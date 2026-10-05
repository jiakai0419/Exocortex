// @ts-check
// One due timestamp attached to the existing worker, with a kernel-held lock.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { activityDatabaseKey } from "../../diagnostics/lark-im-activity-evidence.mjs";
import { TRANSPORT_OPERATIONS } from "../../adapters/lark-im/transport.mjs";
import { liveProbeContext } from "../../diagnostics/live-probe-cache.mjs";
import { invalidateRemoteSampleCache, publicRemoteReport } from "../../diagnostics/remote-sample-cache.mjs";
import { readStableJsonFile } from "../../diagnostics/private-json-file.mjs";
import { REMOTE_SAMPLE_GUARDIAN, REMOTE_SAMPLE_TIMEOUT_MS, runGuardedRemoteSampleProcess, safeGuardianDiagnostic } from "./remote-sample-process.mjs";
import { createRemoteSamplePublication, remoteSamplePublicationStage } from "./remote-sample-cache-gate.mjs";

export { REMOTE_SAMPLE_GUARDIAN, REMOTE_SAMPLE_TIMEOUT_MS };
export const REMOTE_SAMPLE_MAX_BACKOFF_MS = 6 * 60 * 60_000;
export const REMOTE_SAMPLE_OBSERVATION_TTL_MS = 7 * 24 * 60 * 60_000;
const MIN_INTERVAL_MS = 15 * 60_000;
const BUSY_RETRY_MS = 60_000;
const MAX_STATE_BYTES = 96 * 1024;
const STATE_KIND = "lark_im_remote_sample_schedule/v1";
const MAIN_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "remote-sample-main.mjs");
const HASH = /^[a-f0-9]{64}$/;

// Python is already a project prerequisite. exec preserves this descriptor in
// the same PID: process death/SIGKILL releases flock without stale-lock removal.
// Use a high descriptor to avoid the runtime's usual standard/IPC descriptors.
export const REMOTE_SAMPLE_LOCK_WRAPPER = String.raw`
import fcntl,json,os,stat,sys
try:
    p=sys.argv[1]
    fd=os.open(p,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
    s=os.fstat(fd)
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode & 0o077 or s.st_nlink!=1:
        raise ValueError('unsafe lock')
    try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({'outcome':'busy','reason':'scheduler_busy'})); sys.exit(0)
    held=fcntl.fcntl(fd,fcntl.F_DUPFD,200)
    os.close(fd)
    os.set_inheritable(held,True)
    os.environ['EXOCORTEX_REMOTE_SAMPLE_LOCK_FD']=str(held)
    # The wrapper now execs the guardian in this same Python interpreter.
    os.execv(sys.executable,[sys.executable,*sys.argv[3:]])
except Exception:
    print(json.dumps({'outcome':'failed','reason':'scheduler_unavailable'})); sys.exit(2)
`;

/** @typedef {{first_seen:number,last_seen:number,run_finished:number,target:number,kind:'missing'|'version'|'content'}} Observation */
/** @typedef {Record<string, Observation>} Observations */
/** @typedef {{kind:string,database_key:string,account_key:string|null,written_at:number,next_due:number,failures:number,rotation:number,observations:Observations,last_outcome:string,cooldowns:Record<string,number>,blocked_reason:string|null}} ScheduleState */
/** @typedef {{db:string,logDir:string,remoteSampleIntervalSeconds?:number,publication?:Record<string,any>}} ScheduleOptions */

