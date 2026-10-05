// @ts-check

import { ACTIVITY_GAP_MS, ACTIVITY_GRACE_MS, activityDatabaseKey, createActivityWriter } from "../../diagnostics/lark-im-activity-evidence.mjs";

import { spawnSync } from "node:child_process";
import { parseOptions } from "../../cli/parse-options.mjs";
import { writeLog, rotateLogIfNeeded } from "./log.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRemoteSampleController, readScheduledRemoteCooldowns } from "./remote-sample-scheduler.mjs";
import {
  adaptiveFairDecision,
  compactSummary,
  compactTransportStats,
  createAdaptiveFairState,
  mergeTransportCooldowns,
  runCycleWithRunner,
} from "../../../dist/runtime/worker/lark-im-worker-core.js";

import {
  WORKER_DEFAULTS,
  WORKER_OPTION_SPECS,
  resolveWorkerPaths,
  validateWorkerOptions,
} from "./options.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI_PATH = resolve(PROJECT_ROOT, "bin/exocortex.mjs");
const STEP_OPERATIONS = {
  sent: "message_search_bundle",
  "discover-hot": "chat_discovery_bundle",
  "discover-catchup": "chat_discovery_bundle",
  "discover-reconcile": "chat_discovery_bundle",
  "received-hot": "message_history_bundle",
  "received-fair": "message_history_bundle",
};

/**
 * @typedef {import("./options.mjs").WorkerSettings & {
 *   db: string, maxCycles: number | null, help?: boolean,
 * }} WorkerOptions
 *
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} WorkerStepResult
 * @property {string} name
 * @property {boolean} ok
 * @property {boolean=} partial
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
 * @property {string | null=} signal
 *
 * @typedef {object} RunStepDeps
 * @property {(cmd: string, args: string[], options: JsonObject) => SpawnResult=} spawnSync
 * @property {string=} execPath
 * @property {() => Date=} now
 * @property {number=} timeoutSeconds
 * @property {string=} scriptPath
 * @property {"sync" | "maintenance"=} command
 * @property {Record<string, number>=} cooldownsByOperation
 * @property {Record<string, string>=} activityEnv
 * @property {() => number=} nowMs
 *
 * @typedef {import("./log.mjs").WriteLogDeps} WriteLogDeps
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
 * @property {(opts: WorkerOptions, deps: JsonObject) => JsonObject=} runRemoteSample
 * @property {{run: (deps: JsonObject) => JsonObject, stop: () => void}=} remoteSampleController
 * @property {ReturnType<typeof createActivityWriter>=} activity
 * @property {(opts: WorkerOptions, cycle: number, deps?: RunCycleDeps) => unknown=} runCycle
 * @property {(seconds: number) => void=} sleepSeconds
 * @property {() => number=} nowMs
 * @property {(opts: WorkerOptions, payload: JsonObject) => void=} writeScheduler
 * @property {Record<string, number>=} cooldownsByOperation
 */

function usage() {
  return `Usage: node src/runtime/worker/main.mjs [options]\n\nInternal worker options:\n${WORKER_OPTION_SPECS.map((spec) =>
    `  ${spec.flag}${spec.type === "boolean" ? "" : " <value>"}  ${spec.description} Default: ${spec.default}`).join("\n")}\n  --once  Run one cycle and exit.\n  --max-cycles <n>  Stop after N cycles.\n  --help  Show this help.\n`;
}

