import assert from "node:assert/strict";
import test from "node:test";
import { cyclePayload, REQUIRED_CYCLE_STEPS } from "../dist/runtime/worker/lark-im-worker-core.js";
import { evaluateActivityEvent } from "../src/diagnostics/lark-im-activity-evidence.mjs";
import { summarizeRuntimeStats } from "../src/diagnostics/status-runtime-stats.mjs";

// Pure invented in-memory evidence: no log, process, database or API is read.
const NOW = Date.parse("2034-06-08T12:00:00.000Z");
const START = NOW - 2 * 86_400_000;
const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
const INSTANCE = "invented-current-worker";
const PRIVATE = "SYNTHETIC_PRIVATE_RUNTIME_DATA";
const iso = (value) => new Date(value).toISOString();
const bind = (event) => ({ ...event, version: 1, instance_id: INSTANCE, database_key: KEY, private: PRIVATE });

function round(cycle = 1, { start = NOW - 10_000, failed = [], retention = false, history = false } = {}) {
  const names = [...REQUIRED_CYCLE_STEPS, ...(retention ? ["retention"] : []), ...(history ? ["history"] : [])];
  const steps = names.map((name, index) => bind({ type: "lark_im_worker_step", cycle, step_index: index, name,
    ok: !failed.includes(name), exit_code: failed.includes(name) ? 2 : 0,
    started_at: iso(start + index * 100), finished_at: iso(start + index * 100 + 80), stderr: PRIVATE }));
  return [...steps, bind(cyclePayload(cycle, steps, () => iso(start + names.length * 100)))];
}

function fixture(events = round()) {
  const worker = { type: "lark_im_worker_activity", version: 1, role: "worker", instance_id: INSTANCE,
    parent_instance: null, pid: 7101, process_started_at_ms: START, database_key: KEY,
    phase: "waiting", cycle: 10, step: null, updated_at: iso(NOW - 1000), valid_until: iso(NOW + 60_000) };
  const process = { state: "alive", started_at_ms: START, ppid: 1 };
  const report = { probe: { pid: worker.pid },
    activity_evidence: { database_key: KEY, database_identity_stable: true, integrity: true, truncated: false,
      processes: new Map([[worker.pid, process]]) },
    worker: { log: { path: PRIVATE, exists: true, events, activity_integrity: true, truncated: false },
      summary: { last_cycle: { cycle: 999, ok: true, at: iso(NOW), started_at: iso(START) } } },
    stability: { cycles: { total: 999, ok: 999 }, longest_between_successes_ms: 99_999 } };
  const binding = { target_match: "matched", worker, phase: evaluateActivityEvent(worker, process, KEY, NOW) };
  return { report, binding, collect: (at = NOW) => summarizeRuntimeStats(report, binding, at) };
}

function unavailable(value, reason) {
  assert.deepEqual(value, { scope: "current_worker_retained_log", state: "unavailable", total_runs: null,
    successful_runs: null, last_completed_at: null, last_duration_ms: null, last_completion: null, groups: null, reason });
}

test("counts retained completed rounds and successes without using cycle numbers, 24-hour totals or spacing", () => {
  const events = [...round(1, { start: START + 1000 }), ...round(4, { start: NOW - 60_000, failed: ["sent"] }),
    ...round(9, { start: NOW - 10_000 })];
  const f = fixture(events);
  assert.deepEqual(f.collect(), { scope: "current_worker_retained_log", state: "available", total_runs: 3,
    successful_runs: 2, last_completed_at: iso(NOW - 9400), last_duration_ms: 600,
    last_completion: { cycle: 9, at: iso(NOW - 9400), ok: true, duration_ms: 600, failed_steps: [], failures: [],
      groups: { sync: "succeeded", history: "not_run", retention: "not_run" } },
    groups: { sync: { total_runs: 3, successful_runs: 2, failed_runs: 1 },
      history: { total_runs: 0, successful_runs: 0, failed_runs: 0 }, retention: { total_runs: 0, successful_runs: 0, failed_runs: 0 } }, reason: null });
});

