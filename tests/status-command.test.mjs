import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runStatusCommand } from "../src/cli/status-command.mjs";
import { serviceTargetEvidence, waitWorkerSummary, readPrivateLogs } from "../src/diagnostics/status-report.mjs";
import { formatLogLine } from "../src/terminal/status-log-view.mjs";
import { plain } from "../dist/terminal/index.js";
import { fixture, options, sync, at } from "./helpers/check-fixture.mjs";
const marker = "PRIVATE_STATUS_SENTINEL";
const report = (overrides = {}) => ({ probe: { status: "absent", loaded: false, pid: null }, activity_evidence: null,
  overview: { health: { status: "problem", detail: marker }, activity: { status: "unknown", state: "unknown", detail: marker }, freshness: { status: "unknown", detail: marker } },
  sync: { status: sync({ health: "needs_attention", db_path: marker }) }, worker: { log: { events: [], path: marker }, summary: {} },
  launchd: { stderr: marker, stdout: marker }, freshness: { cache_path: marker }, ...overrides });
const deps = (value = report()) => ({ readInstalledServiceConfig: () => ({ status: "installed", config: { db: marker }, xml: marker }), buildServiceStatusReport: () => value });

test("status is a successful local query even when health is a problem; detail is public-safe", async () => {
  const f = fixture(); const code = await runStatusCommand(options({ detail: true }), f.context, deps());
  const result = JSON.parse(f.output()); assert.equal(code, 0); assert.equal(result.schema_version, 1);
  assert.equal(result.service.status, "absent"); assert.equal(result.health.local, "needs_attention");
  assert.equal(result.detail.health, "needs_attention"); assert.equal(result.privacy, "public-safe");
  assert.doesNotMatch(f.output(), new RegExp(marker)); assert.equal(result.launchd, undefined); assert.equal(result.freshness.cache_path, undefined);
});
test("status read failure returns 1 and retains independent service evidence", async () => {
  const f = fixture(); const code = await runStatusCommand(options(), f.context, deps(report({ sync: { status: null } })));
  assert.equal(code, 1); assert.equal(JSON.parse(f.output()).service.status, "absent");
});
test("status default excludes detail and never needs remote or cache writes", async () => {
  const f = fixture(); const code = await runStatusCommand(options(), f.context, { ...deps(), collectLagReport: () => assert.fail("remote"), writeLiveProbeCache: () => assert.fail("cache") });
  assert.equal(code, 0); assert.equal(JSON.parse(f.output()).detail, undefined);
  await assert.rejects(runStatusCommand(options(), { ...f.context, provided: new Set(["--lines"]) }, deps()), /requires --logs/);
});
test("explicit logs are private and bounded without mode or content changes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "invented-status-logs-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "worker.jsonl"); writeFileSync(file, `old\n${marker}\nlast\n`, { mode: 0o640 });
  const before = readFileSync(file); const mode = statSync(file).mode;
  const f = fixture(); const code = await runStatusCommand(options({ logs: true, lines: 2, logDir: dir }), f.context, deps());
  const result = JSON.parse(f.output()); assert.equal(code, 0); assert.equal(result.privacy, "private");
  assert.deepEqual(result.logs[0].lines, [marker, "last"]); assert.deepEqual(result.logs[1].lines, []);
  assert.deepEqual(readFileSync(file), before); assert.equal(statSync(file).mode, mode);
  let maxBytes;
  const logs = readPrivateLogs({ logDir: dir, lines: 1 }, { existsSync: () => true, readFileTail: (_path, max) => { maxBytes = max; return "a\nb\n"; } });
  assert.equal(maxBytes, 8 * 1024 * 1024); assert.deepEqual(logs[0].lines, ["b"]);
});
test("private log rendering retains cycle, failed step, counters, stderr and raw fallback", () => {
  assert.match(plain(formatLogLine(JSON.stringify({ type: "lark_im_worker_cycle", at: "2030-01-02T12:00:00Z", cycle: 7, ok: true }))), /cycle=7 OK/);
  const step = plain(formatLogLine(JSON.stringify({ type: "lark_im_worker_step", finished_at: "2030-01-02T12:00:00Z", cycle: 8, name: "received-catchup", ok: false, exit_code: 2, summary: { received: { scopes: 3, records: 5, inserted: 4, failed: 1 } }, stderr: marker })));
  assert.match(step, /received-catchup FAILED exit=2/); assert.match(step, /scopes=3 records=5 inserted=4 failed=1/); assert.match(step, new RegExp(marker));
  assert.equal(formatLogLine("not-json"), "not-json");
});
function boundReport() {
  const worker = { type: "lark_im_worker_activity", version: 1, role: "worker", pid: 1234, instance_id: "invented", parent_instance: null, database_key: "a".repeat(64),
    process_started_at_ms: at - 60000, phase: "waiting", cycle: 3, step: null, updated_at: new Date(at + 1000).toISOString(), valid_until: new Date(at + 6000).toISOString() };
  const identity = { version: 1, instance_id: worker.instance_id, database_key: worker.database_key, cycle: 3 };
  const cycle = { ...identity, type: "lark_im_worker_cycle", ok: true, at: new Date(at + 1000).toISOString(), step_count: 6, failed_steps: [] };
  const steps = ["sent", "discover-hot", "received-hot", "discover-catchup", "discover-reconcile", "received-fair"].map((name, index) => ({
    ...identity, type: "lark_im_worker_step", ok: true, exit_code: 0, name, step_index: index,
    started_at: new Date(at + index * 100).toISOString(), finished_at: new Date(at + index * 100 + 99).toISOString(),
  }));
  return report({ probe: { status: "running", pid: 1234 }, activity_evidence: { events: [worker], database_key: worker.database_key, database_identity_stable: true, integrity: true,
    processes: new Map([[1234, { state: "alive", started_at_ms: at - 60000 }]]) }, worker: { log: { events: [...steps, cycle] }, summary: { last_cycle: { cycle: 3, ok: true, at: cycle.at } } } });
}
test("installed disk config alone never proves running database association", () => {
  assert.equal(serviceTargetEvidence(report(), at).target_match, "unknown");
  const r = boundReport(); assert.equal(serviceTargetEvidence(r, at + 2000).target_match, "matched");
  r.activity_evidence.processes.get(1234).started_at_ms -= 10000;
  assert.equal(serviceTargetEvidence(r, at + 2000).target_match, "unknown");
});
test("wait summary requires a current matching worker and every successful step of its completed cycle", () => {
  const r = boundReport(); const binding = serviceTargetEvidence(r, at + 2000);
  const summary = waitWorkerSummary(r, binding); assert.equal(summary.last_cycle.complete, true); assert.equal(summary.last_cycle.started_at, new Date(at).toISOString());
  for (const mutate of [(r) => r.worker.log.events.pop(), (r) => r.worker.log.events.shift(), (r) => { r.worker.log.events[0].ok = false; }, (r) => { r.worker.log.events[0].started_at = "bad"; }, (r) => { r.worker.log.events.at(-1).step_count = 2; }, (r) => { r.worker.log.events.at(-1).at = new Date(at + 90000).toISOString(); }, (r) => { r.worker.log.events[0].finished_at = new Date(at - 1).toISOString(); }, (r) => { r.worker.log.events[0].finished_at = new Date(at + 90000).toISOString(); }, (r) => { r.activity_evidence.events[0].cycle = 4; }]) {
    const bad = boundReport(); mutate(bad); assert.notEqual(waitWorkerSummary(bad, serviceTargetEvidence(bad, at + 2000)).last_cycle?.complete, true);
  }
});

