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

// Every identity and complete response below is authored synthetic data.
// The only transport accepts detail URLs for messages in this temporary fixture.
const START = Date.parse('2026-03-01T00:00:00Z');
const CHAT = 'oc_synthetic_orphan_detail', SCOPE = chatScopeId(CHAT);
const SENT = 'lark.im.sent_by_me';
const SELF = { open_id: 'ou_synthetic_orphan_self', name: 'Synthetic Self' };
const q = store.quoteSql, sha = text => createHash('sha256').update(text).digest('hex');
const root = (snapshot = 1, extra = {}) => ({ message_id: 'om_synthetic_orphan_root', chat_id: CHAT,
  create_time: String(START + 1000), update_time: String(START + 2000), msg_type: 'merge_forward',
  sender: { id: 'ou_synthetic_orphan_author', id_type: 'open_id', sender_type: 'user' },
  body: { content: JSON.stringify({ snapshot }) }, ...extra });
const child = (body = 'Synthetic child', parent = root().message_id) => ({ ...root(),
  message_id: `${parent}_child`, upper_message_id: parent, msg_type: 'text',
  body: { content: JSON.stringify({ text: body }) } });
const page = items => ({ code: 0, data: { items, has_more: false } });
function restart(f) {
  f.adapter = createLarkImAdapter({ run: args => {
    const prefix = '/open-apis/im/v1/messages/';
    assert.ok(args[2].startsWith(prefix), 'no list, name or real transport');
    const messageId = args[2].slice(prefix.length), response = f.responses.get(messageId);
    assert.ok(response, 'detail target must belong to the synthetic fixture');
    f.calls += 1;
    const hook = f.onFetch; f.onFetch = null; hook?.();
    if (f.failure) throw f.failure;
    return page(response.root.msg_type === 'merge_forward'
      ? [response.root, ...response.children] : [response.root]);
  } });
  f.runner = createSyncRunner({ ...f.adapter, buildPeopleContext: () => ({ self: SELF }),
    nowIso: () => '2099-01-01T00:00:00.000Z', reuseKnownSenderNames: (_db, rows) => rows });
}
function fixture(t, scopeId = SCOPE) {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-orphan-details-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite'); store.ensureInitialized(db);
  store.sqliteExec(db, `UPDATE sources SET config_json=${q(JSON.stringify({ initial_sync_start_ms: START,
    initial_account_binding: { kind: store.INITIAL_ACCOUNT_KIND, account_key: sha(`lark.im\0${SELF.open_id}`),
      reserved_at: '2026-03-01T00:00:00.000Z', confirmed_at: '2026-03-01T00:00:00.000Z' } }))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(SCOPE)},'lark.im','Synthetic orphan scope',
      ${q(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`);
  const f = { db, scopeId, responses: new Map(), calls: 0, failure: null, onFetch: null };
  setRemote(f, root()); restart(f); return f;
}
function setRemote(f, raw, children = [child('Synthetic child', raw.message_id)]) {
  f.responses.set(raw.message_id, { root: raw, children });
}
const scope = f => store.readScope(f.db, f.scopeId);
const tasks = f => store.sqliteQuery(f.db, 'SELECT * FROM lark_im_detail_tasks ORDER BY message_id;');
const task = f => tasks(f)[0];
const records = f => store.sqliteQuery(f.db, 'SELECT * FROM records ORDER BY external_id;');
const progress = f => store.readLarkListProgress(f.db, scope(f));
const candidate = row => Object.fromEntries(Object.entries(row).filter(([key]) => key.startsWith('candidate_')));
function list(f, start, end, roots) {
  const sc = scope(f), run = store.createRun(f.db, sc);
  return store.commitLarkListRun(f.db, sc, run, [], roots, roots.length, { created_at_ms: end, message_id: '' },
    { initial_sync_start_ms: START, list_window_start_ms: start, list_window_end_ms: end });
}
function retry(f, options = {}, self = SELF) {
  return f.runner.retryDetails(f.db, { detailLimit: 5, detailScope: f.scopeId, detailBudgetMs: 30000,
    lockTtlSeconds: 600, retries: 0, retryDelayMs: 0, ...options }, self);
}
function queue(f, roots = [root()]) {
  list(f, START, START + 60000, roots);
  list(f, START + 60000, START + 120000, []);
}
function assertPending(f, attempts) {
  assert.equal(task(f).status, 'pending');
  assert.equal(task(f).attempt_count, attempts);
  assert.equal(records(f).length, 0, 'no incomplete placeholder or premature full record');
  assert.equal(scope(f).cursor_json, null, 'incomplete detail blocks complete-content coverage');
  assert.equal(progress(f).cursor.created_at_ms, START + 120000, 'list coverage remains ahead');
}
function assertComplete(f, raw, attempts) {
  assert.equal(task(f).status, 'complete'); assert.equal(task(f).attempt_count, attempts);
  assert.equal(records(f).length, 1);
  assert.equal(scope(f).cursor.created_at_ms, START + 120000);
  const stored = JSON.parse(records(f)[0].raw_json);
  assert.equal(stored.message_id, raw.message_id); assert.equal(stored.msg_type, raw.msg_type);
  assert.deepEqual(stored.body, raw.body); assert.deepEqual(stored.sender, raw.sender);
  if (raw.msg_type === 'merge_forward') assert.deepEqual(stored.raw_api_expansions.merge_forward.items[0], raw);
}

