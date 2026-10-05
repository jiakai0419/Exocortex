import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createRemoteSamplePublication, remoteSamplePublicationStage } from "../src/runtime/worker/remote-sample-cache-gate.mjs";

// These tests execute the JavaScript control flow in a VM with every process,
// filesystem, collector and guardian dependency replaced. The only real reads
// load the source under test; no child, flock, guardian or business API runs.
const schedulerUrl = new URL("../src/runtime/worker/remote-sample-scheduler.mjs", import.meta.url);
const mainUrl = new URL("../src/runtime/worker/remote-sample-main.mjs", import.meta.url);
const schedulerSource = readFileSync(schedulerUrl, "utf8");
const mainSource = readFileSync(mainUrl, "utf8");
const NOW = 1_900_000_000_000;
const DATABASE = "a".repeat(64);
const OTHER_DATABASE = "b".repeat(64);
const ACCOUNT = "c".repeat(64);
const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const OTHER_ATTEMPT = "22222222-2222-4222-8222-222222222222";
const LOG_DIR = "/synthetic/logs";
const DB_PATH = "/synthetic/sample.sqlite";
const PRIVATE_TOKEN = "synthetic-private-error-must-not-be-published";

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function unavailable(name) { return () => { throw new Error(`unexpected real dependency: ${name}`); }; }
function withoutImports(source) { return source.replace(/^import .*;\r?$/gm, ""); }
function publication(database = DATABASE, attempt = ATTEMPT) {
  return createRemoteSamplePublication(LOG_DIR, database, attempt);
}
function options(overrides = {}) {
  return { db: DB_PATH, logDir: LOG_DIR, remoteSampleIntervalSeconds: 900, publication: publication(), ...overrides };
}
function state(overrides = {}) {
  return {
    kind: "lark_im_remote_sample_schedule/v1", database_key: DATABASE, account_key: ACCOUNT,
    written_at: NOW - 1_000, next_due: NOW - 1, failures: 0, rotation: 4,
    observations: {}, last_outcome: "ok", cooldowns: {}, blocked_reason: null, ...overrides,
  };
}
function sample(overrides = {}) {
  return {
    outcome: "ok", rotation: 5, observations: {}, cooldownsByOperation: {},
    cacheContext: { account_key: ACCOUNT, auth_identity_verified: true },
    report: { status: "healthy", reason: "sampled" }, ...overrides,
  };
}
function childResult(output = { outcome: "ok", reason: "sampled", next_due: NOW + 900_000 }) {
  return { status: 0, stdout: JSON.stringify(output) };
}

