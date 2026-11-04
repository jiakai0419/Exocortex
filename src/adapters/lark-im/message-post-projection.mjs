// @ts-check
import { renderApiMessageContent } from './raw-message.mjs';
import { validateJsonObjectText } from '../../../dist/core/json-text-patch.js';
import { isSourceTombstone } from './source-tombstone.mjs';
import { isDeepStrictEqual } from 'node:util';
import { isCurrentImageContext } from './media-resource-projection.mjs';

/** @typedef {Record<string, any>} Row */
/** @param {unknown} value @returns {value is Row} */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const proofs = new WeakMap();
const fields = ['id', 'source_id', 'record_type', 'external_id', 'container_id',
  'external_version', 'content_hash', 'body', 'raw_json', 'canonical_json'];
/** @param {string} state @param {string|null} [reason] */
const evidence = (state, reason = null) => ({ state, source: 'message_renderer', reason });

/** Rebuild post display only after checking the source and a known stored
 * projection. A stale rendering flag cannot prove either bytes or prose.
 * Resource callbacks are internal, read-only and never serialized.
 * @param {Row} row @param {Row} canonical @param {Row} raw
 * @param {Row} [options]
 * @returns {import('./raw-message.mjs').RenderResult|null} */
export function projectPostContent(row, canonical, raw, options = {}) {
  if (isSourceTombstone(canonical, raw)) return null;
  const native = object(raw.raw_api) ? raw.raw_api : raw;
  const declared = [canonical.msg_type, raw.msg_type, raw.message_type, native.msg_type, native.message_type];
  if (!declared.includes('post')) return null;
  let item = native, baseline, legacy, diagnosis = null, sourceRaw = null, sourceCanonical = null;
  try {
    for (const encoded of [row.raw_json, row.canonical_json]) {
      if (typeof encoded !== 'string') throw new Error('missing_source_encoding');
      validateJsonObjectText(encoded);
    }
    sourceRaw = JSON.parse(row.raw_json); sourceCanonical = JSON.parse(row.canonical_json);
    if (!isDeepStrictEqual(sourceRaw,raw) || !isDeepStrictEqual(sourceCanonical,canonical))
      throw new Error('source_encoding_mismatch');
    if (Object.hasOwn(raw, 'raw_api') && !object(raw.raw_api)) throw new Error('invalid_native_wrapper');
    if (declared.some(value => value !== undefined && value !== null && value !== 'post'))
      throw new Error('conflicting_native_type');
    if (native === raw && !Object.hasOwn(raw, 'raw_api')
      && !Object.hasOwn(raw, 'source_api') && !Object.hasOwn(canonical, 'source_api')
      && !Object.hasOwn(native, 'msg_type') && !Object.hasOwn(native, 'message_type')
      && canonical.msg_type === 'post') item = { ...native, msg_type: 'post' };
    if ((item.msg_type || item.message_type) !== 'post') throw new Error('missing_native_type');
    for (const value of [canonical, raw, native]) {
      if (value.message_id != null && value.message_id !== row.external_id
        || value.chat_id != null && value.chat_id !== row.container_id) throw new Error('conflicting_native_identity');
    }
    if (!Object.hasOwn(item, 'body')) diagnosis = evidence('pending', 'post_source_missing');
    else {
      const content = item.body?.content;
      if (typeof content === 'string') validateJsonObjectText(content);
      else if (!object(content)) throw new Error('invalid_native_content');
      baseline = renderApiMessageContent(item);
      // Reuse the same bounded parser's exact pre-image mode; never accept an
      // arbitrary historical body merely because its metadata says rendered.
      legacy = renderApiMessageContent(item, { legacyPostImages: true });
      if (typeof row.body !== 'string' || row.body !== baseline.text && row.body !== legacy.text)
        diagnosis = evidence('invalid', 'stored_post_projection_mismatch');
    }
  } catch {
    diagnosis = evidence('invalid', 'post_source_invalid');
  }
  // A legitimate read from another message/account/version is still not this
  // post's resource evidence. The generic renderer cannot enforce row binding.
  const renderOptions = isCurrentImageContext(row,canonical,raw,options.imageContext)
    ? {imageContext:options.imageContext,resolveImage:options.resolveImage} : {};
  /** @type {import('./raw-message.mjs').RenderResult} */
  const rendered = baseline
    ? (diagnosis ? baseline : renderApiMessageContent(item, renderOptions))
    : { text: '', status: 'partial', reason: diagnosis?.reason || 'post_source_missing', version: 1 };
  /** @type {import('./raw-message.mjs').RenderResult} */
  const result = diagnosis ? { ...rendered, status: 'partial', reason: diagnosis.reason } : rendered;
  if (Array.isArray(result.media_slots)) Object.freeze(result.media_slots);
  Object.freeze(result);
  proofs.set(result, { row: fields.map(field => row[field]), canonical: sourceCanonical, raw: sourceRaw,
    diagnosis: diagnosis || evidence(result.status === 'rendered' ? 'complete'
      : result.status === 'partial' ? 'partial' : result.status === 'structured_fallback' ? 'unsupported' : 'pending', result.reason || null) });
  return result;
}

/** Only this read's exact post/source proof may supersede stored metadata.
 * @param {Row} row @param {Row} canonical @param {Row} raw @param {unknown} rendered */
export function readPostProjectionEvidence(row, canonical, raw, rendered) {
  const proof = object(rendered) ? proofs.get(rendered) : null;
  if (!proof || fields.some((field, index) => row[field] !== proof.row[index])
    || !isDeepStrictEqual(canonical,proof.canonical) || !isDeepStrictEqual(raw,proof.raw))
    return evidence('invalid', 'post_projection_unverified');
  return { ...proof.diagnosis };
}
