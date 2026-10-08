import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runEvidenceSql, runProgress } from "../src/diagnostics/lark-run-progress.mjs";
import { buildStatus } from "../src/diagnostics/sync-status-report.mjs";
import { buildServiceStatusReport } from "../src/diagnostics/lark-im-service-report.mjs";
import { publicStatusReport } from "../src/diagnostics/status-report.mjs";
import { renderStatusText } from "../src/terminal/status-view.mjs";
import { readOnlySqliteJson } from "../src/storage/sqlite/readonly-query.mjs";
import { ensureInitialized, sqliteExec, sqliteQuery } from "../dist/storage/sqlite/ingestion-store.js";
import { rawStatusScreenFixture, STATUS_SCREEN_NOW } from "./helpers/status-screen-fixture.mjs";

const START = Date.parse("2020-02-03T00:00:00.000Z");
const NOW = Date.parse("2032-02-04T12:00:00.000Z");
const iso = (value) => new Date(value).toISOString();
const cursor = (value) => JSON.stringify({ kind: "time_message_cursor/v1", created_at_ms: value });
const quote = (value) => value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
const meta = (run, patch) => ({ ...run, metadata_json: JSON.stringify({ ...JSON.parse(run.metadata_json), ...patch }) });

function evidence({ initial = false, end = START + 119999 } = {}) {
  const before = initial ? null : cursor(START);
  const list = { id: 7, source_id: "lark.im", scope_id: "lark.im.sent_by_me", status: "failed",
    started_at: "2032-02-04T11:00:00.000Z", finished_at: "2032-02-04T11:00:01.000Z",
    cursor_before_json: before, cursor_after_json: null, error_type: "LarkDetailIncomplete", error_message: "PRIVATE_SYNTHETIC_ERROR",
    metadata_json: JSON.stringify({ adapter: "lark.im.sent_by_me", initial_sync_start_ms: START,
      __run_fence: { list_generation: 3, scope_config: { chat_id: null } },
      list_complete: true, details_complete: false, window_complete: false, pending_detail_count: 1,
      list_window_start_ms: START, list_window_end_ms: end }), evidence_cutoff_ms: NOW };
  const closure = { id: 8, source_id: list.source_id, scope_id: list.scope_id, status: "succeeded",
    started_at: "2032-02-04T11:00:01.001Z", finished_at: "2032-02-04T11:00:02.000Z",
    cursor_before_json: before, cursor_after_json: cursor(START + 60000), metadata_json: JSON.stringify({
      adapter: "lark.im.details", detail_retry: true,
      __run_fence: { list_generation: 4, scope_config: { chat_id: null } },
      coverage_mode: "list_checkpoint_and_details", list_complete: true, details_complete: true,
      window_complete: true, pending_detail_count: 0,
      window_start_ms: START, window_end_ms: START + 60000, window_start: iso(START), window_end: iso(START + 60000),
    }) };
  return { list: { ...list, closure_candidates_json: JSON.stringify([closure]) }, closure };
}

test("legacy list proof closes both initial and noninitial chains at the conservative minute frontier", () => {
  for (const initial of [false, true]) {
    const { list } = evidence({ initial });
    assert.deepEqual(runProgress(list), { phase: "list", outcome: "awaiting_details", resolution: "resolved" });
    assert.equal(runProgress({ ...list, closure_candidates_json: "[]" }).resolution, "unresolved");
  }
  const { list, closure } = evidence();
  const nestedBefore = { kind: "time_message_cursor/v1", created_at_ms: START, marker: { a: 1, b: 2 } };
  assert.equal(runProgress({ ...list, cursor_before_json: JSON.stringify(nestedBefore), closure_candidates_json: JSON.stringify([
    { ...closure, cursor_before_json: JSON.stringify({ marker: { b: 2, a: 1 }, created_at_ms: START, kind: "time_message_cursor/v1" }) },
  ]) }).resolution, "resolved", "normalization ignores key order, never cursor contents");
});

