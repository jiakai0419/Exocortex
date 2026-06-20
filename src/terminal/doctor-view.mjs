// @ts-check

import {
  block,
  hint,
  kv,
  list,
  section,
  statusBadge,
  subtitle,
  title,
} from "../../dist/terminal/index.js";

/**
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} DoctorReport
 * @property {boolean} ok
 * @property {string} overall
 * @property {string} checked_at
 * @property {JsonObject} status
 * @property {JsonObject} quality
 * @property {JsonObject | null} live
 * @property {string[]} findings
 */

/** @param {JsonObject} status */
function localLatest(status) {
  const ms = status.records?.latest_ms;
  return ms ? new Date(Number(ms)).toLocaleString() : "none";
}

/** @param {JsonObject} status */
function reconcileText(status) {
  const state = status.reconcile?.complete
    ? "complete"
    : status.reconcile?.cursor?.has_more
      ? "in progress"
      : "not started";
  return `${state}, ${status.reconcile?.cursor?.pages_scanned || 0} pages`;
}

/** @param {JsonObject} status */
function hotDiscoveryText(status) {
  if (!status.hot_discovery?.ran) return "not started";
  const time = status.hot_discovery.cursor_updated_at
    ? new Date(status.hot_discovery.cursor_updated_at).toLocaleString()
    : "unknown time";
  return `last run ${time}`;
}

/** @param {DoctorReport} report */
function renderDoctorText(report) {
  const byDirection = Object.fromEntries(
    (report.status.records?.by_direction || []).map((row) => [row.direction, row]),
  );
  const lines = [
    `${title("Exocortex doctor")} ${statusBadge(report.overall)}`,
    subtitle(`Checked at ${new Date(report.checked_at).toLocaleString()}`),
    "",
    section("Summary"),
    kv([
      ["Latest record", localLatest(report.status)],
      [
        "Records",
        `${report.status.records?.total || 0} total, ${byDirection.sent?.count || 0} sent, ${
          byDirection.received?.count || 0
        } received`,
      ],
      ["Sync", `${statusBadge(report.status.health || "unknown")} ${report.status.health_detail || ""}`],
      ["Hot discovery", hotDiscoveryText(report.status)],
      ["Reconcile", reconcileText(report.status)],
      [
        "Scopes",
        `${report.status.scopes?.received_enabled || 0} received enabled, ${
          report.status.scopes?.received_without_cursor || 0
        } without cursor`,
      ],
      [
        "Quality",
        `${report.quality.quality?.actionable_missing_sender_name || 0} actionable sender gaps, ` +
          `${report.quality.quality?.missing_sender_name || 0} total missing sender names, ` +
          `${report.quality.quality?.missing_chat_name || 0} missing chat names, ` +
          `${report.quality.quality?.invalid_rendered_body || 0} invalid bodies`,
      ],
    ]),
  ];

  lines.push("");
  if (report.live) {
    lines.push(section("Live"));
    /** @type {Array<[unknown, unknown]>} */
    const liveRows = [
      ["Status", statusBadge(report.live.status || "unknown")],
      ["Missing", report.live.missing_count ?? "?"],
      [
        "Lag",
        report.live.lag_ms === null || report.live.lag_ms === undefined
          ? "unknown"
          : `${Math.round(report.live.lag_ms / 1000)}s`,
      ],
    ];
    if (report.live.reason) liveRows.push(["Reason", report.live.reason]);
    if (report.live.hint) liveRows.push(["Hint", report.live.hint]);
    lines.push(kv(liveRows));
  } else {
    lines.push(hint("Live", "skipped. Run node scripts/doctor.mjs --live to compare recent remote hot messages."));
  }

  if (report.findings.length > 0) {
    lines.push("");
    lines.push(section("Findings"));
    lines.push(list(report.findings));
  }

  return `${block(lines)}\n`;
}

export {
  renderDoctorText,
};
