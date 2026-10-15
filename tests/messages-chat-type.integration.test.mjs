import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ensureInitialized, quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { plain } from '../dist/terminal/index.js';
import { chatScopeId, SENT_SCOPE_ID } from '../src/adapters/lark-im/core.mjs';
import { loadMessages, sqliteJson } from '../src/diagnostics/messages-report.mjs';
import { renderMessagesText } from '../src/terminal/messages-view.mjs';
import { textWidth } from '../src/terminal/text-layout.mjs';

// Entirely fictional inputs, including names, messages, IDs and dates. These
// fixtures never use screenshots, production rows or an authenticated account.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AT = Date.UTC(2061, 2, 4, 5, 6, 7);
const ACTOR = 'ou_synthetic_type_sender';
const SENDER = '合成寄件人';
const NAME = '合成会话名';
const SENT_CONFIG = { mode: 'sent_by_me', synthetic_marker: 'keep-first-seen-config' };
const hash = value => createHash('sha256').update(value).digest('hex');
const sqlValue = value => value == null ? 'NULL' : typeof value === 'number' ? String(value) : quoteSql(value);
const selectedFields = ['id', 'direction', 'record_type', 'occurred_at', 'occurred_at_ms', 'actor_id',
  'container_id', 'external_id', 'body', 'canonical_json', 'raw_json'];

