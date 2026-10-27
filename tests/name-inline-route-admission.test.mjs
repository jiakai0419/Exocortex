import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureInitialized, quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';
import { createNameResolver } from '../src/adapters/lark-im/name-resolver.mjs';
import { prepareInlineNameOptions } from '../src/adapters/lark-im/name-history.mjs';
import { nameRouteAdmission, nameRouteDescriptor, nextNameRouteState } from '../src/adapters/lark-im/name-route-state.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';

// Synthetic identities only; no external process/API is used for resolution.
const SELF = { open_id: 'ou_synthetic_inline_self', name: 'Invented Inline Self' };
const ACCOUNT = recipientAccountKey(SELF.open_id), OTHER = 'b'.repeat(64), CHAT = 'oc_synthetic_inline_room';
const USER = 'ou_synthetic_inline_user', SECOND = 'ou_synthetic_inline_second';
const APP = 'cli_synthetic_inline_app', SECOND_APP = 'cli_synthetic_inline_second';
const stamp = Date.parse('2025-01-01T00:00:00.000Z');
const message = (id = USER, namespace = 'open_id', chat = CHAT) => ({ message_id: `om_${id}`, chat_id: chat,
  chat_type: 'group', sender: { id, id_type: namespace, sender_type: namespace === 'app_id' ? 'app' : 'user' } });
const task = (actor = USER, namespace = 'open_id', chat = CHAT, account = ACCOUNT) => ({
  source_id: 'lark.im', account_key: account, kind: 'sender', actor_id: actor, namespace, chat_id: chat });
function blocked(operation, actor = USER, namespace = 'open_id', chat = CHAT, account = ACCOUNT) {
  const route = nameRouteDescriptor(task(actor, namespace, chat, account), operation);
  return nextNameRouteState(route, null, { type: 'failure', error:
    `lark-cli failed: kind=permission_denied code=210508 operation=${operation}` }, { nowMs: stamp }).row;
}
const target = (operation, actor_id = USER, namespace = 'open_id', chat_id = '') => ({ operation, actor_id, namespace, chat_id });
function fixture(t, values = []) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-inline-admission-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite'); ensureInitialized(db);
  for (const row of values) {
    const columns = Object.keys(row);
    sqliteExec(db, `INSERT INTO lark_im_name_routes(${columns.join(',')}) VALUES(${columns.map(key => row[key] === null ? 'NULL' : quoteSql(row[key])).join(',')});`);
  }
  return db;
}
const sha = db => createHash('sha256').update(readFileSync(db)).digest('hex');

test('ordinary route admission validates exact rows, keeps terminal routes closed when due, and respects temporary retry', () => {
  const descriptor = nameRouteDescriptor(task(), 'contact_search'), denied = blocked('contact_search');
  assert.deepEqual(nameRouteAdmission(descriptor, null, stamp), { allowed: true, state: 'ready' });
  assert.deepEqual(nameRouteAdmission(descriptor, denied, stamp + 100_000_000), { allowed: false, state: 'blocked' });
  const exhausted = { ...denied, blocked: 0, failure_kind: 'network_timeout', failures: 3, failure_code: null };
  assert.deepEqual(nameRouteAdmission(descriptor, exhausted, stamp + 100_000_000), { allowed: false, state: 'exhausted' });
  const retry = { ...exhausted, failures: 1, retry_at_ms: stamp + 5000 };
  assert.deepEqual(nameRouteAdmission(descriptor, retry, stamp + 4999), { allowed: false, state: 'retry' });
  assert.deepEqual(nameRouteAdmission(descriptor, retry, stamp + 5000), { allowed: true, state: 'ready' });
  for (const invalid of [{ ...denied, account_key: OTHER }, { ...denied, operation: 'application_info' },
    { ...denied, failures: '1' }, { ...denied, failure_kind: 'private-error' }, { ...denied, last_attempt_at_ms: stamp + 1 }]) {
    assert.deepEqual(nameRouteAdmission(descriptor, invalid, stamp), { allowed: false, state: 'unavailable' });
  }
  assert.deepEqual(nameRouteAdmission(null, null, stamp), { allowed: false, state: 'unavailable' });
});

