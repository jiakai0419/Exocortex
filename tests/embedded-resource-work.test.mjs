import {projectionAccount} from '../src/adapters/lark-im/message-projection-evidence.mjs';
import {extractMessageResourceReferences,mediaFromImageSlot} from '../src/adapters/lark-im/media-resource-references.mjs';
import {makeMediaResourceBindings,publishMediaResource} from '../src/adapters/lark-im/media-resource-store.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ensureInitialized,sqliteExec,sqliteQuery,quoteSql as q} from '../dist/storage/sqlite/ingestion-store.js';
import {SENT_SCOPE_ID} from '../src/adapters/lark-im/core.mjs';
import {renderApiMessageContent} from '../src/adapters/lark-im/raw-message.mjs';
import {readMessageSnapshot} from '../src/diagnostics/message-read-snapshot.mjs';
import {projectEmbeddedMediaResources} from '../src/adapters/lark-im/media-resource-projection.mjs';
import {executeResourceWork,resourceWorkIdentities,resourceWorkCapabilityEvidence,resourceWorkFailureEvidence} from '../src/maintenance/resource-work.mjs';
import {enrichResources} from '../src/maintenance/enrich-resources.mjs';
import {RESOURCE_CANDIDATE_INDEX} from '../src/maintenance/resource-candidates.mjs';

const SELF='ou_synthetic_multi_resource',AT=Date.UTC(2025,4,1),sha=x=>createHash('sha256').update(x).digest('hex');
const GIF=Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b','hex');
const allowed=()=> 'message_image';
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'synthetic-embedded-work-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const db=join(root,'messages.sqlite');ensureInitialized(db);
  const f={root,db,resourceDir:join(root,'resources'),wall:AT+100000,tick:1,next:1,calls:[],writes:[],settings:{}};
  f.add=(type='post',keys=['synthetic_image'],padding='',payload=null)=>{
    const id=f.next++,raw={message_id:`om_synthetic_embedded_work_${id}`,chat_id:'oc_synthetic_embedded_work',msg_type:type,chat_type:'group',
      create_time:String(AT+id),sender:{id:SELF,id_type:'open_id',sender_type:'user',name:'Synthetic Reader'},
      body:{content:JSON.stringify(payload??(type==='post'?{title:'Synthetic source',content:[[{tag:'text',text:`Synthetic text ${padding}`},...keys.map(image_key=>({tag:'img',image_key}))]]}
        :type==='image'?{image_key:keys[0]}:type==='interactive'?{elements:[{tag:'plain_text',content:`Synthetic card ${padding}`}]}:{text:`Synthetic prose ${padding}`}))}};
    const rendered=renderApiMessageContent(raw),canonical={message_id:raw.message_id,chat_id:raw.chat_id,chat_type:'group',chat_name:'Synthetic Room',
      msg_type:type,sender_id:SELF,sender_id_type:'open_id',sender_type:'user',sender_name:'Synthetic Reader',sender_name_source:'message_sender',content_rendering:{...rendered}};
    delete canonical.content_rendering.text;
    const raw_json=JSON.stringify(raw),row={id,source_id:'lark.im',record_type:'lark.im.message',external_id:raw.message_id,external_version:String(AT+id),
      first_seen_scope_id:SENT_SCOPE_ID,actor_id:SELF,container_id:raw.chat_id,direction:'sent',occurred_at:new Date(AT+id).toISOString(),occurred_at_ms:AT+id,
      raw_json,canonical_json:JSON.stringify(canonical),content_hash:sha(raw_json),body:rendered.text};
    sqliteExec(db,`INSERT INTO records(${Object.keys(row)}) VALUES(${Object.values(row).map(q)});`);return id;
  };
  f.options={db,resourceDir:f.resourceDir,maxCliAttempts:3,maxSelfAttempts:2,maxSeconds:30};
  f.deps={tmpdir:root,now:()=>f.wall,monotonicClock:()=>f.tick,
    tryAcquireLease:()=>({state:'acquired',release(){}}),
    sqliteWrite:(db,sql,label)=>{f.writes.push(sql);f.settings.beforeWrite?.(sql);return sqliteQuery(db,sql,label);},
    requestSessionDeps:{monotonicClock:()=>f.tick,now:()=>f.wall,sleep:ms=>{f.tick+=ms;},
      tryAcquireLease:()=>({state:'acquired',release(){}}),readSharedCooldown:()=>({state:'ready'}),writeSharedCooldown:()=>true,
      spawnSync(command,wrapped,options){
        assert.equal(command,'python3');const args=wrapped.slice(4);f.calls.push(args);f.tick+=10;
        if(args[0]==='contact')return {status:0,stdout:JSON.stringify({open_id:SELF}),stderr:''};
        assert.equal(args[0],'api');assert.equal(args[1],'GET');
        const key=decodeURIComponent(args[2].split('/').at(-1));
        if(f.settings.denied?.has(key))return {status:1,stdout:JSON.stringify({code:210508,msg:'Synthetic exact resource denied'}),stderr:''};
        const bytes=f.settings.invalid?.has(key)?Buffer.from('Synthetic invalid image bytes'):GIF;
        const name=args[args.indexOf('--output')+1];writeFileSync(join(options.cwd,name),bytes,{mode:0o600});
        return {status:0,stdout:JSON.stringify({saved_path:name,size_bytes:bytes.length,content_type:'image/gif'}),stderr:''};
      }} };
  f.run=()=>executeResourceWork(f.options,f.deps);
  f.advance=(ms=61000)=>{f.wall+=ms;f.tick+=ms;};
  f.tasks=()=>sqliteQuery(db,'SELECT * FROM lark_im_resource_work ORDER BY record_id,work_key;');
  f.row=id=>readMessageSnapshot(db,{recordIds:[id]}).rows[0];
  f.downloads=()=>f.calls.filter(args=>args[0]==='api').map(args=>decodeURIComponent(args[2].split('/').at(-1)));
  return f;
}

