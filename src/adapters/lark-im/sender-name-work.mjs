// @ts-check
import { createHash } from 'node:crypto';
import { quoteSql, REVIEW_RECORD_COLUMNS } from '../../../dist/storage/sqlite/ingestion-store.js';
import { patchJsonText, validateJsonObjectText } from '../../../dist/core/json-text-patch.js';
import { readOnlySqliteJson } from '../../storage/sqlite/readonly-query.mjs';
import { createNameResolver } from './name-resolver.mjs';
import { displayNameFromUser, personName, senderNameFromSource } from './sender-identity.mjs';
import { senderNameTarget, nameTaskKey } from './name-evidence.mjs';
import { recipientAccountKey } from './p2p-recipient.mjs';
import { readNameProjectionPage } from './name-projection-progress.mjs';

/** @typedef {Record<string,any>} JsonObject */
const SCHEMA = 'lark_sender_name_work/v1';
const RECORD_BYTES = 1024 * 1024, BATCH_BYTES = 2 * 1024 * 1024;
const MEMBER_PAGES_PER_TURN = 2, MEMBER_SWEEP_PAGES = 256, PROGRESS_AGE_MS = 24 * 60 * 60_000;
const RETRY_MS = 5 * 60_000;
const AUTHORITIES = new Set(['contact', 'chat_member', 'application_api', 'chat_bot_app_id']);
const NAME_FIELDS = ['sender_name', 'sender_name_state', 'sender_name_source', 'sender_name_confidence',
  'sender_name_resolution_status', 'sender_name_resolution_reason', 'sender_name_authority_source',
  'sender_name_account_key', 'sender_name_observed_at', 'sender_name_verification'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = (value, now) => typeof value === 'string' && Number.isSafeInteger(Date.parse(value))
  && Date.parse(value) >= 0 && Date.parse(value) <= now && new Date(Date.parse(value)).toISOString() === value;
const safeText = value => typeof value === 'string' && value.length > 0 && !value.includes('\0');
function taskValid(task, self, accountKey) {
  return task?.source_id === 'lark.im' && task.kind === 'sender' && task.account_key === accountKey
    && accountKey === recipientAccountKey(self?.open_id) && /^[a-f0-9]{64}$/.test(accountKey || '')
    && safeText(task.chat_id) && safeText(task.actor_id) && ['open_id','app_id'].includes(task.namespace)
    && task.task_key === nameTaskKey('sender', task.chat_id, task.actor_id, task.namespace)
    && integer(task.latest_record_id) && task.latest_record_id > 0 && integer(task.after_record_id || 0);
}
function baseEvidence(task) {
  return { schema: SCHEMA, source_id: 'lark.im', account_key: task.account_key,
    chat_id: task.chat_id, actor_id: task.actor_id, namespace: task.namespace };
}
function parseEvidence(task, nowMs) {
  try {
    if (typeof task.evidence_json !== 'string' || Buffer.byteLength(task.evidence_json) > 16 * 1024) return null;
    validateJsonObjectText(task.evidence_json);
    const value = JSON.parse(task.evidence_json), base = baseEvidence(task);
    if (!object(value) || Object.keys(base).some(key => value[key] !== base[key])) return null;
    const allowed = [...Object.keys(base), 'phase', ...(value.phase === 'resolved' ? ['observation']
      : value.phase === 'members' ? ['started_at', 'contact_checked_at', 'page_token', 'pages', 'token_hashes'] : [])];
    if (Object.keys(value).some(key => !allowed.includes(key))) return null;
    if (value.phase === 'resolved') {
      const observation = value.observation;
      const keys = ['status','reason','name','source','account_key','observed_at','cached'];
      if (!object(observation) || Object.keys(observation).some(key => !keys.includes(key))
        || observation.status !== 'resolved' || observation.reason !== 'exact_id_match'
        || !AUTHORITIES.has(observation.source) || observation.account_key !== task.account_key
        || observation.cached !== false || !timestamp(observation.observed_at, nowMs)
        || !personName(observation.name, [task.actor_id])
        || task.namespace === 'open_id' && !['contact','chat_member'].includes(observation.source)
        || task.namespace === 'app_id' && !['application_api','chat_bot_app_id'].includes(observation.source)) return null;
      return value;
    }
    if (value.phase !== 'members' || task.namespace !== 'open_id'
      || !timestamp(value.started_at, nowMs) || !timestamp(value.contact_checked_at, nowMs)
      || nowMs - Date.parse(value.started_at) > PROGRESS_AGE_MS
      || typeof value.page_token !== 'string' || value.page_token.length > 4096 || value.page_token.includes('\0')
      || !integer(value.pages) || value.pages > MEMBER_SWEEP_PAGES || !Array.isArray(value.token_hashes)
      || value.token_hashes.length > 16 || value.token_hashes.some(token => typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))) return null;
    return value;
  } catch { return null; }
}
function matchingTarget(row, task) {
  if (row?.source_id !== 'lark.im' || row.container_id !== task.chat_id || row.actor_id !== task.actor_id
    || !REVIEW_RECORD_COLUMNS.every(column => Object.hasOwn(row, column))
    || Object.values(row).some(value => typeof value === 'string' && value.includes('\0'))) return null;
  const target = senderNameTarget(row);
  if (!target || target.namespace !== task.namespace) return null;
  const native = object(target.raw.raw_api) ? target.raw.raw_api : target.raw;
  if ([target.raw.sender_name_state, target.raw.sender?.name_state, native.sender_name_state, native.sender?.name_state].includes('cleared')
    || [target.raw.message_type, native.message_type, native.msg_type].includes('system')) return null;
  const accountMarkers = [target.canonical.chat_name_account_key, target.canonical.sender_name_account_key,
    target.canonical.sender_name_verification?.account_key];
  if (accountMarkers.some(value => value != null && value !== task.account_key)) return null;
  return target;
}
function resolved(task, observation, nowMs) {
  if (observation?.status !== 'resolved' || observation.reason !== 'exact_id_match'
    || !AUTHORITIES.has(observation.source) || observation.account_key !== task.account_key
    || !personName(observation.name, [task.actor_id]) || !timestamp(observation.observed_at, nowMs)) return null;
  return { ...baseEvidence(task), phase: 'resolved', observation: {
    status: 'resolved', reason: 'exact_id_match', name: observation.name, source: observation.source,
    account_key: task.account_key, observed_at: observation.observed_at, cached: false } };
}
function recordPredicate(task) {
  return `source_id='lark.im' AND record_type='lark.im.message' AND actor_id=${quoteSql(task.actor_id)}
    AND container_id=${quoteSql(task.chat_id)}`;
}
/** Row metadata is bounded before payloads are materialized. The current work
 * horizon cannot move while fresh traffic arrives. Oversized rows remain debt. */
