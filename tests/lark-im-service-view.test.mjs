import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { plain } from "../dist/terminal/index.js";
import { buildServiceOverview, summarizeWorkerStability } from "../src/diagnostics/lark-im-service-report.mjs";

import { ageText, formatLeaseIssues, formatReconcile, formatStabilityInterval, formatStatisticsRange, localTimestamp, serviceTimestamp, serviceTimeRange, renderServiceStatusText } from "../src/terminal/lark-im-service-view.mjs";

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

test("statistics range stays compact and flags actual truncation without routine long caveats", () => {
  const observation = {
    first_event_at: "2026-04-12T09:00:00.000Z", last_event_at: "2026-04-12T10:00:00.000Z",
    range_started_at: "2026-04-12T09:00:00.000Z", range_ended_at: "2026-04-12T10:00:00.000Z",
    window_start_reached: false, tail_truncated: true,
  };
  const referenceMs = Date.parse(observation.range_ended_at);
  const partial = formatStatisticsRange({ window_ms: 24 * 3600000, observation }, referenceMs);
  assert.ok(partial.startsWith(serviceTimeRange(observation.range_started_at, observation.range_ended_at, referenceMs)));
  assert.match(partial, / · 1h · log truncated$/);
  assert.doesNotMatch(partial, /service start|uptime/i);
  const boundaryReached = formatStatisticsRange({ observation: { ...observation, window_start_reached: true, tail_truncated: false } });
  assert.match(boundaryReached, / · 1h$/);
  assert.doesNotMatch(boundaryReached, /less than 24h|retained|truncated|complete/i);
  assert.equal(formatStatisticsRange({ observation: { range_started_at: null, range_ended_at: null } }), "unavailable (no current-window log evidence)");
});

test("reconcile completion shows only its recorded completion time", () => {
  const completedAt = "2026-04-12T08:10:00.000Z";
  const laterUpdate = "2026-04-12T09:20:00.000Z";
  const reconcile = { complete: true, cursor: { completed_at: completedAt, pages_scanned: 17 }, cursor_updated_at: laterUpdate };
  assert.equal(formatReconcile(reconcile), `complete; completed ${serviceTimestamp(completedAt)}`);
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
      activity: { status: "syncing", state: "syncing", detail: "cycle 3: sent" },
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
  assert.match(output, /Statistics range\s+Today .* · 1h · log truncated/);
  assert.equal((output.match(/Statistics range/g) || []).length, 1);
  assert.equal((output.match(/^\s*Health\s/gm) || []).length, 1, "overview health is not repeated in Sync");
  assert.match(output, /Last success\s+#3 53s ago/);
  assert.match(output, /Longest between successes\s+1m50s/);
  assert.match(output, /Received scopes\s+7 enabled, 0 without cursor/);
  assert.match(output, /Active chat refresh\s+last success /);
  assert.match(output, /Chat list review\s+complete; completed Today /);
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
    assert.match(output, /Statistics range\s+Today .* · 6m/);
    if (expired) assert.match(output, /Warning\s+expired x1; check sync diagnostics and system clock/);
    else {
      assert.doesNotMatch(output, /Warning|\bLocks\b/);
      assert.match(output, /Activity\s+UNKNOWN/);
      assert.doesNotMatch(output, /Activity\s+SYNCING/);
    }
    assert.doesNotMatch(output, /blocked|waiting|process dead|holder/i);
  }
  const unknown = reportFixture();
  unknown.overview.leases = { evidence: "unavailable", abnormal_count: null };
  assert.doesNotMatch(plain(renderServiceStatusText(unknown)), /Warning|\bLocks\b/);
  delete unknown.overview;
  assert.doesNotMatch(plain(renderServiceStatusText(unknown)), /Warning|\bLocks\b/);
});

test("unsupported scopes use one key/value row for a single reason without empty CLI columns", () => {
  const report = reportFixture();
  report.sync.status.scopes.received_unsupported = 4;
  report.sync.status.scopes.unsupported_reasons = [{ reason: "restricted_mode", error_code: null, count: 4 }];
  const before = JSON.stringify(report);
  const output = plain(renderServiceStatusText(report));
  const row = output.split("\n").find((line) => line.includes("Unsupported scopes"));
  assert.match(row, /^\s+Unsupported scopes\s+4 · restricted_mode \(access restricted\)$/);
  assert.equal((output.match(/restricted_mode/g) || []).length, 1);
  assert.doesNotMatch(output, /Lark CLI|\bReason\s+|\bCount\s+|code null|4 total/);
  assert.equal(JSON.stringify(report), before, "rendering does not mutate the public report");
});

test("unsupported scope reasons remain indented with individual counts and nonempty error codes", () => {
  const report = reportFixture();
  report.sync.status.scopes.received_unsupported = 7;
  report.sync.status.scopes.unsupported_reasons = [
    { reason: "restricted_mode", error_code: null, count: 5 },
    { reason: "bot_user_out_of_chat", error_code: 73142, count: 2 },
  ];
  const output = plain(renderServiceStatusText(report));
  assert.match(output, /Unsupported scopes\s+7\n\s+5 · restricted_mode \(access restricted\)\n\s+2 · bot_user_out_of_chat \(bot or user outside chat\) · code 73142/);
  assert.doesNotMatch(output, /Lark CLI|\bReason\s+|\bCount\s+/);
  assert.equal((output.match(/73142/g) || []).length, 1);
});

