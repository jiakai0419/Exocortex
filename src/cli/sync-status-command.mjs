// @ts-check

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { recoverStaleSyncState } from "../../dist/storage/sqlite/ingestion-store.js";
import {
  countBy,
  healthDetail,
  summarizeHealth,
} from "../diagnostics/sync-status-core.mjs";
import {
  block,
  kv,
  list,
  renderError,
  section,
  statusBadge,
  subtitle,
  table,
  title,
} from "../../dist/terminal/index.js";

const DEFAULT_DB = "data/exocortex.sqlite";

/**
 * @typedef {"text" | "json"} SyncStatusFormat
 *
 * @typedef {object} SyncStatusOptions
 * @property {string} db
 * @property {SyncStatusFormat} format
 * @property {boolean=} help
 *
 * @typedef {Record<string, any>} Row
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} SyncStatusCommandDeps
 * @property {(dbPath: string, sql: string, label: string) => Row[]=} sqliteJson
 * @property {(dbPath: string) => JsonObject=} recoverStaleSyncState
 * @property {(dbPath: string) => boolean=} existsSync
 * @property {(dbPath: string) => string=} resolvePath
 * @property {(dbPath: string) => JsonObject=} buildStatus
 *
 * @typedef {object} CliIo
 * @property {{write: (text: string) => unknown}=} stdout
 * @property {{write: (text: string) => unknown}=} stderr
 * @property {SyncStatusCommandDeps=} deps
 */

