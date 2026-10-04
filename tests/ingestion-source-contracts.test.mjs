import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as store from "../dist/storage/sqlite/ingestion-store.js";
import { loadExistingRecords } from "../src/diagnostics/lark-im-lag-report.mjs";
import { buildStatus } from "../src/diagnostics/sync-status-report.mjs";
import { loadMessages } from "../src/diagnostics/messages-report.mjs";

const token = (value) => `opaque:${JSON.stringify(value)}`;
const T = Date.parse("2026-02-03T04:05:06Z");
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-source-contract-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "invented.sqlite");
  store.ensureInitialized(db);
  store.sqliteExec(db, `INSERT INTO sources(id,kind,display_name) VALUES('synthetic.notes','test','Invented notes');
    INSERT INTO sync_scopes(id,source_id,name) VALUES('synthetic.notes.scope','synthetic.notes','Invented scope');`);
  return { db, scope: store.readScope(db, "synthetic.notes.scope") };
}
function record(scope, overrides = {}) {
  return { source_id: scope.source_id, first_seen_scope_id: scope.id, external_id: "synthetic-shared-id",
    external_version: token("1"), record_type: "synthetic.note", occurred_at: new Date(T).toISOString(),
    occurred_at_ms: T, actor_id: "synthetic-person", container_id: "synthetic-container", direction: null,
    title: "Invented note", body: "Invented original body", content_hash: "synthetic-hash-a",
    canonical_json: JSON.stringify({ sender_name: "Invented Name", chat_name: "Invented Chat" }),
    raw_json: JSON.stringify({ token: "1", text: "Invented original body" }), ...overrides };
}
function write(db, scope, candidates, cursor = T) {
  const current = store.readScope(db, scope.id);
  const runId = store.createRun(db, current);
  return store.succeedRecordRun(db, current, runId, candidates, candidates.length, { created_at_ms: cursor }, {});
}
const rows = (db) => store.sqliteQuery(db, "SELECT * FROM records ORDER BY source_id,external_id;");

