// @ts-check

import { readOnlySqliteJson } from "../storage/sqlite/readonly-query.mjs";

import { classifyLarkFailure } from "../adapters/lark-im/transport.mjs";
import {
  publicCommandFailureReason,
  publicErrorCode,
  publicFailureKind,
  publicTimestamp,
  publicUnsupportedReasons,
} from "./public-safe.mjs";
import {
  countBy,
  summarizeHealth,
} from "./sync-status-core.mjs";

/**
 * @typedef {Record<string, any>} Row
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} SyncStatusReportDeps
 * @property {(dbPath: string, sql: string, label: string) => Row[]=} sqliteJson
 */

/**
 * @param {string} dbPath
 * @param {string} sql
 * @param {string} label
 * @returns {Row[]}
 */
function sqliteJson(dbPath, sql, label) {
  return readOnlySqliteJson(dbPath, sql, label);
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

/** @param {unknown} value */
function nonNegativeNumber(value) {
  return Math.max(0, Number(value || 0));
}

/** @param {unknown} value */
function publicCursor(value) {
  if (!value || typeof value !== "object") return null;
  const cursor = /** @type {JsonObject} */ (value);
  /** @type {JsonObject} */
  const projected = {};
  if (typeof cursor.has_more === "boolean") projected.has_more = cursor.has_more;
  if (Number.isFinite(Number(cursor.pages_scanned))) {
    projected.pages_scanned = nonNegativeNumber(cursor.pages_scanned);
  }
  return Object.keys(projected).length > 0 ? projected : null;
}

/**
 * @param {string} health
 * @param {JsonObject} scopes
 * @param {JsonObject | null} discoveryCursor
 */
function publicHealthDetail(health, scopes, discoveryCursor) {
  if (health === "not_ready") return "initial discovery or successful message-scope evidence is missing";
  if (health === "needs_attention") return "sync history contains failures but no successful run";
  if (health === "syncing") return "worker is currently syncing";
  if (health === "catching_up") {
    /** @type {string[]} */
    const details = [];
    if (discoveryCursor?.has_more === true) details.push("discovery still has more pages");
    const withoutCursor = nonNegativeNumber(scopes.received_without_cursor);
    if (withoutCursor > 0) details.push(`${withoutCursor} chat scopes need cursors`);
    return `initial catch-up: ${details.join(", ") || "work remains"}`;
  }
  if (health === "ok_with_history") return "all known enabled scopes have cursors; historical failures recorded";
  if (health === "ok") return "all known enabled scopes have cursors";
  return "sync status unavailable";
}

/**
 * @param {JsonObject} report
 * @returns {JsonObject}
 */
function sanitizeStatusReportForPublicOutput(report) {
  if (report?.status === "command_failed") {
    return {
      ok: false,
      status: "command_failed",
      reason: publicCommandFailureReason(`${report.reason || ""}\n${report.stderr || ""}\n${report.stdout || ""}`),
      exit_status: Number(report.exit_status || 1),
    };
  }
  const health = ["syncing", "catching_up", "not_ready", "needs_attention", "ok", "ok_with_history"].includes(report?.health)
    ? report.health
    : "unknown";
  const scopes = {
    total: nonNegativeNumber(report?.scopes?.total),
    enabled: nonNegativeNumber(report?.scopes?.enabled),
    received_enabled: nonNegativeNumber(report?.scopes?.received_enabled),
    received_without_cursor: nonNegativeNumber(report?.scopes?.received_without_cursor),
    message_enabled: nonNegativeNumber(report?.scopes?.message_enabled),
    message_without_success: nonNegativeNumber(report?.scopes?.message_without_success),
    received_unsupported: nonNegativeNumber(report?.scopes?.received_unsupported),
    unsupported_reasons: publicUnsupportedReasons(report?.scopes?.unsupported_reasons),
  };
  const discoveryCursor = publicCursor(report?.discovery?.cursor);
  /** @type {JsonObject} */
  const byStatus = {};
  for (const status of ["running", "succeeded", "failed", "cancelled"]) {
    const count = nonNegativeNumber(report?.runs?.by_status?.[status]);
    if (count > 0) byStatus[status] = count;
  }
  return {
    records: {
      total: nonNegativeNumber(report?.records?.total),
      latest_ms: Number.isFinite(Number(report?.records?.latest_ms)) ? Number(report.records.latest_ms) : null,
      by_direction: (Array.isArray(report?.records?.by_direction) ? report.records.by_direction : [])
        .filter((row) => ["sent", "received", "unknown"].includes(String(row.direction)))
        .map((row) => ({
          direction: String(row.direction),
          count: nonNegativeNumber(row.count),
          latest_ms: Number.isFinite(Number(row.latest_ms)) ? Number(row.latest_ms) : null,
        })),
    },
    scopes,
    discovery: {
      cursor: discoveryCursor,
      cursor_updated_at: publicTimestamp(report?.discovery?.cursor_updated_at),
      complete: report?.discovery?.complete === true,
    },
    hot_discovery: {
      cursor: publicCursor(report?.hot_discovery?.cursor),
      cursor_updated_at: publicTimestamp(report?.hot_discovery?.cursor_updated_at),
      ran: report?.hot_discovery?.ran === true,
    },
    reconcile: {
      cursor: publicCursor(report?.reconcile?.cursor),
      cursor_updated_at: publicTimestamp(report?.reconcile?.cursor_updated_at),
      complete: report?.reconcile?.complete === true,
    },
    runs: {
      by_status: byStatus,
      recent: (Array.isArray(report?.runs?.recent) ? report.runs.recent : []).map((run) => ({
        status: ["running", "succeeded", "failed", "cancelled"].includes(String(run.status))
          ? String(run.status)
          : "failed",
        started_at: publicTimestamp(run.started_at),
        finished_at: publicTimestamp(run.finished_at),
        scanned_count: nonNegativeNumber(run.scanned_count),
        inserted_count: nonNegativeNumber(run.inserted_count),
        updated_count: nonNegativeNumber(run.updated_count),
        duplicate_count: nonNegativeNumber(run.duplicate_count),
        failure_kind: run.status === "succeeded" ? "" : publicFailureKind(run.failure_kind),
        transient: run.transient === true,
        error_code: publicErrorCode(run.error_code),
      })),
    },
    locks: (Array.isArray(report?.locks) ? report.locks : []).map((lock) => ({
      locked_at: publicTimestamp(lock.locked_at),
      expires_at: publicTimestamp(lock.expires_at),
    })),
    recovery: {
      performed: false,
      recovered_locks: 0,
      cancelled_runs: 0,
      active_expired_locks: 0,
    },
    health,
    health_detail: publicHealthDetail(health, scopes, discoveryCursor),
  };
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
      `SELECT cursor_json, cursor_updated_at, (last_success_run_id IS NOT NULL) AS has_success
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
         SUM(CASE WHEN enabled = 1 AND (id = 'lark.im.sent_by_me' OR id LIKE 'lark.im.received.chat.%') THEN 1 ELSE 0 END) AS message_enabled,
         SUM(CASE WHEN enabled = 1 AND (id = 'lark.im.sent_by_me' OR id LIKE 'lark.im.received.chat.%')
           AND NOT EXISTS (SELECT 1 FROM sync_runs r WHERE r.id = sync_scopes.last_success_run_id AND r.scope_id = sync_scopes.id AND r.status = 'succeeded')
           THEN 1 ELSE 0 END) AS message_without_success,
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
    `SELECT status, started_at, finished_at, scanned_count, inserted_count, updated_count, duplicate_count, error_message
     FROM sync_runs
     ORDER BY id DESC
     LIMIT 10;`,
    "read recent runs",
  );
  const locks = query(
    dbPath,
    "SELECT locked_at, expires_at FROM sync_locks ORDER BY locked_at DESC;",
    "read locks",
  );

  const discoveryCursor = parseMaybeJson(discoveryRow.cursor_json);
  const hotDiscoveryCursor = parseMaybeJson(hotDiscoveryRow.cursor_json);
  const reconcileCursor = parseMaybeJson(reconcileRow.cursor_json);
  return sanitizeStatusReportForPublicOutput({
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
      message_enabled: Number(scopeCounts.message_enabled || 0),
      message_without_success: Number(scopeCounts.message_without_success || 0),
      received_unsupported: Number(scopeCounts.received_unsupported || 0),
      unsupported_reasons: unsupportedReasons,
    },
    discovery: {
      cursor: discoveryCursor,
      cursor_updated_at: discoveryRow.cursor_updated_at || null,
      complete: discoveryCursor ? discoveryCursor.has_more === false : false,
    },
    hot_discovery: {
      cursor: hotDiscoveryCursor,
      cursor_updated_at: hotDiscoveryRow.cursor_updated_at || null,
      ran: Boolean(hotDiscoveryRow.has_success),
    },
    reconcile: {
      cursor: reconcileCursor,
      cursor_updated_at: reconcileRow.cursor_updated_at || null,
      complete: reconcileCursor ? reconcileCursor.has_more === false : false,
    },
    runs: {
      by_status: countBy(runCounts, "status", "count"),
      recent: recentRuns.map((run) => {
        const classification = classifyLarkFailure(run.error_message || "");
        return {
          status: run.status,
          started_at: run.started_at,
          finished_at: run.finished_at,
          scanned_count: run.scanned_count,
          inserted_count: run.inserted_count,
          updated_count: run.updated_count,
          duplicate_count: run.duplicate_count,
          failure_kind: run.status === "succeeded" ? "" : classification.kind,
          transient: run.status === "succeeded" ? false : classification.transient,
          error_code: run.status === "succeeded" ? null : classification.code,
        };
      }),
    },
    locks,
    health: summarizeHealth({ discoveryCursor, scopeCounts, locks, runCounts }),
  });
}

export {
  buildStatus,
  sanitizeStatusReportForPublicOutput,
  sqliteJson,
};
