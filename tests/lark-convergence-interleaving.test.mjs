import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';
import { createSyncRunner } from '../src/adapters/lark-im/sync-runner.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { executeLarkImHistory } from '../src/maintenance/history.mjs';
import { runMaintenanceCommand } from '../src/cli/maintenance-command.mjs';
import { parseRouteOptions } from '../src/cli/registry.mjs';
import { createCommandContext } from '../src/cli/context.mjs';

// All identities, payloads and network responses are authored synthetic data.
const START = Date.parse('2026-01-01T00:00:00Z');
const CHAT = 'oc_synthetic_convergence', SCOPE = chatScopeId(CHAT);
const SELF = { open_id: 'ou_synthetic_convergence_self', name: 'Synthetic Self' };
const q = store.quoteSql, sha = text => createHash('sha256').update(text).digest('hex');
const root = (snapshot = 1, extra = {}) => ({ message_id: 'om_synthetic_merge_root', chat_id: CHAT,
  create_time: String(START + 1000), update_time: String(START + 2000), msg_type: 'merge_forward',
  sender: { id: 'ou_synthetic_author', id_type: 'open_id', sender_type: 'user' },
  body: { content: JSON.stringify({ snapshot }) }, ...extra });
const child = (body = 'Synthetic initial child') => ({ ...root(), message_id: 'om_synthetic_child',
  msg_type: 'text', upper_message_id: root().message_id, body: { content: JSON.stringify({ text: body }) } });
const page = items => ({ code: 0, data: { items, has_more: false } });
const fetchOpts = { pageSize: 50, maxPages: 2, retries: 0, retryDelayMs: 0 };
function adapterFor(listed, detailed) {
  return createLarkImAdapter({ run: args => {
    if (args[2] === '/open-apis/im/v1/messages') return page([listed]);
    assert.equal(args[2], `/open-apis/im/v1/messages/${listed.message_id}`);
    return page(detailed);
  } });
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-convergence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite'); store.ensureInitialized(db);
  store.sqliteExec(db, `UPDATE sources SET config_json=${q(JSON.stringify({ initial_sync_start_ms: START,
    initial_account_binding: { kind: store.INITIAL_ACCOUNT_KIND, account_key: sha(`lark.im\0${SELF.open_id}`),
      reserved_at: '2026-01-01T00:00:00.000Z', confirmed_at: '2026-01-01T00:00:00.000Z' } }))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(SCOPE)},'lark.im','Synthetic scope',
      ${q(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`);
  const f = { db, remote: root(), children: [child()] };
  f.adapter = createLarkImAdapter({ run: args => {
    assert.equal(args[2], `/open-apis/im/v1/messages/${root().message_id}`);
    return page(f.remote.msg_type === 'merge_forward' ? [f.remote, ...f.children] : [f.remote]);
  } });
  f.runner = createSyncRunner({ ...f.adapter, buildPeopleContext: () => ({ self: SELF }),
    nowIso: () => '2099-01-01T00:00:00.000Z', reuseKnownSenderNames: (_db, rows) => rows });
  return f;
}
const scope = f => store.readScope(f.db, SCOPE);
const task = f => store.sqliteQuery(f.db, 'SELECT * FROM lark_im_detail_tasks;')[0];
const record = f => store.sqliteQuery(f.db, 'SELECT * FROM records;')[0];
const state = f => store.sqliteQuery(f.db, 'SELECT * FROM record_observation_state;')[0];
const progress = f => store.readLarkListProgress(f.db, scope(f));
function list(f, start, end, roots) {
  const sc = scope(f), run = store.createRun(f.db, sc);
  return store.commitLarkListRun(f.db, sc, run, [], roots, roots.length, { created_at_ms: end, message_id: '' },
    { initial_sync_start_ms: START, list_window_start_ms: start, list_window_end_ms: end });
}
function retry(f) {
  return f.runner.retryDetails(f.db, { detailLimit: 5, detailScope: SCOPE, detailBudgetMs: 30000,
    lockTtlSeconds: 600, retries: 0, retryDelayMs: 0 }, SELF);
}
function history(f, afterSelection) {
  return executeLarkImHistory({ db: f.db, maxCliAttempts: 4, maxSeconds: 30 }, {
    createRequestSession: () => ({ runLark: () => { throw Error('unexpected boundary'); }, assertReady() {},
      summary: () => ({ cli_attempts: 3, max_cli_attempts: 4, max_seconds: 30, elapsed_ms: 1 }) }),
    getSelfProfile: () => SELF,
    fetchChatMessageList: () => {
      afterSelection?.();
      return f.remote.msg_type === 'merge_forward'
        ? { messages: [], detailRoots: [f.remote], pages: 1 }
        : { messages: [normalizeApiMessage(f.remote)], pages: 1 };
    }, fetchMessageDetails: f.adapter.fetchMessageDetails,
  });
}
function seedComplete(f) {
  list(f, START, START + 1000, [root()]); retry(f);
  assert.equal(task(f).status, 'complete');
}

