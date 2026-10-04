import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { ensureInitialized, sqliteExec, sqliteQuery, upsertRecordsSql } from '../dist/storage/sqlite/ingestion-store.js';

// Invented messages exercise projection compatibility, not claims about the
// exact response shapes of a current remote endpoint. All databases are new.
const OPEN = 'ou_synthetic_inheritance_actor';
const USER = 'synthetic_inheritance_user';
const OLD_NAME = 'ou_synthetic_inheritance_old_label';
const NEW_NAME = 'Synthetic Orchard Cartographer';
const CHAT = 'oc_synthetic_inheritance_orchard';
const BASE = 2456789012000;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-sender-inheritance-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite');
  ensureInitialized(db);
  return db;
}
function message({ actor = OPEN, type = 'open_id', name, version = 1, aliasType, alias,
  nested = false, wrapped = false, nativeProjection = false, chat = CHAT, outerAlias } = {}) {
  const sender = { id: actor, id_type: type, sender_type: 'user', ...(name === undefined ? {} : { name }),
    ...(aliasType ? nested ? { sender_id: { [aliasType]: alias } } : { [aliasType]: alias } : {}) };
  const native = { message_id: 'om_synthetic_inheritance_map', create_time: String(BASE),
    update_time: String(BASE + version * 1000), sender, chat_id: chat, chat_type: 'group',
    content: { text: 'Sketch three imaginary orchard paths.' } };
  return wrapped ? { ...native, raw_api: native, ...(nativeProjection ? { source_api: 'im.v1.messages' } : {}),
    sender: { ...sender, ...(outerAlias ? { user_id: outerAlias } : {}) } } : native;
}
const record = (options, context = {}) => recordFromMessage(message(options), 'lark.im.sent_by_me', 'sent', context);
const write = (db, value) => sqliteExec(db, upsertRecordsSql([value]), 'upsert invented source record');
const read = db => sqliteQuery(db, 'SELECT * FROM records;', 'read invented source record')[0];
const canonical = value => JSON.parse(value.canonical_json);
function assertSource(row, incoming) {
  for (const key of ['actor_id', 'container_id', 'raw_json', 'content_hash', 'external_version', 'body']) {
    assert.equal(row[key], incoming[key], key);
  }
}

for (const [aliasType, actor, type] of [
  ['user_id', OPEN, 'open_id'], ['union_id', OPEN, 'open_id'],
  ['app_id', OPEN, 'open_id'], ['open_id', USER, 'user_id'],
]) {
  for (const nested of [false, true]) {
    for (const wrapped of [false, true]) {
      test(`new ${nested ? 'nested' : 'direct'} ${aliasType} rejects old display echo${wrapped ? ' through raw_api' : ''}`, t => {
        const db = fixture(t);
        const old = record({ actor, type, name: OLD_NAME, version: 1, wrapped });
        const incoming = record({ actor, type, name: OLD_NAME, version: 2, aliasType, alias: OLD_NAME, nested, wrapped });
        assert.equal(canonical(old).sender_name, OLD_NAME);
        assert.equal(canonical(incoming).sender_name, null, 'the new source already classifies the display as an ID echo');
        assert.equal(canonical(incoming).sender_id_type, type, 'different namespaces are a valid alias set');
        assert.equal(Object.hasOwn(JSON.parse(incoming.raw_json), 'raw_api'), wrapped, 'persisted wrapper branch is exercised');
        assert.notEqual(incoming.content_hash, old.content_hash);
        write(db, old);
        write(db, incoming);
        const after = read(db);
        assertSource(after, incoming);
        assert.equal(canonical(after).sender_name, null, 'merge must not reintroduce a newly proven ID echo');
        assert.equal(canonical(after).sender_name_source, null);
        assert.equal(canonical(after).sender_name_confidence, null);
        write(db, incoming);
        assert.deepEqual(read(db), after, 'repeated unknown projection is byte-stable');
        write(db, old);
        assert.deepEqual(read(db), after, 'an older version cannot restore the old name or raw source');
      });
    }
  }
}