function fixture(t, inputs) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-chat-type-synthetic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite');
  const marker = join(dir, 'unexpected-network');
  const cli = join(dir, 'reject-network-cli');
  const guard = join(dir, 'reject-network.mjs');
  writeFileSync(cli, '#!/bin/sh\nprintf called > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
  writeFileSync(guard, `import { writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
const reject = () => { writeFileSync(process.env.SYNTHETIC_NETWORK_MARKER, 'called'); throw new Error('unexpected synthetic network access'); };
globalThis.fetch = reject;
Socket.prototype.connect = reject;
Object.defineProperty(process.stdout, 'columns', { value: Number(process.env.SYNTHETIC_COLUMNS), configurable: true });
`);
  ensureInitialized(db);
  sqliteExec(db, `UPDATE sync_scopes SET config_json=${quoteSql(JSON.stringify(SENT_CONFIG))} WHERE id=${quoteSql(SENT_SCOPE_ID)};
    INSERT INTO sources(id,kind,display_name) VALUES('synthetic.other','synthetic','Synthetic other source');`);
  const scopes = new Map([[SENT_SCOPE_ID, SENT_CONFIG]]);
  function addScope(id, config, source = 'lark.im') {
    assert.equal(scopes.has(id), false, 'synthetic scope IDs must be unique');
    scopes.set(id, config);
    sqliteExec(db, `INSERT INTO sync_scopes(id,source_id,name,config_json)
      VALUES(${quoteSql(id)},${quoteSql(source)},${quoteSql(id)},${quoteSql(JSON.stringify(config))});`);
  }
  const records = inputs.map((entry, index) => {
    const chat = `oc_synthetic_type_${entry.key}`;
    const id = `om_synthetic_type_${entry.key}`;
    const body = entry.body ?? `合成正文 ${entry.key}。`;
    const at = AT + (entry.offset ?? index) * 1000;
    const canonical = { chat_id: chat, msg_type: 'text', sender_id: ACTOR,
      sender_name: SENDER, sender_type: 'user', chat_name: NAME, ...entry.canonical };
    const raw = { message_id: id, chat_id: chat, msg_type: 'text', create_time: String(at),
      sender: { id: ACTOR, id_type: 'open_id', sender_type: 'user', name: SENDER },
      body: { content: JSON.stringify({ text: body }) }, ...entry.raw };
    if (entry.scope) addScope(entry.scopeId ?? chatScopeId(chat), { chat_id: chat, ...entry.scope }, entry.scopeSource);
    for (const extra of entry.extraScopes ?? []) {
      addScope(extra.id ?? `${chatScopeId(chat)}.synthetic-duplicate`, { chat_id: chat, ...extra.config }, extra.source);
    }
    let first = SENT_SCOPE_ID;
    if (entry.firstSeen === 'chat') first = entry.scopeId ?? chatScopeId(chat);
    if (entry.firstConfig) {
      first = `synthetic.origin.${entry.key}`;
      addScope(first, entry.firstConfig, entry.firstSource);
    }
    const stored = { source_id: 'lark.im', first_seen_scope_id: first, external_id: id,
      external_version: 'synthetic-version-1', record_type: 'lark.im.message',
      occurred_at: new Date(at).toISOString(), occurred_at_ms: at, actor_id: ACTOR,
      container_id: chat, direction: entry.direction ?? 'sent', body, content_hash: hash(body),
      canonical_json: JSON.stringify(canonical), raw_json: JSON.stringify(raw) };
    const fields = Object.keys(stored);
    sqliteExec(db, `INSERT INTO records(${fields.join(',')}) VALUES(${fields.map(field => sqlValue(stored[field])).join(',')});`);
    return { ...stored, id: index + 1, scope_config_json: JSON.stringify(scopes.get(first)), key: entry.key };
  });
  sqliteExec(db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  const before = hash(readFileSync(db));
  const unchanged = () => {
    assert.equal(hash(readFileSync(db)), before, 'messages reads must preserve the entire database byte for byte');
    assert.equal(existsSync(marker), false, 'messages must not call Lark, fetch or a network socket');
  };
  const options = { db, direction: 'all', limit: 100, search: '' };
  const direct = loadMessages(db, options);
  unchanged();
  function run(format = 'json', columns = 80, args = []) {
    const env = { ...process.env, NO_COLOR: '1', TZ: 'UTC', LARK_CLI: cli,
      SYNTHETIC_NETWORK_MARKER: marker, SYNTHETIC_COLUMNS: String(columns) };
    delete env.FORCE_COLOR;
    const result = spawnSync(process.execPath, ['--import', guard, join(ROOT, 'bin/exocortex.mjs'),
      'messages', '--db', db, '--format', format, ...(args.includes('--limit') ? [] : ['--limit', '100']), ...args], {
      cwd: dir, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 5 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    unchanged();
    return format === 'json' ? JSON.parse(result.stdout) : plain(result.stdout);
  }
  return { db, records, direct, run, unchanged };
}

function displayFor(stored, { scene = '群聊', recipient = null, chat = NAME } = {}) {
  return { external_id: 'om_synth...', scene, sender: SENDER, sender_type: 'user',
    message_type: '文本', recipient, chat, body: stored.body };
}

function publicRow(stored, display) {
  return { ...Object.fromEntries(selectedFields.map(field => [field, stored[field]])),
    scope_config_json: stored.scope_config_json,
    canonical: JSON.parse(stored.canonical_json), raw: JSON.parse(stored.raw_json),
    scope_config: JSON.parse(stored.scope_config_json), display };
}

function assertRows(f, expected) {
  const json = f.run();
  const rows = [...f.records].sort((a, b) => b.occurred_at_ms - a.occurred_at_ms || b.external_id.localeCompare(a.external_id));
  assert.deepEqual(json, rows.map(stored => publicRow(stored, displayFor(stored, expected[stored.key]))),
    'JSON retains all original fields and their values, ordering and first-seen config, with no public metadata additions');
  assert.deepEqual(json, f.direct, 'real CLI JSON equals the real loadMessages projection');
  return json;
}

function screen(rows) {
  return `Messages (${rows.length})\n\n${rows.map(row => {
    const time = new Date(row.occurred_at).toLocaleString(undefined, { timeZone: 'UTC' });
    const d = row.display;
    return `${row.direction.toUpperCase()} ${time}  ${d.external_id}  ${d.scene}\n`
      + `  发送人  ${d.sender}\n`
      + (d.recipient ? `  接收人  ${d.recipient}\n` : '')
      + (d.chat ? `${d.scene === '会话类型未知' ? '  会话    ' : '  群      '}${d.chat}\n` : '')
      + `  类型    user / 文本\n  消息    ${d.body}\n`;
  }).join('\n')}`;
}

test('real offline messages retains the complete JSON and screen for existing p2p, group and topic messages', t => {
  const f = fixture(t, [
    { key: 'p2p_sent', firstSeen: 'chat', scope: { chat_type: 'p2p' },
      canonical: { chat_type: 'p2p', chat_partner: { open_id: 'ou_synthetic_peer', name: '合成同伴' } } },
    { key: 'p2p_received', direction: 'received', firstSeen: 'chat', scope: { chat_type: 'p2p' }, canonical: { chat_type: 'p2p' } },
    { key: 'group', firstSeen: 'chat', scope: { chat_type: 'group' }, canonical: { chat_type: 'group' } },
    { key: 'topic', firstSeen: 'chat', scope: { chat_type: 'topic' }, canonical: { chat_type: 'topic' } },
    { key: 'group_with_topic_scope', scope: { chat_type: 'topic' }, canonical: { chat_type: 'group' } },
  ]);
  const json = assertRows(f, {
    p2p_sent: { scene: '私聊', recipient: '合成同伴', chat: null },
    p2p_received: { scene: '私聊', recipient: '我', chat: null },
    group: {}, topic: { scene: '话题群' }, group_with_topic_scope: {},
  });
  assert.equal(f.run('text'), screen(json), 'every line, field, blank line and existing group/topic label stays unchanged');
  assert.deepEqual(f.run(), json, 'text rendering does not mutate the following JSON read');
});

test('sent-first messages use only an exact legal same-source conversation scope, preserving names and history', t => {
  const f = fixture(t, [
    { key: 'sent_p2p', scope: { chat_type: 'p2p', chat_name: '不得采用的新名称' }, body: '合成原文  保留空格。' },
    { key: 'sent_p2p_id', scope: { chat_type: 'p2p', chat_name: '不得引入的名称' }, canonical: { chat_name: null } },
    { key: 'sent_group', scope: { chat_type: 'group' } },
    { key: 'legal_with_duplicate', scope: { chat_type: 'p2p' }, extraScopes: [{ config: { chat_type: 'group' } }] },
    { key: 'other_source', scope: { chat_type: 'p2p' }, scopeSource: 'synthetic.other' },
    { key: 'invalid_scope_id', scope: { chat_type: 'p2p' }, scopeId: 'synthetic.not-a-chat-scope' },
    { key: 'wrong_scope_chat', scope: { chat_id: 'oc_synthetic_unrelated', chat_type: 'p2p' } },
    { key: 'wrong_first_chat', firstConfig: { chat_id: 'oc_synthetic_unrelated_first', chat_type: 'p2p' } },
    { key: 'cross_first', firstConfig: { chat_id: 'oc_synthetic_type_cross_first', chat_type: 'p2p' }, firstSource: 'synthetic.other' },
  ]);
  const json = assertRows(f, {
    sent_p2p: { scene: '私聊', recipient: NAME, chat: null },
    sent_p2p_id: { scene: '私聊', recipient: 'oc_synth...', chat: null },
    sent_group: {}, legal_with_duplicate: { scene: '私聊', recipient: NAME, chat: null },
    other_source: { scene: '会话类型未知' }, invalid_scope_id: { scene: '会话类型未知' },
    wrong_scope_chat: { scene: '会话类型未知' }, wrong_first_chat: { scene: '会话类型未知' }, cross_first: { scene: '会话类型未知' },
  });
  assert.equal(f.run('text'), screen(json).replace('合成原文  保留空格。', '合成原文 保留空格。'),
    'whole screen changes only the required scene and recipient/conversation labels; original body compacting remains');
  for (const stored of f.records.filter(row => row.first_seen_scope_id === SENT_SCOPE_ID)) {
    assert.equal(json.find(row => row.id === stored.id).scope_config_json, JSON.stringify(SENT_CONFIG));
  }
  const sent = json.find(row => row.external_id === 'om_synthetic_type_sent_p2p');
  const stored = f.records.find(row => row.key === 'sent_p2p');
  const oldDisplay = displayFor(stored);
  assert.deepEqual(Object.keys(sent.display).filter(key => JSON.stringify(sent.display[key]) !== JSON.stringify(oldDisplay[key])),
    ['scene', 'recipient', 'chat'], 'the sent-first repair changes exactly these three display fields');
});

test('an illegal first-seen scope cannot supply or contradict a type even when its source and chat ID match', t => {
  const f = fixture(t, [
    { key: 'illegal_first_only', firstConfig: { chat_id: 'oc_synthetic_type_illegal_first_only', chat_type: 'p2p' } },
    { key: 'illegal_first_with_group', firstConfig: { chat_id: 'oc_synthetic_type_illegal_first_with_group', chat_type: 'p2p' },
      scope: { chat_type: 'group' } },
  ]);
  const json = assertRows(f, { illegal_first_only: { scene: '会话类型未知' }, illegal_first_with_group: {} });
  assert.equal(f.run('text'), screen(json));
  for (const row of json) {
    assert.equal(row.scope_config.chat_id, row.container_id);
    assert.equal(row.scope_config.chat_type, 'p2p', 'rejecting type evidence does not rewrite the public first-seen config');
  }
});

test('legacy raw.id must agree with record identity even when a correct message_id is also present', t => {
  const f = fixture(t, [
    { key: 'legacy_valid', raw: { message_id: undefined, id: 'om_synthetic_type_legacy_valid', chat_type: 'p2p' } },
    { key: 'legacy_both_valid', raw: { id: 'om_synthetic_type_legacy_both_valid', chat_type: 'p2p' } },
    { key: 'legacy_wrong', raw: { message_id: undefined, id: 'om_synthetic_unrelated_legacy', chat_type: 'p2p' } },
    { key: 'legacy_shadowed', raw: { id: 'om_synthetic_unrelated_shadowed', chat_type: 'p2p' } },
    { key: 'native_legacy_wrong', raw: { raw_api: {
      id: 'om_synthetic_unrelated_native_legacy', chat_id: 'oc_synthetic_type_native_legacy_wrong', chat_type: 'p2p' } } },
  ]);
  const json = assertRows(f, {
    legacy_valid: { scene: '私聊', recipient: NAME, chat: null },
    legacy_both_valid: { scene: '私聊', recipient: NAME, chat: null },
    legacy_wrong: { scene: '会话类型未知' }, legacy_shadowed: { scene: '会话类型未知' },
    native_legacy_wrong: { scene: '会话类型未知' },
  });
  assert.equal(f.run('text'), screen(json));
});

test('missing, malformed, visibility-only, conflicting and mismatched evidence never claims a group or a private chat', t => {
  const entries = [
    { key: 'missing' },
    { key: 'unknown', canonical: { chat_type: 'synthetic-future-type' } },
    { key: 'malformed', canonical: { chat_type: { mode: 'p2p' } } },
    { key: 'private_visibility', canonical: { chat_type: 'private' } },
    { key: 'public_visibility', raw: { chat_type: 'public' } },
    { key: 'scope_visibility', scope: { chat_type: 'private' } },
    { key: 'raw_conflict', canonical: { chat_type: 'group' }, raw: { chat_type: 'p2p' } },
    { key: 'reverse_conflict', canonical: { chat_type: 'p2p' }, raw: { chat_type: 'topic' } },
    { key: 'scope_conflict', canonical: { chat_type: 'group' }, scope: { chat_type: 'p2p' } },
    { key: 'canonical_wrong_chat', canonical: { chat_id: 'oc_synthetic_unrelated_canonical', chat_type: 'p2p' } },
    { key: 'raw_wrong_chat', raw: { chat_id: 'oc_synthetic_unrelated_raw', chat_type: 'p2p' } },
    { key: 'nested_wrong_chat', raw: { chat: { id: 'oc_synthetic_unrelated_nested', chat_type: 'p2p' } } },
    { key: 'wrong_message', raw: { message_id: 'om_synthetic_unrelated_message', chat_type: 'p2p' } },
    { key: 'native_conflict', canonical: { chat_type: 'group' }, raw: { raw_api: {
      message_id: 'om_synthetic_type_native_conflict', chat_id: 'oc_synthetic_type_native_conflict', chat_type: 'p2p' } } },
    { key: 'native_wrong_chat', raw: { raw_api: {
      message_id: 'om_synthetic_type_native_wrong_chat', chat_id: 'oc_synthetic_unrelated_native', chat_type: 'p2p' } } },
    { key: 'unknown_id', canonical: { chat_name: null } },
  ];
  const f = fixture(t, entries);
  const expected = Object.fromEntries(entries.map(entry => [entry.key, { scene: '会话类型未知',
    ...(entry.key === 'unknown_id' ? { chat: 'oc_synth...' } : {}) }]));
  const json = assertRows(f, expected);
  const text = f.run('text');
  assert.equal(text, screen(json));
  assert.doesNotMatch(text, /  群\s|  接收人\s|  群聊|  私聊/);
  assert.equal((text.match(/  会话    /g) ?? []).length, entries.length);
});

test('explicit conversation modes keep visibility separate without upgrading an existing ordinary group to topic', t => {
  const f = fixture(t, [
    { key: 'private_group', scope: { chat_type: 'private', chat_mode: 'group' } },
    { key: 'public_group', raw: { chat_type: 'public', chat_mode: 'group' } },
    { key: 'private_p2p_mode', raw: { chat_type: 'private', chat_mode: 'p2p' } },
    { key: 'old_group_topic', canonical: { chat_type: 'group' }, scope: { chat_type: 'topic' } },
  ]);
  const json = assertRows(f, { private_group: {}, public_group: {},
    private_p2p_mode: { scene: '私聊', recipient: NAME, chat: null }, old_group_topic: {} });
  assert.equal(f.run('text'), screen(json));
});

test('real CLI keeps ordering, filters and narrow screen content while unknown scenes use the neutral field', t => {
  const f = fixture(t, [
    { key: 'narrow_a', offset: 0, scope: { chat_type: 'p2p' }, body: '合成正文甲。' },
    { key: 'narrow_b', offset: 0, direction: 'received', body: '合成正文乙。' },
    { key: 'narrow_c', offset: 1, canonical: { chat_type: 'group' }, body: '合成正文丙。' },
  ]);
  const json = assertRows(f, { narrow_a: { scene: '私聊', recipient: NAME, chat: null },
    narrow_b: { scene: '会话类型未知' }, narrow_c: {} });
  assert.deepEqual(json.map(row => row.external_id), ['om_synthetic_type_narrow_c', 'om_synthetic_type_narrow_b', 'om_synthetic_type_narrow_a']);
  assert.deepEqual(f.run('json', 80, ['--limit', '2']), json.slice(0, 2));
  assert.deepEqual(f.run('json', 80, ['--direction', 'received']), [json[1]]);
  assert.deepEqual(f.run('json', 80, ['--search', '合成正文甲']), [json[2]]);
  for (const columns of [1, 20, 40, 80]) {
    const text = f.run('text', columns);
    for (const line of text.split('\n')) assert.ok(textWidth(line) <= Math.max(columns, 20), `${columns} columns: ${line}`);
    assert.equal((text.match(/发送人/g) ?? []).length, 3);
    assert.equal((text.match(/接收人/g) ?? []).length, 1);
    assert.equal((text.match(/  会话    /g) ?? []).length, 1);
    assert.equal((text.match(/  群      /g) ?? []).length, 1);
    for (const value of [SENDER, NAME, '合成正文甲。', '合成正文乙。', '合成正文丙。']) {
      assert.ok(text.replace(/\n +/g, '').includes(value), `no content loss at ${columns} columns: ${value}`);
    }
    assert.deepEqual(f.run('json', columns), json, 'terminal width cannot affect any JSON field');
  }
  assert.equal(f.run('text'), screen(json));
  f.unchanged();
});

test('duplicate legal-scope query results fail closed regardless of row order without adding public fields', t => {
  const f = fixture(t, [{ key: 'duplicate_query', scope: { chat_type: 'p2p' } }]);
  const stored = f.records[0];
  for (const types of [['p2p', 'group'], ['group', 'p2p'], ['group', 'p2p', 'group']]) {
    const rows = loadMessages(f.db, { db: f.db, direction: 'all', limit: 1, search: '' }, {
      sqliteJson(db, sql, label) {
        const result = sqliteJson(db, sql, label);
        if (label !== 'read message conversation types') return result;
        assert.equal(result.length, 1);
        // A SQLite primary key excludes this on disk. Inject duplicate query
        // results to prove the boundary never chooses an arbitrary candidate.
        return types.map(chat_type => ({ ...result[0],
          config_json: JSON.stringify({ chat_id: stored.container_id, chat_type }) }));
      },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(rows)), [publicRow(stored, displayFor(stored, { scene: '会话类型未知' }))]);
    const text = plain(renderMessagesText(rows));
    assert.match(text, /会话类型未知/);
    assert.match(text, /  会话    合成会话名/);
    assert.doesNotMatch(text, /  群\s|  接收人\s/);
    f.unchanged();
  }
});
