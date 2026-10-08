import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitEnrichmentUpdates } from "../src/maintenance/enrichment-commit.mjs";
import { readOnlySqliteJson } from "../src/storage/sqlite/readonly-query.mjs";
import {
  REVIEW_EFFECTIVE_COLUMNS, REVIEW_RECORD_COLUMNS, REVIEW_LIFETIME_MS, boundedReplayProjectionSql,
  commitBoundedReplayRecords, ensureInitialized, quoteSql, reviewFenceSql, sqliteExec, upsertRecordsSql,
} from "../dist/storage/sqlite/ingestion-store.js";

const START = Date.parse("2042-02-03T04:00:00.000Z");
const CHAT = "oc_review_synthetic";
const SCOPE = `lark.im.received.chat.${CHAT}`;
const SOURCE_CONFIG = JSON.stringify({ initial_sync_start_ms: START, synthetic_review: true });
const SCOPE_CONFIG = JSON.stringify({ chat_id: CHAT, chat_type: "group" });
const ro = (db, sql) => readOnlySqliteJson(db, sql, "read synthetic review fixture");
const sql = (db, text) => sqliteExec(db, text, "write synthetic review fixture");

function record(externalId) {
  const actor = "ou_review_synthetic";
  return { source_id: "lark.im", first_seen_scope_id: SCOPE, external_id: externalId, external_version: "100",
    record_type: "lark.im.message", occurred_at: new Date(START + 1000).toISOString(), occurred_at_ms: START + 1000,
    actor_id: actor, container_id: CHAT, direction: "received", title: null, body: "Synthetic original body",
    content_hash: `synthetic-hash-${externalId}`, raw_json: JSON.stringify({ synthetic: externalId,
      sender: { id: actor, id_type: "open_id" } }),
    canonical_json: JSON.stringify({ sender_id: actor, sender_id_type: "open_id", chat_id: CHAT,
      sender_name: "Synthetic reviewed name", sender_name_source: "contact", sender_name_confidence: "high",
      chat_name: "Synthetic current chat", chat_name_source: "message", text: "Synthetic original body" }) };
}

function fixture(t, count = 2) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-review-storage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "synthetic.sqlite");
  ensureInitialized(db);
  sql(db, `UPDATE sources SET config_json=${quoteSql(SOURCE_CONFIG)} WHERE id='lark.im';
    INSERT INTO sync_scopes (id,source_id,name,config_json) VALUES
      (${quoteSql(SCOPE)},'lark.im','Synthetic review',${quoteSql(SCOPE_CONFIG)});`);
  sql(db, upsertRecordsSql(Array.from({ length: count }, (_, i) => record(`om_review_${i}`))));
  const before = ro(db, "SELECT * FROM records ORDER BY id;");
  return { db, before, scope: { id: SCOPE, source_id: "lark.im", enabled: 1, config_json: SCOPE_CONFIG } };
}

function fence(f, overrides = {}) {
  const createdAtMs = Date.now() - 1000;
  return { createdAtMs, expiresAtMs: createdAtMs + REVIEW_LIFETIME_MS, sourceConfigJson: SOURCE_CONFIG, sentActor: null,
    records: f.before, scopes: [f.scope], ...overrides };
}

function candidates(f) {
  return f.before.map((before) => ({ ...record(before.external_id), external_version: "101",
    expected_external_version: before.external_version, body: "Synthetic incoming body",
    raw_json: JSON.stringify({ ...JSON.parse(before.raw_json), synthetic_update: true }),
    content_hash: `synthetic-new-${before.external_id}`,
    canonical_json: JSON.stringify({ sender_id: before.actor_id, sender_id_type: "open_id", chat_id: CHAT,
      sender_name: "", chat_name: "", text: "Synthetic incoming body" }) }));
}

function replay(f, rows, reviewFence) {
  return commitBoundedReplayRecords(f.db, { scope: f.scope, initialSyncStartMs: START, startMs: START,
    endMs: START + 60_000, planId: "1".repeat(64), attemptId: "synthetic-review-attempt", selfIdHash: "2".repeat(64),
    pages: 1, fetchedCount: rows.length, records: rows,
    exactTargets: f.before.map(({ id, external_id, container_id, occurred_at_ms, external_version }) =>
      ({ id, external_id, container_id, occurred_at_ms, external_version })), reviewFence });
}

