// @ts-check
import { makeMediaResourceBinding, makeMediaResourceBindings, makeMediaPendingSourceFence, readMediaResource, resourceStorePath } from './media-resource-store.mjs';
import { projectionAccount } from './message-projection-evidence.mjs';
import { isHistoryCommandBudget } from '../../maintenance/history-command-budget.mjs';
import { extractMessageResourceReferences, imageResourceCapability, mediaFromImageSlot } from './media-resource-references.mjs';
import { createImageContext, createVerifiedImageResolution } from './media-image-slot.mjs';

const imageContexts=new WeakMap();
function sourceFingerprint(row,canonical,raw) {
  try {
    const account=projectionAccount(row,canonical,raw);
    if(account.state!=='verified'||JSON.stringify(JSON.parse(row.canonical_json))!==JSON.stringify(canonical)
      ||JSON.stringify(JSON.parse(row.raw_json))!==JSON.stringify(raw))return null;
    const fence=makeMediaPendingSourceFence(row);
    return fence?JSON.stringify([fence,account.account_key]):null;
  } catch {return null;}
}

/** A terminal re-projection may reuse only this read's exact row/account proof.
 * @param {Record<string,any>} row @param {Record<string,any>} canonical @param {Record<string,any>} raw @param {unknown} context */
export function isCurrentImageContext(row,canonical,raw,context) {
  try {return context!==null&&typeof context==='object'&&imageContexts.has(context)
    &&imageContexts.get(context)===sourceFingerprint(row,canonical,raw);} catch {return false;}
}

/** Bounded local reads only. JSON-safe reference/resource data is separate from
 * the in-process resolver/context. Default embedded endpoint eligibility stays
 * unverified until the typed contract is established; no request is made here.
 * @param {string} db @param {string|undefined} resourceDir @param {Record<string,any>} row
 * @param {Record<string,any>} canonical @param {Record<string,any>} raw @param {Record<string,any>} [deps] */
export function projectEmbeddedMediaResources(db,resourceDir,row,canonical,raw,deps={}) {
  const budget=deps.executionBudget;
  if(budget!==undefined&&!isHistoryCommandBudget(budget))throw new TypeError('invalid embedded projection budget');
  budget?.assertReady();
  const extracted=extractMessageResourceReferences(row,canonical,raw),issues=[...extracted.issues],resources=[];
  budget?.assertReady();
  const account=projectionAccount(row,canonical,raw),fingerprint=sourceFingerprint(row,canonical,raw);
  const medias=extracted.slots.map(mediaFromImageSlot);
  const bindings=account.state==='verified'?makeMediaResourceBindings(db,row,account.account_key,medias):medias.map(()=>null);
  budget?.assertReady();
  const entries=extracted.slots.flatMap((slot,index)=>bindings[index]?[{slot,binding:bindings[index]}]:[]);
  const imageContext=createImageContext(entries),verified=new Map(),checked=new Map();
  if(fingerprint)imageContexts.set(imageContext,fingerprint);
  for(const [index,slot] of extracted.slots.entries()) {
    budget?.assertReady();
    const binding=bindings[index],capability=imageResourceCapability(slot,deps.resourceCapability);
    let value;
    if(!binding)value={status:'blocked',reason:account.state==='verified'?'source_binding_invalid':'account_unverified'};
    else {
      const id=JSON.stringify(binding);
      if(!checked.has(id))checked.set(id,readMediaResource(resourceStorePath(db,resourceDir),binding,{executionBudget:budget}));
      value=checked.get(id);
      if(value.status==='available')verified.set(JSON.stringify(slot),{binding,read:value});
      else if(value.status==='missing'&&capability!=='message_image')value={status:'blocked',reason:capability==='invalid'?'media_reference_invalid':'resource_endpoint_unverified'};
    }
    budget?.assertReady();
    resources.push({slot_id:slot.slot_id,order:slot.order,reference_kind:slot.reference_kind,...value});
    if(value.status!=='available')issues.push(value.reason||'media_resource_unavailable');
  }
  const resolveImage=slot=>{
    const item=verified.get(JSON.stringify(slot));
    return item?createVerifiedImageResolution(slot,item.binding,item.read,imageContext):null;
  };
  return {version:1,slots:extracted.slots,resources,issues:[...new Set(issues)],complete:extracted.complete,imageContext,resolveImage};
}

/** Add only independently revalidated local bytes to a pure source projection.
 * @param {string} db @param {string|undefined} resourceDir
 * @param {Record<string,any>} row @param {Record<string,any>} canonical
 * @param {Record<string,any>} raw
 * @param {import('./media-content.mjs').MediaProjection|null} media
 * @param {{executionBudget?:ReturnType<typeof import('../../maintenance/history-command-budget.mjs').createHistoryCommandBudget>}} [deps]
 * @returns {import('./media-content.mjs').MediaProjection|null} */
export function projectMediaResource(db,resourceDir,row,canonical,raw,media,deps={}) {
  const budget=deps.executionBudget;
  if(budget!==undefined&&!isHistoryCommandBudget(budget))throw new TypeError('invalid media projection budget');
  budget?.assertReady();
  if(!media || media.type!=='image' || media.resource.state!=='reference_only')return media;
  const account=projectionAccount(row,canonical,raw);
  if(account.state!=='verified')return media;
  const binding=makeMediaResourceBinding(db,row,account.account_key,media);
  if(!binding)return media;
  const resource=readMediaResource(resourceStorePath(db,resourceDir),binding,{executionBudget:budget});
  budget?.assertReady();
  if(resource.status!=='available')return resource.status==='invalid'
    ? {...media,text:'[图片] 本地资源未通过验证',reason:'media_resource_invalid',
      resource:{...media.resource,availability:'invalid',verification_reason:resource.reason}}
    : media;
  return {...media,status:'rendered',reason:null,text:'[图片] 本地资源已验证（未生成文字描述）',
    resource:{...media.resource,...resource,state:'available',availability:'available'}};
}
