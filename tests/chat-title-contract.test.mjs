import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ensureInitialized, quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { plain } from '../dist/terminal/index.js';
import { chatScopeId, SENT_SCOPE_ID } from '../src/adapters/lark-im/core.mjs';
import { chatTitle, displayChatTitle } from '../src/adapters/lark-im/chat-title.mjs';
import { loadMessages, sqliteJson } from '../src/diagnostics/messages-report.mjs';
import { textWidth } from '../src/terminal/text-layout.mjs';

// Every ID, name, timestamp and message below is newly invented. No production
// data, authenticated API, external files or production coordination directory.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AT = Date.UTC(2063, 3, 5, 6, 7, 8);
const ACTOR = 'ou_synthetic_title_author';
const AUTHOR = 'Synthetic Author';
const TITLE = 'Synthetic Current Room';
const OLD = 'Synthetic Adopted Room';
const FIRST_CONFIG = '{\n  "mode": "sent_by_me", "opaque": 9007199254740993\n}';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sqlValue = value => value == null ? 'NULL' : typeof value === 'number' ? String(value) : quoteSql(value);
const selectedFields = ['id', 'source_id', 'direction', 'record_type', 'occurred_at', 'occurred_at_ms', 'actor_id',
  'container_id', 'external_id', 'body', 'canonical_json', 'raw_json'];
const readyGroup = { version: 1, state: 'ready', requirements: [
  { field: 'sender', state: 'satisfied', reason: null, evidence: 'message_sender' },
  { field: 'recipient', state: 'not_applicable', reason: null, evidence: 'chat_destination' },
  { field: 'conversation', state: 'satisfied', reason: null, evidence: 'scope_config' },
  { field: 'content', state: 'satisfied', reason: null, evidence: 'content_projection' },
], reasons: [], next_action: 'none' };