test('default post keys enroll exact capability-blocked tasks with no attempts or API',t=>{
  const f=fixture(t),id=f.add('post',['synthetic_a','synthetic_a','synthetic_b']);
  const before=f.row(id);f.run();const tasks=f.tasks();assert.equal(tasks.length,2);assert.equal(f.calls.length,0);
  for(const task of tasks){assert.equal(task.state,'blocked');assert.equal(task.reason,null);assert.equal(task.attempts,0);assert.equal(task.failures,0);
    assert.equal(task.failure_reason,null);const identity=resourceWorkIdentities(f.db,f.row(id)).find(x=>x.work_key===task.work_key);
    assert.deepEqual(resourceWorkCapabilityEvidence(task,identity),{reason:'resource_endpoint_unverified',
      association:{binding_key:task.binding_key,source_fence:task.source_fence},applicability:'exact_source'});}
  assert.deepEqual(f.row(id),before);
  const preview=enrichResources({db:f.db,resourceDir:f.resourceDir,recordIds:[id],apply:true},f.deps);
  assert.equal(preview.request_budget,null);assert.equal(preview.results.length,2);
  assert(preview.results.every(item=>item.reason==='resource_endpoint_unverified'&&item.failure===null));assert.equal(f.calls.length,0);
});
test('authoritatively enabled internal route processes one exact unique resource per original unit',t=>{
  const f=fixture(t),id=f.add('post',['synthetic_a','synthetic_a','synthetic_b','synthetic_c']),before=f.row(id);
  f.run();f.deps.resourceCapability=allowed;f.advance();
  for(let i=0;i<3;i++){
    const prior=f.calls.length,r=f.run();assert.equal(r.processed,1);assert.equal(r.available,1);
    assert.equal(f.calls.length-prior,3);assert.equal(r.request_budget.max_cli_attempts,3);assert.equal(r.request_budget.cli_attempts,3);
    assert.equal(r.request_budget.max_self_attempts,2);assert.equal(r.request_budget.self_attempts,2);assert(r.request_budget.elapsed_ms<=30000);
    f.advance();
  }
  assert.equal(f.downloads().length,3);assert.equal(new Set(f.downloads()).size,3);assert(f.tasks().every(x=>x.state==='available'));
  const row=f.row(id),canonical=JSON.parse(row.canonical_json),raw=JSON.parse(row.raw_json),projection=projectEmbeddedMediaResources(f.db,f.resourceDir,row,canonical,raw);
  assert.equal(projection.resources.length,4);assert(projection.resources.every(x=>x.status==='available'));
  assert.equal(renderApiMessageContent(raw,{imageContext:projection.imageContext,resolveImage:projection.resolveImage}).status,'rendered');
  assert.deepEqual(row,before,'resource completion leaves the stored message unchanged');
});
test('explicit multi-slot acquisition cannot expand one selected record into extra request budget',t=>{
  const f=fixture(t),id=f.add('post',['synthetic_a','synthetic_b','synthetic_c']);f.deps.resourceCapability=allowed;
  const result=enrichResources({db:f.db,resourceDir:f.resourceDir,recordIds:[id],apply:true},f.deps);
  assert.equal(result.request_budget.max_cli_attempts,3);assert.equal(result.request_budget.cli_attempts,3);
  assert.equal(result.available,1);assert.equal(result.planned,2);assert.equal(f.downloads().length,1);
});
test('an exact resource selector cannot download a sibling or a forged key',t=>{
  const f=fixture(t),id=f.add('post',['synthetic_a','synthetic_b']);f.deps.resourceCapability=allowed;
  const result=enrichResources({...f.options,recordIds:[id],resourceTargets:[{record_id:id,resource_key:'synthetic_b',reference_kind:'image_key'}],apply:true},f.deps);
  assert.equal(result.available,1);assert.deepEqual(f.downloads(),['synthetic_b']);
  const count=f.calls.length,wrong=enrichResources({...f.options,recordIds:[id],resourceTargets:[{record_id:id,resource_key:'synthetic_other',reference_kind:'image_key'}],apply:true},f.deps);
  assert.equal(wrong.results[0].reason,'media_reference_missing');assert.equal(f.calls.length,count);
});
test('unknown capability never consumes an existing real failure or a claim',t=>{
  const f=fixture(t),id=f.add('post',['synthetic_bad']);f.deps.resourceCapability=allowed;f.settings.invalid=new Set(['synthetic_bad']);
  assert.equal(f.run().deferred,1);const before=f.tasks()[0],calls=f.calls.length;
  delete f.deps.resourceCapability;f.advance(500000);const result=f.run(),after=f.tasks()[0];
  assert.equal(result.blocked,1);assert.equal(f.calls.length,calls);assert.equal(after.state,'blocked');assert.equal(after.reason,null);
  for(const field of ['attempts','failures','failure_stage','failure_reason','failure_binding_key','failure_source_fence'])assert.equal(after[field],before[field]);
  assert.equal(resourceWorkCapabilityEvidence(after,resourceWorkIdentities(f.db,f.row(id))[0]).reason,'resource_endpoint_unverified');
  f.deps.resourceCapability=allowed;f.advance();f.run();assert.equal(f.calls.length,calls,'only zero-attempt capability work may reopen');
});
test('same-binding metadata changes preserve exhausted and exact denied resources',t=>{
  const f=fixture(t);f.add('post',['synthetic_bad']);f.deps.resourceCapability=allowed;f.settings.invalid=new Set(['synthetic_bad']);
  for(let i=0;i<3;i++){f.run();f.advance(500000);}const before=f.tasks()[0],calls=f.calls.length;
  assert.equal(before.state,'exhausted');sqliteExec(f.db,"UPDATE records SET canonical_json=json_set(canonical_json,'$.chat_name','Synthetic corrected room');");
  f.run();const after=f.tasks()[0];assert.equal(f.calls.length,calls);assert.equal(after.state,'exhausted');assert.equal(after.attempts,before.attempts);
  assert.equal(after.failure_reason,before.failure_reason);assert.equal(resourceWorkFailureEvidence(after,resourceWorkIdentities(f.db,f.row(1))[0]).applicability,'same_binding');
});
test('explicit remote denial survives source version and capability changes without a new request',t=>{
  const f=fixture(t);f.add('post',['synthetic_denied']);f.deps.resourceCapability=allowed;f.settings.denied=new Set(['synthetic_denied']);
  assert.equal(f.run().blocked,1);const before=f.tasks()[0],calls=f.calls.length;assert.equal(before.reason,'permission_denied');
  sqliteExec(f.db,"UPDATE records SET external_version='synthetic_later_version';");delete f.deps.resourceCapability;f.advance();f.run();
  const after=f.tasks()[0];assert.equal(f.calls.length,calls);assert.equal(after.reason,'permission_denied');assert.equal(after.attempts,before.attempts);
  assert.equal(after.failure_reason,before.failure_reason);assert.equal(after.capability_evidence_json,null);
});
test('expanded slots validate each complete source once instead of multiplying source SQL',t=>{
  const f=fixture(t),padding='SyntheticLongSourceSentinel'.repeat(900);f.add('post',Array.from({length:64},(_,i)=>`synthetic_slot_${i}`),padding);
  f.run();assert.equal(f.tasks().length,64);assert.equal(f.calls.length,0);
  const sql=f.writes.find(value=>value.includes('CREATE TEMP TABLE __resource_scan_source'));
  assert(sql);assert.equal((sql.match(/SyntheticLongSourceSentinel/g)||[]).length,1800,'only raw and body contain the source, independent of64 resources');
  assert(Buffer.byteLength(sql)<500000,'bounded source-plus-reference SQL must not repeat a large source per slot');
});
test('source change between scan and enrollment skips every slot of that source',t=>{
  const f=fixture(t);f.add('post',['synthetic_a','synthetic_b']);let changed=false;
  f.settings.beforeWrite=sql=>{if(!changed&&sql.includes('__resource_scan_source')){changed=true;sqliteExec(f.db,"UPDATE records SET body=body||' Synthetic changed';");}};
  f.run();assert.equal(f.tasks().length,0);assert.equal(f.calls.length,0);
});
test('broader discovery advances through deep card candidates without moving the fixed horizon',t=>{
  const f=fixture(t);for(let i=0;i<45;i++)f.add('interactive');const target=f.add('post',['synthetic_old_embedded']);
  for(let i=0;i<45;i++)f.add('interactive');
  f.run();const horizon=sqliteQuery(f.db,'SELECT horizon_id FROM lark_im_resource_scan;')[0].horizon_id;
  assert.equal(f.tasks().length,0);f.advance();f.run();f.add('post',['synthetic_new_embedded']);f.advance();f.run();
  assert(f.tasks().some(task=>task.record_id===target));assert(f.tasks().some(task=>task.record_id!==target));
  assert.equal(sqliteQuery(f.db,'SELECT horizon_id FROM lark_im_resource_scan;')[0].horizon_id,horizon);
  assert.equal(f.calls.length,0);
});
test('024 upgrade preserves old task rows and both old/new indexed readers',t=>{
  const f=fixture(t);f.add('image',['synthetic_legacy']);f.run();
  sqliteExec(f.db,`DROP INDEX ${RESOURCE_CANDIDATE_INDEX}; ALTER TABLE lark_im_resource_work DROP COLUMN capability_evidence_json; DELETE FROM schema_migrations WHERE version='024';`);
  const before=f.tasks(),scan=sqliteQuery(f.db,'SELECT * FROM lark_im_resource_scan;');ensureInitialized(f.db);
  assert.deepEqual(f.tasks().map(({capability_evidence_json,...row})=>row),before);assert(f.tasks().every(x=>x.capability_evidence_json===null));
  assert.deepEqual(sqliteQuery(f.db,'SELECT * FROM lark_im_resource_scan;'),scan);
  const old=readFileSync(new URL('../migrations/021_resource_image_candidates.sql',import.meta.url),'utf8').split('WHERE ')[1].replace(/;\s*$/,'');
  assert.equal(sqliteQuery(f.db,`SELECT COUNT(*) n FROM records INDEXED BY records_resource_image_candidates WHERE ${old};`)[0].n,1);
  assert.equal(sqliteQuery(f.db,`SELECT COUNT(*) n FROM schema_migrations WHERE version='024';`)[0].n,1);
});
test('capability evidence is closed and cannot constrain or authorize an older source writer',t=>{
  const f=fixture(t),id=f.add('post',['synthetic_key']);f.run();const before=f.tasks()[0];
  const value=JSON.parse(before.capability_evidence_json);
  for(const bad of [{},{...value,version:2},{...value,extra:'synthetic'},{...value,reason:'permission_denied'},
    {...value,binding_key:'not-a-hash'},['synthetic'],Object.fromEntries(Object.entries(value).filter(([key])=>key!=='source_fence'))])
    assert.throws(()=>sqliteExec(f.db,`UPDATE lark_im_resource_work SET capability_evidence_json=${q(JSON.stringify(bad))};`));
  sqliteExec(f.db,`UPDATE lark_im_resource_work SET binding_key=${q('e'.repeat(64))},source_fence=${q('f'.repeat(64))};`);
  assert.equal(f.tasks()[0].capability_evidence_json,before.capability_evidence_json,'old writers preserve evidence with its old association');
  const identity={...resourceWorkIdentities(f.db,f.row(id))[0],binding_key:'e'.repeat(64),source_fence:'f'.repeat(64)};
  assert.equal(resourceWorkCapabilityEvidence(f.tasks()[0],identity).applicability,'different_binding');assert.equal(f.calls.length,0);
});


