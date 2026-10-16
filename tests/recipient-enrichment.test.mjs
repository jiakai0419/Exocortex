import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeEnrichment, EnrichmentInputError } from '../src/maintenance/enrich.mjs';
import { enrichRecipients } from '../src/maintenance/enrich-recipients.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { displayP2pRecipient, makeRecipientEvidence, recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { ensureInitialized, quoteSql, REVIEW_RECORD_COLUMNS, sqliteExec, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';

// All inputs are authored here. No existing account, source database, message,
// diagnostic log or screenshot is read. The CLI test uses a fixture-owned fake.
const SELF = 'ou_synthetic_recipient_self', PEER = 'ou_synthetic_recipient_peer';
const CHAT = 'oc_synthetic_recipient_chat', NOW = Date.parse('2025-02-03T04:05:06.000Z');
const NAME = 'Synthetic Recipient';
const sql = (f, value) => sqliteExec(f.db, value, 'authored recipient fixture');
const query = (f, value) => sqliteQuery(f.db, value, 'inspect authored recipient fixture');
const records = f => query(f, 'SELECT * FROM records ORDER BY id;');
const scopes = f => query(f, 'SELECT * FROM sync_scopes ORDER BY id;');
const sources = f => query(f, 'SELECT * FROM sources ORDER BY id;');
const states = f => query(f, 'SELECT * FROM lark_im_recipient_state ORDER BY source_id,account_key,chat_id;');
const evidence = (f, chat = CHAT, account = SELF) => {
  const text = states(f).find(row => row.chat_id === chat && row.account_key === recipientAccountKey(account))?.evidence_json;
  return text == null ? null : JSON.parse(text);
};
function fixture(t, settings = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'exocortex-recipient-enrichment-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = { directory, db: join(directory, 'synthetic.sqlite'), calls: [] };
  ensureInitialized(f.db);
  add(f, 1, settings);
  return f;
}
function add(f, id, { chat = CHAT, type = 'p2p', account = SELF, direction = 'sent', source = 'lark.im',
  raw = {}, canonical = {}, scope = {}, firstSeen = 'lark.im.sent_by_me', createScope = true } = {}) {
  const native = { message_id: `om_synthetic_recipient_${id}`, chat_id: chat, msg_type: 'text',
    sender: { id: account, id_type: 'open_id', sender_type: 'user' },
    create_time: String(NOW - 10000 + id), body: { content: JSON.stringify({ text: `Synthetic body ${id}  preserved.` }) }, ...raw };
  const projected = { message_id: native.message_id, chat_id: chat, chat_type: type, sender_id: account,
    sender_id_type: 'open_id', sender_type: 'user', sender_name: 'Synthetic Sender', arbitrary: { kept: true }, ...canonical };
  if (source !== 'lark.im') sql(f, `INSERT OR IGNORE INTO sources(id,kind,display_name) VALUES(${quoteSql(source)},'synthetic','Synthetic source');`);
  if (createScope) sql(f, `INSERT OR IGNORE INTO sync_scopes(id,source_id,name,config_json,cursor_json) VALUES(
    ${quoteSql(chatScopeId(chat))},${quoteSql(source)},${quoteSql(`synthetic.chat.${id}`)},
    ${quoteSql(JSON.stringify({ chat_id: chat, chat_type: type, chat_name: 'Synthetic chat title is not recipient', untouched: ['keep', 7], ...scope }))},'{"synthetic_cursor":8}');`);
  const row = { id, source_id: source, first_seen_scope_id: firstSeen, external_id: native.message_id,
    external_version: '180', record_type: 'lark.im.message', occurred_at: new Date(NOW - 10000 + id).toISOString(),
    occurred_at_ms: NOW - 10000 + id, actor_id: account, container_id: chat, direction,
    title: 'Synthetic original title', body: `Synthetic body ${id}  preserved.`, content_hash: `synthetic-hash-${id}`,
    canonical_json: JSON.stringify(projected), raw_json: JSON.stringify(native) };
  sql(f, `INSERT INTO records(${Object.keys(row).join(',')}) VALUES(${Object.values(row).map(quoteSql).join(',')});`);
}
const batch = (chat = CHAT, target = PEER, extra = {}) => ({ code: 0, data: { items: [{ chat_id: chat,
  chat_mode: 'p2p', chat_type: 'private', p2p_target_type: 'user', p2p_target_id: target, ...extra }] } });