function enrich(f, reviewFence, updates = f.before.map((row) => `UPDATE records SET body='Synthetic reviewed update' WHERE id=${row.id};
  INSERT INTO __enrichment_effects (updated) VALUES (changes());`)) {
  return commitEnrichmentUpdates(f.db, updates, { dryRun: false, reason: "synthetic-review", label: "synthetic review commit", reviewFence });
}

function assertUnchanged(f, expected = f.before) {
  assert.deepEqual(ro(f.db, "SELECT * FROM records ORDER BY id;"), expected);
  assert.equal(ro(f.db, "SELECT COUNT(*) AS n FROM bounded_replay_runs;")[0].n, 0);
  assert.equal(ro(f.db, "SELECT COUNT(*) AS n FROM maintenance_locks;")[0].n, 0);
}

test("read-only replay projection exactly matches strict SQL upsert and final name merge", (t) => {
  const f = fixture(t, 4);
  const rows = candidates(f);
  rows[1].external_version = "100";
  rows[2].external_version = "99";
  rows[3] = { ...record(f.before[3].external_id), expected_external_version: "100", body: "Ignored incoming body",
    canonical_json: '{"synthetic_ignored":true}' };
  const bytes = readFileSync(f.db);
  const projection = ro(f.db, boundedReplayProjectionSql(rows));
  assert.deepEqual(readFileSync(f.db), bytes, "projection uses a read-only transaction");
  assert.deepEqual(projection.map((row) => row.outcome), ["update", "conflict", "conflict", "duplicate"]);
  const effective = projection.map((row) => JSON.parse(row.after_json));
  assert.deepEqual(Object.keys(effective[0]), REVIEW_EFFECTIVE_COLUMNS);
  assert.equal(typeof effective[0].occurred_at_ms, "number");
  assert.equal(JSON.parse(effective[0].canonical_json).sender_name, "Synthetic reviewed name");
  assert.equal(JSON.parse(effective[0].canonical_json).chat_name, "Synthetic current chat");
  assert.equal(JSON.parse(effective[0].canonical_json).text, "Synthetic incoming body");
  for (const index of [1, 2, 3]) {
    assert.deepEqual(effective[index], Object.fromEntries(REVIEW_EFFECTIVE_COLUMNS.map((column) => [column, f.before[index][column]])));
  }
  const result = replay(f, rows, fence(f));
  assert.deepEqual([result.updated, result.duplicate, result.conflicts], [1, 1, 2]);
  const actual = ro(f.db, "SELECT * FROM records ORDER BY id;");
  assert.deepEqual(actual.map((row) => Object.fromEntries(REVIEW_EFFECTIVE_COLUMNS.map((column) => [column, row[column]]))), effective);
});

for (const kind of ["enrich", "replay"]) {
  for (const column of ["raw_json", "body", "canonical_json", "received_at", "created_at", "updated_at"]) {
    test(`${kind} rejects same-version ${column} drift in the second target before changing the first`, (t) => {
      const f = fixture(t);
      const reviewed = fence(f);
      const value = column.endsWith("_json") ? '{"synthetic_drift":true}' : "Synthetic concurrent drift";
      sql(f.db, `UPDATE records SET ${column}=${quoteSql(value)} WHERE id=${f.before[1].id};`);
      const drifted = ro(f.db, "SELECT * FROM records ORDER BY id;");
      assert.equal(drifted[1].external_version, f.before[1].external_version);
      assert.throws(() => kind === "enrich" ? enrich(f, reviewed) : replay(f, candidates(f), reviewed), /CHECK constraint failed/);
      assertUnchanged(f, drifted);
    });
  }
}

