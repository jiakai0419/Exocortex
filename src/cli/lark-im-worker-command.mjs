// @ts-check

import { ACTIVITY_GAP_MS, ACTIVITY_GRACE_MS, createActivityWriter } from "../diagnostics/lark-im-activity-evidence.mjs";

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

import {
  WORKER_DEFAULTS,
  applyWorkerOption,
  parsePositiveInt,
  validateWorkerOptions,
} from "../../dist/runtime/worker/lark-im-worker-options.js";

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
 * @typedef {import("../../dist/runtime/worker/lark-im-worker-options.js").WorkerSettings & {
 *   db: string, maxCycles: number | null,
 * }} WorkerOptions
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
 * @property {Record<string, string>=} activityEnv
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
 * @property {ReturnType<typeof createActivityWriter>=} activity
 * @property {Record<string, string>=} activityEnv
 * @property {RunStepDeps=} runStep
 * @property {WriteLogDeps=} writeLog
 * @property {() => string=} now
 * @property {() => number=} nowMs
 * @property {Record<string, number>=} cooldownsByOperation
 * @property {(steps: JsonObject[], payload: JsonObject) => void=} onComplete
 *
 * @typedef {object} RunWorkerDeps
 * @property {ReturnType<typeof createActivityWriter>=} activity
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
  --interval-seconds <n>              Sleep between cycles. Default: ${WORKER_DEFAULTS.intervalSeconds}
  --hot-received-scopes-per-cycle <n> Recently active received scopes per cycle. Default: ${WORKER_DEFAULTS.hotReceivedScopesPerCycle}
  --received-scopes-per-cycle <n>     Catch-up received scopes per cycle. Default: ${WORKER_DEFAULTS.receivedScopesPerCycle}
  --hot-discovery-pages-per-cycle <n> Recently active discovery pages per cycle. Default: ${WORKER_DEFAULTS.hotDiscoveryPagesPerCycle}
  --discovery-pages-per-cycle <n>     Full discovery pages per cycle. Default: ${WORKER_DEFAULTS.discoveryPagesPerCycle}
  --max-chat-pages <n>                Max full-discovery pages per snapshot. Default: ${WORKER_DEFAULTS.maxChatPages}
  --reconcile-interval-hours <n>      Minimum hours between full reconcile snapshots. Default: ${WORKER_DEFAULTS.reconcileIntervalHours}
  --chat-types <types>                Chat types for received discovery. Default: ${WORKER_DEFAULTS.chatTypes}
  --log-dir <path>                    JSONL log directory. Default: ${WORKER_DEFAULTS.logDir}
  --step-timeout-seconds <n>          Hard timeout for each sync step. Default: ${WORKER_DEFAULTS.stepTimeoutSeconds}
  --log-max-bytes <n>                 Rotate worker.jsonl at this size. Default: ${WORKER_DEFAULTS.logMaxBytes}
  --log-keep-files <n>                Rotated worker logs to keep. Default: ${WORKER_DEFAULTS.logKeepFiles}
  --retention-every-cycles <n>        Apply run retention every N cycles. Default: ${WORKER_DEFAULTS.retentionEveryCycles}
  --adaptive-fair                    Adapt fair scope batch size. Off by default; this is not an HTTP rate limiter.
  --adaptive-fair-min <n>            Minimum adaptive fair batch. Default: ${WORKER_DEFAULTS.adaptiveFairMin}
  --adaptive-fair-max <n>            Maximum adaptive fair batch. Default: ${WORKER_DEFAULTS.adaptiveFairMax}
  --adaptive-target-cycle-seconds <n> Target work plus interval duration. Default: ${WORKER_DEFAULTS.adaptiveTargetCycleSeconds}
  --max-cycles <n>                    Stop after N cycles. Omit to run forever.
  --once                              Run one cycle and exit.
  --help                              Show this help.
`;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {WorkerOptions} */
  const opts = { ...WORKER_DEFAULTS, db: "data/exocortex.sqlite", maxCycles: null };
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
    const consumed = applyWorkerOption(opts, arg, argv[i + 1]);
    if (consumed) {
      i += consumed - 1;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--max-cycles") opts.maxCycles = parsePositiveInt(next, "max-cycles");
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  validateWorkerOptions(opts);
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
  const now = deps.now || (() => new Date((deps.nowMs || Date.now)()));
  const run = deps.spawnSync || spawnSync;
  const execPath = deps.execPath || process.execPath;
  const startedAt = now().toISOString();
  const result = run(execPath, [deps.scriptPath || SYNC_SCRIPT, ...args], {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    timeout: Number(deps.timeoutSeconds || WORKER_DEFAULTS.stepTimeoutSeconds) * 1000,
    killSignal: "SIGKILL",
    ...(deps.cooldownsByOperation !== undefined || deps.activityEnv ? { env: {
      ...process.env,
      ...deps.activityEnv,
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
      Number(opts.logMaxBytes || WORKER_DEFAULTS.logMaxBytes),
      Number(opts.logKeepFiles || WORKER_DEFAULTS.logKeepFiles),
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
      deps.activity?.update("step", { cycle, step: name, durationMs: opts.stepTimeoutSeconds * 1000 + ACTIVITY_GRACE_MS });
      const step = runStep(name, args, {
        ...deps.runStep,
        activityEnv: deps.activityEnv,
        timeoutSeconds: opts.stepTimeoutSeconds,
        scriptPath: command === "maintenance" ? MAINTENANCE_SCRIPT : SYNC_SCRIPT,
        cooldownsByOperation: cooldowns,
        nowMs,
      });
      deps.activity?.update("between_steps", { cycle, durationMs: ACTIVITY_GAP_MS });
      const merged = mergeTransportCooldowns(cooldowns, step.summary?.transport?.cooldowns_by_operation, nowMs());
      for (const key of Object.keys(cooldowns)) delete cooldowns[key];
      Object.assign(cooldowns, merged);
      return step;
    },
    (logOpts, payload) => writeLog(logOpts, payload, deps.writeLog),
    deps.now || (() => new Date(nowMs()).toISOString()),
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
  const activity = deps.activity || (!deps.runCycle ? createActivityWriter({ db: opts.db, role: "worker", now: nowMs,
    emit: (event) => writeLog(opts, event, { stdout: { write() {} } }), }) : undefined);
  const activityEnv = activity ? { EXOCORTEX_ACTIVITY_PARENT: activity.instanceId, EXOCORTEX_ACTIVITY_LOG_DIR: resolve(opts.logDir),
    EXOCORTEX_ACTIVITY_STEP_TIMEOUT_MS: String(opts.stepTimeoutSeconds * 1000) } : undefined;
  let adaptiveState = createAdaptiveFairState(opts);
  let cycle = 0;
  let ok = true;
  try {
  while (opts.maxCycles === null || cycle < opts.maxCycles) {
    cycle += 1;
    const startedMs = nowMs();
    activity?.update("cycle", { cycle, durationMs: ACTIVITY_GAP_MS });
    /** @type {JsonObject[] | undefined} */
    let observedSteps;
    const cycleOpts = opts.adaptiveFair ? { ...opts, receivedScopesPerCycle: adaptiveState.batch } : opts;
    const cycleOk = Boolean(runOneCycle(cycleOpts, cycle, {
      cooldownsByOperation: cooldowns,
      activity, activityEnv,
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
    activity?.update("waiting", { cycle, durationMs: opts.intervalSeconds * 1000 + ACTIVITY_GRACE_MS });
    sleep(opts.intervalSeconds);
  }
  return ok;
  } finally { activity?.update("stopped", { cycle }); }
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
