import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enrichRecords } from "../src/maintenance/enrich-records.mjs";
import { ensureInitialized, quoteSql, sqliteExec, sqliteQuery } from "../dist/storage/sqlite/ingestion-store.js";

// Fresh authored rows and injected transport only. No real API, account, lease,
// source database, captured message, or service is used by this test file.
const START = Date.parse("2044-07-08T09:10:11.000Z");
const SENDER_FIELDS = new Set(["sender_id_type", "sender_name", "sender_name_state", "sender_name_source",
  "sender_name_confidence", "sender_name_resolution_status", "sender_name_resolution_reason"]);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "exocortex-exact-names-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, "synthetic.sqlite");
  ensureInitialized(db);
  return { db, calls: [] };
}
function insert(f, id, { app = false, sender = `${app ? 'cli' : 'ou'}_synthetic_name_${id}`,
  chat = `oc_synthetic_names_${id % 3}`, canonical = {}, raw = {}, row = {} } = {}) {
  const native = { message_id: `om_synthetic_names_${id}`, chat_id: chat, msg_type: 'text',
    create_time: String(START + id * 1000), update_time: String(START + id * 1000 + 20),
    sender: { id: sender, sender_type: app ? 'app' : 'user', ...(!app ? { id_type: 'open_id' } : {}) },
    deleted: true, body: { content: JSON.stringify({ text: `Private synthetic source ${id}` }) }, ...raw };
  const projected = { sender_id: sender, sender_type: app ? 'app' : 'user', sender_name: null,
    chat_id: chat, chat_type: 'group', chat_name: null, msg_type: 'text',
    chat_partner: { open_id: 'ou_synthetic_unselected_partner', name: null },
    untouched: { a: [1, 2], meaning: 'synthetic non-name metadata' }, ...canonical };
  const stored = { id, source_id: 'lark.im', first_seen_scope_id: 'lark.im.sent_by_me',
    external_id: native.message_id, external_version: native.update_time, record_type: 'lark.im.message',
    occurred_at_ms: Number(native.create_time), actor_id: sender, container_id: chat,
    body: '[Invalid rich text JSON]', canonical_json: JSON.stringify(projected), raw_json: JSON.stringify(native),
    content_hash: `synthetic-hash-${id}`, updated_at: new Date(START).toISOString(), ...row };
  sqliteExec(f.db, `INSERT INTO records (${Object.keys(stored).join(',')}) VALUES (${Object.values(stored).map(quoteSql).join(',')});`,
    'insert authored exact-name fixture');
}
function rows(f) { return sqliteQuery(f.db, 'SELECT * FROM records ORDER BY id;', 'read authored exact-name fixture'); }
function api(f, responder) {
  return (args) => {
    f.calls.push(args);
    assert.equal(sqliteQuery(f.db, 'SELECT COUNT(*) AS count FROM maintenance_locks;', 'inspect synthetic maintenance locks')[0].count, 0);
    if (responder) return responder(args);
    if (args[0] === 'contact' && args[1] === '+search-user') return { users: args[args.indexOf('--user-ids') + 1].split(',')
      .map((open_id) => ({ open_id, name: `Synthetic Reader ${open_id.slice(-1)}` })) };
    if (args[0] === 'api' && args[2].startsWith('/open-apis/application/v6/applications/')) {
      return { data: { app: { app_name: `Synthetic App ${args[2].slice(-1)}` } } };
    }
    assert.fail(`unexpected synthetic API family: ${args.slice(0, 2).join(' ')}`);
  };
}
function run(f, ids, { dryRun = false, runLark = api(f), assertReady = () => {}, ...options } = {}) {
  return enrichRecords({ db: f.db, namesOnly: true, recordIds: ids, limit: ids.length, dryRun, ...options },
    { runLark, assertReady });
}
function assertNamesOnly(before, after) {
  for (const field of Object.keys(before)) if (!['canonical_json', 'updated_at'].includes(field)) assert.equal(after[field], before[field], field);
  const stripped = (value) => Object.fromEntries(Object.entries(JSON.parse(value)).filter(([key]) => !SENDER_FIELDS.has(key)));
  assert.deepEqual(stripped(after.canonical_json), stripped(before.canonical_json));
}
function assertPublic(report) {
  assert.doesNotMatch(JSON.stringify(report), /ou_synthetic|cli_synthetic|oc_synthetic|om_synthetic|Synthetic Reader|Synthetic App|Private synthetic|synthetic\.sqlite/);
}

