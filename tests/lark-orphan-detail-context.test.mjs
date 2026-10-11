import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';
import { createSyncRunner } from '../src/adapters/lark-im/sync-runner.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';

// All source payloads and identities are authored synthetic fixtures. The real
// runner and SQLite store receive only injected GET responses; no live API.
const START = Date.parse('2026-02-01T00:00:00Z');
const CHAT = 'oc_synthetic_detail_context', SCOPE = chatScopeId(CHAT);
const SELF = { open_id: 'ou_synthetic_detail_context_self', name: 'Synthetic Self' };
const q = store.quoteSql, sha = text => createHash('sha256').update(text).digest('hex');
const root = snapshot => ({ message_id: 'om_synthetic_detail_context', chat_id: CHAT,
  create_time: String(START + 1000), update_time: String(START + 2000), msg_type: 'merge_forward',
  sender: { id: 'ou_synthetic_detail_context_sender', id_type: 'open_id', sender_type: 'user' },
  body: { content: JSON.stringify({ snapshot }) } });
const child = { ...root(2), message_id: 'om_synthetic_detail_context_child', upper_message_id: root(2).message_id,
  msg_type: 'text', body: { content: '{"text":"Synthetic full detail"}' } };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-detail-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite'); store.ensureInitialized(db);
  store.sqliteExec(db, `UPDATE sources SET config_json=${q(JSON.stringify({ initial_sync_start_ms: START,
    initial_account_binding: { kind: store.INITIAL_ACCOUNT_KIND, account_key: sha(`lark.im\0${SELF.open_id}`),
      reserved_at: '2026-02-01T00:00:00.000Z', confirmed_at: '2026-02-01T00:00:00.000Z' } }))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(SCOPE)},'lark.im','Synthetic context scope',
      ${q(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`);
  const f = { db, requests: 0, duringFetch: null };
  const adapter = createLarkImAdapter({ run: args => {
    assert.equal(args[2], `/open-apis/im/v1/messages/${root(2).message_id}`);
    f.requests++; const mutate = f.duringFetch; f.duringFetch = null; mutate?.();
    return { code: 0, data: { items: [root(2), child], has_more: false } };
  } });
  f.runner = createSyncRunner({ ...adapter, buildPeopleContext: () => ({ self: SELF }),
    nowIso: () => '2099-01-01T00:00:00.000Z', reuseKnownSenderNames: (_db, rows) => rows });
  const scope = store.readScope(db, SCOPE), run = store.createRun(db, scope);
  store.commitLarkListRun(db, scope, run, [], [root(1)], 1, { created_at_ms: START + 60000 },
    { initial_sync_start_ms: START, list_window_start_ms: START, list_window_end_ms: START + 60000 });
  return f;
}
const task = f => store.sqliteQuery(f.db, 'SELECT * FROM lark_im_detail_tasks;')[0];
const records = f => store.sqliteQuery(f.db, 'SELECT * FROM records;');
const cursor = f => store.readScope(f.db, SCOPE).cursor_json;
const retry = f => f.runner.retryDetails(f.db, { detailLimit: 1, detailScope: SCOPE, detailBudgetMs: 30000,
  lockTtlSeconds: 600, retries: 0, retryDelayMs: 0 }, SELF);
const setConfig = (f, config) => store.sqliteExec(f.db,
  `UPDATE sync_scopes SET config_json=${q(config)} WHERE id=${q(SCOPE)};`);
function hot(f, round) {
  store.sqliteExec(f.db, `UPDATE sync_scopes SET config_json=json_set(config_json,
    '$.hot_rank',${round},'$.hot_seen_at',${q(`2026-02-01T00:00:0${round}.000Z`)},
    '$.last_hot_snapshot_id',${q(`synthetic-hot-${round}`)}) WHERE id=${q(SCOPE)};`);
}

test('hot scheduling fields changing before every acquisition still complete on the second independent detail', t => {
  const f = fixture(t); hot(f, 1); retry(f);
  const first = task(f);
  assert.equal(first.status, 'pending'); assert.equal(records(f).length, 0); assert.equal(cursor(f), null);
  hot(f, 2); retry(f);
  assert.equal(task(f).status, 'complete'); assert.equal(records(f).length, 1);
  assert.equal(task(f).attempt_count, 2); assert.equal(f.requests, 2);
  assert.equal(JSON.parse(cursor(f)).created_at_ms, START + 60000);
});

