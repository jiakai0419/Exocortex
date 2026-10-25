import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureInitialized, quoteSql as q, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { plain } from '../dist/terminal/index.js';
import { patchTopLevelJsonMemberText } from '../dist/core/json-text-patch.js';
import { chatScopeId, SENT_SCOPE_ID } from '../src/adapters/lark-im/core.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { enrichRow, loadMessages, sqliteJson } from '../src/diagnostics/messages-report.mjs';
import { renderMessagesText } from '../src/terminal/messages-view.mjs';
import { displayP2pRecipient, makeRecipientEvidence, parseP2pTarget, recipientAccountKey, sentRecipientAccount }
  from '../src/adapters/lark-im/p2p-recipient.mjs';

// Entirely invented identities and text. No private database, screenshot or
// account is an input, and real API/network access is never part of these tests.
const SELF = 'ou_synthetic_recipient_self', PEER = 'ou_synthetic_recipient_peer';
const CHAT = 'oc_synthetic_recipient_chat', ID = 'om_synthetic_recipient_message';
const AT = '2025-02-03T04:05:06.000Z', NAME = '合成收件人';
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function sample() {
  const canonical = { message_id: ID, chat_id: CHAT, sender_id: SELF, sender_id_type: 'open_id',
    sender_name: '合成发送人', sender_type: 'user', msg_type: 'text' };
  const raw = { message_id: ID, chat_id: CHAT, create_time: String(Date.parse(AT)), msg_type: 'text',
    sender: { id: SELF, id_type: 'open_id', sender_type: 'user' }, body: { content: '{"text":"合成正文"}' } };
  const row = { source_id: 'lark.im', record_type: 'lark.im.message', external_id: ID,
    container_id: CHAT, actor_id: SELF, direction: 'sent', occurred_at: AT, occurred_at_ms: Date.parse(AT), body: '合成正文' };
  const evidence = makeRecipientEvidence(CHAT, SELF, { id_type: 'open_id', id: PEER }, NAME, AT);
  return { row, canonical, raw, config: { chat_id: CHAT, chat_type: 'p2p', p2p_recipient: evidence } };
}
const recipient = s => displayP2pRecipient(s.row, s.canonical, s.raw, s.config);
function projected(s) {
  return enrichRow({ ...s.row, canonical_json: JSON.stringify(s.canonical), raw_json: JSON.stringify(s.raw),
    scope_config_json: '{}' }, s.config, false);
}

test('a sent private recipient uses an exact persisted account/chat relationship without rewriting any message field', () => {
  const s = sample(), before = clone(s);
  assert.equal(recipient(s), NAME);
  assert.equal(sentRecipientAccount(s.row, s.canonical, s.raw), SELF);
  assert.equal(projected(s).display.recipient, NAME);
  assert.deepEqual(s, before);
});

