import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mergeLarkNameProjectionSql } from '../dist/storage/sqlite/lark-name-projection.js';
import { ensureInitialized, readScope, createRun, succeedRecordRun, sqliteQuery, sqliteExec, quoteSql } from '../dist/storage/sqlite/ingestion-store.js';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { messageNameAccount } from '../src/adapters/lark-im/name-evidence.mjs';

// All values below are invented here; no account, messages or database are read.
const ACCOUNT = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const ACTOR = 'ou_authored_marker_actor', CHAT = 'oc_authored_marker_chat';
const SCOPE = 'lark.im.sent_by_me', AT = Date.UTC(2032, 0, 2, 3, 4, 5);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'exo-chat-account-merge-')), db = join(root, 'synthetic.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true })); ensureInitialized(db);
  return {
    db,
    write(record) { const scope = readScope(db, SCOPE), run = createRun(db, scope, { synthetic: true });
      return succeedRecordRun(db, scope, run, [record], 1, { kind: 'synthetic.cursor/v1', occurred_at_ms: AT }, {}); },
    row() { return sqliteQuery(db, 'SELECT * FROM records;', 'inspect authored account merge')[0]; },
  };
}
function canonical(extra = {}) { return { message_id: 'om_authored_marker', chat_id: CHAT, sender_id: ACTOR,
  sender_id_type: 'open_id', sender_name: null, chat_name: null, ...extra }; }
function merge(f, before, after, options = {}) {
  const old = typeof before === 'string' ? before : JSON.stringify(before);
  const next = typeof after === 'string' ? after : JSON.stringify(after);
  const raw = options.raw || { message_id: 'om_authored_marker', chat_id: CHAT, sender: { id: ACTOR, id_type: 'open_id' } };
  const nextRaw = options.nextRaw || raw;
  const expression = mergeLarkNameProjectionSql(quoteSql(old), quoteSql(next), quoteSql(ACTOR), quoteSql(ACTOR),
    quoteSql(CHAT), quoteSql(options.nextContainer || CHAT), quoteSql(JSON.stringify(raw)), quoteSql(JSON.stringify(nextRaw)));
  const value = sqliteQuery(f.db, `SELECT ${expression} AS value;`, 'merge authored chat account')[0].value;
  return options.text ? value : JSON.parse(value);
}
function message(revision = 0, extra = {}) {
  return { message_id: 'om_authored_marker', create_time: String(AT), update_time: String(AT + revision),
    chat_id: CHAT, chat_type: 'group', msg_type: 'text', sender: { id: ACTOR, id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: 'A synthetic message remains exact.' }) }, ...extra };
}
function project(revision = 0, extra = {}) { return recordFromMessage(message(revision, extra), SCOPE, 'received'); }

for (const title of [null, 'Known historical title']) test(`independent account marker survives unknown reobservation with title ${title}`, t => {
  const f = fixture(t), before = canonical({ chat_name: title, chat_name_account_key: ACCOUNT });
  const result = merge(f, before, canonical());
  assert.equal(result.chat_name_account_key, ACCOUNT); assert.equal(result.chat_name, title);
  assert.equal(messageNameAccount({ record_type: 'lark.im.message', source_id: 'lark.im', external_id: 'om_authored_marker',
    container_id: CHAT, actor_id: ACTOR, direction: 'received' }, result,
    { message_id: 'om_authored_marker', chat_id: CHAT, sender: { id: ACTOR, id_type: 'open_id' } }), ACCOUNT);
});