test("explicit source version encoding separates numeric tokens from arbitrary precision revisions", () => {
  assert.equal(store.encodeSourceVersion({ token: "00042" }), token("00042"));
  assert.equal(store.encodeSourceVersion({ token: " 1 " }), token(" 1 "));
  assert.equal(store.encodeSourceVersion({ token: "" }), token(""));
  assert.equal(store.encodeSourceVersion({ revision: "00042" }), "42");
  assert.equal(store.encodeSourceVersion({ revision: 900719925474099312345n }), "900719925474099312345");
  for (const input of [{}, { token: "a", revision: "1" }, { token: 1 }, { revision: -1 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => store.encodeSourceVersion(input));
  }
});

test("a second source works without any Lark progress tables or Lark name inheritance", (t) => {
  const { db, scope } = fixture(t);
  store.sqliteExec(db, "DROP TABLE lark_im_detail_tasks; DROP TABLE lark_im_list_progress;");
  write(db, scope, [record(scope)]);
  write(db, scope, [record(scope, { canonical_json: '{"sender_name":null,"chat_name":null}' })]);
  assert.deepEqual(JSON.parse(rows(db)[0].canonical_json), { sender_name: null, chat_name: null });
  const metadata = JSON.parse(store.sqliteQuery(db, "SELECT metadata_json FROM sync_runs LIMIT 1;")[0].metadata_json);
  assert.equal(metadata.__run_fence.list_generation, undefined);
  assert.equal(metadata.__run_fence.scope_config, undefined);
});

test("messages projection includes only the Lark message source and type", (t) => {
  const { db, scope } = fixture(t);
  write(db, scope, [record(scope)]);
  const lark = store.readScope(db, "lark.im.sent_by_me");
  write(db, lark, [record(lark, { record_type: "lark.im.message", external_id: "synthetic-lark-message" }),
    record(lark, { record_type: "synthetic.other-type", external_id: "synthetic-lark-nonmessage" })]);
  assert.deepEqual(loadMessages(db, { direction: "all", limit: 30, search: "" }).map((row) => row.external_id), ["synthetic-lark-message"]);
  assert.deepEqual([...loadExistingRecords(db, ["synthetic-shared-id", "synthetic-lark-message", "synthetic-lark-nonmessage"]).keys()], ["synthetic-lark-message"]);
  assert.equal(buildStatus(db).records.total, 3, "generic record totals intentionally include every source/type");
});

test("different opaque tokens in a batch are rejected instead of selecting page order", (t) => {
  const { db, scope } = fixture(t);
  assert.throws(() => store.normalizeStoredRecords([record(scope), record(scope, { external_version: token("2") })]), /ambiguous.*version/i);
  assert.equal(rows(db).length, 0);
});

test("opaque changes require the exact observed predecessor and remain isolated from Lark IDs", (t) => {
  const { db, scope } = fixture(t);
  const lark = store.readScope(db, "lark.im.sent_by_me");
  write(db, lark, [record(lark, { record_type: "lark.im.message" })]);
  write(db, scope, [record(scope)]);
  const incoming = record(scope, { external_version: token("0"), body: "Invented authoritative replacement", content_hash: "synthetic-hash-b" });
  assert.equal(write(db, scope, [incoming]).updated, 0);
  assert.equal(write(db, scope, [{ ...incoming, expected_external_version: token("1") }]).updated, 1);
  assert.equal(rows(db).find((row) => row.source_id === "lark.im").body, "Invented original body");
  const stored = rows(db).find((row) => row.source_id === scope.source_id);
  assert.equal(stored.external_version, token("0"));
  assert.equal(stored.body, incoming.body);
  assert.equal("expected_external_version" in stored, false);
  assert.equal(JSON.stringify(stored).includes("expected_external_version"), false);
});

test("a stale authoritative fetch fails CAS and rolls back its entire batch and cursor", (t) => {
  const { db, scope } = fixture(t);
  write(db, scope, [record(scope)]);
  const original = token("1");
  write(db, scope, [record(scope, { external_version: token("2"), expected_external_version: original, body: "Invented winner" })], T + 1000);
  const current = store.readScope(db, scope.id);
  const run = store.createRun(db, current);
  const before = rows(db);
  assert.throws(() => store.succeedRecordRun(db, current, run, [
    record(scope, { external_id: "synthetic-sibling" }),
    record(scope, { external_version: token("3"), expected_external_version: original, body: "Invented stale loser" }),
  ], 2, { created_at_ms: T + 2000 }, {}), /CHECK constraint|version.*conflict/i);
  assert.deepEqual(rows(db), before);
  assert.deepEqual(store.readScope(db, scope.id).cursor, current.cursor);
  assert.equal(store.sqliteQuery(db, `SELECT status FROM sync_runs WHERE id=${run};`)[0].status, "running");
});

for (const mode of ["run", "direct"]) {
  test(`${mode}: CAS never authorizes numeric regression, clear or a different record type`, (t) => {
    const { db, scope } = fixture(t);
    write(db, scope, [record(scope, { external_version: "900719925474099312345" })]);
    for (const change of [
      { external_version: "900719925474099312344" },
      { external_version: null },
      { external_version: token("new-token") },
      { external_version: "900719925474099312346", record_type: "synthetic.different-type" },
    ]) {
      const candidate = record(scope, { ...change, expected_external_version: "900719925474099312345", body: "must not replace" });
      if (change.record_type) {
        assert.throws(() => mode === "run" ? write(db, scope, [candidate]) : store.sqliteExec(db, `BEGIN IMMEDIATE; ${store.upsertRecordsSql([candidate])} COMMIT;`), /CHECK constraint|record type/i);
      } else if (mode === "run") write(db, scope, [candidate]);
      else store.sqliteExec(db, `BEGIN IMMEDIATE; ${store.upsertRecordsSql([candidate])} COMMIT;`);
      assert.equal(rows(db)[0].body, "Invented original body");
    }
  });
}

test("explicit null predecessor means missing or unversioned, undefined means no CAS", (t) => {
  const { db, scope } = fixture(t);
  write(db, scope, [record(scope, { expected_external_version: null })]);
  assert.throws(() => write(db, scope, [record(scope, { external_version: token("2"), expected_external_version: null })]), /CHECK constraint/);
  store.releaseLock(db, scope.id);
  assert.equal(write(db, scope, [record(scope, { external_version: token("2"), expected_external_version: undefined })]).updated, 0);
  assert.throws(() => store.normalizeStoredRecords([record(scope, { expected_external_version: 42 })]), /expected_external_version/);
});

test("large revisions remain ordered and equal-version projection updates remain accepted", (t) => {
  const { db, scope } = fixture(t);
  write(db, scope, [record(scope, { external_version: "900719925474099312344" })]);
  assert.equal(write(db, scope, [record(scope, { external_version: "900719925474099312345" })]).updated, 1);
  assert.equal(write(db, scope, [record(scope, { external_version: "900719925474099312345", canonical_json: '{"projection":"invented refresh"}' })]).updated, 1);
});

test("a source cannot attach its record to another source's scope", (t) => {
  const { db, scope } = fixture(t);
  assert.throws(() => write(db, scope, [record(scope, { first_seen_scope_id: "lark.im.sent_by_me" })]), /CHECK constraint/);
  assert.equal(rows(db).length, 0);
  assert.equal(store.readScope(db, scope.id).cursor, null);
});
