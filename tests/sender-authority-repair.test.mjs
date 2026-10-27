import assert from 'node:assert/strict';
import test from 'node:test';
import { senderNeedsAuthorityRepair } from '../src/adapters/lark-im/sender-authority-repair.mjs';
import { senderIdentity } from '../src/adapters/lark-im/sender-identity.mjs';

const ACCOUNT = 'a'.repeat(64), FOREIGN = 'b'.repeat(64);
function target(changes = {}, { namespace = 'open_id', sourceName, rawState, wrapped = false } = {}) {
  const sender = { id: namespace === 'app_id' ? 'cli_synthetic_authority_app' : 'ou_synthetic_authority_person',
    id_type: namespace, sender_type: namespace === 'app_id' ? 'app' : 'user',
    ...(sourceName ? { name: sourceName } : {}), ...(rawState ? { name_state: rawState } : {}) };
  const source = { sender }, raw = wrapped ? { raw_api: source } : source;
  const identity = senderIdentity(raw);
  return { raw, identity, namespace, canonical: {
    sender_id: sender.id, sender_id_type: namespace, sender_name: 'Synthetic Adopted Name',
    sender_name_source: namespace === 'app_id' ? 'application_api' : 'contact',
    sender_name_confidence: 'high', sender_name_account_key: ACCOUNT, ...changes } };
}

test('nonempty unproven names and unknown names require the same repair as old guesses', () => {
  for (const changes of [
    { sender_name: null }, { sender_name: 'ou_synthetic_authority_person' },
    { sender_name_account_key: undefined }, { sender_name_account_key: null },
    { sender_name_account_key: undefined, chat_name_account_key: ACCOUNT },
    { sender_name_confidence: 'low' }, { sender_name_source: 'message_sender' },
    { sender_name_source: 'chat_bot_unique' }, { sender_name_source: null },
    { sender_name_source: 'local_history', sender_name_authority_source: 'chat_bot_unique' },
  ]) assert.equal(senderNeedsAuthorityRepair(target(changes), ACCOUNT), true, JSON.stringify(changes));
});

test('only namespace-compatible high-confidence same-account adoption skips repair', () => {
  for (const [namespace, authorities] of [['open_id', ['contact', 'chat_member', 'self']],
    ['app_id', ['application_api', 'chat_bot_app_id']]]) {
    for (const authority of authorities) {
      assert.equal(senderNeedsAuthorityRepair(target({ sender_name_source: authority }, { namespace }), ACCOUNT), false);
      assert.equal(senderNeedsAuthorityRepair(target({ sender_name_source: 'local_history',
        sender_name_authority_source: authority }, { namespace }), ACCOUNT), false);
    }
  }
  assert.equal(senderNeedsAuthorityRepair(target({ sender_name_source: 'application_api' }), ACCOUNT), true);
  assert.equal(senderNeedsAuthorityRepair(target({ sender_name_source: 'contact' }, { namespace: 'app_id' }), ACCOUNT), true);
  assert.equal(senderNeedsAuthorityRepair(target({ sender_name: '1234' }), ACCOUNT), false, 'numeric display names remain names');
});

test('latest lookup failure does not erase adoption, while explicit foreign markers and conflicts are not repair grants', () => {
  for (const status of ['failed', 'unresolved']) assert.equal(senderNeedsAuthorityRepair(target({
    sender_name_verification: { status, source: 'contact', account_key: ACCOUNT } }), ACCOUNT), false);
  for (const changes of [{ sender_name_account_key: FOREIGN }, { chat_name_account_key: FOREIGN },
    { sender_name_verification: { account_key: FOREIGN } }, { sender_name_verification: { status: 'conflict' } },
    { sender_name_account_key: '' }, { sender_name_state: 'cleared' }]) {
    assert.equal(senderNeedsAuthorityRepair(target({ sender_name_confidence: 'low', ...changes }), ACCOUNT), false);
  }
  for (const wrapped of [false, true]) assert.equal(senderNeedsAuthorityRepair(target(
    { sender_name_account_key: undefined }, { rawState: 'cleared', wrapped }), ACCOUNT), false);
});

test('any valid exact native sender name avoids a remote repair even with a different legacy projection', () => {
  for (const wrapped of [false, true]) {
    for (const sender_name of [null, 'Synthetic Native', 'Different Synthetic Legacy']) {
      assert.equal(senderNeedsAuthorityRepair(target({ sender_name, sender_name_account_key: undefined },
        { sourceName: 'Synthetic Native', wrapped }), ACCOUNT), false);
    }
  }
  assert.equal(senderNeedsAuthorityRepair(target({ sender_name_account_key: undefined },
    { sourceName: 'ou_synthetic_authority_person' }), ACCOUNT), true, 'an ID echo is not a native name');
});

test('invalid or contradictory typed targets never grant remote repair', () => {
  for (const value of [null, undefined, {}, { ...target(), namespace: 'user_id' },
    { ...target(), identity: { ...target().identity, verified: false } },
    { ...target(), identity: { ...target().identity, conflict: true } },
    target({ sender_id: 'ou_synthetic_different' }), target({ sender_id_type: 'app_id' })]) {
    assert.equal(senderNeedsAuthorityRepair(value, ACCOUNT), false);
  }
  for (const key of ['', FOREIGN, 'invalid']) assert.equal(senderNeedsAuthorityRepair(target(), key), false);
});
