import test from 'node:test';
import assert from 'node:assert/strict';
import { nameRouteDescriptor, classifyNameRouteFailure, nextNameRouteState } from '../src/adapters/lark-im/name-route-state.mjs';
import { createLarkCliRunner, createTransportState } from '../src/adapters/lark-im/transport.mjs';

// Fully authored synthetic tasks and fake subprocess results; no account/API reads.
const ACCOUNT = 'a'.repeat(64), OTHER_ACCOUNT = 'b'.repeat(64);
const task = overrides => ({ source_id: 'lark.im', account_key: ACCOUNT, kind: 'sender',
  namespace: 'open_id', actor_id: 'synthetic-typed-actor', chat_id: 'synthetic-chat-a', ...overrides });
const route = (operation = 'contact_search', overrides) => nameRouteDescriptor(task(overrides), operation);
const failure = (value = 'lark-cli failed: kind=network_timeout operation=contact_search') => ({ type: 'failure', error: new Error(value) });
const at = (nowMs, cooldownUntilMs = 0) => ({ nowMs, cooldownUntilMs });

test('contact/application failure keys deduplicate exact typed identity across chats only', () => {
  for (const [operation, namespace] of [['contact_search', 'open_id'], ['application_info', 'app_id']]) {
    const first = route(operation, { namespace });
    assert.deepEqual(route(operation, { namespace, chat_id: 'synthetic-chat-b', latest_record_id: 900 }), first);
    assert.notEqual(route(operation, { namespace, account_key: OTHER_ACCOUNT }).route_key, first.route_key);
    assert.notEqual(route(operation, { namespace, actor_id: 'synthetic-other-actor' }).route_key, first.route_key);
    assert.equal(first.route_key.length, 64);
  }
});

test('member and bot failures remain bound to their exact chat and operation', () => {
  for (const [operation, namespace] of [['chat_members', 'open_id'], ['chat_bots', 'app_id']]) {
    const first = route(operation, { namespace });
    assert.notEqual(route(operation, { namespace, chat_id: 'synthetic-chat-b' }).route_key, first.route_key);
    assert.notEqual(route(operation, { namespace, account_key: OTHER_ACCOUNT }).route_key, first.route_key);
  }
  assert.notEqual(route('application_info', { namespace: 'app_id' }).route_key,
    route('chat_bots', { namespace: 'app_id' }).route_key);
});

test('chat metadata isolation is a chat route even though transport bucket is other', () => {
  const chat = { kind: 'chat', namespace: '', actor_id: '' };
  const first = route('other', chat);
  assert.ok(first);
  assert.notEqual(route('other', { ...chat, chat_id: 'synthetic-chat-b' }).route_key, first.route_key);
  assert.equal(route('other'), null);
  assert.equal(route('contact_search', chat), null);
});

test('namespace is explicit and prefixes never establish a lookup route', () => {
  for (const overrides of [{ namespace: 'user_id', actor_id: 'ou_synthetic' },
    { namespace: '', actor_id: 'ou_synthetic' }, { source_id: 'other-source' },
    { account_key: 'not-an-account-digest' }, { chat_id: '' }, { actor_id: '\0' },
    { actor_id: 'x'.repeat(513) }]) assert.equal(route('contact_search', overrides), null);
  assert.equal(route('contact_search', { namespace: 'app_id' }), null);
  assert.equal(route('application_info'), null);
  assert.ok(route('contact_search', { actor_id: 'no-prefix-but-explicitly-typed' }));
});

test('safe transport descriptors retain only finite kind and numeric evidence', () => {
  assert.deepEqual(classifyNameRouteFailure(new Error('lark-cli failed: kind=unknown code=210508 operation=application_info'), 'application_info'),
    { kind: 'permission_denied', code: 210508, retryAfterMs: null });
  assert.deepEqual(classifyNameRouteFailure('lark-cli failed: kind=rate_limited code=99991400 retry_after_ms=7000 retry_after_source=header operation=contact_search retry_exhausted=1'),
    { kind: 'rate_limited', code: 99991400, retryAfterMs: 7000 });
  assert.equal(classifyNameRouteFailure('lark-cli failed: kind=network_timeout timeout_ms=321 operation=contact_search retries=0 exhausted=1').kind, 'network_timeout');
  assert.equal(classifyNameRouteFailure('lark-cli failed: kind=command_unavailable spawn_code=ENOENT operation=contact_search').kind, 'command_unavailable');
});

