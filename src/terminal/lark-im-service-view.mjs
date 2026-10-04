// @ts-check

import { basename } from "node:path";

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
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m ago` : `${minutes}m ${seconds % 60}s ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h ago` : `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d ago` : `${days}d ${hours % 24}h ago`;
}

/** @param {unknown} ms */
function durationText(ms) {
  if (ms === null || ms === undefined) return "unknown";
  const seconds = Math.max(0, Math.floor(Number(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** @param {unknown} ms */
function windowText(ms) {
  const hours = Number(ms) / (60 * 60 * 1000);
  if (Number.isInteger(hours) && hours <= 72) return `${hours}h`;
  return durationText(ms);
}

/** @param {unknown} value */
function localIso(value) {
  if (!value) return "none";
  return new Date(String(value)).toLocaleString();
}

/** Local wall time with the UTC offset at that instant, including DST changes.
 * @param {unknown} value
 */
function localTimestamp(value) {
  if (!value) return "unknown";
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return "unknown";
  const pad = (part) => String(part).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const offset = `${offsetMinutes >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} UTC${offset}`;
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

/** @param {{status?: string, detail?: string} | null | undefined} item */
function formatOverviewItem(item) {
  if (!item) return statusBadge("unknown");
  return `${statusBadge(item.status || "unknown")} ${item.detail || ""}`.trim();
}

/** @param {JsonObject | null | undefined} stability */
function formatStabilityCycles(stability) {
  if (!stability) return "unknown";
  const cycles = stability.cycles || {};
  return `${cycles.ok || 0} ok, ${cycles.failed || 0} failed, ${cycles.total || 0} total`;
}

/** @param {JsonObject | null | undefined} stability */
function formatStabilityLastSuccess(stability) {
  if (!stability) return "unknown";
  if (!stability.last_success) {
    return stability.observed_events > 0 ? "none in window" : "no worker events in window";
  }
  const cycle = stability.last_success.cycle === null || stability.last_success.cycle === undefined
    ? ""
    : `#${stability.last_success.cycle} `;
  return `${cycle}${ageText(stability.last_success.age_ms)}`.trim();
}

/** @param {JsonObject | null | undefined} stability */
function formatStabilityInterval(stability) {
  if (!stability) return "unknown";
  if (Number(stability.cycles?.ok || 0) < 2) return "unavailable (need 2 successes)";
  const interval = stability.longest_between_successes_ms;
  // Round measured intervals independently of ages, which still round down.
  return typeof interval === "number" && Number.isFinite(interval) && interval >= 0 ? durationText(Math.round(interval / 1000) * 1000).replaceAll(" ", "") : "unknown";
}

/** @param {JsonObject | null | undefined} stability */
function formatStatisticsRange(stability) {
  const observed = stability?.observation;
  const from = localTimestamp(observed?.range_started_at);
  const to = localTimestamp(observed?.range_ended_at);
  if (from === "unknown" || to === "unknown") return "unavailable (no current-window log evidence)";
  const partial = observed?.window_start_reached === true ? "" : `less than ${windowText(stability?.window_ms || 24 * 60 * 60 * 1000)} observed; `;
  return `${from} → ${to} (${partial}${observed?.tail_truncated ? "retained log tail only" : "retained log only"})`;
}

/** @param {JsonObject | null | undefined} reconcile */
function formatReconcile(reconcile) {
  if (reconcile?.complete) {
    const completedAt = localTimestamp(reconcile.cursor?.completed_at);
    return `complete; ${completedAt === "unknown" ? "completion time unavailable" : `completed ${completedAt}`}`;
  }
  return reconcile?.cursor?.has_more ? "in progress" : "not started";
}

/** @param {JsonObject | null | undefined} leases */
function formatLeaseIssues(leases) {
  const labels = {
    invalid_timestamp: "invalid timestamps",
    invalid_interval: "invalid lease interval",
    future_start: "future start time",
    hard_limit_exceeded: "hard lease limit exceeded",
    expired: "expired",
  };
  const reasons = Array.isArray(leases?.reasons) ? leases.reasons : [];
  const parts = Object.entries(labels).flatMap(([reason, label]) => {
    const count = reasons.filter((item) => item?.reason === reason && Number.isSafeInteger(item.count) && item.count > 0)
      .reduce((sum, item) => sum + item.count, 0);
    return count > 0 ? [`${label} x${count}`] : [];
  });
  return parts.join(", ") || "lease state needs inspection";
}

