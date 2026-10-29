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
import { resourceWorkAvailable } from "../../maintenance/resource-work.mjs";
import { readIdleFairState, claimIdleLane } from "./idle-fair-state.mjs";
import { readOnlySqliteJson } from "../../storage/sqlite/readonly-query.mjs";
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
// Existing runGuardedWorkerStep outer cleanup allowance; reserve it inside idle work.
const IDLE_CHILD_CLEANUP_MS = 2000;
const IDLE_LANES = ["sample", "history", "resources"];
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
 * @property {number=} timeoutMs
 * @property {(() => number)=} remainingTimeMs
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
 * @property {(steps: JsonObject[], runHistory: (args?: string[], limits?: {timeoutMs?:number,remainingTimeMs?:()=>number}) => JsonObject) => JsonObject|null=} beforeHistory
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
 * @property {(opts: WorkerOptions, hintDeps?: JsonObject) => boolean=} hasHistoryWork
 * @property {(opts: WorkerOptions, hintDeps?: JsonObject) => boolean=} hasResourceWork
 * @property {(args: string[], limits: JsonObject) => JsonObject=} runResources
 * @property {((db: string, deps?: JsonObject) => JsonObject|null)=} readIdleFairState
 * @property {((db: string, state: JsonObject, lane: string, eligible: string[], deps?: JsonObject) => JsonObject|null)=} claimIdleLane
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
  const configuredTimeout = Number(deps.timeoutMs ?? Number(deps.timeoutSeconds || WORKER_DEFAULTS.stepTimeoutSeconds) * 1000);
  const liveRemaining = deps.remainingTimeMs ? deps.remainingTimeMs() : Infinity;
  const timeout = Math.min(configuredTimeout, liveRemaining - (deps.remainingTimeMs ? IDLE_CHILD_CLEANUP_MS : 0));
  const result = Number.isFinite(timeout) && timeout > 0 ? run(execPath, [deps.scriptPath || CLI_PATH, deps.command || "sync", ...args], {
    maxBuffer: 100 * 1024 * 1024,
    timeout: Math.floor(timeout),
    ...(deps.cooldownsByOperation !== undefined || deps.activityEnv ? { env: {
      ...process.env,
      ...deps.activityEnv,
      EXOCORTEX_LARK_COOLDOWNS_JSON: JSON.stringify(mergeTransportCooldowns(
        deps.cooldownsByOperation, {}, (deps.nowMs || Date.now)(),
      )),
    } } : {}),
  }) : { status: null, stdout: "", stderr: "worker step idle deadline elapsed" };
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
  const outputSummary = name === "history" ? compactHistorySummary(summary) :
    name === "resources" ? compactResourceSummary(summary) : compactSummary(summary);
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
    (name, args, command, limits = {}) => {
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
      deps.activity?.update("step", { cycle, step: name, durationMs: (limits.timeoutMs ?? opts.stepTimeoutSeconds * 1000) + ACTIVITY_GRACE_MS });
      const step = runStep(name, args, {
        ...deps.runStep,
        activityEnv: deps.activityEnv,
        timeoutSeconds: opts.stepTimeoutSeconds,
        ...limits,
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

const RESOURCE_OUTCOMES = new Set(["processed", "no_eligible_known_resource", "batch_deferred", "blocked",
  "exhausted", "source_changed", "clock_unavailable", "execution_failed"]);
const IDLE_STOP_REASONS = new Set(["cli_budget", "self_budget", "time_budget", "clock_unavailable", "sync_busy",
  "lease_unavailable", "rate_cooldown", "rate_limited", "shared_cooldown_unavailable"]);

/** A resource child never inherits the generic sync projection, which may expose
 * target identifiers. Missing counters remain missing, never fabricated zeros. */
function compactResourceSummary(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  const result = { ok: summary.ok === true };
  if (summary.profile === "known_record_resources/v1") result.profile = summary.profile;
  if (RESOURCE_OUTCOMES.has(summary.outcome)) result.outcome = summary.outcome;
  for (const field of ["processed", "available", "deferred", "blocked"]) {
    if (Number.isSafeInteger(summary[field]) && summary[field] >= 0) result[field] = summary[field];
  }
  const budget = summary.request_budget;
  if (budget && typeof budget === "object" && !Array.isArray(budget)) {
    result.request_budget = Object.fromEntries(["max_cli_attempts", "cli_attempts", "max_self_attempts", "self_attempts",
      "max_seconds", "min_interval_ms", "elapsed_ms"].filter(field => Number.isSafeInteger(budget[field]) && budget[field] >= 0)
      .map(field => [field, budget[field]]));
    if (typeof budget.complete === "boolean") result.request_budget.complete = budget.complete;
    if (budget.stop_reason === null || IDLE_STOP_REASONS.has(budget.stop_reason)) result.request_budget.stop_reason = budget.stop_reason;
  }
  return result;
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

/** Three optional lanes share a single allowance. Persist only first-service
 * order; surplus work cannot erase a lane's next first opportunity. A claimed
 * failed attempt still rotates. Metadata lease/CAS failure is not a service.
 * @param {WorkerOptions} opts
 * @param {number} cycle
 * @param {(args?: string[], limits?: {timeoutMs?:number,remainingTimeMs?:()=>number}) => JsonObject} runHistory
 * @param {JsonObject} deps
 */
function runSharedIdleWork(opts, cycle, runHistory, deps) {
  const now = deps.nowMs, monotonic = deps.monotonicNowMs;
  const began = monotonic(), startedAt = new Date(now()).toISOString();
  // Hints are charged from began; preserve the existing sampler-only allowance.
  let deadline = began + Math.max(1000, Math.min(55_000, (opts.intervalSeconds - 5) * 1000));
  let previous = began, clockFailed = !Number.isFinite(began), cliRemaining = 12, selfRemaining = 6, called = false;
  /** @type {JsonObject|null} */ let historyStep = null;
  /** @type {JsonObject|null} */ let resourceStep = null;
  let idleOutcome = "completed";
  const remaining = () => {
    if (clockFailed) return 0;
    const observed = monotonic();
    if (!Number.isFinite(deadline) || !Number.isFinite(observed) || observed < previous) {
      clockFailed = true; return 0;
    }
    previous = observed;
    return Math.max(0, deadline - observed);
  };
  let historyAvailable = true, resourcesAvailable = false;
  // Bound all default local hints together, including a multi-query history
  // selection; no single hint may use its legacy independent 30-second timeout.
  const hintDeadline = Math.min(deadline, began + 2000);
  const hintDeps = { sqliteJson: (db, sql, label, queryDeps = {}) => {
    const left = Math.floor(Math.min(remaining(), hintDeadline - previous));
    if (left < 1) throw new Error("idle hint deadline elapsed");
    const rows = readOnlySqliteJson(db, sql, label, { timeoutMs: Math.min(left, queryDeps.timeoutMs || 1000) });
    if (remaining() === 0 || previous >= hintDeadline) throw new Error("idle hint deadline elapsed");
    return rows;
  } };
  if (deps.runResources && remaining() > 0) {
    try { resourcesAvailable = deps.hasResourceWork(opts, hintDeps) === true; } catch { /* An unknown queue cannot become eligible. */ }
  }
  if (remaining() > 0) {
    try { historyAvailable = deps.hasHistoryWork(opts, hintDeps) !== false; } catch { /* Child admission remains authoritative. */ }
  }
  deadline = began + Math.max(1000, Math.min(historyAvailable || resourcesAvailable ? 25_000 : 55_000,
    (opts.intervalSeconds - 5) * 1000));
  const finalCycle = opts.maxCycles !== null && cycle >= opts.maxCycles;
  let admission = { outcome: "disabled" };
  if (!finalCycle && opts.remoteSampleIntervalSeconds !== 0 && deps.sample) {
    try { admission = deps.remoteSampleAdmission(opts, { nowMs: now, cooldownsByOperation: deps.cooldowns }); }
    catch { admission = { outcome: "failed", reason: "scheduler_unavailable", next_due: null }; }
    if (admission.outcome === "failed") deps.onSample(admission);
  }
  // Three producer seconds are necessary for its two fixed request gaps. Give
  // the wrapper four seconds so ordinary local preparation/flooring does not
  // immediately turn that into two; the producer still rechecks before claim.
  const minimumMs = lane => lane === "resources" ? 6000 : 3000;
  const eligible = [...(admission.outcome === "due" ? ["sample"] : []),
    ...(historyAvailable ? ["history"] : []), ...(resourcesAvailable ? ["resources"] : [])]
    .filter(lane => remaining() >= minimumMs(lane));
  let state = null;
  if (eligible.length && remaining() >= 3000) {
    try { state = deps.readFair(opts.db, { nowMs: now, monotonicNowMs: monotonic, monotonicDeadlineMs: deadline }); }
    catch { /* Untrusted scheduling state admits no optional child. */ }
  }
  if (eligible.length && !state) idleOutcome = "state_unavailable";
  const jobs = state ? eligible.slice().sort((a, b) => state.last_served[a] - state.last_served[b] ||
    IDLE_LANES.indexOf(a) - IDLE_LANES.indexOf(b)) : [];
  for (const name of jobs) {
    if (remaining() < 3000 || selfRemaining < 2 || cliRemaining < 3) break;
    if (remaining() < minimumMs(name)) continue;
    // Preserve the existing sampler's indivisible full call-plan admission.
    if (name === "sample" && cliRemaining !== 12) continue;
    if (called) {
      if (remaining() < minimumMs(name) + 1000) continue;
      deps.sleepSeconds(1);
      if (remaining() < minimumMs(name)) continue;
    }
    if (!called) {
      let claimed = null;
      const beforeClaim = remaining();
      const claimEligible = eligible.filter(lane => beforeClaim >= minimumMs(lane));
      if (!claimEligible.includes(name)) continue;
      try { claimed = deps.claimFair(opts.db, state, name, claimEligible,
        { nowMs: now, monotonicNowMs: monotonic, monotonicDeadlineMs: deadline - minimumMs(name) }); }
      catch { /* A failed/uncertain CAS cannot admit optional work. */ }
      if (!claimed) { idleOutcome = "state_unavailable"; break; }
      state = claimed;
    }
    // Re-read after metadata I/O, then reserve before spawning the complete job.
    const availableMs = Math.floor(remaining());
    if (availableMs < minimumMs(name)) { idleOutcome = "admission_expired"; break; }
    const maxCli = name === "resources" ? 3 : cliRemaining;
    const maxSelf = name === "history" ? selfRemaining : 2;
    cliRemaining -= maxCli; selfRemaining -= maxSelf;
    called = true;
    let receipt;
    if (name === "sample") {
      let sampled;
      try { sampled = deps.sample({ ...opts, maxApiCalls: maxCli, maxSelfCalls: maxSelf,
        remoteSampleBudgetMs: availableMs }, { nowMs: now, cooldownsByOperation: deps.cooldowns,
        returnReport: true, remainingTimeMs: remaining }); }
      catch { idleOutcome = "untrusted_result"; break; }
      deps.onSample(sampled);
      receipt = sampled?.budget_receipt;
      if (!trustedIdleBudget(receipt, maxCli, maxSelf, true)) { idleOutcome = "untrusted_result"; break; }
      cliRemaining += maxCli - receipt.cli_attempts;
      selfRemaining += maxSelf - receipt.self_attempts;
      if (!["ok", "not_due", "disabled"].includes(sampled.outcome)) break;
    } else {
      const timeoutMs = availableMs - IDLE_CHILD_CLEANUP_MS;
      const seconds = Math.min(30, Math.floor(timeoutMs / 1000));
      if (seconds < 1) break;
      const limits = { timeoutMs, remainingTimeMs: remaining };
      let step;
      try {
        step = name === "resources" ? deps.runResources(["resources", "--db", opts.db,
          "--max-cli-attempts", String(maxCli), "--max-self-attempts", String(maxSelf),
          "--max-seconds", String(seconds), "--format", "json"], limits) :
          runHistory(["history", "--db", opts.db, ...(opts.logDir ? ["--log-dir", opts.logDir] : []),
            "--max-records", "12", "--max-cli-attempts", String(maxCli), "--max-self-attempts", String(maxSelf),
            "--max-seconds", String(seconds), "--format", "json"], limits);
      } catch { idleOutcome = "untrusted_result"; break; }
      if (name === "resources") resourceStep = step; else historyStep = step;
      receipt = step?.summary?.request_budget;
      const validResource = name !== "resources" || step?.summary?.profile === "known_record_resources/v1" &&
        RESOURCE_OUTCOMES.has(step.summary.outcome) && receipt?.complete === true && receipt.max_seconds === seconds &&
        receipt.min_interval_ms === 1000 && Number.isSafeInteger(receipt.elapsed_ms) && receipt.elapsed_ms >= 0 &&
        (receipt.stop_reason === null || IDLE_STOP_REASONS.has(receipt.stop_reason)) &&
        ["processed", "available", "deferred", "blocked"].every(field => Number.isSafeInteger(step.summary[field]) && step.summary[field] >= 0);
      if (step?.guardian_diagnostic || !trustedIdleBudget(receipt, maxCli, maxSelf) || !validResource) {
        idleOutcome = "untrusted_result"; break;
      }
      cliRemaining += maxCli - receipt.cli_attempts;
      selfRemaining += maxSelf - receipt.self_attempts;
      if (step.ok !== true || ["sync_busy", "lease_unavailable", "rate_limited", "rate_cooldown",
        "shared_cooldown_unavailable", "clock_unavailable"].includes(receipt.stop_reason)) break;
    }
    if (remaining() === 0) break;
  }
  const finished = monotonic();
  if (!Number.isFinite(finished) || finished < previous) clockFailed = true;
  const elapsed = Number.isFinite(finished) && finished >= began ? finished - began : 0;
  const base = historyStep || { name: "history", ok: true, exit_code: 0, stderr: "",
    summary: { ok: true, profile: "known_record_history/v1", outcome: "batch_deferred", processed: 0,
      cursor_policy: "unchanged", coverage: "known_rows_only" } };
  // Keep the established logical history/idle event; nested resource projection
  // is already finite and contains no target-specific fields.
  return { ...base, summary: { ...base.summary,
    idle_outcome: clockFailed ? "clock_unavailable" : idleOutcome,
    ...(resourceStep ? { resources: compactResourceSummary(resourceStep.summary) } : {}) },
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
  const hasHistoryWork = deps.hasHistoryWork || (!deps.runCycle ? (candidate, hintDeps) => Boolean(selectHistoryTarget(candidate.db, hintDeps)) : () => true);
  const remoteSampleAdmission = deps.remoteSampleAdmission || (!deps.runCycle ? readScheduledRemoteSampleAdmission : () => ({ outcome: "due" }));
  const runResources = deps.runResources || (!deps.runCycle ? (args, limits) => runStep("resources", args, {
    command: "maintenance", nowMs, monotonicNowMs: monotonicNow, cooldownsByOperation: cooldowns, ...limits,
  }) : null);
  const hasResourceWork = deps.hasResourceWork || (!deps.runCycle ? (candidate, hintDeps) => resourceWorkAvailable(candidate.db, { ...hintDeps, now: nowMs }) : () => Boolean(deps.runResources));
  const memoryFair = { sequence: 0, last_served: { sample: 0, history: 0, resources: 0 } };
  const readFair = deps.readIdleFairState || (!deps.runCycle ? readIdleFairState : () => structuredClone(memoryFair));
  const claimFair = deps.claimIdleLane || (!deps.runCycle ? claimIdleLane : (_db, state, lane) => {
    if (state.sequence !== memoryFair.sequence) return null;
    memoryFair.sequence += 1;
    memoryFair.last_served[lane] = memoryFair.sequence;
    return structuredClone(memoryFair);
  });
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
        if (!runHistory || !cycleHealthyWithoutHistory(steps, false)) return null;
        return runSharedIdleWork(opts, cycle, runHistory, { nowMs, monotonicNowMs: monotonicNow,
          hasHistoryWork, hasResourceWork, runResources, readFair, claimFair,
          remoteSampleAdmission, sample, cooldowns, onSample, sleepSeconds: sleep });
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
  compactResourceSummary,
  runWorker,
  sleepSeconds,
  usage,
  writeLog,
  rotateLogIfNeeded,
};