function api(f, settings = {}) {
  let selfCalls = 0;
  return (args, options) => {
    f.calls.push(args);
    assert.equal(query(f, 'SELECT count(*) AS count FROM maintenance_locks;')[0].count, 0, 'remote lookup is outside commit lock');
    assert.equal(options.retries, 0);
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 5000);
    settings.onCall?.(args, f);
    if (args[0] === 'contact' && args[1] === '+get-user') {
      selfCalls += 1;
      if (settings.profileError) throw new Error('Synthetic private profile error');
      return { open_id: selfCalls === 2 && settings.switchAccount ? 'ou_synthetic_other_account' : settings.account || SELF,
        name: 'Synthetic Current Account' };
    }
    if (args[0] === 'api' && args[1] === 'POST' && args[2] === '/open-apis/im/v1/chats/batch_query') {
      assert.deepEqual(JSON.parse(args[args.indexOf('--params') + 1]), { user_id_type: 'open_id' });
      const { chat_ids: ids } = JSON.parse(args[args.indexOf('--data') + 1]);
      assert.ok(ids.length >= 1 && ids.length <= 20);
      if (settings.batchError) throw new Error('Synthetic private batch error');
      return settings.batchResponse?.(ids[0]) ?? { code: 0, data: { items: ids.flatMap(id => batch(id, settings.target || PEER).data.items) } };
    }
    if (args[0] === 'contact' && args[1] === '+search-user') {
      if (settings.nameError) throw new Error('Synthetic private contact error');
      const ids = args[args.indexOf('--user-ids') + 1].split(',');
      return settings.nameResponse ?? { users: ids.map(open_id => ({ open_id, name: NAME })) };
    }
    assert.fail('unexpected synthetic request');
  };
}
function run(f, options = {}, settings = {}, deps = {}) {
  return executeEnrichment({ target: 'recipients', db: f.db, recordIds: [1], ...options },
    { runLark: api(f, settings), now: () => NOW, ...deps,
      enrichRecipients: (opts, inner) => enrichRecipients(opts, { ...inner, onRecipientResult: deps.onRecipientResult }) });
}
function assertPublic(report) {
  assert.doesNotMatch(JSON.stringify(report), /ou_synthetic|oc_synthetic|om_synthetic|Synthetic Recipient|Synthetic body|synthetic\.sqlite/);
}
function recipient(f, id = 1) {
  const row = records(f).find(row => row.id === id), config = { chat_id: row.container_id, p2p_recipient: evidence(f, row.container_id) };
  return displayP2pRecipient(row, JSON.parse(row.canonical_json), JSON.parse(row.raw_json), config);
}

test('default preview verifies exact identity and names without changing database bytes or creating a binding', t => {
  const f = fixture(t), before = readFileSync(f.db), files = readdirSync(f.directory).sort(), source = sources(f);
  const report = run(f);
  assert.equal(report.dry_run, true);
  assert.deepEqual([report.resolved, report.named, report.planned, report.updated], [1, 1, 1, 0]);
  assert.deepEqual(readFileSync(f.db), before);
  assert.deepEqual(readdirSync(f.directory).sort(), files);
  assert.deepEqual(sources(f), source);
  assert.equal(f.calls.length, 4);
  assertPublic(report);
});

test('apply changes only independent relationship evidence; scope and message bytes remain intact', t => {
  const f = fixture(t);
  add(f, 2, { chat: 'oc_synthetic_unselected_chat' });
  const beforeRecords = records(f), beforeScopes = scopes(f), beforeSources = sources(f);
  const report = run(f, { apply: true });
  assert.equal(report.updated, 1);
  assert.equal(report.partial, false);
  assert.deepEqual(records(f), beforeRecords);
  assert.deepEqual(sources(f), beforeSources, 'legacy source is never upgraded');
  assert.deepEqual(scopes(f), beforeScopes);
  assert.deepEqual(evidence(f), makeRecipientEvidence(CHAT, SELF, { id_type: 'open_id', id: PEER }, NAME, new Date(NOW).toISOString()));
  assert.equal(evidence(f).account_key, recipientAccountKey(SELF));
  assert.equal(recipient(f), NAME);
  assertPublic(report);
});

