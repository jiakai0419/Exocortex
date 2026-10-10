import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireLock, commitLarkListRun, createRun, ensureInitialized, ensureSourceInitialSyncStart,
  finishLarkDetailRun, readLarkListProgress, readPendingLarkDetails, readScope,
  releaseLock, sqliteExec, sqliteQuery, upsertRecordsSql,
} from "../dist/storage/sqlite/ingestion-store.js";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";
import { recordFromMessage } from "../src/adapters/lark-im/message-record.mjs";
import { createLarkImAdapter } from "../src/adapters/lark-im/adapter.mjs";

// All identities and content in this file are invented from scratch.
const START = Date.parse("2026-01-01T00:00:00Z");
const SCOPE = "lark.im.sent_by_me";
const cursor = (end) => ({ kind: "lark.im.time_cursor/v1", created_at_ms: end, message_id: "" });
function database(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-detail-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "synthetic.sqlite");
  ensureInitialized(db);
  ensureSourceInitialSyncStart(db, "lark.im", START, { explicit: true });
  return db;
}
function raw(id, at, version = START, type = "merge_forward") {
  return { message_id: id, msg_type: type, create_time: String(at), update_time: String(version),
    chat_id: "invented-chat", sender: { id: "invented-author", sender_type: "user" },
    body: { content: JSON.stringify(type === "text" ? { text: `Invented text ${id}` } : {}) } };
}
function ordinary(id, at) {
  return recordFromMessage(normalizeApiMessage(raw(id, at, at, "text")), SCOPE, "sent");
}
function detailRecord(root, overrides = {}) {
  const child = { ...raw(`${root.message_id}-child`, Number(root.create_time), Number(root.update_time), "text"),
    upper_message_id: root.message_id };
  return { ...recordFromMessage(normalizeApiMessage(root, { mergeItems: [root, child] }), SCOPE, "sent"), ...overrides };
}
function begin(db, metadata = {}) {
  const scope = readScope(db, SCOPE);
  return { scope, runId: createRun(db, scope, metadata) };
}
function list(db, start, end, roots = [], records = [], metadata = {}) {
  const { scope, runId } = begin(db);
  const effects = commitLarkListRun(db, scope, runId, records, roots, records.length + roots.length, cursor(end), {
    initial_sync_start_ms: START, list_window_start_ms: start, list_window_end_ms: end, ...metadata,
  });
  return { effects, runId };
}
function retry(db, task, outcome, metadata = {}) {
  const { scope, runId } = begin(db);
  const effects = finishLarkDetailRun(db, scope, runId, [
    { message_id: task.message_id, fingerprint: task.fingerprint, ...outcome },
  ], metadata);
  return { effects, runId };
}
function pending(db, options = {}) {
  return readPendingLarkDetails(db, readScope(db, SCOPE), { now: "2099-01-01T00:00:00Z", ...options });
}
function tasks(db) { return sqliteQuery(db, "SELECT * FROM lark_im_detail_tasks ORDER BY message_id;", "read synthetic debt"); }
function records(db) { return sqliteQuery(db, "SELECT external_id, body, raw_json, external_version FROM records ORDER BY external_id;", "read synthetic records"); }
function run(db, id) {
  const row = sqliteQuery(db, `SELECT * FROM sync_runs WHERE id=${id};`, "read synthetic run")[0];
  return { ...row, metadata: JSON.parse(row.metadata_json) };
}