test('one bounded exact metadata query isolates account, actor, namespace, operation and chat without writes', t => {
  const rows = [blocked('contact_search'), blocked('chat_members'), blocked('application_info', APP, 'app_id'),
    blocked('chat_bots', APP, 'app_id'), blocked('contact_search', SECOND, 'open_id', CHAT, OTHER)];
  const db = fixture(t, rows), before = sha(db), calls = [];
  const opts = prepareInlineNameOptions(db, [message(), message(SECOND), message(APP, 'app_id'), message(APP, 'app_id', 'oc_synthetic_other')], SELF, {}, {}, {
    query(path, sql, label, options) { calls.push({ sql, label, options }); return readOnlySqliteJson(path, sql, label, options); },
  });
  assert.equal(calls.length, 1); assert(calls[0].options.timeoutMs <= 1500);
  assert.match(calls[0].sql, /account_key=/); assert.match(calls[0].sql, /route_key IN/);
  assert.doesNotMatch(calls[0].sql, /FROM records|canonical_json|raw_json|\b(?:UPDATE|INSERT|DELETE)\b/);
  assert.equal(opts.nameRouteAdmission(target('contact_search')), false);
  assert.equal(opts.nameRouteAdmission(target('contact_search', SECOND)), true, 'another account cannot block this actor');
  assert.equal(opts.nameRouteAdmission(target('chat_members', USER, 'open_id', CHAT)), false);
  assert.equal(opts.nameRouteAdmission(target('application_info', APP, 'app_id')), false);
  assert.equal(opts.nameRouteAdmission(target('chat_bots', APP, 'app_id', CHAT)), false);
  assert.equal(opts.nameRouteAdmission(target('chat_bots', APP, 'app_id', 'oc_synthetic_other')), true);
  assert.equal(opts.nameRouteAdmission(target('contact_search', APP, 'open_id')), false, 'a wrong explicit namespace is not in the snapshot');
  assert.equal(sha(db), before);
});

test('metadata read cost consumes the shared deadline and a failed read creates no observation or lost positive cache', t => {
  const db = fixture(t), start = Date.now(); let elapsed = 0;
  const bounded = prepareInlineNameOptions(db, [message()], SELF, {}, { nameLookupDeadlineMs: start + 800 }, {
    now: () => start, monotonicNow: () => elapsed,
    query(path, sql, label, options) { assert.equal(options.timeoutMs, 800); elapsed = 350; return readOnlySqliteJson(path, sql, label); },
  });
  assert.equal(bounded.nameLookupDeadlineMs, start + 450);
  assert.equal(bounded.nameRouteAdmission(target('contact_search')), true);
  elapsed = 801; assert.equal(bounded.nameRouteAdmission(target('contact_search')), false);
  let requests = 0;
  const resolver = createNameResolver({ run: () => { requests++; return { users: [{ open_id: USER, name: 'Invented Cache' }] }; } });
  resolver.buildPeopleContext([message()], {}, SELF);
  assert.equal(requests, 1);
  const unavailable = prepareInlineNameOptions(db, [message(), message(SECOND)], SELF, {}, {}, { query() { throw Error('synthetic unavailable'); } });
  const context = resolver.buildPeopleContext([message(), message(SECOND)], unavailable, SELF);
  assert.equal(context.contacts.get(USER), 'Invented Cache'); assert.equal(context.contacts.has(SECOND), false);
  assert.equal(requests, 1); assert.equal(resolver.senderNameObservation(SECOND, CHAT, 'open_id'), null);
  assert.equal(resolver.senderNameObservation(USER, CHAT, 'open_id').cached, true);
});

test('malformed/duplicate route metadata defers only optional lookup and never fabricates denial observations', t => {
  const good = blocked('contact_search'), db = fixture(t, [good]);
  for (const result of [[{ ...good, blocked: '1' }], [good, good]]) {
    const opts = prepareInlineNameOptions(db, [message()], SELF, {}, {}, { query: () => result });
    let requests = 0;
    const resolver = createNameResolver({ run: () => { requests++; assert.fail('unavailable metadata must defer'); } });
    // The member route is absent and independently usable unless the whole
    // duplicate snapshot is invalid. Restrict this call to the exact contact.
    assert.equal(resolver.resolveContactNames([USER], opts).size, 0);
    assert.equal(requests, 0); assert.equal(resolver.senderNameObservation(USER, CHAT, 'open_id'), null);
  }
});

test('positive contact/app/member caches precede a denying hook and do not renew remote lookup', () => {
  const calls = [];
  const resolver = createNameResolver({ run(args) {
    calls.push(args);
    if (args[0] === 'contact') return { users: [{ open_id: USER, name: 'Invented Contact' }] };
    if (args[0] === 'api') return { app: { app_id: APP, app_name: 'Invented Application' } };
    return { items: [{ member_id: SECOND, member_id_type: 'open_id', name: 'Invented Member' }], has_more: false };
  } });
  resolver.resolveContactNames([USER], {}); resolver.resolveApplicationNames([APP], {}); resolver.resolveChatMemberNames(CHAT, [SECOND], {});
  const opts = { nameRouteAdmission() { assert.fail('a positive cache should not need request admission'); } };
  assert.equal(resolver.resolveContactNames([USER], opts).get(USER), 'Invented Contact');
  assert.equal(resolver.resolveApplicationNames([APP], opts).get(APP), 'Invented Application');
  assert.equal(resolver.resolveChatMemberNames(CHAT, [SECOND], opts).get(SECOND), 'Invented Member');
  assert.equal(calls.length, 3);
});

