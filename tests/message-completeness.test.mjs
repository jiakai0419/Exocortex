import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateMessageCompleteness, MESSAGE_COMPLETENESS_REASONS } from '../src/adapters/lark-im/message-completeness.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';

// All identities and payloads are authored. No DB, filesystem, API or clock is
// consulted by these tests or the evaluator.
const SELF = 'ou_synthetic_completeness_self', ACCOUNT = recipientAccountKey(SELF);
const AT = Date.UTC(2049, 2, 14, 12), ID = 'ou_synthetic_completeness_actor';
function fixture({ type = 'group', direction = 'received', actorType = 'open_id' } = {}) {
  const actor = actorType === 'app_id' ? 'cli_synthetic_completeness_app' : ID;
  const name = actorType === 'app_id' ? 'Invented Courier' : 'Invented Rowan';
  const raw = { message_id: 'om_synthetic_completeness', chat_id: 'oc_synthetic_completeness',
    chat_type: type, chat_name: 'Invented Observatory', msg_type: 'text', create_time: String(AT),
    sender: { id: actor, id_type: actorType, sender_type: actorType === 'app_id' ? 'app' : 'user', name },
    body: { content: JSON.stringify({ text: 'Entirely invented prose.' }) } };
  return { row: { source_id: 'lark.im', record_type: 'lark.im.message', external_id: raw.message_id,
    container_id: raw.chat_id, actor_id: actor, direction, occurred_at_ms: AT, body: 'Entirely invented prose.' },
  raw, canonical: { message_id: raw.message_id, chat_id: raw.chat_id, chat_type: type,
    chat_name: raw.chat_name, chat_name_source: 'message', sender_id: actor, sender_id_type: actorType,
    sender_name: name, sender_name_source: 'message_sender', msg_type: 'text' },
  display: { sender: name, chat: raw.chat_name, body: 'Entirely invented prose.' },
  evidence: { prepared: true, account: { state: 'unknown' },
    sender: { id: actor, id_type: actorType, name, source: 'message_sender' },
    conversation: { id: raw.chat_id, type, title: { value: raw.chat_name, source: 'message' } },
    content: { state: 'complete', source: 'renderer' }, blockers: [] } };
}
const adopted = f => {
  delete f.raw.sender.name;
  f.evidence.account = { state: 'verified', account_key: ACCOUNT };
  f.evidence.sender.account_key = ACCOUNT;
  f.evidence.sender.source = f.raw.sender.id_type === 'app_id' ? 'application_api' : 'contact';
  f.canonical.sender_name_source = f.evidence.sender.source;
  f.canonical.sender_name_confidence = 'high';
  f.canonical.sender_name_account_key = ACCOUNT;
  return f;
};
function ownRecipient(f) {
  f.evidence.account = { state: 'verified', account_key: ACCOUNT };
  f.evidence.recipient = { is_self: true, name: '我', source: 'account_self', relationship_source: 'admitted_account' };
  return f;
}
function peerRecipient(f, namespace = 'open_id') {
  // Same open-looking bytes deliberately exercise all three explicit namespaces.
  const peer = { id: 'ou_synthetic_peer_bytes', id_type: namespace, name: 'Invented Juniper' };
  f.raw.chat_partner = { ...peer };
  f.canonical.chat_partner = { ...peer };
  f.evidence.recipient = { ...peer, source: 'message_partner', relationship_source: 'message_partner' };
  return f;
}
function result(f, state, reason) {
  const value = evaluateMessageCompleteness(f);
  assert.equal(value.state, state, JSON.stringify(value));
  if (reason) assert(value.reasons.includes(reason), JSON.stringify(value));
  assert.deepEqual(value.requirements.map(item => item.field), ['sender', 'recipient', 'conversation', 'content']);
  assert.equal(new Set(value.reasons).size, value.reasons.length);
  assert(value.reasons.every(value => MESSAGE_COMPLETENESS_REASONS.includes(value)));
  return value;
}

