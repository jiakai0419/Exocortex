// @ts-check
import { randomUUID, createHash } from 'node:crypto';
import { createLarkImAdapter } from '../adapters/lark-im/adapter.mjs';
import { messageId, chatId, chatScopeId } from '../adapters/lark-im/core.mjs';
import { prepareChatWindowRecords } from '../adapters/lark-im/sync-runner.mjs';
import { createMaintenanceRequestSession } from './request-session.mjs';
import { readOnlySqliteJson } from '../storage/sqlite/readonly-query.mjs';
import { captureRemoteAccountBinding, readRemoteAccountBinding, accountBindingAdmissionError } from '../diagnostics/remote-account-binding.mjs';
import { captureLarkWriteAdmission } from '../diagnostics/lark-write-admission.mjs';
import { commitBoundedReplayRecords, quoteSql, normalizeBoundedReplayRecords } from '../../dist/storage/sqlite/ingestion-store.js';
import { scopeObservationContext } from './scope-config-policy.mjs';
import { loadHistoryDebtHints, readHistoryDebtSchedule, selectHistoryDebtTarget, readHistoryFairRound } from './history-debt.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const PROFILE = 'known_record_history/v1';

/** Read-only selection. A discovered chat routes all its known native records;
 * first-seen scope is immutable provenance, including sent-first ingestion.
 * The fixed horizon excludes records arriving during this sweep. Coverage here
 * means processed known rows, never missing-source coverage. */
function selectHistoryTarget(db, deps = {}) {
  const query = deps.sqliteJson || readOnlySqliteJson;
  const source = query(db, "SELECT enabled,config_json FROM sources WHERE id='lark.im';", 'read history source')[0];
  if (source?.enabled !== 1) return null;
  const baseline = JSON.parse(source.config_json).initial_sync_start_ms;
  if (!Number.isSafeInteger(baseline) || baseline < 100_000_000_000) throw new Error('history baseline unavailable');
  const eligible = `r.source_id='lark.im' AND r.record_type='lark.im.message'
    AND r.occurred_at_ms>=${baseline} AND r.external_version IS NOT NULL
    AND r.external_version<>'' AND r.external_version NOT GLOB '*[^0-9]*'
    AND CASE WHEN json_valid(r.canonical_json) THEN json_extract(r.canonical_json,'$.source_api')='im.v1.messages' ELSE 0 END
    AND r.container_id=json_extract(s.config_json,'$.chat_id')`;
  const scope = query(db, `SELECT s.*, COALESCE(p.generation,0) AS history_generation,
    COALESCE(p.after_id,0) AS history_after, COALESCE(p.sweep_max_id,0) AS history_max,
    COALESCE(p.completed_sweeps,0) AS history_sweeps,
    (SELECT MAX(r.id) FROM records r INDEXED BY records_history_container_id WHERE ${eligible}) AS current_max
    FROM sync_scopes s LEFT JOIN lark_im_history_progress p ON p.scope_id=s.id
    WHERE s.source_id='lark.im' AND s.enabled=1 AND s.id LIKE 'lark.im.received.chat.%'
    ${deps.eligibleScopeIds ? `AND s.id IN (${deps.eligibleScopeIds.map(quoteSql).join(',') || 'NULL'})` : ''}
    AND CASE WHEN json_valid(s.config_json) THEN json_type(s.config_json,'$.chat_id')='text' ELSE 0 END
    AND EXISTS(SELECT 1 FROM records r WHERE ${eligible})
    ORDER BY COALESCE(p.last_attempt_at_ms,0),s.id LIMIT 1;`, 'select history scope')[0];
  if (!scope) return null;
  if (chatScopeId(JSON.parse(scope.config_json).chat_id) !== scope.id) throw new Error("history scope identity unavailable");
  const recordWhere = `r.source_id='lark.im' AND r.record_type='lark.im.message'
    AND r.container_id=${quoteSql(JSON.parse(scope.config_json).chat_id)}
    AND r.occurred_at_ms>=${baseline} AND r.external_version<>'' AND r.external_version NOT GLOB '*[^0-9]*'
    AND CASE WHEN json_valid(r.canonical_json) THEN json_extract(r.canonical_json,'$.source_api')='im.v1.messages' ELSE 0 END`;
  const read = (after, max) => query(db, `SELECT r.*,o.generation AS observation_generation
    FROM records r INDEXED BY records_history_container_id JOIN record_observation_state o ON o.record_id=r.id
    WHERE ${recordWhere} AND r.id>${after} AND r.id<=${max} ORDER BY r.id LIMIT 1;`, 'select history record')[0];
  let horizon = scope.history_max;
  let selected = read(scope.history_after, horizon);
  if (!selected) { horizon = scope.current_max; selected = read(0, horizon); }
  if (!selected) return null;
  const { observation_generation, ...record } = selected;
  const { history_generation, history_after, history_max, history_sweeps, current_max, ...selectedScope } = scope;
  const detailTask = query(db, `SELECT d.fingerprint,d.raw_root_json,d.external_version,d.occurred_at_ms,
    p.generation AS list_generation FROM lark_im_detail_tasks d
    JOIN lark_im_list_progress p ON p.scope_id=d.scope_id
    WHERE d.scope_id=${quoteSql(scope.id)} AND d.message_id=${quoteSql(record.external_id)} AND d.status='pending';`,
  'read selected history detail descriptor')[0] || null;
  return { sourceConfigJson: source.config_json, baseline, scope: selectedScope, record, observationGeneration: observation_generation,
    checkpoint: { detailTask, generation: history_generation, afterId: history_after, sweepMaxId: history_max,
      completedSweeps: history_sweeps, selectedId: record.id, nextSweepMaxId: horizon } };
}

