import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { prepareChatWindowRecords, createSyncRunner } from '../src/adapters/lark-im/sync-runner.mjs';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';

// Entirely authored data. Each history invocation is a new real CLI process,
// with real SQLite and flock/cooldown in this fixture. Only the remote CLI is fake.
const START = Date.UTC(2025, 6, 7, 8), END = START + 60_000;
const SELF = { open_id: 'ou_authored_capture_owner', name: 'Authored Owner' };
const CHAT = 'oc_authored_capture_chat', SCOPE = chatScopeId(CHAT);
const CONFIG = { chat_id: CHAT, chat_type: 'group' }, q = store.quoteSql;
const sha = value => createHash('sha256').update(value).digest('hex');
const root = change => ({ message_id: 'om_authored_capture_root', chat_id: CHAT,
  msg_type: 'merge_forward', create_time: String(START + 1000), update_time: String(START + 2000),
  sender: { id: 'ou_authored_capture_author', id_type: 'open_id', sender_type: 'user' },
  body: { content: '{"snapshot":"initial"}' }, ...change });
const child = text => ({ ...root(), message_id: 'om_authored_capture_child',
  upper_message_id: root().message_id, msg_type: 'text', body: { content: JSON.stringify({ text }) } });
const nativeRecord = (rawRoot, rawChild) => prepareChatWindowRecords([
  normalizeApiMessage(rawRoot, { mergeItems: [rawRoot, rawChild] }),
], SCOPE, null, START, END, SELF.open_id, { self: SELF }, CONFIG)[0];

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'authored-history-detail-capture-')));
  chmodSync(dir, 0o700); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = { dir, db: join(dir, 'synthetic.sqlite'), state: join(dir, 'remote.json'),
    calls: join(dir, 'calls.jsonl'), cli: join(dir, 'fake-lark.mjs'), helper: join(dir, 'history-cli.mjs') };
  store.ensureInitialized(f.db);
  const confirmed = new Date(START).toISOString();
  store.sqliteExec(f.db, `UPDATE sources SET config_json=${q(JSON.stringify({ initial_sync_start_ms: START,
    initial_account_binding: { kind: store.INITIAL_ACCOUNT_KIND, account_key: sha(`lark.im\0${SELF.open_id}`),
      reserved_at: confirmed, confirmed_at: confirmed } }))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(SCOPE)},'lark.im',
      'Authored capture scope',${q(JSON.stringify(CONFIG))});`);
  store.sqliteExec(f.db, store.upsertRecordsSql([nativeRecord(root(), child('Authored initial child'))]));
  const scope = store.readScope(f.db, SCOPE), run = store.createRun(f.db, scope);
  store.commitLarkListRun(f.db, scope, run, [], [root()], 1, { created_at_ms: END },
    { initial_sync_start_ms: START, list_window_start_ms: START, list_window_end_ms: END });
  writeFileSync(f.calls, '');
  f.remote = { self: SELF, listed: root({ body: { content: '{"snapshot":"listed"}' } }), detail: root({ body: { content: '{"snapshot":"changed"}' },
    future_source_field: { meaningful: true } }), child: child('Authored revised child') };
  f.save = () => writeFileSync(f.state, JSON.stringify(f.remote)); f.save();
  writeFileSync(f.cli, `#!${process.execPath}
import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const statePath=${JSON.stringify(f.state)}, state=JSON.parse(readFileSync(statePath));
const args=process.argv.slice(2);appendFileSync(${JSON.stringify(f.calls)},JSON.stringify(args)+'\\n');
let out;
if(args[0]==='contact'&&args[1]==='+get-user')out=state.self;
else if(args[0]==='api'&&args[1]==='GET'&&args[2]==='/open-apis/im/v1/messages')out={code:0,data:{items:[state.listed],has_more:false}};
else if(args[0]==='api'&&args[1]==='GET'&&args[2]==='/open-apis/im/v1/messages/om_authored_capture_root'){
  if(state.mutateSql){const p=spawnSync('sqlite3',[${JSON.stringify(f.db)},state.mutateSql],{encoding:'utf8'});if(p.status!==0)throw Error('synthetic mutation failed');delete state.mutateSql;writeFileSync(statePath,JSON.stringify(state));}
  out={code:0,data:{items:state.items||[state.detail,state.child],has_more:false}};
}else throw Error('unexpected synthetic API route');
process.stdout.write(JSON.stringify(out));
`); chmodSync(f.cli, 0o700);
  writeFileSync(f.helper, `import {runCli} from ${JSON.stringify(new URL('../bin/exocortex.mjs', import.meta.url).href)};
import {performance} from 'node:perf_hooks';
import {Socket} from 'node:net';
import {tryAcquireLarkApiLease,readSharedLarkCooldown,writeSharedLarkCooldown} from ${JSON.stringify(new URL('../src/runtime/lark-api-lease.mjs', import.meta.url).href)};
globalThis.fetch=()=>{throw Error('synthetic test forbids network')};Socket.prototype.connect=function(){throw Error('synthetic test forbids network')};
const directory=${JSON.stringify(join(dir, 'api-state'))};let elapsed=0;const monotonicClock=()=>performance.now()+elapsed;
const requestSessionDeps={monotonicClock,sleep:ms=>{elapsed+=ms},
tryAcquireLease:opts=>tryAcquireLarkApiLease(opts,{directory,monotonicClock}),
readSharedCooldown:opts=>readSharedLarkCooldown(opts,{directory}),writeSharedCooldown:opts=>writeSharedLarkCooldown(opts,{directory})};
process.exitCode=await runCli(process.argv.slice(2),{deps:{requestSessionDeps}});
`);
  f.query = sql => store.sqliteQuery(f.db, sql);
  f.records = () => f.query('SELECT * FROM records ORDER BY id;');
  f.task = () => f.query('SELECT * FROM lark_im_detail_tasks;')[0];
  f.observation = () => f.query('SELECT * FROM record_observation_state;')[0];
  return f;
}

