import { fileURLToPath } from 'node:url';
// @ts-check
import { spawnSync } from 'node:child_process';
import { readOnlySqliteJson } from '../storage/sqlite/readonly-query.mjs';
import { liveProbeContext } from './live-probe-cache.mjs';
import { nativePage, nativeData, assertRawMessagePage } from '../adapters/lark-im/adapter.mjs';
import { classifyLarkFailure } from '../adapters/lark-im/transport.mjs';
import { tryAcquireLarkApiLease, readSharedLarkCooldown, writeSharedLarkCooldown } from '../runtime/lark-api-lease.mjs';
import { readRemoteAccountBinding } from './remote-account-binding.mjs';
import { inspectRemoteSampleSnapshot } from './remote-sample-coverage.mjs';
import { SAMPLE_POLICY, digest, epoch, sampleScopeHash, selectSampleChats, evaluateSample } from './remote-sample-core.mjs';
import { selectHistoricalObservation } from './remote-sample-history.mjs';
import { runGuardedRemoteSampleProcess, safeGuardianDiagnostic } from '../runtime/worker/remote-sample-process.mjs';
import { publicRemoteReport } from './remote-sample-cache.mjs';
import { collectorDiagnostic } from './remote-sample-diagnostic.mjs';
export { writeRemoteSampleCache } from './remote-sample-cache.mjs';
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export class SampleFailure extends Error {
  constructor(reason, retryAtMs = 0, operation = '') { super(reason); this.reason = reason; this.retryAtMs = retryAtMs; this.operation = operation; }
}

/** One bounded request; no retries, shortcuts, credentials or raw error output. */
export function createSampleApi(db, options = {}, deps = {}) {
  const now = deps.now || Date.now;
  const start = now(); let calls = 0; let last = -Infinity;
  const deadline = start + SAMPLE_POLICY.deadlineMs;
  const call = (path, params = {}) => {
    const operation = path.includes('/authen/') ? 'self_profile' : 'message_history_bundle';
    const retryAt = Math.max(Number(options.cooldownsByOperation?.[operation]) || 0, Number(options.cooldownsByOperation?.other) || 0);
    if (retryAt > now()) throw new SampleFailure('rate_cooldown', retryAt, operation);
    if (calls >= SAMPLE_POLICY.calls) throw new SampleFailure('request_budget');
    const wait = Math.max(0, last + SAMPLE_POLICY.gapMs - now());
    if (now() + wait + 1 >= deadline) throw new SampleFailure('time_budget');
    if (wait) (deps.sleep || sleep)(wait);
    if (now() >= deadline) throw new SampleFailure('time_budget');
    const lease = (deps.tryAcquireLease || tryAcquireLarkApiLease)({ db, role: 'probe', deadlineMs: deadline });
    if (lease.state !== 'acquired') throw new SampleFailure(lease.state === 'busy' ? 'sync_busy' : 'lease_unavailable');
    try {
      const readCooldown = deps.readSharedCooldown || (!deps.spawnSync ? readSharedLarkCooldown : null);
      const shared = readCooldown?.({ operation, nowMs: now() });
      if (shared?.state === 'unavailable') throw new SampleFailure('shared_cooldown_unavailable');
      if (shared?.state === 'cooldown') throw new SampleFailure('rate_cooldown', shared.untilMs || 0, operation);
      const timeout = Math.min(SAMPLE_POLICY.requestMs, deadline - now());
      if (timeout <= 0) throw new SampleFailure('time_budget');
      calls++; last = now();
      const args = ['api', 'GET', path, '--as', 'user', '--params', JSON.stringify(params), '--format', 'json'];
      const result = (deps.spawnSync || spawnSync)(options.env?.LARK_CLI || process.env.LARK_CLI || 'lark-cli', args,
        { encoding: 'utf8', env: options.env || process.env, timeout, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
          ...(lease.stdio ? { stdio: lease.stdio } : {}) });
      let json;
      try { json = JSON.parse(String(result.stdout || '')); } catch { /* Generic failure below. */ }
      let validEnvelope = true;
      try { nativeData(json, 'sample'); } catch { validEnvelope = false; }
      if (result.error || result.signal || result.status !== 0 || !validEnvelope) {
        const failure = classifyLarkFailure(`${String(result.stderr || '')}\n${String(result.stdout || '')}`);
        if (failure.kind === 'rate_limited') {
          const untilMs = Math.min(Number.MAX_SAFE_INTEGER, now() + (failure.retry_after_ms ?? 900000));
          const writeCooldown = deps.writeSharedCooldown || (!deps.spawnSync ? writeSharedLarkCooldown : null);
          if (writeCooldown && !writeCooldown({ operation, untilMs, nowMs: now() })) throw new SampleFailure('shared_cooldown_unavailable', untilMs, operation);
          throw new SampleFailure('rate_limited', untilMs, operation);
        }
        if (failure.code === 231203) throw new SampleFailure('restricted_mode');
        throw new SampleFailure(result.error?.code === 'ETIMEDOUT' || result.signal ? 'request_timeout' :
          'api_unavailable');
      }
      if (now() > deadline) throw new SampleFailure('time_budget');
      return json;
    } finally { last = now(); lease.release(); }
  };
  return { call, count: () => calls, deadline };
}

