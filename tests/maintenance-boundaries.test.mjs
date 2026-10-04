import assert from "node:assert/strict";
import test from "node:test";
import { executeMaintenanceCheck, parseArgs, runMaintenanceCheckCli } from "../src/cli/maintenance-check-command.mjs";
const ok = { status: 0, stdout: "", stderr: "" };
function execute(failing = "", options = []) {
  const calls = [];
  const report = executeMaintenanceCheck(parseArgs(options), { execPath: "node", run: (cmd, args) => {
    const command = [cmd, ...args].join(" "); calls.push(command);
    return command === failing ? { status: 1, stdout: "PRIVATE_STDOUT_SENTINEL", stderr: "PRIVATE_STDERR_SENTINEL" } : ok;
  }});
  return { calls, report };
}
test("maintenance stops before any check that can rebuild dist, then starts after successful checks", () => {
  const { calls, report } = execute();
  assert.equal(report.ok, true);
  assert.ok(calls.indexOf("node scripts/lark-im-service.mjs stop") >= 0);
  assert.ok(calls.indexOf("node scripts/lark-im-service.mjs stop") < calls.indexOf("npm run check"));
  assert.ok(calls.indexOf("node scripts/lark-im-service.mjs start") >= 0);
  assert.ok(calls.indexOf("npm test") < calls.indexOf("node scripts/lark-im-service.mjs start"));
});
test("maintenance stop failure prevents build; check failure does not restart partial output", () => {
  const stopped = execute("node scripts/lark-im-service.mjs stop");
  assert.equal(stopped.report.ok, false);
  assert.equal(stopped.calls.some((call) => call.startsWith("npm ")), false);
  const checked = execute("npm run check");
  assert.equal(checked.report.ok, false);
  assert.equal(checked.calls.includes("node scripts/lark-im-service.mjs start"), false);
});
for (const state of [true, false, "unknown"]) {
  test(`maintenance no-restart build requires confirmed unloaded state: ${state}`, () => {
    const calls = [];
    const report = executeMaintenanceCheck(parseArgs(["--no-restart"]), {
      isServiceLoaded: () => { if (state === "unknown") throw new Error("PRIVATE_STATE"); return state; },
      run: (cmd, args) => { calls.push([cmd, ...args].join(" ")); return ok; },
    });
    assert.equal(report.ok, state === false);
    assert.equal(calls.some((call) => call.startsWith("npm ")), state === false);
    assert.equal(calls.some((call) => / (start|stop|restart)$/.test(call)), false);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_STATE/);
  });
}
for (const format of ["text", "json"]) {
  for (const stage of ["check", "doctor", "doctor live", "status"]) {
    test(`maintenance ${stage} ${format} output excludes raw failure details`, () => {
      let output = "";
      const code = runMaintenanceCheckCli(["--live", "--format", format], {
        stdout: { write: (text) => { output += text; } }, stderr: { write: (text) => { output += text; } },
        deps: { execPath: "node", run: (cmd, args) => {
          const matches = stage === "check" ? cmd === "npm" : stage === "doctor" ? args[0] === "scripts/doctor.mjs" && !args.includes("--live") : stage === "doctor live" ? args.includes("--live") : args.includes("status");
          return matches ? { status: 1, stdout: "PRIVATE_STDOUT_SENTINEL", stderr: "PRIVATE_STDERR_SENTINEL" } : ok;
        } },
      });
      assert.equal(code, 2);
      assert.doesNotMatch(output, /PRIVATE_(STDOUT|STDERR)_SENTINEL/);
    });
  }
}
test("maintenance live details allow only public values, not arbitrary child findings or reason", () => {
  let output = "";
  runMaintenanceCheckCli(["--live", "--skip-local-checks", "--no-restart", "--format", "json"], {
    stdout: { write: (text) => { output += text; } }, deps: { execPath: "node", run: (cmd, args) => args.includes("--live") ? { status: 2, stderr: "PRIVATE_SENTINEL", stdout: JSON.stringify({ overall: "PRIVATE_SENTINEL", live: { status: "PRIVATE_SENTINEL", reason: "PRIVATE_SENTINEL", missing_count: "PRIVATE_SENTINEL" }, findings: ["PRIVATE_SENTINEL"] }) } : ok },
  });
  assert.doesNotMatch(output, /PRIVATE_SENTINEL/);
});
for (const inspection of [
  { status: 113, stderr: 'Could not find service "com.exocortex.lark-im-worker" in domain for user gui: 701', safe: true },
  { status: 0, stderr: "", safe: false },
  { status: 1, stderr: "PRIVATE_INSPECTION", safe: false },
  { status: 113, stderr: "PRIVATE_INSPECTION", safe: false },
  { status: null, stderr: "PRIVATE_INSPECTION", signal: "SIGKILL", safe: false },
]) {
  test(`maintenance no-restart uses tri-state launchctl inspection ${JSON.stringify(inspection)}`, () => {
    const calls = [];
    const report = executeMaintenanceCheck(parseArgs(["--no-restart"]), { run: (cmd, args) => {
      calls.push([cmd, ...args]);
      return cmd === "launchctl" ? { ...ok, ...inspection } : ok;
    } });
    assert.equal(report.ok, inspection.safe);
    assert.equal(calls.some((call) => call[0] === "npm"), inspection.safe);
    assert.equal(calls.filter((call) => call[0] === "launchctl").length, 1);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_INSPECTION/);
  });
}
for (const failure of [{ status: 0, error: new Error("PRIVATE_THROWN") }, { status: 0, signal: "SIGTERM" }, "throw"]) {
  test(`maintenance process errors cannot be hidden by zero exit: ${JSON.stringify(failure)}`, () => {
    const report = executeMaintenanceCheck(parseArgs(["--skip-local-checks", "--no-restart"]), { run: (cmd) => {
      if (cmd === "git") return { ...ok, stdout: " M PRIVATE_FILENAME\n" };
      if (failure === "throw") throw new Error("PRIVATE_THROWN");
      return { ...ok, ...failure };
    } });
    assert.equal(report.ok, false);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_(THROWN|FILENAME)/);
  });
}
test("maintenance start failure does not run wait-ok or diagnostics", () => {
  const { calls, report } = execute("node scripts/lark-im-service.mjs start");
  assert.equal(report.ok, false);
  assert.equal(calls.some((call) => call.includes("wait-ok") || call.includes("doctor.mjs")), false);
});