test("pending details leave full cursor unchanged while ordinary records and durable list coverage continue", (t) => {
  const db = database(t);
  const root = raw("invented-merge", START + 1_000);
  const first = list(db, START, START + 2_000, [root], [ordinary("invented-one", START + 500)], {
    window_start_ms: START, window_end_ms: START + 2_000, coverage_mode: "invented false evidence", details_complete: true,
    lark_progress: { version: 1, phase: "details", outcome: "complete", attempted: 99, failed: 0 },
  });
  assert.equal(first.effects.pending_details, 1);
  assert.equal(first.effects.full_cursor_promoted, false);
  assert.equal(readScope(db, SCOPE).cursor, null);
  const firstRun = run(db, first.runId);
  assert.equal(firstRun.status, "succeeded");
  assert.equal(firstRun.error_type, null);
  assert.equal(firstRun.error_message, null);
  assert.equal(firstRun.cursor_after_json, null);
  assert.deepEqual(firstRun.metadata.lark_progress, { version: 1, phase: "list", outcome: "awaiting_details",
    attempted: 0, completed: 0, failed: 0, generation: 1 });
  assert.deepEqual(sqliteQuery(db, `SELECT last_success_run_id,last_error_run_id FROM sync_scopes WHERE id='${SCOPE}';`)[0],
    { last_success_run_id: null, last_error_run_id: null });
  assert.equal(firstRun.metadata.list_complete, true);
  assert.equal(firstRun.metadata.details_complete, false);
  assert.equal(firstRun.metadata.window_complete, false);
  assert.equal(firstRun.metadata.window_start_ms, undefined);
  assert.equal(firstRun.metadata.coverage_mode, undefined);
  list(db, START + 2_000, START + 4_000, [], [ordinary("invented-two", START + 3_000)]);
  assert.equal(readScope(db, SCOPE).cursor, null);
  assert.equal(readLarkListProgress(db, readScope(db, SCOPE)).cursor.created_at_ms, START + 4_000);
  assert.deepEqual(records(db).map((item) => item.external_id), ["invented-one", "invented-two"]);
  assert.deepEqual(pending(db)[0].raw_root, root);
});

test("detail failures reschedule durably without changing known records or starving later list windows", (t) => {
  const db = database(t);
  const root = raw("invented-merge", START + 1_000);
  list(db, START, START + 1_000, [root]);
  retry(db, pending(db)[0], { record: detailRecord(root) });
  const before = records(db);
  const newer = { ...root, update_time: String(START + 2_000), body: { content: '{"revision":2}' } };
  list(db, START + 1_000, START + 1_000, [newer]);
  const failure = retry(db, pending(db)[0], { error: new Error("invented permission denial") });
  assert.equal(failure.effects.pending_details, 1);
  assert.equal(run(db, failure.runId).status, "failed");
  assert.equal(run(db, failure.runId).metadata.lark_progress.outcome, "attempt_failed");
  assert.equal(run(db, failure.runId).metadata.lark_progress.failed, 1);
  assert.deepEqual(records(db), before);
  const task = tasks(db)[0];
  assert.equal(task.attempt_count, 1);
  assert.equal(task.status, "pending");
  assert.equal(task.last_error_message, "invented permission denial");
  assert.ok(Date.parse(task.retry_at) >= Date.parse(task.updated_at) + 60_000);
  assert.equal(pending(db, { now: new Date(task.updated_at) }).length, 0);
  list(db, START + 1_000, START + 3_000, [], [ordinary("invented-later", START + 2_500)]);
  assert.equal(sqliteQuery(db, `SELECT last_error_run_id FROM sync_scopes WHERE id='${SCOPE}';`)[0].last_error_run_id, failure.runId);
  assert.equal(readLarkListProgress(db, readScope(db, SCOPE)).cursor.created_at_ms, START + 3_000);
  assert.ok(records(db).some((record) => record.external_id === "invented-later"));
  assert.equal(readScope(db, SCOPE).cursor.created_at_ms, START + 1_000);
});

