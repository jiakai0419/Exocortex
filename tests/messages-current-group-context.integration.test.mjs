import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ensureInitialized, quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';

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
  assert.equal((text.match(/当前本地标题来源\s+会话配置；观察时间未知/g) || []).length, 3);
  assert.match(text, /current local\s+title: Synthetic Cedar Workshop/);
  assert.doesNotMatch(text, /2058-06-13|2058-06-14/, 'scope bookkeeping timestamps are not title observation evidence');
  assert.deepEqual(f.run('json'), json, 'text projection does not change a later JSON read');
});

test('explicit historical group names and existing adopted sender names retain precedence', t => {
  const f = fixture(t, [
    { key: 'explicit', parameters: { ...PARAMETERS, group_name: 'Synthetic Historical Studio' } },
    { key: 'adopted_sender', native: {
      sender: { id: 'ou_synthetic_current_actor', id_type: 'open_id', sender_type: 'user', name: 'Synthetic API Name' },
    }, canonical: { sender_name: 'Synthetic Adopted Name', sender_name_source: 'chat_member', sender_name_confidence: 'high' } },
  ]);
  const json = f.run('json');
  const explicit = json.find(row => row.external_id === 'om_synthetic_current_explicit');
  assert.equal(explicit.display.body, 'Synthetic Alder, Synthetic Birch joined Synthetic Historical Studio. New members can view all chat history.');
  assert.equal(explicit.display.system.status, 'rendered');
  assert.deepEqual(explicit.display.system.missing_parameters, []);
  assert.deepEqual(explicit.display.system.context_parameters, []);
  assert.equal(explicit.display.system.context_status, 'not_applied');
  assert.equal(explicit.display.system.current_group_context, null);
  const adopted = json.find(row => row.external_id === 'om_synthetic_current_adopted_sender');
  assertCurrentContext(adopted);
  // Current-title display cannot resolve a separate API/client name dispute
  // or replace an already adopted canonical name with a raw sender value.
  assert.equal(adopted.display.sender, 'Synthetic Adopted Name');
  assert.equal(adopted.raw.sender.name, 'Synthetic API Name');
  const text = f.run('text');
  assert.equal((text.match(/当前本地标题来源\s+会话配置；观察时间未知/g) || []).length, 1);
  assert.match(text, /Synthetic Historical Studio/);
  assert.match(text, /Synthetic Adopted Name/);
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