test('contact batching filters exact targets after cache while preserving full alias conflict checks and partner work', () => {
  const calls = [], targets = [];
  const resolver = createNameResolver({ run(args) {
    calls.push(args); assert.equal(args[0], 'contact');
    assert.equal(args[args.indexOf('--user-ids') + 1], SECOND);
    return { users: [{ open_id: SECOND, name: 'synthetic-second-alias' }] };
  } });
  const opts = { nameRouteAdmission(request) { targets.push(request); return request.actor_id === SECOND && request.operation === 'contact_search'; } };
  const second = message(SECOND); second.sender.user_id = 'synthetic-second-alias';
  const native = message('ou_synthetic_native'); native.sender.name = 'Invented Native';
  const partner = message(); partner.chat_partner = { id: SECOND, id_type: 'open_id', user_id: 'synthetic-second-alias' };
  const before = JSON.stringify([partner, second, native]);
  const result = resolver.buildPeopleContext([partner, second, native], opts, SELF);
  assert.equal(calls.length, 1); assert.equal(result.contacts.size, 1, 'only self seed remains; echoed alias is not a name');
  assert.equal(result.contacts.has(SECOND), false); assert.equal(result.contacts.has(USER), false);
  assert.equal(resolver.senderNameObservation(USER, CHAT, 'open_id'), null);
  assert.equal(JSON.stringify([partner, second, native]), before);
  assert(targets.every(value => value.namespace === 'open_id'));
});

test('member and bot pages cannot adopt excluded targets but independently admitted peers remain resolvable', () => {
  const calls = [];
  const resolver = createNameResolver({ run(args) {
    calls.push(args[2]);
    return args[2] === 'get' ? { items: [
      { member_id: USER, member_id_type: 'open_id', name: 'Invented Excluded' },
      { member_id: SECOND, member_id_type: 'open_id', name: 'Invented Independent Member' }], has_more: false }
      : { items: [{ app_id: APP, name: 'Invented Excluded Bot' }, { app_id: SECOND_APP, name: 'Invented Independent Bot' }] };
  } });
  const opts = { nameRouteAdmission: request => [SECOND, SECOND_APP].includes(request.actor_id) };
  const members = resolver.resolveChatMemberNames(CHAT, [USER, SECOND], opts);
  assert.equal(members.has(USER), false); assert.equal(members.get(SECOND), 'Invented Independent Member');
  const bots = resolver.resolveChatBotAppFallbackNames(new Map([[CHAT, new Set([APP, SECOND_APP])]]), new Map(), opts);
  assert.equal(bots.has(`${CHAT}:${APP}`), false); assert.equal(bots.get(`${CHAT}:${SECOND_APP}`).name, 'Invented Independent Bot');
  assert.equal(resolver.senderNameObservation(USER, CHAT, 'open_id'), null);
  assert.equal(resolver.senderNameObservation(APP, CHAT, 'app_id'), null);
  assert.deepEqual(calls, ['get', 'bots']);
});

test('typed metadata descriptors are never guessed from names/prefixes and partner scope stays exact', t => {
  const db = fixture(t); let queryCount = 0;
  const untyped = message(APP, 'app_id'); delete untyped.sender.id_type;
  const wrong = message(USER, 'user_id');
  const valid = message(SECOND); valid.chat_partner = { id: USER, id_type: 'open_id' };
  const opts = prepareInlineNameOptions(db, [untyped, wrong, valid], SELF, {}, {}, {
    query(path, sql, label, options) { queryCount++; return readOnlySqliteJson(path, sql, label, options); },
  });
  assert.equal(queryCount, 1);
  assert.equal(opts.nameRouteAdmission(target('application_info', APP, 'app_id')), false);
  assert.equal(opts.nameRouteAdmission(target('contact_search', USER)), true, 'the explicit partner grants the contact route, not the same bytes in user_id');
  assert.equal(opts.nameRouteAdmission(target('chat_members', USER, 'open_id', CHAT)), false);
  assert.equal(opts.nameRouteAdmission(target('chat_members', SECOND, 'open_id', CHAT)), true);
});

test('large batches keep one finite route query and exhausted preparation starts no lookup', t => {
  const db = fixture(t), messages = Array.from({ length: 201 }, (_, i) => message(`ou_synthetic_bounded_${i}`));
  let queries = 0;
  const opts = prepareInlineNameOptions(db, messages, SELF, {}, {}, {
    query(path, sql, label, options) {
      queries++; assert.match(sql, /LIMIT 401;/);
      assert.equal((sql.match(/'[a-f0-9]{64}'/g) || []).length, 401, '400 route keys plus the exact account');
      return readOnlySqliteJson(path, sql, label, options);
    },
  });
  assert.equal(queries, 1);
  assert.equal(opts.nameRouteAdmission(target('contact_search', 'ou_synthetic_bounded_199')), true);
  assert.equal(opts.nameRouteAdmission(target('contact_search', 'ou_synthetic_bounded_200')), false);
  const wall = Date.now(); let elapsed = 0, requests = 0;
  const spent = prepareInlineNameOptions(db, [message()], SELF, {}, { nameLookupDeadlineMs: wall + 500 }, {
    now: () => wall, monotonicNow: () => elapsed,
    query() { elapsed = 500; return []; },
  });
  const resolver = createNameResolver({ run() { requests++; assert.fail('the metadata read spent the name allowance'); } });
  const context = resolver.buildPeopleContext([message()], spent, SELF);
  assert.equal(requests, 0); assert.equal(context.contacts.has(USER), false);
  assert.equal(resolver.senderNameObservation(USER, CHAT, 'open_id'), null);
});
