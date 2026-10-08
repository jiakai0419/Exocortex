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

/** Three PPID edges cover both direct steps and worker -> guardian -> anchor
 * -> sync. Share the existing 32-process budget, discover at most two layers,
 * then recheck every node of the expanded paths together. Missing evidence
 * never establishes independence. PID 1 is the only non-worker boundary.
 * @param {Record<string, any>[]} events
 * @param {unknown[]} workerEvents
 * @param {ReturnType<typeof inspectActivityProcesses>} initial
 * @param {typeof inspectActivityProcesses} [inspect]
 * @param {number} [beforeInspectionMs]
 */
function collectActivityAncestors(events, workerEvents, initial, inspect = inspectActivityProcesses, beforeInspectionMs = Date.now()) {
  const processes = new Map([...initial].slice(0, MAX_ACTIVITY_INSTANCES));
  const workerPids = workerEvents.filter(validateActivityEventShape)
    .filter((event) => /** @type {Record<string, any>} */ (event).role === "worker")
    .map((event) => Number(/** @type {Record<string, any>} */ (event).pid));
  const workerIdentities = collectWorkerParentIdentities(workerEvents, workerPids);
  const children = events.filter((event) => event.role === "sync").slice(0, MAX_ACTIVITY_INSTANCES);
  /** @param {number} pid */
  function trace(pid) {
    const pids = [];
    for (let depth = 0; depth <= 3; depth += 1) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || pids.includes(pid)) break;
      pids.push(pid);
      const row = processes.get(pid);
      if (!row) return { pids, complete: false, missing: pid };
      const possibleWorker = [...(workerIdentities.get(pid) || [])]
        .some((start) => compareActivityProcessStarts(start, row?.started_at_ms) !== "different");
      if (depth > 0 && possibleWorker) return { pids, complete: Boolean(row), worker: pid };
      if (row.state !== "alive" || !Number.isSafeInteger(row.started_at_ms) || Number(row.started_at_ms) <= 0) break;
      if (depth === 3) break;
      if (row.ppid === 1) return { pids, complete: true, worker: null };
      pid = Number(row.ppid);
    }
    return { pids, complete: false };
  }
  for (let depth = 0; depth < 2; depth += 1) {
    const missing = [...new Set(children.flatMap((child) => {
      const path = trace(child.pid);
      return path.missing ? [path.missing] : [];
    }))].slice(0, Math.max(0, MAX_ACTIVITY_INSTANCES - processes.size));
    if (!missing.length) break;
    let observed;
    try { observed = inspect(missing); } catch { observed = new Map(); }
    for (const pid of missing) processes.set(pid, observed.get(pid) || { state: "unknown", started_at_ms: null });
  }
  const paths = new Map(children.map((child) => [Number(child.pid), trace(Number(child.pid))]));
  // Direct children and direct PID-1 foreground work retain the original
  // single observation. Every expanded path needs a coherent second sample.
  const expanded = [...paths.values()].filter((path) => path.complete
    && (path.pids.length > 2 || path.pids.some((pid) => !initial.has(pid))));
  const requested = [...new Set(expanded.flatMap((path) => path.pids))]
    .filter((pid) => processes.has(pid)).slice(0, MAX_ACTIVITY_INSTANCES);
  let rechecked = /** @type {ReturnType<typeof inspectActivityProcesses>} */ (new Map());
  if (requested.length) {
    try { rechecked = inspect(requested); } catch { /* remain unknown */ }
  }
  const ancestry = new Map([...paths].map(([pid, path]) => {
    const needsRecheck = path.pids.length > 2 || path.pids.some((id) => !initial.has(id));
    const stable = !needsRecheck || path.pids.every((id) => {
      const before = processes.get(id), after = rechecked.get(id);
      return before?.state === "alive" && after?.state === "alive"
        && compareActivityProcessStarts(before.started_at_ms, after.started_at_ms) === "same"
        && before.ppid === after.ppid;
    });
    return [pid, { ...path, stable, before_inspection_ms: beforeInspectionMs }];
  }));
  return { processes, ancestry };
}

/** Validate all starts and edges, including both event-bound endpoints.
 * Every process start bucket must end before the first sample: equal-second
 * PID reuse during discovery cannot then impersonate an earlier observation.
 * The child's initial phase may be in its start bucket; only the separately
 * verified worker phase proves activity. Foreground phases retain their own
 * bucket/freshness checks. Two consistent reads are not an atomic snapshot.
 * @param {Record<string, any>} child
 * @param {Record<string, any> | undefined} path
 * @param {ReturnType<typeof inspectActivityProcesses>} processes
 */
