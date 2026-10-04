import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { recordFromMessage, senderId } from '../src/adapters/lark-im/message-record.mjs';
import { createNameResolver } from '../src/adapters/lark-im/name-resolver.mjs';
import { ensureInitialized, sqliteExec, sqliteQuery, upsertRecordsSql } from '../dist/storage/sqlite/ingestion-store.js';
import { larkSenderNamespaceSql } from '../dist/storage/sqlite/lark-name-projection.js';

// These compatibility shapes and values are invented. They do not assert that
// each shape is currently returned by a particular upstream API endpoint.
const OPEN = 'ou_fixture_mosaic_maker';
const USER = 'fixture_mosaic_user';
const UNION = 'fixture_mosaic_union';
const APP = 'cli_fixture_mosaic_printer';
const ROOM = 'oc_fixture_mosaic_studio';
const NAME = 'Mosaic Maker';
const opts = { retries: 0, retryDelayMs: 0 };
const message = sender => ({ message_id: 'om_fixture_mosaic_diagram', create_time: '2345678901000',
  update_time: '2345678902000', chat_id: ROOM, chat_type: 'group', sender,
  content: { text: 'Arrange eleven invented mosaic tiles.' } });
const record = (sender, context = {}) => recordFromMessage(message(sender), 'lark.im.sent_by_me', 'sent', context);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-sender-shapes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite');
  ensureInitialized(db);
  return db;
}
const read = db => sqliteQuery(db, 'SELECT * FROM records;', 'read invented record')[0];
const write = (db, value) => sqliteExec(db, upsertRecordsSql([value]), 'write invented record');
const project = (value, name) => ({ ...value, canonical_json: JSON.stringify({
  ...JSON.parse(value.canonical_json), sender_name: name,
  sender_name_source: name ? 'message_sender' : null, sender_name_confidence: name ? 'high' : null,
}) });

for (const [shape, sender, actor, type] of [
  ['explicit generic open ID', { id: OPEN, id_type: 'open_id' }, OPEN, 'open_id'],
  ['direct open ID', { open_id: OPEN }, OPEN, 'open_id'],
  ['nested open ID', { sender_id: { open_id: OPEN } }, OPEN, 'open_id'],
  ['nested user ID', { sender_id: { user_id: USER } }, USER, 'user_id'],
  ['nested union ID', { sender_id: { union_id: UNION } }, UNION, 'union_id'],
  ['direct user ID', { user_id: USER }, USER, 'user_id'],
  ['direct union ID', { union_id: UNION }, UNION, 'union_id'],
  ['direct app ID', { app_id: APP }, APP, 'app_id'],
  ['nested app ID', { sender_id: { app_id: APP } }, APP, 'app_id'],
  ['legacy string sender ID', { sender_id: USER }, USER, null],
]) {
  test(`${shape}: record actor, canonical namespace and store merge agree`, t => {
    const db = fixture(t);
    const value = record({ ...sender, name: NAME });
    const canonical = JSON.parse(value.canonical_json);
    assert.equal(senderId(message(sender)), actor);
    assert.equal(value.actor_id, actor);
    assert.equal(canonical.sender_id, actor);
    assert.equal(canonical.sender_id_type, type);
    assert.equal(canonical.sender_name, NAME);
    write(db, value);
    const before = read(db);
    assert.equal(before.actor_id, actor);
    write(db, project(value, null));
    assert.deepEqual(read(db), before, 'unknown replay must keep name and original bytes');
    write(db, project(value, 'Mosaic Designer'));
    const improved = read(db);
    assert.equal(JSON.parse(improved.canonical_json).sender_name, 'Mosaic Designer');
    for (const key of ['raw_json', 'content_hash', 'external_version', 'body']) assert.equal(improved[key], before[key], key);
  });
}

test('legacy selection order stays deterministic while objects never become actor identifiers', () => {
  assert.equal(senderId(message({ id: OPEN, open_id: OPEN, sender_id: { open_id: OPEN, user_id: USER } })), OPEN);
  assert.equal(senderId(message({ open_id: OPEN, sender_id: { user_id: USER } })), OPEN);
  assert.equal(senderId(message({ sender_id: { open_id: OPEN, user_id: USER } })), OPEN);
  assert.equal(senderId(message({ sender_id: { user_id: USER, union_id: UNION } })), USER);
  assert.equal(senderId(message({ sender_id: { unsupported: 'invented' } })), '');
  assert.equal(senderId(message({ id: {}, sender_id: {} })), '');
  assert.equal(record({ sender_id: { unsupported: 'invented' } }).actor_id, null);
});