function history(f) {
  f.save();
  const result = spawnSync(process.execPath, [f.helper, 'maintenance', 'history', '--db', f.db,
    '--format', 'json', '--max-records', '1', '--max-cli-attempts', '4', '--max-self-attempts', '1', '--max-seconds', '25'],
  { cwd: f.dir, env: { ...process.env, LARK_CLI: f.cli }, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  assert.ifError(result.error); assert.equal(result.signal, null);
  if (result.status === 0) assert.equal(result.stderr, '');
  return { code: result.status, report: result.stdout ? JSON.parse(result.stdout) : null, stderr: result.stderr };
}
function retryDetail(f) {
  let calls = 0;
  const adapter = createLarkImAdapter({ run: args => {
    assert.equal(args[2], '/open-apis/im/v1/messages/om_authored_capture_root'); calls++;
    return { code: 0, data: { items: [f.remote.detail, f.remote.child], has_more: false } };
  } });
  const runner = createSyncRunner({ ...adapter, buildPeopleContext: () => ({ self: SELF }),
    nowIso: () => '2099-01-01T00:00:00.000Z', reuseKnownSenderNames: (_db, rows) => rows });
  const result = runner.retryDetails(f.db, { detailLimit: 1, detailScope: SCOPE, detailBudgetMs: 30000,
    lockTtlSeconds: 600, retries: 0, retryDelayMs: 0 }, SELF);
  assert.equal(calls, 1); return result;
}

test('real history CLI captures a complete existing-root conflict across restarts and still requires fresh detail completion', t => {
  const f = fixture(t), before = f.records(), cursor = store.readScope(f.db, SCOPE).cursor_json;
  const strict = retryDetail(f); assert.equal(strict[0].ok, false);
  assert.match(f.task().last_error_message, /kind=source_version_conflict$/);
  assert.deepEqual(f.records(), before, 'ordinary detail is still non-confirming');
  const first = history(f);
  assert.equal(first.code, 0, JSON.stringify(first)); assert.equal(first.report.outcome, 'pending_observation');
  assert.equal(first.report.request_budget.cli_attempts, 3);
  assert.deepEqual(f.records(), before); assert.equal(f.task().status, 'pending');
  const pending = f.observation(); assert.ok(pending.candidate_json); assert.ok(pending.candidate_context);
  assert.equal(pending.candidate_generation, pending.generation);
  const second = history(f);
  assert.equal(second.code, 0, JSON.stringify(second)); assert.equal(second.report.updated, 1);
  assert.equal(second.report.request_budget.cli_attempts, 3);
  assert.equal(f.observation().candidate_json, null);
  assert.equal(f.task().status, 'pending', 'history is not a fresh detail receipt');
  assert.equal(JSON.parse(f.task().raw_root_json).body.content, f.remote.detail.body.content);
  assert.equal(store.readScope(f.db, SCOPE).cursor_json, cursor);
  const accepted = JSON.parse(f.records()[0].raw_json);
  assert.deepEqual(accepted.future_source_field, { meaningful: true });
  assert.equal(accepted.raw_api_expansions.merge_forward.items[1].body.content, f.remote.child.body.content);
  assert.equal(retryDetail(f)[0].ok, true); assert.equal(f.task().status, 'complete');
  assert.equal(store.readScope(f.db, SCOPE).cursor.created_at_ms, END);
  assert.equal(f.query('SELECT COUNT(*) n FROM sync_locks;')[0].n, 0);
  assert.equal(f.query('SELECT COUNT(*) n FROM maintenance_locks;')[0].n, 0);
});

test('a changed second complete tree replaces the candidate and needs another independent acquisition', t => {
  const f = fixture(t), before = f.records(), task = f.task();
  assert.equal(history(f).report.outcome, 'pending_observation');
  const first = f.observation();
  f.remote.child = child('Authored third source, not a confirmation of the second');
  const second = history(f);
  assert.equal(second.code, 0, JSON.stringify(second)); assert.equal(second.report.conflicts, 1);
  assert.deepEqual(f.records(), before); assert.equal(f.task().fingerprint, task.fingerprint);
  assert.notEqual(f.observation().candidate_attempt, first.candidate_attempt);
  assert.notEqual(f.observation().candidate_json, first.candidate_json);
  assert.equal(history(f).report.updated, 1);
  assert.equal(f.task().status, 'pending');
});

test('a different source policy cannot combine with the previous history confirmation', t => {
  const f = fixture(t), before = f.records();
  assert.equal(history(f).report.conflicts, 1); const first = f.observation();
  store.sqliteExec(f.db, `UPDATE sources SET config_json=json_set(config_json,'$.authored_policy',2) WHERE id='lark.im';`);
  const second = history(f);
  assert.equal(second.code, 0, JSON.stringify(second)); assert.equal(second.report.conflicts, 1);
  assert.deepEqual(f.records(), before); assert.notEqual(f.observation().candidate_context, first.candidate_context);
  assert.equal(history(f).report.updated, 1);
});

test('foreign self cannot reach the list or conflict detail acquisition', t => {
  const f = fixture(t), before = f.records(), task = f.task();
  f.remote.self = { open_id: 'ou_authored_foreign_owner', name: 'Authored Other Owner' };
  const result = history(f);
  assert.notEqual(result.code, 0); assert.deepEqual(f.records(), before); assert.deepEqual(f.task(), task);
  assert.equal(f.observation().candidate_json, null);
  const calls = readFileSync(f.calls, 'utf8').trim().split('\n').map(value => JSON.parse(value));
  assert.deepEqual(calls.map(args => args[0]), ['contact']);
});

for (const [name, mutate] of [
  ['cross-chat root', f => { f.remote.detail.chat_id = 'oc_authored_different_chat'; }],
  ['regressed source version', f => { f.remote.detail.update_time = String(START + 1999); }],
  ['missing source version', f => { delete f.remote.detail.update_time; }],
  ['incomplete tree', f => { f.remote.items = [f.remote.detail]; }],
  ['duplicate child identity', f => { f.remote.items = [f.remote.detail, f.remote.child, f.remote.child]; }],
]) test(`history conflict capture still rejects ${name} without a candidate`, t => {
  const f = fixture(t), before = f.records(), task = f.task(); mutate(f);
  const result = history(f);
  assert.notEqual(result.code, 0); assert.equal(result.report.request_budget.cli_attempts, 3);
  assert.deepEqual(f.records(), before); assert.deepEqual(f.task(), task);
  assert.equal(f.observation().candidate_json, null);
});

for (const [name, sql] of [
  ['source policy', `UPDATE sources SET config_json=json_set(config_json,'$.authored_inflight_policy',3) WHERE id='lark.im';`],
  ['record generation ABA', `UPDATE records SET body='Authored transient body' WHERE external_id='om_authored_capture_root';
    UPDATE records SET body=(SELECT body FROM __authored_before) WHERE external_id='om_authored_capture_root';`],
]) test(`history refuses stale acceptance after an in-flight ${name} change`, t => {
  const f = fixture(t), before = f.records(), task = f.task();
  // The helper table exists only to restore the authored projection in the ABA
  // control; the observation trigger still records both record generations.
  store.sqliteExec(f.db, 'CREATE TABLE __authored_before AS SELECT body FROM records;');
  f.remote.mutateSql = sql;
  const result = history(f);
  assert.deepEqual(f.records(), before); assert.deepEqual(f.task(), task);
  if (name === 'source policy') {
    assert.notEqual(result.code, 0); assert.equal(f.observation().candidate_json, null);
    assert.equal(f.query('SELECT COUNT(*) n FROM bounded_replay_runs;')[0].n, 0);
  } else {
    // Existing observation policy can durably record a rejected stale source;
    // a committed conflict receipt is not a qualifying confirmation candidate.
    assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.report.conflicts, 1);
    assert.equal(f.observation().candidate_generation, null);
    assert.equal(f.observation().reason, 'local_generation_changed');
    delete f.remote.mutateSql;
    assert.equal(history(f).report.conflicts, 1, 'a fresh first vote is still needed after ABA');
    assert.deepEqual(f.records(), before);
    assert.equal(history(f).report.updated, 1);
  }
  assert.equal(f.query('SELECT COUNT(*) n FROM maintenance_locks;')[0].n, 0);
});
