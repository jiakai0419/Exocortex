// @ts-check

// These are retained-run proofs, never message freshness or current queue state.
// All closure candidates must be read alongside their run in one SQLite snapshot.
const CLOSURE_LIMIT = 100;
const CLOSURE_BYTE_LIMIT = 16 * 1024;
const TRANSITION_LIMIT = 200;
const LEGACY_TRANSITION_SQL = `r.status='failed' AND r.source_id='lark.im' AND r.error_type='LarkDetailIncomplete'
  AND CASE WHEN json_valid(r.metadata_json) THEN
    COALESCE(json_extract(r.metadata_json,'$.adapter'),'') != 'lark.im.details'
    AND COALESCE(json_type(r.metadata_json,'$.detail_retry'),'') != 'true'
    AND COALESCE(json_extract(r.metadata_json,'$.lark_progress.phase'),'') != 'details' ELSE 1 END`;
const RUN_EVIDENCE_COLUMNS = ["id", "source_id", "scope_id", "status", "started_at", "finished_at",
  "cursor_before_json", "cursor_after_json", "metadata_json", "error_type", "error_message",
  "scanned_count", "inserted_count", "updated_count", "duplicate_count"];

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction) => `.${String(fraction || "").padEnd(3, "0")}Z`);
  return new Date(milliseconds).toISOString() === canonical ? milliseconds : null;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
}
const parse = (value) => { try { return JSON.parse(value); } catch { return undefined; } };
const metadata = (run) => { const value = parse(run.metadata_json); return object(value) ? value : null; };

/** Normalize only the persisted scope identity, not mutable scope configuration. */
function identity(run, meta) {
  const value = meta?.__run_fence?.scope_config;
  if (!object(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "chat_id")) return null;
  if (run.scope_id === "lark.im.sent_by_me") return value.chat_id === null ? "sent" : null;
  return typeof run.scope_id === "string" && run.scope_id.startsWith("lark.im.received.chat.") &&
    typeof value.chat_id === "string" && value.chat_id.length > 0 ? JSON.stringify(["received", value.chat_id]) : null;
}

function cursor(raw) {
  if (raw === null) return { initial: true, ms: null, key: "null" };
  if (typeof raw !== "string") return null;
  const value = parse(raw);
  if (value === null) return { initial: true, ms: null, key: "null" };
  if (!object(value) || value.kind !== "time_message_cursor/v1" || !integer(value.created_at_ms) ||
      value.created_at_ms > 253402300799999) return null;
  return { initial: false, ms: value.created_at_ms, key: JSON.stringify(canonical(value)) };
}

/** Validate the store-owned stage object before using it as semantic evidence. */
function stage(run, meta) {
  const value = meta?.lark_progress;
  if (!object(value) || value.version !== 1 || !["list", "details"].includes(value.phase) ||
      !["complete", "awaiting_details", "attempt_failed"].includes(value.outcome) ||
      ![value.attempted, value.completed, value.failed, value.generation].every(integer) ||
      value.attempted !== value.completed + value.failed || meta.list_complete !== true ||
      !integer(meta.pending_detail_count) || !integer(meta.__run_fence?.list_generation) ||
      value.generation < 1 || value.generation !== meta.__run_fence.list_generation + 1) return null;
  if (value.phase === "list" ? value.attempted !== 0 : value.attempted < 1 || value.attempted > 100) return null;
  const complete = value.outcome === "complete";
  const failed = value.outcome === "attempt_failed";
  if (meta.details_complete !== complete || meta.window_complete !== complete ||
      (complete ? meta.pending_detail_count !== 0 : meta.pending_detail_count < 1) ||
      (failed ? value.failed < 1 || run.status !== "failed" : value.failed !== 0 || run.status !== "succeeded")) return null;
  return value;
}

