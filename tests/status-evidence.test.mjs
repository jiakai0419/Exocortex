import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServiceStatusReport, collectRecentFailureKinds, summarizeServiceActivity,
  summarizeServiceHealth, summarizeWorkerStability } from "../src/diagnostics/lark-im-service-report.mjs";
import { activityDatabaseKey } from "../src/diagnostics/lark-im-activity-evidence.mjs";
import { publicActivity } from "../src/diagnostics/public-activity.mjs";
import { collectStatusEvidence, publicStatusReport } from "../src/diagnostics/status-report.mjs";
import { summarizeWorkerEvents } from "../dist/runtime/worker/lark-im-worker-core.js";

const now = Date.parse("2033-04-07T12:00:00.000Z");
const iso = (at) => new Date(at).toISOString();
const day = 86400000;
const marker = "INVENTED_PRIVATE_EVIDENCE";
const ready = (overrides = {}) => ({
  health: "ok", records: { total: 0, by_direction: [] },
  scopes: { received_enabled: 0, received_without_cursor: 0, message_enabled: 1, message_without_success: 0 },
  discovery: { complete: true, cursor: { has_more: false, pages_scanned: 2, completed_at: iso(now - 10000) } },
  details: { evidence: "available", pending_count: 0, due_count: 0, scopes_pending: 0, oldest_pending_ms: null, next_retry_at: null },
  list_progress: { evidence: "available", scopes: 1, oldest_cursor_ms: now - 2000, invalid_cursor_scopes: 0 },
  runs: { by_status: { succeeded: 1 } }, locks: [], ...overrides,
});
const collected = (overrides = {}) => ({ observedAt: now, service: { status: "running", target_match: "matched" },
  installed: { status: "installed" }, report: {
    overview: { health: { status: "ok", reason: "local_ready" }, activity: {}, freshness: {} },
    sync: { status: ready() }, worker: { summary: {} }, ...overrides,
  } });
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), "invented-status-evidence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function serviceDeps(overrides = {}) {
  return { clock: () => now,
    runCommand: () => ({ status: 0, stdout: "state = running\npid = 7701\n", stderr: "" }),
    buildStatus: () => ready(), readRecentWorkerEvents: () => ({ path: marker, exists: true, events: [], activity_integrity: true }),
    readLiveProbeCache: () => null, liveProbeContext: () => null,
    inspectActivityProcesses: () => new Map(), sqliteJson: () => [], ...overrides };
}

test("retained database failures use inclusive start-time boundaries and exclude future rows", (t) => {
  const db = join(temp(t), "synthetic.sqlite");
  execFileSync("sqlite3", [db], { input: `CREATE TABLE sync_runs(id INTEGER PRIMARY KEY, status TEXT, started_at TEXT, error_message TEXT);
    INSERT INTO sync_runs VALUES
      (1,'failed','${iso(now - day - 1)}','${marker}'),
      (2,'failed','${iso(now - day)}','${marker}'),
      (3,'failed','${iso(now)}','${marker}'),
      (4,'failed','${iso(now + 1)}','${marker}'),
      (5,'succeeded','${iso(now)}','${marker}');` });
  assert.deepEqual(collectRecentFailureKinds(db, now, day), {
    failed_runs: 2, by_kind: [{ kind: "unknown", count: 2 }],
  });
});

test("database failure query failure is unavailable, while a successful empty result is zero", () => {
  for (const fail of [false, true]) {
    const report = buildServiceStatusReport({ label: "invented", target: "invented", db: "/tmp/nonexistent-invented-status.sqlite", logDir: "/tmp/invented" },
      serviceDeps({ sqliteJson: () => { if (fail) throw new Error(marker); return []; } }));
    const result = publicStatusReport(collected(report), {});
    assert.equal(result.failure_runs.evidence, fail ? "unavailable" : "available");
    assert.equal(result.failure_runs.failed_runs, fail ? null : 0);
    assert.equal(result.failure_runs.window_started_at, iso(now - day));
    assert.equal(result.failure_runs.window_ended_at, iso(now));
    assert.deepEqual(result.stability.failures.by_kind, []);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
  }
});

