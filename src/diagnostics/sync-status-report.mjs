// @ts-check

import { spawnSync } from "node:child_process";
import { recoverStaleSyncState } from "../../dist/storage/sqlite/ingestion-store.js";
import {
  countBy,
  healthDetail,
  summarizeHealth,
} from "./sync-status-core.mjs";

/**
 * @typedef {Record<string, any>} Row
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} SyncStatusReportDeps
 * @property {(dbPath: string, sql: string, label: string) => Row[]=} sqliteJson
 * @property {(dbPath: string) => JsonObject=} recoverStaleSyncState
 */

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
 * @param {SyncStatusReportDeps} [deps]
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

export {
  buildStatus,
  sqliteJson,
};
