// @ts-check
import { randomUUID } from 'node:crypto';
import { quoteSql, REVIEW_RECORD_COLUMNS } from '../../../dist/storage/sqlite/ingestion-store.js';
import { validateJsonObjectText } from '../../../dist/core/json-text-patch.js';
import { captureLarkWriteAdmission } from '../../diagnostics/lark-write-admission.mjs';
import { commitEnrichmentUpdates } from '../../maintenance/enrichment-commit.mjs';
import { enrichRecipients } from '../../maintenance/enrich-recipients.mjs';
import { readOnlySqliteJson } from '../../storage/sqlite/readonly-query.mjs';
import { getLarkApiLeaseStdio } from '../../runtime/lark-api-lease.mjs';
import { chatScopeId } from './core.mjs';
import { readRecipientEvidence, recipientAccountKey, sentRecipientAccount } from './p2p-recipient.mjs';
import { runLark } from './transport.mjs';

/** @typedef {Record<string,any>} JsonObject */
const MAX_CHATS = 20, SCAN_PAGE = 40, QUEUE_CHATS = 10, WITNESS_PAGE = 8;
const MAX_CALLS = 4, BUDGET_MS = 10_000, CLAIM_MS = 5 * 60_000, MAX_RETRY_MS = 24 * 60 * 60_000;
const COMPLETE_RETRY_AT = Number.MAX_SAFE_INTEGER;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeRow = row => Number.isSafeInteger(row.id) && row.id > 0 && typeof row.container_id === 'string' && row.container_id.length > 0
  && (row.occurred_at_ms === null || Number.isSafeInteger(row.occurred_at_ms))
  && !Object.values(row).some(value => typeof value === 'string' && value.includes('\0'));
class RecipientBudgetError extends Error {}

function witness(row, account) {
  if (!safeRow(row)) return false;
  try {
    const canonical = JSON.parse(row.canonical_json || '{}'), raw = JSON.parse(row.raw_json);
    const native = object(raw?.raw_api) ? raw.raw_api : raw;
    return sentRecipientAccount(row, canonical, raw) === account
      && ![canonical, raw, raw?.chat, native, native?.chat].some(value =>
        ['group', 'topic'].includes(value?.chat_type) || ['group', 'topic'].includes(value?.chat_mode));
  } catch { return false; }
}
function savedEvidence(state, self, nowMs) {
  if (!state?.evidence_json) return null;
  try {
    validateJsonObjectText(state.evidence_json);
    return readRecipientEvidence({ chat_id: state.chat_id, p2p_recipient: JSON.parse(state.evidence_json) }, self, { nowMs });
  } catch { return null; }
}
function permittedScope(scope, chatId) {
  if (!scope) return true;
  try {
    validateJsonObjectText(scope.config_json);
    const config = JSON.parse(scope.config_json);
    return scope.source_id === 'lark.im' && config.chat_id === chatId
      && [config.chat_type, config.chat_mode].every(value => value == null || ['p2p', 'unknown'].includes(value));
  } catch { return false; }
}
const recordFence = row => `EXISTS(SELECT 1 FROM records WHERE ${REVIEW_RECORD_COLUMNS
  .map(column => `${column} IS ${quoteSql(row[column])}`).join(' AND ')})`;
const scopeFence = (scope, chatId) => scope ? `EXISTS(SELECT 1 FROM sync_scopes WHERE id IS ${quoteSql(scope.id)}
  AND source_id IS ${quoteSql(scope.source_id)} AND enabled IS ${quoteSql(scope.enabled)}
  AND config_json IS ${quoteSql(scope.config_json)} AND updated_at IS ${quoteSql(scope.updated_at)})`
  : `NOT EXISTS(SELECT 1 FROM sync_scopes WHERE id=${quoteSql(chatScopeId(chatId))})`;
const stateKey = (chatId, accountKey) => `source_id='lark.im' AND account_key=${quoteSql(accountKey)} AND chat_id=${quoteSql(chatId)}`;
const effects = sql => `${sql}; INSERT INTO __enrichment_effects(updated) VALUES(changes());`;
const fence = predicate => `CREATE TEMP TABLE IF NOT EXISTS __recipient_state_fence(allowed INTEGER NOT NULL CHECK(allowed=1));
  INSERT INTO __recipient_state_fence SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END;`;

