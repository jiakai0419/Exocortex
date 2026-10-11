import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createNameResolver } from '../src/adapters/lark-im/name-resolver.mjs';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { runLarkImSyncCli } from './helpers/sync-command.mjs';
import { bindCurrentSenderNames } from '../src/adapters/lark-im/name-history.mjs';
import { ensureInitialized, quoteSql, sqliteExec, sqliteQuery, upsertRecordsSql } from '../dist/storage/sqlite/ingestion-store.js';

// New synthetic fixtures only; no captured names, identifiers, or responses.
const SELF = { open_id: 'ou_synthetic_verification_owner', name: 'Synthetic Owner' };
const ID = 'ou_synthetic_verification_gardener';
const APP = 'cli_synthetic_verification_wheelbarrow';
const CHAT = 'oc_synthetic_verification_garden';
const EPOCH = Date.UTC(2049, 2, 1);
const message = (sender = { id: ID, id_type: 'open_id', sender_type: 'user' }) => ({
  message_id: 'om_synthetic_verification_seed', chat_id: CHAT, chat_type: 'group', msg_type: 'text',
  create_time: String(EPOCH), update_time: String(EPOCH + 1000), sender,
  content: { text: 'Count the imaginary seedlings.' },
});
const appMessage = () => message({ id: APP, id_type: 'app_id', sender_type: 'app' });
const canonical = record => JSON.parse(record.canonical_json);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-verification-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite');
  ensureInitialized(db);
  return db;
}

for (const appName of [APP, `  ${APP}  `, '', ' ']) {
  test(`invalid application candidate ${JSON.stringify(appName)} cannot cache success or block exact bot fallback`, () => {
    const calls = [];
    const adapter = createLarkImAdapter({ run(args) {
      calls.push(args.slice(0, 3));
      if (args[0] === 'api') return { app: { app_id: APP, app_name: appName } };
      return { items: [{ app_id: APP, bot_name: 'Synthetic Seed Cart' }] };
    } });
    for (let i = 0; i < 2; i++) {
      const context = adapter.buildPeopleContext([appMessage()], {}, SELF);
      const record = recordFromMessage(appMessage(), 'lark.im.sent_by_me', 'sent', context);
      assert.equal(canonical(record).sender_name, 'Synthetic Seed Cart');
      assert.equal(canonical(record).sender_name_source, 'chat_bot_app_id');
      assert.equal(canonical(record).sender_name_verification.source, 'chat_bot_app_id');
    }
    assert.equal(calls.filter(args => args[0] === 'api').length, 2, 'no positive cache for echoed ID');
    assert.equal(calls.filter(args => args[2] === 'bots').length, 2);
  });
}

test('name acceptance retains numeric nicknames and rejects conflicting exact bot mappings', () => {
  const numeric = createNameResolver({ run: () => ({ users: [{ open_id: ID, name: 'User 2049123' }] }) });
  assert.equal(numeric.resolveContactNames([ID], {}).get(ID), 'User 2049123');
  const conflict = createNameResolver({ run: args => args[0] === 'api' ? { app: { app_name: APP } }
    : { items: [{ app_id: APP, bot_name: 'Synthetic First' }, { app_id: APP, bot_name: 'Synthetic Second' }] } });
  const context = conflict.buildPeopleContext([appMessage()], {}, SELF);
  assert.equal(context.app_fallbacks.size, 0);
  assert.equal(canonical(recordFromMessage(appMessage(), 'lark.im.sent_by_me', 'sent', context)).sender_name_verification.status, 'conflict');
});

