import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireSyncLarkApiLease, readSharedLarkCooldown, writeSharedLarkCooldown } from "../src/runtime/lark-api-lease.mjs";
import { createLarkCliRunner, createTransportState, transportOperation } from "../src/adapters/lark-im/transport.mjs";
const nowMs = 1800000000000;
const operation = "message_history_bundle";
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "exocortex-cooldown-synthetic-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory };
}

test("cooldowns survive new readers, isolate operations and never shorten a maximum", (t) => {
  const deps = fixture(t);
  assert.deepEqual(readSharedLarkCooldown({ operation, nowMs }, deps), { state: "ready", untilMs: null });
  assert.equal(writeSharedLarkCooldown({ operation, nowMs, untilMs: nowMs + 5000 }, deps), true);
  assert.equal(writeSharedLarkCooldown({ operation, nowMs, untilMs: nowMs + 1000 }, deps), true);
  assert.deepEqual(readSharedLarkCooldown({ operation, nowMs }, { ...deps }), { state: "cooldown", untilMs: nowMs + 5000 });
  assert.equal(readSharedLarkCooldown({ operation: "self_profile", nowMs }, deps).state, "ready");
  assert.equal(writeSharedLarkCooldown({ operation: "other", nowMs, untilMs: nowMs + 9000 }, deps), true);
  assert.equal(readSharedLarkCooldown({ operation: "self_profile", nowMs }, deps).untilMs, nowMs + 9000);
  const files = readdirSync(join(deps.directory, "cooldowns"));
  for (const name of files) {
    const file = join(deps.directory, "cooldowns", name);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort(), ["operation", "untilMs", "version"]);
  }
});

test("expired records are pruned but official long resets are preserved", (t) => {
  const deps = fixture(t);
  writeSharedLarkCooldown({ operation, nowMs, untilMs: nowMs + 1 }, deps);
  assert.equal(readSharedLarkCooldown({ operation, nowMs: nowMs + 1 }, deps).state, "ready");
  assert.equal(writeSharedLarkCooldown({ operation, nowMs: nowMs + 1, untilMs: Number.MAX_SAFE_INTEGER }, deps), true);
  assert.equal(readdirSync(join(deps.directory, "cooldowns")).length, 1);
  assert.equal(readSharedLarkCooldown({ operation, nowMs: nowMs + 1 }, deps).untilMs, Number.MAX_SAFE_INTEGER);
});

test("unknown operations, damaged records and unsafe permissions fail closed", (t) => {
  const deps = fixture(t);
  assert.equal(writeSharedLarkCooldown({ operation: "synthetic-private-sentinel", nowMs, untilMs: nowMs + 1 }, deps), false);
  assert.equal(readSharedLarkCooldown({ operation: "unknown", nowMs }, deps).state, "unavailable");
  writeSharedLarkCooldown({ operation, nowMs, untilMs: nowMs + 1 }, deps);
  const file = join(deps.directory, "cooldowns", readdirSync(join(deps.directory, "cooldowns"))[0]);
  writeFileSync(file, "synthetic-private-sentinel");
  assert.equal(readSharedLarkCooldown({ operation, nowMs }, deps).state, "unavailable");
  assert.equal(writeSharedLarkCooldown({ operation, nowMs, untilMs: nowMs + 2 }, deps), false);
  chmodSync(deps.directory, 0o755);
  assert.equal(readSharedLarkCooldown({ operation, nowMs }, deps).state, "unavailable");
});

