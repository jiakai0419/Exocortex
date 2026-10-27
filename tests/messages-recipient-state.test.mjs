import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureInitialized, quoteSql as q, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { chatScopeId, SENT_SCOPE_ID } from '../src/adapters/lark-im/core.mjs';
import { makeRecipientEvidence, recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { loadMessages, sqliteJson } from '../src/diagnostics/messages-report.mjs';
import { buildStatus } from '../src/diagnostics/sync-status-report.mjs';

// Invented fixtures only. Never reads a user database or invokes an API.
const SELF = 'ou_synthetic_state_self', PEER = 'ou_synthetic_state_peer';
const CHAT = 'oc_synthetic_state_chat', ID = 'om_synthetic_state_message';
const AT = '2025-02-03T04:05:06.000Z', NAME = '合成收件人';
const opts = { direction: 'all', limit: 5, search: '' };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-recipient-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite'); ensureInitialized(db);
  return { db, dir };
}
function recordSql({ id = ID, chat = CHAT, actor = SELF, direction = 'sent', type } = {}) {
  const canonical = { message_id: id, chat_id: chat, sender_id: actor, sender_id_type: 'open_id',
    sender_name: '合成发送人', sender_type: 'user', msg_type: 'text', ...(type ? { chat_type: type } : {}) };
  const raw = { message_id: id, chat_id: chat, create_time: String(Date.parse(AT)), msg_type: 'text',
    sender: { id: actor, id_type: 'open_id', sender_type: 'user' }, body: { content: '{"text":"合成正文"}' } };
  return `INSERT INTO records(source_id,first_seen_scope_id,external_id,record_type,occurred_at,occurred_at_ms,actor_id,container_id,direction,body,content_hash,canonical_json,raw_json)
    VALUES('lark.im',${q(SENT_SCOPE_ID)},${q(id)},'lark.im.message',${q(AT)},${Date.parse(AT)},${q(actor)},${q(chat)},${q(direction)},'合成正文','synthetic_hash',${q(JSON.stringify(canonical))},${q(JSON.stringify(raw))});`;
}
function evidenceSql({ chat = CHAT, account = SELF, text = JSON.stringify(makeRecipientEvidence(chat, account, { id_type: 'open_id', id: PEER }, NAME, AT)) } = {}) {
  return `INSERT INTO lark_im_recipient_state(source_id,account_key,chat_id,evidence_json)
    VALUES('lark.im',${q(recipientAccountKey(account))},${q(chat)},${text === null ? 'NULL' : q(text)})
    ON CONFLICT(source_id,account_key,chat_id) DO UPDATE SET evidence_json=excluded.evidence_json;`;
}
function scopeSql(config) {
  return `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(chatScopeId(CHAT))},'lark.im','synthetic scope',${q(typeof config === 'string' ? config : JSON.stringify(config))});`;
}

