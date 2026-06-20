#!/usr/bin/env node

// @ts-check

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import { summarizeWorkerEvents } from "./lib/lark-im-worker-core.mjs";
import {
  buildServiceStatusReport,
  parseJsonOutput,
  readRecentWorkerEvents,
} from "../src/diagnostics/lark-im-service-report.mjs";
import { renderServiceStatusText } from "../src/terminal/lark-im-service-view.mjs";
import { block, kv, list, renderError, statusBadge, subtitle, title } from "./lib/terminal.mjs";

const LABEL = "com.exocortex.lark-im-worker";
const DEFAULT_LOG_DIR = "logs/lark-im";
const DEFAULT_MAX_CHAT_PAGES = 300;
const DEFAULT_RECONCILE_INTERVAL_HOURS = 24;
const DEFAULT_CHAT_TYPES = "group,p2p";

/**
 * @typedef {"install" | "start" | "stop" | "restart" | "status" | "wait-ok" | "tail" | "uninstall" | string} ServiceCommand
 *
 * @typedef {object} ServiceOptions
 * @property {ServiceCommand} command
 * @property {number} intervalSeconds
 * @property {number} hotReceivedScopesPerCycle
 * @property {number} receivedScopesPerCycle
 * @property {number} hotDiscoveryPagesPerCycle
 * @property {number} discoveryPagesPerCycle
 * @property {number} maxChatPages
 * @property {number} reconcileIntervalHours
 * @property {string} chatTypes
 * @property {string} logDir
 * @property {number} lines
 * @property {number} timeoutSeconds
 * @property {number} pollSeconds
 *
 * @typedef {object} RunOptions
 * @property {boolean=} allowFailure
 *
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {import("node:child_process").SpawnSyncReturns<string>} SpawnResult
 */

function usage() {
  return `Usage: node scripts/lark-im-service.mjs <command> [options]

Commands:
  install     Write LaunchAgent plist and start the worker.
  start       Start the installed LaunchAgent.
  stop        Stop the LaunchAgent but keep the plist.
  restart     Stop, then start.
  status      Show launchd status and sync status.
  wait-ok     Wait until a new complete worker cycle succeeds.
  tail        Show recent worker log lines.
  uninstall   Stop and remove the plist.

Options:
  --interval-seconds <n>              Worker interval. Default: 60
  --hot-received-scopes-per-cycle <n> Recently active received scopes per cycle. Default: 20
  --received-scopes-per-cycle <n>     Catch-up received scopes per cycle. Default: 50
  --hot-discovery-pages-per-cycle <n> Recently active discovery pages per cycle. Default: 5
  --discovery-pages-per-cycle <n>     Full discovery pages per cycle. Default: 1
  --max-chat-pages <n>                Max full-discovery pages per snapshot. Default: ${DEFAULT_MAX_CHAT_PAGES}
  --reconcile-interval-hours <n>      Minimum hours between full reconcile snapshots. Default: ${DEFAULT_RECONCILE_INTERVAL_HOURS}
  --chat-types <types>                Chat types for received discovery. Default: ${DEFAULT_CHAT_TYPES}
  --log-dir <path>                    Log directory. Default: ${DEFAULT_LOG_DIR}
  --lines <n>                         Lines for tail. Default: 20
  --timeout-seconds <n>               Timeout for wait-ok. Default: 180
  --poll-seconds <n>                  Poll interval for wait-ok. Default: 5
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
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    process.exit(0);
  }
  /** @type {ServiceOptions} */
  const opts = {
    command,
    intervalSeconds: 60,
    hotReceivedScopesPerCycle: 20,
    receivedScopesPerCycle: 50,
    hotDiscoveryPagesPerCycle: 5,
    discoveryPagesPerCycle: 1,
    maxChatPages: DEFAULT_MAX_CHAT_PAGES,
    reconcileIntervalHours: DEFAULT_RECONCILE_INTERVAL_HOURS,
    chatTypes: DEFAULT_CHAT_TYPES,
    logDir: DEFAULT_LOG_DIR,
    lines: 20,
    timeoutSeconds: 180,
    pollSeconds: 5,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--interval-seconds") opts.intervalSeconds = parsePositiveInt(next, "interval-seconds");
    else if (arg === "--hot-received-scopes-per-cycle")
      opts.hotReceivedScopesPerCycle = parsePositiveInt(next, "hot-received-scopes-per-cycle");
    else if (arg === "--received-scopes-per-cycle")
      opts.receivedScopesPerCycle = parsePositiveInt(next, "received-scopes-per-cycle");
    else if (arg === "--hot-discovery-pages-per-cycle")
      opts.hotDiscoveryPagesPerCycle = parsePositiveInt(next, "hot-discovery-pages-per-cycle");
    else if (arg === "--discovery-pages-per-cycle")
      opts.discoveryPagesPerCycle = parsePositiveInt(next, "discovery-pages-per-cycle");
    else if (arg === "--max-chat-pages")
      opts.maxChatPages = parsePositiveInt(next, "max-chat-pages");
    else if (arg === "--reconcile-interval-hours")
      opts.reconcileIntervalHours = parsePositiveInt(next, "reconcile-interval-hours");
    else if (arg === "--chat-types") opts.chatTypes = next;
    else if (arg === "--log-dir") opts.logDir = next;
    else if (arg === "--lines") opts.lines = parsePositiveInt(next, "lines");
    else if (arg === "--timeout-seconds") opts.timeoutSeconds = parsePositiveInt(next, "timeout-seconds");
    else if (arg === "--poll-seconds") opts.pollSeconds = parsePositiveInt(next, "poll-seconds");
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  return opts;
}

function uid() {
  return typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
}

function domain() {
  return `gui/${uid()}`;
}

function target() {
  return `${domain()}/${LABEL}`;
}

function plistPath() {
  return resolve(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
}

function launchdPrint() {
  return run("launchctl", ["print", target()], { allowFailure: true });
}

function isLaunchdLoaded() {
  return launchdPrint().status === 0;
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {RunOptions} [options]
 * @returns {SpawnResult}
 */
function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result;
}

/** @param {ServiceOptions} opts */
function plistXml(opts) {
  const cwd = process.cwd();
  const logDir = resolve(opts.logDir);
  const nodePath = process.execPath;
  const workerPath = resolve("scripts/lark-im-worker.mjs");
  const larkCli = run("which", ["lark-cli"], { allowFailure: true }).stdout.trim() || "/opt/homebrew/bin/lark-cli";
  mkdirSync(logDir, { recursive: true });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>WorkingDirectory</key>
  <string>${cwd}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${workerPath}</string>
    <string>--interval-seconds</string>
    <string>${opts.intervalSeconds}</string>
    <string>--received-scopes-per-cycle</string>
    <string>${opts.receivedScopesPerCycle}</string>
    <string>--hot-received-scopes-per-cycle</string>
    <string>${opts.hotReceivedScopesPerCycle}</string>
    <string>--discovery-pages-per-cycle</string>
    <string>${opts.discoveryPagesPerCycle}</string>
    <string>--hot-discovery-pages-per-cycle</string>
    <string>${opts.hotDiscoveryPagesPerCycle}</string>
    <string>--max-chat-pages</string>
    <string>${opts.maxChatPages}</string>
    <string>--reconcile-interval-hours</string>
    <string>${opts.reconcileIntervalHours}</string>
    <string>--chat-types</string>
    <string>${opts.chatTypes}</string>
    <string>--log-dir</string>
    <string>${logDir}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LARK_CLI</key>
    <string>${larkCli}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${resolve(logDir, "launchd.out.log")}</string>
  <key>StandardErrorPath</key>
  <string>${resolve(logDir, "launchd.err.log")}</string>
</dict>
</plist>
`;
}

