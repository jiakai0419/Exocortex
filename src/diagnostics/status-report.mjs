// @ts-check
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildServiceStatusReport, readFileTail, DEFAULT_WORKER_LOG_TAIL_BYTES } from "./lark-im-service-report.mjs";
import { sanitizeStatusReportForPublicOutput } from "./sync-status-report.mjs";
import { compareActivityProcessStarts, evaluateActivityEvent, validateActivityEventShape } from "./lark-im-activity-evidence.mjs";
import { LABEL, target, readInstalledServiceConfig } from "../runtime/service/launchd.mjs";
import { publicFailureKind, publicTimestamp } from "./public-safe.mjs";
import { publicActivity } from "./public-activity.mjs";
import { REQUIRED_CYCLE_STEPS } from "../../dist/runtime/worker/lark-im-worker-core.js";

/** @typedef {Record<string, any>} JsonObject */
const choice = (/** @type {unknown} */ value, /** @type {string[]} */ values) => values.includes(String(value)) ? String(value) : "unknown";
const count = (/** @type {unknown} */ value) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;

const WORKER_STEPS = ["sent", "discover-hot", "received-hot", "discover-catchup", "discover-reconcile", "received-fair", "retention", "received-catchup"];
const LEASE_REASONS = ["invalid_timestamp", "invalid_interval", "future_start", "hard_limit_exceeded", "expired"];
const HEALTH_REASONS = ["service_state_unavailable", "service_stopped", "sync_status_unavailable", "detail_evidence_unavailable",
  "list_progress_unavailable", "initial_sync_unverified", "no_successful_runs", "unfinished_runs_unverified", "last_cycle_failed",
  "details_pending", "scopes_pending", "discovery_pending", "catchup_pending", "local_ready", "activity_observed", "health_unavailable"];
const FRESHNESS_REASONS = ["no_cached_probe", "legacy_evidence", "context_mismatch", "invalid_timestamp", "expired", "no_usable_sample", "inconclusive"];

/** Group only finite public categories; raw step names and errors stay private.
 * @param {unknown} rows @param {string} key @param {(value: unknown) => string} classify */
function publicCounts(rows, key, classify) {
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const amount = count(row?.count);
    if (amount === null || amount === 0) continue;
    const label = classify(row?.[key]);
    grouped.set(label, Math.min(Number.MAX_SAFE_INTEGER, (grouped.get(label) || 0) + amount));
  }
  return [...grouped].map(([label, amount]) => ({ [key]: label, count: amount }))
    .sort((a, b) => b.count - a.count || String(a[key]).localeCompare(String(b[key])));
}

/** @param {JsonObject | undefined} value */
function publicStability(value) {
  const stability = value || {};
  return { window_ms: count(stability.window_ms), window_started_at: publicTimestamp(stability.window_started_at),
    window_ended_at: publicTimestamp(stability.window_ended_at),
    source: choice(stability.source, ["current_worker_log"]), database_binding: "unverified",
    evidence: choice(stability.evidence, ["available", "unavailable"]),
    log_evidence: { exists: typeof stability.log_evidence?.exists === "boolean" ? stability.log_evidence.exists : null,
      integrity: typeof stability.log_evidence?.integrity === "boolean" ? stability.log_evidence.integrity : null,
      truncated: typeof stability.log_evidence?.truncated === "boolean" ? stability.log_evidence.truncated : null },
    observation: { first_event_at: publicTimestamp(stability.observation?.first_event_at), last_event_at: publicTimestamp(stability.observation?.last_event_at),
      current_window_first_event_at: publicTimestamp(stability.observation?.current_window_first_event_at),
      current_window_last_event_at: publicTimestamp(stability.observation?.current_window_last_event_at),
      range_started_at: publicTimestamp(stability.observation?.range_started_at), range_ended_at: publicTimestamp(stability.observation?.range_ended_at),
      window_start_reached: typeof stability.observation?.window_start_reached === "boolean" ? stability.observation.window_start_reached : null,
      tail_truncated: typeof stability.observation?.tail_truncated === "boolean" ? stability.observation.tail_truncated : null },
    observed_events: count(stability.observed_events), cycles: { total: count(stability.cycles?.total), ok: count(stability.cycles?.ok), failed: count(stability.cycles?.failed) },
    last_success: stability.last_success ? { cycle: count(stability.last_success.cycle), at: publicTimestamp(stability.last_success.at), age_ms: count(stability.last_success.age_ms) } : null,
    longest_between_successes_ms: count(stability.longest_between_successes_ms),
    failures: { failed_cycles: count(stability.failures?.failed_cycles), failed_steps: count(stability.failures?.failed_steps),
      by_kind: publicCounts(stability.failures?.by_kind, "kind", publicFailureKind),
      by_step: publicCounts(stability.failures?.by_step, "name", (value) => choice(value, WORKER_STEPS)) } };
}

