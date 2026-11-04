// @ts-check
import { createHash } from 'node:crypto';
import { validateJsonObjectText } from '../../../dist/core/json-text-patch.js';
import { renderApiMessageContent } from './raw-message.mjs';
import { renderMediaProjection } from './media-content.mjs';
import { createImageSlot, isImageSlot, MAX_IMAGE_SLOTS } from './media-image-slot.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const sha=value=>createHash('sha256').update(value).digest('hex');
const LIMIT=256*1024;
const incompleteReasons=new Set(['media_slot_limit','card_image_slot_limit','card_input_limit','card_output_limit',
  'card_node_limit','card_depth_limit','card_cycle','invalid_card_json','unsupported_card_structure',
  'unsupported_post_structure','unsupported_post_element','media_reference_missing','media_reference_invalid']);
const fail=reason=>({version:1,slots:[],issues:[reason],complete:false});

/** Reuse the selected renderer traversal; never independently choose fallback.
 * This proves references, not endpoint eligibility, file contents or readiness.
 * @param {Record<string,any>} row @param {Record<string,any>} canonical @param {Record<string,any>} raw */
export function extractMessageResourceReferences(row,canonical,raw) {
  try {
    if(row.source_id!=='lark.im'||row.record_type!=='lark.im.message'||typeof row.raw_json!=='string'
      ||row.raw_json.length>LIMIT||typeof row.canonical_json!=='string'||row.canonical_json.length>LIMIT
      ||sha(row.raw_json)!==row.content_hash)return fail('media_source_binding_invalid');
    validateJsonObjectText(row.raw_json);validateJsonObjectText(row.canonical_json);
    const parsed=JSON.parse(row.raw_json),canon=JSON.parse(row.canonical_json);
    if(JSON.stringify(parsed)!==JSON.stringify(raw)||JSON.stringify(canon)!==JSON.stringify(canonical))return fail('media_source_binding_invalid');
    if(Object.hasOwn(raw,'raw_api')&&!object(raw.raw_api))return fail('media_source_binding_invalid');
    const native=Object.hasOwn(raw,'raw_api')?raw.raw_api:raw,type=native.msg_type||native.message_type;
    if(!['image','post','interactive'].includes(type))return {version:1,slots:[],issues:[],complete:true};
    if(typeof row.external_id!=='string'||!row.external_id||typeof row.container_id!=='string'||!row.container_id
      ||native.message_id!==row.external_id||native.chat_id!==row.container_id
      ||[canonical,raw,native].some(value=>value.deleted===true
        ||[value.msg_type,value.message_type].some(t=>t!=null&&t!==type)
        ||value.message_id!=null&&value.message_id!==row.external_id
        ||[value.chat_id,value.chat?.id,value.chat?.chat_id].some(id=>id!=null&&id!==row.container_id))
      ||[raw,native].some(value=>value.id!=null&&value.id!==row.external_id))return fail('media_source_binding_invalid');
    if(type!=='image') {
      let payload=native.body?.content;
      if(typeof payload==='string') {if(payload.length>LIMIT)return fail('media_reference_limit');validateJsonObjectText(payload);payload=JSON.parse(payload);}
      if(!object(payload))return fail('media_reference_invalid');
      // Declared nested JSON slots retain the same duplicate-key/numeric checks;
      // ordinary prose is not recursively interpreted as JSON.
      for(const name of ['json_card','json_attachment'])if(typeof payload[name]==='string') {
        if(payload[name].length>LIMIT)return fail('media_reference_limit');validateJsonObjectText(payload[name]);
      }
    }
    let slots,reason=null;
    if(type==='image') {
      const media=renderMediaProjection(row,canonical,raw);
      if(!media)return fail('media_source_binding_invalid');
      slots=[createImageSlot({slot_id:'/image_key',order:0,message_type:'image',representation:'body.content',
        reference_kind:'image_key',reference_state:media.resource.state,key:media.resource.key})];
    } else {
      const rendered=renderApiMessageContent(native);
      slots=rendered.media_slots??[];reason=rendered.reason;
    }
    if(!Array.isArray(slots)||slots.length>MAX_IMAGE_SLOTS||slots.some((s,i)=>!isImageSlot(s)||s.order!==i||s.message_type!==type)
      ||new Set(slots.map(s=>s.slot_id)).size!==slots.length)return fail('media_reference_invalid');
    const issues=[];
    if(reason&&incompleteReasons.has(reason))issues.push(reason);
    for(const s of slots)if(s.reference_state!=='reference_only')issues.push(s.reference_state==='missing_reference'?'media_reference_missing':'media_reference_invalid');
    return {version:1,slots,issues:[...new Set(issues)],complete:issues.length===0};
  } catch {return fail('media_reference_invalid');}
}

/** Default capability is intentionally only the previously established native
 * top-level image endpoint. Embedded post/card eligibility is not inferred.
 * `capability` is internal dependency injection for authored contract tests;
 * no CLI option or source/canonical field can replace this decision.
 * @param {Record<string,any>} slot @param {((slot:Record<string,any>)=>unknown)|undefined} [capability] */
export function imageResourceCapability(slot,capability) {
  if(!isImageSlot(slot)||slot.reference_state!=='reference_only')return 'invalid';
  if(capability!==undefined) {
    if(typeof capability!=='function')return 'unverified';
    return capability(slot)==='message_image'?'message_image':'unverified';
  }
  return slot.message_type==='image'&&slot.reference_kind==='image_key'?'message_image':'unverified';
}

/** A media view for one exact typed occurrence. Store binding re-extracts this
 * occurrence independently before accepting it. @param {Record<string,any>} slot */
export function mediaFromImageSlot(slot) {
  if(!isImageSlot(slot))return null;
  return {version:1,type:'image',status:'partial',reason:'media_resource_unavailable',text:'[图片] 资源尚未验证',
    resource:{kind:slot.reference_kind,key:slot.key,state:slot.reference_state},slot};
}
