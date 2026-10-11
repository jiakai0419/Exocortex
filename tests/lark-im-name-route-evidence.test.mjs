import assert from 'node:assert/strict';
import test from 'node:test';

import { createNameResolver } from '../src/adapters/lark-im/name-resolver.mjs';

// All fixtures are invented here; runners are stubs and never call an API.
const SELF = { open_id: 'ou_synthetic_route_owner', name: 'Synthetic Owner' };
const PERSON = 'ou_synthetic_route_potter';
const OTHER = 'ou_synthetic_route_glazier';
const APP = 'cli_synthetic_route_kiln';
const OTHER_APP = 'cli_synthetic_route_lathe';
const CHAT = 'oc_synthetic_route_studio';
const NAME = '用户2049051';
const ADOPTED = 'Synthetic Adopted Name';
const EPOCH = Date.UTC(2049, 4, 1);
const iso = time => new Date(time).toISOString();
const message = (chatType = 'group') => ({ chat_id: CHAT, chat_type: chatType,
  sender: { id: PERSON, id_type: 'open_id', sender_type: 'user' } });
const member = (id = PERSON, name = NAME) => ({ member_id: id, member_id_type: 'open_id', name });
const params = args => JSON.parse(args[args.indexOf('--params') + 1]);

test('exact verification retains empty contact and exact member evidence with separate original times', () => {
  let time = EPOCH;
  const calls = [];
  const resolver = createNameResolver({ now: () => time, run(args) {
    calls.push(args);
    time += 1000;
    return args[0] === 'contact' ? { data: { users: [] } }
      : { data: { items: [member()], has_more: false } };
  } });
  const source = message(), before = JSON.stringify(source);
  const result = resolver.verifySenderName(source, NAME, SELF);
  assert.equal(result.status, 'same');
  assert.equal(result.adopted_name, NAME);
  assert.deepEqual(result.lookups.map(value => ({ source: value.source, status: value.status,
    reason: value.reason, observed_at: value.observed_at, cached: value.cached })), [
    { source: 'contact', status: 'unresolved', reason: 'empty_result', observed_at: iso(EPOCH + 1000), cached: false },
    { source: 'chat_member', status: 'resolved', reason: 'exact_id_match', observed_at: iso(EPOCH + 2000), cached: false },
  ]);
  assert.equal(result.lookups[0].name, undefined);
  assert.equal(result.lookups[1].name, NAME);
  assert.equal(result.lookups[1].pages_observed, 1);
  assert.deepEqual(result.observation, result.lookups[1]);
  assert.deepEqual(calls.map(args => args[0]), ['contact', 'im']);
  assert.deepEqual(params(calls[1]), { chat_id: CHAT, member_id_type: 'open_id', page_size: 100 });
  assert.equal(JSON.stringify(source), before);

  const retained = structuredClone(result);
  resolver.verifySenderName(source, NAME, SELF);
  assert.deepEqual(result, retained, 'a later verification must not mutate a returned route snapshot');
  assert.equal(calls.length, 4, 'explicit verification bypasses both positive route caches');
});

const contactCases = [
  ['empty_result', 'unresolved', () => ({ users: [] })],
  ['missing_name', 'unresolved', () => ({ users: [{ open_id: PERSON, name: ' ' }] })],
  ['target_not_returned', 'unresolved', () => ({ users: [{ open_id: OTHER, name: 'Synthetic Other' }] })],
  ['malformed_response', 'failed', () => ({ users: {} })],
  ['request_failed', 'failed', () => { throw new Error('Synthetic private failure detail'); }],
  ['page_limit', 'unresolved', () => ({ users: [], has_more: true, page_token: 'synthetic_contact_more' })],
];
for (const [reason, status, response] of contactCases) {
  test(`contact ${reason} remains distinct in an exact read-only report`, () => {
    let calls = 0;
    const resolver = createNameResolver({ now: () => EPOCH, run() { calls++; return response(); } });
    const result = resolver.verifySenderName(message('p2p'), ADOPTED, SELF);
    assert.equal(calls, 1);
    assert.equal(result.status, status);
    assert.equal(result.adopted_name, ADOPTED);
    assert.equal(result.lookups.length, 1);
    assert.equal(result.lookups[0].source, 'contact');
    assert.equal(result.lookups[0].reason, reason);
    assert.equal(result.lookups[0].status, status);
    assert.equal(result.lookups[0].observed_at, iso(EPOCH));
    assert.equal(result.lookups[0].name, undefined);
    assert.equal(JSON.stringify(result).includes('Synthetic private failure detail'), false);
    assert.equal(JSON.stringify(result).includes(OTHER), false, 'unrelated returned identities are not report payload');
  });
}

