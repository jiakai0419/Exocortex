import assert from 'node:assert/strict';
import test from 'node:test';
import { senderIdentity, senderOpenId, displayNameFromUser } from '../src/adapters/lark-im/sender-identity.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { createNameResolver } from '../src/adapters/lark-im/name-resolver.mjs';

// Invented fixtures: no copied messages, people, or production API responses.
const PERSON = 'ou_fixture_paper_cartographer';
const ROOM = 'oc_fixture_paper_workshop';
const OPTIONS = { retries: 0, retryDelayMs: 0 };
const source = (sender = { id: PERSON, id_type: 'open_id', sender_type: 'user' }) => ({
  message_id: 'om_fixture_paper_map', create_time: '2345678912000', update_time: '2345678913000',
  chat_id: ROOM, chat_type: 'group', content: { text: 'Fold a paper map into seven squares.' }, sender,
});
const canonical = (sender, context = {}) => JSON.parse(recordFromMessage(source(sender), 'synthetic.scope', 'received', context).canonical_json);

test('a spelling supplies no network authority; typed source evidence does', () => {
  assert.equal(senderOpenId({ sender: { id: PERSON } }), '');
  assert.equal(senderOpenId({ sender: { id: PERSON, id_type: 'user_id' } }), '');
  assert.equal(senderOpenId({ sender: { id: PERSON, id_type: 'union_id' } }), '');
  assert.equal(senderOpenId({ sender: { id: PERSON, id_type: 'unsupported' } }), '');
  assert.equal(senderOpenId({ sender: { id: PERSON, id_type: 'open_id' } }), PERSON);
  assert.equal(senderOpenId({ sender: { open_id: PERSON } }), PERSON);
  assert.equal(senderOpenId({ raw_api: { sender: { id: PERSON, id_type: 'open_id' } } }), PERSON);
  assert.equal(senderOpenId({ sender: { sender_id: { open_id: PERSON } } }), PERSON);
});

test('contradictory same-namespace identities are unknown; a different namespace alias is allowed', () => {
  const contradictory = { id: PERSON, id_type: 'open_id', open_id: 'ou_fixture_different_cartographer' };
  assert.equal(senderIdentity({ sender: contradictory }).conflict, true);
  assert.equal(senderOpenId({ sender: contradictory }), '');
  assert.deepEqual(senderIdentity({ sender: { id: PERSON, id_type: 'open_id', user_id: 'synthetic_user_alias' } }),
    { id: PERSON, type: 'open_id', verified: true, conflict: false });
  assert.equal(senderIdentity({ sender: { id: PERSON, open_id: PERSON, user_id: PERSON } }).conflict, true);
  assert.equal(senderIdentity({ sender: { id: PERSON, id_type: { type: 'open_id' } } }).conflict, true);
});

test('identity conflicts block direct raw names as well as context names', () => {
  const projected = canonical({ id: PERSON, id_type: 'open_id', open_id: 'ou_fixture_other_mapmaker', name: 'Wrong Mapmaker' }, {
    contacts: new Map([[PERSON, 'Context Mapmaker']]), self: { open_id: PERSON, name: 'Self Mapmaker' },
    apps: new Map([[PERSON, 'Wrong Application']]),
  });
  assert.equal(projected.sender_name, null);
  assert.equal(projected.sender_id_type, 'conflicting');
  const good = canonical({ id: PERSON, id_type: 'open_id', user_id: 'synthetic_user_alias', name: 'Source Mapmaker' });
  assert.equal(good.sender_name, 'Source Mapmaker');
  assert.equal(good.sender_id_type, 'open_id');
});

test('typed users cannot consume open-ID context from equal bytes in another namespace', () => {
  const context = { contacts: new Map([[PERSON, 'Contact Mapmaker']]),
    chat_members: new Map([[`${ROOM}:${PERSON}`, 'Group Mapmaker']]), self: { open_id: PERSON, name: 'Self Mapmaker' } };
  for (const id_type of ['user_id', 'union_id', 'unsupported']) {
    const projected = canonical({ id: PERSON, id_type, sender_type: 'user' }, context);
    assert.equal(projected.sender_name, null, id_type);
    assert.equal(projected.sender_id_type, id_type);
  }
  assert.equal(canonical({ id: PERSON, sender_type: 'user' }, context).sender_name, null);
  assert.equal(canonical({ id: PERSON, name: 'Direct Mapmaker' }, context).sender_name, 'Direct Mapmaker');
  assert.equal(canonical({ id: PERSON, id_type: 'open_id' }, context).sender_name, 'Group Mapmaker');
});

test('self, contact, member, and source ID echoes stay unknown without preventing a valid fallback', () => {
  const sender = { id: PERSON, id_type: 'open_id', name: PERSON };
  for (const name of [undefined, '', '   ', PERSON]) {
    assert.equal(canonical(sender, { self: { open_id: PERSON, name } }).sender_name, null);
    assert.equal(canonical(sender, { contacts: new Map([[PERSON, name]]) }).sender_name, null);
    assert.equal(canonical(sender, { chat_members: new Map([[`${ROOM}:${PERSON}`, { name }]]) }).sender_name, null);
  }
  assert.equal(canonical(sender, { self: { open_id: PERSON, name: 'Self Mapmaker' } }).sender_name, 'Self Mapmaker');
  assert.equal(canonical(sender, { chat_members: new Map([[`${ROOM}:${PERSON}`, PERSON]]),
    contacts: new Map([[PERSON, 'Contact Mapmaker']]) }).sender_name, 'Contact Mapmaker');
});

