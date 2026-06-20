import assert from "node:assert/strict";
import test from "node:test";

import { plain } from "../dist/terminal/index.js";
import {
  buildServiceStatusReport,
  buildServiceOverview,
  parseJsonOutput,
  parseLaunchdState,
} from "../src/diagnostics/lark-im-service-report.mjs";
import { renderServiceStatusText } from "../src/terminal/lark-im-service-view.mjs";

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

test("service status report parses launchd, sync status, and worker log summary", () => {
  const calls = [];
  const workerEvents = [{ type: "lark_im_worker_cycle", cycle: 12, ok: true }];
  const report = buildServiceStatusReport(
    { label: "com.example.worker", target: "gui/501/com.example.worker", logDir: "logs/test" },
    {
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
  assert.equal(report.overview.activity.status, "idle");
  assert.equal(report.overview.freshness.status, "unknown");
  assert.equal(report.worker.log.exists, true);
  assert.equal(report.worker.summary.last_cycle.cycle, 12);
  assert.deepEqual(calls, [
    ["launchctl", "print", "gui/501/com.example.worker"],
    [process.execPath, "scripts/sync-status.mjs", "--format", "json"],
  ]);
});

test("service status report preserves not-loaded and sync-unavailable states", () => {
  const report = buildServiceStatusReport(
    { label: "com.example.worker", target: "gui/501/com.example.worker", logDir: "logs/test" },
    {
      runCommand: (cmd) => {
        if (cmd === "launchctl") {
          return spawnResult({ status: 113, stderr: "Could not find service" });
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
    },
  );

  assert.equal(report.service_state, "not loaded");
  assert.equal(report.launchd.loaded, false);
  assert.equal(report.overview.service.status, "stopped");
  assert.equal(report.overview.health.status, "problem");
  assert.equal(report.overview.activity.status, "idle");
  assert.equal(report.sync.status, null);
  assert.match(report.sync.error_text, /sync unavailable/);
  assert.equal(report.worker.log.exists, false);
});

test("service overview separates service, health, activity, and freshness", () => {
  const overview = buildServiceOverview({
    launchd: { loaded: true, state: "running", pid: "123" },
    syncStatus: syncStatusFixture({
      health: "syncing",
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
    liveProbe: { status: "healthy", ok: true, missing_count: 0, lag_ms: 0 },
  });

  assert.equal(overview.service.status, "running");
  assert.equal(overview.health.status, "ok");
  assert.equal(overview.health.detail, "all known enabled scopes have cursors");
  assert.equal(overview.activity.status, "syncing");
  assert.equal(overview.freshness.status, "verified");
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
  assert.equal(overview.activity.status, "idle");
  assert.equal(overview.freshness.status, "unknown");
});

test("service overview can show sync activity from locks without claiming worker log progress", () => {
  const overview = buildServiceOverview({
    launchd: { loaded: true, state: "running", pid: "123" },
    syncStatus: syncStatusFixture({ health: "syncing" }),
    workerSummary: workerSummaryFixture({ in_progress: false }),
  });

  assert.equal(overview.health.status, "ok");
  assert.equal(overview.activity.status, "syncing");
  assert.equal(overview.activity.detail, "sync lock or run active");
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
    }),
  );

  assert.match(output, /Lark IM service/);
  assert.match(output, /Overview/);
  assert.match(output, /Service\s+RUNNING/);
  assert.match(output, /Health\s+OK all known enabled scopes have cursors/);
  assert.match(output, /Activity\s+IDLE/);
  assert.match(output, /Freshness\s+UNKNOWN no cached live probe/);
  assert.doesNotMatch(output, /OK_WITH_HISTORY/);
  assert.match(output, /LaunchAgent/);
  assert.match(output, /Records\s+3 total, 1 sent, 2 received/);
  assert.match(output, /Unsupported scopes\s+1 total/);
  assert.match(output, /restricted_mode/);
  assert.match(output, /Worker/);
  assert.match(output, /received-catchup/);
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
  assert.match(output, /logs\/test\/worker\.jsonl \(missing\)/);
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
