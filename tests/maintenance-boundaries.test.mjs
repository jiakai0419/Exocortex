// The mixed maintenance-check recipe is retired. These counterexamples now
// guard check's stronger contract: no builds or service changes in any mode.
import assert from "node:assert/strict";
import test from "node:test";
import { collectCheckReport } from "../src/diagnostics/check-report.mjs";
import { runCheckCommand } from "../src/cli/check-command.mjs";
import { parseRouteOptions } from "../src/cli/registry.mjs";
import { probeService } from "../src/runtime/service/launchd.mjs";
import { fixture, options, sync, live, waitEvidence } from "./helpers/check-fixture.mjs";

function forbidEffects(f) {
  for (const key of ["run", "spawnSync", "start", "stop", "restart", "install", "build", "writeFileSync", "chmodSync"]) {
    f.deps[key] = () => { throw new Error(`forbidden effect: ${key}`); };
  }
  return f;
}
for (const state of ["running", "stopped", "unknown"]) {
  test(`default check never builds/restarts or requires service state=${state}`, async () => {
    const f = forbidEffects(fixture());
    f.deps.collectStatusEvidence = () => { throw new Error(`default check must not inspect ${state} service`); };
    const report = await collectCheckReport(options(), f.context, f.deps);
    assert.equal(report.exit_code, 0);
    assert.deepEqual(f.calls, ["database", "sync", "quality"]);
    assert.equal(report.cache.status, "not_requested");
  });
}
for (const flag of ["--restart", "--no-restart", "--skip-local-checks"]) {
  test(`check rejects retired service/build recipe flag ${flag}`, () => {
    assert.throws(() => parseRouteOptions("check", [flag]), /Unknown option/);
  });
}
test("local read failure does not build or restart, and blocks live/cache while retaining other evidence", async () => {
  const f = forbidEffects(fixture());
  f.deps.buildStatus = () => { f.calls.push("sync"); throw new Error("PRIVATE_READ_SENTINEL"); };
  const report = await collectCheckReport(options({ live: true, writeLiveCache: true }), f.context, f.deps);
  assert.equal(report.exit_code, 1);
  assert.equal(report.checks.sync.status, "unavailable");
  assert.equal(report.checks.database.status, "passed");
  assert.equal(report.checks.quality.status, "passed");
  assert.equal(report.checks.live.status, "skipped");
  assert.equal(report.cache.status, "skipped");
  assert.deepEqual(f.calls, ["database", "sync", "quality"]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_READ_SENTINEL/);
});
for (const format of ["text", "json"]) {
  for (const collector of ["readDatabaseEvidence", "buildStatus", "collectQualityReport", "collectLagReport", "collectStatusEvidence"]) {
    test(`check ${collector} ${format} excludes arbitrary failure stdout/stderr`, async () => {
      const f = forbidEffects(fixture());
      f.deps.collectStatusEvidence = () => waitEvidence(f.context.startedAtMs);
      f.deps[collector] = () => { throw Object.assign(new Error("PRIVATE_STDERR_SENTINEL"), { stdout: "PRIVATE_STDOUT_SENTINEL", stderr: "PRIVATE_STDERR_SENTINEL" }); };
      const code = await runCheckCommand(options({ format, live: true, wait: collector === "collectStatusEvidence" }), f.context, f.deps);
      assert.equal(code, 1);
      assert.doesNotMatch(f.output(), /PRIVATE_(STDOUT|STDERR)_SENTINEL/);
    });
  }
}
test("live public projection excludes arbitrary enum/findings/path fields", async () => {
  const f = forbidEffects(fixture());
  f.deps.collectLagReport = () => live({ status: "PRIVATE_SENTINEL", reason: "PRIVATE_SENTINEL", missing_count: "PRIVATE_SENTINEL", stderr: "PRIVATE_SENTINEL", findings: ["PRIVATE_SENTINEL"], db_path: "PRIVATE_SENTINEL" });
  const report = await collectCheckReport(options({ live: true }), f.context, f.deps);
  assert.equal(report.ok, false);
  assert.equal(report.exit_code, 2);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_SENTINEL/);
});
for (const inspection of [
  { status: 113, stderr: 'Could not find service "com.exocortex.lark-im-worker" in domain for user gui: 701' },
  { status: 0, stdout: "state = waiting" },
  { status: 1, stderr: "PRIVATE_INSPECTION" },
  { status: 113, stderr: "PRIVATE_INSPECTION" },
  { status: null, stderr: "PRIVATE_INSPECTION", signal: "SIGKILL" },
]) {
  test(`check wait rejects unavailable or inactive launchctl evidence ${JSON.stringify(inspection)}`, async () => {
    const f = forbidEffects(fixture());
    const commands = [];
    f.deps.collectStatusEvidence = () => {
      const probe = probeService({ uid: () => 701, run: (cmd, args) => { commands.push([cmd, ...args]); return inspection; } });
      return waitEvidence(f.context.startedAtMs, { service: { status: probe.status, target_match: "matched" } });
    };
    const report = await collectCheckReport(options({ wait: true, live: true, writeLiveCache: true }), f.context, f.deps);
    const inspectionFailed = probeService({ run: () => inspection }).status === "unknown";
    assert.equal(report.exit_code, inspectionFailed ? 1 : 2);
    assert.equal(report.checks.wait.status, inspectionFailed ? "unavailable" : "incomplete");
    assert.equal(report.checks.live.status, "skipped");
    assert.equal(report.cache.status, "skipped");
    assert.deepEqual(commands, [["launchctl", "print", "gui/701/com.exocortex.lark-im-worker"]]);
    assert.deepEqual(f.calls, ["database", "sync", "quality"]);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_INSPECTION/);
  });
}
for (const failure of [
  { status: 0, error: new Error("PRIVATE_THROWN") },
  { status: 0, signal: "SIGTERM" },
  { status: null, error: new Error("PRIVATE_THROWN") },
]) {
  test(`check wait cannot treat failed OS inspection as healthy JSON: ${JSON.stringify(failure)}`, async () => {
    const f = forbidEffects(fixture());
    f.deps.collectStatusEvidence = () => {
      const probe = probeService({ uid: () => 701, run: () => ({ stdout: "state = running\npid = 7111", ...failure }) });
      return { report: { sync: { status: sync() } }, workerSummary: waitEvidence(f.context.startedAtMs).workerSummary, service: { status: probe.status, target_match: "matched" } };
    };
    const report = await collectCheckReport(options({ wait: true }), f.context, f.deps);
    assert.equal(report.ok, false);
    assert.equal(report.exit_code, 1);
    assert.equal(report.checks.wait.status, "unavailable");
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_THROWN/);
  });
}
test("failed wait never starts remote work or cache writes and leaves local results reviewable", async () => {
  const f = forbidEffects(fixture());
  f.deps.collectStatusEvidence = () => { throw new Error("PRIVATE_WAIT_FAILURE"); };
  const report = await collectCheckReport(options({ wait: true, live: true, writeLiveCache: true }), f.context, f.deps);
  assert.equal(report.exit_code, 1);
  assert.deepEqual(f.calls, ["database", "sync", "quality"]);
  assert.equal(report.checks.wait.status, "unavailable");
  assert.equal(report.checks.live.status, "skipped");
  assert.equal(report.cache.status, "skipped");
});
