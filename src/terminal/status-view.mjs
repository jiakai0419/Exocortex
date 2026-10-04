// @ts-check
import { formatStabilityCycles, formatStabilityFailures, formatStabilityLastSuccess, formatStabilityInterval,
  formatStatisticsRange, formatLeaseIssues, formatWorkerCycle, formatWorkerEvent, formatWorkerFailure, formatWorkerStep,
  serviceTimeRange, serviceTimestamp, unsupportedScopeRows, formatReconcile, durationText } from "./lark-im-service-view.mjs";
import { kv, section } from "../../dist/terminal/index.js";
import { formatLogLine } from "./status-log-view.mjs";
import { activityReasonText } from "../diagnostics/public-activity.mjs";

/** Render only the public status projection; raw service reports are never accepted here.
 * @param {Record<string, any>} report */
export function renderStatusText(report) {
  const referenceMs = Date.parse(report.observed_at);
  const activityPhase = ["cycle", "between_steps", "step"].includes(report.activity.phase)
    ? report.activity.phase.replaceAll("_", " ") : null;
  const lines = [
    `Service: ${report.service.status.toUpperCase()} · target ${report.service.target_match}`,
    `Health: ${report.health.status.toUpperCase()}`,
    `Activity: ${report.activity.state.toUpperCase()} · ${activityReasonText(report.activity.reason)}${activityPhase ? ` · ${activityPhase}` : ""}`,
    `Freshness: ${report.freshness.status.toUpperCase()}${report.freshness.reason !== "unknown" ? ` · ${report.freshness.reason}` : ""}`,
    `Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
  ];
  if (report.freshness.sample_count > 0) lines.push(
    `Sample: ${report.freshness.scope}, ${report.freshness.sample_count} messages`,
    `Window: ${serviceTimeRange(report.freshness.window.start, report.freshness.window.end, referenceMs, true)}`,
    `Checked: ${serviceTimestamp(report.freshness.checked_at, referenceMs)}`,
    `Expires: ${serviceTimestamp(report.freshness.expires_at, referenceMs)}`,
    "Identity: current authenticated principal unknown",
  );
  const hours = report.stability.window_ms / 3600000;
  lines.push(`Recent cycles (up to ${Number.isInteger(hours) && hours > 0 && hours <= 72 ? `${hours}h` : durationText(report.stability.window_ms)})`);
  lines.push(`Statistics range: ${formatStatisticsRange(report.stability, referenceMs)}`,
    `Cycles: ${formatStabilityCycles(report.stability)}`,
    `Last success: ${formatStabilityLastSuccess(report.stability)}`,
    `Longest between successes: ${formatStabilityInterval(report.stability)}`,
    `Failures: ${formatStabilityFailures(report.stability)}`);
  lines.push(section("Sync"));
  if (report.sync) {
    const sync = report.sync;
    const byDirection = Object.fromEntries(sync.records.by_direction.map((row) => [row.direction, row.count]));
    lines.push(kv([
      ["Records", `${sync.records.total} total, ${byDirection.sent || 0} sent, ${byDirection.received || 0} received`],
      ["Received scopes", `${sync.scopes.received_enabled} enabled, ${sync.scopes.received_without_cursor} without cursor`],
      ...unsupportedScopeRows(sync.scopes),
      ["Active chat refresh", sync.hot_discovery.ran ? `last success ${serviceTimestamp(sync.hot_discovery.cursor_updated_at, referenceMs)}` : "not started"],
      ["Chat list review", formatReconcile(sync.reconcile, referenceMs)],
      report.leases.evidence === "available" && report.leases.abnormal_count > 0
        ? ["Warning", `${formatLeaseIssues(report.leases)}; check sync diagnostics and system clock`] : null,
    ]));
  } else lines.push("Sync status unavailable");
  lines.push(`Last cycle: ${formatWorkerCycle(report.worker, referenceMs)}`, `Last event: ${formatWorkerEvent(report.worker)}`,
    `Last step: ${formatWorkerStep(report.worker)}`, `Last failure: ${formatWorkerFailure(report.worker)}`,
    `Unfinished history: ${report.worker.in_progress || report.worker.unfinished_cycle ? "yes; current activity requires separate evidence" : "no"}`);
  if (report.detail !== undefined) lines.push(JSON.stringify(report.detail, null, 2));
  if (report.logs) {
    lines.push("PRIVATE LOGS");
    for (const log of report.logs) lines.push(log.name, ...log.lines.map(formatLogLine));
  }
  return `${lines.join("\n")}\n`;
}
