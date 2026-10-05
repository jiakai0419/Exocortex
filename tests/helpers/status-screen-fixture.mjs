// Invented whole-screen examples. No operational data or captured reports are used.
import { publicStatusReport } from "../../src/diagnostics/status-report.mjs";
import { summarizeWorkerStability } from "../../src/diagnostics/lark-im-service-report.mjs";
import { REQUIRED_CYCLE_STEPS } from "../../dist/runtime/worker/lark-im-worker-core.js";

export const STATUS_SCREEN_NOW = Date.parse("2032-02-04T12:00:00.000Z");
export const STATUS_SCREEN_PRIVATE = "INVENTED_PRIVATE_STATUS_MARKER";
const HOUR = 3_600_000;
const RUNTIME_DATABASE = "a".repeat(64);
const RUNTIME_INSTANCE = "invented-screen-worker";
const iso = (offset = 0) => new Date(STATUS_SCREEN_NOW + offset).toISOString();
const cycle = (offset, number, ok = true) => ({ type: "lark_im_worker_cycle", cycle: number, ok, at: iso(offset) });
const summaryEvent = (offset, number, ok = true) => ({ cycle: number, ok, at: iso(offset), age_ms: -offset });
const noActivity = (reason) => ({ status: "unknown", state: "unknown", phase: "unknown", source: "unknown", evidence: "unavailable", reason });
const unavailableFreshness = (reason) => ({ status: "unknown", reason, auth_identity: "unknown" });

export const STATUS_SCREEN_SCENARIOS = Object.freeze([
  "healthy", "syncing", "catching_up", "empty", "stopped", "failed", "old_history",
  "unavailable", "legacy", "truncated", "sampled", "behind", "expired", "invalid_history",
  "foreground_stopped", "expired_phase", "old_instance_history", "unbound_failure",
]);

