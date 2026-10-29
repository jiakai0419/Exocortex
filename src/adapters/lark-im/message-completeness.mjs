// @ts-check
import { personName, senderIdentity, senderNameFromSource } from './sender-identity.mjs';
import { chatNameCleared, chatTitle, titleMessageMatches } from './chat-title.mjs';
import { parseLarkTimeMs } from './message-record.mjs';
import { recipientAccountKey, resolveP2pRecipient } from './p2p-recipient.mjs';

/** This evaluator consumes an exact, caller-validated local evidence bundle.
 * It never interprets a rendered label as identity or performs lookup/persistence.
 * Latest lookup diagnostics are deliberately separate from adopted authority. */
export const MESSAGE_COMPLETENESS_REASONS = Object.freeze([
  'message_identity_invalid', 'message_time_invalid', 'direction_unknown',
  'account_unknown', 'account_conflict', 'conversation_identity_conflict',
  'conversation_type_unknown', 'conversation_name_missing', 'sender_identity_unknown',
  'sender_identity_conflict', 'sender_name_missing', 'sender_name_unverified',
  'recipient_identity_unknown', 'recipient_identity_conflict', 'recipient_name_missing',
  'name_explicitly_cleared', 'content_pending', 'content_partial', 'content_invalid',
  'content_resource_unavailable', 'content_resource_unsupported', 'content_resource_invalid', 'content_reference_missing', 'content_reference_invalid',
  'content_unsupported', 'permission_denied', 'unsupported_identity',
]);
const PERSON = new Set(['open_id', 'user_id', 'union_id']);
const HUMAN_SOURCES = new Set(['contact', 'chat_member', 'self']);
const APP_SOURCES = new Set(['application_api', 'chat_bot_app_id']);
const TITLE_SOURCES = new Set(['message', 'scope_config', 'im.chats.get', 'canonical']);
const UNSUPPORTED_CONTENT = new Set(['unsupported_message_content', 'unsupported_post_structure',
  'unsupported_post_element', 'unsupported_card_structure', 'unsupported_card_link']);
const BLOCK_AUTHORITIES = new Set(['contact', 'chat_member', 'application_api', 'chat_bot_app_id',
  'im.chats.get', 'im.v1.chats.batch_query']);
// This is the explicit permission code already classified by transport.mjs.
// Unknown positive codes are failures, not evidence of permanent invisibility.
const PERMISSION_CODES = new Set(['210508']);
/** @param {unknown} value @returns {value is Record<string, any>} */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && Boolean(value.trim());
const key = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/** @param {string} field @param {string} state @param {string|null} [reason] @param {string|null} [evidence] */
const requirement = (field, state, reason = null, evidence = null) => ({ field, state, reason, evidence });
const missing = (field, reason) => requirement(field, 'missing', reason);
const conflict = (field, reason) => requirement(field, 'conflict', reason);
const clear = field => requirement(field, 'blocked', 'name_explicitly_cleared', 'explicit_clear');
const satisfied = (field, source) => requirement(field, 'satisfied', null, source);
const accountReady = account => account?.state === 'verified' && key(account.account_key);
const declared = (values, expected) => values.every(value => value == null || value === '' || value === expected);
// A shared primary ID does not make contradictory typed aliases equivalent.
function aliasesDisagree(left, right) {
  const values = (sender, type) => [sender?.[type], sender?.sender_id?.[type],
    sender?.id_type === type ? sender?.id : null].filter(text);
  return ['open_id','user_id','union_id','app_id'].some(type => {
    const a=values(left,type), b=values(right,type);
    return a.length && b.length && new Set([...a,...b]).size > 1;
  });
}