test('fresh titles and explicit clears retain the independent account without changing the existing clear contract', t => {
  const f = fixture(t), old = canonical({ chat_name: 'Before', chat_name_account_key: ACCOUNT });
  const renamed = merge(f, old, canonical({ chat_name: 'After' }));
  assert.equal(renamed.chat_name, 'After'); assert.equal(renamed.chat_name_account_key, ACCOUNT);
  const cleared = merge(f, old, canonical({ chat_name_state: 'cleared' }));
  assert.equal(cleared.chat_name, null); assert.equal(cleared.chat_name_state, 'cleared');
  assert.equal(cleared.chat_name_account_key, ACCOUNT);
  const stillClear = merge(f, cleared, canonical());
  assert.equal(stillClear.chat_name_state, 'cleared'); assert.equal(stillClear.chat_name_account_key, ACCOUNT);
});

test('different containers and explicit new or existing account conflicts cannot inherit a marker', t => {
  const f = fixture(t), old = canonical({ chat_name_account_key: ACCOUNT });
  const candidates = [
    canonical({ chat_name_account_key: OTHER }), canonical({ sender_name_account_key: OTHER }),
    canonical({ sender_name_verification: { account_key: OTHER } }),
    canonical({ sender_name_account_key: 3 }), canonical({ chat_name_account_key: '' }),
  ];
  for (const after of candidates) assert.equal(merge(f, old, after).chat_name_account_key, undefined);
  assert.equal(merge(f, { ...old, sender_name_account_key: OTHER }, canonical()).chat_name_account_key, undefined);
  assert.equal(merge(f, old, canonical({ chat_id: 'oc_authored_other_chat' }), { nextContainer: 'oc_authored_other_chat' }).chat_name_account_key, undefined);
  assert.equal(merge(f, old, canonical(), { nextRaw: { chat_id: 'oc_authored_other_chat' } }).chat_name_account_key, undefined);
  assert.equal(merge(f, old, canonical(), { nextRaw: { chat_id: CHAT, raw_api: { chat_id: 'oc_authored_other_chat' } } }).chat_name_account_key, undefined);
});

test('compatible and unknown explicit accounts preserve the marker, independently of actor names', t => {
  const f = fixture(t), old = canonical({ chat_name_account_key: ACCOUNT, sender_name: 'Known sender',
    sender_name_source: 'contact', sender_name_account_key: ACCOUNT });
  for (const accounts of [{}, { chat_name_account_key: ACCOUNT }, { sender_name_account_key: ACCOUNT },
    { sender_name_verification: { account_key: ACCOUNT } }, { chat_name_account_key: null, sender_name_account_key: null }]) {
    const after = merge(f, old, canonical(accounts));
    assert.equal(after.chat_name_account_key, ACCOUNT); assert.equal(after.sender_name, 'Known sender');
  }
});

test('a new payload or incoming projection cannot establish official chat-account authority', t => {
  const f = fixture(t);
  const projected = project(0, { chat_name_account_key: ACCOUNT });
  assert.equal(JSON.parse(projected.canonical_json).chat_name_account_key, undefined);
  assert.equal(JSON.parse(projected.raw_json).chat_name_account_key, ACCOUNT, 'untrusted source field stays raw only');
  const result = merge(f, canonical(), canonical({ chat_name_account_key: ACCOUNT }),
    { nextRaw: { chat_id: CHAT, chat_name_account_key: ACCOUNT } });
  assert.equal(result.chat_name_account_key, undefined);
  for (const invalid of ['short', 'A'.repeat(64), 123, null]) {
    assert.equal(merge(f, canonical({ chat_name_account_key: invalid }), canonical()).chat_name_account_key, undefined);
  }
});

test('duplicate account declarations cannot become a valid inherited marker after reserialization', t => {
  const f = fixture(t), base = JSON.stringify(canonical()).slice(0, -1);
  const duplicate = `${base},"chat_name_account_key":"${ACCOUNT}","chat_name_account_key":"${OTHER}"}`;
  assert.equal(merge(f, duplicate, canonical()).chat_name_account_key, undefined);
  const verification = `${base},"chat_name_account_key":"${ACCOUNT}","sender_name_verification":{"account_key":"${ACCOUNT}","account_key":"${OTHER}"}}`;
  assert.equal(merge(f, verification, canonical()).chat_name_account_key, undefined);
});

