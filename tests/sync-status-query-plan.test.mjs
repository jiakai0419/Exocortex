import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildStatus } from "../src/diagnostics/sync-status-report.mjs";
import { LEGACY_TRANSITION_SQL, runEvidenceSql } from "../src/diagnostics/lark-run-progress.mjs";
import { readOnlySqliteJson } from "../src/storage/sqlite/readonly-query.mjs";
import { ensureInitialized, sqliteExec } from "../dist/storage/sqlite/ingestion-store.js";

const START = Date.parse("2020-02-03T00:00:00.000Z");
const CUTOFF = Date.parse("2030-03-01T00:00:00.000Z");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const cursor = (value) => JSON.stringify({ kind: "time_message_cursor/v1", created_at_ms: value });

function seed(db, failedRuns = 201) {
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
  sqliteExec(db, `WITH RECURSIVE ids(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM ids WHERE id<${failedRuns})
    INSERT INTO sync_runs(id,source_id,scope_id,status,started_at,finished_at,cursor_before_json,error_type,metadata_json)
    SELECT id,'lark.im','lark.im.sent_by_me','failed','2020-03-01T00:00:00.000Z','2020-03-01T00:00:01.000Z',
      ${quote(cursor(START))},'LarkDetailIncomplete',${quote(JSON.stringify(list))} FROM ids;
    INSERT INTO sync_runs(id,source_id,scope_id,status,started_at,finished_at,cursor_before_json,cursor_after_json,metadata_json)
    VALUES(${failedRuns + 1},'lark.im','lark.im.sent_by_me','succeeded','2020-03-01T00:00:02.000Z','2020-03-01T00:00:03.000Z',
      ${quote(cursor(START))},${quote(cursor(START + 60000))},${quote(JSON.stringify(closure))});
    UPDATE sync_scopes SET last_success_run_id=${failedRuns + 1},cursor_json=${quote(cursor(START + 60000))} WHERE id='lark.im.sent_by_me';
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

// Reintroduce only the previous access predicate as a regression control. This
// preserves the complete query, including projection work that COUNT(*) could
// optimize away. Production never selects this control query.
function previousAccessPredicate(sql) {
  assert.ok(sql.includes("+c.status='succeeded'"));
  return sql.replaceAll("+c.status='succeeded'", "c.status='succeeded'");
}

function profileQueries(db, queries) {
  const result = spawnSync("python3", ["-B", "-c", `
import hashlib,json,sqlite3,sys,time,urllib.parse
request=json.load(sys.stdin)
connection=sqlite3.connect('file:'+urllib.parse.quote(sys.argv[1],safe='/')+'?mode=ro',uri=True)
connection.row_factory=sqlite3.Row
connection.execute('PRAGMA query_only=ON')
connection.execute('BEGIN')
results=[]
for item in request:
    ticks=[0]
    def progress():
        ticks[0]+=1
        return ticks[0]>100000
    connection.set_progress_handler(progress,1000)
    started=time.perf_counter()
    rows=[dict(row) for row in connection.execute(item['sql'])]
    elapsed_ms=(time.perf_counter()-started)*1000
    connection.set_progress_handler(None,0)
    payload=json.dumps(rows,sort_keys=True,separators=(',',':')).encode()
    results.append({'label':item['label'],'elapsed_ms':elapsed_ms,
        'vm_steps':ticks[0]*1000,'rows':len(rows),'sha256':hashlib.sha256(payload).hexdigest()})
connection.rollback()
connection.close()
print(json.dumps(results))
`, db], { input: JSON.stringify(queries), encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined, "bounded synthetic query profiler must finish");
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("failed-run closure work stays scoped with twenty thousand unrelated successful runs", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-status-scaling-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, "synthetic.sqlite");
  const failedRuns = 16;
  seed(db, failedRuns);
  const sql = runEvidenceSql(LEGACY_TRANSITION_SQL, { limit: 200, cutoffSql: String(CUTOFF) });
  const [small] = profileQueries(db, [{ label: "scoped small", sql }]);
  sqliteExec(db, `WITH RECURSIVE ids(id) AS (VALUES(1000) UNION ALL SELECT id+1 FROM ids WHERE id<20999)
    INSERT INTO sync_runs(id,source_id,scope_id,status,started_at,finished_at,cursor_before_json,cursor_after_json,metadata_json)
    SELECT ids.id,r.source_id,'lark.im.unmuted_chat_hot',r.status,r.started_at,r.finished_at,
      r.cursor_before_json,r.cursor_after_json,r.metadata_json
    FROM ids CROSS JOIN sync_runs r WHERE r.id=${failedRuns + 1};`);
  const [previous, scoped] = profileQueries(db, [
    { label: "previous large", sql: previousAccessPredicate(sql) }, { label: "scoped large", sql },
  ]);
  assert.equal(scoped.rows, failedRuns);
  assert.equal(scoped.sha256, previous.sha256, "all proof rows, values and ordering must be identical");
  assert.equal(scoped.sha256, small.sha256, "unrelated scope history must not enter a closure proof");
  assert.ok(scoped.vm_steps <= small.vm_steps * 2 + 10_000,
    `unrelated history must not multiply scoped VM work: ${small.vm_steps} -> ${scoped.vm_steps}`);
  assert.ok(scoped.vm_steps <= 100_000, `scoped proof must fit its synthetic VM budget: ${scoped.vm_steps}`);
  // Do not require a future SQLite planner to reproduce the old bad choice.
  // The optimized growth/budget assertions catch that regression when it occurs;
  // the control's measured cost remains evidence, not a required plan shape.

  let snapshotSql;
  const report = buildStatus(db, { sqliteJson(path, statement, label) {
    if (label === "read sync status snapshot") {
      snapshotSql = statement.replaceAll("CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)", String(CUTOFF));
      return readOnlySqliteJson(path, snapshotSql, label);
    }
    return readOnlySqliteJson(path, statement, label);
  } });
  assert.equal(report.runs.by_status.failed, failedRuns, "raw failures remain retained");
  assert.equal(report.runs.transitions.resolved, failedRuns);
  assert.equal(report.runs.actionable_failed_runs, 0);
  const [oldSnapshot, newSnapshot] = profileQueries(db, [
    { label: "previous complete snapshot", sql: previousAccessPredicate(snapshotSql) },
    { label: "scoped complete snapshot", sql: snapshotSql },
  ]);
  assert.equal(newSnapshot.sha256, oldSnapshot.sha256, "the complete status snapshot must remain identical");
  t.diagnostic(`Synthetic ${failedRuns} failures + 20,000 unrelated successes; closure VM steps ${previous.vm_steps} -> ${scoped.vm_steps}; `
    + `closure ${previous.elapsed_ms.toFixed(2)}ms -> ${scoped.elapsed_ms.toFixed(2)}ms; `
    + `complete snapshot ${oldSnapshot.elapsed_ms.toFixed(2)}ms -> ${newSnapshot.elapsed_ms.toFixed(2)}ms (timings informational)`);
});

test("scoped closure predicate preserves TEXT status comparisons and works without the scope index", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-status-predicate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, "synthetic.sqlite");
  seed(db, 2);
  // The production TEXT column additionally has NOT NULL/CHECK constraints.
  // This deliberately wider synthetic column checks affinity without them.
  sqliteExec(db, `CREATE TABLE synthetic_status_values(value TEXT);
    INSERT INTO synthetic_status_values(value) VALUES
      ('succeeded'),('SUCCEEDED'),('succeeded '),('failed'),(NULL),(1),(1.0),(X'737563636565646564');`);
  const comparisons = readOnlySqliteJson(db, `SELECT
    COUNT(*) AS total, SUM((value='succeeded') IS (+value='succeeded')) AS equivalent,
    SUM(CASE WHEN +value='succeeded' THEN 1 ELSE 0 END) AS accepted FROM synthetic_status_values;`, "synthetic affinity");
  assert.deepEqual(comparisons, [{ total: 8, equivalent: 8, accepted: 1 }]);
  sqliteExec(db, "DROP INDEX idx_sync_runs_scope_started;");
  const sql = runEvidenceSql(LEGACY_TRANSITION_SQL, { limit: 200, cutoffSql: String(CUTOFF) });
  assert.deepEqual(readOnlySqliteJson(db, `${sql};`, "synthetic no scope index"),
    readOnlySqliteJson(db, `${previousAccessPredicate(sql)};`, "synthetic previous no scope index"));
});
