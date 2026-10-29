// @ts-check
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { readStableJsonFile } from "../diagnostics/private-json-file.mjs";

const errorCode = (/** @type {unknown} */ error) => /** @type {NodeJS.ErrnoException|null} */ (error)?.code;
const FLOCK_HELPER = fileURLToPath(new URL("./lark-api-flock.py", import.meta.url));
/** @type {Set<number>} */ const activeLeaseDescriptors = new Set();
// Internal wait context follows the exact options object through the injected
// acquisition seam. Pure acquisition mocks never open a default shared path;
// real acquisitions use their explicitly injected directory for both files.
/** @type {WeakMap<object, {intent?: ReturnType<typeof acquireKernelLock>}>} */
const syncWaitContexts = new WeakMap();
const COOLDOWN_OPERATIONS = new Set(["message_history_bundle", "message_search_bundle", "chat_discovery_bundle",
  "self_profile", "contact_search", "chat_members", "chat_bots", "application_info", "other"]);
const MAX_COOLDOWNS = 128;
const COOLDOWN_NAME = /^([a-z_]+)-(\d+)\.json$/;
const COOLDOWN_VALUE = "value.json";

/** Legacy records are files; atomically published records are nonempty private
 * directories containing one single-link file. Never follow a directory alias
 * or accept an active record whose directory changed during the bounded read.
 * @param {string} file */
function readCooldownRecord(file) {
  try {
    const before = lstatSync(file, { bigint: true });
    if (!before.isDirectory()) return readStableJsonFile(file, { maxBytes: 512 });
    privateDirectory(file, false);
    const names = readdirSync(file);
    if (names.length !== 1 || names[0] !== COOLDOWN_VALUE) throw new Error("invalid_cooldown_record");
    const loaded = readStableJsonFile(join(file, COOLDOWN_VALUE), { maxBytes: 512 });
    const after = lstatSync(file, { bigint: true });
    if (loaded.status !== "ready" || !["dev", "ino", "mode", "uid", "nlink", "mtimeNs", "ctimeNs"]
      .every(key => before[key] === after[key])) throw new Error("unstable_cooldown_record");
    return loaded;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      try { lstatSync(file); } catch (missing) { if (errorCode(missing) === "ENOENT") return { status: "missing", value: null }; }
    }
    return { status: "invalid", value: null };
  }
}

/** Clean only our known temporary payload, never recursively delete entries.
 * @param {string} directory */
function removeCooldownTemporary(directory) {
  try { unlinkSync(join(directory, COOLDOWN_VALUE)); } catch { /* Absent or unavailable. */ }
  try { rmdirSync(directory); } catch { /* Do not remove unknown entries. */ }
}

/** @param {string} directory @param {boolean} create */
function privateDirectory(directory, create) {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("unsupported_platform");
  if (create) {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
  }
  let info;
  try { info = lstatSync(directory); }
  catch (error) { if (!create && errorCode(error) === "ENOENT") return false; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0) throw new Error("unsafe_directory");
  return true;
}

/** Immutable per-operation timestamps preserve the maximum under concurrent
 * publication; no last-writer-wins map can shorten another process's cooldown.
 * Atomic nonempty-directory rename exposes fully written single-link records
 * and cannot replace another valid record with the same operation and expiry.
 * Expired records can be deleted independently; no live lease is revoked.
 * @param {{operation: string, nowMs?: number}} options
 * @param {{directory?: string}} [deps]
 * @returns {{state: "ready"|"cooldown"|"unavailable", untilMs: number|null}}
 */