for (const retention of [false, true]) for (const failed of [[], ["received-fair"], ["sent", "received-hot"]]) {
  test(`real producer completion has duration for retention=${retention}, failed=${failed.join(",") || "none"}`, () => {
    const f = fixture(round(1, { retention, failed }));
    const result = f.collect();
    assert.equal(result.state, "available");
    assert.equal(result.total_runs, 1);
    assert.equal(result.successful_runs, failed.length ? 0 : 1);
    assert.equal(result.last_duration_ms, retention ? 700 : 600);
  });
}

test("a zero-duration round is a valid measured zero and a later unfinished round is not counted", () => {
  const rows = round();
  for (const step of rows.slice(0, -1)) step.started_at = step.finished_at = rows.at(-1).at;
  const f = fixture([...rows, ...round(2).slice(0, 2)]);
  f.binding.worker.phase = "step"; f.binding.worker.step = "received-hot";
  f.binding.phase = { state: "syncing" };
  const value = f.collect();
  assert.equal(value.total_runs, 1);
  assert.equal(value.last_duration_ms, 0);
});

test("only explicit current database and instance records enter counts", () => {
  const rows = round(3);
  const foreign = round(3).map((event) => ({ ...event, database_key: OTHER_KEY, ok: "damaged other database" }));
  const old = round(3).map((event) => ({ ...event, instance_id: "invented-old-worker", at: "invalid-other-instance" }));
  const interleaved = rows.flatMap((event, index) => [foreign[index], event, old[index]]);
  const value = fixture(interleaved).collect();
  assert.equal(value.total_runs, 1);
  assert.equal(value.successful_runs, 1);
  assert.equal(value.last_duration_ms, null,
    "same-instance cross-database step evidence for one cycle cannot establish its duration");
});

test("retained-log truncation does not pretend to cover startup and does not erase verified retained records", () => {
  const f = fixture(round(9).slice(4));
  f.report.worker.log.truncated = true;
  const result = f.collect();
  assert.equal(result.state, "available");
  assert.equal(result.total_runs, 1);
  assert.equal(result.successful_runs, 1);
  assert.equal(result.last_duration_ms, null);
});

test("empty readable retained evidence is zero while a missing log is unknown", () => {
  const f = fixture([]);
  assert.deepEqual(f.collect(), { scope: "current_worker_retained_log", state: "available", total_runs: 0,
    successful_runs: 0, last_completed_at: null, last_duration_ms: null, last_completion: null,
    groups: { sync: { total_runs: 0, successful_runs: 0, failed_runs: 0 }, history: { total_runs: 0, successful_runs: 0, failed_runs: 0 },
      retention: { total_runs: 0, successful_runs: 0, failed_runs: 0 } }, reason: null });
  f.report.worker.log.exists = false;
  unavailable(f.collect(), "log_unavailable");
  delete f.report.worker.log;
  unavailable(f.collect(), "log_unavailable");
});

test("legacy completion-only evidence never becomes zero current-worker runs", () => {
  const legacy = { type: "lark_im_worker_cycle", cycle: 1, ok: true, at: iso(START - 1000) };
  unavailable(fixture([legacy]).collect(), "completion_unbound");
  const current = fixture([legacy, ...round(1)]).collect();
  assert.equal(current.total_runs, 1, "definitely old unbound history need not hide identified current completions");
  for (const at of [iso(START), iso(NOW - 100), "damaged", iso(NOW + 1)]) {
    unavailable(fixture([{ ...legacy, at }, ...round(1)]).collect(), "completion_unbound");
  }
});

for (const field of ["database_key", "instance_id"]) test(`current-looking completion missing ${field} remains unbound`, () => {
  const rows = round();
  delete rows.at(-1)[field];
  unavailable(fixture(rows).collect(), "completion_unbound");
});

test("identical completion repeats count once, including equivalent timezone representation", () => {
  const rows = round();
  const duplicate = { ...rows.at(-1), at: "2034-06-08T19:59:50.600+08:00", extra_private: PRIVATE };
  const value = fixture([...rows, duplicate]).collect();
  assert.equal(value.total_runs, 1);
  assert.equal(value.successful_runs, 1);
  assert.equal(value.last_duration_ms, 600);
});

