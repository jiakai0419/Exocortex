import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeResourceWork } from '../src/maintenance/resource-work.mjs';
import { createLegacyCardFixture, snapshot, messages } from './helpers/card-projection-fixture.mjs';
import { renderApiMessageContent } from '../src/adapters/lark-im/raw-message.mjs';
import { sqliteExec, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';
import { projectionAccount } from '../src/adapters/lark-im/message-projection-evidence.mjs';
import { extractMessageResourceReferences, mediaFromImageSlot } from '../src/adapters/lark-im/media-resource-references.mjs';
import { makeMediaResourceBindings, publishMediaResource, resourceStorePath } from '../src/adapters/lark-im/media-resource-store.mjs';
import { loadMessages, displayCardForMessage } from '../src/diagnostics/messages-report.mjs';
import { projectPostContent, readPostProjectionEvidence } from '../src/adapters/lark-im/message-post-projection.mjs';
import { projectEmbeddedMediaResources } from '../src/adapters/lark-im/media-resource-projection.mjs';
import { HistoryCommandBudgetError } from '../src/maintenance/history-command-budget.mjs';
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

  const source=rows[0].item, sourceRaw=JSON.parse(source.raw_json), sourceCanonical=JSON.parse(source.canonical_json);
  const sourceProjection=projectEmbeddedMediaResources(f.dbPath,cache,source,sourceCanonical,sourceRaw);
  const genuine=projectPostContent(source,sourceCanonical,sourceRaw,sourceProjection);
  assert.equal(readPostProjectionEvidence(source,sourceCanonical,sourceRaw,genuine).state,'complete');
  const foreign={...source,id:source.id+100,external_id:'om_synthetic_foreign_proof'};
  const foreignRaw={...sourceRaw,message_id:foreign.external_id}, foreignCanonical={...sourceCanonical,message_id:foreign.external_id};
  foreign.raw_json=JSON.stringify(foreignRaw);foreign.canonical_json=JSON.stringify(foreignCanonical);
  foreign.content_hash=createHash('sha256').update(foreign.raw_json).digest('hex');
  const foreignResult=projectPostContent(foreign,foreignCanonical,foreignRaw,sourceProjection);
  assert.equal(readPostProjectionEvidence(foreign,foreignCanonical,foreignRaw,foreignResult).state,'partial');
  const stop=new HistoryCommandBudgetError('time_budget');
  assert.throws(()=>projectPostContent(source,sourceCanonical,sourceRaw,{imageContext:sourceProjection.imageContext,
    resolveImage(){throw stop;}}),error=>error===stop,'trusted resource abort must escape unchanged');

  const loaded=loadMessages(f.dbPath,{db:f.dbPath,direction:'all',limit:30,search:''});
  const card=loaded.find(item=>item.display.card);
  assert.equal(displayCardForMessage(card).status,'rendered');
  const cloned=JSON.parse(JSON.stringify(card));
  assert.equal(displayCardForMessage(cloned,{resolveImage:()=>({status:'available'}),imageContext:{}}).status,'partial');
  card.raw_json='{}';
  assert.equal(displayCardForMessage(card).status,'partial','changed source bytes invalidate the retained context');
  assert.deepEqual(snapshot(f),completeSnapshot,'all actual CLI and direct projection reads are immutable');
});