/** @param {ServiceOptions} opts */
function install(opts) {
  mkdirSync(resolve(homedir(), "Library/LaunchAgents"), { recursive: true });
  writeFileSync(plistPath(), plistXml(opts));
  run("launchctl", ["bootout", target()], { allowFailure: true });
  run("launchctl", ["bootout", domain(), plistPath()], { allowFailure: true });
  run("launchctl", ["bootstrap", domain(), plistPath()]);
  run("launchctl", ["kickstart", "-k", target()], { allowFailure: true });
  process.stdout.write(`installed ${LABEL}\n`);
}

function start() {
  if (!existsSync(plistPath())) throw new Error(`plist not found: ${plistPath()}`);
  if (isLaunchdLoaded()) {
    run("launchctl", ["kickstart", "-k", target()], { allowFailure: true });
    process.stdout.write(`started ${LABEL}\n`);
    return;
  }
  const boot = run("launchctl", ["bootstrap", domain(), plistPath()], { allowFailure: true });
  if (boot.status !== 0 && !isLaunchdLoaded()) {
    throw new Error(boot.stderr.trim() || "launchctl bootstrap failed");
  }
  run("launchctl", ["kickstart", "-k", target()], { allowFailure: true });
  process.stdout.write(`started ${LABEL}\n`);
}

function stop() {
  const attempts = [
    run("launchctl", ["bootout", target()], { allowFailure: true }),
    run("launchctl", ["bootout", domain(), plistPath()], { allowFailure: true }),
  ];
  if (isLaunchdLoaded()) {
    const detail = attempts
      .map((result) => result.stderr.trim() || result.stdout.trim())
      .filter(Boolean)
      .join("; ");
    throw new Error(`failed to stop ${LABEL}: ${detail || "service is still loaded"}`);
  }
  process.stdout.write(`stopped ${LABEL}\n`);
}

function uninstall() {
  stop();
  if (existsSync(plistPath())) rmSync(plistPath());
  process.stdout.write(`removed ${plistPath()}\n`);
}

/** @param {unknown} value */
function localIso(value) {
  if (!value) return "none";
  return new Date(String(value)).toLocaleString();
}

/** @param {number} ms */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @param {unknown} value */
function isReadyHealth(value) {
  return ["fresh", "ok", "ok_with_history"].includes(String(value || "").toLowerCase());
}

