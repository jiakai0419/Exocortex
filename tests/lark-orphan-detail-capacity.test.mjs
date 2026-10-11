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

// Every identity and response is invented. The oversized child is generated
// locally to exercise the evidence limit, never fetched from a real service.
const START = Date.parse('2026-03-01T00:00:00.000Z');
const CHAT = 'oc_synthetic_capacity', SCOPE = chatScopeId(CHAT);
const SELF = { open_id: 'ou_synthetic_capacity_self', name: 'Synthetic Self' };
const q = store.quoteSql;
const root = (id = 'large', snapshot = 1, offset = 1000) => ({
  message_id: `om_synthetic_capacity_${id}`, chat_id: CHAT,
  create_time: String(START + offset), update_time: String(START + 2000), msg_type: 'merge_forward',
  sender: { id: 'ou_synthetic_capacity_author', id_type: 'open_id', sender_type: 'user' },
  body: { content: JSON.stringify({ snapshot }) },
});
const child = (parent, text = 'Synthetic child') => ({ ...parent,
  message_id: `${parent.message_id}_child`, upper_message_id: parent.message_id,
  msg_type: 'text', body: { content: JSON.stringify({ text }) },
});
function restart(f) {
  const adapter = createLarkImAdapter({ run(args) {
    const path = '/open-apis/im/v1/messages/';
    assert.ok(args[2].startsWith(path), 'only fixture detail transport is allowed');
    const response = f.responses.get(args[2].slice(path.length));
    assert.ok(response, 'detail target must be synthetic');
    f.calls += 1;
    if (f.failure) throw f.failure;
    return { code: 0, data: { items: response, has_more: false } };
  } });
  f.runner = createSyncRunner({ ...adapter, buildPeopleContext: () => ({ self: SELF }),
    nowIso: () => f.now, reuseKnownSenderNames: (_db, rows) => rows });
}
function fixture(t, roots = [root()]) {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-detail-capacity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite');
  store.ensureInitialized(db);
  const config = { initial_sync_start_ms: START, initial_account_binding: {
    kind: store.INITIAL_ACCOUNT_KIND,
    account_key: createHash('sha256').update(`lark.im\0${SELF.open_id}`).digest('hex'),
    reserved_at: '2026-03-01T00:00:00.000Z', confirmed_at: '2026-03-01T00:00:00.000Z',
  } };
  store.sqliteExec(db, `UPDATE sources SET config_json=${q(JSON.stringify(config))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(SCOPE)},'lark.im','Synthetic capacity scope',
      ${q(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`);
  const scope = store.readScope(db, SCOPE), runId = store.createRun(db, scope);
  store.commitLarkListRun(db, scope, runId, [], roots, roots.length,
    { created_at_ms: START + 60000, message_id: '' },
    { initial_sync_start_ms: START, list_window_start_ms: START, list_window_end_ms: START + 60000 });
  const f = { db, responses: new Map(roots.map(value => [value.message_id, [value, child(value)]])),
    calls: 0, failure: null, now: '2099-01-01T00:00:00.000Z' };
  restart(f); return f;
}
const readTask = (f, id = root().message_id) => store.sqliteQuery(f.db,
  `SELECT * FROM lark_im_detail_tasks WHERE message_id=${q(id)};`)[0];
const readRecords = f => store.sqliteQuery(f.db, 'SELECT * FROM records ORDER BY external_id;');
const candidate = task => Object.fromEntries(Object.entries(task).filter(([key]) => key.startsWith('candidate_')));
const retry = f => f.runner.retryDetails(f.db, { detailLimit: 5, detailScope: SCOPE, detailBudgetMs: 30000,
  lockTtlSeconds: 600, retries: 0, retryDelayMs: 0 }, SELF);