function readSharedLarkCooldown(options, deps = {}) {
  try {
    if (!COOLDOWN_OPERATIONS.has(options.operation) || !Number.isSafeInteger(options.nowMs ?? Date.now())) throw new Error("invalid_input");
    const now = options.nowMs ?? Date.now();
    const root = deps.directory || `/tmp/exocortex-lark-api-${process.getuid?.()}`;
    const directory = join(root, "cooldowns");
    if (!privateDirectory(root, false) || !privateDirectory(directory, false)) return { state: "ready", untilMs: null };
    const names = readdirSync(directory).filter((name) => !name.endsWith(".tmp"));
    if (names.length > MAX_COOLDOWNS) throw new Error("cooldown_limit");
    let until = 0;
    for (const name of names) {
      const match = COOLDOWN_NAME.exec(name);
      if (!match || !COOLDOWN_OPERATIONS.has(match[1]) || !Number.isSafeInteger(Number(match[2]))) throw new Error("invalid_cooldown");
      const file = join(directory, name);
      const loaded = readCooldownRecord(file);
      if (loaded.status === "missing") continue;
      if (loaded.status !== "ready") {
        // A concurrent publisher may prune an expired immutable record after
        // this reader opened it. Never ignore a changed active record.
        if (Number(match[2]) <= now) {
          try { lstatSync(file); } catch (error) { if (errorCode(error) === "ENOENT") continue; }
        }
        throw new Error("unsafe_cooldown");
      }
      const stored = loaded.value;
      if (stored?.version !== 1 || stored.operation !== match[1] || stored.untilMs !== Number(match[2])) throw new Error("invalid_cooldown");
      if (stored.untilMs > now && (stored.operation === options.operation || stored.operation === "other")) until = Math.max(until, stored.untilMs);
    }
    return { state: until > now ? "cooldown" : "ready", untilMs: until > now ? until : null };
  } catch { return { state: "unavailable", untilMs: null }; }
}

/** No identifiers, command arguments or remote payloads enter this store.
 * Values are not shortened to a retry budget or presumed vendor maximum.
 * @param {{operation: string, untilMs: number, nowMs?: number}} options
 * @param {{directory?: string}} [deps] */
function writeSharedLarkCooldown(options, deps = {}) {
  let temporary = "", fd;
  try {
    const now = options.nowMs ?? Date.now();
    if (!COOLDOWN_OPERATIONS.has(options.operation) || !Number.isSafeInteger(now) || !Number.isSafeInteger(options.untilMs) || options.untilMs <= now) return false;
    const root = deps.directory || `/tmp/exocortex-lark-api-${process.getuid?.()}`;
    const directory = join(root, "cooldowns");
    privateDirectory(root, true); privateDirectory(directory, true);
    const existing = readSharedLarkCooldown({ operation: options.operation, nowMs: now }, deps);
    if (existing.state === "unavailable") return false;
    // Filenames are immutable and unique to their expiry, so an expired record
    // cannot have been replaced with a new active value when it is removed.
    for (const name of readdirSync(directory)) {
      const match = COOLDOWN_NAME.exec(name);
      if (match && Number(match[2]) <= now) {
        const expired = join(directory, name);
        try {
          if (lstatSync(expired).isDirectory()) {
            privateDirectory(expired, false);
            const retired = join(directory, `${randomUUID()}.tmp`);
            mkdirSync(retired, { mode: 0o700 });
            try { renameSync(expired, retired); } finally { removeCooldownTemporary(retired); }
          } else unlinkSync(expired);
        } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
      }
    }
    // Idempotent or smaller resets need no additional immutable record. This
    // also avoids consuming the capacity guard on repeated same-reset writes.
    if (existing.state === "cooldown" && Number(existing.untilMs) >= options.untilMs) return true;
    const names = readdirSync(directory).filter((name) => !name.endsWith(".tmp"));
    if (names.length >= MAX_COOLDOWNS) return false;
    const target = join(directory, `${options.operation}-${options.untilMs}.json`);
    temporary = join(directory, `${randomUUID()}.tmp`);
    mkdirSync(temporary, { mode: 0o700 });
    fd = openSync(join(temporary, COOLDOWN_VALUE), "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ version: 1, operation: options.operation, untilMs: options.untilMs }));
    fsyncSync(fd); closeSync(fd); fd = undefined;
    // A hard link/unlink window exposes nlink=2. A complete directory rename
    // instead exposes only a single-link payload. The nonempty target cannot
    // be replaced by another same-expiry publisher; both can validate it.
    try { renameSync(temporary, target); temporary = ""; }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(errorCode(error) || "")) throw error;
    }
    const result = readSharedLarkCooldown({ operation: options.operation, nowMs: now }, deps);
    return result.state === "cooldown" && Number(result.untilMs) >= options.untilMs;
  } catch { return false; }
  finally {
    try { if (fd !== undefined) closeSync(fd); } catch { /* Closed or unavailable. */ }
    if (temporary) removeCooldownTemporary(temporary);
  }
}