test('a never-discovered sent chat is resolved without creating a scope or changing status inputs', t => {
  const f = fixture(t, { createScope: false, type: null }), beforeRecords = records(f), beforeScopes = scopes(f), beforeSources = sources(f);
  const bytes = readFileSync(f.db);
  assert.equal(run(f).planned, 1);
  assert.deepEqual(readFileSync(f.db), bytes, 'preview does not even initialize a relationship row');
  assert.deepEqual(states(f), []);
  const report = run(f, { apply: true });
  assert.equal(report.updated, 1);
  assert.equal(recipient(f), NAME);
  assert.deepEqual(records(f), beforeRecords);
  assert.deepEqual(scopes(f), beforeScopes);
  assert.deepEqual(sources(f), beforeSources);
});

test('a chat with no scope requires the official explicit private-user target', t => {
  const f = fixture(t, { createScope: false, type: null }), before = readFileSync(f.db);
  const report = run(f, { apply: true }, { batchResponse: () => batch(CHAT, PEER, { chat_mode: 'group' }) });
  assert.deepEqual([report.updated, report.partial], [0, true]);
  assert.deepEqual(readFileSync(f.db), before);
  assert.deepEqual(states(f), []);
});

for (const chatType of [undefined, null, 'unknown']) test(`an existing ${String(chatType)} scope type can recover without modifying its scope`, t => {
  const f = fixture(t, { scope: { chat_type: chatType }, canonical: { chat_type: null } });
  const before = scopes(f), beforeRecords = records(f);
  assert.equal(run(f, { apply: true }).updated, 1);
  assert.equal(recipient(f), NAME);
  assert.deepEqual(scopes(f), before);
  assert.deepEqual(records(f), beforeRecords);
});

test('scope evidence can migrate into the independent relation while every scope byte is preserved', t => {
  const prior = makeRecipientEvidence(CHAT, SELF, { id_type: 'open_id', id: PEER }, NAME, new Date(NOW - 1000).toISOString());
  const f = fixture(t, { scope: { p2p_recipient: prior } }), before = scopes(f);
  const report = run(f, { apply: true }, { nameError: true });
  assert.equal(report.updated, 1);
  assert.deepEqual(evidence(f), prior);
  assert.deepEqual(scopes(f), before);
});

for (const invalid of ['duplicate keys', 'byte limit', 'depth limit']) test(`an invalid ${invalid} cache is restored without borrowing a scope name`, t => {
  const prior = makeRecipientEvidence(CHAT, SELF, { id_type: 'open_id', id: PEER }, NAME, new Date(NOW - 1000).toISOString());
  const f = fixture(t, { scope: { p2p_recipient: prior } });
  let text;
  if (invalid === 'duplicate keys') text = JSON.stringify(prior).replace(/}$/, `,"recipient":${JSON.stringify(prior.recipient)}}`);
  if (invalid === 'byte limit') text = JSON.stringify({ ...prior, synthetic_padding: 's'.repeat(1024 * 1024) });
  if (invalid === 'depth limit') {
    let nested = {};
    for (let depth = 0; depth < 70; depth++) nested = { synthetic: nested };
    text = JSON.stringify({ ...prior, nested });
  }
  sql(f, `INSERT INTO lark_im_recipient_state(source_id,account_key,chat_id,evidence_json)
    VALUES('lark.im',${quoteSql(recipientAccountKey(SELF))},${quoteSql(CHAT)},${quoteSql(text)});`);
  const before = scopes(f);
  assert.equal(run(f, { apply: true }, { nameError: true }).updated, 1);
  assert.equal(evidence(f).recipient.id, PEER);
  assert.equal(evidence(f).recipient.name, null, 'ambiguous cached name is not trusted');
  assert.deepEqual(scopes(f), before);
  assert.equal(run(f, { apply: true }).updated, 1);
  assert.equal(recipient(f), NAME);
});

