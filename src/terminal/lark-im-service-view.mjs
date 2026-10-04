// @ts-check

import { basename } from "node:path";
import { publicUnsupportedReasons } from "../diagnostics/public-safe.mjs";

import {
  block,
  compact,
  kv,
  section,
  statusBadge,
  subtitle,
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

/** @param {Date} date */
function localDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** @param {Date} date */
function ambiguousLocalTime(date) {
  const offset = date.getTimezoneOffset();
  return [-86400000, 86400000].some((delta) => {
    const otherOffset = new Date(date.getTime() + delta).getTimezoneOffset();
    if (otherOffset === offset) return false;
    const other = new Date(date.getTime() + (otherOffset - offset) * 60000);
    return localDay(other) === localDay(date) && other.getHours() === date.getHours() && other.getMinutes() === date.getMinutes();
  });
}

/** @param {Date} date @param {boolean} seconds @param {boolean} offset */
function serviceClock(date, seconds, offset) {
  const parts = localTimestamp(date.toISOString()).split(" ");
  return `${seconds ? parts[1] : parts[1].slice(0, 5)}${offset ? ` ${parts[2]}` : ""}`;
}

/** Service-only local timestamp; the renderer declares the IANA zone once.
 * @param {unknown} value @param {number} [referenceMs]
 */
function serviceTimestamp(value, referenceMs = Date.now()) {
  const date = new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) return "unknown";
  const day = localDay(date) === localDay(new Date(referenceMs)) ? "Today" : localDay(date);
  return `${day} ${serviceClock(date, true, ambiguousLocalTime(date))}`;
}

/** @param {unknown} from @param {unknown} to @param {number} referenceMs @param {boolean} [seconds] */
function serviceTimeRange(from, to, referenceMs, seconds = false) {
  const start = new Date(String(from || ""));
  const end = new Date(String(to || ""));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) return "unknown";
  const offsetsDiffer = start.getTimezoneOffset() !== end.getTimezoneOffset();
  const firstClock = serviceClock(start, seconds, offsetsDiffer || ambiguousLocalTime(start));
  const lastClock = serviceClock(end, seconds, offsetsDiffer || ambiguousLocalTime(end));
  if (localDay(start) === localDay(end)) {
    const day = localDay(start) === localDay(new Date(referenceMs)) ? "Today" : localDay(start);
    return `${day} ${firstClock}–${lastClock}`;
  }
  return `${localDay(start)} ${firstClock}–${localDay(end)} ${lastClock}`;
}

/** @param {JsonObject} summary */
function formatWorkerEvent(summary) {
  if (!summary.has_events) return "no worker events yet";
  const eventType = String(summary.last_event_type || "").replace(/^lark_im_worker_/, "");
  return `${eventType || "event"} ${ageText(summary.last_event_age_ms)}`;
}