function plainObject(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function integer(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function exactKeys(value, keys) { return plainObject(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(","); }

/** @returns {Record<string,number>|null} */
function safeCooldowns(value, writtenAt) {
  if (!plainObject(value)) return null;
  const safe = /** @type {Record<string,number>} */ ({});
  for (const [key, until] of Object.entries(value)) {
    if (!TRANSPORT_OPERATIONS.includes(/** @type {any} */ (key)) || !integer(until) || until > writtenAt + REMOTE_SAMPLE_OBSERVATION_TTL_MS) return null;
    safe[key] = /** @type {number} */ (until);
  }
  return safe;
}
function mergeCooldowns(previous, incoming, now) {
  return Object.fromEntries(TRANSPORT_OPERATIONS.map(key => [key, Math.max(previous[key] || 0, incoming[key] || 0)]).filter(([, until]) => Number(until) > now));
}

/** Reject unexpected fields rather than preserving potentially private payloads.
 * @returns {Observations | null} */
export function sanitizeRemoteObservations(value, now, dropExpired = true) {
  if (!plainObject(value) || Object.keys(value).length > 200) return null;
  const safe = /** @type {Observations} */ ({});
  for (const [key, item] of Object.entries(value)) {
    if (!HASH.test(key) || !exactKeys(item, ["first_seen", "last_seen", "run_finished", "target", "kind"]) ||
      !["missing", "version", "content"].includes(item.kind) ||
      ![item.first_seen, item.last_seen, item.run_finished, item.target].every(integer) ||
      item.first_seen > item.last_seen || item.last_seen > now || item.run_finished > now || item.target > now) return null;
    if (dropExpired && item.last_seen < now - REMOTE_SAMPLE_OBSERVATION_TTL_MS) continue;
    safe[key] = { first_seen: item.first_seen, last_seen: item.last_seen, run_finished: item.run_finished, target: item.target, kind: item.kind };
  }
  return safe;
}

/** @returns {ScheduleState | null} */
export function validateRemoteSampleState(value, databaseKey, now) {
  if (!exactKeys(value, ["kind", "database_key", "account_key", "written_at", "next_due", "failures", "rotation", "observations", "last_outcome", "cooldowns", "blocked_reason"]) ||
    value.kind !== STATE_KIND || value.database_key !== databaseKey || !HASH.test(databaseKey) ||
    value.account_key !== null && !HASH.test(value.account_key) ||
    ![value.written_at, value.next_due, value.failures, value.rotation].every(integer) ||
    value.written_at > now || value.next_due < value.written_at ||
    value.failures > 64 || value.rotation > 1_000_000_000 || !["attempting", "ok", "busy", "failed"].includes(value.last_outcome)) return null;
  const cooldowns = safeCooldowns(value.cooldowns, value.written_at);
  if (!cooldowns || ![null, "cooldown_invalid"].includes(value.blocked_reason) ||
    value.next_due > Math.max(value.written_at + REMOTE_SAMPLE_MAX_BACKOFF_MS, ...Object.values(cooldowns))) return null;
  // Let the collector explicitly account for aged-out unresolved findings.
  const observations = sanitizeRemoteObservations(value.observations, now, false);
  return observations ? { ...value, observations } : null;
}

export function remoteSamplePaths(logDir, databaseKey) {
  const directory = resolve(logDir, "remote-sample");
  return { directory, state: join(directory, `${databaseKey}.json`), lock: join(directory, "live-probe.lock"), cache: resolve(logDir, "live-probe.json") };
}

function secureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw new Error("unsafe scheduler directory");
}

/** @returns {{status:'missing'|'invalid'|'ready',state:ScheduleState|null}} */
export function readRemoteSampleState(path, databaseKey, now) {
  const loaded = readStableJsonFile(path, { maxBytes: MAX_STATE_BYTES, requirePrivate: true });
  if (loaded.status !== "ready") return { status: loaded.status === "missing" ? "missing" : "invalid", state: null };
  const state = validateRemoteSampleState(loaded.value, databaseKey, now);
  return { status: state ? "ready" : "invalid", state };
}

/** Atomic, private writes; no identifiers, bodies or error strings enter state. */
export function writeRemoteSampleState(path, state, now) {
  if (!validateRemoteSampleState(state, state.database_key, now)) throw new Error("invalid scheduler state");
  secureDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd;
  let directoryFd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, `${JSON.stringify(state)}\n`);
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    directoryFd = openSync(dirname(path), constants.O_RDONLY);
    fsyncSync(directoryFd);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (directoryFd !== undefined) closeSync(directoryFd);
    try { unlinkSync(temporary); } catch { /* The successful rename removed it. */ }
  }
}

