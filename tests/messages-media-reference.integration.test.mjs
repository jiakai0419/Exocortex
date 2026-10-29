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

// All messages, resource references and identities below are invented here.
// No account, fixture derived from business data, remote API or live DB is read.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AT = Date.UTC(2025, 7, 8, 9, 10, 11);
const CHAT = 'oc_invented_media_reference_room';
const ACTOR = 'ou_invented_media_reference_author';
const NAME = 'Invented Media Author', TITLE = 'Invented Media Workshop';
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const textFor = (type, state) => type==='sticker'&&state==='reference_only'
  ? '[贴纸] 已保存资源引用；飞书消息资源接口不支持读取贴纸' : `[${type === 'image' ? '图片' : '贴纸'}] ${state === 'reference_only'
  ? '仅保存资源引用' : state === 'missing_reference' ? '资源引用缺失' : '资源引用无效'}，尚无可用资源证据`;
const reasonFor = (state,type) => state === 'reference_only' ? (type==='sticker'?'content_resource_unsupported':'content_resource_unavailable')
  : state === 'missing_reference' ? 'content_reference_missing' : 'content_reference_invalid';

function cases() {
  const entries = [];
  function add(label, type, payload, options = {}) {
    const id = entries.length + 1, external = `om_m${String(id).padStart(4, '0')}_invented_media`;
    const native = { message_id: external, chat_id: CHAT, chat_type: 'group', msg_type: type,
      create_time: String(AT + id * 1000), update_time: String(AT + id * 1000 + 7),
      sender: { id: ACTOR, id_type: 'open_id', sender_type: 'user', name: NAME },
      body: { content: JSON.stringify(payload) } };
    options.native?.(native);
    const raw = options.wrapped ? { ...clone(native), source_api: 'im.v1.messages', raw_api: clone(native),
      content: 'Invented wrapper text cannot prove the resource is available.' } : native;
    options.raw?.(raw);
    const canonical = { message_id: external, chat_id: CHAT, chat_type: 'group', chat_name: TITLE,
      msg_type: type, sender_id: ACTOR, sender_id_type: 'open_id', sender_type: 'user',
      sender_name: NAME, sender_name_source: 'message_sender',
      content_rendering: { status: 'structured_fallback', reason: 'unsupported_message_content', version: 1 },
      ...(options.canonical || {}) };
    const body = options.body ?? `Invented original stored body ${id}.`;
    const rawJson = JSON.stringify(raw);
    const row = { id, source_id: 'lark.im', record_type: 'lark.im.message', first_seen_scope_id: SENT_SCOPE_ID,
      external_id: external, external_version: String(AT + id * 1000 + 7), actor_id: ACTOR,
      container_id: CHAT, direction: options.direction || 'received', occurred_at: new Date(AT + id * 1000).toISOString(),
      occurred_at_ms: AT + id * 1000, body, raw_json: rawJson, canonical_json: JSON.stringify(canonical),
      content_hash: hash(rawJson) };
    const mediaState = options.mediaState === undefined ? 'reference_only' : options.mediaState;
    entries.push({ label, row, type, mediaState, state: options.state || 'blocked',
      scene: options.scene || '群聊',
      reason: options.reason ?? (mediaState ? reasonFor(mediaState,type) : null),
      key: options.key ?? (type === 'image' ? payload?.image_key : payload?.file_key) ?? null,
      search: options.search || false });
  }
  const ready = { mediaState: null, state: 'ready', canonical: { content_rendering: { status: 'rendered', reason: null, version: 1 } } };
  add('older ready neighbor', 'text', { text: 'Invented ordinary older text.' }, { ...ready, body: 'Invented ordinary older text.' });
  add('unwrapped image reference', 'image', { image_key: 'synthetic_image_reference_A' });
  add('wrapped sticker reference', 'sticker', { file_key: 'synthetic_sticker_reference_A' }, { wrapped: true });
  add('direct object content', 'image', {}, { native: item => { item.body.content = { image_key: 'synthetic_object_image_reference' }; }, key: 'synthetic_object_image_reference' });
  add('explicit alias type', 'sticker', { file_key: 'synthetic_alias_sticker_reference' }, {
    native: item => { delete item.msg_type; item.message_type = 'sticker'; } });
  add('unknown fields do not prove resource availability', 'image', {
    image_key: 'synthetic_reference_with_extra_fields', text: 'INVENTED_OCR_MUST_NOT_APPEAR',
    url: 'https://example.invalid/not-downloaded', local_path: '/tmp/invented-media-never-open',
  });
  add('false persisted rendered metadata cannot satisfy resource-only content', 'sticker', {
    file_key: 'synthetic_not_downloaded_sticker', downloaded: true, available: true,
  }, { wrapped: true, canonical: { content_rendering: { status: 'rendered', reason: null, version: 987 } },
    raw: raw => { raw.content_rendering = { status: 'rendered', reason: null, version: 987 }; } });
  add('old partial metadata gets specific resource diagnosis', 'image', { image_key: 'synthetic_old_partial' }, {
    canonical: { content_rendering: { status: 'partial', reason: 'invented_legacy_limit', version: 1 } } });
  add('missing image reference', 'image', {}, { mediaState: 'missing_reference' });
  add('wrong reference field is missing', 'sticker', { image_key: 'synthetic_wrong_slot' }, { mediaState: 'missing_reference' });
  for (const [label, value] of [['empty', ''], ['whitespace', ' '], ['null', null], ['number', 12], ['object', {}],
    ['array', []], ['control', 'synthetic\u001b[31m'], ['newline', 'synthetic\nkey'], ['URL', 'https://example.invalid/resource'],
    ['absolute path', '/tmp/invented-resource'], ['relative path', '../invented-resource'], ['too long', 'k'.repeat(2049)]]) {
    add(`invalid image key ${label}`, 'image', { image_key: value }, { mediaState: 'invalid_reference' });
  }
  add('boundary reference length remains only a reference', 'sticker', { file_key: 's'.repeat(2048) });
  add('duplicate content keys fail closed', 'image', {}, { mediaState: 'invalid_reference', native: item => {
    item.body.content = '{"image_key":"synthetic_first","image_key":"synthetic_second"}'; } });
  add('malformed encoded content fails closed', 'sticker', {}, { mediaState: 'invalid_reference', native: item => {
    item.body.content = '{invented invalid JSON'; } });
  add('nonobject content fails closed', 'image', {}, { mediaState: 'invalid_reference', native: item => {
    item.body.content = '[]'; } });
  add('oversized encoded content is not truncated into a valid reference', 'image', {}, {
    mediaState: 'invalid_reference', native: item => { item.body.content = JSON.stringify({
      image_key: 'synthetic_oversized_reference', unused: 'x'.repeat(256 * 1024) }); } });
  add('missing native body cannot borrow wrapper body', 'image', { image_key: 'synthetic_outer_only' }, {
    wrapped: true, mediaState: 'missing_reference', raw: raw => { delete raw.raw_api.body; } });
  add('native content wins over a distinct wrapper summary', 'image', { image_key: 'synthetic_native_reference' }, {
    wrapped: true, raw: raw => { raw.body.content = JSON.stringify({ image_key: 'synthetic_wrapper_imposter' }); } });
  add('source message binding conflict', 'image', { image_key: 'synthetic_wrong_message' }, {
    wrapped: true, mediaState: null, reason: 'message_identity_invalid', scene: '会话类型未知', raw: raw => { raw.raw_api.message_id = 'om_invented_different_message'; } });
  add('source chat binding conflict', 'sticker', { file_key: 'synthetic_wrong_chat' }, {
    mediaState: null, reason: 'message_identity_invalid', scene: '会话类型未知', native: item => { item.chat_id = 'oc_invented_different_chat'; } });
  add('native nested chat alias conflicts with row binding', 'image', { image_key: 'synthetic_wrong_nested_chat' }, {
    mediaState: null, reason: 'message_identity_invalid', scene: '会话类型未知',
    native: item => { item.chat = { chat_id: 'oc_invented_different_nested_chat' }; } });
  add('native ID alias conflicts with row binding', 'sticker', { file_key: 'synthetic_wrong_native_alias' }, {
    mediaState: null, reason: 'message_identity_invalid', scene: '会话类型未知',
    native: item => { item.id = 'om_invented_different_alias'; } });
  add('canonical type conflicts with native type', 'image', { image_key: 'synthetic_type_conflict' }, {
    mediaState: null, reason: 'content_invalid', canonical: { msg_type: 'sticker' } });
  add('native type aliases conflict', 'image', { image_key: 'synthetic_alias_conflict' }, {
    mediaState: null, reason: 'content_invalid', native: item => { item.message_type = 'sticker'; } });
  add('damaged native wrapper cannot borrow outer reference', 'image', { image_key: 'synthetic_untrusted_outer' }, {
    mediaState: null, reason: 'content_unsupported', raw: raw => { raw.raw_api = null; } });
  add('damaged wrapper with false rendered metadata cannot become ready', 'image', { image_key: 'synthetic_untrusted_rendered_outer' }, {
    mediaState: null, state: 'enriching', reason: 'content_invalid', raw: raw => { raw.raw_api = []; },
    canonical: { content_rendering: { status: 'rendered', reason: null, version: 1 } } });
  add('canonical type cannot invent absent native type', 'image', { image_key: 'synthetic_absent_type' }, {
    mediaState: null, reason: 'content_unsupported', native: item => { delete item.msg_type; } });
  add('unknown type with familiar resource key remains unsupported', 'invented_future_media', { image_key: 'synthetic_unknown_type' }, {
    mediaState: null, reason: 'content_unsupported' });
  add('recalled media preserves tombstone priority', 'image', { image_key: 'synthetic_recalled_reference' }, {
    mediaState: null, state: 'ready', native: item => { item.deleted = true; } });
  add('stored-body search finds a blocked sent row', 'sticker', { file_key: 'synthetic_sent_resource_key' }, {
    direction: 'sent', body: 'Invented original STORED_MEDIA_SEARCH paragraph.', search: true });
  add('adjacent ready text remains unchanged', 'text', { text: 'Invented newest ordinary text.' }, {
    ...ready, body: 'Invented newest ordinary text.' });
  add('latest blocked row is not skipped for a ready neighbor', 'image', { image_key: 'synthetic_latest_reference' });
  return entries;
}