test('generic failures, private prose and malformed descriptors never imply permission', () => {
  for (const value of ['failed', 'permission denied code=210508', 'request_failed',
    'prefix lark-cli failed: kind=permission_denied',
    'lark-cli failed: permission denied', 'lark-cli failed: kind=unknown permission denied',
    'lark-cli failed: kind=unknown code=210508\nprivate text',
    'lark-cli failed: kind=permission_denied; private text',
    'lark-cli failed: kind=unknown kind=permission_denied',
    'lark-cli failed: kind=unknown code=210508 code=1',
    'lark-cli failed: kind=permission_denied private=message',
    'lark-cli failed: kind=unknown code=9007199254740992',
    'lark-cli failed: kind=unknown code=-1',
    'lark-cli failed: kind=unknown retry_after_ms=NaN',
    'lark-cli failed: kind=made_up', 'x'.repeat(1025),
    { message: 'lark-cli failed: kind=permission_denied' }]) {
    assert.deepEqual(classifyNameRouteFailure(value), { kind: 'unknown', code: null, retryAfterMs: null });
  }
  assert.equal(classifyNameRouteFailure('lark-cli failed: kind=permission_denied operation=application_info', 'contact_search').kind, 'unknown');
});

function transportError(stderr, args = ['contact', '+search-user'], spawnExtras = {}) {
  let attempts = 0;
  const run = createLarkCliRunner({ state: createTransportState(), clock: () => 10_000, monotonicClock: () => 0,
    spawn: () => { attempts++; return { status: 1, stdout: '', stderr, ...spawnExtras }; },
    readSharedCooldown: () => ({ state: 'ready' }), writeSharedCooldown: () => true });
  let error;
  try { run(args, { retries: 0 }); } catch (value) { error = value; }
  assert.ok(error instanceof Error);
  return { error, attempts };
}

test('actual transport producer formats are accepted without remote/private strings', () => {
  const denied = transportError(JSON.stringify({ error: { type: 'api', code: 210508, message: 'synthetic private prose' } }),
    ['api', 'GET', '/open-apis/application/v6/applications/synthetic-app']);
  assert.equal(denied.attempts, 1);
  assert.deepEqual(classifyNameRouteFailure(denied.error, 'application_info'),
    { kind: 'permission_denied', code: 210508, retryAfterMs: null });
  const untyped = transportError(JSON.stringify({ error: { code: 210508, message: 'synthetic private prose' } }),
    ['api', 'GET', '/open-apis/application/v6/applications/synthetic-app']);
  assert.equal(untyped.attempts, 1);
  assert.deepEqual(classifyNameRouteFailure(untyped.error, 'application_info'),
    { kind: 'unknown', code: null, retryAfterMs: null }, 'untyped nested code is not proof of an API refusal');
  const rate = transportError(JSON.stringify({ code: 99991400, headers: { 'x-ogw-ratelimit-reset': '7' } }));
  assert.deepEqual(classifyNameRouteFailure(rate.error, 'contact_search'),
    { kind: 'rate_limited', code: 99991400, retryAfterMs: 7000 });
  const missing = transportError('', ['contact', '+search-user'],
    { status: null, error: Object.assign(new Error('synthetic private executable path'), { code: 'ENOENT' }) });
  assert.equal(classifyNameRouteFailure(missing.error, 'contact_search').kind, 'command_unavailable');
  assert.ok(!JSON.stringify(classifyNameRouteFailure(denied.error)).includes('synthetic'));
});

test('permission and missing-command blocks survive time, traffic, restart and ordinary success', () => {
  for (const kind of ['permission_denied', 'command_unavailable']) {
    const descriptor = route();
    const result = nextNameRouteState(descriptor, null, failure(`lark-cli failed: kind=${kind} operation=contact_search`), at(100));
    assert.equal(result.state, 'blocked'); assert.equal(result.row.blocked, 1);
    assert.equal(result.row.retry_at_ms, 0); assert.equal(result.row.failures, 1);
    for (const event of [{ type: 'success' }, { type: 'deferred' }, failure()]) {
      const copy = JSON.parse(JSON.stringify(result.row));
      const next = nextNameRouteState(route('contact_search', { latest_record_id: 500, chat_id: 'synthetic-chat-new' }), copy, event, at(90_000_000));
      assert.equal(next.changed, false); assert.deepEqual(next.row, result.row); assert.equal(next.state, 'blocked');
    }
  }
});

test('three unknown or transient failures exhaust one episode with a distinct reason', () => {
  for (const error of ['generic failed with private permission prose',
    'lark-cli failed: kind=network_timeout operation=contact_search']) {
    const descriptor = route(); let previous = null;
    for (let index = 1; index <= 3; index++) {
      const next = nextNameRouteState(descriptor, previous, failure(error), at(index * 60_000));
      assert.equal(next.row.failures, index); assert.equal(next.row.generation, index);
      assert.equal(next.row.blocked, 0);
      assert.equal(next.state, index < 3 ? 'retry' : 'exhausted');
      if (index === 3) { assert.equal(next.reason, 'failure_limit'); assert.equal(next.row.retry_at_ms, 0); }
      previous = next.row;
    }
    const exhausted = nextNameRouteState(descriptor, previous, { type: 'success' }, at(1_000_000));
    assert.equal(exhausted.changed, false); assert.equal(exhausted.state, 'exhausted');
  }
});

