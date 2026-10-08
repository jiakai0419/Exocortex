import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import test from "node:test";
import { publicStatusReport, serviceTargetEvidence } from "../src/diagnostics/status-report.mjs";
import { renderStatusText } from "../src/terminal/status-view.mjs";
import { statusWidth } from "../src/terminal/status-layout.mjs";
import { plain } from "../dist/terminal/index.js";
import { REQUIRED_CYCLE_STEPS } from "../dist/runtime/worker/lark-im-worker-core.js";
import { STATUS_SCREEN_NOW, STATUS_SCREEN_PRIVATE, STATUS_SCREEN_SCENARIOS,
  rawStatusScreenFixture, statusScreenFixture } from "./helpers/status-screen-fixture.mjs";

process.env.TZ = "UTC";
process.env.NO_COLOR = "1";
delete process.env.FORCE_COLOR;
const stream = new Writable({ write(_chunk, _encoding, done) { done(); } });
const LABELS = ["Runs", "Last completed"];
const PRIVATE = "SYNTHETIC-RUNTIME-PRIVATE-ID";
const DATABASE_KEY = "a".repeat(64);
const OTHER_DATABASE_KEY = "b".repeat(64);
const iso = (offset = 0) => new Date(STATUS_SCREEN_NOW + offset).toISOString();
const hash = (text) => createHash("sha256").update(text).digest("hex");

// Generated only from invented status-screen fixtures, with TZ=UTC and NO_COLOR=1.
// JSON hashes include the approved read-only failed-run transition projection.
// Compared against bf093e9 baseline status using all 18 invented scenarios:
// only failure_runs actionable counters/transitions and their detailed run
// counterparts were added; no existing JSON value changed.
// Detail text additionally names its log source "Worker history source"; at
// every tested width this is the only new text change, and default text is exact.
// The earlier detail baseline incorporated Command targets guidance and wrapping.
// Default hashes were regenerated from 6ffc3d5b047c73638b2a2f0450769e2c755ddff1
// by removing its old four runtime rows and Message details row. The candidate
// removes its paired runtime rows and the same detail row for comparison; an
// otherwise empty Problems section is removed only after losing that detail row.
// Hash input: scenarios.map(name => `${name}\n${rendered}`).join("\n---\n").
// The test runner never invokes Git or reads operational data. Only the authorized
// runtime layout and default detail-row placement are exempt from this baseline;
// hashes protect all other text, including indentation, wrapping, headings,
// blank lines, diagnostics and the final newline.
const BASELINE_TEXT = {
  "default:96": "0739e9f515304cf03444c2700fe0390e4520bfe2c437bba5609f316668e3703a",
  "default:80": "7a6c4d40382234cbed7eff58844c122fa9a8a2f5bad9475243b9e1ecf2c3b710",
  "default:56": "bd2cd9d5a179d6450548b65d09b920a9500c2ea81d25db1cc051901a22a88dfb",
  "default:40": "f4104d27b98586065485d9e4d41374a60d0dbb2d75b625790933791996621474",
  "detail:96": "96f275ac92493b11289a829977bc3df91a227d860a65097252e221f6003bde22",
  "detail:80": "f8428b4b31c38e162e238b8a1bc9c8d4178973c2ac31b6f20dd7061c9d95cfe5",
  "detail:56": "923ab902e79bad31eb069779a73c1118386cea0aea5105eb266b82914426acc9",
  "detail:40": "48bb46a782b4316e7f437e16e2b58531d0d6356207481bf9027ff3116e3ce402",
};
const BASELINE_JSON = {
  false: "b5478d5d03fb34d6a84c7b002d5e78fd1ccc67cbeb6d0651c0f984de9c5bf517",
  true: "b261a19be2aefdda84241702edcb8ed9f7351c9994952331280b8788a07e32b0",
};