function schedulerHarness(settings = {}) {
  const calls = { invalidations: [], stages: [], states: [], collected: [], guarded: [], spawned: [], operations: [] };
  let visible = { generation: "existing" };
  const guard = (...args) => {
    calls.guarded.push(args);
    if (settings.guard) return settings.guard({ args, setVisible(value) { visible = value; } });
    return childResult();
  };
  const spawn = (...args) => {
    calls.spawned.push(args);
    if (settings.spawn) return settings.spawn(...args);
    return { pid: 456, once() {}, unref() {}, kill: unavailable("child.kill") };
  };
  const fakeDirectory = { mode: 0o40700, uid: 501, isDirectory: () => true, isSymbolicLink: () => false };
  const readState = () => settings.stateRead || (settings.state ? { status: "ready", value: settings.state } : { status: "missing" });
  const sandbox = {
    Buffer, dirname, join, resolve, fileURLToPath,
    process: { pid: 123, execPath: "/synthetic/node", env: {}, getuid: () => 501 },
    spawn, randomUUID: () => ATTEMPT, constants: {},
    mkdirSync() {}, lstatSync: () => fakeDirectory,
    closeSync: unavailable("closeSync"), fsyncSync: unavailable("fsyncSync"),
    openSync: unavailable("openSync"), renameSync: unavailable("renameSync"),
    unlinkSync: unavailable("unlinkSync"), writeFileSync: unavailable("writeFileSync"),
    activityDatabaseKey: () => DATABASE, TRANSPORT_OPERATIONS: ["im.message.list"],
    liveProbeContext: () => ({ database_key: DATABASE }),
    invalidateRemoteSampleCache: unavailable("un-injected cache invalidation"),
    publicRemoteReport: value => value, readStableJsonFile: readState,
    REMOTE_SAMPLE_GUARDIAN: "synthetic guardian source; never executed", REMOTE_SAMPLE_TIMEOUT_MS: 60_000,
    runGuardedRemoteSampleProcess: guard, safeGuardianDiagnostic: value => value || null,
    createRemoteSamplePublication: (logDir, databaseKey) => createRemoteSamplePublication(logDir, databaseKey, ATTEMPT),
    remoteSamplePublicationStage,
  };
  const source = withoutImports(schedulerSource)
    .replace(/^export \{.*\};\r?$/gm, "")
    .replace(/^export /gm, "")
    .replaceAll("import.meta.url", JSON.stringify(schedulerUrl.href));
  const api = vm.runInNewContext(`(() => { ${source}\nreturn { remoteSamplePaths, runScheduledRemoteSample, startScheduledRemoteSample, executeRemoteSampleAttempt }; })()`, sandbox, {
    filename: "remote-sample-scheduler.fake.mjs", timeout: 1_000,
  });
  const deps = {
    nowMs: () => NOW, databaseKey: settings.databaseKey || (() => DATABASE),
    invalidateCache(path, detail) {
      calls.invalidations.push({ path, detail: copy(detail) });
      calls.operations.push(`invalidate:${detail.reason}`);
      visible = { status: "unavailable", reason: detail.reason };
      return settings.invalidateResult !== false;
    },
    writeState(path, value) {
      calls.states.push({ path, value: copy(value) });
      calls.operations.push(`state:${value.last_outcome}`);
      if (settings.writeState) return settings.writeState(path, value, calls.states.length);
    },
    async collect(db, collectorOptions) {
      calls.collected.push({ db, options: copy(collectorOptions) });
      calls.operations.push("collect");
      return settings.sample || sample();
    },
    async writeCache(path, value) {
      calls.stages.push({ path, value });
      calls.operations.push("stage");
      return settings.writeCache ? settings.writeCache(path, value) : true;
    },
  };
  return { api, calls, deps, visible: () => visible };
}

async function mainHarness({ result, options: input = options(), lock: lockOverrides = {}, namedLock: namedOverrides = {}, environment = {}, collectResult } = {}) {
  const calls = { execute: [], collect: [], fstat: [], lstat: [], stdout: [] };
  const lock = {
    dev: 1, ino: 42, mode: 0o100600, uid: 501, nlink: 1,
    isFile: () => true, isSymbolicLink: () => false, ...lockOverrides,
  };
  const namedLock = { ...lock, ...namedOverrides };
  const fakeProcess = {
    env: {
      EXOCORTEX_REMOTE_SAMPLE_INPUT: JSON.stringify(input),
      EXOCORTEX_REMOTE_SAMPLE_LOCK_FD: "200",
      EXOCORTEX_REMOTE_SAMPLE_PUBLICATION: JSON.stringify(input.publication), ...environment,
    },
    getuid: () => 501,
    stdout: { write(value) { calls.stdout.push(value); } },
    exitCode: undefined,
  };
  const sandbox = {
    process: fakeProcess, readFileSync: unavailable("stdin read"),
    fstatSync(fd) { calls.fstat.push(fd); return lock; },
    lstatSync(path) { calls.lstat.push(path); return namedLock; },
    async executeRemoteSampleAttempt(...args) { calls.execute.push(args); return result; },
    collectRemoteSample(...args) { calls.collect.push(args); return collectResult; },
    publicRemoteReport: value => value,
  };
  await vm.runInNewContext(`(async () => { ${withoutImports(mainSource)}\n})()`, sandbox, {
    filename: "remote-sample-main.fake.mjs", timeout: 1_000,
  });
  return { calls, exitCode: fakeProcess.exitCode, output: JSON.parse(calls.stdout.join("")) };
}

