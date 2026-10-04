import assert from "node:assert/strict";
import test from "node:test";

import { plain } from "../dist/terminal/index.js";
import { summarizeWorkerEvents } from "../dist/runtime/worker/lark-im-worker-core.js";
import {
  buildServiceStatusReport,
  buildServiceOverview,
  collectRecentFailureKinds,
  classifyLaunchdPrint,
  parseJsonOutput,
  parseLaunchdState,
  summarizeWorkerStability,
  summarizeServiceFreshness,
} from "../src/diagnostics/lark-im-service-report.mjs";
import { renderServiceStatusText } from "../src/terminal/lark-im-service-view.mjs";


function activePhaseEvidence(nowMs) {
  const started = nowMs - 60000;
  return { database_key: "b".repeat(64), events: [{ type: "lark_im_worker_activity", version: 1,
    role: "worker", pid: 123, instance_id: "synthetic-worker", parent_instance: null,
    process_started_at_ms: started, database_key: "b".repeat(64), phase: "step", cycle: 13, step: "sent",
    updated_at: new Date(nowMs - 1000).toISOString(), valid_until: new Date(nowMs + 10000).toISOString() }],
    processes: new Map([[123, { state: "alive", started_at_ms: started, ppid: 111 }]]) };
}

function spawnResult(overrides = {}) {
  return {
    status: 0,
    stdout: "",
    stderr: "",
    signal: null,
    pid: 1,
    output: [],
    ...overrides,
  };
}

function syncStatusFixture(overrides = {}) {
  return {
    health: "ok_with_history",
    health_detail: "all known enabled scopes have cursors",
    records: {
      total: 3,
      by_direction: [
        { direction: "received", count: 2 },
        { direction: "sent", count: 1 },
      ],
    },
    scopes: {
      received_enabled: 2,
      received_without_cursor: 0,
      received_unsupported: 1,
      unsupported_reasons: [
        {
          reason: "restricted_mode",
          lark_cli_error_code: "",
          lark_cli_error_message: "",
          count: 1,
        },
      ],
    },
    hot_discovery: {
      ran: true,
      cursor_updated_at: "2026-06-20T00:01:00.000Z",
    },
    reconcile: {
      complete: true,
      cursor: { pages_scanned: 7 },
    },
    locks: [],
    ...overrides,
  };
}

function workerSummaryFixture(overrides = {}) {
  return {
    has_events: true,
    last_event_type: "lark_im_worker_cycle",
    last_event_age_ms: 10000,
    last_cycle: {
      cycle: 12,
      ok: true,
      at: "2026-06-20T00:02:00.000Z",
      age_ms: 10000,
    },
    last_step: {
      cycle: 12,
      name: "received-catchup",
      ok: true,
      at: "2026-06-20T00:02:00.000Z",
      age_ms: 10000,
    },
    in_progress: false,
    last_failure: null,
    ...overrides,
  };
}

function stabilityFixture(overrides = {}) {
  return {
    window_ms: 24 * 60 * 60 * 1000,
    window_started_at: "2026-06-19T00:00:00.000Z",
    observed_events: 20,
    cycles: {
      total: 12,
      ok: 11,
      failed: 1,
    },
    last_success: {
      cycle: 12,
      at: "2026-06-20T00:02:00.000Z",
      age_ms: 60000,
    },
    longest_between_successes_ms: 41 * 60 * 1000,
    failures: {
      failed_cycles: 1,
      failed_steps: 2,
      by_step: [{ name: "received-catchup", count: 2 }],
      by_kind: [{ kind: "rate_limited", count: 1 }],
    },
    ...overrides,
  };
}

const probeContext = { database_key: "a".repeat(64), source_id: "lark.im", auth_identity_verified: false };
function probeFixture(checkedAt, overrides = {}) {
  return {
    kind: "lark_im_live_probe_cache/v2", context: probeContext, scope: "recent_hot_messages",
    checked_at: checkedAt, expires_at: new Date(Date.parse(checkedAt) + 300000).toISOString(),
    window: { start: "2026-06-19T00:00:00.000Z", end: "2026-06-20T00:00:00.000Z" },
    sample: { remote_messages_checked: 3, probe_errors: 0 },
    status: "healthy", ok: true, missing_count: 0, ...overrides,
  };
}