function fixture(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-title-contract-synthetic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite'), marker = join(dir, 'unexpected-network');
  const cli = join(dir, 'reject-lark'), guard = join(dir, 'reject-network.mjs');
  writeFileSync(cli, '#!/bin/sh\nprintf called > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
  writeFileSync(guard, `import { writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
const reject = () => { writeFileSync(process.env.SYNTHETIC_NETWORK_MARKER, 'called'); throw new Error('unexpected synthetic network'); };
globalThis.fetch = reject;
Socket.prototype.connect = reject;
Object.defineProperty(process.stdout, 'columns', { value: Number(process.env.SYNTHETIC_COLUMNS), configurable: true });
`);
  ensureInitialized(db);
  const statements = [`UPDATE sync_scopes SET config_json=${quoteSql(FIRST_CONFIG)} WHERE id=${quoteSql(SENT_SCOPE_ID)};`,
    "INSERT INTO sources(id,kind,display_name) VALUES('synthetic.foreign','synthetic','Synthetic foreign source');"];
  const scopeTexts = new Map([[SENT_SCOPE_ID, FIRST_CONFIG]]);
  function scope(id, config, source = 'lark.im', transform) {
    if (scopeTexts.has(id)) return;
    const text = transform ? transform(JSON.stringify(config)) : JSON.stringify(config);
    scopeTexts.set(id, text);
    statements.push(`INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${quoteSql(id)},${quoteSql(source)},${quoteSql(id)},${quoteSql(text)});`);
  }
  const records = entries.map((entry, index) => {
    const chat = `oc_synthetic_title_${entry.chatKey ?? entry.key}`, external = `om_synthetic_title_${entry.key}`;
    const time = AT + (entry.offset ?? index) * 1000;
    const body = entry.body ?? `Synthetic body ${entry.key}.`;
    const canonical = { message_id: external, chat_id: chat, chat_type: 'group', chat_name: null,
      msg_type: 'text', sender_id: ACTOR, sender_name: AUTHOR, sender_type: 'user', ...entry.canonical };
    const native = { message_id: external, chat_id: chat, chat_type: 'group', msg_type: 'text', create_time: String(time),
      sender: { id: ACTOR, id_type: 'open_id', sender_type: 'user', name: AUTHOR },
      body: { content: JSON.stringify({ text: body }) }, ...entry.raw };
    const raw = entry.native ? { message_id: external, chat_id: chat, msg_type: 'text', raw_api: { ...native, ...entry.native } } : native;
    const current = entry.scope === null ? null : { chat_id: chat, chat_type: 'group', chat_name: TITLE, ...entry.scope };
    if (current) scope(entry.scopeId ?? chatScopeId(chat), current, entry.scopeSource, entry.scopeText);
    let first = entry.firstSeen === 'chat' ? entry.scopeId ?? chatScopeId(chat) : SENT_SCOPE_ID;
    if (entry.firstConfig) {
      first = `synthetic.first.${entry.key}`;
      scope(first, { chat_id: chat, ...entry.firstConfig }, entry.firstSource, entry.firstText);
    }
    const canonicalText = entry.canonicalText ? entry.canonicalText(JSON.stringify(canonical)) : JSON.stringify(canonical);
    const rawText = entry.rawText ? entry.rawText(JSON.stringify(raw)) : JSON.stringify(raw);
    const stored = { id: index + 1, source_id: 'lark.im', first_seen_scope_id: first, external_id: external,
      external_version: 'synthetic-v1', record_type: 'lark.im.message', occurred_at: new Date(time).toISOString(),
      occurred_at_ms: time, actor_id: ACTOR, container_id: chat, direction: entry.direction ?? 'sent', body,
      content_hash: hash(body), canonical_json: canonicalText, raw_json: rawText };
    statements.push(`INSERT INTO records(${Object.keys(stored).join(',')}) VALUES(${Object.values(stored).map(sqlValue).join(',')});`);
    return { ...stored, key: entry.key, scope_config_json: scopeTexts.get(first) };
  });
  sqliteExec(db, statements.join('\n') + '\nPRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  const before = hash(readFileSync(db)), files = readdirSync(dir).sort();
  function unchanged() {
    assert.equal(hash(readFileSync(db)), before, 'messages must not modify the synthetic database or migrate it');
    assert.equal(existsSync(marker), false, 'messages must not call Lark, fetch or a network socket');
    assert.deepEqual(readdirSync(dir).sort(), files, 'reading must not create sidecars or other files');
  }
  function run({ format = 'json', columns = 100, color = false, args = [] } = {}) {
    const env = { ...process.env, TZ: 'UTC', LARK_CLI: cli, SYNTHETIC_NETWORK_MARKER: marker, SYNTHETIC_COLUMNS: String(columns) };
    delete env.NO_COLOR; delete env.FORCE_COLOR;
    env[color ? 'FORCE_COLOR' : 'NO_COLOR'] = '1';
    const result = spawnSync(process.execPath, ['--import', guard, join(ROOT, 'bin/exocortex.mjs'), 'messages',
      '--db', db, '--format', format, ...(args.includes('--limit') ? [] : ['--limit', '100']), ...args], {
      cwd: dir, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 5 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, ''); unchanged();
    return format === 'json' ? JSON.parse(result.stdout) : result.stdout;
  }
  return { db, records, run, unchanged };
}

function row(f, key, rows = f.run()) { return rows.find(value => value.external_id === `om_synthetic_title_${key}`); }
function assertTitles(f, expected) {
  const rows = f.run();
  assert.equal(rows.length, f.records.length);
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, row(f, key, rows).display.chat])), expected);
  return rows;
}
const shortChat = 'oc_synth...';

test('title values admit numeric strings and Unicode while rejecting malformed values and identity echoes', () => {
  for (const title of ['123456', '００１', '合成群・β', ' Synthetic Room ']) assert.equal(chatTitle(title, 'oc_synthetic_room'), title);
  for (const title of [null, undefined, '', '   ', 123456, {}, [], true, 'oc_synthetic_room', 'oc_synthetic_room ', 'line\nbreak', 'null\0byte']) {
    assert.equal(chatTitle(title, 'oc_synthetic_room'), '', String(title));
  }
});

