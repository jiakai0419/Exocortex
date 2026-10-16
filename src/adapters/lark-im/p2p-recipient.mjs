// @ts-check
import { createHash } from 'node:crypto';
import { personName, senderIdentity } from './sender-identity.mjs';

const SCHEMA = 'lark_p2p_recipient/v1';
const SOURCE = 'im.v1.chats.batch_query';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const openId = value => typeof value === 'string' && /^ou_[A-Za-z0-9_-]+$/.test(value) && value.length <= 512;
const native = raw => object(raw?.raw_api) ? raw.raw_api : raw;

/** The account key has the same namespace as existing Lark account fences. */
function recipientAccountKey(id) {
  return openId(id) ? createHash('sha256').update(`lark.im\0${id}`).digest('hex') : null;
}

/** Bind a projection to the exact message and chat, including every supplied
 * wrapper identity. Titles, first-seen provenance and names are not identity. */
function messageMatches(row, canonical, raw) {
  if (!row.container_id || !row.external_id || row.record_type !== 'lark.im.message'
    || row.source_id != null && row.source_id !== 'lark.im') return false;
  for (const value of [canonical, raw, native(raw)]) {
    if (!object(value)) return false;
    if (value.message_id != null && value.message_id !== row.external_id) return false;
    for (const id of [value.chat_id, value.chat?.chat_id, value.chat?.id]) {
      if (id != null && id !== row.container_id) return false;
    }
  }
  return [raw, native(raw)].every(value => value.id == null || value.id === row.external_id);
}

/** Only the target's own typed native sent identity authorizes consumption of
 * account-bound evidence. A legacy database's single sent actor does not bind
 * its received history, and no other record is borrowed here. */
function sentRecipientAccount(row, canonical, raw) {
  if (row.direction !== 'sent' || !messageMatches(row, canonical, raw)) return null;
  const source = native(raw), identity = senderIdentity(raw);
  if (source !== raw && raw.sender != null) {
    const wrapper = senderIdentity({ sender: raw.sender });
    if (!wrapper.verified || wrapper.id !== identity.id || wrapper.type !== identity.type
      || raw.sender.sender_type === 'app' || raw.sender.type === 'app') return null;
    for (const type of ['open_id', 'user_id', 'union_id', 'app_id']) {
      const ids = sender => [sender?.[type], sender?.sender_id?.[type], ...(sender?.id_type === type ? [sender.id] : [])]
        .filter(value => typeof value === 'string' && value);
      const outer = ids(raw.sender), inner = ids(source.sender);
      if (outer.length && inner.length && outer.some(id => !inner.includes(id))) return null;
    }
  }
  if (!identity.verified || identity.type !== 'open_id' || !openId(identity.id)
    || (source.message_id ?? source.id) !== row.external_id || source.chat_id !== row.container_id
    || identity.id !== row.actor_id || canonical.sender_id !== identity.id
    || canonical.sender_id_type != null && canonical.sender_id_type !== 'open_id'
    || source.sender?.sender_type === 'app' || source.sender?.type === 'app'
    || canonical.sender_type === 'app') return null;
  return identity.id;
}

/** Official CLI batch-query contract explicitly requests user_id_type=open_id.
 * Require one exact response item; a title, roster fragment or a duplicate item
 * cannot substitute for the API's explicit p2p target relationship. */
function parseP2pTarget(response, chatId) {
  if (!object(response) || response.ok === false || response.error != null
    || response.code != null && response.code !== 0) return null;
  const data = object(response.data) ? response.data : response;
  if (!Array.isArray(data.items) || data.has_more != null && data.has_more !== false
    || data.page_token != null && data.page_token !== '') return null;
  const matches = data.items.filter(item => object(item) && item.chat_id === chatId);
  if (matches.length !== 1) return null;
  const item = matches[0];
  if (item.chat_mode !== 'p2p' || ['group', 'topic'].includes(item.chat_type)
    || item.p2p_target_type !== 'user' || !openId(item.p2p_target_id)) return null;
  return { id_type: 'open_id', id: item.p2p_target_id };
}

function makeRecipientEvidence(chatId, selfOpenId, target, name, observedAt) {
  if (typeof chatId !== 'string' || !chatId || !openId(selfOpenId)
    || target?.id_type !== 'open_id' || !openId(target.id)
    || typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))
    || new Date(observedAt).toISOString() !== observedAt) throw new Error('invalid recipient evidence');
  const verifiedName = personName(name, [target.id, selfOpenId, chatId]);
  return { schema: SCHEMA, source_id: 'lark.im', chat_id: chatId,
    account_key: recipientAccountKey(selfOpenId), recipient: { ...target, name: verifiedName || null },
    observed_at: observedAt, identity_source: SOURCE, name_source: verifiedName ? 'contact' : null };
}

/** The scheduler and reader use the same strict evidence validator. A conflict
 * keeps both observations; a missing lookup is not contradictory evidence. */
