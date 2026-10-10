import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceRelation, sourceProof, parseEvidence, compareObservation } from '../dist/core/lark-observation.js';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { normalizeStoredRecords, normalizeBoundedReplayRecords } from '../dist/storage/sqlite/record-storage.js';

// All data is invented. No captured payload or real identifiers are used.
const clone = value => JSON.parse(JSON.stringify(value));
const native = (payload={text:'Invented text'}) => ({message_id:'om_contract',msg_type:'text',
  create_time:'1800000000000',update_time:'1800000001000',chat_id:'oc_contract',
  sender:{id:'ou_contract',id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify(payload)},mentions:[]});
const row = raw => recordFromMessage(normalizeApiMessage(raw),'invented.scope','received');
const relation = (a,b) => sourceRelation(JSON.stringify(a),JSON.stringify(b));

test('same evidence is deterministic; object and declared JSON property order are representation only',()=>{
  const a=native({text:'Invented',extra:{a:1,b:2}}),b=Object.fromEntries(Object.entries(a).reverse());
  assert.equal(relation(a,clone(a)),'exact');assert.equal(relation(a,b),'json_representation');
  b.body={content:' { "extra": { "b": 2, "a": 1 }, "text": "Invented" } '};
  assert.equal(relation(a,b),'json_representation');assert.equal(row(a).body,row(b).body);
});
test('unknown fields, arrays, missing/null, scalar types and calendar references remain significant',()=>{
  const a=native({text:'Invented',unknown:[1,2]});
  for(const payload of [{text:'Invented',unknown:[2,1]},{text:'Invented',unknown:null},{text:'Invented'},
    {text:'Invented',unknown:['1',2]}]) assert.equal(relation(a,native(payload)),'different');
  const c={...native({title:'Invented meeting',event_id:'event-invented',open_calendar_id:'calendar-a',start_time:100}),msg_type:'general_calendar'};
  const d=clone(c);d.body.content=d.body.content.replace('calendar-a','calendar-b');assert.equal(relation(c,d),'different');
});
test('proof refuses duplicate keys, lossy numbers, malformed and non-string native content',()=>{
  for(const text of ['{"a":1,"a":2}','{"n":9007199254740993}','{"n":1.1}','{"n":-0}','{"a":1}x','{"a":}']) assert.throws(()=>parseEvidence(text));
  const a=native(),b=clone(a);b.body.content='{"text":"Invented","unknown":9007199254740993}';
  assert.equal(relation(a,b),'unverified');assert.equal(sourceRelation(JSON.stringify(b),JSON.stringify(b)),'exact');
  b.body.content={encoded_json_document:{text:'Invented text'}};assert.equal(relation(a,b),'unverified');
});

function card(swapped=false, names=['Invented A','Invented B']) {
  const ids=swapped?['b','a']:['a','b'];
  return {...native(),msg_type:'interactive',body:{content:JSON.stringify({
    json_card:JSON.stringify({elements:['a','b'].map(id=>({tag:'at',property:{userID:`native-${id}`}}))}),
    json_attachment:{at_users:Object.fromEntries(['a','b'].map((id,index)=>[`native-${id}`,
      {mention_key:`@_user_${swapped?2-index:index+1}`,user_id:`native-${id}`,content:names[index]}]))},
  })},mentions:ids.map((id,index)=>({key:`@_user_${index+1}`,id:`ou_invented_${id}`,id_type:'open_id',name:names[id==='a'?0:1]}))};
}
test('coordinated alias renaming preserves every typed reference position, not just displayed text',()=>{
  const a=card(),b=card(true);assert.equal(relation(a,b),'reference_rename');
  assert.equal(row(a).body,'@Invented A\n@Invented B');assert.equal(row(a).body,row(b).body);
  assert.notEqual(row(a).content_hash,row(b).content_hash);
  assert.equal(compareObservation(row(a),row(b)).equivalent,true);
});
test('same-name targets can have identical text and sets while reference positions change',()=>{
  const a=card(false,['Same invented name','Same invented name']),b=clone(a);
  const content=JSON.parse(b.body.content);for(const entry of Object.values(content.json_attachment.at_users))entry.mention_key=entry.mention_key==='@_user_1'?'@_user_2':'@_user_1';b.body.content=JSON.stringify(content);
  assert.equal(row(a).body,row(b).body);assert.equal(relation(a,b),'different');
});
test('hidden, unknown, direct text consumers and namespace changes prevent an alias proof',()=>{
  for(const mutate of [
    c=>{c.action={value:'@_user_1'};},
    c=>{c.elements.push({tag:'plain_text',content:'@_user_1'});},
    c=>{c.elements.push({tag:'future-consumer',value:'@_user_1'});},
  ]) {
    const a=card(),b=card(true);for(const raw of [a,b]){const outer=JSON.parse(raw.body.content),inner=JSON.parse(outer.json_card);mutate(inner);outer.json_card=JSON.stringify(inner);raw.body.content=JSON.stringify(outer);}
    assert.equal(sourceProof(JSON.stringify(a)).references,null);assert.equal(relation(a,b),'different');
  }
  const a=card(),b=card(true);b.mentions[0].id_type='user_id';assert.equal(relation(a,b),'different');
});
test('ambiguous definitions, dangling aliases and unknown outer fields retain raw but cannot prove rename',()=>{
  for(const mutate of [r=>r.mentions.push(clone(r.mentions[0])),r=>r.mentions.pop(),r=>r.future_field={token:'@_user_1'}]){
    const a=card();mutate(a);assert.equal(sourceProof(JSON.stringify(a)).references,null);
  }
});