test('exact names reach ten older user/app rows without selecting 239 newer unrelated rows', (t) => {
  const f = fixture(t);
  for (let id = 1; id <= 6; id++) insert(f, id);
  for (let id = 7; id <= 10; id++) insert(f, id, { app: true, sender: `cli_synthetic_name_${id === 10 ? 7 : id}`,
    canonical: { sender_name_resolution_status: 'unresolved_app_sender', sender_name_resolution_reason: 'synthetic_old_failure' } });
  for (let id = 11; id <= 249; id++) insert(f, id);
  const before = rows(f);
  const report = run(f, [10, 2, 8, 4, 6, 1, 9, 3, 5, 7], { limit: 1 });
  assert.equal(report.scanned, 10);
  assert.equal(report.requested_records, 10);
  assert.equal(report.eligible_records, 10);
  assert.equal(report.updated, 10);
  assert.equal(report.resolved, 10);
  assert.equal(report.unresolved, 0);
  assert.equal(report.partial, false);
  assert.equal(f.calls.filter((args) => args[0] === 'contact').length, 1);
  assert.equal(f.calls.filter((args) => args[0] === 'api').length, 3);
  const contacts = f.calls.find((args) => args[0] === 'contact');
  assert.deepEqual(new Set(contacts[contacts.indexOf('--user-ids') + 1].split(',')),
    new Set(Array.from({ length: 6 }, (_, index) => `ou_synthetic_name_${index + 1}`)));
  const after = rows(f);
  for (let index = 0; index < 10; index++) {
    assertNamesOnly(before[index], after[index]);
    const canonical = JSON.parse(after[index].canonical_json);
    assert.ok(canonical.sender_name);
    assert.equal(canonical.sender_name_resolution_status, undefined);
    assert.equal(canonical.sender_name_resolution_reason, undefined);
  }
  assert.deepEqual(after.slice(10), before.slice(10));
  assertPublic(report);
});

test('exact names preview makes proposals without a database or maintenance-lock write', (t) => {
  const f = fixture(t); insert(f, 1); insert(f, 2, { app: true });
  const before = readFileSync(f.db);
  const report = run(f, [1, 2], { dryRun: true });
  assert.equal(report.planned, 2);
  assert.equal(report.updated, 0);
  assert.deepEqual(readFileSync(f.db), before);
  assert.equal(sqliteQuery(f.db, 'SELECT COUNT(*) AS count FROM maintenance_locks;', 'synthetic lock count')[0].count, 0);
});

test('every requested ID must be a distinct existing Lark message before any lookup', (t) => {
  const f = fixture(t); insert(f, 1); insert(f, 2, { row: { record_type: 'synthetic.other' } });
  const before = rows(f);
  for (const ids of [[1, 99], [1, 2], [1, 1], [], [0], [-1], [1.5], ['1'], [Number.MAX_SAFE_INTEGER + 1],
    Array.from({ length: 101 }, (_, index) => index + 1)]) {
    assert.throws(() => run(f, ids, { runLark: () => assert.fail('invalid selection performed a lookup') }));
  }
  assert.deepEqual(rows(f), before);
});