test('exact current scopes fill sent-first titles and numeric strings without replacing adopted names', t => {
  const f = fixture(t, [
    { key: 'missing' }, { key: 'numeric', scope: { chat_name: '123456' } },
    { key: 'known', canonical: { chat_name: OLD } },
    { key: 'known_bad_raw', canonical: { chat_name: OLD }, raw: { id: 'om_synthetic_unrelated' } },
    { key: 'known_bad_scope', canonical: { chat_name: OLD }, scope: { chat_id: 'oc_synthetic_unrelated' } },
    { key: 'known_foreign_scope', canonical: { chat_name: OLD }, scopeSource: 'synthetic.foreign' },
    { key: 'known_duplicate_scope', canonical: { chat_name: OLD }, scopeText: text => text.replace('"chat_name":', '"chat_name":"Ambiguous old value","chat_name":') },
  ]);
  assertTitles(f, { missing: TITLE, numeric: '123456', known: OLD, known_bad_raw: OLD,
    known_bad_scope: OLD, known_foreign_scope: OLD, known_duplicate_scope: OLD });
});

test('foreign, illegal or mismatched scope identity cannot lend a title', t => {
  const f = fixture(t, [
    { key: 'foreign_current', scopeSource: 'synthetic.foreign' },
    { key: 'wrong_current', scope: { chat_id: 'oc_synthetic_unrelated' } },
    { key: 'illegal_scope_id', scopeId: 'synthetic.not-a-chat-scope' },
    { key: 'foreign_first', scope: null, firstConfig: { chat_type: 'group', chat_name: 'Synthetic foreign title' }, firstSource: 'synthetic.foreign' },
    { key: 'illegal_first', scope: null, firstConfig: { chat_type: 'group', chat_name: 'Synthetic illegal title' } },
  ]);
  assertTitles(f, Object.fromEntries(f.records.map(value => [value.key, shortChat])));
});

test('all explicit message and nested chat identities must agree before scope title fallback', t => {
  const f = fixture(t, [
    { key: 'canonical_message', canonical: { message_id: 'om_synthetic_wrong' } },
    { key: 'canonical_chat', canonical: { chat_id: 'oc_synthetic_wrong' } },
    { key: 'raw_message', raw: { message_id: 'om_synthetic_wrong' } },
    { key: 'raw_id', raw: { id: 'om_synthetic_wrong' } },
    { key: 'raw_chat', raw: { chat_id: 'oc_synthetic_wrong' } },
    { key: 'nested_chat', raw: { chat: { id: 'oc_synthetic_wrong' } } },
    { key: 'native_message', native: { message_id: 'om_synthetic_wrong' } },
    { key: 'native_chat', native: { chat: { chat_id: 'oc_synthetic_wrong' } } },
    { key: 'numeric_chat', canonical: { chat_id: 123 } },
  ]);
  assertTitles(f, Object.fromEntries(f.records.map(value => [value.key, value.key === 'canonical_chat' ? 'oc_synth...' : value.key === 'numeric_chat' ? '123...' : shortChat])));
  const stored = f.records[0];
  assert.equal(displayChatTitle({ ...stored, source_id: 'synthetic.foreign' }, { chat_id: stored.container_id },
    { message_id: stored.external_id, chat_id: stored.container_id }, {}, { chat_id: stored.container_id, chat_name: TITLE }, false), '');
});

test('valid explicit clear blocks old scope titles in canonical, raw and native records', t => {
  const f = fixture(t, [
    { key: 'canonical_clear', canonical: { chat_name_state: 'cleared' } },
    { key: 'raw_clear', raw: { chat_name_state: 'cleared' } },
    { key: 'native_clear', native: { chat_name_state: 'cleared' } },
    { key: 'scope_clear', scope: { chat_name_state: 'cleared' }, firstSeen: 'chat' },
  ]);
  assertTitles(f, Object.fromEntries(f.records.map(value => [value.key, shortChat])));
});

