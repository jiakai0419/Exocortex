import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { plain } from "../dist/terminal/index.js";
import { buildServiceOverview, summarizeWorkerStability } from "../src/diagnostics/lark-im-service-report.mjs";

import { ageText, formatLeaseIssues, formatReconcile, formatStabilityInterval, formatStatisticsRange, localTimestamp, renderServiceStatusText } from "../src/terminal/lark-im-service-view.mjs";

test("success intervals require two observed successes instead of a misleading zero", () => {
  for (const successes of [0, 1]) {
    assert.equal(formatStabilityInterval({ cycles: { ok: successes }, longest_between_successes_ms: null }), "unavailable (need 2 successes)");
    assert.equal(formatStabilityInterval({ cycles: { ok: successes }, longest_between_successes_ms: 0 }), "unavailable (need 2 successes)");
  }
  assert.equal(formatStabilityInterval({ cycles: { ok: 2 }, longest_between_successes_ms: 41 * 60000 }), "41m");
  assert.equal(formatStabilityInterval({ cycles: { ok: 2 }, longest_between_successes_ms: 0 }), "0s");
  assert.equal(formatStabilityInterval({ cycles: { ok: 2 }, longest_between_successes_ms: null }), "unknown");
  assert.equal(formatStabilityInterval({ cycles: { ok: 2 }, longest_between_successes_ms: 109600 }), "1m50s");
  assert.equal(ageText(53600), "53s ago");
});

test("success intervals retain seconds above an hour without changing age formatting", () => {
  for (const [milliseconds, expected] of [[3601000, "1h1s"], [3601499, "1h1s"],
    [3601500, "1h2s"], [3661000, "1h1m1s"], [90061500, "1d1h1m2s"]]) {
    assert.equal(formatStabilityInterval({ cycles: { ok: 2 }, longest_between_successes_ms: milliseconds }), expected);
  }
  assert.equal(ageText(3601000), "1h ago");
});