test('default card aliases are distinct capability-blocked resources without API attempts',t=>{
  const f=fixture(t),source={json_card:{body:{elements:[{tag:'img',property:{imageID:'synthetic_alias'}}]}},
    json_attachment:{images:{synthetic_alias:{origin_key:'synthetic_origin'}}}};
  const id=f.add('interactive',[], '',source);f.run();
  const task=f.tasks()[0];assert.equal(f.tasks().length,1);assert.equal(task.state,'blocked');assert.equal(task.attempts,0);
  const identity=resourceWorkIdentities(f.db,f.row(id))[0];assert.equal(identity.reference_kind,'attachment_origin_key');
  assert.equal(resourceWorkCapabilityEvidence(task,identity).reason,'resource_endpoint_unverified');
  const result=enrichResources({...f.options,recordIds:[id],apply:true},f.deps);
  assert.equal(result.results[0].reference_kind,'attachment_origin_key');assert.equal(result.results[0].reason,'resource_endpoint_unverified');
  assert.equal(result.request_budget,null);assert.equal(f.calls.length,0);
});

test('true version recovery retains the old failure but diagnoses the new unverified capability',t=>{
  const f=fixture(t);f.add('post',['synthetic_bad']);f.deps.resourceCapability=allowed;f.settings.invalid=new Set(['synthetic_bad']);
  for(let i=0;i<3;i++){f.run();f.advance(500000);}const before=f.tasks()[0],calls=f.calls.length;
  assert.equal(before.state,'exhausted');delete f.deps.resourceCapability;
  sqliteExec(f.db,"UPDATE records SET external_version='synthetic_real_source_version_change';");f.advance();f.run();
  const after=f.tasks()[0],identity=resourceWorkIdentities(f.db,f.row(1))[0];
  assert.equal(after.state,'blocked');assert.equal(after.reason,null);assert.equal(after.attempts,0,'baseline true-version reset policy retained');
  assert.equal(after.failure_reason,before.failure_reason);assert.equal(resourceWorkFailureEvidence(after,identity).applicability,'different_binding');
  assert.equal(resourceWorkCapabilityEvidence(after,identity).reason,'resource_endpoint_unverified');assert.equal(f.calls.length,calls);
});