test('successful page clears a nonterminal failure and only changed rows advance generation', () => {
  const descriptor = route();
  const failed = nextNameRouteState(descriptor, null, failure(), at(10));
  const success = nextNameRouteState(descriptor, failed.row, { type: 'success' }, at(70_000));
  assert.equal(success.state, 'ready'); assert.equal(success.row.failures, 0);
  assert.equal(success.row.failure_kind, null); assert.equal(success.row.failure_code, null);
  assert.equal(success.row.generation, 2); assert.equal(success.row.last_attempt_at_ms, 70_000);
  for (let pages = 0, row = success.row; pages < 10; pages++) {
    row = nextNameRouteState(descriptor, row, { type: 'success' }, at(80_000 + pages)).row;
    assert.equal(row.failures, 0);
  }
});

test('budget and lease deferral create no row and do not consume failed lookup attempts', () => {
  const descriptor = route();
  assert.deepEqual(nextNameRouteState(descriptor, null, { type: 'deferred' }, at(100)),
    { changed: false, state: 'deferred', reason: 'admission_deferred', row: null });
  const failed = nextNameRouteState(descriptor, null, failure(), at(100));
  for (let attempt = 0; attempt < 50; attempt++) {
    const next = nextNameRouteState(descriptor, failed.row,
      { type: 'deferred', error: new Error('lark-cli failed: kind=rate_limited retry_after_source=shared operation=contact_search retry_exhausted=1') }, at(200));
    assert.equal(next.changed, false); assert.deepEqual(next.row, failed.row);
  }
  assert.throws(() => nextNameRouteState(descriptor, failed.row, { type: 'new_message' }, at(200)), /invalid_name_route_state/);
});

test('retry deadlines obey route backoff, header and shared cooldown without overflow', () => {
  const descriptor = route();
  const first = nextNameRouteState(descriptor, null, failure(), at(100));
  assert.equal(first.row.retry_at_ms, 5100);
  const second = nextNameRouteState(descriptor, first.row, failure(), at(60_000));
  assert.equal(second.row.retry_at_ms, 90_000);
  const rate = nextNameRouteState(descriptor, null,
    failure('lark-cli failed: kind=rate_limited retry_after_ms=7000 operation=contact_search'), at(100, 20_000));
  assert.equal(rate.row.retry_at_ms, 20_000);
  const overflow = nextNameRouteState(descriptor, null,
    failure(`lark-cli failed: kind=rate_limited retry_after_ms=${Number.MAX_SAFE_INTEGER} operation=contact_search`), at(100));
  assert.equal(overflow.row.retry_at_ms, Number.MAX_SAFE_INTEGER);
});

test('explicit recovery clears terminal state but retains attempt time and shared cooldown', () => {
  const descriptor = route();
  const blocked = nextNameRouteState(descriptor, null,
    failure('lark-cli failed: kind=permission_denied code=210508 operation=contact_search'), at(100));
  const recovered = nextNameRouteState(descriptor, blocked.row, { type: 'recover' }, at(200, 1000));
  assert.equal(recovered.row.failures, 0); assert.equal(recovered.row.failure_kind, null);
  assert.equal(recovered.row.failure_code, null); assert.equal(recovered.row.blocked, 0);
  assert.equal(recovered.row.generation, blocked.row.generation + 1);
  assert.equal(recovered.row.last_attempt_at_ms, 100); assert.equal(recovered.row.retry_at_ms, 1000);
});

test('account/chat/operation mismatch, corrupt rows and backward clocks cannot yield replacement rows', () => {
  const descriptor = route('chat_members');
  const failed = nextNameRouteState(descriptor, null,
    failure('lark-cli failed: kind=network_timeout operation=chat_members'), at(100));
  for (const changed of [route('chat_members', { account_key: OTHER_ACCOUNT }),
    route('chat_members', { chat_id: 'synthetic-other-chat' }), route('contact_search')])
    assert.throws(() => nextNameRouteState(changed, failed.row, { type: 'success' }, at(200)), /invalid_name_route_state/);
  for (const patch of [{ failures: 4 }, { blocked: 1 }, { failure_kind: 'private prose' },
    { failure_code: -1 }, { generation: Number.MAX_SAFE_INTEGER }, { raw_error: 'private prose' }])
    assert.throws(() => nextNameRouteState(descriptor, { ...failed.row, ...patch }, { type: 'success' }, at(200)), /invalid_name_route_state/);
  assert.throws(() => nextNameRouteState(descriptor, failed.row, { type: 'success' }, at(99)), /invalid_name_route_state/);
});

test('one denied application leaves the exact bot fallback and another app independent', () => {
  const denied = route('application_info', { namespace: 'app_id' });
  const blocked = nextNameRouteState(denied, null,
    failure('lark-cli failed: kind=permission_denied code=210508 operation=application_info'), at(100));
  assert.equal(blocked.state, 'blocked');
  for (const independent of [route('chat_bots', { namespace: 'app_id' }),
    route('application_info', { namespace: 'app_id', actor_id: 'synthetic-app-b' })]) {
    assert.notEqual(independent.route_key, denied.route_key);
    const result = nextNameRouteState(independent, null, { type: 'success' }, at(200));
    assert.equal(result.state, 'ready'); assert.equal(result.row.failures, 0);
  }
});