function setResponse(f, changed, oversized = false) {
  f.responses.set(changed.message_id, [changed, child(changed,
    oversized ? 'Synthetic '.repeat(200000) : 'Synthetic child')]);
}
function assertDebt(f, attempts) {
  const task = readTask(f);
  assert.equal(task.status, 'pending');
  assert.equal(task.attempt_count, attempts);
  assert.equal(store.readScope(f.db, SCOPE).cursor_json, null);
  assert.equal(store.readLarkListProgress(f.db, store.readScope(f.db, SCOPE)).cursor.created_at_ms, START + 60000);
  return task;
}

test('oversized orphan conflict backs off without rolling back a healthy detail in the same batch', t => {
  const healthy = root('healthy', 1, 1500), f = fixture(t, [root(), healthy]);
  const initial = readTask(f);
  setResponse(f, root('large', 2), true);
  const result = retry(f);
  const rejected = assertDebt(f, 1);
  assert.equal(rejected.candidate_json, null, 'oversized evidence is never persisted');
  assert.ok(Date.parse(rejected.retry_at) > Date.parse(initial.retry_at), 'rejected evidence uses normal task backoff');
  assert.match(rejected.last_error_message, /capacity|evidence.*limit/i);
  assert.equal(readTask(f, healthy.message_id).status, 'complete');
  assert.deepEqual(readRecords(f).map(record => record.external_id), [healthy.message_id]);
  assert.equal(result[0].detail_attempts, 2, 'both acquisitions count toward the bounded retry quota');
  assert.equal(result[0].inserted, 1);
  assert.equal(result[0].pending_details, 1);
  assert.equal(f.calls, 2);

  // A normal current-time retry cannot immediately re-acquire the large root.
  f.now = new Date().toISOString();
  restart(f); retry(f);
  assert.equal(f.calls, 2);
  assert.deepEqual(readTask(f), rejected);
});

test('a complete oversized contradiction invalidates qualification while preserving evidence through restart', t => {
  const f = fixture(t), changed = root('large', 2);
  setResponse(f, changed); retry(f);
  const first = assertDebt(f, 1), qualified = candidate(first);
  assert.ok(qualified.candidate_json);
  assert.equal(readRecords(f).length, 0);

  setResponse(f, changed, true); retry(f);
  const rejected = assertDebt(f, 2);
  assert.match(rejected.last_error_message, /capacity|evidence.*limit/i);
  const invalidated = { ...qualified, candidate_generation: null };
  assert.deepEqual(candidate(rejected), invalidated,
    'a complete oversized contradiction preserves diagnostic bytes, time, attempt and context but invalidates qualification');
  assert.equal(rejected.evidence_generation, first.evidence_generation + 1);
  assert.equal(readRecords(f).length, 0);

  f.failure = new Error('kind=network_error Synthetic interrupted response');
  restart(f); retry(f);
  const failed = assertDebt(f, 3);
  assert.deepEqual(candidate(failed), invalidated, 'a failed acquisition cannot restore or refresh old qualification');
  assert.equal(failed.evidence_generation, rejected.evidence_generation);
  assert.equal(readRecords(f).length, 0);

  f.failure = null; setResponse(f, changed); restart(f); retry(f);
  const fresh = assertDebt(f, 4);
  assert.equal(readRecords(f).length, 0, 'the old small snapshot cannot vote across the intervening complete contradiction');
  assert.equal(fresh.candidate_generation, fresh.descriptor_generation);
  assert.notEqual(fresh.candidate_attempt, qualified.candidate_attempt);
  assert.ok(fresh.candidate_observed_at_ms > qualified.candidate_observed_at_ms);
  assert.equal(fresh.candidate_context, qualified.candidate_context);
  assert.equal(fresh.evidence_generation, rejected.evidence_generation + 1);
  assert.equal(f.calls, 4);

  restart(f); retry(f);
  const complete = readTask(f);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.attempt_count, 5);
  assert.equal(complete.candidate_json, null);
  assert.equal(readRecords(f).length, 1);
  assert.deepEqual(JSON.parse(readRecords(f)[0].raw_json).body, changed.body);
  assert.equal(store.readScope(f.db, SCOPE).cursor.created_at_ms, START + 60000);
  assert.equal(f.calls, 5);
});