test("slow database statistics retain their cutoff while current activity expires at the final observation", (t) => {
  const db = join(temp(t), "synthetic-identity.sqlite");
  writeFileSync(db, "synthetic identity only");
  let clock = now;
  let sql;
  const event = { type: "lark_im_worker_activity", version: 1, role: "worker", pid: 7701,
    instance_id: "synthetic-instance", parent_instance: null, database_key: activityDatabaseKey(db),
    process_started_at_ms: now - 10000, phase: "step", cycle: 1, step: "sent",
    updated_at: iso(now - 1000), valid_until: iso(now + 500) };
  const report = buildServiceStatusReport({ label: "invented", target: "invented", db, logDir: "/tmp/invented" }, serviceDeps({
    clock: () => clock, readRecentWorkerEvents: () => ({ path: marker, exists: true, events: [event], activity_integrity: true }),
    inspectActivityProcesses: () => new Map([[7701, { state: "alive", started_at_ms: now - 10000 }]]),
    sqliteJson: (_db, query) => { sql = query; clock += 2000; return []; },
  }));
  assert.match(sql, new RegExp(`started_at <= '${iso(now)}'`));
  assert.equal(report.failure_runs.window_ended_at, iso(now));
  assert.equal(report.observed_at, iso(now + 2000));
  assert.equal(report.stability.window_ended_at, report.observed_at);
  assert.equal(report.overview.activity.state, "unknown");
  const result = collectStatusEvidence({ db, logDir: "/tmp/invented" }, { now: () => now + 9000 }, {
    readInstalledServiceConfig: () => ({ status: "missing" }), buildServiceStatusReport: () => report,
  });
  assert.equal(result.observedAt, now + 2000);
});

test("default safe coverage distinguishes empty counts, legacy evidence and missing database", () => {
  const empty = publicStatusReport(collected({ sync: { status: ready({
    health: "not_ready", scopes: { message_enabled: 0, message_without_success: 0 },
    list_progress: { evidence: "available", scopes: 0, oldest_cursor_ms: null, invalid_cursor_scopes: 0 },
  }) } }), {});
  assert.equal(empty.sync.records.total, 0);
  assert.equal(empty.sync.scopes.message_enabled, 0);
  assert.equal(empty.sync.details.evidence, "available");
  assert.equal(empty.sync.details.pending_count, 0);
  assert.equal(empty.sync.list_progress.scopes, 0);
  const legacy = publicStatusReport(collected({ sync: { status: ready({ details: undefined, list_progress: undefined }) } }), {});
  assert.equal(legacy.sync.details.evidence, "legacy_unavailable");
  assert.equal(legacy.sync.details.pending_count, null);
  assert.equal(legacy.sync.list_progress.oldest_cursor_ms, null);
  assert.equal(publicStatusReport(collected({ sync: { status: null } }), {}).sync, null);
  assert.equal(empty.sync.discovery.cursor.has_more, false);
});

test("current task comes only from verified phase and never from the most recent historical task", () => {
  const event = { type: "lark_im_worker_activity", version: 1, role: "worker", pid: 7701,
    instance_id: "synthetic-instance", parent_instance: null, database_key: "a".repeat(64),
    process_started_at_ms: now - 10000, phase: "step", cycle: 1, step: "discover-reconcile",
    updated_at: iso(now - 1000), valid_until: iso(now + 500) };
  const input = { service: { status: "running" }, launchd: { pid: 7701 }, syncStatus: ready(), nowMs: now,
    workerSummary: { last_step: { name: "sent" } }, activityEvidence: { events: [event], database_key: event.database_key,
      database_identity_stable: true, integrity: true, observed_at: iso(now),
      processes: new Map([[7701, { state: "alive", started_at_ms: now - 10000 }]]) } };
  const valid = publicActivity(summarizeServiceActivity(input));
  assert.equal(valid.state, "syncing");
  assert.equal(valid.step, "discover-reconcile");
  assert.equal(publicActivity(summarizeServiceActivity({ ...input, nowMs: now + 1000 })).step, null);
  assert.equal(publicActivity({ ...valid, step: marker }).step, null);
  assert.equal(publicActivity({ ...valid, state: "unknown", reason: "worker_phase_unavailable" }).step, null);
});