test("incorrect, absent and coerced closure facts cannot close a historical list run", () => {
  const { list, closure } = evidence();
  const bad = [
    ["different source", { ...closure, source_id: "other" }],
    ["different scope", { ...closure, scope_id: "lark.im.received.chat.other" }],
    ["older id", { ...closure, id: list.id }],
    ["starts before list commit", { ...closure, started_at: list.started_at }],
    ["finishes before start", { ...closure, finished_at: list.started_at }],
    ["future finish", { ...closure, finished_at: iso(NOW + 1) }],
    ["coverage newer than finish", { ...meta(closure, { window_end_ms: NOW, window_end: iso(NOW) }), cursor_after_json: cursor(NOW) }],
    ["malformed metadata", { ...closure, metadata_json: "{" }],
    ["ordinary list success", meta(closure, { adapter: "lark.im.sent_by_me", detail_retry: undefined })],
    ["string retry flag", meta(closure, { detail_retry: "true" })],
    ["wrong scope identity", meta(closure, { __run_fence: { list_generation: 4, scope_config: { chat_id: "other" } } })],
    ["same generation", meta(closure, { __run_fence: { list_generation: 3, scope_config: { chat_id: null } } })],
    ["coerced generation", meta(closure, { __run_fence: { list_generation: "4", scope_config: { chat_id: null } } })],
    ["string completeness", meta(closure, { details_complete: "true" })],
    ["integer completeness", meta(closure, { window_complete: 1 })],
    ["string zero debt", meta(closure, { pending_detail_count: "0" })],
    ["mismatched ISO bounds", meta(closure, { window_end: iso(START + 60001) })],
    ["missing bounds", meta(closure, { window_start_ms: undefined })],
    ["wrong full cursor anchor", { ...closure, cursor_before_json: cursor(START - 60000) }],
    ["missing before", { ...closure, cursor_before_json: undefined }],
    ["different tie breaker", { ...closure, cursor_before_json: JSON.stringify({ ...JSON.parse(closure.cursor_before_json), message_id: "other" }) }],
    ["impossible calendar date", { ...closure, finished_at: "2032-02-30T11:00:02.000Z" }],
    ["coerced cursor ms", { ...closure, cursor_after_json: JSON.stringify({ kind: "time_message_cursor/v1", created_at_ms: String(START + 60000) }) }],
    ["wrong cursor kind", { ...closure, cursor_after_json: JSON.stringify({ kind: "other", created_at_ms: START + 60000 }) }],
    ["too short interval", { ...meta(closure, { window_end_ms: START, window_end: iso(START) }), cursor_after_json: cursor(START) }],
    ["wrong generated phase", meta(closure, { lark_progress: { version: 1, phase: "other" } })],
    ["generated incomplete", meta(closure, { lark_progress: { version: 1, phase: "details", outcome: "awaiting_details", attempted: 1, completed: 1, failed: 0, generation: 5 } })],
  ];
  for (const [label, value] of bad) assert.equal(runProgress({ ...list, closure_candidates_json: JSON.stringify([value]) }).resolution, "unresolved", label);
  for (const value of [undefined, "{", "null", "[null]", JSON.stringify(Array(101).fill(closure))]) {
    assert.equal(runProgress({ ...list, closure_candidates_json: value }).resolution, "unknown");
  }
});

test("bad legacy evidence is unknown; actual failed detail attempts never become normal transitions", () => {
  const { list } = evidence();
  for (const patch of [{ list_complete: "true" }, { pending_detail_count: "1" }, { adapter: "other" },
    { __run_fence: { scope_config: {} } }, { list_window_start_ms: "bad" }, { lark_progress: { version: 999 } }]) {
    assert.equal(runProgress(meta(list, patch)).resolution, "unknown");
  }
  const initial = evidence({ initial: true }).list;
  assert.equal(runProgress(meta(initial, { initial_sync_start_ms: START - 1 })).resolution, "unresolved");
  assert.equal(runProgress(meta(initial, { initial_sync_start_ms: undefined })).resolution, "unknown");
  for (const patch of [{ adapter: "lark.im.details" }, { detail_retry: true },
    { lark_progress: { version: 1, phase: "details", outcome: "attempt_failed", attempted: 1, completed: 0, failed: 1, generation: 4 } }]) {
    assert.deepEqual(runProgress(meta(list, patch)), { phase: "details", outcome: "attempt_failed", resolution: "not_applicable" });
  }
});

