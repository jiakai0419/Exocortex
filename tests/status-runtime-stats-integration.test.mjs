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
const LABELS = ["Total runs", "Successful runs", "Last completed", "Last duration"];
const PRIVATE = "SYNTHETIC-RUNTIME-PRIVATE-ID";
const DATABASE_KEY = "a".repeat(64);
const OTHER_DATABASE_KEY = "b".repeat(64);
const iso = (offset = 0) => new Date(STATUS_SCREEN_NOW + offset).toISOString();
const hash = (text) => createHash("sha256").update(text).digest("hex");

// Generated only from the invented status-screen fixtures at commit
// 34f9698142fc479decd20968ab3002316278dcbd, with TZ=UTC and NO_COLOR=1.
// Hash input: scenarios.map(name => `${name}\n${rendered}`).join("\n---\n").
// The test runner never invokes Git or reads any operational data. Removing only
// the four added rows must recover every byte of the pre-change screen, including
// indentation, wrapping, headings, blank lines, diagnostics and final newline.
const BASELINE_TEXT = {
  "default:96": "8963a50283d4ab8b2f89e6324cec411325f0406f17e69252007ba13e72868881",
  "default:80": "f0da67d4ea0cfe5fb75487e6591eff4bd10a642135fff2191f844b53eb541e36",
  "default:56": "b1927c2ff3224bd1575498e6dcc5475fc9a951ffc5e22a2ff650d72436f96164",
  "default:40": "4512be2fbc35c80bd1ce3df763a768c4057a33b21a6034acc4d60de1394d23fd",
  "detail:96": "f6e766c2292962e2c81e7667592dda7f849eccbd24e1558b0c00af1745675722",
  "detail:80": "3a1b6f67f93360129c4fde357259fcf183a35de75ba4ec664492b7d11b2a6cf5",
  "detail:56": "9d839f5436f374cf5f46b5467c692fb9cddd8db521113224abf794a8df0d8182",
  "detail:40": "2d4a4fd8e966fb2e200fdc25deabbc3475e71a8a77882289e9fce6e6ef83446e",
};
const BASELINE_JSON = {
  false: "dbfe1994f881cf37963be356f2acd33b63b09c161b59b3d29762a0fd430fef8c",
  true: "21ccb36120f67708260f7032f10946571afea5cbb26e75bae6aefa8debac9aea",
};

function runtimeRows(text) {
  const lines = plain(text).split("\n");
  const retained = [];
  const rows = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^ {2}(Total runs|Successful runs|Last completed|Last duration)(?:\s+(.*))?$/.exec(lines[index]);
    if (!match) { retained.push(lines[index]); continue; }
    const parts = [match[2] || ""];
    const preceding = lines.slice(0, index).findLast((line) => /^ {2}\S/.test(line));
    while (index + 1 < lines.length && /^ {4}\s*\S/.test(lines[index + 1])) parts.push(lines[++index].trim());
    rows.push({ label: match[1], value: parts.join(" ").trim(), preceding });
  }
  assert.deepEqual(rows.map(({ label }) => label), LABELS, "exactly the four approved rows, once each and in order");
  return { retained: retained.join("\n"), rows, values: Object.fromEntries(rows.map(({ label, value }) => [label, value])) };
}

for (const detail of [false, true]) {
  for (const columns of [96, 80, 56, 40]) {
    test(`only the four runtime rows change ${detail ? "detailed" : "default"} status at ${columns} columns`, () => {
      const joined = STATUS_SCREEN_SCENARIOS.map((name) => {
        const report = statusScreenFixture(name, { detail });
        const output = renderStatusText(report, { columns, stream });
        const { retained, rows } = runtimeRows(output);
        const preceding = detail && ["waiting", "syncing"].includes(report.activity.state) ? "Phase observed" : "Current work";
        assert.ok(rows[0].preceding?.startsWith(`  ${preceding}`), `${name}: runtime rows follow ${preceding}`);
        assert.doesNotMatch(output, /\u001b\[/, "NO_COLOR output must not contain styles");
        assert.doesNotMatch(output, new RegExp(STATUS_SCREEN_PRIVATE));
        for (const line of output.split("\n")) assert.ok(statusWidth(line) <= columns, `${name}: overflow at ${columns} columns`);
        return `${name}\n${retained}`;
      }).join("\n---\n");
      assert.equal(hash(joined), BASELINE_TEXT[`${detail ? "detail" : "default"}:${columns}`], "all other text must match the fixed baseline byte for byte");
    });
  }
  test(`runtime_stats is the sole public JSON addition (${detail ? "detail" : "default"})`, () => {
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
  const output = renderStatusText(report, { columns, stream });
  assert.doesNotMatch(`${JSON.stringify(report)}\n${output}`, new RegExp(`${PRIVATE}|${DATABASE_KEY}|${OTHER_DATABASE_KEY}|${STATUS_SCREEN_PRIVATE}`));
  return runtimeRows(output).values;
}

test("bound runtime facts survive public projection and render independently of success spacing", () => {
  for (const detail of [false, true]) for (const columns of [96, 80, 56, 40]) {
    const fixture = collectedFixture();
    const report = project(fixture, detail);
    assert.deepEqual(report.runtime_stats, { scope: "current_worker_retained_log", state: "available",
      total_runs: 2, successful_runs: 1, last_completed_at: iso(-5000), last_duration_ms: REQUIRED_CYCLE_STEPS.length * 1000, reason: null });
    const rows = renderStats(report, columns);
    assert.match(rows["Total runs"], /^2 completed rounds.*current worker \/ retained log$/);
    assert.equal(rows["Successful runs"], "1");
    assert.match(rows["Last completed"], /11:59:55.*5s ago/);
    assert.equal(rows["Last duration"], `${REQUIRED_CYCLE_STEPS.length}s`);
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

test("a bound empty retained log is zero completed runs with no invented time or duration", () => {
  const fixture = collectedFixture();
  fixture.report.worker.log.events = [];
  const report = project(fixture);
  assert.deepEqual(report.runtime_stats, { scope: "current_worker_retained_log", state: "available", total_runs: 0,
    successful_runs: 0, last_completed_at: null, last_duration_ms: null, reason: null });
  const rows = renderStats(report, 40);
  assert.match(rows["Total runs"], /^0 completed rounds/);
  assert.equal(rows["Successful runs"], "0");
  assert.equal(rows["Last completed"], "None recorded");
  assert.equal(rows["Last duration"], "None recorded");
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
    const report = project(fixture);
    assert.equal(report.runtime_stats.state, "unavailable");
    assert.ok(["worker_unverified", "log_unavailable", "log_damaged", "completion_unbound", "completion_invalid", "completion_conflict"].includes(report.runtime_stats.reason));
    for (const key of ["total_runs", "successful_runs", "last_completed_at", "last_duration_ms"]) assert.equal(report.runtime_stats[key], null, key);
    for (const value of Object.values(renderStats(report, 40))) assert.match(value, /^Unavailable/);
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
  assert.match(renderStats(report)["Last duration"], /^Unavailable/);
});

test("last duration includes completion bookkeeping after the last finished step", () => {
  const fixture = collectedFixture();
  fixture.final.at = iso(-3000);
  const report = project(fixture);
  assert.equal(report.runtime_stats.last_completed_at, iso(-3000));
  assert.equal(report.runtime_stats.last_duration_ms, REQUIRED_CYCLE_STEPS.length * 1000 + 2000);
  const rows = renderStats(report);
  assert.match(rows["Last completed"], /11:59:57.*3s ago/);
  assert.equal(rows["Last duration"], `${REQUIRED_CYCLE_STEPS.length + 2}s`);
});
