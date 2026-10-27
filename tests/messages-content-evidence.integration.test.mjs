import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { ensureInitialized, quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { SENT_SCOPE_ID } from '../src/adapters/lark-im/core.mjs';
import { renderApiMessageContent } from '../src/adapters/lark-im/raw-message.mjs';

// Every identity, payload, event and database is authored synthetic test data.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AT = Date.UTC(2025, 1, 3, 4, 5, 6), CHAT = 'oc_synthetic_content_evidence';
const TITLE = 'Invented Content Evidence Room', NAME = 'Invented Content Author';
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const own = (value, key) => Object.hasOwn(value, key);

function native(id, type, payload, mentions) {
  return { message_id: `om_c${String(id).padStart(4, '0')}_synthetic_content`, chat_id: CHAT, chat_type: 'group',
    msg_type: type, create_time: String(AT + id * 1000), update_time: String(AT + id * 1000 + 9),
    sender: { id: 'ou_synthetic_content_author', id_type: 'open_id', sender_type: 'user', name: NAME },
    body: { content: JSON.stringify(payload) }, ...(mentions ? { mentions } : {}) };
}
function fixtures() {
  const cases = [];
  const add = (label, type, payload, options = {}) => {
    const id = cases.length + 1;
    const raw = native(id, type, payload, options.mentions);
    options.mutate?.(raw);
    const source = raw.raw_api || raw;
    const body = own(options, 'body') ? options.body : renderApiMessageContent(source,
      raw.raw_api_expansions?.merge_forward ? { mergeItems: raw.raw_api_expansions.merge_forward.items } : {}).text;
    const canonical = { message_id: source.message_id, chat_id: CHAT, chat_type: 'group', chat_name: TITLE,
      msg_type: type, sender_id: source.sender.id, sender_id_type: 'open_id', sender_type: 'user',
      sender_name: NAME, sender_name_source: 'message_sender', ...(options.canonical || {}) };
    const rawJson = JSON.stringify(raw);
    const row = { id, source_id: 'lark.im', record_type: 'lark.im.message', first_seen_scope_id: SENT_SCOPE_ID,
      external_id: source.message_id, external_version: source.update_time, actor_id: source.sender.id,
      container_id: CHAT, direction: 'received', occurred_at: new Date(AT + id * 1000).toISOString(),
      occurred_at_ms: AT + id * 1000, body, raw_json: rawJson, canonical_json: JSON.stringify(canonical), content_hash: hash(rawJson) };
    cases.push({ label, row, state: options.state || 'ready', reason: options.reason || null,
      shown: own(options, 'shown') ? options.shown : body, freshProjection: options.freshProjection || false });
  };
  const member = { key: '@_user_1', id: { open_id: 'ou_synthetic_content_mention' }, name: 'Invented Mention' };
  add('native exact plain text', 'text', { text: 'Invented exact text.' });
  add('valid empty text', 'text', { text: '' }, { shown: '(empty)' });
  add('native text object', 'text', { text: 'Invented object text.' }, {
    mutate: raw => { raw.body.content = { text: 'Invented object text.' }; } });
  add('direct legacy string', 'text', null, { body: 'Invented direct text.',
    mutate: raw => { delete raw.body; raw.content = 'Invented direct text.'; } });
  add('direct legacy text object', 'text', null, { body: 'Invented legacy object.',
    mutate: raw => { delete raw.body; raw.content = { text: 'Invented legacy object.' }; } });
  add('resolved native mention', 'text', { text: 'Hello @_user_1.' }, { mentions: [member], body: 'Hello @Invented Mention.' });
  add('resolved direct legacy mention', 'text', null, { mentions: [member], body: 'Hello @Invented Mention.',
    mutate: raw => { delete raw.body; raw.content = 'Hello @_user_1.'; } });
  add('wrapped native text without metadata', 'text', { text: 'Invented wrapped text.' }, {
    mutate: raw => { raw.raw_api = clone(raw); raw.content = 'Invented wrapped text.'; raw.source_api = 'im.v1.messages'; } });
  add('supported legacy post', 'post', { title: 'Invented post', content: [[{ tag: 'text', text: 'Invented post paragraph.' }]] },
    { shown: 'Invented post Invented post paragraph.' });
  add('saved exact forward details', 'merge_forward', { message_ids: ['om_synthetic_forward_child'] }, {
    mutate: raw => { raw.raw_api = clone(raw); raw.source_api = 'im.v1.messages';
      const child = native(900, 'text', { text: 'Invented forwarded text.' }); child.message_id = 'om_synthetic_forward_child';
      raw.raw_api_expansions = { merge_forward: { source_api: 'im.v1.messages.get', items: [clone(raw.raw_api), child] } }; },
    shown: '[转发合并内容，按 API 顺序列出 1 条] [转发消息 1 · Invented Content Author] Invented forwarded text.' });
  add('current card renderer supersedes old partial metadata', 'interactive',
    { elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Invented current card.' } }] },
    { body: 'Stored old card fallback remains unchanged.', shown: 'Invented current card.', freshProjection: true,
      canonical: { content_rendering: { status: 'partial', reason: 'old_parser_limit' } } });
  add('current system renderer supersedes old partial metadata', 'system',
    { template: '{name} joined {group_name}. New members can view all chat history.', name: 'Invented Guest', group_name: 'Invented Historic Room' },
    { body: 'Stored old system text remains unchanged.',
      shown: 'Invented Guest joined Invented Historic Room. New members can view all chat history.', freshProjection: true,
      canonical: { content_rendering: { status: 'partial', reason: 'system_parameters_missing' } } });
  add('recalled tombstone', 'text', null, { body: '[Invalid text JSON]', shown: '[已撤回/已删除：飞书未返回原始富文本内容]', freshProjection: true,
    mutate: raw => { raw.deleted = true; } });
  add('body disagrees with source', 'text', { text: 'Invented authoritative complete body.' },
    { body: 'Invented shortened body.', state: 'enriching', reason: 'content_invalid' });
  add('malformed encoded native text', 'text', {}, { body: 'Invented readable fallback.',
    mutate: raw => { raw.body.content = '{broken invented text'; }, state: 'enriching', reason: 'content_invalid' });
  add('duplicate source content key', 'text', {}, { body: 'Invented second value.',
    mutate: raw => { raw.body.content = '{"text":"Invented first value.","text":"Invented second value."}'; },
    state: 'enriching', reason: 'content_invalid' });
  add('unresolved native mention', 'text', { text: 'Hello @_user_1.' },
    { mentions: [{ key: member.key, id: member.id }], state: 'enriching', reason: 'content_partial' });
  add('conflicting native mention', 'text', { text: 'Hello @_user_1.' },
    { mentions: [member, { ...member, name: 'Invented Conflicting Mention' }], state: 'enriching', reason: 'content_partial' });
  add('unresolved direct legacy mention', 'text', {}, { body: 'Hello @_user_1.',
    mutate: raw => { delete raw.body; raw.content = 'Hello @_user_1.'; }, state: 'enriching', reason: 'content_partial' });
  add('native malformed content cannot borrow wrapper', 'text', {}, { body: 'Invented plausible wrapper text.',
    mutate: raw => { raw.body.content = '{malformed native'; raw.raw_api = clone(raw); raw.source_api = 'im.v1.messages'; raw.content = 'Invented plausible wrapper text.'; },
    state: 'enriching', reason: 'content_invalid' });
  add('missing native body cannot borrow wrapper', 'text', {}, { body: 'Invented plausible wrapper text.',
    mutate: raw => { delete raw.body; raw.raw_api = clone(raw); raw.source_api = 'im.v1.messages'; raw.content = 'Invented plausible wrapper text.'; },
    state: 'enriching', reason: 'content_pending' });
  add('native null body cannot borrow direct content', 'text', {}, { body: 'Invented plausible direct text.',
    mutate: raw => { raw.body = null; raw.content = 'Invented plausible direct text.'; },
    state: 'enriching', reason: 'content_invalid' });
  add('unsupported legacy post node', 'post', { content: [[{ tag: 'invented_unsupported', text: 'Invented unknown node.' }]] },
    { state: 'blocked', reason: 'content_unsupported' });
  add('forward details remain incomplete', 'merge_forward', { message_ids: ['om_synthetic_unfetched'] },
    { state: 'enriching', reason: 'content_partial' });
  add('forward detail route cannot be invented', 'merge_forward', {}, { body: 'Invented unsupported detail.',
    mutate: raw => { raw.raw_api_expansions = { merge_forward: { source_api: 'invented.route', items: [] } }; },
    state: 'enriching', reason: 'content_invalid' });
  add('unsupported media is not invented prose support', 'sticker', { file_key: 'synthetic_sticker_key' },
    { state: 'blocked', reason: 'content_unsupported' });
  add('ready adjacent neighbor', 'text', { text: 'Invented adjacent ready body.' });
  add('latest malformed must not be replaced at limit one', 'text', {}, { body: 'Invented latest fallback.',
    mutate: raw => { raw.body.content = 'not encoded JSON'; }, state: 'enriching', reason: 'content_invalid' });
  return cases;
}

function fixture(t, cases) {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-messages-content-evidence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite'), marker = join(directory, 'unexpected-network');
  const cli = join(directory, 'reject-cli'), guard = join(directory, 'reject-network.mjs');
  writeFileSync(cli, '#!/bin/sh\nprintf called > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
  writeFileSync(guard, `import {writeFileSync} from 'node:fs';import {Socket} from 'node:net';
const deny=()=>{writeFileSync(process.env.SYNTHETIC_NETWORK_MARKER,'called');throw Error('synthetic content test forbids network');};
globalThis.fetch=deny;Socket.prototype.connect=deny;Object.defineProperty(process.stdout,'columns',{value:180});\n`);
  ensureInitialized(db);
  for (const { row } of cases) {
    const columns = Object.keys(row);
    sqliteExec(db, `INSERT INTO records(${columns.join(',')}) VALUES(${columns.map(key => typeof row[key] === 'number'
      ? String(row[key]) : quoteSql(row[key])).join(',')});`);
  }
  sqliteExec(db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  return { directory, db, marker, cli, guard };
}
function snapshot(f) {
  const dump = spawnSync('sqlite3', ['-readonly', f.db, '.dump'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(dump.status, 0, dump.stderr);
  return { bytes: hash(readFileSync(f.db)), dump: dump.stdout, mtime: statSync(f.db).mtimeMs, files: readdirSync(f.directory).sort() };
}
function run(f, args) {
  const env = { ...process.env, TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', NO_COLOR: '1',
    LARK_CLI: f.cli, SYNTHETIC_NETWORK_MARKER: f.marker }; delete env.FORCE_COLOR;
  const p = spawnSync(process.execPath, ['--import', f.guard, ...args], { cwd: f.directory, env,
    encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(p.status, 0, p.stderr || p.stdout); assert.equal(p.stderr, ''); assert.equal(existsSync(f.marker), false);
  return p.stdout;
}
const messages = (f, format, limit = 100) => run(f, [join(ROOT, 'bin/exocortex.mjs'), 'messages', '--db', f.db, '--limit', String(limit), '--format', format]);
const header = row => `RECEIVED ${new Date(row.occurred_at).toLocaleString('en-US', { timeZone: 'UTC' })}  ${row.external_id.slice(0, 8)}...  群聊`;
const reasonLabels = { content_invalid: '消息内容需核验', content_pending: '消息详情待补全', content_partial: '消息内容未完整解析', content_unsupported: '消息类型尚未完整支持' };

test('real CLI and quality verify legacy content against its exact source without changing storage, order or neighbors', t => {
  const cases = fixtures(), f = fixture(t, cases), before = snapshot(f), ordered = [...cases].reverse();
  const rows = JSON.parse(messages(f, 'json')), text = messages(f, 'text');
  assert.deepEqual(rows.map(row => row.id), ordered.map(value => value.row.id));
  for (const [index, expected] of ordered.entries()) {
    const row = rows[index], stored = expected.row;
    for (const key of ['id', 'source_id', 'record_type', 'external_id', 'actor_id', 'container_id', 'direction',
      'occurred_at', 'occurred_at_ms', 'raw_json', 'canonical_json', 'body']) assert.equal(row[key], stored[key], `${expected.label}: ${key}`);
    assert.deepEqual(row.raw, JSON.parse(stored.raw_json)); assert.deepEqual(row.canonical, JSON.parse(stored.canonical_json));
    if (!expected.freshProjection) assert.equal(row.display.body, stored.body, expected.label);
    assert.equal(row.readiness.state, expected.state, expected.label);
    assert.deepEqual(row.readiness.reasons, expected.reason ? [expected.reason] : [], expected.label);
    const content = row.readiness.requirements.find(value => value.field === 'content');
    assert.equal(content.state, expected.state === 'ready' ? 'satisfied' : expected.state === 'blocked' ? 'blocked' : 'missing', expected.label);
    const start = text.indexOf(header(stored)), end = index + 1 < ordered.length ? text.indexOf(header(ordered[index + 1].row)) : text.length;
    assert(start >= 0 && end > start, `${expected.label}: exact text header and unchanged position`);
    const block = text.slice(start, end).trimEnd();
    if (expected.reason) assert.equal(block, `${header(stored)}\n  状态    ${expected.state === 'blocked' ? '准备受阻' : '等待完整信息'}\n  原因    ${reasonLabels[expected.reason]}\n  查看    messages --format json 可检查已保存内容与原因`, expected.label);
    else {
      assert(block.includes(`\n  发送人  ${NAME}\n  群      ${TITLE}\n`), expected.label);
      if (expected.shown) assert(block.includes(expected.shown), `${expected.label}: unchanged supported display: ${block}`);
      assert(!block.includes('状态    '), expected.label);
    }
  }
  const counts = { captured: 0, enriching: 0, ready: 0, blocked: 0 };
  for (const value of cases) counts[value.state]++;
  assert(text.startsWith(`Messages (${cases.length})\n完整 ${counts.ready} · 待补全 ${counts.enriching} · 受阻 ${counts.blocked}\n\n`));
  const quality = JSON.parse(run(f, ['--input-type=module', '-e', `import {collectQualityReport} from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/diagnostics/lark-im-quality-report.mjs')).href)};process.stdout.write(JSON.stringify(collectQualityReport(process.argv[1])));`, f.db]));
  assert.deepEqual(quality.completeness.counts, counts, 'quality uses the actual CLI content classification');
  assert.deepEqual(JSON.parse(messages(f, 'json', 1)), [rows[0]], 'latest exception does not skip backward to a ready neighbor');
  assert.equal(messages(f, 'text', 1), `Messages (1)\n完整 0 · 待补全 1 · 受阻 0\n\n${header(ordered[0].row)}\n  状态    等待完整信息\n  原因    消息内容需核验\n  查看    messages --format json 可检查已保存内容与原因\n`);
  assert.deepEqual(snapshot(f), before, 'read-only evidence projection preserves all DB bytes, clocks, schema and files');
});