test('relationship writes keep scheduler metadata and other accounts isolated', t => {
  const f = fixture(t), accountKey = recipientAccountKey(SELF), otherKey = recipientAccountKey('ou_synthetic_other_account');
  const otherEvidence = makeRecipientEvidence(CHAT, 'ou_synthetic_other_account', { id_type: 'open_id', id: 'ou_synthetic_other_peer' }, 'Synthetic Other', new Date(NOW).toISOString());
  sql(f, `INSERT INTO lark_im_recipient_state(source_id,account_key,chat_id,evidence_json,last_attempt_at_ms,retry_at_ms,failures,record_after_id,generation,attempt_token)
    VALUES('lark.im',${quoteSql(accountKey)},${quoteSql(CHAT)},NULL,11,22,3,4,5,'synthetic_claim'),
      ('lark.im',${quoteSql(otherKey)},${quoteSql(CHAT)},${quoteSql(JSON.stringify(otherEvidence))},31,32,1,8,7,'synthetic_other_claim');`);
  const before = states(f);
  assert.equal(run(f, { apply: true }).updated, 1);
  for (const old of before) {
    const next = states(f).find(row => row.account_key === old.account_key);
    if (old.account_key === otherKey) assert.deepEqual(next, old);
    else for (const key of Object.keys(old)) if (key !== 'evidence_json') assert.deepEqual(next[key], old[key], key);
  }
});

test('an ordinary failed refresh keeps the previous identity and name byte-for-byte', t => {
  const f = fixture(t);
  run(f, { apply: true });
  const before = readFileSync(f.db);
  const report = run(f, { apply: true }, { batchError: true });
  assert.equal(report.updated, 0);
  assert.equal(recipient(f), NAME);
  assert.deepEqual(readFileSync(f.db), before);
});

test('duplicate selected chat is queried and updated once while all exact rows remain fenced', t => {
  const f = fixture(t); add(f, 2);
  const report = run(f, { apply: true, recordIds: [2, 1] });
  assert.deepEqual([report.scanned, report.chats, report.updated], [2, 1, 1]);
  assert.equal(f.calls.filter(args => args[0] === 'api').length, 1);
});

test('twenty distinct chats share one batch and four total requests', t => {
  const f = fixture(t);
  for (let id = 2; id <= 20; id++) add(f, id, { chat: `oc_synthetic_distinct_${id}` });
  const before = records(f);
  const report = run(f, { apply: true, recordIds: Array.from({ length: 20 }, (_, i) => i + 1) });
  assert.equal(report.updated, 20);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(records(f), before);
});

test('valid contradictory peers become unknown and require a second later matching observation to recover', t => {
  const f = fixture(t), other = 'ou_synthetic_changed_peer', observed = [];
  run(f, { apply: true });
  const before = records(f);
  const next = run(f, { apply: true }, { target: other }, { now: () => NOW + 1000,
    onRecipientResult: result => observed.push(result) });
  assert.equal(next.updated, 1);
  assert.deepEqual(observed, [{ chat_id: CHAT, outcome: 'conflict' }]);
  assert.equal(recipient(f), '未知');
  const conflict = evidence(f);
  assert.equal(conflict.recipient.id, PEER);
  assert.equal(conflict.conflict.recipient.id, other);
  assert.deepEqual(records(f), before);
  run(f, { apply: true }, { batchError: true }, { now: () => NOW + 2000 });
  assert.equal(recipient(f), '未知', 'a failed query cannot clear the contradiction');
  run(f, { apply: true }, { target: other }, { now: () => NOW + 3000 });
  assert.equal(recipient(f), NAME);
  const restored = evidence(f);
  assert.equal(restored.recipient.id, other);
  assert.equal(restored.conflict, undefined);
  const unchanged = states(f);
  run(f, { apply: true }, { target: other }, { now: () => NOW + 4000 });
  assert.deepEqual(states(f), unchanged, 'identical names and identities do not refresh relationship context');
  assert.deepEqual(records(f), before);
});

test('empty or failed name lookup stores verified identity, then a new invocation restores the name', t => {
  const f = fixture(t), before = records(f);
  const first = run(f, { apply: true }, { nameError: true });
  assert.deepEqual([first.resolved, first.named, first.updated, first.partial], [1, 0, 1, true]);
  assert.match(recipient(f), /^ou_synth\.\.\.$/);
  const next = run(f, { apply: true });
  assert.equal(next.named, 1);
  assert.equal(recipient(f), NAME);
  const saved = states(f);
  const failedRefresh = run(f, { apply: true }, { nameError: true }, { now: () => NOW + 1000 });
  assert.equal(failedRefresh.updated, 0);
  assert.deepEqual(states(f), saved);
  assert.deepEqual(records(f), before);
});