function readPage(task, query) {
  return readNameProjectionPage(task, query, { index: 'records_name_sender', predicate: recordPredicate(task),
    label: 'sender records', recordBytes: RECORD_BYTES, batchBytes: BATCH_BYTES });
}
function applyEvidence(task, evidence, query) {
  const page = readPage(task, query), updates = [];
  let capacityDeferred = page.capacityDeferred;
  for (const row of page.rows) {
    const target = matchingTarget(row, task);
    if (!(target?.unknown || target?.needsVerification) || senderNameFromSource(target.raw)) continue;
    const observation = evidence.observation;
    if (!personName(observation.name, [row.actor_id, ...target.identity.identifiers])) continue;
    const next = { sender_name: observation.name, sender_name_source: observation.source,
      sender_name_confidence: 'high', sender_name_resolution_status: 'resolved',
      sender_name_resolution_reason: 'exact_id_match', sender_name_authority_source: observation.source,
      sender_name_account_key: task.account_key, sender_name_observed_at: observation.observed_at,
      sender_name_verification: observation };
    try {
      const patches = NAME_FIELDS.map(key => ({ path: [key], value: Object.hasOwn(next, key) ? JSON.stringify(next[key]) : undefined }));
      const canonical = patchJsonText(row.canonical_json, patches, NAME_FIELDS.map(key => [key]));
      if (canonical === row.canonical_json) continue;
      // The coordinator commits these exact predecessors with the task generation
      // and account admission. Message/body/source clocks are not mutation rights.
      updates.push(`UPDATE records SET canonical_json=${quoteSql(canonical)} WHERE ${REVIEW_RECORD_COLUMNS
        .map(column => `${column} IS ${quoteSql(row[column])}`).join(' AND ')}`);
    } catch { capacityDeferred = true; }
  }
  return { outcome: page.more ? 'pending' : capacityDeferred ? 'capacity_deferred' : 'resolved',
    evidenceJson: JSON.stringify(evidence), afterRecordId: page.after,
    horizonRecordId: page.horizon, projectionDeferred: capacityDeferred,
    retryDelayMs: page.more ? 0 : capacityDeferred ? RETRY_MS : PROGRESS_AGE_MS, updates };
}