test('orphan equal-version conflict converges through two complete detail retries without history eligibility', t => {
  const f = fixture(t), changed = root(2); queue(f); setRemote(f, changed);
  const descriptor = task(f), listCursor = progress(f).cursor_json;
  retry(f); assertPending(f, 1);
  assert.ok(task(f).candidate_json, 'first independent complete response creates bounded candidate evidence');
  assert.equal(task(f).raw_root_json, descriptor.raw_root_json);
  assert.equal(task(f).fingerprint, descriptor.fingerprint);
  assert.equal(executeLarkImHistory({ db: f.db }, {
    createRequestSession: () => assert.fail('orphan convergence must not add a history request'),
  }).outcome, 'no_eligible_known_record');
  restart(f); retry(f); assertComplete(f, changed, 2);
  assert.equal(progress(f).cursor_json, listCursor); assert.equal(f.calls, 2);
  assert.equal(task(f).candidate_json, null);
});

test('a failed detail read and runner restart preserve the first complete orphan observation', t => {
  const f = fixture(t), changed = root(2); queue(f); setRemote(f, changed);
  retry(f); assertPending(f, 1); const first = candidate(task(f));
  assert.ok(first.candidate_json);
  f.failure = new Error('Synthetic interrupted detail acquisition'); retry(f);
  assertPending(f, 2); assert.deepEqual(candidate(task(f)), first, 'a failed response does not replace a complete candidate');
  f.failure = null; restart(f); retry(f); assertComplete(f, changed, 3);
});

test('orphan root B to C to B requires two independent reads of the current complete candidate', t => {
  const f = fixture(t); queue(f);
  for (const [index, snapshot] of [2, 3, 2].entries()) {
    setRemote(f, root(snapshot)); retry(f); assertPending(f, index + 1);
  }
  retry(f); assertComplete(f, root(2), 4);
});

test('same orphan root with changed descendants cannot inherit an earlier complete-tree vote', t => {
  const f = fixture(t), changed = root(2); queue(f);
  setRemote(f, changed, [child('Synthetic child B')]); retry(f); assertPending(f, 1);
  setRemote(f, changed, [child('Synthetic child C')]); retry(f); assertPending(f, 2);
  retry(f); assertComplete(f, changed, 3);
  assert.equal(JSON.parse(records(f)[0].raw_json).raw_api_expansions.merge_forward.items[1].body.content,
    child('Synthetic child C').body.content);
});

