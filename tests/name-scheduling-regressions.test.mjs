import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureInitialized, reserveInitialLarkAccount, confirmInitialLarkAccountSql,
  quoteSql as q, sqliteExec, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';
import { syncNames } from '../src/adapters/lark-im/name-sync.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { nameTaskKey } from '../src/adapters/lark-im/name-evidence.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';

test('scope conflicts consume a fair turn so five old cleared scopes cannot starve a fresh identity', t => {
  const self = 'ou_synthetic_conflict_self', account = recipientAccountKey(self);
  const now = Date.parse('2032-04-05T06:07:00Z');
  const dir = mkdtempSync(join(tmpdir(), 'exo-synthetic-conflict-')), db = join(dir, 'synthetic.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  ensureInitialized(db);
  reserveInitialLarkAccount(db, account, new Date().toISOString());
  sqliteExec(db, confirmInitialLarkAccountSql(new Date().toISOString()));
  const read = sql => sqliteQuery(db, sql, 'inspect synthetic scheduling regression');
  function add(id, known) {
    const chat = `oc_synthetic_conflict_${id}`, actor = `ou_synthetic_conflict_${id}`;
    const message = `om_synthetic_conflict_${id}`;
    const raw = { message_id: message, chat_id: chat, chat_type: 'group',
      sender: { id: actor, id_type: 'open_id', sender_type: 'user', name: known ? 'Synthetic Existing Name' : undefined } };
    const canonical = { message_id: message, chat_id: chat, chat_type: 'group', sender_id: actor,
      sender_id_type: 'open_id', sender_name: known ? 'Synthetic Existing Name' : null,
      chat_name: 'Synthetic Known Group', msg_type: 'text' };
    sqliteExec(db, `INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,record_type,actor_id,container_id,direction,body,canonical_json,raw_json)
      VALUES(${id},'lark.im','lark.im.sent_by_me',${q(message)},'synthetic-v1','lark.im.message',${q(actor)},${q(chat)},'received','Synthetic body',${q(JSON.stringify(canonical))},${q(JSON.stringify(raw))});`);
    sqliteExec(db, `INSERT INTO sync_scopes(id,source_id,name,enabled,config_json)
      VALUES(${q(chatScopeId(chat))},'lark.im',${q('Synthetic Group ' + id)},0,${q(JSON.stringify({ chat_id: chat,
      chat_type: 'group', chat_name: 'Synthetic Known Group', ...(known ? { chat_name_state: 'cleared' } : {}) }))});`);
    // These are valid historical chat tasks. The scope was subsequently cleared;
    // no malformed task key or fabricated identity is needed for the regression.
    if (known) sqliteExec(db, `INSERT INTO lark_im_name_tasks(source_id,account_key,task_key,kind,chat_id,latest_record_id,retry_at_ms,enqueued_sequence,last_served_sequence,serviced_record_id)
      VALUES('lark.im',${q(account)},${q(nameTaskKey('chat', chat, '', ''))},'chat',${q(chat)},${id},0,0,0,${id});`);
  }
  for (let id = 1; id <= 5; id++) add(id, true);
  add(6, false);
  sqliteExec(db, `INSERT INTO lark_im_name_scan(account_key,schedule_sequence,schedule_slot) VALUES(${q(account)},2,2);`);
  const calls = [];
  const turn = at => syncNames(db, { open_id: self }, { now: () => at, monotonicNow: () => 0,
    syncRecipients: () => assert.fail('received-only work cannot reserve an empty recipient turn'),
    runLark: (args, options) => {
      calls.push(args); assert.equal(options.retries, 0);
      if (args[0] === 'contact' && args[1] === '+get-user') return { open_id: self };
      if (args[0] === 'contact' && args[1] === '+search-user') {
        assert.ok(args.includes('ou_synthetic_conflict_6'));
        return { users: [{ open_id: 'ou_synthetic_conflict_6', name: 'Synthetic Fresh Name' }] };
      }
      assert.fail('unexpected synthetic route');
    } });
  const first = turn(now);
  assert.equal(first.reason, 'scope_conflict'); assert.equal(first.calls, 0);
  assert.deepEqual(read('SELECT schedule_sequence,schedule_slot FROM lark_im_name_scan;')[0],
    { schedule_sequence: 3, schedule_slot: 0 });
  assert.equal(read("SELECT COUNT(*) AS n FROM lark_im_name_tasks WHERE outcome='conflict' AND last_served_sequence=3;")[0].n, 1);
  const second = turn(now + 60_001);
  assert.equal(second.reason, 'resolved'); assert.equal(second.calls, 2); assert.equal(calls.length, 2);
  assert.equal(JSON.parse(read('SELECT canonical_json FROM records WHERE id=6;')[0].canonical_json).sender_name, 'Synthetic Fresh Name');
  assert.equal(read("SELECT last_attempt_at_ms FROM lark_im_name_tasks WHERE actor_id='ou_synthetic_conflict_6';")[0].last_attempt_at_ms, now + 60_001);
  assert.deepEqual(read('SELECT schedule_sequence,schedule_slot FROM lark_im_name_scan;')[0],
    { schedule_sequence: 4, schedule_slot: 1 });
});

const RR_NOW = Date.parse('2032-04-05T06:07:00Z');
const RR_SELF = 'ou_synthetic_route_regression_owner';
const RR_ACTOR = 'ou_synthetic_route_regression_sender';
const RR_CHAT = 'oc_synthetic_route_regression_conversation';
const RR_ACCOUNT = recipientAccountKey(RR_SELF);
function rrFixture(t, mode = 'p2p') {
  const directory = mkdtempSync(join(tmpdir(), 'exo-synthetic-route-regression-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'authored.sqlite'); ensureInitialized(db);
  reserveInitialLarkAccount(db, RR_ACCOUNT, new Date().toISOString());
  sqliteExec(db, confirmInitialLarkAccountSql(new Date().toISOString()));
  const raw = { message_id: 'om_synthetic_route_regression_message', chat_id: RR_CHAT,
    chat_type: mode, sender: { id: RR_ACTOR, id_type: 'open_id', sender_type: 'user' } };
  const canonical = { message_id: raw.message_id, chat_id: RR_CHAT, chat_type: mode,
    chat_name_state: 'cleared', sender_id: RR_ACTOR, sender_id_type: 'open_id',
    sender_name: null, msg_type: 'text' };
  sqliteExec(db, `INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,
    record_type,actor_id,container_id,direction,body,canonical_json,raw_json)
    VALUES(1,'lark.im','lark.im.sent_by_me',${q(raw.message_id)},'synthetic-v1',
    'lark.im.message',${q(RR_ACTOR)},${q(RR_CHAT)},'received','Authored synthetic body',
    ${q(JSON.stringify(canonical))},${q(JSON.stringify(raw))});`);
  return { db, now: RR_NOW, calls: [] };
}
const rrTask = f => sqliteQuery(f.db, "SELECT * FROM lark_im_name_tasks WHERE kind='sender';")[0];
const rrRoutes = f => sqliteQuery(f.db, 'SELECT * FROM lark_im_name_routes ORDER BY operation;');
const rrDenied = operation => { throw new Error(`lark-cli failed: kind=permission_denied code=210508 operation=${operation}`); };
function rrRun(f, respond, additional = {}) {
  return syncNames(f.db, { open_id: RR_SELF }, {
    now: () => f.now, monotonicNow: () => 0,
    syncRecipients: () => assert.fail('received-only records must not enter recipient work'),
    runLark: (args, options) => {
      f.calls.push({ args, options }); assert.equal(options.retries, 0);
      if (args[0] === 'contact' && args[1] === '+get-user') return { open_id: RR_SELF };
      return respond(args, options);
    }, ...additional,
  });
}

test('p2p sender denial isolates its only applicable route and actually probes after 24 hours', t => {
  const f = rrFixture(t);
  const first = rrRun(f, args => {
    assert.deepEqual(args.slice(0, 2), ['contact', '+search-user']);
    return rrDenied('contact_search');
  });
  assert.equal(first.calls, 2); assert.equal(first.updated, 0);
  const denied = rrTask(f);
  assert.equal(denied.blocked_reason, 'permission_denied');
  assert.equal(denied.retry_at_ms, RR_NOW + 24 * 60 * 60_000);
  assert.equal(rrRoutes(f).length, 1, 'private chats have no member fallback route');
  f.now = RR_NOW + 5 * 60_000 + 1;
  const early = rrRun(f, () => assert.fail('quarantined route must not run early'));
  assert.equal(early.calls, 0); assert.equal(rrTask(f).blocked_reason, 'permission_denied');
  f.now = RR_NOW + 24 * 60 * 60_000 + 1;
  const recovered = rrRun(f, args => {
    assert.deepEqual(args.slice(0, 2), ['contact', '+search-user']);
    return { users: [{ open_id: RR_ACTOR, name: 'Synthetic Exact Sender' }] };
  });
  assert.equal(recovered.reason, 'resolved'); assert.equal(recovered.calls, 2);
  assert.equal(rrTask(f).blocked_reason, null);
  assert.equal(rrRoutes(f)[0].blocked, 0);
  assert.equal(JSON.parse(sqliteQuery(f.db, 'SELECT canonical_json FROM records WHERE id=1;')[0].canonical_json).sender_name,
    'Synthetic Exact Sender');
});

test('route DB read consumes the same ten-second deadline before request options are chosen', t => {
  const f = rrFixture(t); let elapsed = 0, advanced = false;
  const launches = [];
  const result = rrRun(f, () => ({ users: [{ open_id: RR_ACTOR, name: 'Synthetic Exact Sender' }] }), {
    monotonicNow: () => elapsed,
    readOnlyQuery: (db, sql, label, options) => {
      const rows = readOnlySqliteJson(db, sql, label, options);
      if (label === 'read exact name route' && !advanced) { advanced = true; elapsed = 9500; }
      return rows;
    },
    runLark: (args, options) => {
      launches.push({ elapsed, options });
      if (args[1] === '+get-user') return { open_id: RR_SELF };
      return { users: [{ open_id: RR_ACTOR, name: 'Synthetic Exact Sender' }] };
    },
  });
  assert.equal(result.reason, 'resolved'); assert.equal(result.calls, 2);
  assert.equal(launches.length, 2);
  for (const launch of launches) {
    assert.equal(launch.elapsed, 9500);
    assert(launch.options.timeoutMs > 0 && launch.options.timeoutMs <= 500);
    assert(launch.options.retryBudgetMs > 0 && launch.options.retryBudgetMs <= 500);
  }
});

test('route DB read reaching the deadline starts no request and adopts no lookup', t => {
  const f = rrFixture(t); let elapsed = 0, advanced = false;
  const result = rrRun(f, () => assert.fail('expired deadline must prevent request'), {
    monotonicNow: () => elapsed,
    readOnlyQuery: (db, sql, label, options) => {
      const rows = readOnlySqliteJson(db, sql, label, options);
      if (label === 'read exact name route' && !advanced) { advanced = true; elapsed = 10000; }
      return rows;
    },
  });
  assert.equal(result.reason, 'budget'); assert.equal(result.calls, 0);
  assert.equal(f.calls.length, 0); assert.equal(rrRoutes(f).length, 0);
  assert.equal(JSON.parse(sqliteQuery(f.db, 'SELECT canonical_json FROM records WHERE id=1;')[0].canonical_json).sender_name, null);
});

test('route read used to quarantine a task is fenced even when that route was never requested', t => {
  const f = rrFixture(t, 'group'); let concurrentlyRecovered = false;
  const first = rrRun(f, args => {
    if (args[0] === 'contact') return rrDenied('contact_search');
    assert.deepEqual(args.slice(0, 3), ['im', 'chat.members', 'get']);
    return { items: [], has_more: false };
  });
  assert.equal(first.reason, 'unresolved');
  const previousTask = rrTask(f), previousMember = rrRoutes(f).find(row => row.operation === 'chat_members');
  f.now += 5 * 60_000 + 1;
  const result = rrRun(f, args => {
    assert.deepEqual(args.slice(0, 3), ['im', 'chat.members', 'get'], 'contact must stay suppressed during its quarantine');
    // A competing exact-route recovery has completed. This is authored local
    // concurrency, not a mutation of any real or production state.
    sqliteExec(f.db, `UPDATE lark_im_name_routes SET blocked=0,failures=0,failure_kind=NULL,
      failure_code=NULL,retry_at_ms=0,last_attempt_at_ms=${f.now},generation=generation+2
      WHERE operation='contact_search';`);
    concurrentlyRecovered = true;
    return rrDenied('chat_members');
  });
  assert.equal(concurrentlyRecovered, true);
  assert.equal(result.reason, 'unavailable', 'stale blocked contact receipt must reject task/result adoption');
  const afterTask = rrTask(f);
  assert.equal(afterTask.blocked_reason, null);
  assert.equal(afterTask.schedule_failures, previousTask.schedule_failures);
  assert.ok(afterTask.attempt_token, 'failed result transaction leaves the existing bounded claim');
  assert.deepEqual(rrRoutes(f).find(row => row.operation === 'chat_members'), previousMember);
  assert.equal(rrRoutes(f).find(row => row.operation === 'contact_search').blocked, 0);
});
