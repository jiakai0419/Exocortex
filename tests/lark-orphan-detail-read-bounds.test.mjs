import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import { pendingDetailContextKey } from '../dist/storage/sqlite/pending-detail-observation.js';
import { captureLarkWriteAdmission } from '../src/diagnostics/lark-write-admission.mjs';
import { activityDatabaseKey } from '../src/diagnostics/lark-im-activity-evidence.mjs';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';
import { createSyncRunner } from '../src/adapters/lark-im/sync-runner.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';

// All identities, source snapshots, account evidence and storage are synthetic.
// The fixture exceeds the existing 50 MiB sqlite stdout buffer in aggregate,
// while every candidate is legitimately below its unchanged 4 MiB limit.
const START = Date.parse('2026-01-01T00:00:00.000Z');
const CHAT = 'oc_synthetic_read_bounds', SCOPE = chatScopeId(CHAT);
const SELF = { open_id: 'ou_synthetic_read_bounds_self', name: 'Synthetic Self' };
const NOW = '2099-01-01T00:00:00.000Z', q = store.quoteSql;
const root = (index, snapshot = 1) => ({ message_id: `om_synthetic_bounds_${String(index).padStart(3, '0')}`,
  chat_id: CHAT, create_time: String(START + 1000 + index), update_time: String(START + 2000),
  msg_type: 'merge_forward', sender: { id: 'ou_synthetic_bounds_author', id_type: 'open_id', sender_type: 'user' },
  body: { content: JSON.stringify({ snapshot }) } });
const child = (parent, text = 'Synthetic child') => ({ ...parent, message_id: `${parent.message_id}_child`,
  upper_message_id: parent.message_id, msg_type: 'text', body: { content: JSON.stringify({ text }) } });
const currentScope = f => store.readScope(f.db, SCOPE);
const summary = f => store.sqliteQuery(f.db, `SELECT count(*) AS tasks,
  sum(status='pending') AS pending, sum(candidate_json IS NOT NULL) AS candidates,
  sum(attempt_count) AS attempts, sum(length(candidate_json)) AS candidate_bytes FROM lark_im_detail_tasks;`)[0];
function fixture(t, count) {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-detail-read-bounds-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite'); store.ensureInitialized(db);
  const config = { initial_sync_start_ms: START, initial_account_binding: {
    kind: store.INITIAL_ACCOUNT_KIND,
    account_key: createHash('sha256').update(`lark.im\0${SELF.open_id}`).digest('hex'),
    reserved_at: '2026-01-01T00:00:00.000Z', confirmed_at: '2026-01-01T00:00:00.000Z',
  } };
  store.sqliteExec(db, `UPDATE sources SET config_json=${q(JSON.stringify(config))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(SCOPE)},'lark.im','Synthetic bounded read',
      ${q(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`);
  const roots = Array.from({ length: count }, (_, index) => root(index));
  const f = { db, roots, requests: [], readLimits: [], failId: null };
  const scope = currentScope(f), runId = store.createRun(db, scope);
  store.commitLarkListRun(db, scope, runId, [], [...roots].reverse(), count,
    { created_at_ms: START + 60000, message_id: '' },
    { initial_sync_start_ms: START, list_window_start_ms: START, list_window_end_ms: START + 60000 });
  return f;
}
function seedCandidates(f) {
  for (let index = 0; index < f.roots.length; index++) {
    const scope = currentScope(f);
    const admission = captureLarkWriteAdmission(f.db,
      { selfOpenId: SELF.open_id, requireVerified: true, scopeIds: [SCOPE] });
    scope.writeAdmission = admission.fence; scope.assertWriteAdmission = admission.assertCurrent;
    const task = store.readPendingLarkDetails(f.db, scope, { limit: 1, now: NOW })[0];
    assert.equal(task.message_id, root(index).message_id);
    const runId = store.createRun(f.db, scope), databaseKey = activityDatabaseKey(f.db);
    const acquisition = { task, attempt: `detail-run:${runId}`, startedAtMs: Date.now(), databaseKey,
      contextKey: pendingDetailContextKey(databaseKey, scope) };
    const changed = root(index, 2);
    const record = recordFromMessage(normalizeApiMessage(changed,
      { mergeItems: [changed, child(changed, 'x'.repeat(1150000))] }), SCOPE, 'received');
    const bytes = Buffer.byteLength(JSON.stringify(record));
    assert.ok(bytes > 3_400_000 && bytes < 4 * 1024 * 1024);
    const effects = store.finishLarkDetailRun(f.db, scope, runId,
      [{ message_id: task.message_id, fingerprint: task.fingerprint, record, acquisition }]);
    assert.equal(effects.inserted, 0); assert.equal(effects.pending_details, f.roots.length);
  }
}
function runner(f) {
  const adapter = createLarkImAdapter({ run(args) {
    const prefix = '/open-apis/im/v1/messages/';
    assert.ok(args[2].startsWith(prefix), 'fixture must not perform any other transport');
    const id = args[2].slice(prefix.length), raw = f.roots.find(value => value.message_id === id);
    assert.ok(raw, 'all requested roots belong to this synthetic fixture');
    f.requests.push(id);
    if (id === f.failId) throw new Error('kind=network_error Synthetic incomplete acquisition');
    return { code: 0, data: { items: [raw, child(raw)], has_more: false } };
  } });
  // Storage/runtime contention is not simulated remote time. Keep this quota
  // regression deterministic; the existing deadline tests own elapsed time.
  return createSyncRunner({ ...adapter, nowIso: () => NOW, nowMs: () => START,
    readPendingLarkDetails: (db, scope, options) => {
      f.readLimits.push(options.limit);
      return store.readPendingLarkDetails(db, scope, options);
    },
    buildPeopleContext: () => ({ self: SELF }),
    reuseKnownSenderNames: (_db, rows) => rows });
}
const retryOptions = changes => ({ detailScope: SCOPE, detailBudgetMs: 30000,
  lockTtlSeconds: 600, retries: 0, retryDelayMs: 0, ...changes });