for (const [label, change] of [
  ['missing evidence', s => delete s.config.p2p_recipient],
  ['chat title only', s => { delete s.config.p2p_recipient; s.canonical.chat_name = NAME; s.config.chat_name = NAME; }],
  ['complete-looking member list alone', s => { delete s.config.p2p_recipient; s.config.members = [{ open_id: SELF }, { open_id: PEER, name: NAME }]; }],
  ['conflicting member list alone', s => { delete s.config.p2p_recipient; s.config.members = [{ open_id: PEER }, { open_id: 'ou_synthetic_second_peer' }]; }],
  ['different account', s => s.config.p2p_recipient.account_key = recipientAccountKey('ou_synthetic_other_account')],
  ['different source', s => s.config.p2p_recipient.source_id = 'synthetic.other'],
  ['different row source', s => s.row.source_id = 'synthetic.other'],
  ['different chat evidence', s => s.config.p2p_recipient.chat_id = 'oc_synthetic_other_chat'],
  ['different scope chat', s => s.config.chat_id = 'oc_synthetic_other_chat'],
  ['different raw chat', s => s.raw.chat_id = 'oc_synthetic_other_chat'],
  ['different wrapper chat', s => { s.raw.raw_api = clone(s.raw); s.raw.chat_id = 'oc_synthetic_other_chat'; }],
  ['different wrapper sender', s => { s.raw.raw_api = clone(s.raw); s.raw.sender.id = 'ou_synthetic_other_actor'; }],
  ['different wrapper actor kind', s => { s.raw.raw_api = clone(s.raw); s.raw.sender.sender_type = 'app'; }],
  ['different wrapper sender alias', s => { s.raw.sender.user_id = 'synthetic_inner_user'; s.raw.raw_api = clone(s.raw); s.raw.sender.user_id = 'synthetic_outer_user'; }],
  ['different raw message', s => s.raw.message_id = 'om_synthetic_other_message'],
  ['different actor', s => s.row.actor_id = 'ou_synthetic_other_actor'],
  ['different canonical actor', s => s.canonical.sender_id = 'ou_synthetic_other_actor'],
  ['untyped sender', s => delete s.raw.sender.id_type],
  ['conflicting sender namespace', s => s.canonical.sender_id_type = 'user_id'],
  ['conflicting sender aliases', s => s.raw.sender.open_id = 'ou_synthetic_other_actor'],
  ['application actor', s => s.raw.sender.sender_type = 'app'],
  ['unknown direction', s => s.row.direction = 'unknown'],
  ['wrong identity authority', s => s.config.p2p_recipient.identity_source = 'chat_title'],
  ['future observation', s => s.config.p2p_recipient.observed_at = '2999-01-01T00:00:00.000Z'],
  ['invalid observation', s => s.config.p2p_recipient.observed_at = 'not-a-date'],
  ['pre-epoch observation', s => s.config.p2p_recipient.observed_at = '1969-12-31T23:59:59.000Z'],
  ['extended-year observation', s => s.config.p2p_recipient.observed_at = '-000001-01-01T00:00:00.000Z'],
  ['wrong recipient namespace', s => s.config.p2p_recipient.recipient.id_type = 'user_id'],
  ['recipient is a conversation ID', s => s.config.p2p_recipient.recipient.id = CHAT],
  ['contradictory explicit partner', s => s.canonical.chat_partner = { open_id: 'ou_synthetic_other_peer', name: NAME }],
]) {
  test(`recipient fails closed for ${label}`, () => { const s = sample(); change(s); assert.equal(recipient(s), '未知'); });
}

test('received private messages retain their existing recipient and group/topic messages never consume p2p evidence', () => {
  const s = sample(); s.row.direction = 'received';
  assert.equal(projected(s).display.recipient, '我');
  for (const chat_type of ['group', 'topic']) {
    s.row.direction = 'sent'; s.config.chat_type = chat_type;
    assert.equal(projected(s).display.recipient, null);
  }
});

test('missing names expose the actual typed person ID, ID echoes do not become names, and an explicit self target is valid', () => {
  const s = sample();
  for (const name of [null, PEER, SELF, CHAT]) {
    s.config.p2p_recipient = makeRecipientEvidence(CHAT, SELF, { id_type: 'open_id', id: PEER }, name, AT);
    assert.equal(recipient(s), `${PEER.slice(0, 8)}...`);
  }
  s.config.p2p_recipient = makeRecipientEvidence(CHAT, SELF, { id_type: 'open_id', id: SELF }, null, AT);
  assert.equal(recipient(s), '我', 'explicit API self target, not a one-member roster or a nickname');
});