test('duplicate message JSON cannot authorize a new title fallback', t => {
  const duplicate = text => text.replace('"chat_id":', '"chat_id":"oc_synthetic_conflict","chat_id":');
  const f = fixture(t, [
    { key: 'canonical_duplicate', canonicalText: duplicate },
    { key: 'raw_duplicate', rawText: duplicate },
    { key: 'current_duplicate', scopeText: duplicate },
  ]);
  assertTitles(f, Object.fromEntries(f.records.map(value => [value.key, shortChat])));
});

test('duplicate first-seen scope JSON cannot resurrect a rejected exact-scope title', t => {
  const f = fixture(t, [{ key: 'first_duplicate', firstSeen: 'chat',
    scopeText: text => text.replace('"chat_name":', '"chat_name":"Synthetic conflicting title","chat_name":') }]);
  assertTitles(f, { first_duplicate: shortChat });
});

test('new raw and native titles require exact message/chat identity', t => {
  const f = fixture(t, [
    { key: 'valid_raw', raw: { chat_name: 'Synthetic Raw Room' } },
    { key: 'valid_native', native: { chat_name: 'Synthetic Native Room' } },
    { key: 'wrong_raw_title', raw: { chat_id: 'oc_synthetic_unrelated', chat_name: 'Synthetic Wrong Room' } },
    { key: 'wrong_native_title', native: { message_id: 'om_synthetic_unrelated', chat_name: 'Synthetic Wrong Room' } },
    { key: 'duplicate_raw_title', raw: { chat_name: 'Synthetic Wrong Room' }, rawText: text => text.replace('"chat_id":', '"chat_id":"oc_synthetic_unrelated","chat_id":') },
  ]);
  assertTitles(f, { valid_raw: 'Synthetic Raw Room', valid_native: 'Synthetic Native Room',
    wrong_raw_title: shortChat, wrong_native_title: shortChat, duplicate_raw_title: shortChat });
});

test('conflicting raw clear does not erase an independently adopted canonical title', t => {
  const f = fixture(t, [
    { key: 'foreign_clear', canonical: { chat_name: OLD }, raw: { chat_id: 'oc_synthetic_unrelated', chat_name_state: 'cleared' } },
    { key: 'foreign_native_clear', canonical: { chat_name: OLD }, native: { message_id: 'om_synthetic_unrelated', chat_name_state: 'cleared' } },
    { key: 'duplicate_clear', canonical: { chat_name: OLD }, raw: { chat_name_state: 'cleared' },
      rawText: text => text.replace('"chat_id":', '"chat_id":"oc_synthetic_unrelated","chat_id":') },
  ]);
  assertTitles(f, { foreign_clear: OLD, foreign_native_clear: OLD, duplicate_clear: OLD });
});

test('p2p/group contradictions reject borrowed titles and visibility is not a conversation mode', t => {
  const f = fixture(t, [
    { key: 'group_vs_p2p', scope: { chat_type: 'p2p' } },
    { key: 'p2p_vs_group', canonical: { chat_type: 'p2p' }, raw: { chat_type: 'p2p' } },
    { key: 'p2p', canonical: { chat_type: 'p2p' }, raw: { chat_type: 'p2p' }, scope: { chat_type: 'p2p' }, direction: 'received' },
    { key: 'private_group', scope: { chat_type: 'private', chat_mode: 'group' } },
    { key: 'public_topic', canonical: { chat_type: null }, raw: { chat_type: null }, scope: { chat_type: 'public', chat_mode: 'topic' } },
  ]);
  const rows = assertTitles(f, { group_vs_p2p: shortChat, p2p_vs_group: shortChat, p2p: null, private_group: TITLE, public_topic: TITLE });
  assert.equal(row(f, 'group_vs_p2p', rows).display.scene, '会话类型未知');
  assert.equal(row(f, 'p2p_vs_group', rows).display.scene, '会话类型未知');
  assert.equal(row(f, 'p2p', rows).display.recipient, '我');
  assert.equal(row(f, 'private_group', rows).display.scene, '群聊');
  assert.equal(row(f, 'public_topic', rows).display.scene, '话题群');
});