test("cooldown hardlinks and FIFO replacement are rejected through bounded descriptor reads", (t) => {
  const deps = fixture(t);
  assert.equal(writeSharedLarkCooldown({ operation, nowMs, untilMs: nowMs + 1000 }, deps), true);
  const file = join(deps.directory, "cooldowns", `${operation}-${nowMs + 1000}.json`);
  assert.equal(statSync(file).nlink, 1);
  linkSync(file, join(deps.directory, "alias"));
  assert.equal(readSharedLarkCooldown({ operation, nowMs }, deps).state, "unavailable");
  rmSync(join(deps.directory, "alias")); rmSync(file);
  assert.equal(spawnSync("mkfifo", [file]).status, 0);
  const moduleUrl = new URL("../src/runtime/lark-api-lease.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import {readSharedLarkCooldown} from ${JSON.stringify(moduleUrl)}; process.stdout.write(readSharedLarkCooldown({operation:'${operation}',nowMs:${nowMs}},{directory:process.argv[1]}).state);`, deps.directory], { encoding: "utf8", timeout: 2000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.equal(result.stdout, "unavailable");
});

test("concurrent publishers preserve the largest reset across independent processes", async (t) => {
  const deps = fixture(t);
  const moduleUrl = new URL("../src/runtime/lark-api-lease.mjs", import.meta.url).href;
  await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import {writeSharedLarkCooldown} from ${JSON.stringify(moduleUrl)};
      const ok = writeSharedLarkCooldown({operation:'message_history_bundle',nowMs:${nowMs},untilMs:${nowMs}+Number(process.argv[2])}, {directory:process.argv[1]});
      process.exit(ok ? 0 : 1);`, deps.directory, String((index + 1) * 1000)]);
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve(null) : reject(new Error(`synthetic cooldown child ${code}`)));
  })));
  assert.equal(readSharedLarkCooldown({ operation, nowMs }, deps).untilMs, nowMs + 8000);
});

test("sync waits at most five seconds for a probe and does not retry unavailable evidence", () => {
  let at = 0, calls = 0, slept = 0;
  const deps = { monotonicClock: () => at, sleep: (ms) => { at += ms; slept += ms; },
    acquire: () => ({ state: ++calls < 5 ? "busy" : "acquired", release() {}, reason: null }) };
  assert.equal(acquireSyncLarkApiLease({}, deps).state, "acquired"); assert.equal(slept, 400);
  at = 0; calls = 0; slept = 0;
  assert.equal(acquireSyncLarkApiLease({}, { ...deps, acquire: () => ({ state: "busy", release() {}, reason: null }) }).state, "busy");
  assert.equal(slept, 5000);
  slept = 0;
  assert.equal(acquireSyncLarkApiLease({}, { ...deps, acquire: () => ({ state: "unavailable", release() {}, reason: null }) }).state, "unavailable");
  assert.equal(slept, 0);
});

test("a rate-limited probe bucket stops a fresh sync transport before spawn", (t) => {
  const deps = fixture(t); let spawned = 0;
  writeSharedLarkCooldown({ operation, nowMs, untilMs: nowMs + 7200000 }, deps);
  const run = createLarkCliRunner({ clock: () => nowMs, state: createTransportState(),
    readSharedCooldown: (options) => readSharedLarkCooldown(options, deps),
    spawn: () => { spawned++; throw new Error("synthetic spawn should be unreachable"); } });
  assert.throws(() => run(["api", "GET", "/open-apis/im/v1/messages"], { retryBudgetMs: 1000 }), /kind=rate_limited/);
  assert.equal(spawned, 0);
  assert.equal(transportOperation(["api", "GET", "/open-apis/authen/v1/user_info"]), "self_profile");
});

test("transport publishes rate reset for the next process and refuses unavailable shared storage", (t) => {
  const deps = fixture(t); let spawned = 0;
  const run = createLarkCliRunner({ clock: () => nowMs, state: createTransportState(),
    readSharedCooldown: (options) => readSharedLarkCooldown(options, deps),
    writeSharedCooldown: (options) => writeSharedLarkCooldown(options, deps),
    spawn: () => { spawned++; return { status: 1, stderr: '{"code":99991400,"headers":{"x-ogw-ratelimit-reset":"7200"}}', stdout: "" }; } });
  assert.throws(() => run(["api", "GET", "/open-apis/im/v1/messages"]), /kind=rate_limited/);
  assert.equal(spawned, 1);
  assert.equal(readSharedLarkCooldown({ operation, nowMs }, deps).untilMs, nowMs + 7200000);
  const broken = createLarkCliRunner({ clock: () => nowMs, state: createTransportState(),
    readSharedCooldown: () => ({ state: "unavailable", untilMs: null }), spawn: () => assert.fail("unavailable store spawned") });
  assert.throws(() => broken(["contact", "+get-user"]), /shared_cooldown_unavailable/);
});