test('existing message-bound typed partner names survive and clears cannot be replaced by the scope cache', () => {
  const s = sample();
  s.canonical.chat_partner = { open_id: PEER, name: '合成原姓名' };
  assert.equal(recipient(s), '合成原姓名');
  s.canonical.chat_partner.name_state = 'cleared';
  assert.equal(recipient(s), `${PEER.slice(0, 8)}...`);
  s.raw.chat_partner = { user_id: PEER, name: NAME };
  assert.equal(recipient(s), '未知', 'same bytes in a different namespace do not establish identity');
  delete s.config.p2p_recipient;
  s.canonical.chat_partner = { user_id: 'synthetic_user_id', name: NAME };
  s.raw.chat_partner = { user_id: 'synthetic_user_id', name: NAME };
  assert.equal(recipient(s), NAME);
  s.config.p2p_recipient = makeRecipientEvidence(CHAT, SELF, { id_type: 'open_id', id: PEER }, '合成新查询姓名', AT);
  assert.equal(recipient(s), NAME, 'an open-ID observation cannot overwrite an existing name in another namespace');
  s.canonical.chat_partner = { name: NAME };
  assert.equal(recipient(s), '未知', 'name alone is not a recipient');
});

test('a valid relationship conflict cannot resurrect an older explicit partner name', () => {
  const s = sample();
  s.canonical.chat_partner = { open_id: PEER, name: NAME };
  s.config.p2p_recipient.conflict = { schema: 'lark_p2p_recipient_conflict/v1',
    identity_source: 'im.v1.chats.batch_query', recipient: { id_type: 'open_id', id: 'ou_synthetic_conflicting_target' },
    observed_at: '2025-02-03T04:05:07.000Z' };
  assert.equal(recipient(s), '未知');
  s.canonical.chat_partner = { user_id: 'synthetic_namespace_person', name: '合成命名空间姓名' };
  assert.equal(recipient(s), '合成命名空间姓名', 'an unrelated open-ID conflict cannot erase a typed user-ID name');
  s.row.direction = 'received';
  assert.equal(recipient(s), '我');
});

test('stored legacy mistyped partner user_id keeps its trusted raw name without asserting an open-ID mapping', () => {
  const s = sample(); delete s.config.p2p_recipient;
  const input = { ...s.raw, id: ID, chat_type: 'p2p', chat_partner: { user_id: 'synthetic_tenant_person', name: NAME } };
  delete input.message_id;
  const stored = recordFromMessage(input, SENT_SCOPE_ID, 'sent');
  const canonical = JSON.parse(stored.canonical_json), raw = JSON.parse(stored.raw_json);
  // Preserve the historical fixture after the normalizer stops creating it.
  canonical.chat_partner = { open_id: input.chat_partner.user_id, name: NAME };
  assert.equal(canonical.chat_partner.open_id, 'synthetic_tenant_person', 'exercise the actual historical normalizer shape');
  assert.equal(displayP2pRecipient(stored, canonical, raw, s.config), NAME);
  assert.equal(sentRecipientAccount(stored, canonical, raw), SELF, 'legacy raw.id is an exact message identity');
  raw.id = 'om_synthetic_other_message';
  assert.equal(displayP2pRecipient(stored, canonical, raw, s.config), '未知');
  const collision = recordFromMessage({ ...input, chat_partner: { user_id: PEER, name: NAME } }, SENT_SCOPE_ID, 'sent');
  const collisionCanonical = JSON.parse(collision.canonical_json);
  collisionCanonical.chat_partner = { open_id: PEER, name: NAME };
  assert.equal(displayP2pRecipient(collision, collisionCanonical, JSON.parse(collision.raw_json), s.config), '未知');
});

test('batch response uses only an explicit unique p2p user target in the requested namespace', () => {
  const item = { chat_id: CHAT, chat_mode: 'p2p', p2p_target_type: 'user', p2p_target_id: PEER };
  assert.deepEqual(parseP2pTarget({ code: 0, data: { items: [item] } }, CHAT), { id_type: 'open_id', id: PEER });
  for (const response of [
    { code: 1, data: { items: [item] } }, { ok: false, items: [item] },
    { data: { items: [item, item] } }, { items: [{ ...item, chat_id: 'oc_synthetic_elsewhere' }] },
    { items: [{ ...item, chat_mode: 'group' }] }, { items: [{ ...item, chat_type: 'topic' }] },
    { items: [{ ...item, p2p_target_type: 'bot' }] }, { items: [{ ...item, p2p_target_id: CHAT }] },
    { items: [{ chat_id: CHAT, chat_mode: 'p2p', name: NAME }] },
    { items: [item], has_more: true }, { items: [item], page_token: 'synthetic_next' },
    { members: [{ member_id: SELF }, { member_id: PEER }] },
  ]) assert.equal(parseP2pTarget(response, CHAT), null);
});

