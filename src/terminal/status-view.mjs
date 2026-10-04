// @ts-check
import { serviceTimeRange, serviceTimestamp, durationText, formatStabilityInterval, formatLeaseIssues } from "./lark-im-service-view.mjs";
import { statusLayout } from "./status-layout.mjs";
import { formatLogLine } from "./status-log-view.mjs";

/** @typedef {Record<string, any>} Report */
const TASKS = Object.freeze({ sent: "Sent messages", "discover-hot": "Active conversation refresh", "received-hot": "Active conversation messages",
  "discover-catchup": "Initial conversation discovery", "discover-reconcile": "Conversation list review", "received-fair": "Other conversation messages",
  "received-catchup": "Conversation history", retention: "History cleanup", all: "Message synchronization", discover: "Conversation discovery",
  received: "Received messages", details: "Message details", cycle: "Background round" });
const ACTIVITY = Object.freeze({ activity_evidence_unavailable: "current work evidence is unavailable", sync_status_unavailable: "database status is unavailable",
  database_identity_unavailable: "database identity changed or could not be verified", phase_evidence_incomplete: "current activity records are incomplete",
  worker_child_conflict: "background service and task observations disagree", worker_parent_unverified: "task has no verified background service phase",
  foreground_parent_unavailable: "foreground process relationship could not be verified", current_phase_unavailable: "current phase or process identity could not be verified",
  owner_evidence_unavailable: "a sync reservation has no verified process state", worker_phase_unavailable: "no current background phase could be verified",
  service_state_unavailable: "background service state could not be checked" });
const HEALTH = Object.freeze({ service_state_unavailable: "background service state could not be checked", service_stopped: "background service is stopped",
  sync_status_unavailable: "database status could not be read", detail_evidence_unavailable: "message detail evidence is unavailable",
  list_progress_unavailable: "message list progress could not be verified", initial_sync_unverified: "initial discovery or successful sync evidence is missing",
  no_successful_runs: "failed syncs recorded without a successful sync", unfinished_runs_unverified: "unfinished sync records have no verified current work",
  last_cycle_failed: "latest logged background round failed", details_pending: "message details remain to be retrieved", scopes_pending: "conversation history remains to be retrieved",
  discovery_pending: "initial conversation discovery is incomplete", local_ready: "local service and database checks passed", activity_observed: "local sync work is verified",
  catchup_pending: "local catch-up work remains", health_unavailable: "local health evidence could not be established" });
const FRESHNESS = Object.freeze({ no_cached_probe: "no cached remote sample", legacy_evidence: "cached sample lacks database binding",
  context_mismatch: "cached sample belongs to a different database or source", invalid_timestamp: "cached sample has invalid times", expired: "cached sample expired",
  no_usable_sample: "cached sample has no usable messages or time window", inconclusive: "cached sample did not establish freshness" });
const FAILURE = Object.freeze({ command_unavailable: "Required command unavailable", internal_error: "Internal error", network_error: "Network error", network_timeout: "Network timeout", service_unavailable: "Service unavailable", spawn_error: "Could not start sync command", permission_denied: "Permission denied", rate_limited: "Rate limited", timeout: "Timed out", transient: "Temporary service error",
  authentication: "Authentication failed", auth: "Authentication failed", invalid_request: "Invalid request", unavailable: "Service unavailable", unknown: "Unclassified failure" });
/** @param {unknown} value */
const number = (value) => Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : "unavailable";
/** @param {unknown} name */
const task = (name) => Object.hasOwn(TASKS, String(name)) ? TASKS[String(name)] : "Unclassified task";
/** @param {unknown} kind */
const failure = (kind) => Object.hasOwn(FAILURE, String(kind)) ? FAILURE[String(kind)] : "Unclassified failure";
/** @param {unknown} value */
const validTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
/** @param {number} ms */
const lookback = (ms) => Number.isFinite(ms) && ms > 0 && Number.isInteger(ms / 3600000) ? `${ms / 3600000}h` : durationText(ms);
/** @param {unknown} state */
const evidenceText = (state) => state === "legacy_unavailable" ? "Unavailable in this database version" : "Evidence unavailable";