const memberCases = [
  ['empty_result', 'unresolved', 1, () => ({ items: [], has_more: false })],
  ['missing_name', 'unresolved', 1, () => ({ items: [member(PERSON, '')], has_more: false })],
  ['target_not_returned', 'unresolved', 1, () => ({ items: [member(OTHER)], has_more: false })],
  ['malformed_response', 'failed', 0, () => ({ items: 'not-an-array' })],
  ['request_failed', 'failed', 0, () => { throw new Error('Synthetic private member detail'); }],
];
for (const [reason, status, pages, response] of memberCases) {
  test(`member route distinguishes ${reason} and its completed page count`, () => {
    let calls = 0;
    const resolver = createNameResolver({ now: () => EPOCH, run() { calls++; return response(); } });
    assert.equal(resolver.resolveChatMemberNames(CHAT, [PERSON], {}).size, 0);
    const result = resolver.senderNameObservation(PERSON, CHAT, 'open_id');
    assert.equal(calls, 1);
    assert.equal(result.source, 'chat_member');
    assert.equal(result.reason, reason);
    assert.equal(result.status, status);
    assert.equal(result.pages_observed, pages);
    assert.equal(result.name, undefined);
    assert.equal(JSON.stringify(result).includes('Synthetic private member detail'), false);
  });
}

for (const [reason, status, response] of [
  ['empty_result', 'unresolved', () => ({ items: [] })],
  ['missing_name', 'unresolved', () => ({ items: [{ app_id: APP, bot_name: ' ' }] })],
  ['target_not_returned', 'unresolved', () => ({ items: [{ app_id: OTHER_APP, bot_name: 'Synthetic Other Bot' }] })],
  ['malformed_response', 'failed', () => ({ data: {} })],
  ['request_failed', 'failed', () => { throw new Error('Synthetic private bot detail'); }],
]) {
  test(`exact bot route distinguishes ${reason} without adopting a candidate`, () => {
    const resolver = createNameResolver({ now: () => EPOCH, run: () => response() });
    const names = resolver.resolveChatBotAppFallbackNames(new Map([[CHAT, new Set([APP])]]), new Map(), {});
    assert.equal(names.size, 0);
    const result = resolver.senderNameObservation(APP, CHAT, 'app_id');
    assert.equal(result.source, 'chat_bot_app_id');
    assert.equal(result.status, status);
    assert.equal(result.reason, reason);
    assert.equal(result.name, undefined);
    assert.equal(JSON.stringify(result).includes('Synthetic private bot detail'), false);
  });
}

for (const [label, options, response, expectedPages, reason] of [
  ['default two-page bound', {}, page => ({ items: [], has_more: true, page_token: `synthetic_page_${page}` }), 2, 'page_limit'],
  ['caller cannot expand the two-page bound', { memberPageLimit: 20 }, page => ({ items: [], has_more: true, page_token: `synthetic_page_${page}` }), 2, 'page_limit'],
  ['caller may tighten to one page', { memberPageLimit: 1 }, page => ({ items: [], has_more: true, page_token: `synthetic_page_${page}` }), 1, 'page_limit'],
  ['repeated page token', {}, () => ({ items: [], has_more: true, page_token: 'synthetic_cycle' }), 2, 'pagination_cycle'],
  ['has_more without a token', {}, () => ({ items: [], has_more: true }), 1, 'missing_page_token'],
  ['normal end is not a page-limit stop', { memberPageLimit: 1 }, () => ({ items: [], has_more: false, page_token: 'synthetic_unused' }), 1, 'empty_result'],
]) {
  test(`explicit verification reports ${label}`, () => {
    let pages = 0;
    const calls = [];
    const resolver = createNameResolver({ run(args, opts) {
      calls.push({ args, opts });
      return args[0] === 'contact' ? { users: [] } : response(++pages);
    } });
    const result = resolver.verifySenderName(message(), ADOPTED, SELF, options);
    assert.equal(pages, expectedPages);
    assert.equal(calls.length, expectedPages + 1);
    assert.equal(result.status, 'unresolved');
    assert.equal(result.adopted_name, ADOPTED);
    assert.equal(result.lookups.length, 2, 'pages update one bounded member-route observation');
    assert.equal(result.lookups[0].reason, 'empty_result');
    assert.equal(result.lookups[1].source, 'chat_member');
    assert.equal(result.lookups[1].reason, reason);
    assert.equal(result.lookups[1].pages_observed, expectedPages);
    for (const { opts } of calls) {
      assert.equal(opts.retries, 0);
      assert.ok(opts.timeoutMs > 0 && opts.timeoutMs <= 5000);
      assert.equal(opts.timeoutMs, opts.retryBudgetMs);
    }
    assert.equal(params(calls[1].args).page_token, undefined);
    if (pages > 1) assert.equal(params(calls[2].args).page_token,
      reason === 'pagination_cycle' ? 'synthetic_cycle' : 'synthetic_page_1');
  });
}