test('system messages, authoritative clears and known names remain unchanged without lookups', (t) => {
  const f = fixture(t);
  insert(f, 1, { canonical: { msg_type: 'system' } });
  insert(f, 2, { canonical: { sender_name_state: 'cleared' }, raw: { sender: {
    id: 'ou_synthetic_name_2', id_type: 'open_id', sender_type: 'user', name: 'Old Synthetic Source Name' } } });
  insert(f, 3, { app: true, canonical: { sender_name: 'Known Synthetic App' } });
  const before = rows(f);
  const report = run(f, [1, 2, 3], { runLark: () => assert.fail('excluded record lookup') });
  assert.equal(report.eligible_records, 0);
  assert.equal(report.planned, 0);
  assert.equal(report.partial, false);
  assert.deepEqual(report.exclusions, { system_message: 1, explicitly_cleared: 1, known_name: 1, unverified_identity: 0 });
  assert.deepEqual(rows(f), before);
});

test('conflicting sender/chat identities and unsupported namespaces remain visibly unverified', (t) => {
  const f = fixture(t);
  insert(f, 1, { canonical: { sender_id: 'ou_synthetic_different' } });
  insert(f, 2, { canonical: { chat_id: 'oc_synthetic_different' } });
  insert(f, 3, { raw: { sender: { id: 'ou_synthetic_name_3', id_type: 'union_id', sender_type: 'user' } } });
  insert(f, 4, { app: true, canonical: { sender_id_type: 'open_id' } });
  const before = rows(f);
  const report = run(f, [1, 2, 3, 4], { runLark: () => assert.fail('unverified identity lookup') });
  assert.equal(report.eligible_records, 0);
  assert.equal(report.exclusions.unverified_identity, 4);
  assert.equal(report.partial, true);
  assert.deepEqual(rows(f), before);
});

test('source names fill only name projection fields without a remote lookup', (t) => {
  const f = fixture(t);
  insert(f, 1, { raw: { sender: { id: 'ou_synthetic_name_1', id_type: 'open_id', sender_type: 'user', name: 'Synthetic Source Person' } } });
  insert(f, 2, { app: true, raw: { sender: { id: 'cli_synthetic_name_2', sender_type: 'app', name: 'Synthetic Source App' } } });
  const before = rows(f);
  const report = run(f, [1, 2], { runLark: () => assert.fail('source name should not need lookup') });
  assert.equal(report.updated, 2);
  for (const [index, row] of rows(f).entries()) {
    assertNamesOnly(before[index], row);
    assert.equal(JSON.parse(row.canonical_json).sender_name_source, 'message_sender');
  }
});

for (const outcome of ['empty', 'failure', 'identity_echo']) {
  test(`unresolved ${outcome} names do not churn unknown fields or diagnostics`, (t) => {
    const f = fixture(t); insert(f, 1); insert(f, 2, { app: true,
      canonical: { sender_name_resolution_status: 'unresolved_app_sender', sender_name_resolution_reason: 'existing_synthetic_reason' } });
    const before = rows(f);
    const report = run(f, [1, 2], { runLark: api(f, (args) => {
      if (outcome === 'failure') throw new Error('synthetic permission denied PRIVATE_SYNTHETIC_FAILURE');
      if (outcome === 'identity_echo' && args[0] === 'contact') return { users: [{ open_id: 'ou_synthetic_name_1', name: 'ou_synthetic_name_1' }] };
      if (outcome === 'identity_echo' && args[0] === 'api') return { data: { app: { app_name: 'cli_synthetic_name_2' } } };
      return {};
    }) });
    assert.equal(report.updated, 0);
    assert.equal(report.unresolved, 2);
    assert.equal(report.unresolved_name_targets, 2);
    assert.equal(report.app_names, 0);
    assert.equal(report.partial, true);
    assert.deepEqual(rows(f), before);
    assertPublic(report);
  });
}