/** A malformed legacy claim remains unknown, including when today's queue is empty. */
function legacyList(run, meta) {
  if (run.source_id !== "lark.im" || !integer(run.id) || run.id < 1 || !identity(run, meta) ||
      !object(meta) || Object.hasOwn(meta, "lark_progress") || meta.detail_retry !== undefined ||
      meta.adapter !== (run.scope_id === "lark.im.sent_by_me" ? "lark.im.sent_by_me" : "lark.im.received_per_chat") ||
      meta.list_complete !== true || meta.details_complete !== false || meta.window_complete !== false ||
      !integer(meta.pending_detail_count) || meta.pending_detail_count < 1 ||
      !integer(meta.list_window_start_ms) || !integer(meta.list_window_end_ms) ||
      meta.list_window_end_ms < meta.list_window_start_ms || meta.list_window_end_ms > 253402300799999 ||
      !integer(meta.__run_fence?.list_generation)) return null;
  const before = cursor(run.cursor_before_json);
  const start = timestamp(run.started_at), end = timestamp(run.finished_at);
  if (!before || start === null || end === null || end < start) return null;
  const anchor = before.initial ? meta.initial_sync_start_ms : before.ms;
  if (!integer(anchor) || anchor > meta.list_window_start_ms) return null;
  return { before, anchor, end, generation: meta.__run_fence.list_generation, identity: identity(run, meta) };
}

function closes(run, meta, prior, chain, cutoff) {
  const proof = metadata(run);
  const started = timestamp(run.started_at), finished = timestamp(run.finished_at);
  if (run.source_id !== prior.source_id || run.scope_id !== prior.scope_id || !integer(run.id) || run.id <= prior.id ||
      run.status !== "succeeded" || !proof || started === null || finished === null ||
      started < chain.end || finished < started || finished > cutoff || identity(run, proof) !== chain.identity ||
      !integer(proof.__run_fence?.list_generation) || proof.__run_fence.list_generation <= chain.generation) return false;
  const generated = stage(run, proof);
  if (Object.hasOwn(proof, "lark_progress") ? generated?.phase !== "details" || generated.outcome !== "complete"
    : proof.adapter !== "lark.im.details" || proof.detail_retry !== true) return false;
  if (proof.coverage_mode !== "list_checkpoint_and_details" || proof.list_complete !== true ||
      proof.details_complete !== true || proof.window_complete !== true || proof.pending_detail_count !== 0 ||
      !integer(proof.pending_detail_count) || !integer(proof.window_start_ms) || !integer(proof.window_end_ms) ||
      timestamp(proof.window_start) !== proof.window_start_ms || timestamp(proof.window_end) !== proof.window_end_ms ||
      proof.window_start_ms !== chain.anchor || proof.window_end_ms < proof.window_start_ms ||
      finished < proof.window_end_ms) return false;
  const before = cursor(run.cursor_before_json), after = cursor(run.cursor_after_json);
  return Boolean(before && before.key === chain.before.key &&
    after && !after.initial && after.ms === Math.floor(proof.window_end_ms / 60000) * 60000 &&
    after.ms >= proof.window_start_ms && after.ms >= Math.floor(meta.list_window_end_ms / 60000) * 60000);
}

/** Only finite public enums leave this helper. Actual detail failures are never transitions. */
function runProgress(run) {
  const meta = metadata(run);
  const generated = stage(run, meta);
  if (generated) return { phase: generated.phase, outcome: generated.outcome, resolution: "not_applicable" };
  if (run.status !== "failed" || run.error_type !== "LarkDetailIncomplete") return {};
  if (meta?.adapter === "lark.im.details" || meta?.detail_retry === true || meta?.lark_progress?.phase === "details") {
    return { phase: "details", outcome: "attempt_failed", resolution: "not_applicable" };
  }
  const chain = legacyList(run, meta);
  const candidates = parse(run.closure_candidates_json);
  const cutoff = run.evidence_cutoff_ms;
  if (!chain || !Array.isArray(candidates) || candidates.length > CLOSURE_LIMIT ||
      candidates.some((value) => !object(value)) || !integer(cutoff) || chain.end > cutoff) {
    return { phase: chain ? "list" : "unknown", outcome: "awaiting_details", resolution: "unknown" };
  }
  return { phase: "list", outcome: "awaiting_details", resolution:
    candidates.some((candidate) => closes(candidate, meta, run, chain, cutoff)) ? "resolved" : "unresolved" };
}

/** SQL fragments are application constants. The correlated evidence stays in the same SELECT snapshot.
 * Count overflows never serialize candidates; complete proofs above the UTF-8
 * byte budget also return NULL, never a truncated array or false zero-debt proof.
 * @param {string} where @param {{limit?: number, cutoffSql?: string}} [options] */