for (const mode of ['found', 'page_limit', 'request_failed', 'malformed_response']) {
  test(`looking for a second member (${mode}) does not redate the first member's success`, () => {
    let time = EPOCH, calls = 0;
    const resolver = createNameResolver({ now: () => time, run() {
      calls++;
      time = EPOCH + calls * 1000;
      if (calls === 1) return { items: [member()], has_more: true, page_token: 'synthetic_next' };
      if (mode === 'request_failed') throw new Error('Synthetic second-page failure');
      if (mode === 'malformed_response') return { items: null };
      if (mode === 'found') return { items: [member(OTHER, 'Synthetic Glazier')], has_more: false };
      return { items: [], has_more: true, page_token: 'synthetic_after_limit' };
    } });
    const names = resolver.resolveChatMemberNames(CHAT, [PERSON, OTHER], { memberPageLimit: 2 });
    assert.equal(calls, 2);
    assert.equal(names.get(PERSON), NAME);
    const first = resolver.senderNameObservation(PERSON, CHAT, 'open_id');
    assert.equal(first.status, 'resolved');
    assert.equal(first.reason, 'exact_id_match');
    assert.equal(first.observed_at, iso(EPOCH + 1000));
    assert.equal(first.pages_observed, 1);
    const second = resolver.senderNameObservation(OTHER, CHAT, 'open_id');
    assert.equal(second.status, mode === 'found' ? 'resolved' : mode === 'page_limit' ? 'unresolved' : 'failed');
    assert.equal(second.reason, mode === 'found' ? 'exact_id_match' : mode);
    assert.equal(second.observed_at, iso(EPOCH + 2000));
    assert.equal(second.pages_observed, mode === 'request_failed' || mode === 'malformed_response' ? 1 : 2);
    assert.equal(names.has(OTHER), mode === 'found');

    time += 1000;
    assert.equal(resolver.resolveChatMemberNames(CHAT, [PERSON], {}).get(PERSON), NAME);
    const cached = resolver.senderNameObservation(PERSON, CHAT, 'open_id');
    assert.equal(calls, 2);
    assert.equal(cached.cached, true);
    assert.equal(cached.observed_at, first.observed_at);
    assert.equal(cached.reason, 'exact_id_match');
  });
}

for (const [label, id, namespace, lookup, response] of [
  ['contact', PERSON, 'open_id', resolver => resolver.resolveContactNames([PERSON], {}), { users: [{ open_id: PERSON, name: NAME }] }],
  ['application', APP, 'app_id', resolver => resolver.resolveApplicationNames([APP], {}), { app: { app_id: APP, app_name: NAME } }],
]) {
  test(`${label} cache retains the successful route time, while expiry permits a fresh observation`, () => {
    let time = EPOCH, calls = 0;
    const resolver = createNameResolver({ now: () => time, run() { calls++; return response; } });
    assert.equal(lookup(resolver).get(id), NAME);
    const first = resolver.senderNameObservation(id, CHAT, namespace);
    time += 299_999;
    assert.equal(lookup(resolver).get(id), NAME);
    const cached = resolver.senderNameObservation(id, CHAT, namespace);
    assert.equal(calls, 1);
    assert.equal(cached.cached, true);
    assert.equal(cached.observed_at, first.observed_at);
    assert.equal(cached.reason, 'exact_id_match');
    time++;
    lookup(resolver);
    const refreshed = resolver.senderNameObservation(id, CHAT, namespace);
    assert.equal(calls, 2);
    assert.equal(refreshed.cached, false);
    assert.equal(refreshed.observed_at, iso(time));
  });
}

for (const input of [message('p2p'), message(), {
  chat_id: CHAT, sender: { id: APP, id_type: 'app_id', sender_type: 'app' },
}]) {
  test(`expired verification budget never reports an unmade ${input.sender.id_type}/${input.chat_type || 'app'} request as failure`, () => {
    const resolver = createNameResolver({ run() { assert.fail('expired budget must make zero requests'); } });
    const result = resolver.verifySenderName(input, ADOPTED, SELF, { nameLookupDeadlineMs: Date.now() - 1 });
    assert.equal(result.status, 'failed');
    assert.equal(result.adopted_name, ADOPTED);
    assert.equal(result.lookups.length, input.chat_type === 'p2p' ? 1 : 2);
    assert.ok(result.lookups.every(value => value.reason === 'budget_exhausted' && value.status === 'failed'));
  });
}

test('repeated missing names are missing evidence, not contradictory nonempty names', () => {
  const resolver = createNameResolver({ run: args => args[0] === 'contact'
    ? { users: [{ open_id: PERSON, name: '' }, { open_id: PERSON, name: ' ' }] }
    : { items: [member(PERSON, ''), member(PERSON, ' ')], has_more: false } });
  const result = resolver.verifySenderName(message(), ADOPTED, SELF);
  assert.equal(result.status, 'unresolved');
  assert.deepEqual(result.lookups.map(value => value.reason), ['missing_name', 'missing_name']);
});
