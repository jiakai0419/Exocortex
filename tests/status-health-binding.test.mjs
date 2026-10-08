import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { summarizeServiceHealth } from "../src/diagnostics/lark-im-service-report.mjs";
import { activityDatabaseKey } from "../src/diagnostics/lark-im-activity-evidence.mjs";
import { collectStatusEvidence, publicStatusReport } from "../src/diagnostics/status-report.mjs";

// All identities, snapshots, phases and history are invented for these tests.
// The temporary files establish file identity only; no operational database,
// launchd service, process table or worker log is inspected.
const NOW = Date.parse("2034-06-08T12:00:00.000Z");
const DAY = 86_400_000;
const PRIVATE = "SYNTHETIC_HEALTH_BINDING_PRIVATE";
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const ready = (overrides = {}) => ({
  health: "ok", health_detail: "all known enabled scopes have cursors", db_path: PRIVATE,
  records: { total: 8, by_direction: [{ direction: "sent", count: 3 }, { direction: "received", count: 5 }] },
  scopes: { received_enabled: 2, received_without_cursor: 0, message_enabled: 3, message_without_success: 0 },
  discovery: { complete: true, cursor: { has_more: false, pages_scanned: 1, completed_at: iso(-60_000) } },
  details: { evidence: "available", pending_count: 0, due_count: 0, scopes_pending: 0, oldest_pending_ms: null, next_retry_at: null },
  list_progress: { evidence: "available", scopes: 3, oldest_cursor_ms: NOW - 1000, invalid_cursor_scopes: 0 },
  runs: { by_status: { succeeded: 3 }, recent: [] }, locks: [], ...overrides,
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "invented-status-health-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "selected.sqlite");
  const otherDb = join(dir, "other.sqlite");
  writeFileSync(db, "synthetic selected file identity");
  writeFileSync(otherDb, "synthetic other file identity");
  const databaseKey = activityDatabaseKey(db);
  const otherKey = activityDatabaseKey(otherDb);

  function completion(kind, ok = false) {
    const event = { type: "lark_im_worker_cycle", cycle: 1, ok, at: iso(-5000), private: PRIVATE };
    if (kind !== "legacy") Object.assign(event, { version: 1, instance_id: kind === "same_instance" ? "synthetic-current" : `synthetic-${kind}`,
      database_key: kind === "foreign_database" ? otherKey : databaseKey });
    if (kind === "old_instance") event.at = iso(-2 * DAY);
    if (kind === "future_event") event.at = iso(5000);
    return event;
  }

  function observe({ phase = "waiting", history = [completion("legacy")], local = ready(), runtime = "running", failedRows = [] } = {}) {
    const events = [...history];
    if (["waiting", "syncing", "expired", "foreign_worker", "foreground"].includes(phase)) {
      const foreground = phase === "foreground";
      events.push({ type: "lark_im_worker_activity", version: 1, role: foreground ? "sync" : "worker", pid: foreground ? 8802 : 7701,
        instance_id: foreground ? "synthetic-foreground" : "synthetic-current", parent_instance: null,
        database_key: phase === "foreign_worker" ? otherKey : databaseKey,
        process_started_at_ms: NOW - 60_000, phase: foreground ? "sync" : phase === "waiting" ? "waiting" : "step",
        cycle: foreground ? null : 2, step: foreground ? "all" : phase === "waiting" ? null : "received-fair",
        updated_at: iso(-1000), valid_until: iso(phase === "expired" ? -1 : foreground ? 4000 : 10_000) });
    }
    const collected = collectStatusEvidence({ db, logDir: dir }, { root: dir, cwd: dir, now: () => NOW }, {
      serviceDeps: { uid: () => 12345 },
      readInstalledServiceConfig: () => ({ status: "installed", config: { db }, xml: PRIVATE }),
      reportDeps: {
        clock: () => NOW,
        runCommand: (command) => {
          assert.equal(command, "launchctl");
          if (runtime === "stopped") return { status: 113, stdout: "", stderr: 'Could not find service "com.exocortex.lark-im-worker" in domain for user gui: 12345' };
          if (runtime === "unknown") return { status: 1, stdout: "", stderr: PRIVATE };
          return { status: 0, stdout: "state = running\npid = 7701\n", stderr: "" };
        },
        buildStatus: (path) => { assert.equal(path, db); return local; },
        readRecentWorkerEvents: () => ({ path: PRIVATE, exists: true, events, activity_integrity: true, truncated: false }),
        readLiveProbeCache: () => null, liveProbeContext: () => null,
        inspectActivityProcesses: (pids) => new Map([
          [7701, { state: "alive", started_at_ms: NOW - 60_000, ppid: 1 }],
          [8802, { state: "alive", started_at_ms: NOW - 60_000, ppid: 2222 }],
          [2222, { state: "alive", started_at_ms: NOW - 120_000, ppid: 1 }],
        ].filter(([pid]) => pids.includes(pid))),
        sqliteJson: (path) => { assert.equal(path, db); return failedRows; },
      },
    });
    const result = publicStatusReport(collected, { detail: true });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(PRIVATE));
    return { result, internal: collected.report };
  }
  return { completion, observe };
}

