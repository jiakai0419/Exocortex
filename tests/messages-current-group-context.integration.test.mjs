import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCli } from '../bin/exocortex.mjs';
import { ensureInitialized, quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { plain } from '../dist/terminal/index.js';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { renderMessagesText } from '../src/terminal/messages-view.mjs';
import { textWidth } from '../src/terminal/text-layout.mjs';

// Invented inputs only. The native system message intentionally has no title
// or conversation type; these are separately bound local scope metadata.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AT = Date.UTC(2058, 5, 12, 13, 14, 15);
const CHAT = 'oc_synthetic_current_context';
const OTHER_CHAT = 'oc_synthetic_other_context';
const TITLE = 'Synthetic Cedar Workshop';
const TEMPLATE = '{to_chatters} joined {group_name}. New members can view all chat history.';
const PARAMETERS = { template: TEMPLATE, to_chatters: ['Synthetic Alder', 'Synthetic Birch'] };
const EXPECTED = `Synthetic Alder, Synthetic Birch joined this group (current local title: ${TITLE}). New members can view all chat history.`;
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t, entries) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-current-group-synthetic-'));
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
`);
  ensureInitialized(db);
  const records = entries.map(({ key, parameters = PARAMETERS, native = {}, config: changes = {}, canonical = {}, mutate }) => {
    const scope = `lark.im.received.chat.synthetic_current_${key}`;
    const config = {
      chat_id: CHAT, chat_type: 'group', chat_name: TITLE,
      // Neither scheduling/config timestamps nor message time are evidence of
      // when this title was observed. They must never become observed_at.
      updated_at: '2058-06-13T14:15:16.000Z', hot_seen_at: '2058-06-14T15:16:17.000Z',
      ...changes,
    };
    sqliteExec(db, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${quoteSql(scope)},'lark.im',${quoteSql(`Synthetic context ${key}`)},${quoteSql(JSON.stringify(config))});`);
    const raw = {
      message_id: `om_synthetic_current_${key}`, chat_id: CHAT, msg_type: 'system',
      create_time: String(AT), update_time: String(AT),
      body: { content: JSON.stringify(parameters) }, ...native,
    };
    const row = recordFromMessage(normalizeApiMessage(raw), scope, 'received', {}, config);
    row.canonical_json = JSON.stringify({ ...JSON.parse(row.canonical_json), ...canonical });
    mutate?.(row);
    const fields = Object.keys(row);
    sqliteExec(db, `INSERT INTO records(${fields.join(',')}) VALUES(${fields.map(field => row[field] === null ? 'NULL'
      : typeof row[field] === 'number' ? String(row[field]) : quoteSql(row[field])).join(',')});`);
    return row;
  });
  sqliteExec(db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  const before = hash(readFileSync(db));
  const run = format => {
    const env = { ...process.env, NO_COLOR: '1', TZ: 'UTC', LARK_CLI: cli, SYNTHETIC_NETWORK_MARKER: marker };
    delete env.FORCE_COLOR;
    const result = spawnSync(process.execPath, ['--import', guard, join(ROOT, 'bin/exocortex.mjs'),
      'messages', '--db', db, '--format', format, '--limit', '100'], {
      cwd: dir, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 5 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    assert.equal(existsSync(marker), false, 'messages must not invoke Lark, fetch, or a network socket');
    assert.equal(hash(readFileSync(db)), before, 'display-only projection must preserve database bytes');
    if (format !== 'json') return result.stdout;
    const output = JSON.parse(result.stdout);
    assert.equal(output.length, records.length);
    for (const stored of records) {
      const got = output.find(row => row.external_id === stored.external_id);
      assert.ok(got, stored.external_id);
      for (const field of ['body', 'raw_json', 'canonical_json']) {
        assert.equal(got[field], stored[field], `${stored.external_id}: ${field}`);
      }
      assert.deepEqual(got.raw, JSON.parse(stored.raw_json));
      assert.deepEqual(got.canonical, JSON.parse(stored.canonical_json));
    }
    return output;
  };
  return { records, run };
}

function assertCurrentContext(row, type = 'group') {
  assert.equal(row.display.body, EXPECTED);
  assert.equal(row.display.system.status, 'partial');
  assert.equal(row.display.system.reason, 'system_parameters_missing');
  assert.deepEqual(row.display.system.missing_parameters, ['group_name']);
  assert.deepEqual(row.display.system.context_parameters, []);
  assert.equal(row.display.system.context_source, null);
  assert.equal(row.display.system.context_time_basis, null);
  assert.equal(row.display.system.context_status, 'current_context_applied');
  assert.deepEqual(row.display.system.current_group_context, {
    chat_id: CHAT, chat_type: type, name: TITLE,
    source: 'scope_config', time_basis: 'current_local', observed_at: null,
  });
  assert.equal(row.canonical.content_rendering.status, 'partial');
  assert.match(row.body, /\[未知参数：group_name\]/, 'stored historical missing-parameter evidence remains');
  assert.equal(Object.hasOwn(row.raw, 'chat_name'), false);
  assert.equal(Object.hasOwn(row.raw, 'chat_type'), false);
  assert.equal(row.display.scene, type === 'topic' ? '话题群' : '群聊');
  assert.equal(row.readiness.state, 'enriching');
  assert.deepEqual(row.readiness.reasons, ['content_partial']);
  assert.deepEqual(row.readiness.requirements.find(item => item.field === 'content'),
    { field: 'content', state: 'missing', reason: 'content_partial', evidence: null });
}

test('offline messages labels current group/topic titles for the native to_chatters template without repairing history', t => {
  const f = fixture(t, [
    { key: 'group' },
    { key: 'topic', config: { chat_type: 'topic' } },
    { key: 'topic_mode', config: { chat_type: 'public', chat_mode: 'topic' }, canonical: { chat_type: 'topic' } },
  ]);
  const json = f.run('json');
  const byId = new Map(json.map(row => [row.external_id, row]));
  assertCurrentContext(byId.get('om_synthetic_current_group'));
  assertCurrentContext(byId.get('om_synthetic_current_topic'), 'topic');
  assertCurrentContext(byId.get('om_synthetic_current_topic_mode'), 'topic');
  const text = f.run('text');
  const blocks = text.trimEnd().split('\n\n');
  assert.equal(blocks.length, 4);
  assert.equal(blocks[0], 'Messages (3)\n完整 0 · 待补全 3 · 受阻 0');
  for (const [index, row] of json.entries()) {
    assert.equal(blocks[index + 1], `RECEIVED ${new Date(row.occurred_at).toLocaleString('en-US', { timeZone: 'UTC' })}  om_synth...  ${row.display.scene}\n  状态    等待完整信息\n  原因    消息内容未完整解析\n  查看    messages --format json 可检查已保存内容与原因`,
      'a current local title does not turn missing historical event parameters into a complete message');
  }
  assert.doesNotMatch(text, /当前本地标题来源|current local title:/);
  assert.doesNotMatch(text, /2058-06-13|2058-06-14/, 'scope bookkeeping timestamps are not title observation evidence');
  assert.deepEqual(f.run('json'), json, 'text projection does not change a later JSON read');
});

test('real messages CLI retains partial provenance in JSON and wraps its exception beside a complete neighbour at narrow widths', async t => {
  const f = fixture(t, [{ key: 'narrow_columns' }, { key: 'ready_neighbour',
    parameters: { ...PARAMETERS, group_name: 'Synthetic Historical Studio' },
    native: { create_time: String(AT + 1000), update_time: String(AT + 1000) } }]);
  const messages = f.run('json');
  const before = JSON.stringify(messages);
  assert.equal(messages[0].external_id, 'om_synthetic_current_ready_neighbour');
  assert.equal(messages[0].readiness.state, 'ready');
  assert.equal(messages[0].display.system.status, 'rendered');
  assert.deepEqual(messages[0].display.system.missing_parameters, []);
  assert.equal(messages[0].display.system.current_group_context, null);
  assertCurrentContext(messages[1]);
  function writer(columns) {
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
    stream.columns = columns;
    stream.isTTY = false;
    return { stream, text: () => plain(output) };
  }
  async function run(columns, format) {
    const stdout = writer(columns), stderr = writer(columns);
    const code = await runCli(['messages', '--db', '/synthetic/narrow-never-opened.sqlite', '--format', format], {
      stdout: stdout.stream, stderr: stderr.stream,
      messagesDeps: {
        resolvePath: () => '/synthetic/narrow-never-opened.sqlite', existsSync: () => true,
        readLocalChatAppNames: () => null, loadMessages: () => messages,
      },
    });
    assert.equal(JSON.stringify(messages), before, 'CLI rendering preserves body, raw and canonical inputs');
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  }
  for (const columns of [20, 19, 1, 21]) {
    await t.test(`stream columns ${columns}`, async () => {
      const json = await run(columns, 'json');
      assert.equal(json.code, 0, json.stderr);
      assert.equal(json.stderr, '');
      assert.deepEqual(JSON.parse(json.stdout), messages, 'JSON is independent of terminal width');
      const text = await run(columns, 'text');
      assert.equal(text.code, 0, text.stderr);
      assert.equal(text.stderr, '');
      assert.match(text.stdout, /Messages \(2\)/);
      const lines = text.stdout.split('\n');
      for (const line of lines) {
        assert.ok(textWidth(line) <= Math.max(20, columns), `${textWidth(line)} cells at ${columns} columns: ${line}`);
      }
      const blocks = text.stdout.trimEnd().split('\n\n');
      assert.equal(blocks.length, 3, 'ready neighbour and partial exception retain separate selected positions');
      const readyLines = blocks[1].split('\n');
      const bodyIndex = readyLines.findIndex(line => line.startsWith('  消息    '));
      assert.ok(bodyIndex >= 0, 'the complete historical message keeps its ordinary body field');
      const bodyLines = readyLines.slice(bodyIndex);
      assert.equal(bodyLines.map((line, index) => line.slice(index ? 10 : 8)).join(''), messages[0].display.body,
        'normal narrow wrapping preserves the whole source body and its spaces');
      const exception = blocks[2].replace(/\s/gu, '');
      assert.ok(exception.includes('状态等待完整信息'));
      assert.ok(exception.includes('原因消息内容未完整解析'));
      assert.doesNotMatch(blocks[2], /\n  消息|当前本地标题来源/);
    });
  }
  assert.deepEqual(f.run('json'), messages, 'all narrow text reads preserve database bytes and a later JSON read');
});

test('low-level renderer still stacks a long current-title provenance label without asserting message readiness', () => {
  // A fictional presentation model isolates the retained formatter contract.
  // This is not a ready message or a normal CLI publication of partial content.
  const presentation = { direction: 'received', occurred_at: new Date(AT).toISOString(), raw: {}, display: {
    external_id: 'om_synth...', scene: '群聊', sender: '系统', sender_type: 'system', message_type: '系统',
    recipient: null, chat: TITLE, body: EXPECTED,
    system: { current_group_context: { chat_id: CHAT, name: TITLE, source: 'scope_config', observed_at: null } },
  } };
  assert.equal(Object.hasOwn(presentation, 'readiness'), false);
  for (const columns of [20, 19, 1, 21]) {
    const lines = plain(renderMessagesText([presentation], { columns })).split('\n');
    for (const line of lines) assert.ok(textWidth(line) <= Math.max(20, columns));
    const source = lines.indexOf('  当前本地标题来源');
    assert.ok(source >= 0, 'the long provenance label occupies its own line');
    const nextField = lines.findIndex((line, index) => index > source && line.startsWith('  类型 '));
    assert.ok(nextField > source + 1, 'the provenance value follows below its label');
    const values = lines.slice(source + 1, nextField);
    assert.ok(values.every(line => line.startsWith('    ')), 'stacked values retain their hanging indentation');
    assert.equal(values.map(line => line.slice(4)).join(''), '会话配置；观察时间未知');
  }
});

test('explicit historical group names and existing adopted sender names retain precedence', t => {
  const f = fixture(t, [
    { key: 'explicit', parameters: { ...PARAMETERS, group_name: 'Synthetic Historical Studio' } },
    { key: 'adopted_sender', native: {
      sender: { id: 'ou_synthetic_current_actor', id_type: 'open_id', sender_type: 'user', name: 'Synthetic API Name' },
    }, canonical: { sender_name: 'Synthetic Adopted Name', sender_name_source: 'chat_member', sender_name_confidence: 'high',
      sender_name_account_key: recipientAccountKey('ou_synthetic_current_owner') } },
    { key: 'adopted_complete', parameters: { ...PARAMETERS, group_name: 'Synthetic Historical Studio' }, native: {
      sender: { id: 'ou_synthetic_current_actor', id_type: 'open_id', sender_type: 'user', name: 'Synthetic API Name' },
    }, canonical: { sender_name: 'Synthetic Adopted Name', sender_name_source: 'chat_member', sender_name_confidence: 'high',
      sender_name_account_key: recipientAccountKey('ou_synthetic_current_owner') } },
  ]);
  const json = f.run('json');
  const explicit = json.find(row => row.external_id === 'om_synthetic_current_explicit');
  assert.equal(explicit.display.body, 'Synthetic Alder, Synthetic Birch joined Synthetic Historical Studio. New members can view all chat history.');
  assert.equal(explicit.display.system.status, 'rendered');
  assert.deepEqual(explicit.display.system.missing_parameters, []);
  assert.deepEqual(explicit.display.system.context_parameters, []);
  assert.equal(explicit.display.system.context_status, 'not_applied');
  assert.equal(explicit.display.system.current_group_context, null);
  assert.equal(explicit.readiness.state, 'ready');
  const adopted = json.find(row => row.external_id === 'om_synthetic_current_adopted_sender');
  assertCurrentContext(adopted);
  // Current-title display cannot resolve a separate API/client name dispute
  // or replace an already adopted canonical name with a raw sender value.
  assert.equal(adopted.display.sender, 'Synthetic Adopted Name');
  assert.equal(adopted.raw.sender.name, 'Synthetic API Name');
  const complete = json.find(row => row.external_id === 'om_synthetic_current_adopted_complete');
  assert.equal(complete.readiness.state, 'ready');
  assert.equal(complete.display.sender, 'Synthetic Adopted Name');
  assert.equal(complete.raw.sender.name, 'Synthetic API Name');
  const text = f.run('text');
  assert.doesNotMatch(text, /当前本地标题来源/);
  assert.match(text, /Synthetic Historical Studio/);
  assert.match(text, /Synthetic Adopted Name/);
  assert.equal((text.match(/  状态    等待完整信息/g) || []).length, 1, 'the partial adopted-name record remains an exception');
  assert.deepEqual(f.run('json'), json);
});

test('current group labels require the exact template and consistent native/canonical/scope identity and time', t => {
  const cases = [
    { key: 'other_template', parameters: { template: '{to_chatters} renamed {group_name}.', to_chatters: ['Synthetic Alder'] } },
    { key: 'empty_parameter', parameters: { ...PARAMETERS, group_name: '' } },
    { key: 'null_parameter', parameters: { ...PARAMETERS, group_name: null } },
    { key: 'malformed_parameter', parameters: { ...PARAMETERS, group_name: { name: TITLE } } },
    { key: 'scope_chat_conflict', config: { chat_id: OTHER_CHAT } },
    { key: 'canonical_chat_conflict', canonical: { chat_id: OTHER_CHAT } },
    { key: 'record_chat_conflict', mutate: row => { row.container_id = OTHER_CHAT; } },
    { key: 'nested_chat_conflict', native: { chat: { id: OTHER_CHAT } } },
    { key: 'message_identity_conflict', mutate: row => { row.external_id = 'om_synthetic_current_other_identity'; } },
    { key: 'message_time_conflict', mutate: row => { row.occurred_at_ms += 1; } },
    { key: 'p2p', config: { chat_type: 'p2p' } },
    { key: 'native_p2p', native: { chat_type: 'p2p' }, canonical: { chat_type: 'group' } },
    { key: 'nested_p2p', native: { chat: { chat_type: 'p2p' } }, canonical: { chat_type: 'group' } },
    { key: 'canonical_p2p', canonical: { chat_type: 'p2p' } },
    { key: 'mode_conflict', config: { chat_type: 'topic' }, canonical: { chat_type: 'group' } },
    { key: 'unnormalized_public', config: { chat_type: 'public', chat_mode: 'topic' } },
    { key: 'empty_title', config: { chat_name: '' } },
    { key: 'missing_title', config: { chat_name: undefined } },
    { key: 'cleared_title', canonical: { chat_name_state: 'cleared' } },
    { key: 'non_native_source', canonical: { source_api: null } },
  ];
  const f = fixture(t, cases);
  for (const row of f.run('json')) {
    assert.match(row.display.body, /\[未知参数：group_name\]/, row.external_id);
    assert.equal(row.display.system.status, 'partial', row.external_id);
    assert.deepEqual(row.display.system.missing_parameters, ['group_name'], row.external_id);
    assert.deepEqual(row.display.system.context_parameters, [], row.external_id);
    assert.equal(row.display.system.context_source, null, row.external_id);
    assert.equal(row.display.system.context_time_basis, null, row.external_id);
    assert.equal(row.display.system.current_group_context, null, row.external_id);
    assert.notEqual(row.display.system.context_status, 'current_context_applied', row.external_id);
  }
  const text = f.run('text');
  assert.doesNotMatch(text, /current local title:|当前本地标题来源/);
});
