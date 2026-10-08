import assert from "node:assert/strict";
import test from "node:test";
import { createCommandContext } from "../src/cli/context.mjs";
import { runCheckCommand } from "../src/cli/check-command.mjs";
import { chatScopeId } from "../src/adapters/lark-im/core.mjs";
import { collectRemoteSample, SampleFailure } from "../src/diagnostics/remote-sample.mjs";
import { publicRemoteReport } from "../src/diagnostics/remote-sample-cache.mjs";

// From-scratch synthetic inputs; the real collector and command run with every
// database, account, API and scheduler dependency replaced by an in-memory value.
const now = Date.parse("2030-01-02T12:00:00Z");
const binding = { state: "verified", evidence: "single_sent_actor", database_key: "a".repeat(64), account_key: "b".repeat(64) };
const message = { message_id: "synthetic_message", chat_id: "synthetic_chat", msg_type: "text",
  create_time: String(now - 3600000), update_time: String(now - 3600000), body: { content: '{"text":"Invented message"}' } };
const local = { external_id: message.message_id, source_id: "lark.im", record_type: "lark.im.message", container_id: message.chat_id,
  external_version: message.update_time, raw_json: JSON.stringify(message), canonical_json: '{"source_api":"im.v1.messages"}' };

function sample(scenario) {
  let calls = 0;
  return collectRemoteSample("/synthetic/never-read.sqlite", {}, {
    now: () => now, context: () => ({ database_key: binding.database_key }),
    readBinding: () => scenario === "account_mismatch" ? { ...binding, state: "conflict" } : binding,
    loadInventory: () => scenario === "no_eligible_chats" ? [] : [{ id: chatScopeId(message.chat_id), chat_id: message.chat_id,
      source_id: "lark.im", enabled: 1, hot_rank: 0, hot_seen_at: new Date(now).toISOString() }],
    inspectSnapshot: () => ({ coverage: {}, records: new Map([[message.message_id,
      scenario === "identity_conflict" ? { ...local, container_id: "synthetic_other_chat" } : local]]) }),
    api: { count: () => calls, deadline: now + 55000, call(path) {
      calls++;
      if (scenario === "sync_busy") throw new SampleFailure("sync_busy");
      return path.includes("authen") ? { code: 0, data: { open_id: "ou_synthetic_audit", tenant_key: "synthetic_tenant" } }
        : { code: 0, data: { items: [message], has_more: false, page_token: "" } };
    } },
  });
}

async function command(scenario, { format = "text", unsafeDetails = false, transform = (value) => value } = {}) {
  let output = "";
  let collectorCalls = 0;
  let schedulerCalls = 0;
  const context = createCommandContext({ root: "/synthetic/root", cwd: "/synthetic/cwd", now: () => now,
    stdout: { write(value) { output += value; } } });
  const code = await runCheckCommand({ db: "/synthetic/never-read.sqlite", logDir: "/synthetic/never-read-logs", format,
    live: true, writeLiveCache: scenario === "not_due", unsafeDetails }, context, {
    checkDependencies: () => ({ sqlite: true, python: true, live: true, wait: true }),
    readDatabaseEvidence: () => ({ ok: true, quick_check: "ok" }),
    buildStatus: () => ({ health: "ok", scopes: {}, records: {}, runs: {}, locks: [],
      details: { evidence: "available", pending_count: 0 }, list_progress: { evidence: "available", invalid_cursor_scopes: 0 } }),
    collectQualityReport: () => ({ quality: { actionable_missing_sender_name: 0, missing_chat_name: 0, invalid_rendered_body: 0 } }),
    collectRemoteSample: () => { collectorCalls++; return transform(sample(scenario)); },
    liveProbeContext: () => ({ database_key: binding.database_key }),
    runManualRemoteSample: () => { schedulerCalls++; return { outcome: "not_due", reason: "not_due" }; },
    writeRemoteSampleCache: () => assert.fail("read-only or not-due checks must not write a cache"),
  });
  return { code, output, collectorCalls, schedulerCalls };
}

