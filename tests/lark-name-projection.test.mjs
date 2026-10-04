import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureInitialized, readScope, createRun, succeedRecordRun, sqliteQuery, sqliteExec, upsertRecordsSql }
  from "../dist/storage/sqlite/ingestion-store.js";
import { recordFromMessage } from "../src/adapters/lark-im/message-record.mjs";
import { createNameResolver } from "../src/adapters/lark-im/name-resolver.mjs";

// New synthetic identities and content, composed without captured source data.
const EPOCH = Date.UTC(2044, 3, 5, 6, 7, 8);
const scopeId = "lark.im.sent_by_me";
const person = "ou_fixture_clock_builder";
const partner = "ou_fixture_clock_reader";
const room = "oc_fixture_clock_studio";
function message(overrides = {}) {
  return { message_id: "om_fixture_clock_draft", create_time: String(EPOCH), update_time: String(EPOCH + 500),
    sender: { id: person, sender_type: "user" }, chat_id: room, chat_type: "p2p",
    chat_partner: { open_id: partner }, content: { text: "Arrange nine wooden clock hands." }, ...overrides };
}
function candidate(context = {}, source = message()) {
  return recordFromMessage(source, scopeId, "sent", context);
}
function knownContext() {
  return { contacts: new Map([[person, "Clock Builder"], [partner, "Clock Reader"]]) };
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-name-projection-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "synthetic.sqlite");
  ensureInitialized(db);
  return db;
}
function write(db, record) {
  const scope = readScope(db, scopeId);
  const runId = createRun(db, scope, { fixture: true });
  return succeedRecordRun(db, scope, runId, [record], 1,
    { kind: "test.cursor/v1", occurred_at_ms: EPOCH }, {});
}
function stored(db) { return sqliteQuery(db, "SELECT * FROM records;", "read synthetic record")[0]; }
function project(record, fields) {
  return { ...record, canonical_json: JSON.stringify({ ...JSON.parse(record.canonical_json), ...fields }) };
}

test("lookup success then permission failure preserves names and provenance at identical raw/hash/version with updated=0", (t) => {
  const db = fixture(t);
  let denied = false;
  let now = 0;
  let failures = 0;
  const resolver = createNameResolver({ now: () => now, run: () => {
    if (denied) { failures += 1; throw new Error("synthetic permission denied"); }
    return { users: [{ open_id: person, name: "Clock Builder" }, { open_id: partner, name: "Clock Reader" }] };
  } });
  const first = candidate(resolver.buildPeopleContext([message()], {}, null));
  assert.deepEqual(write(db, first), { inserted: 1, updated: 0, duplicate: 0 });
  const before = stored(db);
  denied = true;
  now += 6 * 60 * 1000;
  const second = candidate(resolver.buildPeopleContext([message()], {}, null));
  assert.ok(failures > 0);
  for (const key of ["raw_json", "content_hash", "external_version", "body"]) assert.equal(second[key], first[key]);
  assert.equal(JSON.parse(second.canonical_json).sender_name, null);
  assert.deepEqual(write(db, second), { inserted: 0, updated: 0, duplicate: 1 });
  assert.deepEqual(stored(db), before);
});

test("same-version lookup improvement and rename update once without changing source facts", (t) => {
  const db = fixture(t);
  const raw = candidate();
  write(db, raw);
  const enriched = candidate(knownContext());
  assert.deepEqual(write(db, enriched), { inserted: 0, updated: 1, duplicate: 0 });
  assert.deepEqual(write(db, enriched), { inserted: 0, updated: 0, duplicate: 1 });
  const renamed = candidate({ contacts: new Map([[person, "Clock Designer"], [partner, "Clock Reader"]]) });
  assert.equal(write(db, renamed).updated, 1);
  const row = stored(db);
  for (const field of ["raw_json", "content_hash", "external_version", "body"]) assert.equal(row[field], raw[field]);
  assert.equal(JSON.parse(row.canonical_json).sender_name, "Clock Designer");
});

test("authoritative clear survives later unknown lookup but later resolved name can replace it", (t) => {
  const db = fixture(t);
  write(db, candidate(knownContext()));
  const clear = candidate({ contacts: new Map([[person, { state: "cleared", source: "synthetic_authority" }],
    [partner, { state: "cleared", source: "synthetic_authority" }]]) });
  assert.equal(JSON.parse(clear.canonical_json).sender_name_state, "cleared");
  assert.equal(JSON.parse(clear.canonical_json).chat_partner.name_state, "cleared");
  assert.equal(write(db, clear).updated, 1);
  const before = stored(db);
  assert.deepEqual(write(db, candidate()), { inserted: 0, updated: 0, duplicate: 1 });
  assert.deepEqual(stored(db), before);
  assert.equal(write(db, candidate(knownContext())).updated, 1);
  const canonical = JSON.parse(stored(db).canonical_json);
  assert.equal(canonical.sender_name, "Clock Builder");
  assert.equal(canonical.sender_name_state, undefined);
  assert.equal(canonical.chat_partner.name_state, undefined);
});

