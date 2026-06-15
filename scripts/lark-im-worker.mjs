#!/usr/bin/env node

// @ts-check

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  compactSummary,
  runCycleWithRunner,
} from "./lib/lark-im-worker-core.mjs";

const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_RECEIVED_SCOPES_PER_CYCLE = 50;
const DEFAULT_HOT_RECEIVED_SCOPES_PER_CYCLE = 20;
const DEFAULT_DISCOVERY_PAGES_PER_CYCLE = 1;
const DEFAULT_HOT_DISCOVERY_PAGES_PER_CYCLE = 5;
const DEFAULT_MAX_CHAT_PAGES = 300;
const DEFAULT_RECONCILE_INTERVAL_HOURS = 24;
const DEFAULT_CHAT_TYPES = "group,p2p";

/**
 * @typedef {object} WorkerOptions
 * @property {string} db
 * @property {number} intervalSeconds
 * @property {number} receivedScopesPerCycle
 * @property {number} hotReceivedScopesPerCycle
 * @property {number} discoveryPagesPerCycle
 * @property {number} hotDiscoveryPagesPerCycle
 * @property {number} maxChatPages
 * @property {number} reconcileIntervalHours
 * @property {string} chatTypes
 * @property {string} logDir
 * @property {number | null} maxCycles
 *
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} WorkerStepResult
 * @property {string} name
 * @property {boolean} ok
 * @property {number=} exit_code
 * @property {string} started_at
 * @property {string} finished_at
 * @property {JsonObject | null} summary
 * @property {string} stderr
 */

function usage() {
  return `Usage: node scripts/lark-im-worker.mjs [options]

Options:
  --db <path>                         SQLite database path. Default: data/exocortex.sqlite
  --interval-seconds <n>              Sleep between cycles. Default: ${DEFAULT_INTERVAL_SECONDS}
  --hot-received-scopes-per-cycle <n> Recently active received scopes per cycle. Default: ${DEFAULT_HOT_RECEIVED_SCOPES_PER_CYCLE}
  --received-scopes-per-cycle <n>     Catch-up received scopes per cycle. Default: ${DEFAULT_RECEIVED_SCOPES_PER_CYCLE}
  --hot-discovery-pages-per-cycle <n> Recently active discovery pages per cycle. Default: ${DEFAULT_HOT_DISCOVERY_PAGES_PER_CYCLE}
  --discovery-pages-per-cycle <n>     Full discovery pages per cycle. Default: ${DEFAULT_DISCOVERY_PAGES_PER_CYCLE}
  --max-chat-pages <n>                Max full-discovery pages per snapshot. Default: ${DEFAULT_MAX_CHAT_PAGES}
  --reconcile-interval-hours <n>      Minimum hours between full reconcile snapshots. Default: ${DEFAULT_RECONCILE_INTERVAL_HOURS}
  --chat-types <types>                Chat types for received discovery. Default: ${DEFAULT_CHAT_TYPES}
  --log-dir <path>                    JSONL log directory. Default: logs/lark-im
  --max-cycles <n>                    Stop after N cycles. Omit to run forever.
  --once                              Run one cycle and exit.
  --help                              Show this help.
`;
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {WorkerOptions} */
  const opts = {
    db: "data/exocortex.sqlite",
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    receivedScopesPerCycle: DEFAULT_RECEIVED_SCOPES_PER_CYCLE,
    hotReceivedScopesPerCycle: DEFAULT_HOT_RECEIVED_SCOPES_PER_CYCLE,
    discoveryPagesPerCycle: DEFAULT_DISCOVERY_PAGES_PER_CYCLE,
    hotDiscoveryPagesPerCycle: DEFAULT_HOT_DISCOVERY_PAGES_PER_CYCLE,
    maxChatPages: DEFAULT_MAX_CHAT_PAGES,
    reconcileIntervalHours: DEFAULT_RECONCILE_INTERVAL_HOURS,
    chatTypes: DEFAULT_CHAT_TYPES,
    logDir: "logs/lark-im",
    maxCycles: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--once") {
      opts.maxCycles = 1;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--interval-seconds")
      opts.intervalSeconds = parsePositiveInt(next, "interval-seconds");
    else if (arg === "--received-scopes-per-cycle")
      opts.receivedScopesPerCycle = parsePositiveInt(next, "received-scopes-per-cycle");
    else if (arg === "--hot-received-scopes-per-cycle")
      opts.hotReceivedScopesPerCycle = parsePositiveInt(next, "hot-received-scopes-per-cycle");
    else if (arg === "--discovery-pages-per-cycle")
      opts.discoveryPagesPerCycle = parsePositiveInt(next, "discovery-pages-per-cycle");
    else if (arg === "--hot-discovery-pages-per-cycle")
      opts.hotDiscoveryPagesPerCycle = parsePositiveInt(next, "hot-discovery-pages-per-cycle");
    else if (arg === "--max-chat-pages")
      opts.maxChatPages = parsePositiveInt(next, "max-chat-pages");
    else if (arg === "--reconcile-interval-hours")
      opts.reconcileIntervalHours = parsePositiveInt(next, "reconcile-interval-hours");
    else if (arg === "--chat-types") opts.chatTypes = next;
    else if (arg === "--log-dir") opts.logDir = next;
    else if (arg === "--max-cycles") opts.maxCycles = parsePositiveInt(next, "max-cycles");
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  return opts;
}

/** @param {number} seconds */
function sleepSeconds(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

/**
 * @param {string} name
 * @param {string[]} args
 * @returns {WorkerStepResult}
 */
function runStep(name, args) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, ["scripts/lark-im-sync.mjs", ...args], {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  const finishedAt = new Date().toISOString();
  /** @type {JsonObject | null} */
  let summary = null;
  try {
    summary = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  } catch {
    summary = null;
  }
  return {
    name,
    ok: result.status === 0,
    exit_code: result.status ?? undefined,
    started_at: startedAt,
    finished_at: finishedAt,
    summary: compactSummary(summary),
    stderr: result.stderr.trim().slice(0, 4000),
  };
}

/**
 * @param {{logDir?: string}} opts
 * @param {JsonObject} payload
 */
function writeLog(opts, payload) {
  const line = `${JSON.stringify(payload)}\n`;
  process.stdout.write(line);
  if (opts.logDir) {
    const logDir = resolve(opts.logDir);
    mkdirSync(logDir, { recursive: true });
    appendFileSync(resolve(logDir, "worker.jsonl"), line);
  }
}

/**
 * @param {WorkerOptions} opts
 * @param {number} cycle
 */
function runCycle(opts, cycle) {
  return runCycleWithRunner(opts, cycle, runStep, writeLog);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let cycle = 0;
  while (opts.maxCycles === null || cycle < opts.maxCycles) {
    cycle += 1;
    runCycle(opts, cycle);
    if (opts.maxCycles !== null && cycle >= opts.maxCycles) break;
    sleepSeconds(opts.intervalSeconds);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