test("one cache target has a shared lock across database identities and attempts", () => {
  const { api } = schedulerHarness();
  const first = publication();
  const second = publication(OTHER_DATABASE, OTHER_ATTEMPT);
  const firstPaths = api.remoteSamplePaths(LOG_DIR, DATABASE);
  const secondPaths = api.remoteSamplePaths(LOG_DIR, OTHER_DATABASE);
  assert.equal(first.cachePath, second.cachePath);
  assert.equal(first.lockPath, second.lockPath);
  assert.equal(firstPaths.lock, first.lockPath);
  assert.equal(secondPaths.lock, first.lockPath);
  assert.notEqual(firstPaths.state, secondPaths.state);
  assert.notEqual(first.stagePath, second.stagePath);
  assert.equal(remoteSamplePublicationStage(LOG_DIR, DATABASE, first), first.stagePath);
  assert.equal(remoteSamplePublicationStage(LOG_DIR, DATABASE, { ...first, lockPath: `${LOG_DIR}/remote-sample/${DATABASE}.lock` }), null);
});

test("manual and background parents pass the shared lock and exact attempt contract to the guardian", () => {
  const manual = schedulerHarness();
  assert.equal(manual.api.runScheduledRemoteSample(options(), manual.deps).outcome, "ok");
  const [, , guardedOptions] = manual.calls.guarded[0];
  assert.equal(guardedOptions.guardianPrefix[2], publication().lockPath);
  assert.deepEqual(JSON.parse(guardedOptions.env.EXOCORTEX_REMOTE_SAMPLE_PUBLICATION), publication());
  assert.deepEqual(JSON.parse(guardedOptions.input).publication, publication());
  assert.equal(manual.calls.invalidations.length, 0);

  const background = schedulerHarness({ databaseKey: () => OTHER_DATABASE });
  assert.equal(background.api.startScheduledRemoteSample(options(), background.deps).outcome, "started");
  const [, args, spawnOptions] = background.calls.spawned[0];
  assert.equal(args[2], publication().lockPath);
  const childPublication = JSON.parse(spawnOptions.env.EXOCORTEX_REMOTE_SAMPLE_PUBLICATION);
  assert.equal(childPublication.lockPath, publication().lockPath);
  assert.deepEqual(JSON.parse(spawnOptions.env.EXOCORTEX_REMOTE_SAMPLE_INPUT).publication, childPublication);
  assert.equal(background.calls.invalidations.length, 0);
});

test("an old child's failure cannot invalidate a newer result after the child releases the lock", async t => {
  const diagnostic = { version: 1, primary: null, cleanup: { stage: "group_kill", errno: 1 } };
  const cases = [
    ["spawn error", { error: new Error(PRIVATE_TOKEN), status: null }],
    ["signal", { signal: "SIGTERM", status: null }],
    ["guardian diagnostic", { ...childResult(), guardian_diagnostic: diagnostic }],
    ["malformed stdout", { status: 0, stdout: PRIVATE_TOKEN }],
    ["nonzero status", { ...childResult(), status: 2 }],
    ["failed child report", childResult({ outcome: "failed", reason: "cache_write_failed" })],
    ["unexpected reason", childResult({ outcome: "failed", reason: PRIVATE_TOKEN })],
    ["invalid cooldown", childResult({ outcome: "ok", reason: "sampled", cooldownsByOperation: { unknown: NOW + 1 } })],
    ["nested diagnostic", childResult({ outcome: "ok", reason: "sampled", report: { guardian_diagnostic: diagnostic } })],
  ];
  for (const [name, child] of cases) await t.test(name, () => {
    const harness = schedulerHarness({ guard({ setVisible }) { setVisible({ generation: "newer" }); return child; } });
    const result = harness.api.runScheduledRemoteSample(options(), harness.deps);
    assert.equal(result.outcome, "failed");
    assert.equal(harness.calls.invalidations.length, 0);
    assert.deepEqual(harness.visible(), { generation: "newer" });
    assert.ok(!JSON.stringify(result).includes(PRIVATE_TOKEN));
  });
});

