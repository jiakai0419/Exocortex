import assert from "node:assert/strict";
import test from "node:test";
import { runCheckCommand } from "../src/cli/check-command.mjs";
import { runStatusCommand } from "../src/cli/status-command.mjs";
import { fixture, options, sync, quality, live, liveResult } from "./helpers/check-fixture.mjs";

// These domain/privacy cases outlive the retired doctor and report renderers.
// Inject only the current command's official I/O boundaries; exercise its real
// aggregation, exit code, public projection and rendering with synthetic data.
test("check keeps a keychain failure unavailable without disclosing its raw diagnostic", async () => {
  for (const format of ["json", "text"]) {
    const f = fixture();
    let calls = 0;
    f.deps.collectRemoteSample = () => {
      calls++;
      throw new Error("keychain Get failed: keychain not initialized GENERATED_PRIVATE_KEYCHAIN_PATH");
    };
    assert.equal(await runCheckCommand(options({ live: true, format }), f.context, f.deps), 1);
    assert.equal(calls, 1);
    assert.match(f.output(), /live_keychain_unavailable/);
    assert.doesNotMatch(f.output(), /GENERATED_PRIVATE_KEYCHAIN_PATH|keychain Get failed/);
    if (format === "json") {
      const report = JSON.parse(f.output());
      assert.equal(report.ok, false);
      assert.equal(report.checks.sync.status, "passed");
      assert.equal(report.checks.live.status, "unavailable");
    }
  }
});

for (const outcome of ["ok", "failed"]) test(`check v3 healthy sample requires successful collector outcome: ${outcome}`, async () => {
  const f = fixture();
  let calls = 0;
  f.deps.collectRemoteSample = () => { calls++; return liveResult(live(), { outcome }); };
  const expected = outcome === "ok";
  assert.equal(await runCheckCommand(options({ live: true }), f.context, f.deps), expected ? 0 : 1);
  const report = JSON.parse(f.output());
  assert.equal(calls, 1);
  assert.equal(report.ok, expected);
  assert.equal(report.checks.live.evidence.schema_version, 3);
  assert.equal(report.checks.live.status, expected ? "passed" : "unavailable");
});

for (const health of ["syncing", "catching_up"]) test(`unavailable v3 sample cannot make historical ${health} ready`, async () => {
  const f = fixture();
  f.deps.buildStatus = () => sync({ health,
    details: { evidence: "available", pending_count: 0, due_count: 0, scopes_pending: 0 },
    list_progress: { evidence: "available", scopes: 1, invalid_cursor_scopes: 0 } });
  f.deps.collectRemoteSample = () => liveResult(live({ ok: false, status: "unavailable", reason: "api_unavailable" }), { outcome: "failed" });
  assert.equal(await runCheckCommand(options({ live: true }), f.context, f.deps), 1);
  const report = JSON.parse(f.output());
  assert.equal(report.checks.sync.status, "incomplete");
  assert.equal(report.checks.sync.evidence.health, health === "syncing" ? "unknown" : "catching_up");
  assert.equal(report.checks.live.status, "unavailable");
  assert.equal(report.ok, false);
});

for (const status of ["needs_attention", "delayed", "inconclusive"]) test(`check retains non-green v3 ${status} evidence`, async () => {
  const f = fixture();
  f.deps.collectRemoteSample = () => liveResult(live({ ok: false, status }));
  assert.equal(await runCheckCommand(options({ live: true }), f.context, f.deps), 2);
  const report = JSON.parse(f.output());
  assert.equal(report.checks.live.status, "incomplete");
  assert.equal(report.checks.live.evidence.status, status);
  assert.equal(report.ok, false);
});

test("check permits advisory system and unresolved app sender gaps", async () => {
  const f = fixture();
  f.deps.collectQualityReport = () => quality({ missing_sender_name: 33, missing_user_sender_name: 0,
    missing_app_sender_name: 1, unresolved_app_sender_name: 1, missing_system_sender_name: 32 });
  assert.equal(await runCheckCommand(options(), f.context, f.deps), 0);
  const report = JSON.parse(f.output());
  assert.equal(report.checks.quality.status, "passed");
  assert.equal(report.checks.quality.evidence.quality.missing_sender_name, 33);
  assert.equal(report.checks.quality.evidence.quality.actionable_missing_sender_name, 0);
  assert.deepEqual(report.issues, []);
});

for (const field of ["actionable_missing_sender_name", "missing_chat_name", "invalid_rendered_body"]) {
  test(`check retains actionable quality finding ${field} alongside unknown sync evidence`, async () => {
    const f = fixture();
    f.deps.buildStatus = () => sync({ health: "syncing",
      details: { evidence: "available", pending_count: 0, due_count: 0, scopes_pending: 0 },
      list_progress: { evidence: "available", scopes: 1, invalid_cursor_scopes: 0 } });
    f.deps.collectQualityReport = () => quality({ [field]: 1 });
    assert.equal(await runCheckCommand(options(), f.context, f.deps), 2);
    const report = JSON.parse(f.output());
    assert.equal(report.checks.sync.evidence.health, "unknown");
    assert.equal(report.checks.quality.status, "incomplete");
    assert.equal(report.checks.quality.evidence.quality[field], 1);
    assert.deepEqual(report.issues, [{ code: "sync_incomplete", check: "sync" }, { code: "quality_incomplete", check: "quality" }]);
  });
}

for (const evidence of ["available", "legacy_unavailable"]) test(`current status preserves ${evidence} detail evidence without private source data`, async () => {
  const marker = "GENERATED_PRIVATE_STATUS_DETAIL";
  const local = sync({ db_path: marker,
    details: { evidence, pending_count: evidence === "available" ? 1 : null, due_count: evidence === "available" ? 1 : null,
      scopes_pending: evidence === "available" ? 1 : null, raw_root_json: marker },
    list_progress: { evidence, scopes: evidence === "available" ? 1 : null, invalid_cursor_scopes: evidence === "available" ? 0 : null },
    runs: { recent: [{ status: "failed", scope_id: marker, error_message: marker, failure_kind: "rate_limited", error_code: 9499 }] } });
  for (const format of ["json", "text"]) {
    const f = fixture();
    const deps = {
      readInstalledServiceConfig: () => ({ status: "absent" }),
      buildServiceStatusReport: () => ({ probe: { status: "absent", loaded: false, pid: null },
        overview: { health: { status: "unknown" }, activity: { status: "unknown" }, freshness: { status: "unknown" } },
        sync: { status: local }, worker: { log: { events: [] }, summary: {} } }),
    };
    assert.equal(await runStatusCommand(options({ format, detail: true }), f.context, deps), 0);
    assert.doesNotMatch(f.output(), new RegExp(marker));
    if (format === "json") {
      const report = JSON.parse(f.output());
      assert.equal(report.detail.details.evidence, evidence);
      assert.equal(report.detail.list_progress.evidence, evidence);
      assert.equal(report.detail.runs.recent[0].failure_kind, "rate_limited");
      assert.equal(report.detail.runs.recent[0].error_code, 9499);
      assert.equal(report.health.local, evidence === "available" ? "catching_up" : "ok");
    } else {
      assert.match(f.output(), evidence === "available" ? /1 pending · 1 due for retry/ : /Unavailable in this database version/);
    }
  }
});