function intervalMs(opts) {
  const seconds = opts.remoteSampleIntervalSeconds ?? 900;
  return seconds === 0 ? 0 : Number.isSafeInteger(seconds) && seconds >= 900 && seconds <= 1800 ? seconds * 1000 : null;
}

/** @param {number|null} [nextDue] */
function result(outcome, reason, nextDue = null, cooldownsByOperation = {}) { return { outcome, reason, next_due: nextDue, cooldownsByOperation }; }

function invalidateAttempt(opts, deps, reason) {
  try {
    return Boolean((deps.invalidateCache || invalidateRemoteSampleCache)(resolve(opts.logDir, "live-probe.json"), {
      context: liveProbeContext(opts.db), nowMs: (deps.nowMs || Date.now)(), reason,
    }));
  } catch { return false; }
}

function boundedCollectorOptions(value = {}) {
  return Object.fromEntries(["startMs", "endMs", "hotChats", "messagesPerChat"].filter(key => integer(value[key])).map(key => [key, value[key]]));
}

/** Restore shared transport cooldowns before the worker's first sync cycle. */
export function readScheduledRemoteCooldowns(opts, deps = {}) {
  try {
    const now = (deps.nowMs || Date.now)();
    const key = (deps.databaseKey || activityDatabaseKey)(opts.db);
    if (!key) return {};
    const loaded = readRemoteSampleState(remoteSamplePaths(opts.logDir, key).state, key, now);
    return loaded.state ? mergeCooldowns({}, loaded.state.cooldowns, now) : {};
  } catch { return {}; }
}

/** Start a single bounded background attempt without waiting for its API calls.
 * The guardian holds the existing schedule lock through final cache publication.
 * @param {ScheduleOptions} opts */
export function startScheduledRemoteSample(opts, deps = {}) {
  const failed = (reason) => result("failed", reason);
  try {
    const interval = intervalMs(opts);
    if (interval === 0) return result("disabled", "disabled");
    if (interval === null) return failed("invalid_interval");
    const now = (deps.nowMs || Date.now)();
    const databaseKey = (deps.databaseKey || activityDatabaseKey)(opts.db);
    if (!databaseKey) return failed("database_unavailable");
    const paths = remoteSamplePaths(opts.logDir, databaseKey);
    const loaded = readRemoteSampleState(paths.state, databaseKey, now);
    if (loaded.status === "invalid" || loaded.state?.blocked_reason) return failed("state_invalid");
    const inherited = safeCooldowns(deps.cooldownsByOperation || {}, now);
    if (!inherited) return failed("state_invalid");
    const cooldowns = mergeCooldowns(loaded.state?.cooldowns || {}, inherited, now);
    const nextDue = loaded.state?.next_due ?? deps.notBeforeIfMissing ?? now;
    if (nextDue > now) return result("not_due", "not_due", nextDue, cooldowns);
    secureDirectory(paths.directory);
    const publication = createRemoteSamplePublication(opts.logDir, databaseKey);
    const input = JSON.stringify({ db: resolve(opts.db), logDir: resolve(opts.logDir), remoteSampleIntervalSeconds: interval / 1000,
      cooldownsByOperation: cooldowns, publication });
    if (Buffer.byteLength(input) > 16 * 1024) return failed("scheduler_unavailable");
    const python = deps.pythonPath || "python3";
    const child = (deps.spawn || spawn)(python, ["-c", REMOTE_SAMPLE_LOCK_WRAPPER, paths.lock, python,
      "-c", REMOTE_SAMPLE_GUARDIAN, String(process.pid), String(REMOTE_SAMPLE_TIMEOUT_MS), deps.execPath || process.execPath, deps.scriptPath || MAIN_PATH], {
      stdio: "ignore", detached: true, env: { ...process.env, EXOCORTEX_REMOTE_SAMPLE_INPUT: input, EXOCORTEX_REMOTE_SAMPLE_CAPTURE: "0",
        EXOCORTEX_REMOTE_SAMPLE_PUBLICATION: JSON.stringify(publication) },
    });
    // No pipe callbacks or timers are needed by the synchronous worker loop.
    child.once("error", () => {});
    child.unref();
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return failed("scheduler_unavailable");
    return { ...result("started", "sample_started", now + REMOTE_SAMPLE_TIMEOUT_MS, cooldowns),
      stop: () => { try { child.kill("SIGTERM"); } catch { /* Already stopped. */ } } };
  } catch { return failed("scheduler_unavailable"); }
}

