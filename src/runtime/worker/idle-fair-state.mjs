// @ts-check
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { quoteSql as q } from '../../../dist/storage/sqlite/sqlite-executor.js';
import { larkWriteAdmissionSql } from '../../../dist/storage/sqlite/lark-write-admission.js';
import { activityDatabaseKey } from '../../diagnostics/lark-im-activity-evidence.mjs';
import { captureLarkWriteAdmission } from '../../diagnostics/lark-write-admission.mjs';
import { readOnlySqliteJson } from '../../storage/sqlite/readonly-query.mjs';
import { tryAcquireLarkApiLease } from '../lark-api-lease.mjs';

export const IDLE_FAIR_LANES = Object.freeze(['sample', 'history', 'resources']);
const SCHEMA = 'lark_idle_fair/v1', MAX_MS = 2000;
const FIELDS = ['source_id', 'account_key', 'database_key', 'generation', 'sequence',
  'sample_last_served', 'history_last_served', 'resources_last_served'];
const HASH = /^[a-f0-9]{64}$/;
const observed = new WeakMap();
// Expiry is evaluated by SQLite's transaction clock, not a caller's fake wall time.
// Unknown lock timestamps and every outstanding sync lock fail closed; no recovery.
const UNLOCKED = `NOT EXISTS(SELECT 1 FROM sync_locks) AND NOT EXISTS(
  SELECT 1 FROM maintenance_locks WHERE name='global' AND
    (julianday(expires_at) IS NULL OR julianday(expires_at)>julianday('now')))`;

/** @typedef {{schema:string,account_key:string,database_key:string,generation:number,
 * sequence:number,last_served:Readonly<Record<string,number>>,exists:boolean}} IdleFairState */
/** @typedef {{timeoutMs?:number,monotonicDeadlineMs?:number,monotonicNowMs?:()=>number,
 * readOnlyQuery?:typeof readOnlySqliteJson,spawnSync?:typeof spawnSync,
 * tryAcquireLease?:typeof tryAcquireLarkApiLease}} IdleFairDeps */

/** All local admission reads, lease acquisition and one write share this budget.
 * It bounds these operations, not an entire worker slice. @param {IdleFairDeps} deps */
function budgetFor(deps) {
  const clock = deps.monotonicNowMs || (() => performance.now());
  const started = clock();
  if (!Number.isFinite(started) || deps.timeoutMs !== undefined &&
    (!Number.isSafeInteger(deps.timeoutMs) || deps.timeoutMs <= 0) ||
    deps.monotonicDeadlineMs !== undefined && !Number.isFinite(deps.monotonicDeadlineMs)) throw new Error('idle_budget');
  const deadline = Math.min(started + Math.min(MAX_MS, deps.timeoutMs ?? MAX_MS), deps.monotonicDeadlineMs ?? Infinity);
  let last = started;
  const remaining = () => {
    const current = clock();
    if (!Number.isFinite(current) || current < last) throw new Error('idle_clock');
    last = current;
    const left = Math.floor(deadline - current);
    if (left < 1) throw new Error('idle_budget');
    return left;
  };
  remaining();
  const query = (db, sql, label) => {
    const rows = (deps.readOnlyQuery || readOnlySqliteJson)(db, sql, label, { timeoutMs: remaining() });
    remaining();
    return rows;
  };
  return { clock, deadline, remaining, query };
}

/** No remote self query, reservation, schema initialization or account adoption.
 * The existing admission reader rejects contradictory sent actors and sidecars.
 * @param {string} db @param {ReturnType<typeof budgetFor>} budget */
function localAdmission(db, budget) {
  const key = activityDatabaseKey(db);
  if (!key) throw new Error('idle_database');
  const admission = captureLarkWriteAdmission(db, {}, { query: budget.query });
  const fence = admission.fence, initial = JSON.parse(fence.sourceConfigJson).initial_account_binding;
  if (!HASH.test(fence.accountKey || '') || (initial
    ? initial.confirmed_at === null
    : !fence.sidecarVerified && !fence.sentActor)) throw new Error('idle_account');
  // The captured parser already validates any embedded binding and timestamps.
  if (activityDatabaseKey(db) !== key) throw new Error('idle_database');
  admission.assertCurrent(); budget.remaining();
  return { admission, accountKey: fence.accountKey, databaseKey: key, sourceConfig: fence.sourceConfigJson };
}

function validRow(row) {
  return row?.source_id === 'lark.im' && HASH.test(row.account_key) && HASH.test(row.database_key)
    && ['generation', 'sequence', ...IDLE_FAIR_LANES.map(lane => `${lane}_last_served`)]
      .every(field => Number.isSafeInteger(row[field]) && row[field] >= 0)
    && IDLE_FAIR_LANES.every(lane => row[`${lane}_last_served`] <= row.sequence);
}

/** @returns {IdleFairState} */
function expose(row, exists, sourceConfig) {
  const state = Object.freeze({ schema: SCHEMA, account_key: row.account_key, database_key: row.database_key,
    generation: row.generation, sequence: row.sequence, exists,
    last_served: Object.freeze(Object.fromEntries(IDLE_FAIR_LANES.map(lane => [lane, row[`${lane}_last_served`]]))) });
  // Only state actually read/committed in this process can authorize a claim.
  // Source configuration and the full SQL before-image remain private in memory.
  observed.set(state, { row: Object.freeze({ ...row }), sourceConfig });
  return state;
}

/** Read existing confirmed local evidence. Missing scheduler row is an all-zero
 * before-image; a missing schema, mixed/unbound account or stale file is unavailable.
 * @param {string} db @param {IdleFairDeps} [deps] @returns {IdleFairState|null} */