for (const nested of [false, true]) {
  for (const wrapped of [false, true]) {
    test(`unrelated new ${nested ? 'nested' : 'direct'} alias preserves a real known name${wrapped ? ' through raw_api' : ''}`, t => {
      const db = fixture(t);
      const old = record({ name: OLD_NAME, wrapped });
      const incoming = record({ version: 2, aliasType: 'union_id', alias: 'synthetic_unrelated_union', nested, wrapped });
      assert.equal(canonical(incoming).sender_name, null);
      write(db, old);
      write(db, incoming);
      const after = read(db);
      assertSource(after, incoming);
      assert.equal(canonical(after).sender_name, OLD_NAME);
      assert.equal(canonical(after).sender_name_source, 'message_sender');
      write(db, incoming);
      assert.deepEqual(read(db), after);
    });
  }
}

test('raw_api authority ignores an outer projection alias when retaining a known name', t => {
  const db = fixture(t);
  write(db, record({ name: OLD_NAME, wrapped: true }));
  const incoming = record({ version: 2, wrapped: true, aliasType: 'user_id', alias: 'synthetic_trusted_user', outerAlias: OLD_NAME });
  write(db, incoming);
  assert.equal(canonical(read(db)).sender_name, OLD_NAME);
  assertSource(read(db), incoming);
});

test('an authoritative clear survives later unknown aliases and a fresh valid name can replace it', t => {
  const db = fixture(t);
  const clear = record({ version: 2 }, { contacts: new Map([[OPEN, { state: 'cleared', source: 'synthetic_authority' }]]) });
  write(db, record({ name: OLD_NAME }));
  write(db, clear);
  assert.equal(canonical(read(db)).sender_name_state, 'cleared');
  const unknown = record({ version: 3, aliasType: 'user_id', alias: OLD_NAME, name: OLD_NAME });
  assert.equal(canonical(unknown).sender_name, null);
  write(db, unknown);
  const after = read(db);
  assert.equal(canonical(after).sender_name, null);
  assert.equal(canonical(after).sender_name_state, 'cleared');
  assert.equal(canonical(after).sender_name_source, 'synthetic_authority');
  assertSource(after, unknown);
  write(db, unknown);
  assert.deepEqual(read(db), after);
  const recovered = record({ version: 4, aliasType: 'user_id', alias: OLD_NAME, name: NEW_NAME });
  write(db, recovered);
  assert.equal(canonical(read(db)).sender_name, NEW_NAME);
  assert.equal(canonical(read(db)).sender_name_state, undefined);
  assertSource(read(db), recovered);
});

test('a valid fresh name replaces an old name that is now also an alias', t => {
  const db = fixture(t);
  write(db, record({ name: OLD_NAME }));
  const incoming = record({ version: 2, aliasType: 'app_id', alias: OLD_NAME, nested: true, name: NEW_NAME });
  write(db, incoming);
  assert.equal(canonical(read(db)).sender_name, NEW_NAME);
  assertSource(read(db), incoming);
});

for (const [label, change] of [
  ['actor', { actor: 'ou_synthetic_other_inheritance_actor' }],
  ['namespace', { type: 'user_id' }],
  ['chat', { chat: 'oc_synthetic_other_orchard' }],
]) {
  test(`a changed ${label} still cannot inherit a previous name`, t => {
    const db = fixture(t);
    write(db, record({ name: OLD_NAME }));
    const incoming = record({ version: 2, ...change, aliasType: 'union_id', alias: 'synthetic_unrelated_union' });
    write(db, incoming);
    assert.equal(canonical(read(db)).sender_name, null);
    assertSource(read(db), incoming);
  });
}

test('same-version lookup improvement, unknown replay and older versions keep existing source protections', t => {
  const db = fixture(t);
  const options = { version: 3, aliasType: 'user_id', alias: 'synthetic_unrelated_user', wrapped: true };
  const unknown = record(options);
  const named = record(options, { contacts: new Map([[OPEN, NEW_NAME]]) });
  for (const key of ['raw_json', 'content_hash', 'external_version', 'body']) assert.equal(named[key], unknown[key]);
  write(db, unknown);
  write(db, named);
  const before = read(db);
  assert.equal(canonical(before).sender_name, NEW_NAME);
  write(db, named);
  write(db, unknown);
  assert.deepEqual(read(db), before);
  write(db, record({ version: 2, aliasType: 'user_id', alias: NEW_NAME }));
  assert.deepEqual(read(db), before, 'older alias evidence cannot alter a newer row');
  const unversioned = recordFromMessage({ ...message({ aliasType: 'union_id', alias: NEW_NAME }), update_time: null }, 'lark.im.sent_by_me', 'sent');
  assert.equal(unversioned.external_version, null);
  write(db, unversioned);
  assert.deepEqual(read(db), before, 'unversioned evidence cannot replace a known version');
  assertSource(read(db), named);
});

