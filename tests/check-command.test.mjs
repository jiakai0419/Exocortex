import assert from "node:assert/strict";
import test from "node:test";
import { collectCheckReport } from "../src/diagnostics/check-report.mjs";
import { createCheckPlan } from "../src/diagnostics/check-plan.mjs";
import { evaluateWaitState } from "../src/diagnostics/service-wait-state.mjs";
import { runCheckCommand } from "../src/cli/check-command.mjs";
import { parseRouteOptions } from "../src/cli/registry.mjs";
import { at, sync, quality, live, options, fixture, waitEvidence } from "./helpers/check-fixture.mjs";

test("default check collects exactly three direct local reports, each with an observation time", async () => {
  let time = at;
  const f = fixture({ now: () => time++ });
  const code = await runCheckCommand(options(), f.context, f.deps);
  const result = JSON.parse(f.output());
  assert.equal(code, 0); assert.equal(result.schema_version, 1); assert.equal(result.ok, true);
  assert.deepEqual(f.calls, ["database", "sync", "quality"]);
  assert.deepEqual(Object.keys(result.checks), ["database", "sync", "quality", "coverage", "backup", "live", "wait"]);
  assert.notEqual(result.checks.database.observed_at, result.checks.sync.observed_at);
  assert.equal(result.checks.live.status, "not_requested"); assert.equal(result.cache.status, "not_requested");
});
for (const health of ["catching_up", "syncing", "unknown", "not_ready", "needs_attention"]) test(`local ${health} is incomplete, never ready`, async () => {
  const f = fixture(); f.deps.buildStatus = () => sync({ health });
  const result = await collectCheckReport(options(), f.context, f.deps);
  assert.equal(result.exit_code, 2); assert.equal(result.checks.sync.status, "incomplete");
});
for (const details of [{ evidence: "unavailable", pending_count: 0 }, { evidence: "available", pending_count: 1 }, {}]) test(`detail evidence ${JSON.stringify(details)} blocks readiness`, async () => {
  const f = fixture(); f.deps.buildStatus = () => sync({ details });
  assert.equal((await collectCheckReport(options(), f.context, f.deps)).exit_code, 2);
});
test("history is acceptable but actionable quality and database failures are not", async () => {
  const f = fixture(); f.deps.buildStatus = () => sync({ health: "ok_with_history" });
  assert.equal((await collectCheckReport(options(), f.context, f.deps)).exit_code, 0);
  f.deps.collectQualityReport = () => quality({ invalid_rendered_body: 1 });
  assert.equal((await collectCheckReport(options(), f.context, f.deps)).exit_code, 2);
  f.deps.readDatabaseEvidence = () => { throw new Error("PRIVATE_DB_ERROR"); };
  const result = await collectCheckReport(options(), f.context, f.deps);
  assert.equal(result.exit_code, 1); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DB_ERROR/);
});
test("dependency plan blocks remote access while still inspecting an explicit backup independently", async () => {
  const f = fixture(); f.deps.checkDependencies = () => ({ sqlite: true, python: false, live: true, wait: true });
  f.deps.readDatabaseEvidence = () => { throw new Error("database not found"); };
  f.deps.buildStatus = () => { throw new Error("PRIVATE_SOURCE_MISSING"); };
  f.deps.collectQualityReport = () => { throw new Error("PRIVATE_SOURCE_MISSING"); };
  const result = await collectCheckReport(options({ live: true, through: "2030-01-01T00:00:00Z", backup: "/tmp/existing-copy.sqlite" }), f.context, f.deps);
  assert.equal(result.exit_code, 1); assert.equal(result.checks.backup.status, "passed");
  assert.equal(result.checks.coverage.status, "unavailable"); assert.equal(result.checks.live.status, "skipped");
  assert.deepEqual(f.calls, ["backup"]); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|existing-copy/);
});
for (const overrides of [{ probe: { remote_messages_checked: 0, probe_errors: 0 } }, { probe: { remote_messages_checked: 1, probe_errors: 1 } }, { missing_count: 1 }, { window: {} }, { status: "unavailable", ok: false }, { status: "inconclusive", ok: false }]) test(`live rejects insufficient evidence ${JSON.stringify(overrides)}`, async () => {
  const f = fixture(); f.deps.collectLagReport = () => live(overrides);
  const result = await collectCheckReport(options({ live: true }), f.context, f.deps);
  assert.equal(result.exit_code, 2); assert.equal(result.checks.live.status, "incomplete");
});
test("live defaults use bounded discovered chats and a frozen stable 24-hour window without cache access", async () => {
  const f = fixture(); let received;
  f.deps.collectLagReport = (_db, plan) => { received = plan; return live(); };
  f.deps.liveProbeContext = () => { throw new Error("cache must not be inspected"); };
  assert.equal((await collectCheckReport(options({ live: true }), f.context, f.deps)).exit_code, 0);
  assert.deepEqual([received.chatPages, received.hotChats, received.messagesPerChat], [5, 5, 20]);
  assert.equal(received.endMs, Math.floor((at - 600000) / 60000) * 60000); assert.equal(received.startMs, received.endMs - 86400000);
});
test("all extensions run in fixed order; wait rechecks final readiness and cache writes last", async () => {
  const f = fixture(); f.deps.collectStatusEvidence = () => { f.calls.push("wait"); return waitEvidence(at); };
  const result = await collectCheckReport(options({ wait: true, live: true, writeLiveCache: true, through: "2030-01-01T00:00:00Z", backup: "/tmp/copy.sqlite" }), f.context, f.deps);
  assert.equal(result.exit_code, 0); assert.deepEqual(f.calls, ["wait", "database", "sync", "quality", "coverage", "backup", "live", "cache"]);
});
test("wait failure still collects local, coverage and backup, skipping live and cache", async () => {
  const f = fixture(); f.deps.collectStatusEvidence = () => waitEvidence(at, { service: { status: "absent" } });
  const result = await collectCheckReport(options({ wait: true, live: true, writeLiveCache: true, through: "2030-01-01T00:00:00Z", backup: "/tmp/copy.sqlite" }), f.context, f.deps);
  assert.equal(result.exit_code, 2); assert.equal(result.checks.wait.status, "incomplete");
  assert.equal(result.checks.live.status, "skipped"); assert.equal(result.cache.status, "skipped");
  assert.deepEqual(f.calls, ["database", "sync", "quality", "coverage", "backup"]);
});
test("wait uses the captured start and final quality, never remote polling", async () => {
  let time = at; let polls = 0;
  const f = fixture({ now: () => time });
  f.deps.collectStatusEvidence = () => { polls++; return waitEvidence(polls === 1 ? at - 1000 : at); };
  f.deps.sleep = async (ms) => { time += ms; };
  f.deps.collectQualityReport = () => quality({ missing_chat_name: 1 });
  const result = await collectCheckReport(options({ wait: true, live: true, timeoutSeconds: 10, pollSeconds: 1 }), f.context, f.deps);
  assert.equal(polls, 2); assert.equal(result.exit_code, 2); assert.equal(result.checks.wait.evidence.reason, "final_local_not_ready"); assert.ok(!f.calls.includes("live"));
});
for (const change of [
  (e) => { e.workerSummary.last_cycle.at = new Date(at).toISOString(); },
  (e) => { e.workerSummary.last_cycle.started_at = new Date(at - 1).toISOString(); },
  (e) => { e.workerSummary.last_cycle.complete = false; },
  (e) => { e.workerSummary.in_progress = true; }, (e) => { e.workerSummary.unfinished_cycle = true; },
  (e) => { e.service.target_match = "unknown"; }, (e) => { e.service.status = "loaded"; },
]) test(`wait predicate rejects ${change}`, () => {
  const e = waitEvidence(at); change(e);
  assert.equal(evaluateWaitState(at, e.report.sync.status, e.workerSummary, e.service).ready, false);
});
test("wait timeout is bounded and retains a fresh final local result", async () => {
  let time = at;
  const f = fixture({ now: () => time }); f.deps.collectStatusEvidence = () => waitEvidence(at - 1000);
  f.deps.sleep = async (ms) => { assert.ok(ms <= 60000); time += ms; };
  const report = await collectCheckReport(options({ wait: true, timeoutSeconds: 2, pollSeconds: 5 }), f.context, f.deps);
  assert.equal(time, at + 2000); assert.equal(report.exit_code, 2); assert.equal(report.checks.wait.evidence.reason, "wait_timeout"); assert.equal(report.checks.sync.status, "passed");
});
test("safe nested output drops private markers; only explicit unsafe live makes entire output private", async () => {
  const f = fixture(); const marker = "PRIVATE_INVENTED_SENTINEL";
  f.deps.buildStatus = () => sync({ db_path: marker, runs: { recent: [{ error_message: marker, scope_id: marker }] } });
  f.deps.collectQualityReport = () => ({ ...quality(), latest_records: [{ body: marker }] });
  f.deps.collectLagReport = () => live({ latest_remote: { body: marker, message_id: marker } });
  assert.doesNotMatch(JSON.stringify(await collectCheckReport(options({ live: true }), f.context, f.deps)), new RegExp(marker));
  const privateReport = await collectCheckReport(options({ live: true, unsafeDetails: true }), f.context, f.deps);
  assert.equal(privateReport.privacy, "private"); assert.match(JSON.stringify(privateReport), new RegExp(marker));
});
test("cache requires stable database identity and reports failed writes", async () => {
  const f = fixture(); let generation = 0;
  f.deps.liveProbeContext = () => ({ database_key: String(generation++) });
  assert.equal((await collectCheckReport(options({ live: true, writeLiveCache: true }), f.context, f.deps)).exit_code, 1);
  assert.ok(!f.calls.includes("cache"));
  f.deps.liveProbeContext = () => ({ database_key: "same" });
  f.deps.writeLiveProbeCache = () => { throw new Error("PRIVATE_CACHE_FAILURE"); };
  const report = await collectCheckReport(options({ live: true, writeLiveCache: true }), f.context, f.deps);
  assert.equal(report.exit_code, 1); assert.equal(report.cache.status, "failed"); assert.doesNotMatch(JSON.stringify(report), /PRIVATE_CACHE_FAILURE/);
});
test("domain validates mode combinations and time windows before dependencies", async () => {
  for (const [opts, flags] of [[{ backup: "/tmp/a", latestBackup: true }, []], [{ unsafeDetails: true }, []], [{ writeLiveCache: true }, []], [{}, ["--start"]], [{}, ["--lines"]], [{}, ["--timeout-seconds"]], [{}, ["--backup-dir"]], [{}, ["--log-dir"]], [{ live: true, start: "2030-01-02" }, []], [{ live: true, start: "2030-01-02T12:00:00Z" }, []]]) {
    if (flags.includes("--lines")) continue; // status owns this flag; root rejects it for check.
    const f = fixture({ provided: new Set(flags) }); f.deps.checkDependencies = () => { throw new Error("DEPENDENCIES_TOUCHED"); };
    await assert.rejects(collectCheckReport(options(opts), f.context, f.deps), (error) => !error.message.includes("DEPENDENCIES_TOUCHED"));
  }
  assert.throws(() => parseRouteOptions("check", ["--restart"]), /unknown/i);
  assert.throws(() => parseRouteOptions("check", ["--only", "sync"]), /unknown/i);
  assert.throws(() => parseRouteOptions("check", ["--hot-chats", "20junk"]), /integer/);
});

