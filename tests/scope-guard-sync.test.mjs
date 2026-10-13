import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';
import { createSyncRunner } from '../src/adapters/lark-im/sync-runner.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { captureLarkWriteAdmission } from '../src/diagnostics/lark-write-admission.mjs';
import { readRemoteAccountBinding } from '../src/diagnostics/remote-account-binding.mjs';
import { ensureInitialized, sqliteExec, sqliteQuery, quoteSql as q, readScope,
  readLarkListProgress, reserveInitialLarkAccount } from '../dist/storage/sqlite/ingestion-store.js';

// Real adapter -> runner -> SQLite, with invented accounts and transport only.
// No live API, profile/name lookup, production database, or upstream assertion.
const START = Date.parse('2026-10-01T00:00:00Z'), END = START + 60_000;
const SELF = { open_id: 'ou_synthetic_scope_self', name: 'Invented Scope Self' };
const FOREIGN = 'ou_synthetic_scope_foreign';
const CHAT = 'oc_synthetic_scope_a', OTHER_CHAT = 'oc_synthetic_scope_b';
const SENT = 'lark.im.sent_by_me', RECEIVED = chatScopeId(CHAT), PATH = '/open-apis/im/v1/messages';
const raw = (id, overrides = {}) => ({ message_id: `om_synthetic_scope_${id}`, chat_id: CHAT,
  create_time: String(START + 1000), update_time: String(START + 2000), msg_type: 'text',
  sender: { id: SELF.open_id, id_type: 'open_id', sender_type: 'user' },
  body: { content: '{"text":"invented private scope payload"}' }, ...overrides });
const root = (id, overrides = {}) => raw(id, { msg_type: 'merge_forward', ...overrides });
const page = (items, has_more = false, page_token = '') => ({ ok: true, data: { items, has_more, page_token } });
const context = () => ({ self: SELF, contacts: new Map(), chat_members: new Map(), apps: new Map(), app_fallbacks: new Map() });

function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'scope-guard-synthetic-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite');
  ensureInitialized(db);
  sqliteExec(db, `UPDATE sources SET config_json=json_set(config_json,'$.initial_sync_start_ms',${START}) WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(RECEIVED)},'lark.im','Invented Scope',
      ${q(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`);
  reserveInitialLarkAccount(db, createHash('sha256').update(`lark.im\0${SELF.open_id}`).digest('hex'), new Date().toISOString());
  return db;
}
function options(db, endMs = END) {
  return { startMs: START, endMs, endExplicit: true, stableHorizonSeconds: 30,
    pageSize: 50, maxPages: 5, chatPageSize: 100, chatTypes: 'group', lockTtlSeconds: 600,
    retries: 0, retryDelayMs: 0, writeAdmission: captureLarkWriteAdmission(db, { selfOpenId: SELF.open_id }) };
}
const sync = (runner, db, mode, endMs = END) => mode === 'sent'
  ? runner.syncSent(db, options(db, endMs), SELF)
  : runner.syncReceivedScope(db, options(db, endMs), readScope(db, RECEIVED), SELF);
