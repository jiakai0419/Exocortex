import assert from "node:assert/strict";
import test from "node:test";

import { plain } from "../dist/terminal/index.js";
import {
  parseArgs,
  runSyncStatusCli,
} from "../src/cli/sync-status-command.mjs";
import { buildStatus } from "../src/diagnostics/sync-status-report.mjs";
import { renderSyncStatusText as renderText } from "../src/terminal/sync-status-view.mjs";

function memoryWriter() {
  let text = "";
  return {
    stream: {
      write(chunk) {
        text += String(chunk);
      },
    },
    text: () => text,
  };
}

function statusFixture(overrides = {}) {
  return {
    db_path: "/abs/exocortex.sqlite",
    records: {
      total: 3,
      latest_ms: Date.parse("2026-06-20T00:00:00.000Z"),
      by_direction: [
        { direction: "received", count: 2, latest_ms: Date.parse("2026-06-20T00:00:00.000Z") },
        { direction: "sent", count: 1, latest_ms: Date.parse("2026-06-19T23:59:00.000Z") },
      ],
    },
    scopes: {
      total: 4,
      enabled: 3,
      received_enabled: 2,
      received_without_cursor: 0,
      received_unsupported: 1,
      unsupported_reasons: [
        {
          reason: "bot_user_out_of_chat",
          lark_cli_error_code: "230002",
          lark_cli_error_message: "Bot/User can NOT be out of the chat.",
          count: 1,
        },
      ],
    },
    discovery: {
      cursor: { has_more: false, pages_scanned: 7 },
      cursor_updated_at: "2026-06-20T00:00:01.000Z",
      complete: true,
    },
    hot_discovery: {
      cursor: { page_token: "next" },
      cursor_updated_at: "2026-06-20T00:01:00.000Z",
      last_success_run_id: 11,
      ran: true,
    },
    reconcile: {
      cursor: { has_more: true, pages_scanned: 2 },
      cursor_updated_at: "2026-06-20T00:02:00.000Z",
      complete: false,
    },
    runs: {
      by_status: { failed: 1, succeeded: 8 },
      recent: [
        {
          id: 12,
          scope_id: "lark.im.received.chat.1",
          status: "failed",
          error_type: "api",
          failure_kind: "rate_limited",
        },
        { id: 11, scope_id: "lark.im.sent", status: "succeeded" },
      ],
    },
    locks: [],
    recovery: { recovered_locks: 1, cancelled_runs: 0, active_expired_locks: 0 },
    health: "ok_with_history",
    health_detail: "all known enabled scopes have cursors",
    ...overrides,
  };
}