test("service status report parses launchd, sync status, and worker log summary", () => {
  const calls = [];
  const cachePaths = [];
  const workerEvents = [
    {
      type: "lark_im_worker_step",
      cycle: 12,
      name: "received-catchup",
      ok: true,
      at: "2026-06-20T00:01:30.000Z",
    },
    {
      type: "lark_im_worker_cycle",
      cycle: 12,
      ok: true,
      at: "2026-06-20T00:02:00.000Z",
    },
  ];
  const report = buildServiceStatusReport(
    { label: "com.example.worker", target: "gui/501/com.example.worker", logDir: "logs/test" },
    {
      nowMs: Date.parse("2026-06-20T00:03:00.000Z"),
      stabilityWindowMs: 10 * 60 * 1000,
      runCommand: (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === "launchctl") {
          return spawnResult({
            stdout: "state = running\npid = 123\nlast exit code = 0\n",
          });
        }
        if (cmd === process.execPath) {
          return spawnResult({ stdout: JSON.stringify(syncStatusFixture()) });
        }
        throw new Error(`unexpected command: ${cmd}`);
      },
      readRecentWorkerEvents: (logDir) => ({
        path: `${logDir}/worker.jsonl`,
        exists: true,
        events: workerEvents,
      }),
      liveProbeContext: () => probeContext,
      readLiveProbeCache: (path) => {
        cachePaths.push(path);
        return probeFixture("2026-06-20T00:02:00.000Z");
      },
      sqliteJson: (_dbPath, _sql, label) => {
        assert.equal(label, "read recent failed run kinds");
        return [
          {
            error_message: '{"error":{"type":"api","code":9499,"message":"too many request"}}',
          },
        ];
      },
      summarizeWorkerEvents: (events) => {
        assert.deepEqual(events, workerEvents);
        return workerSummaryFixture();
      },
    },
  );

  assert.equal(report.label, "com.example.worker");
  assert.equal(report.service_state, "running");
  assert.equal(report.launchd.loaded, true);
  assert.equal(report.launchd.pid, "123");
  assert.equal(report.sync.status.health, "ok_with_history");
  assert.equal(report.overview.service.status, "running");
  assert.equal(report.overview.health.status, "ok");
  assert.equal(report.overview.activity.status, "unknown");
  assert.equal(report.overview.freshness.status, "sampled");
  assert.equal(report.overview.freshness.detail, "3 recent hot messages sampled 1m ago; auth identity unknown");
  assert.match(report.freshness.cache_path, /logs\/test\/live-probe\.json$/);
  assert.deepEqual(cachePaths, [report.freshness.cache_path]);
  assert.equal(report.worker.log.exists, true);
  assert.equal(report.worker.summary.last_cycle.cycle, 12);
  assert.equal(report.stability.cycles.ok, 1);
  assert.equal(report.stability.last_success.cycle, 12);
  assert.equal(report.stability.last_success.age_ms, 60000);
  assert.deepEqual(report.stability.failures.by_kind, [{ kind: "rate_limited", count: 1 }]);
  assert.deepEqual(calls, [
    ["launchctl", "print", "gui/501/com.example.worker"],
    [process.execPath, "scripts/sync-status.mjs", "--db", "data/exocortex.sqlite", "--format", "json"],
  ]);
});

test("worker stability measures only adjacent observed successful cycles", () => {
  const nowMs = Date.parse("2026-06-20T10:50:00.000Z");
  const windowMs = 60 * 60 * 1000;
  const successTimes = ["10:00", "10:01", "10:02", "10:43", "10:44"];
  const events = successTimes.map((time, index) => ({
    type: "lark_im_worker_cycle",
    cycle: index + 1,
    ok: true,
    at: `2026-06-20T${time}:00.000Z`,
  }));
  events.push({
    type: "lark_im_worker_step",
    cycle: 6,
    name: "received-catchup",
    ok: false,
    at: "2026-06-20T10:45:00.000Z",
  });

  const stability = summarizeWorkerStability(events, nowMs, windowMs);

  assert.equal(stability.cycles.ok, 5);
  assert.equal(stability.cycles.failed, 0);
  assert.equal(stability.last_success.cycle, 5);
  assert.equal(stability.longest_between_successes_ms, 41 * 60 * 1000);
  assert.deepEqual(stability.failures.by_step, [{ name: "received-catchup", count: 1 }]);
});