function protectedSnapshot(db) {
  return {
    ...Object.fromEntries(['sources', 'records', 'lark_im_list_progress', 'lark_im_detail_tasks'].map(table =>
      [table, sqliteQuery(db, `SELECT * FROM ${table} ORDER BY rowid;`)])),
    cursors: sqliteQuery(db, 'SELECT id,config_json,cursor_json,cursor_updated_at,last_success_run_id,enabled FROM sync_scopes ORDER BY id;'),
  };
}
function nativeRunner(getPages, getRoot = item => item) {
  const calls = [];
  const adapter = createLarkImAdapter({ run(args) {
    const path = args[2], params = JSON.parse(args[args.indexOf('--params') + 1]);
    calls.push(path);
    const pages = getPages();
    if (path === `${PATH}/search`) {
      assert.deepEqual(JSON.parse(args[args.indexOf('--data') + 1]).filter.from_ids, [SELF.open_id]);
    }
    if (path === PATH) assert.equal(params.container_id, CHAT);
    if (path === `${PATH}/mget`) return page(params.message_ids.map(id => pages.flat().find(item => item.message_id === id)));
    if (path !== PATH && path !== `${PATH}/search`) {
      const queued = pages.flat().find(item => `${PATH}/${item.message_id}` === path);
      assert.ok(queued, 'unexpected injected detail request');
      return page([getRoot(queued), raw('child', { chat_id: OTHER_CHAT,
        sender: { id: FOREIGN, id_type: 'open_id' }, upper_message_id: queued.message_id })]);
    }
    const index = params.page_token ? 1 : 0, items = pages[index];
    return page(path === PATH ? items : items.map(item => ({ meta_data: { message_id: item.message_id } })),
      index + 1 < pages.length, index + 1 < pages.length ? 'second' : '');
  } });
  return { runner: createSyncRunner({ ...adapter, buildPeopleContext: context }), calls };
}

for (const mode of ['received', 'sent']) {
  for (const merged of [false, true]) {
    for (const later of [false, true]) {
      test(`${mode} ${merged ? 'merge root' : 'ordinary'} wrong scope on ${later ? 'later' : 'first'} page preserves all business state and retries`, t => {
        const db = database(t), scopeId = mode === 'sent' ? SENT : RECEIVED;
        let corrected = false;
        const makeBad = () => (merged ? root : raw)('target', corrected ? {} : mode === 'sent'
          ? { sender: { id: FOREIGN, id_type: 'open_id' } } : { chat_id: OTHER_CHAT });
        const good = [raw('ordinary'), root('queued')];
        const h = nativeRunner(() => later ? [good, [makeBad()]] : [[...good, makeBad()]]);
        const before = protectedSnapshot(db), binding = readRemoteAccountBinding({ db, selfOpenId: SELF.open_id });
        const failed = sync(h.runner, db, mode);
        assert.equal(failed.ok, false);
        assert.match(failed.error, /requested scope/);
        assert.doesNotMatch(failed.error, /synthetic|invented|ou_|oc_|om_/);
        assert.deepEqual(protectedSnapshot(db), before, 'no records, full/list cursors, account evidence, or detail debt mutation');
        assert.deepEqual(readRemoteAccountBinding({ db, selfOpenId: SELF.open_id }), binding);
        assert.equal(sqliteQuery(db, 'SELECT COUNT(*) AS n FROM sync_locks;')[0].n, 0);
        assert.deepEqual(sqliteQuery(db, 'SELECT status FROM sync_runs;').map(row => row.status), ['failed']);
        assert.equal(h.calls.some(path => path.endsWith('/om_synthetic_scope_queued')), false, 'invalid list creates no detail work');
        corrected = true;
        const retried = sync(h.runner, db, mode);
        assert.equal(retried.ok, true, JSON.stringify(retried));
        assert.equal(sqliteQuery(db, 'SELECT COUNT(*) AS n FROM records;')[0].n, 3);
        assert.equal(readScope(db, scopeId).cursor.created_at_ms, END);
        assert.equal(readLarkListProgress(db, readScope(db, scopeId)).cursor.created_at_ms, END);
        assert.equal(readRemoteAccountBinding({ db, selfOpenId: SELF.open_id }).state, 'verified');
      });
    }
  }
}

