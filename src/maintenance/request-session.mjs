// @ts-check
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { registerHistoryLocalFailure, preserveHistoryFailure, registerHistoryLeaseFailure } from "./history-diagnostics.mjs";
import { markReplayCleanup, markReplayActionEntered } from '../../dist/storage/sqlite/execution-evidence.js';
import { isHistoryCommandBudget, HistoryCommandBudgetError } from "./history-command-budget.mjs";
import { classifyLarkFailure, createLarkCliRunner, createTransportState, transportOperation } from "../adapters/lark-im/transport.mjs";
import { NAME_LOOKUP_RETRY_BUDGET_MS } from "../adapters/lark-im/name-resolver.mjs";
import { tryAcquireLarkApiLease, readSharedLarkCooldown, writeSharedLarkCooldown } from "../runtime/lark-api-lease.mjs";

const STOP_REASONS = new Set(["cli_budget", "self_budget", "time_budget", "clock_unavailable", "sync_busy", "lease_unavailable",
  "rate_cooldown", "rate_limited", "shared_cooldown_unavailable"]);
const MAINTENANCE_REQUEST_GAP_MS = 1000;

/** Only local, finite reasons cross the command's public error boundary. */
class MaintenanceRequestError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    const safeReason = STOP_REASONS.has(reason) ? reason : "lease_unavailable";
    super(`maintenance requests stopped: ${safeReason}`);
    this.name = "MaintenanceRequestError";
    this.reason = safeReason;
    registerHistoryLocalFailure(this, safeReason);
    /** @type {Record<string, number|string|null> | undefined} */
    this.requestBudget = undefined;
  }
}

/** One command-wide budget. Counts actual CLI spawn attempts, including
 * pagination and fallbacks, not the CLI's opaque internal HTTP requests.
 * Maintenance never waits for an API lease or a cooldown. A running request
 * cannot be preempted. A sync holding shared intent excludes later probes;
 * there is no FIFO guarantee among sync waiters or before intent admission.
 * @param {{db?: string, maxCliAttempts?: number, maxSelfAttempts?: number, maxSeconds?: number}} options
 * @param {Record<string, any>} [deps]
 */