test('source-bound group and topic are ready without own-account disclosure or individual recipient', () => {
  for (const type of ['group', 'topic']) for (const direction of ['sent', 'received']) {
    const r = result(fixture({ type, direction }), 'ready');
    assert.equal(r.requirements[1].state, 'not_applicable');
    assert.equal(r.next_action, 'none');
  }
});

test('nonempty labels and familiar ID prefixes never establish sender identity', () => {
  const f = fixture(); delete f.raw.sender.id_type;
  result(f, 'enriching', 'sender_identity_unknown');
  delete f.canonical.sender_id_type;
  f.evidence.sender.id_type = 'open_id';
  result(f, 'enriching', 'sender_identity_unknown');
});

test('explicit actor and namespace contradictions block despite a plausible name', () => {
  for (const change of [f => { f.row.actor_id = 'another_actor'; },
    f => { f.raw.sender.open_id = 'another_actor'; },
    f => { f.canonical.sender_id_type = 'union_id'; },
    f => { f.evidence.sender.id_type = 'union_id'; },
    f => { f.canonical.sender_type = 'app'; }]) {
    const f = fixture(); change(f); result(f, 'blocked', 'sender_identity_conflict');
  }
});

test('wrapper actor kind cannot contradict the same typed native actor', () => {
  const f = fixture(); const native = structuredClone(f.raw);
  f.raw = { ...f.raw, raw_api: native, sender: { ...native.sender, sender_type: 'app' } };
  result(f, 'blocked', 'sender_identity_conflict');
});

test('direct names are bound to source; numeric-looking names are valid and ID echoes are missing', () => {
  const f = fixture(); f.evidence.sender.name = 'Unproven Nonempty Label';
  result(f, 'enriching', 'sender_name_unverified');
  f.raw.sender.name = f.evidence.sender.name = '12345'; result(f, 'ready');
  f.raw.sender.name = f.evidence.sender.name = ID; result(f, 'enriching', 'sender_name_missing');
  f.raw.sender.name = f.evidence.sender.name = '  '; result(f, 'enriching', 'sender_name_missing');
});

test('adopted exact names survive failed latest lookups but require compatible account evidence', () => {
  const f = adopted(fixture());
  f.canonical.sender_name_verification = { status: 'failed', reason: 'request_failed', source: 'contact' };
  f.evidence.latest_lookup = { state: 'failed', reason: 'request_failed' };
  result(f, 'ready');
  f.evidence.account = { state: 'unknown' }; result(f, 'enriching', 'account_unknown');
  f.evidence.account = { state: 'verified', account_key: 'a'.repeat(64) };
  result(f, 'blocked', 'account_conflict');
});

test('non-native sender adoption cannot borrow a conversation-only account binding', () => {
  for (const value of [undefined, null, '', 'invalid-key']) {
    const f = adopted(fixture());
    f.evidence.sender.account_key = value;
    f.canonical.chat_name_account_key = ACCOUNT;
    delete f.canonical.sender_name_account_key;
    result(f, 'enriching', 'sender_name_unverified');
  }
  const f = adopted(fixture()); f.evidence.sender.account_key = 'b'.repeat(64);
  result(f, 'blocked', 'account_conflict');
});

test('typed app direct/exact names are ready; a nonempty old sole-bot guess is not authority', () => {
  const f = fixture({ actorType: 'app_id' }); result(f, 'ready');
  adopted(f); result(f, 'ready');
  f.evidence.sender.source = 'chat_bot_unique'; f.canonical.sender_name_source = 'chat_bot_unique';
  result(f, 'enriching', 'sender_name_unverified');
  f.evidence.sender.source = 'chat_bot_app_id'; f.evidence.sender.confidence = 'high'; result(f, 'ready');
  f.evidence.sender.source = 'contact'; result(f, 'enriching', 'sender_name_unverified');
});

