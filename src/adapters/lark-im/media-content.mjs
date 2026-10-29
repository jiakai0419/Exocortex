// @ts-check
import { validateJsonObjectText } from '../../../dist/core/json-text-patch.js';

/** @typedef {Record<string, any>} JsonObject */
/** @typedef {{version:number,type:'image'|'sticker',text:string,status:'partial'|'rendered',reason:string|null,
 * resource:Record<string,any>}} MediaProjection */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const INPUT_LIMIT = 256 * 1024;
const KEY_LIMIT = 2048;

/** A typed source reference is not a usable/downloaded resource. Pure bounded
 * read-time diagnosis only: no files, URLs, OCR, lookup or stored-body changes.
 * @param {JsonObject} row @param {JsonObject} canonical @param {JsonObject} raw
 * @returns {MediaProjection|null} */
export function renderMediaProjection(row, canonical, raw) {
  if (Object.hasOwn(raw, 'raw_api') && !object(raw.raw_api)) return null;
  const native = Object.hasOwn(raw, 'raw_api') ? raw.raw_api : raw;
  if ([canonical, raw, native].some(value => value.deleted === true)) return null;
  const type = native.msg_type || native.message_type;
  if (!['image', 'sticker'].includes(type)) return null;
  const declarations = [canonical.msg_type, raw.msg_type, raw.message_type, native.msg_type, native.message_type]
    .filter(value => value !== undefined && value !== null);
  if (declarations.some(value => value !== type)
    || typeof row.external_id !== 'string' || !row.external_id
    || typeof row.container_id !== 'string' || !row.container_id
    || native.message_id !== row.external_id || native.chat_id !== row.container_id
    || [canonical, raw, native].some(value => value.message_id != null && value.message_id !== row.external_id
      || value.chat_id != null && value.chat_id !== row.container_id
      || [value.chat?.chat_id, value.chat?.id].some(id => id != null && id !== row.container_id))
    || [raw, native].some(value => value.id != null && value.id !== row.external_id)) return null;
  let sourceTooLarge = false;
  try {
    for (const encoded of [row.raw_json, row.canonical_json]) {
      if (typeof encoded !== 'string') continue;
      if (encoded.length > INPUT_LIMIT) { sourceTooLarge = true; continue; }
      validateJsonObjectText(encoded);
    }
  } catch { return null; }
  const kind = type === 'image' ? 'image_key' : 'file_key';
  const label = type === 'image' ? '图片' : '贴纸';
  let state = 'invalid_reference', key = null;
  try {
    if (sourceTooLarge) throw new Error('media_input_limit');
    let payload = object(native.body) ? native.body.content : undefined;
    if (typeof payload === 'string') {
      if (payload.length > INPUT_LIMIT) throw new Error('media_input_limit');
      validateJsonObjectText(payload);
      payload = JSON.parse(payload);
    }
    if (payload === undefined || payload === null) state = 'missing_reference';
    else if (object(payload)) {
      if (!Object.hasOwn(payload, kind)) state = 'missing_reference';
      else {
        // Resource keys stay opaque; URL/path/control/whitespace input cannot
        // manufacture a usable reference. Do not truncate into validity.
        const value = payload[kind];
        if (typeof value === 'string' && value.length > 0 && value.length <= KEY_LIMIT
          && !/[\s\x00-\x1f\x7f-\x9f/:\\]/u.test(value)) {
          key = value; state = 'reference_only';
        }
      }
    }
  } catch { /* Keep the invalid diagnosis without parser/private details. */ }
  const reason = state === 'reference_only' ? (type === 'sticker' ? 'media_resource_unsupported' : 'media_resource_unavailable')
    : state === 'missing_reference' ? 'media_reference_missing' : 'media_reference_invalid';
  const detail = state === 'reference_only' ? '仅保存资源引用' : state === 'missing_reference' ? '资源引用缺失' : '资源引用无效';
  const unsupported=type==='sticker'&&state==='reference_only';
  return { version: 1, type, text: unsupported ? '[贴纸] 已保存资源引用；飞书消息资源接口不支持读取贴纸'
    : `[${label}] ${detail}，尚无可用资源证据`, status: 'partial', reason,
    resource: { kind, key, state, availability: unsupported?'unsupported':'unverified' } };
}