function senderRequirement(row, canonical, raw, native, evidence, type) {
  const identity = senderIdentity(raw), selected = evidence.sender || {};
  const sourceSender = object(native.sender) ? native.sender : {};
  const kinds = [canonical.sender_type, sourceSender.sender_type, sourceSender.type,
    raw.sender?.sender_type, raw.sender?.type];
  if (selected.reason === 'sender_identity_conflict') return conflict('sender', 'sender_identity_conflict');
  if (type === 'system' && !identity.id && !row.actor_id && !canonical.sender_id
    && !identity.conflict && kinds.every(kind => kind == null || kind === '' || kind === 'system')) {
    return satisfied('sender', 'system_event');
  }
  if (identity.conflict || canonical.sender_id_type === 'conflicting'
    || identity.id && !declared([row.actor_id, canonical.sender_id], identity.id)
    || identity.type && !declared([canonical.sender_id_type], identity.type)
    || identity.type === 'app_id' && kinds.some(kind => kind != null && kind !== '' && kind !== 'app')
    || PERSON.has(identity.type || '') && kinds.some(kind => kind != null && kind !== '' && kind !== 'user')) return conflict('sender', 'sender_identity_conflict');
  if (raw !== native && raw.sender != null) {
    const wrapper = senderIdentity({ sender: raw.sender });
    if (wrapper.conflict || wrapper.id && (wrapper.id !== identity.id || wrapper.type !== identity.type)
      || aliasesDisagree(raw.sender,sourceSender)) {
      return conflict('sender', 'sender_identity_conflict');
    }
  }
  if (!identity.verified || !identity.id || row.actor_id !== identity.id) return missing('sender', 'sender_identity_unknown');
  if (selected.reason === 'name_explicitly_cleared' || [canonical.sender_name_state, raw.sender_name_state, native.sender_name_state,
    raw.sender?.name_state, sourceSender.name_state].includes('cleared')) return clear('sender');
  if (selected.id != null && selected.id !== identity.id || selected.id_type != null && selected.id_type !== identity.type) {
    return conflict('sender', 'sender_identity_conflict');
  }
  const direct = senderNameFromSource(raw);
  const name = personName(selected.name, identity.identifiers);
  if (!name) return missing('sender', 'sender_name_missing');
  if (selected.source === 'message_sender') {
    return direct === name ? satisfied('sender', 'message_sender') : missing('sender', 'sender_name_unverified');
  }
  // The bundle must explicitly bind every adopted non-source name to its actor.
  if (selected.id !== identity.id || selected.id_type !== identity.type) return missing('sender', 'sender_name_unverified');
  if (selected.source === 'local_chat_app_name') {
    const mapping=selected.mapping;
    const valid=identity.type==='app_id' && object(mapping) && key(mapping.database_key)
      && mapping.source_id===row.source_id && mapping.chat_id===row.container_id
      && mapping.app_id===identity.id && text(mapping.tenant_key)
      && mapping.tenant_key===sourceSender.tenant_key && mapping.source_kind==='user_screenshot'
      && typeof mapping.recorded_at==='string' && Number.isFinite(Date.parse(mapping.recorded_at))
      && new Date(mapping.recorded_at).toISOString()===mapping.recorded_at;
    return valid ? satisfied('sender','local_chat_app_name') : missing('sender','sender_name_unverified');
  }
  // A persisted source label cannot stand in for independently verified
  // adoption authority; only the read-time mapping envelope above is accepted.
  const authority = selected.source === 'local_history' ? selected.authority_source : selected.source;
  const accepted = identity.type === 'app_id' ? APP_SOURCES.has(authority)
    : identity.type === 'open_id' && HUMAN_SOURCES.has(authority);
  if (!accepted) return missing('sender', 'sender_name_unverified');
  const confidence = selected.confidence ?? (canonical.sender_name === selected.name
    && canonical.sender_name_source === selected.source ? canonical.sender_name_confidence : null);
  if (confidence !== 'high') return missing('sender', 'sender_name_unverified');
  if (!key(selected.account_key)) return missing('sender', 'sender_name_unverified');
  if (!accountReady(evidence.account)) return missing('sender', 'account_unknown');
  if (selected.account_key !== evidence.account.account_key) return conflict('sender', 'account_conflict');
  return satisfied('sender', selected.source);
}

