// @ts-check

import { evaluateActivityEvent, validateActivityEventShape } from "./lark-im-activity-evidence.mjs";
import { parseWorkerEventTimestamp as timestamp } from "./worker-event-time.mjs";
import { expectedCycleSteps } from "../../dist/runtime/worker/lark-im-worker-core.js";

/** @typedef {Record<string, any>} JsonObject */
/** @typedef {"worker_unverified" | "log_unavailable" | "log_damaged" | "completion_unbound" | "completion_invalid" | "completion_conflict"} UnavailableReason */

const SCOPE = "current_worker_retained_log";
const positive = (/** @type {unknown} */ value) => Number.isSafeInteger(value) && Number(value) > 0;
const instance = (/** @type {unknown} */ value) => typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const database = (/** @type {unknown} */ value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** @param {UnavailableReason} reason */
function unavailable(reason) {
  return { scope: SCOPE, state: "unavailable", total_runs: null, successful_runs: null,
    last_completed_at: null, last_duration_ms: null, reason };
}

/** Recheck supplied evidence using the final observation clock, without any I/O.
 * A retained log alone cannot identify the current background process.
 * @param {JsonObject | undefined} report @param {JsonObject | undefined} binding @param {number} nowMs */
function verifiedWorker(report, binding, nowMs) {
  const worker = binding?.worker;
  const evidence = report?.activity_evidence;
  if (!Number.isSafeInteger(nowMs) || binding?.target_match !== "matched" ||
    !["waiting", "syncing"].includes(binding.phase?.state) || !validateActivityEventShape(worker) ||
    worker.role !== "worker" || !positive(worker.process_started_at_ms) || !positive(worker.cycle) ||
    !database(worker.database_key) || report?.probe?.pid !== worker.pid ||
    evidence?.database_identity_stable !== true || evidence.integrity === false || evidence.truncated === true ||
    evidence.database_key !== worker.database_key || typeof evidence.processes?.get !== "function") return null;
  const phase = evaluateActivityEvent(worker, evidence.processes.get(worker.pid), evidence.database_key, nowMs);
  return ["waiting", "syncing"].includes(phase.state) && phase.state === binding.phase.state ? worker : null;
}

/** @param {JsonObject} event */
function expectedSteps(event) { return expectedCycleSteps(event); }

/** Completion counts stand independently of the optional detailed step trail.
 * @param {JsonObject} event @param {JsonObject} worker @param {number} nowMs */
function completionValid(event, worker, nowMs) {
  const at = timestamp(event.at);
  const expected = expectedSteps(event);
  return event.version === 1 && positive(event.cycle) && event.cycle <= worker.cycle &&
    typeof event.ok === "boolean" && at !== null && at >= worker.process_started_at_ms && at <= nowMs &&
    expected !== null && Array.isArray(event.failed_steps) &&
    event.failed_steps.every((/** @type {unknown} */ name) => typeof name === "string" && expected.includes(name)) &&
    new Set(event.failed_steps).size === event.failed_steps.length &&
    event.ok === (event.failed_steps.length === 0);
}

/** Duration covers the first step's start through the completion record. It
 * excludes the subsequent wait and never substitutes inter-cycle spacing.
 * @param {JsonObject[]} events @param {{event: JsonObject, index: number}} completion @param {JsonObject} worker
 * @param {{event: JsonObject, index: number} | undefined} previous */
function duration(events, completion, worker, previous) {
  const cycle = completion.event;
  const expected = expectedSteps(cycle);
  const at = timestamp(cycle.at);
  const steps = events.map((event, index) => ({ event, index })).filter(({ event }) =>
    event.type === "lark_im_worker_step" && event.instance_id === worker.instance_id && event.cycle === cycle.cycle);
  if (!expected || at === null || steps.length !== expected.length) return null;
  let firstStart = null;
  // Worker rounds execute serially. An otherwise complete trail cannot start
  // before a retained preceding completion, in either time or append order.
  let previousEnd = previous ? Math.max(worker.process_started_at_ms, Number(timestamp(previous.event.at))) : worker.process_started_at_ms;
  const previousPosition = previous?.index ?? -1;
  const failed = [];
  for (let index = 0; index < steps.length; index += 1) {
    const { event: step, index: position } = steps[index];
    const start = timestamp(step.started_at);
    const end = timestamp(step.finished_at);
    if (step.version !== 1 || step.database_key !== worker.database_key || position <= previousPosition || position >= completion.index ||
      step.step_index !== index || step.name !== expected[index] || typeof step.ok !== "boolean" ||
      (step.partial !== undefined && typeof step.partial !== "boolean") ||
      (step.ok && (step.exit_code !== 0 || step.partial === true)) ||
      start === null || end === null || start < previousEnd || end < start || end > at) return null;
    if (firstStart === null) firstStart = start;
    previousEnd = end;
    if (!step.ok) failed.push(step.name);
  }
  if (JSON.stringify(failed) !== JSON.stringify(cycle.failed_steps) || firstStart === null) return null;
  return at - firstStart;
}

/** Four statistics from the already-read, bounded current log. The scope is
 * retained completion records, never worker lifetime or the last 24 hours.
 * No raw identity, path, event payload or exception is returned.
 * @param {JsonObject | undefined} report @param {JsonObject | undefined} binding @param {number} nowMs */
function summarizeRuntimeStats(report, binding, nowMs) {
  const worker = verifiedWorker(report, binding, nowMs);
  if (!worker) return unavailable("worker_unverified");
  const log = report?.worker?.log;
  if (log?.exists !== true || !Array.isArray(log.events)) return unavailable("log_unavailable");
  if (log.activity_integrity === false || log.events.some((/** @type {unknown} */ event) =>
    !event || typeof event !== "object" || Array.isArray(event))) return unavailable("log_damaged");

  /** @type {Map<number, {event: JsonObject, index: number, fingerprint: string}>} */
  const completed = new Map();
  let sawUnbound = false;
  /** @type {{event: JsonObject, index: number, fingerprint: string} | null} */
  let latest = null;
  for (let index = 0; index < log.events.length; index += 1) {
    const event = log.events[index];
    if (event.type !== "lark_im_worker_cycle") continue;
    // Explicitly different identities cannot belong to this scope. Missing
    // identities are never inferred from a nearby activity or completion.
    if (instance(event.instance_id) && event.instance_id !== worker.instance_id ||
      database(event.database_key) && event.database_key !== worker.database_key) continue;
    if (event.instance_id !== worker.instance_id || event.database_key !== worker.database_key) {
      sawUnbound = true;
      const at = timestamp(event.at);
      if (event.instance_id === worker.instance_id || at === null || at >= worker.process_started_at_ms) return unavailable("completion_unbound");
      continue;
    }
    if (!completionValid(event, worker, nowMs)) return unavailable("completion_invalid");
    const fingerprint = JSON.stringify([event.ok, timestamp(event.at), event.step_count, event.failed_steps]);
    const prior = completed.get(event.cycle);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return unavailable("completion_conflict");
      continue;
    }
    if (latest && (event.cycle < latest.event.cycle || Number(timestamp(event.at)) < Number(timestamp(latest.event.at)))) {
      return unavailable("completion_conflict");
    }
    latest = { event, index, fingerprint };
    completed.set(event.cycle, latest);
  }
  if (completed.size === 0 && sawUnbound) return unavailable("completion_unbound");
  const completions = [...completed.values()];
  return { scope: SCOPE, state: "available", total_runs: completed.size,
    successful_runs: completions.filter(({ event }) => event.ok === true).length,
    last_completed_at: latest ? new Date(Number(timestamp(latest.event.at))).toISOString() : null,
    last_duration_ms: latest ? duration(log.events, latest, worker, completions.at(-2)) : null, reason: null };
}

export { summarizeRuntimeStats };
