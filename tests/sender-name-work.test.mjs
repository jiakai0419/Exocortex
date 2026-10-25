import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { prepareSenderWork } from '../src/adapters/lark-im/sender-name-work.mjs';
import { nameTaskKey } from '../src/adapters/lark-im/name-evidence.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { ensureInitialized, sqliteExec, sqliteQuery, quoteSql } from '../dist/storage/sqlite/ingestion-store.js';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';

// Every identity, payload and database here is invented. No local account or API.
const SELF = 'ou_authored_name_self', ACTOR = 'ou_authored_name_actor', CHAT = 'oc_authored_name_chat';
const NOW = Date.parse('2030-01-02T03:04:05.000Z'), ACCOUNT = recipientAccountKey(SELF);
function fixture(t, count = 1, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'exo-sender-work-')), db = join(root, 'synthetic.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensureInitialized(db);
  const f = { db, self: { open_id: SELF, name: 'Authored Self' }, calls: [] };
  for (let id = 1; id <= count; id++) add(f, id, options);
  return f;
}
const query = (f, sql) => sqliteQuery(f.db, sql, 'inspect authored sender fixture');
const execute = (f, sql) => sqliteExec(f.db, sql, 'write authored sender fixture');
const rows = f => query(f, 'SELECT * FROM records ORDER BY id;');
function add(f, id, options = {}) {
  const actor = options.actor || ACTOR, namespace = options.namespace || 'open_id';
  const raw = { message_id: `om_authored_sender_${id}`, chat_id: CHAT, chat_type: 'group',
    sender: { id: actor, id_type: namespace, sender_type: namespace === 'app_id' ? 'app' : 'user' },
    body: { content: JSON.stringify({ text: 'A synthetic body, preserved byte for byte.' }) }, ...options.raw };
  const canonical = { message_id: raw.message_id, chat_id: CHAT, chat_type: 'group', sender_id: actor,
    sender_id_type: namespace, sender_name: null, unknown: { retain: [1, 2] }, ...options.canonical };
  let text = options.canonicalText || JSON.stringify(canonical);
  execute(f, `INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,record_type,actor_id,container_id,direction,
    title,body,content_hash,canonical_json,raw_json) VALUES(${id},'lark.im','lark.im.sent_by_me',${quoteSql(raw.message_id)},'v1',
    'lark.im.message',${quoteSql(actor)},${quoteSql(CHAT)},'received','Authored title','Exact authored body','authored hash',
    ${quoteSql(text)},${quoteSql(JSON.stringify(raw))});`);
}
function task(f, overrides = {}) {
  const actor = overrides.actor_id || ACTOR, namespace = overrides.namespace || 'open_id';
  return { source_id: 'lark.im', kind: 'sender', account_key: ACCOUNT, chat_id: CHAT, actor_id: actor, namespace,
    task_key: nameTaskKey('sender', CHAT, actor, namespace), latest_record_id: rows(f).at(-1).id,
    after_record_id: 0, evidence_json: null, ...overrides };
}
function work(f, state, respond, nowMs = NOW) {
  return prepareSenderWork(state, { db: f.db, self: f.self, accountKey: ACCOUNT, nowMs,
    query: (sql, label) => readOnlySqliteJson(f.db, sql, label),
    runLark: (args, options) => { f.calls.push(args); assert.equal(options.retries, 0); return respond(args); } });
}
function apply(f, result) {
  for (const sql of result.updates) execute(f, sql + ';');
}
function next(state, result) { return { ...state, evidence_json: result.evidenceJson, after_record_id: result.afterRecordId,
  projection_horizon_record_id: result.horizonRecordId, projection_deferred: Number(Boolean(result.projectionDeferred)) }; }
function unchangedExceptName(before, after) {
  for (let i = 0; i < before.length; i++) {
    for (const key of Object.keys(before[i])) if (key !== 'canonical_json') assert.deepEqual(after[i][key], before[i][key], key);
    const old = JSON.parse(before[i].canonical_json), current = JSON.parse(after[i].canonical_json);
    for (const key of Object.keys(old)) if (!key.startsWith('sender_name')) assert.deepEqual(current[key], old[key], key);
  }
}

