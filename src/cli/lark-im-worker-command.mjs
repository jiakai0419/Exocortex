// @ts-check

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adaptiveFairDecision,
  compactSummary,
  compactTransportStats,
  createAdaptiveFairState,
  mergeTransportCooldowns,
  runCycleWithRunner,
} from "../../dist/runtime/worker/lark-im-worker-core.js";

const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_RECEIVED_SCOPES_PER_CYCLE = 50;
const DEFAULT_HOT_RECEIVED_SCOPES_PER_CYCLE = 20;
const DEFAULT_DISCOVERY_PAGES_PER_CYCLE = 1;
const DEFAULT_HOT_DISCOVERY_PAGES_PER_CYCLE = 5;
const DEFAULT_MAX_CHAT_PAGES = 300;
const DEFAULT_RECONCILE_INTERVAL_HOURS = 24;
const DEFAULT_CHAT_TYPES = "group,p2p";
const DEFAULT_STEP_TIMEOUT_SECONDS = 600;
const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LOG_KEEP_FILES = 5;
const DEFAULT_RETENTION_EVERY_CYCLES = 1440;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SYNC_SCRIPT = resolve(PROJECT_ROOT, "scripts/lark-im-sync.mjs");
const MAINTENANCE_SCRIPT = resolve(PROJECT_ROOT, "scripts/sqlite-maintenance.mjs");
const STEP_OPERATIONS = {
  sent: "message_search_bundle",
  "discover-hot": "chat_discovery_bundle",
  "discover-catchup": "chat_discovery_bundle",
  "discover-reconcile": "chat_discovery_bundle",
  "received-hot": "message_history_bundle",
  "received-fair": "message_history_bundle",
};

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
 * @property {number} stepTimeoutSeconds
 * @property {number} logMaxBytes
 * @property {number} logKeepFiles
 * @property {number} retentionEveryCycles
 * @property {number | null} maxCycles
 * @property {boolean} adaptiveFair
 * @property {number} adaptiveFairMin
 * @property {number} adaptiveFairMax
 * @property {number} adaptiveTargetCycleSeconds
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
 *
 * @typedef {object} SpawnResult
 * @property {number | null} status
 * @property {string} stdout
 * @property {string} stderr
 * @property {Error=} error
 *
 * @typedef {object} RunStepDeps
 * @property {(cmd: string, args: string[], options: JsonObject) => SpawnResult=} spawnSync
 * @property {string=} execPath
 * @property {() => Date=} now
 * @property {number=} timeoutSeconds
 * @property {string=} scriptPath
 * @property {Record<string, number>=} cooldownsByOperation
 * @property {() => number=} nowMs
 *
 * @typedef {object} WriteLogDeps
 * @property {{write(chunk: string): void}=} stdout
 * @property {(path: string, options?: {recursive?: boolean}) => void=} mkdirSync
 * @property {(path: string, data: string, options?: JsonObject) => void=} appendFileSync
 * @property {(path: string) => boolean=} existsSync
 * @property {(path: string) => {size: number}=} statSync
 * @property {(oldPath: string, newPath: string) => void=} renameSync
 * @property {(path: string, options?: JsonObject) => void=} rmSync
 * @property {(path: string, mode: number) => void=} chmodSync
 * @property {(path: string, ...paths: string[]) => string=} resolvePath
 *
 * @typedef {object} RunCycleDeps
 * @property {RunStepDeps=} runStep
 * @property {WriteLogDeps=} writeLog
 * @property {() => string=} now
 * @property {() => number=} nowMs
 * @property {Record<string, number>=} cooldownsByOperation
 * @property {(steps: JsonObject[], payload: JsonObject) => void=} onComplete
 *
 * @typedef {object} RunWorkerDeps
 * @property {(opts: WorkerOptions, cycle: number, deps?: RunCycleDeps) => unknown=} runCycle
 * @property {(seconds: number) => void=} sleepSeconds
 * @property {() => number=} nowMs
 * @property {(opts: WorkerOptions, payload: JsonObject) => void=} writeScheduler
 * @property {Record<string, number>=} cooldownsByOperation
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
  --step-timeout-seconds <n>          Hard timeout for each sync step. Default: ${DEFAULT_STEP_TIMEOUT_SECONDS}
  --log-max-bytes <n>                 Rotate worker.jsonl at this size. Default: ${DEFAULT_LOG_MAX_BYTES}
  --log-keep-files <n>                Rotated worker logs to keep. Default: ${DEFAULT_LOG_KEEP_FILES}
  --retention-every-cycles <n>        Apply run retention every N cycles. Default: ${DEFAULT_RETENTION_EVERY_CYCLES}
  --adaptive-fair                    Adapt fair scope batch size. Off by default; this is not an HTTP rate limiter.
  --adaptive-fair-min <n>            Minimum adaptive fair batch. Default: 10
  --adaptive-fair-max <n>            Maximum adaptive fair batch. Default: 50
  --adaptive-target-cycle-seconds <n> Target work plus interval duration. Default: 90
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
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${name} must be positive integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe positive integer`);
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
    stepTimeoutSeconds: DEFAULT_STEP_TIMEOUT_SECONDS,
    logMaxBytes: DEFAULT_LOG_MAX_BYTES,
    logKeepFiles: DEFAULT_LOG_KEEP_FILES,
    retentionEveryCycles: DEFAULT_RETENTION_EVERY_CYCLES,
    maxCycles: null,
    adaptiveFair: false,
    adaptiveFairMin: 10,
    adaptiveFairMax: 50,
    adaptiveTargetCycleSeconds: 90,
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
    if (arg === "--adaptive-fair") {
      opts.adaptiveFair = true;
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
    else if (arg === "--step-timeout-seconds")
      opts.stepTimeoutSeconds = parsePositiveInt(next, "step-timeout-seconds");
    else if (arg === "--log-max-bytes") opts.logMaxBytes = parsePositiveInt(next, "log-max-bytes");
    else if (arg === "--log-keep-files") opts.logKeepFiles = parsePositiveInt(next, "log-keep-files");
    else if (arg === "--retention-every-cycles")
      opts.retentionEveryCycles = parsePositiveInt(next, "retention-every-cycles");
    else if (arg === "--max-cycles") opts.maxCycles = parsePositiveInt(next, "max-cycles");
    else if (arg === "--adaptive-fair-min") opts.adaptiveFairMin = parsePositiveInt(next, "adaptive-fair-min");
    else if (arg === "--adaptive-fair-max") opts.adaptiveFairMax = parsePositiveInt(next, "adaptive-fair-max");
    else if (arg === "--adaptive-target-cycle-seconds")
      opts.adaptiveTargetCycleSeconds = parsePositiveInt(next, "adaptive-target-cycle-seconds");
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  if (opts.adaptiveFairMin > opts.adaptiveFairMax) throw new Error("adaptive-fair-min must not exceed adaptive-fair-max");
  if (opts.adaptiveFair && (opts.receivedScopesPerCycle < opts.adaptiveFairMin || opts.receivedScopesPerCycle > opts.adaptiveFairMax)) {
    throw new Error("received-scopes-per-cycle must be within adaptive fair bounds");
  }
  if (opts.adaptiveFair && opts.adaptiveTargetCycleSeconds <= opts.intervalSeconds) {
    throw new Error("adaptive-target-cycle-seconds must exceed interval-seconds");
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
 * @param {RunStepDeps} [deps]
 * @returns {WorkerStepResult}
 */
function runStep(name, args, deps = {}) {
  const now = deps.now || (() => new Date());
  const run = deps.spawnSync || spawnSync;
  const execPath = deps.execPath || process.execPath;
  const startedAt = now().toISOString();
  const result = run(execPath, [deps.scriptPath || SYNC_SCRIPT, ...args], {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    timeout: Number(deps.timeoutSeconds || DEFAULT_STEP_TIMEOUT_SECONDS) * 1000,
    killSignal: "SIGKILL",
    ...(deps.cooldownsByOperation !== undefined ? { env: {
      ...process.env,
      EXOCORTEX_LARK_COOLDOWNS_JSON: JSON.stringify(mergeTransportCooldowns(
        deps.cooldownsByOperation, {}, (deps.nowMs || Date.now)(),
      )),
    } } : {}),
  });
  const finishedAt = now().toISOString();
  const stdout = String(result.stdout || "");
  const rawStderr = String(result.stderr || "");
  let errorTransport = null;
  const stderrLines = rawStderr.split("\n").filter((line) => {
    try {
      const event = JSON.parse(line);
      if (event?.type === "lark_transport_summary") {
        errorTransport = compactTransportStats(event.transport);
        return false;
      }
    } catch { /* Ordinary stderr keeps its existing private-log behavior. */ }
    return true;
  });
  const stderr = stderrLines.join("\n") || String(result.error?.message || (result.status === null ? "worker step terminated" : ""));
  /** @type {JsonObject | null} */
  let summary = null;
  try {
    summary = stdout.trim() ? JSON.parse(stdout) : null;
  } catch {
    summary = null;
  }
  const validSummary = Boolean(
    summary &&
    typeof summary === "object" &&
    !Array.isArray(summary) &&
    summary.ok === true,
  );
  const ok = result.status === 0 && validSummary;
  const transport = errorTransport || compactTransportStats(summary?.transport);
  const outputSummary = compactSummary(summary);
  let failureDetail = stderr.trim();
  if (result.status === 0 && !validSummary && !failureDetail) {
    failureDetail = summary && typeof summary === "object"
      ? "worker step reported an unhealthy summary"
      : "worker step returned invalid or empty JSON";
  }
  return {
    name,
    ok,
    exit_code: result.status ?? undefined,
    started_at: startedAt,
    finished_at: finishedAt,
    summary: transport ? { ...(outputSummary || {}), transport } : outputSummary,
    stderr: failureDetail.slice(0, 4000),
  };
}

/**
 * @param {string} path
 * @param {number} incomingBytes
 * @param {number} maxBytes
 * @param {number} keepFiles
 * @param {WriteLogDeps} deps
 */
function rotateLogIfNeeded(path, incomingBytes, maxBytes, keepFiles, deps) {
  const exists = deps.existsSync || existsSync;
  const stat = deps.statSync || statSync;
  if (!exists(path) || Number(stat(path).size || 0) + incomingBytes <= maxBytes) return;
  const rename = deps.renameSync || renameSync;
  const remove = deps.rmSync || rmSync;
  for (let index = keepFiles; index >= 1; index -= 1) {
    const source = index === 1 ? path : `${path}.${index - 1}`;
    const destination = `${path}.${index}`;
    if (!exists(source)) continue;
    if (exists(destination)) remove(destination, { force: true });
    rename(source, destination);
  }
}

/**
 * @param {{logDir?: string, logMaxBytes?: number, logKeepFiles?: number}} opts
 * @param {JsonObject} payload
 * @param {WriteLogDeps} [deps]
 */
function writeLog(opts, payload, deps = {}) {
  const line = `${JSON.stringify(payload)}\n`;
  const stdout = deps.stdout || process.stdout;
  stdout.write(line);
  if (opts.logDir) {
    const resolvePath = deps.resolvePath || resolve;
    const makeDir = deps.mkdirSync || mkdirSync;
    const append = deps.appendFileSync || appendFileSync;
    const chmod = deps.chmodSync || (deps.mkdirSync || deps.appendFileSync ? () => {} : chmodSync);
    const logDir = resolvePath(opts.logDir);
    makeDir(logDir, { recursive: true, mode: 0o700 });
    chmod(logDir, 0o700);
    const logPath = resolvePath(logDir, "worker.jsonl");
    rotateLogIfNeeded(
      logPath,
      Buffer.byteLength(line),
      Number(opts.logMaxBytes || DEFAULT_LOG_MAX_BYTES),
      Number(opts.logKeepFiles || DEFAULT_LOG_KEEP_FILES),
      deps,
    );
    append(logPath, line, { encoding: "utf8", mode: 0o600 });
    chmod(logPath, 0o600);
  }
}

/**
 * @param {WorkerOptions} opts
 * @param {number} cycle
 * @param {RunCycleDeps} [deps]
 */
function runCycle(opts, cycle, deps = {}) {
  const cooldowns = deps.cooldownsByOperation || {};
  const nowMs = deps.nowMs || Date.now;
  return runCycleWithRunner(
    opts,
    cycle,
    (name, args, command) => {
      const startedMs = nowMs();
      const activeCooldowns = mergeTransportCooldowns(cooldowns, {}, startedMs);
      for (const key of Object.keys(cooldowns)) delete cooldowns[key];
      Object.assign(cooldowns, activeCooldowns);
      const operation = STEP_OPERATIONS[/** @type {keyof typeof STEP_OPERATIONS} */ (name)];
      if (operation && cooldowns[operation] > startedMs) {
        const at = new Date(startedMs).toISOString();
        return {
          name,
          ok: false,
          started_at: at,
          finished_at: at,
          summary: {
            ok: false,
            deferred: { reason: "operation_cooldown", operation, retry_at_ms: cooldowns[operation] },
            transport: compactTransportStats({ cooldowns_by_operation: cooldowns }),
          },
          stderr: "worker step deferred until its operation cooldown expires",
        };
      }
      const step = runStep(name, args, {
        ...deps.runStep,
        timeoutSeconds: opts.stepTimeoutSeconds,
        scriptPath: command === "maintenance" ? MAINTENANCE_SCRIPT : SYNC_SCRIPT,
        cooldownsByOperation: cooldowns,
        nowMs,
      });
      const merged = mergeTransportCooldowns(cooldowns, step.summary?.transport?.cooldowns_by_operation, nowMs());
      for (const key of Object.keys(cooldowns)) delete cooldowns[key];
      Object.assign(cooldowns, merged);
      return step;
    },
    (logOpts, payload) => writeLog(logOpts, payload, deps.writeLog),
    deps.now,
    deps.onComplete,
  );
}

/**
 * @param {WorkerOptions} opts
 * @param {RunWorkerDeps} [deps]
 */
function runWorker(opts, deps = {}) {
  const runOneCycle = deps.runCycle || runCycle;
  const sleep = deps.sleepSeconds || sleepSeconds;
  const nowMs = deps.nowMs || Date.now;
  const logScheduler = deps.writeScheduler || writeLog;
  const cooldowns = deps.cooldownsByOperation || {};
  let adaptiveState = createAdaptiveFairState(opts);
  let cycle = 0;
  let ok = true;
  while (opts.maxCycles === null || cycle < opts.maxCycles) {
    cycle += 1;
    const startedMs = nowMs();
    /** @type {JsonObject[] | undefined} */
    let observedSteps;
    const cycleOpts = opts.adaptiveFair ? { ...opts, receivedScopesPerCycle: adaptiveState.batch } : opts;
    const cycleOk = Boolean(runOneCycle(cycleOpts, cycle, {
      cooldownsByOperation: cooldowns,
      nowMs,
      onComplete: (steps) => { observedSteps = steps; },
    }));
    ok = cycleOk && ok;
    if (opts.adaptiveFair) {
      const outcome = adaptiveFairDecision(adaptiveState, {
        ok: cycleOk,
        durationMs: Math.max(0, nowMs() - startedMs),
        steps: observedSteps,
      }, opts);
      adaptiveState = outcome.state;
      logScheduler(cycleOpts, { type: "lark_im_worker_scheduler", cycle, at: new Date(nowMs()).toISOString(), ...outcome.decision });
    }
    if (opts.maxCycles !== null && cycle >= opts.maxCycles) break;
    sleep(opts.intervalSeconds);
  }
  return ok;
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  return runWorker(opts) ? 0 : 2;
}

export {
  main,
  parseArgs,
  parsePositiveInt,
  runCycle,
  runStep,
  runWorker,
  sleepSeconds,
  usage,
  writeLog,
  rotateLogIfNeeded,
};