function cliReplay(f, adapter) {
  let stdout = '', stderr = '';
  const parsed = parseRouteOptions('maintenance.replay', ['--db', f.db, '--scope-id', SCOPE,
    '--start', new Date(START).toISOString(), '--end', new Date(START + 60000).toISOString(), '--apply', '--format', 'json']);
  const exit = runMaintenanceCommand(parsed.options, { ...createCommandContext({ stdout: { write: s => stdout += s },
    stderr: { write: s => stderr += s } }), provided: parsed.provided,
    deps: { getSelfProfile: () => SELF, fetchChatMessages: adapter.fetchChatMessages } });
  return { exit, stdout, stderr };
}

for (const [label, refreshed, expected] of [
  ['sender conflict', root(1, { sender: { ...root().sender, id: 'ou_synthetic_different' } }), 'source_version_conflict'],
  ['body conflict', root(2), 'source_version_conflict'],
  ['version regression', root(1, { update_time: String(START + 1999) }), 'source_version_regressed'],
  ['identity conflict', root(1, { chat_id: 'oc_synthetic_different' }), 'source_identity_changed'],
]) test(`replay and detail agree on full root ${label}`, t => {
  const adapter = adapterFor(root(), [refreshed, child()]);
  assert.throws(() => adapter.fetchMessageDetails(root()), error => error.detailReason === expected);
  assert.throws(() => adapter.fetchChatMessages(CHAT, START, START + 60000, fetchOpts),
    error => error.missingDetails?.[0].reason === expected);
  assert.throws(() => normalizeApiMessage(root(), { mergeItems: [refreshed, child()] }), /source changed/);
  const f = fixture(t); seedComplete(f); const before = record(f), debt = task(f);
  const result = cliReplay(f, adapter);
  assert.equal(result.exit, 2); assert.equal(JSON.parse(result.stdout).ok, false);
  assert.deepEqual(record(f), before); assert.deepEqual(task(f), debt);
});

for (const [label, refreshed] of [
  ['JSON order', { ...Object.fromEntries(Object.entries(root()).reverse()), body: { content: ' { "snapshot" : 1 } ' } }],
  ['timestamp representation', root(1, { create_time: String((START + 1000) / 1000), update_time: String((START + 2000) / 1000), upper_message_id: '' })],
  ['newer full root', root(2, { update_time: String(START + 3000), sender: { ...root().sender, id: 'ou_synthetic_refreshed' } })],
]) test(`replay and detail preserve one authoritative snapshot for ${label}`, t => {
  const adapter = adapterFor(root(), [refreshed, child()]);
  const detail = adapter.fetchMessageDetails(root());
  const replay = adapter.fetchChatMessages(CHAT, START, START + 60000, fetchOpts).messages[0];
  for (const message of [detail, replay]) {
    const stored = recordFromMessage(message, SCOPE, 'received', { self: SELF }, { chat_id: CHAT });
    const raw = JSON.parse(stored.raw_json);
    assert.deepEqual(raw.sender, refreshed.sender);
    assert.deepEqual(raw.raw_api_expansions.merge_forward.items[0], refreshed);
    assert.equal(stored.actor_id, refreshed.sender.id);
  }
  // Exercise the actual CLI dispatch and replay commit, with only its transport injected.
  const f = fixture(t), { exit, stdout, stderr } = cliReplay(f, adapter);
  assert.equal(exit, 0, stdout + stderr);
  const saved = JSON.parse(record(f).raw_json);
  assert.deepEqual(saved.sender, saved.raw_api_expansions.merge_forward.items[0].sender);
  assert.equal(JSON.parse(stdout).scopes[0].inserted, 1);
});

