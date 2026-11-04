import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_IMAGE_SLOTS,createImageSlot,isImageSlot,imageSlotDisplay,createImageContext,
  attestVerifiedImageRead,createVerifiedImageResolution,isVerifiedImageResolution} from '../src/adapters/lark-im/media-image-slot.mjs';

const input={slot_id:'/content/0/1',order:0,message_type:'post',representation:'content',reference_kind:'image_key',key:'synthetic_image_alpha'};
const binding={schema:'synthetic_test_binding',database:{path:'synthetic',dev:'1',ino:'2'},source_id:'lark.im',
  external_id:'synthetic_message_alpha',external_version:'synthetic_v1',content_hash:'a'.repeat(64),container_id:'synthetic_chat',
  account_key:'b'.repeat(64),type:'image',key:input.key,message_type:'post',reference_kind:'image_key'};
function fixture(overrides={}) {
  const source={...binding,...overrides},plain=createImageSlot(input),context=createImageContext([{slot:plain,binding:source}]);
  const slot=createImageSlot(input,{imageContext:context});
  // Pure unit mock of the trusted store boundary. Actual filesystem/binding
  // verification is covered by the resource store/projection integration tests.
  const read=attestVerifiedImageRead(source,{status:'available',path:'synthetic-private-path'});
  return {source,context,slot,read,evidence:createVerifiedImageResolution(slot,source,read,context)};
}

for(const context of [undefined,null,false,true,0,1,'synthetic',{},[]])test(`ordinary context ${JSON.stringify(context)} never throws or authorizes`,()=>{
  const s=createImageSlot(input,{imageContext:context});assert(isImageSlot(s));
  assert.equal(imageSlotDisplay(s,{available:true}).status,'partial');
});
test('finite reference diagnosis keeps keys out of text',()=>{
  for(const [key,state] of [[null,'missing_reference'],['','missing_reference'],['https://invalid','invalid_reference'],['with whitespace','invalid_reference'],[input.key,'reference_only']]) {
    const s=createImageSlot({...input,key});assert.equal(s.reference_state,state);assert.equal(imageSlotDisplay(s).status,'partial');
    if(key)assert(!imageSlotDisplay(s).text.includes(key));
  }
  const conflict=createImageSlot({...input,reference_state:'conflicting_reference'});
  assert.equal(conflict.key,null);assert.equal(imageSlotDisplay(conflict).reason,'media_reference_invalid');
});
test('occurrence cap is exact and rejects invalid shape rather than truncating',()=>{
  assert.equal(MAX_IMAGE_SLOTS,64);assert(createImageSlot({...input,order:63}));assert.equal(createImageSlot({...input,order:64}),null);
  assert.equal(createImageSlot({...input,slot_id:'not-a-pointer'}),null);
  assert.equal(createImageSlot({...input,reference_state:'available'}),null);
});
test('trusted read plus same context and occurrence can resolve without exposing paths',()=>{
  const f=fixture();assert(isVerifiedImageResolution(f.slot,f.evidence));assert.equal(imageSlotDisplay(f.slot,f.evidence).status,'rendered');
  assert(!imageSlotDisplay(f.slot,f.evidence).text.includes('synthetic-private-path'));
});
test('serialized read, evidence and context lose authority',()=>{
  const f=fixture();assert.equal(createVerifiedImageResolution(f.slot,f.source,{...f.read},f.context),null);
  assert.equal(createVerifiedImageResolution(f.slot,f.source,f.read,{}),null);
  assert.equal(imageSlotDisplay(f.slot,JSON.parse(JSON.stringify(f.evidence))).status,'partial');
});
for(const change of [{external_id:'synthetic_other_message'},{account_key:'c'.repeat(64)},{external_version:'synthetic_v2'},{content_hash:'d'.repeat(64)}])
  test(`another source context ${Object.keys(change)[0]} cannot borrow a valid receipt`,()=>{
    const a=fixture(),b=fixture(change);
    assert.equal(imageSlotDisplay(b.slot,a.evidence).status,'partial');
    assert.equal(createVerifiedImageResolution(b.slot,b.source,a.read,b.context),null);
  });
test('another occurrence, alias or resource cannot borrow a valid receipt',()=>{
  const f=fixture();
  for(const change of [{order:1,slot_id:'/content/0/2'},{alias:'synthetic_alias'},{key:'synthetic_other_key'}]) {
    const slot=createImageSlot({...input,...change},{imageContext:f.context});
    assert.equal(imageSlotDisplay(slot,f.evidence).status,'partial');
    assert.equal(createVerifiedImageResolution(slot,f.source,f.read,f.context),null);
  }
});