function conversationRequirement(row, canonical, raw, native, evidence) {
  const conversation = evidence.conversation || {};
  if (conversation.reason === 'conversation_identity_conflict') return conflict('conversation', 'conversation_identity_conflict');
  if (conversation.id != null && conversation.id !== row.container_id) return conflict('conversation', 'conversation_identity_conflict');
  const modes = [canonical, raw, raw.chat, native, native.chat].flatMap(value => [value?.chat_type, value?.chat_mode])
    .filter(mode => ['p2p', 'group', 'topic'].includes(mode));
  if (modes.includes('p2p') && modes.some(mode => mode !== 'p2p')
    || ['p2p', 'group', 'topic'].includes(conversation.type) && modes.some(mode => (mode === 'p2p') !== (conversation.type === 'p2p'))) {
    return conflict('conversation', 'conversation_identity_conflict');
  }
  if (conversation.id !== row.container_id || !['p2p', 'group', 'topic'].includes(conversation.type)) {
    return missing('conversation', 'conversation_type_unknown');
  }
  if (conversation.type === 'p2p') return satisfied('conversation', 'exact_conversation');
  if (chatNameCleared(canonical, raw) || conversation.title?.state === 'cleared'
    || conversation.reason === 'name_explicitly_cleared') return clear('conversation');
  const title = conversation.title || {}, name = chatTitle(title.value, row.container_id);
  if (!name || !TITLE_SOURCES.has(title.source)) return missing('conversation', 'conversation_name_missing');
  if (title.source === 'canonical' && chatTitle(canonical.chat_name, row.container_id) !== name
    || title.source === 'message' && ![raw.chat_name, raw.chat?.name, native.chat_name, native.chat?.name,
      canonical.chat_name_source === 'message' ? canonical.chat_name : null].some(value => chatTitle(value, row.container_id) === name)) {
    return missing('conversation', 'conversation_name_missing');
  }
  if (title.source === 'im.chats.get' && !accountReady(evidence.account)) return missing('conversation', 'account_unknown');
  return satisfied('conversation', title.source);
}

function recipientRequirement(row, canonical, raw, native, evidence) {
  const type = evidence.conversation?.type, recipient = evidence.recipient || {};
  if (['group', 'topic'].includes(type)) return requirement('recipient', 'not_applicable', null, 'chat_destination');
  if (type !== 'p2p') return missing('recipient', 'recipient_identity_unknown');
  if (recipient.reason === 'recipient_identity_conflict') return conflict('recipient', 'recipient_identity_conflict');
  if (recipient.reason === 'name_explicitly_cleared') return clear('recipient');
  if (row.direction === 'received') {
    if (!accountReady(evidence.account)) return missing('recipient', 'account_unknown');
    if (recipient.is_self !== true || recipient.source !== 'account_self'
      || recipient.relationship_source !== 'admitted_account' || recipient.name !== '我') {
      return missing('recipient', 'recipient_identity_unknown');
    }
    // Own-account proof can be a hash. Do not invent or require a public self ID.
    if (recipient.id != null && (recipient.id_type !== 'open_id'
      || recipientAccountKey(recipient.id) !== evidence.account.account_key)) return conflict('recipient', 'recipient_identity_conflict');
    return satisfied('recipient', 'admitted_account');
  }
  if (row.direction !== 'sent') return missing('recipient', 'recipient_identity_unknown');
  // Reuse the established typed-partner/legacy compatibility contract instead
  // of maintaining a second interpretation of canonical versus native partner.
  const direct = resolveP2pRecipient(row, canonical, raw);
  if (direct.reason === 'recipient_identity_conflict') return conflict('recipient', 'recipient_identity_conflict');
  if (direct.reason === 'name_explicitly_cleared') return clear('recipient');
  const partner = direct.evidence;
  if (!text(recipient.id) || !PERSON.has(recipient.id_type)) return missing('recipient', 'recipient_identity_unknown');
  if (partner && (partner.id !== recipient.id || partner.id_type !== recipient.id_type)) {
    return conflict('recipient', 'recipient_identity_conflict');
  }
  const relationship = recipient.relationship_source;
  if (relationship === 'message_partner') {
    if (!partner) return missing('recipient', 'recipient_identity_unknown');
  } else if (relationship === 'im.v1.chats.batch_query') {
    if (recipient.id_type !== 'open_id') return conflict('recipient', 'recipient_identity_conflict');
    if (!accountReady(evidence.account)) return missing('recipient', 'account_unknown');
  } else return missing('recipient', 'recipient_identity_unknown');
  if (recipient.is_self === true && recipient.source === 'account_self' && recipient.name === '我'
    && recipient.id_type === 'open_id' && accountReady(evidence.account)
    && recipientAccountKey(recipient.id) === evidence.account.account_key) return satisfied('recipient', 'account_self');
  const aliases = [recipient.id, ...[canonical.chat_partner, raw.chat_partner, native.chat_partner]
    .filter(object).flatMap(value => senderIdentity({ sender: value }).identifiers)];
  const name = personName(recipient.name, aliases);
  if (!name) return missing('recipient', 'recipient_name_missing');
  if (recipient.source === 'message_partner' && partner?.name === name) {
    return satisfied('recipient', 'message_partner');
  }
  if (recipient.source === 'contact' && recipient.id_type === 'open_id') {
    return accountReady(evidence.account) ? satisfied('recipient', 'contact') : missing('recipient', 'account_unknown');
  }
  return missing('recipient', 'recipient_name_missing');
}

