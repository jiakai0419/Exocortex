import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, runCycle, runWorker, writeLog } from "../src/runtime/worker/worker.mjs";
import { createActivityWriter, validateActivityEventShape } from "../src/diagnostics/lark-im-activity-evidence.mjs";
import { collectStatusEvidence, serviceTargetEvidence, waitWorkerSummary } from "../src/diagnostics/status-report.mjs";
import { summarizeRuntimeStats } from "../src/diagnostics/status-runtime-stats.mjs";
import { collectCheckReport } from "../src/diagnostics/check-report.mjs";
import { summarizeWorkerEvents, cyclePayload } from "../dist/runtime/worker/lark-im-worker-core.js";
import { evaluateWaitState } from "../src/diagnostics/service-wait-state.mjs";
import { sync } from "./helpers/check-fixture.mjs";

const START = Date.parse("2034-05-06T07:08:09.000Z");
const clone = value => structuredClone(value);
const quiet = { stdout: { write() {} } };

function fixtures(t, start = START) {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-worker-binding-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbA = join(dir, "alpha.sqlite"); const dbB = join(dir, "beta.sqlite");
  writeFileSync(dbA, "invented alpha file identity"); writeFileSync(dbB, "invented beta file identity");
  function worker(db, instance, success = true, retention = false, beforeChild = () => {}, processStartedAtMs = start - 60000) {
    const logDir = join(dir, instance); let clock = start; let captured;
    const opts = { ...parseArgs(["--max-cycles", "2", "--retention-every-cycles", retention ? "1" : "999"]), db, logDir };
    const activity = createActivityWriter({ db, role: "worker", pid: 4321, instanceId: instance, now: () => ++clock,
      inspect: () => new Map([[4321, { state: "alive", started_at_ms: processStartedAtMs }]]),
      emit: event => writeLog(opts, event, quiet) });
    const stop = new Error("synthetic stop after first waiting phase");
    assert.throws(() => runWorker(opts, { activity, nowMs: () => ++clock,
      runCycle: (options, cycle, deps) => runCycle(options, cycle, { ...deps, writeLog: quiet,
        runStep: { runProcess: () => { beforeChild(); return { status: success ? 0 : 1, stdout: JSON.stringify({ ok: success }), stderr: "" }; } } }),
      sleepSeconds: () => {
        captured = readFileSync(join(logDir, "worker.jsonl"), "utf8").trim().split("\n").map(JSON.parse); throw stop;
      } }), error => error === stop);
    return captured;
  }
  return { worker, dbA, dbB, dir, start };
}
function evidence(events, currentEvents = events) {
  const activity = currentEvents.findLast(event => event.type === "lark_im_worker_activity" && event.phase === "waiting");
  const now = START + 1000;
  const report = { probe: { status: "running", pid: activity.pid }, worker: { log: { events }, summary: summarizeWorkerEvents(events, now) },
    activity_evidence: { events: [activity], database_key: activity.database_key, database_identity_stable: true, integrity: true,
      processes: new Map([[activity.pid, { state: "alive", started_at_ms: activity.process_started_at_ms }]]) } };
  const binding = serviceTargetEvidence(report, now);
  const summary = waitWorkerSummary(report, binding);
  const state = evaluateWaitState(START, sync(), summary, { status: "running", target_match: binding.target_match });
  return { report, binding, summary, state };
}
const completed = events => events.filter(event => ["lark_im_worker_step", "lark_im_worker_cycle"].includes(event.type));

