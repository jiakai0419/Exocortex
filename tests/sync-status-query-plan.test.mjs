import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildStatus } from "../src/diagnostics/sync-status-report.mjs";
import { readOnlySqliteJson } from "../src/storage/sqlite/readonly-query.mjs";
import { ensureInitialized, sqliteExec } from "../dist/storage/sqlite/ingestion-store.js";

const START = Date.parse("2020-02-03T00:00:00.000Z");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const cursor = (value) => JSON.stringify({ kind: "time_message_cursor/v1", created_at_ms: value });

function seed(db) {
  ensureInitialized(db);
  const list = {
    adapter: "lark.im.sent_by_me", initial_sync_start_ms: START,
    __run_fence: { list_generation: 3, scope_config: { chat_id: null } },
    list_complete: true, details_complete: false, window_complete: false, pending_detail_count: 1,
    list_window_start_ms: START, list_window_end_ms: START + 119999,
  };
  const closure = {
    adapter: "lark.im.details", detail_retry: true,
    __run_fence: { list_generation: 4, scope_config: { chat_id: null } },
    coverage_mode: "list_checkpoint_and_details", list_complete: true, details_complete: true,
    window_complete: true, pending_detail_count: 0, window_start_ms: START, window_end_ms: START + 60000,
    window_start: new Date(START).toISOString(), window_end: new Date(START + 60000).toISOString(),
  };
  sqliteExec(db, `WITH RECURSIVE ids(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM ids WHERE id<201)
    INSERT INTO sync_runs(id,source_id,scope_id,status,started_at,finished_at,cursor_before_json,error_type,metadata_json)
    SELECT id,'lark.im','lark.im.sent_by_me','failed','2020-03-01T00:00:00.000Z','2020-03-01T00:00:01.000Z',
      ${quote(cursor(START))},'LarkDetailIncomplete',${quote(JSON.stringify(list))} FROM ids;
    INSERT INTO sync_runs(id,source_id,scope_id,status,started_at,finished_at,cursor_before_json,cursor_after_json,metadata_json)
    VALUES(202,'lark.im','lark.im.sent_by_me','succeeded','2020-03-01T00:00:02.000Z','2020-03-01T00:00:03.000Z',
      ${quote(cursor(START))},${quote(cursor(START + 60000))},${quote(JSON.stringify(closure))});
    UPDATE sync_scopes SET last_success_run_id=202,cursor_json=${quote(cursor(START + 60000))} WHERE id='lark.im.sent_by_me';
    UPDATE sync_scopes SET cursor_json='{"has_more":false}' WHERE id='lark.im.unmuted_chat_discovery';`);
}

test("the actual status snapshot emits bounded proof cells at the legacy history cap", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-status-query-plan-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, "synthetic.sqlite");
  seed(db);
  let snapshotCount = 0;
  let proofRows = 0;
  let largestProofCell = 0;
  const report = buildStatus(db, { sqliteJson(path, sql, label) {
    if (label !== "read sync status snapshot") return readOnlySqliteJson(path, sql, label);
    snapshotCount += 1;
    const rows = readOnlySqliteJson(path, sql, label);
    // SQLite's CLI JSON formatter is slow for one enormous rows_json string.
    // VM-instruction counts do not include this output cost. Check the actual
    // wire payload boundary instead of machine-dependent wall-clock timing or
    // a particular CTE/query-plan spelling.
    for (const [section, expected] of [["read recent runs", 10], ["read failed run transitions", 200]]) {
      const chunks = rows.filter((row) => row.section === section);
      assert.equal(chunks.length, expected, `${section} must emit one bounded cell per retained run`);
      const ids = new Set();
      for (const chunk of chunks) {
        const values = JSON.parse(chunk.rows_json);
        assert.equal(values.length, 1, `${section} must not aggregate all run evidence into a large JSON cell`);
        assert.ok(!ids.has(values[0].id), "chunking must not duplicate retained runs");
        ids.add(values[0].id);
        largestProofCell = Math.max(largestProofCell, Buffer.byteLength(chunk.rows_json));
        proofRows += 1;
      }
    }
    return rows;
  } });
  assert.equal(snapshotCount, 1, "payload boundaries and semantics must use the same actual snapshot SQL");
  assert.deepEqual(report.runs.by_status, { succeeded: 1, failed: 201 });
  assert.deepEqual(report.runs.transitions, { resolved: 200, unresolved: 0, unknown: 1 });
  assert.equal(report.runs.actionable_failed_runs, 1);
  assert.equal(report.details.pending_count, 0);
  assert.equal(report.health, "ok_with_history", "unexamined history must remain actionable");
  assert.equal(proofRows, 210);
  assert.ok(largestProofCell < 64 * 1024, "ordinary proof cells stay small enough for the CLI JSON formatter");
  t.diagnostic(`201 legacy rows: ${proofRows} proof cells; largest ${largestProofCell} bytes`);
});
