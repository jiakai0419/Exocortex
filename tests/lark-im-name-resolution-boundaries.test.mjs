import assert from 'node:assert/strict';
import test from 'node:test';

import { createNameResolver } from '../src/adapters/lark-im/name-resolver.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';

// Entirely synthetic identities, names and response bodies. No captured data.
const SELF = { open_id: 'ou_synthetic_boundary_owner', name: 'Synthetic Owner' };
const PERSON = 'ou_synthetic_boundary_weaver';
const OTHER_PERSON = 'ou_synthetic_boundary_baker';
const APP = 'cli_synthetic_boundary_loom';
const OTHER_APP = 'cli_synthetic_boundary_oven';
const CHAT = 'oc_synthetic_boundary_workshop';
const ADOPTED = 'Synthetic Previously Adopted';
const CANDIDATE = 'Synthetic Current Candidate';
const userMessage = (sender = {}) => ({
  chat_id: CHAT, chat_type: 'group',
  sender: { id: PERSON, id_type: 'open_id', sender_type: 'user', ...sender },
});
const appMessage = (sender = {}) => userMessage({ id: APP, id_type: 'app_id', sender_type: 'app', ...sender });

for (const [label, input] of [
  ['app sender with a person namespace', userMessage({ sender_type: 'app' })],
  ['user sender with an application namespace', appMessage({ sender_type: 'user' })],
]) {
  test(`explicit verification rejects ${label} before any lookup`, () => {
    const calls = [];
    const resolver = createNameResolver({ run(args) {
      calls.push(args);
      return args[0] === 'contact'
        ? { users: [{ open_id: PERSON, name: CANDIDATE }] }
        : { app: { app_id: APP, app_name: CANDIDATE } };
    } });
    const before = JSON.stringify(input);
    const result = resolver.verifySenderName(input, ADOPTED, SELF);
    assert.equal(result.status, 'conflict');
    assert.equal(result.adopted_name, ADOPTED);
    assert.equal(result.observation, null);
    assert.deepEqual(calls, []);
    assert.equal(JSON.stringify(input), before);
  });
}

test('an exact member_id cannot overrule a contradictory explicit open_id', () => {
  const calls = [];
  const resolver = createNameResolver({ run(args) {
    calls.push(args[0]);
    return args[0] === 'contact' ? { users: [] } : {
      items: [{ member_id: PERSON, member_id_type: 'open_id', open_id: OTHER_PERSON, name: CANDIDATE }],
      has_more: false,
    };
  } });
  const result = resolver.verifySenderName(userMessage(), ADOPTED, SELF);
  assert.equal(result.status, 'conflict');
  assert.equal(result.adopted_name, ADOPTED);
  assert.equal(result.observation?.status, 'conflict');
  assert.equal(result.observation?.name, undefined);
  assert.deepEqual(calls, ['contact', 'im']);
});

for (const item of [
  { app_id: APP, application_id: OTHER_APP, bot_name: CANDIDATE },
  { app_id: OTHER_APP, application_id: APP, bot_name: CANDIDATE },
]) {
  test(`conflicting bot app aliases cannot resolve the ${item.app_id === APP ? 'first' : 'second'} alias`, () => {
    const resolver = createNameResolver({ run: args => args[0] === 'api'
      ? { app: { app_id: APP, app_name: '' } }
      : { items: [item] } });
    const result = resolver.verifySenderName(appMessage(), ADOPTED, SELF);
    assert.equal(result.status, 'conflict');
    assert.equal(result.adopted_name, ADOPTED);
    assert.equal(result.observation?.status, 'conflict');
    assert.equal(result.observation?.name, undefined);
  });
}

for (const badName of ['', '   ', APP]) {
  for (const reverse of [false, true]) {
    test(`duplicate exact bot rows retain ${JSON.stringify(badName)} evidence (${reverse ? 'bad first' : 'good first'})`, () => {
      const items = [
        { app_id: APP, bot_name: CANDIDATE },
        { app_id: APP, bot_name: badName },
      ];
      if (reverse) items.reverse();
      const resolver = createNameResolver({ run: () => ({ items }) });
      const names = resolver.resolveChatBotAppFallbackNames(new Map([[CHAT, new Set([APP])]]), new Map(), {});
      assert.equal(names.size, 0, 'a filtered invalid row must not turn contradictory exact evidence into success');
      const observation = resolver.senderNameObservation(APP, CHAT, 'app_id');
      assert.equal(observation?.status, 'conflict');
      assert.equal(observation?.name, undefined);
    });
  }
}

