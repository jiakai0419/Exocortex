import { fileURLToPath } from 'node:url';
// @ts-check
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { readOnlySqliteJson } from '../storage/sqlite/readonly-query.mjs';
import { liveProbeContext } from './live-probe-cache.mjs';
import { nativePage, nativeData, assertRawMessagePage } from '../adapters/lark-im/adapter.mjs';
import { classifyLarkFailure } from '../adapters/lark-im/transport.mjs';
import { tryAcquireLarkApiLease, readSharedLarkCooldown, writeSharedLarkCooldown } from '../runtime/lark-api-lease.mjs';
import { readRemoteAccountBinding } from './remote-account-binding.mjs';
import { inspectRemoteSampleSnapshot } from './remote-sample-coverage.mjs';
import { SAMPLE_POLICY, digest, epoch, sampleScopeHash, selectSampleChats, evaluateSample, sameSampleMessageAcquisition } from './remote-sample-core.mjs';
import { selectHistoricalObservations, loadPendingHistoryVerifications, routeTargetedHistory, MAX_TARGETED_HISTORY, stableVerificationTarget } from './remote-sample-history.mjs';
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
  const monotonic = deps.monotonicNow || deps.now || (() => performance.now());
  const start = now(); const monotonicStart = monotonic(); let calls = 0; let selfCalls = 0; let last = -Infinity;
  let lastAcquiredAt = /** @type {number|null} */ (null);
  const maxCalls = options.maxApiCalls === undefined ? SAMPLE_POLICY.calls :
    Number.isSafeInteger(options.maxApiCalls) && options.maxApiCalls >= 0 && options.maxApiCalls <= SAMPLE_POLICY.calls ? options.maxApiCalls : 0;
  const maxSelfCalls = options.maxSelfCalls === undefined ? 6 :
    Number.isSafeInteger(options.maxSelfCalls) && options.maxSelfCalls >= 0 && options.maxSelfCalls <= 6 ? options.maxSelfCalls : 0;
  const requestedBudget = options.remoteSampleBudgetMs;
  const budget = requestedBudget === undefined ? SAMPLE_POLICY.deadlineMs :
    Number.isSafeInteger(requestedBudget) && requestedBudget >= 1000 && requestedBudget <= SAMPLE_POLICY.deadlineMs ? requestedBudget : 0;
  const deadline = start + budget;
  const remainingMs = () => monotonicStart + budget - monotonic();
  const call = (path, params = {}, callOptions = {}) => {
    const operation = path.includes('/authen/') ? 'self_profile' : path.endsWith('/messages/mget') ? 'message_search_bundle' : 'message_history_bundle';
    const retryAt = Math.max(Number(options.cooldownsByOperation?.[operation]) || 0, Number(options.cooldownsByOperation?.other) || 0);
    if (retryAt > now()) throw new SampleFailure('rate_cooldown', retryAt, operation);
    if (calls >= maxCalls || operation === 'self_profile' && selfCalls >= maxSelfCalls) throw new SampleFailure('request_budget');
    const reserveMs = Number.isSafeInteger(callOptions.reserveMs) && callOptions.reserveMs >= 0 ? callOptions.reserveMs : 0;
    const wait = Math.max(0, last + SAMPLE_POLICY.gapMs - monotonic());
    if (wait + reserveMs + 1 >= remainingMs()) throw new SampleFailure('time_budget');
    if (wait) (deps.sleep || sleep)(wait);
    if (remainingMs() <= reserveMs) throw new SampleFailure('time_budget');
    const lease = (deps.tryAcquireLease || tryAcquireLarkApiLease)({ db, role: 'probe', deadlineMs: now() + Math.floor(remainingMs()) });
    if (lease.state !== 'acquired') throw new SampleFailure(lease.state === 'busy' ? 'sync_busy' : 'lease_unavailable');
    try {
      const readCooldown = deps.readSharedCooldown || (!deps.spawnSync ? readSharedLarkCooldown : null);
      const shared = readCooldown?.({ operation, nowMs: now() });
      if (shared?.state === 'unavailable') throw new SampleFailure('shared_cooldown_unavailable');
      if (shared?.state === 'cooldown') throw new SampleFailure('rate_cooldown', shared.untilMs || 0, operation);
      const timeout = Math.floor(Math.min(SAMPLE_POLICY.requestMs, remainingMs() - reserveMs));
      if (timeout <= 0) throw new SampleFailure('time_budget');
      calls++; if (operation === 'self_profile') selfCalls++; last = monotonic(); lastAcquiredAt = now();
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
      if (remainingMs() < 0) throw new SampleFailure('time_budget');
      return json;
    } finally { last = monotonic(); lease.release(); }
  };
  return { call, count: () => calls, selfCount: () => selfCalls, lastAcquiredAt: () => lastAcquiredAt, remainingMs, maxCalls, maxSelfCalls, deadline };
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
  const apiLimit = api.maxCalls ?? options.maxApiCalls ?? SAMPLE_POLICY.calls;
  let observedSelfCalls = 0;
  const selfProfile = () => {
    const count = api.count();
    try { return identity(api.call('/open-apis/authen/v1/user_info')); }
    finally { if (api.count() > count) observedSelfCalls++; }
  };
  const remainingTime = () => api.remainingMs ? api.remainingMs() : api.deadline - now();
  /** @type {Record<string, any>} */ const report = { schema_version: 3, ok: false, status: 'inconclusive', reason: null,
    checked_at: new Date(started).toISOString(), scope: 'discovered_chats_rotating',
    window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    binding: { state: 'unverified', evidence: null },
    probe: { mode: 'bounded_native_pages', comparison: 'identity_version_static_body', hot_chats_requested: maxChats,
      hot_chats_found: 0, messages_per_chat: pageSize, remote_messages_checked: 0, unsupported_chats: 0, probe_errors: 0,
      eligible_chats: 0, hot_chats: 0, fair_chats: 0, chats_checked: 0, pages: 0, truncated_chats: 0, api_calls: 0, self_calls: 0 },
    findings: {}, missing_count: 0, lag_ms: null,
    unverified: ['undiscovered_or_disabled_chats','outside_creation_window','thread_only_replies','merged_children','client_dynamic_cards'] };
  const remaining = () => {
    const ms = Math.floor(remainingTime());
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
  const historyAttempts = []; let pendingVerification = false; let budgetTruncated = false; let rotationPlan = null;
  let retryAtMs = 0; let operation = '';
  let stage = 'inventory';
  const finish = (outcome) => ({ outcome, rotation: outcome === 'ok' ? rotationPlan ? rotationPlan.nextCursor * 4 + (rotationPlan.phase + 1) % 4 : selection?.rotation ?? rotation : rotation,
    observations, observationOverflow, historyAttempt: historyAttempts[0] || null, historyAttempts, pendingVerification, report: { ...report, checked_at: new Date(now()).toISOString(), probe: { ...report.probe, api_calls: api.count(), self_calls: api.selfCount ? api.selfCount() : observedSelfCalls } },
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
    if (apiLimit < 2 || (api.maxSelfCalls ?? options.maxSelfCalls ?? 6) < 2) throw new SampleFailure('request_budget');
    stage = 'identity_before';
    const before = selfProfile();
    stage = 'binding_before';
    binding = readBinding(before);
    report.binding = { state: binding.state, evidence: binding.evidence };
    if (binding.state !== 'verified') {
      report.reason = binding.state === 'conflict' ? 'account_mismatch' : 'account_unverified'; return finish('ok');
    }
    // Observations from another account must never participate in confirmation.
    if (options.accountKey && options.accountKey !== binding.account_key) { observations = {}; observationOverflow = false; }
    let revisits = maxChats > 1 ? (deps.selectHistoricalObservations || (deps.selectHistoricalObservation
      ? (...args) => { const selected = deps.selectHistoricalObservation(...args); return selected ? [selected] : []; }
      : selectHistoricalObservations))(db, observations, binding, rows, start, started, localDeps, MAX_TARGETED_HISTORY, end) : [];
    revisits = (deps.routeTargetedHistory || routeTargetedHistory)(db, revisits, binding, localDeps)
      .filter((revisit, index) => index < Math.min(3, maxChats - 1) || revisit.messageId);
    const targeted = revisits.filter(revisit => revisit.messageId);
    const shortBudget = api.deadline - started < SAMPLE_POLICY.deadlineMs;
    const currentPageLimit = shortBudget && revisits.some(revisit => revisit.chat) ? 1 : SAMPLE_POLICY.pages;
    if (currentPageLimit !== SAMPLE_POLICY.pages) report.probe.max_pages_per_chat = currentPageLimit;
    let currentFirst = 0;
    if (revisits.length) {
      const windows = revisits.map(revisit => revisit.chat ? { start: new Date(revisit.start).toISOString(), end: new Date(revisit.end).toISOString() } : null);
      report.history = { requested: revisits.length, chats_checked: 0, pages: 0, messages_checked: 0, unsupported_chats: 0, truncated_chats: 0,
        unroutable: revisits.filter(revisit => !revisit.chat).length, window: revisits.length === 1 ? windows[0] : null,
        ...(revisits.some(revisit => revisit.observation.target + 2000 >= start) ? { scope: 'known_verification' } : {}),
        ...(revisits.length > 1 ? { windows, attempts: 0 } : {}) };
      if (targeted.length) {
        report.probe.mode = 'bounded_native_pages_and_targeted_ids';
        report.history.targeted = { requested: targeted.length, batches: 0, targets_checked: 0, omitted: 0, unsupported: 0 };
      }
      if (revisits.some(revisit => revisit.chat)) {
        const phase = rotation % 4; const cursor = Math.floor(rotation / 4);
        selection = selectSampleChats(rows, cursor, started, Math.min(2, maxChats - 1), 1);
        currentFirst = selection.hot && phase >= 2 ? 1 : 0;
        rotationPlan = { phase, nextCursor: selection.eligible ? cursor % selection.eligible : 0, fairRotations: selection.fairRotations };
      }
      Object.assign(report.probe, { hot_chats_found: selection.selected.length, eligible_chats: selection.eligible,
        hot_chats: selection.hot, fair_chats: selection.fair });
      for (const revisit of revisits.filter(item => !item.chat)) observations = { ...observations,
        [revisit.key]: { ...revisit.observation, last_checked: started } };
    }
    /** @type {Record<string, any>[]} */ const messages = [];
    const seenMessages = new Map(); const unsupportedMessages = new Map(); const acquisitions = new Map(); const historyMessages = new Set();
    const revisitKeys = new Set(revisits.filter(revisit => revisit.chat).map(revisit => revisit.key));
    const messageKey = item => digest([binding.database_key, binding.account_key, item.chat_id, item.message_id, epoch(item.create_time)]);
    const rememberMessage = (item, scopeId, acquiredAt, explicit, comparable = true) => {
      const key = messageKey(item), prior = seenMessages.get(item.message_id) || unsupportedMessages.get(item.message_id);
      if (prior && (!revisitKeys.has(key) || messageKey(prior) !== key || !sameSampleMessageAcquisition(prior, item))) {
        throw new SampleFailure('invalid_page');
      }
      // Even a representation we cannot compare can contradict an ordinary
      // response. Keep it for overlap checks without granting it debt proof.
      if (!comparable) { unsupportedMessages.set(item.message_id, item); return; }
      if (!seenMessages.has(item.message_id)) { const stored = { ...item, scope_id: scopeId }; messages.push(stored); seenMessages.set(item.message_id, stored); }
      // The explicit revisit is the intended ticket acquisition when ordinary
      // coverage overlaps it, regardless of which request happened first.
      if (!acquisitions.has(key) || explicit && !acquisitions.get(key).explicit) acquisitions.set(key, { at: acquiredAt, explicit });
      if (explicit) historyMessages.add(key);
    };
    const currentRequests = selection.selected.map(chat => ({ chat, start, end, historical: false, revisit: null }));
    let targetedInserted = false;
    /** @type {Record<string, any>[]} */
    const historyRequests = revisits.filter(revisit => revisit.chat).flatMap(revisit => {
      if (!revisit.messageId) return [{ chat: revisit.chat, start: revisit.start, end: revisit.end, historical: true, revisit }];
      if (targetedInserted) return [];
      targetedInserted = true;
      return [{ targeted, historical: true }];
    });
    // A slow two-page oldest target cannot permanently put the static batch
    // behind all current routes. Both existing route classes get first place
    // in two of the four existing phases; no capacity or deadline is added.
    const batchIndex = historyRequests.findIndex(request => request.targeted);
    if ((rotationPlan?.phase || 0) >= 2 && batchIndex > 0) historyRequests.unshift(...historyRequests.splice(batchIndex, 1));
    // Interleave the fair historical slot with current coverage. Under slow
    // requests both domains make progress before optional priority slots.
    if (currentFirst === 1 && currentRequests.length > 1) currentRequests.reverse();
    // Alternate the first domain too. A real lease/SQLite overhead must not
    // let a slow current route monopolize every short idle budget.
    /** @type {Record<string, any>[]} */
    const requests = !historyRequests.length ? currentRequests : (rotationPlan?.phase || 0) % 2 === 1
      ? [historyRequests[0], ...currentRequests, ...historyRequests.slice(1)]
      : [currentRequests[0], historyRequests[0], ...currentRequests.slice(1), ...historyRequests.slice(1)].filter(Boolean);
    // Retain the existing conservative route admission and bound each request
    // again, reserving final identity plus local inspection time. Batching saves
    // acquisitions; it must not rely on shorter safety reservations.
    const closingReserveMs = SAMPLE_POLICY.requestMs + SAMPLE_POLICY.gapMs + 1000;
    const canStartRoute = pages => api.count() + pages + 1 <= apiLimit &&
      remainingTime() >= (pages + 1) * (SAMPLE_POLICY.requestMs + SAMPLE_POLICY.gapMs) + 1000;
    const recordHistoryAttempt = (revisit, attemptStarted) => {
      historyAttempts.push({ key: revisit.key, checked_at: attemptStarted, database_key: binding.database_key, source_id: 'lark.im' });
      if (Object.hasOwn(report.history, 'attempts')) report.history.attempts++;
      observations = { ...observations, [revisit.key]: { ...revisit.observation, last_checked: attemptStarted,
        scope_hash: sampleScopeHash(binding, revisit.chat.chat_id) } };
    };
    for (const request of requests) {
      if (request.targeted) {
        if (!canStartRoute(1)) break;
        const callsBefore = api.count(); let attemptStarted = now(); let json;
        stage = 'message_request';
        try { json = api.call('/open-apis/im/v1/messages/mget', {
          message_ids: request.targeted.map(revisit => revisit.messageId), card_msg_content_type: 'raw_card_content',
        }, { reserveMs: closingReserveMs }); }
        finally { if (api.count() > callsBefore) {
          attemptStarted = api.lastAcquiredAt?.() ?? attemptStarted;
          report.history.targeted.batches++;
          request.targeted.forEach(revisit => recordHistoryAttempt(revisit, attemptStarted));
        } }
        stage = 'message_page';
        const data = nativeData(json, 'remote sample targeted messages');
        if (!Array.isArray(data.items) || data.has_more !== undefined && data.has_more !== false ||
          data.page_token != null && data.page_token !== '') throw new SampleFailure('invalid_page');
        stage = 'message_shape';
        assertRawMessagePage(data.items, 'remote sample targeted messages');
        const expected = new Map(request.targeted.map(revisit => [revisit.messageId, revisit]));
        const returned = new Set();
        if (expected.size !== request.targeted.length) throw new SampleFailure('invalid_page');
        stage = 'message_identity';
        for (const item of data.items) {
          const revisit = expected.get(item.message_id);
          const created = epoch(item.create_time);
          if (!revisit || returned.has(item.message_id) ||
            item.chat_id !== revisit.chat.chat_id || created !== revisit.observation.target ||
            digest([binding.database_key,binding.account_key,item.chat_id,item.message_id,created]) !== revisit.key) throw new SampleFailure('invalid_page');
          returned.add(item.message_id);
          if (!['text','post'].includes(item.msg_type)) {
            rememberMessage(item, revisit.chat.id, attemptStarted, true, false);
            report.history.targeted.unsupported++; continue;
          }
          rememberMessage(item, revisit.chat.id, attemptStarted, true);
          report.history.targeted.targets_checked++;
        }
        report.history.targeted.omitted += expected.size - returned.size;
        continue;
      }
      const { chat, historical, revisit } = request;
      const pageLimit = historical ? SAMPLE_POLICY.pages : currentPageLimit;
      if (!canStartRoute(pageLimit)) break;
      const counters = historical ? report.history : report.probe;
      const tokens = new Set(); const routeMessages = new Set(); let token = '';
      for (let pageNo = 0; pageNo < pageLimit; pageNo++) {
        if (pageNo > 0 && !canStartRoute(1)) { counters.truncated_chats++; budgetTruncated = true; break; }
        let json;
        stage = 'message_request';
        const callsBefore = api.count(); let attemptStarted = now();
        try { json = api.call('/open-apis/im/v1/messages', { container_id_type: 'chat', container_id: chat.chat_id,
          sort_type: 'ByCreateTimeDesc', page_size: pageSize, card_msg_content_type: 'user_card_content',
          start_time: String(Math.floor(request.start / 1000)), end_time: String(Math.ceil(request.end / 1000)), ...(token ? { page_token: token } : {}) },
          { reserveMs: closingReserveMs }); }
        catch (error) { if (error instanceof SampleFailure && error.reason === 'restricted_mode') { counters.unsupported_chats++; break; } throw error; }
        finally {
          if (api.count() > callsBefore) attemptStarted = api.lastAcquiredAt?.() ?? attemptStarted;
          // A lease/cooldown refusal made no remote acquisition and cannot
          // consume a writer verification ticket.
          if (!historical && pageNo === 0 && api.count() > callsBefore && rotationPlan && Object.hasOwn(rotationPlan.fairRotations, chat.chat_id)) {
            rotationPlan.nextCursor = rotationPlan.fairRotations[chat.chat_id];
          }
          if (historical && pageNo === 0 && api.count() > callsBefore) {
            recordHistoryAttempt(revisit, attemptStarted);
          }
        }
        stage = 'message_page';
        const page = nativePage(json, 'remote sample page', tokens);
        stage = 'message_shape';
        assertRawMessagePage(page.items, 'remote sample page');
        stage = 'message_identity';
        counters.pages++;
        if (pageNo === 0) counters.chats_checked++;
        if (page.items.length > pageSize) throw new SampleFailure('invalid_page');
        for (const item of page.items) {
          if (item.chat_id !== chat.chat_id || epoch(item.create_time) === null || !item.message_id || routeMessages.has(item.message_id)) throw new SampleFailure('invalid_page');
          routeMessages.add(item.message_id);
          const created = epoch(item.create_time);
          if (created === null || created < request.start || created > request.end) continue;
          if (historical && digest([binding.database_key, binding.account_key, item.chat_id, item.message_id, created]) !== revisit.key) continue;
          rememberMessage(item, chat.id, attemptStarted, historical);
        }
        if (!page.has_more) break;
        token = page.page_token;
        if (pageNo + 1 === pageLimit) {
          counters.truncated_chats++;
          if (!historical && pageLimit < SAMPLE_POLICY.pages) budgetTruncated = true;
        }
      }
    }
    stage = 'identity_after';
    const after = selfProfile();
    if (after.openId !== before.openId || after.tenantKey !== before.tenantKey) throw new SampleFailure('account_changed');
    stage = 'database_context';
    if ((deps.context || liveProbeContext)(db)?.database_key !== context.database_key) throw new SampleFailure('database_changed');
    const targets = messages.map((m) => ({ key: digest([binding.database_key, binding.account_key, m.chat_id, m.message_id, epoch(m.create_time)]),
      scope_id: m.scope_id, message_id: m.message_id, created_ms: epoch(m.create_time), expected_chat_id: m.chat_id }));
    if (remainingTime() <= 0) throw new SampleFailure('time_budget');
    // Coverage, debt and records must come from one SQLite snapshot, including concurrent revocation.
    stage = 'snapshot';
    const knownAcquisitions = Object.fromEntries([...acquisitions].filter(([key]) => observations[key]).map(([key, acquisition]) => [key, acquisition.at]));
    const verificationRequest = Object.keys(knownAcquisitions).length ? { binding, observations,
      acquisitions: knownAcquisitions, requiredKeys: revisits.filter(revisit => revisit.verificationRequired && acquisitions.has(revisit.key)).map(revisit => revisit.key) } : null;
    const { coverage, records, verification } = (deps.inspectSnapshot || inspectRemoteSampleSnapshot)(db, targets,
      { timeoutMs: Math.min(5000, remaining()), now, ...(verificationRequest ? { verification: verificationRequest } : {}) });
    if (verificationRequest && (!verification || verification.status !== 'ready' || !Array.isArray(verification.blockedKeys) ||
      verification.blockedKeys.some(key => !Object.hasOwn(knownAcquisitions, key)))) throw new SampleFailure('context_unavailable');
    if (Object.values(coverage).some(proof => ['source_unavailable', 'scope_unavailable'].includes(proof.reason)) ||
        revisits.some(revisit => revisit.chat && coverage[revisit.key]?.reason === 'before_sync_baseline')) throw new SampleFailure('context_changed');
    stage = 'binding_after';
    const finalBinding = readBinding(after);
    if (finalBinding.state !== 'verified' || finalBinding.account_key !== binding.account_key || finalBinding.database_key !== binding.database_key) throw new SampleFailure('account_changed');
    // The final record snapshot also fences current writer tickets against the
    // actual request start. A response acquired before an accepted commit cannot
    // clear the later generation simply because comparison finishes afterward.
    const lateTickets = new Set(verification?.blockedKeys || []);
    const comparableMessages = messages.filter(message => !lateTickets.has(messageKey(message)));
    stage = 'comparison';
    const evaluated = evaluateSample({ messages: comparableMessages, records, coverage, binding, previous: observations, previousOverflow: observationOverflow, now: now(), windowEnd: end });
    observations = evaluated.observations;
    // Persist acquisition time, not finish time, even when a ticket arrives
    // after the fence. The later writer acceptance must remain unconsumed.
    for (const [key, acquisition] of acquisitions) if (observations[key]) observations[key] = { ...observations[key], last_checked: acquisition.at };
    observationOverflow = evaluated.observationOverflow;
    report.findings = evaluated.counts;
    report.missing_count = evaluated.counts.missing;
    report.probe.remote_messages_checked = comparableMessages.length;
    if (revisits.length) {
      const historyKeys = new Set(revisits.map(revisit => revisit.key));
      report.history.messages_checked = comparableMessages.filter(message => historyKeys.has(messageKey(message)) && historyMessages.has(messageKey(message))).length;
    }
    // Only still-unattempted, generation-bound tickets can request a follow-up;
    // recent known targets use the same complete-window stability boundary.
    pendingVerification = (deps.pendingVerifications || loadPendingHistoryVerifications)(db, observations, binding, now(), localDeps)
      .some(key => stableVerificationTarget(observations[key], end));
    stage = 'final_context';
    if ((deps.context || liveProbeContext)(db)?.database_key !== context.database_key || remainingTime() < 0) throw new SampleFailure('context_changed');
    const c = evaluated.counts;
    if (c.confirmed_missing || c.identity_conflict || c.stale_version || c.content_mismatch) {
      report.status = 'needs_attention'; report.reason = c.confirmed_missing ? 'confirmed_missing' : 'source_difference';
    } else if (c.missing || c.pending_sync || c.unresolved_prior || c.observation_overflow || c.expired_observations) {
      report.status = 'delayed'; report.reason = c.suspected_missing ? 'suspected_missing' : c.pending_sync ? 'sync_pending' : 'unresolved_observations';
    } else if (!messages.length || report.probe.unsupported_chats || report.history?.unsupported_chats || c.local_newer ||
      budgetTruncated || report.probe.chats_checked < selection.selected.length || report.history && report.history.messages_checked < report.history.requested) {
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