test('real offline JSON and terminal contracts preserve all fields, ordering, limits and only fill chat title', t => {
  const f = fixture(t, [
    { key: 'a', chatKey: 'shared', offset: 0, body: 'Synthetic body a.' },
    { key: 'b', chatKey: 'shared', offset: 0, body: 'Synthetic body b.', direction: 'received' },
    { key: 'c', offset: 1, body: 'Synthetic body c.' },
  ]);
  const rows = f.run();
  const expected = [...f.records].sort((a, b) => b.occurred_at_ms - a.occurred_at_ms || b.external_id.localeCompare(a.external_id));
  assert.deepEqual(rows, expected.map(stored => ({
    ...Object.fromEntries(selectedFields.map(field => [field, stored[field]])),
    scope_config_json: FIRST_CONFIG, canonical: JSON.parse(stored.canonical_json), raw: JSON.parse(stored.raw_json),
    scope_config: JSON.parse(FIRST_CONFIG), display: { external_id: 'om_synth...', scene: '群聊', sender: AUTHOR,
      sender_type: 'user', message_type: '文本', recipient: null, chat: TITLE, body: stored.body },
    readiness: readyGroup,
  })), 'public first-seen JSON text and all stored/display fields retain their complete contract');
  const expectedText = `Messages (3)\n\n${expected.map(stored => `${stored.direction.toUpperCase()} ${new Date(stored.occurred_at).toLocaleString('en-US', { timeZone: 'UTC' })}  om_synth...  群聊\n  发送人  ${AUTHOR}\n  群      ${TITLE}\n  类型    user / 文本\n  消息    ${stored.body}\n`).join('\n')}`;
  assert.equal(f.run({ format: 'text' }), expectedText);
  assert.equal(plain(f.run({ format: 'text', color: true })), expectedText);
  for (const columns of [20, 38]) {
    const text = f.run({ format: 'text', columns });
    assert(text.split('\n').every(line => textWidth(line) <= columns));
    assert.equal(plain(f.run({ format: 'text', columns, color: true })), text);
  }
  assert.deepEqual(f.run({ args: ['--limit', '1'] }).map(value => value.external_id), [expected[0].external_id]);
  assert.deepEqual(f.run({ args: ['--direction', 'received'] }).map(value => value.external_id), ['om_synthetic_title_b']);
  assert.deepEqual(f.run({ args: ['--search', 'body a'] }).map(value => value.external_id), ['om_synthetic_title_a']);
  const calls = [];
  assert.deepEqual(loadMessages(f.db, { direction: 'all', limit: 100, search: '' }, { sqliteJson: (db, sql, label) => {
    const result = sqliteJson(db, sql, label); calls.push({ sql, label, result }); return result;
  } }), rows);
  assert.deepEqual(calls.map(call => call.label), ['read message snapshot schema', 'read message snapshot'],
    'a schema-only preflight is followed by one consistent page/evidence read');
  assert.match(calls[0].sql, /FROM sqlite_schema/);
  assert.doesNotMatch(calls[0].sql, /FROM records|FROM sync_scopes/);
  const scopes = calls[1].result.filter(row=>row.kind==='scope').map(row=>JSON.parse(row.payload));
  assert.deepEqual(scopes.map(scope => scope.id).sort(), [...new Set(f.records.map(record => chatScopeId(record.container_id)))].sort(),
    'the same snapshot contains two distinct page chat scopes, without repeated same-chat reads');
  const limitedCalls = [];
  assert.deepEqual(loadMessages(f.db, { direction: 'all', limit: 1, search: '' }, { sqliteJson: (db, sql, label) => {
    const result = sqliteJson(db, sql, label); limitedCalls.push({ label, result }); return result;
  } }), [rows[0]]);
  assert.deepEqual(limitedCalls.map(call => call.label), ['read message snapshot schema', 'read message snapshot']);
  assert.deepEqual(limitedCalls[1].result.filter(row=>row.kind==='scope').map(row=>JSON.parse(row.payload).id), [chatScopeId(expected[0].container_id)],
    'the limit-one snapshot excludes the other chat still present in this database');
  f.unchanged();
});