test('member and explicit app-ID bot fallback names remain scoped to selected identities', (t) => {
  const f = fixture(t); insert(f, 1); insert(f, 2, { app: true }); insert(f, 3);
  const before = rows(f);
  const report = run(f, [1, 2], { runLark: api(f, (args) => {
    if (args[0] === 'contact' || args[0] === 'api') throw new Error('synthetic permission denied');
    if (args[2] === 'get') return { items: [{ member_id: 'ou_synthetic_name_1', name: 'Synthetic Member Name' }] };
    if (args[2] === 'bots') return { items: [{ app_id: 'cli_synthetic_name_2', bot_name: 'Synthetic Matched Bot' }] };
    assert.fail('unrelated fallback');
  }) });
  assert.equal(report.updated, 2);
  assert.equal(report.partial, false);
  const after = rows(f);
  assert.equal(JSON.parse(after[0].canonical_json).sender_name_source, 'chat_member');
  assert.equal(JSON.parse(after[1].canonical_json).sender_name_source, 'chat_bot_app_id');
  assert.deepEqual(after[2], before[2]);
  for (const args of f.calls.filter((args) => args[0] === 'im')) {
    const chat = JSON.parse(args[args.indexOf('--params') + 1]).chat_id;
    assert.ok(['oc_synthetic_names_1', 'oc_synthetic_names_2'].includes(chat));
  }
});

for (const bot of [{ app_id: 'cli_synthetic_name_2', bot_name: 'Synthetic Other App' }, { bot_name: 'Synthetic Unbound App' }]) {
  test(`a selected app cannot borrow an unselected or unbound bot: ${bot.app_id ? 'different ID' : 'no ID'}`, (t) => {
    const f = fixture(t); insert(f, 1, { app: true, chat: 'oc_synthetic_shared' });
    insert(f, 2, { app: true, chat: 'oc_synthetic_shared' });
    const before = rows(f);
    const report = run(f, [1], { runLark: api(f, (args) => args[0] === 'api' ? {} : { items: [bot] }) });
    assert.equal(report.updated, 0);
    assert.equal(report.unresolved, 1);
    assert.equal(report.partial, true);
    assert.equal(report.app_fallback_names, 0);
    assert.deepEqual(rows(f), before);
  });
}

test('a session failure caught by a resolver still blocks every proposal at the commit fence', (t) => {
  const f = fixture(t); insert(f, 1); insert(f, 2, { app: true });
  const before = rows(f);
  assert.throws(() => run(f, [1, 2], { assertReady: () => { throw new Error('synthetic terminal session failure'); } }),
    /synthetic terminal session failure/);
  assert.deepEqual(rows(f), before);
  assert.equal(sqliteQuery(f.db, 'SELECT COUNT(*) AS count FROM maintenance_locks;', 'synthetic lock count')[0].count, 0);
});

test('sender-only also checks the terminal session guard before committing', (t) => {
  const f = fixture(t); insert(f, 1);
  const before = rows(f);
  assert.throws(() => enrichRecords({ db: f.db, senderOnly: true, senderId: 'ou_synthetic_name_1', limit: 1, dryRun: false },
    { runLark: api(f), assertReady: () => { throw new Error('synthetic sender session failure'); } }), /synthetic sender session failure/);
  assert.deepEqual(rows(f), before);
});

test('a concurrent authoritative name clear wins the exact row snapshot comparison', (t) => {
  const f = fixture(t); insert(f, 1);
  let changed;
  const report = run(f, [1], { runLark: api(f, () => {
    sqliteExec(f.db, `UPDATE records SET canonical_json=json_set(canonical_json,'$.sender_name_state','cleared') WHERE id=1;`,
      'synthetic concurrent clear');
    changed = rows(f);
    return { users: [{ open_id: 'ou_synthetic_name_1', name: 'Synthetic Fresh Lookup' }] };
  }) });
  assert.equal(report.planned, 1);
  assert.equal(report.updated, 0);
  assert.equal(report.skipped_conflicts, 1);
  assert.equal(report.partial, true);
  assert.deepEqual(rows(f), changed);
});