test("generated stage projection requires strict types and consistent result counts", () => {
  const { list, closure } = evidence();
  const progress = { version: 1, phase: "list", outcome: "awaiting_details", attempted: 0, completed: 0, failed: 0, generation: 4 };
  const stage = meta({ ...list, status: "succeeded", error_type: null }, { lark_progress: progress });
  assert.deepEqual(runProgress(stage), { phase: "list", outcome: "awaiting_details", resolution: "not_applicable" });
  for (const patch of [{ version: "1" }, { attempted: 1 }, { failed: "0" }, { completed: -1 }, { outcome: "complete" }, { generation: null }, { generation: 0 }, { generation: 5 }]) {
    assert.deepEqual(runProgress(meta(stage, { lark_progress: { ...progress, ...patch } })), {});
  }
  const generatedClosure = meta(closure, { lark_progress: { version: 1, phase: "details", outcome: "complete", attempted: 1, completed: 1, failed: 0, generation: 5 } });
  assert.equal(runProgress({ ...list, closure_candidates_json: JSON.stringify([generatedClosure]) }).resolution, "resolved");
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-run-progress-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, "synthetic.sqlite");
  ensureInitialized(db);
  const insert = (row) => {
    const columns = Object.keys(row).filter((key) => !["closure_candidates_json", "evidence_cutoff_ms"].includes(key));
    sqliteExec(db, `INSERT INTO sync_runs (${columns.join(",")}) VALUES (${columns.map((key) => quote(row[key])).join(",")});`);
  };
  return { db, insert, directory };
}

test("one real SQL snapshot returns raw failure plus bounded closure proof without trusting the current queue", (t) => {
  const { db, insert } = fixture(t);
  const { list, closure } = evidence();
  insert(list);
  const query = runEvidenceSql("r.status='failed'", { cutoffSql: String(NOW) }) + ";";
  assert.equal(runProgress(readOnlySqliteJson(db, query)[0]).resolution, "unresolved", "empty detail ledger is not proof");
  const before = readOnlySqliteJson(db, query);
  insert(closure);
  assert.equal(runProgress(before[0]).resolution, "unresolved", "saved snapshot cannot acquire a later closure");
  const after = readOnlySqliteJson(db, query);
  assert.equal(runProgress(after[0]).resolution, "resolved");
  assert.equal(after[0].status, "failed");
  for (let id = 9; id <= 108; id += 1) insert({ ...closure, id });
  const exhausted = readOnlySqliteJson(db, query)[0];
  assert.equal(exhausted.closure_candidates_json, null, "over-limit candidates must not cross the CLI as a large JSON cell");
  assert.equal(runProgress(exhausted).resolution, "unknown", "candidate budget exhaustion stays visible");
});

test("the complete closure proof obeys a UTF-8 byte budget without truncating or accepting partial evidence", (t) => {
  const { db, insert, directory } = fixture(t);
  const { list, closure } = evidence();
  insert(list);
  insert(meta(closure, { synthetic_padding: "" }));
  const query = runEvidenceSql("r.status='failed'", { cutoffSql: String(NOW) }) + ";";
  const read = () => readOnlySqliteJson(db, query)[0];
  const plain = read();
  assert.equal(runProgress(plain).resolution, "resolved");
  const available = 16 * 1024 - Buffer.byteLength(plain.closure_candidates_json);
  // Multibyte padding makes a character-count cap detectably wrong. The
  // per-field character cap remains satisfied throughout these boundary cases.
  const padding = "界".repeat(Math.floor(available / 3)) + "x".repeat(available % 3);
  const writePadding = (value) => sqliteExec(db, `UPDATE sync_runs SET metadata_json=${quote(meta(closure,
    { synthetic_padding: value }).metadata_json)} WHERE id=${closure.id};`);
  writePadding(padding);
  const atLimit = read();
  assert.equal(Buffer.byteLength(atLimit.closure_candidates_json), 16 * 1024);
  assert.equal(runProgress(atLimit).resolution, "resolved");
  writePadding(padding + "x");
  const overLimit = read();
  assert.equal(overLimit.closure_candidates_json, null);
  assert.equal(runProgress(overLimit).resolution, "unknown");
  writePadding("");
  sqliteExec(db, `WITH RECURSIVE ids(id) AS (VALUES(9) UNION ALL SELECT id+1 FROM ids WHERE id<107)
    INSERT INTO sync_runs(id,source_id,scope_id,status,started_at,finished_at,cursor_before_json,cursor_after_json,metadata_json)
    SELECT ids.id,r.source_id,r.scope_id,r.status,r.started_at,r.finished_at,r.cursor_before_json,r.cursor_after_json,r.metadata_json
    FROM ids CROSS JOIN sync_runs r WHERE r.id=${closure.id};`);
  assert.equal(sqliteQuery(db, "SELECT COUNT(*) AS count FROM sync_runs WHERE status='succeeded';")[0].count, 100);
  const many = read();
  assert.equal(many.closure_candidates_json, null, "100 candidates may still exceed the total proof byte budget");
  assert.equal(runProgress(many).resolution, "unknown");
  const raw = buildServiceStatusReport({ db, logDir: directory, label: "synthetic", target: "synthetic" }, {
    nowMs: NOW, runCommand: () => ({ status: 0, stdout: "state = running\npid = 7701\n", stderr: "" }),
    readRecentWorkerEvents: () => ({ path: "synthetic", exists: true, events: [], activity_integrity: true }),
    readLiveProbeCache: () => null, liveProbeContext: () => null, inspectActivityProcesses: () => new Map(),
  });
  assert.equal(raw.failure_runs.failed_runs, 1);
  assert.equal(raw.failure_runs.actionable_failed_runs, 1);
  assert.equal(raw.failure_runs.transitions.unknown, 1);
  const fixtureReport = rawStatusScreenFixture("healthy");
  fixtureReport.failure_runs = raw.failure_runs;
  const report = publicStatusReport({ observedAt: STATUS_SCREEN_NOW, report: fixtureReport,
    service: { status: "running", target_match: "matched" }, installed: { status: "installed" } }, {});
  assert.match(renderStatusText(report, { columns: 140 }).replace(/\s+/g, " "), /Database failures 1 retained failed runs/);
});