test('IDless and legacy app behavior remain conservative and compatible', () => {
  assert.equal(canonical({}, { self: { open_id: PERSON, name: 'Self Mapmaker' } }).sender_name, null);
  assert.equal(canonical({ name: 'Source Without ID' }).sender_name, 'Source Without ID');
  const app = 'cli_fixture_paper_printer';
  assert.equal(canonical({ id: app, sender_type: 'app' }, { apps: new Map([[app, 'Paper Printer']]) }).sender_name, 'Paper Printer');
});

test('person normalization accepts localized names and rejects all identifier echoes', () => {
  assert.equal(displayNameFromUser({ open_id: PERSON, name: PERSON }), '');
  assert.equal(displayNameFromUser({ member_id: PERSON, localized_name: PERSON, name: '   ', en_name: 'Mapmaker' }), 'Mapmaker');
  assert.equal(displayNameFromUser({ open_id: PERSON, user_id: 'fixture_user', name: 'fixture_user' }), '');
  assert.equal(displayNameFromUser({ member_id: PERSON, localized_name: '  Local Mapmaker  ' }), 'Local Mapmaker');
});

for (const badNames of [[PERSON], [''], ['Mapmaker A', 'Mapmaker B'], ['Mapmaker B', 'Mapmaker A'], ['Mapmaker A', '', 'Mapmaker A']]) {
  test(`unknown or conflicting contact response is not cached (${JSON.stringify(badNames)})`, () => {
    let attempts = 0;
    const resolver = createNameResolver({ run() {
      attempts += 1;
      return { users: (attempts === 1 ? badNames : ['Recovered Mapmaker']).map((name) => ({ open_id: PERSON, name })) };
    } });
    assert.equal(resolver.resolveContactNames([PERSON], OPTIONS).has(PERSON), false);
    assert.equal(resolver.resolveContactNames([PERSON], OPTIONS).get(PERSON), 'Recovered Mapmaker');
    assert.equal(resolver.resolveContactNames([PERSON], OPTIONS).get(PERSON), 'Recovered Mapmaker');
    assert.equal(attempts, 2);
  });
}

test('an echoed self seed cannot suppress contact or member lookup', () => {
  const operations = [];
  const resolver = createNameResolver({ run(args) {
    operations.push(args[0]);
    return args[0] === 'contact' ? { users: [{ open_id: PERSON, name: PERSON }] }
      : { items: [{ member_id: PERSON, localized_name: 'Member Mapmaker' }], has_more: false };
  } });
  const message = source();
  const context = resolver.buildPeopleContext([message], OPTIONS, { open_id: PERSON, name: PERSON });
  assert.deepEqual(operations, ['contact', 'im']);
  assert.equal(context.contacts.has(PERSON), false);
  assert.equal(context.chat_members.get(`${ROOM}:${PERSON}`), 'Member Mapmaker');
  assert.equal(canonical(message.sender, context).sender_name, 'Member Mapmaker');
});

test('ambiguous member responses are retried and never cached as a successful name', () => {
  let attempts = 0;
  const resolver = createNameResolver({ run() {
    attempts += 1;
    return { items: attempts === 1 ? [{ member_id: PERSON, name: 'Mapmaker A' }, { member_id: PERSON, name: 'Mapmaker B' }]
      : [{ member_id: PERSON, member_id_type: 'open_id', localized_name: 'Recovered Member' }], has_more: false };
  } });
  assert.equal(resolver.resolveChatMemberNames(ROOM, [PERSON], OPTIONS).has(PERSON), false);
  assert.equal(resolver.resolveChatMemberNames(ROOM, [PERSON], OPTIONS).get(PERSON), 'Recovered Member');
  assert.equal(resolver.resolveChatMemberNames(ROOM, [PERSON], OPTIONS).get(PERSON), 'Recovered Member');
  assert.equal(attempts, 2);
});

test('explicitly mismatched member ID types remain unknown and permit later recovery', () => {
  let attempts = 0;
  const resolver = createNameResolver({ run() {
    attempts += 1;
    return { items: [{ member_id: PERSON, member_id_type: attempts === 1 ? 'user_id' : 'open_id', name: 'Typed Member' }], has_more: false };
  } });
  assert.equal(resolver.resolveChatMemberNames(ROOM, [PERSON], OPTIONS).has(PERSON), false);
  assert.equal(resolver.resolveChatMemberNames(ROOM, [PERSON], OPTIONS).get(PERSON), 'Typed Member');
});

test('online sender lookup uses only typed open IDs and successful same-version projection preserves source facts', () => {
  const calls = [];
  const resolver = createNameResolver({ run(args) { calls.push(args); return { users: [{ open_id: PERSON, name: 'Mapmaker' }] }; } });
  for (const sender of [{ id: PERSON }, { id: PERSON, id_type: 'user_id' },
    { id: PERSON, id_type: 'open_id', open_id: 'ou_fixture_other_mapmaker' }]) {
    assert.equal(resolver.buildPeopleContext([source(sender)], OPTIONS, null).contacts.size, 0);
  }
  assert.equal(calls.length, 0);
  const message = source();
  const before = recordFromMessage(message, 'synthetic.scope', 'received');
  const after = recordFromMessage(message, 'synthetic.scope', 'received', resolver.buildPeopleContext([message], OPTIONS, null));
  for (const key of ['raw_json', 'content_hash', 'external_version', 'body']) assert.equal(after[key], before[key], key);
  assert.equal(JSON.parse(before.canonical_json).sender_name, null);
  assert.equal(JSON.parse(after.canonical_json).sender_name, 'Mapmaker');
  assert.equal(calls.length, 1);
});