/** One explicitly bounded autonomous slice; no name fanout or discovery cursor.
 * Tests inject a transport session, never real source or shared production state. */
function executeHistoryTarget(options, deps, session, initialTarget) {
  const db = options.db, now = deps.now || Date.now, startedAtMs = now(), attemptId = randomUUID();
  let target = initialTarget, schedule = null, priority = false;
  const binding = captureRemoteAccountBinding({ db });
  if (!binding || binding.conflict) throw new Error('history account binding unavailable');
  const attemptsBefore = session.summary().cli_attempts;
  const targetSession = { ...session, runLark(...args) {
    if (session.summary().cli_attempts - attemptsBefore >= 4) throw new Error('target_cli_budget');
    return session.runLark(...args);
  } };
  const adapter = createLarkImAdapter({ run: targetSession.runLark });
  const fetchOptions = { pageSize: 50, chatPageSize: 100, maxPages: 2, retries: 0, retryDelayMs: 0 };
  // Account failures do not advance a selected scope or publish a candidate.
  const self = (deps.getSelfProfile || adapter.getSelfProfile)(fetchOptions);
  const admission = readRemoteAccountBinding({ db, selfOpenId: self?.open_id });
  const accountKey = 'account_key' in admission ? admission.account_key : null;
  if (typeof self?.open_id !== 'string' || !self.open_id.startsWith('ou_') || admission.state !== 'verified' || !/^[a-f0-9]{64}$/.test(accountKey || '') || accountBindingAdmissionError(admission)) {
    throw new Error('history account identity unavailable');
  }
  {
    const loaded = loadHistoryDebtHints(db, options.logDir, { database_key: binding.database_key, account_key: accountKey }, now(), deps.debtDeps);
    schedule = readHistoryDebtSchedule(db, loaded, now());
    const fair = readHistoryFairRound(db, schedule.scheduler, { now: () => startedAtMs });
    schedule.fairRound = fair;
    target = selectHistoryTarget(db, { eligibleScopeIds: fair.eligibleScopeIds?.slice(0, 1) }) || initialTarget;
    if (schedule.selected) {
      const selected = selectHistoryDebtTarget(db, schedule.selected);
      if (selected) { target = selected; priority = true; }
    }
  }
  const row = target.record, scope = target.scope, config = JSON.parse(scope.config_json);
  const writeAdmission = captureLarkWriteAdmission(db, { selfOpenId: self.open_id, requireVerified: true, scopeIds: [scope.id] });
  const { policy: scopePolicy, configJson: scopeConfig } = scopeObservationContext(scope.config_json);
  const startMs = Math.max(target.baseline, Math.floor(row.occurred_at_ms / 1000) * 1000);
  const endMs = Math.floor(row.occurred_at_ms / 1000) * 1000 + 1000;
  let records = [], pages = 1, fetchedCount = 0, error = null;
  try {
    // Complete the list before selecting; unrelated merge roots never consume
    // this known row's detail budget or turn their permission debt into ours.
    const fetched = (deps.fetchChatMessageList || adapter.fetchChatMessageList)(config.chat_id, startMs, endMs, fetchOptions);
    const detailRoots = fetched.detailRoots ?? [];
    if (!Array.isArray(fetched.messages) || !Array.isArray(detailRoots)
      || fetched.messages.length + detailRoots.length > 100 || fetched.has_more === true
      || !Number.isSafeInteger(fetched.pages) || fetched.pages < 1 || fetched.pages > 2) throw new Error('incomplete');
    const listed = [...fetched.messages, ...detailRoots];
    if (Buffer.byteLength(JSON.stringify(listed)) > 1024 * 1024) throw new Error('size_limit');
    if (listed.some(message => chatId(message) && chatId(message) !== config.chat_id)) throw new Error('identity');
    pages = fetched.pages; fetchedCount = listed.length;
    const ordinary = fetched.messages.filter(message => messageId(message) === row.external_id);
    const roots = detailRoots.filter(message => messageId(message) === row.external_id);
    if (ordinary.length + roots.length !== 1) throw new Error(ordinary.length + roots.length ? 'ambiguous' : 'missing');
    const selected = roots.length ? (deps.fetchMessageDetails || adapter.fetchMessageDetails)(roots[0], {
      retries: 0, retryDelayMs: 0, detailMaxPages: 2, detailMaxItems: 100, detailBudgetMs: 30_000,
    }) : ordinary[0];
    if (Buffer.byteLength(JSON.stringify(selected)) > 1024 * 1024) throw new Error('size_limit');
    records = prepareChatWindowRecords([selected], scope.id, null, startMs, endMs, self.open_id, { self }, config);
    normalizeBoundedReplayRecords(records, 'lark.im');
    if (records.some(record => record.external_id !== row.external_id)) throw new Error('identity');
    if (records.length !== 1 || records[0].occurred_at_ms !== row.occurred_at_ms || records[0].container_id !== row.container_id) throw new Error('identity');
    records = records.map(record => ({ ...record, expected_external_version: row.external_version }));
    session.assertReady();
  } catch (cause) {
    // Never infer deletion from absence or transport failure. Finite, private-
    // content-free error rotates this row; the next sweep can retry it.
    error = ['incomplete', 'size_limit', 'identity', 'ambiguous', 'missing'].includes(cause instanceof Error ? cause.message : '')
      ? /** @type {Error} */ (cause).message : 'fetch_unavailable';
    records = [];
    // Batch exhaustion/cooldown/lease loss is not evidence against this row.
    // Keep already committed targets, but leave this target's checkpoint intact.
    if (options.maxRecords > 1 && session.summary().stop_reason) throw cause;
  }
  const checkBinding = () => {
    writeAdmission.assertCurrent();
    if (JSON.stringify(captureRemoteAccountBinding({ db })) !== JSON.stringify(binding)
      || accountBindingAdmissionError(readRemoteAccountBinding({ db, selfOpenId: self.open_id }))) throw new Error('history account binding changed');
  };
  checkBinding();
  const requestBudget = session.summary();
  const commit = () => (deps.commit || commitBoundedReplayRecords)(db, {
    scope, initialSyncStartMs: target.baseline, startMs, endMs,
    planId: sha(JSON.stringify({ profile: PROFILE, scope: scope.id, horizon: target.checkpoint.nextSweepMaxId })),
    attemptId, selfIdHash: sha(self.open_id), pages, fetchedCount, records,
    writeAdmission: writeAdmission.fence,
    observationAcquisition: { attempt: attemptId, startedAtMs, basis: new Map([[row.external_id, target.observationGeneration]]), confirm: true,
      contextKey: sha(JSON.stringify({ profile: PROFILE, self: self.open_id, account: accountKey,
        database: binding.database_key, source: sha(target.sourceConfigJson), scope: scope.id, chat: config.chat_id,
        scopePolicy, scopeConfig: sha(scopeConfig) })) },
    history: { ...target.checkpoint, startedAtMs, error, requestBudget,
      ...(schedule ? { scheduling: { generation: schedule.scheduler.generation,
        priorityStreak: schedule.scheduler.priority_streak, lane: priority ? 'priority' : 'fair',
        hints: schedule.hints, queue: schedule.queue, queueBefore: schedule.previous, fairRound: priority ? null : schedule.fairRound.state } } : {}) },
    reviewBeforeCommit: checkBinding,
    reviewFence: { mode: 'replay', createdAtMs: startedAtMs, expiresAtMs: startedAtMs + 30 * 60 * 1000,
      sourceConfigJson: target.sourceConfigJson, sentActor: binding.sent_actor || null, records: [row],
      scopes: [{ id: scope.id, source_id: scope.source_id, enabled: scope.enabled, config_json: scope.config_json }] },
  });
  const effects = session.withCommit ? session.withCommit(commit, { allowStoppedForFailure: error !== null && records.length === 0 }) : commit();
  return { ok: error === null, profile: PROFILE, outcome: error || (effects.conflicts ? 'pending_observation' : 'processed'),
    ...effects, request_budget: requestBudget, cursor_policy: 'unchanged', coverage: 'known_rows_only',
    ...(schedule ? { lane: priority ? 'priority' : 'fair', priority_hint_reason: schedule.reason, fair_round_reason: schedule.fairRound.reason } : {}) };
}