test('detail → history → equivalent detail → history retains one original confirmation and converges', t => {
  const f = fixture(t);
  const original = recordFromMessage(normalizeApiMessage(root(), { mergeItems: [root(), child()] }), SCOPE,
    'received', { self: SELF }, { chat_id: CHAT, chat_type: 'group' });
  store.sqliteExec(f.db, store.upsertRecordsSql([original]));
  list(f, START, START + 6000, [root()]); f.children = [child('Synthetic stable replacement')];
  retry(f); assert.equal(task(f).status, 'pending'); assert.equal(state(f).candidate_context, null);
  const before = record(f); assert.equal(history(f).conflicts, 1);
  const first = state(f), keys = Object.keys(first).filter(key => key.startsWith('candidate_'));
  retry(f); const second = state(f);
  for (const key of keys) assert.equal(second[key], first[key], key);
  assert.deepEqual(record(f), before); assert.equal(task(f).status, 'pending');
  assert.equal(history(f).updated, 1); assert.equal(scope(f).cursor_json, null);
  retry(f); assert.equal(task(f).status, 'complete'); assert.equal(scope(f).cursor.created_at_ms, START + 6000);
});

for (const change of ['context', 'generation', 'candidate']) test(`ordinary retention cannot confirm through changed ${change}`, t => {
  const f = fixture(t); seedComplete(f); list(f, START + 1000, START + 2000, [root()]);
  // Reopen the same root's task for the synthetic missed child edit.
  store.sqliteExec(f.db, "UPDATE lark_im_detail_tasks SET status='pending';");
  f.children = [child('Synthetic candidate B')]; assert.equal(history(f).conflicts, 1);
  const first = state(f);
  if (change === 'context') store.sqliteExec(f.db, `UPDATE sync_scopes SET config_json=json_set(config_json,'$.unknown_policy','changed') WHERE id=${q(SCOPE)};`);
  if (change === 'generation') store.sqliteExec(f.db, "UPDATE records SET body='Synthetic local projection change';");
  if (change === 'candidate') f.children = [child('Synthetic candidate D')];
  retry(f); assert.equal(task(f).status, 'pending');
  if (change === 'context') assert.equal(state(f).candidate_context, first.candidate_context, 'inert old context remains bounded evidence');
  else assert.equal(state(f).candidate_context, null);
  assert.equal(history(f).conflicts, 1, 'a fresh first observation is required');
  assert.equal(history(f).updated, 1);
});

