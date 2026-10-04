import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { plain } from "../dist/terminal/index.js";
import { buildStatus, sanitizeStatusReportForPublicOutput, sqliteJson as readStatusRows } from "../src/diagnostics/sync-status-report.mjs";
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

test("buildStatus assembles one tagged snapshot without performing recovery", () => {
  const calls = [];
  const sections = {
    "read detail progress schema": [],
    "read detail progress migration": [],
    "read record totals": [{ count: 3, latest_ms: Date.parse("2026-06-20T00:00:00.000Z") }],
    "read direction totals": [
      { direction: "received", count: 2, latest_ms: Date.parse("2026-06-20T00:00:00.000Z") },
      { direction: "sent", count: 1, latest_ms: Date.parse("2026-06-19T23:59:00.000Z") },
    ],
    "read scope totals": [{ total: 4, enabled: 3, received_enabled: 2, message_enabled: 3,
      message_without_success: 0, received_without_cursor: 1, received_unsupported: 1 }],
    "read unsupported scope reasons": [{ reason: "restricted_mode", lark_cli_error_code: "", count: 1 }],
    "read discovery scope": [{ cursor_json: JSON.stringify({ has_more: false, pages_scanned: 7 }),
      cursor_updated_at: "2026-06-20T00:00:01.000Z", has_success: 1 }],
    "read hot discovery scope": [{ cursor_json: null, has_success: 1 }],
    "read reconcile scope": [{ cursor_json: JSON.stringify({ has_more: true, pages_scanned: 2 }),
      cursor_updated_at: "2026-06-20T00:02:00.000Z" }],
    "read run counts": [{ status: "failed", count: 1 }, { status: "succeeded", count: 1 }],
    "read recent runs": [{ status: "failed",
      error_message: '{"error":{"type":"api","code":9499,"message":"too many request"}}' }],
    "read locks": [],
  };
  const status = buildStatus("/abs/db.sqlite", {
    recoverStaleSyncState: () => { throw new Error("read-only status must not recover"); },
    sqliteJson: (dbPath, _sql, label) => {
      calls.push([label, dbPath]);
      if (label === "read detail progress schema") return sections[label];
      if (label === "read sync status snapshot") return Object.entries(sections)
        .map(([section, rows]) => ({ section, rows_json: JSON.stringify(rows) }));
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
  assert.deepEqual(calls, [["read detail progress schema", "/abs/db.sqlite"],
    ["read sync status snapshot", "/abs/db.sqlite"]]);
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
  assert.throws(() => buildStatus(db), /read sync status snapshot failed/);
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


test("public discovery completion preserves the snapshot finish time without exposing cursor identities", () => {
  const completed = "2026-08-05T13:24:00+08:00";
  const updated = "2026-08-06T05:24:00.000Z";
  const marker = "GENERATED_PRIVATE_DISCOVERY_MARKER";
  const status = sanitizeStatusReportForPublicOutput(statusFixture({
    discovery: { complete: true, cursor_updated_at: updated, cursor: {
      has_more: false, pages_scanned: 80, completed_at: completed,
      snapshot_id: marker, page_token: marker, chat_id: marker,
    } },
    reconcile: { complete: true, cursor_updated_at: updated, cursor: {
      has_more: false, pages_scanned: 80, completed_at: completed,
      snapshot_id: marker, page_token: marker, chat_id: marker,
    } },
  }));
  for (const section of [status.discovery, status.reconcile]) {
    assert.deepEqual(section.cursor, { has_more: false, pages_scanned: 80,
      completed_at: "2026-08-05T05:24:00.000Z" });
    assert.equal(section.cursor_updated_at, updated);
    assert.notEqual(section.cursor.completed_at, section.cursor_updated_at);
  }
  assert.doesNotMatch(JSON.stringify(status), new RegExp(marker));
});

test("public discovery completion keeps legacy absence and rejects invalid timestamp evidence", () => {
  const legacy = sanitizeStatusReportForPublicOutput(statusFixture({
    reconcile: { complete: true, cursor_updated_at: "2026-08-06T05:24:00.000Z",
      cursor: { has_more: false, pages_scanned: 80 } },
  }));
  assert.equal(Object.hasOwn(legacy.reconcile.cursor, "completed_at"), false);
  for (const completed of [null, undefined, "", "GENERATED_PRIVATE_BAD_COMPLETION", 1e30, "999999999999999999999"]) {
    const status = sanitizeStatusReportForPublicOutput(statusFixture({
      reconcile: { complete: true, cursor_updated_at: "2026-08-06T05:24:00.000Z",
        cursor: { has_more: false, pages_scanned: 80, completed_at: completed } },
    }));
    assert.equal(status.reconcile.cursor.completed_at, null);
    assert.doesNotMatch(JSON.stringify(status), /GENERATED_PRIVATE_BAD_COMPLETION/);
  }
});

test("status validates migration evidence in the report snapshot after legacy preflight", (t) => {
  const { db, sql } = detailFixture(t);
  sql("DROP TABLE lark_im_detail_tasks; DROP TABLE lark_im_list_progress; DELETE FROM schema_migrations WHERE version='009';");
  assert.equal(buildStatus(db).details.evidence, "legacy_unavailable");
  let changed = false;
  assert.throws(() => buildStatus(db, {
    sqliteJson: (path, query, label) => {
      const rows = readStatusRows(path, query, label);
      if (label === "read detail progress schema") {
        // The relevant sqlite_schema names and SQL are unchanged. A separate
        // reader for migration metadata could incorrectly keep the old verdict.
        sql("INSERT INTO schema_migrations(version,name) VALUES('009','generated-marker-race');");
        changed = true;
      }
      return rows;
    },
  }), /schema is incomplete/);
  assert.equal(changed, true);
});

test("status rejects changed schema definitions even when preflight table names still match", (t) => {
  const { db, sql } = detailFixture(t);
  let changed = false;
  assert.throws(() => buildStatus(db, {
    sqliteJson: (path, query, label) => {
      const rows = readStatusRows(path, query, label);
      if (label === "read detail progress schema") {
        sql("ALTER TABLE schema_migrations ADD COLUMN generated_snapshot_marker TEXT;");
        changed = true;
      }
      return rows;
    },
  }), /schema changed during status collection/);
  assert.equal(changed, true);
});

test("missing, repeated or malformed snapshot sections cannot become an okay report", (t) => {
  const { db } = detailFixture(t);
  const changeDetailRows = (rows, rowsJson) => rows.map((row) => row.section === "read pending detail totals"
    ? { ...row, rows_json: rowsJson } : row);
  const cases = [
    ["empty snapshot", () => []],
    ["missing detail evidence", (rows) => rows.filter((row) => row.section !== "read pending detail totals")],
    ["missing run evidence", (rows) => rows.filter((row) => row.section !== "read run counts")],
    ["repeated detail evidence", (rows) => [...rows, rows.find((row) => row.section === "read pending detail totals")]],
    ["unknown section", (rows) => [...rows, { section: "generated unknown section", rows_json: "[]" }]],
    ["invalid JSON", (rows) => changeDetailRows(rows, "GENERATED_PRIVATE_INVALID_JSON")],
    ["non-array JSON", (rows) => changeDetailRows(rows, "{}")],
    ["null row", (rows) => changeDetailRows(rows, "[null]")],
    ["array row", (rows) => changeDetailRows(rows, "[[]]")],
    ["empty required aggregate", (rows) => changeDetailRows(rows, "[]")],
    ["multiple aggregate rows", (rows) => changeDetailRows(rows, "[{},{}]")],
  ];
  const before = readFileSync(db);
  for (const [name, mutate] of cases) {
    let mutated = false;
    assert.throws(() => buildStatus(db, {
      sqliteJson: (path, query, label) => {
        const rows = readStatusRows(path, query, label);
        if (label !== "read sync status snapshot") return rows;
        mutated = true;
        return mutate(rows);
      },
    }), (error) => {
      assert.match(error.message, /sync status snapshot returned (?:invalid|incomplete)/, name);
      assert.doesNotMatch(error.message, /GENERATED_PRIVATE/);
      return true;
    }, name);
    assert.equal(mutated, true, name);
  }
  assert.deepEqual(readFileSync(db), before);
});

test("malformed aggregate values stay unavailable rather than becoming an empty detail backlog", (t) => {
  const { db } = detailFixture(t);
  const report = buildStatus(db, {
    sqliteJson: (path, query, label) => {
      const rows = readStatusRows(path, query, label);
      if (label !== "read sync status snapshot") return rows;
      return rows.map((row) => row.section === "read pending detail totals"
        ? { ...row, rows_json: JSON.stringify([{ pending_count: null, scopes_pending: 1, due_count: 1 }]) } : row);
    },
  });
  assert.equal(report.health, "needs_attention");
  assert.equal(report.details.evidence, "unavailable");
  assert.equal(report.details.pending_count, null);
});
