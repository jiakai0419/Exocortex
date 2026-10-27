// @ts-check
import { senderIdentity, senderNameFromSource, personName } from './sender-identity.mjs';
import { nameTaskKey, messageNameAccount } from './name-evidence.mjs';
import { sentRecipientAccount, recipientAccountKey, resolveP2pRecipient } from './p2p-recipient.mjs';
import { titleMessageMatches } from './chat-title.mjs';
import { validateJsonObjectText } from '../../../dist/core/json-text-patch.js';
import { readMessageAccountEvidence } from './message-account-evidence.mjs';
import { readSavedSenderRouteEvidence } from './saved-sender-route-failures.mjs';
import { messageContentEvidence } from './message-content-evidence.mjs';

/** @typedef {Record<string,any>} JsonObject */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const account = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const humanSources = new Set(['contact', 'chat_member', 'self']);
const appSources = new Set(['application_api', 'chat_bot_app_id']);

/** Account ownership is never borrowed from a different message or inferred
 * from whichever task happens to be returned by a query.
 * @param {JsonObject} row @param {JsonObject} canonical @param {JsonObject} raw */
function projectionAccount(row, canonical, raw) {
  const acquisition=Object.hasOwn(canonical,'message_account_evidence')
    ? readMessageAccountEvidence(row,canonical,raw) : null;
  if (Object.hasOwn(canonical,'message_account_evidence') && !acquisition)
    return {state:'conflict',account_key:null};
  const self = sentRecipientAccount(row, canonical, raw);
  const key = self ? recipientAccountKey(self) : acquisition?.account_key || messageNameAccount(row, canonical, raw);
  const markers = [canonical.chat_name_account_key, canonical.sender_name_account_key,
    canonical.sender_name_verification?.account_key,acquisition?.account_key].filter(value => value != null);
  if (markers.some(value => !account(value)) || new Set(markers).size > 1
    || key && markers.some(value => value !== key)) return { state: 'conflict', account_key: null };
  return account(key) ? { state: 'verified', account_key: key, ...(self ? { self_id: self } : {}) }
    : { state: 'unknown', account_key: null };
}

/** Validate exact local work evidence; a task's outcome label alone is not
 * adoption authority. No network, writes or whole-history search.
 * @param {JsonObject} task @param {JsonObject} row @param {string} accountKey @param {number} [nowMs] */
function readSenderProjectionEvidence(task, row, accountKey, nowMs = Date.now()) {
  try {
    validateJsonObjectText(row.canonical_json);
    validateJsonObjectText(row.raw_json);
    const canonical = JSON.parse(row.canonical_json), raw = JSON.parse(row.raw_json);
    const identity = senderIdentity(raw);
    if (!account(accountKey) || !identity.verified || identity.conflict
      || !['open_id', 'app_id'].includes(identity.type || '')
      || row.source_id != null && row.source_id !== 'lark.im'
      || !titleMessageMatches(row, canonical, raw)
      || row.actor_id !== identity.id || canonical.sender_id !== identity.id
      || canonical.sender_id_type != null && canonical.sender_id_type !== identity.type
      || projectionAccount(row, canonical, raw).account_key !== accountKey
      || task.source_id !== 'lark.im' || task.account_key !== accountKey || task.kind !== 'sender'
      || task.actor_id !== row.actor_id || task.chat_id !== row.container_id || task.namespace !== identity.type
      || task.task_key !== nameTaskKey('sender', row.container_id, row.actor_id, identity.type || '')
      || typeof task.evidence_json !== 'string' || Buffer.byteLength(task.evidence_json) > 16384) return null;
    validateJsonObjectText(task.evidence_json);
    const value = JSON.parse(task.evidence_json), observation = value.observation;
    const keys = ['schema', 'source_id', 'account_key', 'chat_id', 'actor_id', 'namespace', 'phase', 'observation'];
    const observationKeys = ['status', 'reason', 'name', 'source', 'account_key', 'observed_at', 'cached'];
    if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
      || value.schema !== 'lark_sender_name_work/v1' || value.source_id !== 'lark.im'
      || value.account_key !== accountKey || value.chat_id !== row.container_id || value.actor_id !== identity.id
      || value.namespace !== identity.type || value.phase !== 'resolved'
      || !object(observation) || Object.keys(observation).length !== observationKeys.length
      || observationKeys.some(key => !Object.hasOwn(observation, key))
      || observation.status !== 'resolved' || observation.reason !== 'exact_id_match'
      || observation.account_key !== accountKey || observation.cached !== false
      || !(identity.type === 'open_id' ? humanSources : appSources).has(observation.source)
      || !personName(observation.name, [identity.id, ...identity.identifiers])) return null;
    const at = Date.parse(observation.observed_at);
    if (!Number.isSafeInteger(at) || at < 0 || at > nowMs
      || new Date(at).toISOString() !== observation.observed_at) return null;
    return { ...observation, id: identity.id, id_type: identity.type, confidence: 'high' };
  } catch { return null; }
}

