import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runEvidenceSql, runProgress } from "../src/diagnostics/lark-run-progress.mjs";
import { ensureInitialized, sqliteExec, quoteSql } from "../dist/storage/sqlite/ingestion-store.js";

// Frozen pre-optimization oracle from 26c31fb7d6110194f22025cd43e364a6b83fffd6.
// Keep these constants and the generator independent of production exports:
// changing both sides together would invalidate this differential control.
const CLOSURE_LIMIT = 100;
const CLOSURE_BYTE_LIMIT = 16 * 1024;
const TRANSITION_LIMIT = 200;
const LEGACY_TRANSITION_SQL = `r.status='failed' AND r.source_id='lark.im' AND r.error_type='LarkDetailIncomplete'
  AND CASE WHEN json_valid(r.metadata_json) THEN
    COALESCE(json_extract(r.metadata_json,'$.adapter'),'') != 'lark.im.details'
    AND COALESCE(json_type(r.metadata_json,'$.detail_retry'),'') != 'true'
    AND COALESCE(json_extract(r.metadata_json,'$.lark_progress.phase'),'') != 'details' ELSE 1 END`;
const RUN_EVIDENCE_COLUMNS = ["id", "source_id", "scope_id", "status", "started_at", "finished_at",
  "cursor_before_json", "cursor_after_json", "metadata_json", "error_type", "error_message",
  "scanned_count", "inserted_count", "updated_count", "duplicate_count"];


function baselineEvidenceSql(where, { limit, cutoffSql = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)" } = {}) {
  const budget = `r.id IN (SELECT r.id FROM sync_runs r WHERE (${where}) AND ${LEGACY_TRANSITION_SQL}
    ORDER BY r.id DESC LIMIT ${TRANSITION_LIMIT})`;
  // Preserve the old error projection for raw classification. Proof payloads have
  // a separate row/size budget; excess history stays unknown and actionable.
  const columns = RUN_EVIDENCE_COLUMNS.map((name) => {
    if (name === "metadata_json") return `CASE WHEN r.status!='failed' OR (${budget}) THEN
      CASE WHEN length(r.metadata_json)<=16384 THEN r.metadata_json END
      WHEN r.source_id='lark.im' AND r.error_type='LarkDetailIncomplete' AND NOT (${LEGACY_TRANSITION_SQL})
      THEN '{"adapter":"lark.im.details"}' ELSE NULL END AS metadata_json`;
    if (name === "cursor_before_json" || name === "cursor_after_json") return `CASE
      WHEN r.${name} IS NULL THEN NULL
      WHEN (r.status!='failed' OR (${budget})) AND length(r.${name})<=16384 THEN r.${name}
      ELSE '!unavailable!' END AS ${name}`;
    return `r.${name}`;
  }).join(", ");
  const json = RUN_EVIDENCE_COLUMNS.filter((name) => !["error_type", "error_message", "scanned_count", "inserted_count", "updated_count", "duplicate_count"].includes(name))
    .map((name) => `'${name}', ${["metadata_json", "cursor_before_json", "cursor_after_json"].includes(name)
      ? `CASE WHEN c.${name} IS NULL THEN NULL WHEN length(c.${name})<=16384 THEN c.${name}
          ELSE ${name === "metadata_json" ? "NULL" : "'!unavailable!'"} END` : `c.${name}`}`).join(", ");
  // Keep this correlated lookup scoped: the global status index can otherwise
  // rescan unrelated successful history for every retained failure. Unary +
  // disqualifies only that index term; TEXT status compared with the fixed
  // nonnumeric literal keeps the same accepted values. All proof fences remain.
  return `SELECT ${columns}, ${cutoffSql} AS evidence_cutoff_ms,
    CASE WHEN ${LEGACY_TRANSITION_SQL} THEN
      CASE WHEN ${budget} THEN (WITH candidates AS MATERIALIZED (
        SELECT c.* FROM sync_runs c WHERE c.source_id=r.source_id AND c.scope_id=r.scope_id
          AND c.id > r.id AND +c.status='succeeded' AND julianday(c.started_at) >= julianday(r.finished_at)
          AND julianday(c.finished_at) <= julianday((${cutoffSql}) / 1000.0, 'unixepoch')
          AND CASE WHEN json_valid(c.metadata_json) THEN
            json_extract(c.metadata_json,'$.adapter')='lark.im.details'
            OR json_extract(c.metadata_json,'$.lark_progress.phase')='details' ELSE 0 END
        ORDER BY c.id LIMIT ${CLOSURE_LIMIT + 1}
      ), proof AS MATERIALIZED (
        SELECT json_group_array(json_object(${json})) AS value FROM candidates c
        WHERE (SELECT COUNT(*) FROM candidates) <= ${CLOSURE_LIMIT}
      ) SELECT CASE WHEN (SELECT COUNT(*) FROM candidates) > ${CLOSURE_LIMIT}
          OR length(CAST(value AS BLOB)) > ${CLOSURE_BYTE_LIMIT} THEN NULL ELSE value END FROM proof
      ) ELSE NULL END ELSE '[]' END AS closure_candidates_json
    FROM sync_runs r WHERE ${where} ORDER BY r.id DESC${limit ? ` LIMIT ${limit}` : ""}`;
}

