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
 *
 * @typedef {object} ServiceStatusReportDeps
 * @property {(cmd: string, args: string[], options?: {allowFailure?: boolean}) => SpawnResult=} runCommand
 * @property {(logDir: string) => WorkerLogTail=} readRecentWorkerEvents
 * @property {(events: unknown[], nowMs?: number) => JsonObject=} summarizeWorkerEvents
 * @property {number=} nowMs
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
  const lines = readFileTail(path)
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-200);
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
 * @param {JsonObject | null | undefined} liveProbe
 * @returns {{status: ServiceFreshnessStatus, detail: string}}
 */
function summarizeServiceFreshness(liveProbe) {
  if (!liveProbe) return { status: "unknown", detail: "no cached live probe" };
  const status = String(liveProbe.status || "").toLowerCase();
  if (status === "healthy" || liveProbe.ok === true) {
    return { status: "verified", detail: "latest live probe found no missing hot messages" };
  }
  if (status === "delayed") {
    const missing = liveProbe.missing_count ?? "?";
    return { status: "behind", detail: `${missing} remote hot messages missing locally` };
  }
  return { status: "unknown", detail: status || "live probe unavailable" };
}

/**
 * @param {{launchd: JsonObject, syncStatus: JsonObject | null, syncErrorText?: string, workerSummary: JsonObject, liveProbe?: JsonObject | null}} input
 * @returns {ServiceOverview}
 */
function buildServiceOverview({ launchd, syncStatus, syncErrorText = "", workerSummary, liveProbe = null }) {
  const service = summarizeServiceRuntime(launchd);
  return {
    service,
    health: summarizeServiceHealth({ service, syncStatus, syncErrorText, workerSummary }),
    activity: summarizeServiceActivity({ service, syncStatus, workerSummary }),
    freshness: summarizeServiceFreshness(liveProbe),
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
  const launchd = run("launchctl", ["print", opts.target], { allowFailure: true });
  const loaded = launchd.status === 0;
  const launchdState = loaded ? parseLaunchdState(launchd.stdout || "") : {};
  const sync = run(process.execPath, ["scripts/sync-status.mjs", "--format", "json"], { allowFailure: true });
  const syncStatus = parseJsonOutput(sync);
  const workerLog = readWorkerLog(opts.logDir);
  const workerSummary = summarize(workerLog.events, deps.nowMs);
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
  };
}

export {
  buildServiceOverview,
  buildServiceStatusReport,
  isCatchingUp,
  parseJsonOutput,
  parseLaunchdState,
  readFileTail,
  readRecentWorkerEvents,
  runCommand,
  summarizeServiceActivity,
  summarizeServiceFreshness,
  summarizeServiceHealth,
  summarizeServiceRuntime,
};
