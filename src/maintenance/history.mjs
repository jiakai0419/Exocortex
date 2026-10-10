// @ts-check
import { randomUUID, createHash } from 'node:crypto';
import { createLarkImAdapter } from '../adapters/lark-im/adapter.mjs';
import { messageId, chatId, chatScopeId } from '../adapters/lark-im/core.mjs';
import { prepareChatWindowRecords } from '../adapters/lark-im/sync-runner.mjs';
import { createMaintenanceRequestSession } from './request-session.mjs';
import { readOnlySqliteJson } from '../storage/sqlite/readonly-query.mjs';
import { captureRemoteAccountBinding, readRemoteAccountBinding, accountBindingAdmissionError } from '../diagnostics/remote-account-binding.mjs';
import { commitBoundedReplayRecords, quoteSql, normalizeBoundedReplayRecords } from '../../dist/storage/sqlite/ingestion-store.js';
import { stable } from '../../dist/core/lark-observation.js';
import { SCOPE_CONFIG_POLICY, projectScopeConfig } from './scope-config-policy.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const PROFILE = 'known_record_history/v1';

/** Read-only selection. The fixed horizon excludes records arriving during this
 * sweep. Coverage here means processed known rows, never missing-source coverage. */
function selectHistoryTarget(db) {
  const source = readOnlySqliteJson(db, "SELECT enabled,config_json FROM sources WHERE id='lark.im';", 'read history source')[0];
  if (source?.enabled !== 1) return null;
  const baseline = JSON.parse(source.config_json).initial_sync_start_ms;
  if (!Number.isSafeInteger(baseline) || baseline < 100_000_000_000) throw new Error('history baseline unavailable');
  const eligible = `r.source_id='lark.im' AND r.record_type='lark.im.message' AND r.first_seen_scope_id=s.id
    AND r.occurred_at_ms>=${baseline} AND r.external_version IS NOT NULL
    AND r.external_version<>'' AND r.external_version NOT GLOB '*[^0-9]*'
    AND CASE WHEN json_valid(r.canonical_json) THEN json_extract(r.canonical_json,'$.source_api')='im.v1.messages' ELSE 0 END
    AND r.container_id=json_extract(s.config_json,'$.chat_id')`;
  const scope = readOnlySqliteJson(db, `SELECT s.*, COALESCE(p.generation,0) AS history_generation,
    COALESCE(p.after_id,0) AS history_after, COALESCE(p.sweep_max_id,0) AS history_max,
    COALESCE(p.completed_sweeps,0) AS history_sweeps,
    (SELECT MAX(r.id) FROM records r WHERE ${eligible}) AS current_max
    FROM sync_scopes s LEFT JOIN lark_im_history_progress p ON p.scope_id=s.id
    WHERE s.source_id='lark.im' AND s.enabled=1 AND s.id LIKE 'lark.im.received.chat.%'
    AND CASE WHEN json_valid(s.config_json) THEN json_type(s.config_json,'$.chat_id')='text' ELSE 0 END
    AND EXISTS(SELECT 1 FROM records r WHERE ${eligible})
    ORDER BY COALESCE(p.last_attempt_at_ms,0),s.id LIMIT 1;`, 'select history scope')[0];
  if (!scope) return null;
  if (chatScopeId(JSON.parse(scope.config_json).chat_id) !== scope.id) throw new Error("history scope identity unavailable");
  const recordWhere = `r.source_id='lark.im' AND r.record_type='lark.im.message'
    AND r.first_seen_scope_id=${quoteSql(scope.id)} AND r.container_id=${quoteSql(JSON.parse(scope.config_json).chat_id)}
    AND r.occurred_at_ms>=${baseline} AND r.external_version<>'' AND r.external_version NOT GLOB '*[^0-9]*'
    AND CASE WHEN json_valid(r.canonical_json) THEN json_extract(r.canonical_json,'$.source_api')='im.v1.messages' ELSE 0 END`;
  const read = (after, max) => readOnlySqliteJson(db, `SELECT r.*,o.generation AS observation_generation
    FROM records r JOIN record_observation_state o ON o.record_id=r.id
    WHERE ${recordWhere} AND r.id>${after} AND r.id<=${max} ORDER BY r.id LIMIT 1;`, 'select history record')[0];
  let horizon = scope.history_max;
  let selected = read(scope.history_after, horizon);
  if (!selected) { horizon = scope.current_max; selected = read(0, horizon); }
  if (!selected) return null;
  const { observation_generation, ...record } = selected;
  const { history_generation, history_after, history_max, history_sweeps, current_max, ...selectedScope } = scope;
  return { sourceConfigJson: source.config_json, baseline, scope: selectedScope, record, observationGeneration: observation_generation,
    checkpoint: { generation: history_generation, afterId: history_after, sweepMaxId: history_max,
      completedSweeps: history_sweeps, selectedId: record.id, nextSweepMaxId: horizon } };
}