for (const [label, response] of [
  ['missing target', { code: 0, data: { items: [] } }],
  ['group', batch(CHAT, PEER, { chat_mode: 'group' })],
  ['bot target', batch(CHAT, PEER, { p2p_target_type: 'bot' })],
  ['wrong chat', batch('oc_synthetic_wrong_chat')],
  ['duplicate target', { data: { items: [...batch().data.items, ...batch().data.items] } }],
  ['partial response', { data: { ...batch().data, has_more: true, page_token: 'synthetic_next' } }],
]) test(`${label} cannot establish a relationship or change stored messages`, t => {
  const f = fixture(t), before = readFileSync(f.db);
  const report = run(f, { apply: true }, { batchResponse: () => response });
  assert.deepEqual([report.resolved, report.planned, report.updated, report.partial], [0, 0, 0, true]);
  assert.deepEqual(readFileSync(f.db), before);
  assert.equal(f.calls.filter(args => args[1] === '+search-user').length, 0);
  assertPublic(report);
});

for (const [label, settings] of [
  ['received', { direction: 'received' }], ['group scope', { type: 'group' }],
  ['other source', { source: 'synthetic.other' }],
  ['untyped sender', { raw: { sender: { id: SELF } } }],
  ['conflicting sender', { raw: { sender: { id: SELF, id_type: 'open_id', open_id: PEER } } }],
  ['wrong canonical chat', { canonical: { chat_id: 'oc_synthetic_wrong_chat' } }],
  ['conflicting canonical type', { canonical: { chat_type: 'group' } }],
  ['conflicting native type', { raw: { chat_mode: 'topic' } }],
  ['conflicting scope mode', { scope: { chat_mode: 'group' } }],
  ['invalid scope type', { scope: { chat_type: 'synthetic_invalid' } }],
  ['object scope type', { scope: { chat_type: {} } }],
  ['wrong scope chat', { scope: { chat_id: 'oc_synthetic_wrong_chat' } }],
]) test(`${label} is rejected before any remote request`, t => {
  const f = fixture(t, settings), before = readFileSync(f.db);
  assert.throws(() => run(f, { apply: true }));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(readFileSync(f.db), before);
});

for (const settings of [{ account: 'ou_synthetic_other_account' }, { switchAccount: true }, { profileError: true }]) {
  test(`profile admission rejects ${Object.keys(settings)[0]} without a business write`, t => {
    const f = fixture(t), before = readFileSync(f.db);
    assert.throws(() => run(f, { apply: true }, settings));
    assert.deepEqual(readFileSync(f.db), before);
  });
}

for (const [label, mutation] of [
  ['body change', "UPDATE records SET body='Synthetic concurrent body' WHERE id=1;"],
  ['record deletion', 'DELETE FROM records WHERE id=1;'],
  ['scope change', `UPDATE sync_scopes SET config_json=json_set(config_json,'$.chat_name','Synthetic concurrent title') WHERE id=${quoteSql(chatScopeId(CHAT))};`],
]) test(`full target and scope CAS reject ${label} before changing recipient evidence`, t => {
  const f = fixture(t);
  assert.throws(() => run(f, { apply: true }, {}, { withCommit(action) { sql(f, mutation); return action(); } }));
  assert.equal(evidence(f), null);
  assert.deepEqual(query(f, 'SELECT * FROM maintenance_locks;'), []);
});

