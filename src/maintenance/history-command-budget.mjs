// @ts-check
import { performance } from 'node:perf_hooks';

const budgets = new WeakSet();
const REASONS = new Set(['time_budget', 'clock_unavailable']);

export class HistoryCommandBudgetError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    const safe = REASONS.has(reason) ? reason : 'clock_unavailable';
    super(`history command stopped: ${safe}`);
    this.name = 'HistoryCommandBudgetError';
    this.reason = safe;
  }
}

/** A synchronous internal command clock, never a cross-process performance.now
 * value. The optional trusted provider can only shorten the original grant.
 * Normal work reserves bounded time for owner-qualified cleanup and output;
 * every operation still obtains its fresh remainder before it starts.
 * @param {{maxSeconds:number}} options
 * @param {{monotonicClock?:()=>number,remainingTimeMs?:()=>number,startedMonotonicMs?:number}} [deps]
 */
export function createHistoryCommandBudget(options, deps = {}) {
  if (!Number.isSafeInteger(options?.maxSeconds) || options.maxSeconds < 1 || options.maxSeconds > 30) throw new RangeError('invalid history command budget');
  return createCommandBudget(options,deps,true);
}

/** Resource production uses the original full grant without adding a history
 * reservation or resetting its invocation origin. The private brand is shared
 * with the established session/media boundary, never reconstructed by shape.
 * @param {{maxSeconds:number}} options
 * @param {{monotonicClock?:()=>number,remainingTimeMs?:()=>number,startedMonotonicMs?:number}} [deps]
 */
export function createResourceCommandBudget(options,deps={}) {
  if(!Number.isSafeInteger(options?.maxSeconds)||options.maxSeconds<1||options.maxSeconds>180)throw new RangeError('invalid resource command budget');
  return createCommandBudget(options,deps,false);
}

/** @param {{maxSeconds:number}} options
 * @param {{monotonicClock?:()=>number,remainingTimeMs?:()=>number,startedMonotonicMs?:number}} deps
 * @param {boolean} reserveCleanup */
function createCommandBudget(options,deps,reserveCleanup) {
  const clock = deps.monotonicClock || (() => performance.now());
  let created;
  try { created = clock(); } catch { created = NaN; }
  // An earlier invocation origin is valid only in this same clock domain.
  // The CLI uses it to include actual startup in both deadline and receipt.
  const started = deps.startedMonotonicMs === undefined ? created : deps.startedMonotonicMs;
  let previous = created, deadline = started + options.maxSeconds * 1000;
  let phase = 'work';
  /** @type {string|null} */ let stopped = Number.isFinite(started) && Number.isFinite(created) && started <= created ? null : 'clock_unavailable';
  const grant = options.maxSeconds * 1000;
  // These are contained reservations, not extra grace or the sole deadline
  // protection. A blocked release is interrupted and remains an explicit error.
  const completionReserve = reserveCleanup ? Math.min(1000, Math.floor(grant / 4)) : 0;
  const outputReserve = Math.min(100, Math.floor(completionReserve / 4));
  const fail = reason => { stopped = reason === 'clock_unavailable' ? reason : stopped || reason; throw new HistoryCommandBudgetError(stopped || 'clock_unavailable'); };
  function observe() {
    if (stopped === 'clock_unavailable') return fail('clock_unavailable');
    let value;
    try { value = clock(); } catch { return fail('clock_unavailable'); }
    if (!Number.isFinite(started) || !Number.isFinite(value) || value < previous) return fail('clock_unavailable');
    previous = value;
    if (deps.remainingTimeMs) {
      let left;
      try { left = deps.remainingTimeMs(); } catch { return fail('clock_unavailable'); }
      if (!Number.isFinite(left)) return fail('clock_unavailable');
      deadline = Math.min(deadline, value + Math.max(0, left));
    }
    return value;
  }
  function remainingMs() {
    if (stopped === 'clock_unavailable') return fail('clock_unavailable');
    const value = observe();
    return Math.max(0, deadline - value);
  }
  function timeoutMs(capMs = 30000) {
    if (!Number.isFinite(capMs) || capMs <= 0) throw new RangeError('invalid history operation timeout');
    const left = remainingMs() - (phase === 'cleanup' ? outputReserve : completionReserve);
    const result = Math.floor(Math.min(capMs, left));
    if (result < 1) return fail('time_budget');
    return result;
  }
  function assertReady() { timeoutMs(); }
  function assertOutputReady() {
    if (Math.floor(remainingMs()) < 1) fail('time_budget');
  }
  /** @template T @param {()=>T} fn @returns {T} */
  function runCleanup(fn) {
    const before = phase; phase = 'cleanup';
    try { assertReady(); return fn(); }
    finally { phase = before; }
  }
  function summary() {
    let elapsed = null, complete = stopped !== 'clock_unavailable';
    try { elapsed = Math.max(0, Math.floor(observe() - started)); } catch { complete = false; }
    return { version: 1, max_ms: grant, elapsed_ms: elapsed, stop_reason: stopped, complete };
  }
  const budget = Object.freeze({ assertReady, timeoutMs, remainingMs, runCleanup, assertOutputReady, summary });
  budgets.add(budget);
  // Capture an inherited shorter deadline immediately, before selectors run.
  observe();
  return budget;
}

/** @param {unknown} value */
export function isHistoryCommandBudget(value) { return typeof value === 'object' && value !== null && budgets.has(value); }