const ANCHOR = Date.parse("2020-02-03T00:00:00.000Z");
const AT = Date.parse("2032-02-04T11:00:00.000Z");
const CUTOFF = AT + 60000;
const SENT = "lark.im.sent_by_me";
const iso = value => new Date(value).toISOString();
const cursor = value => JSON.stringify({ kind: "time_message_cursor/v1", created_at_ms: value });
const metadataPatch = (row, patch) => ({ ...row, metadata_json: JSON.stringify({ ...JSON.parse(row.metadata_json), ...patch }) });

function list(id, patch = {}) {
  return { id, source_id: "lark.im", scope_id: SENT, status: "failed",
    started_at: iso(AT), finished_at: iso(AT + 1000), error_type: "LarkDetailIncomplete",
    cursor_before_json: cursor(ANCHOR), cursor_after_json: null,
    metadata_json: JSON.stringify({ adapter: SENT, initial_sync_start_ms: ANCHOR,
      __run_fence: { list_generation: 3, scope_config: { chat_id: null } },
      list_complete: true, details_complete: false, window_complete: false, pending_detail_count: 1,
      list_window_start_ms: ANCHOR, list_window_end_ms: ANCHOR + 119999 }), ...patch };
}

function closure(id, patch = {}) {
  return { id, source_id: "lark.im", scope_id: SENT, status: "succeeded",
    started_at: iso(AT + 2000), finished_at: iso(AT + 3000),
    cursor_before_json: cursor(ANCHOR), cursor_after_json: cursor(ANCHOR + 60000),
    metadata_json: JSON.stringify({ adapter: "lark.im.details", detail_retry: true,
      __run_fence: { list_generation: 4, scope_config: { chat_id: null } },
      coverage_mode: "list_checkpoint_and_details", list_complete: true, details_complete: true,
      window_complete: true, pending_detail_count: 0,
      window_start_ms: ANCHOR, window_end_ms: ANCHOR + 60000,
      window_start: iso(ANCHOR), window_end: iso(ANCHOR + 60000) }), ...patch };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "synthetic-status-equivalence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, "authored.sqlite");
  ensureInitialized(db);
  const insert = (...rows) => sqliteExec(db, `BEGIN;${rows.map(row => {
    const columns = Object.keys(row);
    return `INSERT INTO sync_runs(${columns.join(",")}) VALUES(${columns.map(key => quoteSql(row[key])).join(",")});`;
  }).join("\n")}COMMIT;`);
  return { db, insert };
}