test("raw and actionable failure counts coexist; resolved history does not hide new pending or genuine failures", (t) => {
  const { db, directory, insert } = fixture(t);
  const { list, closure } = evidence();
  insert(list); insert(closure);
  const actualDetailFailure = meta({ ...list, id: 9 }, { adapter: "lark.im.details", detail_retry: true });
  insert(actualDetailFailure);
  const raw = buildServiceStatusReport({ db, logDir: directory, label: "synthetic", target: "synthetic" }, {
    nowMs: NOW, runCommand: () => ({ status: 0, stdout: "state = running\npid = 7701\n", stderr: "" }),
    readRecentWorkerEvents: () => ({ path: "synthetic", exists: true, events: [], activity_integrity: true }),
    readLiveProbeCache: () => null, liveProbeContext: () => null, inspectActivityProcesses: () => new Map(),
  });
  assert.equal(raw.failure_runs.failed_runs, 2);
  assert.equal(raw.failure_runs.actionable_failed_runs, 1);
  assert.deepEqual(raw.failure_runs.transitions, { resolved: 1, unresolved: 0, unknown: 0 });
  assert.deepEqual(raw.failure_runs.by_kind, [{ kind: "detail_incomplete", count: 2 }]);
  assert.deepEqual(raw.failure_runs.actionable_by_kind, [{ kind: "detail_incomplete", count: 1 }]);
  const fixtureReport = rawStatusScreenFixture("healthy");
  fixtureReport.failure_runs = raw.failure_runs;
  Object.assign(fixtureReport.sync.status.details, { pending_count: 1, due_count: 1, scopes_pending: 1 });
  const report = publicStatusReport({ observedAt: STATUS_SCREEN_NOW, report: fixtureReport,
    service: { status: "running", target_match: "matched" }, installed: { status: "installed" } }, { detail: true });
  for (const detail of [false, true]) {
    const text = renderStatusText({ ...report, detail: detail ? report.detail : undefined }, { detail, columns: 140 }).replace(/\s+/g, " ");
    assert.match(text, /1 pending/);
    assert.match(text, /1 retained failed runs requiring attention/);
    assert.doesNotMatch(text + JSON.stringify(report), /PRIVATE_SYNTHETIC_ERROR|__run_fence|cursor_before_json|scope_config/);
    if (detail) { assert.match(text, /2 retained failed runs/); assert.match(text, /1 legacy list runs have later detail closure evidence/); }
  }
});

test("scope readiness rejects a successful pending stage even when mistakenly referenced by last_success", (t) => {
  const { db, insert } = fixture(t);
  const { list } = evidence();
  insert(meta({ ...list, status: "succeeded", error_type: null }, {
    lark_progress: { version: 1, phase: "list", outcome: "awaiting_details", attempted: 0, completed: 0, failed: 0, generation: 4 },
  }));
  sqliteExec(db, `UPDATE sync_scopes SET last_success_run_id=7,cursor_json=${quote(cursor(START))} WHERE id='lark.im.sent_by_me';
    UPDATE sync_scopes SET cursor_json='{"has_more":false}' WHERE id='lark.im.unmuted_chat_discovery';`);
  const report = buildStatus(db);
  assert.equal(report.scopes.message_without_success, 1);
  assert.equal(report.health, "not_ready");
  assert.equal(report.runs.by_status.succeeded, 1, "raw operation success count is retained");
  sqliteExec(db, "UPDATE sync_runs SET metadata_json=NULL WHERE id=7;");
  assert.equal(buildStatus(db).health, "ok", "schema-valid legacy null metadata remains compatible");
});