test("last resolved debt promotes composed list proof and resets the next coverage anchor", (t) => {
  const db = database(t);
  const root = raw("invented-merge", START + 1_000);
  list(db, START, START + 2_000, [root]);
  list(db, START + 2_000, START + 4_000);
  const closed = retry(db, pending(db)[0], { record: detailRecord(root) });
  assert.equal(closed.effects.full_cursor_promoted, true);
  assert.equal(readScope(db, SCOPE).cursor.created_at_ms, START + 4_000);
  const evidence = run(db, closed.runId);
  assert.equal(evidence.status, "succeeded");
  assert.equal(evidence.metadata.coverage_mode, "list_checkpoint_and_details");
  assert.equal(evidence.metadata.window_start_ms, START);
  assert.equal(evidence.metadata.window_end_ms, START + 4_000);
  assert.equal(evidence.metadata.window_start, new Date(START).toISOString());
  assert.equal(evidence.metadata.details_complete, true);
  assert.equal(evidence.metadata.pending_detail_count, 0);
  const next = list(db, START + 4_000, START + 5_000);
  assert.equal(run(db, next.runId).metadata.window_start_ms, START + 4_000);
  assert.equal(readLarkListProgress(db, readScope(db, SCOPE)).coverage_start_ms, START + 5_000);
});

test("a successful bounded detail batch leaves unattempted debt without recording a failed run", (t) => {
  const db = database(t);
  const roots = [raw("invented-batch-one", START + 500), raw("invented-batch-two", START + 1_000)];
  const listed = list(db, START, START + 2_000, roots);
  const original = run(db, listed.runId);
  const first = retry(db, pending(db)[0], { record: detailRecord(roots[0]) }, {
    lark_progress: { version: 1, phase: "list", outcome: "complete", failed: 0 },
  });
  assert.equal(first.effects.pending_details, 1);
  assert.equal(first.effects.full_cursor_promoted, false);
  const batch = run(db, first.runId);
  assert.equal(batch.status, "succeeded");
  assert.equal(batch.error_type, null);
  assert.deepEqual(batch.metadata.lark_progress, { version: 1, phase: "details", outcome: "awaiting_details",
    attempted: 1, completed: 1, failed: 0, generation: 2 });
  assert.equal(readScope(db, SCOPE).cursor, null);
  const closed = retry(db, pending(db)[0], { record: detailRecord(roots[1]) });
  assert.equal(run(db, closed.runId).metadata.lark_progress.outcome, "complete");
  assert.equal(closed.effects.full_cursor_promoted, true);
  assert.deepEqual(run(db, listed.runId), original, "subsequent detail completion never rewrites the list run");
});

test("completed root receipts ignore unchanged key-order replay and provably older versions, reopening newer debt", (t) => {
  const db = database(t);
  const root = raw("invented-boundary", START + 1_000, START + 2_000);
  list(db, START, START + 1_000, [root]);
  retry(db, pending(db)[0], { record: detailRecord(root) });
  const receipt = tasks(db)[0];
  const reordered = Object.fromEntries(Object.entries(root).reverse());
  list(db, START + 1_000, START + 1_000, [reordered]);
  assert.equal(pending(db).length, 0);
  assert.deepEqual(tasks(db)[0], receipt);
  list(db, START + 1_000, START + 1_000, [{ ...root, update_time: String(START + 1_000) }]);
  assert.deepEqual(tasks(db)[0], receipt);
  list(db, START + 1_000, START + 1_000, [{ ...root, update_time: String(START + 3_000) }]);
  assert.equal(pending(db).length, 1);
  assert.equal(tasks(db)[0].attempt_count, 0);
  assert.notEqual(tasks(db)[0].fingerprint, receipt.fingerprint);
});

test("changed descriptor with an unknown version conservatively reopens detail debt", (t) => {
  const db = database(t);
  const root = raw("invented-unknown", START + 1_000);
  list(db, START, START + 1_000, [root]);
  retry(db, pending(db)[0], { record: detailRecord(root) });
  const changed = { ...root, update_time: undefined, body: { content: '{"changed":true}' } };
  list(db, START + 1_000, START + 1_000, [changed]);
  assert.equal(pending(db).length, 1);
  assert.equal(tasks(db)[0].external_version, null);
});