test('exact contact fills historical unknown names only, with byte-stable non-name columns and no implicit commit', t => {
  const f = fixture(t, 3); add(f, 4, { canonical: { sender_name: 'Known name' } });
  add(f, 5, { canonical: { sender_name_state: 'cleared' } });
  const before = rows(f), dbBefore = readFileSync(f.db);
  const result = work(f, task(f, { latest_record_id: 3 }), () => ({ users: [{ open_id: ACTOR, name: '12345' }] }));
  assert.equal(result.outcome, 'resolved'); assert.equal(result.updates.length, 3); assert.equal(f.calls.length, 1);
  assert.deepEqual(readFileSync(f.db), dbBefore, 'preparing never writes');
  apply(f, result); const after = rows(f);
  assert.deepEqual(after.slice(0, 3).map(row => JSON.parse(row.canonical_json).sender_name), ['12345','12345','12345']);
  assert.deepEqual(after.slice(3), before.slice(3)); unchangedExceptName(before, after);
});

test('persistent member cursor reaches a later page after a process boundary without redoing the first two pages', t => {
  const f = fixture(t), state = task(f);
  const first = work(f, state, args => args[0] === 'contact' ? { users: [] }
    : { items: [], has_more: true, page_token: JSON.parse(args[args.indexOf('--params') + 1]).page_token ? 'authored-page-3' : 'authored-page-2' });
  assert.equal(first.outcome, 'pending'); assert.equal(f.calls.length, 3); assert.equal(first.updates.length, 0);
  const saved = JSON.parse(JSON.stringify(next(state, first))); f.calls.length = 0;
  const second = work(f, saved, args => {
    assert.equal(args[0], 'im'); assert.equal(JSON.parse(args[args.indexOf('--params') + 1]).page_token, 'authored-page-3');
    return { items: [{ member_id: ACTOR, member_id_type: 'open_id', name: 'Later Page Name' }], has_more: false };
  }, NOW + 1000);
  assert.equal(second.outcome, 'resolved'); assert.equal(f.calls.length, 1); apply(f, second);
  assert.equal(JSON.parse(rows(f)[0].canonical_json).sender_name, 'Later Page Name');
});

test('wrapped member responses retain bounded paging across serialized task state', t => {
  const f = fixture(t), state = task(f), before = rows(f), observedPages = [];
  const first = work(f, state, args => {
    if (args[0] === 'contact') return { users: [] };
    const params = JSON.parse(args[args.indexOf('--params') + 1]);
    observedPages.push(params.page_token || '');
    return { data: { items: [], has_more: true,
      page_token: params.page_token ? 'authored-wrapped-page-3' : 'authored-wrapped-page-2' } };
  });
  assert.equal(first.outcome, 'pending'); assert.equal(first.updates.length, 0);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(observedPages, ['', 'authored-wrapped-page-2']);
  assert.deepEqual(rows(f), before);
  const saved = JSON.parse(JSON.stringify(next(state, first))); f.calls.length = 0;
  const second = work(f, saved, args => {
    assert.equal(args[0], 'im');
    assert.equal(JSON.parse(args[args.indexOf('--params') + 1]).page_token, 'authored-wrapped-page-3');
    return { data: { items: [{ member_id: ACTOR, member_id_type: 'open_id', name: 'Authored Wrapped Name' }],
      has_more: false } };
  }, NOW + 1000);
  assert.equal(second.outcome, 'resolved'); assert.equal(f.calls.length, 1);
  apply(f, second);
  assert.equal(JSON.parse(rows(f)[0].canonical_json).sender_name, 'Authored Wrapped Name');
  unchangedExceptName(before, rows(f));
});

test('failed permission lookup remains retryable and cached exact evidence applies multiple bounded pages after restart', t => {
  const f = fixture(t, 45), state = task(f), before = rows(f);
  const denied = work(f, state, () => { throw new Error('Authored permission denied'); });
  assert.equal(denied.outcome, 'failed'); assert.equal(denied.updates.length, 0); assert.deepEqual(rows(f), before);
  f.calls.length = 0;
  const resumed = work(f, next(state, denied), () => ({ items: [{ member_id: ACTOR, name: 'Restored Name' }], has_more: false }), NOW + 300000);
  assert.equal(resumed.outcome, 'pending'); assert.equal(resumed.updates.length, 20); apply(f, resumed);
  const offline = () => { throw new Error('No API is needed for stored exact evidence'); };
  const second = work(f, JSON.parse(JSON.stringify(next(state, resumed))), offline, NOW + 301000);
  assert.equal(second.updates.length, 20); apply(f, second);
  const third = work(f, next(state, second), offline, NOW + 302000); apply(f, third);
  assert.equal(third.outcome, 'resolved'); assert.equal(third.updates.length, 5);
  assert.equal(rows(f).filter(row => JSON.parse(row.canonical_json).sender_name === 'Restored Name').length, 45);
  unchangedExceptName(before, rows(f));
});