test("unknown chat and partner names are retained only for matching identities", (t) => {
  const db = fixture(t);
  write(db, project(candidate(knownContext()), { chat_name: "Clock Studio" }));
  assert.equal(write(db, candidate()).updated, 0);
  const changed = candidate({}, message({ update_time: String(EPOCH + 1000),
    sender: { id: "ou_fixture_other_builder", sender_type: "user" },
    chat_id: "oc_fixture_clock_gallery", chat_partner: { open_id: "ou_fixture_other_reader" } }));
  assert.equal(write(db, changed).updated, 1);
  const row = stored(db);
  const canonical = JSON.parse(row.canonical_json);
  assert.equal(canonical.sender_name, null);
  assert.equal(canonical.chat_name, null);
  assert.equal(canonical.chat_partner.name, null);
  assert.equal(row.raw_json, changed.raw_json);
});

test("canonical identities inconsistent with record columns never inherit names", (t) => {
  const db = fixture(t);
  write(db, project(candidate(knownContext()), { chat_name: "Clock Studio" }));
  const mismatched = project(candidate(), { sender_id: "ou_fixture_unmatched", chat_id: "oc_fixture_unmatched" });
  assert.equal(write(db, mismatched).updated, 1);
  const canonical = JSON.parse(stored(db).canonical_json);
  assert.equal(canonical.sender_name, null);
  assert.equal(canonical.chat_name, null);
  assert.equal(canonical.chat_partner.name, null);
});

test("older source versions cannot improve projection or clear current names", (t) => {
  const db = fixture(t);
  write(db, candidate(knownContext()));
  const before = stored(db);
  const older = candidate({ contacts: new Map([[person, { state: "cleared" }]]) },
    message({ update_time: String(EPOCH + 100) }));
  assert.deepEqual(write(db, older), { inserted: 0, updated: 0, duplicate: 1 });
  assert.deepEqual(stored(db), before);
});

test("plain record upsert uses the same Lark name merge while other record types keep replacement semantics", (t) => {
  const db = fixture(t);
  write(db, candidate(knownContext()));
  const before = stored(db);
  sqliteExec(db, upsertRecordsSql([candidate()]), "unknown name upsert");
  assert.deepEqual(stored(db), before);
  const differentType = { ...candidate(), record_type: "synthetic.other" };
  sqliteExec(db, upsertRecordsSql([differentType]), "other type upsert");
  assert.equal(JSON.parse(stored(db).canonical_json).sender_name, null);
});

test("matching actor in a different container cannot inherit a scoped sender name", (t) => {
  const db = fixture(t);
  write(db, candidate({ chat_members: new Map([[`${room}:${person}`, "Studio Timekeeper"]]) }));
  const changed = candidate({}, message({ chat_id: "oc_fixture_clock_annex" }));
  assert.equal(write(db, changed).updated, 1);
  assert.equal(JSON.parse(stored(db).canonical_json).sender_name, null);
});

test("a hundred synthetic names survive an exact unknown replay in one bounded transaction", { timeout: 30_000 }, (t) => {
  const db = fixture(t);
  const messages = Array.from({ length: 100 }, (_, index) => message({
    message_id: `om_fixture_clock_batch_${index}`, content: { text: `Place synthetic dial number ${index}.` },
  }));
  function writeBatch(records) {
    const scope = readScope(db, scopeId);
    const runId = createRun(db, scope, { synthetic_batch: true });
    return succeedRecordRun(db, scope, runId, records, records.length,
      { kind: "test.cursor/v1", occurred_at_ms: EPOCH }, {});
  }
  assert.deepEqual(writeBatch(messages.map((item) => candidate(knownContext(), item))),
    { inserted: 100, updated: 0, duplicate: 0 });
  const before = sqliteQuery(db, "SELECT canonical_json, updated_at FROM records ORDER BY id;", "batch before");
  assert.deepEqual(writeBatch(messages.map((item) => candidate({}, item))),
    { inserted: 0, updated: 0, duplicate: 100 });
  assert.deepEqual(sqliteQuery(db, "SELECT canonical_json, updated_at FROM records ORDER BY id;", "batch after"), before);
});