/** @param {JsonObject | null | undefined} stability */
function formatStabilityFailures(stability) {
  if (!stability) return "unknown";
  const failures = stability.failures || {};
  const parts = [];
  if (Number(failures.failed_cycles || 0) > 0) {
    parts.push(`${failures.failed_cycles} failed cycle${failures.failed_cycles === 1 ? "" : "s"}`);
  }
  for (const item of (failures.by_step || []).slice(0, 3)) {
    parts.push(`${item.name || "unknown"} x${item.count || 0}`);
  }
  for (const item of (failures.by_kind || []).slice(0, 3)) {
    parts.push(`${item.kind || "unknown"} x${item.count || 0}`);
  }
  return parts.length > 0 ? parts.join(", ") : "none";
}

/** @param {JsonObject | null | undefined} stability */
function stabilitySectionTitle(stability) {
  return `Last ${windowText(stability?.window_ms || 24 * 60 * 60 * 1000)}`;
}

/** @param {JsonObject} report */
function renderServiceStatusText(report) {
  const syncStatus = report.sync?.status || null;
  const workerLog = report.worker?.log || { exists: false, path: "logs/lark-im/worker.jsonl" };
  const workerSummary = report.worker?.summary || {};
  const stability = report.stability || null;
  const overview = report.overview || {
    service: {
      status: report.service_state === "unknown" ? "unknown" : report.service_state === "not loaded" ? "stopped" : "running",
      detail: report.service_state || "unknown",
    },
    health: {
      status: syncStatus ? "ok" : "problem",
      detail: syncStatus?.health_detail || report.sync?.error_text || "",
    },
    activity: {
      status: workerSummary.in_progress || workerSummary.unfinished_cycle || !syncStatus ? "unknown" : "idle",
      detail: workerSummary.in_progress || workerSummary.unfinished_cycle || !syncStatus ? "current activity is unverified" : "no unfinished worker cycle observed",
    },
    freshness: {
      status: "unknown",
      detail: "no cached live probe",
    },
  };
  const lines = [
    `${title("Lark IM service")} ${statusBadge(overview.service?.status || "unknown")}`,
    subtitle(report.label),
    "",
    section("Overview"),
    kv(
      [
        ["Service", formatOverviewItem(overview.service)],
        ["Health", formatOverviewItem(overview.health)],
        ["Activity", formatOverviewItem(overview.activity)],
        ["Freshness", formatOverviewItem(overview.freshness)],
        ...(overview.freshness?.sample_count > 0 ? /** @type {Array<[unknown, unknown]>} */ ([
          ["Sample", `${overview.freshness.scope}, ${overview.freshness.sample_count} messages`],
          ["Window", `${overview.freshness.window?.start} → ${overview.freshness.window?.end}`],
          ["Checked", overview.freshness.checked_at],
          ["Expires", overview.freshness.expires_at],
          ["Identity", "current authenticated principal unknown"],
        ]) : []),
      ],
      { width: 9 },
    ),
    "",
    section(stabilitySectionTitle(stability)),
    kv([
      ["Statistics range", formatStatisticsRange(stability)],
      ["Cycles", formatStabilityCycles(stability)],
      ["Last success", formatStabilityLastSuccess(stability)],
      ["Longest between successes", formatStabilityInterval(stability)],
      ["Failures", formatStabilityFailures(stability)],
    ]),
    "",
    section("LaunchAgent"),
    kv([
      ["Loaded", report.launchd?.loaded === null || report.launchd?.loaded === undefined ? statusBadge("unknown") : report.launchd.loaded ? statusBadge("loaded") : statusBadge("not loaded")],
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
    const hotDiscoveryState = syncStatus.hot_discovery?.ran
      ? `last success ${localIso(syncStatus.hot_discovery.cursor_updated_at)}`
      : "not started";
    lines.push(
      kv([
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
        ["Active chat refresh", hotDiscoveryState],
        ["Chat list review", formatReconcile(syncStatus.reconcile)],
        overview.leases?.evidence === "available" && Number(overview.leases.abnormal_count || 0) > 0
          ? ["Warning", `${formatLeaseIssues(overview.leases)}; check sync diagnostics and system clock`]
          : null,
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
      ["In progress", workerSummary.in_progress || workerSummary.unfinished_cycle ? "unknown (unfinished history)" : "no"],
      ["Last failure", formatWorkerFailure(workerSummary)],
      ["Log", workerLog.exists ? basename(workerLog.path) : `${basename(workerLog.path)} (missing)`],
    ]),
  );

  return `${block(lines)}\n`;
}

export {
  ageText,
  durationText,
  formatOverviewItem,
  formatStabilityCycles,
  formatStabilityFailures,
  formatStabilityLastSuccess,
  formatStabilityInterval,
  formatStatisticsRange,
  formatReconcile,
  formatLeaseIssues,
  formatWorkerCycle,
  formatWorkerEvent,
  formatWorkerFailure,
  formatWorkerStep,
  localIso,
  localTimestamp,
  renderServiceStatusText,
};
