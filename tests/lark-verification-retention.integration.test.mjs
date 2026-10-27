import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureInitialized, quoteSql, sqliteExec, sqliteQuery, upsertRecordsSql } from '../dist/storage/sqlite/ingestion-store.js';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { bindCurrentSenderNames } from '../src/adapters/lark-im/name-history.mjs';
import { prepareSenderWork } from '../src/adapters/lark-im/sender-name-work.mjs';
import { nameTaskKey } from '../src/adapters/lark-im/name-evidence.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';

// Authored fixtures only. No captured or redacted account/message data.
const SELF = { open_id: 'ou_synthetic_retention_owner', name: 'Synthetic Owner' };
const ACTOR = 'ou_synthetic_retention_person', CHAT = 'oc_synthetic_retention_group';
const ACCOUNT = recipientAccountKey(SELF.open_id), OTHER = recipientAccountKey('ou_synthetic_other_owner');
const NOW = Date.parse('2040-01-02T03:04:05.000Z');
const STORED_AT = '2002-01-01T00:00:00.000Z';
const OBSERVATION = { status: 'resolved', reason: 'exact_id_match', name: 'Synthetic Gardener',
  source: 'chat_member', account_key: ACCOUNT, observed_at: new Date(NOW).toISOString(), cached: false };
const ADOPTED_FIELDS = ['sender_name', 'sender_name_source', 'sender_name_confidence',
  'sender_name_resolution_status', 'sender_name_resolution_reason', 'sender_name_authority_source',
  'sender_name_account_key', 'sender_name_observed_at'];
const canonical = row => JSON.parse(row.canonical_json);
const without = (row, fields) => Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)));
const appendMember = (text, key, value) => `${text.slice(0, -1)},${key}:${JSON.stringify(value)}}`;

function fixture(t, { native = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'exo-verification-retention-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite'), scope = chatScopeId(CHAT);
  ensureInitialized(db);
  sqliteExec(db, `INSERT INTO sync_scopes(id,source_id,name,enabled,config_json)
    VALUES(${quoteSql(scope)},'lark.im','Synthetic scope',1,${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`);
  const raw = { message_id: 'om_synthetic_retention_message', chat_id: CHAT, chat_type: 'group', msg_type: 'text',
    create_time: String(NOW - 1000), update_time: String(NOW),
    sender: { id: ACTOR, id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: 'Count the invented seedlings.' }) } };
  const message = native ? normalizeApiMessage(raw) : { ...raw, content: 'Count the invented seedlings.' };
  const incoming = (source = message) => bindCurrentSenderNames([
    recordFromMessage(source, scope, 'received', { self: SELF }),
  ], SELF)[0];
  const read = () => sqliteQuery(db, 'SELECT * FROM records;', 'read synthetic row')[0];
  const write = row => sqliteExec(db, upsertRecordsSql([row]), 'store synthetic row');
  const replaceCanonical = text => sqliteExec(db,
    `UPDATE records SET canonical_json=${quoteSql(text)};`, 'author synthetic predecessor');
  write(incoming());
  sqliteExec(db, `UPDATE records SET updated_at=${quoteSql(STORED_AT)};`);
  const initial = read();
  const task = { source_id: 'lark.im', kind: 'sender', account_key: ACCOUNT,
    chat_id: CHAT, actor_id: ACTOR, namespace: 'open_id', task_key: nameTaskKey('sender', CHAT, ACTOR, 'open_id'),
    latest_record_id: initial.id, after_record_id: 0, projection_horizon_record_id: initial.id,
    projection_deferred: 0,
    evidence_json: JSON.stringify({ schema: 'lark_sender_name_work/v1', source_id: 'lark.im',
      account_key: ACCOUNT, chat_id: CHAT, actor_id: ACTOR, namespace: 'open_id', phase: 'resolved', observation: OBSERVATION }) };
  const result = prepareSenderWork(task, { db, self: SELF, accountKey: ACCOUNT, nowMs: NOW,
    query: (sql, label) => sqliteQuery(db, sql, label),
    runLark() { assert.fail('resolved synthetic evidence must not request an API'); } });
  assert.equal(result.updates.length, 1);
  sqliteExec(db, result.updates.join(';'), 'apply genuine synthetic sender projection');
  assert.deepEqual(canonical(read()).sender_name_verification, OBSERVATION);
  assert.equal(read().updated_at, initial.updated_at);
  return { db, message, incoming, read, write, replaceCanonical };
}