/** Announce a sync waiter with a shared intent lock for the entire API wait.
 * Later probes need an exclusive intent lock, so cannot chain ahead of an
 * announced waiter. An already active request or local commit is not preempted;
 * a long commit can still exhaust this wait. Sync waiters are not FIFO.
 * Convert an optional wall deadline once, then account for helper execution,
 * filesystem work and sleeps against one monotonic deadline across attempts.
 * @param {{db?: string, deadlineMs?: number}} options
 * @param {{acquire?: typeof tryAcquireLarkApiLease, clock?: () => number, monotonicClock?: () => number, sleep?: (ms: number) => void, maxWaitMs?: number}} [deps] */
function acquireSyncLarkApiLease(options, deps = {}) {
  const clock = deps.clock || Date.now;
  const monotonicClock = deps.monotonicClock || (() => performance.now());
  const sleep = deps.sleep || ((ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); });
  const limit = Math.min(5000, Math.max(0, deps.maxWaitMs ?? 5000));
  const start = monotonicClock();
  const wallRemaining = options.deadlineMs === undefined ? limit : Math.max(0, options.deadlineMs - clock());
  const monotonicDeadlineMs = start + Math.min(limit, wallRemaining);
  const request = { ...options, role: /** @type {const} */ ("sync"), monotonicDeadlineMs };
  /** @type {{intent?: ReturnType<typeof acquireKernelLock>}} */ const context = {};
  syncWaitContexts.set(request, context);
  try {
    while (true) {
      const result = (deps.acquire || tryAcquireLarkApiLease)(request, { clock, monotonicClock });
      if (result.state !== "busy") return result;
      const remaining = monotonicDeadlineMs - monotonicClock();
      if (remaining <= 0) return result;
      const pause = Math.min(100, remaining);
      sleep(pause);
    }
  } finally {
    syncWaitContexts.delete(request);
    context.intent?.release();
  }
}

/** Inherit a held lease into the actual API subprocess, so killing Node cannot
 * release the lock while that request still runs. No descriptor enters JSON.
 * @returns {import("node:child_process").StdioOptions|undefined} */
function getLarkApiLeaseStdio() {
  const fd = activeLeaseDescriptors.values().next().value;
  return fd === undefined ? undefined : ["pipe", "pipe", "pipe", fd];
}

/** A short Python helper applies flock to Node's duplicated descriptor. The
 * open-file description is shared across dup/fork, so Node continues holding
 * the lock after the helper exits. Final close/process death releases it.
 * No PID, ps, stale-file removal, TTL or persistent helper is involved.
 * All databases for this Unix user share the never-unlinked API and intent
 * files. Only the API descriptor may enter an actual request child.
 *
 * deadlineMs is a public wall-clock boundary, translated only on entry;
 * monotonicDeadlineMs carries the enclosing sync budget across helper calls.
 * @param {{role: "sync"|"probe", db?: string, deadlineMs?: number, monotonicDeadlineMs?: number}} options
 * @param {{directory?: string, clock?: () => number, monotonicClock?: () => number, spawnSync?: typeof spawnSync}} [deps]
 * @returns {{state: "acquired"|"busy"|"unavailable", reason: string|null, release: () => void, stdio?: import("node:child_process").StdioOptions}}
 */