test("local timestamps include each instant's offset across a daylight-saving boundary", () => {
  const moduleUrl = new URL("../src/terminal/lark-im-service-view.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { localTimestamp } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify([
      localTimestamp("2026-11-01T05:30:00.000Z"),
      localTimestamp("2026-11-01T06:30:00.000Z")
    ]));
  `], { encoding: "utf8", env: { TZ: "America/New_York" }, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    "2026-11-01 01:30:00 UTC-04:00",
    "2026-11-01 01:30:00 UTC-05:00",
  ]);
  assert.equal(localTimestamp(null), "unknown");
  assert.equal(localTimestamp("invalid"), "unknown");
});

test("statistics range shows retained evidence and partial-window caveats once", () => {
  const observation = {
    first_event_at: "2026-04-12T09:00:00.000Z", last_event_at: "2026-04-12T10:00:00.000Z",
    range_started_at: "2026-04-12T09:00:00.000Z", range_ended_at: "2026-04-12T10:00:00.000Z",
    window_start_reached: false, tail_truncated: true,
  };
  const partial = formatStatisticsRange({ window_ms: 24 * 3600000, observation });
  assert.ok(partial.startsWith(`${localTimestamp(observation.range_started_at)} → ${localTimestamp(observation.range_ended_at)}`));
  assert.match(partial, /less than 24h observed; retained log tail only/);
  assert.doesNotMatch(partial, /service start|uptime/i);
  const boundaryReached = formatStatisticsRange({ observation: { ...observation, window_start_reached: true, tail_truncated: false } });
  assert.match(boundaryReached, /retained log only/);
  assert.doesNotMatch(boundaryReached, /less than 24h|complete/i);
  assert.equal(formatStatisticsRange({ observation: { range_started_at: null, range_ended_at: null } }), "unavailable (no current-window log evidence)");
});

test("reconcile completion shows only its recorded completion time", () => {
  const completedAt = "2026-04-12T08:10:00.000Z";
  const laterUpdate = "2026-04-12T09:20:00.000Z";
  const reconcile = { complete: true, cursor: { completed_at: completedAt, pages_scanned: 17 }, cursor_updated_at: laterUpdate };
  assert.equal(formatReconcile(reconcile), `complete; completed ${localTimestamp(completedAt)}`);
  assert.equal(formatReconcile({ ...reconcile, cursor: { pages_scanned: 17 } }), "complete; completion time unavailable");
  assert.equal(formatReconcile({ ...reconcile, cursor: { completed_at: "invalid" } }), "complete; completion time unavailable");
  assert.equal(formatReconcile({ complete: false, cursor: { has_more: true } }), "in progress");
  assert.equal(formatReconcile({ complete: false, cursor: null }), "not started");
});

test("lease issue formatting uses fixed reasons and never includes holder metadata", () => {
  assert.equal(formatLeaseIssues({ reasons: [
    { reason: "expired", count: 2 }, { reason: "hard_limit_exceeded", count: 1 },
    { reason: "invalid_timestamp", count: 1 }, { reason: "invalid_interval", count: 1 }, { reason: "future_start", count: 1 },
    { reason: "PRIVATE-SYNTHETIC-OWNER", count: 5 },
  ] }), "invalid timestamps x1, invalid lease interval x1, future start time x1, hard lease limit exceeded x1, expired x2");
  assert.equal(formatLeaseIssues({ reasons: [{ reason: "expired", count: 0 }] }), "lease state needs inspection");
});

function reportFixture(abnormal = false) {
  return {
    label: "com.example.worker",
    service_state: "running",
    launchd: { loaded: true, state: "running" },
    overview: {
      service: { status: "running", detail: "LaunchAgent loaded" },
      health: { status: "ok", detail: "known scopes ready" },
      activity: { status: "syncing", detail: "unexpired sync lease observed" },
      freshness: { status: "unknown", detail: "no cached live probe" },
      leases: { evidence: "available", total: abnormal ? 3 : 1, occupied_count: 1, abnormal_count: abnormal ? 2 : 0, reasons: abnormal ? [{ reason: "expired", count: 2 }] : [] },
    },
    sync: { status: {
      records: { total: 8 }, scopes: { received_enabled: 7, received_without_cursor: 0 },
      hot_discovery: { ran: true, cursor_updated_at: "2026-04-12T10:00:00.000Z" },
      reconcile: { complete: true, cursor: { pages_scanned: 17, completed_at: "2026-04-12T08:10:00.000Z" } },
      locks: [{ locked_by: "PRIVATE-SYNTHETIC-OWNER" }],
    } },
    worker: { log: { exists: true, path: "worker.jsonl" }, summary: { has_events: false } },
    stability: {
      window_ms: 24 * 3600000, observed_events: 4, cycles: { total: 2, ok: 2, failed: 0 },
      last_success: { cycle: 3, age_ms: 53600 }, longest_between_successes_ms: 109600,
      observation: { range_started_at: "2026-04-12T09:00:00.000Z", range_ended_at: "2026-04-12T10:00:00.000Z", window_start_reached: false, tail_truncated: true },
      failures: {},
    },
  };
}

test("service view keeps minimal business rows and hides normal lock/page counts", () => {
  const output = plain(renderServiceStatusText(reportFixture()));
  assert.match(output, /Statistics range\s+.*less than 24h observed; retained log tail only/);
  assert.equal((output.match(/Statistics range/g) || []).length, 1);
  assert.equal((output.match(/^\s*Health\s/gm) || []).length, 1, "overview health is not repeated in Sync");
  assert.match(output, /Last success\s+#3 53s ago/);
  assert.match(output, /Longest between successes\s+1m50s/);
  assert.match(output, /Received scopes\s+7 enabled, 0 without cursor/);
  assert.match(output, /Active chat refresh\s+last success /);
  assert.match(output, /Chat list review\s+complete; completed .* UTC[+-]\d\d:\d\d/);
  assert.doesNotMatch(output, /\bLocks\b|Warning|17 pages|Observed log|PRIVATE-SYNTHETIC/);
  const abnormal = plain(renderServiceStatusText(reportFixture(true)));
  assert.match(abnormal, /Warning\s+expired x2; check sync diagnostics and system clock/);
  assert.doesNotMatch(abnormal, /\bLocks\b|PRIVATE-SYNTHETIC/);
});

test("real overview evidence renders only abnormal warnings without inferring blocking or process death", () => {
  const nowMs = Date.parse("2026-04-12T10:00:00.000Z");
  for (const expired of [false, true]) {
    const report = reportFixture();
    report.sync.status.health = "syncing";
    report.sync.status.locks = [{
      locked_at: "2026-04-12T09:59:00.000Z",
      expires_at: expired ? "2026-04-12T10:00:00.000Z" : "2026-04-12T10:01:00.000Z",
    }];
    report.overview = buildServiceOverview({ launchd: report.launchd, syncStatus: report.sync.status, workerSummary: report.worker.summary, nowMs });
    report.stability = summarizeWorkerStability([
      { type: "lark_im_worker_cycle", cycle: 1, ok: true, at: "2026-04-12T09:54:00.000Z" },
      { type: "lark_im_worker_cycle", cycle: 2, ok: true, at: "2026-04-12T09:56:00.000Z" },
    ], nowMs);
    const output = plain(renderServiceStatusText(report));
    assert.match(output, /Longest between successes\s+2m/);
    assert.match(output, /Statistics range\s+.*less than 24h observed/);
    if (expired) assert.match(output, /Warning\s+expired x1; check sync diagnostics and system clock/);
    else {
      assert.doesNotMatch(output, /Warning|\bLocks\b/);
      assert.match(output, /Activity\s+SYNCING unexpired sync lease observed/);
    }
    assert.doesNotMatch(output, /blocked|waiting|process dead|holder/i);
  }
  const unknown = reportFixture();
  unknown.overview.leases = { evidence: "unavailable", abnormal_count: null };
  assert.doesNotMatch(plain(renderServiceStatusText(unknown)), /Warning|\bLocks\b/);
  delete unknown.overview;
  assert.doesNotMatch(plain(renderServiceStatusText(unknown)), /Warning|\bLocks\b/);
});
