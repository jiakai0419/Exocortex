import assert from 'node:assert/strict';
import test from 'node:test';
import { createLegacyCardFixture, snapshot, messages } from './helpers/card-projection-fixture.mjs';
import { renderApiMessageContent } from '../src/adapters/lark-im/raw-message.mjs';
import { sqliteExec, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';
import { projectionAccount } from '../src/adapters/lark-im/message-projection-evidence.mjs';
import { extractMessageResourceReferences, mediaFromImageSlot } from '../src/adapters/lark-im/media-resource-references.mjs';
import { makeMediaResourceBindings, publishMediaResource, resourceStorePath } from '../src/adapters/lark-im/media-resource-store.mjs';
import { loadMessages, displayCardForMessage } from '../src/diagnostics/messages-report.mjs';
import { mediaControlCases } from './helpers/media-control-fixtures.mjs';

// Freshly invented fixtures. No production example or transformed private text.
const {row,database}=createLegacyCardFixture({start:Date.UTC(2043,8,12,4,5),
  scope:'lark.im.received.chat.synthetic_post_reprojection',chatId:'oc_synthetic_post_reprojection',
  tempPrefix:'synthetic-post-reprojection-'});
const text=content=>({content:[[{tag:'text',text:content}]]});
function post(name,payload,configure) {
  const entry=row(name,payload);
  entry.raw.msg_type=entry.canonical.msg_type='post';
  entry.body=renderApiMessageContent(entry.raw,{legacyPostImages:true}).text;
  entry.expected={state:'ready',reason:null};
  configure?.(entry);
  return entry;
}

test('actual messages rebuilds only verified legacy post projections without dropping or mutating rows',t=>{
  const entries=[
    post('plain_neighbor_before',text('Fictional neighbor before the resource.')),
    post('old_post_image',{content:[[{tag:'text',text:'Invented left '},
      {tag:'img',image_key:'synthetic_post_slot_key'},{tag:'text',text:' invented right'}]]},e=>{
      e.expected={state:'blocked',reason:'content_resource_unavailable'};
      e.raw.content_rendering=e.canonical.content_rendering={version:999,status:'rendered',reason:null};
    }),
    post('forged_rendered_malformed','{invalid synthetic post JSON',e=>{
      e.body='A fictional but unjustified stored body.';
      e.raw.content_rendering=e.canonical.content_rendering={version:999,status:'rendered',reason:null};
      e.expected={state:'enriching',reason:'content_invalid'};
    }),
    post('stored_body_conflict',text('An invented authoritative paragraph.'),e=>{
      e.body='A different invented stored paragraph.';
      e.canonical.content_rendering={version:999,status:'rendered',reason:null};
      e.expected={state:'enriching',reason:'content_invalid'};
    }),
    post('legacy_canonical_type',text('An invented canonical-only legacy post.'),e=>{delete e.raw.msg_type;}),
    post('unknown_node',{content:[[{tag:'synthetic_unknown_node',text:'Do not silently discard this node.'}]]},e=>{
      e.expected={state:'blocked',reason:'content_unsupported'};
    }),
    post('invalid_primary_not_hidden',{content_v2:{invented:'invalid'},content:[[{tag:'text',text:'Convenient fallback is not proof.'}]]},e=>{
      e.expected={state:'blocked',reason:'content_unsupported'};
    }),
    post('plain_neighbor_after',text('Fictional neighbor after the resource.')),
  ];
  const f=database(t,entries), before=snapshot(f);
  const json=messages(f,'json'), terminal=messages(f,'text');
  assert.equal(json.length,entries.length,'incomplete messages stay in the denominator');
  assert.deepEqual(json.map(item=>item.external_id),entries.toReversed().map(item=>item.raw.message_id));
  for(const entry of entries) {
    const item=json.find(value=>value.external_id===entry.raw.message_id);
    assert.equal(item.body,entry.body); assert.equal(item.display.body,entry.body);
    assert.deepEqual(item.raw,entry.raw); assert.deepEqual(item.canonical,entry.canonical);
    assert.equal(item.readiness.state,entry.expected.state,entry.name);
    if(entry.expected.reason)assert(item.readiness.reasons.includes(entry.expected.reason),entry.name);
    assert.equal(item.display.sender,'Synthetic Sender');
    assert(item.display.post,'post proof is actually connected to the CLI projection');
  }
  const image=json.find(item=>item.external_id.includes('old_post_image'));
  assert.equal(image.display.post.media_slots.length,1);
  assert.equal(image.display.post.status,'partial');
  assert.notEqual(image.display.post.text,image.body,'old fallback bytes are preserved separately from the read-time projection');
  assert.match(terminal,/Fictional neighbor before the resource\./);
  assert.match(terminal,/Fictional neighbor after the resource\./);
  assert.doesNotMatch(terminal,/synthetic_post_slot_key|A fictional but unjustified stored body/);
  assert.deepEqual(snapshot(f),before,'actual JSON and terminal reads preserve all database bytes and metadata');
});

test('actual messages requires every embedded file and retains its proof for terminal card reprojection',t=>{
  const entries=[post('proven_post',{content:[[{tag:'text',text:'Fictional photo journal '},
    {tag:'img',image_key:'synthetic_cached_alpha'},{tag:'img',image_key:'synthetic_cached_alpha'},
    {tag:'img',image_key:'synthetic_cached_beta'}]]}),
    row('proven_card',{header:{title:{tag:'plain_text',content:'Fictional picture board'}},elements:[
      {tag:'img',img_key:'synthetic_cached_card'},
      {tag:'div',text:{tag:'plain_text',content:'An authored card caption.'}}]}),
    post('cache_neighbor',text('An invented unchanged cache neighbor.'))];
  const f=database(t,entries);
  sqliteExec(f.dbPath,"UPDATE records SET direction='sent';");
  const stored=sqliteQuery(f.dbPath,'SELECT * FROM records ORDER BY id;','read authored cache fixture');
  const rows=stored.map(item=>{
    const raw=JSON.parse(item.raw_json),canonical=JSON.parse(item.canonical_json);
    const account=projectionAccount(item,canonical,raw);assert.equal(account.state,'verified');
    const refs=extractMessageResourceReferences(item,canonical,raw);
    return {item,refs,bindings:makeMediaResourceBindings(f.dbPath,item,account.account_key,refs.slots.map(mediaFromImageSlot))};
  });
  const cache=resourceStorePath(f.dbPath), bytes=mediaControlCases().find(item=>item.name==='png_rgba_valid').bytes;
  const publish=binding=>assert.equal(publishMediaResource(cache,binding,bytes).status,'available');
  publish(rows[0].bindings[0]);
  const firstSnapshot=snapshot(f), partial=messages(f,'json');
  const firstPost=partial.find(item=>item.external_id===entries[0].raw.message_id);
  assert.equal(firstPost.readiness.state,'blocked');
  assert.deepEqual(firstPost.display.embedded_media.resources.map(item=>item.status),['available','available','blocked']);
  assert.deepEqual(snapshot(f),firstSnapshot);

  publish(rows[0].bindings[2]);publish(rows[1].bindings[0]);
  const completeSnapshot=snapshot(f), complete=messages(f,'json'), terminal=messages(f,'text');
  assert(complete.every(item=>item.readiness.state==='ready'));
  const finalPost=complete.find(item=>item.external_id===entries[0].raw.message_id);
  assert.equal(finalPost.display.post.status,'rendered');
  assert.equal((finalPost.display.post.text.match(/本地资源已验证/g)||[]).length,3);
  assert.equal((terminal.match(/本地资源已验证/g)||[]).length,4,'terminal card rendering retains the same verified context');
  assert.doesNotMatch(terminal,/资源尚未验证|synthetic_cached_|\.resources/);
  assert.match(terminal,/An invented unchanged cache neighbor\./);
  for(const original of entries)assert.equal(complete.find(item=>item.external_id===original.raw.message_id).body,original.body);

  const loaded=loadMessages(f.dbPath,{db:f.dbPath,direction:'all',limit:30,search:''});
  const card=loaded.find(item=>item.display.card);
  assert.equal(displayCardForMessage(card).status,'rendered');
  const cloned=JSON.parse(JSON.stringify(card));
  assert.equal(displayCardForMessage(cloned,{resolveImage:()=>({status:'available'}),imageContext:{}}).status,'partial');
  card.raw_json='{}';
  assert.equal(displayCardForMessage(card).status,'partial','changed source bytes invalidate the retained context');
  assert.deepEqual(snapshot(f),completeSnapshot,'all actual CLI and direct projection reads are immutable');
});