test('a newly inserted scope invalidates a previously scope-less target before committing evidence', t => {
  const f = fixture(t, { createScope: false, type: null });
  assert.throws(() => run(f, { apply: true }, {}, { withCommit(action) {
    sql(f, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${quoteSql(chatScopeId(CHAT))},'lark.im','Synthetic concurrent scope',
      ${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`);
    return action();
  } }));
  assert.deepEqual(states(f), []);
});

test('an existing scope from another source is rejected even when the selected record is Lark', t => {
  const f = fixture(t);
  sql(f, `INSERT INTO sources(id,kind,display_name) VALUES('synthetic.other','synthetic','Synthetic other source');
    UPDATE sync_scopes SET source_id='synthetic.other' WHERE id=${quoteSql(chatScopeId(CHAT))};`);
  assert.throws(() => run(f, { apply: true }));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(states(f), []);
});

for (const operation of ['insert', 'replace', 'delete']) test(`relationship evidence CAS rejects concurrent ${operation}`, t => {
  const f = fixture(t), key = `source_id='lark.im' AND account_key=${quoteSql(recipientAccountKey(SELF))} AND chat_id=${quoteSql(CHAT)}`;
  if (operation !== 'insert') {
    run(f, { apply: true }, { nameError: true });
    assert.equal(evidence(f).recipient.name, null);
  }
  const competing = makeRecipientEvidence(CHAT, SELF, { id_type: 'open_id', id: 'ou_synthetic_competing_peer' }, 'Synthetic Competing', new Date(NOW).toISOString());
  const callbacks = [];
  assert.throws(() => run(f, { apply: true }, {}, { onRecipientResult: result => callbacks.push(result), withCommit(action) {
    if (operation === 'insert') sql(f, `INSERT INTO lark_im_recipient_state(source_id,account_key,chat_id,evidence_json)
      VALUES('lark.im',${quoteSql(recipientAccountKey(SELF))},${quoteSql(CHAT)},${quoteSql(JSON.stringify(competing))});`);
    if (operation === 'replace') sql(f, `UPDATE lark_im_recipient_state SET evidence_json=${quoteSql(JSON.stringify(competing))} WHERE ${key};`);
    if (operation === 'delete') sql(f, `DELETE FROM lark_im_recipient_state WHERE ${key};`);
    return action();
  } }));
  assert.deepEqual(evidence(f), operation === 'delete' ? null : competing);
  assert.deepEqual(callbacks, [], 'a rejected proposal never reports a resolved relationship');
});

test('concurrent scheduler-only changes survive the independent evidence update', t => {
  const f = fixture(t);
  sql(f, `INSERT INTO lark_im_recipient_state(source_id,account_key,chat_id) VALUES('lark.im',${quoteSql(recipientAccountKey(SELF))},${quoteSql(CHAT)});`);
  const report = run(f, { apply: true }, {}, { withCommit(action) {
    sql(f, `UPDATE lark_im_recipient_state SET retry_at_ms=123,failures=4,generation=8,attempt_token='synthetic_new_claim';`);
    return action();
  } });
  assert.equal(report.updated, 1);
  assert.equal(recipient(f), NAME);
  const saved = states(f)[0];
  assert.deepEqual([saved.retry_at_ms, saved.failures, saved.generation, saved.attempt_token], [123, 4, 8, 'synthetic_new_claim']);
});

test('source changes invalidate the proposal without touching relationship evidence', t => {
  const f = fixture(t);
  assert.throws(() => run(f, { apply: true }, {}, { withCommit(action) {
    sql(f, `UPDATE sources SET config_json=json_set(config_json,'$.synthetic_concurrent_config',true) WHERE id='lark.im';`);
    return action();
  } }));
  assert.deepEqual(states(f), []);
});

const recordChanges = {
  id: 99, source_id: 'synthetic.concurrent', first_seen_scope_id: chatScopeId(CHAT), external_id: 'om_synthetic_concurrent_message',
  external_version: '181', record_type: 'synthetic.changed', occurred_at: '2025-02-03T04:05:00.000Z', occurred_at_ms: NOW + 1,
  received_at: '2025-02-03T04:05:00.000Z', actor_id: 'ou_synthetic_concurrent_actor', container_id: 'oc_synthetic_concurrent_chat',
  direction: 'received', title: 'Synthetic concurrent title', body: 'Synthetic concurrent body', content_hash: 'synthetic-concurrent-hash',
  canonical_json: '{"synthetic":"changed"}', raw_json: '{"synthetic":"changed"}',
  created_at: '2025-02-03T04:05:00.000Z', updated_at: '2025-02-03T04:05:00.000Z',
};
assert.deepEqual(Object.keys(recordChanges), REVIEW_RECORD_COLUMNS, 'the immutable record fence covers every current column');
for (const column of REVIEW_RECORD_COLUMNS) test(`exact record CAS rejects a concurrent ${column} change`, t => {
  const f = fixture(t);
  sql(f, `INSERT INTO sources(id,kind,display_name) VALUES('synthetic.concurrent','synthetic','Synthetic concurrent source');`);
  assert.throws(() => run(f, { apply: true }, {}, { withCommit(action) {
    sql(f, `UPDATE records SET ${column}=${quoteSql(recordChanges[column])} WHERE id=1;`);
    return action();
  } }));
  assert.deepEqual(states(f), []);
});

test('budget interruption after a parsed result cannot commit any evidence', t => {
  const f = fixture(t), before = readFileSync(f.db);
  assert.throws(() => run(f, { apply: true }, {}, { assertReady() { throw new Error('Synthetic exhausted command budget'); } }));
  assert.deepEqual(readFileSync(f.db), before);
});

for (const options of [
  { recordIds: [] }, { recordIds: [1, 1] }, { recordIds: Array.from({ length: 21 }, (_, i) => i + 1) },
  { recordIds: [1.5] }, { namesOnly: true }, { limit: 1 }, { senderOnly: true, senderId: SELF },
  { probeApps: true }, { unsafeDetails: true }, { reviewOut: '/invented/unused' },
]) test(`recipient options reject unsupported selection ${JSON.stringify(options)}`, () => {
  assert.throws(() => executeEnrichment({ target: 'recipients', db: '/invented/not-opened', recordIds: [1], ...options }), EnrichmentInputError);
});

test('real CLI uses fixture-owned request coordination and bounded fake API, leaving messages unchanged', t => {
  const f = fixture(t), before = records(f), executable = join(f.directory, 'fake-lark-cli.mjs'), audit = join(f.directory, 'synthetic-requests.jsonl');
  writeFileSync(executable, `#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs';
const args=process.argv.slice(2); appendFileSync(${JSON.stringify(audit)}, JSON.stringify(args)+'\\n');
let response;
if(args[0]==='contact'&&args[1]==='+get-user') response={open_id:${JSON.stringify(SELF)},name:'Synthetic Current Account'};
else if(args[0]==='api'&&args[1]==='POST'&&args[2]==='/open-apis/im/v1/chats/batch_query') response=${JSON.stringify(batch())};
else if(args[0]==='contact'&&args[1]==='+search-user') response={users:[{open_id:${JSON.stringify(PEER)},name:${JSON.stringify(NAME)}}]};
else process.exit(1);
process.stdout.write(JSON.stringify(response));\n`);
  chmodSync(executable, 0o700);
  const result = spawnSync(process.execPath, ['tests/helpers/enrichment-cli.mjs', f.directory, 'maintenance', 'enrich',
    '--target', 'recipients', '--record-id', '1', '--db', f.db, '--apply', '--format', 'json'],
  { cwd: process.cwd(), encoding: 'utf8', timeout: 20000, env: { ...process.env, LARK_CLI: executable } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.updated, 1);
  assert.equal(report.request_budget.cli_attempts, 4);
  assert.equal(readFileSync(audit, 'utf8').trim().split('\n').length, 4);
  assert.deepEqual(records(f), before);
  assert.equal(recipient(f), NAME);
  assertPublic(report);
  const beforeBudgetStop = readFileSync(f.db);
  const stopped = spawnSync(process.execPath, ['tests/helpers/enrichment-cli.mjs', f.directory, 'maintenance', 'enrich',
    '--target', 'recipients', '--record-id', '1', '--db', f.db, '--apply', '--max-cli-attempts', '3', '--format', 'json'],
  { cwd: process.cwd(), encoding: 'utf8', timeout: 20000, env: { ...process.env, LARK_CLI: executable } });
  assert.equal(stopped.status, 1, stopped.stderr + stopped.stdout);
  assert.match(stopped.stdout, /cli_budget/);
  assert.equal(readFileSync(audit, 'utf8').trim().split('\n').length, 7, 'actual attempt cap blocks the second self lookup');
  assert.deepEqual(readFileSync(f.db), beforeBudgetStop);
});