for (const alias of ['app_id', 'application_id', 'bot_app_id', 'cli_id']) {
  test(`unique bot inference cannot borrow a bot explicitly bound by ${alias} to another app`, () => {
    const resolver = createNameResolver({ run: () => ({ items: [{ [alias]: OTHER_APP, bot_name: CANDIDATE }] }) });
    const names = resolver.resolveChatBotAppFallbackNames(new Map([[CHAT, new Set([APP])]]), new Map(), {});
    assert.equal(names.size, 0);
    assert.equal(resolver.senderNameObservation(APP, CHAT, 'app_id')?.status, 'unresolved');
  });
}

test('an unbound unique bot supplies neither a display name nor exact verification', () => {
  const calls = [];
  const resolver = createNameResolver({ run(args) {
    calls.push(args[0]);
    return args[0] === 'api' ? { app: { app_id: APP, app_name: '' } }
      : { items: [{ bot_name: CANDIDATE }] };
  } });
  const names = resolver.resolveChatBotAppFallbackNames(new Map([[CHAT, new Set([APP])]]), new Map(), {});
  assert.equal(names.size, 0);
  const report = resolver.verifySenderName(appMessage(), ADOPTED, SELF);
  assert.equal(report.status, 'unresolved');
  assert.equal(report.adopted_name, ADOPTED);
  assert.equal(report.observation?.name, undefined);
  assert.deepEqual(calls, ['im', 'api', 'im']);
});

test('consistent exact identities still resolve default-looking names without rewriting them', () => {
  const name = '用户2049067';
  const resolver = createNameResolver({ run: args => args[0] === 'contact'
    ? { users: [] }
    : { items: [{ member_id: PERSON, member_id_type: 'open_id', open_id: PERSON, name }], has_more: false } });
  const result = resolver.verifySenderName(userMessage(), name, SELF);
  assert.equal(result.status, 'same');
  assert.equal(result.observation?.name, name);
  assert.equal(result.observation?.source, 'chat_member');
  assert.equal(result.observation?.cached, false);
});

test('native actor kind wins over a normalized wrapper before explicit verification', () => {
  const native = userMessage({ sender_type: 'app' });
  const wrapper = { ...userMessage(), raw_api: native };
  const resolver = createNameResolver({ run() { assert.fail('contradictory native actor must make no request'); } });
  assert.equal(resolver.verifySenderName(wrapper, ADOPTED, SELF).status, 'conflict');
});

for (const kind of ['user', 'app']) {
  test(`mixed batch cannot lend a ${kind} lookup or observation to a contradictory actor kind`, () => {
    const valid = kind === 'user' ? userMessage() : appMessage();
    const invalid = { ...valid, sender: { ...valid.sender, sender_type: kind === 'user' ? 'app' : 'user' } };
    const calls = [];
    const resolver = createNameResolver({ run(args) {
      calls.push(args[0]);
      return kind === 'user' ? { users: [{ open_id: PERSON, name: CANDIDATE }] }
        : { app: { app_id: APP, app_name: CANDIDATE } };
    } });
    const context = resolver.buildPeopleContext([valid, invalid], {}, SELF);
    const project = input => JSON.parse(recordFromMessage({
      ...input, message_id: 'om_synthetic_boundary_sample', msg_type: 'text',
      create_time: '2500000000000', content: { text: 'Synthetic weaving notes.' },
    }, 'synthetic.scope', 'received', context).canonical_json);
    assert.equal(project(valid).sender_name, CANDIDATE);
    assert.equal(project(valid).sender_name_verification.status, 'resolved');
    assert.equal(project(invalid).sender_name, null);
    assert.equal(project(invalid).sender_name_verification, undefined);
    assert.deepEqual(calls, [kind === 'user' ? 'contact' : 'api']);
  });
}