export function rawStatusScreenFixture(name = "healthy") {
  if (!STATUS_SCREEN_SCENARIOS.includes(name)) throw new Error(`Unknown synthetic status scenario: ${name}`);
  const events = [cycle(-2 * HOUR, 1), cycle(-125_000, 2), cycle(-80_000, 3), cycle(-35_000, 4)];
  const stability = summarizeWorkerStability(events, STATUS_SCREEN_NOW, 24 * HOUR, { truncated: false });
  Object.assign(stability, { source: "current_worker_log", database_binding: "unverified", evidence: "available",
    window_ended_at: iso(), log_evidence: { exists: true, integrity: true, truncated: false } });
  Object.assign(stability.observation, { current_window_first_event_at: iso(-2 * HOUR), current_window_last_event_at: iso(-35_000) });
  const report = {
    probe: { status: "running", loaded: true, pid: 43100, last_exit_code: 0 },
    overview: {
      health: { status: "ok", reason: "local_ready", detail: STATUS_SCREEN_PRIVATE },
      activity: { status: "idle", state: "waiting", phase: "waiting", source: "worker", evidence: "verified_worker_phase",
        reason: "worker_waiting", observed_at: iso(), updated_at: iso(-10_000), valid_until: iso(20_000) },
      freshness: unavailableFreshness("no_cached_probe"),
      leases: { evidence: "available", observed_at: iso(), total: 0, occupied_count: 0, abnormal_count: 0, reasons: [] },
    },
    sync: { status: {
      health: "ok", db_path: STATUS_SCREEN_PRIVATE, health_detail: STATUS_SCREEN_PRIVATE,
      records: { total: 293, latest_ms: STATUS_SCREEN_NOW - 50_000,
        by_direction: [{ direction: "sent", count: 54 }, { direction: "received", count: 232 }, { direction: "unknown", count: 7 }] },
      scopes: { total: 18, enabled: 18, received_enabled: 14, received_without_cursor: 0,
        message_enabled: 15, message_without_success: 0, received_unsupported: 0, unsupported_reasons: [] },
      discovery: { complete: true, cursor: { has_more: false, pages_scanned: 4, completed_at: iso(-3 * HOUR), token: STATUS_SCREEN_PRIVATE }, cursor_updated_at: iso(-3 * HOUR) },
      hot_discovery: { ran: true, cursor_updated_at: iso(-45_000), cursor: { pages_scanned: 1 } },
      reconcile: { complete: true, cursor: { has_more: false, pages_scanned: 4, completed_at: iso(-15 * 60_000) }, cursor_updated_at: iso(-15 * 60_000) },
      details: { evidence: "available", pending_count: 0, due_count: 0, scopes_pending: 0, oldest_pending_ms: null, next_retry_at: null },
      list_progress: { evidence: "available", scopes: 15, oldest_cursor_ms: STATUS_SCREEN_NOW - 10 * 60_000, invalid_cursor_scopes: 0 },
      runs: { by_status: { succeeded: 26 }, recent: [] }, locks: [],
    } },
    worker: { log: { events, exists: true, path: STATUS_SCREEN_PRIVATE }, summary: {
      has_events: true, last_event_type: "lark_im_worker_cycle", last_event_at: iso(-35_000), last_event_age_ms: 35_000,
      last_cycle: summaryEvent(-35_000, 4), last_step: { ...summaryEvent(-36_000, 4), name: "received-fair" },
      last_failure: null, in_progress: false, unfinished_cycle: false,
    } },
    stability,
    failure_runs: { source: "retained_sync_runs", database_binding: "selected_database", time_basis: "started_at",
      evidence: "available", window_ms: 24 * HOUR, window_started_at: iso(-24 * HOUR), window_ended_at: iso(), failed_runs: 0, by_kind: [] },
    launchd: { stderr: STATUS_SCREEN_PRIVATE, stdout: STATUS_SCREEN_PRIVATE },
    freshness: { cache_path: STATUS_SCREEN_PRIVATE },
  };
  const sync = report.sync.status;
  const activity = report.overview.activity;
  const worker = report.worker.summary;

  if (["syncing", "catching_up"].includes(name)) {
    Object.assign(activity, { status: "syncing", state: "syncing", phase: "step", step: "discover-reconcile", reason: "worker_phase_observed" });
    worker.unfinished_cycle = true;
  }
  if (name === "unbound_failure") {
    worker.last_cycle = summaryEvent(-35_000, 4, false);
    worker.last_failure = { ...summaryEvent(-36_000, 4, false), type: "lark_im_worker_step", name: "received-hot" };
    Object.assign(stability.cycles, { ok: 3, failed: 1 });
    Object.assign(stability.failures, { failed_cycles: 1, failed_steps: 1, by_step: [{ name: "received-hot", count: 1 }] });
    stability.last_success = summaryEvent(-80_000, 3);
  }
  if (name === "catching_up") {
    Object.assign(sync, { health: "catching_up" });
    Object.assign(report.overview.health, { status: "catching_up", reason: "details_pending" });
    Object.assign(activity, { step: "received-fair" });
    Object.assign(sync.scopes, { received_without_cursor: 9, message_without_success: 9 });
    Object.assign(sync.discovery, { complete: false, cursor: { has_more: true, pages_scanned: 2 }, cursor_updated_at: iso(-HOUR) });
    Object.assign(sync.details, { pending_count: 6, due_count: 2, scopes_pending: 3, oldest_pending_ms: STATUS_SCREEN_NOW - 2 * HOUR, next_retry_at: iso(5 * 60_000) });
    Object.assign(sync.scopes, { received_unsupported: 5, unsupported_reasons: [
      { reason: "restricted_mode", lark_cli_error_code: 71101, count: 3, lark_cli_error_message: STATUS_SCREEN_PRIVATE },
      { reason: "bot_user_out_of_chat", lark_cli_error_code: 71102, count: 2 },
    ] });
  }
  if (name === "empty") {
    sync.health = "not_ready";
    Object.assign(report.overview.health, { status: "problem", reason: "initial_sync_unverified" });
    sync.records = { total: 0, latest_ms: null, by_direction: [] };
    Object.assign(sync.scopes, { total: 4, enabled: 4, received_enabled: 0, message_enabled: 1, message_without_success: 1 });
    sync.discovery = { complete: false, cursor: null, cursor_updated_at: null };
    sync.hot_discovery = { ran: false, cursor: null, cursor_updated_at: null };
    sync.reconcile = { complete: false, cursor: null, cursor_updated_at: null };
    sync.list_progress = { evidence: "available", scopes: 0, oldest_cursor_ms: null, invalid_cursor_scopes: 0 };
    sync.runs = { by_status: {}, recent: [] };
    report.overview.activity = noActivity("worker_phase_unavailable");
  }
  if (["stopped", "foreground_stopped"].includes(name)) {
    Object.assign(report.probe, { status: "absent", loaded: false, pid: null });
    Object.assign(report.overview.health, { status: "problem", reason: "service_stopped" });
    report.overview.activity = { status: "idle", state: "stopped", phase: "stopped", source: "none", evidence: "no_current_process_observed", reason: "no_current_sync_observed" };
  }
  if (name === "foreground_stopped") {
    report.overview.activity = { status: "syncing", state: "syncing", phase: "sync", source: "foreground", evidence: "recent_foreground_phase",
      reason: "foreground_sync_observed", observed_at: iso(), updated_at: iso(-1000), valid_until: iso(5000) };
  }
  if (name === "expired_phase") {
    report.overview.activity = { ...noActivity("current_phase_unavailable"), updated_at: iso(-10_000), valid_until: iso(-1000) };
  }
  if (name === "old_instance_history") {
    Object.assign(worker, { unfinished_cycle: true, last_step: { ...summaryEvent(-HOUR, 93), name: "received-catchup" } });
  }
  if (name === "failed") {
    Object.assign(report.overview.health, { status: "problem", reason: "no_successful_runs" });
    sync.health = "needs_attention";
    sync.runs.by_status = { failed: 15 };
    worker.last_cycle = summaryEvent(-35_000, 4, false);
    worker.last_step = { ...summaryEvent(-36_000, 4, false), name: "received-hot" };
    worker.last_failure = { ...worker.last_step, type: "lark_im_worker_step" };
    Object.assign(stability.cycles, { ok: 3, failed: 1 });
    stability.last_success = summaryEvent(-80_000, 3);
    Object.assign(stability.failures, { failed_cycles: 1, failed_steps: 1, by_step: [{ name: "received-hot", count: 1 }] });
    Object.assign(report.failure_runs, { failed_runs: 15, by_kind: [
      { kind: "permission_denied", count: 5 }, { kind: "network_timeout", count: 4 },
      { kind: "rate_limited", count: 3 }, { kind: "service_unavailable", count: 2 }, { kind: "unknown", count: 1 },
    ] });
    stability.failures.by_kind = report.failure_runs.by_kind;
    Object.assign(report.overview.leases, { total: 2, occupied_count: 1, abnormal_count: 2,
      reasons: [{ reason: "expired", count: 1 }, { reason: "future_start", count: 1 }], owner: STATUS_SCREEN_PRIVATE });
  }
  if (name === "old_history") {
    Object.assign(worker, { last_event_at: iso(-48 * HOUR), last_event_age_ms: 48 * HOUR,
      last_cycle: summaryEvent(-48 * HOUR, 9), last_step: { ...summaryEvent(-48 * HOUR - 1000, 9), name: "discover-reconcile" },
      unfinished_cycle: true });
    Object.assign(stability, summarizeWorkerStability([cycle(-48 * HOUR, 9)], STATUS_SCREEN_NOW, 24 * HOUR, { truncated: false }));
    Object.assign(stability.observation, { current_window_first_event_at: null, current_window_last_event_at: null });
    report.overview.activity = noActivity("worker_phase_unavailable");
  }
  if (["empty", "unavailable"].includes(name)) {
    Object.assign(worker, { has_events: false, last_event_type: null, last_event_at: null, last_event_age_ms: null,
      last_cycle: null, last_step: null, last_failure: null, unfinished_cycle: false });
    Object.assign(stability, summarizeWorkerStability([], STATUS_SCREEN_NOW, 24 * HOUR, { truncated: false }));
    Object.assign(stability.observation, { current_window_first_event_at: null, current_window_last_event_at: null });
  }
  if (name === "unavailable") {
    report.sync.status = null;
    Object.assign(report.probe, { status: "unknown", loaded: null, pid: null });
    Object.assign(report.overview.health, { status: "problem", reason: "service_state_unavailable" });
    report.overview.activity = noActivity("sync_status_unavailable");
    Object.assign(stability, { evidence: "unavailable", log_evidence: { exists: false, integrity: null, truncated: null } });
    Object.assign(report.failure_runs, { evidence: "unavailable", failed_runs: null, by_kind: [] });
    report.overview.leases = { evidence: "unavailable" };
  }
  if (name === "legacy") {
    sync.details = { evidence: "legacy_unavailable" };
    sync.list_progress = { evidence: "legacy_unavailable" };
    report.overview.activity = noActivity("phase_evidence_incomplete");
    report.overview.freshness = unavailableFreshness("legacy_evidence");
  }
  if (name === "truncated") {
    stability.observation.tail_truncated = true;
    Object.assign(stability.log_evidence, { truncated: true, integrity: false });
    report.overview.activity = noActivity("phase_evidence_incomplete");
  }
  if (["sampled", "behind"].includes(name)) {
    report.overview.freshness = { status: name, reason: "unknown", auth_identity: "unknown", scope: "recent_hot_messages",
      sample_count: 11, window: { start: iso(-10 * 60_000), end: iso(-60_000) }, checked_at: iso(-30_000), expires_at: iso(4 * 60_000) };
  }
  if (name === "expired") report.overview.freshness = unavailableFreshness("expired");
  if (name === "invalid_history") {
    worker.last_cycle = { cycle: 5, ok: true, at: iso(HOUR), age_ms: 0 };
    worker.last_step = { cycle: 5, ok: true, name: "sent", at: "synthetic-invalid-time", age_ms: 0 };
    worker.last_event_at = iso(HOUR);
    worker.last_event_age_ms = 0;
    report.overview.activity = noActivity("current_phase_unavailable");
  }
  // Bound runtime evidence is independently invented. Existing history summaries
  // above stay unchanged so adding the four statistics cannot alter prior rows.
  const identity = { version: 1, database_key: RUNTIME_DATABASE, instance_id: RUNTIME_INSTANCE };
  report.worker.log.events = events.map((event) => ({ ...event, ...identity,
    step_count: REQUIRED_CYCLE_STEPS.length, failed_steps: [],
  }));
  const last = report.worker.log.events.at(-1);
  if (last) {
    if (name === "failed") Object.assign(last, { ok: false, failed_steps: ["received-hot"] });
    const steps = REQUIRED_CYCLE_STEPS.map((stepName, stepIndex) => ({ ...identity,
      type: "lark_im_worker_step", cycle: last.cycle, step_index: stepIndex, name: stepName,
      ok: !(name === "failed" && stepName === "received-hot"),
      exit_code: name === "failed" && stepName === "received-hot" ? 1 : 0,
      started_at: iso(-47_000 + stepIndex * 2_000), finished_at: iso(-45_000 + stepIndex * 2_000),
    }));
    report.worker.log.events.splice(-1, 0, ...steps);
  }
  if (["empty", "unavailable"].includes(name)) report.worker.log.events = [];
  if (name === "unavailable") report.worker.log.exists = false;
  if (name === "truncated") Object.assign(report.worker.log, { truncated: true, activity_integrity: false });
  if (name === "unbound_failure") report.worker.log.events.forEach((event) => { event.database_key = "b".repeat(64); });
  return report;
}

