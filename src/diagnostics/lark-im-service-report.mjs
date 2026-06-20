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

  return {
    label: opts.label,
    service_state: serviceState,
    launchd: {
      loaded,
      state: launchdState.state || null,
      pid: launchdState.pid || null,
      last_exit_code: launchdState["last exit code"] || null,
      command_status: launchd.status,
      stderr: launchd.stderr || "",
      stdout: launchd.stdout || "",
    },
    sync: {
      status: syncStatus,
      command_status: sync.status,
      error_text: syncStatus ? "" : String(sync.stderr || sync.stdout || "sync status unavailable"),
    },
    worker: {
      log: workerLog,
      summary: workerSummary,
    },
  };
}

export {
  buildServiceStatusReport,
  parseJsonOutput,
  parseLaunchdState,
  readFileTail,
  readRecentWorkerEvents,
  runCommand,
};