test('orphan sent chat consumes only explicit account-bound evidence, with unchanged status, records and scopes', t => {
  const { db, dir } = fixture(t);
  sqliteExec(db, recordSql());
  const before = loadMessages(db, opts), status = buildStatus(db);
  const records = sqliteJson(db, 'SELECT * FROM records;', 'synthetic records');
  const scopes = sqliteJson(db, 'SELECT * FROM sync_scopes;', 'synthetic scopes');
  assert.equal(before[0].display.scene, '会话类型未知');
  assert.deepEqual(before[0].readiness, { version: 1, state: 'enriching', requirements: [
    { field: 'sender', state: 'missing', reason: 'sender_name_unverified', evidence: null },
    { field: 'recipient', state: 'missing', reason: 'recipient_identity_unknown', evidence: null },
    { field: 'conversation', state: 'missing', reason: 'conversation_type_unknown', evidence: null },
    { field: 'content', state: 'satisfied', reason: null, evidence: 'content_projection' },
  ], reasons: ['sender_name_unverified', 'recipient_identity_unknown', 'conversation_type_unknown'], next_action: 'resolve_sender' });
  sqliteExec(db, evidenceSql({ text: null }));
  assert.deepEqual(loadMessages(db, opts), before, 'queue presence is not a conversation identity');
  sqliteExec(db, evidenceSql());
  const expected = structuredClone(before);
  Object.assign(expected[0].display, { scene: '私聊', recipient: NAME, chat: null });
  // This legacy sender name still lacks authority. Recipient recovery can
  // satisfy its own fields without promoting the entire row to ready.
  expected[0].readiness = { version: 1, state: 'enriching', requirements: [
    { field: 'sender', state: 'missing', reason: 'sender_name_unverified', evidence: null },
    { field: 'recipient', state: 'satisfied', reason: null, evidence: 'contact' },
    { field: 'conversation', state: 'satisfied', reason: null, evidence: 'exact_conversation' },
    { field: 'content', state: 'satisfied', reason: null, evidence: 'content_projection' },
  ], reasons: ['sender_name_unverified'], next_action: 'resolve_sender' };
  assert.deepEqual(loadMessages(db, opts), expected);
  assert.deepEqual(buildStatus(db), status, 'recipient evidence does not change status shape or counts');
  assert.deepEqual(sqliteJson(db, 'SELECT * FROM records;', 'synthetic records'), records);
  assert.deepEqual(sqliteJson(db, 'SELECT * FROM sync_scopes;', 'synthetic scopes'), scopes);
  sqliteExec(db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  const bytes = readFileSync(db);
  const result = spawnSync(process.execPath, ['bin/exocortex.mjs', 'messages', '--db', db, '--format', 'json'],
    { encoding: 'utf8', env: { ...process.env, LARK_CLI: join(dir, 'absent-cli') }, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  const text = spawnSync(process.execPath, ['bin/exocortex.mjs', 'messages', '--db', db, '--format', 'text'],
    { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', LARK_CLI: join(dir, 'absent-cli') }, timeout: 5000 });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Messages \(1\)\n完整 0 · 待补全 1 · 受阻 0/);
  assert.ok(text.stdout.includes(`SENT ${new Date(AT).toLocaleString()}  om_synth...  私聊\n`));
  assert.match(text.stdout, /状态\s+等待完整信息\n.*原因\s+发送人名称待核验/);
  assert.doesNotMatch(text.stdout, /\n  发送人  |\n  接收人  /);
  assert.deepEqual(readFileSync(db), bytes, 'messages remains offline and strictly read-only');
});

test('invalid independent evidence blocks old positive scope evidence and can recover after replacement', t => {
  const { db } = fixture(t), positive = makeRecipientEvidence(CHAT, SELF, { id_type: 'open_id', id: PEER }, NAME, AT);
  sqliteExec(db, recordSql() + scopeSql({ chat_id: CHAT, chat_type: 'p2p', p2p_recipient: positive }));
  assert.equal(loadMessages(db, opts)[0].display.recipient, NAME);
  for (const text of ['{}', '[]', JSON.stringify(positive).replace('"schema":', '"schema":"invalid","schema":'),
    JSON.stringify({ ...positive, account_key: recipientAccountKey('ou_synthetic_other_account') })]) {
    sqliteExec(db, evidenceSql({ text }));
    assert.equal(loadMessages(db, opts)[0].display.recipient, '未知');
  }
  sqliteExec(db, evidenceSql({ text: null }));
  assert.equal(loadMessages(db, opts)[0].display.recipient, NAME, 'queue-only state does not invalidate preexisting evidence');
  sqliteExec(db, evidenceSql());
  assert.equal(loadMessages(db, opts)[0].display.recipient, NAME);
});

test('different account state never supplies a recipient or conversation mode', t => {
  const { db } = fixture(t);
  sqliteExec(db, recordSql() + evidenceSql({ account: 'ou_synthetic_other_account' }));
  assert.equal(loadMessages(db, opts)[0].display.scene, '会话类型未知');
  sqliteExec(db, scopeSql({ chat_id: CHAT, chat_type: 'p2p' }));
  assert.equal(loadMessages(db, opts)[0].display.recipient, '未知');
});

for (const type of ['group', 'topic']) test(`${type} contradiction never consumes private evidence`, t => {
  const { db } = fixture(t);
  sqliteExec(db, recordSql({ type }) + evidenceSql());
  const message = loadMessages(db, opts)[0];
  assert.equal(message.display.scene, '会话类型未知');
  assert.equal(message.display.recipient, null);
});

test('malformed duplicate-key scope evidence never crashes messages or becomes an identity', t => {
  const { db } = fixture(t), positive = makeRecipientEvidence(CHAT, SELF, { id_type: 'open_id', id: PEER }, NAME, AT);
  const config = `{"chat_id":${JSON.stringify(CHAT)},"chat_type":"p2p","p2p_recipient":null,"p2p_recipient":${JSON.stringify(positive)}}`;
  sqliteExec(db, recordSql() + scopeSql(config));
  assert.equal(loadMessages(db, opts)[0].display.recipient, '未知');
});

test('1001 exact account/chat pairs retain the existing messages limit contract without SQLite expression-depth failure', t => {
  const { db, dir } = fixture(t), statements = [];
  for (let i = 0; i < 1001; i++) {
    const chat = `${CHAT}_${i}`, account = i % 2 ? SELF : 'ou_synthetic_second_self';
    statements.push(recordSql({ id: `${ID}_${i}`, chat, actor: account }), evidenceSql({ chat, account }));
  }
  sqliteExec(db, `BEGIN;${statements.join('\n')}COMMIT;`);
  const result = spawnSync(process.execPath, ['bin/exocortex.mjs', 'messages', '--db', db, '--limit', '1001', '--format', 'json'],
    { encoding: 'utf8', env: { ...process.env, LARK_CLI: join(dir, 'absent-cli') }, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  assert.equal(rows.length, 1001);
  assert.ok(rows.every(row => row.display.scene === '私聊' && row.display.recipient === NAME));
});
