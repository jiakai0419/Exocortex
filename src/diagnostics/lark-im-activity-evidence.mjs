// @ts-check
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

const MAX_ACTIVITY_AGE_MS = 60 * 60 * 1000;
const ACTIVITY_GRACE_MS = 5000;
const ACTIVITY_GAP_MS = 30000;
const MAX_ACTIVITY_INSTANCES = 32;
const PHASES = new Set(["cycle", "between_steps", "step", "waiting", "sync", "stopped"]);
const STEPS = new Set(["sent", "discover-hot", "received-hot", "discover-catchup", "discover-reconcile", "received-fair", "retention", "all", "discover", "received", "details"]);

/** Bind phases to a concrete file, not merely its reusable pathname.
 * Missing/inaccessible files provide no positive identity evidence.
 * @param {string} db @returns {string | null} */
function activityDatabaseKey(db) {
  try {
    const path = realpathSync(resolve(db));
    const info = statSync(path, { bigint: true });
    if (!info.isFile() || info.dev < 0n || info.ino <= 0n) return null;
    return createHash("sha256").update(JSON.stringify([
      path, String(info.dev), String(info.ino), String(info.birthtimeNs),
    ])).digest("hex");
  } catch { return null; }
}

/** One bounded OS read; never collects command lines.
 * @param {number[]} pids @param {typeof spawnSync} [run]
 * @returns {Map<number, {state: string, started_at_ms: number | null, ppid?: number}>} */
function inspectActivityProcesses(pids, run = spawnSync) {
  const requested = [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))].slice(0, MAX_ACTIVITY_INSTANCES);
  const result = /** @type {Map<number, {state: string, started_at_ms: number | null, ppid?: number}>} */ (new Map(requested.map((pid) => [pid, { state: "unknown", started_at_ms: /** @type {number|null} */ (null) }])));
  if (!requested.length) return result;
  let observed;
  try {
    observed = run("ps", ["-o", "pid=,ppid=,stat=,lstart=", "-p", requested.join(",")], {
      encoding: "utf8", timeout: 2000, killSignal: "SIGKILL", maxBuffer: 32 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
  } catch { return result; }
  if (observed.error || observed.signal || String(observed.stderr || "").trim()) return result;
  if (observed.status === 1 && !String(observed.stdout || "").trim()) {
    for (const pid of requested) result.set(pid, { state: "dead", started_at_ms: null });
    return result;
  }
  if (observed.status !== 0) return result;
  for (const pid of requested) result.set(pid, { state: "dead", started_at_ms: null });
  for (const line of String(observed.stdout || "").split("\n").filter((value) => value.trim())) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    const pid = Number(match?.[1]);
    const start = Date.parse(match?.[4] || "");
    if (!match || !result.has(pid) || !Number.isFinite(start)) {
      for (const id of requested) result.set(id, { state: "unknown", started_at_ms: null });
      return result;
    }
    result.set(pid, { state: match[3].includes("Z") ? "dead" : match[3].includes("T") ? "unknown" : "alive", started_at_ms: start, ppid: Number(match[2]) });
  }
  return result;
}

/** @param {unknown} owner */
function ownerIdentity(owner) {
  const match = typeof owner === "string" ? owner.match(/^pid:(\d+):started:(\d+)(?::|$)/) : null;
  if (!match) return null;
  const pid = Number(match[1]);
  const start = Number(match[2]);
  return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(start) && start > 0
    ? { pid, started_at_ms: Math.floor(start / 1000) * 1000 } : null;
}

/** @param {Record<string, any>[]} locks @param {(pids: number[]) => ReturnType<typeof inspectActivityProcesses>} [inspect] @param {() => number} [now] */
function observeLockOwners(locks, inspect = inspectActivityProcesses, now = Date.now) {
  const identities = locks.map((lock) => ownerIdentity(lock.locked_by));
  const processes = inspect(identities.flatMap((id) => id ? [id.pid] : []));
  const at = new Date(now()).toISOString();
  return locks.map((lock, index) => {
    const identity = identities[index];
    const observed = identity ? processes.get(identity.pid) : null;
    let state = observed?.state === "alive" && observed.started_at_ms !== identity?.started_at_ms
      ? "dead" : observed?.state || "unknown";
    // A reservation written within a one-second OS start-time bucket cannot
    // disambiguate another process that reused the PID in that same bucket.
    if (state === "alive" && Date.parse(lock.locked_at) < Number(identity?.started_at_ms) + 1000) state = "unknown";
    return { ...lock, owner_state: state, owner_observed_at: at };
  });
}

/** @param {{db: string, role: "worker"|"sync", emit: (event: Record<string, any>) => void, now?: () => number, inspect?: typeof inspectActivityProcesses, pid?: number, instanceId?: string, parentInstance?: string}} opts */
function createActivityWriter(opts) {
  const pid = opts.pid || process.pid;
  const now = opts.now || Date.now;
  const observed = (opts.inspect || inspectActivityProcesses)([pid]).get(pid);
  const instanceId = opts.instanceId || randomUUID();
  return {
    instanceId,
    /** @param {string} phase @param {{cycle?: number, step?: string, durationMs?: number}} [fields] */
    update(phase, fields = {}) {
      const at = now();
      try {
        opts.emit({ type: "lark_im_worker_activity", version: 1, role: opts.role,
          instance_id: instanceId, parent_instance: opts.parentInstance || null,
          pid, process_started_at_ms: observed?.state === "alive" ? observed.started_at_ms : null,
          database_key: activityDatabaseKey(opts.db), phase, cycle: fields.cycle || null, step: fields.step || null,
          updated_at: new Date(at).toISOString(),
          valid_until: new Date(at + Math.min(MAX_ACTIVITY_AGE_MS, Math.max(0, fields.durationMs || ACTIVITY_GAP_MS))).toISOString(),
        });
      } catch { /* Optional diagnostics must not interrupt the synchronization. */ }
    },
  };
}