for (const change of [
  { ok: false, failed_steps: ["sent"] },
  { at: iso(NOW - 9300) },
  { step_count: 7 },
]) test(`conflicting completion repetition is unavailable: ${JSON.stringify(change)}`, () => {
  const rows = round();
  unavailable(fixture([...rows, { ...rows.at(-1), ...change }]).collect(), "completion_conflict");
});

test("cycle or completion clock reversal is conflicting history", () => {
  unavailable(fixture([...round(2), ...round(1, { start: NOW - 9000 })]).collect(), "completion_conflict");
  unavailable(fixture([...round(1), ...round(2, { start: NOW - 11_000 })]).collect(), "completion_conflict");
});

test("duration rejects steps overlapping a preceding retained completion in time", () => {
  const before = round(1, { start: NOW - 20_600 });
  const after = round(2, { start: NOW - 30_000 });
  after.at(-1).at = iso(NOW - 10_000);
  const value = fixture([...before, ...after]).collect();
  assert.equal(value.total_runs, 2);
  assert.equal(value.successful_runs, 2);
  assert.equal(value.last_completed_at, iso(NOW - 10_000));
  assert.equal(value.last_duration_ms, null);
});

test("duration rejects steps appended before the preceding completion even when timestamps do not overlap", () => {
  const before = round(1, { start: NOW - 20_600 });
  const after = round(2, { start: NOW - 10_600 });
  const value = fixture([...before.slice(0, -1), ...after.slice(0, -1), before.at(-1), after.at(-1)]).collect();
  assert.equal(value.total_runs, 2);
  assert.equal(value.last_duration_ms, null);
});

test("duration permits a serial round starting exactly at the preceding completion, and no fabricated lower bound after truncation", () => {
  const before = round(1, { start: NOW - 20_600 });
  const after = round(2, { start: NOW - 20_000 });
  assert.equal(fixture([...before, ...after]).collect().last_duration_ms, 600);
  const truncated = fixture(after);
  truncated.report.worker.log.truncated = true;
  assert.equal(truncated.collect().last_duration_ms, 600);
});

const malformedCompletions = {
  "missing version": { version: undefined }, "wrong version": { version: 2 },
  "string result": { ok: "true" }, "missing result": { ok: undefined }, "null result": { ok: null },
  "false without failure": { ok: false }, "true with failure": { failed_steps: ["sent"] },
  "duplicate failure": { ok: false, failed_steps: ["sent", "sent"] },
  "unknown failure": { ok: false, failed_steps: [PRIVATE] }, "missing failure list": { failed_steps: undefined },
  "object failure name": { ok: false, failed_steps: [{ toString: null }] },
  "string step count": { step_count: "6" }, "short step count": { step_count: 1 },
  "zero cycle": { cycle: 0 }, "future cycle": { cycle: 11 }, "string cycle": { cycle: "1" },
  "missing completion time": { at: undefined }, "numeric completion time": { at: NOW - 1 },
  "impossible date": { at: "2034-02-30T10:00:00Z" }, "missing timezone": { at: "2034-06-08T11:59:00" },
  "future completion": { at: iso(NOW + 1) }, "before process start": { at: iso(START - 1) },
};
for (const [name, change] of Object.entries(malformedCompletions)) test(`damaged current completion fails closed: ${name}`, () => {
  const rows = round();
  Object.assign(rows.at(-1), change);
  unavailable(fixture(rows).collect(), "completion_invalid");
});

