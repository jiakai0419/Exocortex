#!/usr/bin/env node

// @ts-check

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import { summarizeWorkerEvents } from "./lib/lark-im-worker-core.mjs";
import { block, compact, kv, list, renderError, section, statusBadge, subtitle, title } from "./lib/terminal.mjs";

const LABEL = "com.exocortex.lark-im-worker";
const DEFAULT_LOG_DIR = "logs/lark-im";
const DEFAULT_MAX_CHAT_PAGES = 300;
const DEFAULT_RECONCILE_INTERVAL_HOURS = 24;

/**
 * @typedef {"install" | "start" | "stop" | "restart" | "status" | "tail" | "uninstall" | string} ServiceCommand
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
 * @property {string} logDir
 * @property {number} lines
 *
 * @typedef {object} RunOptions
 * @property {boolean=} allowFailure
 *
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} WorkerLogTail
 * @property {string} path
 * @property {boolean} exists
 * @property {JsonObject[]} events
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
  --log-dir <path>                    Log directory. Default: ${DEFAULT_LOG_DIR}
  --lines <n>                         Lines for tail. Default: 20
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
    logDir: DEFAULT_LOG_DIR,
    lines: 20,
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
    else if (arg === "--log-dir") opts.logDir = next;
    else if (arg === "--lines") opts.lines = parsePositiveInt(next, "lines");
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
  run("launchctl", ["bootstrap", domain(), plistPath()]);
  run("launchctl", ["kickstart", "-k", target()], { allowFailure: true });
  process.stdout.write(`installed ${LABEL}\n`);
}

function start() {
  if (!existsSync(plistPath())) throw new Error(`plist not found: ${plistPath()}`);
  const boot = run("launchctl", ["bootstrap", domain(), plistPath()], { allowFailure: true });
  if (boot.status !== 0 && !/already bootstrapped|service already loaded/i.test(boot.stderr)) {
    throw new Error(boot.stderr.trim() || "launchctl bootstrap failed");
  }
  run("launchctl", ["kickstart", "-k", target()], { allowFailure: true });
  process.stdout.write(`started ${LABEL}\n`);
}

function stop() {
  run("launchctl", ["bootout", target()], { allowFailure: true });
  process.stdout.write(`stopped ${LABEL}\n`);
}

function uninstall() {
  stop();
  if (existsSync(plistPath())) rmSync(plistPath());
  process.stdout.write(`removed ${plistPath()}\n`);
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
 * @param {SpawnResult} result
 * @returns {JsonObject | null}
 */
function parseJsonOutput(result) {
  try {
    return JSON.parse(result.stdout.trim());
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

/** @param {ServiceOptions} opts */
function status(opts) {
  const launchd = run("launchctl", ["print", target()], { allowFailure: true });
  const loaded = launchd.status === 0;
  const launchdState = loaded ? parseLaunchdState(launchd.stdout) : {};
  const sync = run(process.execPath, ["scripts/sync-status.mjs", "--format", "json"], { allowFailure: true });
  const syncStatus = parseJsonOutput(sync);
  const workerLog = readRecentWorkerEvents(opts.logDir);
  const workerSummary = summarizeWorkerEvents(workerLog.events);
  const serviceState = loaded ? launchdState.state || "loaded" : "not loaded";
  const lines = [
    `${title("Lark IM service")} ${statusBadge(serviceState === "not loaded" ? "not loaded" : serviceState)}`,
    subtitle(LABEL),
    "",
    section("LaunchAgent"),
    kv([
      ["Loaded", loaded ? statusBadge("loaded") : statusBadge("not loaded")],
      ["State", launchdState.state || "unknown"],
      ["PID", launchdState.pid || "none"],
      ["Last exit", launchdState["last exit code"] || "none"],
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
        ["Hot discovery", hotDiscoveryState],
        ["Reconcile", `${reconcileState}, ${syncStatus.reconcile?.cursor?.pages_scanned || 0} pages`],
        ["Locks", syncStatus.locks?.length || 0],
      ]),
    );
  } else {
    lines.push("");
    lines.push(section("Sync"));
    lines.push(`  ${statusBadge("failed")} ${compact(sync.stderr || sync.stdout || "sync status unavailable", 180)}`);
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

  process.stdout.write(`${block(lines)}\n`);
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
