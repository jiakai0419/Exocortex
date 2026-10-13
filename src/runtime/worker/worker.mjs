// @ts-check

import { ACTIVITY_GAP_MS, ACTIVITY_GRACE_MS, activityDatabaseKey, createActivityWriter } from "../../diagnostics/lark-im-activity-evidence.mjs";

import { runGuardedWorkerStep } from "./step-process.mjs";
import { parseOptions } from "../../cli/parse-options.mjs";
import { writeLog, rotateLogIfNeeded } from "./log.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { readScheduledRemoteSampleAdmission, readScheduledRemoteCooldowns, runScheduledRemoteSample } from "./remote-sample-scheduler.mjs";
import { selectHistoryTarget } from "../../maintenance/history.mjs";
import {
  adaptiveFairDecision,
  compactHistorySummary,
  compactSummary,
  compactTransportStats,
  createAdaptiveFairState,
  cycleHealthyWithoutHistory,
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
  history: "message_history_bundle",
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
 * @property {number=} elapsed_ms
 * @property {JsonObject | null} summary
 * @property {string} stderr
 * @property {JsonObject=} guardian_diagnostic
 *
 * @typedef {object} SpawnResult
 * @property {number | null} status
 * @property {string} stdout
 * @property {string} stderr
 * @property {Error=} error
 * @property {string | null=} signal
 * @property {JsonObject=} guardian_diagnostic
 *
 * @typedef {object} RunStepDeps
 * @property {(cmd: string, args: string[], options: JsonObject) => SpawnResult=} runProcess
 * @property {string=} execPath
 * @property {() => Date=} now
 * @property {number=} timeoutSeconds
 * @property {string=} scriptPath
 * @property {"sync" | "maintenance"=} command
 * @property {Record<string, number>=} cooldownsByOperation
 * @property {Record<string, string>=} activityEnv
 * @property {() => number=} nowMs
 * @property {() => number=} monotonicNowMs
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
 * @property {() => number=} monotonicNowMs
 * @property {Record<string, number>=} cooldownsByOperation
 * @property {(steps: JsonObject[], payload: JsonObject) => void=} onComplete
 * @property {(steps: JsonObject[], runHistory: (args?: string[]) => JsonObject) => JsonObject|null=} beforeHistory
 *
 * @typedef {object} RunWorkerDeps
 * @property {(opts: WorkerOptions, deps: JsonObject) => JsonObject=} runRemoteSample
 * @property {{run: (deps: JsonObject) => JsonObject, stop: () => void}=} remoteSampleController
 * @property {ReturnType<typeof createActivityWriter>=} activity
 * @property {(opts: WorkerOptions, cycle: number, deps?: RunCycleDeps) => unknown=} runCycle
 * @property {(seconds: number) => void=} sleepSeconds
 * @property {() => number=} nowMs
 * @property {() => number=} monotonicNowMs
 * @property {(opts: WorkerOptions, payload: JsonObject) => void=} writeScheduler
 * @property {Record<string, number>=} cooldownsByOperation
 * @property {(opts: WorkerOptions) => boolean=} hasHistoryWork
 * @property {(opts: WorkerOptions, deps: JsonObject) => JsonObject=} remoteSampleAdmission
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
  const monotonicNow = deps.monotonicNowMs || deps.nowMs || (() => performance.now());
  const run = deps.runProcess || runGuardedWorkerStep;
  const execPath = deps.execPath || process.execPath;
  const startedAt = now().toISOString();
  const startedMonotonic = monotonicNow();
  const result = run(execPath, [deps.scriptPath || CLI_PATH, deps.command || "sync", ...args], {
    maxBuffer: 100 * 1024 * 1024,
    timeout: Number(deps.timeoutSeconds || WORKER_DEFAULTS.stepTimeoutSeconds) * 1000,
    ...(deps.cooldownsByOperation !== undefined || deps.activityEnv ? { env: {
      ...process.env,
      ...deps.activityEnv,
      EXOCORTEX_LARK_COOLDOWNS_JSON: JSON.stringify(mergeTransportCooldowns(
        deps.cooldownsByOperation, {}, (deps.nowMs || Date.now)(),
      )),
    } } : {}),
  });
  const finishedAt = now().toISOString();
  const elapsedMs = Math.max(0, monotonicNow() - startedMonotonic);
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
  const processFailed = Boolean(result.error || result.signal || result.guardian_diagnostic);
  const ok = result.status === 0 && validSummary && !processFailed;
  const partial = result.status === 2 && summary?.ok === false && summary?.partial === true && !processFailed;
  const transport = errorTransport || compactTransportStats(summary?.transport);
  const outputSummary = name === "history" ? compactHistorySummary(summary) : compactSummary(summary);
  let failureDetail = stderr.trim();
  if (result.guardian_diagnostic) {
    const stages = [result.guardian_diagnostic.primary?.stage, result.guardian_diagnostic.cleanup?.stage].filter(Boolean);
    failureDetail = `worker step terminated: ${stages.join(", ")}`;
  }
  if (processFailed && !failureDetail) failureDetail = "worker step terminated with a process error or signal";
  if (!failureDetail && !processFailed && result.status !== 0 && summary?.schema_version === 1 && summary.ok === false &&
      ["invalid_arguments", "execution_failed"].includes(summary.error?.code) && typeof summary.error?.message === "string") {
    failureDetail = summary.error.message.trim();
  }
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
    ...(Number.isFinite(elapsedMs) ? { elapsed_ms: elapsedMs } : {}),
    summary: transport ? { ...(outputSummary || {}), transport } : outputSummary,
    stderr: failureDetail.slice(0, 4000),
    ...(result.guardian_diagnostic ? { guardian_diagnostic: result.guardian_diagnostic } : {}),
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
        monotonicNowMs: deps.monotonicNowMs || deps.nowMs || (() => performance.now()),
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
    deps.beforeHistory,
  );
}

