import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bindCurrentSenderNames, reuseKnownSenderNames } from '../src/adapters/lark-im/name-history.mjs';
import { createNameResolver } from '../src/adapters/lark-im/name-resolver.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';
import { createSyncRunner } from '../src/adapters/lark-im/sync-runner.mjs';
import { enrichRecords } from '../src/maintenance/enrich-records.mjs';
import { ensureInitialized, quoteSql, reserveInitialLarkAccount, confirmInitialLarkAccountSql,
  sqliteExec, sqliteQuery, upsertRecordsSql, readScope }
  from '../dist/storage/sqlite/ingestion-store.js';

// Invented from scratch; no captured IDs, messages, names or API payloads.
const EPOCH = Date.UTC(2042, 6, 3);
const ACTOR = 'ou_synthetic_orchard_keeper';
const CHAT = 'oc_synthetic_orchard_north';
const SCOPE = 'lark.im.received.chat.synthetic_orchard_north';
const SELF = { open_id: 'ou_synthetic_orchard_owner', name: 'Orchard Owner' };
function raw(id, overrides = {}) {
  return { message_id: `om_synthetic_orchard_${id}`, chat_id: CHAT, chat_type: 'group', msg_type: 'text',
    create_time: String(EPOCH + 100), update_time: String(EPOCH + 101),
    sender: { id: ACTOR, id_type: 'open_id', sender_type: 'user' },
    content: { text: 'Arrange the invented pear baskets.' }, ...overrides };
}
function record(id, fields = {}, overrides = {}) {
  const value = recordFromMessage(raw(id, overrides), SCOPE, 'received');
  value.canonical_json = JSON.stringify({ ...JSON.parse(value.canonical_json), ...fields });
  return value;
}
const known = (id = 'authority', source = 'contact', name = 'Orchard Keeper', overrides = {}) =>
  record(id, { sender_name: name, sender_name_source: source, sender_name_confidence: 'high' }, overrides);
const canonical = (value) => JSON.parse(value.canonical_json);
function fixture(t, bound = true) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-orchard-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'invented.sqlite');
  ensureInitialized(db);
  if (bound) {
    reserveInitialLarkAccount(db, createHash('sha256').update(`lark.im\0${SELF.open_id}`).digest('hex'), new Date().toISOString());
    sqliteExec(db, confirmInitialLarkAccountSql(new Date().toISOString()));
  }
  sqliteExec(db, `UPDATE sources SET config_json=json_set(config_json,'$.initial_sync_start_ms',${EPOCH}) WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${quoteSql(SCOPE)},'lark.im','invented orchard',
      ${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`);
  return db;
}
const put = (db, ...records) => sqliteExec(db, upsertRecordsSql(records));
const reuse = (db, input, self = SELF) => reuseKnownSenderNames(db, [input], self)[0];

test('verified history fills a new message without changing source facts; repeated upsert is byte stable', (t) => {
  const db = fixture(t);
  put(db, known());
  const next = record('next');
  const filled = reuse(db, next);
  assert.equal(canonical(filled).sender_name, 'Orchard Keeper');
  assert.equal(canonical(filled).sender_name_source, 'local_history');
  assert.equal(canonical(filled).sender_name_authority_source, 'contact');
  for (const key of Object.keys(next).filter((key) => key !== 'canonical_json')) assert.equal(filled[key], next[key], key);
  put(db, filled);
  const snapshot = sqliteQuery(db, 'SELECT * FROM records ORDER BY id;');
  put(db, reuse(db, next));
  assert.deepEqual(sqliteQuery(db, 'SELECT * FROM records ORDER BY id;'), snapshot);
});

test('fresh API name wins over contradictory history and removes historical provenance', (t) => {
  const db = fixture(t);
  put(db, known());
  const next = record('next');
  put(db, reuse(db, next));
  const fresh = known('next', 'contact', 'Current Orchard Keeper');
  assert.strictEqual(reuse(db, fresh), fresh);
  put(db, fresh);
  const saved = canonical(sqliteQuery(db, `SELECT canonical_json FROM records WHERE external_id=${quoteSql(next.external_id)};`)[0]);
  assert.equal(saved.sender_name, 'Current Orchard Keeper');
  assert.equal(saved.sender_name_authority_source, undefined);
});

for (const source of ['contact', 'chat_member']) {
  test(`${source} history respects its global or chat-local identity scope`, (t) => {
    const db = fixture(t);
    put(db, known('authority', source));
    const same = reuse(db, record('same'));
    const other = reuse(db, record('other', {}, { chat_id: 'oc_synthetic_orchard_south' }));
    assert.equal(canonical(same).sender_name, 'Orchard Keeper');
    assert.equal(canonical(other).sender_name, source === 'contact' ? 'Orchard Keeper' : null);
  });
}

for (const mode of ['different_account', 'unbound_database', 'different_database']) {
  test(`history rejects ${mode}`, (t) => {
    const db = fixture(t, mode !== 'unbound_database');
    put(db, known());
    const next = record('next');
    const actual = mode === 'different_database' ? reuse(fixture(t), next)
      : reuse(db, next, mode === 'different_account' ? { open_id: 'ou_synthetic_other_owner' } : SELF);
    assert.strictEqual(actual, next);
  });
}