test("global proof budget leaves unexamined history unknown without loading its metadata", (t) => {
  const { db, insert } = fixture(t);
  const { list, closure } = evidence();
  const pastList = { ...list, started_at: "2020-03-01T00:00:00.000Z", finished_at: "2020-03-01T00:00:01.000Z" };
  insert(pastList);
  sqliteExec(db, `WITH RECURSIVE ids(id) AS (VALUES(8) UNION ALL SELECT id+1 FROM ids WHERE id<207)
    INSERT INTO sync_runs(id,source_id,scope_id,status,started_at,finished_at,cursor_before_json,error_type,metadata_json)
    SELECT ids.id,r.source_id,r.scope_id,r.status,r.started_at,r.finished_at,r.cursor_before_json,r.error_type,r.metadata_json
    FROM ids CROSS JOIN sync_runs r WHERE r.id=7;`);
  insert({ ...closure, id: 208, started_at: "2020-03-01T00:00:02.000Z", finished_at: "2020-03-01T00:00:03.000Z" });
  const rows = readOnlySqliteJson(db, runEvidenceSql("r.status='failed'", { cutoffSql: String(NOW) }) + ";", "synthetic proof budget");
  assert.equal(rows.length, 201, "raw failure history is complete");
  assert.equal(rows.filter((row) => runProgress(row).resolution === "resolved").length, 200);
  const unexamined = rows.find((row) => row.id === 7);
  assert.equal(unexamined.metadata_json, null);
  assert.equal(unexamined.closure_candidates_json, null);
  assert.equal(runProgress(unexamined).resolution, "unknown");
  sqliteExec(db, `UPDATE sync_scopes SET last_success_run_id=208,cursor_json=${quote(closure.cursor_after_json)} WHERE id='lark.im.sent_by_me';
    UPDATE sync_scopes SET cursor_json='{"has_more":false}' WHERE id='lark.im.unmuted_chat_discovery';`);
  const report = buildStatus(db);
  assert.deepEqual(report.runs.transitions, { resolved: 200, unresolved: 0, unknown: 1 });
  assert.equal(report.runs.by_status.failed, 201);
  assert.equal(report.runs.actionable_failed_runs, 1);
  sqliteExec(db, "DELETE FROM sync_runs WHERE id=7;");
  const closed = buildStatus(db);
  assert.equal(closed.runs.by_status.failed, 200);
  assert.equal(closed.health, "ok", "resolved transitions alone do not create historical-failure health");
  sqliteExec(db, `INSERT INTO lark_im_detail_tasks(scope_id,message_id,raw_root_json,fingerprint,occurred_at_ms,status,retry_at,created_at,updated_at)
    VALUES ('lark.im.sent_by_me','synthetic_new_version','{}','invented',${START},'pending','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z');`);
  const pending = buildStatus(db);
  assert.equal(pending.runs.transitions.resolved, 200);
  assert.equal(pending.details.pending_count, 1);
  assert.equal(pending.health, "catching_up", "new debt remains visible after historical closure");
});

test("oversized proof cursor cannot be projected into a false initial null cursor", (t) => {
  const { db, insert } = fixture(t);
  const { list, closure } = evidence({ initial: true });
  insert(list);
  insert({ ...closure, cursor_before_json: JSON.stringify({ kind: "time_message_cursor/v1", created_at_ms: START, padding: "x".repeat(17000) }) });
  const row = readOnlySqliteJson(db, runEvidenceSql("r.status='failed'", { cutoffSql: String(NOW) }) + ";", "synthetic oversized cursor")[0];
  assert.notEqual(runProgress(row).resolution, "resolved");
  sqliteExec(db, `UPDATE sync_runs SET cursor_before_json=${quote(JSON.stringify({ kind: "time_message_cursor/v1", created_at_ms: START, padding: "x".repeat(17000) }))} WHERE id=7;`);
  const both = readOnlySqliteJson(db, runEvidenceSql("r.status='failed'", { cutoffSql: String(NOW) }) + ";", "synthetic oversized before cursors")[0];
  assert.equal(runProgress(both).resolution, "unknown");
});