test("a stale list snapshot cannot write records even when full cursor is still unchanged", (t) => {
  const db = database(t);
  assert.equal(acquireLock(db, SCOPE, 60), true);
  const scope = readScope(db, SCOPE);
  const olderRun = createRun(db, scope);
  const newerRun = createRun(db, scope);
  const root = raw("invented-merge", START + 1_000);
  commitLarkListRun(db, scope, newerRun, [], [root], 1, cursor(START + 2_000), {
    initial_sync_start_ms: START, list_window_start_ms: START, list_window_end_ms: START + 2_000,
  });
  assert.equal(readScope(db, SCOPE).cursor, null);
  assert.throws(() => commitLarkListRun(db, scope, olderRun, [ordinary("invented-stale", START + 2_500)], [], 1,
    cursor(START + 3_000), { initial_sync_start_ms: START, list_window_start_ms: START + 2_000, list_window_end_ms: START + 3_000 }), /stale|unfenced/);
  assert.equal(records(db).length, 0);
  assert.equal(readLarkListProgress(db, scope).cursor.created_at_ms, START + 2_000);
  releaseLock(db, SCOPE);
});

test("detail fingerprint compare-and-set rejects stale source results atomically", (t) => {
  const db = database(t);
  const root = raw("invented-merge", START + 1_000);
  list(db, START, START + 2_000, [root]);
  const task = pending(db)[0];
  const { scope, runId } = begin(db);
  sqliteExec(db, "UPDATE lark_im_detail_tasks SET fingerprint='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';", "simulate revised descriptor");
  assert.throws(() => finishLarkDetailRun(db, scope, runId, [{ message_id: task.message_id,
    fingerprint: task.fingerprint, record: detailRecord(root) }]), /stale|unfenced/);
  assert.equal(records(db).length, 0);
  assert.equal(tasks(db)[0].attempt_count, 0);
  assert.equal(run(db, runId).status, "running");
});

test("lock and full-cursor changes reject detail writes and preserve debt", (t) => {
  for (const change of ["lock", "cursor"]) {
    const db = database(t);
    const root = raw("invented-merge", START + 1_000);
    list(db, START, START + 2_000, [root]);
    const task = pending(db)[0];
    const { scope, runId } = begin(db);
    sqliteExec(db, change === "lock" ? "UPDATE sync_locks SET locked_by='invented-other-worker';"
      : `UPDATE sync_scopes SET cursor_json='${JSON.stringify(cursor(START + 3_000))}' WHERE id='${SCOPE}';`, "simulate lost ownership");
    assert.throws(() => finishLarkDetailRun(db, scope, runId, [{ message_id: task.message_id,
      fingerprint: task.fingerprint, record: detailRecord(root) }]), /stale|unfenced/);
    assert.equal(records(db).length, 0);
    assert.equal(tasks(db)[0].status, "pending");
  }
});

test("list gaps and mismatched initial baselines cannot create false coverage or persist candidates", (t) => {
  for (const initial of [START, START + 1_000]) {
    const db = database(t);
    const { scope, runId } = begin(db);
    assert.throws(() => commitLarkListRun(db, scope, runId, [ordinary("invented-gap", START + 1_500)], [], 1,
      cursor(START + 2_000), { initial_sync_start_ms: initial,
        list_window_start_ms: START + 1_000, list_window_end_ms: START + 2_000 }), /discontinuous/);
    assert.equal(records(db).length, 0);
    assert.equal(readLarkListProgress(db, scope), null);
  }
  const db = database(t);
  list(db, START, START + 1_000, [raw("invented-debt", START + 500)]);
  const { scope, runId } = begin(db);
  assert.throws(() => commitLarkListRun(db, scope, runId, [], [], 0, cursor(START + 3_000), {
    initial_sync_start_ms: START, list_window_start_ms: START + 2_000, list_window_end_ms: START + 3_000,
  }), /discontinuous/);
  assert.equal(readLarkListProgress(db, scope).cursor.created_at_ms, START + 1_000);
});

test("record constraint errors roll back the list checkpoint and detail queue with the fact write", (t) => {
  const db = database(t);
  const { scope, runId } = begin(db);
  const invalid = { ...ordinary("invented-invalid", START + 500), canonical_json: "invalid-json" };
  assert.throws(() => commitLarkListRun(db, scope, runId, [invalid], [raw("invented-merge", START + 1_000)], 2,
    cursor(START + 2_000), { initial_sync_start_ms: START, list_window_start_ms: START, list_window_end_ms: START + 2_000 }), /CHECK constraint/);
  assert.equal(records(db).length, 0);
  assert.equal(tasks(db).length, 0);
  assert.equal(readLarkListProgress(db, scope), null);
  assert.equal(run(db, runId).status, "running");
});