test('typed namespace conflicts and newly revealed ID aliases cannot consume history', (t) => {
  const db = fixture(t);
  put(db, known('authority', 'contact', 'synthetic_orchard_user_alias'));
  for (const sender of [
    { id: ACTOR, id_type: 'user_id', sender_type: 'user' },
    { id: ACTOR, sender_type: 'user' },
    { id: ACTOR, id_type: 'open_id', open_id: 'ou_synthetic_other_keeper' },
    { id: ACTOR, id_type: 'open_id', user_id: 'synthetic_orchard_user_alias' },
  ]) {
    const next = record('next', {}, { sender });
    assert.strictEqual(reuse(db, next), next);
  }
});

test('a legacy single sent actor cannot authorize reuse from unrelated received history', (t) => {
  const db = fixture(t, false);
  const self = record('legacy_self', { sender_name: 'Orchard Owner', sender_name_source: 'self', sender_name_confidence: 'high' },
    { sender: { id: SELF.open_id, id_type: 'open_id', sender_type: 'user' } });
  self.direction = 'sent';
  put(db, self, known());
  const next = record('next');
  assert.strictEqual(reuse(db, next), next);
  const selfNext = record('self_next', {}, { sender: { id: SELF.open_id, id_type: 'open_id', sender_type: 'user' } });
  selfNext.direction = 'sent';
  assert.equal(canonical(reuse(db, selfNext)).sender_name, 'Orchard Owner');
});

test('conflicting authority names and explicit historical clears fail closed', (t) => {
  for (const blocked of [known('conflict', 'contact', 'Another Orchard Keeper'),
    record('clear', { sender_name: null, sender_name_state: 'cleared' })]) {
    const db = fixture(t);
    put(db, known(), blocked);
    const next = record('next');
    assert.strictEqual(reuse(db, next), next);
  }
});

test('history never seeds itself and excludes guesses, namespace-incompatible sources and ID echoes', (t) => {
  for (const source of ['local_history', 'chat_bot_unique', 'application_api']) {
    const db = fixture(t);
    put(db, known('authority', source));
    const next = record('next');
    assert.strictEqual(reuse(db, next), next);
  }
  const db = fixture(t);
  put(db, known('echo', 'contact', ACTOR));
  const next = record('next');
  assert.strictEqual(reuse(db, next), next);
});

test('application history requires typed app identity and exact matching bot evidence stays chat-local', (t) => {
  const app = { id: 'cli_synthetic_orchard_cart', id_type: 'app_id', sender_type: 'app' };
  for (const source of ['application_api', 'chat_bot_app_id']) {
    const db = fixture(t);
    put(db, known('authority', source, 'Orchard Cart', { sender: app }));
    const next = record('next', {}, { sender: app });
    assert.equal(canonical(reuse(db, next)).sender_name, 'Orchard Cart');
    const other = record('other', {}, { sender: app, chat_id: 'oc_synthetic_orchard_south' });
    assert.equal(canonical(reuse(db, other)).sender_name, source === 'application_api' ? 'Orchard Cart' : null);
  }
});

test('ordinary incremental sync reuses persisted contact authority after a resolver restart and API failure', (t) => {
  const db = fixture(t);
  put(db, known());
  const next = raw('incremental', { body: { content: JSON.stringify({ text: 'Invented incremental pear count.' }) } });
  const calls = [];
  const adapter = createLarkImAdapter({ run(args) {
    calls.push(args.slice(0, 3));
    if (args[2] === '/open-apis/im/v1/messages') return { ok: true, data: { items: [next], has_more: false } };
    throw new Error('synthetic name service unavailable');
  } });
  const runner = createSyncRunner(adapter);
  const result = runner.syncReceivedScope(db, { startMs: EPOCH, endMs: EPOCH + 1000, endExplicit: true,
    stableHorizonSeconds: 30, pageSize: 50, maxPages: 2, chatPageSize: 100, chatTypes: 'group',
    lockTtlSeconds: 600, retries: 0, retryDelayMs: 0 }, readScope(db, SCOPE), SELF);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.inserted, 1);
  const saved = canonical(sqliteQuery(db, `SELECT canonical_json FROM records WHERE external_id=${quoteSql(next.message_id)};`)[0]);
  assert.equal(saved.sender_name, 'Orchard Keeper');
  assert.equal(saved.sender_name_source, 'local_history');
  assert.ok(calls.some((args) => args[0] === 'contact'));
});

test('detail lookup deadline bounds requests and an expired budget prevents every remote name call', () => {
  const calls = [];
  const resolver = createNameResolver({ run(args, options) { calls.push(options); return {}; } });
  const message = raw('budget');
  resolver.buildPeopleContext([message], { nameLookupDeadlineMs: Date.now() + 1000 }, null);
  assert.ok(calls.length > 0);
  for (const opts of calls) assert.ok(opts.timeoutMs > 0 && opts.timeoutMs <= 1000 && opts.retryBudgetMs <= 1000);
  const before = calls.length;
  resolver.buildPeopleContext([message], { nameLookupDeadlineMs: Date.now() - 1 }, null);
  assert.equal(calls.length, before);
});

