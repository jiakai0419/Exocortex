import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { activityDatabaseKey, collectActivityAncestors, verifyActivityAncestry } from "../src/diagnostics/lark-im-activity-evidence.mjs";
import { buildServiceStatusReport } from "../src/diagnostics/lark-im-service-report.mjs";

const now = Date.parse("2033-06-07T08:09:10Z");
const iso = (at) => new Date(at).toISOString();
const [worker, guardian, anchor, child] = [7100, 7200, 7300, 7400];
const row = (ppid, ago) => ({ state: "alive", ppid, started_at_ms: now - ago });
function topology() {
  return new Map([[worker, row(1, 60000)], [guardian, row(worker, 30000)],
    [anchor, row(guardian, 20000)], [child, row(anchor, 10000)]]);
}
function events() {
  const base = { type: "lark_im_worker_activity", version: 1, database_key: "b".repeat(64),
    updated_at: iso(now - 2000), valid_until: iso(now + 20000), cycle: 2, step: "sent" };
  return [{ ...base, pid: worker, instance_id: "synthetic-worker", parent_instance: null,
    role: "worker", phase: "step", process_started_at_ms: now - 60000 },
  { ...base, pid: child, instance_id: "synthetic-child", parent_instance: "synthetic-worker",
    role: "sync", phase: "sync", process_started_at_ms: now - 10000 }];
}
function fixture(t, change = () => {}, observe = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-ancestry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "invented.sqlite"); writeFileSync(db, "invented file identity only");
  const state = { rows: topology(), events: events(), clock: now };
  state.events.forEach((event) => { event.database_key = activityDatabaseKey(db); });
  change(state);
  writeFileSync(join(dir, "worker.jsonl"), state.events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const queries = [];
  const report = buildServiceStatusReport({ label: "synthetic", target: "test/synthetic", db, logDir: dir }, {
    clock: () => state.clock,
    runCommand: () => ({ status: 0, stdout: `state = running\npid = ${worker}\n`, stderr: "" }),
    buildStatus: () => ({ health: "syncing", locks: [] }),
    readLiveProbeCache: () => null, liveProbeContext: () => null, sqliteJson: () => [],
    inspectActivityProcesses: (pids) => {
      queries.push([...pids]); observe(state, queries.length, pids);
      return new Map(pids.map((pid) => [pid, state.rows.has(pid) ? { ...state.rows.get(pid) } : { state: "unknown", started_at_ms: null }]));
    },
  });
  return { report, queries };
}

for (const direct of [true, false]) test(`${direct ? "direct" : "guardian"} child retains worker activity and health through real JSONL collection`, (t) => {
  const { report, queries } = fixture(t, ({ rows }) => { if (direct) rows.get(child).ppid = worker; });
  assert.equal(report.overview.activity.state, "syncing");
  assert.equal(report.overview.activity.source, "worker");
  assert.equal(report.overview.health.status, "ok");
  assert.equal(queries.length, direct ? 1 : 4);
  if (!direct) assert.deepEqual(new Set(queries.at(-1)), new Set([child, anchor, guardian, worker]));
});

for (const [name, change] of [
  ["missing parent instance", ({ events }) => { events[1].parent_instance = null; }],
  ["wrong parent instance", ({ events }) => { events[1].parent_instance = "unrelated-worker"; }],
  ["worker bound to another database", ({ events }) => { events[0].database_key = "c".repeat(64); }],
  ["worker waiting with a child", ({ events }) => { events[0].phase = "waiting"; }],
  ["claimed instance on an unrelated OS chain", ({ rows }) => { rows.get(guardian).ppid = 1; }],
  ["missing anchor", ({ rows }) => { rows.delete(anchor); }],
  ["exited guardian", ({ rows }) => { rows.get(guardian).state = "dead"; }],
  ["paused guardian", ({ rows }) => { rows.get(guardian).state = "unknown"; }],
  ["missing intermediate start", ({ rows }) => { rows.get(guardian).started_at_ms = null; }],
  ["missing child start identity", ({ events }) => { events[1].process_started_at_ms = null; }],
  ["parent newer than child", ({ rows }) => { rows.get(guardian).started_at_ms = now - 5000; }],
  ["sampling inside child start bucket", ({ events, rows }) => { rows.get(child).started_at_ms = now; events[1].process_started_at_ms = now; events[1].updated_at = iso(now); }],
  ["cycle", ({ rows }) => { rows.get(guardian).ppid = anchor; }],
  ["self parent", ({ rows }) => { rows.get(anchor).ppid = anchor; }],
  ["more than three worker edges", ({ rows }) => { rows.set(7500, row(worker, 40000)); rows.get(guardian).ppid = 7500; }],
]) test(`${name} cannot authenticate a worker child`, (t) => {
  const { report, queries } = fixture(t, change);
  assert.equal(report.overview.activity.state, "unknown");
  assert.equal(report.overview.health.status, "problem");
  assert.ok(queries.length <= 4);
  assert.ok(queries.every((pids) => pids.length <= 32));
});