test("preflight and background spawn failures do not write the shared cache outside its lock", async t => {
  const cases = [
    ["invalid interval", {}, { remoteSampleIntervalSeconds: 1 }],
    ["database unavailable", { databaseKey: () => null }, {}],
    ["invalid state", { stateRead: { status: "invalid" } }, {}],
    ["spawn throws", { spawn() { throw new Error(PRIVATE_TOKEN); } }, {}],
    ["spawn has no pid", { spawn: () => ({ once() {}, unref() {} }) }, {}],
  ];
  for (const [name, settings, overrides] of cases) await t.test(name, () => {
    const harness = schedulerHarness(settings);
    assert.equal(harness.api.startScheduledRemoteSample(options(overrides), harness.deps).outcome, "failed");
    assert.equal(harness.calls.invalidations.length, 0);
    assert.deepEqual(harness.visible(), { generation: "existing" });
  });
});

test("attempt reports prepared only after a completed write to its own stage", async () => {
  const harness = schedulerHarness({ state: state() });
  const result = await harness.api.executeRemoteSampleAttempt(options(), harness.deps);
  assert.equal(result.outcome, "ok");
  assert.equal(result.cachePrepared, true);
  assert.equal(harness.calls.stages.length, 1);
  assert.equal(harness.calls.stages[0].path, publication().stagePath);
  assert.notEqual(harness.calls.stages[0].path, publication().cachePath);
  assert.deepEqual(harness.calls.operations, ["invalidate:attempting", "state:attempting", "collect", "state:ok", "stage"]);
  assert.deepEqual(harness.visible(), { status: "unavailable", reason: "attempting" });
});

test("a stage left behind by a failed writer is explicitly unprepared", async t => {
  for (const failure of ["throw after stage rename", "false after stage rename"]) await t.test(failure, async () => {
    const fakeFiles = new Map();
    const harness = schedulerHarness({ state: state(), writeCache(path) {
      fakeFiles.set(path, { status: "healthy" });
      if (failure.startsWith("throw")) throw new Error(PRIVATE_TOKEN);
      return false;
    } });
    const result = await harness.api.executeRemoteSampleAttempt(options({ returnReport: true }), harness.deps);
    assert.equal(result.outcome, "failed");
    assert.equal(result.reason, "cache_write_failed");
    assert.equal(result.cachePrepared, false);
    assert.equal(fakeFiles.has(publication().stagePath), true, "stage existence cannot authorize publication");
    assert.equal(fakeFiles.has(publication().cachePath), false);
    assert.deepEqual(harness.visible(), { status: "unavailable", reason: "sample_failed" });
    assert.equal(harness.calls.states.at(-1).value.last_outcome, "failed");
    assert.equal(harness.calls.states.at(-1).value.rotation, 4);
    assert.ok(!JSON.stringify(result).includes(PRIVATE_TOKEN));
  });
});

test("failed or busy evidence can be prepared only when its stage write completes", async t => {
  for (const outcome of ["failed", "busy"]) for (const written of [true, false]) await t.test(`${outcome}, write=${written}`, async () => {
    const harness = schedulerHarness({ sample: sample({ outcome, report: { status: "unavailable" } }), writeCache: () => written });
    const result = await harness.api.executeRemoteSampleAttempt(options(), harness.deps);
    assert.equal(result.outcome, outcome);
    assert.equal(result.cachePrepared, written);
    assert.equal(harness.calls.stages[0].path, publication().stagePath);
  });
});

test("early failure and not-due branches explicitly disable publication", async t => {
  const cases = [
    ["missing contract", {}, { publication: undefined }, "cache_write_failed"],
    ["invalid interval", {}, { remoteSampleIntervalSeconds: 0 }, "invalid_interval"],
    ["database unavailable", { databaseKey: () => null }, {}, "database_unavailable"],
    ["invalid history", { stateRead: { status: "invalid" } }, {}, "state_invalid"],
    ["not due", { state: state({ next_due: NOW + 1_000 }) }, {}, "not_due"],
    ["marker failure", { invalidateResult: false }, {}, "cache_write_failed"],
    ["reservation failure", { writeState() { throw new Error(PRIVATE_TOKEN); } }, {}, "state_write_failed"],
  ];
  for (const [name, settings, overrides, reason] of cases) await t.test(name, async () => {
    const harness = schedulerHarness(settings);
    const result = await harness.api.executeRemoteSampleAttempt(options(overrides), harness.deps);
    assert.equal(result.reason, reason);
    assert.equal(result.cachePrepared, false);
    assert.equal(harness.calls.collected.length, 0);
    assert.equal(harness.calls.stages.length, 0);
  });
});