test("sync status command renders help without touching dependencies", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const exitCode = runSyncStatusCli(["--help"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    deps: {
      existsSync: () => {
        throw new Error("should not check db");
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.text(), /Usage: node scripts\/sync-status\.mjs/);
  assert.equal(stderr.text(), "");
});

test("sync status command emits injected status as json", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const calls = [];
  const exitCode = runSyncStatusCli(["--db", "custom.sqlite", "--format", "json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    deps: {
      resolvePath: (dbPath) => `/abs/${dbPath}`,
      existsSync: (dbPath) => {
        calls.push(["exists", dbPath]);
        return true;
      },
      buildStatus: (dbPath) => {
        calls.push(["build", dbPath]);
        return statusFixture({ db_path: dbPath, health: "ok" });
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.text(), "");
  const payload = JSON.parse(stdout.text());
  assert.equal(payload.db_path, "/abs/custom.sqlite");
  assert.equal(payload.health, "ok");
  assert.deepEqual(calls, [
    ["exists", "/abs/custom.sqlite"],
    ["build", "/abs/custom.sqlite"],
  ]);
});

test("sync status command reports missing database as a terminal error", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const exitCode = runSyncStatusCli(["--db", "missing.sqlite"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    deps: {
      resolvePath: (dbPath) => `/abs/${dbPath}`,
      existsSync: () => false,
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.text(), "");
  assert.match(plain(stderr.text()), /database not found: \/abs\/missing\.sqlite/);
});

test("renderText shows summary, unsupported reasons, recovery, and recent failures", () => {
  const output = plain(renderText(statusFixture()));

  assert.match(output, /Exocortex sync status/);
  assert.match(output, /Records\s+3 total, 1 sent, 2 received/);
  assert.match(output, /Unsupported reasons/);
  assert.match(output, /230002: Bot\/User can NOT be out of the chat\./);
  assert.match(output, /Recovery/);
  assert.match(output, /Recent non-success runs/);
  assert.match(output, /#12 FAILED \[rate_limited\] lark\.im\.received\.chat\.1: api/);
});

test("buildStatus assembles sqlite rows, recovery, and health detail", () => {
  const calls = [];
  const status = buildStatus("/abs/db.sqlite", {
    recoverStaleSyncState: (dbPath) => {
      calls.push(["recover", dbPath]);
      return { recovered_locks: 0, cancelled_runs: 0, active_expired_locks: 0 };
    },
    sqliteJson: (dbPath, _sql, label) => {
      calls.push([label, dbPath]);
      if (label === "read record totals") {
        return [{ count: 3, latest_ms: Date.parse("2026-06-20T00:00:00.000Z") }];
      }
      if (label === "read direction totals") {
        return [
          { direction: "received", count: 2, latest_ms: Date.parse("2026-06-20T00:00:00.000Z") },
          { direction: "sent", count: 1, latest_ms: Date.parse("2026-06-19T23:59:00.000Z") },
        ];
      }
      if (label === "read scope totals") {
        return [
          {
            total: 4,
            enabled: 3,
            received_enabled: 2,
            received_without_cursor: 1,
            received_unsupported: 1,
          },
        ];
      }
      if (label === "read unsupported scope reasons") {
        return [{ reason: "restricted_mode", lark_cli_error_code: "", lark_cli_error_message: "", count: 1 }];
      }
      if (label === "read discovery scope") {
        return [
          {
            cursor_json: JSON.stringify({ has_more: false, pages_scanned: 7 }),
            cursor_updated_at: "2026-06-20T00:00:01.000Z",
            last_success_run_id: 10,
          },
        ];
      }
      if (label === "read hot discovery scope") {
        return [{ cursor_json: null, last_success_run_id: 11 }];
      }
      if (label === "read reconcile scope") {
        return [
          {
            cursor_json: JSON.stringify({ has_more: true, pages_scanned: 2 }),
            cursor_updated_at: "2026-06-20T00:02:00.000Z",
          },
        ];
      }
      if (label === "read run counts") {
        return [{ status: "failed", count: 1 }];
      }
      if (label === "read recent runs") {
        return [
          {
            id: 12,
            scope_id: "scope",
            status: "failed",
            error_message: '{"error":{"type":"api","code":9499,"message":"too many request"}}',
          },
        ];
      }
      if (label === "read locks") return [];
      throw new Error(`unexpected query: ${label}`);
    },
  });

  assert.equal(status.db_path, "/abs/db.sqlite");
  assert.equal(status.records.total, 3);
  assert.equal(status.discovery.complete, true);
  assert.equal(status.reconcile.complete, false);
  assert.equal(status.health, "catching_up");
  assert.equal(status.health_detail, "initial catch-up: 1 chat scopes need cursors");
  assert.equal(status.runs.recent[0].failure_kind, "rate_limited");
  assert.equal(status.runs.recent[0].transient, true);
  assert.equal(status.runs.recent[0].error_code, 9499);
  assert.deepEqual(calls[0], ["recover", "/abs/db.sqlite"]);
});

test("parseArgs validates format and missing values", () => {
  assert.deepEqual(parseArgs(["--format", "json"]), { db: "data/exocortex.sqlite", format: "json" });
  assert.throws(() => parseArgs(["--format", "yaml"]), /--format must be text or json/);
  assert.throws(() => parseArgs(["--db"]), /--db requires a value/);
});