export function loadSampleInventory(db, deps = {}) {
  return (deps.sqliteJson || readOnlySqliteJson)(db, `SELECT id, source_id, enabled,
    json_extract(config_json,'$.chat_id') AS chat_id,
    json_extract(config_json,'$.unsupported_reason') AS unsupported_reason,
    json_extract(config_json,'$.hot_rank') AS hot_rank,
    json_extract(config_json,'$.hot_seen_at') AS hot_seen_at,
    (SELECT json_extract(config_json,'$.initial_sync_start_ms') FROM sources WHERE id='lark.im') AS initial_sync_start_ms
    FROM sync_scopes WHERE source_id='lark.im' AND id LIKE 'lark.im.received.chat.%'
      AND EXISTS(SELECT 1 FROM sources WHERE id='lark.im' AND enabled=1)
    ORDER BY id LIMIT 10001;`, 'remote sample inventory');
}


function identity(json) {
  const data = json?.data;
  if (!data || typeof data.open_id !== 'string' || !/^ou_[A-Za-z0-9_-]+$/.test(data.open_id) ||
      typeof data.tenant_key !== 'string' || !data.tenant_key || data.tenant_key.length > 128) throw new SampleFailure('identity_unavailable');
  return { openId: data.open_id, tenantKey: data.tenant_key };
}