/** Never infer zero from a missing/projected counter. Process failures and
 * incomplete receipts consume their whole reservation and stop this idle slice. */
function trustedIdleBudget(value, cli, self, sample = false) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    (!sample || value.version === 1 && value.complete === true) &&
    value.max_cli_attempts === cli && value.max_self_attempts === self &&
    Number.isSafeInteger(value.cli_attempts) && value.cli_attempts >= 0 && value.cli_attempts <= cli &&
    Number.isSafeInteger(value.self_attempts) && value.self_attempts >= 0 &&
    value.self_attempts <= self && value.self_attempts <= value.cli_attempts);
}

/** Two complete jobs share one in-memory allowance. The sampler keeps its full
 * list contract when it goes first. Only its measured surplus may fund history;
 * history-first never squeezes a legacy sampler into an unproven smaller plan.
 * Waiting ages track first opportunities, not successful work, and survive
 * unserved cycles, not restarts. No extra scheduling loop,
 * persistent budget, API concurrency, or speculative refund is introduced.
 * @param {WorkerOptions} opts
 * @param {number} cycle
 * @param {(args?: string[]) => JsonObject} runHistory
 * @param {{history:number|null,sample:number|null}} waiting
 * @param {JsonObject} deps
 */
function runSharedIdleWork(opts, cycle, runHistory, waiting, deps) {
  const now = deps.nowMs, monotonic = deps.monotonicNowMs;
  const began = monotonic(), startedAt = new Date(now()).toISOString();
  let historyAvailable = true;
  try { historyAvailable = deps.hasHistoryWork(opts) !== false; } catch { /* Child admission remains authoritative. */ }
  const finalCycle = opts.maxCycles !== null && cycle >= opts.maxCycles;
  let admission = { outcome: "disabled" };
  if (!finalCycle && opts.remoteSampleIntervalSeconds !== 0 && deps.sample) {
    try { admission = deps.remoteSampleAdmission(opts, { nowMs: now, cooldownsByOperation: deps.cooldowns }); }
    catch { admission = { outcome: "failed", reason: "scheduler_unavailable", next_due: null }; }
    if (admission.outcome === "failed") deps.onSample(admission);
  }
  const sampleDue = admission.outcome === "due";
  if (!historyAvailable) waiting.history = null;
  else if (waiting.history === null) waiting.history = began;
  if (!sampleDue) waiting.sample = null;
  else if (waiting.sample === null) waiting.sample = began;
  const jobs = [
    ...(sampleDue ? [{ name: "sample", since: waiting.sample }] : []),
    ...(historyAvailable ? [{ name: "history", since: waiting.history }] : []),
  ].sort((a, b) => Number(a.since) - Number(b.since)); // A first-cycle tie keeps the ordinary sample first.
  const duration = Math.max(1000, Math.min(historyAvailable ? 25_000 : 55_000, (opts.intervalSeconds - 5) * 1000));
  const deadline = began + duration;
  let previous = began, cliRemaining = 12, selfRemaining = 6, called = false;
  /** @type {JsonObject|null} */ let historyStep = null;
  const remaining = () => {
    const observed = monotonic();
    if (!Number.isFinite(deadline) || !Number.isFinite(previous) || !Number.isFinite(observed) || observed < previous) return 0;
    previous = observed;
    return Math.max(0, deadline - observed);
  };
  for (const job of jobs) {
    if (remaining() < 1000 || selfRemaining < 2 || cliRemaining < 3) break;
    // No duplicate collector planner: preserve its whole CLI admission contract.
    // A zero-request history race may leave all twelve calls available.
    if (job.name === "sample" && (cliRemaining !== 12 || remaining() < 3000)) continue;
    if (called) {
      if (remaining() <= 1000) break;
      deps.sleepSeconds(1);
      if (remaining() < (job.name === "sample" ? 3000 : 1000)) break;
    }
    const maxCli = cliRemaining, maxSelf = job.name === "sample" ? 2 : selfRemaining;
    // Spending the first opportunity is independent of progress or a valid
    // receipt. A failed job must not keep either peer behind it indefinitely.
    // Surplus-only history keeps its age until it progresses or gets to go first.
    const firstOpportunity = !called;
    // Reserve before spawning. Only a complete, strictly checked receipt refunds.
    cliRemaining -= maxCli; selfRemaining -= maxSelf;
    called = true;
    let receipt;
    if (job.name === "sample") {
      const budgetMs = Math.floor(remaining());
      let sampled;
      if (firstOpportunity) waiting.sample = null;
      try { sampled = deps.sample({ ...opts, maxApiCalls: maxCli, maxSelfCalls: maxSelf,
        remoteSampleBudgetMs: budgetMs }, { nowMs: now, cooldownsByOperation: deps.cooldowns,
        returnReport: true, remainingTimeMs: remaining }); }
      catch { break; }
      deps.onSample(sampled);
      receipt = sampled?.budget_receipt;
      if (!trustedIdleBudget(receipt, maxCli, maxSelf, true)) break;
      cliRemaining += maxCli - receipt.cli_attempts;
      selfRemaining += maxSelf - receipt.self_attempts;
      if (sampled.outcome === "ok") waiting.sample = null;
      if (!["ok", "not_due", "disabled"].includes(sampled.outcome)) break;
    } else {
      const seconds = Math.min(30, Math.floor(remaining() / 1000));
      if (seconds < 1) break;
      if (firstOpportunity) waiting.history = null;
      historyStep = runHistory(["history", "--db", opts.db, ...(opts.logDir ? ["--log-dir", opts.logDir] : []),
        "--max-records", "12", "--max-cli-attempts", String(maxCli), "--max-self-attempts", String(maxSelf),
        "--max-seconds", String(seconds), "--format", "json"]);
      receipt = historyStep?.summary?.request_budget;
      if (historyStep?.guardian_diagnostic || !trustedIdleBudget(receipt, maxCli, maxSelf)) break;
      cliRemaining += maxCli - receipt.cli_attempts;
      selfRemaining += maxSelf - receipt.self_attempts;
      const summary = historyStep.summary;
      if (summary?.outcome === "no_eligible_known_record" ||
          Number(summary?.processed) > 0 && summary?.outcome !== "legacy_required") waiting.history = null;
      // Surplus-only no progress, including ordinary->merge, keeps its next turn.
      if (historyStep.ok !== true || ["sync_busy", "lease_unavailable", "rate_limited", "rate_cooldown",
        "shared_cooldown_unavailable", "clock_unavailable"].includes(receipt.stop_reason)) break;
    }
  }
  const finished = monotonic();
  const elapsed = Number.isFinite(finished) && finished >= began ? finished - began : 0;
  // This logical history/idle step includes the synchronous sample and gap.
  // Its child request_budget.elapsed_ms remains the actual writer duration.
  return { ...(historyStep || { name: "history", ok: true, exit_code: 0, stderr: "",
    summary: { ok: true, profile: "known_record_history/v1", outcome: "batch_deferred", processed: 0,
      cursor_policy: "unchanged", coverage: "known_rows_only" } }),
    started_at: startedAt, finished_at: new Date(now()).toISOString(), elapsed_ms: elapsed };
}