test("worker stability reports no interval when no successful cycle exists", () => {
  const stability = summarizeWorkerStability(
    [
      {
        type: "lark_im_worker_cycle",
        cycle: 1,
        ok: false,
        at: "2026-06-20T10:10:00.000Z",
      },
    ],
    Date.parse("2026-06-20T10:50:00.000Z"),
    60 * 60 * 1000,
  );

  assert.equal(stability.cycles.total, 1);
  assert.equal(stability.cycles.ok, 0);
  assert.equal(stability.cycles.failed, 1);
  assert.equal(stability.last_success, null);
  assert.equal(stability.longest_between_successes_ms, null);
});

test("service status report preserves not-loaded and sync-unavailable states", () => {
  const report = buildServiceStatusReport(
    { label: "com.example.worker", target: "gui/501/com.example.worker", logDir: "logs/test" },
    {
      runCommand: (cmd) => {
        if (cmd === "launchctl") {
          return spawnResult({ status: 113, stderr: 'Could not find service "com.example.worker" in domain for user gui: 501' });
        }
        return spawnResult({ status: 1, stderr: "sync unavailable" });
      },
      readRecentWorkerEvents: (logDir) => ({
        path: `${logDir}/worker.jsonl`,
        exists: false,
        events: [],
      }),
      summarizeWorkerEvents: () => ({
        has_events: false,
        in_progress: false,
      }),
      sqliteJson: () => [],
    },
  );

  assert.equal(report.service_state, "not loaded");
  assert.equal(report.launchd.loaded, false);
  assert.equal(report.overview.service.status, "stopped");
  assert.equal(report.overview.health.status, "problem");
  assert.equal(report.overview.activity.status, "unknown");
  assert.equal(report.sync.status, null);
  assert.match(report.sync.error_text, /sync unavailable/);
  assert.equal(report.worker.log.exists, false);
});

test("service overview separates service, health, activity, and freshness", () => {
  const overview = buildServiceOverview({
    launchd: { loaded: true, state: "running", pid: "123" },
    syncStatus: syncStatusFixture({
      health: "syncing",
      locks: [{ locked_at: "2026-06-20T00:00:50.000Z", expires_at: "2026-06-20T00:02:00.000Z" }],
      scopes: {
        received_enabled: 2,
        received_without_cursor: 0,
        received_unsupported: 0,
        unsupported_reasons: [],
      },
    }),
    workerSummary: workerSummaryFixture({
      in_progress: true,
      last_step: { cycle: 13, name: "received-hot", ok: true, age_ms: 1000 },
    }),
    liveProbe: probeFixture("2026-06-20T00:01:00.000Z"),
    expectedContext: probeContext,
    activityEvidence: activePhaseEvidence(Date.parse("2026-06-20T00:01:00.000Z")),
    nowMs: Date.parse("2026-06-20T00:01:00.000Z"),
  });

  assert.equal(overview.service.status, "running");
  assert.equal(overview.health.status, "ok");
  assert.equal(overview.health.detail, "sync activity observed; this does not verify remote freshness");
  assert.equal(overview.activity.status, "syncing");
  assert.equal(overview.freshness.status, "sampled");
  assert.equal(overview.freshness.detail, "3 recent hot messages sampled 0s ago; auth identity unknown");
});

test("service overview keeps catch-up as health, not activity", () => {
  const overview = buildServiceOverview({
    launchd: { loaded: true, state: "running", pid: "123" },
    syncStatus: syncStatusFixture({
      health: "catching_up",
      health_detail: "initial catch-up: 1 chat scope needs cursor",
      scopes: {
        received_enabled: 2,
        received_without_cursor: 1,
        received_unsupported: 0,
        unsupported_reasons: [],
      },
    }),
    workerSummary: workerSummaryFixture({ in_progress: false }),
  });

  assert.equal(overview.service.status, "running");
  assert.equal(overview.health.status, "catching_up");
  assert.equal(overview.activity.status, "unknown");
  assert.equal(overview.freshness.status, "unknown");
});