test('local history retains its underlying namespace-specific authority', () => {
  const f = adopted(fixture()); f.evidence.sender.source = 'local_history';
  f.evidence.sender.confidence = 'high';
  result(f, 'enriching', 'sender_name_unverified');
  f.evidence.sender.authority_source = 'chat_member'; result(f, 'ready');
  f.evidence.sender.authority_source = 'application_api'; result(f, 'enriching', 'sender_name_unverified');
});

test('missing, low or medium adopted confidence is not laundered by an authority source label', () => {
  const f = adopted(fixture());
  for (const confidence of [undefined, null, 'low', 'medium', '']) {
    f.canonical.sender_name_confidence = confidence;
    result(f, 'enriching', 'sender_name_unverified');
  }
  f.evidence.sender.confidence = 'high';
  result(f, 'ready'); // A separately validated exact observation can supersede old weak adoption.
});

test('a local mapping source label alone is not an independently verified mapping envelope', () => {
  const f = fixture({ actorType: 'app_id' }); delete f.raw.sender.name;
  f.evidence.sender.source = 'local_chat_app_name'; result(f, 'enriching', 'sender_name_unverified');
  f.evidence.sender.id = 'cli_another_synthetic_app'; result(f, 'blocked', 'sender_identity_conflict');
});

test('explicit clears block source and fallback names without mutation or resurrection', () => {
  for (const field of ['sender', 'conversation', 'recipient']) {
    const f = field === 'recipient' ? peerRecipient(fixture({ type: 'p2p', direction: 'sent' })) : fixture();
    if (field === 'sender') f.canonical.sender_name_state = 'cleared';
    if (field === 'conversation') f.raw.chat_name_state = 'cleared';
    if (field === 'recipient') f.canonical.chat_partner.name_state = 'cleared';
    const r = result(f, 'blocked', 'name_explicitly_cleared');
    assert.equal(r.requirements.find(item => item.field === field).state, 'blocked');
  }
});

test('received p2p accepts an admitted account hash without inventing a self ID', () => {
  const f = ownRecipient(fixture({ type: 'p2p' })); result(f, 'ready');
  assert.equal(Object.hasOwn(f.evidence.recipient, 'id'), false);
  f.evidence.account.account_key = 'not-a-hash'; result(f, 'enriching', 'account_unknown');
  f.evidence.account.account_key = ACCOUNT;
  f.evidence.recipient.id = 'ou_synthetic_other_self'; f.evidence.recipient.id_type = 'open_id';
  result(f, 'blocked', 'recipient_identity_conflict');
});

test('received display 我 does not independently establish the recipient relationship', () => {
  const f = fixture({ type: 'p2p' }); f.display.recipient = '我'; result(f, 'enriching', 'account_unknown');
  f.evidence.account = { state: 'verified', account_key: ACCOUNT };
  result(f, 'enriching', 'recipient_identity_unknown');
});

test('sent private partners preserve all explicit person namespaces without prefix guessing', () => {
  for (const namespace of ['open_id', 'user_id', 'union_id']) {
    const f = peerRecipient(fixture({ type: 'p2p', direction: 'sent' }), namespace); result(f, 'ready');
    f.evidence.recipient.id_type = namespace === 'union_id' ? 'user_id' : 'union_id';
    result(f, 'blocked', 'recipient_identity_conflict');
  }
});

test('official private relationship requires exact open namespace and an admitted account', () => {
  const f = fixture({ type: 'p2p', direction: 'sent' });
  f.evidence.recipient = { id: 'ou_synthetic_peer', id_type: 'open_id', name: 'Invented Peer',
    source: 'contact', relationship_source: 'im.v1.chats.batch_query' };
  result(f, 'enriching', 'account_unknown');
  f.evidence.account = { state: 'verified', account_key: ACCOUNT }; result(f, 'ready');
  f.evidence.recipient.id_type = 'union_id'; result(f, 'blocked', 'recipient_identity_conflict');
});

