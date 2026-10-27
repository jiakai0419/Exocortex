// @ts-check
import { createHash } from 'node:crypto';
import { quoteSql } from '../../dist/storage/sqlite/sqlite-executor.js';
import { summarizeMessageCompleteness } from './message-completeness-summary.mjs';

export const READINESS_CONTRACT_VERSION = 1;
export const READINESS_OBSERVATION_INTERVAL_MS = 60_000;
export const READINESS_OBSERVATION_LIMIT = 40;
const ROLE_LIMIT = 20, ROW_BYTES = 2 * 1024 * 1024, ROLE_BYTES = 2 * 1024 * 1024;
const TABLE = 'lark_im_message_readiness', SCAN = 'lark_im_message_readiness_scan';
const SOURCE = "source_id='lark.im' AND record_type='lark.im.message'";
const PROOF = ['id', 'source_id', 'record_type', 'external_id', 'external_version',
  'actor_id', 'container_id', 'direction', 'occurred_at', 'occurred_at_ms', 'raw_json'];
const EFFECT = 'INSERT INTO __enrichment_effects(updated) VALUES(changes());';
/** @param {unknown} value @returns {value is Record<string,any>} */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @returns {value is number} */
const integer = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const account = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const keyWhere = observer => `source_id='lark.im' AND observer_account_key=${quoteSql(observer)} AND contract_version=${READINESS_CONTRACT_VERSION}`;
const recordWhere = (observer, id) => `${keyWhere(observer)} AND record_id=${id}`;
const failed = (reason, scanned = 0) => ({ reason, scanned, observed: 0, deferred: scanned });
function payloadBytes(row) {
  if (!object(row) || typeof row.raw_json !== 'string'
    || !['canonical_json', 'body'].every(key => row[key] === null || typeof row[key] === 'string')) return null;
  return ['raw_json', 'canonical_json', 'body'].reduce((sum, key) => sum + Buffer.byteLength(row[key] ?? ''), 0);
}

function time(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return integer(ms) && ms <= 8_640_000_000_000_000 && new Date(ms).toISOString() === value ? ms : null;
}

/** Exact accepted-source epoch; it intentionally does not hash derived names.
 * It cannot discover a source A -> B -> A transition between observations. */
export function readinessSourceVersionKey(proof) {
  return hash(JSON.stringify([proof.external_version, hash(proof.raw_json)]));
}

function validProof(proof) {
  return object(proof) && PROOF.every(key => Object.hasOwn(proof, key))
    && integer(proof.id) && proof.id > 0 && proof.source_id === 'lark.im'
    && proof.record_type === 'lark.im.message' && typeof proof.external_id === 'string'
    && typeof proof.raw_json === 'string'
    && Buffer.byteLength(proof.raw_json) <= ROW_BYTES
    && [proof.external_version, proof.actor_id, proof.container_id, proof.occurred_at]
      .every(value => value === null || typeof value === 'string')
    && (proof.direction === null || ['sent', 'received'].includes(proof.direction))
    && (proof.occurred_at_ms === null || Number.isSafeInteger(proof.occurred_at_ms))
    && PROOF.every(key => typeof proof[key] !== 'string' || !proof[key].includes('\0'));
}

/** Generate guarded SQL from a completed reading pipeline. This stores only
 * past observations; it never grants ownership or overrides current readiness.
 * Each update records changes() for the caller's existing guarded transaction.
 * @param {{messages:unknown,metadata:unknown,previous?:Record<string,any>[],observerAccountKey:string}} options
 */