/** One optional in-flight job belongs to the existing worker, not another
 * scheduling loop. The guardian enforces the deadline even while sync blocks.
 * @param {ScheduleOptions} opts */
export function createRemoteSampleController(opts, deps = {}) {
  let stopJob = /** @type {null|(() => void)} */ (null);
  let activeUntil = 0;
  let retryIfMissing = 0;
  return {
    run(runDeps = {}) {
      const combined = /** @type {Record<string, any>} */ ({ ...deps, ...runDeps });
      const now = (combined.nowMs || Date.now)();
      if (now < activeUntil) return result("not_due", "not_due", activeUntil);
      const sampled = (deps.start || startScheduledRemoteSample)(opts, { ...combined, notBeforeIfMissing: retryIfMissing });
      if (sampled.outcome === "started") {
        stopJob?.(); stopJob = sampled.stop;
        activeUntil = now + REMOTE_SAMPLE_TIMEOUT_MS;
        retryIfMissing = now + MIN_INTERVAL_MS;
      }
      return sampled;
    },
    stop() { stopJob?.(); stopJob = null; },
  };
}

/** The parent only reads the state and starts a bounded child when due.
 * @param {ScheduleOptions} opts */
export function runScheduledRemoteSample(opts, deps = {}) {
  const failed = (reason, diagnostic = null) => {
    const safe = safeGuardianDiagnostic(diagnostic);
    return { ...result("failed", reason), ...(safe ? { guardian_diagnostic: safe } : {}) };
  };
  try {
    const interval = intervalMs(opts);
    if (interval === 0) return result("disabled", "disabled");
    if (interval === null) return failed("invalid_interval");
    const now = (deps.nowMs || Date.now)();
    const databaseKey = (deps.databaseKey || activityDatabaseKey)(opts.db);
    if (!databaseKey) return failed("database_unavailable");
    const paths = remoteSamplePaths(opts.logDir, databaseKey);
    const loaded = readRemoteSampleState(paths.state, databaseKey, now);
    if (loaded.status === "invalid") return failed("state_invalid");
    const inherited = safeCooldowns(deps.cooldownsByOperation || {}, now);
    if (!inherited || loaded.state?.blocked_reason) return failed("state_invalid");
    const cooldowns = mergeCooldowns(loaded.state?.cooldowns || {}, inherited, now);
    if (loaded.state && loaded.state.next_due > now) return result("not_due", "not_due", loaded.state.next_due, cooldowns);
    secureDirectory(paths.directory);
    const publication = createRemoteSamplePublication(opts.logDir, databaseKey);
    const python = deps.pythonPath || "python3";
    const child = runGuardedRemoteSampleProcess(deps.execPath || process.execPath, [deps.scriptPath || MAIN_PATH], {
      guardianPrefix: ["-c", REMOTE_SAMPLE_LOCK_WRAPPER, paths.lock, python],
      env: { ...process.env, EXOCORTEX_REMOTE_SAMPLE_PUBLICATION: JSON.stringify(publication) },
      input: JSON.stringify({ db: resolve(opts.db), logDir: resolve(opts.logDir), remoteSampleIntervalSeconds: interval / 1000, cooldownsByOperation: cooldowns,
        collectorOptions: boundedCollectorOptions(deps.collectorOptions), returnReport: deps.returnReport === true, publication }),
    }, deps);
    if (child.guardian_diagnostic || child.error || child.signal) return failed("sample_process_failed", child.guardian_diagnostic);
    let output;
    try { output = JSON.parse(String(child.stdout || "")); } catch { return failed("sample_process_failed"); }
    if (output?.report && Object.hasOwn(output.report, "guardian_diagnostic")) return failed("sample_process_failed", output.report.guardian_diagnostic);
    if (child.status !== 0 || !["ok", "busy", "not_due", "failed"].includes(output?.outcome)) return failed("sample_process_failed");
    const reasons = new Set(["sampled", "sample_failed", "scheduler_busy", "sync_busy", "not_due", "state_invalid", "database_unavailable", "state_write_failed", "database_changed", "scheduler_unavailable", "cache_write_failed"]);
    if (!reasons.has(output.reason)) return failed("sample_process_failed");
    const observed = safeCooldowns(output.cooldownsByOperation || {}, (deps.nowMs || Date.now)());
    if (!observed) return failed("state_invalid");
    return { ...result(output.outcome, output.reason, integer(output.next_due) ? output.next_due : null, mergeCooldowns(cooldowns, observed, now)),
      ...(deps.returnReport === true && output.report ? { report: publicRemoteReport(output.report), cacheWritten: output.cacheWritten === true } : {}) };
  } catch { return failed("scheduler_unavailable"); }
}