for (const pid of [worker, guardian, anchor, child]) {
  for (const mutation of ["reuse", "reparent", "exit", "denied"]) test(`whole-path recheck rejects ${mutation} of node ${pid}`, (t) => {
    const { report } = fixture(t, () => {}, ({ rows }, call) => {
      if (call !== 4) return;
      if (mutation === "reuse") rows.get(pid).started_at_ms += 1000;
      if (mutation === "reparent") rows.get(pid).ppid = 9990;
      if (mutation === "exit") rows.get(pid).state = "dead";
      if (mutation === "denied") rows.set(pid, { state: "unknown", started_at_ms: null });
    });
    assert.equal(report.overview.activity.state, "unknown");
  });
}
test("permissions failure cannot convert an undeclared child into independent foreground", (t) => {
  const { report } = fixture(t, ({ events, rows }) => { events[1].parent_instance = null; rows.delete(anchor); });
  assert.equal(report.overview.activity.state, "unknown");
  assert.equal(report.overview.activity.reason, "foreground_parent_unavailable");
});
test("a complete independent chain to PID 1 still proves foreground activity", (t) => {
  const { report } = fixture(t, ({ events, rows }) => {
    events[0].phase = "waiting"; events[1].parent_instance = null; rows.get(guardian).ppid = 1;
  });
  assert.equal(report.overview.activity.state, "syncing");
  assert.equal(report.overview.activity.source, "foreground");
});
test("a slow ancestry sample never extends the worker phase deadline", (t) => {
  const { report } = fixture(t, () => {}, (state, call) => { if (call === 4) state.clock += 30000; });
  assert.equal(report.overview.activity.state, "unknown");
});
test("a child's initial start-bucket phase does not suppress its verified current worker", (t) => {
  const { report } = fixture(t, ({ events }) => { events[1].updated_at = iso(now - 9500); });
  assert.equal(report.overview.activity.state, "syncing");
  assert.equal(report.overview.activity.source, "worker");
});
test("an expired child phase can classify ownership but cannot replace the worker phase", (t) => {
  const { report } = fixture(t, ({ events }) => { events[1].valid_until = iso(now - 1000); });
  assert.equal(report.overview.activity.state, "syncing");
  assert.equal(report.overview.activity.source, "worker");
  const expired = fixture(t, ({ events }) => { events[0].valid_until = iso(now - 1000); events[1].valid_until = iso(now - 1000); });
  assert.equal(expired.report.overview.activity.state, "unknown");
});
test("an unchanged initial child phase becomes usable for ownership after its start bucket", (t) => {
  for (const [age, expected] of [[500, "unknown"], [1500, "syncing"]]) {
    const { report } = fixture(t, (state) => {
      state.clock = now - 10000 + age;
      state.events[0].updated_at = iso(now - 12000);
      state.events[1].updated_at = iso(now - 9900);
    });
    assert.equal(report.overview.activity.state, expected);
    if (expected === "syncing") assert.equal(report.overview.activity.source, "worker");
  }
});
test("process budget exhaustion never establishes ancestry or independence", () => {
  const rows = topology(), input = events();
  const initial = new Map([[worker, rows.get(worker)], [child, rows.get(child)]]);
  for (let n = 0; n < 30; n++) initial.set(8000 + n, row(1, 60000));
  const calls = [];
  const result = collectActivityAncestors(input, input, initial, (pids) => {
    calls.push(pids); return new Map(pids.map((pid) => [pid, rows.get(pid)]));
  }, now);
  assert.ok(result.processes.size <= 32);
  assert.ok(new Set([...initial.keys(), ...calls.flat()]).size <= 32);
  assert.equal(verifyActivityAncestry(input[1], result.ancestry.get(child), result.processes), false);
  assert.ok(calls.length <= 1);
});
test("structurally forged paths do not bypass edge and start checks", () => {
  const rows = topology(), input = events();
  for (const pids of [null, [], [child, worker], [child, anchor, anchor, worker], [child, anchor, guardian, 7500, worker]]) {
    assert.equal(verifyActivityAncestry(input[1], { complete: true, stable: true, pids, worker }, rows), false);
  }
});