function consumerCard(field, label, idType='user_id') {
  return {...native(),msg_type:'interactive',mentions:[
    {key:'@_user_1',id:'typed-alice',id_type:idType,name:'Invented Alice'},
  ],body:{content:JSON.stringify({
    json_card:{elements:[{tag:'at',property:{[field]:label}}]},
    json_attachment:{at_users:{bridge:{mention_key:'@_user_1',user_id:'native-alias',content:'Invented Alice'}}},
  })}};
}
test('reference proofs preserve the consumer namespace and never resolve a dangling reference by another domain',()=>{
  for(const [field,before,after] of [
    ['user_id','typed-alice','bridge'],
    ['user_id','typed-alice','native-alias'],
    ['user_id','typed-alice','@_user_1'],
    ['userID','bridge','typed-alice'],
    ['userID','bridge','@_user_1'],
    ['userID','bridge','missing-alias'],
  ]) {
    const a=consumerCard(field,before),b=consumerCard(field,after);
    assert.equal(row(a).body,'@Invented Alice');assert.equal(row(b).body,'@未知用户');
    assert.equal(sourceProof(JSON.stringify(b)).references,null,`${field}:${after}`);
    assert.equal(relation(a,b),'different');assert.equal(compareObservation(row(a),row(b)).equivalent,false);
  }
  const crossNamespace=consumerCard('user_id','typed-alice','open_id');
  assert.equal(row(crossNamespace).body,'@未知用户');
  assert.equal(sourceProof(JSON.stringify(crossNamespace)).references,null);
});
test('an attachment alias may select a different typed identity with identical ID bytes and display name',()=>{
  const a=consumerCard('userID','bridge'),b=clone(a);
  for(const raw of [a,b])raw.mentions.push({key:'@_user_2',id:'typed-alice',id_type:'open_id',name:'Invented Alice'});
  const content=JSON.parse(b.body.content);content.json_attachment.at_users.bridge.mention_key='@_user_2';
  b.body.content=JSON.stringify(content);
  assert.equal(row(a).body,row(b).body);assert.equal(row(a).body,'@Invented Alice');
  assert.equal(relation(a,b),'different','equal bytes in different namespaces are different source identities');
});
test('valid native aliases retain their declared attachment target while mention keys are renamed',()=>{
  const a=consumerCard('userID','bridge'),b=clone(a);
  b.mentions[0].key='@_user_42';
  const content=JSON.parse(b.body.content);content.json_attachment.at_users.bridge.mention_key='@_user_42';
  content.json_card.elements[0].property.userID='native-alias';b.body.content=JSON.stringify(content);
  assert.equal(row(a).body,row(b).body);assert.equal(relation(a,b),'reference_rename');
});
test('normal and replay batches reject equal-version source conflicts and select representation deterministically',()=>{
  const a=row(native({text:'A'})),b=row(native({text:'B'}));
  for(const normalize of [items=>normalizeStoredRecords(items,'lark.im'),items=>normalizeBoundedReplayRecords(items,'lark.im')]){
    assert.throws(()=>normalize([a,b]),/ambiguous/);assert.throws(()=>normalize([b,a]),/ambiguous/);
    const c=row(card()),d=row(card(true));assert.deepEqual(normalize([c,d]),normalize([d,c]));
  }
});
test('version, identity and projection have separate outcomes',()=>{
  const a=row(native()),b={...a,external_version:'1800000002000'};
  assert.equal(compareObservation(a,b).version,'newer');assert.equal(compareObservation(a,b).projection,'equal');
  assert.equal(compareObservation(a,{...a,container_id:'oc_other'}).identity,'conflict');
  assert.equal(compareObservation(a,{...a,body:'A local projection'}).representation,'exact');
});