// A real, identity-bound synthetic cache provides the producer's local result.
// No fabricated available object may stand in for its private provenance.
function cacheSyntheticResources(f,ids,bytes) {
  for(const row of readMessageSnapshot(f.db,{recordIds:ids}).rows) {
    const raw=JSON.parse(row.raw_json),canonical=JSON.parse(row.canonical_json),account=projectionAccount(row,canonical,raw);
    assert.equal(account.state,'verified');
    const slots=extractMessageResourceReferences(row,canonical,raw).slots;
    const bindings=makeMediaResourceBindings(f.db,row,account.account_key,slots.map(mediaFromImageSlot));
    assert.equal(bindings.length,slots.length);assert(bindings.length>0);
    for(const binding of bindings)assert.equal(publishMediaResource(f.resourceDir,binding,bytes,{nowMs:AT}).status,'available');
  }
}

test('multi-slot fair turns persist across processes while newer messages keep arriving',t=>{
  const f=fixture(t),oldest=f.add('post',['synthetic_old_a','synthetic_old_b']),turns=[];
  // Each restarted producer validates real synthetic cached slots, without API calls.
  cacheSyntheticResources(f,[oldest],GIF);
  for(let i=0;i<3;i++){
    const fresh=f.add('post',[`synthetic_fresh_${i}_a`,`synthetic_fresh_${i}_b`]);f.advance();
    cacheSyntheticResources(f,[fresh],GIF);
    const program=`import {executeResourceWork} from ${JSON.stringify(new URL('../src/maintenance/resource-work.mjs',import.meta.url).href)};
      import {sqliteQuery} from ${JSON.stringify(new URL('../dist/storage/sqlite/ingestion-store.js',import.meta.url).href)};
      import {enrichResources} from ${JSON.stringify(new URL('../src/maintenance/enrich-resources.mjs',import.meta.url).href)};
      const selected=[];let requests=0;const db=${JSON.stringify(f.db)};
      const result=executeResourceWork({db,resourceDir:${JSON.stringify(f.resourceDir)},maxCliAttempts:3,maxSelfAttempts:2,maxSeconds:30},{
        now:()=>${f.wall},monotonicClock:()=>1,resourceCapability:()=> 'message_image',tryAcquireLease:()=>({state:'acquired',release(){}}),
        requestSessionDeps:{spawnSync(){requests++;throw Error('unexpected synthetic external request');}},
        enrichResources(options,deps){const target=options.resourceTargets[0];selected.push(target);return enrichResources(options,deps);}
      });process.stdout.write(JSON.stringify({pid:process.pid,result,selected,requests,scan:sqliteQuery(db,'SELECT * FROM lark_im_resource_scan;')[0]}));`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8',timeout:15000});
    assert.equal(child.status,0,child.stderr);turns.push(JSON.parse(child.stdout));
  }
  assert.equal(new Set(turns.map(x=>x.pid)).size,3);assert.deepEqual(turns.map(x=>x.scan.priority_streak),[1,2,0]);
  assert.equal(turns[2].selected[0].record_id,oldest);assert(turns.every(x=>x.selected.length===1&&x.result.processed===1));
  assert(turns.every(x=>x.requests===0&&x.result.request_budget.cli_attempts===0&&x.result.request_budget.self_attempts===0));
  assert.equal(f.tasks().filter(x=>x.record_id===oldest&&x.state==='available').length,1,'one exact old slot is serviced');
  assert.equal(f.calls.length,0);
});