function usage() {
  return `Usage: node scripts/sync-status.mjs [options]

Options:
  --db <path>       SQLite database path. Default: ${DEFAULT_DB}
  --format <fmt>    text | json. Default: text
  --help            Show this help.
`;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {SyncStatusOptions} */
  const opts = { db: DEFAULT_DB, format: "text" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { ...opts, help: true };
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--format") opts.format = /** @type {SyncStatusFormat} */ (next);
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  if (!["text", "json"].includes(opts.format)) throw new Error("--format must be text or json");
  return opts;
}

/**
 * @param {string} dbPath
 * @param {string} sql
 * @param {string} label
 * @returns {Row[]}
 */
function sqliteJson(dbPath, sql, label) {
  const result = spawnSync("sqlite3", ["-json", dbPath], {
    input: `.timeout 5000\n${sql}`,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

/** @param {unknown} value */
function parseMaybeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

/**
 * @param {Row[]} rows
 * @param {Row} [fallback]
 * @returns {Row}
 */
function first(rows, fallback = {}) {
  return rows[0] || fallback;
}

/** @param {unknown} value */
function quoteSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * @param {string} dbPath
 * @param {string} scopeId
 * @param {string} label
 * @param {(dbPath: string, sql: string, label: string) => Row[]} query
 */
function readScopeStatus(dbPath, scopeId, label, query) {
  return first(
    query(
      dbPath,
      `SELECT id, cursor_json, cursor_updated_at, last_success_run_id, last_error_run_id
       FROM sync_scopes
       WHERE id = ${quoteSql(scopeId)}
       LIMIT 1;`,
      label,
    ),
    {},
  );
}

/**
 * @param {string} dbPath
 * @param {SyncStatusCommandDeps} [deps]
 */
function buildStatus(dbPath, deps = {}) {
  const query = deps.sqliteJson || sqliteJson;
  const recover = deps.recoverStaleSyncState || recoverStaleSyncState;
  const recovery = recover(dbPath);
  const totals = first(
    query(
      dbPath,
      "SELECT COUNT(*) AS count, MAX(occurred_at_ms) AS latest_ms FROM records;",
      "read record totals",
    ),
    { count: 0, latest_ms: null },
  );
  const byDirection = query(
    dbPath,
    "SELECT COALESCE(direction, 'unknown') AS direction, COUNT(*) AS count, MAX(occurred_at_ms) AS latest_ms FROM records GROUP BY direction ORDER BY direction;",
    "read direction totals",
  );
  const scopeCounts = first(
    query(
      dbPath,
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled,
         SUM(CASE WHEN id LIKE 'lark.im.received.chat.%' AND enabled = 1 THEN 1 ELSE 0 END) AS received_enabled,
         SUM(CASE WHEN id LIKE 'lark.im.received.chat.%' AND enabled = 1 AND cursor_json IS NULL THEN 1 ELSE 0 END) AS received_without_cursor,
         SUM(CASE WHEN id LIKE 'lark.im.received.chat.%' AND json_extract(config_json, '$.unsupported_reason') IS NOT NULL THEN 1 ELSE 0 END) AS received_unsupported
       FROM sync_scopes;`,
      "read scope totals",
    ),
    {},
  );
  const unsupportedReasons = query(
    dbPath,
    `SELECT
       COALESCE(json_extract(config_json, '$.unsupported_reason'), 'unknown') AS reason,
       MAX(COALESCE(json_extract(config_json, '$.lark_cli_error_code'), '')) AS lark_cli_error_code,
       MAX(COALESCE(json_extract(config_json, '$.lark_cli_error_message'), '')) AS lark_cli_error_message,
       COUNT(*) AS count
     FROM sync_scopes
     WHERE id LIKE 'lark.im.received.chat.%'
       AND json_extract(config_json, '$.unsupported_reason') IS NOT NULL
     GROUP BY reason
     ORDER BY count DESC, reason;`,
    "read unsupported scope reasons",
  );
  const discoveryRow = readScopeStatus(
    dbPath,
    "lark.im.unmuted_chat_discovery",
    "read discovery scope",
    query,
  );
  const hotDiscoveryRow = readScopeStatus(
    dbPath,
    "lark.im.unmuted_chat_hot",
    "read hot discovery scope",
    query,
  );
  const reconcileRow = readScopeStatus(
    dbPath,
    "lark.im.unmuted_chat_reconcile",
    "read reconcile scope",
    query,
  );
  const runCounts = query(
    dbPath,
    "SELECT status, COUNT(*) AS count FROM sync_runs GROUP BY status ORDER BY status;",
    "read run counts",
  );
  const recentRuns = query(
    dbPath,
    `SELECT id, scope_id, status, started_at, finished_at, scanned_count, inserted_count, updated_count, duplicate_count, error_type, error_message
     FROM sync_runs
     ORDER BY id DESC
     LIMIT 10;`,
    "read recent runs",
  );
  const locks = query(
    dbPath,
    "SELECT scope_id, locked_by, locked_at, expires_at FROM sync_locks ORDER BY locked_at DESC;",
    "read locks",
  );

  const discoveryCursor = parseMaybeJson(discoveryRow.cursor_json);
  const hotDiscoveryCursor = parseMaybeJson(hotDiscoveryRow.cursor_json);
  const reconcileCursor = parseMaybeJson(reconcileRow.cursor_json);
  return {
    db_path: dbPath,
    records: {
      total: Number(totals.count || 0),
      latest_ms: totals.latest_ms ?? null,
      by_direction: byDirection.map((row) => ({
        direction: row.direction,
        count: Number(row.count || 0),
        latest_ms: row.latest_ms ?? null,
      })),
    },
    scopes: {
      total: Number(scopeCounts.total || 0),
      enabled: Number(scopeCounts.enabled || 0),
      received_enabled: Number(scopeCounts.received_enabled || 0),
      received_without_cursor: Number(scopeCounts.received_without_cursor || 0),
      received_unsupported: Number(scopeCounts.received_unsupported || 0),
      unsupported_reasons: unsupportedReasons,
    },
    discovery: {
      cursor: discoveryCursor,
      cursor_updated_at: discoveryRow.cursor_updated_at || null,
      last_success_run_id: discoveryRow.last_success_run_id || null,
      last_error_run_id: discoveryRow.last_error_run_id || null,
      complete: discoveryCursor ? discoveryCursor.has_more === false : false,
    },
    hot_discovery: {
      cursor: hotDiscoveryCursor,
      cursor_updated_at: hotDiscoveryRow.cursor_updated_at || null,
      last_success_run_id: hotDiscoveryRow.last_success_run_id || null,
      last_error_run_id: hotDiscoveryRow.last_error_run_id || null,
      ran: Boolean(hotDiscoveryRow.last_success_run_id),
    },
    reconcile: {
      cursor: reconcileCursor,
      cursor_updated_at: reconcileRow.cursor_updated_at || null,
      last_success_run_id: reconcileRow.last_success_run_id || null,
      last_error_run_id: reconcileRow.last_error_run_id || null,
      complete: reconcileCursor ? reconcileCursor.has_more === false : false,
    },
    runs: {
      by_status: countBy(runCounts, "status", "count"),
      recent: recentRuns,
    },
    locks,
    recovery,
    health: summarizeHealth({ discoveryCursor, scopeCounts, locks, runCounts }),
    health_detail: healthDetail({ discoveryCursor, scopeCounts, locks, runCounts }),
  };
}

/** @param {unknown} ms */
function localTime(ms) {
  if (!ms) return "none";
  return new Date(Number(ms)).toLocaleString();
}

/** @param {unknown} value */
function localIso(value) {
  if (!value) return "none";
  return new Date(String(value)).toLocaleString();
}

/** @param {JsonObject} status */
function renderText(status) {
  const byDirection = Object.fromEntries(
    status.records.by_direction.map((row) => [row.direction, row]),
  );
  const discoveryState = status.discovery.complete
    ? "complete"
    : status.discovery.cursor?.has_more
      ? "in progress"
      : "not started";
  const reconcileState = status.reconcile.complete
    ? "complete"
    : status.reconcile.cursor?.has_more
      ? "in progress"
      : "not started";
  const lines = [
    `${title("Exocortex sync status")} ${statusBadge(status.health)}`,
    subtitle(status.health_detail),
    "",
    section("Summary"),
    kv([
      [
        "Records",
        `${status.records.total} total, ${byDirection.sent?.count || 0} sent, ${
          byDirection.received?.count || 0
        } received`,
      ],
      ["Latest record", localTime(status.records.latest_ms)],
      ["Discovery", discoveryState],
      ["Discovery pages", status.discovery.cursor?.pages_scanned || 0],
      [
        "Hot discovery",
        status.hot_discovery.ran
          ? `last run ${localIso(status.hot_discovery.cursor_updated_at)}`
          : "not started",
      ],
      [
        "Reconcile",
        `${reconcileState}, ${status.reconcile.cursor?.pages_scanned || 0} pages`,
      ],
      [
        "Received scopes",
        `${status.scopes.received_enabled} enabled, ${status.scopes.received_without_cursor} without cursor`,
      ],
      ["Unsupported scopes", `${status.scopes.received_unsupported || 0} total`],
      ["Runs", JSON.stringify(status.runs.by_status)],
      ["Locks", status.locks.length],
    ]),
  ];
  if (status.scopes.unsupported_reasons?.length > 0) {
    lines.push("");
    lines.push(section("Unsupported reasons"));
    lines.push(
      table(status.scopes.unsupported_reasons, [
        { key: "reason", header: "Reason", render: (row) => row.reason },
        {
          key: "lark_cli",
          header: "Lark CLI",
          render: (row) =>
            row.lark_cli_error_message
              ? `${row.lark_cli_error_code}: ${row.lark_cli_error_message}`
              : "",
        },
        { key: "count", header: "Count", render: (row) => row.count },
      ]),
    );
  }
  if (
    status.recovery?.recovered_locks > 0 ||
    status.recovery?.cancelled_runs > 0 ||
    status.recovery?.active_expired_locks > 0
  ) {
    lines.push("");
    lines.push(section("Recovery"));
    lines.push(
      kv([
        ["Recovered locks", status.recovery.recovered_locks || 0],
        ["Cancelled runs", status.recovery.cancelled_runs || 0],
        ["Active expired locks", status.recovery.active_expired_locks || 0],
      ]),
    );
  }
  const recentProblems = status.runs.recent
    .filter((run) => run.status !== "succeeded")
    .slice(0, 3);
  if (recentProblems.length > 0) {
    lines.push("");
    lines.push(section("Recent non-success runs"));
    lines.push(
      list(
        recentProblems.map((run) =>
          `#${run.id} ${statusBadge(run.status)} ${run.scope_id}: ${run.error_type || ""}`,
        ),
      ),
    );
  }
  return `${block(lines)}\n`;
}

/**
 * @param {SyncStatusOptions} opts
 * @param {SyncStatusCommandDeps} [deps]
 */
function executeSyncStatus(opts, deps = {}) {
  const dbPath = (deps.resolvePath || resolve)(opts.db);
  const fileExists = deps.existsSync || existsSync;
  if (!fileExists(dbPath)) throw new Error(`database not found: ${dbPath}`);
  const loadStatus = deps.buildStatus || ((path) => buildStatus(path, deps));
  return loadStatus(dbPath);
}

/**
 * @param {string[]} argv
 * @param {CliIo} [io]
 */
function runSyncStatusCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      stdout.write(usage());
      return 0;
    }
    const status = executeSyncStatus(opts, io.deps || {});
    if (opts.format === "json") stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    else stdout.write(renderText(status));
    return 0;
  } catch (error) {
    stderr.write(renderError(error));
    return 1;
  }
}

export {
  buildStatus,
  executeSyncStatus,
  parseArgs,
  renderText,
  runSyncStatusCli,
  sqliteJson,
  usage,
};