test('an orphan merge can independently confirm its ordinary replacement and complete the original debt', t => {
  const f = fixture(t), ordinary = root(2, { msg_type: 'text', body: { content: '{"text":"Synthetic ordinary replacement"}' } });
  queue(f); setRemote(f, ordinary); retry(f); assertPending(f, 1);
  restart(f); retry(f); assertComplete(f, ordinary, 2);
  assert.equal(JSON.parse(records(f)[0].raw_json).raw_api_expansions, undefined);
});

test('a newer complete orphan root keeps the existing single-read authoritative-version rule', t => {
  const f = fixture(t), newer = root(2, { update_time: String(START + 3000) });
  queue(f); setRemote(f, newer); retry(f); assertComplete(f, newer, 1);
  assert.equal(records(f)[0].external_version, String(START + 3000));
});

test('completing one orphan cannot promote the full cursor past another pending detail', t => {
  const f = fixture(t), other = root(1, { message_id: 'om_synthetic_orphan_second', create_time: String(START + 1500) });
  queue(f, [root(), other]); setRemote(f, root(2)); setRemote(f, other);
  retry(f, { detailLimit: 1 }); assert.equal(task(f).status, 'pending'); assert.equal(records(f).length, 0);
  // Select the first root again without changing the other root's durable debt.
  store.sqliteExec(f.db, `UPDATE lark_im_detail_tasks SET retry_at='2000-01-01T00:00:00.000Z' WHERE message_id=${q(root().message_id)};`);
  retry(f, { detailLimit: 1 });
  assert.equal(tasks(f)[0].status, 'complete'); assert.equal(tasks(f)[1].status, 'pending');
  assert.equal(records(f).length, 1); assert.equal(scope(f).cursor_json, null);
  assert.equal(progress(f).cursor.created_at_ms, START + 120000);
  retry(f, { detailLimit: 1 });
  assert.ok(tasks(f).every(row => row.status === 'complete')); assert.equal(records(f).length, 2);
  assert.equal(scope(f).cursor.created_at_ms, START + 120000);
});

test('existing records cannot gain equal-version confirmation from ordinary detail retries', t => {
  const f = fixture(t); list(f, START, START + 1000, [root()]); retry(f);
  assert.equal(task(f).status, 'complete'); assert.equal(records(f).length, 1);
  const accepted = records(f)[0];
  list(f, START + 1000, START + 2000, [root(2)]);
  setRemote(f, root(2));
  for (let index = 0; index < 3; index++) retry(f);
  assert.deepEqual(records(f)[0], accepted); assert.equal(task(f).status, 'pending');
  assert.equal(task(f).candidate_json, null, 'orphan-specific candidate state is never used for an existing row');
});

for (const mutation of ['account', 'source configuration', 'scope configuration'])
test(`an orphan candidate cannot confirm through changed ${mutation}`, t => {
  const f = fixture(t), changed = root(2); queue(f); setRemote(f, changed); retry(f); assertPending(f, 1);
  const originalSource = store.sqliteQuery(f.db, "SELECT config_json FROM sources WHERE id='lark.im';")[0].config_json;
  if (mutation === 'account') store.sqliteExec(f.db, `UPDATE sources SET config_json=json_set(config_json,
    '$.initial_account_binding.account_key',${q(sha('lark.im\0ou_synthetic_other_account'))}) WHERE id='lark.im';`);
  else if (mutation === 'source configuration') store.sqliteExec(f.db, "UPDATE sources SET config_json=json_set(config_json,'$.synthetic_policy',2) WHERE id='lark.im';");
  else store.sqliteExec(f.db, `UPDATE sync_scopes SET config_json=json_set(config_json,'$.synthetic_policy',2) WHERE id=${q(SCOPE)};`);
  retry(f); assert.equal(records(f).length, 0); assert.equal(task(f).status, 'pending');
  assert.equal(scope(f).cursor_json, null);
  if (mutation === 'account') {
    // The mismatching account could not confirm; restoring the verified original
    // account resumes its original qualification without introducing a freeze.
    store.sqliteExec(f.db, `UPDATE sources SET config_json=${q(originalSource)} WHERE id='lark.im';`);
    restart(f); retry(f); assertComplete(f, changed, 3);
  } else {
    restart(f); retry(f); assertComplete(f, changed, 3);
  }
});