/** @param {ServiceOptions} opts */
function status(opts) {
  const report = buildServiceStatusReport({
    label: LABEL,
    target: target(),
    logDir: opts.logDir,
  });
  process.stdout.write(renderServiceStatusText(report));
}

/** @param {ServiceOptions} opts */
function tail(opts) {
  const path = resolve(opts.logDir, "worker.jsonl");
  if (!existsSync(path)) {
    process.stdout.write(`no worker log yet: ${path}\n`);
    return;
  }
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  process.stdout.write(
    `${block([
      `${title("Lark IM worker log")} ${subtitle(`last ${opts.lines} lines`)}`,
      list(lines.slice(-opts.lines).map(formatLogLine), { empty: "  no worker log lines" }),
    ])}\n`,
  );
}

/** @param {ServiceOptions} opts */
function waitOk(opts) {
  const startedAt = Date.now();
  const deadline = startedAt + opts.timeoutSeconds * 1000;
  /** @type {string | null} */
  let lastReason = null;

  while (Date.now() <= deadline) {
    const sync = run(process.execPath, ["scripts/sync-status.mjs", "--format", "json"], { allowFailure: true });
    const syncStatus = parseJsonOutput(sync);
    const workerLog = readRecentWorkerEvents(opts.logDir);
    const workerSummary = summarizeWorkerEvents(workerLog.events);
    const lastCycle = workerSummary.last_cycle;
    const lastCycleAt = lastCycle?.at ? Date.parse(String(lastCycle.at)) : NaN;
    const newOkCycle = lastCycle?.ok === true && Number.isFinite(lastCycleAt) && lastCycleAt >= startedAt;
    const healthReady = syncStatus ? isReadyHealth(syncStatus.health) : false;

    if (lastCycle && newOkCycle && !workerSummary.in_progress && healthReady) {
      process.stdout.write(
        `${block([
          `${title("Lark IM service")} ${statusBadge("ok")}`,
          kv([
            ["Cycle", `#${lastCycle.cycle} ${localIso(lastCycle.at)}`],
            ["Sync", String(syncStatus?.health || "unknown")],
            ["Log", workerLog.exists ? workerLog.path : `${workerLog.path} (missing)`],
          ]),
        ])}\n`,
      );
      return;
    }

    lastReason = [
      `cycle=${workerSummary.last_cycle?.cycle || "none"}`,
      `cycle_ok=${workerSummary.last_cycle?.ok ?? "unknown"}`,
      `cycle_new=${newOkCycle}`,
      `in_progress=${Boolean(workerSummary.in_progress)}`,
      `health=${syncStatus?.health || "unavailable"}`,
    ].join(" ");
    sleepMs(opts.pollSeconds * 1000);
  }

  throw new Error(`wait-ok timed out after ${opts.timeoutSeconds}s: ${lastReason || "no worker state"}`);
}

/** @param {string} line */
function formatLogLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return line;
  }

  if (event.type === "lark_im_worker_cycle") {
    return `${event.at} cycle=${event.cycle} ${event.ok ? statusBadge("ok") : statusBadge("failed")}`;
  }

  if (event.type === "lark_im_worker_step") {
    const summary = event.summary || {};
    const parts = [
      `${event.finished_at || event.started_at} cycle=${event.cycle}`,
      event.name,
      event.ok ? statusBadge("ok") : `${statusBadge("failed")} exit=${event.exit_code}`,
    ];

    if (summary.sent) {
      parts.push(
        `run=${summary.sent.run_id}`,
        `records=${summary.sent.records ?? 0}`,
        `inserted=${summary.sent.inserted ?? 0}`,
      );
    }
    if (summary.discovery) {
      if (summary.discovery.skipped) {
        parts.push(
          statusBadge("skipped"),
          summary.discovery.reason || "skipped",
          `mode=${summary.discovery.mode || "unknown"}`,
          `has_more=${summary.discovery.has_more}`,
        );
      } else {
        parts.push(
          `run=${summary.discovery.run_id}`,
          `mode=${summary.discovery.mode || "unknown"}`,
          `pages=${summary.discovery.pages ?? 0}`,
          `discovered=${summary.discovery.discovered_in_run ?? 0}`,
          `has_more=${summary.discovery.has_more}`,
        );
      }
    }
    if (summary.received) {
      parts.push(
        `scopes=${summary.received.scopes ?? 0}`,
        `records=${summary.received.records ?? 0}`,
        `inserted=${summary.received.inserted ?? 0}`,
        `failed=${summary.received.failed ?? 0}`,
      );
    }
    if (event.stderr) parts.push(`stderr=${event.stderr.slice(0, 240)}`);
    return parts.join(" ");
  }

  return line;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === "install") install(opts);
  else if (opts.command === "start") start();
  else if (opts.command === "stop") stop();
  else if (opts.command === "restart") {
    stop();
    start();
  } else if (opts.command === "status") status(opts);
  else if (opts.command === "wait-ok") waitOk(opts);
  else if (opts.command === "tail") tail(opts);
  else if (opts.command === "uninstall") uninstall();
  else throw new Error(`Unknown command: ${opts.command}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(renderError(error));
  process.exit(1);
}