/** @param {JsonObject} summary @param {number} [referenceMs] */
function formatWorkerCycle(summary, referenceMs = Date.now()) {
  if (!summary.last_cycle) return "none";
  return `#${summary.last_cycle.cycle} ${summary.last_cycle.ok ? statusBadge("ok") : statusBadge("failed")} ${serviceTimestamp(
    summary.last_cycle.at, referenceMs,
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
  if (typeof interval !== "number" || !Number.isFinite(interval) || interval < 0) return "unknown";
  let seconds = Math.round(interval / 1000);
  if (!Number.isSafeInteger(seconds)) return "unknown";
  /** @type {Array<[number, string]>} */
  const units = [[86400, "d"], [3600, "h"], [60, "m"], [1, "s"]];
  const parts = [];
  for (const [size, label] of units) {
    const count = Math.floor(seconds / size);
    if (count) parts.push(`${count}${label}`);
    seconds %= size;
  }
  return parts.join("") || "0s";
}

/** @param {JsonObject | null | undefined} stability @param {number} [referenceMs] */
function formatStatisticsRange(stability, referenceMs = Date.now()) {
  const observed = stability?.observation;
  const range = serviceTimeRange(observed?.range_started_at, observed?.range_ended_at, referenceMs);
  if (range === "unknown") return "unavailable (no current-window log evidence)";
  const elapsedMs = Date.parse(observed.range_ended_at) - Date.parse(observed.range_started_at);
  const minutes = Math.floor(elapsedMs / 60000);
  const duration = minutes === 0 ? elapsedMs === 0 ? "0m" : "<1m"
    : `${Math.floor(minutes / 60) || ""}${minutes >= 60 ? "h" : ""}${minutes % 60 ? `${minutes % 60}m` : ""}`;
  return `${range} · ${duration}${observed.tail_truncated ? " · log truncated" : ""}`;
}

/** @param {JsonObject | null | undefined} reconcile @param {number} [referenceMs] */
function formatReconcile(reconcile, referenceMs = Date.now()) {
  if (reconcile?.complete) {
    const completedAt = serviceTimestamp(reconcile.cursor?.completed_at, referenceMs);
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

/**
 * @param {JsonObject | null | undefined} scopes
 * @returns {Array<[string, string]>}
 */
function unsupportedScopeRows(scopes) {
  const total = Number(scopes?.received_unsupported || 0);
  const reasons = publicUnsupportedReasons(Array.isArray(scopes?.unsupported_reasons) ? scopes.unsupported_reasons : []);
  const describe = (row) => {
    const reason = row.reason === "restricted_mode" ? "restricted_mode (access restricted)"
      : row.reason === "bot_user_out_of_chat" ? "bot_user_out_of_chat (bot or user outside chat)" : row.reason;
    return `${reason}${row.error_code === null ? "" : ` · code ${row.error_code}`}`;
  };
  if (reasons.length === 1 && reasons[0].count === total) {
    return [["Unsupported scopes", `${total} · ${describe(reasons[0])}`]];
  }
  return [
    ["Unsupported scopes", String(total)],
    ...reasons.map((row) => /** @type {[string, string]} */ (["", `${row.count} · ${describe(row)}`])),
  ];
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
  return `Recent cycles (up to ${windowText(stability?.window_ms || 24 * 60 * 60 * 1000)})`;
}

/** @param {JsonObject} report */
function renderServiceStatusText(report) {
  const syncStatus = report.sync?.status || null;
  const workerLog = report.worker?.log || { exists: false, path: "logs/lark-im/worker.jsonl" };
  const workerSummary = report.worker?.summary || {};
  const stability = report.stability || null;
  const observedAt = Date.parse(String(stability?.observation?.range_ended_at || report.overview?.leases?.observed_at || ""));
  const referenceMs = Number.isFinite(observedAt) ? observedAt : Date.now();
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
    kv([["Time zone", Intl.DateTimeFormat().resolvedOptions().timeZone]]),
    "",
    section("Overview"),
    kv(
      [
        ["Service", formatOverviewItem(overview.service)],
        ["Health", formatOverviewItem(overview.health)],
        ["Activity", formatOverviewItem({ ...overview.activity, status: overview.activity?.state || overview.activity?.status })],
        ["Freshness", formatOverviewItem(overview.freshness)],
        ...(overview.freshness?.sample_count > 0 ? /** @type {Array<[unknown, unknown]>} */ ([
          ["Sample", `${overview.freshness.scope}, ${overview.freshness.sample_count} messages`],
          ["Window", serviceTimeRange(overview.freshness.window?.start, overview.freshness.window?.end, referenceMs, true)],
          ["Checked", serviceTimestamp(overview.freshness.checked_at, referenceMs)],
          ["Expires", serviceTimestamp(overview.freshness.expires_at, referenceMs)],
          ["Identity", "current authenticated principal unknown"],
        ]) : []),
      ],
      { width: 9 },
    ),
    "",
    section(stabilitySectionTitle(stability)),
    kv([
      ["Statistics range", formatStatisticsRange(stability, referenceMs)],
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
      ? `last success ${serviceTimestamp(syncStatus.hot_discovery.cursor_updated_at, referenceMs)}`
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
        ...unsupportedScopeRows(syncStatus.scopes),
        ["Active chat refresh", hotDiscoveryState],
        ["Chat list review", formatReconcile(syncStatus.reconcile, referenceMs)],
        overview.leases?.evidence === "available" && Number(overview.leases.abnormal_count || 0) > 0
          ? ["Warning", `${formatLeaseIssues(overview.leases)}; check sync diagnostics and system clock`]
          : null,
      ]),
    );
  } else {
    lines.push("");
    lines.push(section("Sync"));
    lines.push(`  ${statusBadge("failed")} ${compact(report.sync?.error_text || "sync status unavailable", 180)}`);
  }

  lines.push("");
  lines.push(section("Worker"));
  lines.push(
    kv([
      ["Last cycle", formatWorkerCycle(workerSummary, referenceMs)],
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
  unsupportedScopeRows,
  formatWorkerCycle,
  formatWorkerEvent,
  formatWorkerFailure,
  formatWorkerStep,
  localIso,
  localTimestamp,
  serviceTimestamp,
  serviceTimeRange,
  renderServiceStatusText,
};