test("service overview maps delayed and stale live caches to freshness states", () => {
  const delayed = buildServiceOverview({
    launchd: { loaded: true, state: "running", pid: "123" },
    syncStatus: syncStatusFixture(),
    workerSummary: workerSummaryFixture(),
    liveProbe: probeFixture("2026-06-20T00:00:00.000Z", { status: "delayed", ok: false, missing_count: 2 }),
    expectedContext: probeContext,
    nowMs: Date.parse("2026-06-20T00:04:00.000Z"),
  });
  const stale = buildServiceOverview({
    launchd: { loaded: true, state: "running", pid: "123" },
    syncStatus: syncStatusFixture(),
    workerSummary: workerSummaryFixture(),
    liveProbe: probeFixture("2026-06-20T00:00:00.000Z"),
    expectedContext: probeContext,
    nowMs: Date.parse("2026-06-22T00:00:01.000Z"),
  });

  assert.equal(delayed.freshness.status, "behind");
  assert.equal(delayed.freshness.detail, "sample checked 4m ago, missing 2; auth identity unknown");
  assert.equal(stale.freshness.status, "unknown");
  assert.equal(stale.freshness.detail, "last live probe stale, checked 2d ago");
});

test("service overview does not treat a reservation as current synchronization", () => {
  const overview = buildServiceOverview({
    launchd: { loaded: true, state: "running", pid: "123" },
    syncStatus: syncStatusFixture({ health: "syncing", locks: [{ locked_at: "2026-06-20T00:00:00.000Z", expires_at: "2026-06-20T00:02:00.000Z" }] }),
    workerSummary: workerSummaryFixture({ in_progress: false }),
    nowMs: Date.parse("2026-06-20T00:01:00.000Z"),
  });

  assert.equal(overview.health.status, "problem");
  assert.equal(overview.activity.status, "unknown");
  assert.match(overview.activity.detail, /phase or owner evidence/);
});

