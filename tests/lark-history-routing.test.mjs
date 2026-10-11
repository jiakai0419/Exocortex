import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';
import { createSyncRunner } from '../src/adapters/lark-im/sync-runner.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { executeLarkImHistory, selectHistoryTarget } from '../src/maintenance/history.mjs';

// Entirely authored synthetic records. No source account, logs, or API access.
const START = Date.parse('2026-02-01T00:00:00Z');
const SELF = { open_id: 'ou_synthetic_unreachable_self', name: 'Synthetic Self' };
const CHAT = 'oc_synthetic_unreachable_history';
const SCOPE = chatScopeId(CHAT);
const SENT = 'lark.im.sent_by_me';
const q = store.quoteSql;
const raw = (changes = {}) => ({ message_id: 'om_synthetic_unreachable_history', chat_id: CHAT,
  msg_type: 'text', create_time: String(START + 1000), update_time: String(START + 2000),
  sender: { id: SELF.open_id, id_type: 'open_id', sender_type: 'user' },
  body: { content: '{"text":"Synthetic original"}' }, ...changes });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-history-unreachable-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite');
  store.ensureInitialized(db);
  store.sqliteExec(db, `UPDATE sources SET config_json=${q(JSON.stringify({ initial_sync_start_ms: START,
    initial_account_binding: { kind: store.INITIAL_ACCOUNT_KIND,
      account_key: createHash('sha256').update(`lark.im\0${SELF.open_id}`).digest('hex'),
      reserved_at: '2026-02-01T00:00:00.000Z', confirmed_at: '2026-02-01T00:00:00.000Z' } }))}
    WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(SCOPE)},'lark.im','Synthetic history',
      ${q(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`);
  return { db };
}
function put(f, scopeId, message) {
  const scope = store.readScope(f.db, scopeId), run = store.createRun(f.db, scope);
  const record = recordFromMessage(normalizeApiMessage(message), scopeId, 'sent', { self: SELF },
    { chat_id: CHAT, chat_type: 'group' });
  return store.succeedRecordRun(f.db, scope, run, [record], 1, { created_at_ms: START + 60000 }, {});
}
const records = f => store.sqliteQuery(f.db, 'SELECT * FROM records;');
function history(f, message, afterSelection) {
  return executeLarkImHistory({ db: f.db, maxCliAttempts: 4, maxSeconds: 30 }, {
    createRequestSession: () => ({ runLark: () => assert.fail('Unexpected real transport'),
      assertReady() {}, summary: () => ({ cli_attempts: 2, max_cli_attempts: 4, max_seconds: 30, elapsed_ms: 1 }) }),
    getSelfProfile: () => SELF,
    fetchChatMessageList: (chat, start, end) => {
      assert.equal(chat, CHAT);
      assert.equal(start, START + 1000);
      assert.equal(end, START + 2000);
      afterSelection?.();
      return { messages: [normalizeApiMessage(message)], pages: 1 };
    },
  });
}

test('sent-first native rows remain reachable through their enabled received chat history', t => {
  const f = fixture(t), initial = raw(), changed = raw({ body: { content: '{"text":"Synthetic missed edit"}' } });
  put(f, SENT, initial);
  put(f, SCOPE, initial);
  assert.equal(records(f)[0].first_seen_scope_id, SENT, 'normal duplicate ingestion preserves original provenance');
  const before = records(f)[0];
  const receivedCursor = store.readScope(f.db, SCOPE).cursor_json;
  const sentCursor = store.readScope(f.db, SENT).cursor_json;
  const first = history(f, changed);
  assert.equal(first.outcome, 'pending_observation', 'a routable sent-first row must receive the same conservative first history observation');
  assert.deepEqual(records(f)[0], before);
  assert.equal(history(f, changed).updated, 1);
  const after = records(f)[0];
  assert.equal(after.raw_json, JSON.stringify(changed));
  assert.equal(after.first_seen_scope_id, SENT);
  assert.equal(store.readScope(f.db, SCOPE).cursor_json, receivedCursor);
  assert.equal(store.readScope(f.db, SENT).cursor_json, sentCursor);
});

for (const exclusion of ['disabled source', 'disabled route', 'different chat', 'before baseline', 'legacy API', 'unordered version']) {
  test(`sent-first history still rejects ${exclusion}`, t => {
    const f = fixture(t); put(f, SENT, raw());
    const sql = {
      'disabled source': "UPDATE sources SET enabled=0 WHERE id='lark.im';",
      'disabled route': `UPDATE sync_scopes SET enabled=0 WHERE id=${q(SCOPE)};`,
      'different chat': "UPDATE records SET container_id='oc_synthetic_other_chat';",
      'before baseline': `UPDATE records SET occurred_at_ms=${START - 1};`,
      'legacy API': "UPDATE records SET canonical_json=json_set(canonical_json,'$.source_api','synthetic_legacy');",
      'unordered version': "UPDATE records SET external_version='synthetic-opaque';",
    }[exclusion];
    store.sqliteExec(f.db, sql);
    const before = records(f);
    assert.equal(selectHistoryTarget(f.db), null);
    assert.equal(executeLarkImHistory({ db: f.db }, {
      createRequestSession: () => assert.fail('Ineligible history must not request remote access'),
    }).outcome, 'no_eligible_known_record');
    assert.deepEqual(records(f), before);
  });
}