/** Shared structural contract. Explicit unavailable identities are legal;
 * absent fields are damaged evidence. Time freshness and OS identity are
 * evaluated separately so initialization does not poison the retained log.
 * @param {unknown} input */
function validateActivityEventShape(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const event = /** @type {Record<string, any>} */ (input);
  const required = ["type", "version", "role", "instance_id", "parent_instance", "pid", "process_started_at_ms",
    "database_key", "phase", "cycle", "step", "updated_at", "valid_until"];
  if (!required.every((field) => Object.hasOwn(event, field))) return false;
  const token = (/** @type {unknown} */ value) => typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
  const positive = (/** @type {unknown} */ value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const updated = typeof event.updated_at === "string" ? Date.parse(event.updated_at) : NaN;
  const until = typeof event.valid_until === "string" ? Date.parse(event.valid_until) : NaN;
  return event.type === "lark_im_worker_activity" && event.version === 1 && ["worker", "sync"].includes(event.role)
    && token(event.instance_id) && (event.parent_instance === null || token(event.parent_instance))
    && positive(event.pid) && (event.process_started_at_ms === null || positive(event.process_started_at_ms))
    && (event.database_key === null || typeof event.database_key === "string" && /^[a-f0-9]{64}$/.test(event.database_key))
    && PHASES.has(event.phase) && (event.role === "sync" ? ["sync", "stopped"].includes(event.phase) : event.phase !== "sync")
    && (event.cycle === null || positive(event.cycle)) && (event.step === null || STEPS.has(event.step))
    && Number.isFinite(updated) && Number.isFinite(until) && until > updated && until - updated <= MAX_ACTIVITY_AGE_MS;
}

/** Latest means append order, never the largest timestamp/cycle. Completed
 * instances and other databases do not consume the current-process budget.
 * @param {unknown[]} events @param {string | null} [databaseKey] @param {number} [nowMs] */
function latestActivityEvents(events, databaseKey, nowMs = Date.now()) {
  const seen = new Set();
  const candidates = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = /** @type {Record<string, any>} */ (events[index]);
    if (event?.type !== "lark_im_worker_activity") continue;
    if (!validateActivityEventShape(event)) return { events: [event], truncated: false, integrity: false };
    const key = String(event.instance_id || "invalid");
    if (seen.has(key)) continue;
    seen.add(key);
    if (databaseKey && typeof event.database_key === "string" && /^[a-f0-9]{64}$/.test(event.database_key) && event.database_key !== databaseKey) continue;
    const updated = Date.parse(event.updated_at);
    if (event.phase === "stopped" && event.database_key !== null && event.process_started_at_ms !== null
      && updated >= event.process_started_at_ms && updated <= nowMs) continue;
    candidates.push(event);
    if (candidates.length > MAX_ACTIVITY_INSTANCES) return { events: candidates.slice(0, MAX_ACTIVITY_INSTANCES), truncated: true, integrity: true };
  }
  return { events: candidates, truncated: false, integrity: true };
}

/** @param {Record<string, any>} event @param {Record<string, any> | undefined} processState @param {string | null} databaseKey @param {number} nowMs */
function evaluateActivityEvent(event, processState, databaseKey, nowMs) {
  if (!validateActivityEventShape(event)) return { state: "unknown" };
  if (typeof databaseKey !== "string" || !/^[a-f0-9]{64}$/.test(databaseKey)
    || typeof event.database_key !== "string" || !/^[a-f0-9]{64}$/.test(event.database_key)) return { state: "unknown" };
  if (event.database_key !== databaseKey) return { state: "other_database" };
  if (processState?.state === "dead") return { state: "dead" };
  const start = Number(event.process_started_at_ms);
  if (processState?.state === "alive" && Number.isFinite(start) && start > 0 && processState.started_at_ms !== start) return { state: "dead" };
  const updated = Date.parse(String(event.updated_at || ""));
  const until = Date.parse(String(event.valid_until || ""));
  const valid = event.process_started_at_ms !== null
    && processState?.state === "alive" && processState.started_at_ms === start
    && updated >= start + 1000 && updated <= nowMs && nowMs < until;
  if (!valid) return { state: "unknown" };
  if (event.phase === "stopped") return { state: "stopped" };
  return { state: event.phase === "waiting" ? "waiting" : "syncing", phase: event.phase,
    cycle: Number.isSafeInteger(event.cycle) && event.cycle > 0 ? event.cycle : null,
    step: STEPS.has(event.step) ? event.step : null, updated_at: event.updated_at, valid_until: event.valid_until };
}

/** Database reservations and historical running rows have no phase evidence.
 * @param {unknown} locks @param {number} [running] */
function databaseActivityEvidence(locks, running = 0) {
  return { state: "unknown", evidence: "database_only", reason:
    (Array.isArray(locks) && locks.length > 0) || running > 0 ? "unverified_sync_history" : "phase_not_collected" };
}

/** Legacy database-only "syncing" is unverified, including input to doctor.
 * @param {unknown} health */
function databaseOnlyHealth(health) {
  return health === "syncing" ? "unknown" : String(health || "unknown");
}

export { databaseActivityEvidence, databaseOnlyHealth, ACTIVITY_GAP_MS, ACTIVITY_GRACE_MS, MAX_ACTIVITY_AGE_MS, activityDatabaseKey, createActivityWriter,
  inspectActivityProcesses, observeLockOwners, latestActivityEvents, evaluateActivityEvent, validateActivityEventShape };