const invalidSteps = {
  "missing first": (rows) => rows.splice(0, 1),
  "duplicate step": (rows) => rows.splice(1, 1, { ...rows[0] }),
  "extra step": (rows) => rows.splice(1, 0, { ...rows[0] }),
  "step after completion": (rows) => rows.push(rows.shift()),
  "wrong database": (rows) => { rows[0].database_key = OTHER_KEY; },
  "wrong instance": (rows) => { rows[0].instance_id = "invented-foreign"; },
  "missing database": (rows) => { delete rows[0].database_key; },
  "legacy version": (rows) => { delete rows[0].version; },
  "duplicate index": (rows) => { rows[1].step_index = 0; },
  "unknown name": (rows) => { rows[0].name = PRIVATE; },
  "string result": (rows) => { rows[0].ok = "true"; },
  "failure inconsistent with completion": (rows) => { rows[0].ok = false; },
  "missing success exit": (rows) => { delete rows[0].exit_code; },
  "failed exit despite success": (rows) => { rows[0].exit_code = 2; },
  "partial success": (rows) => { rows[0].partial = true; },
  "bad partial": (rows) => { rows[0].partial = "false"; },
  "missing start": (rows) => { delete rows[0].started_at; },
  "invalid finish": (rows) => { rows[0].finished_at = PRIVATE; },
  "start before process": (rows) => { rows[0].started_at = iso(START - 1); },
  "negative step duration": (rows) => { rows[0].finished_at = iso(NOW - 10_001); },
  "overlap": (rows) => { rows[1].started_at = rows[0].started_at; },
  "finish after completion": (rows) => { rows[5].finished_at = iso(NOW - 9300); },
};
for (const [name, mutate] of Object.entries(invalidSteps)) test(`incomplete steps affect only duration: ${name}`, () => {
  const rows = round(); mutate(rows);
  assert.deepEqual(fixture(rows).collect(), { scope: "current_worker_retained_log", state: "available", total_runs: 1,
    successful_runs: 1, last_completed_at: iso(NOW - 9400), last_duration_ms: null,
    last_completion: { cycle: 1, at: iso(NOW - 9400), ok: true, duration_ms: null, failed_steps: [], failures: [],
      groups: { sync: "succeeded", history: "not_run", retention: "not_run" } },
    groups: { sync: { total_runs: 1, successful_runs: 1, failed_runs: 0 },
      history: { total_runs: 0, successful_runs: 0, failed_runs: 0 }, retention: { total_runs: 0, successful_runs: 0, failed_runs: 0 } }, reason: null });
});

test("failed process steps without an exit code can still establish a completed round duration", () => {
  const rows = round(1, { failed: ["sent"] });
  delete rows[0].exit_code;
  assert.equal(fixture(rows).collect().last_duration_ms, 600);
});

const invalidBindings = {
  "unmatched target": (f) => { f.binding.target_match = "unknown"; },
  "invalid worker shape": (f) => { delete f.binding.worker.parent_instance; },
  "foreground sync": (f) => { f.binding.worker.role = "sync"; f.binding.worker.phase = "sync"; },
  "service pid differs": (f) => { f.report.probe.pid += 1; },
  "no process evidence": (f) => { f.report.activity_evidence.processes.clear(); },
  "dead process": (f) => { f.report.activity_evidence.processes.get(7101).state = "dead"; },
  "pid reused": (f) => { f.report.activity_evidence.processes.get(7101).started_at_ms += 1000; },
  "missing process start": (f) => { f.binding.worker.process_started_at_ms = null; },
  "database replaced": (f) => { f.report.activity_evidence.database_identity_stable = false; },
  "foreign database": (f) => { f.report.activity_evidence.database_key = OTHER_KEY; },
  "ambiguous workers": (f) => { f.report.activity_evidence.truncated = true; },
  "damaged activity": (f) => { f.report.activity_evidence.integrity = false; },
  "expired phase": (f) => { f.binding.worker.valid_until = iso(NOW); },
  "future phase": (f) => { f.binding.worker.updated_at = iso(NOW + 1); },
  "stopped phase": (f) => { f.binding.worker.phase = "stopped"; },
  "wrong claimed phase": (f) => { f.binding.phase.state = "syncing"; },
  "unknown phase": (f) => { f.binding.phase.state = "unknown"; },
};
for (const [name, mutate] of Object.entries(invalidBindings)) test(`current background identity is required: ${name}`, () => {
  const f = fixture(); mutate(f); unavailable(f.collect(), "worker_unverified");
});

test("old mocks, absent binding and invalid clocks return unavailable without throwing", () => {
  unavailable(summarizeRuntimeStats(undefined, undefined, NOW), "worker_unverified");
  unavailable(summarizeRuntimeStats({}, {}, NOW), "worker_unverified");
  for (const now of [NaN, Infinity, undefined, null, "2034-06-08T12:00:00Z"]) {
    const f = fixture(); unavailable(summarizeRuntimeStats(f.report, f.binding, now), "worker_unverified");
  }
});