function contentRequirement(canonical, raw, native, display, evidence) {
  const content = evidence.content || {};
  const types = [canonical.msg_type, raw.msg_type, raw.message_type, native.msg_type, native.message_type].filter(text);
  if (new Set(types).size > 1) return conflict('content', 'content_invalid');
  if (content.state === 'pending') return missing('content', 'content_pending');
  if (content.state === 'recalled' && [canonical, raw, native].some(value => value.deleted === true)) {
    return satisfied('content', 'source_tombstone');
  }
  const mediaReasons = { media_resource_unavailable: 'content_resource_unavailable',
    media_resource_unsupported:'content_resource_unsupported',media_resource_invalid:'content_resource_invalid',
    media_reference_missing: 'content_reference_missing', media_reference_invalid: 'content_reference_invalid' };
  if (content.state === 'partial' && Object.hasOwn(mediaReasons, content.reason))
    return requirement('content', 'blocked', mediaReasons[content.reason], 'media_reference');
  if (['partial', 'unsupported'].includes(content.state) && UNSUPPORTED_CONTENT.has(content.reason))
    return requirement('content', 'blocked', 'content_unsupported', 'renderer');
  // Read-time renderers use the current raw snapshot. A successfully rebuilt
  // card/system projection supersedes an older stored renderer diagnosis.
  const renderings = [display.media || display.card || display.system || canonical.content_rendering || raw.content_rendering].filter(object);
  const unsupported = renderings.find(value => value.status !== 'rendered' && UNSUPPORTED_CONTENT.has(value.reason));
  if (unsupported) return requirement('content', 'blocked', 'content_unsupported', 'renderer');
  if (renderings.some(value => ['partial', 'structured_fallback'].includes(value.status))) return missing('content', 'content_partial');
  if (content.state === 'invalid') return missing('content', 'content_invalid');
  if (content.state === 'partial' || content.state === 'unsupported') return missing('content', 'content_partial');
  if (content.state !== 'complete') return missing('content', 'content_pending');
  if (!text(canonical.msg_type || native.msg_type || native.message_type)) return missing('content', 'content_pending');
  return satisfied('content', 'content_projection');
}

function applyBlockers(requirements, row, evidence) {
  for (const blocker of Array.isArray(evidence.blockers) ? evidence.blockers : []) {
    if (!object(blocker) || blocker.source_id !== row.source_id || blocker.chat_id !== row.container_id
      || !['sender', 'recipient', 'conversation'].includes(blocker.field)
      || !BLOCK_AUTHORITIES.has(blocker.authority) || !key(blocker.account_key)
      || !accountReady(evidence.account) || blocker.account_key !== evidence.account.account_key) continue;
    const index = requirements.findIndex(item => item.field === blocker.field);
    if (index < 0) continue;
    const selected = blocker.field === 'sender' ? evidence.sender : blocker.field === 'recipient' ? evidence.recipient : null;
    if (['sender', 'recipient'].includes(blocker.field) && (!selected
      || blocker.id !== selected.id || blocker.id_type !== selected.id_type)) continue;
    if (blocker.field === 'sender' && (!selected || blocker.id !== row.actor_id)) continue;
    const routeMatches = blocker.field === 'sender'
      ? selected?.id_type === 'open_id' ? ['contact', 'chat_member'].includes(blocker.authority)
        : selected?.id_type === 'app_id' && APP_SOURCES.has(blocker.authority)
      : blocker.field === 'recipient' ? selected?.id_type === 'open_id'
        && ['contact', 'im.v1.chats.batch_query'].includes(blocker.authority)
        : blocker.authority === 'im.chats.get';
    if (!routeMatches) continue;
    if (blocker.reason === 'identity_conflict') {
      requirements[index] = conflict(blocker.field, blocker.field === 'sender' ? 'sender_identity_conflict'
        : blocker.field === 'recipient' ? 'recipient_identity_conflict' : 'conversation_identity_conflict');
    } else if (requirements[index].state === 'missing' && blocker.reason === 'permission_denied'
      && PERMISSION_CODES.has(String(blocker.code))) {
      requirements[index] = requirement(blocker.field, 'blocked', 'permission_denied', blocker.authority);
    }
  }
}