/** Manual cache-writing checks share the exact same lock, history and due gate.
 * A not_due result explicitly means no fresh remote check took place. */
export function runManualRemoteSample(opts, deps = {}) {
  return runScheduledRemoteSample(opts, { ...deps, returnReport: true });
}

/** Runs only inside the kernel lock acquired by the wrapper. Tests inject a
 * synthetic collector; this function never writes the business database.
 * @param {ScheduleOptions} opts */
export async function executeRemoteSampleAttempt(opts, deps = {}) {
  const failed = (reason) => { invalidateAttempt(opts, deps, reason); return { ...result("failed", reason), cachePrepared: false }; };
  const nowMs = deps.nowMs || Date.now;
  const dbKey = deps.databaseKey || activityDatabaseKey;
  const interval = intervalMs(opts);
  if (!interval) return failed("invalid_interval");
  const started = nowMs();
  const databaseKey = dbKey(opts.db);
  if (!databaseKey) return failed("database_unavailable");
  const stagePath = remoteSamplePublicationStage(opts.logDir, databaseKey, opts.publication);
  if (!stagePath) return failed("cache_write_failed");
  const paths = remoteSamplePaths(opts.logDir, databaseKey);
  const loaded = readRemoteSampleState(paths.state, databaseKey, started);
  if (loaded.status === "invalid") return failed("state_invalid");
  if (loaded.state?.blocked_reason) return failed("state_invalid");
  if (loaded.state && loaded.state.next_due > started) return { ...result("not_due", "not_due", loaded.state.next_due), cachePrepared: false };
  const previous = loaded.state || { kind: STATE_KIND, database_key: databaseKey, written_at: started,
    next_due: started, failures: 0, rotation: 0, observations: {}, last_outcome: "ok", cooldowns: {}, account_key: null, blocked_reason: null };
  const inherited = safeCooldowns(deps.cooldownsByOperation || {}, started);
  if (!inherited) return failed("state_invalid");
  const cooldowns = mergeCooldowns(previous.cooldowns, inherited, started);
  const failures = Math.min(64, previous.failures + 1);
  const backoff = Math.min(REMOTE_SAMPLE_MAX_BACKOFF_MS, MIN_INTERVAL_MS * 2 ** Math.min(5, failures - 1));
  const reserved = { ...previous, failures, cooldowns, last_outcome: "attempting", written_at: started, next_due: started + backoff };
  const writeState = deps.writeState || writeRemoteSampleState;
  // Invalidate before reserving and before any remote request. A killed child
  // can leave an attempted state, but cannot leave a renewed positive cache.
  if (!invalidateAttempt(opts, deps, "attempting")) return { ...result("failed", "cache_write_failed"), cachePrepared: false };
  try { writeState(paths.state, reserved, started); } catch { return failed("state_write_failed"); }
  let sampled;
  try {
    const collect = deps.collect || (await import("../../diagnostics/remote-sample.mjs")).collectRemoteSample;
    sampled = await collect(opts.db, { ...boundedCollectorOptions(deps.collectorOptions), rotation: previous.rotation, previousObservations: previous.observations,
      accountKey: previous.account_key, cooldownsByOperation: cooldowns,
      maxApiCalls: 12, minApiGapMs: 1000, totalTimeoutMs: 55_000, cacheTtlMs: Math.max(30 * 60_000, interval * 2) });
  } catch { sampled = { outcome: "failed" }; }
  const finished = nowMs();
  if (!integer(finished) || finished < started) return failed("state_invalid");
  if (dbKey(opts.db) !== databaseKey) return failed("database_changed");
  const observations = sampled?.outcome === "ok" ? sanitizeRemoteObservations(sampled.observations, finished) : null;
  const successful = sampled?.outcome === "ok" && integer(sampled.rotation) && sampled.rotation <= 1_000_000_000 && observations !== null;
  const busy = sampled?.outcome === "busy";
  const observedCooldowns = safeCooldowns(sampled?.cooldownsByOperation || {}, finished);
  const sampledAccount = HASH.test(sampled.cacheContext?.account_key || "") ? sampled.cacheContext.account_key : null;
  const changedUnverifiedAccount = sampledAccount && previous.account_key && sampledAccount !== previous.account_key && sampled.cacheContext?.auth_identity_verified !== true;
  const ok = successful && Boolean(sampled.report) && observedCooldowns !== null && !changedUnverifiedAccount;
  const finalCooldowns = mergeCooldowns(cooldowns, observedCooldowns || {}, finished);
  const nextDue = Math.max(finished + (ok ? interval : busy ? BUSY_RETRY_MS : backoff), ...Object.values(finalCooldowns));
  const finalState = { ...reserved, written_at: finished, next_due: nextDue, cooldowns: finalCooldowns,
    blocked_reason: observedCooldowns ? null : "cooldown_invalid",
    account_key: ok && sampled.cacheContext?.auth_identity_verified === true && sampledAccount ? sampledAccount : previous.account_key,
    failures: ok ? 0 : busy ? previous.failures : failures, last_outcome: ok ? "ok" : busy ? "busy" : "failed",
    rotation: ok ? sampled.rotation : previous.rotation, observations: changedUnverifiedAccount ? {} : ok ? observations : previous.observations };
  try { writeState(paths.state, finalState, finished); } catch { return failed("state_write_failed"); }
  if (!observedCooldowns) return failed("state_invalid");
  // Prepare a private stage only after durable schedule state succeeds. The
  // guardian alone can publish it after successful group cleanup and reap.
  let cacheWritten = false;
  if (sampled?.report && (successful || ["failed", "busy"].includes(sampled.outcome))) {
    try {
      const writeCache = deps.writeCache || (await import("../../diagnostics/remote-sample.mjs")).writeRemoteSampleCache;
      cacheWritten = Boolean(await writeCache(stagePath, sampled));
    } catch { cacheWritten = false; }
  }
  if (!cacheWritten) {
    invalidateAttempt(opts, deps, "sample_failed");
    if (ok) {
      const failedState = { ...finalState, failures, last_outcome: "failed", rotation: previous.rotation, observations: previous.observations,
        next_due: Math.max(finished + backoff, ...Object.values(finalCooldowns)) };
      try { writeState(paths.state, failedState, finished); } catch { return failed("state_write_failed"); }
      return { ...result("failed", "cache_write_failed", failedState.next_due, finalCooldowns), cachePrepared: false };
    }
  }
  return { ...result(ok ? "ok" : busy ? "busy" : "failed", ok ? "sampled" : busy ? "sync_busy" : "sample_failed", finalState.next_due, finalCooldowns), cachePrepared: cacheWritten,
    ...(deps.returnReport === true && sampled?.report ? { report: publicRemoteReport(sampled.report), cacheWritten } : {}) };
}