function runtimeRows(text, detail = false) {
  const lines = plain(text).split("\n");
  const retained = [];
  const rows = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^ {2}(Runs|Last completed|Run scope)(?:\s+(.*))?$/.exec(lines[index]);
    if (!match) { retained.push(lines[index]); continue; }
    const parts = [match[2] || ""];
    const preceding = lines.slice(0, index).findLast((line) => /^ {2}\S/.test(line));
    while (index + 1 < lines.length && /^ {4}\s*\S/.test(lines[index + 1])) parts.push(lines[++index].trim());
    rows.push({ label: match[1], value: parts.join(" ").trim(), preceding });
  }
  assert.deepEqual(rows.map(({ label }) => label), detail ? [...LABELS, "Run scope"] : LABELS,
    "exactly two runtime rows, plus scope only in detail, once each and in order");
  if (detail) assert.match(rows[2].value, /^(?:Completed rounds · )?current worker \/ retained log$/);
  else assert.doesNotMatch(text, /current worker \/ retained log/);
  return { retained: retained.join("\n"), rows, values: Object.fromEntries(rows.map(({ label, value }) => [label, value])) };
}

function withoutDefaultDetails(text) {
  const lines = text.split("\n");
  const retained = [];
  let inProblems = false;
  let removedProblemDetails = false;
  for (let index = 0; index < lines.length; index++) {
    if (/^\S/.test(lines[index])) inProblems = lines[index] === "Problems";
    if (!/^ {2}Message details(?:\s|$)/.test(lines[index])) { retained.push(lines[index]); continue; }
    removedProblemDetails ||= inProblems;
    while (index + 1 < lines.length && /^ {4}\s*\S/.test(lines[index + 1])) index++;
  }
  const output = retained.join("\n");
  // A Problems section containing other rows keeps its heading and row order.
  // An unsolicited empty section with no removed detail row is not exempted.
  return removedProblemDetails ? output.replace(/\nProblems\n(?=\n|$)/g, "") : output;
}