function tryAcquireLarkApiLease(options, deps = {}) {
  const failed = (/** @type {"busy"|"unavailable"} */ state, /** @type {string} */ reason) => ({ state, reason, release() {} });
  const uid = process.getuid?.();
  if (!["sync", "probe"].includes(options.role) || uid === undefined) return failed("unavailable", "lease_platform_unavailable");
  const directory = deps.directory || `/tmp/exocortex-lark-api-${uid}`;
  const clock = deps.clock || Date.now;
  const monotonicClock = deps.monotonicClock || (() => performance.now());
  const started = monotonicClock();
  const wallRemaining = options.monotonicDeadlineMs !== undefined || options.deadlineMs === undefined
    ? 2000 : Math.max(0, options.deadlineMs - clock());
  const deadline = Math.min(options.monotonicDeadlineMs ?? started + wallRemaining, started + 2000);
  if (!Number.isFinite(started) || !Number.isFinite(deadline) || deadline <= started) return failed("unavailable", "lease_deadline");
  const context = options.role === "sync" ? syncWaitContexts.get(options) : undefined;
  const intent = context?.intent || acquireKernelLock("sync-intent.lock", options.role === "sync" ? "shared" : "exclusive", deadline,
    { ...deps, directory, clock, monotonicClock });
  if (intent.state !== "acquired") return intent;
  if (context) context.intent = intent;
  try {
    if (!intent.isCurrent?.()) return failed("unavailable", "lease_evidence_unavailable");
    const api = acquireKernelLock("api.lock", "exclusive", deadline, { ...deps, directory, clock, monotonicClock });
    if (api.state === "acquired") {
      if (!intent.isCurrent?.() || monotonicClock() >= deadline) {
        api.release();
        return failed("unavailable", "lease_evidence_unavailable");
      }
      if (api.stdio) activeLeaseDescriptors.add(/** @type {number} */ (api.stdio[3]));
    }
    return api;
  } finally {
    // A sync wrapper owns its shared intent across retries, then closes it on
    // every return/throw. One-shot sync and all probes close the gate here.
    if (!context) intent.release();
  }
}

/** Both immutable files use identical ownership, path and descriptor checks.
 * The supplied deadline covers gate and API helper work together.
 * @param {string} filename
 * @param {"shared"|"exclusive"} mode
 * @param {number} deadline
 * @param {{directory: string, clock: () => number, monotonicClock: () => number, spawnSync?: typeof spawnSync}} deps
 */
function acquireKernelLock(filename, mode, deadline, deps) {
  const failed = (/** @type {"busy"|"unavailable"} */ state, /** @type {string} */ reason) => ({ state, reason, release() {} });
  const { directory, monotonicClock } = deps;
  const uid = process.getuid?.();
  /** @type {number|undefined} */ let fd;
  const release = () => {
    if (fd === undefined) return;
    const held = fd; fd = undefined; activeLeaseDescriptors.delete(held);
    try { closeSync(held); } catch { /* Do not retry close on a possibly reused fd. */ }
  };
  try {
    privateDirectory(directory, true);
    const file = join(directory, filename);
    fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o077) !== 0 || info.nlink !== 1) throw new Error("unsafe_lock");
    const timeout = Math.floor(deadline - monotonicClock());
    if (timeout <= 0) { release(); return failed("unavailable", "lease_deadline"); }
    const result = (deps.spawnSync || spawnSync)("python3", ["-B", FLOCK_HELPER, mode], {
      stdio: ["ignore", "ignore", "ignore", fd], timeout, killSignal: "SIGKILL",
    });
    if (result.error || result.signal || monotonicClock() > deadline) { release(); return failed("unavailable", "lease_helper_unavailable"); }
    if (result.status !== 0) { release(); return failed(result.status === 75 ? "busy" : "unavailable", result.status === 75 ? "lark_api_busy" : "lease_helper_unavailable"); }
    const isCurrent = () => {
      try {
        privateDirectory(directory, false);
        if (fd === undefined) return false;
        const held = fstatSync(fd), current = lstatSync(file);
        return current.isFile() && !current.isSymbolicLink() && current.uid === uid && (current.mode & 0o077) === 0
          && current.nlink === 1 && held.nlink === 1 && current.dev === info.dev && current.ino === info.ino;
      } catch { return false; }
    };
    if (!isCurrent()) throw new Error("lock_replaced");
    if (monotonicClock() >= deadline) { release(); return failed("unavailable", "lease_deadline"); }
    return { state: /** @type {const} */ ("acquired"), reason: null, release, isCurrent,
      stdio: /** @type {import("node:child_process").StdioOptions} */ (["pipe", "pipe", "pipe", fd]) };
  } catch {
    release();
    return failed("unavailable", "lease_evidence_unavailable");
  }
}

export { tryAcquireLarkApiLease, acquireSyncLarkApiLease, getLarkApiLeaseStdio, readSharedLarkCooldown, writeSharedLarkCooldown };
