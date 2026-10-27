// @ts-check
import { renderApiMessageContent } from './raw-message.mjs';
import { validateJsonObjectText } from '../../../dist/core/json-text-patch.js';

/** @typedef {Record<string, any>} JsonObject */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const evidence = (state, reason = null) => ({ state, source: 'message_renderer', reason });
const fromRendering = rendering => evidence(rendering?.status === 'rendered' ? 'complete'
  : rendering?.status === 'partial' ? 'partial'
  : rendering?.status === 'structured_fallback' ? 'unsupported' : 'pending', rendering?.reason || null);

/** Text/post native content has an encoded JSON object contract. Never treat
 * failed parsing as legacy plain text, or select the last duplicate member.
 * @param {JsonObject} item */
function validateNativeContent(item) {
  const type = item.msg_type || item.message_type;
  if (!['text', 'post'].includes(type)) return;
  const content = item.body?.content;
  if (typeof content === 'string') validateJsonObjectText(content);
  else if (!object(content)) throw new Error('invalid_native_content');
}

/** Verify an old projection without writing a new body or manufacturing a
 * renderer observation. Current card/system projections and persisted renderer
 * diagnoses keep their existing precedence. All fallback rendering is pure.
 * @param {JsonObject} row @param {JsonObject} canonical @param {JsonObject} raw
 * @param {JsonObject} display */
export function messageContentEvidence(row, canonical, raw, display) {
  const native = object(raw.raw_api) ? raw.raw_api : raw;
  if (canonical.deleted === true || raw.deleted === true || native.deleted === true)
    return { state: 'recalled', source: 'native_tombstone', reason: null };
  const rendering = display.card || display.system || canonical.content_rendering || raw.content_rendering;
  if (rendering) return fromRendering(rendering);
  const type = canonical.msg_type || native.msg_type || native.message_type;
  let item = native;
  if (!Object.hasOwn(native, 'body')) {
    // The old direct-text representation is distinct from a native API item or
    // its derived wrapper. A wrapper cannot rescue missing/malformed raw_api.
    if (type !== 'text' || native !== raw || raw.source_api != null) return evidence('pending');
    const text = typeof native.content === 'string' ? native.content
      : object(native.content) && typeof native.content.text === 'string' ? native.content.text : null;
    if (text === null) return evidence('pending');
    item = { ...native, msg_type: 'text', body: { content: { text } } };
  }
  try {
    validateNativeContent(item);
    const expansion = raw.raw_api_expansions?.merge_forward;
    if (type === 'merge_forward' && expansion != null) {
      if (!object(expansion) || expansion.source_api !== 'im.v1.messages.get' || !Array.isArray(expansion.items))
        return evidence('invalid');
      for (const child of expansion.items) {
        if (!object(child)) return evidence('invalid');
        validateNativeContent(child);
      }
    }
    const rebuilt = renderApiMessageContent(item, type === 'merge_forward' && expansion != null
      ? { mergeItems: expansion.items } : {});
    if (rebuilt.status === 'rendered' && (typeof row.body !== 'string' || row.body !== rebuilt.text))
      return evidence('invalid');
    return fromRendering(rebuilt);
  } catch {
    return evidence('invalid');
  }
}
