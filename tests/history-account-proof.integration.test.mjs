import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../bin/exocortex.mjs';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import { prepareChatWindowRecords } from '../src/adapters/lark-im/sync-runner.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { readMessageAccountEvidence } from '../src/adapters/lark-im/message-account-evidence.mjs';

// Fresh fictional records only. Exercise the real CLI, history selector,
// transport normalization, request-session budget, fenced store and renderer.
// Only the external process/lease boundary is simulated.
const START = Date.UTC(2025, 4, 6, 7), END = START + 60_000;
const SELF = { open_id: 'ou_synthetic_history_proof_owner', name: 'Invented History Owner' };
const OTHER = { open_id: 'ou_synthetic_history_proof_foreign', name: 'Invented Foreign Owner' };
const CHAT = 'oc_synthetic_history_proof_private', SCOPE = chatScopeId(CHAT);
const hash = text => createHash('sha256').update(text).digest('hex');
const ACCOUNT = hash(`lark.im\0${SELF.open_id}`), q = store.quoteSql;
const config = { chat_id: CHAT, chat_type: 'p2p' };

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-history-account-proof-')));
  chmodSync(dir, 0o700);
  const f = { dir, db: join(dir, 'synthetic.sqlite'), calls: [], tick: 0, held: false, mode: 'ok', selves: 0 };
  const originalFetch = globalThis.fetch, originalConnect = Socket.prototype.connect;
  const deny = () => { throw Error('synthetic history proof forbids real network'); };
  globalThis.fetch = deny; Socket.prototype.connect = deny;
  t.after(() => {
    globalThis.fetch = originalFetch; Socket.prototype.connect = originalConnect;
    rmSync(dir, { recursive: true, force: true });
  });
  store.ensureInitialized(f.db);
  const confirmed = new Date(START).toISOString();
  store.sqliteExec(f.db, `UPDATE sources SET config_json=${q(JSON.stringify({ initial_sync_start_ms: START,
    initial_account_binding: { kind: store.INITIAL_ACCOUNT_KIND, account_key: ACCOUNT,
      reserved_at: confirmed, confirmed_at: confirmed } }))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json,cursor_json) VALUES(${q(SCOPE)},'lark.im',
      'Invented historical private scope',${q(JSON.stringify(config))},${q(JSON.stringify({ created_at_ms: END }))});`);
  f.native = Array.from({ length: 2 }, (_, index) => ({
    message_id: `om_synthetic_history_proof_${index}`, chat_id: CHAT, chat_type: 'p2p', msg_type: 'text',
    create_time: String(START + 1_000 + index * 2_000), update_time: String(START + 1_001 + index * 2_000),
    sender: { id: `ou_synthetic_history_proof_peer_${index}`, id_type: 'open_id', sender_type: 'user', name: `Invented Native Peer ${index}` },
    body: { content: JSON.stringify({ text: `Authored historical paragraph ${index}; keep  double spaces.` }) },
  }));
  store.sqliteExec(f.db, store.upsertRecordsSql(prepareChatWindowRecords(f.native.map(item => normalizeApiMessage(item)),
    SCOPE, null, START, END, SELF.open_id, { self: SELF }, config)));
  f.query = sql => store.sqliteQuery(f.db, sql);
  f.records = () => f.query('SELECT * FROM records ORDER BY id;');
  f.deps = { requestSessionDeps: {
    env: { LARK_CLI: 'synthetic-history-proof-never-spawned' }, now: () => Date.now(), monotonicClock: () => f.tick,
    sleep: ms => { assert.equal(f.held, false); f.tick += ms; },
    tryAcquireLease: () => { assert.equal(f.held, false); f.held = true;
      return { state: 'acquired', release() { f.held = false; } }; },
    readSharedCooldown: () => ({ state: 'ready' }), writeSharedCooldown: () => true,
    spawnSync(_command, args) {
      assert.equal(f.held, true); f.calls.push(args); f.tick += 10;
      if (args[0] === 'contact' && args[1] === '+get-user') {
        f.selves++;
        const profile = f.mode === 'foreign' || f.mode === 'foreign-closing' && f.selves === 2 ? OTHER : SELF;
        return { status: 0, stdout: JSON.stringify(profile), stderr: '' };
      }
      assert.equal(args[0], 'api'); assert.equal(args[1], 'GET');
      const params = JSON.parse(args[args.indexOf('--params') + 1]);
      let items;
      if (args[2] === '/open-apis/im/v1/messages/mget') {
        items = params.message_ids.map(id => f.native.find(item => item.message_id === id));
      } else {
        assert.equal(args[2], '/open-apis/im/v1/messages'); assert.equal(params.container_id, CHAT);
        items = f.native.filter(item => Number(item.create_time) >= Number(params.start_time) * 1000
          && Number(item.create_time) < Number(params.end_time) * 1000);
      }
      if (f.mode === 'missing') items = [];
      return { status: 0, stdout: JSON.stringify({ code: 0, data: { items, has_more: false } }), stderr: '' };
    },
  } };
  return f;
}