/** The successful sent/all tail retains its sync API lease. Fixed quotas bound
 * discovery to 40 newest + 40 historical sent rows and queue witnesses to
 * 10 chats x 8 rows. No scope, message, history context or status is written.
 * @param {string} db @param {JsonObject} self @param {JsonObject} [deps] */
function syncRecipients(db, self, deps = {}) {
  const now = deps.now || Date.now, monotonic = deps.monotonicNow || (() => performance.now());
  const started = monotonic(), nowMs = now(), accountKey = recipientAccountKey(self?.open_id);
  let calls = 0, claimed = 0, clockLast = started, deferredTransport = false;
  const report = { attempted: 0, updated: 0, deferred: 0, calls: 0, reason: 'idle' };
  if (!deps.runLark && !getLarkApiLeaseStdio()) return { ...report, reason: 'lease_unavailable' };
  if (!accountKey || !Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isFinite(started)) return report;
  const remaining = () => {
    const current = monotonic();
    if (!Number.isFinite(current) || current < clockLast) throw new RecipientBudgetError('recipient clock unavailable');
    clockLast = current; return Math.floor(BUDGET_MS - (current - started));
  };
  const assertReady = () => { if (!(remaining() > 0)) throw new RecipientBudgetError('recipient budget exhausted'); };
  const query = (sql, label) => { assertReady(); return (deps.readOnlyQuery || readOnlySqliteJson)(db, sql, label, { timeoutMs: Math.max(1, remaining()) }); };
  const readSent = (where, order, limit, index) => query(`SELECT ${REVIEW_RECORD_COLUMNS.join(',')} FROM records INDEXED BY ${index}
    WHERE source_id='lark.im' AND direction='sent' AND record_type='lark.im.message' ${where}
    ORDER BY id ${order} LIMIT ${limit};`, 'read bounded recipient witnesses');
  try {
    const admission = captureLarkWriteAdmission(db, { selfOpenId: self.open_id, requireVerified: true });
    const scan = query(`SELECT * FROM lark_im_recipient_scan WHERE account_key=${quoteSql(accountKey)};`, 'read recipient scan cursor')[0];
    const newest = readSent('', 'DESC', SCAN_PAGE, 'records_recipient_sent_id');
    let historical = readSent(`AND id>${Number(scan?.after_record_id || 0)}`, 'ASC', SCAN_PAGE, 'records_recipient_sent_id');
    if (!historical.length && scan?.after_record_id) historical = readSent('', 'ASC', SCAN_PAGE, 'records_recipient_sent_id');
    const afterRecordId = historical.length ? historical[historical.length - 1].id : 0;
    if (!Number.isSafeInteger(afterRecordId)) throw new Error('recipient scan cursor unavailable');
    const dueQueue = query(`SELECT * FROM lark_im_recipient_state INDEXED BY lark_im_recipient_state_due
      WHERE source_id='lark.im' AND account_key=${quoteSql(accountKey)} AND retry_at_ms<=${nowMs}
      ORDER BY retry_at_ms,last_attempt_at_ms,enqueued_at_ms,chat_id LIMIT ${QUEUE_CHATS};`, 'read bounded due recipients');
    const changedQueue = query(`SELECT * FROM lark_im_recipient_state INDEXED BY lark_im_recipient_state_changed
      WHERE source_id='lark.im' AND account_key=${quoteSql(accountKey)} AND attempt_evidence_json IS NOT evidence_json
      ORDER BY last_attempt_at_ms,enqueued_at_ms,chat_id LIMIT ${QUEUE_CHATS};`, 'read bounded changed recipients');
    /** @type {JsonObject[]} */
    const queued = [];
    const take = (rows, count) => {
      let taken = 0;
      for (const row of rows) {
        if (taken >= count || queued.length >= QUEUE_CHATS) break;
        if (!queued.some(item => item.chat_id === row.chat_id)) { queued.push(row); taken += 1; }
      }
    };
    take(dueQueue, 5); take(changedQueue, 5); take(dueQueue, QUEUE_CHATS); take(changedQueue, QUEUE_CHATS);
    /** @type {Map<string,JsonObject[]>} */
    const queueRows = new Map();
    for (const state of queued) {
      if (typeof state.chat_id !== 'string' || !state.chat_id || state.chat_id.includes('\0')) continue;
      queueRows.set(state.chat_id, readSent(`AND container_id=${quoteSql(state.chat_id)} AND id>${Number(state.record_after_id || 0)}`,
        'ASC', WITNESS_PAGE, 'records_recipient_sent_container_id'));
    }
    const validNew = newest.filter(row => witness(row, self.open_id)), validOld = historical.filter(row => witness(row, self.open_id));
    const chats = [...new Set([...validNew, ...validOld].map(row => row.container_id).concat(queued.map(row => row.chat_id)))];
    const scopeIds = chats.map(chatScopeId);
    const scopes = scopeIds.length ? query(`SELECT id,source_id,enabled,config_json,updated_at,
      json_extract(config_json,'$.p2p_recipient') AS legacy_evidence FROM sync_scopes
      WHERE id IN (${scopeIds.map(quoteSql).join(',')});`, 'read recipient scope constraints') : [];
    const scopeFor = chatId => scopes.find(scope => scope.id === chatScopeId(chatId));
    const states = chats.length ? query(`SELECT * FROM lark_im_recipient_state WHERE source_id='lark.im' AND account_key=${quoteSql(accountKey)}
      AND chat_id IN (${chats.map(quoteSql).join(',')});`, 'read exact recipient states') : [];
    const stateFor = chatId => states.find(state => state.chat_id === chatId);
    const due = state => !state || state.retry_at_ms <= nowMs || state.attempt_evidence_json !== state.evidence_json;
    /** @type {Map<string,{chatId:string,row:JsonObject,scope:JsonObject|undefined,evidenceJson:string|null}>} */
    const enroll = new Map();
    for (const row of [...validNew, ...validOld]) {
      const scope = scopeFor(row.container_id);
      if (!stateFor(row.container_id) && permittedScope(scope, row.container_id) && !enroll.has(row.container_id)) {
        let evidenceJson = null;
        if (scope?.legacy_evidence) {
          try {
            if (readRecipientEvidence(JSON.parse(scope.config_json), self.open_id, { includeConflicted: true, nowMs })) evidenceJson = scope.legacy_evidence;
          } catch { /* A legacy cache is optional, never account evidence. */ }
        }
        enroll.set(row.container_id, { chatId: row.container_id, row, scope, evidenceJson });
      }
    }
    /** @type {Array<{chatId:string,row:JsonObject|null,scope:JsonObject|undefined,state:JsonObject|undefined,afterId:number}>} */
    const selected = [];
    const seen = new Set();
    const add = (chatId, row, afterId = 0) => {
      const state = stateFor(chatId), scope = scopeFor(chatId);
      const cached = state || { chat_id: chatId, evidence_json: enroll.get(chatId)?.evidenceJson };
      if (selected.length >= MAX_CHATS || seen.has(chatId) || !due(state) || savedEvidence(cached, self.open_id, nowMs)?.name) return;
      seen.add(chatId);
      selected.push({ chatId, row: permittedScope(scope, chatId) ? row : null, scope, state, afterId });
    };
    // Fixed quotas guarantee retries, newly sent chats and historical migration
    // all advance even under continuous incoming sent traffic.
    for (const state of queued) {
      const rows = queueRows.get(state.chat_id) || [];
      const row = [...rows, ...validNew, ...validOld].find(value => value.container_id === state.chat_id && witness(value, self.open_id)) || null;
      add(state.chat_id, row, row ? 0 : rows.length === WITNESS_PAGE ? rows[rows.length - 1].id : 0);
    }
    const addLane = (rows, quota) => {
      let added = 0;
      for (const row of rows) {
        if (added >= quota) break;
        if (!permittedScope(scopeFor(row.container_id), row.container_id)) continue;
        const before = selected.length; add(row.container_id, row); added += selected.length - before;
      }
    };
    addLane(validNew, 5); addLane(validOld, 5);
    addLane(validNew, MAX_CHATS); addLane(validOld, MAX_CHATS);
    const boundScopes = [...enroll.values(), ...selected].flatMap(item => item.scope?.source_id === 'lark.im' ? [item.scope.id] : []);
    admission.bindScopes(boundScopes);
    const token = randomUUID(), updates = [];
    if ((scan?.after_record_id || 0) !== afterRecordId || !scan && historical.length) {
      updates.push(effects(`${fence(scan ? `EXISTS(SELECT 1 FROM lark_im_recipient_scan WHERE account_key=${quoteSql(accountKey)}
        AND after_record_id=${scan.after_record_id} AND generation=${scan.generation})`
        : `NOT EXISTS(SELECT 1 FROM lark_im_recipient_scan WHERE account_key=${quoteSql(accountKey)})`)}
        INSERT INTO lark_im_recipient_scan(account_key,after_record_id,generation) VALUES(${quoteSql(accountKey)},${afterRecordId},${Number(scan?.generation || 0) + 1})
        ON CONFLICT(account_key) DO UPDATE SET after_record_id=excluded.after_record_id,generation=excluded.generation`));
    }
    for (const { chatId, row, scope, evidenceJson } of enroll.values()) {
      const complete = Boolean(savedEvidence({ chat_id: chatId, evidence_json: evidenceJson }, self.open_id, nowMs)?.name);
      updates.push(effects(`${fence(`${recordFence(row)} AND ${scopeFence(scope, chatId)} AND NOT EXISTS(SELECT 1 FROM lark_im_recipient_state WHERE ${stateKey(chatId, accountKey)})`)}
        INSERT INTO lark_im_recipient_state(source_id,account_key,chat_id,enqueued_at_ms,retry_at_ms,evidence_json,attempt_evidence_json)
          VALUES('lark.im',${quoteSql(accountKey)},${quoteSql(chatId)},${nowMs},${complete ? COMPLETE_RETRY_AT : nowMs},${quoteSql(evidenceJson)},${quoteSql(evidenceJson)})`));
    }
    // Existing manual evidence is classified locally once. The exact snapshot
    // stays out of the due index; any later change enters the changed index.
    for (const state of states) {
      if (!savedEvidence(state, self.open_id, nowMs)?.name || state.retry_at_ms === COMPLETE_RETRY_AT && state.attempt_evidence_json === state.evidence_json) continue;
      updates.push(effects(`UPDATE lark_im_recipient_state SET retry_at_ms=${COMPLETE_RETRY_AT},failures=0,attempt_evidence_json=evidence_json
        WHERE ${stateKey(state.chat_id, accountKey)} AND evidence_json IS ${quoteSql(state.evidence_json)}
          AND generation=${state.generation} AND attempt_token IS ${quoteSql(state.attempt_token)}`));
    }
    for (const item of selected) {
      const { state, row, scope, chatId, afterId } = item, generation = Number(state?.generation || 0);
      const statePredicate = state ? `generation=${generation} AND evidence_json IS ${quoteSql(state.evidence_json)}
        AND attempt_token IS ${quoteSql(state.attempt_token)} AND retry_at_ms=${state.retry_at_ms}`
        : `generation=0 AND attempt_token IS NULL AND evidence_json IS ${quoteSql(enroll.get(chatId)?.evidenceJson ?? null)}`;
      updates.push(effects(`${fence(`${scopeFence(scope, chatId)} ${row ? `AND ${recordFence(row)}` : ''}
          AND EXISTS(SELECT 1 FROM lark_im_recipient_state WHERE ${stateKey(chatId, accountKey)} AND ${statePredicate})`)}
        UPDATE lark_im_recipient_state SET last_attempt_at_ms=${nowMs},retry_at_ms=${nowMs + CLAIM_MS},
          record_after_id=${afterId},generation=${generation + 1},attempt_token=${quoteSql(token)},attempt_evidence_json=evidence_json
          WHERE ${stateKey(chatId, accountKey)}`));
    }
    assertReady();
    commitEnrichmentUpdates(db, updates, { dryRun: false, reason: 'recipient-sync-claim', label: 'claim recipient relationships',
      writeAdmission: admission.fence, admissionBeforeCommit: admission.assertCurrent, withCommit: action => action() });
    claimed = selected.length;
    const targets = selected.filter(item => item.row !== null).map(item => ({ ...item, row: /** @type {JsonObject} */ (item.row) }));
    report.deferred = selected.length - targets.length;
    if (!targets.length) return { ...report, reason: selected.length ? 'witness_unavailable' : 'idle' };
    /** @type {Map<string,string>} */
    const outcomes = new Map();
    const boundedRun = (args, options = {}) => {
      assertReady();
      if (calls >= MAX_CALLS) throw new RecipientBudgetError('recipient request limit reached');
      const budget = remaining(); if (budget <= 0) throw new RecipientBudgetError('recipient budget exhausted');
      calls += 1;
      try { return (deps.runLark || runLark)(args, { ...options, retries: 0, timeoutMs: Math.min(5000, budget), retryBudgetMs: budget, maxBufferBytes: 2 * 1024 * 1024 }); }
      catch (error) {
        if (error instanceof Error && /retry_after_source=shared|reason=shared_cooldown_unavailable|reason=sync_busy/.test(error.message)) deferredTransport = true;
        throw error;
      }
    };
    const result = (deps.enrichRecipients || enrichRecipients)({ db, recordIds: targets.map(item => item.row.id), dryRun: false },
      { runLark: boundedRun, assertReady, withCommit: action => action(), now,
        onRecipientResult: ({ chat_id, outcome }) => outcomes.set(chat_id, outcome) });
    report.attempted = targets.length; report.updated = Number(result.updated || 0);
    const current = query(`SELECT * FROM lark_im_recipient_state WHERE source_id='lark.im' AND account_key=${quoteSql(accountKey)}
      AND chat_id IN (${targets.map(item => quoteSql(item.chatId)).join(',')});`, 'read completed recipient relationships');
    const finishAdmission = captureLarkWriteAdmission(db, { selfOpenId: self.open_id, requireVerified: true });
    const finishes = [];
    for (const item of targets) {
      const state = current.find(value => value.chat_id === item.chatId), outcome = outcomes.get(item.chatId);
      if (!state || !outcome || !['resolved', 'name_missing', 'unresolved', 'conflict', 'failed'].includes(outcome)) continue;
      const complete = outcome === 'resolved' && Boolean(savedEvidence(state, self.open_id, now())?.name);
      const failures = complete ? 0 : Math.min(16, Number(item.state?.failures || 0) + (deferredTransport ? 0 : 1));
      const delay = deferredTransport ? CLAIM_MS : Math.min(MAX_RETRY_MS, CLAIM_MS * 2 ** Math.max(0, failures - 1));
      finishes.push(effects(`UPDATE lark_im_recipient_state SET failures=${failures},retry_at_ms=${complete ? COMPLETE_RETRY_AT : nowMs + delay},
        attempt_evidence_json=evidence_json WHERE ${stateKey(item.chatId, accountKey)} AND attempt_token=${quoteSql(token)}
        AND generation=${Number(item.state?.generation || 0) + 1} AND evidence_json IS ${quoteSql(state.evidence_json)} AND ${recordFence(item.row)}`));
    }
    assertReady();
    commitEnrichmentUpdates(db, finishes, { dryRun: false, reason: 'recipient-sync-result', label: 'finish recipient relationships',
      writeAdmission: finishAdmission.fence, admissionBeforeCommit: finishAdmission.assertCurrent, withCommit: action => action() });
    return { ...report, calls, reason: deferredTransport ? 'deferred' : 'completed' };
  } catch (error) {
    return { ...report, calls, deferred: claimed || report.deferred,
      reason: error instanceof RecipientBudgetError ? 'budget' : claimed ? 'deferred' : 'unavailable' };
  }
}

export { syncRecipients };
