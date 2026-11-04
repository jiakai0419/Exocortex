// @ts-check
/** Pure reference and in-process read evidence. No filesystem/network access. */
export const MAX_IMAGE_SLOTS = 64;
const slotKeys=['version','slot_id','order','message_type','representation','reference_kind','reference_state','key','alias'];
const contexts=new WeakMap(), slotContexts=new WeakMap(), reads=new WeakMap(), resolutions=new WeakMap();
/** @param {unknown} value @returns {value is Record<string,any>} */
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f-\x9f]/u.test(value);
const key=value=>text(value,2048)&&!/[\s/:\\]/u.test(value);
const signature=slot=>JSON.stringify(slotKeys.map(k=>slot[k]));
const bindingSignature=binding=>JSON.stringify(binding);

/** A slot is an occurrence, never file or endpoint authority.
 * @param {Record<string,any>} input
 * @param {{imageContext?:unknown}} [options]
 * @returns {Record<string,any>|null} */
export function createImageSlot(input,options={}) {
  if(!object(input)||!text(input.slot_id,4096)||!input.slot_id.startsWith('/')||!Number.isSafeInteger(input.order)
    ||input.order<0||input.order>=MAX_IMAGE_SLOTS||!['image','post','interactive'].includes(input.message_type)
    ||!text(input.representation,128)||!['image_key','attachment_origin_key'].includes(input.reference_kind))return null;
  let state=input.reference_state,resourceKey=null,alias=null;
  if(state!==undefined&&!['reference_only','missing_reference','invalid_reference','conflicting_reference'].includes(state))return null;
  if(input.alias!==undefined&&input.alias!==null) {
    if(!key(input.alias))state='invalid_reference';else alias=input.alias;
  }
  if(!['missing_reference','invalid_reference','conflicting_reference'].includes(state)) {
    state=input.key===null||input.key===undefined||input.key===''?'missing_reference':key(input.key)?'reference_only':'invalid_reference';
    if(state==='reference_only')resourceKey=input.key;
  }
  const slot=Object.freeze({version:1,slot_id:input.slot_id,order:input.order,message_type:input.message_type,
    representation:input.representation,reference_kind:input.reference_kind,reference_state:state,key:resourceKey,alias});
  const context=object(options.imageContext)?contexts.get(options.imageContext):null;
  if(context?.entries.has(signature(slot)))slotContexts.set(slot,options.imageContext);
  return slot;
}

/** @param {unknown} value */
export function isImageSlot(value) {
  if(!object(value)||Object.keys(value).length!==slotKeys.length||slotKeys.some(k=>!Object.hasOwn(value,k))||value.version!==1)return false;
  const normalized=createImageSlot(value);
  return normalized!==null&&signature(normalized)===signature(value);
}

/** Internal projection boundary. Entries were independently extracted from one
 * exact row; context alone does not prove a readable image.
 * @param {Array<{slot:Record<string,any>,binding:Record<string,any>}>} entries */
export function createImageContext(entries) {
  if(!Array.isArray(entries)||entries.length>MAX_IMAGE_SLOTS)throw new TypeError('invalid image context');
  const values=new Map();let source=null;
  for(const entry of entries) {
    if(!isImageSlot(entry.slot)||!object(entry.binding)||entry.slot.reference_state!=='reference_only'
      ||entry.binding.type!=='image'||entry.binding.key!==entry.slot.key)throw new TypeError('invalid image context');
    const {key:_key,reference_kind:_referenceKind,...basis}=entry.binding,basisText=JSON.stringify(basis),id=signature(entry.slot),bound=bindingSignature(entry.binding);
    if(source!==null&&source!==basisText||values.has(id)&&values.get(id)!==bound)throw new TypeError('conflicting image context');
    source=basisText;values.set(id,bound);
  }
  const context=Object.freeze({});contexts.set(context,{entries:values});return context;
}

/** Store-only boundary: invoke only after full binding/file/byte verification.
 * The returned object's JSON shape remains the legacy available-read contract.
 * @param {Record<string,any>} binding @param {Record<string,any>} result */
export function attestVerifiedImageRead(binding,result) {
  if(!object(binding)||binding.type!=='image'||!key(binding.key)||!object(result)||result.status!=='available')
    throw new TypeError('invalid verified image read');
  const value=Object.freeze({...result});reads.set(value,bindingSignature(binding));return value;
}

/** Only the actual store-read object, exact binding and same projection context
 * can yield a renderer credential. JSON copies and status booleans cannot.
 * @param {Record<string,any>} slot @param {Record<string,any>} binding
 * @param {unknown} resource @param {unknown} context */
export function createVerifiedImageResolution(slot,binding,resource,context) {
  if(!isImageSlot(slot)||!object(resource)||!object(context)||slotContexts.get(slot)!==context)return null;
  const expected=contexts.get(context)?.entries.get(signature(slot));
  if(!expected||expected!==bindingSignature(binding)||reads.get(resource)!==expected)return null;
  const value=Object.freeze({});resolutions.set(value,{context,slot:signature(slot)});return value;
}

/** @param {Record<string,any>} slot @param {unknown} value */
export function isVerifiedImageResolution(slot,value) {
  const evidence=object(value)&&resolutions.get(value);
  return Boolean(isImageSlot(slot)&&evidence&&evidence.context===slotContexts.get(slot)&&evidence.slot===signature(slot));
}

/** Fixed neutral text; source keys, local paths and arbitrary receipt text never
 * enter the terminal renderer. @param {Record<string,any>} slot @param {unknown} [resolution] */
export function imageSlotDisplay(slot,resolution) {
  if(isVerifiedImageResolution(slot,resolution))return {text:'[图片] 本地资源已验证（未生成文字描述）',status:'rendered',reason:null};
  const state=isImageSlot(slot)?slot.reference_state:'invalid_reference';
  if(state==='missing_reference')return {text:'[图片] 资源引用缺失',status:'partial',reason:'media_reference_missing'};
  if(state==='invalid_reference'||state==='conflicting_reference')return {text:state==='conflicting_reference'?'[图片] 资源引用冲突':'[图片] 资源引用无效',status:'partial',reason:'media_reference_invalid'};
  return {text:'[图片] 资源尚未验证',status:'partial',reason:'media_resource_unavailable'};
}