for (const phase of ["waiting", "syncing", "unknown", "expired", "foreign_worker"]) {
  for (const historyKind of ["legacy", "same_instance", "foreign_database", "old_instance", "future_event"]) {
    test(`unbound failed ${historyKind} history does not change selected target health during ${phase}`, (t) => {
      const f = fixture(t);
      const event = f.completion(historyKind);
      const { result, internal } = f.observe({ phase, history: [event] });
      assert.equal(result.health.status, "ok");
      assert.equal(result.health.reason, "local_ready");
      assert.equal(result.health.local, "ok");
      assert.equal(result.activity.state, ["waiting", "syncing"].includes(phase) ? phase : "unknown");
      assert.equal(result.service.target_match, ["waiting", "syncing"].includes(phase) ? "matched" : "unknown");
      assert.equal(result.worker.last_cycle.ok, false);
      assert.equal(result.worker.last_cycle.result_valid, true);
      assert.equal(result.worker.last_cycle.at, event.at);
      assert.equal(result.worker.last_cycle.timestamp_valid, historyKind !== "future_event");
      assert.equal(result.worker.database_binding, "unverified");
      assert.equal(result.stability.database_binding, "unverified");
      assert.equal(result.stability.cycles.failed, ["old_instance", "future_event"].includes(historyKind) ? 0 : 1);
      assert.equal(internal.worker.summary.last_cycle.ok, false, "raw summary remains useful history");
      assert.equal(internal.worker.log.events[0], event, "history evidence is not discarded");
    });
  }
}

test("healthy idle and unconfirmed activity remain independent from explicit successful or failed history", () => {
  for (const status of ["idle", "syncing", "unknown"]) {
    for (const ok of [true, false]) {
      const result = summarizeServiceHealth({ service: { status: "running" }, syncStatus: ready(),
        workerSummary: { last_cycle: { ok, result_valid: true, at: iso(-1000) } }, activity: { status } });
      assert.equal(result.status, "ok", `${status}/${ok}`);
      assert.equal(result.reason, "local_ready");
    }
  }
});

test("service stopped or unavailable remains a current problem despite any unbound history", (t) => {
  const f = fixture(t);
  for (const runtime of ["stopped", "unknown"]) {
    for (const ok of [true, false]) {
      const { result } = f.observe({ runtime, phase: "unknown", history: [f.completion("foreign_database", ok)] });
      assert.equal(result.health.status, "problem");
      assert.equal(result.health.reason, runtime === "stopped" ? "service_stopped" : "service_state_unavailable");
      assert.equal(result.activity.state, runtime === "stopped" ? "stopped" : "unknown");
      assert.equal(result.worker.last_cycle.ok, ok);
    }
  }
});

test("independent foreground sync does not hide a stopped background service", (t) => {
  const f = fixture(t);
  const { result } = f.observe({ runtime: "stopped", phase: "foreground", history: [f.completion("old_instance")] });
  assert.equal(result.activity.state, "syncing");
  assert.equal(result.activity.source, "foreground");
  assert.equal(result.health.status, "problem");
  assert.equal(result.health.reason, "service_stopped");
});

test("selected database failures, missing initial evidence and content debt keep their original health decisions", (t) => {
  const f = fixture(t);
  const states = [
    [ready({ health: "needs_attention", runs: { by_status: { failed: 2 } } }), "problem", "no_successful_runs"],
    [ready({ health: "not_ready", discovery: { complete: false, cursor: null } }), "problem", "initial_sync_unverified"],
    [ready({ health: "needs_attention", details: { evidence: "unavailable" } }), "problem", "detail_evidence_unavailable"],
    [ready({ health: "needs_attention", list_progress: { evidence: "unavailable" } }), "problem", "list_progress_unavailable"],
    [ready({ health: "catching_up", details: { evidence: "available", pending_count: 4, due_count: 2, scopes_pending: 1 } }), "catching_up", "details_pending"],
    [ready({ health: "catching_up", scopes: { received_without_cursor: 1, message_enabled: 3 } }), "catching_up", "scopes_pending"],
    [null, "problem", "sync_status_unavailable"],
  ];
  for (const phase of ["waiting", "syncing", "unknown"]) {
    for (const [local, status, reason] of states) {
      for (const ok of [true, false]) {
        const { result } = f.observe({ phase, local, history: [f.completion("foreign_database", ok)] });
        assert.equal(result.health.status, status, `${phase}/${reason}/${ok}`);
        assert.equal(result.health.reason, reason, `${phase}/${ok}`);
      }
    }
  }
});

test("database unfinished records still require verified current activity, regardless of worker history", (t) => {
  const f = fixture(t);
  const local = ready({ health: "unknown", current_activity: { evidence: "database_only", reason: "unverified_sync_history" },
    runs: { by_status: { succeeded: 3, running: 1 } } });
  for (const phase of ["waiting", "syncing", "unknown"]) {
    const { result } = f.observe({ phase, local, history: [f.completion("foreign_database")] });
    assert.equal(result.health.status, phase === "syncing" ? "ok" : "problem");
    assert.equal(result.health.reason, phase === "syncing" ? "activity_observed" : "unfinished_runs_unverified");
  }
});

test("retained selected-database failure counts survive independently of worker-history health", (t) => {
  const f = fixture(t);
  const { result } = f.observe({ local: ready({ health: "ok_with_history", runs: { by_status: { succeeded: 3, failed: 2 } } }),
    history: [f.completion("foreign_database")], failedRows: [{ error_message: "permission denied" }, { error_message: "network timeout" }] });
  assert.equal(result.health.status, "ok");
  assert.equal(result.health.local, "ok_with_history");
  assert.equal(result.failure_runs.evidence, "available");
  assert.equal(result.failure_runs.failed_runs, 2);
  assert.equal(result.failure_runs.database_binding, "selected_database");
  assert.equal(result.failure_runs.window_started_at, iso(-DAY));
  assert.equal(result.failure_runs.window_ended_at, iso());
  assert.equal(result.failure_runs.by_kind.reduce((total, row) => total + row.count, 0), 2);
  assert.equal(result.worker.last_cycle.ok, false);
  assert.equal(result.stability.cycles.failed, 1);
});