export function planReadinessObservations({ messages, metadata, previous = [], observerAccountKey }) {
  /** @type {string[]} */
  const updates = [];
  const scanned = Array.isArray(messages) ? messages.length : 0;
  const invalid = () => ({ ...failed('invalid_observation', scanned), updates: [] });
  if (!account(observerAccountKey) || !Array.isArray(messages) || messages.length > READINESS_OBSERVATION_LIMIT
    || !object(metadata) || metadata.observation_complete !== true || !object(metadata.as_of)
    || !Array.isArray(metadata.source_records) || metadata.source_records.length !== messages.length
    || !Array.isArray(previous)) return invalid();
  const at = time(metadata.as_of.read_at);
  if (at === null) return invalid();
  const proofs = new Map(), priors = new Map();
  let bytes = 0;
  for (const proof of metadata.source_records) {
    if (!validProof(proof) || proofs.has(proof.id)) return invalid();
    bytes += Buffer.byteLength(proof.raw_json);
    if (bytes > 2 * ROLE_BYTES) return invalid();
    proofs.set(proof.id, proof);
  }
  for (const old of previous) {
    if (!object(old) || !integer(old.record_id) || priors.has(old.record_id)
      || old.source_id !== 'lark.im' || old.observer_account_key !== observerAccountKey
      || old.contract_version !== READINESS_CONTRACT_VERSION) return invalid();
    priors.set(old.record_id, old);
  }
  const seen = new Set();
  let deferred = 0, actualBytes = 0;
  for (const row of messages) {
    if (!object(row) || !integer(row.id) || seen.has(row.id)) return invalid();
    seen.add(row.id);
    const size = payloadBytes(row);
    if (size === null) return invalid();
    actualBytes += size;
    if (size > ROW_BYTES || actualBytes > 2 * ROLE_BYTES) return { ...failed('capacity_deferred', scanned), updates: [] };
    const proof = proofs.get(row.id);
    // The hidden version proof belongs to the same snapshot; display/mapping
    // spreads may omit non-enumerable version metadata from the public row.
    if (!proof || PROOF.some(key => key === 'external_version' && !Object.hasOwn(row, key)
      ? false : !Object.hasOwn(row, key) || row[key] !== proof[key])) return invalid();
    const summary = summarizeMessageCompleteness([row], {
      population: { total: 1, evaluated: 1, not_evaluated: 0 },
      as_of: { read_at: metadata.as_of.read_at, source_max_record_id: row.id },
      filter: { direction: 'all', search: '' },
    });
    if (summary.evaluation.invalid_readiness_count !== 0 || !summary.evaluation.metadata_valid) { deferred++; continue; }
    const state = row.readiness.state, reasons = JSON.stringify([...new Set(row.readiness.reasons)].sort());
    const version = readinessSourceVersionKey(proof), old = priors.get(row.id);
    if (old && (!integer(old.generation) || old.generation < 1 || !integer(old.source_epoch)
      || old.source_epoch < 1 || !integer(old.last_observed_at_ms) || at < old.last_observed_at_ms)) { deferred++; continue; }
    if (old && at === old.last_observed_at_ms) {
      // Replaying the same timestamp cannot establish an ordering between
      // contradictory observations, nor increment a regression twice.
      if (old.source_version_key !== version || old.state !== state || old.reasons_json !== reasons) { deferred++; continue; }
    }
    const same = old?.source_version_key === version;
    const first = same ? old.first_observed_at_ms : at;
    const missing = same ? (old.first_missing_observed_at_ms ?? (state === 'ready' ? null : at)) : state === 'ready' ? null : at;
    const ready = same ? (old.first_ready_observed_at_ms ?? (state === 'ready' ? at : null)) : state === 'ready' ? at : null;
    const regressions = same ? old.observed_regression_count + Number(old.state === 'ready' && state !== 'ready') : 0;
    const epoch = old ? old.source_epoch + Number(!same) : 1;
    const cas = old ? `EXISTS(SELECT 1 FROM ${TABLE} WHERE ${recordWhere(observerAccountKey, row.id)}
      AND generation=${old.generation} AND last_observed_at_ms=${old.last_observed_at_ms})`
      : `NOT EXISTS(SELECT 1 FROM ${TABLE} WHERE ${recordWhere(observerAccountKey, row.id)})`;
    const sourceCas = PROOF.map(key => `r.${key} IS ${quoteSql(proof[key])}`).join(' AND ');
    const values = ['lark.im', row.id, observerAccountKey, READINESS_CONTRACT_VERSION, version, epoch,
      state, reasons, first, missing, ready, at, regressions, old ? old.generation + 1 : 1].map(quoteSql);
    updates.push(`INSERT INTO ${TABLE}(source_id,record_id,observer_account_key,contract_version,
      source_version_key,source_epoch,state,reasons_json,first_observed_at_ms,first_missing_observed_at_ms,
      first_ready_observed_at_ms,last_observed_at_ms,observed_regression_count,generation)
      SELECT ${values.join(',')} WHERE ${cas} AND EXISTS(SELECT 1 FROM records r WHERE ${sourceCas})
      ON CONFLICT(source_id,record_id,observer_account_key,contract_version) DO UPDATE SET
        source_version_key=excluded.source_version_key,source_epoch=excluded.source_epoch,state=excluded.state,
        reasons_json=excluded.reasons_json,first_observed_at_ms=excluded.first_observed_at_ms,
        first_missing_observed_at_ms=excluded.first_missing_observed_at_ms,first_ready_observed_at_ms=excluded.first_ready_observed_at_ms,
        last_observed_at_ms=excluded.last_observed_at_ms,observed_regression_count=excluded.observed_regression_count,
        generation=excluded.generation;
      ${EFFECT}`);
  }
  return { reason: 'planned', scanned, observed: 0, deferred, updates };
}