test('account, typed actor, raw name, clear and exact predecessor conflicts cannot be overwritten', t => {
  const f = fixture(t, 1);
  add(f, 2, { canonical: { sender_name_account_key: 'f'.repeat(64) } });
  add(f, 3, { canonical: { sender_name_state: 'cleared' } });
  add(f, 4, { raw: { sender: { id: ACTOR, id_type: 'user_id', sender_type: 'user' } } });
  add(f, 5, { raw: { sender: { id: ACTOR, id_type: 'open_id', sender_type: 'user', name: 'Source name' } } });
  const state = task(f, { latest_record_id: 1 });
  const resolved = work(f, state, () => ({ users: [{ open_id: ACTOR, name: 'Safe Name' }] }));
  const result = work(f, { ...next(state, resolved), latest_record_id: 5, after_record_id: 0, projection_horizon_record_id: 5 }, () => { throw new Error('No API'); });
  assert.equal(result.updates.length, 1);
  execute(f, "UPDATE records SET body='Changed after observation' WHERE id=1;");
  apply(f, result);
  assert.equal(JSON.parse(rows(f)[0].canonical_json).sender_name, null, 'whole predecessor CAS refuses changed body');
  const invalid = work(f, { ...state, account_key: 'e'.repeat(64) }, () => { throw new Error('Must not call'); });
  assert.equal(invalid.outcome, 'invalid_target');
});

test('app route accepts only exact app-id bot evidence and refuses the old unique-bot guess', t => {
  const app = 'cli_authored_name_bot';
  const f = fixture(t, 1, { actor: app, namespace: 'app_id' }), state = task(f, { actor_id: app, namespace: 'app_id' });
  const uncertain = work(f, state, args => args[0] === 'api' ? { data: { app: { app_id: app } } }
    : { items: [{ bot_id: 'authored-bot', name: 'Unmapped Bot' }] });
  assert.equal(uncertain.outcome, 'unresolved'); assert.equal(uncertain.updates.length, 0); assert.equal(f.calls.length, 2);
  const exact = work(f, state, args => args[0] === 'api' ? { data: { app: { app_id: app } } }
    : { items: [{ app_id: app, name: 'Exact Bot' }] });
  assert.equal(exact.outcome, 'resolved'); apply(f, exact);
  assert.equal(JSON.parse(rows(f)[0].canonical_json).sender_name, 'Exact Bot');
});

test('malformed, duplicate, cross-account and cyclic persisted observations never supply a name', t => {
  const f = fixture(t), state = task(f);
  const answer = work(f, state, () => ({ users: [{ open_id: ACTOR, name: 'Exact Name' }] }));
  const evidence = JSON.parse(answer.evidenceJson); evidence.observation.account_key = 'd'.repeat(64);
  const forged = work(f, { ...state, evidence_json: JSON.stringify(evidence) }, () => { throw new Error('Authored unavailable'); });
  assert.equal(forged.updates.length, 0);
  const progress = work(f, state, args => args[0] === 'contact' ? { users: [] }
    : { items: [], has_more: true, page_token: 'same-token' });
  assert.equal(progress.outcome, 'failed'); assert.equal(progress.evidenceJson, null);
  const conflicts = work(f, state, () => ({ users: [{ open_id: ACTOR, name: 'A' }, { open_id: ACTOR, name: 'B' }] }));
  assert.equal(conflicts.outcome, 'conflict'); assert.equal(conflicts.updates.length, 0);
});

test('budget interruption preserves the exact pending member token and never partially commits', t => {
  const f = fixture(t), state = task(f), before = rows(f); let call = 0;
  const result = work(f, state, args => {
    call++; if (call === 1) return { users: [] };
    if (call === 2) return { items: [], has_more: true, page_token: 'continue-here' };
    throw new Error('name budget exhausted');
  });
  assert.equal(result.outcome, 'failed'); assert.equal(JSON.parse(result.evidenceJson).page_token, 'continue-here');
  assert.equal(result.updates.length, 0); assert.deepEqual(rows(f), before);
});