function runEvidenceSql(where, { limit, cutoffSql = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)" } = {}) {
  const budget = `r.id IN (SELECT r.id FROM sync_runs r WHERE (${where}) AND ${LEGACY_TRANSITION_SQL}
    ORDER BY r.id DESC LIMIT ${TRANSITION_LIMIT})`;
  // Preserve the old error projection for raw classification. Proof payloads have
  // a separate row/size budget; excess history stays unknown and actionable.
  const columns = RUN_EVIDENCE_COLUMNS.map((name) => {
    if (name === "metadata_json") return `CASE WHEN r.status!='failed' OR (${budget}) THEN
      CASE WHEN length(r.metadata_json)<=16384 THEN r.metadata_json END
      WHEN r.source_id='lark.im' AND r.error_type='LarkDetailIncomplete' AND NOT (${LEGACY_TRANSITION_SQL})
      THEN '{"adapter":"lark.im.details"}' ELSE NULL END AS metadata_json`;
    if (name === "cursor_before_json" || name === "cursor_after_json") return `CASE
      WHEN r.${name} IS NULL THEN NULL
      WHEN (r.status!='failed' OR (${budget})) AND length(r.${name})<=16384 THEN r.${name}
      ELSE '!unavailable!' END AS ${name}`;
    return `r.${name}`;
  }).join(", ");
  const json = RUN_EVIDENCE_COLUMNS.filter((name) => !["error_type", "error_message", "scanned_count", "inserted_count", "updated_count", "duplicate_count"].includes(name))
    .map((name) => `'${name}', ${["metadata_json", "cursor_before_json", "cursor_after_json"].includes(name)
      ? `CASE WHEN c.${name} IS NULL THEN NULL WHEN length(c.${name})<=16384 THEN c.${name}
          ELSE ${name === "metadata_json" ? "NULL" : "'!unavailable!'"} END` : `c.${name}`}`).join(", ");
  return `SELECT ${columns}, ${cutoffSql} AS evidence_cutoff_ms,
    CASE WHEN ${LEGACY_TRANSITION_SQL} THEN
      CASE WHEN ${budget} THEN (WITH candidates AS MATERIALIZED (
        SELECT c.* FROM sync_runs c WHERE c.source_id=r.source_id AND c.scope_id=r.scope_id
          AND c.id > r.id AND c.status='succeeded' AND julianday(c.started_at) >= julianday(r.finished_at)
          AND julianday(c.finished_at) <= julianday((${cutoffSql}) / 1000.0, 'unixepoch')
          AND CASE WHEN json_valid(c.metadata_json) THEN
            json_extract(c.metadata_json,'$.adapter')='lark.im.details'
            OR json_extract(c.metadata_json,'$.lark_progress.phase')='details' ELSE 0 END
        ORDER BY c.id LIMIT ${CLOSURE_LIMIT + 1}
      ), proof AS MATERIALIZED (
        SELECT json_group_array(json_object(${json})) AS value FROM candidates c
        WHERE (SELECT COUNT(*) FROM candidates) <= ${CLOSURE_LIMIT}
      ) SELECT CASE WHEN (SELECT COUNT(*) FROM candidates) > ${CLOSURE_LIMIT}
          OR length(CAST(value AS BLOB)) > ${CLOSURE_BYTE_LIMIT} THEN NULL ELSE value END FROM proof
      ) ELSE NULL END ELSE '[]' END AS closure_candidates_json
    FROM sync_runs r WHERE ${where} ORDER BY r.id DESC${limit ? ` LIMIT ${limit}` : ""}`;
}

/** @param {Record<string, any>[]} runs */
function transitionCounts(runs) {
  const counts = { resolved: 0, unresolved: 0, unknown: 0 };
  for (const run of runs) {
    const value = runProgress(run).resolution;
    if (value === "resolved" || value === "unresolved" || value === "unknown") counts[value] += 1;
  }
  return counts;
}

export { runEvidenceSql, RUN_EVIDENCE_COLUMNS, runProgress, transitionCounts, TRANSITION_LIMIT, LEGACY_TRANSITION_SQL };
