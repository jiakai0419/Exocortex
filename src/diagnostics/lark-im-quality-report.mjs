// @ts-check

import { readOnlySqliteJson } from "../storage/sqlite/readonly-query.mjs";
import { executeMessages } from "../cli/messages-command.mjs";
import { readMessagesMetadata } from "./messages-report.mjs";
import {
  MESSAGE_COMPLETENESS_SUMMARY_LIMIT,
  MESSAGE_COMPLETENESS_SUMMARY_REASONS,
  summarizeMessageCompleteness,
} from "./message-completeness-summary.mjs";

import { classifySyncRunFailure } from "./sync-run-failure.mjs";
import { runEvidenceSql, runProgress } from "./lark-run-progress.mjs";
import { publicRunProgress } from "./sync-status-report.mjs";
import {
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
  return readOnlySqliteJson(dbPath, sql, label);
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
const IDENTITY_BLOCK_REASONS = ['permission_denied', 'command_unavailable', 'routes_blocked', 'retry_exhausted', 'unknown'];
const IDENTITY_TABLES = { name_tasks: 'lark_im_name_tasks', recipient_state: 'lark_im_recipient_state' };

/** Counts and clocks have explicit unknown values; sanitizing cannot turn
 * unavailable evidence into a successful zero. Never copy message payloads or
 * arbitrary nested summary keys into a public diagnostic report.
 * @param {unknown} value */
const safeCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** @param {unknown} value */
function safeClock(value) {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at >= 0 && new Date(at).toISOString() === value ? value : null;
}

/** This is a protocol whitelist, not a second message classifier.
 * @param {JsonObject|undefined} value */
function publicCompleteness(value) {
  const status = ['complete', 'bounded', 'invalid'].includes(value?.evaluation?.status)
    ? value?.evaluation?.status : 'invalid';
  return {
    version: value?.version === 1 ? 1 : null,
    scope: value?.scope === 'stored_lark_im_messages' ? value.scope : 'unknown',
    filter: {
      direction: ['all', 'sent', 'received'].includes(value?.filter?.direction) ? value?.filter?.direction : 'unknown',
      has_search: value?.filter?.has_search === true,
    },
    limit: value?.limit === MESSAGE_COMPLETENESS_SUMMARY_LIMIT ? MESSAGE_COMPLETENESS_SUMMARY_LIMIT : null,
    as_of: { read_at: safeClock(value?.as_of?.read_at), source_max_record_id: safeCount(value?.as_of?.source_max_record_id) },
    population: { total: safeCount(value?.population?.total), evaluated: safeCount(value?.population?.evaluated),
      not_evaluated: safeCount(value?.population?.not_evaluated) },
    counts: Object.fromEntries(['captured', 'enriching', 'ready', 'blocked'].map(state => [state, safeCount(value?.counts?.[state])])),
    incomplete: safeCount(value?.incomplete),
    reasons: Object.fromEntries(MESSAGE_COMPLETENESS_SUMMARY_REASONS.map(reason => [reason, safeCount(value?.reasons?.[reason])])),
    evaluation: { mode: 'bounded_latest', status,
      complete: status === 'complete' && value?.evaluation?.complete === true,
      input_truncated: value?.evaluation?.input_truncated === true,
      invalid_readiness_count: safeCount(value?.evaluation?.invalid_readiness_count),
      metadata_valid: value?.evaluation?.metadata_valid === true },
    timing: {
      basis: 'source_occurrence_not_first_missing',
      oldest_source_at: safeClock(value?.timing?.oldest_source_at),
      oldest_source_age_ms: safeCount(value?.timing?.oldest_source_age_ms),
      source_time_unknown_count: safeCount(value?.timing?.source_time_unknown_count),
      source_age_unknown_count: safeCount(value?.timing?.source_age_unknown_count),
      first_missing: { oldest_at: safeClock(value?.timing?.first_missing?.oldest_at),
        oldest_age_ms: safeCount(value?.timing?.first_missing?.oldest_age_ms),
        unknown_count: safeCount(value?.timing?.first_missing?.unknown_count) },
      completion: { latest_at: safeClock(value?.timing?.completion?.latest_at),
        latency_ms: safeCount(value?.timing?.completion?.latency_ms),
        unknown_count: safeCount(value?.timing?.completion?.unknown_count) },
      first_missing_observed: { oldest_at: safeClock(value?.timing?.first_missing_observed?.oldest_at),
        oldest_age_ms: safeCount(value?.timing?.first_missing_observed?.oldest_age_ms),
        known_count: safeCount(value?.timing?.first_missing_observed?.known_count),
        unknown_count: safeCount(value?.timing?.first_missing_observed?.unknown_count) },
      first_ready_observed: { latest_at: safeClock(value?.timing?.first_ready_observed?.latest_at),
        known_count: safeCount(value?.timing?.first_ready_observed?.known_count),
        unknown_count: safeCount(value?.timing?.first_ready_observed?.unknown_count) },
      observed_regressions: { regression_count: safeCount(value?.timing?.observed_regressions?.regression_count),
        known_count: safeCount(value?.timing?.observed_regressions?.known_count),
        unknown_count: safeCount(value?.timing?.observed_regressions?.unknown_count) },
    },
  };
}

/** Persisted work state has its own denominator. It does not assert that the
 * corresponding message is incomplete or that a nonempty stored name is true.
 * Recipient retry state does not persist projection/block categories; leave
 * them unknown rather than derive them from a paging cursor or generic error.
 * @param {JsonObject|undefined} value */
function publicIdentityWork(value) {
  return {
    version: 1, scope: 'persisted_identity_work', source_id: 'lark.im', account_scope: 'all_stored_accounts',
    basis: 'scheduler_state_not_message_readiness', as_of: { read_at: safeClock(value?.as_of?.read_at) },
    ...Object.fromEntries(Object.entries(IDENTITY_TABLES).map(([key, table]) => {
      const row = value?.[key];
      return [key, { table, availability: ['known', 'partial', 'unavailable'].includes(row?.availability) ? row.availability : 'unavailable',
        total: safeCount(row?.total), unresolved: safeCount(row?.unresolved),
        pending_projection: row?.projection_status === 'recorded' ? safeCount(row?.pending_projection) : null,
        projection_status: row?.projection_status === 'recorded' ? 'recorded' : 'unknown',
        blocked_status: row?.blocked_status === 'recorded' ? 'recorded' : 'unknown',
        blocked_reasons: Object.fromEntries(IDENTITY_BLOCK_REASONS.map(reason => [reason,
          row?.blocked_status === 'recorded' ? safeCount(row?.blocked_reasons?.[reason]) : null])),
        enqueue_population: 'unresolved_tasks', enqueue_status: row?.enqueue_status === 'recorded' ? 'recorded' : 'unknown',
        oldest_known_enqueued_at: row?.enqueue_status === 'recorded' ? safeClock(row?.oldest_known_enqueued_at) : null,
        oldest_known_enqueue_age_ms: row?.enqueue_status === 'recorded' ? safeCount(row?.oldest_known_enqueue_age_ms) : null,
        enqueue_time_unknown_count: row?.enqueue_status === 'recorded' ? safeCount(row?.enqueue_time_unknown_count) : null,
      }];
    })),
  };
}

/** Schema-only preflight selects compatible expressions. All task counts and
 * their clock are then aggregated in one SQL snapshot; no task payload or key
 * crosses into JavaScript. Missing tables/columns and schema races stay unknown.
 * @param {string} db @param {typeof sqliteJson} query */
function collectIdentityWork(db, query) {
  try {
    const schema = query(db, `SELECT 'name_tasks' AS group_key,name FROM pragma_table_info('lark_im_name_tasks')
      UNION ALL SELECT 'recipient_state' AS group_key,name FROM pragma_table_info('lark_im_recipient_state');`, 'identity work schema');
    const branches = [];
    /** @type {Record<string, any>} */
    const capabilities = {};
    for (const [key, table] of Object.entries(IDENTITY_TABLES)) {
      const columns = new Set(schema.filter(row => row.group_key === key).map(row => row.name));
      const has = (...names) => names.every(name => columns.has(name));
      const source = has('source_id'), name = key === 'name_tasks';
      const resolution = source && (name ? has('outcome') : has('retry_at_ms', 'evidence_json', 'attempt_evidence_json'));
      const projection = source && name && has('outcome', 'projection_deferred');
      const blocked = source && name && has('blocked_reason');
      const enqueued = resolution && has('enqueued_at_ms');
      capabilities[key] = { availability: !source ? 'unavailable' : resolution && enqueued && (!name || projection && blocked) ? 'known' : 'partial',
        projection_status: projection ? 'recorded' : 'unknown', blocked_status: blocked ? 'recorded' : 'unknown',
        enqueue_status: enqueued ? 'recorded' : 'unknown' };
      const unresolved = !resolution ? 'NULL' : name ? "outcome IS NOT 'resolved'"
        : 'NOT(retry_at_ms=9007199254740991 AND evidence_json IS NOT NULL AND attempt_evidence_json IS evidence_json)';
      const knownTime = "typeof(enqueued_at_ms)='integer' AND enqueued_at_ms>0 AND enqueued_at_ms<=snapshot.now_ms";
      const sum = expression => `COALESCE(SUM(CASE WHEN ${expression} THEN 1 ELSE 0 END),0)`;
      const expressions = [source ? 'COUNT(*)' : 'NULL', resolution ? sum(unresolved) : 'NULL',
        projection ? sum("projection_deferred=1 OR outcome IN ('applying','capacity_deferred')") : 'NULL',
        enqueued ? `MIN(CASE WHEN (${unresolved}) AND (${knownTime}) THEN enqueued_at_ms END)` : 'NULL',
        enqueued ? sum(`(${unresolved}) AND NOT(${knownTime})`) : 'NULL',
        ...IDENTITY_BLOCK_REASONS.map(reason => !blocked ? 'NULL' : sum(reason === 'unknown'
          ? "blocked_reason IS NOT NULL AND blocked_reason NOT IN ('permission_denied','command_unavailable','routes_blocked','retry_exhausted')"
          : `blocked_reason='${reason}'`))];
      const aliases = ['total', 'unresolved', 'pending_projection', 'oldest_ms', 'unknown_enqueue', ...IDENTITY_BLOCK_REASONS.map(reason => `blocked_${reason}`)];
      branches.push(`SELECT '${key}' AS group_key,(SELECT read_at FROM snapshot) AS read_at,(SELECT now_ms FROM snapshot) AS now_ms,
        ${expressions.map((value, index) => `${value} AS ${aliases[index]}`).join(',')}
        FROM snapshot${source ? `,${table} WHERE source_id='lark.im'` : ''}`);
    }
    const rows = query(db, `WITH snapshot AS MATERIALIZED (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS read_at,
      CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER) AS now_ms)
      ${branches.join('\nUNION ALL\n')};`, 'identity work counts');
    if (rows.length !== 2 || new Set(rows.map(row => row.group_key)).size !== 2
      || rows.some(row => !Object.hasOwn(IDENTITY_TABLES, row.group_key)) || rows[0].read_at !== rows[1].read_at) return publicIdentityWork(undefined);
    const result = { as_of: { read_at: rows[0].read_at } };
    for (const row of rows) {
      const at = safeCount(row.oldest_ms), now = safeCount(row.now_ms);
      result[row.group_key] = { ...capabilities[row.group_key], total: row.total, unresolved: row.unresolved,
        pending_projection: row.pending_projection,
        blocked_reasons: Object.fromEntries(IDENTITY_BLOCK_REASONS.map(reason => [reason, row[`blocked_${reason}`]])),
        oldest_known_enqueued_at: at !== null && at <= 8_640_000_000_000_000 ? new Date(at).toISOString() : null,
        oldest_known_enqueue_age_ms: at !== null && now !== null && now >= at ? now - at : null,
        enqueue_time_unknown_count: row.unknown_enqueue };
    }
    return publicIdentityWork(result);
  } catch { return publicIdentityWork(undefined); }
}

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
    completeness: publicCompleteness(report?.completeness),
    identity_work: publicIdentityWork(report?.identity_work),
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
        : classifySyncRunFailure(row);
      return {
        failure_kind: classification.kind,
        transient: classification.transient === true,
        error_code: publicErrorCode(classification.code),
        ...publicRunProgress(row),
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
    runEvidenceSql("r.status = 'failed'", { limit: 5 }) + ";",
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
  // The exact CLI path applies validated local sidecar names and retains the
  // atomic page/population metadata. Legacy SQL counters above remain canonical
  // diagnostics; they are not this bounded display-completeness denominator.
  const messages = executeMessages({ db: dbPath, direction: 'all', limit: MESSAGE_COMPLETENESS_SUMMARY_LIMIT, search: '' });
  const metadata = readMessagesMetadata(messages);
  const completeness = summarizeMessageCompleteness(messages, {
    ...metadata,
    filter: { ...metadata?.filter, search: '' },
  });
  return sanitizeQualityReportForPublicOutput({
    messages: {
      total: countRow.total || 0,
      sent: countRow.sent || 0,
      received: countRow.received || 0,
      latest_at: countRow.latest_ms ? new Date(countRow.latest_ms).toISOString() : null,
    },
    message_types: byType,
    quality: quality[0] || {},
    completeness,
    identity_work: collectIdentityWork(dbPath, queryJson),
    scopes: scopes[0] || {},
    unsupported_reasons: unsupportedReasons,
    recent_failures: recentFailures.map((row) => {
      const classification = classifySyncRunFailure(row);
      return {
        failure_kind: classification.kind,
        transient: classification.transient,
        error_code: classification.code,
        ...runProgress(row),
      };
    }),
  });
}

/** @param {JsonObject} report */
function hasQualityIssues(report) {
  // Preserve the canonical-only check/--wait exit contract, including advisory
  // system and unresolved-app counts. Bounded completeness is reported above;
  // it cannot claim that unevaluated messages are complete or change this gate.
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
