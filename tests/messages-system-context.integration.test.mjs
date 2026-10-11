import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ensureInitialized, quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { compact } from '../dist/terminal/index.js';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { renderSystemProjection } from '../src/adapters/lark-im/system-content.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AT = Date.UTC(2041, 3, 9, 10, 11, 12), CHAT = 'oc_synthetic_context', SCOPE = 'lark.im.received.chat.synthetic_context';
const TEMPLATE = '{name} joined {group_name}. New members can view all chat history.';
const hash = value => createHash('sha256').update(value).digest('hex');
function message(key, parameters, extra = {}) {
  return { message_id: `om_synthetic_${key}`, chat_id: CHAT, chat_type: 'group', chat_name: 'Synthetic snapshot room',
    msg_type: 'system', create_time: String(AT), update_time: String(AT),
    body: { content: JSON.stringify(parameters) }, ...extra };
}
function fixture(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-system-display-synthetic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite'), marker = join(dir, 'remote-forbidden'), cli = join(dir, 'no-lark');
  writeFileSync(cli, '#!/bin/sh\nprintf forbidden > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
  ensureInitialized(db);
  sqliteExec(db, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${quoteSql(SCOPE)},'lark.im','Synthetic context',
    ${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: 'group', chat_name: 'CURRENT SCOPE NAME MUST NOT BECOME EVENT NAME' }))});`);
  const records = entries.map(({ raw, mutate }) => {
    const row = recordFromMessage(normalizeApiMessage(raw), SCOPE, 'received', {
      scope_config: { chat_id: CHAT, chat_type: 'group', chat_name: 'CURRENT SCOPE NAME MUST NOT BECOME EVENT NAME' },
    });
    mutate?.(row);
    const fields = Object.keys(row);
    sqliteExec(db, `INSERT INTO records(${fields.join(',')}) VALUES(${fields.map(key => quoteSql(row[key])).join(',')});`);
    return row;
  });
  sqliteExec(db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  const before = hash(readFileSync(db));
  const run = (format, args = []) => {
    const result = spawnSync(process.execPath, [join(ROOT, 'bin/exocortex.mjs'), 'messages', '--db', db, '--format', format, ...args], {
      cwd: dir, env: { ...process.env, NO_COLOR: '1', TZ: 'UTC', LARK_CLI: cli, SYNTHETIC_NETWORK_MARKER: marker }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    assert.equal(existsSync(marker), false); assert.equal(hash(readFileSync(db)), before, 'reading must not change DB bytes');
    return format === 'json' ? JSON.parse(result.stdout) : result.stdout;
  };
  return { records, run };
}

test('normalize → SQLite → messages binds group context to the same source snapshot without rewriting storage', t => {
  const params = { template: TEMPLATE, name: 'Synthetic Alder {phase}' };
  const f = fixture(t, [
    { raw: message('context', params) },
    { raw: message('explicit', { ...params, group_name: 'Explicit historical room' }) },
    { raw: message('scope_only', params, { chat_name: undefined }) },
    { raw: message('unknown_type', params, { chat_type: undefined }) },
    { raw: message('p2p', params, { chat_type: 'p2p' }) },
    { raw: message('other_chat', params), mutate: row => { row.container_id = 'oc_other_synthetic'; } },
    { raw: message('other_time', params), mutate: row => { row.occurred_at_ms++; } },
    { raw: message('contradictory_metadata', params, { chat: { id: 'oc_other_synthetic', name: 'Other snapshot room' } }) },
    { raw: message('unknown_template', { template: 'Previous room {group_name}, operated by {operator}.' }) },
    { raw: message('explicit_empty', { ...params, group_name: '' }) },
    { raw: message('operator', { template: '{operator} joined {group_name}.' }) },
  ]);
  const output = f.run('json');
  const byId = new Map(output.map(row => [row.external_id, row]));
  for (const stored of f.records) {
    const got = byId.get(stored.external_id);
    for (const key of ['raw_json', 'canonical_json', 'body']) assert.equal(got[key], stored[key]);
  }
  const good = byId.get('om_synthetic_context');
  assert.equal(good.display.body, 'Synthetic Alder {phase} joined [未知参数：group_name]. New members can view all chat history.');
  assert.equal(good.display.chat, 'Synthetic snapshot room');
  assert.equal(good.canonical.content_rendering.status, 'partial');
  assert.equal(good.display.system.status, 'partial');
  assert.deepEqual(good.display.system.context_parameters, []);
  assert.equal(good.display.system.context_source, null);
  assert.equal(good.display.system.context_time_basis, null);
  assert.equal(good.display.system.context_status, 'snapshot_only');
  assert.deepEqual(good.display.system.missing_parameters, ['group_name']);
  const explicit = byId.get('om_synthetic_explicit');
  assert.match(explicit.display.body, /Explicit historical room/);
  assert.deepEqual(explicit.display.system.context_parameters, []);
  for (const key of ['scope_only', 'unknown_type', 'p2p', 'other_chat', 'other_time', 'contradictory_metadata', 'unknown_template', 'explicit_empty', 'operator']) {
    const row = byId.get(`om_synthetic_${key}`);
    assert.match(row.display.body, /\[未知参数：group_name\]/, key);
    assert.equal(row.display.system.status, 'partial', key);
    assert.deepEqual(row.display.system.context_parameters, [], key);
  }
  assert.match(byId.get('om_synthetic_operator').display.body, /\[未知参数：operator\]/);
  const text = f.run('text');
  assert.match(text, /Synthetic snapshot room/);
  assert.match(text, /Explicit historical room/);
  assert.match(text, /\[未知参数：group_name\]/);
});

test('only explicit event-time container context fills the limited semantic profile', () => {
  // Synthetic evidence for the renderer contract, not a claim that today's API
  // supplies historical group names. The messages reader never fabricates it.
  const context = { chat_id: CHAT, event_time_ms: AT, group: { chat_id: CHAT, chat_type: 'group', name: 'Synthetic event room {phase}',
    source: 'message_event', time_basis: 'event', effective_at_ms: AT } };
  const content = { template: TEMPLATE, name: 'Synthetic Alder' };
  const good = renderSystemProjection(content, context);
  assert.equal(good.text, 'Synthetic Alder joined Synthetic event room {phase}. New members can view all chat history.');
  assert.equal(good.status, 'rendered'); assert.deepEqual(good.context_parameters, ['group_name']);
  assert.equal(good.context_time_basis, 'event');
  assert.equal(renderSystemProjection({ ...content, group_name: 'Explicit historical name' }, context).context_status, 'not_applied');
  for (const change of [{ source: 'scope_config' }, { time_basis: 'message_snapshot' }, { effective_at_ms: AT + 1 },
    { chat_id: 'oc_other' }, { chat_type: 'p2p' }, { name: '' }]) {
    assert.match(renderSystemProjection(content, { ...context, group: { ...context.group, ...change } }).text, /\[未知参数：group_name\]/);
  }
  assert.match(renderSystemProjection({ template: 'Renamed {group_name}' }, context).text, /\[未知参数：group_name\]/);
});

for (const type of ['text', 'post', 'system']) test(`${type} CLI keeps complete graphemes inside the original body budget and full JSON`, t => {
  for (const cluster of ['😀', '👍🏽', 'e\u0301', '👩🏽‍🔬']) {
    const body = 'x'.repeat(236) + cluster + ' synthetic tail';
    const parameters = type === 'system' ? { template: body } : type === 'text' ? { text: body }
      : { en_us: { title: '', content: [[{ tag: 'text', text: body }]] } };
    const f = fixture(t, [{ raw: message(`${type}_unicode`, parameters, { msg_type: type }) }]);
    const row = f.run('json')[0];
    assert.equal(row.body, body); assert.equal(row.display.body, body);
    const text = f.run('text');
    const bodyLines = text.split('\n').slice(text.split('\n').findIndex(line => /^  消息\s/.test(line)));
    const displayed = bodyLines.map((line, index) => index ? line.trim() : line.replace(/^  消息\s+/, '')).join('');
    assert.equal(displayed, 'x'.repeat(236) + '...', cluster);
    assert.equal(displayed.isWellFormed(), true); assert.ok(displayed.length <= 240);
    assert.equal(compact('x'.repeat(235) + '😀' + ' longer suffix'), 'x'.repeat(235) + '😀...');
  }
  assert.equal(compact('a'.repeat(241)), 'a'.repeat(237) + '...');
});