test("old-only and damaged log evidence never imply observed current-window events", () => {
  const events = [{ type: "lark_im_worker_cycle", ok: true, cycle: 1, at: iso(now - day * 2), database_key: "a".repeat(64) }];
  const stability = summarizeWorkerStability(events, now, day, { exists: true, truncated: true, activity_integrity: false });
  assert.equal(stability.observation.range_started_at, iso(now - day));
  assert.equal(stability.observation.current_window_first_event_at, null);
  assert.equal(stability.observation.current_window_last_event_at, null);
  assert.equal(stability.observed_events, 0);
  assert.deepEqual(stability.log_evidence, { exists: true, integrity: false, truncated: true });
  assert.equal(stability.database_binding, "unverified");
  assert.equal(summarizeWorkerStability([], now, day, { exists: false }).evidence, "unavailable");
});

test("future and malformed worker history are flagged without reinterpreting legacy JSON ages", () => {
  const events = [{ type: "lark_im_worker_cycle", ok: true, cycle: 1, at: iso(now - day * 2) },
    { type: "lark_im_worker_step", ok: true, name: "sent", cycle: 2, finished_at: iso(now + 1000) }];
  const summary = summarizeWorkerEvents(events, now);
  const result = publicStatusReport(collected({ worker: { summary } }), {});
  assert.equal(result.worker.last_cycle.timestamp_valid, true);
  assert.equal(result.worker.last_step.timestamp_valid, false);
  assert.equal(result.worker.last_step.age_ms, 0);
  assert.equal(result.worker.last_event_timestamp_valid, false);
  assert.equal(result.worker.database_binding, "unverified");
  summary.last_step.at = marker;
  assert.equal(publicStatusReport(collected({ worker: { summary } }), {}).worker.last_step.timestamp_valid, false);
  assert.equal(summarizeWorkerStability(events, now).observed_events, 0);
});

test("health reasons expose finite decision categories and do not copy internal explanations", () => {
  const base = { service: { status: "running" }, syncStatus: ready(), workerSummary: {}, activity: { status: "unknown" } };
  for (const [input, reason] of [
    [base, "local_ready"],
    [{ ...base, service: { status: "stopped" } }, "service_stopped"],
    [{ ...base, service: { status: "unknown" } }, "service_state_unavailable"],
    [{ ...base, syncStatus: null }, "sync_status_unavailable"],
    [{ ...base, syncStatus: ready({ health: "not_ready" }) }, "initial_sync_unverified"],
    [{ ...base, syncStatus: ready({ health: "needs_attention", details: { evidence: "unavailable" } }) }, "detail_evidence_unavailable"],
    [{ ...base, syncStatus: ready({ health: "needs_attention", list_progress: { evidence: "unavailable" } }) }, "list_progress_unavailable"],
    [{ ...base, syncStatus: ready({ health: "catching_up", details: { pending_count: 2 } }) }, "details_pending"],
    [{ ...base, syncStatus: ready({ health: "catching_up", scopes: { received_without_cursor: 2 } }) }, "scopes_pending"],
    [{ ...base, syncStatus: ready({ health: "catching_up", discovery: { cursor: { has_more: true } } }) }, "discovery_pending"],
  ]) assert.equal(summarizeServiceHealth(input).reason, reason);
  const projection = publicStatusReport(collected({ overview: { health: { status: "problem", reason: marker, detail: marker }, activity: {}, freshness: {} } }), {});
  assert.equal(projection.health.reason, "health_unavailable");
  assert.doesNotMatch(JSON.stringify(projection), new RegExp(marker));
});