test('unknown typed sent responses cannot contaminate an existing verified account', t => {
  const db = database(t);
  let sender = raw('seed').sender;
  let current = raw('seed');
  const h = nativeRunner(() => [[{ ...current, sender }]]);
  assert.equal(sync(h.runner, db, 'sent').ok, true);
  assert.equal(readRemoteAccountBinding({ db, selfOpenId: SELF.open_id }).state, 'verified');
  const before = protectedSnapshot(db), binding = readRemoteAccountBinding({ db, selfOpenId: SELF.open_id });
  current = raw('later', { create_time: String(END + 1000), update_time: String(END + 2000) });
  for (const bad of [undefined, { id: SELF.open_id }, { id: SELF.open_id, id_type: 'unknown' },
    { open_id: SELF.open_id, sender_type: 'user', type: 'unknown' }, { id: FOREIGN, id_type: 'open_id' }]) {
    sender = bad;
    assert.equal(sync(h.runner, db, 'sent', END + 60_000).ok, false);
    assert.deepEqual(protectedSnapshot(db), before);
    assert.deepEqual(readRemoteAccountBinding({ db, selfOpenId: SELF.open_id }), binding);
    assert.doesNotThrow(() => captureLarkWriteAdmission(db, { selfOpenId: SELF.open_id }));
  }
  sender = raw('seed').sender;
  assert.equal(sync(h.runner, db, 'sent', END + 60_000).ok, true);
  assert.deepEqual(sqliteQuery(db, 'SELECT DISTINCT actor_id FROM records;'), [{ actor_id: SELF.open_id }]);
});

for (const [label, mode, bad] of [
  ['wrong chat', 'received', { chat_id: OTHER_CHAT }],
  ['foreign actor', 'sent', { sender: { id: FOREIGN, id_type: 'open_id' } }],
  ['missing typed actor', 'sent', { sender: { id: SELF.open_id } }],
  ['unknown typed actor', 'sent', { sender: { id: SELF.open_id, id_type: 'unknown' } }],
  ['conflicting actor kind', 'sent', { sender: { open_id: SELF.open_id, sender_type: 'user', type: 'app' } }],
]) {
  test(`deferred newer root with ${label} stays debt until a valid detail retry`, t => {
    const db = database(t), scopeId = mode === 'sent' ? SENT : RECEIVED;
    let corrected = false;
    const items = [raw('ordinary'), root('queued')];
    const h = nativeRunner(() => [items], item => ({ ...item, update_time: String(START + 3000), ...(corrected ? {} : bad) }));
    const cursorBefore = readScope(db, scopeId).cursor;
    const failed = sync(h.runner, db, mode);
    assert.equal(failed.ok, false, JSON.stringify(failed));
    assert.equal(failed.list_complete, true);
    assert.deepEqual(readScope(db, scopeId).cursor, cursorBefore);
    assert.equal(readLarkListProgress(db, readScope(db, scopeId)).cursor.created_at_ms, END);
    const stored = sqliteQuery(db, 'SELECT external_id,actor_id,raw_json FROM records;');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].external_id, items[0].message_id);
    const debt = sqliteQuery(db, 'SELECT status,last_error_message,raw_root_json FROM lark_im_detail_tasks;');
    assert.equal(debt.length, 1);
    assert.equal(debt[0].status, 'pending');
    assert.match(debt[0].last_error_message, /source_scope_mismatch/);
    assert.doesNotMatch(debt[0].last_error_message, /synthetic|invented|ou_|oc_|om_/);
    assert.deepEqual(JSON.parse(debt[0].raw_root_json), items[1]);
    assert.equal(readRemoteAccountBinding({ db, selfOpenId: SELF.open_id }).state, 'verified');
    corrected = true;
    sqliteExec(db, "UPDATE lark_im_detail_tasks SET retry_at='2000-01-01T00:00:00.000Z';");
    const retried = h.runner.retryDetails(db, options(db), SELF);
    assert.equal(retried.length, 1);
    assert.equal(retried[0].ok, true, JSON.stringify(retried));
    assert.equal(readScope(db, scopeId).cursor.created_at_ms, END);
    assert.equal(sqliteQuery(db, 'SELECT COUNT(*) AS n FROM records;')[0].n, 2);
    assert.deepEqual(sqliteQuery(db, 'SELECT external_id,actor_id,raw_json FROM records WHERE external_id=' + q(items[0].message_id) + ';'), stored);
    assert.equal(sqliteQuery(db, "SELECT COUNT(*) AS n FROM lark_im_detail_tasks WHERE status='pending';")[0].n, 0);
    assert.equal(readRemoteAccountBinding({ db, selfOpenId: SELF.open_id }).state, 'verified');
  });
}