test('history C rebases queued B without claiming coverage, then the actual detail retry completes', t => {
  const f = fixture(t); seedComplete(f);
  list(f, START + 1000, START + 2000, [root(2)]); list(f, START + 2000, START + 3000, []);
  f.remote = root(3); retry(f);
  assert.match(task(f).last_error_message, /source_version_conflict/);
  assert.equal(history(f).conflicts, 1);
  const full = scope(f).cursor_json, forward = progress(f).cursor_json, generation = progress(f).generation, oldTask = task(f);
  assert.equal(history(f).updated, 1);
  assert.equal(task(f).status, 'pending'); assert.equal(task(f).attempt_count, 1);
  assert.equal(JSON.parse(task(f).raw_root_json).body.content, root(3).body.content);
  assert.equal(scope(f).cursor_json, full); assert.equal(progress(f).cursor_json, forward);
  assert.equal(progress(f).generation, generation + 1, 'stale detail/list runs are fenced');
  const accepted = record(f), descriptor = task(f), sc = scope(f), run = store.createRun(f.db, sc);
  assert.throws(() => store.finishLarkDetailRun(f.db, sc, run, [{ message_id: oldTask.message_id,
    fingerprint: oldTask.fingerprint, record: recordFromMessage(f.adapter.fetchMessageDetails(f.remote), SCOPE,
      'received', { self: SELF }, { chat_id: CHAT, chat_type: 'group' }) }]), /commit Lark progress/);
  store.failRun(f.db, sc, run, new Error('Synthetic stale descriptor retry'));
  assert.deepEqual(record(f), accepted); assert.deepEqual(task(f), descriptor);
  retry(f); assert.equal(task(f).status, 'complete'); assert.equal(scope(f).cursor.created_at_ms, START + 3000);
});

test('a concurrent D descriptor is never overwritten by history C; later history and detail converge D', t => {
  const f = fixture(t); seedComplete(f); list(f, START + 1000, START + 1000, [root(2)]);
  f.remote = root(3); assert.equal(history(f).conflicts, 1);
  assert.equal(history(f, () => list(f, START + 1000, START + 3000, [root(4)])).updated, 1);
  assert.equal(JSON.parse(task(f).raw_root_json).body.content, root(4).body.content);
  assert.equal(JSON.parse(record(f).raw_json).body.content, root(3).body.content);
  assert.equal(task(f).status, 'pending'); assert.equal(scope(f).cursor.created_at_ms, START + 1000);
  f.remote = root(4); retry(f);
  assert.equal(task(f).status, 'pending'); assert.equal(JSON.parse(record(f).raw_json).body.content, root(3).body.content);
  assert.equal(history(f).conflicts, 1); assert.equal(history(f).updated, 1);
  retry(f); assert.equal(task(f).status, 'complete'); assert.equal(scope(f).cursor.created_at_ms, START + 3000);
});


test('list descriptor ABA cannot let a late history snapshot rebase a newer task generation', t => {
  const f = fixture(t); seedComplete(f); list(f, START + 1000, START + 1000, [root(2)]);
  f.remote = root(3); assert.equal(history(f).conflicts, 1);
  const generation = progress(f).generation;
  assert.equal(history(f, () => {
    list(f, START + 1000, START + 1000, [root(4)]);
    list(f, START + 1000, START + 1000, [root(2)]);
  }).updated, 1);
  assert.equal(JSON.parse(task(f).raw_root_json).body.content, root(2).body.content);
  assert.equal(progress(f).generation, generation + 2);
  assert.equal(task(f).status, 'pending');
  // A later, freshly selected observation can safely rebase the now-current B.
  history(f); assert.equal(JSON.parse(task(f).raw_root_json).body.content, root(3).body.content);
  retry(f); assert.equal(task(f).status, 'complete');
});

test('history-selected ordinary replacement remains pending until a matching detail receipt', t => {
  const f = fixture(t); seedComplete(f); list(f, START + 1000, START + 2000, [root(2)]);
  f.remote = root(1, { msg_type: 'text', body: { content: '{"text":"Synthetic replacement"}' } });
  assert.equal(history(f).conflicts, 1); assert.equal(history(f).updated, 1);
  assert.equal(JSON.parse(task(f).raw_root_json).msg_type, 'text'); assert.equal(task(f).status, 'pending');
  assert.equal(scope(f).cursor.created_at_ms, START + 1000);
  retry(f); assert.equal(task(f).status, 'complete'); assert.equal(scope(f).cursor.created_at_ms, START + 2000);
});
