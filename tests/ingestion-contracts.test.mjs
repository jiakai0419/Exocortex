import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as store from "../dist/storage/sqlite/ingestion-store.js";

// Every identity, timestamp and body is a newly invented fixture.
const START = Date.parse("2026-01-01T00:00:00Z");
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-contract-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "synthetic.sqlite");
  store.ensureInitialized(db);
  store.sqliteExec(db, `UPDATE sources SET config_json='{"initial_sync_start_ms":${START}}' WHERE id='lark.im';`);
  const scope = store.readScope(db, "lark.im.sent_by_me");
  return { db, scope };
}
function record(scope) {
  return { source_id: scope.source_id, first_seen_scope_id: scope.id, external_id: "synthetic-contract-record",
    external_version: "1", record_type: "lark.im.message", occurred_at: new Date(START).toISOString(),
    occurred_at_ms: START, actor_id: "synthetic-actor", container_id: "synthetic-chat", direction: "sent",
    title: null, body: "invented contract fixture", content_hash: "synthetic-hash", canonical_json: "{}",
    raw_json: '{"message_id":"synthetic-contract-record","create_time":"1767225600000","msg_type":"text"}' };
}
function snapshot(db) {
  return Object.fromEntries(["records", "sync_runs", "sync_scopes", "sync_locks", "lark_im_list_progress", "lark_im_detail_tasks"]
    .map((table) => [table, store.sqliteQuery(db, `SELECT * FROM ${table};`)]));
}
function finish(db, scope, runId, mode) {
  if (mode === "records") return store.succeedRecordRun(db, scope, runId, [record(scope)], 1, { created_at_ms: START + 1000 }, {});
  if (mode === "partial-records") return store.failRecordRun(db, scope, runId, [record(scope)], 1, new Error("invented fetch failure"), {});
  return store.commitLarkListRun(db, scope, runId, [record(scope)], [], 1, { created_at_ms: START + 1000 },
    { initial_sync_start_ms: START, list_window_start_ms: START, list_window_end_ms: START + 1000 });
}

test("the shared hard lease is twenty minutes for every writer", () => {
  assert.equal(store.DEFAULT_HARD_LEASE_SECONDS, 20 * 60);
});
test("disabled sources reject a persisted initial baseline and expose their state on scopes", (t) => {
  const { db, scope } = fixture(t);
  store.sqliteExec(db, "UPDATE sources SET enabled=0 WHERE id='lark.im';");
  assert.equal(store.readScope(db, scope.id).source_enabled, 0);
  assert.throws(() => store.ensureSourceInitialSyncStart(db, "lark.im", START), /disabled/);
});
for (const target of ["sources", "sync_scopes"]) {
  test(`disabled ${target} cannot acquire a lock or create a run`, (t) => {
    const { db, scope } = fixture(t);
    store.sqliteExec(db, `UPDATE ${target} SET enabled=0;`);
    const before = snapshot(db);
    assert.equal(store.acquireLock(db, scope.id, 60), false);
    assert.throws(() => store.createRun(db, scope), /rejected/);
    assert.deepEqual(snapshot(db), before, "rejected implicit acquisition cannot leave a lock");
  });
  for (const mode of ["records", "partial-records", "list"]) {
    test(`${mode}: ${target} disabled after fetch rolls back records, progress and cursor`, (t) => {
      const { db, scope } = fixture(t);
      const runId = store.createRun(db, scope);
      store.sqliteExec(db, `UPDATE ${target} SET enabled=0;`);
      const before = snapshot(db);
      assert.throws(() => finish(db, scope, runId, mode), /rejected|CHECK constraint/);
      assert.deepEqual(snapshot(db), before);
      assert.equal(store.failRun(db, scope, runId, new Error("disabled during fetch")), true,
        "a disabled source may close the owned run without writing records or cursor");
      assert.equal(store.sqliteQuery(db, "SELECT count(*) AS n FROM records;")[0].n, 0);
      assert.equal(store.readScope(db, scope.id).cursor, null);
    });
  }
}
for (const mode of ["records", "partial-records", "list"]) {
  test(`${mode}: a 21-minute lease cannot commit while its owner is still alive`, (t) => {
    const { db, scope } = fixture(t);
    const runId = store.createRun(db, scope);
    const lockedAt = new Date(Date.now() - 21 * 60_000).toISOString();
    store.sqliteExec(db, `UPDATE sync_locks SET locked_at=${store.quoteSql(lockedAt)};
      UPDATE sync_runs SET metadata_json=json_set(metadata_json,'$.__run_fence.locked_at',${store.quoteSql(lockedAt)});`);
    const before = snapshot(db);
    assert.throws(() => finish(db, scope, runId, mode), /rejected|CHECK constraint/);
    assert.deepEqual(snapshot(db), before);
  });
}

test("shared fence uses the transaction clock, independent of completion timestamps", (t) => {
  const { db, scope } = fixture(t);
  const runId = store.createRun(db, scope);
  const guard = (finish) => store.sqliteQuery(db, `BEGIN IMMEDIATE;
    ${store.runFenceGuardSql(scope, runId, finish, { assert: true })}
    SELECT count(*) AS n FROM __run_fence_guard; COMMIT;`);
  assert.equal(guard("2099-01-01T00:00:00Z")[0].n, 1, "future display clocks do not expire a current lease");
  const lockedAt = new Date(Date.now() - 21 * 60_000).toISOString();
  store.sqliteExec(db, `UPDATE sync_locks SET locked_at=${store.quoteSql(lockedAt)};
    UPDATE sync_runs SET metadata_json=json_set(metadata_json,'$.__run_fence.locked_at',${store.quoteSql(lockedAt)});`);
  assert.throws(() => guard("2000-01-01T00:00:00Z"), /CHECK constraint/, "old display clocks cannot extend a stale lease");
});
