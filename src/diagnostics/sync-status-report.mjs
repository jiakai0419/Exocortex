// @ts-check

import { databaseActivityEvidence, databaseOnlyHealth, observeLockOwners } from "./lark-im-activity-evidence.mjs";

import { readOnlySqliteJson } from "../storage/sqlite/readonly-query.mjs";

import { classifySyncRunFailure } from "./sync-run-failure.mjs";
import { runEvidenceSql, RUN_EVIDENCE_COLUMNS, runProgress, transitionCounts, TRANSITION_LIMIT, LEGACY_TRANSITION_SQL } from "./lark-run-progress.mjs";
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
 * @property {typeof import("./lark-im-activity-evidence.mjs").inspectActivityProcesses=} inspectActivityProcesses
 * @property {() => number=} now
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
function publicCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Preserve absent evidence as unknown, not an empty backlog.
 * @param {JsonObject | undefined} value @param {string[]} counts */
function progressEvidence(value, counts) {
  if (value?.evidence === "available" && counts.every((key) => publicCount(value[key]) !== null)) return "available";
  return value?.evidence === "legacy_unavailable" || value === undefined ? "legacy_unavailable" : "unavailable";
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
  if (Object.hasOwn(cursor, "completed_at")) {
    projected.completed_at = null;
    try {
      projected.completed_at = publicTimestamp(cursor.completed_at);
    } catch {
      // An out-of-range timestamp is unknown completion evidence.
    }
  }
  return Object.keys(projected).length > 0 ? projected : null;
}

/**
 * @param {string} health
 * @param {JsonObject} scopes
 * @param {JsonObject | null} discoveryCursor
 * @param {JsonObject} details
 * @param {JsonObject} listProgress
 */