function readRecipientEvidence(config, account, { includeConflicted = false, nowMs = Date.now() } = {}) {
  const evidence = config?.p2p_recipient;
  if (!openId(account) || !object(evidence) || typeof config.chat_id !== 'string'
    || evidence.schema !== SCHEMA || evidence.source_id !== 'lark.im'
    || evidence.chat_id !== config.chat_id || evidence.account_key !== recipientAccountKey(account)
    || evidence.identity_source !== SOURCE || evidence.recipient?.id_type !== 'open_id'
    || !openId(evidence.recipient.id) || typeof evidence.observed_at !== 'string'
    || !Number.isFinite(Date.parse(evidence.observed_at))
    || new Date(evidence.observed_at).toISOString() !== evidence.observed_at
    || Date.parse(evidence.observed_at) < 0 || Date.parse(evidence.observed_at) > nowMs
    || !/^\d{4}-/.test(evidence.observed_at)) return null;
  const conflict = evidence.conflict;
  if (conflict != null && (!object(conflict) || conflict.schema !== 'lark_p2p_recipient_conflict/v1'
    || conflict.identity_source !== SOURCE || conflict.recipient?.id_type !== 'open_id'
    || !openId(conflict.recipient.id) || typeof conflict.observed_at !== 'string'
    || !Number.isFinite(Date.parse(conflict.observed_at))
    || new Date(conflict.observed_at).toISOString() !== conflict.observed_at
    || Date.parse(conflict.observed_at) < Date.parse(evidence.observed_at)
    || Date.parse(conflict.observed_at) > nowMs)) return null;
  if (conflict && !includeConflicted) return null;
  const peer = evidence.recipient;
  return { id: peer.id, type: 'open_id', name: evidence.name_source === 'contact'
    ? personName(peer.name, [peer.id, account, config.chat_id]) : '', self: peer.id === account,
    observed_at: evidence.observed_at, conflicted: Boolean(conflict), conflict };
}

/** Evidence is persistent local observation, never a live-account assertion. */
function scopeRecipient(row, canonical, raw, config) {
  const account = sentRecipientAccount(row, canonical, raw);
  return account && config?.chat_id === row.container_id
    ? readRecipientEvidence(config, account, { includeConflicted: true }) : null;
}

function explicitPartner(value) {
  if (!object(value)) return null;
  const identity = senderIdentity({ sender: value });
  if (!identity.verified || identity.conflict || !['open_id', 'user_id', 'union_id'].includes(identity.type || '')
    || identity.type === 'open_id' && !openId(identity.id)) return null;
  return { id: identity.id, type: identity.type, name: value.name_state === 'cleared' ? ''
    : personName(value.name, identity.identifiers) || personName(value.display_name, identity.identifiers),
    cleared: value.name_state === 'cleared', self: false };
}

/** Return only a person identity, never a chat title/ID. Unknown is explicit so
 * the existing recipient line remains visible without inventing a recipient. */
function displayP2pRecipient(row, canonical, raw, currentChat) {
  if (row.direction === 'received') return '我';
  if (row.direction !== 'sent' || !messageMatches(row, canonical, raw)) return '未知';
  // Older recordFromMessage stored every partner under open_id. A malformed
  // open-ID-shaped canonical projection cannot override an explicit raw user ID.
  // Do not accept an open-ID-shaped collision as a cross-namespace mapping.
  const sourcePartner = explicitPartner(native(raw)?.chat_partner);
  const old = canonical.chat_partner;
  const legacyMistyped = object(old) && !openId(old.open_id) && sourcePartner?.type === 'user_id'
    && old.open_id === sourcePartner.id && Object.keys(old).every(key => ['open_id', 'name', 'name_state'].includes(key));
  const declarations = [...(legacyMistyped ? [] : [canonical.chat_partner]), raw.chat_partner, native(raw)?.chat_partner]
    .filter(value => value != null);
  const partners = declarations.map(explicitPartner);
  if (partners.some(value => !value)) return '未知';
  const saved = scopeRecipient(row, canonical, raw, currentChat);
  // A new open-ID observation cannot establish or contradict an unrelated
  // user-ID/union-ID namespace. Preserve the message's typed name without
  // inventing an alias mapping. Conflicting declarations within the message
  // itself still fail the comparison below.
  const comparableSaved = saved && (!partners.length || partners.some(value => value?.type === saved.type)) ? saved : null;
  if (comparableSaved?.conflicted) return '未知';
  const candidates = [...partners.filter(value => value !== null), ...(comparableSaved ? [comparableSaved] : [])];
  if (!candidates.length || candidates.some(value => value.id !== candidates[0].id || value.type !== candidates[0].type)) return '未知';
  // A clear in the message projection is not undone by a later local cache.
  const cleared = partners.some(value => value?.cleared) || legacyMistyped && old.name_state === 'cleared';
  const candidate = candidates[0];
  if (!cleared) {
    const name = candidates.find(value => value.name)?.name;
    if (name) return name;
    if (comparableSaved?.self) return '我';
  }
  return `${candidate.id.slice(0, 8)}...`;
}

export { recipientAccountKey, sentRecipientAccount, parseP2pTarget, makeRecipientEvidence, readRecipientEvidence, displayP2pRecipient };
