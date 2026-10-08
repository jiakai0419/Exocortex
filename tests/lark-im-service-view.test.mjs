import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { plain } from "../dist/terminal/index.js";
import { buildServiceOverview, summarizeWorkerStability } from "../src/diagnostics/lark-im-service-report.mjs";
import { publicStatusReport } from "../src/diagnostics/status-report.mjs";
import { durationText, formatLeaseIssues, formatStabilityInterval, serviceTimestamp, serviceTimeRange } from "../src/terminal/status-format.mjs";
import { renderStatusText } from "../src/terminal/status-view.mjs";
import { rawStatusScreenFixture, STATUS_SCREEN_NOW } from "./helpers/status-screen-fixture.mjs";

// These are the surviving service-view invariants, exercised through the current
// public projection and renderer. All underlying reports are invented fixtures.
function project(report, detail = true) {
  return publicStatusReport({ report, observedAt: STATUS_SCREEN_NOW, service: { ...report.probe, target_match: "unknown" },
    installed: { status: "installed" } }, { detail });
}
const render = (report, detail = true) => plain(renderStatusText(project(report, detail), { columns: 160 }));
const compact = (value) => value.replace(/\s+/g, " ").trim();
const row = (output, label) => output.split("\n").find((line) => new RegExp(`^\\s*${label}\\s+`).test(line));

test("success intervals require two observations and round independently from elapsed ages", () => {
  for (const successes of [0, 1]) {
    assert.equal(formatStabilityInterval({ cycles: { ok: successes }, longest_between_successes_ms: null }), "unavailable (need 2 successes)");
    assert.equal(formatStabilityInterval({ cycles: { ok: successes }, longest_between_successes_ms: 0 }), "unavailable (need 2 successes)");
  }
  for (const [milliseconds, expected] of [[0, "0s"], [109600, "1m50s"], [41 * 60000, "41m"],
    [3601000, "1h1s"], [3601499, "1h1s"], [3601500, "1h2s"], [3661000, "1h1m1s"], [90061500, "1d1h1m2s"]]) {
    assert.equal(formatStabilityInterval({ cycles: { ok: 2 }, longest_between_successes_ms: milliseconds }), expected);
  }
  for (const interval of [null, -1, NaN, Infinity]) {
    assert.equal(formatStabilityInterval({ cycles: { ok: 2 }, longest_between_successes_ms: interval }), "unknown");
  }
  assert.equal(durationText(53600), "53s");
  assert.equal(durationText(3601000), "1h");
  assert.equal(durationText(3661000), "1h 1m");
  assert.equal(durationText(90061500), "1d 1h");
  assert.equal(durationText(null), "unknown");
});

test("invalid and reverse timestamp ranges do not imply a usable observation", () => {
  for (const value of [null, "invalid"]) assert.equal(serviceTimestamp(value, STATUS_SCREEN_NOW), "unknown");
  assert.equal(serviceTimeRange(null, "2032-02-04T12:00:00Z", STATUS_SCREEN_NOW), "unknown");
  assert.equal(serviceTimeRange("2032-02-04T12:00:00Z", "invalid", STATUS_SCREEN_NOW), "unknown");
  assert.equal(serviceTimeRange("2032-02-04T12:00:00Z", "2032-02-04T11:00:00Z", STATUS_SCREEN_NOW), "unknown");
});

