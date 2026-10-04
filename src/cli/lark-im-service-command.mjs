// @ts-check

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeWorkerEvents } from "../../dist/runtime/worker/lark-im-worker-core.js";
import {
  WORKER_DEFAULTS,
  applyWorkerOption,
  parsePositiveInt,
  validateWorkerOptions,
  workerProgramArguments,
} from "../../dist/runtime/worker/lark-im-worker-options.js";
import {
  buildServiceStatusReport,
  classifyLaunchdPrint,
  parseJsonOutput,
  readRecentWorkerEvents,
} from "../diagnostics/lark-im-service-report.mjs";
import { renderServiceStatusText } from "../terminal/lark-im-service-view.mjs";
import {
  block,
  kv,
  list,
  renderError,
  statusBadge,
  subtitle,
  title,
} from "../../dist/terminal/index.js";

const LABEL = "com.exocortex.lark-im-worker";
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SYNC_STATUS_SCRIPT = resolve(PROJECT_ROOT, "scripts/sync-status.mjs");

/**
 * @typedef {"install" | "start" | "stop" | "restart" | "status" | "wait-ok" | "tail" | "uninstall" | string} ServiceCommand
 *
 * @typedef {import("../../dist/runtime/worker/lark-im-worker-options.js").WorkerSettings & {
 *   command: ServiceCommand, db?: string, lines: number, timeoutSeconds: number, pollSeconds: number,
 * }} ServiceOptions
 *
 * @typedef {object} RunOptions
 * @property {boolean=} allowFailure
 *
 * @typedef {object} SpawnResult
 * @property {number | null} status
 * @property {string} stdout
 * @property {string} stderr
 * @property {Error=} error
 * @property {NodeJS.Signals | null=} signal
 *
 * @typedef {object} PlistXmlDeps
 * @property {string=} cwd
 * @property {string=} logDir
 * @property {string=} nodePath
 * @property {string=} workerPath
 * @property {string=} larkCli
 * @property {(path: string, options?: {recursive?: boolean}) => void=} mkdirSync
 * @property {(cmd: string, args: string[], options?: RunOptions) => SpawnResult=} run
 * @property {(path: string, ...paths: string[]) => string=} resolvePath
 *
 * @typedef {object} WaitOkEvaluation
 * @property {boolean} ready
 * @property {boolean} newOkCycle
 * @property {boolean} healthReady
 * @property {string} reason
 *
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} ServiceCommandDeps
 * @property {(cmd: string, args: string[], options?: RunOptions) => SpawnResult=} run
 * @property {(cmd: string, args: string[], options?: JsonObject) => SpawnResult=} spawnSync
 * @property {(path: string) => boolean=} existsSync
 * @property {(path: string, options?: {recursive?: boolean}) => void=} mkdirSync
 * @property {(path: string, encoding: BufferEncoding) => string=} readFileSync
 * @property {(path: string, options?: {force?: boolean}) => void=} rmSync
 * @property {(oldPath: string, newPath: string) => void=} renameSync
 * @property {(path: string) => {mode: number}=} statSync
 * @property {(path: string, data: string, options?: JsonObject) => void=} writeFileSync
 * @property {(path: string, mode: number) => void=} chmodSync
 * @property {() => string=} homedir
 * @property {() => {uid: number}=} userInfo
 * @property {() => number=} uid
 * @property {string=} cwd
 * @property {string=} execPath
 * @property {(path: string, ...paths: string[]) => string=} resolvePath
 * @property {{write(text: string): unknown}=} stdout
 * @property {{write(text: string): unknown}=} stderr
 * @property {(ms: number) => void=} sleepMs
 * @property {() => number=} nowMs
 * @property {(opts: {label: string, target: string, logDir: string}) => JsonObject=} buildServiceStatusReport
 * @property {(report: JsonObject) => string=} renderServiceStatusText
 * @property {(result: SpawnResult | {stdout?: string}) => JsonObject | null=} parseJsonOutput
 * @property {(logDir: string) => {path: string, exists: boolean, events: JsonObject[]}=} readRecentWorkerEvents
 * @property {(events: JsonObject[], nowMs?: number) => JsonObject=} summarizeWorkerEvents
 * @property {(error: unknown) => string=} renderError
 * @property {string=} larkCli
 * @property {string=} logDir
 * @property {string=} nodePath
 * @property {string=} workerPath
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
  --db <path>                        Database for status/wait-ok only. Default: data/exocortex.sqlite
  --interval-seconds <n>              Worker interval. Default: ${WORKER_DEFAULTS.intervalSeconds}
  --hot-received-scopes-per-cycle <n> Recently active received scopes per cycle. Default: ${WORKER_DEFAULTS.hotReceivedScopesPerCycle}
  --received-scopes-per-cycle <n>     Catch-up received scopes per cycle. Default: ${WORKER_DEFAULTS.receivedScopesPerCycle}
  --hot-discovery-pages-per-cycle <n> Recently active discovery pages per cycle. Default: ${WORKER_DEFAULTS.hotDiscoveryPagesPerCycle}
  --discovery-pages-per-cycle <n>     Full discovery pages per cycle. Default: ${WORKER_DEFAULTS.discoveryPagesPerCycle}
  --max-chat-pages <n>                Max full-discovery pages per snapshot. Default: ${WORKER_DEFAULTS.maxChatPages}
  --reconcile-interval-hours <n>      Minimum hours between full reconcile snapshots. Default: ${WORKER_DEFAULTS.reconcileIntervalHours}
  --chat-types <types>                Chat types for received discovery. Default: ${WORKER_DEFAULTS.chatTypes}
  --log-dir <path>                    Log directory. Default: ${WORKER_DEFAULTS.logDir}
  --lines <n>                         Lines for tail. Default: 20
  --timeout-seconds <n>               Timeout for wait-ok. Default: 180
  --poll-seconds <n>                  Poll interval for wait-ok. Default: 5
  --step-timeout-seconds <n>          Hard timeout for each sync step. Default: ${WORKER_DEFAULTS.stepTimeoutSeconds}
  --log-max-bytes <n>                 Rotate worker.jsonl at this size. Default: ${WORKER_DEFAULTS.logMaxBytes}
  --log-keep-files <n>                Rotated worker logs to keep. Default: ${WORKER_DEFAULTS.logKeepFiles}
  --retention-every-cycles <n>        Apply run retention every N cycles. Default: ${WORKER_DEFAULTS.retentionEveryCycles}
  --adaptive-fair                    Adapt fair scope batch size. Off by default; persisted by install.
  --adaptive-fair-min <n>            Minimum adaptive fair batch. Default: ${WORKER_DEFAULTS.adaptiveFairMin}
  --adaptive-fair-max <n>            Maximum adaptive fair batch. Default: ${WORKER_DEFAULTS.adaptiveFairMax}
  --adaptive-target-cycle-seconds <n> Target work plus interval duration. Default: ${WORKER_DEFAULTS.adaptiveTargetCycleSeconds}
  --help                              Show this help.

Worker tuning is persisted by install; start/restart use the installed plist.
--once and --max-cycles are available only for the foreground worker.
`;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    process.exit(0);
  }
  /** @type {ServiceOptions} */
  const opts = { ...WORKER_DEFAULTS, command, lines: 20, timeoutSeconds: 180, pollSeconds: 5 };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--once" || arg === "--max-cycles") {
      throw new Error(`${arg} is supported by the foreground worker only`);
    }
    const consumed = applyWorkerOption(opts, arg, rest[i + 1]);
    if (consumed) {
      i += consumed - 1;
      continue;
    }
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--lines") opts.lines = parsePositiveInt(next, "lines");
    else if (arg === "--timeout-seconds") opts.timeoutSeconds = parsePositiveInt(next, "timeout-seconds");
    else if (arg === "--poll-seconds") opts.pollSeconds = parsePositiveInt(next, "poll-seconds");
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  validateWorkerOptions(opts);
  if (opts.db && !["status", "wait-ok"].includes(opts.command)) throw new Error("--db is supported only for status and wait-ok");
  return opts;
}

