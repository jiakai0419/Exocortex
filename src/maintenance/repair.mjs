// @ts-check

import { resolve } from "node:path";
import { recoverStaleSyncState } from "../../dist/storage/sqlite/ingestion-store.js";
import { readOnlySqliteJson } from "../storage/sqlite/readonly-query.mjs";

/** @typedef {Record<string, any>} JsonObject */
/**
 * @param {{db: string, apply: boolean}} opts
 * @param {{sqliteJson?: typeof readOnlySqliteJson, recoverStaleSyncState?: typeof recoverStaleSyncState}} [deps]
 */
function executeSyncRepair(opts, deps = {}) {
  const dbPath = resolve(opts.db);
  // This also rejects missing databases/tables without initializing them.
  const query = deps.sqliteJson || readOnlySqliteJson;
  const row = query(dbPath, `SELECT
    (SELECT COUNT(*) FROM sync_locks) AS locks,
    (SELECT COUNT(*) FROM sync_locks WHERE julianday(expires_at) <= julianday('now')) AS expired_locks,
    (SELECT COUNT(*) FROM sync_runs WHERE status = 'running') AS running_runs;`, "sync repair preview")[0] || {};
  const count = (/** @type {unknown} */ value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  const preview = { locks: count(row.locks), expired_locks: count(row.expired_locks), running_runs: count(row.running_runs) };
  if (!opts.apply) return { applied: false, preview, note: "Structural counts only; owner liveness and repair eligibility are not evaluated." };
  const result = (deps.recoverStaleSyncState || recoverStaleSyncState)(dbPath);
  return { applied: true, preview, recovery: {
    recovered_locks: count(result.recovered_locks), cancelled_runs: count(result.cancelled_runs),
    active_expired_locks: count(result.active_expired_locks),
  } };
}


export { executeSyncRepair };
