// @ts-check

import { resolve } from "node:path";
import { recoverStaleSyncState } from "../../dist/storage/sqlite/ingestion-store.js";
import { readOnlySqliteJson } from "../storage/sqlite/readonly-query.mjs";

/** @typedef {Record<string, any>} JsonObject */
function usage() {
  return `Usage: node scripts/sync-repair.mjs [--db <path>] [--format text|json] [--apply]

Default: read-only structural preview; it does not determine owner liveness.
--apply explicitly recovers stale locks/runs using fenced transactional checks.
Run apply with the worker stopped and no other sync or maintenance process.
`;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = { db: "data/exocortex.sqlite", format: "text", apply: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { opts.help = true; continue; }
    if (arg === "--apply") { opts.apply = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = value;
    else if (arg === "--format") opts.format = value;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!["text", "json"].includes(opts.format)) throw new Error("--format must be text or json");
  return opts;
}

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

/** @param {string[]} argv
 * @param {{stdout?: {write: (text: string) => unknown}, stderr?: {write: (text: string) => unknown}, deps?: Parameters<typeof executeSyncRepair>[1]}} [io]
 */
function runSyncRepairCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const opts = parseArgs(argv);
    if (opts.help) { stdout.write(usage()); return 0; }
    const report = executeSyncRepair(opts, io.deps);
    stdout.write(`${JSON.stringify(report, null, opts.format === "json" ? 2 : 0)}\n`);
    return 0;
  } catch {
    // Raw SQLite errors can include record contents, paths and SQL literals.
    stderr.write("sync repair failed; check the database path, schema and options\n");
    return 1;
  }
}

export { executeSyncRepair, parseArgs, runSyncRepairCli, usage };