test("discovery metadata churn permits progress while chat identity changes are fenced", (t) => {
  const db = database(t);
  const root = raw("invented-merge", START + 1_000);
  list(db, START, START + 2_000, [root]);
  const { scope, runId } = begin(db);
  sqliteExec(db, `UPDATE sync_scopes SET config_json='{"hot_rank":5,"hot_seen_at":"2026-01-01T00:00:00Z","chat_name":"Invented label"}' WHERE id='${SCOPE}';`, "simulate discovery metadata");
  commitLarkListRun(db, scope, runId, [], [], 0, cursor(START + 3_000), {
    initial_sync_start_ms: START, list_window_start_ms: START + 2_000, list_window_end_ms: START + 3_000,
  });
  assert.equal(readLarkListProgress(db, readScope(db, SCOPE)).cursor.created_at_ms, START + 3_000);
  const next = begin(db);
  sqliteExec(db, `UPDATE sync_scopes SET config_json='{"chat_id":"invented-different-chat"}' WHERE id='${SCOPE}';`, "simulate source identity change");
  assert.throws(() => readLarkListProgress(db, readScope(db, SCOPE)), /configuration changed/);
  assert.throws(() => commitLarkListRun(db, next.scope, next.runId, [ordinary("invented-stale", START + 3_500)], [], 1,
    cursor(START + 4_000), { initial_sync_start_ms: START, list_window_start_ms: START + 3_000, list_window_end_ms: START + 4_000 }), /stale|unfenced/);
  assert.equal(records(db).length, 0);
});

test("incomplete merged placeholders and regressed detail versions cannot retire debt", (t) => {
  const db = database(t);
  const root = raw("invented-merge", START + 1_000, START + 3_000);
  const placeholder = recordFromMessage(normalizeApiMessage(root), SCOPE, "sent");
  const first = begin(db);
  assert.throws(() => commitLarkListRun(db, first.scope, first.runId, [placeholder], [], 1, cursor(START + 2_000), {
    initial_sync_start_ms: START, list_window_start_ms: START, list_window_end_ms: START + 2_000,
  }), /placeholders/);
  releaseLock(db, SCOPE);
  list(db, START, START + 2_000, [root]);
  const task = pending(db)[0];
  assert.throws(() => retry(db, task, { record: placeholder }), /complete source evidence/);
  releaseLock(db, SCOPE);
  assert.throws(() => retry(db, task, { record: detailRecord({ ...root, update_time: String(START + 2_000) }) }), /stale|unfenced/);
  assert.equal(records(db).length, 0);
  assert.equal(tasks(db)[0].status, "pending");
});

test("detail retries are bounded and due order survives fresh scope reads", (t) => {
  const db = database(t);
  list(db, START, START + 3_000, [raw("invented-one", START + 1_000), raw("invented-two", START + 2_000)]);
  assert.equal(pending(db, { limit: 1 }).length, 1);
  assert.throws(() => pending(db, { limit: 101 }), /between 1 and 100/);
  assert.throws(() => pending(db, { now: "invalid clock" }), /invalid detail retry clock/);
  const first = pending(db)[0];
  retry(db, first, { error: new Error("invented timeout"), retry_at: "2099-01-01T00:00:00Z" });
  assert.deepEqual(pending(db, { now: "2098-01-01T00:00:00Z" }).map((task) => task.message_id), ["invented-two"]);
});