for (const accountPresent of [false, true]) {
  test(`same native version replay retains diagnostics and all record bytes; incoming account=${accountPresent}`, t => {
    const f = fixture(t);
    const original = f.read();
    // Unknown numeric source tokens must survive JSON mutation and equality checks.
    f.replaceCanonical(`${original.canonical_json.slice(0, -1)},"unknown_precision":9007199254740993}`);
    const before = f.read(), incoming = f.incoming();
    assert.equal(Object.hasOwn(canonical(incoming), 'sender_name_account_key'), false);
    assert.equal(Object.hasOwn(canonical(incoming), 'sender_name_verification'), false);
    incoming.canonical_json = `${incoming.canonical_json.slice(0, -1)},"unknown_precision":9007199254740993${accountPresent ? `,"sender_name_account_key":${JSON.stringify(ACCOUNT)}` : ''}}`;
    f.write(incoming);
    assert.deepEqual(f.read(), before, 'a no-query replay is a complete duplicate, including updated_at');
    f.write(incoming);
    assert.deepEqual(f.read(), before, 'repeated replay remains byte stable');
    assert.equal(canonical(incoming).sender_name_account_key, accountPresent ? ACCOUNT : undefined,
      'retention must not mutate the incoming projection or create its account proof');
  });
}

for (const status of ['failed', 'conflict', 'cached', 'renamed', 'null']) {
  test(`a present ${status} lookup is not frozen to the adopted observation`, t => {
    const f = fixture(t), before = f.read(), incoming = f.incoming();
    const value = status === 'null' ? null : status === 'cached' ? { ...OBSERVATION, cached: true }
      : status === 'renamed' ? { ...OBSERVATION, name: 'Synthetic Arborist', observed_at: new Date(NOW + 1000).toISOString() }
        : { status, reason: status === 'failed' ? 'request_failed' : 'conflicting_names', source: 'contact',
          account_key: ACCOUNT, observed_at: new Date(NOW + 1000).toISOString(), cached: false };
    const next = { ...canonical(incoming), sender_name_verification: value };
    if (status === 'renamed') Object.assign(next, {
      sender_name: value.name, sender_name_source: value.source, sender_name_confidence: 'high',
      sender_name_resolution_status: value.status, sender_name_resolution_reason: value.reason,
      sender_name_authority_source: value.source, sender_name_account_key: value.account_key,
      sender_name_observed_at: value.observed_at,
    });
    incoming.canonical_json = JSON.stringify(next);
    f.write(incoming);
    const after = f.read();
    assert.deepEqual(canonical(after).sender_name_verification, value);
    assert.notEqual(after.updated_at, before.updated_at, 'new diagnostic metadata is a real update');
    assert.deepEqual(without(after, ['canonical_json', 'updated_at']), without(before, ['canonical_json', 'updated_at']));
    if (status !== 'renamed') for (const key of ADOPTED_FIELDS) assert.equal(canonical(after)[key], canonical(before)[key], key);
    else assert.equal(canonical(after).sender_name, value.name);
    f.write(incoming);
    assert.deepEqual(f.read(), after, 'an identical new lookup is not a fresh update');
    if (status !== 'null') {
      f.write(f.incoming());
      assert.deepEqual(f.read(), after, 'a later no-query replay retains the latest diagnostic, not the original success');
    }
  });
}