test("explicit unsafe live preserves private missing/latest/error details in text; ordinary text remains safe", async () => {
  const marker = "PRIVATE_EXPLICIT_LIVE_TEXT";
  for (const unsafeDetails of [false, true]) {
    const f = fixture(); f.deps.collectLagReport = () => live({ status: "delayed", ok: false, missing_count: 1,
      latest_remote: { body: marker, chat_name: marker, sender_name: marker },
      missing: [{ body: marker, chat_name: marker, sender_name: marker }], probe_errors: [{ chat_name: marker, error: marker }], unsupported_chats: [] });
    assert.equal(await runCheckCommand(options({ live: true, unsafeDetails, format: "text" }), f.context, f.deps), 2);
    if (unsafeDetails) { assert.match(f.output(), /PRIVATE/); assert.match(f.output(), new RegExp(marker)); assert.match(f.output(), /Missing/); }
    else assert.doesNotMatch(f.output(), new RegExp(marker));
  }
});

for (const field of ["through", "start", "end"]) test(`${field} rejects normalized dates and non-ISO input before any evidence or effect`, async () => {
  for (const value of ["2030-02-30T00:00:00Z", "2031-02-29T01:02:03+01:00", "2030-04-31T00:00:00-05:30",
    "2030-02-28T24:00:00Z", "March 1 2030 00:00:00Z", "2030-03-01T12:60:00Z", "2030-03-01T12:00:00+24:00"]) {
    let touched = false;
    const stop = () => { touched = true; throw new Error("EVIDENCE_OR_EFFECT_TOUCHED"); };
    const f = fixture({ startedAtMs: Date.parse("2036-01-01T00:00:00Z"), now: () => Date.parse("2036-01-01T00:00:00Z"), provided: new Set([`--${field}`]) });
    const deps = Object.fromEntries(["checkDependencies", "collectStatusEvidence", "sleep", "readDatabaseEvidence", "buildStatus", "collectQualityReport", "collectLagReport", "inspectCoverage", "verifyBackupEvidence", "liveProbeContext", "writeLiveProbeCache"].map((key) => [key, stop]));
    await assert.rejects(collectCheckReport(options({ wait: true, live: true, writeLiveCache: true, start: "2030-01-01T00:00:00Z", end: "2030-03-03T00:00:00Z", [field]: value }), f.context, deps),
      (error) => error.name === "CliUsageError" && error.message === `--${field} requires a valid ISO timestamp with an explicit timezone`, `${field}=${value}`);
    assert.equal(touched, false, `${field}=${value}`);
  }
});
test("leap-day offsets and fractional precision retain the exact requested instants", () => {
  const f = fixture({ startedAtMs: Date.parse("2036-01-01T00:00:00Z"), now: () => Date.parse("2036-01-01T00:00:00Z") });
  const plan = createCheckPlan(options({ live: true, start: "2032-02-29T01:00:00.1+01:00", end: "2032-02-29T01:01:00.123+01:00", through: "2032-02-28T23:00:00-01:00" }), f.context);
  assert.equal(plan.start, "2032-02-29T00:00:00.100Z"); assert.equal(plan.end, "2032-02-29T00:01:00.123Z");
  assert.equal(plan.throughMs, Date.parse("2032-02-29T00:00:00Z"));
  assert.equal(createCheckPlan(options({ through: "2032-02-29T00:00Z" }), f.context).throughMs, plan.throughMs);
});