test("JSON null cursor and native zero update_time retain existing parser semantics", (t) => {
  const db = database(t);
  sqliteExec(db, `UPDATE sync_scopes SET cursor_json='null' WHERE id='${SCOPE}';`, "seed explicit null cursor");
  const root = raw("invented-zero-version", START + 1_000, 0);
  list(db, START, START + 2_000, [root]);
  assert.equal(pending(db)[0].external_version, "0");
  retry(db, pending(db)[0], { record: detailRecord(root) });
  assert.equal(readScope(db, SCOPE).cursor.created_at_ms, START + 2_000);
});

test("exhausted attempts retain debt with a bounded daily retry and type-changed root can resolve", (t) => {
  const db = database(t);
  const root = raw("invented-old-type", START + 1_000);
  list(db, START, START + 2_000, [root]);
  sqliteExec(db, "UPDATE lark_im_detail_tasks SET attempt_count=100;", "seed synthetic long-lived debt");
  retry(db, pending(db)[0], { error: new Error("invented persistent denial") });
  const task = tasks(db)[0];
  assert.equal(Date.parse(task.retry_at) - Date.parse(task.updated_at), 86_400_000);
  assert.equal(task.status, "pending");
  const refreshed = raw(root.message_id, Number(root.create_time), START + 3_000, "text");
  retry(db, pending(db)[0], { record: recordFromMessage(normalizeApiMessage(refreshed), SCOPE, "sent") });
  assert.equal(readScope(db, SCOPE).cursor.created_at_ms, START + 2_000);
  assert.equal(records(db)[0].body, `Invented text ${root.message_id}`);
});

test("an unordered detail response rejected by version protection remains retriable debt", (t) => {
  const db = database(t);
  const root = raw("invented-version-loss", START + 1_000);
  list(db, START, START + 1_000, [root]);
  retry(db, pending(db)[0], { record: detailRecord(root) });
  const before = records(db);
  const unknown = { ...root, update_time: undefined, body: { content: '{"revision":"unknown"}' } };
  list(db, START + 1_000, START + 2_000, [unknown]);
  const response = detailRecord(unknown);
  const finished = retry(db, pending(db)[0], { record: response });
  assert.equal(run(db, finished.runId).status, "failed");
  assert.equal(run(db, finished.runId).metadata.lark_progress.failed, 1);
  assert.equal(finished.effects.full_cursor_promoted, false);
  assert.equal(finished.effects.pending_details, 1);
  assert.deepEqual(records(db), before);
  const task = tasks(db)[0];
  assert.equal(task.status, "pending");
  assert.equal(task.last_error_type, "LarkDetailObservationConflict");
  assert.equal(task.attempt_count, 1);
  assert.ok(Date.parse(task.retry_at) > Date.parse(task.updated_at));
  assert.equal(readScope(db, SCOPE).cursor.created_at_ms, START + 1_000);
});

test("a detail version older than stored content backs off without blocking healthy sibling details", (t) => {
  const db = database(t);
  const stale = raw("invented-stale-source", START + 1_000, START + 2_000);
  const current = { ...stale, update_time: String(START + 4_000) };
  sqliteExec(db, upsertRecordsSql([detailRecord(current)]), "seed invented newer complete content");
  const healthy = raw("invented-healthy", START + 1_500, START + 3_000);
  list(db, START, START + 2_000, [stale, healthy]);
  const due = pending(db);
  const { scope, runId } = begin(db);
  const effects = finishLarkDetailRun(db, scope, runId, due.map((task) => ({ message_id: task.message_id,
    fingerprint: task.fingerprint, record: detailRecord(task.raw_root) })));
  assert.equal(effects.pending_details, 1);
  assert.deepEqual(run(db, runId).metadata.lark_progress, { version: 1, phase: "details", outcome: "attempt_failed",
    attempted: 2, completed: 1, failed: 1, generation: 2 });
  assert.equal(effects.full_cursor_promoted, false);
  assert.equal(records(db).find((record) => record.external_id === stale.message_id).external_version, String(START + 4_000));
  assert.equal(tasks(db).find((task) => task.message_id === stale.message_id).last_error_type, "LarkDetailObservationConflict");
  assert.equal(tasks(db).find((task) => task.message_id === healthy.message_id).status, "complete");
  assert.equal(readScope(db, SCOPE).cursor, null);
});