test("unsupported scopes preserve zero and code-only evidence without exposing remote error text", () => {
  for (const errorCode of [null, "", 0, 73143]) {
    const report = reportFixture();
    report.sync.status.scopes.received_unsupported = 2;
    report.sync.status.scopes.unsupported_reasons = [{
      reason: "restricted_mode", error_code: errorCode, count: 2,
      lark_cli_error_message: "PRIVATE-SYNTHETIC-ERROR\u001b[2J\u202e",
    }];
    const output = plain(renderServiceStatusText(report));
    assert.doesNotMatch(output, /PRIVATE-SYNTHETIC-ERROR|\u001b|\u202e/);
    if (errorCode === null || errorCode === "") assert.doesNotMatch(output, / · code /);
    else assert.match(output, new RegExp(` · code ${errorCode}(?:\\n|$)`));
  }
  const empty = reportFixture();
  empty.sync.status.scopes.received_unsupported = 0;
  empty.sync.status.scopes.unsupported_reasons = [];
  const output = plain(renderServiceStatusText(empty));
  assert.match(output, /Unsupported scopes\s+0\n/);
  assert.doesNotMatch(output, /Lark CLI|\bReason\s+|\bCount\s+/);
});

function renderInZone(zone, script) {
  const viewUrl = new URL("../src/terminal/lark-im-service-view.mjs", import.meta.url).href;
  const terminalUrl = new URL("../dist/terminal/index.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { formatStatisticsRange, serviceTimestamp, renderServiceStatusText } from ${JSON.stringify(viewUrl)};
    import { plain } from ${JSON.stringify(terminalUrl)};
    const range = (from, to, now = to) => formatStatisticsRange({
      observation: { range_started_at: from, range_ended_at: to, tail_truncated: false }
    }, Date.parse(now));
    ${script}
  `], { encoding: "utf8", env: { TZ: zone }, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("compact ranges distinguish today, historical days, cross-day and cross-year dates", () => {
  const ranges = renderInZone("UTC", `console.log(JSON.stringify([
    range("2026-08-15T03:11:00Z", "2026-08-15T07:26:00Z"),
    range("2026-08-15T03:11:00Z", "2026-08-15T07:26:00Z", "2026-08-16T08:00:00Z"),
    range("2026-08-14T23:41:00Z", "2026-08-15T01:11:00Z"),
    range("2025-12-31T23:17:00Z", "2026-01-01T02:22:00Z"),
    range("2026-08-15T03:11:05Z", "2026-08-15T03:11:35Z"),
    range("2026-08-15T03:11:00Z", "2026-08-15T03:11:00Z")
  ]));`);
  assert.deepEqual(ranges, [
    "Today 03:11–07:26 · 4h15m",
    "2026-08-15 03:11–07:26 · 4h15m",
    "2026-08-14 23:41–2026-08-15 01:11 · 1h30m",
    "2025-12-31 23:17–2026-01-01 02:22 · 3h5m",
    "Today 03:11–03:11 · <1m",
    "Today 03:11–03:11 · 0m",
  ]);
  assert.ok(ranges.every((range) => `  Statistics range           ${range}`.length <= 80));
});

test("DST changes and historical fold timestamps keep only necessary offset disambiguation", () => {
  const output = renderInZone("America/New_York", `console.log(JSON.stringify([
    range("2026-11-01T05:15:00Z", "2026-11-01T06:35:00Z"),
    range("2026-03-08T06:30:00Z", "2026-03-08T07:30:00Z"),
    serviceTimestamp("2026-11-01T05:15:00Z", Date.parse("2026-11-02T12:00:00Z")),
    serviceTimestamp("2026-11-01T06:15:00Z", Date.parse("2026-11-02T12:00:00Z"))
  ]));`);
  assert.deepEqual(output, [
    "Today 01:15 UTC-04:00–01:35 UTC-05:00 · 1h20m",
    "Today 01:30 UTC-05:00–03:30 UTC-04:00 · 1h",
    "2026-11-01 01:15:00 UTC-04:00",
    "2026-11-01 01:15:00 UTC-05:00",
  ]);
  assert.ok(output.slice(0, 2).every((range) => `  Statistics range           ${range}`.length <= 80));
});

test("service declares its IANA zone once and keeps the normal statistics row within 80 columns", () => {
  const report = reportFixture();
  report.stability.observation.tail_truncated = false;
  report.overview.freshness = {
    status: "sampled", detail: "synthetic sample", sample_count: 2, scope: "recent_hot_messages",
    window: { start: "2026-04-12T09:00:00Z", end: "2026-04-12T09:30:00Z" },
    checked_at: "2026-04-12T09:31:00Z", expires_at: "2026-04-12T09:36:00Z",
  };
  const output = renderInZone("Asia/Kathmandu", `console.log(JSON.stringify(plain(renderServiceStatusText(${JSON.stringify(report)}))));`);
  assert.equal((output.match(/Time zone/g) || []).length, 1);
  assert.equal((output.match(/Asia\/(?:Kathmandu|Katmandu)/g) || []).length, 1);
  assert.match(output, /Recent cycles \(up to 24h\)/);
  assert.match(output, /Statistics range\s+Today 14:45–15:45 · 1h/);
  assert.match(output, /Checked\s+Today 15:16:00/);
  assert.doesNotMatch(output, /Last 24h|less than 24h|retained log|UTC[+-]|\d\d:\d\d:\d\dZ/);
  assert.ok(output.split("\n").find((line) => line.includes("Statistics range")).length <= 80);
});

test("activity displays the precise additive state without changing its safe detail", () => {
  for (const state of ["syncing", "waiting", "stopped", "unknown"]) {
    const report = reportFixture();
    report.overview.activity = { status: "idle", state, detail: "synthetic current evidence" };
    const output = plain(renderServiceStatusText(report));
    assert.match(output, new RegExp(`Activity\\s+${state.toUpperCase()} synthetic current evidence`));
  }
});