function publicHealthDetail(health, scopes, discoveryCursor, details, listProgress) {
  if (details.evidence === "unavailable") return "message detail evidence is unavailable";
  if (listProgress.evidence === "unavailable" || Number(listProgress.invalid_cursor_scopes || 0) > 0) return "message list progress evidence is unavailable";
  if (Number(details.pending_count || 0) > 0) return `${details.pending_count} message details await retry; list progress does not prove full content`;
  if (health === "not_ready") return "initial discovery or successful message-scope evidence is missing";
  if (health === "needs_attention") return "sync history contains failures but no successful run";
  if (health === "unknown") return "current activity is unverified; database history does not prove a running sync";
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

/** @param {JsonObject} run */
function publicRunProgress(run) {
  if (!["list", "details", "unknown"].includes(run.phase) ||
      !["complete", "awaiting_details", "attempt_failed"].includes(run.outcome) ||
      !["resolved", "unresolved", "unknown", "not_applicable"].includes(run.resolution)) return {};
  return { phase: run.phase, outcome: run.outcome, resolution: run.resolution };
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
  let health = ["syncing", "catching_up", "not_ready", "needs_attention", "ok", "ok_with_history"].includes(report?.health)
    ? databaseOnlyHealth(report.health)
    : "unknown";
  const detailEvidence = progressEvidence(report?.details, ["pending_count", "due_count", "scopes_pending"]);
  const details = {
    evidence: detailEvidence,
    pending_count: detailEvidence === "available" ? publicCount(report.details.pending_count) : null,
    due_count: detailEvidence === "available" ? publicCount(report.details.due_count) : null,
    scopes_pending: detailEvidence === "available" ? publicCount(report.details.scopes_pending) : null,
    oldest_pending_ms: detailEvidence === "available" ? publicCount(report.details.oldest_pending_ms) : null,
    next_retry_at: detailEvidence === "available" ? publicTimestamp(report.details.next_retry_at) : null,
  };
  const listEvidence = progressEvidence(report?.list_progress, ["scopes", "invalid_cursor_scopes"]);
  const listProgress = {
    evidence: listEvidence,
    scopes: listEvidence === "available" ? publicCount(report.list_progress.scopes) : null,
    oldest_cursor_ms: listEvidence === "available" ? publicCount(report.list_progress.oldest_cursor_ms) : null,
    invalid_cursor_scopes: listEvidence === "available" ? publicCount(report.list_progress.invalid_cursor_scopes) : null,
  };
  if (detailEvidence === "unavailable" || listEvidence === "unavailable" || Number(listProgress.invalid_cursor_scopes || 0) > 0) health = "needs_attention";
  else if (Number(details.pending_count || 0) > 0) health = "catching_up";
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
    details,
    list_progress: listProgress,
    ...(report?.source_observations ? { source_observations: {
      evidence: report?.source_observations?.evidence === "available" ? "available" : "legacy_unavailable",
      coverage: "processed_known_rows_not_source_completeness",
      ...Object.fromEntries(["pending", "pending_unordered_versions", "history_errors", "scopes_started", "processed_attempts", "completed_sweeps"].map(key =>
        [key, publicCount(report?.source_observations?.[key])])),
    } } : {}),
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
      actionable_failed_runs: publicCount(report?.runs?.actionable_failed_runs),
      transitions: { resolved: publicCount(report?.runs?.transitions?.resolved),
        unresolved: publicCount(report?.runs?.transitions?.unresolved), unknown: publicCount(report?.runs?.transitions?.unknown) },
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
        ...publicRunProgress(run),
      })),
    },
    current_activity: databaseActivityEvidence(report?.locks, Number(report?.runs?.by_status?.running || 0)),
    locks: (Array.isArray(report?.locks) ? report.locks : []).map((lock) => ({
      locked_at: publicTimestamp(lock.locked_at),
      expires_at: publicTimestamp(lock.expires_at),
      ...(lock.owner_state ? { owner_state: ["alive", "dead", "unknown"].includes(lock.owner_state) ? lock.owner_state : "unknown", owner_observed_at: publicTimestamp(lock.owner_observed_at) } : {}),
    })),
    recovery: {
      performed: false,
      recovered_locks: 0,
      cancelled_runs: 0,
      active_expired_locks: 0,
    },
    health,
    health_detail: publicHealthDetail(health, scopes, discoveryCursor, details, listProgress),
  };
}

// Schema discovery selects only the SQL shape. Every health/readiness fact,
// including schema validation, is then collected by one SELECT on one snapshot.
const DETAIL_SCHEMA_SQL = `SELECT name, sql FROM sqlite_schema WHERE type = 'table'
  AND name IN ('lark_im_list_progress', 'lark_im_detail_tasks', 'schema_migrations', 'record_observation_state', 'lark_im_history_progress') ORDER BY name`;
const ENABLED_MESSAGE_SCOPE = "s.source_id = 'lark.im' AND s.enabled = 1 AND (s.id = 'lark.im.sent_by_me' OR s.id LIKE 'lark.im.received.chat.%')";