// Both queries run on one read-only SQLite connection/transaction. Preserve
// every proof string byte-for-byte, including ordering and null/empty results.
// Blob values outside proofs get an explicit test-only encoding; SQL errors
// are also compared so wider corrupted fixtures cannot silently gain success.
function compare(db, cases) {
  const queries = cases.flatMap(({ where = "r.status='failed'", options = {} }) => {
    const settings = { cutoffSql: String(CUTOFF), ...options };
    return [baselineEvidenceSql(where, settings), runEvidenceSql(where, settings)];
  });
  const child = spawnSync("python3", ["-B", "-c", `
import json,sqlite3,sys,urllib.parse
connection=sqlite3.connect('file:'+urllib.parse.quote(sys.argv[1],safe='/')+'?mode=ro',uri=True)
connection.row_factory=sqlite3.Row
connection.execute('PRAGMA query_only=ON')
connection.execute('BEGIN')
def encode(value):
    return {'synthetic_sql_blob_hex':value.hex()} if isinstance(value,bytes) else value
results=[]
for sql in json.load(sys.stdin):
    ticks=[0]
    def progress():
        ticks[0]+=1
        return ticks[0]>100000
    connection.set_progress_handler(progress,1000)
    try:
        results.append({'rows':[{key:encode(value) for key,value in dict(row).items()} for row in connection.execute(sql)]})
    except sqlite3.Error as error:
        results.append({'error':{'name':type(error).__name__,'message':str(error)}})
    connection.set_progress_handler(None,0)
connection.rollback()
connection.close()
print(json.dumps(results,separators=(',',':')))
`, db], { input: JSON.stringify(queries), encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(child.error, undefined, "finite synthetic differential query process must finish");
  assert.equal(child.status, 0, child.stderr);
  const results = JSON.parse(child.stdout), output = [];
  for (let index = 0; index < cases.length; index += 1) {
    const before = results[index * 2], after = results[index * 2 + 1];
    assert.equal(before.error, undefined, `${cases[index].label || `SQL case ${index}`} baseline must execute, not merely fail like its replacement`);
    assert.deepEqual(after, before, cases[index].label || `SQL case ${index}`);
    if (before.rows) {
      assert.deepEqual(after.rows.map(runProgress), before.rows.map(runProgress));
      output.push(after.rows);
    } else output.push(after);
  }
  return output;
}

test("closure SQL differential preserves empty, where, limit and the global 200-run proof budget", t => {
  const f = fixture(t);
  assert.deepEqual(compare(f.db, [{ where: "1" }, { where: "0", options: { limit: 1 } }]), [[], []]);
  f.insert(...Array.from({ length: 202 }, (_, index) => list(index + 1)), closure(203),
    list(204, { error_type: "SyntheticTransportFailure" }),
    metadataPatch(list(205), { adapter: "lark.im.details", detail_retry: true }));
  const cases = [
    { label: "all rows", where: "1" },
    { label: "all failures", where: "r.status='failed'" },
    { label: "legacy transition expression", where: LEGACY_TRANSITION_SQL },
    { label: "empty subset", where: "r.id<0" },
    { label: "proof budget uses the where subset", where: "r.id<=3" },
    { label: "success subset", where: "r.status='succeeded'" },
    ...[0, 1, 5, 200, 201].map(limit => ({ label: `limit ${limit}`, where: "r.status='failed'", options: { limit } })),
  ];
  const [all, failed, legacy, empty, small] = compare(f.db, cases);
  assert.equal(all.length, 205); assert.equal(failed.length, 204); assert.equal(legacy.length, 202);
  assert.deepEqual(empty, []); assert.equal(small.length, 3);
  assert.equal(legacy.filter(row => runProgress(row).resolution === "resolved").length, 200);
  assert.deepEqual(legacy.filter(row => runProgress(row).resolution === "unknown").map(row => row.id), [2, 1]);
  assert(small.every(row => runProgress(row).resolution === "resolved"));
});

test("closure SQL differential retains malformed JSON, scalar and non-TEXT metadata behavior", t => {
  const f = fixture(t);
  f.insert(list(1), ...Array.from({ length: 10 }, (_, index) => closure(index + 2)));
  // CHECK bypass is confined to this authored corruption fixture, never used
  // by product code. Numeric TEXT affinity and raw BLOB storage stay distinct.
  const values = ["'{'", "NULL", "'null'", "'[]'", "7", "'true'", "X'00ff'",
    "'{\"adapter\":\"ordinary-list\"}'", "'{\"lark_progress\":{\"phase\":\"details\"}}'"];
  sqliteExec(f.db, `PRAGMA ignore_check_constraints=ON;${values.map((value, index) =>
    `UPDATE sync_runs SET metadata_json=${value} WHERE id=${index + 2};`).join("\n")}PRAGMA ignore_check_constraints=OFF;`);
  const [rows, all] = compare(f.db, [{}, { where: "1" }]);
  assert.deepEqual(JSON.parse(rows[0].closure_candidates_json).map(row => row.id), [10, 11]);
  assert.equal(runProgress(rows[0]).resolution, "resolved");
  assert.equal(all.find(row => row.id === 8).metadata_json.synthetic_sql_blob_hex, "00ff");
  sqliteExec(f.db, "PRAGMA ignore_check_constraints=ON; UPDATE sync_runs SET metadata_json='{' WHERE id=1; PRAGMA ignore_check_constraints=OFF;");
  const [invalidFailure] = compare(f.db, [{}]);
  assert.equal(runProgress(invalidFailure[0]).resolution, "unknown");
});

test("closure SQL differential preserves equal, invalid and row-correlated cutoff date comparisons", t => {
  const f = fixture(t);
  f.insert(list(1), list(2, { finished_at: "not-a-date" }), list(3),
    closure(4, { started_at: iso(AT + 1000), finished_at: iso(AT + 3000) }),
    closure(5, { started_at: iso(AT + 999), finished_at: iso(AT + 3000) }),
    closure(6, { started_at: "not-a-date" }), closure(7, { finished_at: "not-a-date" }),
    closure(8, { finished_at: iso(AT + 3001) }), closure(9, { finished_at: "2032-02-30T11:00:03.000Z" }));
  const [rows] = compare(f.db, [{ options: { cutoffSql: `CASE WHEN r.id=1 THEN ${AT + 3000} ELSE ${AT + 3001} END` } }]);
  const byId = new Map(rows.map(row => [row.id, row]));
  assert.deepEqual(JSON.parse(byId.get(1).closure_candidates_json).map(row => row.id), [4]);
  assert.deepEqual(JSON.parse(byId.get(2).closure_candidates_json), []);
  assert.deepEqual(JSON.parse(byId.get(3).closure_candidates_json).map(row => row.id), [4, 8]);
  assert.equal(runProgress(byId.get(1)).resolution, "resolved");
  assert.equal(runProgress(byId.get(2)).resolution, "unknown");
  compare(f.db, [
    { options: { cutoffSql: "NULL" } },
    { options: { cutoffSql: "'not-a-date'" } },
    { options: { cutoffSql: "CAST((julianday(r.finished_at)-2440587.5)*86400000 AS INTEGER)" } },
  ]);
});

test("closure SQL differential keeps source and scope pairs separate in a shared candidate pool", t => {
  const f = fixture(t), scope = "lark.im.received.chat.synthetic_equivalence";
  sqliteExec(f.db, `INSERT INTO sources(id,kind,display_name) VALUES('synthetic.other','synthetic','Synthetic other source');
    INSERT INTO sync_scopes(id,source_id,name) VALUES(${quoteSql(scope)},'lark.im','synthetic-equivalence-received');`);
  const received = row => metadataPatch({ ...row, scope_id: scope }, {
    ...(row.status === "failed" ? { adapter: "lark.im.received_per_chat" } : {}),
    __run_fence: { list_generation: row.status === "failed" ? 3 : 4, scope_config: { chat_id: "synthetic_equivalence" } },
  });
  f.insert(list(1), received(list(2)),
    closure(3, { source_id: "synthetic.other" }), received(closure(4)), closure(5));
  const [rows] = compare(f.db, [{}]);
  assert.deepEqual(rows.map(row => [row.id, JSON.parse(row.closure_candidates_json).map(value => value.id)]), [[2, [4]], [1, [5]]]);
  assert(rows.every(row => runProgress(row).resolution === "resolved"));
  const [subset] = compare(f.db, [{ where: `r.status='failed' AND r.scope_id=${quoteSql(scope)}` }]);
  assert.deepEqual(subset, [rows[0]], "retaining one scope cannot import candidates from the other scope");
});

test("closure SQL differential applies the 101-candidate window independently to each failure ID and time", t => {
  const f = fixture(t);
  f.insert(list(1), ...Array.from({ length: 101 }, (_, index) => metadataPatch(closure(index + 2), { adapter: "lark.im.details", detail_retry: false })),
    list(103, { finished_at: iso(AT + 5000) }),
    closure(104, { started_at: iso(AT + 3000), finished_at: iso(AT + 4000) }),
    closure(105, { started_at: iso(AT + 5000), finished_at: iso(AT + 6000) }));
  const [rows] = compare(f.db, [{}]);
  assert.equal(rows.find(row => row.id === 1).closure_candidates_json, null, "earlier 101 malformed closures still exhaust the old proof budget");
  const later = rows.find(row => row.id === 103);
  assert.deepEqual(JSON.parse(later.closure_candidates_json).map(row => row.id), [105], "a later failure must see the closure beyond another run's first 101 IDs");
  assert.equal(runProgress(later).resolution, "resolved");
});

test("closure SQL differential retains 100 versus 101 candidates without treating malformed proofs as free", t => {
  const f = fixture(t);
  f.insert(list(1), ...Array.from({ length: 100 }, (_, index) => closure(index + 2, {
    source_id: "lark.im", scope_id: SENT, metadata_json: '{"adapter":"lark.im.details"}',
    cursor_before_json: null, cursor_after_json: null, started_at: "2032-02-04", finished_at: "2032-02-05",
  })));
  // Short non-ISO dates are accepted by SQL but rejected by the semantic proof;
  // they still count toward the exact original candidate budget.
  const options = { cutoffSql: String(Date.parse("2032-02-06T00:00:00.000Z")) };
  sqliteExec(f.db, "UPDATE sync_runs SET finished_at='2032-02-03' WHERE id=1;");
  const [hundred] = compare(f.db, [{ options }]);
  // Each complete row has unavoidable identity/date columns, so the existing
  // 16-KiB proof limit may already reject 100. Equivalence, not truncation,
  // remains the oracle at that boundary.
  assert.equal(runProgress(hundred[0]).resolution, "unknown");
  f.insert(closure(102, { metadata_json: '{"adapter":"lark.im.details"}', started_at: "2032-02-04", finished_at: "2032-02-05" }));
  const [hundredOne] = compare(f.db, [{ options }]);
  assert.equal(hundredOne[0].closure_candidates_json, null);
  assert.equal(runProgress(hundredOne[0]).resolution, "unknown");
});

test("closure SQL differential preserves character caps and the exact UTF-8 complete-proof boundary", t => {
  const f = fixture(t);
  f.insert(list(1), metadataPatch(closure(2), { synthetic_padding: "" }));
  const [plain] = compare(f.db, [{}]);
  const remaining = 16 * 1024 - Buffer.byteLength(plain[0].closure_candidates_json);
  const padding = "界".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
  const write = value => sqliteExec(f.db, `UPDATE sync_runs SET metadata_json=${quoteSql(metadataPatch(closure(2), { synthetic_padding: value }).metadata_json)} WHERE id=2;`);
  write(padding);
  const [atLimit] = compare(f.db, [{}]);
  assert.equal(Buffer.byteLength(atLimit[0].closure_candidates_json), 16 * 1024);
  assert.equal(runProgress(atLimit[0]).resolution, "resolved");
  write(padding + "x");
  const [over] = compare(f.db, [{}]);
  assert.equal(over[0].closure_candidates_json, null); assert.equal(runProgress(over[0]).resolution, "unknown");
  write("x".repeat(17000));
  const [wide] = compare(f.db, [{}]);
  assert.equal(JSON.parse(wide[0].closure_candidates_json)[0].metadata_json, null);
  assert.equal(runProgress(wide[0]).resolution, "unresolved");
  write("");
  sqliteExec(f.db, `UPDATE sync_runs SET cursor_before_json=${quoteSql(JSON.stringify({ kind: "time_message_cursor/v1", created_at_ms: ANCHOR, padding: "x".repeat(17000) }))} WHERE id=2;`);
  const [wideCursor] = compare(f.db, [{}]);
  assert.equal(JSON.parse(wideCursor[0].closure_candidates_json)[0].cursor_before_json, "!unavailable!");
  assert.equal(runProgress(wideCursor[0]).resolution, "unresolved");
});



test("closure SQL differential preserves the exact complete buildStatus snapshot", async t => {
  const { buildStatus } = await import("../src/diagnostics/sync-status-report.mjs");
  const { readOnlySqliteJson } = await import("../src/storage/sqlite/readonly-query.mjs");
  const f = fixture(t);
  f.insert(list(1), list(2), list(3, { error_type: "SyntheticTransportFailure" }),
    metadataPatch(closure(4), { synthetic_padding: "界".repeat(300) }),
    metadataPatch(closure(5), { adapter: SENT, detail_retry: undefined }),
    metadataPatch(list(6), { adapter: "lark.im.details", detail_retry: true }),
    closure(7, { finished_at: iso(CUTOFF + 1000) }));
  sqliteExec(f.db, `UPDATE sync_scopes SET last_success_run_id=4,cursor_json=${quoteSql(cursor(ANCHOR + 60000))} WHERE id=${quoteSql(SENT)};
    UPDATE sync_scopes SET cursor_json='{"has_more":false}' WHERE id='lark.im.unmuted_chat_discovery';`);
  const clockSql = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
  const fixedClock = sql => sql.replaceAll(clockSql, String(CUTOFF));
  let captured, snapshots = 0;
  const report = buildStatus(f.db, {
    now: () => CUTOFF, inspectActivityProcesses: () => new Map(),
    sqliteJson(path, sql, label) {
      if (label === "read sync status snapshot") { snapshots += 1; captured = sql; }
      return readOnlySqliteJson(path, fixedClock(sql), label);
    },
  });
  assert.equal(snapshots, 1, "use the actual complete snapshot from the production builder");
  assert.equal(typeof captured, "string");
  assert.deepEqual(report.runs.by_status, { succeeded: 3, failed: 4 });
  assert.deepEqual(report.runs.transitions, { resolved: 2, unresolved: 0, unknown: 0 });

  let baselineSnapshot = captured;
  const mask = (sql, fragments) => fragments.reduce((value, fragment, index) => value.replace(fragment, `__EXACT_PROOF_FRAGMENT_${index}__`), sql);
  const currentFragments = [], baselineFragments = [];
  for (const [where, limit] of [["1", 10], [LEGACY_TRANSITION_SQL, 200]]) {
    const current = runEvidenceSql(where, { limit });
    const original = baselineEvidenceSql(where, { limit });
    assert.equal(captured.split(current).length - 1, 1, `exact current proof fragment limit ${limit} occurs once`);
    baselineSnapshot = baselineSnapshot.replace(current, original);
    currentFragments.push(current); baselineFragments.push(original);
  }
  assert.equal(mask(captured, currentFragments), mask(baselineSnapshot, baselineFragments),
    "all other status sections, projections and where clauses must remain byte-identical");
  assert.notEqual(captured, baselineSnapshot, "the control really restores the previous proof implementation");
  const stripTerminator = sql => { assert.match(sql, /;\s*$/); return sql.replace(/;\s*$/, ""); };
  // One actual SQLite CLI SELECT/transaction preserves the same database and
  // julianday('now') observation across both complete snapshots. No hand-written
  // substitute status query or second application snapshot is used.
  const wire = readOnlySqliteJson(f.db, `
    SELECT 'baseline' AS variant,section,rows_json FROM (${stripTerminator(fixedClock(baselineSnapshot))})
    UNION ALL
    SELECT 'candidate' AS variant,section,rows_json FROM (${stripTerminator(fixedClock(captured))});`,
  "synthetic complete status snapshot differential");
  const rows = variant => wire.filter(row => row.variant === variant).map(({ section, rows_json }) => ({ section, rows_json }));
  const originalRows = rows("baseline"), currentRows = rows("candidate");
  assert.deepEqual(currentRows, originalRows, "every complete snapshot row and JSON cell must match exactly");
  assert.deepEqual(currentRows.map(row => [row.section, JSON.parse(row.rows_json)]),
    originalRows.map(row => [row.section, JSON.parse(row.rows_json)]));
  const sections = new Set(currentRows.map(row => row.section));
  for (const section of ["read record totals", "read scope totals", "read run counts", "read pending detail totals", "read source observation totals"])
    assert(sections.has(section), `non-proof section ${section} remains in the actual snapshot`);
  assert.equal(currentRows.filter(row => row.section === "read recent runs").length, 7);
  assert.equal(currentRows.filter(row => row.section === "read failed run transitions").length, 2);
});