test('nonzero API envelopes and malformed member entries never adopt successful-looking names', t => {
  const f = fixture(t), state = task(f);
  for (const body of [
    { code: 999, items: [{ member_id: ACTOR, name: 'Must refuse error' }] },
    { items: [null, { member_id: ACTOR, name: 'Must refuse partial' }] },
    { items: ['invalid member', { member_id: ACTOR, name: 'Must refuse partial' }] },
    { items: [{ member_id: ACTOR, member_id_type: 7, name: 'Must refuse malformed type' }] },
  ]) {
    const result = work(f, state, args => args[0] === 'contact' ? { users: [] } : body);
    assert.equal(result.outcome, 'failed'); assert.equal(result.updates.length, 0);
  }
  assert.equal(JSON.parse(rows(f)[0].canonical_json).sender_name, null);
});

test('a completed horizon is revisited after its due time, recovering a previously skipped record', t => {
  const f = fixture(t), state = task(f);
  const first = work(f, state, () => ({ users: [{ open_id: ACTOR, name: 'Recovery Name' }] }));
  // Simulate a caller that did not commit the prepared row but retained its work
  // cursor. The actual coordinator rejects that partial commit atomically too.
  const restarted = work(f, next(state, first), () => { throw new Error('No repeat API'); }, NOW + 86400000);
  assert.equal(restarted.updates.length, 1); assert.equal(restarted.outcome, 'resolved'); apply(f, restarted);
  assert.equal(JSON.parse(rows(f)[0].canonical_json).sender_name, 'Recovery Name');
});

test('member collection may exceed requested page_size; an exact 101st member is still usable', t => {
  const f = fixture(t), state = task(f);
  const items = Array.from({ length: 100 }, (_, i) => ({ member_id: `ou_authored_other_${i}`, name: `Other ${i}` }));
  items.push({ member_id: ACTOR, name: 'Member 101' });
  const result = work(f, state, args => args[0] === 'contact' ? { users: [] } : { items, has_more: true, page_token: 'next' });
  assert.equal(result.outcome, 'resolved'); assert.equal(result.updates.length, 1); apply(f, result);
  assert.equal(JSON.parse(rows(f)[0].canonical_json).sender_name, 'Member 101');
});

test('a cleared or removed latest witness cannot permanently block older unknown records', t => {
  const f = fixture(t, 2), state = task(f);
  execute(f, "UPDATE records SET canonical_json=json_set(canonical_json,'$.sender_name_state','cleared') WHERE id=2;");
  const result = work(f, state, () => ({ users: [{ open_id: ACTOR, name: 'Older Witness' }] }));
  assert.equal(result.updates.length, 1); apply(f, result);
  assert.equal(JSON.parse(rows(f)[0].canonical_json).sender_name, 'Older Witness');
  assert.equal(JSON.parse(rows(f)[1].canonical_json).sender_name, null);
});

test('restored contact permission recovers even while the saved member route remains unavailable', t => {
  const f = fixture(t), state = task(f);
  const denied = work(f, state, () => { throw new Error('Authored permission denied'); });
  assert.equal(JSON.parse(denied.evidenceJson).phase, 'members');
  const recovered = work(f, next(state, denied), args => {
    assert.equal(args[0], 'contact', 'retry the primary route when its retry time arrives');
    return { users: [{ open_id: ACTOR, name: 'Contact Permission Restored' }] };
  }, NOW + 300001);
  assert.equal(recovered.outcome, 'resolved'); apply(f, recovered);
  assert.equal(JSON.parse(rows(f)[0].canonical_json).sender_name, 'Contact Permission Restored');
});