/** Resolve a display candidate and its authority together. A known canonical
 * value without sufficient authority remains visible only as an exception;
 * it cannot silently acquire trust from a nonempty label.
 * @param {JsonObject} row @param {JsonObject} canonical @param {JsonObject} raw
 * @param {JsonObject|null|undefined} saved */
function senderProjection(row, canonical, raw, saved) {
  const identity = senderIdentity(raw), native = object(raw.raw_api) ? raw.raw_api : raw;
  const id = canonical.sender_id || row.actor_id || identity.id || null;
  const base = { id, id_type: identity.type, name: '', source: null };
  if ([canonical.sender_name_state, raw.sender_name_state, raw.sender?.name_state,
    native.sender_name_state, native.sender?.name_state].includes('cleared')) return { ...base, reason: 'name_explicitly_cleared' };
  if (identity.conflict || !titleMessageMatches(row, canonical, raw)
    || [row.actor_id, canonical.sender_id].some(value => value != null && value !== '' && value !== identity.id)
    || canonical.sender_id_type != null && canonical.sender_id_type !== identity.type)
    return { ...base, reason: 'sender_identity_conflict' };
  const sourceName = identity.verified ? senderNameFromSource(raw) : '';
  const known = personName(canonical.sender_name, [id, ...identity.identifiers]);
  if (sourceName && (!known || known === sourceName)) return { ...base, name: sourceName, source: 'message_sender' };
  const source = canonical.sender_name_source;
  const authority = source === 'local_history' ? canonical.sender_name_authority_source : source;
  const trustedAdoption = canonical.sender_name_confidence === 'high'
    && (identity.type === 'open_id' ? humanSources : appSources).has(authority)
    && account(canonical.sender_name_account_key);
  if(sourceName && !trustedAdoption) return {...base,name:sourceName,source:'message_sender'};
  if (saved && !trustedAdoption && saved.id === identity.id && saved.id_type === identity.type)
    return { ...base, name: saved.name, source: saved.source, confidence: 'high',
      authority_source: saved.authority_source, account_key: saved.account_key, observed_at: saved.observed_at };
  if (known && source !== 'chat_bot_unique') return { ...base, name: known, source,
    confidence: canonical.sender_name_confidence,
    authority_source: canonical.sender_name_authority_source,
    account_key: canonical.sender_name_account_key, observed_at: canonical.sender_name_observed_at };
  if (saved && saved.id === identity.id && saved.id_type === identity.type)
    return { ...base, name: saved.name, source: saved.source, confidence: 'high', authority_source: saved.authority_source,
      account_key: saved.account_key, observed_at: saved.observed_at };
  return { ...base, name: known, source: known ? source : null };
}

/** Pure normalized evidence for the shared completeness evaluator.
 * @param {JsonObject} row @param {JsonObject} canonical @param {JsonObject} raw
 * @param {JsonObject} display @param {JsonObject} options */
function messageProjectionEvidence(row, canonical, raw, display, options) {
  let sourceIntegrity='valid';
  try { validateJsonObjectText(row.canonical_json); validateJsonObjectText(row.raw_json); }
  catch { sourceIntegrity='invalid'; }
  const accountEvidence = projectionAccount(row, canonical, raw);
  const recipient = resolveP2pRecipient(row, canonical, raw, options.recipientConfig);
  const content = messageContentEvidence(row, canonical, raw, display);
  return {
    prepared: true,
    source_integrity: sourceIntegrity,
    account: accountEvidence,
    conversation: { id: row.container_id, type: options.chatType,
      title: options.chatName ? { value: options.chatName, source: options.titleSource || 'canonical' } : null },
    sender: senderProjection(row, canonical, raw, options.senderEvidence),
    recipient: recipient.evidence ? { ...recipient.evidence, reason: recipient.reason } : { reason: recipient.reason },
    content,
    blockers: sourceIntegrity === 'valid' ? (options.routeEvidence
      || readSavedSenderRouteEvidence(row,canonical,raw,accountEvidence,undefined)).blockers : [],
  };
}

export { projectionAccount, readSenderProjectionEvidence, senderProjection, messageProjectionEvidence };