test('legacy malformed canonical partner does not override an explicit native user namespace', () => {
  const f = peerRecipient(fixture({ type: 'p2p', direction: 'sent' }), 'user_id');
  f.raw.chat_partner.id = f.evidence.recipient.id = 'synthetic_user_without_open_prefix';
  f.canonical.chat_partner = { open_id: 'synthetic_user_without_open_prefix', name: 'Invented Juniper' };
  result(f, 'ready');
});

test('normalized exact recipient conflicts and scope clears cannot be lost as generic absence', () => {
  const f = fixture({ type: 'p2p', direction: 'sent' });
  f.evidence.recipient = { reason: 'recipient_identity_conflict' };
  result(f, 'blocked', 'recipient_identity_conflict');
  const group = fixture(); group.evidence.conversation.title.state = 'cleared';
  result(group, 'blocked', 'name_explicitly_cleared');
});

test('contradictory native and canonical content types cannot be complete', () => {
  const f = fixture(); f.canonical.msg_type = 'system';
  result(f, 'blocked', 'content_invalid');
});

test('group names cannot substitute for private recipient identity or name', () => {
  const f = fixture({ type: 'p2p', direction: 'sent' }); f.display.recipient = 'Invented Observatory';
  result(f, 'enriching', 'recipient_identity_unknown');
  peerRecipient(f); f.evidence.recipient.name = 'Invented Observatory';
  result(f, 'enriching', 'recipient_name_missing');
});

test('senderless system events can be complete without fictitious human identity', () => {
  const f = fixture(); f.raw.msg_type = f.canonical.msg_type = 'system';
  delete f.raw.sender; f.row.actor_id = null; f.canonical.sender_id = null; delete f.canonical.sender_id_type;
  delete f.evidence.sender; result(f, 'ready');
  f.display.system = { status: 'partial', reason: 'system_parameters_missing' };
  result(f, 'enriching', 'content_partial');
});

test('conversation mode and identity conflicts are explicit, never inferred from label', () => {
  const f = fixture(); f.display.scene = '群聊'; delete f.evidence.conversation.type;
  result(f, 'enriching', 'conversation_type_unknown');
  f.evidence.conversation.type = 'p2p'; result(f, 'blocked', 'conversation_identity_conflict');
  f.evidence.conversation.type = 'group'; f.evidence.conversation.id = 'oc_other_synthetic';
  result(f, 'blocked', 'conversation_identity_conflict');
});

test('message source, identity, time and direction are required independent of four labels', () => {
  for (const [change, state, reason] of [
    [f => { f.row.source_id = 'other'; }, 'blocked', 'message_identity_invalid'],
    [f => { f.raw.chat_id = 'oc_other'; }, 'blocked', 'message_identity_invalid'],
    [f => { f.raw.message_id = 'om_other'; }, 'blocked', 'message_identity_invalid'],
    [f => { f.row.occurred_at_ms++; }, 'blocked', 'message_time_invalid'],
    [f => { f.row.occurred_at_ms = NaN; }, 'blocked', 'message_time_invalid'],
    [f => { f.row.direction = 'unknown'; }, 'enriching', 'direction_unknown'],
  ]) { const f = fixture(); change(f); result(f, state, reason); }
});

test('invalid source integrity blocks even when every parsed field and display is plausible', () => {
  const f = fixture(); result(f, 'ready');
  f.evidence.source_integrity = 'valid'; result(f, 'ready');
  f.evidence.source_integrity = 'invalid';
  const r = result(f, 'blocked', 'message_identity_invalid');
  assert.equal(r.requirements.find(item => item.field === 'conversation').state, 'conflict');
  assert.equal(r.next_action, 'review_identity');
  f.evidence.account.state = 'conflict';
  result(f, 'blocked', 'message_identity_invalid');
});