/** This is independent retained database history, not worker-log coverage.
 * @param {JsonObject | undefined} value */
function publicFailureRuns(value) {
  const failures = value || {};
  const available = failures.evidence === "available" && count(failures.failed_runs) !== null;
  return { source: choice(failures.source, ["retained_sync_runs"]), database_binding: choice(failures.database_binding, ["selected_database"]),
    time_basis: choice(failures.time_basis, ["started_at"]), evidence: available ? "available" : "unavailable",
    window_ms: count(failures.window_ms), window_started_at: publicTimestamp(failures.window_started_at),
    window_ended_at: publicTimestamp(failures.window_ended_at), failed_runs: available ? count(failures.failed_runs) : null,
    by_kind: available ? publicCounts(failures.by_kind, "kind", publicFailureKind) : [] };
}

/** @param {JsonObject | undefined} value */
function publicLeases(value) {
  const leases = value || {};
  return { evidence: choice(leases.evidence, ["available", "unavailable"]), observed_at: publicTimestamp(leases.observed_at),
    total: count(leases.total), occupied_count: count(leases.occupied_count), abnormal_count: count(leases.abnormal_count),
    reasons: publicCounts((Array.isArray(leases.reasons) ? leases.reasons : []).filter((row) => LEASE_REASONS.includes(row?.reason)), "reason", String) };
}

/** @param {JsonObject | undefined} value @param {number} observedAt */
function publicWorker(value, observedAt) {
  const summary = value || {};
  const validTimestamp = (/** @type {unknown} */ value) => {
    const at = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(at) && at <= observedAt;
  };
  const event = (/** @type {JsonObject | null | undefined} */ item) => item ? {
    cycle: count(item.cycle), ok: item.ok === true, at: publicTimestamp(item.at), age_ms: count(item.age_ms),
    timestamp_valid: validTimestamp(item.at), result_valid: item.result_valid !== false,
  } : null;
  return { source: "current_worker_log", database_binding: "unverified", has_events: summary.has_events === true,
    last_event_timestamp_valid: validTimestamp(summary.last_event_at),
    last_event_type: choice(summary.last_event_type, ["lark_im_worker_cycle", "lark_im_worker_step", "lark_im_worker_scheduler"]),
    last_event_at: publicTimestamp(summary.last_event_at), last_event_age_ms: count(summary.last_event_age_ms),
    last_cycle: event(summary.last_cycle), last_step: summary.last_step ? { ...event(summary.last_step), name: choice(summary.last_step.name, WORKER_STEPS) } : null,
    last_failure: summary.last_failure ? { ...event(summary.last_failure), name: choice(summary.last_failure.name, [...WORKER_STEPS, "cycle"]),
      type: choice(summary.last_failure.type, ["lark_im_worker_cycle", "lark_im_worker_step", "lark_im_worker_scheduler"]) } : null,
    in_progress: summary.in_progress === true, unfinished_cycle: summary.unfinished_cycle === true };
}

/** Compact default progress facts come only from the existing safe snapshot
 * projection; --detail separately exposes the full safe report.
 * @param {JsonObject | null} sync */
function publicSyncSummary(sync) {
  if (!sync?.records || !sync?.scopes) return null;
  return { records: { total: count(sync.records.total), by_direction: sync.records.by_direction.map((/** @type {JsonObject} */ row) => ({ direction: row.direction, count: count(row.count) })) },
    scopes: { received_enabled: count(sync.scopes.received_enabled), received_without_cursor: count(sync.scopes.received_without_cursor),
      message_enabled: count(sync.scopes.message_enabled), message_without_success: count(sync.scopes.message_without_success),
      received_unsupported: count(sync.scopes.received_unsupported), unsupported_reasons: sync.scopes.unsupported_reasons },
    discovery: { complete: sync.discovery.complete, cursor: sync.discovery.cursor, cursor_updated_at: sync.discovery.cursor_updated_at },
    details: sync.details, list_progress: sync.list_progress, runs: { by_status: sync.runs.by_status },
    hot_discovery: { ran: sync.hot_discovery.ran, cursor_updated_at: sync.hot_discovery.cursor_updated_at },
    reconcile: { complete: sync.reconcile.complete, cursor: sync.reconcile.cursor ? { has_more: sync.reconcile.cursor.has_more === true,
      completed_at: publicTimestamp(sync.reconcile.cursor.completed_at) } : null } };
}