test('actual store preserves the official marker across equal-version and newer reobservations without touching raw content', t => {
  const f = fixture(t), initial = project(); f.write(initial);
  const adopted = canonical({ ...JSON.parse(f.row().canonical_json), chat_name_account_key: ACCOUNT });
  sqliteExec(f.db, `UPDATE records SET canonical_json=${quoteSql(JSON.stringify(adopted))};`, 'author synthetic official adoption');
  const before = f.row(); f.write(initial); const same = f.row();
  assert.equal(JSON.parse(same.canonical_json).chat_name_account_key, ACCOUNT);
  for (const key of ['raw_json','content_hash','body','title','external_version','created_at','received_at','occurred_at_ms'])
    assert.equal(same[key], before[key], key);
  const newer = project(1000); f.write(newer); const stored = f.row();
  assert.equal(JSON.parse(stored.canonical_json).chat_name_account_key, ACCOUNT);
  assert.equal(stored.raw_json, newer.raw_json); assert.equal(stored.content_hash, createHash('sha256').update(newer.raw_json).digest('hex'));
  assert.equal(stored.body, newer.body); assert.equal(stored.external_version, newer.external_version);
});


const NUMERIC_UNKNOWN = '{ "array" : [{"unsafe":9007199254740993,"beyond":18446744073709551617,"decimal":0.12345678901234567890123456789,"exponent":1e400,"negative":-0}, null] }';
function textWithUnknown(fields = {}, pad = '') {
  return JSON.stringify(canonical(fields)).slice(0,-1) + `,"unknown":${NUMERIC_UNKNOWN},"pad":${JSON.stringify(pad)}}`;
}
for (const branch of ['absent','same','append','remove']) test(`marker ${branch} preserves unknown numeric tokens and whitespace`, t => {
  const f = fixture(t), before = textWithUnknown(branch === 'absent' ? {} : { chat_name_account_key: ACCOUNT });
  const fields = { sender_name: 'New Synthetic Sender', ...(branch === 'same' ? { chat_name_account_key: ACCOUNT }
    : branch === 'remove' ? { chat_name_account_key: OTHER } : {}) };
  const after = textWithUnknown(fields);
  const result = merge(f, before, after, { text: true });
  assert.ok(result.includes(`"unknown":${NUMERIC_UNKNOWN}`));
  assert.equal(JSON.parse(result).sender_name, fields.sender_name);
  assert.equal(JSON.parse(result).chat_name_account_key, ['same','append'].includes(branch) ? ACCOUNT : undefined);
});

for (const branch of ['absent','same','append']) test(`marker ${branch} keeps its fast path for large unknown JSON`, t => {
  const f = fixture(t), pad = 'Authored 非ASCII \\" fragment '.repeat(3000);
  const before = textWithUnknown(branch === 'absent' ? {} : { chat_name_account_key: ACCOUNT }, pad);
  const after = textWithUnknown({ sender_name: 'New Sender', ...(branch === 'same' ? { chat_name_account_key: ACCOUNT } : {}) }, pad);
  assert.ok(Buffer.byteLength(after) > 8192);
  const result = merge(f, before, after, { text: true });
  assert.ok(result.includes(`"unknown":${NUMERIC_UNKNOWN}`));
  assert.ok(result.includes(`"pad":${JSON.stringify(pad)}`));
  assert.equal(JSON.parse(result).chat_name_account_key, branch === 'absent' ? undefined : ACCOUNT);
});