test('names echoing any supplied typed alias stay unknown and do not suppress reliable open-ID lookup', () => {
  for (const echo of [OPEN, USER, UNION]) {
    let calls = 0;
    const sender = { id: OPEN, id_type: 'open_id', user_id: USER, sender_id: { union_id: UNION }, name: echo };
    const resolver = createNameResolver({ run(args) {
      assert.equal(args[0], 'contact'); calls += 1;
      return { users: [{ open_id: OPEN, user_id: USER, union_id: UNION, name: NAME }] };
    } });
    assert.equal(JSON.parse(record(sender).canonical_json).sender_name, null, echo);
    const context = resolver.buildPeopleContext([message(sender)], opts, null);
    assert.equal(calls, 1, echo);
    assert.equal(JSON.parse(record(sender, context).canonical_json).sender_name, NAME, echo);
    assert.equal(JSON.parse(record({ ...sender, display_name: NAME }).canonical_json).sender_name, NAME, echo);
  }
});

test('non-open namespaces and untyped generic IDs never become open-ID network targets', () => {
  const resolver = createNameResolver({ run() { assert.fail('unverified open-ID request'); } });
  for (const sender of [{ user_id: OPEN }, { union_id: OPEN }, { sender_id: { union_id: OPEN } },
    { id: OPEN }, { sender_id: OPEN }, { id: OPEN, id_type: 'user_id' }]) {
    const context = resolver.buildPeopleContext([message(sender)], opts, null);
    assert.equal(context.contacts.size, 0);
    assert.equal(JSON.parse(record(sender, { contacts: new Map([[OPEN, NAME]]) }).canonical_json).sender_name, null);
  }
});

test('SQL rejects a record actor selected from a lower-priority alias rather than the source actor', t => {
  const db = fixture(t);
  const original = record({ open_id: OPEN, sender_id: { user_id: USER }, name: NAME });
  const mismatched = { ...original, actor_id: USER,
    canonical_json: JSON.stringify({ ...JSON.parse(original.canonical_json), sender_id: USER, sender_id_type: 'user_id' }) };
  write(db, mismatched);
  const namespaces = sqliteQuery(db, `SELECT ${larkSenderNamespaceSql('canonical_json', 'raw_json', 'actor_id', false)} AS ns FROM records;`, 'check invented namespace');
  assert.equal(namespaces[0].ns, null);
  write(db, project(mismatched, null));
  assert.equal(JSON.parse(read(db).canonical_json).sender_name, null, 'mismatched old name must not be inherited');
});

test('store treats an old alternate-ID echo as unknown, while preserving real names and explicit clear', t => {
  const db = fixture(t);
  const value = record({ id: OPEN, id_type: 'open_id', user_id: USER, sender_id: { union_id: UNION } });
  write(db, project(value, USER));
  write(db, value);
  assert.equal(JSON.parse(read(db).canonical_json).sender_name, null);
  write(db, project(value, NAME));
  const known = read(db);
  write(db, value);
  assert.deepEqual(read(db), known);
  const cleared = { ...value, canonical_json: JSON.stringify({
    ...JSON.parse(value.canonical_json), sender_name_state: 'cleared', sender_name_source: 'synthetic_authority',
  }) };
  write(db, cleared);
  const before = read(db);
  write(db, value);
  assert.deepEqual(read(db), before);
});

test('malformed identity values cannot supply a direct name or become a typed actor', () => {
  for (const sender of [{ id: {}, name: NAME }, { open_id: {}, name: NAME },
    { sender_id: { union_id: {} }, name: NAME }, { sender_id: { unsupported: 'invented' }, name: NAME }]) {
    const value = record(sender);
    assert.equal(value.actor_id, null);
    assert.equal(JSON.parse(value.canonical_json).sender_name, null);
    assert.equal(JSON.parse(value.canonical_json).sender_id_type, 'conflicting');
  }
  assert.equal(JSON.parse(record({ name: NAME }).canonical_json).sender_name, NAME, 'genuine IDless source-name compatibility');
});