/** @param {string} dbPath @param {(dbPath: string, sql: string, label: string) => Row[]} query */
function readStatusSnapshot(dbPath, query) {
  const expectedSchema = query(dbPath, `${DETAIL_SCHEMA_SQL};`, "read detail progress schema");
  const names = new Set(expectedSchema.map((row) => row.name));
  const present = Number(names.has("lark_im_list_progress")) + Number(names.has("lark_im_detail_tasks"));
  if (present === 1) throw new Error("message detail progress schema is incomplete");
  /** @type {{label: string, columns: string[], sql: string, rowLimit?: number}[]} */
  const sections = [
    { label: "read detail progress schema", columns: ["name", "sql"], sql: DETAIL_SCHEMA_SQL },
    { label: "read detail progress migration", columns: ["version"], sql: names.has("schema_migrations")
      ? "SELECT version FROM schema_migrations WHERE version = '009'" : "SELECT NULL AS version WHERE 0" },
    { label: "read record totals", columns: ["count", "latest_ms"],
      sql: "SELECT COUNT(*) AS count, MAX(occurred_at_ms) AS latest_ms FROM records" },
    { label: "read direction totals", columns: ["direction", "count", "latest_ms"],
      sql: "SELECT COALESCE(direction, 'unknown') AS direction, COUNT(*) AS count, MAX(occurred_at_ms) AS latest_ms FROM records GROUP BY direction ORDER BY direction" },
    { label: "read scope totals", columns: ["total", "enabled", "received_enabled", "received_without_cursor", "message_enabled", "message_without_success", "received_unsupported"],
      sql: `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled,
         SUM(CASE WHEN id LIKE 'lark.im.received.chat.%' AND enabled = 1 THEN 1 ELSE 0 END) AS received_enabled,
         SUM(CASE WHEN id LIKE 'lark.im.received.chat.%' AND enabled = 1 AND cursor_json IS NULL THEN 1 ELSE 0 END) AS received_without_cursor,
         SUM(CASE WHEN enabled = 1 AND (id = 'lark.im.sent_by_me' OR id LIKE 'lark.im.received.chat.%') THEN 1 ELSE 0 END) AS message_enabled,
         SUM(CASE WHEN enabled = 1 AND (id = 'lark.im.sent_by_me' OR id LIKE 'lark.im.received.chat.%')
           AND NOT EXISTS (SELECT 1 FROM sync_runs r WHERE r.id = sync_scopes.last_success_run_id AND r.scope_id = sync_scopes.id
             AND r.source_id = sync_scopes.source_id AND r.status = 'succeeded'
             AND (r.metadata_json IS NULL OR CASE WHEN json_valid(r.metadata_json) THEN
               (json_type(r.metadata_json, '$.lark_progress') IS NULL
                AND json_type(r.metadata_json, '$.details_complete') IS NULL)
               OR (json_type(r.metadata_json, '$.details_complete') = 'true'
                 AND json_type(r.metadata_json, '$.list_complete') = 'true'
                 AND json_type(r.metadata_json, '$.window_complete') = 'true'
                 AND json_type(r.metadata_json, '$.pending_detail_count') = 'integer'
                 AND json_extract(r.metadata_json, '$.pending_detail_count') = 0
                 AND (json_type(r.metadata_json, '$.lark_progress') IS NULL
                   OR (json_type(r.metadata_json, '$.lark_progress') = 'object'
                     AND json_type(r.metadata_json, '$.lark_progress.version') = 'integer'
                     AND json_extract(r.metadata_json, '$.lark_progress.version') = 1
                     AND json_extract(r.metadata_json, '$.lark_progress.outcome') = 'complete'
                     AND json_type(r.metadata_json, '$.lark_progress.generation') = 'integer'
                     AND json_type(r.metadata_json, '$.__run_fence.list_generation') = 'integer'
                     AND json_extract(r.metadata_json, '$.__run_fence.list_generation') >= 0
                     AND json_extract(r.metadata_json, '$.lark_progress.generation') = json_extract(r.metadata_json, '$.__run_fence.list_generation') + 1
                     AND json_type(r.metadata_json, '$.lark_progress.failed') = 'integer'
                     AND json_extract(r.metadata_json, '$.lark_progress.failed') = 0
                     AND json_type(r.metadata_json, '$.lark_progress.attempted') = 'integer'
                     AND json_type(r.metadata_json, '$.lark_progress.completed') = 'integer'
                     AND json_extract(r.metadata_json, '$.lark_progress.attempted') = json_extract(r.metadata_json, '$.lark_progress.completed')
                     AND ((json_extract(r.metadata_json, '$.lark_progress.phase') = 'list'
                       AND json_extract(r.metadata_json, '$.lark_progress.attempted') = 0)
                       OR (json_extract(r.metadata_json, '$.lark_progress.phase') = 'details'
                         AND json_extract(r.metadata_json, '$.lark_progress.attempted') BETWEEN 1 AND 100)))))
               ELSE 0 END))
           THEN 1 ELSE 0 END) AS message_without_success,
         SUM(CASE WHEN id LIKE 'lark.im.received.chat.%' AND json_extract(config_json, '$.unsupported_reason') IS NOT NULL THEN 1 ELSE 0 END) AS received_unsupported
       FROM sync_scopes` },
    { label: "read unsupported scope reasons", columns: ["reason", "lark_cli_error_code", "count"],
      sql: `SELECT COALESCE(json_extract(config_json, '$.unsupported_reason'), 'unknown') AS reason,
        MAX(COALESCE(json_extract(config_json, '$.lark_cli_error_code'), '')) AS lark_cli_error_code,
        COUNT(*) AS count FROM sync_scopes
        WHERE id LIKE 'lark.im.received.chat.%' AND json_extract(config_json, '$.unsupported_reason') IS NOT NULL
        GROUP BY reason ORDER BY count DESC, reason` },
    ...[
      ["read discovery scope", "lark.im.unmuted_chat_discovery"],
      ["read hot discovery scope", "lark.im.unmuted_chat_hot"],
      ["read reconcile scope", "lark.im.unmuted_chat_reconcile"],
    ].map(([label, scopeId]) => ({ label, columns: ["cursor_json", "cursor_updated_at", "has_success"],
      sql: `SELECT cursor_json, cursor_updated_at, (last_success_run_id IS NOT NULL) AS has_success
        FROM sync_scopes WHERE id = ${quoteSql(scopeId)} LIMIT 1` })),
    { label: "read run counts", columns: ["status", "count"],
      sql: "SELECT status, COUNT(*) AS count FROM sync_runs GROUP BY status ORDER BY status" },
    { label: "read recent runs", columns: [...RUN_EVIDENCE_COLUMNS, "evidence_cutoff_ms", "closure_candidates_json"],
      sql: runEvidenceSql("1", { limit: 10 }), rowLimit: 10 },
    { label: "read failed run transitions", columns: [...RUN_EVIDENCE_COLUMNS, "evidence_cutoff_ms", "closure_candidates_json"],
      sql: runEvidenceSql(LEGACY_TRANSITION_SQL, { limit: TRANSITION_LIMIT }), rowLimit: TRANSITION_LIMIT },
    { label: "read failed transition count", columns: ["count"],
      sql: `SELECT COUNT(*) AS count FROM sync_runs r WHERE ${LEGACY_TRANSITION_SQL}` },
    { label: "read locks", columns: ["locked_at", "expires_at", "locked_by"],
      sql: "SELECT locked_at, expires_at, locked_by FROM sync_locks ORDER BY locked_at DESC" },
  ];
  if (present === 2) sections.push(
    { label: "read pending detail totals", columns: ["pending_count", "scopes_pending", "due_count", "oldest_pending_ms", "next_retry_at"],
      sql: `SELECT COUNT(*) AS pending_count, COUNT(DISTINCT t.scope_id) AS scopes_pending,
        COALESCE(SUM(CASE WHEN julianday(t.retry_at) <= julianday('now') THEN 1 ELSE 0 END), 0) AS due_count,
        MIN(t.occurred_at_ms) AS oldest_pending_ms, MIN(t.retry_at) AS next_retry_at
        FROM lark_im_detail_tasks t JOIN sync_scopes s ON s.id = t.scope_id
        WHERE ${ENABLED_MESSAGE_SCOPE} AND t.status = 'pending'` },
    { label: "read list progress totals", columns: ["scopes", "oldest_cursor_ms", "invalid_cursor_scopes"],
      sql: `WITH progress AS (
        SELECT CASE WHEN json_valid(p.cursor_json) THEN p.cursor_json ELSE '{}' END AS cursor_json
        FROM lark_im_list_progress p JOIN sync_scopes s ON s.id = p.scope_id WHERE ${ENABLED_MESSAGE_SCOPE}
      ), cursors AS (
        SELECT CASE WHEN json_extract(cursor_json, '$.kind') = 'time_message_cursor/v1'
          AND json_type(cursor_json, '$.created_at_ms') = 'integer'
          AND json_extract(cursor_json, '$.created_at_ms') BETWEEN 0 AND 9007199254740991
          THEN json_extract(cursor_json, '$.created_at_ms') END AS cursor_ms FROM progress
      ) SELECT COUNT(*) AS scopes, MIN(cursor_ms) AS oldest_cursor_ms,
        COUNT(*) - COUNT(cursor_ms) AS invalid_cursor_scopes FROM cursors` },
  );
  if (names.has("record_observation_state") && names.has("lark_im_history_progress")) sections.push({
    label: "read source observation totals", columns: ["pending", "pending_unordered_versions", "history_errors", "scopes_started", "processed_attempts", "completed_sweeps"],
    sql: `SELECT
      (SELECT COUNT(*) FROM record_observation_state o JOIN records r ON r.id=o.record_id
        WHERE r.source_id='lark.im' AND o.candidate_json IS NOT NULL) AS pending,
      (SELECT COUNT(*) FROM record_observation_state o JOIN records r ON r.id=o.record_id
        WHERE r.source_id='lark.im' AND o.candidate_json IS NOT NULL AND o.reason='source_version_unordered') AS pending_unordered_versions,
      (SELECT COUNT(*) FROM record_observation_state o JOIN records r ON r.id=o.record_id
        WHERE r.source_id='lark.im' AND o.history_error IS NOT NULL) AS history_errors,
      COUNT(*) AS scopes_started,COALESCE(SUM(generation),0) AS processed_attempts,COALESCE(SUM(completed_sweeps),0) AS completed_sweeps
      FROM lark_im_history_progress`
  });
  // A single SELECT also gives all julianday('now') evaluations one clock value.
  // Tagged aggregate arrays preserve empty result sets without multiple CLI JSON
  // documents. Labels/columns/SQL are application constants, never caller SQL.
  // The CLI's JSON output is costly when it re-encodes a large aggregate text
  // cell. Emit bounded run proofs one row at a time, retaining an explicit empty
  // section. Each proof is computed once, within this same read snapshot.
  const materialized = sections.flatMap((section, index) => section.rowLimit
    ? [`status_section_${index} AS MATERIALIZED (${section.sql})`] : []);
  const sql = `WITH ${materialized.join(",\n")}\n` + sections.map(({ label, columns, sql, rowLimit }, index) => {
    const value = `json_object(${columns.map((column) => `${quoteSql(column)}, ${column}`).join(", ")})`;
    return rowLimit ? `SELECT ${quoteSql(label)} AS section, json_array(${value}) AS rows_json
      FROM (SELECT * FROM status_section_${index} ORDER BY id DESC)
      UNION ALL SELECT ${quoteSql(label)} AS section, '[]' AS rows_json
      WHERE NOT EXISTS (SELECT 1 FROM status_section_${index})`
      : `SELECT ${quoteSql(label)} AS section, json_group_array(${value}) AS rows_json FROM (${sql})`;
  }).join("\nUNION ALL\n") + ";";
  const rows = query(dbPath, sql, "read sync status snapshot");
  /** @type {Map<string, Row[]>} */
  const snapshot = new Map();
  const expectedLabels = new Set(sections.map((section) => section.label));
  const rowLimits = new Map(sections.filter((section) => section.rowLimit).map((section) => [section.label, section.rowLimit]));
  for (const row of rows) {
    const values = parseMaybeJson(row.rows_json);
    const prior = snapshot.get(row.section);
    const rowLimit = rowLimits.get(row.section);
    if (!expectedLabels.has(row.section) || (!rowLimit && prior) || !Array.isArray(values) ||
        values.some((value) => !value || typeof value !== "object" || Array.isArray(value))) {
      throw new Error("sync status snapshot returned invalid evidence");
    }
    if (rowLimit && (values.length > 1 || (prior && (prior.length === 0 || values.length === 0)) ||
        (prior?.length || 0) + values.length > rowLimit || values.some((value) =>
          !Number.isSafeInteger(value.id) || value.id < 1 || prior?.some((previous) => previous.id === value.id)))) {
      throw new Error("sync status snapshot returned invalid run evidence");
    }
    snapshot.set(row.section, prior ? [...prior, ...values] : values);
  }
  if (snapshot.size !== sections.length) throw new Error("sync status snapshot returned incomplete evidence");
  const schema = snapshot.get("read detail progress schema");
  if (JSON.stringify(schema) !== JSON.stringify(expectedSchema)) {
    throw new Error("message detail progress schema changed during status collection");
  }
  if (present === 0 && snapshot.get("read detail progress migration")?.length) {
    throw new Error("message detail progress schema is incomplete");
  }
  for (const label of ["read record totals", "read scope totals", "read failed transition count", ...(present === 2
    ? ["read pending detail totals", "read list progress totals"] : [])]) {
    if (snapshot.get(label)?.length !== 1) throw new Error("sync status snapshot returned incomplete aggregate evidence");
  }
  return snapshot;
}