test("status restores safe stability, lease warnings, sampled window and worker history in JSON and text", async () => {
  const r = report(); const iso = (ms) => new Date(ms).toISOString();
  r.stability = { window_ms: 86400000, window_started_at: iso(at - 86400000), observed_events: 7,
    observation: { first_event_at: iso(at - 10000), last_event_at: iso(at - 1000), range_started_at: iso(at - 10000), range_ended_at: iso(at), window_start_reached: false, tail_truncated: true, raw: marker },
    cycles: { total: 3, ok: 2, failed: 1 }, last_success: { cycle: 3, at: iso(at - 1000), age_ms: 1000 }, longest_between_successes_ms: 4000,
    failures: { failed_cycles: 1, failed_steps: 2, by_kind: [{ kind: "permission_denied", count: 1 }, { kind: marker, count: 1 }], by_step: [{ name: "sent", count: 1 }, { name: marker, count: 1 }] }, raw: marker };
  r.overview.leases = { evidence: "available", observed_at: iso(at), total: 2, occupied_count: 1, abnormal_count: 1,
    reasons: [{ reason: "expired", count: 1 }, { reason: marker, count: 99 }], owner: marker, scope_id: marker };
  r.overview.freshness = { status: "sampled", scope: "recent_hot_messages", sample_count: 3, window: { start: iso(at - 60000), end: iso(at - 1000), raw: marker }, checked_at: iso(at), expires_at: iso(at + 60000), raw: marker };
  r.worker.summary = { has_events: true, last_event_type: "lark_im_worker_step", last_event_at: iso(at - 1000), last_event_age_ms: 1000,
    last_step: { name: "sent", cycle: 3, ok: true, at: iso(at - 1000), age_ms: 1000, raw: marker }, last_failure: { type: "lark_im_worker_step", name: marker, cycle: 2, at: iso(at - 5000), age_ms: 5000, raw: marker } };
  for (const detail of [false, true]) {
    const f = fixture(); assert.equal(await runStatusCommand(options({ detail }), f.context, deps(r)), 0);
    const p = JSON.parse(f.output()); assert.deepEqual(p.stability.cycles, { total: 3, ok: 2, failed: 1 });
    assert.equal(p.stability.observation.tail_truncated, true); assert.equal(p.stability.longest_between_successes_ms, 4000);
    assert.equal(p.stability.last_success.at, iso(at - 1000)); assert.equal(p.stability.failures.by_step[1].name, "unknown");
    assert.equal(p.leases.abnormal_count, 1); assert.deepEqual(p.leases.reasons, [{ reason: "expired", count: 1 }]);
    assert.deepEqual(p.freshness.window, { start: iso(at - 60000), end: iso(at - 1000) }); assert.equal(p.freshness.scope, "recent_hot_messages");
    assert.equal(p.worker.last_step.name, "sent"); assert.equal(p.worker.last_failure.name, "unknown"); assert.doesNotMatch(f.output(), new RegExp(marker));
  }
  const f = fixture(); assert.equal(await runStatusCommand(options({ format: "text" }), f.context, deps(r)), 0);
  assert.match(f.output(), /Statistics range:.*log truncated/); assert.match(f.output(), /Cycles: 2 ok, 1 failed, 3 total/);
  assert.match(f.output(), /Longest between successes: 4s/); assert.match(f.output(), /permission_denied x1/); assert.match(f.output(), /expired x1/);
  assert.match(f.output(), /Sample: recent_hot_messages, 3 messages/); assert.match(f.output(), /Window:/); assert.match(f.output(), /Last step: cycle #3 sent/);
  assert.doesNotMatch(f.output(), new RegExp(marker));
});
test("unrecognized status enum and timestamp evidence cannot disclose private values or imply a zero interval", async () => {
  const r = report(); r.stability = { longest_between_successes_ms: 0, cycles: { ok: 1 }, observation: { range_started_at: marker }, failures: { by_step: [{ name: marker, count: 1 }] } };
  r.overview.freshness = { status: "unknown", reason: marker, scope: marker, window: { start: marker, end: marker } };
  r.overview.leases = { evidence: "unavailable", reasons: [{ reason: marker, count: 1 }] };
  const f = fixture(); await runStatusCommand(options({ format: "text" }), f.context, deps(r));
  assert.match(f.output(), /Longest between successes: unavailable \(need 2 successes\)/); assert.doesNotMatch(f.output(), /Leases:/); assert.doesNotMatch(f.output(), new RegExp(marker));
});

test("default text preserves existing service health instead of upgrading a failed cycle with local ready", async () => {
  const { buildServiceOverview } = await import("../src/diagnostics/lark-im-service-report.mjs");
  const local = sync({ details: { evidence: "available", pending_count: 0, due_count: 0, scopes_pending: 0 }, list_progress: { evidence: "available", scopes: 1, invalid_cursor_scopes: 0 } });
  const workerSummary = { last_cycle: { cycle: 3, ok: false, at: new Date(at - 1000).toISOString() } };
  const overview = buildServiceOverview({ launchd: { loaded: true, state: "running", pid: 1234 }, syncStatus: local, workerSummary, nowMs: at });
  assert.equal(overview.health.status, "problem");
  const r = report({ probe: { status: "running", pid: 1234 }, overview, sync: { status: local }, worker: { summary: workerSummary, log: { events: [] } } });
  const f = fixture(); assert.equal(await runStatusCommand(options({ format: "text" }), f.context, deps(r)), 0);
  assert.match(f.output(), /Health: PROBLEM/); assert.doesNotMatch(f.output(), /Health: OK/);
});
for (const [unsupported, reasons] of [[0, []], [4, [{ reason: "restricted_mode", error_code: 231203, count: 4 }]],
  [5, [{ reason: "restricted_mode", error_code: 231203, count: 3 }, { reason: "bot_user_out_of_chat", error_code: 230002, count: 2 }]]]) {
  test(`default status retains compact Sync rows for ${reasons.length} unsupported reasons`, async () => {
    const r = report(); r.sync.status = sync({ records: { total: 8, by_direction: [{ direction: "sent", count: 3 }, { direction: "received", count: 5 }] },
      scopes: { received_enabled: 7, received_without_cursor: 1, received_unsupported: unsupported, unsupported_reasons: reasons },
      hot_discovery: { ran: true, cursor_updated_at: new Date(at - 3000).toISOString(), raw: marker },
      reconcile: { complete: true, cursor: { completed_at: new Date(at - 6000).toISOString(), raw: marker } } });
    r.overview.leases = { evidence: "available", total: 1, occupied_count: 1, abnormal_count: 0, reasons: [] };
    const f = fixture(); assert.equal(await runStatusCommand(options({ format: "text" }), f.context, deps(r)), 0); const output = plain(f.output());
    assert.match(output, /Records\s+8 total, 3 sent, 5 received/); assert.match(output, /Received scopes\s+7 enabled, 1 without cursor/);
    assert.match(output, /Active chat refresh\s+last success/); assert.match(output, /Chat list review\s+complete; completed/);
    assert.doesNotMatch(output, /Leases:|Warning|PRIVATE_STATUS_SENTINEL/);
    if (reasons.length === 0) assert.match(output, /Unsupported scopes\s+0/);
    else if (reasons.length === 1) assert.match(output, /Unsupported scopes\s+4 · restricted_mode \(access restricted\) · code 231203/);
    else { assert.match(output, /Unsupported scopes\s+5/); assert.match(output, /\n\s+3 · restricted_mode \(access restricted\) · code 231203/); assert.match(output, /\n\s+2 · bot_user_out_of_chat \(bot or user outside chat\) · code 230002/); }
  });
}