for (const [scenario, reasonText] of [
  ["account_mismatch", "Account association conflicts"],
  ["no_eligible_chats", "No eligible discovered chats"],
  ["sync_busy", "Synchronization is using the API"],
  ["not_due", "Next sample is not due"],
]) {
  test(`live text retains ${scenario} while JSON keeps its existing reason`, async () => {
    const text = await command(scenario);
    const json = await command(scenario, { format: "json" });
    const report = JSON.parse(json.output);
    assert.equal(text.code, 2);
    assert.equal(json.code, text.code);
    assert.ok(text.output.includes(`Reason: ${reasonText}\n`));
    assert.equal(report.checks.live.evidence.reason, scenario);
    assert.equal(report.schema_version, 1);
    assert.equal(report.checks.live.evidence.schema_version, 3);
    assert.doesNotMatch(text.output, /Message identity conflicts: 0|Prior findings unresolved: 0/);
    assert.equal(text.collectorCalls, scenario === "not_due" ? 0 : 1);
    assert.equal(text.schedulerCalls, scenario === "not_due" ? 1 : 0);
    if (scenario === "not_due") assert.equal(report.cache.status, "skipped");
  });
}

test("a real identity-conflict comparison is visible despite zero missing/version/body counters", async () => {
  const text = await command("identity_conflict");
  const json = await command("identity_conflict", { format: "json" });
  const report = JSON.parse(json.output);
  assert.equal(text.code, 2);
  assert.equal(json.code, 2);
  assert.match(text.output, /Remote sample: needs_attention/);
  assert.match(text.output, /Reason: Sample has source differences/);
  assert.match(text.output, /Message identity conflicts: 1\n/);
  assert.match(text.output.replace(/\s+/g, " "), /0 confirmed missing.*0 suspected.*0 pending sync.*0 older versions.*0 source content differences/);
  assert.equal(report.checks.live.evidence.findings.identity_conflict, 1);
  assert.deepEqual(report.checks.live.evidence, publicRemoteReport(sample("identity_conflict").report));
});

test("healthy text wraps at the default width without zero anomaly rows or generic notices", async () => {
  const text = await command("healthy");
  const json = await command("healthy", { format: "json" });
  assert.equal(text.code, 0);
  assert.equal(json.code, 0);
  assert.equal(text.output, [
    "Check: PASSED", "database: PASSED", "sync: PASSED", "quality: PASSED", "coverage: NOT_REQUESTED",
    "backup: NOT_REQUESTED", "live: PASSED", "wait: NOT_REQUESTED",
    "Remote sample: healthy · 1 messages / 1 discovered chats · checked",
    "               2030-01-02T12:00:00.000Z",
    "Window: 2030-01-01T11:50:00.000Z to 2030-01-02T11:50:00.000Z",
    "Findings: 0 confirmed missing · 0 suspected · 0 pending sync · 0 older versions",
    "          · 0 source content differences",
    "Compared: 1 static bodies · 0 body comparisons unverified · 0 truncated chats", "",
  ].join("\n"));
  assert.deepEqual(JSON.parse(json.output).checks.live.evidence, publicRemoteReport(sample("healthy").report));
});

test("nonzero uncertainty counters survive the text projection without changing JSON", async () => {
  const transform = (result) => ({ ...result, report: { ...result.report, ok: false, status: "delayed", reason: "unresolved_observations",
    findings: { ...result.report.findings, unresolved_prior: 2, local_newer: 1, expired_observations: 3, observation_overflow: 4 } } });
  const text = await command("healthy", { transform });
  const json = await command("healthy", { format: "json", transform });
  assert.equal(text.code, 2);
  for (const line of ["Reason: Prior sample findings remain unresolved", "Prior findings unresolved: 2", "Newer local versions: 1",
    "Expired observations: 3", "Observations beyond retained capacity: 4"]) assert.ok(text.output.includes(`${line}\n`), line);
  assert.doesNotMatch(text.output, /Message identity conflicts/);
  assert.deepEqual(JSON.parse(json.output).checks.live.evidence, publicRemoteReport(transform(sample("healthy")).report));
});

test("v3 remains public-safe even with unsafe-details; unknown reasons cannot reach text", async () => {
  const marker = "SYNTHETIC_PRIVATE_REASON\u001b[2J";
  const transform = (result) => ({ ...result, report: { ...result.report, ok: false, status: "inconclusive", reason: marker,
    latest_remote: { body: marker }, missing: [{ body: marker }] } });
  for (const unsafeDetails of [false, true]) {
    const text = await command("healthy", { transform, unsafeDetails });
    const json = await command("healthy", { format: "json", transform, unsafeDetails });
    assert.equal(text.code, 2);
    assert.equal(json.code, 2);
    assert.doesNotMatch(text.output + json.output, /SYNTHETIC_PRIVATE_REASON|\u001b|latest_remote/);
    assert.doesNotMatch(text.output, /^Reason:/m);
    assert.equal(JSON.parse(json.output).checks.live.evidence.reason, null);
    assert.equal(JSON.parse(json.output).privacy, unsafeDetails ? "private" : "public-safe");
  }
});