/** Only this collector calls remote endpoints. Status and cache readers never do. */
export function collectRemoteSample(db, options = {}, deps = {}) {
  const now = deps.now || Date.now; const started = now();
  const context = (deps.context || liveProbeContext)(db);
  const rotation = Number.isSafeInteger(options.rotation) && options.rotation >= 0 ? options.rotation : 0;
  const end = Math.min(options.endMs ?? started, Math.floor((started - SAMPLE_POLICY.stableBufferMs) / 60000) * 60000);
  const start = Math.max(options.startMs ?? end - SAMPLE_POLICY.windowMs, end - SAMPLE_POLICY.windowMs);
  const pageSize = Math.min(SAMPLE_POLICY.pageSize, Math.max(1, options.messagesPerChat ?? SAMPLE_POLICY.pageSize));
  const maxChats = Math.min(SAMPLE_POLICY.chats, Math.max(1, options.hotChats ?? SAMPLE_POLICY.chats));
  const api = deps.api || createSampleApi(db, options, deps);
  /** @type {Record<string, any>} */ const report = { schema_version: 3, ok: false, status: 'inconclusive', reason: null,
    checked_at: new Date(started).toISOString(), scope: 'discovered_chats_rotating',
    window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    binding: { state: 'unverified', evidence: null },
    probe: { mode: 'bounded_native_pages', comparison: 'identity_version_static_body', hot_chats_requested: maxChats,
      hot_chats_found: 0, messages_per_chat: pageSize, remote_messages_checked: 0, unsupported_chats: 0, probe_errors: 0,
      eligible_chats: 0, hot_chats: 0, fair_chats: 0, chats_checked: 0, pages: 0, truncated_chats: 0, api_calls: 0 },
    findings: {}, missing_count: 0, lag_ms: null,
    unverified: ['undiscovered_or_disabled_chats','outside_creation_window','thread_only_replies','merged_children','client_dynamic_cards'] };
  const remaining = () => {
    const ms = Math.floor(api.deadline - now());
    if (ms <= 0) throw new SampleFailure('time_budget');
    return ms;
  };
  const boundedQuery = (path, sql, label, queryOptions = {}) => (deps.sqliteJson || readOnlySqliteJson)(path, sql, label,
    { timeoutMs: Math.min(remaining(), queryOptions.timeoutMs || remaining()) });
  const localDeps = { ...deps, sqliteJson: boundedQuery };
  const readBinding = (self) => { remaining(); return (deps.readBinding || readRemoteAccountBinding)({ db, selfOpenId: self.openId, selfTenantKey: self.tenantKey }, { query: boundedQuery }); };
  let binding = null; let selection = null;
  let observations = options.previousObservations || {};
  let observationOverflow = options.previousOverflow === true;
  let historyAttempt = null;
  let retryAtMs = 0; let operation = '';
  let stage = 'inventory';
  const finish = (outcome) => ({ outcome, rotation: outcome === 'ok' ? selection?.rotation ?? rotation : rotation,
    observations, observationOverflow, historyAttempt, report: { ...report, checked_at: new Date(now()).toISOString(), probe: { ...report.probe, api_calls: api.count() } },
    cacheContext: binding ? { database_key: context?.database_key, source_id: 'lark.im', account_key: binding.account_key,
      auth_identity_verified: binding.state === 'verified' } : context, retryAtMs,
    cooldownsByOperation: retryAtMs && operation ? { [operation]: retryAtMs } : {}, cacheTtlMs: options.cacheTtlMs });
  try {
    if (!context || !(start < end) || end > started) throw new SampleFailure('context_unavailable');
    const rows = (deps.loadInventory || loadSampleInventory)(db, localDeps);
    if (rows.length > 10000) throw new SampleFailure('inventory_budget');
    selection = selectSampleChats(rows, rotation, started, maxChats);
    Object.assign(report.probe, { hot_chats_found: selection.selected.length, eligible_chats: selection.eligible,
      hot_chats: selection.hot, fair_chats: selection.fair });
    if (!selection.selected.length) { report.reason = 'no_eligible_chats'; return finish('ok'); }
    stage = 'identity_before';
    const before = identity(api.call('/open-apis/authen/v1/user_info'));
    stage = 'binding_before';
    binding = readBinding(before);
    report.binding = { state: binding.state, evidence: binding.evidence };
    if (binding.state !== 'verified') {
      report.reason = binding.state === 'conflict' ? 'account_mismatch' : 'account_unverified'; return finish('ok');
    }
    // Observations from another account must never participate in confirmation.
    if (options.accountKey && options.accountKey !== binding.account_key) { observations = {}; observationOverflow = false; }
    const revisit = maxChats > 1 ? (deps.selectHistoricalObservation || selectHistoricalObservation)(db, observations, binding, rows, start, started, localDeps) : null;
    if (revisit) {
      observations = { ...observations, [revisit.key]: { ...revisit.observation, last_checked: started,
        ...(revisit.chat ? { scope_hash: sampleScopeHash(binding, revisit.chat.chat_id) } : {}) } };
      report.history = { requested: 1, chats_checked: 0, pages: 0, messages_checked: 0, unsupported_chats: 0, truncated_chats: 0,
        unroutable: revisit.chat ? 0 : 1, window: revisit.chat ? { start: new Date(revisit.start).toISOString(), end: new Date(revisit.end).toISOString() } : null };
      if (revisit.chat) {
        selection = selectSampleChats(rows, rotation, started, maxChats - 1);
        Object.assign(report.probe, { hot_chats_found: selection.selected.length, eligible_chats: selection.eligible,
          hot_chats: selection.hot, fair_chats: selection.fair });
      }
    }
    /** @type {Record<string, any>[]} */ const messages = []; const seenMessages = new Set();
    const requests = selection.selected.map(chat => ({ chat, start, end, historical: false }));
    if (revisit?.chat) requests.push({ chat: revisit.chat, start: revisit.start, end: revisit.end, historical: true });
    for (const request of requests) {
      const { chat, historical } = request;
      const counters = historical ? report.history : report.probe;
      const tokens = new Set(); let token = '';
      for (let pageNo = 0; pageNo < SAMPLE_POLICY.pages; pageNo++) {
        let json;
        stage = 'message_request';
        if (historical && pageNo === 0) historyAttempt = { key: revisit.key, checked_at: now(),
          database_key: binding.database_key, source_id: 'lark.im' };
        try { json = api.call('/open-apis/im/v1/messages', { container_id_type: 'chat', container_id: chat.chat_id,
          sort_type: 'ByCreateTimeDesc', page_size: pageSize, card_msg_content_type: 'user_card_content',
          start_time: String(Math.floor(request.start / 1000)), end_time: String(Math.ceil(request.end / 1000)), ...(token ? { page_token: token } : {}) }); }
        catch (error) { if (error instanceof SampleFailure && error.reason === 'restricted_mode') { counters.unsupported_chats++; break; } throw error; }
        stage = 'message_page';
        const page = nativePage(json, 'remote sample page', tokens);
        stage = 'message_shape';
        assertRawMessagePage(page.items, 'remote sample page');
        stage = 'message_identity';
        counters.pages++;
        if (pageNo === 0) counters.chats_checked++;
        if (page.items.length > pageSize) throw new SampleFailure('invalid_page');
        for (const item of page.items) {
          if (item.chat_id !== chat.chat_id || epoch(item.create_time) === null || !item.message_id || seenMessages.has(item.message_id)) throw new SampleFailure('invalid_page');
          seenMessages.add(item.message_id);
          const created = epoch(item.create_time);
          if (created === null || created < request.start || created > request.end) continue;
          if (historical && digest([binding.database_key, binding.account_key, item.chat_id, item.message_id, created]) !== revisit.key) continue;
          messages.push({ ...item, scope_id: chat.id });
        }
        if (!page.has_more) break;
        token = page.page_token;
        if (pageNo + 1 === SAMPLE_POLICY.pages) counters.truncated_chats++;
      }
    }
    stage = 'identity_after';
    const after = identity(api.call('/open-apis/authen/v1/user_info'));
    if (after.openId !== before.openId || after.tenantKey !== before.tenantKey) throw new SampleFailure('account_changed');
    stage = 'database_context';
    if ((deps.context || liveProbeContext)(db)?.database_key !== context.database_key) throw new SampleFailure('database_changed');
    const targets = messages.map((m) => ({ key: digest([binding.database_key, binding.account_key, m.chat_id, m.message_id, epoch(m.create_time)]),
      scope_id: m.scope_id, message_id: m.message_id, created_ms: epoch(m.create_time), expected_chat_id: m.chat_id }));
    if (now() >= api.deadline) throw new SampleFailure('time_budget');
    // Coverage, debt and records must come from one SQLite snapshot, including concurrent revocation.
    stage = 'snapshot';
    const { coverage, records } = (deps.inspectSnapshot || inspectRemoteSampleSnapshot)(db, targets, { timeoutMs: Math.min(5000, remaining()), now });
    if (Object.values(coverage).some(proof => ['source_unavailable', 'scope_unavailable'].includes(proof.reason)) ||
        revisit?.chat && coverage[revisit.key]?.reason === 'before_sync_baseline') throw new SampleFailure('context_changed');
    stage = 'binding_after';
    const finalBinding = readBinding(after);
    if (finalBinding.state !== 'verified' || finalBinding.account_key !== binding.account_key || finalBinding.database_key !== binding.database_key) throw new SampleFailure('account_changed');
    stage = 'comparison';
    const evaluated = evaluateSample({ messages, records, coverage, binding, previous: observations, previousOverflow: observationOverflow, now: now(), windowEnd: end });
    observations = evaluated.observations;
    observationOverflow = evaluated.observationOverflow;
    report.findings = evaluated.counts;
    report.missing_count = evaluated.counts.missing;
    report.probe.remote_messages_checked = messages.length;
    if (revisit?.chat) report.history.messages_checked = messages.filter(message =>
      digest([binding.database_key, binding.account_key, message.chat_id, message.message_id, epoch(message.create_time)]) === revisit.key).length;
    stage = 'final_context';
    if ((deps.context || liveProbeContext)(db)?.database_key !== context.database_key || now() > api.deadline) throw new SampleFailure('context_changed');
    const c = evaluated.counts;
    if (c.confirmed_missing || c.identity_conflict || c.stale_version || c.content_mismatch) {
      report.status = 'needs_attention'; report.reason = c.confirmed_missing ? 'confirmed_missing' : 'source_difference';
    } else if (c.missing || c.pending_sync || c.unresolved_prior || c.observation_overflow || c.expired_observations) {
      report.status = 'delayed'; report.reason = c.suspected_missing ? 'suspected_missing' : c.pending_sync ? 'sync_pending' : 'unresolved_observations';
    } else if (!messages.length || report.probe.unsupported_chats || report.history?.unsupported_chats || c.local_newer) {
      report.reason = !messages.length ? 'no_usable_remote_messages' : 'partial_sample';
    } else { report.status = 'healthy'; report.ok = true; }
    return finish('ok');
  } catch (error) {
    report.status = 'unavailable'; report.reason = error instanceof SampleFailure ? error.reason : 'invalid_evidence';
    if (!(error instanceof SampleFailure)) report.collector_diagnostic = collectorDiagnostic(stage, error);
    report.probe.probe_errors++;
    retryAtMs = error instanceof SampleFailure ? error.retryAtMs : 0;
    operation = error instanceof SampleFailure ? error.operation : '';
    return finish(report.reason === 'sync_busy' ? 'busy' : 'failed');
  }
}