test('strictly account-absent historical diagnostics remain unbound and byte stable', t => {
  const f = fixture(t), old = canonical(f.read());
  delete old.sender_name_account_key;
  delete old.sender_name_verification.account_key;
  f.replaceCanonical(JSON.stringify(old));
  const before = f.read();
  f.write(f.incoming());
  assert.deepEqual(f.read(), before);
  const after = canonical(f.read());
  for (const key of ['sender_name_account_key', 'chat_name_account_key']) assert.equal(Object.hasOwn(after, key), false);
  assert.equal(Object.hasOwn(after.sender_name_verification, 'account_key'), false);
});

for (const mode of ['incoming bound', 'incoming null', 'old nulls', 'old invalid hashes', 'old chat bound']) {
  test(`unbound diagnostics cannot use ${mode} as absence`, t => {
    const f = fixture(t), old = canonical(f.read()), incoming = f.incoming();
    delete old.sender_name_account_key;
    delete old.sender_name_verification.account_key;
    if (mode === 'incoming bound' || mode === 'incoming null') incoming.canonical_json = JSON.stringify({
      ...canonical(incoming), sender_name_account_key: mode === 'incoming bound' ? ACCOUNT : null,
    });
    if (mode === 'old nulls' || mode === 'old invalid hashes') {
      old.sender_name_account_key = mode === 'old nulls' ? null : 'not-a-hash';
      old.sender_name_verification.account_key = old.sender_name_account_key;
    }
    if (mode === 'old chat bound') old.chat_name_account_key = ACCOUNT;
    f.replaceCanonical(JSON.stringify(old));
    f.write(incoming);
    assert.equal(Object.hasOwn(canonical(f.read()), 'sender_name_verification'), false);
  });
}

const accountCases = [
  ['old adopted account missing', old => { delete old.sender_name_account_key; }],
  ['old adopted account null', old => { old.sender_name_account_key = null; }],
  ['old adopted account wrong type', old => { old.sender_name_account_key = 7; }],
  ['old adopted account invalid hash', old => { old.sender_name_account_key = 'not-a-hash'; }],
  ['old adopted account differs from observation', old => { old.sender_name_account_key = OTHER; }],
  ['old observation account missing', old => { delete old.sender_name_verification.account_key; }],
  ['old observation account wrong type', old => { old.sender_name_verification.account_key = {}; }],
  ['old chat account conflicts', old => { old.chat_name_account_key = OTHER; }],
];
for (const [name, edit] of accountCases) {
  test(`${name} cannot donate verification`, t => {
    const f = fixture(t), old = canonical(f.read());
    edit(old); f.replaceCanonical(JSON.stringify(old));
    f.write(f.incoming());
    assert.equal(Object.hasOwn(canonical(f.read()), 'sender_name_verification'), false);
  });
}

for (const [name, field, value] of [
  ['other account', 'sender_name_account_key', OTHER],
  ['null account', 'sender_name_account_key', null],
  ['numeric account', 'sender_name_account_key', 7],
  ['uppercase hash', 'sender_name_account_key', ACCOUNT.toUpperCase()],
  ['short hash', 'sender_name_account_key', ACCOUNT.slice(1)],
  ['conflicting chat account', 'chat_name_account_key', OTHER],
]) {
  test(`incoming ${name} cannot borrow the old diagnostic`, t => {
    const f = fixture(t), incoming = f.incoming();
    incoming.canonical_json = JSON.stringify({ ...canonical(incoming), [field]: value });
    f.write(incoming);
    assert.equal(Object.hasOwn(canonical(f.read()), 'sender_name_verification'), false);
  });
}

