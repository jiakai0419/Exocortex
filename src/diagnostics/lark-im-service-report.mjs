// @ts-check

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { summarizeWorkerEvents } from "../../dist/runtime/worker/lark-im-worker-core.js";
import { classifyLarkFailure } from "../adapters/lark-im/transport.mjs";
import { readLiveProbeCache } from "./live-probe-cache.mjs";

const DEFAULT_FRESHNESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STABILITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WORKER_LOG_TAIL_BYTES = 8 * 1024 * 1024;
const DEFAULT_WORKER_LOG_MAX_EVENTS = 20000;
const DEFAULT_DB = "data/exocortex.sqlite";

/**
 * @typedef {Record<string, any>} JsonObject
 * @typedef {import("node:child_process").SpawnSyncReturns<string>} SpawnResult
 *
 * @typedef {object} WorkerLogTail
 * @property {string} path
 * @property {boolean} exists
 * @property {JsonObject[]} events
 *
 * @typedef {object} ServiceStatusOptions
 * @property {string} label
 * @property {string} target
 * @property {string} logDir
 * @property {string=} db
 *
 * @typedef {object} ServiceStatusReportDeps
 * @property {(cmd: string, args: string[], options?: {allowFailure?: boolean}) => SpawnResult=} runCommand
 * @property {(logDir: string) => WorkerLogTail=} readRecentWorkerEvents
 * @property {(events: unknown[], nowMs?: number) => JsonObject=} summarizeWorkerEvents
 * @property {(path: string) => JsonObject | null=} readLiveProbeCache
 * @property {(dbPath: string, sql: string, label: string) => JsonObject[]=} sqliteJson
 * @property {number=} nowMs
 * @property {number=} freshnessMaxAgeMs
 * @property {number=} stabilityWindowMs
 *
 * @typedef {"running" | "stopped"} ServiceRuntimeStatus
 * @typedef {"ok" | "catching_up" | "problem"} ServiceHealthStatus
 * @typedef {"idle" | "syncing"} ServiceActivityStatus
 * @typedef {"verified" | "unknown" | "behind"} ServiceFreshnessStatus
 *
 * @typedef {object} ServiceOverview
 * @property {{status: ServiceRuntimeStatus, detail: string}} service
 * @property {{status: ServiceHealthStatus, detail: string}} health
 * @property {{status: ServiceActivityStatus, detail: string}} activity
 * @property {{status: ServiceFreshnessStatus, detail: string}} freshness
 */

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{allowFailure?: boolean}} [options]
 * @returns {SpawnResult}
 */
function runCommand(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result;
}

/**
 * @param {string} dbPath
 * @param {string} sql
 * @param {string} label
 * @returns {JsonObject[]}
 */