test('automatic embedded enrollment and admitted work reach actual messages within unchanged unit limits',t=>{
  const entries=[post('automatic_post',{content:[[{tag:'text',text:'Invented automated photo journal '},
    {tag:'img',image_key:'synthetic_automatic_a'},{tag:'img',image_key:'synthetic_automatic_a'},
    {tag:'img',image_key:'synthetic_automatic_b'}]]}),post('automatic_neighbor',text('An unchanged automatic neighbor.'))];
  const f=database(t,entries);
  sqliteExec(f.dbPath,"UPDATE records SET direction='sent';");
  const before=sqliteQuery(f.dbPath,'SELECT * FROM records ORDER BY id;');
  const bytes=mediaControlCases().find(item=>item.name==='png_rgba_valid').bytes;
  let wall=Date.UTC(2043,8,12,4,8),tick=1;const calls=[];
  const deps={tmpdir:f.directory,now:()=>wall,monotonicClock:()=>tick,
    tryAcquireLease:()=>({state:'acquired',release(){}}),requestSessionDeps:{
      monotonicClock:()=>tick,now:()=>wall,sleep:ms=>{tick+=ms;},
      tryAcquireLease:()=>({state:'acquired',release(){}}),
      readSharedCooldown:()=>({state:'ready'}),writeSharedCooldown:()=>true,
      spawnSync(command,wrapped,options){
        assert.equal(command,'python3');const args=wrapped.slice(4);calls.push(args);tick+=10;
        if(args[0]==='contact')return {status:0,stdout:JSON.stringify({open_id:entries[0].raw.sender.id}),stderr:''};
        assert.deepEqual(args.slice(0,2),['api','GET']);
        assert.match(args[2],/\/resources\/synthetic_automatic_[ab]$/);
        const name=args[args.indexOf('--output')+1];writeFileSync(join(options.cwd,name),bytes,{mode:0o600});
        return {status:0,stdout:JSON.stringify({saved_path:name,size_bytes:bytes.length,content_type:'image/png'}),stderr:''};
      }}};
  const options={db:f.dbPath,maxCliAttempts:3,maxSelfAttempts:2,maxSeconds:30};
  executeResourceWork(options,deps);
  assert.equal(calls.length,0,'unknown endpoint eligibility cannot cause even a profile request');
  let tasks=sqliteQuery(f.dbPath,'SELECT * FROM lark_im_resource_work ORDER BY work_key;');
  assert.equal(tasks.length,2);assert(tasks.every(task=>task.state==='blocked'&&task.attempts===0));
  assert.equal(messages(f,'json').find(item=>item.external_id===entries[0].raw.message_id).readiness.state,'blocked');
  // This is only an authored endpoint contract at the mocked API boundary. It
  // does not establish actual upstream post/card resource eligibility.
  deps.resourceCapability=()=> 'message_image';
  for(let unit=0;unit<2;unit++) {
    wall+=61000;tick+=61000;const previous=calls.length;
    const result=executeResourceWork(options,deps);
    assert.equal(result.available,1);assert.equal(result.processed,1);
    assert.equal(calls.length-previous,3);assert.equal(result.request_budget.cli_attempts,3);
    assert.equal(result.request_budget.self_attempts,2);assert(result.request_budget.elapsed_ms<=30000);
    const actual=messages(f,'json'), target=actual.find(item=>item.external_id===entries[0].raw.message_id);
    assert.equal(actual.length,2);assert.equal(target.readiness.state,unit===1?'ready':'blocked');
    assert.equal(target.body,entries[0].body);assert.equal(actual[0].external_id,entries[1].raw.message_id);
  }
  tasks=sqliteQuery(f.dbPath,'SELECT * FROM lark_im_resource_work ORDER BY work_key;');
  assert(tasks.every(task=>task.state==='available'));
  assert.equal(new Set(calls.filter(args=>args[0]==='api').map(args=>args[2])).size,2);
  const terminal=messages(f,'text');assert.equal((terminal.match(/本地资源已验证/g)||[]).length,3);
  assert.match(terminal,/An unchanged automatic neighbor/);assert.doesNotMatch(terminal,/synthetic_automatic_[ab]/);
  assert.deepEqual(sqliteQuery(f.dbPath,'SELECT * FROM records ORDER BY id;'),before);
});


test('a recalled post retains the established tombstone display and its neighbors',t=>{
  const deleted=post('fictional_recall','{invalid fictional recalled content');
  deleted.raw.deleted=true;deleted.canonical.deleted=true;deleted.body='[Invalid post JSON]';
  const entries=[post('before_recall',text('Invented neighbor before recall.')),deleted,
    post('after_recall',text('Invented neighbor after recall.'))];
  const f=database(t,entries),before=snapshot(f),json=messages(f,'json'),terminal=messages(f,'text');
  const recalled=json.find(item=>item.external_id===deleted.raw.message_id);
  assert.equal(recalled.readiness.state,'ready');
  assert.equal(recalled.display.post,undefined);assert.equal(recalled.display.embedded_media,undefined);
  assert.equal(recalled.display.body,'[已撤回/已删除：飞书未返回原始富文本内容]');
  assert.match(terminal,/已撤回\/已删除/);assert.match(terminal,/Invented neighbor before recall/);
  assert.match(terminal,/Invented neighbor after recall/);
  assert.deepEqual(json.map(item=>item.external_id),entries.toReversed().map(item=>item.raw.message_id));
  assert.deepEqual(snapshot(f),before);
});