test('rare lossless removal handles root positions, escaped keys and quoted/nested values', t => {
  const f = fixture(t), prefix = JSON.stringify(canonical({ sender_name: 'New Sender' })).slice(1,-1);
  const nested = `"nested": { "label" : "雪", "chat_name_account_key" : "must remain", "quoted" : "x\\\"}y", "unknown" : ${NUMERIC_UNKNOWN} }`;
  for (const key of ['"chat_name_account_key"', '"chat_name_account_\\u006bey"']) {
    for (const value of [JSON.stringify(OTHER), '"bad\\\"}quoted"', '{"chat_name_account_key":"nested owned value","array":["\\\"",{}]}', 'null']) {
      const owned = `${key} : ${value}`;
      for (const members of [[owned,prefix,nested], [prefix,owned,nested], [prefix,nested,owned]]) {
        const after = ` { ${members.join(' , ')} } \n`;
        const result = merge(f, canonical(), after, { text: true });
        assert.equal(JSON.parse(result).chat_name_account_key, undefined);
        assert.ok(result.includes(nested));
      }
    }
  }
});

test('duplicate incoming root markers fail closed before every fast or removal branch, including escaped same-name keys', t => {
  const f = fixture(t), base = JSON.stringify(canonical({ sender_name: 'New Sender' })).slice(0,-1);
  for (const old of [canonical(), canonical({ chat_name_account_key: ACCOUNT })]) {
    for (const key of ['"chat_name_account_key"', '"chat_name_account_\\u006bey"']) {
      const duplicate = `${base},"chat_name_account_key":"${ACCOUNT}",${key}:"${OTHER}"}`;
      assert.throws(() => merge(f, old, duplicate), /failed/);
    }
  }
});

test('oversized or duplicate incoming marker refusal cannot partially write actual store records', t => {
  const f = fixture(t), initial = project(); f.write(initial);
  sqliteExec(f.db, `UPDATE records SET canonical_json=${quoteSql(textWithUnknown({ ...JSON.parse(f.row().canonical_json), chat_name_account_key: ACCOUNT }))};`, 'author official binding');
  const before = f.row();
  const oversized = project(1000);
  oversized.canonical_json = textWithUnknown({ ...JSON.parse(oversized.canonical_json), chat_name_account_key: OTHER }, 'Authored'.repeat(2000));
  assert.throws(() => f.write(oversized), /failed/);
  assert.deepEqual(f.row(), before, 'refused marker replacement cannot commit body, raw, version or canonical changes');
  const malformed = project(1500);
  malformed.canonical_json = textWithUnknown({ ...JSON.parse(malformed.canonical_json), chat_name_account_key: { invalid: true } }, 'Authored'.repeat(2000));
  assert.throws(() => f.write(malformed), /failed/);
  assert.deepEqual(f.row(), before, 'oversized malformed marker removal also refuses the whole record mutation');
  const duplicate = project(2000);
  duplicate.canonical_json = duplicate.canonical_json.slice(0,-1) + `,"chat_name_account_key":"${ACCOUNT}","chat_name_account_\\u006bey":"${OTHER}"}`;
  assert.throws(() => f.write(duplicate));
  assert.deepEqual(f.row(), before);
});

test('the full 8 KiB rare branch is bounded and preserves dense escaped string text', t => {
  const f = fixture(t), suffix = `,"chat_name_account_key":"${OTHER}"}`;
  let prefix = JSON.stringify(canonical({ sender_name: 'New Sender' })).slice(0,-1) + ',"dense":"';
  const paddingBytes = 8192 - Buffer.byteLength(prefix + '"' + suffix);
  const dense = '\\"'.repeat(Math.floor(paddingBytes / 2)) + 'x'.repeat(paddingBytes % 2);
  const incoming = prefix + dense + '"' + suffix;
  assert.equal(Buffer.byteLength(incoming), 8192);
  const start = performance.now();
  const result = merge(f, canonical(), incoming, { text: true });
  const duration = performance.now() - start;
  assert.equal(JSON.parse(result).chat_name_account_key, undefined);
  assert.ok(result.includes(`"dense":"${dense}"`));
  t.diagnostic(`8 KiB bounded BLOB scanner including SQLite subprocess: ${duration.toFixed(1)} ms`);
  assert.ok(duration < 5000, 'one finite rare edit stays within the existing SQLite timeout');
});