for (const mutation of ['account', 'source', 'scope'])
test(`in-flight ${mutation} admission drift cannot publish an orphan confirmation`, t => {
  const f = fixture(t), changed = root(2); queue(f); setRemote(f, changed); retry(f); assertPending(f, 1);
  const before = task(f);
  f.onFetch = () => {
    if (mutation === 'account') store.sqliteExec(f.db, `UPDATE sources SET config_json=json_set(config_json,
      '$.initial_account_binding.account_key',${q(sha('lark.im\0ou_synthetic_inflight_other'))}) WHERE id='lark.im';`);
    else if (mutation === 'source') store.sqliteExec(f.db, "UPDATE sources SET enabled=0 WHERE id='lark.im';");
    else store.sqliteExec(f.db, `UPDATE sync_scopes SET enabled=0 WHERE id=${q(SCOPE)};`);
  };
  retry(f);
  assert.equal(records(f).length, 0); assert.deepEqual(task(f), before);
  assert.equal(scope(f).cursor_json, null);
});

test('a concurrent ordinary record insertion fences a late orphan confirmation', t => {
  const f = fixture(t), changed = root(2); queue(f); setRemote(f, changed); retry(f); assertPending(f, 1);
  const initial = recordFromMessage(normalizeApiMessage(root(), { mergeItems: [root(), child()] }), SCOPE,
    'received', { self: SELF }, { chat_id: CHAT, chat_type: 'group' });
  let inserted;
  f.onFetch = () => { store.sqliteExec(f.db, store.upsertRecordsSql([initial])); inserted = records(f)[0]; };
  retry(f);
  assert.deepEqual(records(f)[0], inserted); assert.equal(task(f).status, 'pending');
  assert.equal(scope(f).cursor_json, null);
  retry(f); assert.deepEqual(records(f)[0], inserted, 'later ordinary retry still requires existing-record history confirmation');
});

test('descriptor ABA fences a late orphan response even when the raw descriptor returns to its old bytes', t => {
  const f = fixture(t), changed = root(2); queue(f); setRemote(f, changed); retry(f); assertPending(f, 1);
  const before = task(f), listBefore = progress(f).generation;
  f.onFetch = () => {
    store.sqliteExec(f.db, `UPDATE lark_im_detail_tasks SET raw_root_json=${q(JSON.stringify(root(3)))}
      WHERE message_id=${q(root().message_id)};
      UPDATE lark_im_detail_tasks SET raw_root_json=${q(before.raw_root_json)} WHERE message_id=${q(root().message_id)};
      UPDATE lark_im_list_progress SET generation=generation+2 WHERE scope_id=${q(SCOPE)};`);
  };
  retry(f);
  assert.equal(records(f).length, 0); assert.equal(task(f).status, 'pending');
  assert.equal(task(f).attempt_count, before.attempt_count);
  assert.equal(task(f).raw_root_json, before.raw_root_json);
  assert.equal(task(f).descriptor_generation, before.descriptor_generation + 2);
  assert.equal(progress(f).generation, listBefore + 2); assert.equal(scope(f).cursor_json, null);
  retry(f); assert.equal(records(f).length, 0, 'new descriptor generation requires a new first observation');
  retry(f); assertComplete(f, changed, 3);
});