test("reviewed enrichment rolls back the first update when a later original CAS unexpectedly skips", (t) => {
  const f = fixture(t);
  const updates = f.before.map((row, index) => `UPDATE records SET body='Synthetic proposed body'
    WHERE id=${row.id} ${index === 1 ? "AND body='Synthetic CAS mismatch'" : ""};
    INSERT INTO __enrichment_effects (updated) VALUES (changes());`);
  assert.throws(() => enrich(f, fence(f), updates), /CHECK constraint failed/);
  assertUnchanged(f);
  assert.deepEqual(enrich(f, undefined, updates), { updated: 1, skippedConflicts: 1 }, "legacy partial-CAS behavior is unchanged");
});

test("reviewed enrichment fences selected no-op records even with no updates", (t) => {
  const f = fixture(t);
  assert.deepEqual(enrich(f, fence(f), []), { updated: 0, skippedConflicts: 0 });
  const reviewed = fence(f);
  sql(f.db, `UPDATE records SET body='Synthetic no-op drift' WHERE id=${f.before[1].id};`);
  assert.throws(() => enrich(f, reviewed, []), /CHECK constraint failed/);
});

function seedSent(f, id = "om_unselected_sent") {
  const sender = "ou_review_synthetic_self";
  const row = { ...record(id), direction: "sent", actor_id: sender,
    canonical_json: JSON.stringify({ sender_id: sender, sender_id_type: "open_id" }) };
  sql(f.db, upsertRecordsSql([row]));
  return sender;
}

test("unselected sent-actor conflicts invalidate the whole approved transaction", async (t) => {
  for (const [name, change] of Object.entries({
    different_actor: "actor_id='ou_synthetic_other'",
    missing_actor: "actor_id=NULL",
    invalid_actor: "actor_id='invalid'",
    canonical_sender: `canonical_json='{"sender_id":"ou_synthetic_other","sender_id_type":"open_id"}'`,
    canonical_type: `canonical_json='{"sender_id_type":"app_id"}'`,
  })) await t.test(name, (t) => {
    const f = fixture(t);
    const sentActor = seedSent(f);
    const reviewed = fence(f, { sentActor });
    sql(f.db, `UPDATE records SET ${change} WHERE external_id='om_unselected_sent';`);
    const actual = ro(f.db, "SELECT * FROM records ORDER BY id;");
    assert.throws(() => enrich(f, reviewed), /CHECK constraint failed/);
    assertUnchanged(f, actual);
  });
});

test("same-account new sent records are allowed; absent sent evidence and newly appearing sent evidence fail closed", (t) => {
  const f = fixture(t);
  const initiallyAbsent = fence(f);
  const sentActor = seedSent(f);
  assert.throws(() => enrich(f, initiallyAbsent), /CHECK constraint failed/);
  const reviewed = fence(f, { sentActor });
  seedSent(f, "om_additional_same_account");
  assert.deepEqual(enrich(f, reviewed), { updated: 2, skippedConflicts: 0 });
  const fresh = { ...f, before: ro(f.db, "SELECT * FROM records WHERE direction='received' ORDER BY id;") };
  const beforeDelete = fence(fresh, { sentActor });
  sql(f.db, "DELETE FROM records WHERE direction='sent';");
  assert.throws(() => enrich(fresh, beforeDelete), /CHECK constraint failed/);
});

test("source, scope, schema, expiry and future creation fences fail in the actual transaction", async (t) => {
  const cases = {
    source_config: (f) => { sql(f.db, "UPDATE sources SET config_json='{}' WHERE id='lark.im';"); return fence(f); },
    source_disabled: (f) => { sql(f.db, "UPDATE sources SET enabled=0 WHERE id='lark.im';"); return fence(f); },
    scope_config: (f) => { sql(f.db, `UPDATE sync_scopes SET config_json='{}' WHERE id=${quoteSql(SCOPE)};`); return fence(f); },
    scope_disabled: (f) => { sql(f.db, `UPDATE sync_scopes SET enabled=0 WHERE id=${quoteSql(SCOPE)};`); return fence(f); },
    unknown_record_column: (f) => { sql(f.db, "ALTER TABLE records ADD COLUMN synthetic_unreviewed TEXT;"); return fence(f); },
    expired: (f) => { const expiresAtMs = Date.now() - 1000; return fence(f, { expiresAtMs, createdAtMs: expiresAtMs - REVIEW_LIFETIME_MS }); },
    future_creation: (f) => { const createdAtMs = Date.now() + 60_000; return fence(f, { createdAtMs, expiresAtMs: createdAtMs + REVIEW_LIFETIME_MS }); },
  };
  for (const [name, prepare] of Object.entries(cases)) await t.test(name, (t) => {
    const f = fixture(t);
    const reviewed = prepare(f);
    const before = ro(f.db, "SELECT * FROM records ORDER BY id;");
    assert.throws(() => enrich(f, reviewed), /CHECK constraint failed/);
    assertUnchanged(f, before);
  });
});