test('a disabled provenance scope does not freeze history on an enabled discovered chat', t => {
  const f = fixture(t); put(f, SENT, raw());
  store.sqliteExec(f.db, `UPDATE sync_scopes SET enabled=0 WHERE id=${q(SENT)};`);
  const changed = raw({ update_time: String(START + 3000), deleted: true });
  assert.equal(history(f, changed).updated, 1);
  assert.equal(records(f)[0].first_seen_scope_id, SENT);
  assert.equal(JSON.parse(records(f)[0].raw_json).deleted, true);
  assert.equal(store.readScope(f.db, SENT).enabled, 0);
});

test('an existing fixed-horizon sweep wraps to newly eligible lower sent-first IDs', t => {
  const f = fixture(t), sent = raw();
  const received = [2, 3].map(index => raw({ message_id: `om_synthetic_received_history_${index}` }));
  put(f, SENT, sent);
  for (const message of received) put(f, SCOPE, message);
  const byId = new Map(records(f).map(record => [record.external_id, record.id]));
  const after = byId.get(received[0].message_id), horizon = byId.get(received[1].message_id);
  // A previous release had processed the first received-origin row and fixed
  // its horizon before sent-origin rows became reachable. Do not reset it.
  store.sqliteExec(f.db, `INSERT INTO lark_im_history_progress(scope_id,generation,after_id,sweep_max_id)
    VALUES(${q(SCOPE)},7,${after},${horizon});`);
  assert.equal(selectHistoryTarget(f.db).record.external_id, received[1].message_id);
  assert.equal(history(f, received[1]).outcome, 'processed');
  const wrapped = selectHistoryTarget(f.db);
  assert.equal(wrapped.record.external_id, sent.message_id);
  assert.equal(wrapped.checkpoint.generation, 8);
  assert.equal(wrapped.checkpoint.completedSweeps, 1);
  assert.equal(records(f).find(record => record.external_id === sent.message_id).first_seen_scope_id, SENT);
});

for (const mutation of ['provenance', 'route']) {
  test(`sent-first history keeps the final ${mutation} fence`, t => {
    const f = fixture(t); put(f, SENT, raw());
    const changed = raw({ update_time: String(START + 3000), body: { content: '{"text":"Synthetic newer edit"}' } });
    let concurrent;
    assert.throws(() => history(f, changed, () => {
      store.sqliteExec(f.db, mutation === 'provenance'
        ? `UPDATE records SET first_seen_scope_id=${q(SCOPE)};`
        : `UPDATE sync_scopes SET enabled=0 WHERE id=${q(SCOPE)};`);
      concurrent = records(f);
    }));
    assert.deepEqual(records(f), concurrent);
    assert.equal(store.sqliteQuery(f.db, 'SELECT COUNT(*) n FROM lark_im_history_progress;')[0].n, 0);
    assert.equal(store.sqliteQuery(f.db, 'SELECT candidate_json FROM record_observation_state;')[0].candidate_json, null);
  });
}

test('record-only history leaves orphan confirmation to independent complete detail retries', t => {
  const f = fixture(t);
  const queued = raw({ msg_type: 'merge_forward', body: { content: '{"snapshot":1}' } });
  const current = raw({ msg_type: 'merge_forward', body: { content: '{"snapshot":2}' } });
  const child = raw({ message_id: 'om_synthetic_unreachable_child', upper_message_id: queued.message_id,
    body: { content: '{"text":"Synthetic child"}' } });
  const adapter = createLarkImAdapter({ run: args => {
    assert.equal(args[2], `/open-apis/im/v1/messages/${queued.message_id}`);
    return { code: 0, data: { items: [current, child], has_more: false } };
  } });
  const runner = createSyncRunner({ ...adapter, buildPeopleContext: () => ({ self: SELF }),
    nowIso: () => '2099-01-01T00:00:00.000Z', reuseKnownSenderNames: (_db, rows) => rows });
  const list = (start, end, roots) => {
    const scope = store.readScope(f.db, SCOPE), run = store.createRun(f.db, scope);
    return store.commitLarkListRun(f.db, scope, run, [], roots, roots.length, { created_at_ms: end },
      { initial_sync_start_ms: START, list_window_start_ms: start, list_window_end_ms: end });
  };
  const retry = () => runner.retryDetails(f.db, { detailLimit: 1, detailScope: SCOPE, detailBudgetMs: 30000,
    lockTtlSeconds: 600, retries: 0, retryDelayMs: 0 }, SELF);
  const task = () => store.sqliteQuery(f.db, 'SELECT * FROM lark_im_detail_tasks;')[0];
  list(START, START + 60000, [queued]); retry();
  const initialTask = task();
  assert.equal(initialTask.status, 'pending');
  assert.equal(initialTask.last_error_type, "LarkDetailObservationConflict");
  assert.ok(initialTask.candidate_json);
  assert.equal(records(f).length, 0);
  list(START + 60000, START + 120000, []);
  const fullBefore = store.readScope(f.db, SCOPE).cursor_json;
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(executeLarkImHistory({ db: f.db }, {
      createRequestSession: () => assert.fail('Known-row history has no eligible stored target'),
    }).outcome, 'no_eligible_known_record');
  }
  retry();
  const retained = task();
  assert.equal(retained.status, 'complete');
  assert.equal(retained.last_error_message, null);
  assert.equal(retained.attempt_count, 2);
  assert.equal(retained.candidate_json, null);
  assert.equal(records(f).length, 1, 'only the second independent complete receipt creates the record');
  assert.equal(JSON.parse(records(f)[0].raw_json).body.content, current.body.content);
  assert.equal(fullBefore, null);
  assert.equal(store.readScope(f.db, SCOPE).cursor.created_at_ms, START + 120000);
  assert.equal(store.readLarkListProgress(f.db, store.readScope(f.db, SCOPE)).cursor.created_at_ms, START + 120000);
});