/** Public one-shot checks also get the same 60s hard process bound, including SQLite and identity work. */
export function runReadOnlyRemoteSample(db, options = {}, deps = {}) {
  const at = (deps.now || Date.now)();
  const result = runGuardedRemoteSampleProcess(process.execPath,
    [deps.scriptPath || fileURLToPath(new URL('../runtime/worker/remote-sample-main.mjs', import.meta.url))],
    { input: JSON.stringify({ mode: 'read_only', db, options: { startMs: options.startMs, endMs: options.endMs,
      hotChats: options.hotChats, messagesPerChat: options.messagesPerChat } }),
      env: options.env || process.env }, deps);
  const diagnostic = safeGuardianDiagnostic(result.guardian_diagnostic);
  if (!diagnostic && !result.error && !result.signal && result.status === 0) {
    try {
      const parsed = JSON.parse(String(result.stdout));
      if (['ok','busy','failed'].includes(parsed.outcome) && parsed.report?.schema_version === 3) {
        if (Object.hasOwn(parsed.report, 'guardian_diagnostic') || Object.hasOwn(parsed.report, 'collector_diagnostic')) {
          const report = publicRemoteReport(parsed.report);
          return { outcome: 'failed', report, ...(report.guardian_diagnostic ? { guardian_diagnostic: report.guardian_diagnostic } : {}) };
        }
        return parsed;
      }
    } catch { /* No raw parser/output excerpts. */ }
  }
  const end = Math.floor((at - SAMPLE_POLICY.stableBufferMs) / 60000) * 60000;
  return { outcome: 'failed', ...(diagnostic ? { guardian_diagnostic: diagnostic } : {}),
    report: { schema_version: 3, ok: false, status: 'unavailable', reason: 'sample_process_failed',
    ...(diagnostic ? { guardian_diagnostic: diagnostic } : {}),
    checked_at: new Date(at).toISOString(), window: { start: new Date(end - SAMPLE_POLICY.windowMs).toISOString(), end: new Date(end).toISOString() },
    probe: {}, findings: {}, binding: {state:'unverified'} } };
}