test("a final state failure cannot reach the stage writer", async () => {
  const harness = schedulerHarness({ writeState(_path, _value, count) { if (count === 2) throw new Error(PRIVATE_TOKEN); } });
  const result = await harness.api.executeRemoteSampleAttempt(options(), harness.deps);
  assert.equal(result.reason, "state_write_failed");
  assert.equal(result.cachePrepared, false);
  assert.equal(harness.calls.collected.length, 1);
  assert.equal(harness.calls.stages.length, 0);
  assert.deepEqual(harness.visible(), { status: "unavailable", reason: "state_write_failed" });
});

test("a database identity change after collection cannot reach the stage writer", async () => {
  let identityReads = 0;
  const harness = schedulerHarness({ databaseKey: () => ++identityReads === 1 ? DATABASE : OTHER_DATABASE });
  const result = await harness.api.executeRemoteSampleAttempt(options(), harness.deps);
  assert.equal(result.reason, "database_changed");
  assert.equal(result.cachePrepared, false);
  assert.equal(harness.calls.stages.length, 0);
});

test("main uses reserved exit codes for prepared, skipped and failed publication", async t => {
  const cases = [
    [{ outcome: "ok", cachePrepared: true }, 0],
    [{ outcome: "failed", cachePrepared: true }, 0],
    [{ outcome: "busy", cachePrepared: true }, 0],
    [{ outcome: "ok", cachePrepared: false }, 2],
    [{ outcome: "failed", cachePrepared: false }, 2],
    [{ outcome: "busy", cachePrepared: false }, 3],
    [{ outcome: "not_due", cachePrepared: false }, 3],
    [{ outcome: "ok" }, 2],
    [{ outcome: "ok", cachePrepared: "true" }, 2],
  ];
  for (const [result, expectedCode] of cases) await t.test(JSON.stringify(result), async () => {
    const observed = await mainHarness({ result });
    assert.equal(observed.exitCode, expectedCode);
    assert.deepEqual(observed.output, result);
    assert.equal(observed.calls.execute.length, 1);
    assert.deepEqual(observed.calls.fstat, [200]);
    assert.deepEqual(observed.calls.lstat, [publication().lockPath]);
  });
});

test("main rejects a replaced or unsafe inherited lock before executing an attempt", async t => {
  const cases = [
    ["low descriptor", { environment: { EXOCORTEX_REMOTE_SAMPLE_LOCK_FD: "199" } }],
    ["shared mode", { lock: { mode: 0o100644 } }],
    ["other owner", { lock: { uid: 502 } }],
    ["extra hardlink", { lock: { nlink: 2 } }],
    ["replaced inode", { namedLock: { ino: 43 } }],
    ["symlink", { namedLock: { isSymbolicLink: () => true } }],
    ["contract mismatch", { environment: { EXOCORTEX_REMOTE_SAMPLE_PUBLICATION: JSON.stringify(publication(DATABASE, OTHER_ATTEMPT)) } }],
  ];
  for (const [name, settings] of cases) await t.test(name, async () => {
    const observed = await mainHarness({ ...settings, result: { outcome: "ok", cachePrepared: true } });
    assert.equal(observed.exitCode, 2);
    assert.equal(observed.output.reason, "scheduler_unavailable");
    assert.equal(observed.calls.execute.length, 0);
  });
});

test("read-only main has no publication or lock activity", async () => {
  const observed = await mainHarness({
    options: { db: DB_PATH, mode: "read_only", options: {} },
    collectResult: { outcome: "ok", report: { status: "healthy" } },
  });
  assert.equal(observed.exitCode, undefined);
  assert.equal(observed.calls.execute.length, 0);
  assert.equal(observed.calls.collect.length, 1);
  assert.equal(observed.calls.fstat.length, 0);
  assert.equal(observed.calls.lstat.length, 0);
  assert.deepEqual(observed.output, { outcome: "ok", report: { status: "healthy" } });
});