export function readIdleFairState(db, deps = {}) {
  try {
    const budget = budgetFor(deps), local = localAdmission(db, budget);
    if (budget.query(db, `SELECT CASE WHEN ${UNLOCKED} THEN 1 ELSE 0 END AS allowed;`, 'read idle admission')[0]?.allowed !== 1) return null;
    const rows = budget.query(db, `SELECT ${FIELDS.join(',')} FROM lark_im_idle_fair_state LIMIT 2;`, 'read idle fair state');
    if (rows.length > 1) return null;
    const row = rows[0] || { source_id: 'lark.im', account_key: local.accountKey, database_key: local.databaseKey,
      generation: 0, sequence: 0, sample_last_served: 0, history_last_served: 0, resources_last_served: 0 };
    if (!validRow(row) || row.account_key !== local.accountKey || row.database_key !== local.databaseKey) return null;
    local.admission.assertCurrent(); budget.remaining();
    if (activityDatabaseKey(db) !== local.databaseKey) return null;
    return expose(row, rows.length === 1, local.sourceConfig);
  } catch { return null; }
}

/** Call once immediately before the first eligible lane's actual spawn. A failed
 * lane attempt keeps its committed service age. A failed/uncertain claim returns
 * null and forbids optional work; never compensate or assume it did not commit.
 * File checks use the existing admission contract: external path replacement
 * requires writer quiescence and is not made SQLite-atomic by this helper.
 * @param {string} db @param {IdleFairState} state @param {string} lane
 * @param {string[]} eligible @param {IdleFairDeps} [deps] @returns {IdleFairState|null} */
export function claimIdleLane(db, state, lane, eligible, deps = {}) {
  let lease;
  try {
    const before = observed.get(state), budget = budgetFor(deps);
    if (!before || !Array.isArray(eligible) || !eligible.length || new Set(eligible).size !== eligible.length
      || eligible.some(value => !IDLE_FAIR_LANES.includes(value)) || !eligible.includes(lane)) return null;
    const order = [...eligible].sort((a, b) => state.last_served[a] - state.last_served[b]
      || IDLE_FAIR_LANES.indexOf(a) - IDLE_FAIR_LANES.indexOf(b));
    if (order[0] !== lane || state.generation >= Number.MAX_SAFE_INTEGER || state.sequence >= Number.MAX_SAFE_INTEGER) return null;
    lease = (deps.tryAcquireLease || tryAcquireLarkApiLease)({ db, role: 'probe', monotonicDeadlineMs: budget.deadline },
      { monotonicClock: budget.clock });
    budget.remaining();
    if (lease?.state !== 'acquired') return null;
    const local = localAdmission(db, budget);
    if (local.databaseKey !== state.database_key || local.accountKey !== state.account_key || local.sourceConfig !== before.sourceConfig) return null;
    const next = { ...before.row, generation: state.generation + 1, sequence: state.sequence + 1,
      [`${lane}_last_served`]: state.sequence + 1 };
    const mutation = state.exists
      ? `UPDATE lark_im_idle_fair_state SET generation=${next.generation},sequence=${next.sequence},${lane}_last_served=${next.sequence}
         WHERE ${FIELDS.map(field => `${field} IS ${q(before.row[field])}`).join(' AND ')};`
      : `INSERT INTO lark_im_idle_fair_state(${FIELDS.join(',')}) VALUES(${FIELDS.map(field => q(next[field])).join(',')});`;
    const sql = `BEGIN IMMEDIATE;
      ${larkWriteAdmissionSql(local.admission.fence)}
      CREATE TEMP TABLE __idle_fair_guard(allowed INTEGER NOT NULL CHECK(allowed=1));
      INSERT INTO __idle_fair_guard SELECT CASE WHEN ${UNLOCKED}
        AND EXISTS(SELECT 1 FROM sources WHERE id='lark.im' AND enabled=1 AND config_json IS ${q(local.sourceConfig)}) THEN 1 ELSE 0 END;
      ${mutation}
      INSERT INTO __idle_fair_guard SELECT CASE WHEN changes()=1 THEN 1 ELSE 0 END;
      SELECT ${FIELDS.join(',')} FROM lark_im_idle_fair_state;
      COMMIT;`;
    local.admission.assertCurrent();
    if (activityDatabaseKey(db) !== state.database_key) return null;
    // mode=rw refuses to create a replacement database if the selected file vanished.
    const uri = pathToFileURL(resolve(db)); uri.searchParams.set('mode', 'rw');
    const result = (deps.spawnSync || spawnSync)('sqlite3', ['-batch', '-bail', '-json', uri.href], {
      input: `.bail on\n.timeout ${budget.remaining()}\nPRAGMA foreign_keys=ON;\n${sql}\n`,
      encoding: 'utf8', timeout: budget.remaining(), killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
      ...(lease.stdio ? { stdio: lease.stdio } : {}),
    });
    budget.remaining();
    if (result.status !== 0 || result.error || result.signal) return null;
    const rows = JSON.parse(String(result.stdout || ''));
    if (!Array.isArray(rows) || rows.length !== 1 || !validRow(rows[0])
      || FIELDS.some(field => rows[0][field] !== next[field])) return null;
    local.admission.assertCurrent(); budget.remaining();
    if (activityDatabaseKey(db) !== state.database_key) return null;
    return expose(rows[0], true, local.sourceConfig);
  } catch { return null; }
  finally { try { lease?.release(); } catch { return null; } }
}