test("review schema rejects missing, extra, duplicate, malformed and unbounded snapshots before SQL", (t) => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(f.before[0]), REVIEW_RECORD_COLUMNS);
  const missing = { ...f.before[0] }; delete missing.updated_at;
  const bad = [
    { unexpected: true }, { expiresAtMs: Date.now() + 1 }, { createdAtMs: NaN }, { sourceConfigJson: "[]" }, { sentActor: "invalid" },
    { records: [] }, { records: Array.from({ length: 101 }, () => f.before[0]) },
    { records: [missing] }, { records: [{ ...f.before[0], unexpected: true }] },
    { records: [f.before[0], f.before[0]] }, { records: [{ ...f.before[0], id: "1" }] },
    { records: [{ ...f.before[0], raw_json: "invalid" }] }, { records: [{ ...f.before[0], source_id: "invented" }] },
    { records: [{ ...f.before[0], body: "embedded\0NUL" }] },
    { scopes: [] }, { scopes: [{ ...f.scope, unexpected: true }] }, { scopes: [{ ...f.scope, enabled: 0 }] },
  ];
  for (const override of bad) assert.throws(() => reviewFenceSql({ ...fence(f), ...override }), /invalid maintenance review/);
  assert.throws(() => replay(f, candidates(f), fence(f, { records: [f.before[0]] })), /cover every candidate/);
  assert.throws(() => boundedReplayProjectionSql([]), /between 1 and 100/);
  assert.throws(() => boundedReplayProjectionSql(Array.from({ length: 101 }, () => record("synthetic"))), /between 1 and 100/);
  assertUnchanged(f);
});

test("a fence valid when generated expires while BEGIN IMMEDIATE waits for a real SQLite writer", async (t) => {
  const f = fixture(t);
  const expiresAtMs = Date.now() + 1800;
  const reviewed = fence(f, { expiresAtMs, createdAtMs: expiresAtMs - REVIEW_LIFETIME_MS });
  const guardedSql = `BEGIN IMMEDIATE; ${reviewFenceSql(reviewed)}
    UPDATE records SET body='Synthetic forbidden late update'; COMMIT;`;
  assert.ok(Date.now() < expiresAtMs, "fence is still valid when generated");
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `
    import { spawn } from 'node:child_process';
    const child=spawn('sqlite3',[process.argv[1]],{stdio:['pipe','pipe','pipe']});
    child.stderr.pipe(process.stderr);
    child.stdout.once('data',()=>{
      process.stdout.write('synthetic-writer-ready');
      setTimeout(()=>child.stdin.end('COMMIT;\\n'),Math.max(0,Number(process.argv[2])-Date.now()));
    });
    child.on('exit',code=>process.exit(code || 0));
    child.stdin.write(".bail on\\nBEGIN IMMEDIATE; SELECT 'held';\\n");
  `, f.db, String(expiresAtMs + 300)], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("synthetic SQLite writer did not become ready")), 5000);
    holder.once("error", (error) => { clearTimeout(timer); reject(error); });
    holder.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    holder.once("exit", (code) => { clearTimeout(timer); if (code) reject(new Error("synthetic writer failed")); });
  });
  assert.ok(Date.now() < expiresAtMs, "transaction starts waiting before approval expires");
  assert.throws(() => sql(f.db, guardedSql), /CHECK constraint failed/);
  assert.ok(Date.now() >= expiresAtMs, "writer released after expiry");
  assertUnchanged(f);
});