/** Installed configuration is only disk evidence. A current process-bound phase
 * is required before associating a service with the selected database.
 * @param {JsonObject} report @param {number} nowMs */
function serviceTargetEvidence(report, nowMs) {
  const evidence = report.activity_evidence;
  if (!evidence || evidence.database_identity_stable !== true || evidence.integrity === false || evidence.truncated) return { target_match: "unknown" };
  const serviceEvents = Object.hasOwn(evidence, "service_worker_events") ? evidence.service_worker_events : evidence.events;
  if (!Array.isArray(serviceEvents)) return { target_match: "unknown" };
  const workers = serviceEvents.filter((/** @type {JsonObject} */ event) => event.role === "worker" && event.pid === report.probe.pid)
    // A legal pre-initialization event may lack a database identity. A clearly
    // different OS start still refutes that old process; damaged events cannot.
    .filter((/** @type {JsonObject} */ worker) => !validateActivityEventShape(worker) ||
      compareActivityProcessStarts(worker.process_started_at_ms, evidence.processes.get(worker.pid)?.started_at_ms) !== "different")
    .map((/** @type {JsonObject} */ worker) => ({ worker,
      phase: evaluateActivityEvent(worker, evidence.processes.get(worker.pid), worker.database_key, nowMs) }))
    .filter((/** @type {JsonObject} */ value) => !["dead", "stopped"].includes(value.phase.state));
  if (workers.length !== 1) return { target_match: "unknown" };
  const { worker, phase } = workers[0];
  if (worker.database_key !== evidence.database_key || !["waiting", "syncing"].includes(phase.state)) return { target_match: "unknown" };
  return { target_match: "matched", worker, phase };
}

/** A completion belongs to an explicitly identified worker instance and file.
 * Legacy or damaged records cannot supply missing evidence through adjacency.
 * @param {JsonObject} report @param {JsonObject} binding */
function waitWorkerSummary(report, binding) {
  const summary = { ...report.worker.summary };
  const worker = binding.target_match === "matched" ? binding.worker : null;
  const events = worker ? report.worker.log.events.filter((/** @type {JsonObject} */ event) => event.instance_id === worker.instance_id) : [];
  const cycle = events.findLast((/** @type {JsonObject} */ event) => event.type === "lark_im_worker_cycle");
  const cycleIndex = events.lastIndexOf(cycle);
  const rows = cycle ? events.filter((/** @type {JsonObject} */ event) => event.cycle === cycle.cycle) : [];
  const steps = rows.filter((/** @type {JsonObject} */ event) => event.type === "lark_im_worker_step");
  const timestamp = (/** @type {unknown} */ value) => typeof value === "string" ? Date.parse(value) : NaN;
  const bound = (/** @type {JsonObject} */ event) => event.version === 1 && event.database_key === worker?.database_key &&
    typeof event.database_key === "string" && /^[a-f0-9]{64}$/.test(event.database_key) &&
    event.instance_id === worker?.instance_id && Number.isSafeInteger(event.cycle) && event.cycle > 0;
  const starts = steps.map((/** @type {JsonObject} */ step) => timestamp(step.started_at));
  const ends = steps.map((/** @type {JsonObject} */ step) => timestamp(step.finished_at));
  const at = timestamp(cycle?.at);
  const expectedNames = cycle?.step_count === REQUIRED_CYCLE_STEPS.length + 1 ? [...REQUIRED_CYCLE_STEPS, "retention"] : REQUIRED_CYCLE_STEPS;
  const complete = Boolean(worker && binding.phase?.state === "waiting" && cycle && bound(cycle) && cycle.ok === true &&
    worker.cycle === cycle.cycle && Array.isArray(cycle.failed_steps) && cycle.failed_steps.length === 0 &&
    cycle.step_count === expectedNames.length && steps.length === cycle.step_count &&
    rows.filter((/** @type {JsonObject} */ event) => event.type === "lark_im_worker_cycle").length === 1 &&
    Number.isFinite(at) && at <= timestamp(worker.updated_at) &&
    steps.every((/** @type {JsonObject} */ step, /** @type {number} */ index) => bound(step) &&
      step.step_index === index && step.name === expectedNames[index] && step.ok === true && step.exit_code === 0 &&
      (step.partial === undefined || step.partial === false) &&
      events.indexOf(step) < cycleIndex && Number.isFinite(starts[index]) && starts[index] >= worker.process_started_at_ms &&
      (index === 0 || starts[index] >= ends[index - 1]) && Number.isFinite(ends[index]) && ends[index] >= starts[index] && ends[index] <= at));
  summary.last_cycle = cycle ? { cycle: cycle.cycle, ok: cycle.ok === true, at: Number.isFinite(at) ? new Date(at).toISOString() : null,
    complete, started_at: complete ? new Date(starts[0]).toISOString() : null } : null;
  summary.in_progress = binding.phase?.state === "syncing";
  summary.unfinished_cycle = events.some((/** @type {JsonObject} */ event, /** @type {number} */ index) => event.type === "lark_im_worker_step" && index > cycleIndex);
  return summary;
}