test("a newer authoritative detail root becomes the completed receipt for inclusive replay", (t) => {
  const db = database(t);
  const queued = raw("invented-refreshed", START + 1_000, START + 2_000);
  list(db, START, START + 1_000, [queued]);
  const original = pending(db)[0];
  const refreshed = { ...queued, update_time: String(START + 3_000), upper_message_id: "",
    body: { content: '{"revision":3}' } };
  retry(db, original, { record: detailRecord(refreshed) });
  const receipt = tasks(db)[0];
  assert.notEqual(receipt.fingerprint, original.fingerprint);
  assert.equal(receipt.external_version, String(START + 3_000));
  assert.equal(JSON.parse(receipt.raw_root_json).raw_api_expansions, undefined);
  const listed = { ...refreshed, create_time: Number(refreshed.create_time), update_time: Number(refreshed.update_time) };
  delete listed.upper_message_id;
  list(db, START + 1_000, START + 2_000, [listed]);
  assert.equal(pending(db).length, 0);
  assert.deepEqual(tasks(db)[0], receipt);
});

test("identical duplicated merge roots deduplicate, while conflicting pages reject all candidate writes", (t) => {
  const db = database(t);
  const root = raw("invented-repeat", START + 1_000);
  list(db, START, START + 2_000, [root, Object.fromEntries(Object.entries(root).reverse())]);
  assert.equal(tasks(db).length, 1);
  assert.equal(tasks(db)[0].attempt_count, 0);
  const other = database(t);
  assert.throws(() => list(other, START, START + 2_000, [root, { ...root, body: { content: '{"conflict":true}' } }],
    [ordinary("invented-candidate", START + 500)]), /conflicting duplicate/);
  assert.equal(tasks(other).length, 0);
  assert.equal(records(other).length, 0);
  assert.equal(readLarkListProgress(other, readScope(other, SCOPE)), null);
});

for (const boundary of ["hard lease expired", "run cancelled"]) {
  test(`Lark list commits reject ${boundary} without changing facts, debt or coverage`, (t) => {
    const db = database(t);
    list(db, START, START + 2_000, [raw("invented-protected", START + 1_000)]);
    const before = tasks(db);
    const { scope, runId } = begin(db);
    if (boundary === "hard lease expired") {
      const expired = new Date(Date.now() - 61 * 60_000).toISOString();
      sqliteExec(db, `UPDATE sync_locks SET locked_at='${expired}';
        UPDATE sync_runs SET metadata_json=json_set(metadata_json, '$.__run_fence.locked_at', '${expired}') WHERE id=${runId};`,
      "simulate matching ownership beyond hard lease ceiling");
    } else {
      sqliteExec(db, `UPDATE sync_runs SET status='cancelled' WHERE id=${runId};`, "simulate cancelled run");
    }
    assert.throws(() => commitLarkListRun(db, scope, runId, [ordinary("invented-forbidden", START + 2_500)], [], 1,
      cursor(START + 3_000), { initial_sync_start_ms: START, list_window_start_ms: START + 2_000,
        list_window_end_ms: START + 3_000 }), /stale|unfenced/);
    assert.equal(records(db).length, 0);
    assert.deepEqual(tasks(db), before);
    assert.equal(readLarkListProgress(db, scope).cursor.created_at_ms, START + 2_000);
    assert.equal(readScope(db, SCOPE).cursor, null);
  });
}

test("an expired soft TTL retains the existing live-owner commit semantics before the hard ceiling", (t) => {
  const db = database(t);
  const { scope, runId } = begin(db);
  sqliteExec(db, `UPDATE sync_locks SET expires_at='${new Date(Date.now() - 60_000).toISOString()}';`,
    "simulate soft TTL expiry under a retained live lock");
  const effects = commitLarkListRun(db, scope, runId, [ordinary("invented-permitted", START + 500)], [], 1,
    cursor(START + 1_000), { initial_sync_start_ms: START, list_window_start_ms: START, list_window_end_ms: START + 1_000 });
  assert.equal(effects.inserted, 1);
  assert.equal(effects.full_cursor_promoted, true);
  assert.equal(readScope(db, SCOPE).cursor.created_at_ms, START + 1_000);
});