/**
 * @param {{row?:Record<string,any>,canonical?:Record<string,any>,raw?:Record<string,any>,
 * display?:Record<string,any>,evidence?:Record<string,any>}} [input]
 */
export function evaluateMessageCompleteness(input = {}) {
  const row = object(input.row) ? input.row : {}, canonical = object(input.canonical) ? input.canonical : {};
  const raw = object(input.raw) ? input.raw : {}, native = object(raw.raw_api) ? raw.raw_api : raw;
  const display = object(input.display) ? input.display : {}, evidence = object(input.evidence) ? input.evidence : {};
  const type = canonical.msg_type || native.msg_type || native.message_type;
  const requirements = [senderRequirement(row, canonical, raw, native, evidence, type),
    recipientRequirement(row, canonical, raw, native, evidence),
    conversationRequirement(row, canonical, raw, native, evidence),
    contentRequirement(canonical, raw, native, display, evidence)];
  if (row.source_id !== 'lark.im' || !text(row.external_id) || !text(row.container_id)
    || !titleMessageMatches(row, canonical, raw) || (native.message_id ?? native.id) !== row.external_id
    || (native.chat_id ?? native.chat?.chat_id ?? native.chat?.id) !== row.container_id) {
    requirements[2] = conflict('conversation', 'message_identity_invalid');
  } else if (!['sent', 'received'].includes(row.direction)) {
    requirements[2] = missing('conversation', 'direction_unknown');
  }
  const sourceTime = native.create_time ?? native.created_at ?? native.create_time_ms;
  if (!Number.isSafeInteger(row.occurred_at_ms) || row.occurred_at_ms < 0
    || sourceTime != null && parseLarkTimeMs(sourceTime) !== row.occurred_at_ms) {
    requirements[3] = conflict('content', 'message_time_invalid');
  }
  const account = evidence.account || {};
  const markers = [canonical.chat_name_account_key, canonical.sender_name_account_key,
    canonical.sender_name_verification?.account_key];
  if (account.state === 'conflict' || markers.some(value => value != null && (!key(value)
    || accountReady(account) && value !== account.account_key))
    || markers.filter(value => value != null).some(value => value !== markers.find(item => item != null))) {
    requirements[2] = conflict('conversation', 'account_conflict');
  }
  applyBlockers(requirements, row, evidence);
  // This gate survives more specific account/task diagnostics: ambiguous source
  // bytes cannot acquire a valid identity merely through plausible parsed values.
  if (evidence.source_integrity === 'invalid') requirements[2] = conflict('conversation', 'message_identity_invalid');
  const reasons = [...new Set(requirements.map(item => item.reason).filter(Boolean))];
  const blocked = requirements.some(item => ['blocked', 'conflict'].includes(item.state));
  const complete = requirements.every(item => ['satisfied', 'not_applicable'].includes(item.state));
  const state = blocked ? 'blocked' : evidence.prepared !== true ? 'captured' : complete ? 'ready' : 'enriching';
  const next_action = state === 'ready' ? 'none' : state === 'captured' ? 'prepare'
    : reasons.includes('account_conflict') || requirements.some(item => item.state === 'conflict') ? 'review_identity'
    : reasons.includes('permission_denied') ? 'review_permissions'
    : reasons.includes('name_explicitly_cleared') ? 'review_explicit_clear'
    : reasons.some(reason => ['content_unsupported', 'content_resource_unavailable', 'content_resource_unsupported', 'content_resource_invalid',
      'content_reference_missing', 'content_reference_invalid'].includes(reason || '')) ? 'review_content'
    : `resolve_${requirements.find(item => item.state === 'missing')?.field || 'content'}`;
  return { version: 1, state, requirements, reasons, next_action };
}