test('source aliases reject incomplete remote contact echoes before member fallback and store projection', t => {
  const db = fixture(t);
  const sender = { id: OPEN, id_type: 'open_id', user_id: USER, sender_id: { union_id: UNION } };
  const calls = [];
  const resolver = createNameResolver({ run(args) {
    calls.push(args[0]);
    return args[0] === 'contact' ? { users: [{ open_id: OPEN, name: USER }] }
      : { items: [{ member_id: OPEN, name: NAME }], has_more: false };
  } });
  const before = record(sender);
  write(db, before);
  const context = resolver.buildPeopleContext([message(sender)], opts, { open_id: OPEN, name: UNION });
  assert.deepEqual(calls, ['contact', 'im']);
  assert.equal(context.contacts.has(OPEN), false);
  assert.equal(context.chat_members.get(`${ROOM}:${OPEN}`), NAME);
  const after = record(sender, context);
  write(db, after);
  assert.equal(JSON.parse(read(db).canonical_json).sender_name, NAME);
  for (const key of ['raw_json', 'content_hash', 'external_version', 'body']) assert.equal(after[key], before[key], key);
  assert.equal(JSON.parse(record(sender, { contacts: new Map([[OPEN, USER]]) }).canonical_json).sender_name, null);
});

test('remote aliases missing alternate ID fields remain unknown, do not cache, and recover next round', () => {
  const sender = { id: OPEN, id_type: 'open_id', user_id: USER, union_id: UNION };
  let contacts = 0;
  let members = 0;
  const resolver = createNameResolver({ run(args) {
    if (args[0] === 'contact') {
      contacts += 1;
      return { users: [{ open_id: OPEN, name: contacts === 1 ? USER : NAME }] };
    }
    members += 1;
    return { items: [{ member_id: OPEN, name: UNION }], has_more: false };
  } });
  const first = resolver.buildPeopleContext([message(sender)], opts, null);
  assert.equal(JSON.parse(record(sender, first).canonical_json).sender_name, null);
  assert.equal(first.contacts.size, 0);
  assert.equal(first.chat_members.size, 0);
  const second = resolver.buildPeopleContext([message(sender)], opts, null);
  assert.equal(JSON.parse(record(sender, second).canonical_json).sender_name, NAME);
  assert.equal(contacts, 2);
  assert.equal(members, 1);
});

for (const kind of ['contact', 'member']) {
  test(`new source alias evidence invalidates an otherwise-positive ${kind} cache`, () => {
    let contacts = 0;
    let members = 0;
    const resolver = createNameResolver({ run(args) {
      if (args[0] === 'contact') {
        contacts += 1;
        return { users: kind === 'contact' ? [{ open_id: OPEN, name: contacts === 1 ? USER : NAME }] : [] };
      }
      members += 1;
      return { items: [{ member_id: OPEN, name: members === 1 ? USER : NAME }], has_more: false };
    } });
    const withoutAlias = { id: OPEN, id_type: 'open_id' };
    assert.equal(JSON.parse(record(withoutAlias, resolver.buildPeopleContext([message(withoutAlias)], opts, null)).canonical_json).sender_name, USER);
    const withAlias = { ...withoutAlias, user_id: USER };
    assert.equal(JSON.parse(record(withAlias, resolver.buildPeopleContext([message(withAlias)], opts, null)).canonical_json).sender_name, NAME);
    assert.equal(kind === 'contact' ? contacts : members, 2);
  });
  test(`${kind} localized alias does not hide a valid lower-priority name`, () => {
    const sender = { id: OPEN, id_type: 'open_id', user_id: USER };
    const calls = [];
    const resolver = createNameResolver({ run(args) {
      calls.push(args[0]);
      if (args[0] === 'contact') return { users: kind === 'contact'
        ? [{ open_id: OPEN, localized_name: USER, name: NAME }] : [] };
      return { items: [{ member_id: OPEN, localized_name: USER, name: NAME }], has_more: false };
    } });
    const context = resolver.buildPeopleContext([message(sender)], opts, { open_id: OPEN, name: USER });
    assert.equal(JSON.parse(record(sender, context).canonical_json).sender_name, NAME);
    assert.deepEqual(calls, kind === 'contact' ? ['contact'] : ['contact', 'im']);
  });
}