test("equal-version rejected details keep coverage debt while a healthy sibling completes and later newer detail resolves", (t) => {
  const db = database(t), root = raw("invented-source-conflict", START + 1_000, START + 2_000);
  list(db, START, START + 1_000, [root]);
  retry(db, pending(db)[0], { record: detailRecord(root) });
  const before = records(db)[0];
  const changed = { ...root, body: { content: '{"unknown_revision":2}' } };
  const sibling = raw("invented-healthy-sibling", START + 2_000, START + 3_000);
  list(db, START + 1_000, START + 3_000, [changed, sibling]);
  const { scope, runId } = begin(db);
  const effects = finishLarkDetailRun(db, scope, runId, pending(db).map(task => ({
    message_id: task.message_id, fingerprint: task.fingerprint,
    record: recordFromMessage(createLarkImAdapter({run: args => {
      assert.equal(args[2], `/open-apis/im/v1/messages/${task.message_id}`);
      return {code:0,data:{items:JSON.parse(detailRecord(task.raw_root).raw_json).raw_api_expansions.merge_forward.items}};
    }}).fetchMessageDetails(task.raw_root,{retries:0,detailMaxPages:2,detailMaxItems:100}),SCOPE,"sent"),
  })));
  assert.equal(effects.updated, 0); assert.equal(effects.conflicts, 1); assert.equal(effects.inserted, 1);
  assert.equal(effects.pending_details, 1); assert.equal(effects.full_cursor_promoted, false);
  assert.equal(readScope(db, SCOPE).cursor.created_at_ms, START + 1_000);
  const evidence = run(db, runId);
  assert.equal(evidence.status, "failed"); assert.equal(evidence.metadata.details_complete, false);
  assert.equal(evidence.metadata.window_complete, false); assert.equal(evidence.metadata.coverage_mode, undefined);
  assert.deepEqual([evidence.metadata.lark_progress.completed,evidence.metadata.lark_progress.failed],[1,1]);
  const debt = tasks(db).find(task => task.message_id === root.message_id);
  assert.equal(debt.status, "pending"); assert.equal(debt.last_error_type, "LarkDetailObservationConflict");
  assert.ok(Date.parse(debt.retry_at) >= Date.parse(debt.updated_at) + 60_000);
  assert.equal(tasks(db).find(task => task.message_id === sibling.message_id).status, "complete");
  assert.deepEqual(records(db).find(row => row.external_id === root.message_id), before);
  // Repeating the same sent observation cannot self-confirm; it is not in history's received domain.
  assert.equal(retry(db, debt, { record: detailRecord(changed) }).effects.pending_details, 1);
  const resolved = retry(db, pending(db)[0], { record: detailRecord({ ...changed, update_time: String(START + 4_000) }) });
  assert.equal(resolved.effects.full_cursor_promoted, true);
  assert.equal(readScope(db, SCOPE).cursor.created_at_ms, START + 3_000);
});

test("an equivalent complete detail no-op can retire debt without rewriting its raw representative", (t) => {
  const db = database(t), root = raw("invented-equivalent-detail", START + 1_000, START + 2_000);
  list(db, START, START + 2_000, [root]);
  const complete = detailRecord(root);
  sqliteExec(db, upsertRecordsSql([complete]), "another path selected the same complete observation");
  const reordered = Object.fromEntries(Object.entries(root).reverse());
  reordered.body = { content: ' { } ' };
  const finished = retry(db, pending(db)[0], { record: detailRecord(reordered) });
  assert.equal(finished.effects.conflicts, undefined); assert.equal(finished.effects.full_cursor_promoted, true);
  assert.equal(tasks(db)[0].status, "complete"); assert.equal(run(db, finished.runId).metadata.details_complete, true);
  assert.equal(records(db)[0].raw_json, complete.raw_json);
});