test('people context → record → SQLite keeps adopted name/time separate from cache, rename, conflict and failure', t => {
  const db = fixture(t);
  let now = EPOCH, mode = 'first', calls = 0;
  const resolver = createNameResolver({ now: () => now, run(args) {
    calls++;
    if (mode === 'failed') throw new Error('synthetic lookup failure');
    if (mode === 'conflict') return args[0] === 'contact'
      ? { users: [{ open_id: ID, name: 'Synthetic A' }, { open_id: ID, name: 'Synthetic B' }] }
      : { items: [] };
    return { users: [{ open_id: ID, name: mode === 'first' ? 'Synthetic Gardener' : 'Synthetic Arborist' }] };
  } });
  const input = message();
  const store = () => {
    const context = resolver.buildPeopleContext([input], {}, SELF);
    const record = recordFromMessage(input, 'lark.im.sent_by_me', 'sent', context);
    sqliteExec(db, upsertRecordsSql(bindCurrentSenderNames([record], SELF)));
    return sqliteQuery(db, 'SELECT * FROM records;')[0];
  };
  const first = store();
  const originalTime = canonical(first).sender_name_observed_at;
  assert.equal(originalTime, new Date(EPOCH).toISOString());
  now++;
  const cached = store();
  assert.equal(calls, 1);
  assert.equal(canonical(cached).sender_name_observed_at, originalTime);
  assert.equal(canonical(cached).sender_name_verification.observed_at, originalTime);
  assert.equal(canonical(cached).sender_name_verification.cached, true);
  assert.equal(canonical(cached).sender_name_verification.account_key,
    createHash('sha256').update(`lark.im\0${SELF.open_id}`).digest('hex'));
  now++;
  assert.deepEqual(store(), cached, 'repeated cache use is byte stable and does not advance an observation time');
  assert.equal(calls, 1);
  mode = 'rename'; now += 300_000;
  const renamed = store();
  assert.equal(canonical(renamed).sender_name, 'Synthetic Arborist');
  assert.equal(canonical(renamed).sender_name_observed_at, new Date(now).toISOString());
  for (const nextMode of ['conflict', 'failed']) {
    mode = nextMode; now += 300_000;
    const after = store();
    assert.equal(canonical(after).sender_name, 'Synthetic Arborist');
    assert.equal(canonical(after).sender_name_observed_at, canonical(renamed).sender_name_observed_at);
    assert.equal(canonical(after).sender_name_verification.status, nextMode);
    for (const key of ['raw_json', 'content_hash', 'external_version', 'body']) assert.equal(after[key], first[key], key);
  }
});

test('legacy name time stays unknown after failure and metadata bind preserves unknown large integer token', t => {
  const db = fixture(t);
  const initial = recordFromMessage(message(), 'lark.im.sent_by_me', 'sent', { contacts: new Map([[ID, 'Synthetic Legacy']]) });
  initial.canonical_json = initial.canonical_json.replace(/}$/, ',"unknown":9007199254740993}');
  const bound = bindCurrentSenderNames([initial], SELF)[0];
  assert.match(bound.canonical_json, /"unknown":9007199254740993/);
  assert.equal(canonical(bound).sender_name_observed_at, undefined);
  sqliteExec(db, upsertRecordsSql([bound]));
  const resolver = createNameResolver({ run() { throw new Error('synthetic unavailable'); } });
  const context = resolver.buildPeopleContext([message()], {}, SELF);
  const incoming = recordFromMessage(message(), 'lark.im.sent_by_me', 'sent', context);
  sqliteExec(db, upsertRecordsSql([incoming]));
  const after = canonical(sqliteQuery(db, 'SELECT canonical_json FROM records;')[0]);
  assert.equal(after.sender_name, 'Synthetic Legacy');
  assert.equal(after.sender_name_observed_at, undefined);
  assert.equal(after.sender_name_verification.status, 'failed');
});

test('explicit adapter verification bypasses positive cache, binds account, reports same/changed, and never mutates source', () => {
  let name = 'Synthetic First', calls = 0;
  const adapter = createLarkImAdapter({ run(args, options) {
    calls++;
    if (options.timeoutMs !== undefined) {
      assert.equal(options.retries, 0);
      assert.ok(options.timeoutMs <= 5000);
    }
    return { users: [{ open_id: ID, name }] };
  } });
  const input = message(), before = JSON.stringify(input);
  adapter.buildPeopleContext([input], {}, SELF);
  assert.equal(adapter.verifySenderName(input, name, SELF).status, 'same');
  name = 'Synthetic Changed';
  const result = adapter.verifySenderName(input, 'Synthetic First', SELF);
  assert.equal(result.status, 'changed');
  assert.equal(result.observation.cached, false);
  assert.equal(result.adopted_name, 'Synthetic First', 'read-only report does not adopt the candidate');
  assert.equal(calls, 3);
  assert.equal(JSON.stringify(input), before);
  assert.equal(adapter.verifySenderName(input, name, { open_id: '', name: '' }).status, 'conflict');
  assert.equal(calls, 3);
});

test('explicit verification is limited to one contact request and two member pages, with no retries', () => {
  const calls = [];
  const resolver = createNameResolver({ run(args, options) {
    calls.push({ args, options });
    if (args[0] === 'contact') return { users: [] };
    return { items: [], has_more: true, page_token: `synthetic_page_${calls.length}` };
  } });
  const result = resolver.verifySenderName(message(), 'Synthetic Existing', SELF);
  assert.equal(result.status, 'unresolved');
  assert.equal(calls.length, 3);
  for (const { options } of calls) {
    assert.equal(options.retries, 0);
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 5000);
  }
  const before = calls.length;
  resolver.verifySenderName(message(), 'Synthetic Existing', SELF, { nameLookupDeadlineMs: Date.now() - 1 });
  assert.equal(calls.length, before);
});

