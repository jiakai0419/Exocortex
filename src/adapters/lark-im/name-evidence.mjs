// @ts-check
import { createHash } from 'node:crypto';
import { personName, senderIdentity, senderLookupNamespace, legacyAppNameNeedsVerification } from './sender-identity.mjs';
import { sentRecipientAccount, recipientAccountKey } from './p2p-recipient.mjs';
import { chatTitle, titleMessageMatches } from './chat-title.mjs';
import { validateJsonObjectText } from '../../../dist/core/json-text-patch.js';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const accountKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
function nameTaskKey(kind, chat, actor = '', namespace = '') {
  return createHash('sha256').update(JSON.stringify([kind,chat,actor,namespace])).digest('hex');
}
/** A message's own adopted lookup, or its typed sent identity, binds reading.
 * Never upgrade a legacy received row merely because the DB has a sent actor. */
function messageNameAccount(row, canonical, raw) {
  const self = sentRecipientAccount(row, canonical, raw);
  if (self) return recipientAccountKey(self);
  if (row.direction==='sent') return null;
  if (!titleMessageMatches(row,canonical,raw)) return null;
  if (accountKey(canonical.chat_name_account_key)) return accountKey(canonical.chat_name_account_key);
  const identity = senderIdentity(raw);
  return identity.verified && senderLookupNamespace(raw) === identity.type
    && identity.id === row.actor_id && canonical.sender_id === row.actor_id
    && canonical.sender_id_type === identity.type
    ? accountKey(canonical.sender_name_account_key) : null;
}
function readChatNameEvidence(text, chat, account, nowMs = Date.now()) {
  try {
    validateJsonObjectText(text);
    const value = JSON.parse(text), at = Date.parse(value.observed_at);
    if (!object(value) || value.schema !== 'lark_current_chat_name/v1' || value.source_id !== 'lark.im'
      || value.account_key !== account || !accountKey(account) || value.chat_id !== chat
      || value.authority !== 'im.chats.get' || !['group','topic'].includes(value.chat_type)
      || !chatTitle(value.name,chat) || !Number.isSafeInteger(at) || at < 0 || at > nowMs
      || new Date(at).toISOString() !== value.observed_at) return null;
    return value;
  } catch { return null; }
}
function senderNameTarget(row) {
  try {
    const canonical = JSON.parse(row.canonical_json || '{}'), raw = JSON.parse(row.raw_json);
    if (!titleMessageMatches(row,canonical,raw) || canonical.msg_type === 'system'
      || raw.msg_type === 'system' || canonical.sender_name_state === 'cleared') return null;
    const identity = senderIdentity(raw), namespace = senderLookupNamespace(raw);
    if (!identity.verified || !['open_id','app_id'].includes(namespace)
      || identity.type !== namespace || identity.id !== row.actor_id || canonical.sender_id !== row.actor_id
      || canonical.sender_id_type && canonical.sender_id_type !== namespace) return null;
    return { canonical, raw, identity, namespace,
      unknown: !personName(canonical.sender_name,[row.actor_id,...identity.identifiers]),
      needsVerification: legacyAppNameNeedsVerification(raw, canonical) };
  } catch { return null; }
}
export { nameTaskKey, messageNameAccount, readChatNameEvidence, senderNameTarget };