for (const retention of [false, true]) test(`a real single-instance cycle is complete with retention=${retention}`, t => {
  const f = fixtures(t); const events = f.worker(f.dbA, "alpha", true, retention);
  const result = evidence(events); assert.equal(result.state.ready, true);
  const worker = result.binding.worker;
  const work = completed(events);
  for (const event of work) {
    assert.equal(event.version, 1); assert.equal(event.instance_id, worker.instance_id); assert.equal(event.database_key, worker.database_key);
  }
  assert.deepEqual(work.filter(event => event.type === "lark_im_worker_step").map(event => event.step_index), retention ? [0, 1, 2, 3, 4, 5, 6, 7] : [0, 1, 2, 3, 4, 5, 6]);
});
for (const sameDb of [false, true]) for (const includeFailedCurrent of [false, true]) {
  test(`foreign same-number success cannot satisfy current waiting: sameDb=${sameDb}, currentFailure=${includeFailedCurrent}`, t => {
    const f = fixtures(t); const current = f.worker(f.dbA, "current", false); const other = f.worker(sameDb ? f.dbA : f.dbB, "other");
    const events = [...(includeFailedCurrent ? completed(current) : []), ...completed(other)];
    const result = evidence(events, current);
    assert.equal(result.state.ready, false); assert.notEqual(result.summary.last_cycle?.complete, true);
  });
}
test("interleaved successes remain attributable to each database and instance", t => {
  const f = fixtures(t); const a = f.worker(f.dbA, "alpha"); const b = f.worker(f.dbB, "beta");
  const rowsA = completed(a); const rowsB = completed(b);
  const events = rowsA.flatMap((event, i) => [event, rowsB[i]]);
  assert.equal(evidence(events, a).state.ready, true); assert.equal(evidence(events, b).state.ready, true);
});

const mutations = {
  "legacy unbound events": rows => rows.forEach(event => { delete event.version; delete event.instance_id; delete event.database_key; delete event.step_index; }),
  "missing cycle instance": rows => { delete rows.at(-1).instance_id; },
  "missing step database": rows => { delete rows[0].database_key; },
  "wrong cycle schema": rows => { rows.at(-1).version = 2; },
  "wrong step schema": rows => { rows[0].version = "1"; },
  "mixed database steps": rows => { rows[0].database_key = "b".repeat(64); },
  "mixed instance steps": rows => { rows[0].instance_id = "other"; },
  "duplicate step replacing a missing step": rows => { rows[1] = clone(rows[0]); },
  "missing first step": rows => { rows.shift(); },
  "missing cycle": rows => { rows.pop(); },
  "step after completion": rows => { rows.push(clone(rows[0])); },
  "duplicate cycle": rows => { rows.push(clone(rows.at(-1))); },
  "failed cycle": rows => { rows.at(-1).ok = false; },
  "failed step": rows => { rows[0].ok = false; },
  "nonempty failed steps": rows => { rows.at(-1).failed_steps = ["sent"]; },
  "cycle count string": rows => { rows.at(-1).step_count = String(rows.at(-1).step_count); },
  "cycle number string": rows => { rows.at(-1).cycle = String(rows.at(-1).cycle); },
  "unknown step name": rows => { rows[0].name = "invented-other"; },
  "nonzero exit despite true ok": rows => { rows[0].exit_code = 2; },
  "missing exit despite true ok": rows => { delete rows[0].exit_code; },
  "missing step index": rows => { delete rows[0].step_index; },
  "string step index": rows => { rows[0].step_index = "0"; },
  "missing failed steps": rows => { delete rows.at(-1).failed_steps; },
  "same-instance success and failure": rows => { rows.unshift({ ...rows.at(-1), ok: false }); },
};
for (const [name, mutate] of Object.entries(mutations)) test(`insufficient cycle evidence stays negative: ${name}`, t => {
  const f = fixtures(t); const events = f.worker(f.dbA, "alpha"); const rows = completed(clone(events)); mutate(rows);
  const result = evidence(rows, events); assert.notEqual(result.summary.last_cycle?.complete, true); assert.equal(result.state.ready, false);
});
for (const invalid of ["false", "true", 1, {}, null, undefined]) for (const target of ["cycle", "step"]) {
  test(`${target} success must be boolean true: ${JSON.stringify(invalid)}`, t => {
    const f = fixtures(t); const events = f.worker(f.dbA, "alpha"); const rows = completed(clone(events));
    (target === "cycle" ? rows.at(-1) : rows[0]).ok = invalid;
    const result = evidence(rows, events); assert.equal(result.state.ready, false); assert.notEqual(result.summary.last_cycle?.complete, true);
    const summary = summarizeWorkerEvents([target === "cycle" ? rows.at(-1) : rows[0]], START + 1000);
    assert.equal((target === "cycle" ? summary.last_cycle : summary.last_step).ok, false);
  });
}
test("cycle producer does not coerce malformed step success", () => {
  for (const ok of ["false", "true", 1, {}, null, undefined]) {
    const payload = cyclePayload(1, [{ name: "sent", ok }], () => new Date(START).toISOString());
    assert.equal(payload.ok, false); assert.deepEqual(payload.failed_steps, ["sent"]);
  }
});