test('sent-first title fallback leaves historical system and card content untouched', t => {
  const systemContent = { template: '{name} joined {group_name}. New members can view all chat history.', name: 'Synthetic Visitor' };
  const cardContent = { elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Synthetic card body' } }] };
  const f = fixture(t, [
    { key: 'system', body: 'Synthetic Visitor joined [未知参数：group_name]. New members can view all chat history.',
      canonical: { msg_type: 'system', source_api: 'im.v1.messages' },
      raw: { msg_type: 'system', body: { content: JSON.stringify(systemContent) } } },
    { key: 'card', body: 'Synthetic stored card projection', canonical: { msg_type: 'interactive' },
      raw: { msg_type: 'interactive', body: { content: JSON.stringify(cardContent) } } },
  ]);
  const rows = assertTitles(f, { system: TITLE, card: TITLE });
  for (const stored of f.records) {
    const got = row(f, stored.key, rows);
    for (const field of ['raw_json', 'canonical_json', 'body', 'occurred_at', 'occurred_at_ms']) assert.equal(got[field], stored[field]);
    assert.equal(got.display.body, stored.body);
    assert.equal(got.display.sender, AUTHOR);
    assert.equal(got.scope_config_json, FIRST_CONFIG);
  }
  const system = row(f, 'system', rows);
  assert.deepEqual(system.display.system.missing_parameters, ['group_name']);
  assert.equal(system.display.system.current_group_context, null);
  assert.equal(system.display.body.includes(TITLE), false);
  assert.match(system.display.body, /\[未知参数：group_name\]/, 'JSON retains the exact historical missing-parameter projection');
  const partialSystem = structuredClone(readyGroup);
  partialSystem.state = 'enriching'; partialSystem.reasons = ['content_partial']; partialSystem.next_action = 'resolve_content';
  partialSystem.requirements[3] = { field: 'content', state: 'missing', reason: 'content_partial', evidence: null };
  assert.deepEqual(system.readiness, partialSystem, 'a current title does not complete missing historical system parameters');
  const card = row(f, 'card', rows);
  assert.equal(card.display.card.text, 'Synthetic card body');
  assert.deepEqual(card.readiness, readyGroup);
  const text = f.run({ format: 'text' });
  assert.match(text, /Synthetic card body/);
  const header = message => `SENT ${new Date(message.occurred_at).toLocaleString('en-US', { timeZone: 'UTC' })}  om_synth...  群聊`;
  assert.equal(text, `Messages (2)\n完整 1 · 待补全 1 · 受阻 0\n\n${header(card)}\n  发送人  ${AUTHOR}\n  群      ${TITLE}\n  类型    user / 卡片\n  消息\n    Synthetic card body\n\n${header(system)}\n  状态    等待完整信息\n  原因    消息内容未完整解析\n  查看    messages --format json 可检查已保存内容与原因\n`,
    'the complete card keeps its exact layout while the partial historical message keeps its selected position and event time');
  assert.doesNotMatch(text, /\[未知参数：group_name\]/, 'the partial system projection remains inspectable in JSON rather than an ordinary complete text row');
  assert.doesNotMatch(text, /当前本地标题来源/);
  assert.deepEqual(f.run(), rows, 'exception rendering never rewrites the raw, stored body or JSON projection');
});