function inZone(zone, script) {
  const formatUrl = new URL("../src/terminal/status-format.mjs", import.meta.url).href;
  const viewUrl = new URL("../src/terminal/status-view.mjs", import.meta.url).href;
  const terminalUrl = new URL("../dist/terminal/index.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { serviceTimestamp, serviceTimeRange } from ${JSON.stringify(formatUrl)};
    import { renderStatusText } from ${JSON.stringify(viewUrl)};
    import { plain } from ${JSON.stringify(terminalUrl)};
    const range = (from, to, now = to, seconds = false) => serviceTimeRange(from, to, Date.parse(now), seconds);
    ${script}
  `], { encoding: "utf8", env: { TZ: zone }, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("status ranges distinguish today, historical days, cross-day and cross-year dates", () => {
  assert.deepEqual(inZone("UTC", `console.log(JSON.stringify([
    range("2026-08-15T03:11:00Z", "2026-08-15T07:26:00Z"),
    range("2026-08-15T03:11:00Z", "2026-08-15T07:26:00Z", "2026-08-16T08:00:00Z"),
    range("2026-08-14T23:41:00Z", "2026-08-15T01:11:00Z"),
    range("2025-12-31T23:17:00Z", "2026-01-01T02:22:00Z"),
    range("2026-08-15T03:11:05Z", "2026-08-15T03:11:35Z", "2026-08-15T03:11:35Z", true)
  ]));`), [
    "Today 03:11–07:26", "2026-08-15 03:11–07:26", "2026-08-14 23:41–2026-08-15 01:11",
    "2025-12-31 23:17–2026-01-01 02:22", "Today 03:11:05–03:11:35",
  ]);
});

test("DST transitions and historical fold timestamps retain necessary offset disambiguation", () => {
  assert.deepEqual(inZone("America/New_York", `console.log(JSON.stringify([
    range("2026-11-01T05:15:00Z", "2026-11-01T06:35:00Z"),
    range("2026-03-08T06:30:00Z", "2026-03-08T07:30:00Z"),
    serviceTimestamp("2026-11-01T05:15:00Z", Date.parse("2026-11-02T12:00:00Z")),
    serviceTimestamp("2026-11-01T06:15:00Z", Date.parse("2026-11-02T12:00:00Z"))
  ]));`), [
    "Today 01:15 UTC-04:00–01:35 UTC-05:00", "Today 01:30 UTC-05:00–03:30 UTC-04:00",
    "2026-11-01 01:15:00 UTC-04:00", "2026-11-01 01:15:00 UTC-05:00",
  ]);
});

test("current history separates observed range from uptime and flags real truncation", () => {
  const report = rawStatusScreenFixture("truncated");
  const output = compact(render(report));
  assert.match(output, /Log coverage\s+Partial window; earlier observations unavailable · log truncated/);
  assert.match(output, /Observed events\s+Today/);
  assert.match(output, /Success spacing\s+Longest observed interval/);
  assert.doesNotMatch(row(render(report), "Observed events"), /uptime|service start/i);
  report.stability.observation.window_start_reached = true;
  report.stability.observation.tail_truncated = false;
  assert.match(row(render(report), "Log coverage"), /Lookback boundary reached/);
  assert.doesNotMatch(row(render(report), "Log coverage"), /truncated/);
  const empty = rawStatusScreenFixture("empty");
  assert.match(row(render(empty), "Log coverage"), /No events observed in this window/);
  assert.equal(row(render(empty), "Observed events"), undefined);
});

test("current chat list review uses completion time rather than later cursor update", () => {
  const report = rawStatusScreenFixture();
  const completed = "2032-02-04T08:10:00.000Z";
  report.sync.status.reconcile = { complete: true, cursor: { completed_at: completed, pages_scanned: 17 }, cursor_updated_at: "2032-02-04T09:20:00.000Z" };
  assert.match(row(render(report), "Chat list review"), new RegExp(`Complete · ${serviceTimestamp(completed, STATUS_SCREEN_NOW)}`));
  for (const value of [undefined, "invalid"]) {
    report.sync.status.reconcile.cursor.completed_at = value;
    assert.match(row(render(report), "Chat list review"), /Complete · time unavailable/);
  }
  report.sync.status.reconcile = { complete: false, cursor: { has_more: true } };
  assert.match(row(render(report), "Chat list review"), /More conversation pages remain/);
  report.sync.status.reconcile.cursor = null;
  assert.match(row(render(report), "Chat list review"), /No completed review recorded/);
});

test("lease formatting uses fixed reasons and never includes holder metadata", () => {
  assert.equal(formatLeaseIssues({ reasons: [
    { reason: "expired", count: 2 }, { reason: "hard_limit_exceeded", count: 1 },
    { reason: "invalid_timestamp", count: 1 }, { reason: "invalid_interval", count: 1 }, { reason: "future_start", count: 1 },
    { reason: "PRIVATE-SYNTHETIC-OWNER", count: 5 },
  ] }), "invalid timestamps x1, invalid lease interval x1, future start time x1, hard lease limit exceeded x1, expired x2");
  assert.equal(formatLeaseIssues({ reasons: [{ reason: "expired", count: 0 }] }), "lease state needs inspection");
});

test("current status shows abnormal reservation evidence without inferring current work or process death", () => {
  for (const expired of [false, true]) {
    const report = rawStatusScreenFixture();
    report.sync.status.health = "syncing";
    report.sync.status.locks = [{ locked_by: "PRIVATE-SYNTHETIC-OWNER", locked_at: "2032-02-04T11:59:00.000Z",
      expires_at: expired ? "2032-02-04T12:00:00.000Z" : "2032-02-04T12:01:00.000Z" }];
    report.overview = buildServiceOverview({ launchd: report.probe, syncStatus: report.sync.status, workerSummary: report.worker.summary, nowMs: STATUS_SCREEN_NOW });
    report.stability = summarizeWorkerStability([
      { type: "lark_im_worker_cycle", cycle: 1, ok: true, at: "2032-02-04T11:54:00.000Z" },
      { type: "lark_im_worker_cycle", cycle: 2, ok: true, at: "2032-02-04T11:56:00.000Z" },
    ], STATUS_SCREEN_NOW);
    const output = render(report, false);
    assert.match(row(output, "Current work"), /Unconfirmed/);
    if (expired) assert.match(row(output, "Sync reservations"), /expired x1/);
    else assert.equal(row(output, "Sync reservations"), undefined);
    assert.doesNotMatch(output, /PRIVATE-SYNTHETIC|blocked|waiting|process dead|holder/i);
    assert.match(row(render(report), "Success spacing"), /2m/);
  }
  const unknown = rawStatusScreenFixture();
  unknown.overview.leases = { evidence: "unavailable", abnormal_count: null };
  assert.match(row(render(unknown, false), "Sync reservations"), /Reservation evidence unavailable/);
  assert.doesNotMatch(render(unknown, false), /expired x/);
});

test("current restriction summaries retain counts without duplicating detail or mutating reports", () => {
  const report = rawStatusScreenFixture();
  Object.assign(report.sync.status.scopes, { received_unsupported: 4,
    unsupported_reasons: [{ reason: "restricted_mode", error_code: null, count: 4 }] });
  const before = JSON.stringify(report);
  const output = render(report, false);
  assert.match(row(output, "Restricted chats"), /4 excluded · 4 access restricted/);
  assert.equal((output.match(/access restricted/g) || []).length, 1);
  assert.doesNotMatch(output, /Lark CLI|code null|\bReason\s+|\bCount\s+/);
  assert.equal(JSON.stringify(report), before);
  report.sync.status.scopes.received_unsupported = 7;
  report.sync.status.scopes.unsupported_reasons = [
    { reason: "restricted_mode", error_code: null, count: 5 },
    { reason: "bot_user_out_of_chat", error_code: 73142, count: 2 },
  ];
  const detail = render(report);
  assert.match(row(detail, "Restricted chats"), /7 excluded/);
  assert.match(compact(detail), /Restriction\s+5 · access restricted Restriction\s+2 · not a conversation member · code 73142/);
  assert.equal((detail.match(/73142/g) || []).length, 1);
});

test("current restriction details retain zero and code-only evidence without leaking remote errors", () => {
  for (const errorCode of [null, "", 0, 73143]) {
    const report = rawStatusScreenFixture();
    Object.assign(report.sync.status.scopes, { received_unsupported: 2, unsupported_reasons: [{
      reason: "restricted_mode", error_code: errorCode, count: 2, lark_cli_error_message: "PRIVATE-SYNTHETIC-ERROR\u001b[2J\u202e",
    }] });
    const publicReport = project(report);
    const output = plain(renderStatusText(publicReport, { columns: 160 }));
    assert.doesNotMatch(JSON.stringify(publicReport) + output, /PRIVATE-SYNTHETIC-ERROR|\u001b|\u202e/);
    if (errorCode === null || errorCode === "") assert.doesNotMatch(row(output, "Restriction"), / · code /);
    else assert.match(row(output, "Restriction"), new RegExp(` · code ${errorCode}$`));
  }
  assert.match(row(render(rawStatusScreenFixture()), "Restricted chats"), /0 excluded/);
  assert.equal(row(render(rawStatusScreenFixture(), false), "Restricted chats"), undefined);
});

test("current status declares its IANA zone once and supports fractional-hour offsets", () => {
  const publicReport = project(rawStatusScreenFixture("sampled"));
  const output = inZone("Asia/Kathmandu", `console.log(JSON.stringify(plain(renderStatusText(${JSON.stringify(publicReport)}, { columns: 80 }))));`);
  assert.equal((output.match(/Asia\/(?:Kathmandu|Katmandu)/g) || []).length, 1);
  assert.match(output, /Observed Today 17:45:00/);
  assert.match(compact(output), /Sample checked\s+Today 17:44:30 · expires Today 17:49:00/);
  assert.doesNotMatch(output, /UTC[+-]|\d\d:\d\d:\d\dZ/);
  assert.ok(output.split("\n").every((line) => [...line].length <= 80));
});

test("current activity rendering preserves each evidence-backed state through public projection", () => {
  for (const [scenario, state, label] of [["syncing", "syncing", "Syncing"], ["healthy", "waiting", "Waiting"],
    ["stopped", "stopped", "Stopped"], ["expired_phase", "unknown", "Unconfirmed"]]) {
    const report = rawStatusScreenFixture(scenario);
    report.overview.activity.detail = "PRIVATE-SYNTHETIC-ACTIVITY";
    const publicReport = project(report);
    assert.equal(publicReport.activity.state, state);
    const output = plain(renderStatusText(publicReport, { columns: 160 }));
    assert.match(row(output, "Current work"), new RegExp(label));
    assert.doesNotMatch(JSON.stringify(publicReport) + output, /PRIVATE-SYNTHETIC-ACTIVITY/);
  }
});