/** @param {string} dbPath @param {SyncStatusReportDeps} [deps] */
function buildStatus(dbPath, deps = {}) {
  const snapshot = readStatusSnapshot(dbPath, deps.sqliteJson || sqliteJson);
  /** @param {string} label */
  const rows = (label) => snapshot.get(label) || [];
  const totals = first(rows("read record totals"));
  const hasDetails = snapshot.has("read pending detail totals");
  const detailProgress = hasDetails ? {
    details: { evidence: "available", ...first(rows("read pending detail totals")) },
    list_progress: { evidence: "available", ...first(rows("read list progress totals")) },
  } : { details: { evidence: "legacy_unavailable" }, list_progress: { evidence: "legacy_unavailable" } };
  const byDirection = rows("read direction totals");
  const scopeCounts = first(rows("read scope totals"));
  const unsupportedReasons = rows("read unsupported scope reasons");
  const discoveryRow = first(rows("read discovery scope"));
  const hotDiscoveryRow = first(rows("read hot discovery scope"));
  const reconcileRow = first(rows("read reconcile scope"));
  const runCounts = rows("read run counts");
  const recentRuns = rows("read recent runs");
  const transitionRows = rows("read failed run transitions");
  const transitions = transitionCounts(transitionRows);
  transitions.unknown += Math.max(0, Number(first(rows("read failed transition count")).count || 0) - transitionRows.length);
  const actionableFailedRuns = Math.max(0, Number(countBy(runCounts, "status", "count").failed || 0) - transitions.resolved);
  const locks = observeLockOwners(rows("read locks"), deps.inspectActivityProcesses, deps.now);

  const discoveryCursor = parseMaybeJson(discoveryRow.cursor_json);
  const hotDiscoveryCursor = parseMaybeJson(hotDiscoveryRow.cursor_json);
  const reconcileCursor = parseMaybeJson(reconcileRow.cursor_json);
  return sanitizeStatusReportForPublicOutput({
    ...detailProgress,
    source_observations: snapshot.has("read source observation totals") ? { evidence: "available", ...first(rows("read source observation totals")) }
      : { evidence: "legacy_unavailable" },
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
      actionable_failed_runs: actionableFailedRuns,
      transitions,
      recent: recentRuns.map((run) => {
        const classification = classifySyncRunFailure(run);
        return {
          status: run.status,
          ...runProgress(run),
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
    health: summarizeHealth({ discoveryCursor, scopeCounts, locks, runCounts, details: detailProgress.details, actionableFailedRuns }),
  });
}

export {
  buildStatus,
  sanitizeStatusReportForPublicOutput,
  sqliteJson,
  publicRunProgress,
};