test("damaged or malformed retained logs are unavailable, never empty", () => {
  const f = fixture();
  f.report.worker.log.activity_integrity = false;
  unavailable(f.collect(), "log_damaged");
  for (const value of [null, [], "invalid", 7]) {
    const g = fixture([value]); unavailable(g.collect(), "log_damaged");
  }
  f.report.worker.log.events = null;
  unavailable(f.collect(), "log_unavailable");
});

test("output is a finite public whitelist and collection never mutates input evidence", () => {
  const f = fixture(); const before = structuredClone({ report: f.report, binding: f.binding });
  const value = f.collect();
  assert.deepEqual(Object.keys(value).sort(), ["scope", "state", "total_runs", "successful_runs", "last_completed_at", "last_duration_ms", "last_completion", "groups", "reason"].sort());
  assert.doesNotMatch(JSON.stringify(value), new RegExp(`${PRIVATE}|${INSTANCE}|${KEY}`));
  assert.deepEqual({ report: f.report, binding: f.binding }, before);
});

test("mixed task groups count the same bound completions without promoting failed rounds", () => {
  const rows = [
    ...round(1, { start: NOW - 40_000 }),
    ...round(2, { start: NOW - 30_000, history: true, failed: ["history"] }),
    ...round(3, { start: NOW - 20_000, history: true, retention: true, failed: ["sent", "retention"] }),
    ...round(4, { history: true, retention: true }),
  ];
  const result = fixture(rows).collect();
  assert.equal(result.total_runs, 4);
  assert.equal(result.successful_runs, 2);
  assert.deepEqual(result.groups, {
    sync: { total_runs: 4, successful_runs: 3, failed_runs: 1 },
    history: { total_runs: 3, successful_runs: 2, failed_runs: 1 },
    retention: { total_runs: 2, successful_runs: 1, failed_runs: 1 },
  });
  assert.deepEqual(result.last_completion, { cycle: 4, at: iso(NOW - 9200), ok: true, duration_ms: 800,
    failed_steps: [], failures: [], groups: { sync: "succeeded", history: "succeeded", retention: "succeeded" } });
  assert.equal(result.last_completed_at, result.last_completion.at);
  assert.equal(result.last_duration_ms, result.last_completion.duration_ms);
});

test("last completion uses its own bound failed result instead of an unbound latest success", () => {
  const f = fixture(round(2, { history: true, failed: ["history"] }));
  f.report.worker.summary.last_cycle = { cycle: 999, ok: true, at: iso(NOW) };
  const result = f.collect();
  assert.equal(result.total_runs, 1);
  assert.equal(result.successful_runs, 0);
  assert.deepEqual(result.last_completion, { cycle: 2, at: iso(NOW - 9300), ok: false, duration_ms: 700,
    failed_steps: ["history"], failures: [{ step: "history", reason: "reason_unavailable" }],
    groups: { sync: "succeeded", history: "failed", retention: "not_run" } });
  assert.deepEqual(result.groups.sync, { total_runs: 1, successful_runs: 1, failed_runs: 0 });
  assert.deepEqual(result.groups.history, { total_runs: 1, successful_runs: 0, failed_runs: 1 });
});

test("optional tasks absent from the latest receipt are not run even if older rounds ran them", () => {
  const result = fixture([
    ...round(1, { start: NOW - 20_000, history: true, retention: true, failed: ["history"] }),
    ...round(2),
  ]).collect();
  assert.deepEqual(result.last_completion.groups, { sync: "succeeded", history: "not_run", retention: "not_run" });
  assert.deepEqual(result.groups.history, { total_runs: 1, successful_runs: 0, failed_runs: 1 });
  assert.deepEqual(result.groups.retention, { total_runs: 1, successful_runs: 1, failed_runs: 0 });
});