for (const partial of [true, "true", "false", 0, 1, null, {}]) test(`partial flag cannot be a malformed or active success: ${JSON.stringify(partial)}`, t => {
  const f = fixtures(t); const events = f.worker(f.dbA, "alpha"); const rows = completed(clone(events)); rows[0].partial = partial;
  const result = evidence(rows, events); assert.equal(result.state.ready, false); assert.equal(result.summary.last_cycle.complete, false);
});
test("explicit false partial preserves a complete cycle", t => {
  const f = fixtures(t); const events = f.worker(f.dbA, "alpha"); const rows = completed(clone(events)); rows[0].partial = false;
  assert.equal(evidence(rows, events).state.ready, true);
});
test("two active worker instances sharing one PID are ambiguous", t => {
  const f = fixtures(t); const a = f.worker(f.dbA, "alpha"); const b = f.worker(f.dbA, "beta");
  const { report } = evidence(a);
  report.activity_evidence.events.push(b.findLast(event => event.phase === "waiting"));
  assert.equal(serviceTargetEvidence(report, START + 1000).target_match, "unknown");
});
test("PID reuse cannot attach a prior worker's complete cycle to a new process", t => {
  const f = fixtures(t); const events = f.worker(f.dbA, "alpha"); const { report } = evidence(events);
  report.activity_evidence.processes.get(4321).started_at_ms = START - 10000;
  const binding = serviceTargetEvidence(report, START + 1000);
  assert.equal(binding.target_match, "unknown"); assert.equal(waitWorkerSummary(report, binding).last_cycle, null);
});
test("foreign failed or unfinished events cannot replace the selected worker's successful summary", t => {
  const f = fixtures(t); const a = f.worker(f.dbA, "alpha"); const b = f.worker(f.dbB, "beta", false);
  const rowsA = completed(a); const rowsB = completed(b);
  for (const foreign of [rowsB, rowsB.slice(0, -1)]) {
    const result = evidence([...rowsA, ...foreign], a); assert.equal(result.state.ready, true);
    assert.equal(result.summary.last_cycle.ok, true); assert.equal(result.summary.last_cycle.at, rowsA.at(-1).at);
    assert.equal(result.summary.unfinished_cycle, false);
  }
});
test("a database replaced during a real cycle cannot inherit completed steps from its predecessor", t => {
  const f = fixtures(t); let calls = 0;
  const events = f.worker(f.dbA, "alpha", true, false, () => {
    if (++calls === 2) { writeFileSync(`${f.dbA}.replacement`, "invented replacement identity"); renameSync(`${f.dbA}.replacement`, f.dbA); }
  });
  const work = completed(events); assert.equal(typeof work[0].database_key, "string");
  assert.equal(work.at(-1).database_key, null);
  const result = evidence(events); assert.equal(result.binding.target_match, "matched"); assert.equal(result.state.ready, false);
});

