import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createActivityWriter, activityDatabaseKey } from "../src/diagnostics/lark-im-activity-evidence.mjs";
import { buildServiceStatusReport, readRecentWorkerEvents } from "../src/diagnostics/lark-im-service-report.mjs";
import { publicStatusReport, serviceTargetEvidence } from "../src/diagnostics/status-report.mjs";
import { writeLog } from "../src/runtime/worker/log.mjs";
import { REQUIRED_CYCLE_STEPS } from "../dist/runtime/worker/lark-im-worker-core.js";

// Entirely invented identities, events and database bytes. Only the temporary
// JSONL writer/reader and file identity are real; no API, service or DB is read.
const NOW = Date.parse("2034-05-06T07:08:09.000Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const INSTANCE = "synthetic-schedule-worker";
const PID = 47123;
const START = NOW - 60_000;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-sample-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "synthetic.sqlite");
  writeFileSync(db, "invented file identity; never queried");
  const key = activityDatabaseKey(db);
  const emit = (event) => writeLog({ logDir: dir }, event, { stdout: { write() {} } });
  for (const [step_index, name] of REQUIRED_CYCLE_STEPS.entries()) {
    emit({ type: "lark_im_worker_step", version: 1, instance_id: INSTANCE, database_key: key,
      cycle: 1, step_index, name, ok: true, exit_code: 0, partial: false,
      started_at: iso(-2000 - (REQUIRED_CYCLE_STEPS.length - step_index) * 1000),
      finished_at: iso(-2000 - (REQUIRED_CYCLE_STEPS.length - step_index - 1) * 1000) });
  }
  emit({ type: "lark_im_worker_cycle", version: 1, instance_id: INSTANCE, database_key: key,
    cycle: 1, at: iso(-2000), ok: true, step_count: REQUIRED_CYCLE_STEPS.length, failed_steps: [] });
  const processes = new Map([[PID, { state: "alive", started_at_ms: START, ppid: 1 }]]);
  createActivityWriter({ db, role: "worker", pid: PID, instanceId: INSTANCE, now: () => NOW - 1000,
    inspect: () => processes, emit }).update("waiting", { cycle: 1, durationMs: 30_000 });
  const schedule = (outcome = "started", reason = "sample_started", overrides = {}) => ({
    type: "lark_im_remote_sample_schedule", version: 1, at: iso(-500), database_key: key,
    instance_id: INSTANCE, cycle: 1, outcome, reason, next_due: NOW + 60_000, ...overrides,
  });
  const collect = () => {
    const report = buildServiceStatusReport({ label: "synthetic", target: "test/synthetic", db, logDir: dir }, {
      nowMs: NOW,
      runCommand: () => ({ status: 0, stdout: `state = running\npid = ${PID}\n`, stderr: "" }),
      buildStatus: () => ({ health: "ok", locks: [] }),
      readLiveProbeCache: () => null, liveProbeContext: () => null, sqliteJson: () => [],
      inspectActivityProcesses: () => processes,
    });
    const binding = serviceTargetEvidence(report, NOW);
    return { report, public: publicStatusReport({ report, binding, observedAt: NOW,
      service: { ...report.probe, target_match: binding.target_match }, installed: { status: "installed" } }, {}) };
  };
  return { dir, key, emit, schedule, collect };
}

const LEGAL_RESULTS = [
  ["started", "sample_started"], ["ok", "sampled"], ["busy", "scheduler_busy"], ["busy", "sync_busy"],
  ...["sample_failed", "state_invalid", "database_unavailable", "state_write_failed", "database_changed",
    "scheduler_unavailable", "cache_write_failed", "sample_process_failed", "invalid_interval"].map((reason) => ["failed", reason]),
];