test('current official observations persist an account marker and are reusable in a legacy source', (t) => {
  const db = fixture(t, false);
  const self = record('legacy_self', {}, { sender: { id: SELF.open_id, id_type: 'open_id', sender_type: 'user' } });
  self.direction = 'sent';
  put(db, self);
  let phase = 0;
  const makeRunner = () => createSyncRunner(createLarkImAdapter({ run(args) {
    if (args[2] === '/open-apis/im/v1/messages') return { ok: true, data: { has_more: false, items: [
      raw(`account_round_${phase}`, { create_time: String(EPOCH + 100 + phase * 1000),
        update_time: String(EPOCH + 101 + phase * 1000), body: { content: '{"text":"Invented pear inventory."}' } }),
    ] } };
    if (phase === 0 && args[0] === 'contact') return { users: [{ open_id: ACTOR, name: 'Orchard Keeper' }] };
    throw new Error('synthetic lookup unavailable after restart');
  } }));
  const run = () => makeRunner().syncReceivedScope(db, { startMs: EPOCH, endMs: EPOCH + (phase + 1) * 1000,
    endExplicit: true, stableHorizonSeconds: 30, pageSize: 50, maxPages: 2, chatPageSize: 100, chatTypes: 'group',
    lockTtlSeconds: 600, retries: 0, retryDelayMs: 0 }, readScope(db, SCOPE), SELF);
  assert.equal(run().ok, true);
  const fresh = canonical(sqliteQuery(db, "SELECT canonical_json FROM records WHERE external_id='om_synthetic_orchard_account_round_0';")[0]);
  assert.equal(fresh.sender_name_account_key, createHash('sha256').update(`lark.im\0${SELF.open_id}`).digest('hex'));
  phase = 1;
  assert.equal(run().ok, true);
  const reused = canonical(sqliteQuery(db, "SELECT canonical_json FROM records WHERE external_id='om_synthetic_orchard_account_round_1';")[0]);
  assert.equal(reused.sender_name, 'Orchard Keeper');
  assert.equal(reused.sender_name_source, 'local_history');
  assert.equal(reused.sender_name_authority_source, 'contact');
});

test('raw names, historical copies and foreign account markers cannot become current official authority', (t) => {
  for (const source of ['message_sender', 'local_history', 'chat_bot_unique']) {
    const input = known('unofficial', source);
    assert.strictEqual(bindCurrentSenderNames([input], SELF)[0], input);
  }
  const db = fixture(t);
  const foreign = bindCurrentSenderNames([known()], { open_id: 'ou_synthetic_foreign_owner' })[0];
  put(db, foreign);
  const next = record('next');
  assert.strictEqual(reuse(db, next), next);
});

test('switching the current account clears resolver authority cache before another account can be stamped', () => {
  let calls = 0;
  const resolver = createNameResolver({ run() {
    calls += 1;
    return { users: [{ open_id: ACTOR, name: `Account Name ${calls}` }] };
  } });
  const input = raw('cache_account');
  const first = resolver.buildPeopleContext([input], {}, SELF);
  assert.equal(first.contacts.get(ACTOR), 'Account Name 1');
  assert.equal(resolver.buildPeopleContext([input], {}, SELF).contacts.get(ACTOR), 'Account Name 1');
  const second = resolver.buildPeopleContext([input], {}, { open_id: 'ou_synthetic_foreign_owner', name: 'Other Owner' });
  assert.equal(second.contacts.get(ACTOR), 'Account Name 2');
  assert.equal(calls, 2);
});

test('a later official app refresh removes stale historical and account provenance', (t) => {
  const db = fixture(t);
  const app = 'cli_synthetic_orchard_cart';
  const old = known('app_refresh', 'local_history', 'Prior Orchard Cart',
    { sender: { id: app, id_type: 'app_id', sender_type: 'app' } });
  old.canonical_json = JSON.stringify({ ...canonical(old), sender_name_authority_source: 'chat_bot_app_id',
    sender_name_account_key: 'a'.repeat(64) });
  put(db, old);
  enrichRecords({ db, limit: 10, dryRun: false, probeApps: true }, { runLark(args) {
    if (args[0] === 'contact' && args[1] === '+get-user') return SELF;
    if (args[0] === 'api') return { app: { app_name: 'Current Orchard Cart' } };
    throw new Error('unexpected synthetic lookup');
  } });
  const saved = canonical(sqliteQuery(db, 'SELECT canonical_json FROM records;')[0]);
  assert.equal(saved.sender_name, 'Current Orchard Cart');
  assert.equal(saved.sender_name_source, 'application_api');
  assert.equal(saved.sender_name_authority_source, undefined);
  assert.equal(saved.sender_name_account_key, undefined);
});