test('a stale positive observation is refreshed before filling new unknown records, but known-only pages need no API', t => {
  const f = fixture(t), state = task(f);
  const first = work(f, state, () => ({ users: [{ open_id: ACTOR, name: 'First Name' }] })); apply(f, first);
  const known = work(f, next(state, first), () => { throw new Error('No lookup for complete names'); }, NOW + 86400001);
  assert.equal(known.updates.length, 0);
  add(f, 2); const updated = { ...next(state, first), latest_record_id: 2 };
  const second = work(f, updated, () => ({ users: [{ open_id: ACTOR, name: 'Current Name' }] }), NOW + 86400002); apply(f, second);
  assert.equal(JSON.parse(rows(f)[0].canonical_json).sender_name, 'First Name');
  assert.equal(JSON.parse(rows(f)[1].canonical_json).sender_name, 'Current Name');
});


test('same actor and chat cannot borrow sender evidence across an explicit chat-account binding', t => {
  const f = fixture(t), state = task(f);
  const resolved = work(f, state, () => ({ users: [{ open_id: ACTOR, name: 'Account A Name' }] }));
  add(f, 2, { canonical: { chat_name_account_key: 'b'.repeat(64) } });
  add(f, 3, { canonical: { chat_name_account_key: ACCOUNT } });
  const before = rows(f);
  const result = work(f, { ...next(state, resolved), latest_record_id: 3, after_record_id: 0, projection_horizon_record_id: 3 },
    () => { throw new Error('Stored exact evidence needs no API'); });
  assert.equal(result.updates.length, 2);
  apply(f, result);
  const after = rows(f);
  assert.equal(JSON.parse(after[0].canonical_json).sender_name, 'Account A Name');
  assert.deepEqual(after[1], before[1], 'another chat account remains byte-for-byte unchanged');
  assert.equal(JSON.parse(after[2].canonical_json).sender_name, 'Account A Name');
  const foreignWitness = { ...state, latest_record_id: 2, after_record_id: 1 };
  const denied = work(f, foreignWitness, () => { throw new Error('A foreign-account witness cannot authorize requests'); });
  assert.equal(denied.outcome, 'invalid_target');
  assert.equal(denied.updates.length, 0);
});


test('sender projection advances past oversized records and retains deferred debt until its fixed horizon completes', t => {
  const f = fixture(t, 1, { canonical: { authored_padding: 'x'.repeat(1024 * 1024) } });
  for (let id = 2; id <= 21; id++) add(f, id);
  const state = task(f), before = rows(f)[0];
  const first = work(f, state, () => ({ users: [{ open_id: ACTOR, name: 'Bounded Recovery' }] }));
  assert.equal(first.outcome, 'pending'); assert.equal(first.retryDelayMs, 0);
  assert.equal(first.afterRecordId, 20); assert.equal(first.horizonRecordId, 21); assert.equal(first.projectionDeferred, true);
  apply(f, first);
  const second = work(f, next(state, first), () => { throw new Error('Cached exact proof only'); }, NOW + 300000);
  assert.equal(second.outcome, 'capacity_deferred'); assert.equal(second.afterRecordId, 21);
  assert.equal(second.projectionDeferred, true); apply(f, second);
  assert.equal(JSON.parse(rows(f)[20].canonical_json).sender_name, 'Bounded Recovery');
  assert.deepEqual(rows(f)[0], before, 'oversized predecessor remains unchanged and retryable');
});

test('daily sender evidence refresh and new traffic cannot reset or extend an unfinished projection horizon', t => {
  const f = fixture(t, 45), state = task(f);
  const first = work(f, state, () => ({ users: [{ open_id: ACTOR, name: 'Daily Exact Name' }] })); apply(f, first);
  assert.equal(first.afterRecordId, 20); assert.equal(first.horizonRecordId, 45);
  add(f, 46);
  const secondState = { ...next(state, first), latest_record_id: 46 };
  const second = work(f, secondState, () => ({ users: [{ open_id: ACTOR, name: 'Daily Exact Name' }] }), NOW + 86400001); apply(f, second);
  assert.equal(second.afterRecordId, 40); assert.equal(second.horizonRecordId, 45);
  const third = work(f, next(secondState, second), () => ({ users: [{ open_id: ACTOR, name: 'Daily Exact Name' }] }), NOW + 172800002); apply(f, third);
  assert.equal(third.afterRecordId, 45); assert.equal(third.outcome, 'resolved');
  assert.equal(rows(f).slice(0, 45).every(row => JSON.parse(row.canonical_json).sender_name === 'Daily Exact Name'), true);
  assert.equal(JSON.parse(rows(f)[45].canonical_json).sender_name, null, 'new traffic belongs to the next sweep');
});