function fixture(t, entries) {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-messages-media-reference-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite'), marker = join(directory, 'unexpected-network');
  const cli = join(directory, 'reject-cli'), guard = join(directory, 'reject-network.mjs');
  writeFileSync(cli, '#!/bin/sh\nprintf called > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
  writeFileSync(guard, `import {writeFileSync} from 'node:fs';import {Socket} from 'node:net';
const deny=()=>{writeFileSync(process.env.SYNTHETIC_NETWORK_MARKER,'called');throw Error('synthetic media test forbids network');};
globalThis.fetch=deny;Socket.prototype.connect=deny;Object.defineProperty(process.stdout,'columns',{value:180});\n`);
  ensureInitialized(db);
  sqliteExec(db, entries.map(({ row }) => {
    const columns = Object.keys(row);
    return `INSERT INTO records(${columns.join(',')}) VALUES(${columns.map(key => typeof row[key] === 'number'
      ? String(row[key]) : quoteSql(row[key])).join(',')});`;
  }).join('\n'));
  sqliteExec(db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  return { directory, db, marker, cli, guard };
}

function snapshot(f) {
  const dump = spawnSync('sqlite3', ['-readonly', f.db, '.dump'], { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(dump.status, 0, dump.stderr);
  return { bytes: hash(readFileSync(f.db)), dump: dump.stdout,
    mtime: statSync(f.db).mtimeMs, files: readdirSync(f.directory).sort() };
}
function run(f, args) {
  const env = { ...process.env, TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', NO_COLOR: '1',
    LARK_CLI: f.cli, SYNTHETIC_NETWORK_MARKER: f.marker }; delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath, ['--import', f.guard, ...args], { cwd: f.directory, env,
    encoding: 'utf8', timeout: 20000, maxBuffer: 12 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(existsSync(f.marker), false, 'neither Node network APIs nor the Lark CLI may run');
  return result.stdout;
}
const messages = (f, format, { limit = 100, direction = 'all', search = '' } = {}) => run(f,
  [join(ROOT, 'bin/exocortex.mjs'), 'messages', '--db', f.db, '--limit', String(limit), '--direction', direction,
    '--format', format, ...(search ? ['--search', search] : [])]);
const header = (row, scene = '群聊') => `${row.direction.toUpperCase()} ${new Date(row.occurred_at).toLocaleString('en-US', { timeZone: 'UTC' })}  ${row.external_id.slice(0, 8)}...  ${scene}`;

test('real messages CLI represents media references faithfully without inventing readiness or mutating source data', async t => {
  const entries = cases(), f = fixture(t, entries), before = snapshot(f), ordered = [...entries].reverse();
  const rows = JSON.parse(messages(f, 'json')), terminal = messages(f, 'text');
  assert.deepEqual(rows.map(row => row.id), ordered.map(value => value.row.id), 'every selected row retains its original position');
  const counts = { captured: 0, enriching: 0, ready: 0, blocked: 0 }, reasons = {};
  for (const [index, expected] of ordered.entries()) {
    const row = rows[index], stored = expected.row;
    counts[expected.state]++;
    for (const reason of row.readiness.reasons) reasons[reason] = (reasons[reason] || 0) + 1;
    await t.test(expected.label, () => {
    for (const key of ['id', 'source_id', 'record_type', 'external_id', 'actor_id', 'container_id', 'direction',
      'occurred_at', 'occurred_at_ms', 'raw_json', 'canonical_json', 'body']) {
      assert.equal(row[key], stored[key], `${expected.label}: ${key}`);
    }
    assert.deepEqual(row.raw, JSON.parse(stored.raw_json), `${expected.label}: native raw remains exact`);
    assert.deepEqual(row.canonical, JSON.parse(stored.canonical_json), `${expected.label}: canonical remains exact`);
    assert.equal(row.display.body, stored.body, `${expected.label}: display.body contract stays unchanged`);
    assert.equal(row.display.scene, expected.scene, `${expected.label}: conversation scene`);
    assert.equal(row.readiness.state, expected.state, expected.label);
    if (expected.reason) assert(row.readiness.reasons.includes(expected.reason), `${expected.label}: ${row.readiness.reasons}`);
    else assert.deepEqual(row.readiness.reasons, [], expected.label);
    const start = terminal.indexOf(header(stored, expected.scene));
    const end = index + 1 < ordered.length ? terminal.indexOf(header(ordered[index + 1].row, ordered[index + 1].scene)) : terminal.length;
    assert(start >= 0 && end > start, `${expected.label}: stable terminal position`);
    const block = terminal.slice(start, end);
    if (expected.mediaState) {
      assert.equal(row.display.scene, '群聊', expected.label);
      const content = row.readiness.requirements.find(item => item.field === 'content');
      assert.equal(content.state, 'blocked', expected.label);
      assert.equal(content.reason, expected.reason, expected.label);
      assert.equal(row.readiness.next_action, 'review_content', expected.label);
      assert.deepEqual(row.display.media, { type: expected.type, text: textFor(expected.type, expected.mediaState), status: 'partial',
        reason: expected.reason.replace('content_', 'media_'), version: 1,
        resource: { kind: expected.type === 'image' ? 'image_key' : 'file_key',
          key: expected.mediaState === 'reference_only' ? expected.key : null,
          state: expected.mediaState, availability: expected.type==='sticker'&&expected.mediaState==='reference_only'?'unsupported':'unverified' } }, expected.label);
      assert(block.includes(`\n  类型    ${expected.type === 'image' ? '图片' : '贴纸'}\n  资源    ${textFor(expected.type, expected.mediaState)}\n  查看`), expected.label);
      assert(block.includes('\n  状态    准备受阻\n'), expected.label);
      if (typeof expected.key === 'string' && expected.key.length > 1) assert(!block.includes(expected.key), `${expected.label}: resource identifier stays out of terminal`);
      assert(!block.includes(stored.body), `${expected.label}: stored fallback is not misrepresented as complete content`);
    } else {
      assert.equal(row.display.media, undefined, expected.label);
      assert(!block.includes('\n  资源    '), expected.label);
      if (expected.state === 'ready') {
        assert(block.includes(`\n  发送人  ${NAME}\n  群      ${TITLE}\n`), expected.label);
        assert(block.includes(stored.body), expected.label);
        assert(!block.includes('\n  状态    '), expected.label);
      }
    }
    });
  }
  assert(!terminal.includes('INVENTED_OCR_MUST_NOT_APPEAR'));
  assert(!terminal.includes('https://example.invalid/'));
  assert(!terminal.includes('\u001b'));
  assert(terminal.length < 40_000, 'invalid/oversized resources do not expand the terminal output');
  assert(terminal.startsWith(`Messages (${entries.length})\n完整 ${counts.ready} · 待补全 ${counts.enriching} · 受阻 ${counts.blocked}\n\n`));
  const qualityUrl = pathToFileURL(join(ROOT, 'src/diagnostics/lark-im-quality-report.mjs')).href;
  const quality = JSON.parse(run(f, ['--input-type=module', '-e', `import {collectQualityReport} from ${JSON.stringify(qualityUrl)};process.stdout.write(JSON.stringify(collectQualityReport(process.argv[1])));`, f.db]));
  assert.deepEqual(quality.completeness.counts, counts, 'quality preserves the same complete/incomplete denominator');
  for (const [reason, count] of Object.entries(reasons)) assert.equal(quality.completeness.reasons[reason], count, reason);
  assert.deepEqual(JSON.parse(messages(f, 'json', { limit: 1 })), [rows[0]], 'limit=1 retains the latest blocked row');
  assert(messages(f, 'text', { limit: 1 }).includes(header(ordered[0].row)));
  for (const direction of ['sent', 'received']) assert.deepEqual(
    JSON.parse(messages(f, 'json', { direction })), rows.filter(row => row.direction === direction), `${direction} filter`);
  assert.deepEqual(JSON.parse(messages(f, 'json', { search: 'STORED_MEDIA_SEARCH' })),
    rows.filter(row => row.body.includes('STORED_MEDIA_SEARCH')), 'search remains based on original stored body');
  assert.deepEqual(JSON.parse(messages(f, 'json', { search: 'synthetic_sent_resource_key' })), [],
    'display/raw resource identifiers are not silently added to the search contract');
  assert.deepEqual(snapshot(f), before, 'messages and quality do not change DB bytes, clocks, schema, rows or directory files');
});
