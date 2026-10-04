import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { plain } from "../dist/terminal/index.js";
import {
  parseArgs,
  runSyncStatusCli,
} from "../src/cli/sync-status-command.mjs";
import { buildStatus, sanitizeStatusReportForPublicOutput } from "../src/diagnostics/sync-status-report.mjs";
import { renderSyncStatusText as renderText } from "../src/terminal/sync-status-view.mjs";
import { ensureInitialized, quoteSql } from "../dist/storage/sqlite/ingestion-store.js";

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
  const privateSentinel = "PRIVATE_STATUS_SENTINEL";
  const privateId = `scope_${"x".repeat(80)}`;
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
        return statusFixture({
          db_path: dbPath,
          health: "ok",
          discovery: { cursor: { has_more: false, page_token: privateSentinel }, complete: true },
          runs: {
            by_status: { failed: 1 },
            recent: [{ status: "failed", scope_id: privateId, error_message: privateSentinel }],
          },
          locks: [{ scope_id: privateId, locked_by: privateSentinel }],
        });
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.text(), "");
  const payload = JSON.parse(stdout.text());
  assert.equal(payload.db_path, undefined);
  assert.equal(stdout.text().includes("/abs/custom.sqlite"), false);
  assert.doesNotMatch(stdout.text(), new RegExp(privateSentinel));
  assert.doesNotMatch(stdout.text(), new RegExp(privateId));
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
  assert.match(plain(stderr.text()), /database not found/);
  assert.doesNotMatch(stderr.text(), /\/abs\/missing\.sqlite/);
});

test("renderText shows summary, unsupported reasons, recovery, and recent failures", () => {
  const output = plain(renderText(statusFixture()));

  assert.match(output, /Exocortex sync status/);
  assert.match(output, /Records\s+3 total, 1 sent, 2 received/);
  assert.match(output, /Unsupported reasons/);
  assert.match(output, /code 230002/);
  assert.doesNotMatch(output, /Recovery/);
  assert.match(output, /Recent non-success runs/);
  assert.match(output, /FAILED \[rate_limited\]/);
  assert.doesNotMatch(output, /lark\.im\.received\.chat\.1/);
});