/**
 * @param {WorkerOptions} opts
 * @param {RunWorkerDeps} [deps]
 */
function runWorker(opts, deps = {}) {
  const runOneCycle = deps.runCycle || runCycle;
  const sleep = deps.sleepSeconds || sleepSeconds;
  const nowMs = deps.nowMs || Date.now;
  const monotonicNow = deps.monotonicNowMs || deps.nowMs || (() => performance.now());
  const logScheduler = deps.writeScheduler || writeLog;
  const cooldowns = deps.cooldownsByOperation || {};
  // Injected synthetic cycles never implicitly start real remote work.
  const sampleOpts = { ...opts, remoteSampleBudgetMs: Math.max(1000, Math.min(55_000, (opts.intervalSeconds - 5) * 1000)) };
  const controller = deps.remoteSampleController || null;
  const sample = deps.runRemoteSample || (controller ? (_opts, sampleDeps) => controller.run(sampleDeps) :
    !deps.runCycle ? runScheduledRemoteSample : null);
  const hasHistoryWork = deps.hasHistoryWork || (!deps.runCycle ? candidate => Boolean(selectHistoryTarget(candidate.db)) : () => true);
  const remoteSampleAdmission = deps.remoteSampleAdmission || (!deps.runCycle ? readScheduledRemoteSampleAdmission : () => ({ outcome: "due" }));
  const waiting = { history: /** @type {number|null} */ (null), sample: /** @type {number|null} */ (null) };
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
    const startedMonotonic = monotonicNow();
    if (!deps.runCycle) Object.assign(cooldowns, mergeTransportCooldowns(cooldowns, readScheduledRemoteCooldowns(opts, { nowMs }), startedMs));
    activity?.update("cycle", { cycle, durationMs: ACTIVITY_GAP_MS });
    /** @type {JsonObject[] | undefined} */
    let observedSteps;
    let sampleAttempted = false;
    const onSample = sampled => {
        const merged = mergeTransportCooldowns(cooldowns, sampled.cooldownsByOperation, nowMs());
        for (const key of Object.keys(cooldowns)) delete cooldowns[key];
        Object.assign(cooldowns, merged);
        if (!["not_due", "disabled"].includes(sampled.outcome)) {
          logScheduler(opts, { type: "lark_im_remote_sample_schedule", version: 1, cycle,
            database_key: activityDatabaseKey(opts.db), instance_id: activity?.instanceId || null,
            at: new Date(nowMs()).toISOString(), outcome: sampled.outcome, reason: sampled.reason,
            next_due: sampled.next_due });
        }
    };
    const attemptSample = () => {
      sampleAttempted = true;
      if (!sample || opts.remoteSampleIntervalSeconds === 0) return false;
      try {
        const sampled = sample(sampleOpts, { nowMs, cooldownsByOperation: cooldowns });
        onSample(sampled);
        return sampled.outcome === "started";
      } catch { return false; }
    };
    const cycleOpts = opts.adaptiveFair ? { ...opts, receivedScopesPerCycle: adaptiveState.batch } : opts;
    const cycleOk = runOneCycle(cycleOpts, cycle, {
      cooldownsByOperation: cooldowns,
      activity, activityEnv,
      nowMs,
      monotonicNowMs: monotonicNow,
      onComplete: (steps) => { observedSteps = steps; },
      beforeHistory: (steps, runHistory) => {
        sampleAttempted = true;
        if (!runHistory || !cycleHealthyWithoutHistory(steps, false) ||
            !sample || opts.remoteSampleIntervalSeconds === 0) return null;
        return runSharedIdleWork(opts, cycle, runHistory, waiting, { nowMs, monotonicNowMs: monotonicNow,
          hasHistoryWork, remoteSampleAdmission, sample, cooldowns, onSample, sleepSeconds: sleep });
      },
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
    // History business debt remains in the cycle result but cannot indefinitely
    // suppress independent diagnostics. Their own lease/cooldown gates remain.
    if (!sampleAttempted && cycleHealthyWithoutHistory(observedSteps, cycleOk)) attemptSample();
    if (opts.maxCycles !== null && cycle >= opts.maxCycles) break;
    // History uses idle capacity after forward sync. Credit actual subprocess
    // wall time (including local commits), never the configured remote budget.
    // Unknown/malformed elapsed values earn no credit, and an overrun cannot turn
    // into negative sleep or borrow time from the next forward cycle.
    const historyMs = Math.min(Math.max(0, monotonicNow() - startedMonotonic), (observedSteps || [])
      .filter(step => step.name === "history").reduce((total, step) => {
        return total + (Number.isFinite(step.elapsed_ms) && step.elapsed_ms >= 0 ? step.elapsed_ms : 0);
      }, 0));
    const waitSeconds = Math.max(0, opts.intervalSeconds - historyMs / 1000);
    activity?.update("waiting", { cycle, durationMs: waitSeconds * 1000 + ACTIVITY_GRACE_MS });
    sleep(waitSeconds);
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