test('native raw_api is unwrapped during record creation and new aliases still block inherited names', t => {
  const db = fixture(t);
  const old = record({ name: OLD_NAME, wrapped: true, nativeProjection: true });
  const incoming = record({ version: 2, name: OLD_NAME, aliasType: 'union_id', alias: OLD_NAME,
    nested: true, wrapped: true, nativeProjection: true });
  assert.equal(Object.hasOwn(JSON.parse(incoming.raw_json), 'raw_api'), false);
  assert.equal(canonical(incoming).source_api, 'im.v1.messages');
  assert.equal(canonical(incoming).sender_name, null);
  write(db, old);
  write(db, incoming);
  assert.equal(canonical(read(db)).sender_name, null);
  assertSource(read(db), incoming);
});

test('ordinary same-version source replacement also rejects the newly identified old-name alias', t => {
  const db = fixture(t);
  const old = record({ version: 3, name: OLD_NAME });
  const incoming = record({ version: 3, aliasType: 'user_id', alias: OLD_NAME, name: OLD_NAME });
  assert.equal(incoming.external_version, old.external_version);
  assert.notEqual(incoming.content_hash, old.content_hash);
  write(db, old);
  write(db, incoming);
  const after = read(db);
  assert.equal(canonical(after).sender_name, null);
  assert.equal(canonical(after).sender_name_source, null);
  assertSource(after, incoming);
  write(db, incoming);
  assert.deepEqual(read(db), after);
});

test('strict-version replay retains its existing rejection of an equal-version raw/hash replacement', t => {
  const db = fixture(t);
  const old = record({ version: 3, name: OLD_NAME });
  const incoming = record({ version: 3, aliasType: 'user_id', alias: OLD_NAME, name: OLD_NAME });
  write(db, old);
  const before = read(db);
  sqliteExec(db, upsertRecordsSql([incoming], { strictVersionIncrease: true }), 'strict invented replay');
  assert.deepEqual(read(db), before);
});

test('body text and non-sender fields cannot act as identity aliases during inheritance', t => {
  const db = fixture(t);
  write(db, record({ name: OLD_NAME }));
  const source = { ...message({ version: 2 }), content: { text: OLD_NAME },
    user_id: OLD_NAME, callback: { union_id: OLD_NAME } };
  const incoming = recordFromMessage(source, 'lark.im.sent_by_me', 'sent');
  write(db, incoming);
  assert.equal(canonical(read(db)).sender_name, OLD_NAME);
  assertSource(read(db), incoming);
});

for (const nested of [false, true]) {
  test(`an alias present only in the old ${nested ? 'nested' : 'direct'} source still blocks inheritance`, t => {
    const db = fixture(t);
    const old = record({ name: OLD_NAME, aliasType: 'user_id', alias: OLD_NAME, nested });
    assert.equal(canonical(old).sender_name, null);
    // Explicitly model a historical invalid projection. This is not the output
    // of today's constructor; the preceding bug could leave such a stored row.
    const legacy = { ...old, canonical_json: JSON.stringify({ ...canonical(old), sender_name: OLD_NAME,
      sender_name_source: 'synthetic_legacy_projection', sender_name_confidence: 'high' }) };
    write(db, legacy);
    assert.equal(canonical(read(db)).sender_name, OLD_NAME);
    const incoming = record({ version: 2 });
    write(db, incoming);
    const after = read(db);
    assert.equal(canonical(after).sender_name, null);
    assert.equal(canonical(after).sender_name_source, null);
    assertSource(after, incoming);
    write(db, incoming);
    assert.deepEqual(read(db), after);
  });
}