test('exact app verification cannot use a unique unbound bot and conflicts preserve the adopted name', () => {
  const resolver = createNameResolver({ run: args => args[0] === 'api' ? { app: { app_name: APP } }
    : { items: [{ bot_name: 'Synthetic Unbound' }] } });
  const result = resolver.verifySenderName(appMessage(), 'Synthetic Existing', SELF);
  assert.equal(result.status, 'unresolved');
  assert.equal(result.adopted_name, 'Synthetic Existing');
});

for (const mode of ['same', 'actor', 'namespace', 'chat', 'account']) {
  test(`latest verification inheritance stays inside matching ${mode} context`, t => {
    const db = fixture(t);
    const resolver = createNameResolver({ run: () => ({ users: [{ open_id: ID, name: 'Synthetic Gardener' }] }) });
    const input = message();
    const initial = bindCurrentSenderNames([recordFromMessage(input, 'lark.im.sent_by_me', 'sent',
      resolver.buildPeopleContext([input], {}, SELF))], SELF)[0];
    sqliteExec(db, upsertRecordsSql([initial]));
    const nextInput = structuredClone(input);
    if (mode === 'actor') nextInput.sender.id = 'ou_synthetic_verification_other';
    if (mode === 'namespace') nextInput.sender.id_type = 'user_id';
    if (mode === 'chat') nextInput.chat_id = 'oc_synthetic_verification_other';
    const nextSelf = mode === 'account' ? { open_id: 'ou_synthetic_verification_other_owner', name: 'Other' } : SELF;
    const incoming = bindCurrentSenderNames([recordFromMessage(nextInput, 'lark.im.sent_by_me', 'sent',
      { contacts: new Map([[nextInput.sender.id, 'Synthetic Gardener']]) })], nextSelf)[0];
    assert.equal(canonical(incoming).sender_name_verification, undefined);
    sqliteExec(db, upsertRecordsSql([incoming]));
    const saved = canonical(sqliteQuery(db, 'SELECT canonical_json FROM records;')[0]);
    assert.equal(saved.sender_name_verification?.status, mode === 'same' ? 'resolved' : undefined);
  });
}

test('switching accounts clears positive caches before an explicit current verification', () => {
  let calls = 0;
  const resolver = createNameResolver({ run: () => ({ users: [{ open_id: ID, name: `Synthetic Account ${++calls}` }] }) });
  const first = resolver.buildPeopleContext([message()], {}, SELF);
  const other = { open_id: 'ou_synthetic_verification_other_owner', name: 'Other' };
  const second = resolver.buildPeopleContext([message()], {}, other);
  const a = first.sender_name_observations.get(JSON.stringify([CHAT, ID, 'open_id']));
  const b = second.sender_name_observations.get(JSON.stringify([CHAT, ID, 'open_id']));
  assert.notEqual(a.account_key, b.account_key);
  assert.equal(b.cached, false);
  assert.equal(calls, 2);
});

test('explicit verification rejects conflicting wrapper chat before any lookup', () => {
  const resolver = createNameResolver({ run() { assert.fail('identity conflict must not make a lookup'); } });
  const source = message();
  const wrapper = { ...source, chat_id: 'oc_synthetic_different_wrapper', raw_api: source };
  assert.equal(resolver.verifySenderName(wrapper, 'Synthetic Existing', SELF).status, 'conflict');
});

test('standalone resolver and people-context callers both stop fallback after contradictory exact evidence', () => {
  const calls = [];
  const resolver = createNameResolver({ run(args) {
    calls.push(args[0]);
    return { users: [{ open_id: ID, name: 'Synthetic First' }, { open_id: ID, name: 'Synthetic Second' }] };
  } });
  assert.equal(resolver.resolveContactNames([ID], {}).size, 0);
  assert.equal(resolver.resolveChatMemberNames(CHAT, [ID], {}).size, 0);
  assert.deepEqual(calls, ['contact']);
  assert.equal(resolver.senderNameObservation(ID, CHAT).status, 'conflict');
});

