// @ts-check
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { patchTopLevelJsonMemberText, validateJsonObjectText } from '../../../dist/core/json-text-patch.js';
import { parseLarkTimeMs } from './message-record.mjs';
import { recipientAccountKey } from './p2p-recipient.mjs';
import { senderIdentity } from './sender-identity.mjs';

/** @typedef {Record<string, any>} JsonObject */
/** @typedef {import('./message-record.mjs').LocalRecord} LocalRecord */
const FIELD = 'message_account_evidence';
const SCHEMA = 'lark_message_acquisition/v1';
const KEYS = ['schema', 'source_id', 'account_key', 'external_id', 'container_id', 'source_hash', 'source_version', 'acquired_at'];
/** @param {unknown} value @returns {value is JsonObject} */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
const key = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = text => createHash('sha256').update(text).digest('hex');
const absent = value => value === undefined || value === null || value === '';

function validTime(value, now) {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isSafeInteger(now) && now >= 0 && Number.isSafeInteger(at) && at >= 0 && at <= now
    && new Date(at).toISOString() === value;
}

function sourceTime(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('invalid source clock');
  return parseLarkTimeMs(value);
}

function sourceMilliseconds(value) {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : NaN;
}

/** A null source version means no source update clock, never creation time. */
function sourceVersion(value) {
  if (absent(value)) return null;
  const at = sourceTime(value);
  if (!Number.isSafeInteger(at) || at < 0) throw new Error('invalid source version');
  return String(at);
}

/** Validate stored bytes before consulting any caller-parsed objects. The
 * existing bounded parser rejects duplicate keys at every nesting level.
 * @param {JsonObject} row */
function sourceBasis(row) {
  if (!object(row) || row.source_id !== 'lark.im' || row.record_type !== 'lark.im.message'
    || !identifier(row.external_id) || !identifier(row.container_id)
    || !['sent', 'received'].includes(row.direction)) return null;
  validateJsonObjectText(row.canonical_json);
  validateJsonObjectText(row.raw_json);
  const canonical = JSON.parse(row.canonical_json), raw = JSON.parse(row.raw_json);
  if (raw.raw_api != null && !object(raw.raw_api)) return null;
  const native = object(raw.raw_api) ? raw.raw_api : raw;
  const sourceHash = hash(row.raw_json);
  if (row.content_hash !== sourceHash || canonical.message_id !== row.external_id
    || canonical.chat_id !== row.container_id || (native.message_id ?? native.id) !== row.external_id
    || (native.chat_id ?? native.chat?.chat_id ?? native.chat?.id) !== row.container_id) return null;
  const declarations = [canonical, raw, native];
  for (const value of declarations) {
    if (value.source_id != null && value.source_id !== row.source_id
      || [value.message_id, value.id].some(id => id != null && id !== row.external_id)
      || [value.chat_id, value.chat?.chat_id, value.chat?.id].some(id => id != null && id !== row.container_id)) return null;
  }
  const version = sourceVersion(native.update_time);
  if (row.external_version !== version) return null;
  const occurred = native.create_time != null ? sourceTime(native.create_time)
    : native.created_at != null ? sourceTime(native.created_at)
      : sourceMilliseconds(native.create_time_ms);
  if (!Number.isSafeInteger(occurred) || occurred < 0 || row.occurred_at_ms !== occurred
    || row.occurred_at !== new Date(occurred).toISOString()) return null;
  for (const value of declarations) {
    if (Object.hasOwn(value, 'update_time') && sourceVersion(value.update_time) !== version
      || value.update_time_ms != null && value.update_time_ms !== Number(version)
      || version === null && value.update_time_ms != null) return null;
    for (const field of ['create_time', 'created_at']) {
      if (!absent(value[field]) && sourceTime(value[field]) !== occurred) return null;
    }
    if (value.create_time_ms != null && (value === canonical
      ? !Number.isSafeInteger(value.create_time_ms) || value.create_time_ms !== occurred
      : sourceMilliseconds(value.create_time_ms) !== occurred)) return null;
  }
  const types = declarations.flatMap(value => [value.msg_type, value.message_type]).filter(value => value != null);
  if (!types.length || types.some(type => !identifier(type)) || new Set(types).size !== 1) return null;
  const identity = senderIdentity(raw);
  const kinds = [canonical.sender_type, ...[raw, native].flatMap(value => [value.sender?.sender_type, value.sender?.type])]
    .filter(kind => kind != null && kind !== '');
  if (identity.conflict || row.actor_id !== (identity.id || null)
    || (identity.id ? canonical.sender_id !== identity.id : !absent(canonical.sender_id))
    || canonical.sender_id_type !== identity.type) return null;
  if (identity.id) {
    if (!identity.verified || !identifier(identity.id)
      || identity.type === 'app_id' && kinds.some(kind => kind !== 'app')
      || identity.type !== 'app_id' && kinds.some(kind => kind !== 'user')) return null;
  } else if (types[0] !== 'system' || kinds.some(kind => kind !== 'system') || row.direction !== 'received') return null;
  for (const value of [raw, native]) {
    if (value.sender != null && !object(value.sender)) return null;
    if (value === native || value.sender == null) continue;
    const wrapper = senderIdentity({ sender: value.sender });
    if (wrapper.conflict || wrapper.id !== identity.id || wrapper.type !== identity.type) return null;
    // A wrapper may add aliases, but cannot contradict an explicitly shared namespace.
    for (const namespace of ['open_id', 'user_id', 'union_id', 'app_id']) {
      const ids = sender => [sender?.[namespace], sender?.sender_id?.[namespace],
        ...(sender?.id_type === namespace ? [sender.id] : [])].filter(value => value != null);
      const outer = ids(value.sender), inner = ids(native.sender);
      if (outer.length && inner.length && outer.some(id => !inner.includes(id))) return null;
    }
  }
  return { canonical, raw, native, identity, sourceHash, version };
}