async function invoke(f, args, deps = {}) {
  let stdout = '', stderr = '';
  const code = await runCli(args, { cwd: f.dir, env: {}, deps,
    stdout: { isTTY: false, columns: 100, write: value => stdout += value }, stderr: { write: value => stderr += value } });
  return { code, stdout, stderr };
}

async function messages(f) {
  const before = f.records(), bytes = hash(readFileSync(f.db)), calls = f.calls.length;
  const json = await invoke(f, ['messages', '--db', f.db, '--limit', '2', '--format', 'json']);
  const text = await invoke(f, ['messages', '--db', f.db, '--limit', '2', '--format', 'text']);
  assert.equal(json.code, 0, json.stderr); assert.equal(text.code, 0, text.stderr);
  assert.equal(json.stderr, ''); assert.equal(text.stderr, '');
  assert.deepEqual(f.records(), before); assert.equal(hash(readFileSync(f.db)), bytes);
  assert.equal(f.calls.length, calls, 'messages performs no remote lookup');
  return { rows: JSON.parse(json.stdout), text: text.stdout };
}

async function history(f, count) {
  const result = await invoke(f, ['maintenance', 'history', '--db', f.db, '--format', 'json',
    '--max-records', String(count), '--max-cli-attempts', count === 1 ? '4' : '3',
    '--max-self-attempts', count === 1 ? '1' : '2', '--max-seconds', '25'], f.deps);
  assert.equal(f.held, false);
  return { ...result, report: result.stdout ? JSON.parse(result.stdout) : null };
}

const proof = row => readMessageAccountEvidence(row, JSON.parse(row.canonical_json), JSON.parse(row.raw_json));
function sourceUnchanged(before, after) {
  for (const field of ['id', 'source_id', 'record_type', 'external_id', 'external_version', 'actor_id', 'container_id',
    'direction', 'raw_json', 'content_hash', 'body', 'occurred_at', 'occurred_at_ms', 'first_seen_scope_id']) {
    assert.equal(after[field], before[field], field);
  }
  const canonical = JSON.parse(after.canonical_json);
  delete canonical.message_account_evidence;
  assert.deepEqual(canonical, JSON.parse(before.canonical_json), 'only acquisition proof changes canonical');
}