/** Defaults preserve the single-record public contract. A batch owns one
 * session; neither target changes nor local commits reset its deadline/ledger. */
function executeLarkImHistory(options, deps = {}) {
  const maxRecords = options.maxRecords ?? 1;
  const maxCliAttempts = options.maxCliAttempts ?? (maxRecords === 1 ? 4 : 12);
  const maxSeconds = options.maxSeconds ?? (maxRecords === 1 ? 30 : 25);
  if (!options.db || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 12 ||
      !Number.isSafeInteger(maxCliAttempts) || maxCliAttempts < 2 || maxCliAttempts > (maxRecords === 1 ? 4 : 12) ||
      !Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 30)
    throw new Error('history requires at most 12 records, 12 batch requests (4 per record), and 30 seconds');
  let target = selectHistoryTarget(options.db);
  if (!target) return { ok: true, profile: PROFILE, outcome: 'no_eligible_known_record', cursor_policy: 'unchanged' };
  const session = (deps.createRequestSession || createMaintenanceRequestSession)({ db: options.db, maxCliAttempts, maxSeconds },
    { env: deps.env, ...deps.requestSessionDeps });
  const results = [];
  let stopReason = null, interrupted = false;
  for (let index = 0; index < maxRecords; index++) {
    if (index) target = selectHistoryTarget(options.db);
    if (!target) break;
    if (maxCliAttempts - session.summary().cli_attempts < 2) { stopReason = 'cli_budget'; break; }
    try {
      session.assertReady();
      const result = executeHistoryTarget({ ...options, maxRecords }, deps, session, target);
      results.push(result);
    } catch (error) {
      stopReason = session.summary().stop_reason;
      if (!stopReason) {
        if (maxRecords === 1 || !results.length) throw error;
        interrupted = true;
      }
      if (maxRecords === 1) throw error;
      break;
    }
  }
  if (maxRecords === 1 && results.length) return results[0];
  const budget = { ...session.summary(), stop_reason: stopReason || session.summary().stop_reason };
  return { ok: !interrupted && results.every(result => result.ok) && !['rate_limited','rate_cooldown','lease_unavailable','shared_cooldown_unavailable','clock_unavailable'].includes(budget.stop_reason),
    profile: PROFILE, outcome: interrupted ? 'batch_interrupted' : results.length ? 'batch_processed' : 'batch_deferred',
    processed: results.length, priority_processed: results.filter(result => result.lane === 'priority').length,
    fair_processed: results.filter(result => result.lane !== 'priority').length,
    inserted: results.reduce((sum,result) => sum + result.inserted, 0),
    updated: results.reduce((sum,result) => sum + result.updated, 0),
    duplicate: results.reduce((sum,result) => sum + result.duplicate, 0),
    conflicts: results.reduce((sum,result) => sum + result.conflicts, 0),
    failed: results.filter(result => !result.ok).length,
    priority_hint_reason: results.at(-1)?.priority_hint_reason || 'not_attempted',
    ...(results.length ? { fair_round_reason: results.at(-1).fair_round_reason } : {}),
    request_budget: budget, cursor_policy: 'unchanged', coverage: 'known_rows_only' };
}

export { executeLarkImHistory, selectHistoryTarget };
