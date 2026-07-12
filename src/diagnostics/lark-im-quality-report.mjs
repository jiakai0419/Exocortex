// @ts-check

import { spawnSync } from "node:child_process";
import { classifyLarkFailure } from "../adapters/lark-im/transport.mjs";
import {
  diagnosticSubprocessError,
  publicCommandFailureReason,
  publicErrorCode,
  publicFailureKind,
  publicMessageTypes,
  publicTimestamp,
  publicUnsupportedReasons,
} from "./public-safe.mjs";

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
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  if (result.status !== 0 || result.error) throw diagnosticSubprocessError(result, label);
  const trimmed = String(result.stdout || "").trim();
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

const QUALITY_FIELDS = [
  "missing_sender_name",
  "missing_user_sender_name",
  "missing_app_sender_name",
  "unresolved_app_sender_name",
  "missing_system_sender_name",
  "missing_non_actionable_sender_name",
  "actionable_missing_sender_name",
  "app_sender_records",
  "missing_chat_name",
  "invalid_rendered_body",
  "deleted_or_recalled_body",
];

/**
 * @param {JsonObject} report
 * @returns {JsonObject}
 */
function sanitizeQualityReportForPublicOutput(report) {
  if (report?.status === "command_failed") {
    return {
      ok: false,
      status: "command_failed",
      reason: publicCommandFailureReason(`${report.reason || ""}\n${report.stderr || ""}\n${report.stdout || ""}`),
      exit_status: Number(report.exit_status || 1),
    };
  }
  const quality = Object.fromEntries(
    QUALITY_FIELDS.map((field) => [field, Math.max(0, Number(report?.quality?.[field] || 0))]),
  );
  return {
    messages: {
      total: Math.max(0, Number(report?.messages?.total || 0)),
      sent: Math.max(0, Number(report?.messages?.sent || 0)),
      received: Math.max(0, Number(report?.messages?.received || 0)),
      latest_at: publicTimestamp(report?.messages?.latest_at),
    },
    message_types: publicMessageTypes(report?.message_types),
    quality,
    scopes: {
      total_received_scopes: Math.max(0, Number(report?.scopes?.total_received_scopes || 0)),
      enabled_received_scopes: Math.max(0, Number(report?.scopes?.enabled_received_scopes || 0)),
      enabled_without_cursor: Math.max(0, Number(report?.scopes?.enabled_without_cursor || 0)),
      unsupported_scopes: Math.max(0, Number(report?.scopes?.unsupported_scopes || 0)),
      hot_seen_scopes: Math.max(0, Number(report?.scopes?.hot_seen_scopes || 0)),
    },
    unsupported_reasons: publicUnsupportedReasons(report?.unsupported_reasons),
    recent_failures: (Array.isArray(report?.recent_failures) ? report.recent_failures : []).map((row) => {
      const classification = row.failure_kind
        ? {
            kind: publicFailureKind(row.failure_kind),
            transient: row.transient === true,
            code: publicErrorCode(row.error_code),
          }
        : classifyLarkFailure(row.error_message || "");
      return {
        failure_kind: classification.kind,
        transient: classification.transient === true,
        error_code: publicErrorCode(classification.code),
      };
    }),
  };
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
    `WITH message_quality AS (
       SELECT
         COALESCE(json_extract(canonical_json, '$.sender_name'), '') AS sender_name,
         COALESCE(json_extract(canonical_json, '$.sender_id'), '') AS sender_id,
         COALESCE(json_extract(canonical_json, '$.chat_id'), '') AS chat_id,
         COALESCE(json_extract(canonical_json, '$.sender_name_resolution_status'), '') AS resolution_status,
         COALESCE(json_extract(canonical_json, '$.msg_type'), '') AS msg_type,
         COALESCE(json_extract(canonical_json, '$.chat_type'), '') AS chat_type,
         COALESCE(json_extract(canonical_json, '$.chat_name'), '') AS chat_name,
         body
       FROM records
       WHERE source_id = 'lark.im'
         AND record_type = 'lark.im.message'
     ),
     unresolved_app_pairs AS (
       SELECT DISTINCT sender_id, chat_id
       FROM message_quality
       WHERE sender_id LIKE 'cli_%'
         AND chat_id <> ''
         AND resolution_status = 'unresolved_app_sender'
     ),
     classified AS (
       SELECT
         message_quality.*,
         CASE
           WHEN message_quality.resolution_status = 'unresolved_app_sender' THEN 1
           WHEN message_quality.chat_id <> '' AND unresolved_app_pairs.sender_id IS NOT NULL THEN 1
           ELSE 0
         END AS is_unresolved_app_sender
       FROM message_quality
       LEFT JOIN unresolved_app_pairs
         ON unresolved_app_pairs.sender_id = message_quality.sender_id
        AND unresolved_app_pairs.chat_id = message_quality.chat_id
     )
     SELECT
       SUM(sender_name = '') AS missing_sender_name,
       SUM(
         sender_name = ''
         AND sender_id LIKE 'ou_%'
       ) AS missing_user_sender_name,
       SUM(
         sender_name = ''
         AND sender_id LIKE 'cli_%'
       ) AS missing_app_sender_name,
       SUM(
         sender_name = ''
         AND sender_id LIKE 'cli_%'
         AND is_unresolved_app_sender = 1
       ) AS unresolved_app_sender_name,
       SUM(
         sender_name = ''
         AND msg_type = 'system'
         AND sender_id = ''
       ) AS missing_system_sender_name,
       SUM(
         sender_name = ''
         AND sender_id NOT LIKE 'ou_%'
         AND (
           sender_id NOT LIKE 'cli_%'
           OR is_unresolved_app_sender = 1
         )
         AND NOT (
           msg_type = 'system'
           AND sender_id = ''
         )
       ) AS missing_non_actionable_sender_name,
       SUM(
         sender_name = ''
         AND (
           sender_id LIKE 'ou_%'
           OR (
             sender_id LIKE 'cli_%'
             AND is_unresolved_app_sender = 0
           )
         )
       ) AS actionable_missing_sender_name,
       SUM(sender_id LIKE 'cli_%') AS app_sender_records,
       SUM(
         chat_type IN ('group', 'topic')
         AND chat_name = ''
       ) AS missing_chat_name,
       SUM(body LIKE '[Invalid%JSON]') AS invalid_rendered_body,
       SUM(body LIKE '[已撤回/已删除%') AS deleted_or_recalled_body
     FROM classified;`,
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
    `SELECT error_message
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
       COUNT(*) AS count
     FROM sync_scopes
     WHERE source_id = 'lark.im'
       AND id LIKE 'lark.im.received.chat.%'
       AND json_extract(config_json, '$.unsupported_reason') IS NOT NULL
     GROUP BY reason
     ORDER BY count DESC, reason;`,
    "unsupported scope reasons",
  );
  const countRow = counts[0] || {};
  return sanitizeQualityReportForPublicOutput({
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
    recent_failures: recentFailures.map((row) => {
      const classification = classifyLarkFailure(row.error_message || "");
      return {
        failure_kind: classification.kind,
        transient: classification.transient,
        error_code: classification.code,
      };
    }),
  });
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
  sanitizeQualityReportForPublicOutput,
  sqliteJson,
};