test("actual schedule log writes preserve verified Waiting and sync runtime statistics for every legal outcome", (t) => {
  const f = fixture(t);
  const baseline = f.collect();
  assert.equal(baseline.public.activity.state, "waiting");
  assert.deepEqual(baseline.public.runtime_stats, { scope: "current_worker_retained_log", state: "available",
    total_runs: 1, successful_runs: 1, last_completed_at: iso(-2000),
    last_duration_ms: REQUIRED_CYCLE_STEPS.length * 1000, reason: null });
  for (const [outcome, reason] of LEGAL_RESULTS) {
    f.emit(f.schedule(outcome, reason));
    const read = readRecentWorkerEvents(f.dir);
    assert.equal(read.activity_integrity, true, `${outcome}/${reason}`);
    assert.equal(read.events.at(-1).reason, reason);
    const current = f.collect();
    assert.equal(current.report.overview.activity.state, "waiting", reason);
    assert.equal(current.public.activity.state, "waiting", reason);
    assert.deepEqual(current.public.runtime_stats, baseline.public.runtime_stats, reason);
    assert.deepEqual(current.report.stability.cycles, baseline.report.stability.cycles, reason);
    assert.doesNotMatch(JSON.stringify(current.public), new RegExp(`${INSTANCE}|${f.key}|${f.dir}`));
  }
});

test("explicit unavailable schedule identities and omitted optional fields are legal but supply no activity or completions", (t) => {
  const f = fixture(t);
  const event = f.schedule("failed", "database_unavailable", { database_key: null, instance_id: null, next_due: null });
  delete event.cycle;
  f.emit(event);
  const minimal = f.schedule();
  delete minimal.instance_id;
  delete minimal.cycle;
  f.emit(minimal);
  const current = f.collect();
  assert.equal(readRecentWorkerEvents(f.dir).activity_integrity, true);
  assert.equal(current.public.activity.state, "waiting");
  assert.equal(current.public.runtime_stats.total_runs, 1);
  writeFileSync(join(f.dir, "worker.jsonl"), "");
  f.emit(minimal);
  const onlySchedule = f.collect();
  assert.equal(onlySchedule.public.activity.state, "unknown");
  assert.equal(onlySchedule.public.runtime_stats.state, "unavailable");
  assert.equal(onlySchedule.public.runtime_stats.total_runs, null);
});

const INVALID_FIELDS = [
  ["unknown event type", { type: "lark_im_remote_sample_schedule_v2" }],
  ["wrong version", { version: 2 }], ["string version", { version: "1" }],
  ["numeric timestamp", { at: NOW }], ["invalid calendar timestamp", { at: "2034-02-30T00:00:00.000Z" }],
  ["noncanonical timestamp", { at: "2034-05-06" }],
  ["invalid database identity", { database_key: "synthetic-private-db" }],
  ["object database identity", { database_key: {} }],
  ["invalid instance identity", { instance_id: "private/path" }], ["oversized instance", { instance_id: "a".repeat(81) }],
  ["zero cycle", { cycle: 0 }], ["string cycle", { cycle: "1" }], ["null cycle", { cycle: null }],
  ["unknown outcome", { outcome: "complete" }], ["unknown reason", { reason: "synthetic-private-error" }],
  ["crossed outcome/reason", { outcome: "ok", reason: "sample_failed" }],
  ["unemitted not-due outcome", { outcome: "not_due", reason: "not_due" }],
  ["string due", { next_due: String(NOW) }], ["negative due", { next_due: -1 }],
  ["fractional due", { next_due: NOW + 0.5 }], ["unsafe due", { next_due: Number.MAX_SAFE_INTEGER + 1 }],
  ["unknown extra field", { raw_error: "synthetic-private-error" }],
];
for (const field of ["type", "version", "at", "database_key", "outcome", "reason", "next_due"]) {
  INVALID_FIELDS.push([`missing ${field}`, { [field]: undefined }]);
}
for (const [label, changes] of INVALID_FIELDS) {
  test(`damaged schedule ${label} remains fail-closed through actual writer, reader, activity and runtime stats`, (t) => {
    const f = fixture(t);
    f.emit(f.schedule("started", "sample_started", changes));
    assert.equal(readRecentWorkerEvents(f.dir).activity_integrity, false);
    const current = f.collect();
    assert.equal(current.report.overview.activity.state, "unknown");
    assert.equal(current.public.activity.state, "unknown");
    assert.equal(current.public.runtime_stats.state, "unavailable");
    assert.equal(current.public.runtime_stats.total_runs, null);
  });
}