test("service status view renders launchd, sync, unsupported scopes, and worker sections", () => {
  const output = plain(
    renderServiceStatusText({
      label: "com.example.worker",
      service_state: "running",
      launchd: {
        loaded: true,
        state: "running",
        pid: "123",
        last_exit_code: "0",
      },
      sync: {
        status: syncStatusFixture(),
      },
      worker: {
        log: { path: "logs/test/worker.jsonl", exists: true, events: [] },
        summary: workerSummaryFixture(),
      },
      stability: stabilityFixture(),
    }),
  );

  assert.match(output, /Lark IM service/);
  assert.match(output, /Overview/);
  assert.match(output, /Service\s+RUNNING/);
  assert.match(output, /Health\s+OK all known enabled scopes have cursors/);
  assert.match(output, /Activity\s+IDLE/);
  assert.match(output, /Freshness\s+UNKNOWN no cached live probe/);
  assert.doesNotMatch(output, /OK_WITH_HISTORY/);
  assert.match(output, /Recent cycles \(up to 24h\)/);
  assert.match(output, /Cycles\s+11 ok, 1 failed, 12 total/);
  assert.match(output, /Last success\s+#12 1m ago/);
  assert.match(output, /Longest between successes\s+41m/);
  assert.match(output, /Failures\s+1 failed cycle, received-catchup x2, rate_limited x1/);
  assert.match(output, /LaunchAgent/);
  assert.match(output, /Records\s+3 total, 1 sent, 2 received/);
  assert.match(output, /Unsupported scopes\s+1 · restricted_mode \(access restricted\)/);
  assert.match(output, /restricted_mode/);
  assert.match(output, /Worker/);
  assert.match(output, /received-catchup/);
});

test("service status recent failure kind aggregation is public-safe", () => {
  const kinds = collectRecentFailureKinds(
    "/abs/db.sqlite",
    Date.parse("2026-06-20T12:00:00.000Z"),
    24 * 60 * 60 * 1000,
    {
      sqliteJson: (dbPath, sql, label) => {
        assert.equal(dbPath, "/abs/db.sqlite");
        assert.equal(label, "read recent failed run kinds");
        assert.match(sql, /started_at >= '2026-06-19T12:00:00\.000Z'/);
        return [
          { error_message: '{"error":{"type":"api","code":9499,"message":"too many request"}}' },
          { error_message: "TLS handshake timeout" },
          { error_message: "permission denied" },
        ];
      },
    },
  );

  assert.deepEqual(kinds, {
    failed_runs: 3,
    by_kind: [
      { kind: "network_timeout", count: 1 },
      { kind: "rate_limited", count: 1 },
      { kind: "unknown", count: 1 },
    ],
  });
});

test("service status view renders sync failure and missing worker log", () => {
  const output = plain(
    renderServiceStatusText({
      label: "com.example.worker",
      service_state: "not loaded",
      launchd: {
        loaded: false,
      },
      sync: {
        status: null,
        error_text: "sync unavailable",
      },
      worker: {
        log: { path: "logs/test/worker.jsonl", exists: false, events: [] },
        summary: { has_events: false, in_progress: false },
      },
    }),
  );

  assert.match(output, /STOPPED/);
  assert.match(output, /PROBLEM sync unavailable/);
  assert.match(output, /FAILED sync unavailable/);
  assert.match(output, /no worker events yet/);
  assert.match(output, /worker\.jsonl \(missing\)/);
  assert.doesNotMatch(output, /logs\/test/);
});

test("service status text never exposes an absolute worker log path", () => {
  const output = plain(
    renderServiceStatusText({
      label: "com.example.worker",
      service_state: "running",
      launchd: { loaded: true, state: "running", pid: "123" },
      sync: { status: syncStatusFixture() },
      worker: {
        log: { path: "/private/PRIVATE-SENTINEL/logs/worker.jsonl", exists: true, events: [] },
        summary: workerSummaryFixture(),
      },
      stability: stabilityFixture(),
    }),
  );

  assert.match(output, /Log\s+worker\.jsonl/);
  assert.doesNotMatch(output, /PRIVATE-SENTINEL|\/private\//);
});

test("service status helpers parse launchd and json output", () => {
  assert.deepEqual(parseLaunchdState("state = running\npid = 123\nlast exit code = 0\n"), {
    state: "running",
    pid: "123",
    "last exit code": "0",
  });
  assert.deepEqual(parseJsonOutput({ stdout: "{\"ok\":true}" }), { ok: true });
  assert.equal(parseJsonOutput({ stdout: "not json" }), null);
});

test("freshness requires a bound nonempty sample with a current bounded lease", () => {
  const now = Date.parse("2026-06-20T00:01:00.000Z");
  const base = probeFixture("2026-06-20T00:00:00.000Z");
  const read = (cache, context = probeContext, at = now) => summarizeServiceFreshness(cache, at, undefined, context);
  assert.equal(read(base).status, "sampled");
  assert.equal(read(base).auth_identity, "unknown");
  assert.equal(read(base).sample_count, 3);
  assert.equal(read(base).expires_at, "2026-06-20T00:05:00.000Z");
  assert.equal(read({ ...base, kind: "lark_im_live_probe_cache/v1" }).reason, "legacy_evidence");
  assert.equal(read(base, null).reason, "context_mismatch");
  assert.equal(read(base, { ...probeContext, database_key: "b".repeat(64) }).reason, "context_mismatch");
  assert.equal(read(base, { ...probeContext, source_id: "other" }).reason, "context_mismatch");
  assert.equal(read({ ...base, sample: { remote_messages_checked: 0, probe_errors: 0 } }).reason, "no_usable_sample");
  assert.equal(read({ ...base, sample: { remote_messages_checked: 3, probe_errors: 1 } }).status, "unknown");
  assert.equal(read({ ...base, window: {} }).status, "unknown");
  assert.equal(read({ ...base, missing_count: 1 }).status, "unknown");
  assert.equal(read({ ...base, ok: false }).status, "unknown");
  assert.equal(read(base, probeContext, now - 120000).reason, "invalid_timestamp");
  assert.equal(read(base, probeContext, now + 240000).reason, "expired");
  assert.equal(read({ ...base, expires_at: "2027-01-01T00:00:00.000Z" }, probeContext, now + 240000).reason, "expired");
});

test("launchd missing-service classification requires matching status and diagnostic", () => {
  const absent = 'Could not find service "com.example.worker" in domain for user gui: 501';
  assert.equal(classifyLaunchdPrint(spawnResult()), "loaded");
  assert.equal(classifyLaunchdPrint(spawnResult({ status: 113, stderr: absent })), "absent");
  for (const failure of [
    { status: 1, stderr: absent },
    { status: 113, stderr: "Operation not permitted" },
    { status: 113, stderr: "Could not find domain for user gui: 501" },
    { status: 113, stderr: "" },
    { status: null, signal: "SIGTERM" },
    { status: 0, error: new Error("synthetic spawn failure") },
  ]) assert.equal(classifyLaunchdPrint(spawnResult(failure)), "unknown");
});

test("unavailable launchd inspection is UNKNOWN in report and view, not stopped", () => {
  const report = buildServiceStatusReport(
    { label: "com.example.worker", target: "gui/501/com.example.worker", logDir: "logs/test" },
    {
      runCommand: (cmd) => cmd === "launchctl" ? spawnResult({ status: 1, stderr: "Operation not permitted" }) : spawnResult({ stdout: JSON.stringify(syncStatusFixture()) }),
      readRecentWorkerEvents: () => ({ path: "worker.jsonl", exists: false, events: [] }),
      readLiveProbeCache: () => null,
      liveProbeContext: () => null,
      sqliteJson: () => [],
    },
  );
  assert.equal(report.service_state, "unknown");
  assert.equal(report.launchd.loaded, null);
  assert.equal(report.overview.service.status, "unknown");
  assert.equal(report.overview.health.status, "problem");
  const output = plain(renderServiceStatusText(report));
  assert.match(output, /Service\s+UNKNOWN/);
  assert.match(output, /Loaded\s+UNKNOWN/);
  assert.doesNotMatch(output, /STOPPED|NOT LOADED/);
});

test("foreground leases alone cannot establish activity when background service is stopped", () => {
  const now = Date.parse("2026-06-20T12:00:00.000Z");
  const overview = buildServiceOverview({
    launchd: { loaded: false },
    syncStatus: syncStatusFixture({ health: "syncing", locks: [{ locked_at: "2026-06-20T11:59:00.000Z", expires_at: "2026-06-20T12:01:00.000Z" }] }),
    workerSummary: { has_events: false, in_progress: false },
    nowMs: now,
  });
  assert.equal(overview.service.status, "stopped");
  assert.equal(overview.health.status, "problem");
  assert.equal(overview.activity.status, "unknown");
  assert.match(overview.activity.detail, /phase or owner evidence/);
});

test("expired, malformed, future and hard-expired leases cannot establish activity", () => {
  const now = Date.parse("2026-06-20T12:00:00.000Z");
  const leases = [
    { locked_at: "2026-06-20T11:59:00.000Z", expires_at: "2026-06-20T12:00:00.000Z" },
    { locked_at: "2026-06-20T12:00:01.000Z", expires_at: "2026-06-20T12:01:00.000Z" },
    { locked_at: "invalid", expires_at: "2026-06-20T12:01:00.000Z" },
    { locked_at: "2026-06-20T11:59:00.000Z", expires_at: "invalid" },
    { locked_at: "2026-06-20T11:00:00.000Z", expires_at: "2026-06-20T12:01:00.000Z" },
    { locked_at: "2026-05-18T12:00:00.000Z", expires_at: "2026-06-21T12:00:00.000Z" },
  ];
  for (const lease of leases) {
    const overview = buildServiceOverview({
      launchd: { loaded: true, state: "running" },
      syncStatus: syncStatusFixture({ health: "syncing", locks: [lease] }),
      workerSummary: workerSummaryFixture(),
      nowMs: now,
    });
    assert.equal(overview.activity.status, "unknown");
    assert.equal(overview.health.status, "problem");
    assert.match(overview.health.detail, /no current activity evidence/);
  }
});

test("unfinished steps or running rows without leases never masquerade as active sync", () => {
  const now = Date.parse("2026-06-20T12:00:00.000Z");
  for (const at of ["2026-05-18T12:00:00.000Z", "2026-06-20T11:59:59.000Z"]) {
    const workerSummary = summarizeWorkerEvents([{ type: "lark_im_worker_step", cycle: 91, name: "sent", ok: true, finished_at: at }], now);
    for (const loaded of [true, false]) {
      const overview = buildServiceOverview({
        launchd: { loaded, state: loaded ? "running" : null },
        syncStatus: syncStatusFixture({ health: "syncing", runs: { by_status: { running: 1 } } }),
        workerSummary,
        nowMs: now,
      });
      assert.equal(overview.activity.status, loaded ? "unknown" : "idle");
      assert.notEqual(overview.activity.state, "syncing");
      assert.equal(overview.health.status, "problem");
      assert.equal(workerSummary.last_step.cycle, 91);
    }
  }
  const completed = buildServiceOverview({
    launchd: { loaded: false }, syncStatus: syncStatusFixture(), workerSummary: workerSummaryFixture(), nowMs: now,
  });
  assert.equal(completed.activity.status, "idle");
  const unavailable = buildServiceOverview({
    launchd: { loaded: false }, syncStatus: null, workerSummary: workerSummaryFixture(), nowMs: now,
  });
  assert.equal(unavailable.activity.status, "unknown");
  assert.match(unavailable.activity.detail, /sync status unavailable/);
});

test("catch-up detail does not repeat a stale raw syncing claim", () => {
  const overview = buildServiceOverview({
    launchd: { loaded: true, state: "running" },
    syncStatus: syncStatusFixture({
      health: "syncing", health_detail: "worker is currently syncing",
      scopes: { received_without_cursor: 1 },
    }),
    workerSummary: workerSummaryFixture(),
  });
  assert.equal(overview.health.status, "catching_up");
  assert.equal(overview.activity.status, "unknown");
  assert.equal(overview.health.detail, "known scopes still need catch-up");
});

test("verified current phase permits recovery activity after a failed historical cycle", () => {
  const overview = buildServiceOverview({
    launchd: { loaded: true, state: "running", pid: 123 },
    syncStatus: syncStatusFixture({ health: "syncing", locks: [{ locked_at: "2026-06-20T11:59:00.000Z", expires_at: "2026-06-20T12:01:00.000Z" }] }),
    workerSummary: workerSummaryFixture({ last_cycle: { cycle: 1, ok: false }, in_progress: false }),
    activityEvidence: activePhaseEvidence(Date.parse("2026-06-20T12:00:00.000Z")),
    nowMs: Date.parse("2026-06-20T12:00:00.000Z"),
  });
  assert.equal(overview.health.status, "ok");
  assert.equal(overview.activity.status, "syncing");
  assert.match(overview.health.detail, /does not verify remote freshness/);
});

test("failed sync subprocess cannot establish activity with otherwise valid JSON", () => {
  const report = buildServiceStatusReport(
    { label: "com.example.worker", target: "gui/501/com.example.worker", logDir: "logs/test" },
    {
      runCommand: (cmd) => cmd === "launchctl" ? spawnResult({ stdout: "state = running\n" }) : spawnResult({ status: 1, stdout: JSON.stringify(syncStatusFixture()) }),
      readRecentWorkerEvents: () => ({ path: "worker.jsonl", exists: false, events: [] }),
      readLiveProbeCache: () => null,
      liveProbeContext: () => null,
      sqliteJson: () => [],
    },
  );
  assert.equal(report.sync.status, null);
  assert.equal(report.overview.activity.status, "unknown");
  assert.equal(report.overview.health.status, "problem");
});

test("service evaluates a foreground lease acquired during a slow sync query against the later clock", (t) => {
  const startedAt = Date.parse("2026-06-20T12:00:00.000Z");
  let clockMs = startedAt;
  t.mock.method(Date, "now", () => clockMs);
  const report = buildServiceStatusReport(
    { label: "com.example.worker", target: "gui/501/com.example.worker", logDir: "logs/test" },
    {
      clock: () => clockMs,
      runCommand: (cmd) => {
        if (cmd === "launchctl") return spawnResult({ status: 113, stderr: 'Could not find service "com.example.worker" in domain for user gui: 501' });
        clockMs += 1000;
        return spawnResult({ stdout: JSON.stringify(syncStatusFixture({ health: "syncing", locks: [{
          locked_at: new Date(startedAt + 500).toISOString(), expires_at: new Date(startedAt + 10000).toISOString(),
        }] })) });
      },
      readRecentWorkerEvents: () => ({ path: "worker.jsonl", exists: false, events: [] }),
      readLiveProbeCache: () => null,
      liveProbeContext: () => null,
      sqliteJson: () => [],
    },
  );
  assert.equal(report.overview.service.status, "stopped");
  assert.equal(report.overview.activity.status, "unknown");
  assert.equal(report.overview.leases.occupied_count, 1);
  assert.equal(report.stability.window_started_at, new Date(clockMs - report.stability.window_ms).toISOString());
});

test("service expires a lease that crosses its normal or hard deadline during a slow sync query", (t) => {
  const startedAt = Date.parse("2026-06-20T12:00:00.000Z");
  let clockMs = startedAt;
  t.mock.method(Date, "now", () => clockMs);
  for (const lease of [
    { locked_at: new Date(startedAt - 1000).toISOString(), expires_at: new Date(startedAt + 500).toISOString() },
    { locked_at: new Date(startedAt - 3600000 + 500).toISOString(), expires_at: new Date(startedAt + 10000).toISOString() },
  ]) {
    clockMs = startedAt;
    const report = buildServiceStatusReport(
      { label: "com.example.worker", target: "gui/501/com.example.worker", logDir: "logs/test" },
      {
        clock: () => clockMs,
        runCommand: (cmd) => {
          if (cmd === "launchctl") return spawnResult({ stdout: "state = running\n" });
          clockMs += 1000;
          return spawnResult({ stdout: JSON.stringify(syncStatusFixture({ health: "syncing", locks: [lease] })) });
        },
        readRecentWorkerEvents: () => ({ path: "worker.jsonl", exists: false, events: [] }),
        readLiveProbeCache: () => null,
        liveProbeContext: () => null,
        sqliteJson: () => [],
      },
    );
    assert.equal(report.overview.activity.status, "unknown");
    assert.equal(report.overview.health.status, "problem");
  }
});

test("service reads its evaluation clock after optional evidence queries, while numeric nowMs stays fixed", () => {
  const startedAt = Date.parse("2026-06-20T12:00:00.000Z");
  for (const fixedClock of [false, true]) {
    let clockMs = startedAt;
    const report = buildServiceStatusReport(
      { label: "com.example.worker", target: "gui/501/com.example.worker", logDir: "logs/test" },
      {
        ...(fixedClock ? { nowMs: startedAt } : {}),
        clock: () => clockMs,
        runCommand: (cmd) => cmd === "launchctl" ? spawnResult({ stdout: "state = running\n" }) : spawnResult({ stdout: JSON.stringify(syncStatusFixture({ health: "syncing", locks: [{
          locked_at: new Date(startedAt - 1000).toISOString(), expires_at: new Date(startedAt + 500).toISOString(),
        }] })) }),
        readRecentWorkerEvents: () => ({ path: "worker.jsonl", exists: false, events: [] }),
        readLiveProbeCache: () => null,
        liveProbeContext: () => null,
        sqliteJson: () => { clockMs += 1000; return []; },
      },
    );
    assert.equal(report.overview.activity.status, "unknown");
    assert.equal(report.overview.leases.occupied_count, fixedClock ? 1 : 0);
    assert.equal(report.stability.window_started_at, new Date((fixedClock ? startedAt : clockMs) - report.stability.window_ms).toISOString());
  }
});

test("pending message details prevent service health from claiming completion even during active sync", () => {
  const nowMs = Date.parse("2026-06-20T12:00:00.000Z");
  for (const health of ["ok", "ok_with_history", "syncing", "catching_up"]) {
    const overview = buildServiceOverview({
      launchd: { loaded: true, state: "running", pid: 123 },
      syncStatus: syncStatusFixture({
        health, health_detail: "all known enabled scopes have cursors", details: { pending_count: 2 },
        locks: [{ locked_at: "2026-06-20T11:59:00.000Z", expires_at: "2026-06-20T12:01:00.000Z" }],
      }),
      workerSummary: workerSummaryFixture(),
      nowMs,
      activityEvidence: activePhaseEvidence(nowMs),
    });
    assert.equal(overview.health.status, "catching_up");
    assert.equal(overview.health.detail, "2 message details await retry");
    assert.equal(overview.activity.status, "syncing");
  }
  const complete = buildServiceOverview({
    launchd: { loaded: true, state: "running" }, syncStatus: syncStatusFixture({ details: { pending_count: 0 } }),
    workerSummary: workerSummaryFixture(), nowMs,
  });
  assert.equal(complete.health.status, "ok");
});