for (const [name, value] of [['policy_version', 2], ['unknown_policy', { enabled: true }], ['nested_hot', { hot_rank: 2 }]]) {
  test(`unknown scope field ${name} resets confirmation while subsequent hot churn remains harmless`, t => {
    const f = fixture(t); retry(f); const first = task(f);
    const config = { chat_id: CHAT, chat_type: 'group', [name]: value };
    setConfig(f, JSON.stringify(config)); hot(f, 1); retry(f);
    const changed = task(f);
    assert.equal(changed.status, 'pending'); assert.equal(records(f).length, 0);
    assert.notEqual(changed.candidate_context, first.candidate_context);
    hot(f, 2); retry(f);
    assert.equal(task(f).status, 'complete'); assert.equal(f.requests, 3);
  });
}

test('in-flight hot drift is still rejected by exact request admission and leaves the prior candidate untouched', t => {
  const f = fixture(t); hot(f, 1); retry(f); const first = task(f), fullBefore = cursor(f);
  f.duringFetch = () => hot(f, 2);
  const result = retry(f);
  assert.ok(result.some(value => value.ok === false));
  assert.deepEqual(task(f), first, 'failed full-config CAS publishes neither a new candidate nor completion');
  assert.equal(records(f).length, 0); assert.equal(cursor(f), fullBefore);
  retry(f);
  assert.equal(task(f).status, 'complete', 'a new acquisition can use the stable projected context after drift');
  assert.equal(f.requests, 3);
});

for (const [beforeValue, afterValue] of [['9007199254740992', '9007199254740993'],
  ['1.00000000000000001', '1.00000000000000002']]) {
  test(`unsafe scope number ${beforeValue} uses exact text and cannot borrow a rounded context`, t => {
    const f = fixture(t);
    const config = value => `{"chat_id":"${CHAT}","unknown_policy":${value}}`;
    setConfig(f, config(beforeValue)); retry(f); const first = task(f);
    setConfig(f, config(afterValue)); retry(f);
    assert.equal(task(f).status, 'pending'); assert.equal(records(f).length, 0);
    assert.notEqual(task(f).candidate_context, first.candidate_context);
    retry(f); assert.equal(task(f).status, 'complete');
  });
}

test('the shared context helper projects exactly the three top-level hot fields and preserves policy data', async () => {
  const core = await import('../dist/core/lark-scope-config.js');
  const maintenance = await import('../src/maintenance/scope-config-policy.mjs');
  assert.equal(maintenance.scopeObservationContext, core.scopeObservationContext, 'history-facing export is the same helper');
  assert.equal(maintenance.projectScopeConfig, core.projectScopeConfig, 'there is one projection rule');
  const a = '{"policy_version":7,"nested":{"hot_rank":8},"chat_id":"synthetic","hot_rank":1,"hot_seen_at":"a","last_hot_snapshot_id":"b"}';
  const b = '{"last_hot_snapshot_id":"c","hot_seen_at":"d","hot_rank":2,"chat_id":"synthetic","nested":{"hot_rank":8},"policy_version":7}';
  assert.deepEqual(core.scopeObservationContext(a), core.scopeObservationContext(b));
  const result = core.scopeObservationContext(a);
  assert.equal(result.policy, core.SCOPE_CONFIG_POLICY);
  assert.deepEqual(JSON.parse(result.configJson), { chat_id: 'synthetic', nested: { hot_rank: 8 }, policy_version: 7 });
  assert.notDeepEqual(result, core.scopeObservationContext(b.replace('"hot_rank":8', '"hot_rank":9')));
});

test('uncertain scope input falls back to exact original text including hot fields', async () => {
  const { scopeObservationContext } = await import('../dist/core/lark-scope-config.js');
  for (const config of [
    '{"unknown":9007199254740993,"hot_rank":1}', '{"unknown":1.00000000000000001,"hot_rank":1}',
    '{"unknown":1,"unknown":2,"hot_rank":1}', '{"unknown":-0,"hot_rank":1}',
    '{"hot_rank":9007199254740993}', '{"broken":', 'null', '1', '[]',
    '{"large":"' + 'x'.repeat(1024 * 1024) + '","hot_rank":1}',
  ]) {
    assert.deepEqual(scopeObservationContext(config), { policy: 'exact_scope_config/v1', configJson: config });
    if (config.includes('"hot_rank":1')) assert.notDeepEqual(scopeObservationContext(config),
      scopeObservationContext(config.replace('"hot_rank":1', '"hot_rank":2')));
  }
});
