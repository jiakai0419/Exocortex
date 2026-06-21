// @ts-check

import { spawnSync } from "node:child_process";

/**
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} QualityReportDeps
 * @property {(dbPath: string, sql: string, label: string) => JsonObject[]=} sqliteJson
 */

/**
 * @param {string} dbPath
 * @param {string} sql
 * @param {string} label
 * @returns {JsonObject[]}
 */
function sqliteJson(dbPath, sql, label) {
  const result = spawnSync("sqlite3", ["-json", dbPath], {
    input: `.timeout 5000\n${sql}`,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr.trim()}`);
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

/**
 * @param {JsonObject[]} rows
 * @param {string} key
 * @param {unknown} [fallback]
 */
function one(rows, key, fallback = 0) {
  return rows[0]?.[key] ?? fallback;
}

/**
 * @param {string} dbPath
 * @param {QualityReportDeps} [deps]
 */
function collectQualityReport(dbPath, deps = {}) {
  const queryJson = deps.sqliteJson || sqliteJson;
  const counts = queryJson(
    dbPath,
    `SELECT
       COUNT(*) AS total,
       SUM(direction = 'sent') AS sent,
       SUM(direction = 'received') AS received,
       MAX(occurred_at_ms) AS latest_ms
     FROM records
     WHERE source_id = 'lark.im'
       AND record_type = 'lark.im.message';`,
    "message counts",
  );
  const byType = queryJson(
    dbPath,
    `SELECT json_extract(canonical_json, '$.msg_type') AS msg_type, COUNT(*) AS count
     FROM records
     WHERE source_id = 'lark.im'
       AND record_type = 'lark.im.message'
     GROUP BY msg_type
     ORDER BY count DESC, msg_type;`,
    "message types",
  );
  const quality = queryJson(
    dbPath,
    `SELECT
       SUM(COALESCE(json_extract(canonical_json, '$.sender_name'), '') = '') AS missing_sender_name,
       SUM(
         COALESCE(json_extract(canonical_json, '$.sender_name'), '') = ''
         AND COALESCE(json_extract(canonical_json, '$.sender_id'), '') LIKE 'ou_%'
       ) AS missing_user_sender_name,
       SUM(
         COALESCE(json_extract(canonical_json, '$.sender_name'), '') = ''
         AND COALESCE(json_extract(canonical_json, '$.sender_id'), '') LIKE 'cli_%'
       ) AS missing_app_sender_name,
       SUM(
         COALESCE(json_extract(canonical_json, '$.sender_name'), '') = ''
         AND COALESCE(json_extract(canonical_json, '$.sender_id'), '') LIKE 'cli_%'
         AND COALESCE(json_extract(canonical_json, '$.sender_name_resolution_status'), '') = 'unresolved_app_sender'
       ) AS unresolved_app_sender_name,
       SUM(
         COALESCE(json_extract(canonical_json, '$.sender_name'), '') = ''
         AND COALESCE(json_extract(canonical_json, '$.msg_type'), '') = 'system'
         AND COALESCE(json_extract(canonical_json, '$.sender_id'), '') = ''
       ) AS missing_system_sender_name,
       SUM(
         COALESCE(json_extract(canonical_json, '$.sender_name'), '') = ''
         AND COALESCE(json_extract(canonical_json, '$.sender_id'), '') NOT LIKE 'ou_%'
         AND (
           COALESCE(json_extract(canonical_json, '$.sender_id'), '') NOT LIKE 'cli_%'
           OR COALESCE(json_extract(canonical_json, '$.sender_name_resolution_status'), '') = 'unresolved_app_sender'
         )
         AND NOT (
           COALESCE(json_extract(canonical_json, '$.msg_type'), '') = 'system'
           AND COALESCE(json_extract(canonical_json, '$.sender_id'), '') = ''
         )
       ) AS missing_non_actionable_sender_name,
       SUM(
         COALESCE(json_extract(canonical_json, '$.sender_name'), '') = ''
         AND (
           COALESCE(json_extract(canonical_json, '$.sender_id'), '') LIKE 'ou_%'
           OR (
             COALESCE(json_extract(canonical_json, '$.sender_id'), '') LIKE 'cli_%'
             AND COALESCE(json_extract(canonical_json, '$.sender_name_resolution_status'), '') <> 'unresolved_app_sender'
           )
         )
       ) AS actionable_missing_sender_name,
       SUM(COALESCE(json_extract(canonical_json, '$.sender_id'), '') LIKE 'cli_%') AS app_sender_records,
       SUM(
         json_extract(canonical_json, '$.chat_type') IN ('group', 'topic')
         AND COALESCE(json_extract(canonical_json, '$.chat_name'), '') = ''
       ) AS missing_chat_name,
       SUM(body LIKE '[Invalid%JSON]') AS invalid_rendered_body,
       SUM(body LIKE '[已撤回/已删除%') AS deleted_or_recalled_body
     FROM records
     WHERE source_id = 'lark.im'
       AND record_type = 'lark.im.message';`,
    "quality counts",
  );
  const scopes = queryJson(
    dbPath,
    `SELECT
       COUNT(*) AS total_received_scopes,
       SUM(enabled = 1) AS enabled_received_scopes,
       SUM(enabled = 1 AND cursor_json IS NULL) AS enabled_without_cursor,
       SUM(json_extract(config_json, '$.unsupported_reason') IS NOT NULL) AS unsupported_scopes,
       SUM(json_extract(config_json, '$.hot_seen_at') IS NOT NULL) AS hot_seen_scopes
     FROM sync_scopes
     WHERE source_id = 'lark.im'
       AND id LIKE 'lark.im.received.chat.%';`,
    "scope counts",
  );
  const recentFailures = queryJson(
    dbPath,
    `SELECT id, scope_id, error_type, substr(error_message, 1, 240) AS error_message
     FROM sync_runs
     WHERE status = 'failed'
     ORDER BY id DESC
     LIMIT 5;`,
    "recent failures",
  );
  const unsupportedReasons = queryJson(
    dbPath,
    `SELECT
       COALESCE(json_extract(config_json, '$.unsupported_reason'), 'unknown') AS reason,
       MAX(COALESCE(json_extract(config_json, '$.lark_cli_error_code'), '')) AS lark_cli_error_code,
       MAX(COALESCE(json_extract(config_json, '$.lark_cli_error_message'), '')) AS lark_cli_error_message,
       COUNT(*) AS count
     FROM sync_scopes
     WHERE source_id = 'lark.im'
       AND id LIKE 'lark.im.received.chat.%'
       AND json_extract(config_json, '$.unsupported_reason') IS NOT NULL
     GROUP BY reason
     ORDER BY count DESC, reason;`,
    "unsupported scope reasons",
  );
  const latest = queryJson(
    dbPath,
    `SELECT direction, occurred_at, json_extract(canonical_json, '$.chat_name') AS chat_name, body
     FROM records
     WHERE source_id = 'lark.im'
       AND record_type = 'lark.im.message'
     ORDER BY occurred_at_ms DESC, external_id DESC
     LIMIT 5;`,
    "latest records",
  );

  const countRow = counts[0] || {};
  return {
    messages: {
      total: countRow.total || 0,
      sent: countRow.sent || 0,
      received: countRow.received || 0,
      latest_at: countRow.latest_ms ? new Date(countRow.latest_ms).toISOString() : null,
    },
    message_types: byType,
    quality: quality[0] || {},
    scopes: scopes[0] || {},
    unsupported_reasons: unsupportedReasons,
    recent_failures: recentFailures,
    latest_records: latest,
  };
}

/** @param {JsonObject} report */
function hasQualityIssues(report) {
  return (
    Number(report.quality?.actionable_missing_sender_name || 0) > 0 ||
    Number(report.quality?.missing_chat_name || 0) > 0 ||
    Number(report.quality?.invalid_rendered_body || 0) > 0
  );
}

export {
  collectQualityReport,
  hasQualityIssues,
  one,
  sqliteJson,
};