function accountMatches(basis, row, accountKey) {
  if (!key(accountKey)) return false;
  for (const value of [basis.canonical, basis.raw, basis.native]) {
    const markers = [value.sender_name_account_key, value.chat_name_account_key,
      value.sender_name_verification?.account_key, value[FIELD]?.account_key];
    if (markers.some(marker => marker != null && (!key(marker) || marker !== accountKey))) return false;
  }
  const senderAccount = basis.identity.type === 'open_id' ? recipientAccountKey(basis.identity.id) : null;
  const explicitOpenIds = [basis.raw.sender, basis.native.sender].flatMap(sender =>
    [sender?.open_id, sender?.sender_id?.open_id, ...(sender?.id_type === 'open_id' ? [sender.id] : [])]);
  return row.direction === 'sent' ? senderAccount === accountKey
    : senderAccount !== accountKey && !explicitOpenIds.some(id => recipientAccountKey(id) === accountKey);
}

/** Read existing proof only; this never creates or refreshes an observation.
 * Name lookup success and source clock skew are not acquisition identity tests.
 * @param {JsonObject} row @param {JsonObject} canonical @param {JsonObject} raw
 * @param {number} [now] @returns {JsonObject|null} */
function readMessageAccountEvidence(row, canonical, raw, now = Date.now()) {
  try {
    const basis = sourceBasis(row);
    if (!basis || !isDeepStrictEqual(canonical, basis.canonical) || !isDeepStrictEqual(raw, basis.raw)) return null;
    const proof = basis.canonical[FIELD];
    if (!object(proof) || Object.keys(proof).length !== KEYS.length || KEYS.some(field => !Object.hasOwn(proof, field))
      || proof.schema !== SCHEMA || proof.source_id !== row.source_id || proof.external_id !== row.external_id
      || proof.container_id !== row.container_id || proof.source_hash !== basis.sourceHash
      || proof.source_version !== basis.version || !validTime(proof.acquired_at, now)
      || !accountMatches(basis, row, proof.account_key)) return null;
    return { ...proof };
  } catch { return null; }
}

/** INTERNAL ACQUISITION PRODUCER: the caller must supply only newly normalized
 * records actually returned by its current admitted source request, and commit
 * under the existing account/scope/run fence. This pure helper cannot establish
 * admission from a self profile or historical row. An explicit acquiredAt is
 * the real response observation time, not normalization or message time.
 * Cross-DB replay retention belongs to the storage acceptance/merge boundary.
 * @param {LocalRecord[]} records @param {{open_id?:string}|null} selfProfile
 * @param {{acquiredAt?:string}} [options] @returns {LocalRecord[]} */
function bindAcquiredMessageAccounts(records, selfProfile, { acquiredAt } = {}) {
  const accountKey = recipientAccountKey(selfProfile?.open_id), now = Date.now();
  if (!Array.isArray(records) || !accountKey || typeof acquiredAt !== 'string' || !validTime(acquiredAt, now)) return records;
  return records.map(record => {
    try {
      const basis = sourceBasis(record);
      if (!basis || !accountMatches(basis, record, accountKey)) return record;
      if (Object.hasOwn(basis.canonical, FIELD)) {
        const previous = readMessageAccountEvidence(record, basis.canonical, basis.raw, now);
        if (!previous || previous.account_key !== accountKey || Date.parse(previous.acquired_at) > Date.parse(acquiredAt)) return record;
      }
      const proof = { schema: SCHEMA, source_id: record.source_id, account_key: accountKey,
        external_id: record.external_id, container_id: record.container_id, source_hash: basis.sourceHash,
        source_version: basis.version, acquired_at: acquiredAt };
      const canonical = patchTopLevelJsonMemberText(record.canonical_json, FIELD, JSON.stringify(proof));
      return canonical === record.canonical_json ? record : { ...record, canonical_json: canonical };
    } catch { return record; }
  });
}

export { bindAcquiredMessageAccounts, readMessageAccountEvidence };