function createMaintenanceRequestSession(options = {}, deps = {}) {
  const maxCliAttempts = options.maxCliAttempts ?? 12;
  const maxSeconds = options.maxSeconds ?? 30;
  const maxSelfAttempts = options.maxSelfAttempts ?? maxCliAttempts;
  if (!Number.isSafeInteger(maxSelfAttempts) || maxSelfAttempts < 0 || maxSelfAttempts > maxCliAttempts) throw new RangeError("invalid self-attempt budget");
  if (!Number.isSafeInteger(maxCliAttempts) || maxCliAttempts < 1 || maxCliAttempts > 1000) {
    throw new RangeError("--max-cli-attempts must be an integer from 1 to 1000");
  }
  if (!Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 180) {
    throw new RangeError("--max-seconds must be an integer from 1 to 180");
  }
  const monotonicClock = deps.monotonicClock || (() => performance.now());
  const wallClock = deps.now || Date.now;
  const env = deps.env || process.env;
  const acquire = deps.tryAcquireLease || tryAcquireLarkApiLease;
  const readCooldown = deps.readSharedCooldown || readSharedLarkCooldown;
  const writeCooldown = deps.writeSharedCooldown || writeSharedLarkCooldown;
  const spawn = deps.spawnSync || spawnSync;
  const sleep = deps.sleep || ((/** @type {number} */ ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const commandBudget = deps.commandBudget || null;
  if (commandBudget && !isHistoryCommandBudget(commandBudget)) throw new TypeError("invalid internal command budget");
  const started = monotonicClock();
  const deadline = started + maxSeconds * 1000;
  let attempts = 0, selfAttempts = 0;
  let lastFinished = -Infinity;
  /** @type {MaintenanceRequestError | null} */
  let stopped = null;
  /** @type {Record<string, any> | null} */
  let heldLease = null;
  let insideTransport = false;
  /** @type {MaintenanceRequestError | null} */ let transportAdmissionStop = null;
  /** @param {string} reason @returns {never} */
  function stop(reason, leaseResult = null, phase = 'request') {
    if (!stopped) {
      stopped = new MaintenanceRequestError(reason);
      registerHistoryLeaseFailure(stopped,leaseResult,phase);
    }
    stopped.requestBudget = summary();
    if (insideTransport) transportAdmissionStop ||= stopped;
    throw stopped;
  }
  function elapsedNow() {
    const value = monotonicClock();
    if (!Number.isFinite(started) || !Number.isFinite(value) || value < started) stop("clock_unavailable");
    return value;
  }
  function commandRemaining(capMs) {
    if (capMs <= 0) stop("time_budget");
    if (!commandBudget) return capMs;
    try { return commandBudget.timeoutMs(capMs); }
    catch (error) { if (error instanceof HistoryCommandBudgetError) stop(error.reason); throw error; }
  }
  function assertReady() {
    if (stopped) stop(stopped.reason);
    if (elapsedNow() >= deadline) stop("time_budget");
    commandRemaining(Math.max(1, deadline - elapsedNow()));
  }
  /** @param {number | undefined} value @param {number} fallback */
  const cap = (value, fallback) => Number.isFinite(value) && Number(value) > 0 ? Math.min(fallback, Math.floor(Number(value))) : fallback;
  /** @param {{operation: string, nowMs?: number}} request */
  function sharedReady(request) {
    assertReady();
    let result;
    try { result = readCooldown(request); } catch { stop("shared_cooldown_unavailable"); }
    if (result?.state === "cooldown") stop("rate_cooldown");
    if (result?.state !== "ready") stop("shared_cooldown_unavailable");
    return result;
  }
  const transport = createLarkCliRunner({
    bin: env.LARK_CLI || "lark-cli", state: createTransportState(), clock: wallClock, monotonicClock,
    timeoutMs: NAME_LOOKUP_RETRY_BUDGET_MS,
    readSharedCooldown: sharedReady,
    writeSharedCooldown(request) {
      let written = false;
      try { written = writeCooldown(request); } catch { /* Fail closed below. */ }
      // Publish the rate limit before releasing this request's lease. Resolver
      // best-effort catches cannot clear the command-wide stop condition.
      stopped ||= new MaintenanceRequestError(written ? "rate_limited" : "shared_cooldown_unavailable");
      return written;
    },
    spawn(command, args, settings) {
      assertReady();
      if (attempts >= maxCliAttempts) stop("cli_budget");
      if (!heldLease) stop("lease_unavailable");
      const remaining = Math.floor(commandRemaining(deadline - elapsedNow()));
      if (remaining < 1) stop("time_budget");
      const isSelf = transportOperation(args) === "self_profile";
      if (isSelf && selfAttempts >= maxSelfAttempts) stop("self_budget");
      attempts += 1;
      if (isSelf) selfAttempts += 1;
      const result = spawn(command, args, { ...settings, env, timeout: Math.min(settings.timeout, remaining),
        ...(heldLease.stdio ? { stdio: heldLease.stdio } : {}) });
      // Some CLI versions return exit 0 with an unsuccessful native envelope.
      // Route only explicit top-level failures through the existing classifier;
      // successful message/profile content must never become transport errors.
      if (result.status === 0) {
        try {
          const json = JSON.parse(String(result.stdout || ""));
          if (json && typeof json === "object" && !Array.isArray(json)
            && (json.ok === false || json.error != null || json.code !== undefined && json.code !== 0)) {
            return { ...result, status: 1 };
          }
        } catch { /* The transport owns the safe malformed-JSON error. */ }
      }
      return result;
    },
  });
  /** @param {string[]} args @param {Record<string, any>} [settings] */
  function runLark(args, settings = {}) {
    assertReady();
    if (attempts >= maxCliAttempts) stop("cli_budget");
    if (transportOperation(args) === "self_profile" && selfAttempts >= maxSelfAttempts) stop("self_budget");
    // This cheap preflight avoids acquiring a lease for known cooled work.
    // The transport rechecks under the lease before the actual spawn.
    sharedReady({ operation: transportOperation(args), nowMs: wallClock() });
    // Leave the lease free between requests so a waiting sync can acquire it.
    // An announced sync waiter also blocks new probes with its intent gate;
    // active requests/local commits are not preempted and sync is not FIFO.
    while (true) {
      const before = elapsedNow();
      const wait = Math.max(0, lastFinished + MAINTENANCE_REQUEST_GAP_MS - before);
      if (!wait) break;
      if (wait + 1 >= commandRemaining(deadline - before)) stop("time_budget");
      sleep(wait);
      assertReady();
      if (elapsedNow() <= before) stop("clock_unavailable");
    }
    let lease;
    try { lease = acquire({ db: options.db, role: "probe", monotonicDeadlineMs: Math.min(deadline, elapsedNow() + commandRemaining(deadline - elapsedNow())) }); }
    catch { stop("lease_unavailable"); }
    if (lease?.state !== "acquired") stop(lease?.state === "busy" ? "sync_busy" : "lease_unavailable",lease,'request');
    heldLease = lease;
    try {
      assertReady();
      const remaining = Math.floor(commandRemaining(deadline - elapsedNow()));
      if (remaining < 1) stop("time_budget");
      const perRequest = Math.min(NAME_LOOKUP_RETRY_BUDGET_MS, remaining);
      let result;
      transportAdmissionStop = null; insideTransport = true;
      try { result = transport(args, { ...settings, retries: 0, retryDelayMs: 0,
        timeoutMs: cap(settings.timeoutMs, perRequest), retryBudgetMs: cap(settings.retryBudgetMs, perRequest) }); }
      finally { insideTransport = false; }
      assertReady();
      return result;
    } catch (error) {
      // A valid reset:0 publishes no future cooldown, but still ends this
      // optional maintenance command before any fallback or local commit.
      if (classifyLarkFailure(error instanceof Error ? error.message : error).kind === "rate_limited") {
        stopped ||= new MaintenanceRequestError("rate_limited");
      }
      // The transport sanitizes a local pre-spawn guard exception. Preserve
      // that exact known admission stop, not a later global budget observation.
      if (commandBudget) {
        if (transportAdmissionStop) throw transportAdmissionStop;
        if (error instanceof MaintenanceRequestError || error instanceof HistoryCommandBudgetError) throw error;
        try { assertReady(); }
        catch (stop) { throw preserveHistoryFailure(new AggregateError([error, stop], 'maintenance request failed and command stopped', { cause: error }), error); }
      } else assertReady();
      throw error;
    } finally {
      heldLease = null;
      lease.release();
      lastFinished = elapsedNow();
    }
  }
  function summary() {
    const command = commandBudget?.summary();
    const elapsed = command ? command.elapsed_ms : monotonicClock() - started;
    return { max_cli_attempts: maxCliAttempts, cli_attempts: attempts, max_seconds: maxSeconds,
      ...(options.maxSelfAttempts !== undefined ? { max_self_attempts: maxSelfAttempts, self_attempts: selfAttempts } : {}),
      min_interval_ms: MAINTENANCE_REQUEST_GAP_MS,
      elapsed_ms: typeof elapsed === "number" && Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed)) : null,
      stop_reason: stopped?.reason || command?.stop_reason || null };
  }
  /** Keep cooperating sync/sidecar publishers out of the local admission and
   * transaction interval. No CLI is spawned or charged by this local lease. */
  function withCommit(action, { allowStoppedForFailure = false, executionEvidence = undefined } = {}) {
    // Legacy callers retain their remote-only clock. Whole-command history
    // must also admit and finish local transactions within its work remainder;
    // its storage owner uses the reserved cleanup phase for lock release.
    if (stopped && !allowStoppedForFailure) stop(stopped.reason);
    const commitStarted = elapsedNow();
    const commitRemaining = commandRemaining(2000);
    let lease;
    try { lease = acquire({ db: options.db, role: "probe", monotonicDeadlineMs: commitStarted + commitRemaining }); }
    catch { stop("lease_unavailable"); }
    if (lease?.state !== "acquired") stop(lease?.state === "busy" ? "sync_busy" : "lease_unavailable",lease,'commit');
    // A successful storage response is a committed receipt. A later clock
    // observation must stop new work, not erase those already durable effects.
    let primary;
    try { markReplayActionEntered(executionEvidence);return action(); }
    catch (error) { primary=error;throw error; }
    // This release only closes our already-owned descriptor; it never starts
    // another process or write. Always close it even when the clock has expired.
    finally {
      try { lease.release();markReplayCleanup(executionEvidence,'lease','complete'); }
      catch(error) {
        markReplayCleanup(executionEvidence,'lease','failed');
        if(primary)throw preserveHistoryFailure(new AggregateError([primary,error],'commit failed and lease cleanup failed',{cause:primary}),primary);
        throw error;
      }
    }
  }
  return { runLark, assertReady, summary, withCommit };
}

export { createMaintenanceRequestSession, MaintenanceRequestError, MAINTENANCE_REQUEST_GAP_MS };