async function collectServiceBinding(fixture, events, processObservation = { state: "alive", started_at_ms: fixture.start - 60000 }) {
  writeFileSync(join(fixture.dir, "worker.jsonl"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
  let now = fixture.start + 1000;
  const context = { root: fixture.dir, cwd: fixture.dir, env: {}, provided: new Set(["--wait"]), startedAtMs: fixture.start, now: () => now };
  const options = { db: fixture.dbA, logDir: fixture.dir, wait: true, timeoutSeconds: 1, pollSeconds: 1 };
  const collected = collectStatusEvidence(options, context, { readInstalledServiceConfig: () => ({ status: "installed" }), reportDeps: {
    runCommand: () => ({ status: 0, stdout: "state = running\npid = 4321\n", stderr: "" }), buildStatus: () => sync(),
    readLiveProbeCache: () => null, liveProbeContext: () => null, sqliteJson: () => [],
    inspectActivityProcesses: pids => new Map(processObservation === null ? [] : pids.map(pid => [pid, processObservation])),
  } });
  const result = await collectCheckReport(options, context, { checkDependencies: () => ({ sqlite: true, python: true, live: true, wait: true }),
    collectStatusEvidence: () => collected, sleep: async ms => { now += ms; }, readDatabaseEvidence: () => ({ ok: true, quick_check: "ok" }),
    buildStatus: () => sync(), collectQualityReport: () => ({ quality: {} }),
  });
  return { result, collected };
}

for (const [target, select, field] of [
  ["completion", rows => rows.findLast(event => event.type === "lark_im_worker_cycle"), "at"],
  ["step start", rows => rows.find(event => event.type === "lark_im_worker_step"), "started_at"],
  ["step finish", rows => rows.find(event => event.type === "lark_im_worker_step"), "finished_at"],
]) for (const [damage, change] of [
  ["nonexistent calendar date", value => value.replace("2037-03-02", "2037-02-30")],
  ["missing timezone", value => value.slice(0, -1)],
  ["numeric timestamp", value => Date.parse(value)],
]) test(`real JSONL collector rejects ${damage} in ${target} for wait`, async t => {
  const f = fixtures(t, Date.parse("2037-03-02T00:00:00.000Z"));
  const events = f.worker(f.dbA, "calendar-worker");
  const row = select(events); const original = row[field]; row[field] = change(original);
  if (damage === "nonexistent calendar date") assert.equal(Date.parse(row[field]), Date.parse(original),
    "the counterexample must normalize to the same otherwise-valid instant");
  const { result, collected } = await collectServiceBinding(f, events);
  assert.equal(collected.binding.target_match, "matched", "current worker identity remains verified");
  assert.equal(collected.report.worker.log.activity_integrity, true, "the real reader preserves structurally valid history");
  assert.equal(collected.workerSummary.last_cycle.complete, false);
  assert.equal(result.checks.wait.status, "incomplete"); assert.equal(result.exit_code, 2);
  const stats = summarizeRuntimeStats(collected.report, collected.binding, f.start + 1000);
  if (target === "completion") {
    assert.equal(stats.state, "unavailable"); assert.equal(stats.reason, "completion_invalid");
  } else {
    assert.equal(stats.state, "available"); assert.equal(stats.total_runs, 1);
    assert.equal(stats.successful_runs, 1); assert.equal(stats.last_duration_ms, null);
  }
});

for (const [zone, offset] of [["Z", 0], ["+08:00", 8], ["-04:00", -4]]) {
  test(`real JSONL collector accepts equivalent ${zone} worker timestamps for wait and stats`, async t => {
    const f = fixtures(t, Date.parse("2037-03-02T00:00:00.000Z"));
    const events = f.worker(f.dbA, "calendar-worker");
    const rows = completed(events);
    const start = Date.parse(rows[0].started_at); const end = Date.parse(rows.at(-1).at);
    for (const row of rows) for (const field of ["at", "started_at", "finished_at"]) {
      if (row[field]) row[field] = new Date(Date.parse(row[field]) + offset * 3_600_000).toISOString().replace("Z", zone);
    }
    const { result, collected } = await collectServiceBinding(f, events);
    assert.equal(collected.binding.target_match, "matched"); assert.equal(collected.workerSummary.last_cycle.complete, true);
    assert.equal(result.checks.wait.status, "passed"); assert.equal(result.exit_code, 0);
    assert.deepEqual(summarizeRuntimeStats(collected.report, collected.binding, f.start + 1000), {
      scope: "current_worker_retained_log", state: "available", total_runs: 1, successful_runs: 1,
      last_completed_at: new Date(end).toISOString(), last_duration_ms: end - start, reason: null,
    });
  });
}

for (const [name, expected, change] of [
  ["unique target", true, (_a, _b) => []],
  ["cross-database active conflict", false, (_a, b) => [b]],
  ["same-database active conflict", false, (a, b) => [{ ...b, database_key: a.database_key }]],
  ["unknown foreign process start", false, (_a, b) => [{ ...b, process_started_at_ms: null }]],
  ["expired foreign phase cannot refute identity", false, (_a, b) => [{ ...b, updated_at: new Date(START - 5000).toISOString(), valid_until: new Date(START - 1000).toISOString() }]],
  ["different foreign PID", true, (_a, b) => [{ ...b, pid: 4322 }]],
  ["known prior process start", true, (_a, b) => [{ ...b, process_started_at_ms: START - 120000 }]],
  ["explicit stopped foreign instance", true, (_a, b) => [{ ...b, phase: "stopped" }]],
  ["same instance latest moved to foreign database", false, (a, b) => [{ ...b, instance_id: a.instance_id }]],
  ["same instance latest returned to target by append order", true, (a, b) => [{ ...b, instance_id: a.instance_id, updated_at: new Date(START + 500).toISOString() }, a]],
  ["same instance latest stopped", false, (a, _b) => [{ ...a, phase: "stopped" }]],
  ["same PID damaged latest instance", false, (a, b) => [{ ...b, instance_id: a.instance_id, version: "1" }]],
  ["many other database PIDs do not consume service binding budget", true, (_a, b) => Array.from({ length: 40 }, (_, index) => ({ ...b, pid: 5000 + index, instance_id: `foreign-${index}` }))],
  ["many known prior starts do not hide the current instance", true, (_a, b) => Array.from({ length: 40 }, (_, index) => ({ ...b, process_started_at_ms: START - 120000 - index * 1000, instance_id: `prior-${index}` }))],
]) test(`complete collector and check wait: ${name}`, async t => {
  const f = fixtures(t); const a = f.worker(f.dbA, "alpha"); const b = f.worker(f.dbB, "beta");
  const target = a.findLast(event => event.phase === "waiting"); const foreign = b.findLast(event => event.phase === "waiting");
  const events = [...completed(a), target, ...completed(b), ...change(target, foreign)];
  const { result, collected } = await collectServiceBinding(f, events);
  assert.equal(collected.binding.target_match === "matched", expected);
  assert.equal(result.checks.wait.status === "passed", expected, JSON.stringify(result.checks.wait));
  assert.equal(result.exit_code, expected ? 0 : 2);
  assert.equal(collected.report.activity_evidence.truncated, false, "foreign databases must not consume the global activity instance budget");
  if (name === "same PID damaged latest instance") assert.equal(collected.report.activity_evidence.integrity, false);
  else assert.equal(collected.report.activity_evidence.events.some(event => event.database_key === foreign.database_key), false,
    "the global activity classifier retains its original selected-database scope");
});

const PROCESS_START = START - 60000;
const PRIOR_PROCESS_START = START - 120000;
const waiting = events => events.findLast(event => event.phase === "waiting");

for (const database of ["target", "foreign", "unavailable"]) {
  for (const [identity, processStart] of [["different", PRIOR_PROCESS_START], ["same", PROCESS_START], ["unknown", null]]) {
    for (const [observation, observed] of [["known", { state: "alive", started_at_ms: PROCESS_START }], ["missing", null],
      ["unknown-start", { state: "alive", started_at_ms: null }], ["unknown-state", { state: "unknown", started_at_ms: PROCESS_START }]]) {
      test(`instance evidence priority: database=${database}, instance start=${identity}, OS=${observation}`, async t => {
        const f = fixtures(t); const a = f.worker(f.dbA, "current"); const b = f.worker(f.dbB, "prior");
        const prior = { ...waiting(b), process_started_at_ms: processStart,
          database_key: database === "unavailable" ? null : waiting(database === "target" ? a : b).database_key };
        assert.equal(validateActivityEventShape(prior), true, "null identity is unavailable evidence, not damaged structure");
        const expected = identity === "different" && observation === "known";
        const { result, collected } = await collectServiceBinding(f, [...completed(a), waiting(a), prior], observed);
        assert.equal(collected.binding.target_match, expected ? "matched" : "unknown");
        assert.equal(result.checks.wait.status, expected ? "passed" : "incomplete");
        assert.equal(result.exit_code, expected ? 0 : 2);
        assert.equal(collected.report.activity_evidence.integrity, true);
        assert.equal(collected.report.activity_evidence.service_worker_events.length, 2, "both append-latest instances must reach the selector");
        if (expected) assert.equal(collected.binding.worker.instance_id, "current");
      });
    }
  }
}

for (const [damage, mutate] of [
  ["wrong version", event => { event.version = "1"; }],
  ["missing database key", event => { delete event.database_key; }],
  ["missing parent field", event => { delete event.parent_instance; }],
  ["invalid phase", event => { event.phase = "invented-invalid-phase"; }],
  ["invalid interval", event => { event.valid_until = event.updated_at; }],
]) test(`different process start cannot excuse malformed evidence: ${damage}`, async t => {
  const f = fixtures(t); const a = f.worker(f.dbA, "current"); const b = f.worker(f.dbB, "prior");
  const prior = { ...waiting(b), process_started_at_ms: PRIOR_PROCESS_START, database_key: null }; mutate(prior);
  assert.equal(validateActivityEventShape(prior), false);
  const { result, collected } = await collectServiceBinding(f, [...completed(a), waiting(a), prior]);
  assert.equal(collected.report.activity_evidence.integrity, false);
  assert.equal(collected.binding.target_match, "unknown"); assert.equal(result.checks.wait.status, "incomplete"); assert.equal(result.exit_code, 2);
});

for (const database of ["target", "foreign", "unavailable"]) test(`a known prior process cannot be revived by expired ${database} database evidence`, async t => {
  const f = fixtures(t); const a = f.worker(f.dbA, "current"); const b = f.worker(f.dbB, "prior");
  const prior = { ...waiting(b), process_started_at_ms: PRIOR_PROCESS_START,
    database_key: database === "unavailable" ? null : waiting(database === "target" ? a : b).database_key,
    updated_at: new Date(START - 5000).toISOString(), valid_until: new Date(START - 1000).toISOString() };
  assert.equal(validateActivityEventShape(prior), true);
  const { result, collected } = await collectServiceBinding(f, [...completed(a), waiting(a), prior]);
  assert.equal(collected.binding.target_match, "matched"); assert.equal(collected.binding.worker.instance_id, "current");
  assert.equal(result.checks.wait.status, "passed"); assert.equal(result.exit_code, 0);
});

test("another PID with legal null database identity does not change the service instance binding", async t => {
  const f = fixtures(t); const a = f.worker(f.dbA, "current"); const b = f.worker(f.dbB, "unrelated");
  const unrelated = { ...waiting(b), pid: 9876, database_key: null };
  assert.equal(validateActivityEventShape(unrelated), true);
  const { result, collected } = await collectServiceBinding(f, [...completed(a), waiting(a), unrelated]);
  assert.equal(collected.report.activity_evidence.service_worker_events.length, 1);
  assert.equal(collected.binding.target_match, "matched"); assert.equal(result.checks.wait.status, "passed"); assert.equal(result.exit_code, 0);
});

test("a real worker before database initialization cannot block a later process's complete cycle", async t => {
  const f = fixtures(t); rmSync(f.dbA);
  const old = f.worker(f.dbA, "before-initialization", true, false, () => {}, PRIOR_PROCESS_START);
  const oldActivity = old.filter(event => event.type === "lark_im_worker_activity");
  assert.ok(oldActivity.length > 0); assert.ok(oldActivity.every(event => validateActivityEventShape(event) && event.database_key === null));
  assert.equal(waiting(old).process_started_at_ms, PRIOR_PROCESS_START);
  writeFileSync(f.dbA, "new fully synthetic database identity");
  const current = f.worker(f.dbA, "after-initialization");
  assert.equal(typeof waiting(current).database_key, "string");
  const { result, collected } = await collectServiceBinding(f, [...old, ...current]);
  assert.equal(collected.report.activity_evidence.integrity, true);
  assert.equal(collected.report.activity_evidence.service_worker_events.length, 2);
  assert.equal(collected.binding.target_match, "matched"); assert.equal(collected.binding.worker.instance_id, "after-initialization");
  assert.equal(result.checks.wait.status, "passed"); assert.equal(result.exit_code, 0);
});