test("buildStatus assembles rows without performing recovery", () => {
  const calls = [];
  const status = buildStatus("/abs/db.sqlite", {
    recoverStaleSyncState: (dbPath) => {
      throw new Error("read-only status must not recover");
    },
    sqliteJson: (dbPath, _sql, label) => {
      calls.push([label, dbPath]);
      if (label === "read detail progress schema") return [];
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
            message_enabled: 3,
            message_without_success: 0,
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
        return [{ cursor_json: null, has_success: 1 }];
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
        return [{ status: "failed", count: 1 }, { status: "succeeded", count: 1 }];
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

  assert.equal(status.db_path, undefined);
  assert.equal(status.records.total, 3);
  assert.equal(status.discovery.complete, true);
  assert.equal(status.reconcile.complete, false);
  assert.equal(status.health, "catching_up");
  assert.equal(status.health_detail, "initial catch-up: 1 chat scopes need cursors");
  assert.equal(status.runs.recent[0].failure_kind, "rate_limited");
  assert.equal(status.runs.recent[0].transient, true);
  assert.equal(status.runs.recent[0].error_code, 9499);
  assert.equal(calls.some(([label]) => label === "recover"), false);
  assert.equal(status.recovery.performed, false);
  assert.equal(status.details.evidence, "legacy_unavailable");
  assert.equal(status.details.pending_count, null);
});

function detailFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "exocortex-detail-status-synthetic-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, "synthetic.sqlite");
  ensureInitialized(db);
  const sql = (input) => {
    const result = spawnSync("sqlite3", [db], { input: `.bail on\n${input}`, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  const scope = "lark.im.received.chat.generated-status-scope";
  const hidden = "GENERATED_PRIVATE_DETAIL_STATE";
  const cursor = JSON.stringify({ kind: "time_message_cursor/v1", created_at_ms: 1_920_000_000_000 });
  sql(`INSERT INTO sync_scopes(id,source_id,name) VALUES (${quoteSql(scope)},'lark.im','generated active scope');
    INSERT INTO sync_scopes(id,source_id,name,enabled) VALUES (${quoteSql(scope + '-disabled')},'lark.im','generated disabled scope',0);
    INSERT INTO sync_runs(source_id,scope_id,status) VALUES ('lark.im','lark.im.sent_by_me','succeeded');
    UPDATE sync_scopes SET last_success_run_id=last_insert_rowid(),cursor_json=${quoteSql(cursor)} WHERE id='lark.im.sent_by_me';
    INSERT INTO sync_runs(source_id,scope_id,status) VALUES ('lark.im',${quoteSql(scope)},'succeeded');
    UPDATE sync_scopes SET last_success_run_id=last_insert_rowid(),cursor_json=${quoteSql(cursor)} WHERE id=${quoteSql(scope)};
    UPDATE sync_scopes SET cursor_json='{"has_more":false}' WHERE id='lark.im.unmuted_chat_discovery';
    INSERT INTO lark_im_list_progress(scope_id,cursor_json,coverage_start_ms,generation,scope_config_json,updated_at)
      VALUES ('lark.im.sent_by_me',${quoteSql(cursor)},1919999940000,1,'{}','2001-01-01T00:00:00.000Z');
    INSERT INTO lark_im_detail_tasks(scope_id,message_id,raw_root_json,fingerprint,occurred_at_ms,status,retry_at,created_at,updated_at,last_error_message)
      VALUES ('lark.im.sent_by_me','generated-root',${quoteSql(JSON.stringify({ hidden }))},'generated-hash',1919999940000,'pending','2001-01-01T00:00:00.000Z','2001-01-01T00:00:00.000Z','2001-01-01T00:00:00.000Z',${quoteSql(hidden)}),
      (${quoteSql(scope)},'generated-complete','{}','generated-complete-hash',1919999940000,'complete','2001-01-01T00:00:00.000Z','2001-01-01T00:00:00.000Z','2001-01-01T00:00:00.000Z',NULL),
      (${quoteSql(scope + '-disabled')},'generated-disabled','{}','generated-disabled-hash',1919999940000,'pending','2001-01-01T00:00:00.000Z','2001-01-01T00:00:00.000Z','2001-01-01T00:00:00.000Z',NULL);`);
  return { db, sql, hidden, scope };
}

test("status reports separate list progress and due detail debt without leaking payloads or writing", (t) => {
  const { db, hidden, scope } = detailFixture(t);
  const before = readFileSync(db);
  const status = buildStatus(db);
  assert.equal(status.health, "catching_up");
  assert.deepEqual(status.details, { evidence: "available", pending_count: 1, due_count: 1, scopes_pending: 1,
    oldest_pending_ms: 1_919_999_940_000, next_retry_at: "2001-01-01T00:00:00.000Z" });
  assert.deepEqual(status.list_progress, { evidence: "available", scopes: 1,
    oldest_cursor_ms: 1_920_000_000_000, invalid_cursor_scopes: 0 });
  const output = JSON.stringify(status) + plain(renderText(status));
  for (const value of [db, hidden, scope, "generated-root", "generated-hash"]) assert.equal(output.includes(value), false);
  assert.match(output, /1 pending, 1 due for retry/);
  assert.match(output, /List progress/);
  assert.deepEqual(readFileSync(db), before);
});

test("legacy status stays explicit and partial or unreadable new detail schemas fail closed", (t) => {
  const { db, sql } = detailFixture(t);
  sql("DROP TABLE lark_im_detail_tasks;");
  assert.throws(() => buildStatus(db), /schema is incomplete/);
  sql("CREATE TABLE lark_im_detail_tasks(unrelated TEXT);");
  assert.throws(() => buildStatus(db), /read pending detail totals failed/);
  sql("DROP TABLE lark_im_detail_tasks; DROP TABLE lark_im_list_progress;");
  assert.throws(() => buildStatus(db), /schema is incomplete/);
  sql("DELETE FROM schema_migrations WHERE version='009';");
  const before = readFileSync(db);
  const status = buildStatus(db);
  assert.equal(status.health, "ok");
  assert.equal(status.details.evidence, "legacy_unavailable");
  assert.equal(status.details.pending_count, null);
  assert.equal(status.list_progress.scopes, null);
  assert.match(plain(renderText(status)), /unavailable \(legacy database\)/);
  assert.deepEqual(readFileSync(db), before);
});

test("public status sanitization cannot retain stale okay health when detail debt is present", () => {
  const status = sanitizeStatusReportForPublicOutput(statusFixture({ health: "ok",
    details: { evidence: "available", pending_count: 3, due_count: 1, scopes_pending: 1, raw_root_json: "PRIVATE" } }));
  assert.equal(status.health, "catching_up");
  assert.match(status.health_detail, /3 message details await retry/);
  assert.equal(status.details.raw_root_json, undefined);
  assert.equal(sanitizeStatusReportForPublicOutput(statusFixture({
    details: { evidence: "available", pending_count: null },
  })).health, "needs_attention");
  const invalidList = sanitizeStatusReportForPublicOutput(statusFixture({
    list_progress: { evidence: "available", scopes: 1, invalid_cursor_scopes: 1 },
  }));
  assert.equal(invalidList.health, "needs_attention");
  assert.match(invalidList.health_detail, /list progress evidence is unavailable/);
});

test("parseArgs validates format and missing values", () => {
  assert.deepEqual(parseArgs(["--format", "json"]), { db: "data/exocortex.sqlite", format: "json" });
  assert.throws(() => parseArgs(["--format", "yaml"]), /--format must be text or json/);
  assert.throws(() => parseArgs(["--db"]), /--db requires a value/);
});