/** @param {string[]} argv @returns {WorkerOptions} */
function parseArgs(argv) {
  const lifetime = [
    { flag: "--once", key: "once", type: "boolean" },
    { flag: "--max-cycles", key: "maxCycles", type: "integer" },
  ];
  const parsed = parseOptions(argv, [...WORKER_OPTION_SPECS, ...lifetime], { resolvePaths: false });
  const opts = /** @type {WorkerOptions} */ ({ ...parsed.options, maxCycles: null });
  // Distinct foreground lifetime options keep their last-occurring choice.
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--once") opts.maxCycles = 1;
    else if (argv[i] === "--max-cycles") opts.maxCycles = parsed.options.maxCycles;
  }
  if (parsed.help) return { ...opts, help: true };
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
  const result = run(execPath, [deps.scriptPath || CLI_PATH, deps.command || "sync", ...args], {
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
  const processFailed = Boolean(result.error || result.signal);
  const ok = result.status === 0 && validSummary && !processFailed;
  const partial = result.status === 2 && summary?.ok === false && summary?.partial === true && !processFailed;
  const transport = errorTransport || compactTransportStats(summary?.transport);
  const outputSummary = compactSummary(summary);
  let failureDetail = stderr.trim();
  if (processFailed && !failureDetail) failureDetail = "worker step terminated with a process error or signal";
  if (result.status === 0 && !validSummary && !failureDetail) {
    failureDetail = summary && typeof summary === "object"
      ? "worker step reported an unhealthy summary"
      : "worker step returned invalid or empty JSON";
  }
  return {
    name,
    ok,
    ...(partial ? { partial: true } : {}),
    exit_code: result.status ?? undefined,
    started_at: startedAt,
    finished_at: finishedAt,
    summary: transport ? { ...(outputSummary || {}), transport } : outputSummary,
    stderr: failureDetail.slice(0, 4000),
  };
}

/**
 * @param {WorkerOptions} opts
 * @param {number} cycle
 * @param {RunCycleDeps} [deps]
 */
function runCycle(opts, cycle, deps = {}) {
  const cooldowns = deps.cooldownsByOperation || {};
  const nowMs = deps.nowMs || Date.now;
  const databaseKey = activityDatabaseKey(opts.db);
  let databaseStable = databaseKey !== null;
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
        command: command || "sync",
        cooldownsByOperation: cooldowns,
        nowMs,
      });
      deps.activity?.update("between_steps", { cycle, durationMs: ACTIVITY_GAP_MS });
      const merged = mergeTransportCooldowns(cooldowns, step.summary?.transport?.cooldowns_by_operation, nowMs());
      for (const key of Object.keys(cooldowns)) delete cooldowns[key];
      Object.assign(cooldowns, merged);
      return step;
    },
    (logOpts, payload) => {
      databaseStable = databaseStable && activityDatabaseKey(opts.db) === databaseKey;
      writeLog(logOpts, { ...payload, version: 1, instance_id: deps.activity?.instanceId || null,
        database_key: databaseStable ? databaseKey : null }, deps.writeLog);
    },
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
  // Injected synthetic cycles never implicitly start real remote work.
  const controller = deps.remoteSampleController || (!deps.runCycle && !deps.runRemoteSample ? createRemoteSampleController(opts) : null);
  const sample = deps.runRemoteSample || (controller ? (_opts, sampleDeps) => controller.run(sampleDeps) : null);
  if (!deps.runCycle) Object.assign(cooldowns, mergeTransportCooldowns(cooldowns, readScheduledRemoteCooldowns(opts, { nowMs }), nowMs()));
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
    if (!deps.runCycle) Object.assign(cooldowns, mergeTransportCooldowns(cooldowns, readScheduledRemoteCooldowns(opts, { nowMs }), startedMs));
    activity?.update("cycle", { cycle, durationMs: ACTIVITY_GAP_MS });
    /** @type {JsonObject[] | undefined} */
    let observedSteps;
    const cycleOpts = opts.adaptiveFair ? { ...opts, receivedScopesPerCycle: adaptiveState.batch } : opts;
    const cycleOk = runOneCycle(cycleOpts, cycle, {
      cooldownsByOperation: cooldowns,
      activity, activityEnv,
      nowMs,
      onComplete: (steps) => { observedSteps = steps; },
    }) === true;
    ok = cycleOk && ok;
    if (opts.adaptiveFair) {
      const outcome = adaptiveFairDecision(adaptiveState, {
        ok: cycleOk,
        durationMs: Math.max(0, nowMs() - startedMs),
        steps: observedSteps,
      }, opts);
      adaptiveState = outcome.state;
      logScheduler(cycleOpts, { type: "lark_im_worker_scheduler", version: 1, instance_id: activity?.instanceId || null,
        database_key: activityDatabaseKey(opts.db), cycle, at: new Date(nowMs()).toISOString(), ...outcome.decision });
    }
    if (cycleOk && sample && opts.remoteSampleIntervalSeconds !== 0) {
      try {
        const sampled = sample(opts, { nowMs, cooldownsByOperation: cooldowns });
        const merged = mergeTransportCooldowns(cooldowns, sampled.cooldownsByOperation, nowMs());
        for (const key of Object.keys(cooldowns)) delete cooldowns[key];
        Object.assign(cooldowns, merged);
        if (!["not_due", "disabled"].includes(sampled.outcome)) {
          logScheduler(opts, { type: "lark_im_remote_sample_schedule", version: 1, cycle,
            database_key: activityDatabaseKey(opts.db), instance_id: activity?.instanceId || null,
            at: new Date(nowMs()).toISOString(), outcome: sampled.outcome, reason: sampled.reason,
            next_due: sampled.next_due });
        }
      } catch { /* Diagnostic collection/logging cannot change sync success. */ }
    }
    if (opts.maxCycles !== null && cycle >= opts.maxCycles) break;
    activity?.update("waiting", { cycle, durationMs: opts.intervalSeconds * 1000 + ACTIVITY_GRACE_MS });
    sleep(opts.intervalSeconds);
  }
  return ok;
  } finally { controller?.stop(); activity?.update("stopped", { cycle }); }
}

/** Internal execution policy: root defaults and explicit cwd-relative paths. */
function main(argv = process.argv.slice(2), context = {}) {
  let opts = parseArgs(argv);
  if (opts.help) { (context.stdout || process.stdout).write(usage()); return 0; }
  const provided = new Set(argv.filter((arg) => arg.startsWith("--")));
  opts = resolveWorkerPaths(opts, { root: context.root || PROJECT_ROOT,
    cwd: context.cwd || process.cwd(), provided });
  return (context.runWorker || runWorker)(opts) ? 0 : 2;
}

export {
  main,
  parseArgs,
  runCycle,
  runStep,
  runWorker,
  sleepSeconds,
  usage,
  writeLog,
  rotateLogIfNeeded,
};