/** Internal aggregate. None of this object is serialized directly.
 * @param {JsonObject} options @param {JsonObject} context @param {JsonObject} [deps] */
function collectStatusEvidence(options, context, deps = {}) {
  const serviceDeps = { root: context.root, cwd: context.cwd, env: context.env, ...deps.serviceDeps };
  const installed = (deps.readInstalledServiceConfig || readInstalledServiceConfig)(serviceDeps);
  const report = (deps.buildServiceStatusReport || buildServiceStatusReport)({ label: LABEL, target: target(serviceDeps), db: options.db, logDir: options.logDir },
    { clock: context.now, ...deps.reportDeps, serviceDeps, ...(deps.buildStatus ? { buildStatus: deps.buildStatus } : {}) });
  const reportObservedAt = Date.parse(String(report.observed_at || ""));
  const observedAt = Number.isFinite(reportObservedAt) ? reportObservedAt : context.now();
  const binding = serviceTargetEvidence(report, observedAt);
  return { report, installed, binding, observedAt, service: { ...report.probe, target_match: binding.target_match }, workerSummary: waitWorkerSummary(report, binding) };
}

/** Public whitelist: raw launchctl, paths, event payloads and cache internals
 * never enter the default result. @param {JsonObject} collected @param {JsonObject} options */
function publicStatusReport(collected, options) {
  const { report, service, installed, observedAt } = collected;
  const overview = report.overview;
  const sync = report.sync.status ? sanitizeStatusReportForPublicOutput(report.sync.status) : null;
  return { schema_version: 1, privacy: options.logs ? "private" : "public-safe", observed_at: new Date(observedAt).toISOString(),
    service: { status: choice(service.status, ["running", "loaded", "absent", "unknown"]), target_match: service.target_match,
      configuration: choice(installed.status, ["installed", "missing", "unknown"]), pid: count(service.pid), last_exit_code: Number.isSafeInteger(service.last_exit_code) ? service.last_exit_code : null },
    health: { status: choice(overview.health.status, ["ok", "catching_up", "problem"]),
      reason: HEALTH_REASONS.includes(overview.health.reason) ? overview.health.reason : "health_unavailable", local: choice(sync?.health, ["ok", "ok_with_history", "catching_up", "syncing", "not_ready", "needs_attention", "unknown"]) },
    activity: publicActivity(overview.activity),
    freshness: { status: choice(overview.freshness.status, ["sampled", "unknown", "behind"]), auth_identity: "unknown",
      scope: choice(overview.freshness.scope, ["recent_hot_messages"]), reason: choice(overview.freshness.reason, FRESHNESS_REASONS),
      window: { start: publicTimestamp(overview.freshness.window?.start), end: publicTimestamp(overview.freshness.window?.end) },
      sample_count: count(overview.freshness.sample_count), checked_at: publicTimestamp(overview.freshness.checked_at), expires_at: publicTimestamp(overview.freshness.expires_at) },
    sync: publicSyncSummary(sync),
    stability: publicStability(report.stability), failure_runs: publicFailureRuns(report.failure_runs), leases: publicLeases(overview.leases),
    worker: publicWorker(report.worker.summary, observedAt),
    ...(options.detail ? { detail: sync } : {}) };
}

/** @param {JsonObject} options @param {JsonObject} [deps] */
function readPrivateLogs(options, deps = {}) {
  const read = deps.readFileTail || readFileTail;
  const lines = options.lines ?? 20;
  if (!Number.isSafeInteger(lines) || lines < 1) throw new Error("--lines must be a positive integer");
  return ["worker.jsonl", "launchd.err.log"].map((name) => {
    const path = resolve(options.logDir, name);
    const text = (deps.existsSync || existsSync)(path) ? read(path, DEFAULT_WORKER_LOG_TAIL_BYTES) : "";
    return { name, lines: text.split("\n").filter(Boolean).slice(-lines) };
  });
}

export { collectStatusEvidence, publicStatusReport, readPrivateLogs, serviceTargetEvidence, waitWorkerSummary };