/** Prepare one typed sender task. No transaction, lock, profile lookup or write:
 * the coordinator owns shared budgets, profile verification and atomic claim/CAS.
 * Unfinished member walks retain a bounded cursor across processes. */
function prepareSenderWork(task, { db, self, accountKey, nowMs = Date.now(), query = undefined, runLark, witness = undefined }) {
  const read = query || ((sql, label) => readOnlySqliteJson(db, sql, label));
  const empty = (outcome, evidence = null, retryDelayMs = RETRY_MS) => ({ outcome,
    evidenceJson: evidence ? JSON.stringify(evidence) : null, afterRecordId: task.after_record_id || 0,
    horizonRecordId: task.projection_horizon_record_id || task.latest_record_id,
    projectionDeferred: Boolean(task.projection_deferred), retryDelayMs, updates: [] });
  if (!taskValid(task, self, accountKey) || !integer(nowMs)) return empty('invalid_target');
  let evidence = parseEvidence(task, nowMs);
  if (evidence?.phase === 'resolved') {
    const prepared = applyEvidence(task, evidence, read);
    if (nowMs - Date.parse(evidence.observation.observed_at) <= PROGRESS_AGE_MS || !prepared.updates.length) return prepared;
    evidence = null;
  }
  const size = REVIEW_RECORD_COLUMNS.filter(column => !['id','occurred_at_ms'].includes(column))
    .map(column => `length(CAST(COALESCE(${column},'') AS BLOB))`).join('+');
  const witnesses = witness ? [witness] : read(`SELECT ${REVIEW_RECORD_COLUMNS.join(',')} FROM records WHERE id=${task.latest_record_id}
    AND (${size})<=${RECORD_BYTES};`, 'read sender work witness');
  let target = matchingTarget(witnesses[0], task);
  if (!target) {
    const fallback = readPage(task, read);
    target = fallback.rows.map(row => matchingTarget(row, task)).find(Boolean) || null;
    if (!target) return { ...empty(fallback.more ? 'pending' : 'invalid_target', evidence,
      fallback.more ? 0 : PROGRESS_AGE_MS), afterRecordId: fallback.after,
      horizonRecordId: fallback.horizon, projectionDeferred: fallback.capacityDeferred };
  }
  let attempts = 0, budgetStopped = false;
  const run = (args, options = {}) => {
    if (attempts >= 3) { budgetStopped = true; throw new Error('sender work budget exhausted'); }
    attempts++;
    try {
      const response = runLark(args, { ...options, retries: 0, retryDelayMs: 0 });
      if (!object(response) || Object.hasOwn(response, 'code') && response.code !== 0
        || response.success === false || response.error != null) throw new Error('sender response failed');
      return response;
    }
    catch (error) {
      if (/budget|request limit|clock unavailable/iu.test(String(/** @type {any} */ (error)?.name) + ' ' + String(/** @type {any} */ (error)?.message))) budgetStopped = true;
      throw error;
    }
  };
  if (!evidence || nowMs - Date.parse(evidence.contact_checked_at) >= RETRY_MS) {
    const previousProgress = evidence;
    const resolver = createNameResolver({ run, now: () => nowMs });
    const result = resolver.verifySenderName(target.raw, null, self, { memberPageLimit: 0, forceRefresh: true });
    const observation = task.namespace === 'open_id'
      ? result.lookups.find(item => item.source === 'contact') : result.observation;
    evidence = resolved(task, observation, nowMs);
    if (evidence) return applyEvidence(task, evidence, read);
    if (observation?.status === 'conflict') return empty('conflict');
    if (budgetStopped) return empty('failed', previousProgress);
    if (task.namespace === 'app_id') return empty(observation?.status === 'failed' ? 'failed' : 'unresolved');
    const native = object(target.raw.raw_api) ? target.raw.raw_api : target.raw;
    if ([target.canonical.chat_type, target.raw.chat_type, native.chat_type, native.chat?.chat_type].includes('p2p'))
      return empty(observation?.status === 'failed' ? 'failed' : 'unresolved');
    evidence = previousProgress ? { ...previousProgress, contact_checked_at: new Date(nowMs).toISOString() }
      : { ...baseEvidence(task), phase: 'members', started_at: new Date(nowMs).toISOString(),
        contact_checked_at: new Date(nowMs).toISOString(), page_token: '', pages: 0, token_hashes: [] };
  }
  // Exact member pages continue where the last process stopped. A permission or
  // transient failure never advances the saved token. Bounded sweeps periodically
  // restart so previously absent members and expired tokens can recover as well.
  for (let page = 0; page < MEMBER_PAGES_PER_TURN && attempts < 3; page++) {
    if (evidence.pages >= MEMBER_SWEEP_PAGES) return empty('unresolved');
    const params = { chat_id: task.chat_id, member_id_type: 'open_id', page_size: 100,
      ...(evidence.page_token ? { page_token: evidence.page_token } : {}) };
    let response;
    try { response = run(['im','chat.members','get','--as','user','--params',JSON.stringify(params),'--format','json'],
      { redactedFlags: ['--params'] }); }
    catch { return empty('failed', evidence); }
    const items = response?.items ?? response?.data?.items;
    if (Array.isArray(items) && items.length > 1000) return empty('capacity_deferred', evidence);
    if (!Array.isArray(items) || items.some(item => !object(item)
      || !safeText(item.member_id) || item.member_id_type != null && typeof item.member_id_type !== 'string'))
      return empty('failed', evidence);
    const matching = items.filter(item => item?.member_id === task.actor_id);
    const conflict = matching.some(item => item.member_id_type != null && item.member_id_type !== 'open_id'
      || item.open_id != null && item.open_id !== task.actor_id);
    const names = new Set(matching.map(item => displayNameFromUser(item, target.identity.identifiers)));
    if (conflict || names.size > 1) return empty('conflict');
    if (names.size === 1 && !names.has('')) {
      const name = [...names][0];
      const answer = resolved(task, { status: 'resolved', reason: 'exact_id_match', name, source: 'chat_member',
        account_key: task.account_key, observed_at: new Date(nowMs).toISOString() }, nowMs);
      return applyEvidence(task, answer, read);
    }
    const hasMore = response?.has_more ?? response?.data?.has_more ?? false;
    if (typeof hasMore !== 'boolean') return empty('failed', evidence);
    if (!hasMore) return empty('unresolved');
    const token = response?.page_token ?? response?.data?.page_token;
    if (!safeText(token) || token.length > 4096 || token === evidence.page_token
      || evidence.token_hashes.includes(hash(token))) return empty('failed');
    evidence = { ...evidence, page_token: token, pages: evidence.pages + 1,
      token_hashes: [...evidence.token_hashes, hash(token)].slice(-16) };
  }
  return empty('pending', evidence, 0);
}

export { prepareSenderWork };