for (const location of ['incoming', 'old', 'escaped incoming', 'nested old']) {
  test(`duplicate account keys in ${location} fail closed`, t => {
    const f = fixture(t), incoming = f.incoming();
    if (location === 'incoming' || location === 'escaped incoming') {
      incoming.canonical_json = appendMember(incoming.canonical_json, '"sender_name_account_key"', ACCOUNT);
      incoming.canonical_json = appendMember(incoming.canonical_json,
        location === 'escaped incoming' ? '"sender_name_account_\\u006bey"' : '"sender_name_account_key"', OTHER);
    } else if (location === 'old') {
      f.replaceCanonical(appendMember(f.read().canonical_json, '"sender_name_account_key"', OTHER));
    } else {
      f.replaceCanonical(f.read().canonical_json.replace(JSON.stringify(OBSERVATION),
        appendMember(JSON.stringify(OBSERVATION), '"account_key"', OTHER)));
    }
    f.write(incoming);
    assert.equal(Object.hasOwn(canonical(f.read()), 'sender_name_verification'), false);
  });
}

for (const change of ['actor', 'namespace', 'chat', 'message', 'name', 'source', 'clear', 'raw clear', 'old clear', 'untyped']) {
  test(`no-query retention respects explicit ${change} boundary`, t => {
    const f = fixture(t, { native: false });
    const message = structuredClone(f.message);
    if (change === 'actor') message.sender.id = 'ou_synthetic_different_person';
    if (change === 'namespace') message.sender.id_type = 'user_id';
    if (change === 'chat') message.chat_id = 'oc_synthetic_other_group';
    if (change === 'raw clear') message.sender.name_state = 'cleared';
    if (change === 'untyped') delete message.sender.id_type;
    const incoming = f.incoming(message), next = canonical(incoming);
    if (change === 'message') next.message_id = 'om_synthetic_other_message';
    if (change === 'name' || change === 'source') Object.assign(next, {
      sender_name: change === 'name' ? 'Synthetic Other Name' : OBSERVATION.name,
      sender_name_source: change === 'source' ? 'message_sender' : OBSERVATION.source,
      sender_name_account_key: ACCOUNT,
    });
    if (change === 'clear') next.sender_name_state = 'cleared';
    if (change === 'old clear') f.replaceCanonical(JSON.stringify({ ...canonical(f.read()), sender_name_state: 'cleared' }));
    incoming.canonical_json = JSON.stringify(next);
    f.write(incoming);
    assert.equal(Object.hasOwn(canonical(f.read()), 'sender_name_verification'), false);
    if (change === 'clear' || change === 'old clear') assert.equal(canonical(f.read()).sender_name_state, 'cleared');
  });
}

for (const mode of ['chat', 'sender id', 'sender clear', 'nested sender id', 'native wrapper']) {
  test(`duplicate raw ${mode} cannot hide an identity or clear conflict`, t => {
    const f = fixture(t, { native: false }), incoming = f.incoming();
    const sender = JSON.stringify(f.message.sender);
    if (mode === 'chat') incoming.raw_json = appendMember(incoming.raw_json, '"chat_id"', 'oc_synthetic_hidden_chat');
    if (mode === 'sender id') incoming.raw_json = incoming.raw_json.replace(sender,
      appendMember(sender, '"id"', 'ou_synthetic_hidden_person'));
    if (mode === 'sender clear') incoming.raw_json = incoming.raw_json.replace(sender,
      appendMember(appendMember(sender, '"name_state"', 'unknown'), '"name_state"', 'cleared'));
    if (mode === 'nested sender id') incoming.raw_json = incoming.raw_json.replace(sender,
      `${sender.slice(0, -1)},"sender_id":{"open_id":${JSON.stringify(ACTOR)},"open_id":"ou_synthetic_hidden_person"}}`);
    if (mode === 'native wrapper') incoming.raw_json = appendMember(appendMember(incoming.raw_json,
      '"raw_api"', f.message), '"raw_api"', { ...f.message, chat_id: 'oc_synthetic_hidden_chat' });
    assert.notEqual(incoming.raw_json, f.incoming().raw_json);
    f.write(incoming);
    assert.equal(Object.hasOwn(canonical(f.read()), 'sender_name_verification'), false);
  });
}