/** One explicitly bounded autonomous slice; no name fanout or discovery cursor.
 * Tests inject a transport session, never real source or shared production state. */
function executeLarkImHistory(options, deps = {}) {
  const db = options.db;
  const maxCliAttempts = options.maxCliAttempts ?? 4, maxSeconds = options.maxSeconds ?? 30;
  if (!db || !Number.isSafeInteger(maxCliAttempts) || maxCliAttempts < 2 || maxCliAttempts > 4
    || !Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 30) throw new Error('history requires at most 4 requests and 30 seconds');
  const target = selectHistoryTarget(db);
  if (!target) return { ok: true, profile: PROFILE, outcome: 'no_eligible_known_record', cursor_policy: 'unchanged' };
  const now = deps.now || Date.now, startedAtMs = now(), attemptId = randomUUID();
  const binding = captureRemoteAccountBinding({ db });
  if (!binding || binding.conflict) throw new Error('history account binding unavailable');
  const session = (deps.createRequestSession || createMaintenanceRequestSession)({ db, maxCliAttempts, maxSeconds },
    { env: deps.env, ...deps.requestSessionDeps });
  const adapter = createLarkImAdapter({ run: session.runLark });
  const fetchOptions = { pageSize: 50, chatPageSize: 100, maxPages: 2, retries: 0, retryDelayMs: 0 };
  // Account failures do not advance a selected scope or publish a candidate.
  const self = (deps.getSelfProfile || adapter.getSelfProfile)(fetchOptions);
  const admission = readRemoteAccountBinding({ db, selfOpenId: self?.open_id });
  const accountKey = 'account_key' in admission ? admission.account_key : null;
  if (typeof self?.open_id !== 'string' || !self.open_id.startsWith('ou_') || admission.state !== 'verified' || !/^[a-f0-9]{64}$/.test(accountKey || '') || accountBindingAdmissionError(admission)) {
    throw new Error('history account identity unavailable');
  }
  const row = target.record, scope = target.scope, config = JSON.parse(scope.config_json);
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
  }
  const checkBinding = () => {
    if (JSON.stringify(captureRemoteAccountBinding({ db })) !== JSON.stringify(binding)
      || accountBindingAdmissionError(readRemoteAccountBinding({ db, selfOpenId: self.open_id }))) throw new Error('history account binding changed');
  };
  checkBinding();
  const requestBudget = session.summary();
  const effects = (deps.commit || commitBoundedReplayRecords)(db, {
    scope, initialSyncStartMs: target.baseline, startMs, endMs,
    planId: sha(JSON.stringify({ profile: PROFILE, scope: scope.id, horizon: target.checkpoint.nextSweepMaxId })),
    attemptId, selfIdHash: sha(self.open_id), pages, fetchedCount, records,
    observationAcquisition: { attempt: attemptId, startedAtMs, basis: new Map([[row.external_id, target.observationGeneration]]), confirm: true,
      contextKey: sha(JSON.stringify({ profile: PROFILE, self: self.open_id, account: accountKey,
        database: binding.database_key, source: sha(target.sourceConfigJson), scope: scope.id, chat: config.chat_id,
        scopePolicy: SCOPE_CONFIG_POLICY, scopeConfig: sha(stable(projectScopeConfig(config))) })) },
    history: { ...target.checkpoint, startedAtMs, error, requestBudget },
    reviewBeforeCommit: checkBinding,
    reviewFence: { mode: 'replay', createdAtMs: startedAtMs, expiresAtMs: startedAtMs + 30 * 60 * 1000,
      sourceConfigJson: target.sourceConfigJson, sentActor: binding.sent_actor || null, records: [row],
      scopes: [{ id: scope.id, source_id: scope.source_id, enabled: scope.enabled, config_json: scope.config_json }] },
  });
  return { ok: error === null, profile: PROFILE, outcome: error || (effects.conflicts ? 'pending_observation' : 'processed'),
    ...effects, request_budget: requestBudget, cursor_policy: 'unchanged', coverage: 'known_rows_only' };
}

export { executeLarkImHistory, selectHistoryTarget };