test('an observation for an open_id cannot be borrowed by equal user_id bytes in the same batch and chat', () => {
  let calls = 0;
  const resolver = createNameResolver({ run() { calls++; return { users: [{ open_id: ID, name: 'Synthetic Contact' }] }; } });
  const open = message();
  const user = { ...message({ id: ID, id_type: 'user_id', sender_type: 'user' }), message_id: 'om_synthetic_other_namespace' };
  const context = resolver.buildPeopleContext([open, user], {}, SELF);
  const openRecord = recordFromMessage(open, 'lark.im.sent_by_me', 'sent', context);
  const userRecord = recordFromMessage(user, 'lark.im.sent_by_me', 'sent', context);
  assert.equal(calls, 1);
  assert.equal(canonical(openRecord).sender_name_verification.status, 'resolved');
  assert.equal(canonical(userRecord).sender_name, null);
  assert.equal(canonical(userRecord).sender_name_verification, undefined);
  assert.equal(canonical(userRecord).sender_name_observed_at, undefined);
});

test('advancing clock does not shift original observation time when the positive cache is reused', () => {
  let time = EPOCH, calls = 0;
  const resolver = createNameResolver({ now: () => time++, run() {
    calls++;
    return { users: [{ open_id: ID, name: 'Synthetic Contact' }] };
  } });
  const build = () => recordFromMessage(message(), 'lark.im.sent_by_me', 'sent',
    resolver.buildPeopleContext([message()], {}, SELF));
  const first = canonical(build());
  const second = canonical(build());
  assert.equal(calls, 1);
  assert.equal(second.sender_name_observed_at, first.sender_name_observed_at);
  assert.equal(second.sender_name_verification.observed_at, first.sender_name_verification.observed_at);
  assert.equal(second.sender_name_verification.cached, true);
});

for (const mode of ['same_account', 'different_account', 'legacy_unknown']) {
  test(`real sync in a received-only legacy DB preserves adopted names only within ${mode} evidence`, t => {
    const db = fixture(t), scope = chatScopeId(CHAT);
    sqliteExec(db, `UPDATE sources SET config_json=${quoteSql(JSON.stringify({ initial_sync_start_ms: EPOCH - 1000 }))} WHERE id='lark.im';
      INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${quoteSql(scope)},'lark.im','Synthetic Garden',
        ${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`);
    const raw = { ...message(), body: { content: '{"text":"Synthetic seed ledger"}' } };
    delete raw.content;
    const normalized = normalizeApiMessage(raw);
    const resolver = createNameResolver({ now: () => EPOCH, run: () => ({ users: [{ open_id: ID, name: 'Synthetic Adopted' }] }) });
    const adopted = mode === 'legacy_unknown'
      ? recordFromMessage(normalized, scope, 'received', { contacts: new Map([[ID, 'Synthetic Adopted']]) })
      : bindCurrentSenderNames([recordFromMessage(normalized, scope, 'received',
        resolver.buildPeopleContext([normalized], {}, SELF))], SELF)[0];
    sqliteExec(db, upsertRecordsSql([adopted]));
    const nextSelf = mode === 'different_account' ? { open_id: 'ou_synthetic_verification_other_owner', name: 'Other' } : SELF;
    const unavailable = createNameResolver({ run() { throw new Error('Synthetic name lookup unavailable'); } });
    let stdout = '', stderr = '';
    const code = runLarkImSyncCli(['--db', db, '--scope', 'received', '--start', new Date(EPOCH - 1000).toISOString(),
      '--end', new Date(EPOCH + 60_000).toISOString()], {
      stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
      deps: { getSelfProfile: () => nextSelf, syncRunnerDeps: {
        fetchChatMessageList: () => ({ messages: [normalized], detailRoots: [], pages: 1 }),
        buildPeopleContext: mode === 'legacy_unknown' ? () => ({}) : unavailable.buildPeopleContext,
      } },
    });
    assert.equal(code, 0, stderr || stdout);
    const saved = sqliteQuery(db, 'SELECT * FROM records;')[0], projection = canonical(saved);
    for (const key of ['raw_json', 'content_hash', 'external_version', 'body']) assert.equal(saved[key], adopted[key], key);
    if (mode === 'different_account') {
      assert.equal(projection.sender_name, null);
      assert.equal(projection.sender_name_observed_at, undefined);
      assert.equal(projection.sender_name_account_key, undefined);
      assert.equal(projection.sender_name_verification.status, 'failed');
      assert.notEqual(projection.sender_name_verification.account_key, canonical(adopted).sender_name_account_key);
    } else {
      assert.equal(projection.sender_name, 'Synthetic Adopted');
      assert.equal(projection.sender_name_observed_at, canonical(adopted).sender_name_observed_at);
      assert.equal(projection.sender_name_account_key, canonical(adopted).sender_name_account_key);
    }
  });
}
