import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireSyncLarkApiLease, tryAcquireLarkApiLease } from "../src/runtime/lark-api-lease.mjs";
import { createLarkCliRunner, createTransportState } from "../src/adapters/lark-im/transport.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "exocortex-kernel-lease-synthetic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, directory: join(root, "lease") };
}

test("the real kernel lock survives helper exit and final close releases it without ps", (t) => {
  const deps = fixture(t), commands = [];
  const owner = tryAcquireLarkApiLease({ role: "sync", db: "synthetic-one" }, { ...deps,
    spawnSync: (command, args, options) => { commands.push(command); return spawnSync(command, args, options); } });
  assert.equal(owner.state, "acquired"); assert.deepEqual(commands, ["python3"]);
  assert.equal(tryAcquireLarkApiLease({ role: "probe", db: "synthetic-two" }, deps).state, "busy");
  owner.release(); owner.release();
  const probe = tryAcquireLarkApiLease({ role: "probe" }, deps);
  assert.equal(probe.state, "acquired"); probe.release();
  assert.deepEqual(readdirSync(deps.directory), ["api.lock"]);
});

test("shared or symlinked directories and unsafe lock files fail closed", (t) => {
  const deps = fixture(t);
  const lease = tryAcquireLarkApiLease({ role: "sync" }, deps); lease.release();
  chmodSync(deps.directory, 0o755);
  assert.equal(tryAcquireLarkApiLease({ role: "probe" }, deps).state, "unavailable");
  chmodSync(deps.directory, 0o700);
  const alias = join(deps.root, "alias"); symlinkSync(deps.directory, alias);
  assert.equal(tryAcquireLarkApiLease({ role: "probe" }, { ...deps, directory: alias }).state, "unavailable");
  chmodSync(join(deps.directory, "api.lock"), 0o644);
  assert.equal(tryAcquireLarkApiLease({ role: "probe" }, deps).state, "unavailable");
  rmSync(join(deps.directory, "api.lock"));
  const other = join(deps.root, "other"); writeFileSync(other, "synthetic");
  symlinkSync(other, join(deps.directory, "api.lock"));
  assert.equal(tryAcquireLarkApiLease({ role: "probe" }, deps).state, "unavailable");
});

test("helper permission, absence and timeout failures release the descriptor and fail closed", (t) => {
  const deps = fixture(t);
  for (const code of ["EPERM", "ENOENT", "ETIMEDOUT"]) {
    const lease = tryAcquireLarkApiLease({ role: "probe" }, { ...deps, spawnSync: () => ({ error: { code }, status: null }) });
    assert.equal(lease.state, "unavailable");
    const next = tryAcquireLarkApiLease({ role: "probe" }, deps);
    assert.equal(next.state, "acquired"); next.release();
  }
});

for (const rollbackMs of [0, 10000]) test(`synthetic 1900ms helpers share five seconds including a ${rollbackMs}ms wall rollback`, (t) => {
  const deps = fixture(t); let wallNow = 1800000000000, elapsed = 0, helperMs = 0, sleepMs = 0;
  const budgets = [], deadlines = [];
  const result = acquireSyncLarkApiLease({ deadlineMs: wallNow + 5000 }, {
    clock: () => wallNow, monotonicClock: () => elapsed,
    sleep: (ms) => { elapsed += ms; wallNow += ms; sleepMs += ms; },
    acquire: (options) => {
      deadlines.push(options.monotonicDeadlineMs);
      return tryAcquireLarkApiLease(options, { ...deps, clock: () => wallNow, monotonicClock: () => elapsed, spawnSync: (_command, _args, settings) => {
        budgets.push(settings.timeout);
        // Simulated helper latency, not a measurement of this machine.
        const duration = Math.min(1900, settings.timeout);
        elapsed += duration; wallNow += duration; helperMs += duration;
        // The wall clock moves backwards after the first helper, while real
        // elapsed time continues. No system clock is modified by this fixture.
        if (budgets.length === 1) wallNow -= rollbackMs;
        return settings.timeout < 1900 ? { error: { code: "ETIMEDOUT" }, status: null } : { status: 75 };
      } });
    },
  });
  assert.equal(result.state, "unavailable");
  assert.deepEqual(budgets, [2000, 2000, 1000]);
  assert.deepEqual(deadlines, [5000, 5000, 5000]);
  assert.equal(elapsed, 5000);
  assert.equal(helperMs, 4800); assert.equal(sleepMs, 200);
});