function verifyActivityAncestry(child, path, processes) {
  if (!path?.complete || !path.stable || !Array.isArray(path.pids) || path.pids[0] !== child.pid
    || path.pids.length < 1 || path.pids.length > 4 || new Set(path.pids).size !== path.pids.length) return false;
  const childStart = processes.get(child.pid)?.started_at_ms;
  const updated = Date.parse(child.updated_at);
  if (compareActivityProcessStarts(child.process_started_at_ms, childStart) !== "same"
    || !Number.isFinite(path.before_inspection_ms) || updated < Number(childStart)
    || updated > path.before_inspection_ms) return false;
  for (let index = 0; index < path.pids.length; index += 1) {
    const row = processes.get(path.pids[index]);
    if (row?.state !== "alive" || !Number.isSafeInteger(row.started_at_ms) || Number(row.started_at_ms) <= 0
      || Number(row.started_at_ms) > Number(childStart)
      || Number(row.started_at_ms) + 1000 > path.before_inspection_ms) return false;
    if (index > 0) {
      const descendant = processes.get(path.pids[index - 1]);
      if (descendant?.ppid !== path.pids[index] || Number(row.started_at_ms) > Number(descendant?.started_at_ms)) return false;
    }
  }
  return path.worker === path.pids.at(-1) || (path.worker === null && processes.get(path.pids.at(-1))?.ppid === 1);
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

/** Identity and liveness are separate observations. Missing start evidence
 * never establishes PID reuse, including for a suspended or absent process.
 * @param {unknown} expectedStart @param {unknown} observedStart
 * @returns {"same" | "different" | "unknown"} */
function compareActivityProcessStarts(expectedStart, observedStart) {
  const valid = (/** @type {unknown} */ value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if (!valid(expectedStart) || !valid(observedStart)) return "unknown";
  return expectedStart === observedStart ? "same" : "different";
}

/** Only parent-role evidence is retained here: it cannot establish activity.
 * Keep each instance's latest identity for matching OS PPIDs, including
 * stopped phases and other database bindings. Any unrefuted instance retains
 * the possible worker role; one different instance cannot erase another.
 * @param {unknown[]} events @param {unknown[]} parentPids
 * @returns {Map<number, Set<number | null>>} */
function collectWorkerParentIdentities(events, parentPids) {
  const requested = new Set(parentPids.flatMap((pid) => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? [pid] : []));
  /** @type {Map<number, Set<number | null>>} */
  const result = new Map();
  if (requested.size === 0) return result;
  const seenInstances = new Set();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = /** @type {Record<string, any>} */ (events[index]);
    if (event?.role !== "worker" || !validateActivityEventShape(event) || seenInstances.has(event.instance_id)) continue;
    seenInstances.add(event.instance_id);
    if (!requested.has(event.pid)) continue;
    if (!result.has(event.pid)) result.set(event.pid, new Set());
    result.get(event.pid)?.add(event.process_started_at_ms);
  }
  return result;
}

/** @param {Record<string, any>} event @param {Record<string, any> | undefined} processState @param {string | null} databaseKey @param {number} nowMs */
function evaluateActivityEvent(event, processState, databaseKey, nowMs) {
  if (!validateActivityEventShape(event)) return { state: "unknown" };
  if (typeof databaseKey !== "string" || !/^[a-f0-9]{64}$/.test(databaseKey)
    || typeof event.database_key !== "string" || !/^[a-f0-9]{64}$/.test(event.database_key)) return { state: "unknown" };
  if (event.database_key !== databaseKey) return { state: "other_database" };
  if (processState?.state === "dead") return { state: "dead" };
  const start = event.process_started_at_ms;
  const identity = compareActivityProcessStarts(start, processState?.started_at_ms);
  if (identity === "different") return { state: "dead" };
  const updated = Date.parse(String(event.updated_at || ""));
  const until = Date.parse(String(event.valid_until || ""));
  const valid = identity === "same" && processState?.state === "alive"
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
  inspectActivityProcesses, observeLockOwners, latestActivityEvents, evaluateActivityEvent, validateActivityEventShape,
  compareActivityProcessStarts, collectWorkerParentIdentities, collectActivityAncestors, verifyActivityAncestry };