test('content completeness is type-aware and does not require prose for media or a tombstone', () => {
  for (const type of ['image', 'file', 'audio', 'video']) {
    const f = fixture(); f.raw.msg_type = f.canonical.msg_type = type; f.row.body = f.display.body = '';
    result(f, 'ready');
  }
  const f = fixture(); f.raw.deleted = true; f.evidence.content.state = 'recalled';
  f.canonical.content_rendering = { status: 'structured_fallback', reason: 'unsupported_message_content' };
  result(f, 'ready');
  delete f.raw.deleted; result(f, 'blocked', 'content_unsupported');
});

test('pending detail and partial render cannot be promoted by a nonempty body or complete hint', () => {
  const f = fixture(); f.raw.msg_type = f.canonical.msg_type = 'merge_forward';
  f.evidence.content.state = 'pending'; result(f, 'enriching', 'content_pending');
  f.evidence.content.state = 'complete'; f.display.card = { status: 'partial', reason: 'card_output_limit' };
  result(f, 'enriching', 'content_partial');
  f.display.card = { status: 'structured_fallback', reason: 'unknown_reason' };
  result(f, 'enriching', 'content_partial');
  f.display.card = { status: 'partial', reason: 'unsupported_card_structure' };
  result(f, 'blocked', 'content_unsupported');
});

test('an unsupported hint without concrete renderer evidence is not a permanent blocker', () => {
  const f = fixture(); f.evidence.content.state = 'unsupported'; result(f, 'enriching', 'content_partial');
  f.evidence.content.state = 'invalid'; result(f, 'enriching', 'content_invalid');
});

test('current successful raw rendering supersedes stale stored rendering diagnostics', () => {
  for (const type of ['interactive', 'system']) {
    const f = fixture(); f.raw.msg_type = f.canonical.msg_type = type;
    f.canonical.content_rendering = { status: 'structured_fallback', reason: 'unsupported_card_structure' };
    f.raw.content_rendering = { status: 'partial', reason: 'old_parser_limit' };
    f.display[type === 'interactive' ? 'card' : 'system'] = { status: 'rendered', reason: null };
    result(f, 'ready');
  }
});

test('permission denial requires exact target, account, authority and code; generic failure remains retryable', () => {
  const f = adopted(fixture()); f.evidence.sender.name = null;
  const blocker = { field: 'sender', reason: 'permission_denied', authority: 'contact', code: 210508,
    source_id: 'lark.im', chat_id: f.row.container_id, account_key: ACCOUNT, id: ID, id_type: 'open_id' };
  f.evidence.blockers = [{ reason: 'permission_denied' }]; result(f, 'enriching', 'sender_name_missing');
  f.evidence.blockers = [{ ...blocker, id: 'ou_other_synthetic' }]; result(f, 'enriching', 'sender_name_missing');
  f.evidence.blockers = [{ ...blocker, code: 0 }]; result(f, 'enriching', 'sender_name_missing');
  f.evidence.blockers = [{ ...blocker, code: 999123 }]; result(f, 'enriching', 'sender_name_missing');
  f.evidence.blockers = [{ ...blocker, authority: 'application_api' }]; result(f, 'enriching', 'sender_name_missing');
  f.evidence.blockers = [{ ...blocker, reason: 'failed' }]; result(f, 'enriching', 'sender_name_missing');
  f.evidence.blockers = [blocker]; result(f, 'blocked', 'permission_denied');
  f.evidence.sender.name = 'Invented Rowan'; result(f, 'ready');
});

test('captured is preparation lifecycle, independent of received/sent message direction', () => {
  const f = fixture(); delete f.evidence.prepared; result(f, 'captured');
  f.evidence.prepared = true; result(f, 'ready');
  f.evidence.sender.name = null; result(f, 'enriching', 'sender_name_missing');
});

test('evaluation is deterministic and does not mutate deep frozen input', () => {
  const f = fixture();
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  freeze(f); const before = JSON.stringify(f), a = result(f, 'ready'), b = result(f, 'ready');
  assert.deepEqual(a, b); assert.equal(JSON.stringify(f), before);
  result({}, 'blocked', 'message_identity_invalid');
});
