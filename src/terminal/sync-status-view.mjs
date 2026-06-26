// @ts-check

import {
  block,
  kv,
  list,
  section,
  statusBadge,
  subtitle,
  table,
  title,
} from "../../dist/terminal/index.js";

/**
 * @typedef {Record<string, any>} JsonObject
 */

/** @param {unknown} ms */
function localTime(ms) {
  if (!ms) return "none";
  return new Date(Number(ms)).toLocaleString();
}

/** @param {unknown} value */
function localIso(value) {
  if (!value) return "none";
  return new Date(String(value)).toLocaleString();
}

/** @param {JsonObject} status */
function renderSyncStatusText(status) {
  const byDirection = Object.fromEntries(
    status.records.by_direction.map((row) => [row.direction, row]),
  );
  const discoveryState = status.discovery.complete
    ? "complete"
    : status.discovery.cursor?.has_more
      ? "in progress"
      : "not started";
  const reconcileState = status.reconcile.complete
    ? "complete"
    : status.reconcile.cursor?.has_more
      ? "in progress"
      : "not started";
  const lines = [
    `${title("Exocortex sync status")} ${statusBadge(status.health)}`,
    subtitle(status.health_detail),
    "",
    section("Summary"),
    kv([
      [
        "Records",
        `${status.records.total} total, ${byDirection.sent?.count || 0} sent, ${
          byDirection.received?.count || 0
        } received`,
      ],
      ["Latest record", localTime(status.records.latest_ms)],
      ["Discovery", discoveryState],
      ["Discovery pages", status.discovery.cursor?.pages_scanned || 0],
      [
        "Hot discovery",
        status.hot_discovery.ran
          ? `last run ${localIso(status.hot_discovery.cursor_updated_at)}`
          : "not started",
      ],
      [
        "Reconcile",
        `${reconcileState}, ${status.reconcile.cursor?.pages_scanned || 0} pages`,
      ],
      [
        "Received scopes",
        `${status.scopes.received_enabled} enabled, ${status.scopes.received_without_cursor} without cursor`,
      ],
      ["Unsupported scopes", `${status.scopes.received_unsupported || 0} total`],
      ["Runs", JSON.stringify(status.runs.by_status)],
      ["Locks", status.locks.length],
    ]),
  ];
  if (status.scopes.unsupported_reasons?.length > 0) {
    lines.push("");
    lines.push(section("Unsupported reasons"));
    lines.push(
      table(status.scopes.unsupported_reasons, [
        { key: "reason", header: "Reason", render: (row) => row.reason },
        {
          key: "lark_cli",
          header: "Lark CLI",
          render: (row) =>
            row.lark_cli_error_message
              ? `${row.lark_cli_error_code}: ${row.lark_cli_error_message}`
              : "",
        },
        { key: "count", header: "Count", render: (row) => row.count },
      ]),
    );
  }
  if (
    status.recovery?.recovered_locks > 0 ||
    status.recovery?.cancelled_runs > 0 ||
    status.recovery?.active_expired_locks > 0
  ) {
    lines.push("");
    lines.push(section("Recovery"));
    lines.push(
      kv([
        ["Recovered locks", status.recovery.recovered_locks || 0],
        ["Cancelled runs", status.recovery.cancelled_runs || 0],
        ["Active expired locks", status.recovery.active_expired_locks || 0],
      ]),
    );
  }
  const recentProblems = status.runs.recent
    .filter((run) => run.status !== "succeeded")
    .slice(0, 3);
  if (recentProblems.length > 0) {
    lines.push("");
    lines.push(section("Recent non-success runs"));
    lines.push(
      list(
        recentProblems.map((run) =>
          `#${run.id} ${statusBadge(run.status)} [${
            run.failure_kind || "unknown"
          }] ${run.scope_id}: ${run.error_type || ""}`,
        ),
      ),
    );
  }
  return `${block(lines)}\n`;
}

export {
  renderSyncStatusText,
};
