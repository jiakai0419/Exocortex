// @ts-check

import {
  block,
  compact,
  kv,
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
function ageText(ms) {
  if (ms === null || ms === undefined) return "unknown";
  const seconds = Math.floor(Number(ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

/** @param {unknown} value */
function localIso(value) {
  if (!value) return "none";
  return new Date(String(value)).toLocaleString();
}

/** @param {JsonObject} summary */
function formatWorkerEvent(summary) {
  if (!summary.has_events) return "no worker events yet";
  const eventType = String(summary.last_event_type || "").replace(/^lark_im_worker_/, "");
  return `${eventType || "event"} ${ageText(summary.last_event_age_ms)}`;
}

/** @param {JsonObject} summary */
function formatWorkerCycle(summary) {
  if (!summary.last_cycle) return "none";
  return `#${summary.last_cycle.cycle} ${summary.last_cycle.ok ? statusBadge("ok") : statusBadge("failed")} ${localIso(
    summary.last_cycle.at,
  )} (${ageText(summary.last_cycle.age_ms)})`;
}

/** @param {JsonObject} summary */
function formatWorkerStep(summary) {
  if (!summary.last_step) return "none";
  return `cycle #${summary.last_step.cycle} ${summary.last_step.name} ${
    summary.last_step.ok ? statusBadge("ok") : statusBadge("failed")
  } (${ageText(summary.last_step.age_ms)})`;
}

/** @param {JsonObject} summary */
function formatWorkerFailure(summary) {
  if (!summary.last_failure) return "none in recent log";
  if (summary.last_failure.name === "cycle") {
    return `cycle #${summary.last_failure.cycle} ${statusBadge("failed")} (${ageText(
      summary.last_failure.age_ms,
    )})`;
  }
  return `cycle #${summary.last_failure.cycle} ${summary.last_failure.name} ${statusBadge("failed")} (${ageText(
    summary.last_failure.age_ms,
  )})`;
}

/** @param {JsonObject} report */
function renderServiceStatusText(report) {
  const syncStatus = report.sync?.status || null;
  const workerLog = report.worker?.log || { exists: false, path: "logs/lark-im/worker.jsonl" };
  const workerSummary = report.worker?.summary || {};
  const lines = [
    `${title("Lark IM service")} ${statusBadge(report.service_state === "not loaded" ? "not loaded" : report.service_state)}`,
    subtitle(report.label),
    "",
    section("LaunchAgent"),
    kv([
      ["Loaded", report.launchd?.loaded ? statusBadge("loaded") : statusBadge("not loaded")],
      ["State", report.launchd?.state || "unknown"],
      ["PID", report.launchd?.pid || "none"],
      ["Last exit", report.launchd?.last_exit_code || "none"],
    ]),
  ];

  if (syncStatus) {
    const byDirection = Object.fromEntries(
      (syncStatus.records?.by_direction || []).map((row) => [row.direction, row]),
    );
    lines.push("");
    lines.push(section("Sync"));
    const reconcileState = syncStatus.reconcile?.complete
      ? "complete"
      : syncStatus.reconcile?.cursor?.has_more
        ? "in progress"
        : "not started";
    const hotDiscoveryState = syncStatus.hot_discovery?.ran
      ? `last run ${localIso(syncStatus.hot_discovery.cursor_updated_at)}`
      : "not started";
    lines.push(
      kv([
        ["Health", `${statusBadge(syncStatus.health)} ${syncStatus.health_detail || ""}`],
        [
          "Records",
          `${syncStatus.records?.total || 0} total, ${byDirection.sent?.count || 0} sent, ${
            byDirection.received?.count || 0
          } received`,
        ],
        [
          "Received scopes",
          `${syncStatus.scopes?.received_enabled || 0} enabled, ${
            syncStatus.scopes?.received_without_cursor || 0
          } without cursor`,
        ],
        ["Unsupported scopes", `${syncStatus.scopes?.received_unsupported || 0} total`],
        ["Hot discovery", hotDiscoveryState],
        ["Reconcile", `${reconcileState}, ${syncStatus.reconcile?.cursor?.pages_scanned || 0} pages`],
        ["Locks", syncStatus.locks?.length || 0],
      ]),
    );
    if (syncStatus.scopes?.unsupported_reasons?.length > 0) {
      lines.push(
        table(syncStatus.scopes.unsupported_reasons, [
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
  } else {
    lines.push("");
    lines.push(section("Sync"));
    lines.push(`  ${statusBadge("failed")} ${compact(report.sync?.error_text || "sync status unavailable", 180)}`);
  }

  lines.push("");
  lines.push(section("Worker"));
  lines.push(
    kv([
      ["Last cycle", formatWorkerCycle(workerSummary)],
      ["Last event", formatWorkerEvent(workerSummary)],
      ["Last step", formatWorkerStep(workerSummary)],
      ["In progress", workerSummary.in_progress ? "yes" : "no"],
      ["Last failure", formatWorkerFailure(workerSummary)],
      ["Log", workerLog.exists ? workerLog.path : `${workerLog.path} (missing)`],
    ]),
  );

  return `${block(lines)}\n`;
}

export {
  ageText,
  formatWorkerCycle,
  formatWorkerEvent,
  formatWorkerFailure,
  formatWorkerStep,
  localIso,
  renderServiceStatusText,
};
