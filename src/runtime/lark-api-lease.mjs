// @ts-check
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { readStableJsonFile } from "../diagnostics/private-json-file.mjs";

const errorCode = (/** @type {unknown} */ error) => /** @type {NodeJS.ErrnoException|null} */ (error)?.code;
const FLOCK_HELPER = fileURLToPath(new URL("./lark-api-flock.py", import.meta.url));
/** @type {Set<number>} */ const activeLeaseDescriptors = new Set();
const COOLDOWN_OPERATIONS = new Set(["message_history_bundle", "message_search_bundle", "chat_discovery_bundle",
  "self_profile", "contact_search", "chat_members", "chat_bots", "application_info", "other"]);
const MAX_COOLDOWNS = 128;

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
 * Atomic hard-link publication exposes only fully written private records.
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
      const match = /^([a-z_]+)-(\d+)\.json$/.exec(name);
      if (!match || !COOLDOWN_OPERATIONS.has(match[1]) || !Number.isSafeInteger(Number(match[2]))) throw new Error("invalid_cooldown");
      const file = join(directory, name);
      const loaded = readStableJsonFile(file, { maxBytes: 512 });
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
    if (readSharedLarkCooldown({ operation: options.operation, nowMs: now }, deps).state === "unavailable") return false;
    // Filenames are immutable and unique to their expiry, so an expired record
    // cannot have been replaced with a new active value when it is removed.
    for (const name of readdirSync(directory)) {
      const match = /^([a-z_]+)-(\d+)\.json$/.exec(name);
      if (match && Number(match[2]) <= now) {
        try { unlinkSync(join(directory, name)); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
      }
    }
    const names = readdirSync(directory).filter((name) => !name.endsWith(".tmp"));
    if (names.length >= MAX_COOLDOWNS) return false;
    const target = join(directory, `${options.operation}-${options.untilMs}.json`);
    temporary = join(directory, `${randomUUID()}.tmp`);
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ version: 1, operation: options.operation, untilMs: options.untilMs }));
    fsyncSync(fd); closeSync(fd); fd = undefined;
    try { linkSync(temporary, target); } catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
    unlinkSync(temporary); temporary = "";
    const result = readSharedLarkCooldown({ operation: options.operation, nowMs: now }, deps);
    return result.state === "cooldown" && Number(result.untilMs) >= options.untilMs;
  } catch { return false; }
  finally {
    try { if (fd !== undefined) closeSync(fd); } catch { /* Closed or unavailable. */ }
    try { if (temporary) unlinkSync(temporary); } catch { /* Unpublished or already removed. */ }
  }
}

/** Wait briefly for a single bounded probe request; unavailable evidence never
 * causes a retry, and no caller can seize the currently executing request.
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
  while (true) {
    const result = (deps.acquire || tryAcquireLarkApiLease)({ ...options, role: "sync", monotonicDeadlineMs }, { clock, monotonicClock });
    if (result.state !== "busy") return result;
    const remaining = monotonicDeadlineMs - monotonicClock();
    if (remaining <= 0) return result;
    const pause = Math.min(100, remaining);
    sleep(pause);
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
 * All databases for this Unix user share the one never-unlinked lock file.
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
  /** @type {number|undefined} */ let fd;
  const release = () => {
    if (fd === undefined) return;
    const held = fd; fd = undefined; activeLeaseDescriptors.delete(held);
    try { closeSync(held); } catch { /* Do not retry close on a possibly reused fd. */ }
  };
  try {
    privateDirectory(directory, true);
    const file = join(directory, "api.lock");
    fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o077) !== 0 || info.nlink !== 1) throw new Error("unsafe_lock");
    const timeout = Math.floor(deadline - monotonicClock());
    if (timeout <= 0) { release(); return failed("unavailable", "lease_deadline"); }
    const result = (deps.spawnSync || spawnSync)("python3", ["-B", FLOCK_HELPER], {
      stdio: ["ignore", "ignore", "ignore", fd], timeout, killSignal: "SIGKILL",
    });
    if (result.error || result.signal || monotonicClock() > deadline) { release(); return failed("unavailable", "lease_helper_unavailable"); }
    if (result.status !== 0) { release(); return failed(result.status === 75 ? "busy" : "unavailable", result.status === 75 ? "lark_api_busy" : "lease_helper_unavailable"); }
    const current = lstatSync(file);
    if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) throw new Error("lock_replaced");
    if (monotonicClock() >= deadline) { release(); return failed("unavailable", "lease_deadline"); }
    activeLeaseDescriptors.add(fd);
    return { state: "acquired", reason: null, release, stdio: ["pipe", "pipe", "pipe", fd] };
  } catch {
    release();
    return failed("unavailable", "lease_evidence_unavailable");
  }
}

export { tryAcquireLarkApiLease, acquireSyncLarkApiLease, getLarkApiLeaseStdio, readSharedLarkCooldown, writeSharedLarkCooldown };