for (const origin of ['sent', 'chat']) test(`real read-only messages restores evidence with ${origin}-first provenance, preserving four neighbours and every stored record`, t => {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-recipient-synthetic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite'); ensureInitialized(db);
  const s = sample(), scopeId = chatScopeId(CHAT), options = { direction: 'all', limit: 5, search: '' };
  const config = { chat_id: CHAT, chat_type: 'p2p', chat_name: '合成会话标题' };
  const configText = `{\n  "chat_id": ${JSON.stringify(CHAT)},\n  "chat_type": "p2p",\n  "chat_name": "合成会话标题",\n  "opaque": 9007199254740993\n}\n`;
  sqliteExec(db, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(scopeId)},'lark.im','synthetic recipient scope',${q(configText)});`);
  for (let index = 0; index < 5; index++) {
    const id = index ? `${ID}_${index}` : ID, chat = index > 1 ? `${CHAT}_${index}` : CHAT;
    const actor = index === 1 ? PEER : SELF, direction = index === 1 ? 'received' : 'sent';
    const ca = { ...s.canonical, sender_id: actor, message_id: id, chat_id: chat, ...(index > 1 ? { chat_type: 'group' } : {}) };
    const raw = { ...s.raw, sender: { ...s.raw.sender, id: actor }, message_id: id, chat_id: chat };
    const body = `合成正文 ${index}。`;
    sqliteExec(db, `INSERT INTO records(source_id,first_seen_scope_id,external_id,record_type,occurred_at,occurred_at_ms,actor_id,container_id,direction,body,content_hash,canonical_json,raw_json)
      VALUES('lark.im',${q(origin === 'chat' && index < 2 ? scopeId : SENT_SCOPE_ID)},${q(id)},'lark.im.message',${q(AT)},${Date.parse(AT) - index},${q(actor)},${q(chat)},${q(direction)},${q(body)},${q(hash(body))},${q(JSON.stringify(ca))},${q(JSON.stringify(raw))});`);
  }
  const records = sqliteJson(db, 'SELECT * FROM records ORDER BY id;', 'synthetic originals');
  const baseline = loadMessages(db, options);
  assert.equal(baseline[0].display.recipient, '未知');
  function setEvidence(value) {
    sqliteExec(db, `UPDATE sync_scopes SET config_json=${q(patchTopLevelJsonMemberText(configText, 'p2p_recipient', value ? JSON.stringify(value) : undefined))} WHERE id=${q(scopeId)};`);
    sqliteExec(db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  }
  setEvidence(s.config.p2p_recipient);
  const bytesBefore = hash(readFileSync(db));
  const after = loadMessages(db, options);
  const expected = clone(baseline); expected[0].display.recipient = NAME;
  assert.deepEqual(after, expected, 'the target changes only display.recipient; four neighbour JSON rows stay exact');
  assert.equal(plain(renderMessagesText(after)), plain(renderMessagesText(baseline)).replace('接收人  未知', `接收人  ${NAME}`));
  const result = spawnSync(process.execPath, ['bin/exocortex.mjs', 'messages', '--db', db, '--limit', '5', '--format', 'json'],
    { encoding: 'utf8', env: { ...process.env, LARK_CLI: join(dir, 'does-not-exist') }, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), after);
  assert.equal(hash(readFileSync(db)), bytesBefore, 'public reads do not mutate any database byte');
  assert.deepEqual(sqliteJson(db, 'SELECT * FROM records ORDER BY id;', 'synthetic originals'), records);
  setEvidence(null); assert.deepEqual(loadMessages(db, options), baseline);
  setEvidence(s.config.p2p_recipient); assert.deepEqual(loadMessages(db, options), after);
});
