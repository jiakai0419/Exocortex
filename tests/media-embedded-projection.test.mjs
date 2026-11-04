import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {renderApiMessageContent} from '../src/adapters/lark-im/raw-message.mjs';
import {extractMessageResourceReferences,mediaFromImageSlot,imageResourceCapability} from '../src/adapters/lark-im/media-resource-references.mjs';
import {makeMediaResourceBinding,makeMediaResourceBindings,publishMediaResource,readMediaResource} from '../src/adapters/lark-im/media-resource-store.mjs';
import {projectEmbeddedMediaResources,isCurrentImageContext} from '../src/adapters/lark-im/media-resource-projection.mjs';
import {projectionAccount} from '../src/adapters/lark-im/message-projection-evidence.mjs';
import {createHistoryCommandBudget} from '../src/maintenance/history-command-budget.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex'),SELF='ou_synthetic_embedded_owner';
const crc=bytes=>{let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
const chunk=(name,b)=>{const data=Buffer.concat([Buffer.from(name),b]),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(b.length);c.writeUInt32BE(crc(data));return Buffer.concat([n,data,c]);};
const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
const PNG=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,9,80,190,255]))),chunk('IEND',Buffer.alloc(0))]);
const permitted=()=> 'message_image'; // trusted test dependency; no CLI/source switch
function fixture(t,keys=['synthetic_alpha','synthetic_alpha','synthetic_beta']) {
  const dir=mkdtempSync(join(tmpdir(),'synthetic-embedded-projection-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=join(dir,'fixture.sqlite');writeFileSync(db,'Synthetic local identity file',{mode:0o600});
  const raw={message_id:'om_synthetic_embedded',chat_id:'oc_synthetic_embedded',msg_type:'post',create_time:'1738540800000',
    sender:{id:SELF,id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({title:'Synthetic journal',content:[[
      {tag:'text',text:'Synthetic before '},...keys.map(image_key=>({tag:'img',image_key})),{tag:'text',text:' Synthetic after'}]]})}};
  const canonical={message_id:raw.message_id,chat_id:raw.chat_id,msg_type:'post',sender_id:SELF,sender_id_type:'open_id',sender_type:'user'};
  const row={id:1,source_id:'lark.im',record_type:'lark.im.message',external_id:raw.message_id,container_id:raw.chat_id,
    external_version:'synthetic_version_1',actor_id:SELF,direction:'sent',occurred_at:'2025-02-03T00:00:00.000Z',occurred_at_ms:1738540800000,
    body:'Synthetic stored body',raw_json:JSON.stringify(raw),canonical_json:JSON.stringify(canonical)};
  row.content_hash=sha(row.raw_json);
  const refs=extractMessageResourceReferences(row,canonical,raw),account=projectionAccount(row,canonical,raw);
  assert.equal(account.state,'verified');assert.equal(refs.slots.length,keys.length);
  const bindings=makeMediaResourceBindings(db,row,account.account_key,refs.slots.map(mediaFromImageSlot));
  const f={dir,db,cache:join(dir,'resources'),raw,canonical,row,refs,account,bindings};
  f.publish=()=>{for(const binding of bindings)assert.equal(publishMediaResource(f.cache,binding,PNG,{nowMs:1738540800100}).status,'available');};
  f.project=deps=>projectEmbeddedMediaResources(db,f.cache,row,canonical,raw,deps);
  return f;
}

test('selected post occurrences remain ordered; repeated key shares a typed binding',t=>{
  const f=fixture(t);assert.equal(f.refs.complete,true);assert.deepEqual(f.refs.slots.map(s=>s.order),[0,1,2]);
  assert.equal(new Set(f.refs.slots.map(s=>s.slot_id)).size,3);
  assert.deepEqual(f.bindings[0],f.bindings[1]);assert.notDeepEqual(f.bindings[0],f.bindings[2]);
  assert.equal(f.bindings[0].schema,'lark_media_resource_binding/v2');assert.equal(f.bindings[0].reference_kind,'image_key');
});
test('default key-only embedded capability stays unverified without files',t=>{
  const f=fixture(t);const p=f.project();
  assert(p.resources.every(r=>r.status==='blocked'&&r.reason==='resource_endpoint_unverified'));
  assert.equal(p.complete,true,'this is extraction, not resource completeness');
  const rendered=renderApiMessageContent(f.raw,{imageContext:p.imageContext,resolveImage:p.resolveImage});
  assert.equal(rendered.status,'partial');assert.equal(rendered.reason,'media_resource_unavailable');
});
test('legitimate exact verified local bytes do not require a new endpoint capability',t=>{
  const f=fixture(t);f.publish();const p=f.project();
  assert(p.resources.every(r=>r.status==='available'));
  assert.equal(renderApiMessageContent(f.raw,{imageContext:p.imageContext,resolveImage:p.resolveImage}).status,'rendered');
});
test('internally established route plus exact actual files resolves every occurrence',t=>{
  const f=fixture(t);f.publish();const p=f.project({resourceCapability:permitted});
  assert(p.resources.every(r=>r.status==='available'));assert(isCurrentImageContext(f.row,f.canonical,f.raw,p.imageContext));
  const rendered=renderApiMessageContent(f.raw,{imageContext:p.imageContext,resolveImage:p.resolveImage});
  assert.equal(rendered.status,'rendered');assert.equal(rendered.reason,null);
  assert.equal((rendered.text.match(/本地资源已验证/g)||[]).length,3);
  assert(!rendered.text.includes(f.cache));assert(!rendered.text.includes('synthetic_alpha'));
});
test('ordinary available JSON and cloned contexts do not supply read evidence',t=>{
  const f=fixture(t);f.publish();const p=f.project({resourceCapability:permitted});
  for(const opts of [{resolveImage:()=>({status:'available'})},{imageContext:{},resolveImage:p.resolveImage},
    {imageContext:p.imageContext,resolveImage:()=>JSON.parse(JSON.stringify(p.resources[0]))}])
    assert.equal(renderApiMessageContent(f.raw,opts).status,'partial');
});
for(const field of ['external_version','content_hash','actor_id','container_id'])test(`changed ${field} cannot reuse a read context`,t=>{
  const f=fixture(t);f.publish();const p=f.project({resourceCapability:permitted});
  assert.equal(isCurrentImageContext({...f.row,[field]:'synthetic_changed'},f.canonical,f.raw,p.imageContext),false);
});
test('changed source/account canonical data cannot reuse a read context',t=>{
  const f=fixture(t);f.publish();const p=f.project({resourceCapability:permitted});
  assert.equal(isCurrentImageContext(f.row,{...f.canonical,sender_name_account_key:'c'.repeat(64)},f.raw,p.imageContext),false);
  assert.equal(isCurrentImageContext(f.row,f.canonical,{...f.raw,message_id:'synthetic_other'},p.imageContext),false);
});
test('missing, changed bytes and wrong version stay incomplete through actual reads',t=>{
  const f=fixture(t,['synthetic_one']);
  assert.equal(f.project({resourceCapability:permitted}).resources[0].status,'missing');f.publish();
  const available=readMediaResource(f.cache,f.bindings[0]);writeFileSync(available.path,Buffer.from('Synthetic invalid image'),{mode:0o600});
  assert.equal(f.project({resourceCapability:permitted}).resources[0].status,'invalid');
  const changed={...f.row,external_version:'synthetic_later'};
  assert.equal(projectEmbeddedMediaResources(f.db,f.cache,changed,f.canonical,f.raw,{resourceCapability:permitted}).resources[0].status,'missing');
});
test('v1 and v2 manifests cannot be borrowed by changing type/schema fields',t=>{
  const f=fixture(t,['synthetic_one']);const legacy={...f.bindings[0],schema:'lark_media_resource_binding/v1'};
  delete legacy.message_type;delete legacy.reference_kind;
  assert.equal(publishMediaResource(f.cache,legacy,PNG,{nowMs:1738540800100}).status,'available');
  assert.equal(f.project({resourceCapability:permitted}).resources[0].status,'missing');
  const illegal={...f.bindings[0],schema:'lark_media_resource_binding/v1'};
  assert.equal(readMediaResource(f.cache,illegal).status,'invalid');
});
test('binding rejects changed occurrence/namespace/source instead of trusting media JSON',t=>{
  const f=fixture(t,['synthetic_one']),media=mediaFromImageSlot(f.refs.slots[0]);
  for(const changed of [{...media,slot:{...media.slot,slot_id:'/content/4/1'}},
    {...media,resource:{...media.resource,kind:'attachment_origin_key'}},
    {...media,resource:{...media.resource,key:'synthetic_different'}}])
    assert.equal(makeMediaResourceBinding(f.db,f.row,f.account.account_key,changed),null);
});
test('expired or invalid command budget starts no resource read',t=>{
  const f=fixture(t);f.publish();let clock=0;
  const budget=createHistoryCommandBudget({maxSeconds:5},{monotonicClock:()=>clock});clock=5000;
  assert.throws(()=>f.project({executionBudget:budget,resourceCapability:permitted}),e=>e.reason==='time_budget');
  assert.throws(()=>f.project({executionBudget:{assertReady(){}}}),/invalid embedded projection budget/);
});
test('source/canonical capability strings do not promote an embedded reference',t=>{
  const f=fixture(t,['synthetic_one']);
  assert.equal(imageResourceCapability({...f.refs.slots[0],available:true,capability:'message_image'}),'invalid');
  assert.equal(imageResourceCapability(f.refs.slots[0],true),'unverified');
});