function sqliteJson(dbPath, sql, label) {
  const result = spawnSync("sqlite3", ["-json", dbPath], {
    input: `.timeout 5000\n${sql}`,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

/** @param {string} stdout */
function parseLaunchdState(stdout) {
  /** @type {Record<string, string>} */
  const result = {};
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(state|pid|last exit code) = (.+)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

/**
 * @param {SpawnResult | {stdout?: string}} result
 * @returns {JsonObject | null}
 */
function parseJsonOutput(result) {
  try {
    return JSON.parse(String(result.stdout || "").trim());
  } catch {
    return null;
  }
}

/**
 * @param {string} path
 * @param {number} [maxBytes]
 */
function readFileTail(path, maxBytes = 512 * 1024) {
  const stat = statSync(path);
  const length = Math.min(stat.size, maxBytes);
  const start = Math.max(0, stat.size - length);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString("utf8");
  return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
}

/**
 * @param {string} logDir
 * @returns {WorkerLogTail}
 */
function readRecentWorkerEvents(logDir) {
  const path = resolve(logDir, "worker.jsonl");
  if (!existsSync(path)) return { path, exists: false, events: [] };
  const lines = readFileTail(path, DEFAULT_WORKER_LOG_TAIL_BYTES)
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-DEFAULT_WORKER_LOG_MAX_EVENTS);
  /** @type {JsonObject[]} */
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Ignore partial or non-JSON log lines at the edge of the tail window.
    }
  }
  return { path, exists: true, events };
}

/**
 * @param {JsonObject | null | undefined} event
 * @returns {number | null}
 */
function eventTimeMs(event) {
  const parsed = Date.parse(String(event?.at || event?.finished_at || event?.started_at || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {unknown[]} events
 * @param {number} [nowMs]
 * @param {number} [windowMs]
 */
function summarizeWorkerStability(events, nowMs = Date.now(), windowMs = DEFAULT_STABILITY_WINDOW_MS) {
  const windowStartMs = nowMs - windowMs;
  const normalized = (events || [])
    .filter((event) => event && typeof event === "object")
    .map((event) => /** @type {JsonObject} */ (event))
    .map((event) => ({ event, at_ms: eventTimeMs(event) }))
    .filter((item) => item.at_ms !== null && item.at_ms >= windowStartMs && item.at_ms <= nowMs)
    .sort((a, b) => Number(a.at_ms) - Number(b.at_ms));
  const cycles = normalized.filter((item) => item.event.type === "lark_im_worker_cycle");
  const successCycles = cycles.filter((item) => item.event.ok === true);
  const failedCycles = cycles.filter((item) => item.event.ok === false);
  const failedSteps = normalized.filter(
    (item) => item.event.type === "lark_im_worker_step" && item.event.ok === false,
  );
  /** @type {Record<string, number>} */
  const failuresByStep = {};
  for (const item of failedSteps) {
    const name = String(item.event.name || "unknown");
    failuresByStep[name] = (failuresByStep[name] || 0) + 1;
  }
  const successTimes = successCycles.map((item) => Number(item.at_ms));
  const lastSuccess = successCycles.at(-1);
  let longestBetweenSuccessesMs = windowMs;
  if (successTimes.length > 0) {
    longestBetweenSuccessesMs = Math.max(0, successTimes[0] - windowStartMs);
    for (let i = 1; i < successTimes.length; i += 1) {
      longestBetweenSuccessesMs = Math.max(longestBetweenSuccessesMs, successTimes[i] - successTimes[i - 1]);
    }
    longestBetweenSuccessesMs = Math.max(longestBetweenSuccessesMs, nowMs - successTimes[successTimes.length - 1]);
  }

  return {
    window_ms: windowMs,
    window_started_at: new Date(windowStartMs).toISOString(),
    observed_events: normalized.length,
    cycles: {
      total: cycles.length,
      ok: successCycles.length,
      failed: failedCycles.length,
    },
    last_success: lastSuccess
      ? {
          cycle: lastSuccess.event.cycle ?? null,
          at: new Date(Number(lastSuccess.at_ms)).toISOString(),
          age_ms: Math.max(0, nowMs - Number(lastSuccess.at_ms)),
        }
      : null,
    longest_between_successes_ms: longestBetweenSuccessesMs,
    failures: {
      failed_cycles: failedCycles.length,
      failed_steps: failedSteps.length,
      by_step: Object.entries(failuresByStep)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    },
  };
}

/** @param {unknown} value */
function quoteSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * @param {string} dbPath
 * @param {number} nowMs
 * @param {number} windowMs
 * @param {ServiceStatusReportDeps} [deps]
 */
function collectRecentFailureKinds(dbPath, nowMs, windowMs, deps = {}) {
  const query = deps.sqliteJson || sqliteJson;
  const windowStart = new Date(nowMs - windowMs).toISOString();
  const rows = query(
    dbPath,
    `SELECT error_message
     FROM sync_runs
     WHERE status = 'failed'
       AND started_at >= ${quoteSql(windowStart)}
     ORDER BY id DESC;`,
    "read recent failed run kinds",
  );
  /** @type {Record<string, number>} */
  const byKind = {};
  for (const row of rows) {
    const kind = classifyLarkFailure(row.error_message || "").kind;
    byKind[kind] = (byKind[kind] || 0) + 1;
  }
  return {
    failed_runs: rows.length,
    by_kind: Object.entries(byKind)
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
  };
}

/**
 * @param {{loaded?: boolean, state?: unknown, pid?: unknown}} launchd
 * @returns {{status: ServiceRuntimeStatus, detail: string}}
 */
function summarizeServiceRuntime(launchd) {
  if (!launchd.loaded) return { status: "stopped", detail: "LaunchAgent not loaded" };
  const state = String(launchd.state || "").toLowerCase();
  const hasWorkerProcess = Boolean(launchd.pid);
  if (hasWorkerProcess || state === "running" || state === "active") {
    return { status: "running", detail: "LaunchAgent loaded, worker process active" };
  }
  return { status: "stopped", detail: "LaunchAgent loaded, worker process not running" };
}

/**
 * @param {JsonObject | null} syncStatus
 */
function isCatchingUp(syncStatus) {
  if (!syncStatus) return false;
  return (
    String(syncStatus.health || "").toLowerCase() === "catching_up" ||
    Number(syncStatus.scopes?.received_without_cursor || 0) > 0 ||
    syncStatus.discovery?.cursor?.has_more === true
  );
}

/**
 * @param {{service: {status: ServiceRuntimeStatus}, syncStatus: JsonObject | null, syncErrorText?: string, workerSummary: JsonObject}} input
 * @returns {{status: ServiceHealthStatus, detail: string}}
 */
function summarizeServiceHealth({ service, syncStatus, syncErrorText = "", workerSummary }) {
  if (service.status !== "running") return { status: "problem", detail: "background service is stopped" };
  if (!syncStatus) return { status: "problem", detail: syncErrorText || "sync status unavailable" };
  const rawHealth = String(syncStatus.health || "").toLowerCase();
  if (["failed", "needs_attention", "problem", "command_failed"].includes(rawHealth)) {
    return { status: "problem", detail: syncStatus.health_detail || rawHealth };
  }
  if (workerSummary.last_cycle?.ok === false && !workerSummary.in_progress) {
    return { status: "problem", detail: "last worker cycle failed" };
  }
  if (isCatchingUp(syncStatus)) {
    return { status: "catching_up", detail: syncStatus.health_detail || "sync is still catching up" };
  }
  if (rawHealth === "syncing") {
    return { status: "ok", detail: "all known enabled scopes have cursors" };
  }
  return { status: "ok", detail: syncStatus.health_detail || "all known enabled scopes have cursors" };
}

/**
 * @param {{service: {status: ServiceRuntimeStatus}, syncStatus: JsonObject | null, workerSummary: JsonObject}} input
 * @returns {{status: ServiceActivityStatus, detail: string}}
 */
function summarizeServiceActivity({ service, syncStatus, workerSummary }) {
  if (workerSummary.in_progress) {
    const step = workerSummary.last_step?.name ? `: ${workerSummary.last_step.name}` : "";
    return { status: "syncing", detail: `worker is currently syncing${step}` };
  }
  if (String(syncStatus?.health || "").toLowerCase() === "syncing") {
    return { status: "syncing", detail: "sync lock or run active" };
  }
  if (workerSummary.last_cycle) {
    return { status: "idle", detail: `last cycle #${workerSummary.last_cycle.cycle}` };
  }
  if (service.status === "stopped") return { status: "idle", detail: "service stopped" };
  return { status: "idle", detail: "no worker cycle yet" };
}

/**
 * @param {number} ms
 * @returns {string}
 */
function durationText(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * @param {JsonObject | null | undefined} liveProbe
 * @param {number} [nowMs]
 * @param {number} [maxAgeMs]
 * @returns {{status: ServiceFreshnessStatus, detail: string}}
 */
function summarizeServiceFreshness(liveProbe, nowMs = Date.now(), maxAgeMs = DEFAULT_FRESHNESS_MAX_AGE_MS) {
  if (!liveProbe) return { status: "unknown", detail: "no cached live probe" };
  const checkedAtMs = Date.parse(String(liveProbe.checked_at || ""));
  if (!Number.isFinite(checkedAtMs)) {
    return { status: "unknown", detail: "cached live probe has no valid timestamp" };
  }
  const ageMs = Math.max(0, nowMs - checkedAtMs);
  const ageText = `${durationText(ageMs)} ago`;
  if (ageMs > maxAgeMs) return { status: "unknown", detail: `last live probe stale, checked ${ageText}` };
  const status = String(liveProbe.status || "").toLowerCase();
  if (status === "healthy" || liveProbe.ok === true) {
    const missing = liveProbe.missing_count ?? 0;
    const lag = liveProbe.lag_ms === null || liveProbe.lag_ms === undefined ? "unknown" : durationText(liveProbe.lag_ms);
    return { status: "verified", detail: `checked ${ageText}, missing ${missing}, lag ${lag}` };
  }
  if (status === "delayed") {
    const missing = liveProbe.missing_count ?? "?";
    const lag = liveProbe.lag_ms === null || liveProbe.lag_ms === undefined ? "unknown" : durationText(liveProbe.lag_ms);
    return { status: "behind", detail: `checked ${ageText}, missing ${missing}, lag ${lag}` };
  }
  const reason = liveProbe.reason ? `: ${liveProbe.reason}` : "";
  return { status: "unknown", detail: `last live probe ${status || "unavailable"} ${ageText}${reason}` };
}

/**
 * @param {{launchd: JsonObject, syncStatus: JsonObject | null, syncErrorText?: string, workerSummary: JsonObject, liveProbe?: JsonObject | null, nowMs?: number, freshnessMaxAgeMs?: number}} input
 * @returns {ServiceOverview}
 */
function buildServiceOverview({
  launchd,
  syncStatus,
  syncErrorText = "",
  workerSummary,
  liveProbe = null,
  nowMs = Date.now(),
  freshnessMaxAgeMs = DEFAULT_FRESHNESS_MAX_AGE_MS,
}) {
  const service = summarizeServiceRuntime(launchd);
  return {
    service,
    health: summarizeServiceHealth({ service, syncStatus, syncErrorText, workerSummary }),
    activity: summarizeServiceActivity({ service, syncStatus, workerSummary }),
    freshness: summarizeServiceFreshness(liveProbe, nowMs, freshnessMaxAgeMs),
  };
}

/**
 * @param {ServiceStatusOptions} opts
 * @param {ServiceStatusReportDeps} [deps]
 */
function buildServiceStatusReport(opts, deps = {}) {
  const run = deps.runCommand || runCommand;
  const readWorkerLog = deps.readRecentWorkerEvents || readRecentWorkerEvents;
  const summarize = deps.summarizeWorkerEvents || summarizeWorkerEvents;
  const readFreshnessCache = deps.readLiveProbeCache || readLiveProbeCache;
  const nowMs = deps.nowMs || Date.now();
  const launchd = run("launchctl", ["print", opts.target], { allowFailure: true });
  const loaded = launchd.status === 0;
  const launchdState = loaded ? parseLaunchdState(launchd.stdout || "") : {};
  const sync = run(process.execPath, ["scripts/sync-status.mjs", "--format", "json"], { allowFailure: true });
  const syncStatus = parseJsonOutput(sync);
  const workerLog = readWorkerLog(opts.logDir);
  const workerSummary = summarize(workerLog.events, nowMs);
  const workerStability = summarizeWorkerStability(
    workerLog.events,
    nowMs,
    deps.stabilityWindowMs || DEFAULT_STABILITY_WINDOW_MS,
  );
  try {
    workerStability.failures.by_kind = collectRecentFailureKinds(
      opts.db || DEFAULT_DB,
      nowMs,
      deps.stabilityWindowMs || DEFAULT_STABILITY_WINDOW_MS,
      deps,
    ).by_kind;
  } catch {
    workerStability.failures.by_kind = [];
  }
  const liveProbeCachePath = resolve(opts.logDir, "live-probe.json");
  const liveProbe = readFreshnessCache(liveProbeCachePath);
  const serviceState = loaded ? launchdState.state || "loaded" : "not loaded";
  const launchdReport = {
    loaded,
    state: launchdState.state || null,
    pid: launchdState.pid || null,
    last_exit_code: launchdState["last exit code"] || null,
    command_status: launchd.status,
    stderr: launchd.stderr || "",
    stdout: launchd.stdout || "",
  };
  const syncErrorText = syncStatus ? "" : String(sync.stderr || sync.stdout || "sync status unavailable");

  return {
    label: opts.label,
    service_state: serviceState,
    overview: buildServiceOverview({
      launchd: launchdReport,
      syncStatus,
      syncErrorText,
      workerSummary,
      liveProbe,
      nowMs,
      freshnessMaxAgeMs: deps.freshnessMaxAgeMs,
    }),
    launchd: launchdReport,
    sync: {
      status: syncStatus,
      command_status: sync.status,
      error_text: syncErrorText,
    },
    worker: {
      log: workerLog,
      summary: workerSummary,
    },
    stability: workerStability,
    freshness: {
      cache_path: liveProbeCachePath,
      cache: liveProbe,
    },
  };
}

export {
  buildServiceOverview,
  buildServiceStatusReport,
  collectRecentFailureKinds,
  durationText,
  DEFAULT_DB,
  DEFAULT_FRESHNESS_MAX_AGE_MS,
  DEFAULT_STABILITY_WINDOW_MS,
  DEFAULT_WORKER_LOG_MAX_EVENTS,
  DEFAULT_WORKER_LOG_TAIL_BYTES,
  isCatchingUp,
  eventTimeMs,
  parseJsonOutput,
  parseLaunchdState,
  readFileTail,
  readRecentWorkerEvents,
  runCommand,
  sqliteJson,
  summarizeServiceActivity,
  summarizeServiceFreshness,
  summarizeServiceHealth,
  summarizeServiceRuntime,
  summarizeWorkerStability,
};