test('sent-by-me orphan details bind each queued chat and confirm only the matching complete candidate', t => {
  const f = fixture(t, SENT), sender = { ...root().sender, id: SELF.open_id };
  const roots = [root(1, { sender }), root(1, { message_id: 'om_synthetic_orphan_sent_second',
    chat_id: 'oc_synthetic_orphan_other_chat', create_time: String(START + 1500), sender })];
  assert.equal(scope(f).config.chat_id, undefined, 'sent scope deliberately has no single chat route');
  queue(f, roots);
  for (const queued of roots) {
    const changed = { ...queued, body: { content: '{"snapshot":2}' } };
    setRemote(f, changed, [{ ...child('Synthetic sent child', queued.message_id), chat_id: queued.chat_id }]);
  }
  retry(f);
  assert.equal(records(f).length, 0); assert.equal(scope(f).cursor_json, null);
  assert.ok(tasks(f).every(row => row.status === 'pending' && row.attempt_count === 1 && row.candidate_json));
  assert.deepEqual(tasks(f).map(row => JSON.parse(row.raw_root_json).chat_id).sort(), roots.map(row => row.chat_id).sort());
  restart(f); retry(f);
  assert.ok(tasks(f).every(row => row.status === 'complete' && row.attempt_count === 2 && row.candidate_json === null));
  assert.equal(records(f).length, 2); assert.equal(scope(f).cursor.created_at_ms, START + 120000);
  for (const saved of records(f)) {
    const queued = roots.find(row => row.message_id === saved.external_id);
    assert.ok(queued); assert.equal(saved.container_id, queued.chat_id);
    assert.equal(saved.direction, 'sent'); assert.equal(saved.actor_id, SELF.open_id);
    assert.equal(saved.first_seen_scope_id, SENT);
    assert.equal(JSON.parse(saved.raw_json).raw_api_expansions.merge_forward.items[0].body.content, '{"snapshot":2}');
  }
  assert.equal(f.calls, 4, 'two selected roots each acquire two independent complete responses');
});

test('a same-version sender change in sent-by-me debt needs two complete observations and retains first-seen scope', t => {
  const f = fixture(t, SENT), sender = { ...root().sender, id: SELF.open_id };
  const queued = root(1, { sender }); queue(f, [queued]);
  const foreign = root(1, { sender: { ...sender, id: 'ou_synthetic_foreign_sender' } });
  setRemote(f, foreign);
  retry(f); assertPending(f, 1);
  assert.ok(task(f).candidate_json, 'sender source differences do not become immediate source acceptance');
  assert.equal(JSON.parse(task(f).raw_root_json).sender.id, SELF.open_id);
  restart(f); retry(f); assertComplete(f, foreign, 2);
  assert.equal(records(f)[0].direction, 'received'); assert.equal(records(f)[0].actor_id, foreign.sender.id);
  assert.equal(records(f)[0].first_seen_scope_id, SENT, 'first-seen scope is provenance, not current sender identity');
  assert.equal(f.calls, 2);
});

for (const [label, queued, refreshed] of [
  ['millisecond to second timestamps', root(), root(1, {
    create_time: String((START + 1000) / 1000), update_time: String((START + 2000) / 1000),
  })],
  ['second to millisecond timestamps', root(1, {
    create_time: String((START + 1000) / 1000), update_time: String((START + 2000) / 1000),
  }), root()],
  ['absent to empty root-parent metadata', root(), root(1, { upper_message_id: '' })],
  ['empty to absent root-parent metadata', root(1, { upper_message_id: '' }), root()],
]) test(`an equivalent orphan root completes on its first receipt: ${label}`, t => {
  const f = fixture(t); queue(f, [queued]); setRemote(f, refreshed);
  retry(f); assertComplete(f, refreshed, 1);
  assert.equal(records(f)[0].occurred_at_ms, START + 1000);
  assert.equal(records(f)[0].external_version, String(START + 2000));
  assert.equal(task(f).candidate_json, null); assert.equal(f.calls, 1);
});
