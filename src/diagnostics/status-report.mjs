// @ts-check
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildServiceStatusReport, readFileTail, DEFAULT_WORKER_LOG_TAIL_BYTES } from "./lark-im-service-report.mjs";
import { sanitizeStatusReportForPublicOutput } from "./sync-status-report.mjs";
import { evaluateActivityEvent } from "./lark-im-activity-evidence.mjs";
import { LABEL, target, readInstalledServiceConfig } from "../runtime/service/launchd.mjs";
import { publicFailureKind, publicTimestamp } from "./public-safe.mjs";

/** @typedef {Record<string, any>} JsonObject */
const choice = (/** @type {unknown} */ value, /** @type {string[]} */ values) => values.includes(String(value)) ? String(value) : "unknown";
const count = (/** @type {unknown} */ value) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;

const WORKER_STEPS = ["sent", "discover-hot", "received-hot", "discover-catchup", "discover-reconcile", "received-fair", "retention", "received-catchup"];
const LEASE_REASONS = ["invalid_timestamp", "invalid_interval", "future_start", "hard_limit_exceeded", "expired"];
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
    observation: { first_event_at: publicTimestamp(stability.observation?.first_event_at), last_event_at: publicTimestamp(stability.observation?.last_event_at),
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

/** @param {JsonObject | undefined} value */
function publicLeases(value) {
  const leases = value || {};
  return { evidence: choice(leases.evidence, ["available", "unavailable"]), observed_at: publicTimestamp(leases.observed_at),
    total: count(leases.total), occupied_count: count(leases.occupied_count), abnormal_count: count(leases.abnormal_count),
    reasons: publicCounts((Array.isArray(leases.reasons) ? leases.reasons : []).filter((row) => LEASE_REASONS.includes(row?.reason)), "reason", String) };
}

/** @param {JsonObject | undefined} value */
function publicWorker(value) {
  const summary = value || {};
  const event = (/** @type {JsonObject | null | undefined} */ item) => item ? { cycle: count(item.cycle), ok: item.ok === true, at: publicTimestamp(item.at), age_ms: count(item.age_ms) } : null;
  return { has_events: summary.has_events === true,
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
      received_unsupported: count(sync.scopes.received_unsupported), unsupported_reasons: sync.scopes.unsupported_reasons },
    hot_discovery: { ran: sync.hot_discovery.ran, cursor_updated_at: sync.hot_discovery.cursor_updated_at },
    reconcile: { complete: sync.reconcile.complete, cursor: sync.reconcile.cursor ? { has_more: sync.reconcile.cursor.has_more === true,
      completed_at: publicTimestamp(sync.reconcile.cursor.completed_at) } : null } };
}

/** Installed configuration is only disk evidence. A current process-bound phase
 * is required before associating a service with the selected database.
 * @param {JsonObject} report @param {number} nowMs */
function serviceTargetEvidence(report, nowMs) {
  const evidence = report.activity_evidence;
  if (!evidence || !evidence.database_identity_stable || evidence.integrity === false || evidence.truncated) return { target_match: "unknown" };
  const worker = evidence.events.find((/** @type {JsonObject} */ event) => event.role === "worker" && event.pid === Number(report.probe.pid));
  if (!worker) return { target_match: "unknown" };
  const phase = evaluateActivityEvent(worker, evidence.processes.get(worker.pid), evidence.database_key, nowMs);
  if (!["waiting", "syncing"].includes(phase.state)) return { target_match: "unknown" };
  return { target_match: "matched", worker, phase };
}

/** Derive complete-cycle evidence from the existing bounded log; no new worker
 * event format or second scheduler is introduced. @param {JsonObject} report @param {JsonObject} binding */
function waitWorkerSummary(report, binding) {
  const summary = { ...report.worker.summary };
  const events = report.worker.log.events;
  let index = events.length - 1;
  while (index >= 0 && events[index].type !== "lark_im_worker_cycle") index--;
  const cycle = events[index];
  const steps = [];
  for (let i = index - 1; i >= 0 && events[i].type !== "lark_im_worker_cycle"; i--) {
    if (events[i].type === "lark_im_worker_step" && events[i].cycle === cycle?.cycle) steps.push(events[i]);
  }
  const starts = steps.map((step) => Date.parse(String(step.started_at || "")));
  const at = Date.parse(String(cycle?.at || ""));
  const complete = binding.target_match === "matched" && binding.phase?.state === "waiting" &&
    binding.worker.cycle === cycle?.cycle && Number.isSafeInteger(cycle?.step_count) && cycle.step_count > 0 &&
    Number.isFinite(at) && at <= Date.parse(String(binding.worker.updated_at || "")) &&
    steps.length === cycle.step_count && steps.every((step, index) => {
      const end = Date.parse(String(step.finished_at || step.at || ""));
      return step.ok === true && Number.isFinite(end) && end >= starts[index] && end <= at;
    }) && starts.every((start) => Number.isFinite(start) && start >= binding.worker.process_started_at_ms && start <= at);
  summary.last_cycle = cycle ? { ...summary.last_cycle, complete, started_at: complete ? new Date(Math.min(...starts)).toISOString() : null } : null;
  summary.in_progress = summary.in_progress || binding.phase?.state === "syncing";
  return summary;
}

/** Internal aggregate. None of this object is serialized directly.
 * @param {JsonObject} options @param {JsonObject} context @param {JsonObject} [deps] */
function collectStatusEvidence(options, context, deps = {}) {
  const serviceDeps = { root: context.root, cwd: context.cwd, env: context.env, ...deps.serviceDeps };
  const installed = (deps.readInstalledServiceConfig || readInstalledServiceConfig)(serviceDeps);
  const report = (deps.buildServiceStatusReport || buildServiceStatusReport)({ label: LABEL, target: target(serviceDeps), db: options.db, logDir: options.logDir },
    { clock: context.now, ...deps.reportDeps, serviceDeps, ...(deps.buildStatus ? { buildStatus: deps.buildStatus } : {}) });
  const observedAt = context.now();
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
    health: { status: choice(overview.health.status, ["ok", "catching_up", "problem"]), local: choice(sync?.health, ["ok", "ok_with_history", "catching_up", "syncing", "not_ready", "needs_attention", "unknown"]) },
    activity: { status: choice(overview.activity.status, ["idle", "syncing", "unknown"]), state: choice(overview.activity.state, ["waiting", "stopped", "syncing", "unknown"]),
      observed_at: publicTimestamp(overview.activity.observed_at), updated_at: publicTimestamp(overview.activity.updated_at), valid_until: publicTimestamp(overview.activity.valid_until) },
    freshness: { status: choice(overview.freshness.status, ["sampled", "unknown", "behind"]), auth_identity: "unknown",
      scope: choice(overview.freshness.scope, ["recent_hot_messages"]), reason: choice(overview.freshness.reason, FRESHNESS_REASONS),
      window: { start: publicTimestamp(overview.freshness.window?.start), end: publicTimestamp(overview.freshness.window?.end) },
      sample_count: count(overview.freshness.sample_count), checked_at: publicTimestamp(overview.freshness.checked_at), expires_at: publicTimestamp(overview.freshness.expires_at) },
    sync: publicSyncSummary(sync),
    stability: publicStability(report.stability), leases: publicLeases(overview.leases),
    worker: publicWorker(report.worker.summary),
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