/** No default reader/writer: callers provide read-only queries and a commit
 * callback holding the existing account, maintenance and sync-lock fences.
 * Remote I/O is forbidden in these hooks. Read failure never affects ingestion.
 * @param {string} db
 * @param {{observerAccountKey:string,query:(sql:string,label:string)=>any,readRows:(db:string,ids:number[])=>any,
 * commit:(updates:string[],reason:string)=>any,nowMs:number}} options
 */
export function observeMessageReadiness(db, options) {
  const { observerAccountKey: observer, query, readRows, commit, nowMs } = options || {};
  if (!account(observer) || !integer(nowMs) || nowMs > Number.MAX_SAFE_INTEGER - READINESS_OBSERVATION_INTERVAL_MS
    || typeof query !== 'function' || typeof readRows !== 'function' || typeof commit !== 'function') return failed('invalid_dependencies');
  let scanned = 0;
  try {
    const stateRows = query(`SELECT s.*,COALESCE((SELECT MAX(id) FROM records WHERE ${SOURCE}),0) AS source_max_id
      FROM (SELECT 1) seed LEFT JOIN ${SCAN} s ON ${keyWhere(observer)};`, 'read readiness observation opportunity');
    if (!Array.isArray(stateRows) || stateRows.length !== 1) return failed('invalid_scan');
    const prior = stateRows[0], exists = prior.generation !== null;
    if (!integer(prior.source_max_id) || exists && (!integer(prior.generation) || prior.generation < 1
      || !['tail_after_id', 'history_after_id', 'history_horizon_id', 'next_attempt_at_ms', 'last_attempt_at_ms'].every(key => integer(prior[key])))) return failed('invalid_scan');
    if (exists && nowMs < prior.next_attempt_at_ms) return failed('cadence');
    const generation = exists ? prior.generation + 1 : 1;
    const predicate = exists ? `EXISTS(SELECT 1 FROM ${SCAN} WHERE ${keyWhere(observer)} AND generation=${prior.generation}
      AND next_attempt_at_ms<=${nowMs})` : `NOT EXISTS(SELECT 1 FROM ${SCAN} WHERE ${keyWhere(observer)})`;
    const claim = `INSERT INTO ${SCAN}(source_id,observer_account_key,contract_version,next_attempt_at_ms,last_attempt_at_ms,generation)
      SELECT 'lark.im',${quoteSql(observer)},${READINESS_CONTRACT_VERSION},${nowMs + READINESS_OBSERVATION_INTERVAL_MS},${nowMs},${generation}
      WHERE ${predicate} ON CONFLICT(source_id,observer_account_key,contract_version) DO UPDATE SET
        next_attempt_at_ms=excluded.next_attempt_at_ms,last_attempt_at_ms=excluded.last_attempt_at_ms,generation=excluded.generation;
      ${EFFECT}`;
    const claimed = commit([claim], 'readiness_observation_claim');
    if (claimed?.updated !== 1) return failed('contended');
    const max = prior.source_max_id;
    const historicalAfter = exists ? prior.history_after_id : 0;
    const historicalHorizon = exists && prior.history_horizon_id > historicalAfter ? prior.history_horizon_id : max;
    const historyStart = exists && prior.history_horizon_id > historicalAfter ? historicalAfter : 0;
    const size = "COALESCE(length(CAST(raw_json AS BLOB)),0)+COALESCE(length(CAST(canonical_json AS BLOB)),0)+COALESCE(length(CAST(body AS BLOB)),0) AS bytes";
    const tail = query(`SELECT id,${size} FROM records INDEXED BY records_name_scan WHERE ${SOURCE}
      AND id${exists ? `>${prior.tail_after_id}` : `<=${max}`} ORDER BY id ${exists ? 'ASC' : 'DESC'} LIMIT ${ROLE_LIMIT};`, 'select new readiness observations');
    const historical = query(`SELECT id,${size} FROM records INDEXED BY records_name_scan WHERE ${SOURCE}
      AND id>${historyStart} AND id<=${historicalHorizon} ORDER BY id ASC LIMIT ${ROLE_LIMIT};`, 'select historical readiness observations');
    if (![tail, historical].every(page => Array.isArray(page) && page.length <= ROLE_LIMIT
      && page.every(row => integer(row.id) && row.id > 0 && integer(row.bytes)))) return failed('invalid_scan');
    const candidates = new Map(), selected = new Map();
    for (const [role, page] of [tail, historical].entries()) {
      let used = 0;
      for (const row of page) {
        candidates.set(row.id, row);
        if (selected.has(row.id)) continue;
        if (row.bytes <= ROW_BYTES && used + row.bytes <= ROLE_BYTES) { selected.set(row.id, role); used += row.bytes; }
      }
    }
    scanned = candidates.size;
    const ids = [...selected.keys()];
    let updates = [];
    let outcome = 'observed';
    if (ids.length) {
      try {
        const read = readRows(db, ids);
        if (!object(read) || !Array.isArray(read.messages) || read.messages.length !== ids.length
          || read.messages.some(row => !object(row) || !ids.includes(row.id))
          || new Set(read.messages.map(row => row.id)).size !== ids.length) outcome = 'invalid_observation';
        else {
          // The source can grow between metadata selection and the actual
          // snapshot. Recheck the returned bytes before accepting observations.
          const roleBytes = [0, 0];
          for (const row of read.messages) {
            const size = payloadBytes(row), role = selected.get(row.id);
            if (size === null || role === undefined) { outcome = 'invalid_observation'; break; }
            roleBytes[role] += size;
            if (size > ROW_BYTES || roleBytes[role] > ROLE_BYTES) { outcome = 'capacity_deferred'; break; }
          }
          if (outcome === 'observed') {
            const previous = query(`SELECT * FROM ${TABLE} WHERE ${keyWhere(observer)} AND record_id IN (${ids.join(',')});`, 'read prior readiness observations');
            const plan = planReadinessObservations({ ...read, messages: read.messages, metadata: read.metadata, previous, observerAccountKey: observer });
            if (plan.reason !== 'planned') outcome = plan.reason;
            else updates = plan.updates;
          }
        }
      } catch { outcome = 'observation_failed'; }
    }
    const tailAfter = exists ? (tail.at(-1)?.id ?? prior.tail_after_id) : max;
    const historyAfter = historical.length < ROLE_LIMIT ? historicalHorizon : historical.at(-1).id;
    const guard = `CREATE TEMP TABLE __readiness_observation_fence(allowed INTEGER NOT NULL CHECK(allowed=1));
      INSERT INTO __readiness_observation_fence SELECT CASE WHEN EXISTS(SELECT 1 FROM ${SCAN}
        WHERE ${keyWhere(observer)} AND generation=${generation} AND last_attempt_at_ms=${nowMs}) THEN 1 ELSE 0 END;`;
    const finish = `UPDATE ${SCAN} SET tail_after_id=${tailAfter},history_after_id=${historyAfter},history_horizon_id=${historicalHorizon},
      last_scanned_count=${scanned},last_observed_count=(SELECT COALESCE(SUM(updated),0) FROM __enrichment_effects),
      last_deferred_count=${scanned}-(SELECT COALESCE(SUM(updated),0) FROM __enrichment_effects),generation=generation+1
      WHERE ${keyWhere(observer)} AND generation=${generation}; ${EFFECT}`;
    updates.push(finish);
    updates[0] = `${guard}\n${updates[0]}`;
    const result = commit(updates, 'readiness_observation_finish');
    if (!integer(result?.updated) || result.updated < 1 || result.updated > updates.length) return failed('commit_unconfirmed', scanned);
    return { reason: outcome, scanned, observed: result.updated - 1, deferred: scanned - result.updated + 1 };
  } catch { return failed('observation_failed', scanned); }
}