export function statusScreenFixture(name = "healthy", { detail = false } = {}) {
  const report = rawStatusScreenFixture(name);
  const targetMatch = ["running", "loaded"].includes(report.probe.status) && !["old_history", "legacy", "truncated", "invalid_history", "empty", "expired_phase"].includes(name) ? "matched" : "unknown";
  const activity = report.overview.activity;
  const binding = { target_match: targetMatch, phase: { state: activity.state }, worker: {
    type: "lark_im_worker_activity", version: 1, role: "worker", instance_id: RUNTIME_INSTANCE,
    database_key: RUNTIME_DATABASE, parent_instance: null, pid: report.probe.pid, process_started_at_ms: STATUS_SCREEN_NOW - 3 * HOUR,
    phase: activity.phase, cycle: activity.state === "syncing" ? 5 : 4,
    step: activity.step || null, updated_at: iso(-10_000), valid_until: iso(20_000),
  } };
  report.activity_evidence = { database_identity_stable: true, integrity: true, database_key: RUNTIME_DATABASE,
    processes: new Map([[report.probe.pid, { state: "alive", started_at_ms: binding.worker.process_started_at_ms }]]),
  };
  return publicStatusReport({ report, observedAt: STATUS_SCREEN_NOW,
    binding, service: { ...report.probe, target_match: targetMatch },
    installed: { status: "installed", config: { db: STATUS_SCREEN_PRIVATE }, xml: STATUS_SCREEN_PRIVATE },
  }, { detail });
}
