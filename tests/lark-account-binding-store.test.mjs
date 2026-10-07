import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { captureRemoteAccountBinding, readRemoteAccountBinding, reserveSyncAccountBinding,
  recordSuccessfulSyncBinding, accountBindingAdmissionError } from "../src/diagnostics/remote-account-binding.mjs";
import { ensureInitialized, reserveInitialLarkAccount, confirmInitialLarkAccountSql, sqliteExec, sqliteQuery,
  quoteSql } from "../dist/storage/sqlite/ingestion-store.js";

// All accounts and source evidence are invented; these tests only use SQLite.
const A = "ou_synthetic_reserved_a", B = "ou_synthetic_reserved_b";
const accountKey = id => createHash("sha256").update(`lark.im\0${id}`).digest("hex");
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-account-reservation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "synthetic.sqlite"); ensureInitialized(db);
  return { db, dir };
}
const before = db => captureRemoteAccountBinding({ db, emptyOnly: true, includeSidecar: true });
const read = (db, selfOpenId = A) => readRemoteAccountBinding({ db, selfOpenId });
const marker = db => JSON.parse(sqliteQuery(db, "SELECT config_json FROM sources WHERE id='lark.im';")[0].config_json).initial_account_binding;

test("two stale empty snapshots cannot reserve different accounts or overwrite the winner", t => {
  const { db } = fixture(t), first = before(db), second = before(db);
  assert.equal(reserveSyncAccountBinding({ db, selfOpenId: A, before: first }), true);
  const reserved = marker(db);
  assert.throws(() => reserveSyncAccountBinding({ db, selfOpenId: B, before: second }), /reservation rejected/);
  assert.deepEqual(marker(db), reserved);
  assert.equal(read(db, B).state, "conflict");
  assert.equal(read(db).reason, "account_database_pending");
  assert.equal(accountBindingAdmissionError(read(db)), null);
  assert.equal(reserveSyncAccountBinding({ db, selfOpenId: A, before: before(db) }), false);
});

for (const invalidation of ["record", "run", "cursor", "disabled", "lock", "maintenance"]) {
  test(`reservation rechecks ${invalidation} after a fresh-source observation`, t => {
    const { db } = fixture(t), snapshot = before(db);
    const sql = {
      record: "INSERT INTO records(source_id,first_seen_scope_id,external_id,record_type,raw_json) VALUES('lark.im','lark.im.sent_by_me','invented','lark.im.message','{}');",
      run: "INSERT INTO sync_runs(source_id,scope_id,status) VALUES('lark.im','lark.im.sent_by_me','failed');",
      cursor: "UPDATE sync_scopes SET cursor_json='{}' WHERE id='lark.im.sent_by_me';",
      disabled: "UPDATE sources SET enabled=0 WHERE id='lark.im';",
      lock: "INSERT INTO sync_locks VALUES('lark.im.sent_by_me','invented-owner',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'2099-01-01T00:00:00.000Z');",
      maintenance: "INSERT INTO maintenance_locks VALUES('global','invented-owner',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'2099-01-01T00:00:00.000Z','invented');",
    }[invalidation];
    sqliteExec(db, sql);
    assert.throws(() => reserveSyncAccountBinding({ db, selfOpenId: A, before: snapshot }), /reservation rejected/);
    assert.equal(marker(db), undefined);
  });
}

test("pending source cannot be promoted by a success flag or matching sent fallback", t => {
  const { db } = fixture(t), snapshot = before(db);
  reserveSyncAccountBinding({ db, selfOpenId: A, before: snapshot });
  sqliteExec(db, `INSERT INTO records(source_id,first_seen_scope_id,external_id,record_type,direction,actor_id,raw_json)
    VALUES('lark.im','lark.im.sent_by_me','invented-sent','lark.im.message','sent',${quoteSql(A)},'{}');`);
  assert.equal(recordSuccessfulSyncBinding({ db, selfOpenId: A, before: snapshot, successful: true }), false);
  assert.equal(existsSync(`${db}.remote-account-binding.json`), false);
  assert.equal(read(db).state, "unverified");
  assert.equal(read(db).reason, "account_database_pending");
});

test("embedded association survives a database-only copy, while a stale sidecar is still rejected", t => {
  const { db, dir } = fixture(t), snapshot = before(db);
  reserveSyncAccountBinding({ db, selfOpenId: A, before: snapshot });
  sqliteExec(db, `BEGIN IMMEDIATE; ${confirmInitialLarkAccountSql(new Date().toISOString())} COMMIT;`);
  assert.equal(recordSuccessfulSyncBinding({ db, selfOpenId: A, before: snapshot, successful: true }), true);
  const copy = join(dir, "synthetic-copy.sqlite");
  sqliteExec(db, `VACUUM INTO ${quoteSql(copy)};`);
  assert.equal(read(copy).state, "verified");
  assert.equal(read(copy, B).state, "conflict");
  copyFileSync(`${db}.remote-account-binding.json`, `${copy}.remote-account-binding.json`);
  assert.equal(read(copy).reason, "binding_database_changed");
  assert.match(accountBindingAdmissionError(read(copy)), /cannot be verified/);
});

test("invalid embedded evidence fails closed despite a valid matching sidecar", t => {
  for (const value of [null, {}, { kind: "wrong" }]) {
    const { db } = fixture(t), snapshot = before(db);
    assert.equal(recordSuccessfulSyncBinding({ db, selfOpenId: A, before: snapshot, successful: true }), true);
    sqliteExec(db, `UPDATE sources SET config_json=json_set(config_json, '$.initial_account_binding', json(${quoteSql(JSON.stringify(value))})) WHERE id='lark.im';`);
    assert.equal(read(db).state, "unavailable");
    assert.match(accountBindingAdmissionError(read(db)), /cannot be verified/);
  }
});

test("source association and sidecar must name the same account", t => {
  const { db } = fixture(t), snapshot = before(db);
  assert.equal(recordSuccessfulSyncBinding({ db, selfOpenId: A, before: snapshot, successful: true }), true);
  // Simulate contradictory evidence; admission must not pick whichever matches.
  reserveInitialLarkAccount(db, accountKey(B), new Date().toISOString());
  sqliteExec(db, `BEGIN IMMEDIATE; ${confirmInitialLarkAccountSql(new Date().toISOString())} COMMIT;`);
  assert.equal(read(db, A).state, "conflict");
  assert.equal(read(db, B).state, "conflict");
});