for (const outcome of ["batch_deferred", "no_eligible_known_record"]) test(`history ${outcome} preserves logical success without inventing work`, () => {
  const rows = round(1, { history: true });
  rows.at(-2).summary = { ok: true, profile: "known_record_history/v1", outcome, processed: 0,
    request_budget: { stop_reason: null, cli_attempts: 0, self_attempts: 0 } };
  const result = fixture(rows).collect();
  assert.equal(result.successful_runs, 1);
  assert.equal(result.last_completion.ok, true);
  assert.equal(result.last_completion.groups.history, "succeeded");
  assert.deepEqual(result.groups.history, { total_runs: 1, successful_runs: 1, failed_runs: 0 });
  assert.deepEqual(result.last_completion.failures, []);
  assert.equal(Object.hasOwn(result.last_completion, "processed"), false);
});

test("completion-only records retain group outcomes but never invent duration or a reason", () => {
  const event = round(8, { history: true, retention: true, failed: ["sent", "history"] }).at(-1);
  event.summary = { ok: false, profile: "known_record_history/v1", request_budget: { stop_reason: "time_budget" } };
  const result = fixture([event]).collect();
  assert.deepEqual(result.last_completion, { cycle: 8, at: iso(NOW - 9200), ok: false, duration_ms: null,
    failed_steps: ["sent", "history"], failures: [{ step: "sent", reason: "reason_unavailable" }, { step: "history", reason: "reason_unavailable" }],
    groups: { sync: "failed", history: "failed", retention: "succeeded" } });
});

function historyFailure(reason = "time_budget") {
  const rows = round(3, { history: true, failed: ["history"] });
  const history = rows.at(-2);
  history.summary = { ok: false, profile: "known_record_history/v1", request_budget: { stop_reason: reason, raw: PRIVATE }, error: PRIVATE };
  return { rows, history };
}

for (const reason of ["cli_budget", "self_budget", "time_budget", "clock_unavailable", "sync_busy", "lease_unavailable",
  "rate_cooldown", "rate_limited", "shared_cooldown_unavailable"]) {
  test(`complete bound history evidence permits the finite reason ${reason}`, () => {
    const { rows } = historyFailure(reason);
    const result = fixture(rows).collect();
    assert.deepEqual(result.last_completion.failures, [{ step: "history", reason }]);
    assert.equal(result.last_completion.ok, false);
    assert.equal(result.successful_runs, 0);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${PRIVATE}|${INSTANCE}|${KEY}`));
  });
}

const invalidReasons = {
  "missing summary": ({ history }) => { delete history.summary; },
  "legacy summary without profile": ({ history }) => { delete history.summary.profile; },
  "unknown profile": ({ history }) => { history.summary.profile = PRIVATE; },
  "success summary on failed step": ({ history }) => { history.summary.ok = true; },
  "nonboolean summary result": ({ history }) => { history.summary.ok = "false"; },
  "missing budget": ({ history }) => { delete history.summary.request_budget; },
  "array budget": ({ history }) => { history.summary.request_budget = []; },
  "missing stop reason": ({ history }) => { delete history.summary.request_budget.stop_reason; },
  "null stop reason": ({ history }) => { history.summary.request_budget.stop_reason = null; },
  "private stop reason": ({ history }) => { history.summary.request_budget.stop_reason = PRIVATE; },
  "unknown finite-looking reason": ({ history }) => { history.summary.request_budget.stop_reason = "request_timeout"; },
  "object stop reason": ({ history }) => { history.summary.request_budget.stop_reason = { reason: "time_budget" }; },
  "missing process exit": ({ history }) => { delete history.exit_code; },
  "zero process exit": ({ history }) => { history.exit_code = 0; },
  "negative process exit": ({ history }) => { history.exit_code = -1; },
  "string process exit": ({ history }) => { history.exit_code = "2"; },
  "process guardian failure": ({ history }) => { history.guardian_diagnostic = { primary: { stage: PRIVATE } }; },
};
for (const [name, mutate] of Object.entries(invalidReasons)) test(`failure reason stays unavailable for ${name}`, () => {
  const f = historyFailure(); mutate(f);
  const result = fixture(f.rows).collect();
  assert.equal(result.last_completion.ok, false);
  assert.deepEqual(result.last_completion.failures, [{ step: "history", reason: "reason_unavailable" }]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${PRIVATE}|${INSTANCE}|${KEY}`));
});