test("malformed completion results stay unverified instead of becoming a failed historical result", () => {
  for (const ok of [undefined, null, "false", 0]) {
    const events = [
      { type: "lark_im_worker_step", cycle: 1, name: "sent", finished_at: iso(now - 2000), ok },
      { type: "lark_im_worker_cycle", cycle: 1, at: iso(now - 1000), ok },
    ];
    const report = buildServiceStatusReport({ label: "invented", target: "invented", db: "/tmp/nonexistent-invented-status.sqlite", logDir: "/tmp/invented" },
      serviceDeps({ readRecentWorkerEvents: () => ({ path: marker, exists: true, events, activity_integrity: true }) }));
    const result = publicStatusReport(collected(report), {});
    assert.equal(result.worker.last_cycle.ok, false, "legacy field remains unchanged");
    assert.equal(result.worker.last_cycle.result_valid, false);
    assert.equal(result.worker.last_step.result_valid, false);
    assert.equal(result.health.status, "ok", "unverified history cannot replace independent local health");
    assert.equal(result.health.reason, "local_ready");
    assert.deepEqual(result.stability.cycles, { total: 1, ok: 0, failed: 0 });
  }
  for (const ok of [true, false]) {
    const events = [{ type: "lark_im_worker_cycle", cycle: 1, at: iso(now - 1000), ok }];
    const report = buildServiceStatusReport({ label: "invented", target: "invented", db: "/tmp/nonexistent-invented-status.sqlite", logDir: "/tmp/invented" },
      serviceDeps({ readRecentWorkerEvents: () => ({ path: marker, exists: true, events, activity_integrity: true }) }));
    const result = publicStatusReport(collected(report), {});
    assert.equal(result.worker.last_cycle.result_valid, true);
    assert.equal(result.worker.last_cycle.ok, ok, "explicit history results stay available");
    assert.equal(result.health.reason, "local_ready", "unbound history cannot replace selected database health");
  }
});

test("verified current target health is independent of current, old and foreign completion results", (t) => {
  const dir = temp(t);
  const db = join(dir, "synthetic-current-target.sqlite");
  const otherDb = join(dir, "synthetic-foreign-target.sqlite");
  writeFileSync(db, "invented current identity");
  writeFileSync(otherDb, "invented foreign identity");
  const databaseKey = activityDatabaseKey(db);
  const phase = { type: "lark_im_worker_activity", version: 1, role: "worker", pid: 7701,
    instance_id: "synthetic-current-instance", parent_instance: null, database_key: databaseKey,
    process_started_at_ms: now - 60000, phase: "step", cycle: 2, step: "received-fair",
    updated_at: iso(now - 1000), valid_until: iso(now + 10000) };
  const histories = [
    { name: "current instance", instance_id: phase.instance_id, database_key: databaseKey, at: iso(now - 5000) },
    { name: "old instance", instance_id: "synthetic-old-instance", database_key: databaseKey, at: iso(now - 2 * day) },
    { name: "old foreign instance", instance_id: "synthetic-foreign-instance", database_key: activityDatabaseKey(otherDb), at: iso(now - 2 * day) },
  ];
  for (const history of histories) {
    for (const ok of [true, false, undefined, null, "false", 0]) {
      const completion = { type: "lark_im_worker_cycle", version: 1, cycle: 1,
        instance_id: history.instance_id, database_key: history.database_key, at: history.at,
        ...(ok === undefined ? {} : { ok }) };
      const evidence = collectStatusEvidence({ db, logDir: dir }, { now: () => now }, {
        readInstalledServiceConfig: () => ({ status: "installed" }),
        reportDeps: serviceDeps({
          readRecentWorkerEvents: () => ({ path: marker, exists: true, events: [completion, phase], activity_integrity: true }),
          inspectActivityProcesses: () => new Map([[7701, { state: "alive", started_at_ms: now - 60000 }]]),
        }),
      });
      const result = publicStatusReport(evidence, {});
      const scenario = `${history.name}; raw result=${String(ok)}`;
      assert.equal(result.service.target_match, "matched", scenario);
      assert.equal(result.activity.state, "syncing", scenario);
      assert.equal(result.activity.evidence, "verified_worker_phase", scenario);
      assert.equal(result.health.status, "ok", scenario);
      assert.equal(result.health.reason, "local_ready", scenario);
      assert.equal(result.worker.database_binding, "unverified", "history is never newly bound by this projection");
      assert.equal(result.worker.last_cycle.result_valid, typeof ok === "boolean", scenario);
    }
  }
});

test("unverified completion history preserves catch-up and missing initial database evidence", () => {
  const input = { service: { status: "running" }, workerSummary: { last_cycle: { ok: false, result_valid: false } }, activity: { status: "syncing" } };
  const catchingUp = summarizeServiceHealth({ ...input, syncStatus: ready({ health: "catching_up", details: { pending_count: 3 } }) });
  assert.equal(catchingUp.status, "catching_up");
  assert.equal(catchingUp.reason, "details_pending");
  const notReady = summarizeServiceHealth({ ...input, syncStatus: ready({ health: "not_ready" }) });
  assert.equal(notReady.status, "problem");
  assert.equal(notReady.reason, "initial_sync_unverified");
});