test('sixteen legal multi-megabyte candidates can be read and retried above the sqlite output ceiling', t => {
  const f = fixture(t, 16); seedCandidates(f);
  const before = summary(f);
  assert.equal(before.candidates, 16); assert.equal(before.attempts, 16);
  assert.ok(before.candidate_bytes > 50 * 1024 * 1024);
  const scope = currentScope(f), expected = f.roots.map(value => value.message_id);
  for (const limit of [1, 5, 20]) {
    const tasks = store.readPendingLarkDetails(f.db, scope, { limit, now: NOW });
    assert.deepEqual(tasks.map(task => task.message_id), expected.slice(0, limit));
    for (const task of tasks) {
      const evidence = JSON.parse(task.candidate_json);
      assert.equal(evidence.external_id, task.message_id);
      assert.equal(JSON.parse(evidence.raw_json).raw_api_expansions.merge_forward.items[1].body.content.length,
        JSON.stringify({ text: 'x'.repeat(1150000) }).length, 'complete evidence cannot be trimmed to fit a batch');
      assert.equal(task.candidate_generation, task.descriptor_generation);
      assert.equal(task.record_exists, 0);
    }
  }
  assert.deepEqual(summary(f), before, 'reading must not mutate or retire evidence');

  f.failId = expected.at(-1);
  const results = runner(f).retryDetails(f.db, retryOptions({ detailLimit: 20 }), SELF);
  assert.deepEqual(f.requests, expected);
  assert.deepEqual(f.readLimits, [1, 20], "pre-lock existence check must not duplicate the full candidate batch");
  assert.equal(results[0].detail_attempts, 16);
  assert.equal(results[0].inserted, 15);
  assert.equal(results[0].pending_details, 1);
  assert.equal(summary(f).attempts, 32);
  assert.equal(currentScope(f).cursor_json, null, 'one failed complete receipt still blocks full coverage');
  assert.equal(store.readLarkListProgress(f.db, currentScope(f)).cursor.created_at_ms, START + 60000);

  f.failId = null;
  const completion = runner(f).retryDetails(f.db, retryOptions({ detailLimit: 20 }), SELF);
  assert.equal(completion[0].detail_attempts, 1);
  assert.equal(completion[0].inserted, 1);
  assert.equal(summary(f).pending, 0);
  assert.equal(summary(f).candidates, 0);
  assert.equal(currentScope(f).cursor.created_at_ms, START + 60000);
  assert.equal(f.requests.length, 17);
});

test('the public read limit of one hundred preserves ordering while default retries remain five', t => {
  const f = fixture(t, 100), scope = currentScope(f);
  const expected = f.roots.map(value => value.message_id);
  const all = store.readPendingLarkDetails(f.db, scope, { limit: 100, now: NOW });
  assert.equal(all.length, 100);
  assert.deepEqual(all.map(task => task.message_id), expected);
  assert.ok(all.every(task => task.candidate_json === null && task.raw_root.message_id === task.message_id));
  assert.throws(() => store.readPendingLarkDetails(f.db, scope, { limit: 101, now: NOW }), /between 1 and 100/);

  const results = runner(f).retryDetails(f.db, retryOptions(), SELF);
  assert.deepEqual(f.requests, expected.slice(0, 5));
  assert.deepEqual(f.readLimits, [1, 5]);
  assert.equal(results[0].detail_attempts, 5);
  assert.equal(results[0].inserted, 5);
  assert.equal(summary(f).pending, 95);
  assert.equal(currentScope(f).cursor_json, null);
  const remaining = store.readPendingLarkDetails(f.db, currentScope(f), { limit: 100, now: NOW });
  assert.deepEqual(remaining.map(task => task.message_id), expected.slice(5));
});