/** @param {ServiceCommandDeps} [deps] */
function uid(deps = {}) {
  if (deps.uid) return deps.uid();
  return typeof process.getuid === "function" ? process.getuid() : (deps.userInfo || userInfo)().uid;
}

/** @param {ServiceCommandDeps} [deps] */
function domain(deps = {}) {
  return `gui/${uid(deps)}`;
}

/** @param {ServiceCommandDeps} [deps] */
function target(deps = {}) {
  return `${domain(deps)}/${LABEL}`;
}

/** @param {ServiceCommandDeps} [deps] */
function plistPath(deps = {}) {
  const resolvePath = deps.resolvePath || resolve;
  const home = (deps.homedir || homedir)();
  return resolvePath(home, "Library/LaunchAgents", `${LABEL}.plist`);
}

/** @param {ServiceCommandDeps} [deps] */
function launchdPrint(deps = {}) {
  return run("launchctl", ["print", target(deps)], { allowFailure: true }, deps);
}

/** @param {ServiceCommandDeps} [deps] */
function isLaunchdLoaded(deps = {}) {
  const result = launchdPrint(deps);
  const inspection = classifyLaunchdPrint(result);
  if (inspection === "unknown") {
    const detail = result.error?.message || result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(`cannot inspect ${LABEL}: launchctl print failed: ${detail}`);
  }
  return inspection === "loaded";
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {RunOptions} [options]
 * @param {ServiceCommandDeps} [deps]
 * @returns {SpawnResult}
 */
function run(cmd, args, options = {}, deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  const result = deps.run ? deps.run(cmd, args, options) : spawn(cmd, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  const normalized = {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error,
    signal: result.signal,
  };
  if ((normalized.status !== 0 || normalized.error || normalized.signal) && !options.allowFailure) {
    const detail = normalized.error?.message || normalized.stderr.trim() || normalized.stdout.trim() || `exit ${normalized.status}`;
    throw new Error(`${cmd} failed: ${detail}`);
  }
  return normalized;
}

/** @param {unknown} value */
function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * @param {ServiceOptions} opts
 * @param {PlistXmlDeps & ServiceCommandDeps} [deps]
 */
function plistXml(opts, deps = {}) {
  const resolvePath = deps.resolvePath || resolve;
  const cwd = deps.cwd || PROJECT_ROOT;
  const logDir = deps.logDir || resolvePath(cwd, opts.logDir);
  const nodePath = deps.nodePath || process.execPath;
  const workerPath = deps.workerPath || resolvePath(PROJECT_ROOT, "scripts/lark-im-worker.mjs");
  const runCommand = deps.run || ((cmd, args, options) => run(cmd, args, options, deps));
  const larkCli =
    (deps.larkCli || runCommand("which", ["lark-cli"], { allowFailure: true }).stdout.trim()) ||
    "/opt/homebrew/bin/lark-cli";
  const makeDir = deps.mkdirSync || mkdirSync;
  makeDir(logDir, { recursive: true });
  const chmod = deps.chmodSync || (deps.mkdirSync ? () => {} : chmodSync);
  chmod(logDir, 0o700);
  const escaped = Object.fromEntries(
    Object.entries({
      label: LABEL,
      cwd,
      larkCli,
      stderrPath: resolvePath(logDir, "launchd.err.log"),
    }).map(([key, value]) => [key, xmlEscape(value)]),
  );
  const argumentsXml = [nodePath, workerPath, ...workerProgramArguments({ ...opts, logDir })]
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escaped.label}</string>
  <key>WorkingDirectory</key>
  <string>${escaped.cwd}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LARK_CLI</key>
    <string>${escaped.larkCli}</string>
  </dict>
  <key>Umask</key>
  <integer>63</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>${escaped.stderrPath}</string>
</dict>
</plist>
`;
}

/**
 * @param {ServiceOptions} opts
 * @param {ServiceCommandDeps} [deps]
 */
function install(opts, deps = {}) {
  const resolvePath = deps.resolvePath || resolve;
  const makeDir = deps.mkdirSync || mkdirSync;
  const writeFile = deps.writeFileSync || writeFileSync;
  const readFile = deps.readFileSync || readFileSync;
  const exists = deps.existsSync || existsSync;
  const rename = deps.renameSync || renameSync;
  const remove = deps.rmSync || rmSync;
  const stat = deps.statSync || statSync;
  const chmod = deps.chmodSync || chmodSync;
  const output = deps.stdout || process.stdout;
  const path = plistPath(deps);
  // Capture both independent pieces of state before changing either. An
  // installed but stopped plist must remain stopped after a failed install.
  const previouslyLoaded = isLaunchdLoaded(deps);
  const previousPlist = exists(path) ? readFile(path, "utf8") : null;
  if (previouslyLoaded && previousPlist === null) {
    throw new Error("cannot replace loaded service without its previous plist");
  }
  const previousMode = previousPlist === null ? 0o600 : stat(path).mode & 0o777;
  const quietDeps = { ...deps, stdout: { write() {} } };
  const tempPath = `${path}.tmp-${process.pid}`;
  makeDir(resolvePath((deps.homedir || homedir)(), "Library/LaunchAgents"), { recursive: true });
  const xml = plistXml(opts, deps);
  try {
    writeFile(tempPath, xml, { encoding: "utf8", mode: 0o600 });
    chmod(tempPath, 0o600);
    run("plutil", ["-lint", tempPath], {}, deps);
  } catch (error) {
    try { remove(tempPath, { force: true }); }
    catch {
      const original = error instanceof Error ? error.message : "plist validation failed";
      throw new Error(`${original}; staging cleanup failed`);
    }
    throw error;
  }
  let installError = null;
  try {
    if (previouslyLoaded) stop(quietDeps);
    rename(tempPath, path);
    chmod(path, 0o600);
    const logDir = deps.logDir || resolvePath(deps.cwd || PROJECT_ROOT, opts.logDir);
    for (const name of ["worker.jsonl", "launchd.out.log", "launchd.err.log"]) {
      const logPath = resolvePath(logDir, name);
      if (exists(logPath)) chmod(logPath, 0o600);
    }
    run("launchctl", ["bootstrap", domain(deps), path], {}, deps);
    run("launchctl", ["kickstart", "-k", target(deps)], {}, deps);
  } catch (error) {
    const failures = [];
    let unloaded = false;
    try {
      stop(quietDeps);
      unloaded = true;
    } catch { failures.push("could not confirm replacement service unloaded"); }
    let fileRestored = false;
    try {
      if (previousPlist === null) remove(path, { force: true });
      else {
        writeFile(tempPath, previousPlist, { encoding: "utf8", mode: previousMode });
        chmod(tempPath, previousMode);
        rename(tempPath, path);
      }
      fileRestored = true;
    } catch { failures.push("could not restore previous plist"); }
    // Never bootstrap over a possibly loaded replacement. A successful print
    // is required after restoring the old job; file restoration alone is not
    // evidence that launchd is using that file.
    if (previouslyLoaded && unloaded && fileRestored) {
      try {
        run("launchctl", ["bootstrap", domain(deps), path], {}, deps);
        run("launchctl", ["kickstart", "-k", target(deps)], {}, deps);
        if (!isLaunchdLoaded(deps)) throw new Error("previous service remains unloaded");
      } catch { failures.push("could not restore previous loaded service"); }
    }
    const original = error instanceof Error ? error.message : "install failed";
    installError = failures.length ? new Error(`${original}; rollback incomplete: ${failures.join("; ")}`) : error;
  }
  try { remove(tempPath, { force: true }); }
  catch {
    const original = installError instanceof Error ? installError.message : installError ? "install failed" : "service installed";
    throw new Error(`${original}; staging cleanup failed`);
  }
  if (installError) throw installError;
  output.write(`installed ${LABEL}\n`);
}

/** @param {ServiceCommandDeps} [deps] */
function start(deps = {}) {
  const exists = deps.existsSync || existsSync;
  const output = deps.stdout || process.stdout;
  if (!exists(plistPath(deps))) throw new Error(`plist not found: ${plistPath(deps)}`);
  if (isLaunchdLoaded(deps)) {
    run("launchctl", ["kickstart", "-k", target(deps)], {}, deps);
    output.write(`start requested ${LABEL}\n`);
    return;
  }
  const boot = run("launchctl", ["bootstrap", domain(deps), plistPath(deps)], { allowFailure: true }, deps);
  if ((boot.status !== 0 || boot.error || boot.signal) && !isLaunchdLoaded(deps)) {
    throw new Error(boot.error?.message || boot.stderr.trim() || "launchctl bootstrap failed");
  }
  run("launchctl", ["kickstart", "-k", target(deps)], {}, deps);
  output.write(`start requested ${LABEL}\n`);
}

/** @param {ServiceCommandDeps} [deps] */
function stop(deps = {}) {
  const output = deps.stdout || process.stdout;
  if (!isLaunchdLoaded(deps)) {
    output.write(`stopped ${LABEL}\n`);
    return;
  }
  const attempts = [
    run("launchctl", ["bootout", target(deps)], { allowFailure: true }, deps),
    run("launchctl", ["bootout", domain(deps), plistPath(deps)], { allowFailure: true }, deps),
  ];
  if (isLaunchdLoaded(deps)) {
    const detail = attempts
      .map((result) => result.stderr.trim() || result.stdout.trim())
      .filter(Boolean)
      .join("; ");
    throw new Error(`failed to stop ${LABEL}: ${detail || "service is still loaded"}`);
  }
  output.write(`stopped ${LABEL}\n`);
}

/** @param {ServiceCommandDeps} [deps] */
function uninstall(deps = {}) {
  const exists = deps.existsSync || existsSync;
  const remove = deps.rmSync || rmSync;
  const output = deps.stdout || process.stdout;
  stop(deps);
  if (exists(plistPath(deps))) remove(plistPath(deps));
  output.write(`removed ${plistPath(deps)}\n`);
}

/** @param {unknown} value */
function localIso(value) {
  if (!value) return "none";
  return new Date(String(value)).toLocaleString();
}

/** @param {number} ms */
function sleepMilliseconds(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @param {unknown} value */
function isReadyHealth(value) {
  return ["fresh", "ok", "ok_with_history"].includes(String(value || "").toLowerCase());
}

/**
 * @param {number} startedAt
 * @param {JsonObject | null} syncStatus
 * @param {JsonObject} workerSummary
 * @returns {WaitOkEvaluation}
 */
function evaluateWaitOkState(startedAt, syncStatus, workerSummary) {
  const lastCycle = workerSummary.last_cycle;
  const lastCycleAt = lastCycle?.at ? Date.parse(String(lastCycle.at)) : NaN;
  const newOkCycle = lastCycle?.ok === true && Number.isFinite(lastCycleAt) && lastCycleAt >= startedAt;
  const healthReady = syncStatus ? isReadyHealth(syncStatus.health) &&
    !(Number(syncStatus.details?.pending_count || 0) > 0) : false;
  const ready = Boolean(lastCycle && newOkCycle && !workerSummary.in_progress && !workerSummary.unfinished_cycle && healthReady);
  const reason = [
    `cycle=${workerSummary.last_cycle?.cycle || "none"}`,
    `cycle_ok=${workerSummary.last_cycle?.ok ?? "unknown"}`,
    `cycle_new=${newOkCycle}`,
    `in_progress=${Boolean(workerSummary.in_progress)}`,
    `unfinished_cycle=${Boolean(workerSummary.unfinished_cycle)}`,
    `health=${syncStatus?.health || "unavailable"}`,
  ].join(" ");
  return { ready, newOkCycle, healthReady, reason };
}

/**
 * @param {ServiceOptions} opts
 * @param {ServiceCommandDeps} [deps]
 */
function status(opts, deps = {}) {
  const buildReport = deps.buildServiceStatusReport || buildServiceStatusReport;
  const renderText = deps.renderServiceStatusText || renderServiceStatusText;
  const output = deps.stdout || process.stdout;
  const report = buildReport({
    label: LABEL,
    target: target(deps),
    logDir: opts.logDir,
    db: opts.db,
  });
  output.write(renderText(report));
  return report;
}

/**
 * @param {ServiceOptions} opts
 * @param {ServiceCommandDeps} [deps]
 */
function tail(opts, deps = {}) {
  const resolvePath = deps.resolvePath || resolve;
  const exists = deps.existsSync || existsSync;
  const readFile = deps.readFileSync || readFileSync;
  const output = deps.stdout || process.stdout;
  const path = resolvePath(opts.logDir, "worker.jsonl");
  if (!exists(path)) {
    output.write(`no worker log yet: ${basename(path)}\n`);
    return;
  }
  const lines = readFile(path, "utf8").trim().split("\n").filter(Boolean);
  output.write(
    `${block([
      `${title("Lark IM worker log")} ${subtitle(`last ${opts.lines} lines`)}`,
      list(lines.slice(-opts.lines).map(formatLogLine), { empty: "  no worker log lines" }),
    ])}\n`,
  );
}

/**
 * @param {ServiceOptions} opts
 * @param {ServiceCommandDeps} [deps]
 */
function waitOk(opts, deps = {}) {
  const nowMs = deps.nowMs || Date.now;
  const sleepMs = deps.sleepMs || sleepMilliseconds;
  const parseJson = deps.parseJsonOutput || parseJsonOutput;
  const readWorkerEvents = deps.readRecentWorkerEvents || readRecentWorkerEvents;
  const summarize = deps.summarizeWorkerEvents || summarizeWorkerEvents;
  const output = deps.stdout || process.stdout;
  const execPath = deps.execPath || process.execPath;
  const startedAt = nowMs();
  const deadline = startedAt + opts.timeoutSeconds * 1000;
  /** @type {string | null} */
  let lastReason = null;

  while (nowMs() <= deadline) {
    const sync = run(execPath, [SYNC_STATUS_SCRIPT, "--db", opts.db || "data/exocortex.sqlite", "--format", "json"], { allowFailure: true }, deps);
    const syncStatus = sync.status === 0 && !sync.error && !sync.signal ? parseJson(sync) : null;
    const workerLog = readWorkerEvents(opts.logDir);
    const workerSummary = summarize(workerLog.events, nowMs());
    const lastCycle = workerSummary.last_cycle;
    const evaluation = evaluateWaitOkState(startedAt, syncStatus, workerSummary);

    if (lastCycle && evaluation.ready) {
      output.write(
        `${block([
          `${title("Lark IM service")} ${statusBadge("ok")}`,
          kv([
            ["Cycle", `#${lastCycle.cycle} ${localIso(lastCycle.at)}`],
            ["Sync", String(syncStatus?.health || "unknown")],
            ["Log", workerLog.exists ? basename(workerLog.path) : `${basename(workerLog.path)} (missing)`],
          ]),
        ])}\n`,
      );
      return;
    }

    lastReason = evaluation.reason;
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

/**
 * @param {ServiceOptions} opts
 * @param {ServiceCommandDeps} [deps]
 */
function runServiceCommand(opts, deps = {}) {
  if (opts.command === "install") install(opts, deps);
  else if (opts.command === "start") start(deps);
  else if (opts.command === "stop") stop(deps);
  else if (opts.command === "restart") {
    stop(deps);
    start(deps);
  } else if (opts.command === "status") return status(opts, deps);
  else if (opts.command === "wait-ok") waitOk(opts, deps);
  else if (opts.command === "tail") tail(opts, deps);
  else if (opts.command === "uninstall") uninstall(deps);
  else throw new Error(`Unknown command: ${opts.command}`);
}

/**
 * @param {string[]} [argv]
 * @param {ServiceCommandDeps} [deps]
 */
function main(argv = process.argv.slice(2), deps = {}) {
  const opts = parseArgs(argv);
  return runServiceCommand(opts, deps);
}

/**
 * @param {string[]} argv
 * @param {ServiceCommandDeps} [deps]
 */
function runLarkImServiceCli(argv, deps = {}) {
  try {
    const result = main(argv, deps);
    if (result?.overview?.service?.status === "stopped" || result?.overview?.health?.status === "problem") {
      return 2;
    }
    return 0;
  } catch (error) {
    const render = deps.renderError || renderError;
    const stderr = deps.stderr || process.stderr;
    stderr.write(render(error));
    return 1;
  }
}

export {
  domain,
  evaluateWaitOkState,
  formatLogLine,
  install,
  isLaunchdLoaded,
  isReadyHealth,
  main,
  parseArgs,
  parsePositiveInt,
  plistPath,
  plistXml,
  run,
  runLarkImServiceCli,
  runServiceCommand,
  start,
  status,
  stop,
  tail,
  target,
  uid,
  uninstall,
  usage,
  waitOk,
  xmlEscape,
};
