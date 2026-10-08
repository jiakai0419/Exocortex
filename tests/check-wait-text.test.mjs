import assert from "node:assert/strict";
import test from "node:test";
import { createCommandContext } from "../src/cli/context.mjs";
import { runCheckCommand, waitReasonText } from "../src/cli/check-command.mjs";
import { collectCheckReport } from "../src/diagnostics/check-report.mjs";

// Entirely invented evidence. The real collector, waiting predicate, clock
// loop, and text renderer run; filesystem, service, API, and sleep do not.
const startedAt = Date.parse("2030-01-02T12:00:00Z");
const privateMarker = "SYNTHETIC_PRIVATE_WAIT_REASON\u001b[2J /invented/private";
const sync = () => ({ health: "ok", scopes: {}, records: {}, runs: {}, locks: [],
  details: { evidence: "available", pending_count: 0, due_count: 0, scopes_pending: 0 },
  list_progress: { evidence: "available", scopes: 0, invalid_cursor_scopes: 0 } });

function fixture(scenario, format = "text") {
  let now = startedAt;
  let output = "";
  let polls = 0;
  const sleeps = [];
  const context = createCommandContext({ root: "/synthetic/root", cwd: "/synthetic/cwd", env: { PATH: "" },
    now: () => now, stdout: { write(value) { output += value; } } });
  const options = { db: "/synthetic/never-read.sqlite", logDir: "/synthetic/never-read-logs", format,
    wait: scenario !== "not_requested", timeoutSeconds: 1, pollSeconds: 1 };
  const deps = {
    checkDependencies: () => ({ sqlite: true, python: true, live: true, wait: true }),
    readDatabaseEvidence: () => ({ ok: true, quick_check: "ok" }),
    buildStatus: () => ({ ...sync(), health: scenario === "final_local_not_ready" ? "not_ready" : "ok" }),
    collectQualityReport: () => ({ quality: { actionable_missing_sender_name: 0, missing_chat_name: 0, invalid_rendered_body: 0 } }),
    collectStatusEvidence: () => {
      polls++;
      if (scenario === "private_failure") throw new Error(privateMarker);
      const complete = scenario === "ready" || scenario === "final_local_not_ready";
      if (complete) now = startedAt + 500;
      return { report: { sync: { status: sync() } },
        service: { status: scenario === "service_absent" ? "absent" : "running", target_match: "matched", reason: privateMarker },
        workerSummary: { last_cycle: { ok: true, complete: true,
          started_at: new Date(complete ? startedAt : startedAt - 1000).toISOString(),
          at: new Date(complete ? now : startedAt - 500).toISOString() }, in_progress: false, unfinished_cycle: false } };
    },
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    collectRemoteSample: () => assert.fail("wait must not call an API"),
    runManualRemoteSample: () => assert.fail("wait must not write a sample cache"),
  };
  return { options, context, deps, output: () => output, polls: () => polls, sleeps, elapsed: () => now - startedAt };
}

async function command(scenario, format = "text") {
  const f = fixture(scenario, format);
  const code = await runCheckCommand(f.options, f.context, f.deps);
  return { ...f, code, text: f.output() };
}

for (const [scenario, reason, explanation, polls, elapsed] of [
  ["service_absent", "service_not_running_or_target_unverified", "Service is not running or its database target is unverified", 1, 0],
  ["timeout", "wait_timeout", "Wait deadline reached", 2, 1000],
  ["final_local_not_ready", "final_local_not_ready", "Final local checks are not ready", 1, 500],
]) test(`wait text preserves ${reason} from the real waiting flow without changing JSON`, async () => {
  const text = await command(scenario);
  const json = await command(scenario, "json");
  const report = JSON.parse(json.text);
  assert.equal(text.code, 2);
  assert.equal(json.code, 2);
  assert.match(text.text, /^Check: INCOMPLETE\n/);
  assert.ok(text.text.includes(`Wait reason: ${explanation}\n`));
  assert.equal(report.checks.wait.status, "incomplete");
  assert.equal(report.checks.wait.evidence.reason, reason);
  assert.equal(report.exit_code, 2);
  assert.equal(text.polls(), polls);
  assert.equal(text.elapsed(), elapsed);
  assert.deepEqual(text.sleeps, scenario === "timeout" ? [1000] : []);
  const expected = fixture(scenario, "json");
  assert.deepEqual(report, await collectCheckReport(expected.options, expected.context, expected.deps));
  assert.doesNotMatch(text.text + json.text, /SYNTHETIC_PRIVATE_WAIT_REASON|\u001b|invented\/private/);
  assert.doesNotMatch(text.text, /Hint:|Next step:|Try /);
});

test("service absence and an elapsed deadline no longer produce identical terminal screens", async () => {
  const absent = await command("service_absent");
  const timeout = await command("timeout");
  assert.notEqual(absent.text, timeout.text);
  assert.equal(absent.text.replace(/^Wait reason:.*\n/m, ""), timeout.text.replace(/^Wait reason:.*\n/m, ""));
});

for (const scenario of ["ready", "not_requested"]) test(`${scenario} keeps the existing compact screen without a wait notice`, async () => {
  const text = await command(scenario);
  const json = await command(scenario, "json");
  assert.equal(text.code, 0);
  assert.equal(json.code, 0);
  assert.equal(text.text, ["Check: PASSED", "database: PASSED", "sync: PASSED", "quality: PASSED",
    "coverage: NOT_REQUESTED", "backup: NOT_REQUESTED", "live: NOT_REQUESTED",
    `wait: ${scenario === "ready" ? "PASSED" : "NOT_REQUESTED"}`, ""].join("\n"));
  assert.equal(text.polls(), scenario === "ready" ? 1 : 0);
  assert.deepEqual(text.sleeps, []);
  const expected = fixture(scenario, "json");
  assert.deepEqual(JSON.parse(json.text), await collectCheckReport(expected.options, expected.context, expected.deps));
});

test("unknown, inherited and private wait reasons do not cross the text projection boundary", () => {
  for (const reason of [privateMarker, "future_reason", "toString", "constructor", "__proto__", "ready", null, undefined, 17, {}]) {
    assert.equal(waitReasonText({ status: "incomplete", evidence: { reason } }), "");
  }
  for (const status of ["passed", "not_requested", "unavailable", "skipped"]) {
    assert.equal(waitReasonText({ status, evidence: { reason: "wait_timeout" } }), "");
  }
  assert.equal(waitReasonText(undefined), "");
  assert.equal(waitReasonText({ status: "incomplete" }), "");
});

test("an arbitrary dependency failure stays unavailable and never becomes a wait instruction", async () => {
  for (const format of ["text", "json"]) {
    const result = await command("private_failure", format);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.text, /SYNTHETIC_PRIVATE_WAIT_REASON|\u001b|invented\/private|Wait reason:/);
    if (format === "json") assert.equal(JSON.parse(result.text).checks.wait.status, "unavailable");
    else assert.match(result.text, /^wait: UNAVAILABLE$/m);
  }
});