for (const detail of [false, true]) {
  for (const columns of [96, 80, 56, 40]) {
    test(`only approved ${detail ? "runtime rows change detailed" : "runtime and detail rows change default"} status at ${columns} columns`, () => {
      const joined = STATUS_SCREEN_SCENARIOS.map((name) => {
        const report = statusScreenFixture(name, { detail });
        const output = renderStatusText(report, { columns, stream });
        const { retained, rows } = runtimeRows(output, detail);
        const preceding = detail && ["waiting", "syncing"].includes(report.activity.state) ? "Phase observed" : "Current work";
        assert.ok(rows[0].preceding?.startsWith(`  ${preceding}`), `${name}: runtime rows follow ${preceding}`);
        assert.doesNotMatch(output, /\u001b\[/, "NO_COLOR output must not contain styles");
        assert.doesNotMatch(output, new RegExp(STATUS_SCREEN_PRIVATE));
        for (const line of output.split("\n")) assert.ok(statusWidth(line) <= columns, `${name}: overflow at ${columns} columns`);
        return `${name}\n${detail ? retained : withoutDefaultDetails(retained)}`;
      }).join("\n---\n");
      assert.equal(hash(joined), BASELINE_TEXT[`${detail ? "detail" : "default"}:${columns}`], "all other text must match the fixed baseline byte for byte");
    });
  }
  test(`public JSON preserves the approved projection outside runtime_stats (${detail ? "detail" : "default"})`, () => {
    const joined = STATUS_SCREEN_SCENARIOS.map((name) => {
      const { runtime_stats, ...existing } = statusScreenFixture(name, { detail });
      assert.equal(runtime_stats.scope, "current_worker_retained_log");
      assert.deepEqual(Object.keys(runtime_stats).sort(), ["scope", "state", "total_runs", "successful_runs", "last_completed_at", "last_duration_ms", "reason"].sort());
      assert.ok(["available", "unavailable"].includes(runtime_stats.state));
      return `${name}\n${JSON.stringify(existing)}`;
    }).join("\n---\n");
    assert.equal(hash(joined), BASELINE_JSON[detail]);
  });
}

// Independent, invented process/file identities. No database, process or service
// is accessed: serviceTargetEvidence validates the injected observation only.
function collectedFixture() {
  const report = rawStatusScreenFixture("healthy");
  const worker = { type: "lark_im_worker_activity", version: 1, role: "worker", pid: report.probe.pid,
    instance_id: `${PRIVATE}-current`, parent_instance: null, database_key: DATABASE_KEY,
    process_started_at_ms: STATUS_SCREEN_NOW - 3_600_000, phase: "waiting", cycle: 2, step: null,
    updated_at: iso(-1000), valid_until: iso(10_000) };
  report.activity_evidence = { database_identity_stable: true, database_key: DATABASE_KEY, integrity: true, truncated: false,
    events: [worker], service_worker_events: [worker],
    processes: new Map([[worker.pid, { state: "alive", started_at_ms: worker.process_started_at_ms, ppid: 1 }]]) };
  report.worker.log = { exists: true, activity_integrity: true, truncated: false, path: PRIVATE, events: [] };
  report.stability.longest_between_successes_ms = 123_000;
  const completion = (cycle, at, ok = true) => ({ type: "lark_im_worker_cycle", version: 1,
    instance_id: worker.instance_id, database_key: DATABASE_KEY, cycle, at: iso(at), ok,
    step_count: REQUIRED_CYCLE_STEPS.length, failed_steps: ok ? [] : [REQUIRED_CYCLE_STEPS[0]], raw_error: PRIVATE });
  const final = completion(2, -5000, false);
  const steps = REQUIRED_CYCLE_STEPS.map((name, step_index) => ({ type: "lark_im_worker_step", version: 1,
    instance_id: worker.instance_id, database_key: DATABASE_KEY, cycle: 2, name, step_index,
    ok: step_index !== 0, exit_code: step_index === 0 ? 1 : 0, partial: false,
    started_at: iso(-5000 - (REQUIRED_CYCLE_STEPS.length - step_index) * 1000),
    finished_at: iso(-5000 - (REQUIRED_CYCLE_STEPS.length - step_index - 1) * 1000), raw: PRIVATE }));
  report.worker.log.events = [completion(1, -60_000), ...steps, final];
  return { report, worker, final, steps, completion };
}

function project(fixture, detail = false) {
  const { report } = fixture;
  const binding = serviceTargetEvidence(report, STATUS_SCREEN_NOW);
  return publicStatusReport({ report, binding, observedAt: STATUS_SCREEN_NOW,
    service: { ...report.probe, target_match: binding.target_match }, installed: { status: "installed", config: { db: PRIVATE } } }, { detail });
}

function renderStats(report, columns = 80) {
  const before = JSON.stringify(report);
  const output = renderStatusText(report, { columns, stream });
  assert.equal(JSON.stringify(report), before, "pairing display rows must not change public data");
  assert.doesNotMatch(`${JSON.stringify(report)}\n${output}`, new RegExp(`${PRIVATE}|${DATABASE_KEY}|${OTHER_DATABASE_KEY}|${STATUS_SCREEN_PRIVATE}`));
  assert.doesNotMatch(output, /\u001b\[/, "NO_COLOR output must not contain styles");
  for (const line of output.split("\n")) assert.ok(statusWidth(line) <= columns, `overflow at ${columns} columns: ${line}`);
  return runtimeRows(output, report.detail !== undefined).values;
}

test("bound runtime facts survive public projection and render independently of success spacing", () => {
  for (const detail of [false, true]) for (const columns of [96, 80, 56, 40]) {
    const fixture = collectedFixture();
    const report = project(fixture, detail);
    assert.deepEqual(report.runtime_stats, { scope: "current_worker_retained_log", state: "available",
      total_runs: 2, successful_runs: 1, last_completed_at: iso(-5000), last_duration_ms: REQUIRED_CYCLE_STEPS.length * 1000, reason: null });
    const rows = renderStats(report, columns);
    assert.equal(rows.Runs, "2 total · 1 successful");
    assert.equal(rows["Last completed"], `Today 11:59:55 (5s ago) · ${REQUIRED_CYCLE_STEPS.length}s duration`);
    assert.notEqual(report.runtime_stats.last_duration_ms, report.stability.longest_between_successes_ms);
  }
});

test("foreign database and previous-instance completions cannot change current worker runtime stats", () => {
  const fixture = collectedFixture();
  const expected = project(fixture).runtime_stats;
  assert.equal(expected.state, "available");
  fixture.report.worker.log.events.push(
    { ...fixture.completion(1, -2000), instance_id: `${PRIVATE}-foreign-db`, database_key: OTHER_DATABASE_KEY },
    { ...fixture.completion(1, -2000), database_key: OTHER_DATABASE_KEY },
    { ...fixture.completion(2, -1000), instance_id: `${PRIVATE}-previous-instance` },
  );
  const report = project(fixture);
  assert.deepEqual(report.runtime_stats, expected);
  renderStats(report);
});

test("failed completions preserve total, zero successes, completion time and duration at 40 columns", () => {
  const fixture = collectedFixture();
  Object.assign(fixture.report.worker.log.events[0], { ok: false, failed_steps: [REQUIRED_CYCLE_STEPS[0]] });
  for (const detail of [false, true]) {
    const report = project(fixture, detail);
    assert.equal(report.runtime_stats.total_runs, 2);
    assert.equal(report.runtime_stats.successful_runs, 0);
    const rows = renderStats(report, 40);
    assert.equal(rows.Runs, "2 total · 0 successful");
    assert.equal(rows["Last completed"], `Today 11:59:55 (5s ago) · ${REQUIRED_CYCLE_STEPS.length}s duration`);
  }
});

test("a bound empty retained log is zero completed runs with no invented time or duration", () => {
  const fixture = collectedFixture();
  fixture.report.worker.log.events = [];
  for (const detail of [false, true]) {
    const report = project(fixture, detail);
    assert.deepEqual(report.runtime_stats, { scope: "current_worker_retained_log", state: "available", total_runs: 0,
      successful_runs: 0, last_completed_at: null, last_duration_ms: null, reason: null });
    const rows = renderStats(report, 40);
    assert.equal(rows.Runs, "0 total · 0 successful");
    assert.equal(rows["Last completed"], "None recorded");
  }
});

for (const [name, change] of [
  ["missing log", ({ report }) => { report.worker.log.exists = false; }],
  ["unverified process", ({ report }) => { report.activity_evidence.processes.clear(); }],
  ["different selected database", ({ report }) => { report.activity_evidence.database_key = OTHER_DATABASE_KEY; }],
  ["expired phase", ({ worker }) => { worker.valid_until = iso(-1); }],
  ["unbound legacy completion", ({ report }) => { report.worker.log.events = [{ type: "lark_im_worker_cycle", cycle: 1, at: iso(-1000), ok: true }]; }],
]) {
  test(`${name} renders unavailable runtime evidence instead of zero or borrowed history`, () => {
    const fixture = collectedFixture(); change(fixture);
    for (const detail of [false, true]) {
      const report = project(fixture, detail);
      assert.equal(report.runtime_stats.state, "unavailable");
      assert.ok(["worker_unverified", "log_unavailable", "log_damaged", "completion_unbound", "completion_invalid", "completion_conflict"].includes(report.runtime_stats.reason));
      for (const key of ["total_runs", "successful_runs", "last_completed_at", "last_duration_ms"]) assert.equal(report.runtime_stats[key], null, key);
      const rows = renderStats(report, 40);
      assert.match(rows.Runs, /^Unavailable · \S.+/, "the reason survives narrow wrapping");
      assert.equal(rows["Last completed"], "Unavailable");
    }
  });
}

test("missing step timestamps keep completion counts but cannot borrow a duration from history or spacing", () => {
  const fixture = collectedFixture();
  delete fixture.steps[0].started_at;
  fixture.report.worker.summary.last_cycle.started_at = iso(-90_000);
  const report = project(fixture, true);
  assert.equal(report.runtime_stats.state, "available");
  assert.equal(report.runtime_stats.total_runs, 2);
  assert.equal(report.runtime_stats.successful_runs, 1);
  assert.equal(report.runtime_stats.last_completed_at, iso(-5000));
  assert.equal(report.runtime_stats.last_duration_ms, null);
  const rows = renderStats(report, 40);
  assert.equal(rows.Runs, "2 total · 1 successful");
  assert.match(rows["Last completed"], /^Today 11:59:55 \(5s ago\).*duration unavailable.*incomplete step evidence/i);
});

test("last duration includes completion bookkeeping after the last finished step", () => {
  const fixture = collectedFixture();
  fixture.final.at = iso(-3000);
  const report = project(fixture);
  assert.equal(report.runtime_stats.last_completed_at, iso(-3000));
  assert.equal(report.runtime_stats.last_duration_ms, REQUIRED_CYCLE_STEPS.length * 1000 + 2000);
  const rows = renderStats(report);
  assert.equal(rows["Last completed"], `Today 11:59:57 (3s ago) · ${REQUIRED_CYCLE_STEPS.length + 2}s duration`);
});
