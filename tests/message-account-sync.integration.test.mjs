import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../bin/exocortex.mjs';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';
import { chatScopeId, recordFromMessage } from '../src/adapters/lark-im/core.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { readMessageAccountEvidence } from '../src/adapters/lark-im/message-account-evidence.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { syncNames } from '../src/adapters/lark-im/name-sync.mjs';
import { readRemoteAccountBinding } from '../src/diagnostics/remote-account-binding.mjs';
import { tryAcquireLarkApiLease } from '../src/runtime/lark-api-lease.mjs';
import { quoteSql, sqliteExec, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';

// Every source item is invented. Use actual admission, adapter normalization,
// sync command, store and messages CLI; only remote API answers are simulated.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AT = Date.UTC(2025, 5, 12, 8, 0), END = AT + 600_000;
const SELF = { open_id: 'ou_synthetic_account_sync_self', name: 'Invented Acquisition Owner' };
const OTHER = { open_id: 'ou_synthetic_account_sync_other', name: 'Invented Other Owner' };
const CHAT = 'oc_synthetic_account_sync_private', SCOPE = chatScopeId(CHAT), ACCOUNT = recipientAccountKey(SELF.open_id);
const hash = value => createHash('sha256').update(value).digest('hex');
const dates = ['--start', new Date(AT).toISOString(), '--end', new Date(END).toISOString()];
const envelope = items => ({ code: 0, data: { items, has_more: false } });

function source(label, { name = 'Invented Native Peer', merge = false } = {}) {
  return { message_id: `om_synthetic_account_sync_${label}`, chat_id: CHAT, chat_type: 'p2p',
    msg_type: merge ? 'merge_forward' : 'text', create_time: String(AT + 60_000), update_time: String(AT + 60_001),
    sender: { id: `ou_synthetic_account_sync_${label}`, id_type: 'open_id', sender_type: 'user', ...(name ? { name } : {}) },
    body: { content: merge ? '{}' : JSON.stringify({ text: `Authored acquisition body ${label}; preserve  spacing.` }) } };
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-account-sync-synthetic-'));
  const f = { dir, db: join(dir, 'synthetic.sqlite'), profile: SELF, items: [], calls: [], unexpected: [], detailFails: false };
  const reject = () => { throw new Error('synthetic account integration forbids network'); };
  const originalFetch = globalThis.fetch, originalConnect = Socket.prototype.connect;
  globalThis.fetch = reject; Socket.prototype.connect = reject;
  t.after(() => {
    globalThis.fetch = originalFetch; Socket.prototype.connect = originalConnect;
    try { assert.deepEqual(f.unexpected, []); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  writeFileSync(join(dir, 'deny-network.mjs'), `import {Socket} from 'node:net';
const deny=()=>{throw Error('synthetic messages attempted network');};globalThis.fetch=deny;Socket.prototype.connect=deny;\n`);
  writeFileSync(join(dir, 'reject-lark'), `#!/bin/sh\nprintf called > '${dir}/unexpected-cli'\nexit 97\n`, { mode: 0o700 });
  f.remote = args => {
    const p = args.includes('--params') ? JSON.parse(args[args.indexOf('--params') + 1]) : {};
    if (args[0] === 'contact' && args[1] === '+get-user') { f.calls.push('self'); return f.profile; }
    if (args[0] === 'im' && args[1] === '+chat-list') {
      f.calls.push('discovery'); return { chats: [{ chat_id: CHAT, chat_type: 'p2p', name: 'Invented Private Conversation' }], has_more: false };
    }
    if (args[0] === 'api' && args[1] === 'GET' && args[2] === '/open-apis/im/v1/messages') {
      assert.equal(p.container_id, CHAT); f.calls.push('list');
      return envelope(f.items.filter(item => Number(item.create_time) >= Number(p.start_time) * 1000
        && Number(item.create_time) <= Number(p.end_time) * 1000));
    }
    if (args[0] === 'api' && args[1] === 'GET' && args[2].startsWith('/open-apis/im/v1/messages/')) {
      const id = decodeURIComponent(args[2].split('/').at(-1)), root = f.items.find(item => item.message_id === id);
      assert(root); f.calls.push('detail');
      if (f.detailFails) throw Error('invented temporarily unavailable detail');
      return envelope([root, { ...source('child'), upper_message_id: root.message_id }]);
    }
    if (args[0] === 'contact' && args[1] === '+search-user'
      || args[0] === 'im' && args[1] === 'chat.members' && args[2] === 'get') {
      f.calls.push('failed-name'); throw Error('lark-cli failed: kind=permission_denied; invented name lookup denied');
    }
    if (args[0] === 'im' && args[1] === 'chats' && args[2] === 'get') {
      f.calls.push('chat'); return { data: { chat_id: CHAT, chat_mode: 'p2p', name: 'Invented Private Conversation' } };
    }
    f.unexpected.push(args.slice(0, 3)); throw Error('unexpected synthetic adapter route');
  };
  f.adapter = createLarkImAdapter({ run: f.remote });
  f.deps = { getSelfProfile: f.adapter.getSelfProfile,
    tryAcquireLarkApiLease: options => tryAcquireLarkApiLease(options, { directory: join(dir, 'api-state') }),
    syncRunnerDeps: { ...f.adapter, syncNames: (db, self) => syncNames(db, self, { runLark: f.remote }) },
    fetchChatMessages: f.adapter.fetchChatMessages };
  return f;
}

async function invoke(f, args) {
  let stdout = '', stderr = '';
  const code = await runCli(args, { root: ROOT, cwd: f.dir, env: {},
    stdout: { write: text => stdout += text }, stderr: { write: text => stderr += text }, deps: f.deps });
  assert.equal(stderr, '');
  return { code, report: JSON.parse(stdout) };
}
const sync = (f, scope) => invoke(f, ['sync', '--db', f.db, '--scope', scope, ...dates, '--chat-types', 'p2p', '--retries', '1']);
const replay = f => invoke(f, ['maintenance', 'replay', '--db', f.db, '--scope-id', SCOPE, ...dates, '--apply']);
const stored = f => sqliteQuery(f.db, 'SELECT * FROM records ORDER BY external_id;');
function proof(row) { return readMessageAccountEvidence(row, JSON.parse(row.canonical_json), JSON.parse(row.raw_json)); }
function businessSnapshot(f) {
  return Object.fromEntries(['sources', 'sync_scopes', 'records', 'sync_runs', 'lark_im_list_progress', 'lark_im_detail_tasks',
    'lark_im_name_tasks', 'lark_im_name_scan', 'bounded_replay_runs'].map(table => [table, sqliteQuery(f.db, `SELECT * FROM ${table} ORDER BY rowid;`)]));
}
function actualMessages(f, search = '') {
  const before = businessSnapshot(f), bytes = hash(readFileSync(f.db)), calls = [...f.calls];
  const run = format => {
    const result = spawnSync(process.execPath, ['--import', join(f.dir, 'deny-network.mjs'), join(ROOT, 'bin/exocortex.mjs'),
      'messages', '--db', f.db, '--format', format, '--limit', '10', '--search', search], { cwd: f.dir,
      env: { ...process.env, LARK_CLI: join(f.dir, 'reject-lark'), NO_COLOR: '1' }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(result.stderr, '');
    return result.stdout;
  };
  const rows = JSON.parse(run('json')), text = run('text');
  assert.equal(existsSync(join(f.dir, 'unexpected-cli')), false);
  assert.deepEqual(businessSnapshot(f), before); assert.equal(hash(readFileSync(f.db)), bytes); assert.deepEqual(f.calls, calls);
  return { rows, text };
}
async function discover(f) {
  const result = await sync(f, 'discover'); assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(readRemoteAccountBinding({ db: f.db, selfOpenId: SELF.open_id }).state, 'verified');
}

test('current admitted list binds exact acquisition even when sender-name lookup fails; real received display still identifies self', async t => {
  const f = fixture(t), known = source('known'), failed = source('failed', { name: null });
  f.items = [known, failed]; await discover(f);
  const start = Date.now(), result = await sync(f, 'received');
  assert.equal(result.code, 0, JSON.stringify(result));
  assert(f.calls.includes('list')); assert(f.calls.includes('failed-name'));
  const records = stored(f); assert.equal(records.length, 2);
  for (const row of records) {
    const evidence = proof(row); assert(evidence, 'a current admitted source response must carry valid ownership');
    assert.equal(evidence.account_key, ACCOUNT); assert.equal(evidence.source_hash, hash(row.raw_json));
    assert.equal(evidence.source_version, row.external_version);
    assert(Date.parse(evidence.acquired_at) >= start && Date.parse(evidence.acquired_at) <= Date.now());
    const raw = JSON.parse(row.raw_json);
    assert.deepEqual(raw.raw_api || raw, f.items.find(item => item.message_id === row.external_id));
  }
  const missing = records.find(row => row.external_id === failed.message_id), canonical = JSON.parse(missing.canonical_json);
  assert.equal(canonical.sender_name, null); assert.equal(canonical.sender_name_verification.status, 'failed');
  const { rows, text } = actualMessages(f);
  const ready = rows.find(row => row.external_id === known.message_id), waiting = rows.find(row => row.external_id === failed.message_id);
  assert.equal(ready.display.sender, known.sender.name); assert.equal(ready.display.recipient, '我');
  assert.equal(ready.readiness.state, 'ready'); assert.match(text, /  接收人  我/);
  assert.equal(waiting.display.recipient, '我', 'ownership is independent from successful sender naming');
  assert.equal(waiting.readiness.state, 'enriching'); assert.deepEqual(waiting.readiness.reasons, ['sender_name_missing']);
  assert.equal(waiting.readiness.requirements.find(x => x.field === 'recipient').state, 'satisfied');
  assert.match(text, /等待完整信息/); assert.equal(rows.length, 2);
});

test('standalone detail acquisition creates exact proof after durable retry debt without a new list request', async t => {
  const f = fixture(t), root = source('detail', { name: null, merge: true });
  f.items = [root]; f.detailFails = true; await discover(f);
  const first = await sync(f, 'received'); assert.equal(first.code, 2, JSON.stringify(first));
  assert.equal(stored(f).length, 0);
  assert.equal(sqliteQuery(f.db, "SELECT COUNT(*) AS n FROM lark_im_detail_tasks WHERE status='pending';")[0].n, 1);
  sqliteExec(f.db, "UPDATE lark_im_detail_tasks SET retry_at='2000-01-01T00:00:00.000Z';");
  f.detailFails = false; const before = f.calls.length, start = Date.now(), second = await sync(f, 'details');
  assert.equal(second.code, 0, JSON.stringify(second));
  assert(!f.calls.slice(before).includes('list')); assert(f.calls.slice(before).includes('detail'));
  const [row] = stored(f), evidence = proof(row); assert(evidence);
  assert.equal(evidence.account_key, ACCOUNT); assert(Date.parse(evidence.acquired_at) >= start);
  assert.equal(row.external_id, root.message_id); assert.equal(row.external_version, root.update_time);
  const raw = JSON.parse(row.raw_json), native = raw.raw_api || raw;
  for (const field of Object.keys(root)) assert.deepEqual(native[field], root[field], field);
  assert.equal(sqliteQuery(f.db, "SELECT COUNT(*) AS n FROM lark_im_detail_tasks WHERE status='pending';")[0].n, 0);
  const { rows, text } = actualMessages(f);
  assert.equal(rows.length, 1); assert.equal(rows[0].display.recipient, '我');
  assert.equal(rows[0].canonical.sender_name, null); assert.equal(rows[0].readiness.state, 'enriching');
  assert.deepEqual(rows[0].readiness.reasons, ['sender_name_missing']); assert.match(text, /等待完整信息/);
});

test('public maintenance replay binds only its newly fetched source and repairs legacy private ownership', async t => {
  const f = fixture(t), current = source('current'), legacy = source('legacy');
  f.items = [current]; await discover(f); assert.equal((await sync(f, 'received')).code, 0);
  const original = stored(f)[0], originalProof = proof(original); assert(originalProof);
  const old = recordFromMessage(normalizeApiMessage(legacy), SCOPE, 'received', { self: SELF }, { chat_id: CHAT, chat_type: 'p2p' });
  assert.equal(JSON.parse(old.canonical_json).message_account_evidence, undefined);
  const columns = Object.keys(old);
  sqliteExec(f.db, `INSERT INTO records(${columns.join(',')}) VALUES(${columns.map(column => old[column] === null ? 'NULL' : quoteSql(old[column])).join(',')});`);
  const beforeRead = actualMessages(f, 'body legacy');
  assert.equal(beforeRead.rows.length, 1); assert.equal(beforeRead.rows[0].readiness.state, 'enriching');
  assert.deepEqual(beforeRead.rows[0].readiness.reasons, ['account_unknown']);
  assert.match(beforeRead.text, /等待完整信息/);
  f.items = [current, legacy];
  const callsBefore = f.calls.length, replayStarted = Date.now();
  const result = await replay(f); assert.equal(result.code, 0, JSON.stringify(result));
  const after = stored(f), retained = after.find(row => row.external_id === current.message_id), unbound = after.find(row => row.external_id === legacy.message_id);
  assert(f.calls.slice(callsBefore).includes('list'), 'the original admitted remote source request actually ran');
  assert.deepEqual(proof(retained), originalProof, 'an otherwise identical source replay retains the earlier observation');
  assert.equal(proof(unbound)?.account_key, ACCOUNT);
  assert(Date.parse(proof(unbound).acquired_at) >= replayStarted);
  for (const field of ['body', 'raw_json', 'external_version', 'content_hash', 'occurred_at', 'occurred_at_ms', 'actor_id', 'container_id']) {
    assert.equal(retained[field], original[field], field); assert.equal(unbound[field], old[field], field);
  }
  const { rows } = actualMessages(f);
  const valid = rows.find(row => row.external_id === current.message_id), unknown = rows.find(row => row.external_id === legacy.message_id);
  assert.equal(valid.display.recipient, '我'); assert.equal(valid.readiness.state, 'ready');
  assert.equal(unknown.readiness.state, 'ready');
  assert.deepEqual(unknown.readiness.reasons, []);
  const recipient = unknown.readiness.requirements.find(item => item.field === 'recipient');
  assert.equal(recipient.state, 'satisfied'); assert.equal(recipient.reason, null);
  const onlyLegacy = actualMessages(f, 'body legacy');
  assert.equal(onlyLegacy.rows.length, 1); assert.equal(onlyLegacy.rows[0].external_id, legacy.message_id);
  assert.doesNotMatch(onlyLegacy.text, /等待完整信息/); assert.match(onlyLegacy.text, /  接收人  我/);
});

test('another current account is refused by real command admission before any list/detail or business mutation', async t => {
  const f = fixture(t); f.items = [source('bound')]; await discover(f);
  assert.equal((await sync(f, 'received')).code, 0);
  const before = businessSnapshot(f), storedProof = proof(stored(f)[0]); f.profile = OTHER;
  for (const scope of ['received', 'details']) {
    const calls = f.calls.length, result = await sync(f, scope);
    assert.equal(result.code, 1); assert.match(result.report.error.message, /account conflicts/);
    assert.deepEqual(f.calls.slice(calls), ['self']); assert.deepEqual(businessSnapshot(f), before);
    assert.deepEqual(proof(stored(f)[0]), storedProof);
  }
  const { rows } = actualMessages(f); assert.equal(rows[0].display.recipient, '我');
  assert.equal(rows[0].readiness.state, 'ready', 'the accepted stored account remains authoritative, not the failed current login');
});
