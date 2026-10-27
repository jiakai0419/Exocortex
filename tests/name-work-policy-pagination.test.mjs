import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { initialNameWorkSelection, selectNameWork } from '../src/adapters/lark-im/name-work-policy.mjs';
import { prepareSenderWork } from '../src/adapters/lark-im/sender-name-work.mjs';
import { nameTaskKey } from '../src/adapters/lark-im/name-evidence.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { ensureInitialized, sqliteExec, sqliteQuery, quoteSql } from '../dist/storage/sqlite/ingestion-store.js';

// Actual sender pagination against a newly authored SQLite record, with fake
// CLI responses, clock and process restart. No private fixtures or real calls.
const SELF = 'ou_synthetic_policy_self', ACTOR = 'ou_synthetic_policy_actor', CHAT = 'oc_synthetic_policy_chat';
const ACCOUNT = recipientAccountKey(SELF), NOW = Date.parse('2031-02-03T04:05:00Z');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'exo-policy-page-')), db = join(root, 'synthetic.sqlite');
  t.after(() => rmSync(root, { force: true, recursive: true }));
  ensureInitialized(db);
  const raw = { message_id: 'om_synthetic_policy', chat_id: CHAT, chat_type: 'group',
    sender: { id: ACTOR, id_type: 'open_id', sender_type: 'user' } };
  const canonical = { message_id: raw.message_id, chat_id: CHAT, chat_type: 'group',
    sender_id: ACTOR, sender_id_type: 'open_id', sender_name: null, extra: 'preserve exactly' };
  sqliteExec(db, `INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,
    record_type,actor_id,container_id,direction,body,canonical_json,raw_json)
    VALUES(1,'lark.im','lark.im.sent_by_me',${quoteSql(raw.message_id)},'v1','lark.im.message',
      ${quoteSql(ACTOR)},${quoteSql(CHAT)},'received','Synthetic preserved body',
      ${quoteSql(JSON.stringify(canonical))},${quoteSql(JSON.stringify(raw))});`, 'author policy pagination');
  return { db, task: { source_id: 'lark.im', kind: 'sender', account_key: ACCOUNT, chat_id: CHAT,
    actor_id: ACTOR, namespace: 'open_id', task_key: nameTaskKey('sender', CHAT, ACTOR, 'open_id'),
    latest_record_id: 1, after_record_id: 0, evidence_json: null } };
}
function runPage(f, clock, requested, onResponse = () => {}) {
  let calls = 0;
  const result = prepareSenderWork(f.task, { db: f.db, self: { open_id: SELF }, accountKey: ACCOUNT,
    nowMs: clock, query: sql => sqliteQuery(f.db, sql, 'read synthetic policy page'),
    runLark: (args, opts) => {
      calls++; assert.ok(calls <= 3, 'one of four existing slots is reserved for the coordinator profile');
      assert.equal(opts.retries, 0);
      if (args[0] === 'contact') return { users: [] };
      assert.equal(args.slice(0, 3).join(' '), 'im chat.members get');
      const params = JSON.parse(args[args.indexOf('--params') + 1]);
      const page = params.page_token ? Number(params.page_token.split('-').at(-1)) : 0;
      requested.push(page); onResponse(page);
      return page < 3 ? { items: [], has_more: true, page_token: `synthetic-page-${page + 1}` }
        : { items: [{ member_id: ACTOR, member_id_type: 'open_id', name: 'Synthetic Exact Name' }], has_more: false };
    } });
  assert.ok(calls + 1 <= 4, 'policy does not increase existing opportunity calls including profile');
  return result;
}
function saveProgress(f, result) {
  f.task = JSON.parse(JSON.stringify({ ...f.task, evidence_json: result.evidenceJson,
    after_record_id: result.afterRecordId, projection_horizon_record_id: result.horizonRecordId,
    projection_deferred: Number(result.projectionDeferred) }));
}
function descriptor(key, changes = {}) {
  return { key, tier: 'fresh', operation: 'chat_members', enqueuedSequence: 0,
    lastServedSequence: 0, dueAtMs: 0, claimedUntilMs: 0, blocked: false, ...changes };
}

test('real member paging resumes across choices without app failures consuming the admitted request budget', t => {
  const f = fixture(t), requested = [], before = sqliteQuery(f.db, 'SELECT * FROM records;', 'before')[0];
  let state = initialNameWorkSelection();
  const candidates = [descriptor('human'), ...Array.from({ length: 64 }, (_, i) =>
    descriptor(`denied-app-${i}`, { operation: 'application_info', blocked: true }))];
  for (let turn = 0; turn < 2; turn++) {
    const choice = selectNameWork(candidates, state, { nowMs: NOW + turn * 60_000, resource: 'remote' });
    assert.equal(choice.candidate.key, 'human');
    state = JSON.parse(JSON.stringify(choice.nextState));
    choice.candidate.lastServedSequence = choice.nextLastServedSequence;
    const result = runPage(f, NOW + turn * 60_000, requested);
    assert.equal(result.outcome, turn === 0 ? 'pending' : 'resolved');
    saveProgress(f, result);
    for (const sql of result.updates) sqliteExec(f.db, sql, 'apply synthetic exact name');
  }
  assert.deepEqual(requested, [0, 1, 2, 3]);
  const after = sqliteQuery(f.db, 'SELECT * FROM records;', 'after')[0];
  assert.equal(JSON.parse(after.canonical_json).sender_name, 'Synthetic Exact Name');
  for (const key of Object.keys(before)) if (key !== 'canonical_json') assert.deepEqual(after[key], before[key]);
});

test('interruption before committing a page receipt replays from the last durable token', t => {
  const f = fixture(t), requested = [];
  let state = initialNameWorkSelection(), row = descriptor('human');
  const choose = nowMs => {
    const choice = selectNameWork([row], state, { nowMs, resource: 'remote' });
    if (choice) {
      state = JSON.parse(JSON.stringify(choice.nextState));
      row = { ...row, lastServedSequence: choice.nextLastServedSequence, claimedUntilMs: nowMs + 300_000 };
    }
    return choice;
  };
  assert.ok(choose(NOW));
  const uncommitted = runPage(f, NOW, requested);
  assert.equal(uncommitted.outcome, 'pending');
  // Process is lost here: neither evidence_json nor record mutation is saved.
  f.task = JSON.parse(JSON.stringify(f.task)); row = JSON.parse(JSON.stringify(row));
  assert.equal(choose(NOW + 60_000), null);
  assert.ok(choose(NOW + 300_000));
  const repeated = runPage(f, NOW + 300_000, requested); saveProgress(f, repeated);
  row.claimedUntilMs = 0;
  assert.ok(choose(NOW + 360_000));
  const resumed = runPage(f, NOW + 360_000, requested);
  assert.equal(resumed.outcome, 'resolved');
  assert.deepEqual(requested, [0, 1, 0, 1, 2, 3]);
});
