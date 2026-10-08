import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { runCli } from "../bin/exocortex.mjs";
import { runCheckCommand } from "../src/cli/check-command.mjs";
import { textWidth } from "../src/terminal/text-layout.mjs";

// New invented evidence only. Every external collector is replaced; the real
// CLI, report projection, wait predicate and renderers remain in the call path.
const now = Date.parse("2034-04-01T12:00:00Z");
const iso = (n) => new Date(n).toISOString();
const sync = () => ({ health: "ok", records: { total: 2 }, scopes: {}, runs: {}, locks: [],
  details: { evidence: "available", pending_count: 0 }, list_progress: { evidence: "available", invalid_cursor_scopes: 0 } });
const sample = () => ({ schema_version: 3, ok: true, status: "healthy", reason: null, checked_at: iso(now), missing_count: 0,
  scope: "discovered_chats_rotating", window: { start: iso(now - 3600000), end: iso(now - 60000) },
  binding: { state: "verified", evidence: "single_sent_actor", tenant_verified: false },
  probe: { hot_chats_found: 1, remote_messages_checked: 2, truncated_chats: 0, probe_errors: 0 },
  findings: { confirmed_missing: 0, suspected_missing: 0, pending_sync: 0, stale_version: 0, content_mismatch: 0,
    content_equal: 2, content_unverified: 0 } });

function writer(columns) {
  let output = "";
  const stream = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }), { columns, isTTY: false });
  return { stream, text: () => output };
}

async function check(scenario, columns, format = "text") {
  const stdout = writer(columns), stderr = writer(columns);
  const deps = {
    checkDependencies: () => ({ sqlite: scenario !== "dependency", python: true, live: true, wait: true }),
    readDatabaseEvidence: () => ({ ok: true, quick_check: "ok" }),
    buildStatus: () => ({ ...sync(), health: scenario === "empty" ? "not_ready" : "ok" }),
    collectQualityReport: () => ({ quality: { actionable_missing_sender_name: 0, missing_chat_name: 0, invalid_rendered_body: 0 } }),
    collectRemoteSample: () => ({ outcome: "ok", report: scenario === "live-error"
      ? { ...sample(), ok: false, status: "inconclusive", reason: "no_eligible_chats", probe: {} } : sample() }),
    collectStatusEvidence: () => ({ report: { sync: { status: sync() } }, service: { status: "absent", target_match: "unknown" }, workerSummary: {} }),
    runManualRemoteSample: () => assert.fail("no cache writes"),
    inspectCoverage: () => assert.fail("no coverage queries"),
    verifyBackupEvidence: () => assert.fail("no backup reads"),
  };
  const flags = scenario.startsWith("live") ? ["--live"] : scenario === "wait" ? ["--wait"] : [];
  const code = await runCli(["check", "--format", format, ...flags], { stdout: stdout.stream, stderr: stderr.stream,
    now: () => now, env: { PATH: "" }, root: "/synthetic/root", cwd: "/synthetic/cwd",
    loadCommand: async (group) => {
      assert.equal(group, "check");
      return { runCheckCommand: (options, context) => runCheckCommand(options, context, deps) };
    } });
  assert.equal(stderr.text(), "");
  return { code, text: stdout.text() };
}

const characters = (text) => text.replace(/\s/g, "");
const assertWidth = (text, columns) => {
  for (const line of text.split("\n")) assert.ok(textWidth(line) <= columns, `${columns}: ${line}`);
};

for (const scenario of ["healthy", "empty", "dependency", "live-healthy", "live-error", "wait"]) {
  test(`real check ${scenario} keeps all evidence at 40/80 columns and leaves JSON unchanged`, async () => {
    const reference = await check(scenario, 1000);
    assert.equal(reference.code, ["healthy", "live-healthy"].includes(scenario) ? 0 : scenario === "dependency" ? 1 : 2);
    const machine = await check(scenario, 80, "json");
    for (const columns of [40, 80]) {
      const output = await check(scenario, columns);
      assertWidth(output.text, columns);
      assert.equal(characters(output.text), characters(reference.text));
      assert.equal(output.code, reference.code);
      assert.equal((await check(scenario, columns, "json")).text, machine.text);
      assert.equal(JSON.parse(machine.text).exit_code, output.code);
      assert.doesNotMatch(output.text, /Hint:|Next step:/);
    }
  });
}

test("ordinary local check retains its existing compact whole screen", async () => {
  assert.equal((await check("healthy", 40)).text,
    "Check: PASSED\ndatabase: PASSED\nsync: PASSED\nquality: PASSED\ncoverage: NOT_REQUESTED\nbackup: NOT_REQUESTED\nlive: NOT_REQUESTED\nwait: NOT_REQUESTED\n");
});

test("narrow live check has hanging continuations and intact sample timestamps", async () => {
  const { text } = await check("live-healthy", 40);
  assert.match(text, /Remote sample: healthy · 2 messages \/ 1\n {15}discovered chats/);
  for (const timestamp of [iso(now), iso(now - 3600000), iso(now - 60000)]) assert.ok(text.includes(timestamp), timestamp);
  assert.match(text, /Findings: 0 confirmed missing · 0\n {10}suspected/);
});

async function help(argv, columns) {
  const stdout = writer(columns), stderr = writer(columns);
  const code = await runCli(argv, { stdout: stdout.stream, stderr: stderr.stream, env: { PATH: "" },
    loadCommand: () => assert.fail("help must never load command implementations") });
  assert.equal(code, 0);
  assert.equal(stderr.text(), "");
  return stdout.text();
}

for (const argv of [["--help"], ["--help", "--all"], ["check", "--help"], ["messages", "--help"], ["service", "--help"]]) {
  test(`real ${argv.join(" ")} fits 40/80 columns without losing flags or descriptions`, async () => {
    const reference = await help(argv, 1000);
    const machine = await help([...argv, "--format", "json"], 80);
    for (const columns of [40, 80]) {
      const output = await help(argv, columns);
      assertWidth(output, columns);
      assert.equal(characters(output), characters(reference));
      assert.equal(await help([...argv, "--format", "json"], columns), machine);
    }
  });
}

test("narrow help stacks long option labels and indents their descriptions", async () => {
  const text = await help(["check", "--help"], 40);
  assert.match(text, /^ {4}--messages-per-chat <integer>\n {6}Messages per page/m);
  assert.ok(text.includes("--write-live-cache"));
  assert.doesNotMatch(text, /\u001b/);
});