test("a probe inherits the sample deadline and cannot start a helper after expiry", (t) => {
  const deps = fixture(t); let now = 1800000000000, calls = 0;
  const spawn = (_command, _args, options) => { calls++; assert.equal(options.timeout, 37); return { status: 75 }; };
  assert.equal(tryAcquireLarkApiLease({ role: "probe", deadlineMs: now + 37 }, { ...deps, clock: () => now, monotonicClock: () => 0, spawnSync: spawn }).state, "busy");
  assert.equal(tryAcquireLarkApiLease({ role: "probe", deadlineMs: now }, { ...deps, clock: () => now, monotonicClock: () => 0, spawnSync: spawn }).reason, "lease_deadline");
  assert.equal(calls, 1);
});

test("tail file verification reaching the monotonic deadline releases a successful kernel lease", (t) => {
  const deps = fixture(t), ticks = [0, 0, 1999, 2000]; let reads = 0;
  const lease = tryAcquireLarkApiLease({ role: "probe" }, { ...deps,
    // Only the elapsed clock is synthetic; the short helper acquires a real
    // temporary-file lock. The final tick models the tail lstat work.
    monotonicClock: () => ticks[Math.min(reads++, ticks.length - 1)] });
  assert.equal(lease.state, "unavailable"); assert.equal(lease.reason, "lease_deadline");
  const next = tryAcquireLarkApiLease({ role: "probe" }, deps);
  assert.equal(next.state, "acquired"); next.release();
});

test("real concurrent kernel contenders never enter the synthetic critical section together", { timeout: 30000 }, async (t) => {
  const deps = fixture(t);
  const moduleUrl = new URL("../src/runtime/lark-api-lease.mjs", import.meta.url).href;
  const code = `import { tryAcquireLarkApiLease } from ${JSON.stringify(moduleUrl)};
    import { openSync, closeSync, unlinkSync } from 'node:fs';
    const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    let acquired = 0, busy = 0;
    for (let i = 0; i < 4; i++) {
      const lease = tryAcquireLarkApiLease({role:'probe'}, {directory:process.argv[1]});
      if (lease.state === 'acquired') {
        const fd = openSync(process.argv[2], 'wx');
        wait(20); closeSync(fd); unlinkSync(process.argv[2]); acquired++; lease.release();
      } else if (lease.state === 'busy') busy++;
      else throw new Error(lease.reason);
      wait((i * 7 + process.pid) % 15);
    }
    process.stdout.write(JSON.stringify({acquired,busy}));`;
  const outputs = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, deps.directory, join(deps.root, "critical")]);
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  })));
  assert.ok(outputs.reduce((sum, value) => sum + value.acquired, 0) > 0);
  assert.ok(outputs.reduce((sum, value) => sum + value.busy, 0) > 0);
  assert.deepEqual(readdirSync(deps.directory), ["api.lock"]);
});

test("killing the real owner releases its kernel lease without process inspection", { timeout: 10000 }, async (t) => {
  const deps = fixture(t);
  const moduleUrl = new URL("../src/runtime/lark-api-lease.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { tryAcquireLarkApiLease } from ${JSON.stringify(moduleUrl)};
    const lease = tryAcquireLarkApiLease({role:'sync'}, {directory:process.argv[1]});
    process.stdout.write(lease.state);
    setInterval(() => {}, 1000);`, deps.directory]);
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const state = await new Promise((resolve, reject) => {
    child.stdout.once("data", (data) => resolve(String(data))); child.once("error", reject);
  });
  assert.equal(state, "acquired");
  assert.equal(tryAcquireLarkApiLease({ role: "probe" }, deps).state, "busy");
  const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
  const recovered = tryAcquireLarkApiLease({ role: "probe" }, deps);
  assert.equal(recovered.state, "acquired"); recovered.release();
});

test("an inherited request descriptor retains the lease after the Node owner closes", { timeout: 10000 }, async (t) => {
  const deps = fixture(t), lease = tryAcquireLarkApiLease({ role: "sync" }, deps);
  assert.equal(lease.state, "acquired");
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: lease.stdio });
  t.after(() => { lease.release(); if (child.exitCode === null) child.kill("SIGKILL"); });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
  lease.release();
  assert.equal(tryAcquireLarkApiLease({ role: "probe" }, deps).state, "busy");
  const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
  const next = tryAcquireLarkApiLease({ role: "probe" }, deps);
  assert.equal(next.state, "acquired"); next.release();
});

test("the real transport inherits the acquired descriptor into its synthetic command", (t) => {
  const deps = fixture(t), lease = tryAcquireLarkApiLease({ role: "sync" }, deps);
  try {
    assert.equal(lease.state, "acquired");
    const run = createLarkCliRunner({ bin: process.execPath, state: createTransportState(),
      readSharedCooldown: () => ({ state: "ready", untilMs: null }), writeSharedCooldown: () => true });
    assert.deepEqual(run(["-e", "process.stdout.write(JSON.stringify({inherited:require('node:fs').fstatSync(3).isFile()}))"]), { inherited: true });
  } finally { lease.release(); }
});