for (const count of [1, 2]) test(`actual history CLI restores legacy native-name private account proof through ${count === 1 ? 'single list' : 'bulk mget'}`, async t => {
  const f = fixture(t), before = f.records(), scopeBefore = f.query('SELECT * FROM sync_scopes ORDER BY id;');
  assert(before.every(row => !proof(row) && row.occurred_at_ms < END));
  const initial = await messages(f);
  assert.deepEqual(initial.rows.map(row => row.readiness.reasons), [['account_unknown'], ['account_unknown']]);
  assert.equal((initial.text.match(/等待完整信息/g) || []).length, 2);
  const result = await history(f, count);
  assert.equal(result.code, 0, result.stderr || result.stdout); assert.equal(result.report.ok, true);
  assert.equal(result.report.processed ?? 1, count);
  assert.equal(result.report.request_budget.cli_attempts, count === 1 ? 2 : 3);
  assert.deepEqual(f.calls.map(args => args[0] === 'contact' ? 'self' : args[2].endsWith('/mget') ? 'mget' : 'list'),
    count === 1 ? ['self', 'list'] : ['self', 'mget', 'self']);
  const after = f.records();
  for (let index = 0; index < before.length; index++) {
    sourceUnchanged(before[index], after[index]);
    if (index < count) {
      const evidence = proof(after[index]); assert(evidence);
      assert.equal(evidence.account_key, ACCOUNT); assert.equal(evidence.source_hash, before[index].content_hash);
      assert.equal(evidence.source_version, before[index].external_version);
    } else assert.deepEqual(after[index], before[index]);
  }
  assert.deepEqual(f.query('SELECT * FROM sync_scopes ORDER BY id;'), scopeBefore, 'history does not move forward cursor');
  const published = await messages(f);
  assert.deepEqual(published.rows.map(row => row.external_id), initial.rows.map(row => row.external_id));
  assert.deepEqual(published.rows.map(row => row.body), initial.rows.map(row => row.body));
  assert.equal(published.rows.filter(row => row.readiness.state === 'ready').length, count);
  for (const row of published.rows.filter(row => row.readiness.state === 'ready')) {
    assert.deepEqual(row.readiness.reasons, []);
    assert.equal(row.readiness.requirements.find(item => item.field === 'recipient').evidence, 'admitted_account');
    const index = f.native.findIndex(item => item.message_id === row.external_id);
    assert.equal(row.display.sender, `Invented Native Peer ${index}`);
    assert.equal(row.body, `Authored historical paragraph ${index}; keep  double spaces.`);
    assert(published.text.includes(`  发送人  Invented Native Peer ${index}\n  接收人  我\n  类型    user / 文本\n  消息    Authored historical paragraph ${index}; keep double spaces.\n`),
      'normal text keeps the established compact-body and field layout');
    assert(published.text.includes(new Date(row.occurred_at).toLocaleString()));
  }
  assert.equal((published.text.match(/等待完整信息/g) || []).length, 2 - count);
  const repeatBefore = f.records();
  if (count === 2) {
    f.selves = 0;
    const repeated = await history(f, count); assert.equal(repeated.code, 0, repeated.stderr || repeated.stdout);
    assert.deepEqual(f.records(), repeatBefore, 'same-source reacquisition retains original proof without refreshing its clock');
  }
});

for (const [mode, count] of [['foreign', 1], ['foreign-closing', 2]]) test(`actual history CLI rejects ${mode} account before proof can publish`, async t => {
  const f = fixture(t), before = f.records(); f.mode = mode;
  const result = await history(f, count);
  assert.notEqual(result.code, 0);
  assert.deepEqual(f.records(), before); assert.equal(f.query('SELECT * FROM lark_im_history_progress;').length, 0);
  assert(f.records().every(row => !proof(row)));
  const published = await messages(f);
  assert(published.rows.every(row => row.readiness.state === 'enriching' && row.readiness.reasons.includes('account_unknown')));
});

test('actual history CLI does not manufacture account proof when the admitted query returns no target', async t => {
  const f = fixture(t), before = f.records(); f.mode = 'missing';
  const result = await history(f, 1);
  assert.notEqual(result.code, 0); assert.equal(result.report.outcome, 'missing');
  assert.deepEqual(f.records(), before); assert(f.records().every(row => !proof(row)));
  assert.equal(result.report.request_budget.cli_attempts, 2);
});