for (const [name, mutate] of Object.entries(invalidSteps)) test(`a damaged whole trail cannot lend its history reason: ${name}`, () => {
  const { rows } = historyFailure();
  // This mutator's old six-step finish value needs to exceed this seven-step completion too.
  if (name === "finish after completion") rows[5].finished_at = iso(NOW - 9000);
  else mutate(rows);
  const result = fixture(rows).collect();
  assert.equal(result.state, "available");
  assert.equal(result.last_completion.duration_ms, null);
  assert.deepEqual(result.last_completion.failed_steps, ["history"]);
  assert.deepEqual(result.last_completion.failures, [{ step: "history", reason: "reason_unavailable" }]);
  assert.deepEqual(result.last_completion.groups, { sync: "succeeded", history: "failed", retention: "not_run" });
});

test("a foreign or previous cycle's safe history reason cannot fill the latest failed step", () => {
  const earlier = historyFailure();
  const latest = round(4, { start: NOW - 8000, history: true, failed: ["history"] });
  const foreign = { ...earlier.history, cycle: 4, instance_id: "invented-other-worker" };
  const result = fixture([...earlier.rows, foreign, ...latest]).collect();
  assert.equal(result.total_runs, 2);
  assert.deepEqual(result.last_completion.failures, [{ step: "history", reason: "reason_unavailable" }]);
});

test("sync and retention failures never borrow history budget-shaped summary fields", () => {
  const rows = round(4, { history: true, retention: true, failed: ["sent", "retention", "history"] });
  for (const step of rows.slice(0, -1)) step.summary = {
    ok: false, profile: "known_record_history/v1", request_budget: { stop_reason: "time_budget" },
  };
  const result = fixture(rows).collect();
  assert.deepEqual(result.last_completion.failures, [
    { step: "sent", reason: "reason_unavailable" }, { step: "retention", reason: "reason_unavailable" },
    { step: "history", reason: "time_budget" },
  ]);
  assert.deepEqual(result.last_completion.groups, { sync: "failed", history: "failed", retention: "failed" });
});

test("rotation limits group counts to retained completions and preserves missing-trail uncertainty", () => {
  const { rows } = historyFailure();
  const f = fixture(rows.slice(-2));
  f.report.worker.log.truncated = true;
  const result = f.collect();
  assert.equal(result.total_runs, 1);
  assert.deepEqual(result.groups, { sync: { total_runs: 1, successful_runs: 1, failed_runs: 0 },
    history: { total_runs: 1, successful_runs: 0, failed_runs: 1 }, retention: { total_runs: 0, successful_runs: 0, failed_runs: 0 } });
  assert.equal(result.last_completion.duration_ms, null);
  assert.deepEqual(result.last_completion.failures, [{ step: "history", reason: "reason_unavailable" }]);
});

test("same cycle and step count with contradictory optional task policy is a conflict", () => {
  const rows = round(1, { retention: true });
  unavailable(fixture([...rows, { ...rows.at(-1), cycle_policy: "bounded_history/v1" }]).collect(), "completion_conflict");
});

test("equivalent history policies deduplicate while historical step order remains explicit", () => {
  const rows = round(1, { history: true });
  const result = fixture([...rows, { ...rows.at(-1), cycle_policy: "bounded_history/v1" }]).collect();
  assert.equal(result.total_runs, 1);
  assert.equal(result.groups.history.total_runs, 1);
  assert.equal(result.last_completion.duration_ms, 700);
  const old = round(1, { history: true, retention: true, failed: ["retention"] });
  [old[6], old[7]] = [old[7], old[6]];
  old[6].step_index = 6; old[7].step_index = 7;
  old[6].started_at = iso(NOW - 9400); old[6].finished_at = iso(NOW - 9320);
  old[7].started_at = iso(NOW - 9300); old[7].finished_at = iso(NOW - 9220);
  old.at(-1).cycle_policy = "bounded_history/v1";
  const historical = fixture(old).collect();
  assert.equal(historical.last_completion.duration_ms, 800);
  assert.deepEqual(historical.last_completion.groups, { sync: "succeeded", history: "succeeded", retention: "failed" });
});