/** Render only the public status projection; no raw service reports or remote calls.
 * @param {Report} report @param {{columns?: number, stream?: any}} [options] */
export function renderStatusText(report, options = {}) {
  const screen = statusLayout(options);
  const at = Date.parse(report.observed_at);
  const stamp = (value) => validTime(value) ? serviceTimestamp(value, at) : "time unavailable";
  const age = (value) => !validTime(value) || Date.parse(value) > at ? "time unverified" : `${durationText(at - Date.parse(value))} ago`;
  const timed = (value) => `${stamp(value)} (${age(value)})`;
  const range = (start, end) => validTime(start) && validTime(end) && Date.parse(end) >= Date.parse(start)
    ? serviceTimeRange(start, end, at, Date.parse(end) - Date.parse(start) < 60000) : "range unavailable";
  const detailed = report.detail !== undefined;
  const stampMs = (value) => Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? stamp(new Date(value).toISOString()) : "time unavailable";
  const health = report.health || {};
  const activity = report.activity || {};
  const service = report.service || {};
  const sync = report.sync;
  const stability = report.stability || {};
  const worker = report.worker || {};
  const freshness = report.freshness || {};
  const leases = report.leases || {};
  const failureRuns = report.failure_runs || {};
  const placed = (event) => event && event.timestamp_valid !== false && validTime(event.at) && Date.parse(event.at) <= at;
  const progress = sync?.list_progress || {};
  const details = sync?.details || {};
  const countValid = (value) => Number.isSafeInteger(value) && value >= 0;

  screen.title("Exocortex status");
  screen.text(`Observed ${stamp(report.observed_at)} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  screen.heading("Health & current work");
  const healthLabel = { ok: "OK", catching_up: "CATCHING UP", problem: "NEEDS ATTENTION" }[health.status] || "UNCONFIRMED";
  const healthReason = HEALTH[health.reason] || "local health evidence could not be established";
  screen.row("Local health", `${healthLabel}${health.status === "ok" && !detailed ? "" : ` · ${healthReason}`}`, health.status === "ok" ? "green" : "yellow");
  const serviceLabel = { running: "Running", loaded: "Loaded · running process not verified", absent: "Stopped (service not loaded)" }[service.status] || "Could not check service state";
  const association = service.status === "running" ? service.target_match === "matched"
    ? detailed ? " · selected database verified" : "" : " · cannot confirm it serves this database" : "";
  screen.row("Background", `${serviceLabel}${association}`);
  let work = `Unconfirmed · ${ACTIVITY[activity.reason] || ACTIVITY.activity_evidence_unavailable}`;
  if (activity.state === "syncing") work = activity.source === "foreground" ? "Syncing · foreground command"
    : `Syncing · ${activity.step ? task(activity.step).toLowerCase() : activity.phase === "between_steps" ? "moving between background tasks" : "background round"}`;
  if (activity.state === "waiting") work = "Waiting · between background rounds";
  if (activity.state === "stopped") work = "Stopped · no current local sync process observed";
  screen.row("Current work", work, activity.state === "unknown" ? "yellow" : activity.state === "syncing" ? "cyan" : "");
  if (detailed && ["syncing", "waiting"].includes(activity.state)) screen.row("Phase observed", `${stamp(activity.updated_at)} · evidence valid until ${stamp(activity.valid_until)}`);

  screen.heading("Messages & progress");
  if (!sync) {
    screen.row("Local database", "Could not read message counts or sync progress");
  } else {
    const scopes = sync.scopes || {};
    const records = sync.records || {};
    const directions = Object.fromEntries((records.by_direction || []).map((row) => [row.direction, row.count]));
    screen.row("Stored messages", `${number(records.total)} total · ${number(Object.hasOwn(directions, "sent") ? directions.sent : 0)} sent · ${number(Object.hasOwn(directions, "received") ? directions.received : 0)} received${directions.unknown > 0 ? ` · ${number(directions.unknown)} unclassified` : ""}`);
    screen.row("Received chats", `${number(scopes.received_enabled)} enabled${scopes.received_without_cursor > 0 ? ` · ${number(scopes.received_without_cursor)} with no content checkpoint` : ""}`);
    const discovery = sync.discovery || {};
    if (detailed || !discovery.complete) screen.row("Conversation list", discovery.complete ? `Initial discovery complete · ${stamp(discovery.cursor?.completed_at)}`
      : discovery.cursor?.has_more ? "Initial discovery has more pages to retrieve" : "Initial discovery not yet established");
    if (detailed || scopes.message_without_success > 0) screen.row("Message sources", `${number(scopes.message_enabled)} enabled · ${number(scopes.message_without_success)} without a successful sync`);
    if (progress.evidence !== "available") screen.row("Message lists", evidenceText(progress.evidence));
    else if (progress.invalid_cursor_scopes > 0) screen.row("Message lists", `${number(progress.invalid_cursor_scopes)} invalid list checkpoints`);
    screen.row("Message details", details.evidence === "available" ? `${number(details.pending_count)} pending${details.pending_count > 0 || detailed ? ` · ${number(details.due_count)} due for retry · ${number(details.scopes_pending)} sources` : ""}` : evidenceText(details.evidence));
    const reasons = scopes.unsupported_reasons || [];
    const reasonText = (row) => row.reason === "restricted_mode" ? "access restricted" : row.reason === "bot_user_out_of_chat" ? "not a conversation member" : "unclassified restriction";
    if (detailed || scopes.received_unsupported > 0) screen.row("Restricted chats", `${number(scopes.received_unsupported)} excluded${!detailed && reasons.length ? ` · ${reasons.map((row) => `${number(row.count)} ${reasonText(row)}`).join(" · ")}` : ""}`);
    if (detailed) for (const reason of reasons) screen.row("Restriction", `${number(reason.count)} · ${reasonText(reason)}${reason.error_code == null ? "" : ` · code ${reason.error_code}`}`);
    if (detailed) screen.row("Active chat refresh", sync.hot_discovery?.ran ? `Last success ${stamp(sync.hot_discovery.cursor_updated_at)}` : "No successful refresh recorded");
    if (detailed || discovery.complete && !sync.reconcile?.complete) screen.row("Chat list review", sync.reconcile?.complete ? `Complete · ${stamp(sync.reconcile.cursor?.completed_at)}`
      : sync.reconcile?.cursor?.has_more ? "More conversation pages remain to be reviewed" : "No completed review recorded");
  }
  if (freshness.status === "sampled" || freshness.status === "behind") {
    screen.row("Remote sample", `${freshness.status === "sampled" ? "Sample matched" : "Sample has missing messages"} · ${number(freshness.sample_count)} messages · checked ${stamp(freshness.checked_at)}`);
    if (detailed) {
      screen.row("Sample window", range(freshness.window?.start, freshness.window?.end));
      screen.row("Sample checked", `${stamp(freshness.checked_at)} · expires ${stamp(freshness.expires_at)}`);
      screen.row("Sample limits", "Recent active-chat sample only; current remote account identity is unverified");
    }
  } else screen.row("Remote sample", `Not verified · ${FRESHNESS[freshness.reason] || "sample evidence unavailable"}`);

  /** @type {Array<[string, string]>} */ const problems = [];
  if (leases.evidence === "available" && leases.abnormal_count > 0) problems.push(["Sync reservations", formatLeaseIssues(leases)]);
  if (leases.evidence !== "available") problems.push(["Sync reservations", "Reservation evidence unavailable"]);
  if (failureRuns.evidence !== "available" || !countValid(failureRuns.failed_runs)) problems.push(["Database failures", "Failed-run query unavailable; count is not known"]);
  else if (failureRuns.failed_runs > 0) {
    problems.push(["Database failures", `${number(failureRuns.failed_runs)} retained failed runs · started in last ${lookback(failureRuns.window_ms)}`]);
    problems.push(["Failure window", range(failureRuns.window_started_at, failureRuns.window_ended_at)]);
    for (const row of failureRuns.by_kind || []) problems.push(["Failure category", `${failure(row.kind)} · ${number(row.count)}`]);
  }
  if (problems.length) {
    screen.heading("Problems");
    for (const [label, value] of problems) screen.row(label, value);
  }

  if (detailed) {
    screen.heading("Background history");
    screen.row("History source", "Retained worker log; database association is not verified");
    screen.row("Worker window", `${lookback(stability.window_ms)} lookback · ${range(stability.window_started_at, stability.window_ended_at || report.observed_at)}`);
    const observation = stability.observation || {};
    const first = observation.current_window_first_event_at;
    const last = observation.current_window_last_event_at;
    const observedEvents = countValid(stability.observed_events) ? stability.observed_events : null;
    screen.row("Log coverage", stability.log_evidence?.exists === false ? "No worker log available" : observedEvents === null ? "Log observation evidence unavailable" : observedEvents === 0 ? "No events observed in this window"
      : `${observation.window_start_reached === true ? "Lookback boundary reached" : "Partial window; earlier observations unavailable"}${observation.tail_truncated ? " · log truncated" : ""}`);
    if (observedEvents > 0) screen.row("Observed events", validTime(first) && validTime(last) ? range(first, last)
      : `${range(observation.range_started_at, observation.range_ended_at)} · retained observation range`);
    if (stability.log_evidence?.integrity === false) screen.row("Log integrity", "Incomplete or malformed records; statistics include usable events only");
    screen.row("Completed rounds", [stability.cycles?.ok, stability.cycles?.failed, stability.cycles?.total].some((value) => number(value) === "unavailable") ? "Round counts unavailable" : `${number(stability.cycles?.ok)} succeeded · ${number(stability.cycles?.failed)} failed · ${number(stability.cycles?.total)} total${stability.cycles.total > stability.cycles.ok + stability.cycles.failed ? ` · ${stability.cycles.total - stability.cycles.ok - stability.cycles.failed} unclassified result` : ""}${observedEvents === 0 ? " observed" : ""}`);
    const resultText = (event) => event.result_valid === false ? `Recorded result could not be classified · ${timed(event.at)}` : placed(event) ? `${event.ok ? "Succeeded" : "Failed"} · ${timed(event.at)}` : "Recorded result has an unverified time; cannot place it in history";
    screen.row(placed(worker.last_cycle) && worker.last_cycle?.result_valid !== false && worker.last_cycle?.ok ? "Latest success" : "Latest round", worker.last_cycle ? resultText(worker.last_cycle) : "No round completion recorded in retained log");
    if (worker.last_step && (!placed(worker.last_step) || !placed(worker.last_cycle) || Date.parse(worker.last_step.at) > Date.parse(worker.last_cycle.at))) screen.row("Latest task", `${task(worker.last_step.name)} · ${resultText(worker.last_step)}`);
    if (stability.last_success && (!placed(worker.last_cycle) || worker.last_cycle?.ok === false || stability.last_success.at !== worker.last_cycle?.at)) screen.row("Latest success", `${timed(stability.last_success.at)} · in log window`);
    screen.row("Success spacing", Number(stability.cycles?.ok) >= 2 ? `Longest observed interval ${formatStabilityInterval(stability)}` : "Unavailable; need two successful rounds in the window");
    screen.row("Failed tasks", observedEvents === null ? "Log failure evidence unavailable" : observedEvents === 0 ? "No task evidence in the log window" : `${number(stability.failures?.failed_steps)} in the log window`);
    for (const row of stability.failures?.by_step || []) screen.row("Failed task", `${task(row.name)} · ${number(row.count)}`);
    if (worker.last_failure && (worker.last_failure.at !== worker.last_cycle?.at || worker.last_cycle?.ok !== false)) screen.row("Last logged failure", placed(worker.last_failure) ? `${task(worker.last_failure.name)} · ${timed(worker.last_failure.at)}` : "Failure record has an unverified time; cannot place it in history");
    if (worker.unfinished_cycle || worker.in_progress) screen.row("Open history", "A round has task records but no completion record; see Current work for activity.");

    screen.heading("Diagnostics");
    screen.row("Service config", { installed: "Installed", missing: "Not installed" }[service.configuration] || "Could not inspect installed configuration");
    if (service.last_exit_code !== null && service.last_exit_code !== undefined) screen.row("Service last exit", String(service.last_exit_code));
    screen.row("Activity evidence", activity.evidence === "verified_worker_phase" ? "Verified background process, database and phase"
      : activity.evidence === "recent_foreground_phase" ? "Recently observed foreground process and database"
      : activity.evidence === "no_current_process_observed" ? "No current local sync process observed" : ACTIVITY[activity.reason] || ACTIVITY.activity_evidence_unavailable);
    screen.row("Sync reservations", leases.evidence === "available" ? `${number(leases.total)} total · ${number(leases.occupied_count)} occupied · ${number(leases.abnormal_count)} abnormal` : "Evidence unavailable");
    if (leases.abnormal_count > 0) screen.row("Reservation issues", formatLeaseIssues(leases));
    screen.row("Message lists", progress.evidence === "available" ? `${number(progress.scopes)} recorded sources · ${progress.oldest_cursor_ms == null ? "no list checkpoint recorded" : `oldest list checkpoint ${stampMs(progress.oldest_cursor_ms)}`}${progress.invalid_cursor_scopes > 0 ? ` · ${number(progress.invalid_cursor_scopes)} invalid cursors` : ""}` : evidenceText(progress.evidence));
    if (sync) screen.row("Content checkpoints", `${number(sync.scopes?.received_without_cursor)} enabled received chats without a content checkpoint`);
    if (details.evidence === "available") {
      screen.row("Detail retry sources", number(details.scopes_pending));
      if (details.oldest_pending_ms != null) screen.row("Oldest pending message", stampMs(details.oldest_pending_ms));
      if (details.next_retry_at) screen.row("Next detail retry", stamp(details.next_retry_at));
    }
    if (failureRuns.evidence === "available" && failureRuns.failed_runs === 0) {
      screen.row("Database failures", `0 retained failed runs · last ${lookback(failureRuns.window_ms)} by start time`);
      screen.row("Database window", range(failureRuns.window_started_at, failureRuns.window_ended_at));
    }
    const detail = report.detail || {};
    const runCounts = Object.entries(detail.runs?.by_status || {}).map(([status, count]) => `${number(count)} ${status === "running" ? "unfinished records" : status}`);
    screen.row("Retained sync runs", detail.runs?.by_status === undefined ? "Run history evidence unavailable" : runCounts.join(" · ") || "No sync run records");
    screen.row("Coverage boundary", "List positions and content checkpoints do not independently verify all remote content through a target time.");
    screen.row("Command targets", "All suggestions require the same --db and --log-dir values as this status invocation.");
    screen.row("Inspect further", "npm run exo -- check · npm run exo -- status --detail · npm run exo -- status --format json · npm run exo -- status --logs (private)");
    screen.row("Remote check", "npm run exo -- check --live takes a new sample; add --write-live-cache to update the status cache.");
  }
  if (report.logs) {
    screen.heading("PRIVATE LOGS");
    for (const log of report.logs) { screen.row("Log", log.name); for (const line of log.lines) screen.text(formatLogLine(line)); }
  }
  return screen.finish();
}
