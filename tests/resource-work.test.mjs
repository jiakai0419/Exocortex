import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {ensureInitialized,sqliteExec,sqliteQuery,quoteSql as q} from '../dist/storage/sqlite/ingestion-store.js';
import {SENT_SCOPE_ID} from '../src/adapters/lark-im/core.mjs';
import {readMessageSnapshot} from '../src/diagnostics/message-read-snapshot.mjs';
import {executeResourceWork,resourceWorkAvailable,resourceWorkIdentity,resourceWorkFailureEvidence} from '../src/maintenance/resource-work.mjs';
import {loadMessages} from '../src/diagnostics/messages-report.mjs';
import {RESOURCE_CANDIDATE_WHERE,RESOURCE_CANDIDATE_INDEX} from '../src/maintenance/resource-candidates.mjs';
import {enrichResources,normalizeResourceFailure,RESOURCE_FAILURE_STAGES,RESOURCE_FAILURE_REASONS} from '../src/maintenance/enrich-resources.mjs';

const SELF='ou_synthetic_resource_work_owner',AT=Date.UTC(2025,1,3),sha=x=>createHash('sha256').update(x).digest('hex');
const crc=bytes=>{let v=0xffffffff;for(const b of bytes){v^=b;for(let i=0;i<8;i++)v=(v>>>1)^((v&1)?0xedb88320:0);}return(v^0xffffffff)>>>0;};
const chunk=(name,bytes)=>{const data=Buffer.concat([Buffer.from(name),bytes]),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(bytes.length);sum.writeUInt32BE(crc(data));return Buffer.concat([len,data,sum]);};
const head=Buffer.alloc(13);head.writeUInt32BE(1);head.writeUInt32BE(1,4);head[8]=8;head[9]=6;
const PNG=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',head),chunk('IDAT',deflateSync(Buffer.from([0,200,30,40,255]))),chunk('IEND',Buffer.alloc(0))]);
function fixture(t,count=1){
  const root=mkdtempSync(join(tmpdir(),'synthetic-resource-work-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const db=join(root,'messages.sqlite');ensureInitialized(db);
  const f={root,db,resourceDir:join(root,'resources'),wall:AT+100000,clock:1,calls:[],profiles:0,localLeases:0,remoteLeases:0,
    settings:{},nextId:1};
  f.add=(type='image',extra={})=>{
    const id=f.nextId++,external=`om_synthetic_queue_${id}`,chat='oc_synthetic_queue_room';
    const raw={message_id:external,chat_id:chat,chat_type:'group',msg_type:type,create_time:String(AT+id),sender:{id:SELF,id_type:'open_id',sender_type:'user',name:'Synthetic Author'},
      body:{content:JSON.stringify(type==='image'?{image_key:`synthetic_queue_image_${id}`}:{text:'Synthetic ordinary text'})},...extra};
    const canonical={message_id:external,chat_id:chat,chat_type:'group',chat_name:'Synthetic Room',msg_type:type,sender_id:SELF,sender_id_type:'open_id',sender_type:'user',sender_name:'Synthetic Author',sender_name_source:'message_sender'};
    const raw_json=JSON.stringify(raw),row={id,source_id:'lark.im',record_type:'lark.im.message',external_id:external,external_version:String(AT+id),first_seen_scope_id:SENT_SCOPE_ID,
      actor_id:SELF,container_id:chat,direction:'sent',occurred_at:new Date(AT+id).toISOString(),occurred_at_ms:AT+id,raw_json,canonical_json:JSON.stringify(canonical),content_hash:sha(raw_json),body:'Synthetic source body'};
    sqliteExec(db,`INSERT INTO records(${Object.keys(row)}) VALUES(${Object.values(row).map(q)});`);return id;
  };
  for(let i=0;i<count;i++)f.add();
  f.options={db,resourceDir:f.resourceDir,maxCliAttempts:3,maxSelfAttempts:2,maxSeconds:30};
  f.deps={tmpdir:root,now:()=>f.wall,monotonicClock:()=>f.clock,
    tryAcquireLease:()=>{f.localLeases++;return f.settings.localBusy?{state:'busy'}:{state:'acquired',release(){}};},
    requestSessionDeps:{monotonicClock:()=>f.clock,now:()=>f.wall,sleep:ms=>{f.clock+=ms;},
      tryAcquireLease:()=>{f.remoteLeases++;return f.settings.remoteBusyAt===f.remoteLeases?{state:'busy'}:{state:'acquired',release(){}};},
      readSharedCooldown:()=>({state:'ready'}),writeSharedCooldown:()=>true,
      spawnSync(command,wrapped,opts){
        assert.equal(command,'python3');assert(wrapped[2].includes('RLIMIT_FSIZE'));const args=wrapped.slice(4);f.calls.push(args);f.clock+=10;
        if(args[0]==='contact') {f.profiles++;f.settings.onProfile?.(f.profiles);return {status:0,stdout:JSON.stringify({open_id:f.settings.profile?.(f.profiles)??SELF}),stderr:''};}
        assert.equal(args[0],'api');assert.equal(args[1],'GET');f.settings.onDownload?.();
        if(f.settings.response)return f.settings.response;
        if(f.settings.localDenied)return {status:1,stdout:'',stderr:'permission denied: synthetic local launcher'};
        if(f.settings.denied)return {status:1,stdout:JSON.stringify({code:210508,msg:'synthetic remote denial'}),stderr:''};
        if(f.settings.transient)return {status:1,stdout:JSON.stringify({code:999999999,msg:'synthetic transient'}),stderr:''};
        const name=args[args.indexOf('--output')+1],bytes=f.settings.bytes??PNG;writeFileSync(join(opts.cwd,name),bytes,{mode:0o600});
        return {status:0,stdout:JSON.stringify({saved_path:f.settings.savedPath??name,size_bytes:f.settings.size??bytes.length,content_type:f.settings.mime??'image/png'}),stderr:''};
      }}};
  f.run=()=>executeResourceWork(f.options,f.deps);
  f.advance=ms=>{f.wall+=ms;f.clock+=ms;};
  f.tasks=()=>sqliteQuery(db,'SELECT * FROM lark_im_resource_work ORDER BY record_id;');
  return f;
}
const downloads=f=>f.calls.filter(a=>a[0]==='api');

test('real queue and producer publish one exact image, then available yields zero requests',t=>{
  const f=fixture(t);assert(resourceWorkAvailable(f.db,{now:()=>f.wall}));
  const result=f.run();assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.available,1);assert.equal(result.request_budget.cli_attempts,3);
  assert.equal(result.request_budget.self_attempts,2);assert.equal(result.request_budget.max_seconds,30);assert.equal(result.request_budget.complete,true);
  assert.equal(f.tasks()[0].state,'available');assert.equal(loadMessages(f.db,{limit:20,resourceDir:f.resourceDir})[0].readiness.state,'ready');
  const n=f.calls.length;f.advance(61000);assert.equal(f.run().request_budget.cli_attempts,0);assert.equal(f.calls.length,n);
  assert(!JSON.stringify(result).includes('om_'));assert(!JSON.stringify(result).includes(f.root));
});

test('confirmed exact denial closes account inside 3 calls and survives names/version/chat corrections',t=>{
  const f=fixture(t);f.settings.denied=true;
  assert.equal(f.run().outcome,'blocked');assert.equal(f.calls.length,3);assert.equal(f.tasks()[0].reason,'permission_denied');
  const before=f.tasks()[0].work_key,row=readMessageSnapshot(f.db,{recordIds:[1]}).rows[0];
  const raw=JSON.parse(row.raw_json),canonical=JSON.parse(row.canonical_json);raw.chat_id='oc_synthetic_corrected_room';canonical.chat_id=raw.chat_id;canonical.sender_name='Updated synthetic name';
  const rawText=JSON.stringify(raw);
  sqliteExec(f.db,`UPDATE records SET container_id=${q(raw.chat_id)},raw_json=${q(rawText)},content_hash=${q(sha(rawText))},canonical_json=${q(JSON.stringify(canonical))},external_version='new-synthetic-version' WHERE id=1;`);
  f.advance(61000);f.run();assert.equal(f.tasks()[0].work_key,before);assert.equal(f.tasks()[0].state,'blocked');assert.equal(f.calls.length,3);
});

for(const mode of ['local denial','closing changed','closing busy'])test(`${mode} never becomes confirmed permanent resource permission`,t=>{
  const f=fixture(t);f.settings.denied=mode!=='local denial';f.settings.localDenied=mode==='local denial';
  if(mode==='closing changed')f.settings.profile=n=>n===2?'ou_synthetic_other_account':SELF;
  if(mode==='closing busy')f.settings.remoteBusyAt=3;
  const result=f.run();assert.equal(result.ok,false);assert.notEqual(f.tasks()[0].reason,'permission_denied');assert.notEqual(f.tasks()[0].state,'blocked');
  assert.equal(downloads(f).length,1);assert.equal(result.request_budget.cli_attempts,mode==='closing changed'?3:2);
});

test('fresh work cannot starve oldest eligible image across continuous arrivals',t=>{
  const f=fixture(t,3);const served=[];
  for(let i=0;i<3;i++){if(i)f.add();const n=downloads(f).length;const r=f.run();assert.equal(r.available,1,JSON.stringify(r));served.push(downloads(f)[n][2]);}
  assert(served[2].includes('/om_synthetic_queue_1/'));assert.equal(f.tasks().find(x=>x.record_id===1).state,'available');
});

test('large plain text and oversized raw pages advance while valid images remain serviceable',t=>{
  const f=fixture(t,0);f.add('text',{large:'x'.repeat(2*1024*1024)});f.add('image',{large:'y'.repeat(2*1024*1024)});
  f.add();for(let i=0;i<25;i++)f.add('text',{text:'Synthetic later text'});
  const result=f.run();assert.equal(result.available,1,JSON.stringify(result));assert(downloads(f)[0][2].includes('/om_synthetic_queue_3/'));
  assert.equal(sqliteQuery(f.db,'SELECT after_id FROM lark_im_resource_scan;')[0].after_id,3,'cursor advances over indexed image candidates including oversized images');
});

test('obsolete queued image becoming text is terminal and cannot pin the next unit',t=>{
  const f=fixture(t,2);f.run(); // newest available, oldest remains pending
  const row=readMessageSnapshot(f.db,{recordIds:[1]}).rows[0],raw=JSON.parse(row.raw_json),canonical=JSON.parse(row.canonical_json);
  raw.msg_type='text';raw.body.content='{"text":"Synthetic changed content"}';canonical.msg_type='text';const txt=JSON.stringify(raw);
  sqliteExec(f.db,`UPDATE records SET raw_json=${q(txt)},content_hash=${q(sha(txt))},canonical_json=${q(JSON.stringify(canonical))} WHERE id=1;`);
  assert.equal(f.run().outcome,'source_changed');assert.equal(f.tasks()[0].reason,'source_changed');
  f.add();assert.equal(f.run().available,1);
});

test('closed pending resumes after dead claim recovery without duplicate download',t=>{
  const f=fixture(t);f.settings.remoteBusyAt=4;const first=f.run();assert.equal(first.request_budget.stop_reason,'sync_busy');assert.equal(downloads(f).length,1);
  f.advance(121000);assert.equal(f.run().request_budget.cli_attempts,0,'live owner cannot be reclaimed merely by wall expiry');
  f.deps.ownerState=()=> 'dead';f.settings.remoteBusyAt=0;const next=f.run();assert.equal(next.available,1,JSON.stringify(next));assert.equal(next.request_budget.cli_attempts,2);assert.equal(downloads(f).length,1);
});

test('unclosed quarantine requires fresh acquisition after restart, never false reuse',t=>{
  const f=fixture(t);f.settings.remoteBusyAt=3;assert.equal(f.run().request_budget.stop_reason,'sync_busy');
  f.advance(121000);f.deps.ownerState=()=> 'dead';f.settings.remoteBusyAt=0;assert.equal(f.run().available,1);assert.equal(downloads(f).length,2);
});

test('busy local admission emits exact zero-call receipt without claiming or fetching',t=>{
  const f=fixture(t);f.settings.localBusy=true;const r=f.run();assert.equal(r.request_budget.stop_reason,'sync_busy');assert.equal(r.request_budget.cli_attempts,0);assert.equal(r.request_budget.complete,true);assert.equal(f.tasks().length,0);
});

test('invalid producer receipt fails closed and is never reported as zero actual attempts',t=>{
  const f=fixture(t);f.deps.enrichResources=()=>({results:[{record_id:1,state:'planned'}],request_budget:null});
  const r=f.run();assert.equal(r.request_budget.complete,false);assert.equal(r.request_budget.cli_attempts,null);assert.equal(f.tasks()[0].state,'running');
});

test('source-account change during closing cannot publish or claim success',t=>{
  const f=fixture(t);f.settings.onProfile=n=>{if(n===2)sqliteExec(f.db,"UPDATE records SET external_version='synthetic-changed-during-call' WHERE id=1;");};
  const r=f.run();assert.equal(r.outcome,'source_changed');assert.equal(f.tasks()[0].reason,'source_changed');assert.equal(r.available,0);
});

test('bounded repeated transient outcomes exhaust without fresh traffic resetting history',t=>{
  const f=fixture(t);f.settings.transient=true;
  for(let i=0;i<3;i++){const r=f.run();assert.equal(r.outcome,i===2?'exhausted':'batch_deferred');f.advance(500000);}
  const before=f.calls.length;f.add('text');f.run();assert.equal(f.calls.length,before);assert.equal(f.tasks()[0].failures,3);
});

test('known available sidecar discovered for the first time uses no remote calls',t=>{
  const f=fixture(t);assert.equal(enrichResources({...f.options,recordIds:[1],apply:true},f.deps).available,1);
  const count=f.calls.length,r=f.run();assert.equal(r.available,1);assert.equal(r.request_budget.cli_attempts,0);assert.equal(r.request_budget.complete,true);assert.equal(f.calls.length,count);
});

test('eight interrupted claims are the fixed bound; dead recovery never makes a ninth request',t=>{
  const f=fixture(t);f.deps.ownerState=()=> 'dead';
  for(let i=0;i<8;i++) {f.settings.remoteBusyAt=f.remoteLeases+1;const r=f.run();assert.equal(r.request_budget.stop_reason,'sync_busy');f.advance(121000);}
  const before=f.remoteLeases,r=f.run();assert.equal(r.request_budget.cli_attempts,0);assert.equal(f.remoteLeases,before);assert.equal(f.tasks()[0].attempts,8);assert.equal(f.tasks()[0].state,'exhausted');
});

test('monotonic rollback fails before admission with incomplete timing receipt',t=>{
  const f=fixture(t);let n=0;f.deps.monotonicClock=()=>n++===0?100:50;
  const r=f.run();assert.equal(r.outcome,'clock_unavailable');assert.equal(r.request_budget.complete,false);assert.equal(r.request_budget.elapsed_ms,null);assert.equal(f.calls.length,0);assert.equal(f.localLeases,0);
});

test('local preparation leaving less than three remote seconds never claims or starts self',t=>{
  const f=fixture(t);f.options.maxSeconds=3;
  const lease=f.deps.tryAcquireLease;f.deps.tryAcquireLease=()=>{const v=lease();f.clock+=10;return v;};
  const r=f.run();assert.equal(r.request_budget.stop_reason,'time_budget');assert.equal(f.calls.length,0);assert.equal(f.tasks()[0].state,'pending');assert.equal(f.tasks()[0].attempts,0);
});

test('queued account evidence becoming invalid does not pin a later resource',t=>{
  const f=fixture(t,2);assert.equal(f.run().available,1);
  sqliteExec(f.db,`UPDATE records SET canonical_json=json_set(canonical_json,'$.sender_name_account_key',${q(sha('synthetic-other-account'))}) WHERE id=1;`);
  assert.equal(f.run().outcome,'source_changed');assert.equal(f.tasks()[0].reason,'source_changed');f.add();assert.equal(f.run().available,1);
});

test('generation change between selection and claim rolls back before requests',t=>{
  const f=fixture(t);let changed=false;
  f.deps.sqliteWrite=(db,sql,label)=>{if(!changed&&sql.includes("SET state='running',attempt_token")){changed=true;sqliteExec(db,'UPDATE lark_im_resource_work SET generation=generation+1;');}return sqliteQuery(db,sql,label);};
  const r=f.run();assert.equal(r.outcome,'execution_failed');assert.equal(f.calls.length,0);assert.equal(f.tasks()[0].state,'pending');assert.equal(f.tasks()[0].attempts,0);
});

test('result generation conflict cannot overwrite another queue generation or report success',t=>{
  const f=fixture(t);f.settings.onProfile=n=>{if(n===2)sqliteExec(f.db,'UPDATE lark_im_resource_work SET generation=generation+1;');};
  const r=f.run();assert.equal(r.ok,false);assert.equal(r.outcome,'execution_failed');assert.equal(f.tasks()[0].state,'running');assert.equal(f.tasks()[0].generation,2);
});


test('bounded recovery cursor passes alive and unknown expired owners on the next invocation',t=>{
  const f=fixture(t,3);f.settings.remoteBusyAt=1;f.run();f.settings.remoteBusyAt=0;
  const ordered=sqliteQuery(f.db,'SELECT work_key,record_id FROM lark_im_resource_work ORDER BY work_key;');
  for(const [i,x] of ordered.entries())sqliteExec(f.db,`UPDATE lark_im_resource_work SET state='running',attempt_token=${q(`synthetic-token-${i}`)},claim_owner=${q(`synthetic-owner-${i}`)},claim_until_ms=${f.wall-1000+i},attempts=1,generation=generation+1 WHERE work_key=${q(x.work_key)};`);
  const before=f.tasks(),seen=[];f.deps.ownerState=owner=>{seen.push(owner);return owner.endsWith('0')?'alive':owner.endsWith('1')?'unknown':'dead';};
  assert.equal(f.run().request_budget.cli_attempts,0);
  assert.deepEqual(seen,['synthetic-owner-0','synthetic-owner-1']);
  const persisted=sqliteQuery(f.db,'SELECT recovery_after_work_key FROM lark_im_resource_scan;')[0].recovery_after_work_key;
  assert.equal(persisted,ordered[1].work_key);
  seen.length=0;
  // A fresh invocation consumes only persisted database state, no process cursor.
  const result=executeResourceWork({...f.options},{...f.deps});
  assert.equal(result.available,1,JSON.stringify(result));assert.equal(seen.length,2);assert(seen.includes('synthetic-owner-2'));
  assert.equal(f.tasks().find(x=>x.work_key===ordered[2].work_key).state,'available');
  for(const x of before.filter(x=>x.work_key!==ordered[2].work_key))assert.deepEqual(f.tasks().find(y=>y.work_key===x.work_key),x,'live/unknown claim is unchanged');
});

for(const outsidePayload of [false,true])test(`changed-source observation CAS rejects restoration before commit (outside payload ${outsidePayload})`,t=>{
  const f=fixture(t,2);assert.equal(f.run().available,1);
  const original=sqliteQuery(f.db,'SELECT canonical_json,body FROM records WHERE id=1;')[0];
  sqliteExec(f.db,outsidePayload?`UPDATE records SET body=${q('x'.repeat(128*1024))} WHERE id=1;`:`UPDATE records SET canonical_json=json_set(canonical_json,'$.chat_name','Synthetic temporary source') WHERE id=1;`);
  const lease=f.deps.tryAcquireLease;let restored=false;
  f.deps.tryAcquireLease=args=>{if(!restored){restored=true;sqliteExec(f.db,`UPDATE records SET canonical_json=${q(original.canonical_json)},body=${q(original.body)} WHERE id=1;`);}return lease(args);};
  const scanBefore=sqliteQuery(f.db,'SELECT * FROM lark_im_resource_scan;')[0];
  const rejected=f.run();assert.equal(rejected.ok,false);assert.equal(rejected.outcome,'execution_failed');
  assert.deepEqual(sqliteQuery(f.db,'SELECT * FROM lark_im_resource_scan;')[0],scanBefore,'restored source rejects the entire selection-turn transaction');
  assert.equal(rejected.processed,0);assert.equal(rejected.available,0);assert.equal(rejected.blocked,0);
  assert.equal(f.tasks()[0].state,'pending');assert.equal(f.tasks()[0].attempts,0);
  assert.equal(f.run().available,1,'restored original source remains normally serviceable');
});

test('normal discovery reopens a source_changed task when its original exact source returns',t=>{
  const f=fixture(t,2);assert.equal(f.run().available,1);
  const original=sqliteQuery(f.db,'SELECT canonical_json FROM records WHERE id=1;')[0].canonical_json;
  sqliteExec(f.db,`UPDATE records SET canonical_json=json_set(canonical_json,'$.sender_name_account_key',${q(sha('synthetic-other-account'))}) WHERE id=1;`);
  assert.equal(f.run().outcome,'source_changed');assert.equal(f.tasks()[0].state,'blocked');
  sqliteExec(f.db,`UPDATE records SET canonical_json=${q(original)} WHERE id=1;`);f.advance(61000);
  assert.equal(f.run().available,1,'same original fence can re-enter after source_changed');assert.equal(f.tasks()[0].state,'available');
});

test('task result CAS failure publishes no successful or blocked task counter',t=>{
  const f=fixture(t);f.settings.onProfile=n=>{if(n===2)sqliteExec(f.db,'UPDATE lark_im_resource_work SET generation=generation+1;');};
  const r=f.run();assert.equal(r.ok,false);assert.equal(r.outcome,'execution_failed');
  assert.equal(r.processed,0);assert.equal(r.available,0);assert.equal(r.blocked,0);assert.equal(f.tasks()[0].state,'running');
});


test('result changed-source observation is fenced and no task success leaks before commit',t=>{
  const f=fixture(t),original=sqliteQuery(f.db,'SELECT body FROM records WHERE id=1;')[0].body;
  let restore=false;const lease=f.deps.tryAcquireLease;
  f.deps.tryAcquireLease=args=>{if(restore){restore=false;sqliteExec(f.db,`UPDATE records SET body=${q(original)} WHERE id=1;`);}return lease(args);};
  f.deps.enrichResources=(options,deps)=>{const r=enrichResources(options,deps);assert.equal(r.available,1);sqliteExec(f.db,"UPDATE records SET body='Synthetic changed source after publication' WHERE id=1;");restore=true;return r;};
  const result=f.run();assert.equal(result.outcome,'execution_failed');assert.equal(result.ok,false);assert.equal(result.available,0);assert.equal(result.processed,0);assert.equal(result.blocked,0);
  assert.equal(f.tasks()[0].state,'running');assert.equal(sqliteQuery(f.db,'SELECT body FROM records WHERE id=1;')[0].body,original);
  assert.equal(loadMessages(f.db,{limit:20,resourceDir:f.resourceDir})[0].readiness.state,'ready','a safe sidecar is not deleted by later queue CAS rejection');
});

test('same-binding source restoration preserves attempt budget and existing failure counts',t=>{
  const f=fixture(t,2);assert.equal(f.run().available,1);
  const original=sqliteQuery(f.db,'SELECT canonical_json FROM records WHERE id=1;')[0].canonical_json;
  sqliteExec(f.db,`UPDATE lark_im_resource_work SET attempts=7,failures=1,deferrals=2 WHERE record_id=1;
    UPDATE records SET canonical_json=json_set(canonical_json,'$.sender_name_account_key',${q(sha('synthetic-other-account'))}) WHERE id=1;`);
  assert.equal(f.run().outcome,'source_changed');
  sqliteExec(f.db,`UPDATE records SET canonical_json=${q(original)} WHERE id=1;`);f.advance(61000);
  assert.equal(f.run().available,1);assert.equal(f.tasks()[0].attempts,8);assert.equal(f.tasks()[0].failures,1);assert.equal(f.tasks()[0].deferrals,2);
  const calls=f.calls.length;
  sqliteExec(f.db,"UPDATE lark_im_resource_work SET state='blocked',reason='source_changed' WHERE record_id=1;");f.advance(61000);
  assert.equal(f.run().request_budget.cli_attempts,0);assert.equal(f.calls.length,calls);assert.equal(f.tasks()[0].state,'exhausted');assert.equal(f.tasks()[0].attempts,8);
});

test('recovery cursor transaction conflict preserves the expired claim and cursor',t=>{
  const f=fixture(t);f.settings.remoteBusyAt=1;f.run();f.advance(121000);f.deps.ownerState=()=> 'dead';
  const before=f.tasks()[0];let changed=false;
  f.deps.sqliteWrite=(db,sql,label)=>{if(!changed&&sql.includes('SET recovery_after_work_key=')){changed=true;sqliteExec(db,'UPDATE lark_im_resource_scan SET generation=generation+1;');}return sqliteQuery(db,sql,label);};
  const result=f.run();assert.equal(result.outcome,'execution_failed');assert.equal(result.request_budget.cli_attempts,0);assert.deepEqual(f.tasks()[0],before);
  assert.equal(sqliteQuery(f.db,'SELECT recovery_after_work_key FROM lark_im_resource_scan;')[0].recovery_after_work_key,'');
});

test('recovery cannot clear a changed owner or expiry even with the same task token',t=>{
  const f=fixture(t);f.settings.remoteBusyAt=1;f.run();f.advance(121000);f.deps.ownerState=()=> 'dead';
  const before=f.tasks()[0];let changed=false;
  f.deps.sqliteWrite=(db,sql,label)=>{if(!changed&&sql.includes('SET recovery_after_work_key=')){changed=true;sqliteExec(db,`UPDATE lark_im_resource_work SET claim_owner='synthetic-replaced-owner',claim_until_ms=${f.wall+120000};`);}return sqliteQuery(db,sql,label);};
  assert.equal(f.run().request_budget.cli_attempts,0);const after=f.tasks()[0];
  assert.equal(after.state,'running');assert.equal(after.claim_owner,'synthetic-replaced-owner');assert.equal(after.claim_until_ms,f.wall+120000);assert.equal(after.attempt_token,before.attempt_token);assert.equal(after.generation,before.generation);
});

test('confirmed denial task CAS failure does not publish a blocked task counter',t=>{
  const f=fixture(t);f.settings.denied=true;f.settings.onProfile=n=>{if(n===2)sqliteExec(f.db,'UPDATE lark_im_resource_work SET generation=generation+1;');};
  const r=f.run();assert.equal(r.ok,false);assert.equal(r.outcome,'execution_failed');assert.equal(r.blocked,0);assert.equal(r.processed,0);assert.equal(r.available,0);assert.equal(f.tasks()[0].state,'running');
});


test('5500 unrelated gapped history rows cannot consume the image discovery page or hide four images',t=>{
  const f=fixture(t,0),template=f.add('text');
  // Five thousand earlier rows hide the images from the old first historical
  // page; five hundred later rows also hide them from the old newest page.
  const texts=(count,idStart,label)=>sqliteExec(f.db,`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<${count-1})
    INSERT INTO records(id,source_id,record_type,external_id,external_version,first_seen_scope_id,
      actor_id,container_id,direction,occurred_at,occurred_at_ms,raw_json,canonical_json,content_hash,body)
    SELECT ${idStart}+x*3,r.source_id,r.record_type,'om_synthetic_deep_${label}_'||x,r.external_version,r.first_seen_scope_id,
      r.actor_id,r.container_id,r.direction,r.occurred_at,r.occurred_at_ms,r.raw_json,r.canonical_json,r.content_hash,r.body
    FROM n JOIN records r ON r.id=${template};`);
  texts(4999,4,'older');f.nextId=14999;
  const images=Array.from({length:4},()=>f.add());
  texts(500,15102,'newer');f.nextId=16600;
  assert.equal(sqliteQuery(f.db,'SELECT COUNT(*) n FROM records;')[0].n,5504);
  assert.equal(sqliteQuery(f.db,`SELECT COUNT(*) n FROM records WHERE id<${images[0]};`)[0].n,5000);
  assert.equal(sqliteQuery(f.db,`SELECT COUNT(*) n FROM records WHERE id>${images.at(-1)};`)[0].n,500);
  const before=sqliteQuery(f.db,'SELECT * FROM records ORDER BY id;');
  const plan=sqliteQuery(f.db,`.explain off\nEXPLAIN QUERY PLAN SELECT id FROM records INDEXED BY ${RESOURCE_CANDIDATE_INDEX}
    WHERE ${RESOURCE_CANDIDATE_WHERE} AND id>0 AND id<=20000 ORDER BY id LIMIT 20;`);
  assert(plan.some(row=>row.detail.includes(RESOURCE_CANDIDATE_INDEX)),JSON.stringify(plan));
  const first=f.run();assert.equal(first.available,1,JSON.stringify(first));
  assert.deepEqual(f.tasks().map(row=>row.record_id),images);
  for(let n=0;n<3;n++) {f.add('text');f.advance(61000);assert.equal(f.run().available,1);}
  assert.deepEqual(f.tasks().map(row=>row.state),['available','available','available','available']);
  assert.equal(downloads(f).length,4);
  assert.deepEqual(sqliteQuery(f.db,'SELECT * FROM records WHERE id<16600 ORDER BY id;'),before);
});

test('candidate index tolerates invalid JSON and conflicting type evidence without authorizing a resource',t=>{
  const f=fixture(t,0);const invalid=f.add(),conflict=f.add('text',{msg_type:'image'}),nested=f.add();
  sqliteExec(f.db,`PRAGMA ignore_check_constraints=ON;
    UPDATE records SET raw_json='not JSON',canonical_json='not JSON' WHERE id=${invalid};
    UPDATE records SET raw_json=json_object('raw_api',json(raw_json)),canonical_json=json_remove(canonical_json,'$.msg_type') WHERE id=${nested};
    PRAGMA ignore_check_constraints=OFF;`);
  // Corrupt JSON is deliberately injected past the schema constraint only to
  // exercise the conservative index. It is not admitted to the producer.
  const conflicting=sqliteQuery(f.db,`SELECT * FROM records WHERE id=${conflict};`)[0];
  assert.equal(resourceWorkIdentity(f.db,conflicting),null);
  assert.equal(downloads(f).length,0);
  assert.deepEqual(sqliteQuery(f.db,`SELECT id FROM records INDEXED BY ${RESOURCE_CANDIDATE_INDEX}
    WHERE ${RESOURCE_CANDIDATE_WHERE} ORDER BY id;`).map(row=>row.id),[conflict,nested]);
  const validId=f.add(),valid=sqliteQuery(f.db,`SELECT * FROM records WHERE id=${validId};`)[0];
  const identity=resourceWorkIdentity(f.db,valid);
  assert(identity,'the two-argument validator must accept exact valid image evidence');
  assert.equal(identity.record_id,validId);
});


test('021 upgrade preserves nonzero scan and task generations and resumes remaining image work',t=>{
  const f=fixture(t,3);assert.equal(f.run().available,1);
  // Use the actual existing scheduler tables, not a replacement schema.
  const names=sqliteQuery(f.db,"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'lark_im_resource%';").map(x=>x.name);
  const snapshots=names.map(name=>[name,sqliteQuery(f.db,`SELECT * FROM ${name};`)]);
  sqliteExec(f.db,`DROP INDEX records_resource_image_candidates; DELETE FROM schema_migrations WHERE version='021';`);
  ensureInitialized(f.db);
  for(const [name,before] of snapshots)assert.deepEqual(sqliteQuery(f.db,`SELECT * FROM ${name};`),before);
  assert.equal(sqliteQuery(f.db,"SELECT count(*) n FROM schema_migrations WHERE version='021';")[0].n,1);
  assert.equal(f.run().available,1);assert.equal(f.run().available,1);
  assert.equal(downloads(f).length,3);
});


test('invalid image prefixes advance bounded discovery and cannot permanently hide a middle valid image',t=>{
  const f=fixture(t,0);
  for(let i=0;i<25;i++)f.add('image',{body:{content:'{"image_key":""}'}});
  const target=f.add();
  for(let i=0;i<25;i++)f.add('image',{body:{content:'{"image_key":""}'}});
  const before=sqliteQuery(f.db,'SELECT * FROM records ORDER BY id;');
  const first=f.run();assert.equal(first.processed,0);assert.equal(f.tasks().length,0);assert.equal(downloads(f).length,0);
  assert.equal(sqliteQuery(f.db,'SELECT after_id FROM lark_im_resource_scan;')[0].after_id,20);
  f.advance(61000);const second=f.run();assert.equal(second.available,1,JSON.stringify(second));
  assert.deepEqual(f.tasks().map(x=>x.record_id),[target]);assert.equal(downloads(f).length,1);
  assert.deepEqual(sqliteQuery(f.db,'SELECT * FROM records ORDER BY id;'),before);
});


// A new Node process on every turn proves that no in-memory cursor repairs the
// queue. Only the acquisition boundary is stubbed: this is not download/readiness
// evidence, and all lease/clock/SQLite inputs belong to this synthetic fixture.
function restartedSourceChangeTurn(f,stableOldest) {
  const code=`
    import {executeResourceWork,resourceWorkIdentity} from ${JSON.stringify(new URL('../src/maintenance/resource-work.mjs',import.meta.url).href)};
    import {sqliteExec,sqliteQuery,quoteSql as q} from ${JSON.stringify(new URL('../dist/storage/sqlite/ingestion-store.js',import.meta.url).href)};
    const db=${JSON.stringify(f.db)},oldest=${stableOldest},wall=${f.wall},selected=[];
    const result=executeResourceWork({db,maxCliAttempts:3,maxSelfAttempts:2,maxSeconds:30},{
      now:()=>wall,monotonicClock:()=>1,tryAcquireLease:()=>({state:'acquired',release(){}}),
      sqliteJson(db,sql,label){
        const rows=sqliteQuery(db,sql,label);
        if(label==='select resource work'&&rows[0]&&rows[0].record_id!==oldest){
          const task=rows[0];
          sqliteExec(db,\`UPDATE records SET canonical_json=json_set(canonical_json,'$.chat_name',\${q('Synthetic concurrent name '+task.record_id+' turn ${f.nextId}')}) WHERE id=\${task.record_id};\`);
          const current=resourceWorkIdentity(db,sqliteQuery(db,\`SELECT * FROM records WHERE id=\${task.record_id};\`)[0]);
          if(!current||current.work_key!==task.work_key||current.binding_key!==task.binding_key||current.source_fence===task.source_fence)throw Error('synthetic source-churn setup failed');
        }
        return rows;
      },
      enrichResources(options){selected.push(options.recordIds[0]);return {request_budget:null,results:[{record_id:options.recordIds[0],state:'available'}]};}
    });
    process.stdout.write(JSON.stringify({pid:process.pid,result,selected,scan:sqliteQuery(db,'SELECT * FROM lark_im_resource_scan;')[0]}));
  `;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:15000});
  assert.equal(child.status,0,JSON.stringify({status:child.status,signal:child.signal,error:child.error?.message,stdout:child.stdout,stderr:child.stderr}));
  return JSON.parse(child.stdout);
}

test('source-change transitions consume durable fresh turns so stable oldest is attempted on turn three across restarts',t=>{
  const f=fixture(t),oldest=1,original=sqliteQuery(f.db,'SELECT * FROM records WHERE id=1;')[0],turns=[];
  for(let i=0;i<9;i++){f.add();turns.push(restartedSourceChangeTurn(f,oldest));}
  assert.equal(new Set(turns.map(x=>x.pid)).size,9,'nine independent processes, one durable queue');
  assert.deepEqual(turns.map(x=>x.scan.priority_streak),[1,2,0,1,2,0,1,2,0]);
  assert.deepEqual(turns.map(x=>x.selected),[[],[],[oldest],[],[],[],[],[],[]],
    'stable oldest must receive the third service opportunity despite ongoing newer source changes');
  assert.deepEqual(turns.map(x=>x.result.outcome),['source_changed','source_changed','processed',...Array(6).fill('source_changed')]);
  for(const turn of turns){
    assert.equal(turn.result.request_budget.cli_attempts,0);assert.equal(turn.result.request_budget.self_attempts,0);
    assert.equal(turn.result.request_budget.max_cli_attempts,3);assert.equal(turn.result.request_budget.max_self_attempts,2);assert.equal(turn.result.request_budget.max_seconds,30);
  }
  const tasks=f.tasks(),stable=tasks.find(x=>x.record_id===oldest);
  assert.equal(stable.attempts,1);assert.equal(stable.state,'available');
  for(const task of tasks.filter(x=>x.reason==='source_changed')){
    assert.equal(task.attempts,0);assert.equal(task.failures,0);assert.equal(task.deferrals,0);assert.equal(task.last_attempt_at_ms,0);
    assert.equal(task.attempt_token,null);assert.equal(task.claim_owner,null);assert.equal(task.claim_until_ms,0);
  }
  assert.equal(stable.enqueued_at_ms,f.wall);assert.deepEqual(sqliteQuery(f.db,'SELECT * FROM records WHERE id=1;')[0],original);
  t.diagnostic(JSON.stringify({opportunities:turns.length,processes:new Set(turns.map(x=>x.pid)).size,firstStableAttempt:turns.findIndex(x=>x.selected.includes(oldest))+1,streaks:turns.map(x=>x.scan.priority_streak)}));
});

for(const replacement of ['scan generation','task generation','running owner'])test(`source-change turn CAS rejects concurrent ${replacement} without touching its replacement`,t=>{
  const f=fixture(t,2);assert.equal(f.run().available,1);
  sqliteExec(f.db,"UPDATE records SET canonical_json=json_set(canonical_json,'$.chat_name','Synthetic changed before selection') WHERE id=1;");
  const calls=f.calls.length;let expectedTask,expectedScan,transitions=0;
  f.deps.sqliteWrite=(db,sql,label)=>{
    if(sql.includes("SET state='blocked',reason='source_changed'")){
      transitions++;
      if(replacement==='scan generation')sqliteExec(db,'UPDATE lark_im_resource_scan SET generation=generation+1,priority_streak=2;');
      else if(replacement==='task generation')sqliteExec(db,'UPDATE lark_im_resource_work SET generation=generation+1 WHERE record_id=1;');
      else sqliteExec(db,`UPDATE lark_im_resource_work SET state='running',attempt_token='synthetic-new-owner-token',claim_owner='synthetic-new-owner',claim_until_ms=${f.wall+120000} WHERE record_id=1;`);
      expectedTask=f.tasks()[0];expectedScan=sqliteQuery(db,'SELECT * FROM lark_im_resource_scan;')[0];
    }
    return sqliteQuery(db,sql,label);
  };
  const result=f.run();assert.equal(transitions,1);assert.equal(result.ok,false);assert.equal(result.outcome,'execution_failed');
  assert.equal(result.processed,0);assert.equal(result.available,0);assert.equal(result.blocked,0);assert.equal(f.calls.length,calls);
  assert.deepEqual(f.tasks()[0],expectedTask);assert.deepEqual(sqliteQuery(f.db,'SELECT * FROM lark_im_resource_scan;')[0],expectedScan);
});

for(const actualCommit of [false,true])test(`unknown source-change write acknowledgement reports failure without replay (actual commit ${actualCommit})`,t=>{
  const f=fixture(t,2);assert.equal(f.run().available,1);
  sqliteExec(f.db,"UPDATE records SET canonical_json=json_set(canonical_json,'$.chat_name','Synthetic changed before unknown write') WHERE id=1;");
  const beforeTask=f.tasks()[0],beforeScan=sqliteQuery(f.db,'SELECT * FROM lark_im_resource_scan;')[0],calls=f.calls.length;let writes=0;
  f.deps.sqliteWrite=(db,sql,label)=>{
    if(sql.includes("SET state='blocked',reason='source_changed'")){
      writes++;if(actualCommit)sqliteQuery(db,sql,label);
      throw Object.assign(new Error('synthetic unknown SQLite process outcome'),{status:null,signal:'SIGKILL'});
    }
    return sqliteQuery(db,sql,label);
  };
  const result=f.run(),afterTask=f.tasks()[0],afterScan=sqliteQuery(f.db,'SELECT * FROM lark_im_resource_scan;')[0];
  assert.equal(writes,1,'unknown transaction is not retried');assert.equal(result.ok,false);assert.equal(result.outcome,'execution_failed');
  assert.equal(result.processed,0);assert.equal(result.available,0);assert.equal(result.blocked,0);assert.equal(f.calls.length,calls);
  if(actualCommit){
    assert.equal(afterTask.state,'blocked');assert.equal(afterTask.reason,'source_changed');assert.equal(afterTask.generation,beforeTask.generation+1);
    assert.equal(afterScan.generation,beforeScan.generation+1);assert.equal(afterScan.priority_streak,2);
  }else{assert.deepEqual(afterTask,beforeTask);assert.deepEqual(afterScan,beforeScan);}
  assert.equal(afterTask.attempts,beforeTask.attempts);assert.equal(afterTask.attempt_token,beforeTask.attempt_token);
  // A subsequent invocation resumes from durable state. It does not repeat the
  // uncertain transaction and is allowed to see the commit if it actually ran.
  delete f.deps.sqliteWrite;
  const next=f.run();
  assert.equal(next.outcome,actualCommit?'no_eligible_known_resource':'source_changed');
  assert.equal(sqliteQuery(f.db,'SELECT * FROM lark_im_resource_scan;')[0].priority_streak,2);
  assert.equal(f.tasks()[0].generation,beforeTask.generation+1);
});

// Every failure fixture below is synthetic. No CLI/network or production DB is used.
test('resource diagnostic retains actual byte rejection instead of generic retry label',t=>{
  const f=fixture(t);f.settings.bytes=Buffer.from('synthetic non-image bytes');
  const result=f.run(),row=f.tasks()[0];
  assert.deepEqual(result.failure,{stage:'download_validation',reason:'download_image_invalid',persisted:true});
  assert.equal(row.failure_stage,'download_validation');assert.equal(row.failure_reason,'download_image_invalid');
  assert.equal(row.state,'deferred');assert.equal(row.reason,'transient_failure');assert.equal(row.failures,1);
  assert.equal(result.request_budget.cli_attempts,2);assert.equal(result.request_budget.self_attempts,1);
});

test('resource diagnostic distinguishes response validation at identical request counts',t=>{
  const f=fixture(t);f.settings.savedPath='../synthetic-unrelated';
  const result=f.run();
  assert.deepEqual(result.failure,{stage:'download_validation',reason:'download_response_invalid',persisted:true});
  assert.equal(result.request_budget.cli_attempts,2);assert.equal(result.request_budget.self_attempts,1);
  assert.equal(f.tasks()[0].reason,'transient_failure');
  assert(!JSON.stringify(result).includes('synthetic-unrelated'));assert(!JSON.stringify(result).includes(f.root));
});

test('resource diagnostic exact confirmed denial is separate from retry policy',t=>{
  const f=fixture(t);f.settings.denied=true;const result=f.run();
  assert.deepEqual(result.failure,{stage:'resource_request',reason:'permission_denied',persisted:true});
  assert.equal(f.tasks()[0].state,'blocked');assert.equal(f.tasks()[0].failure_reason,'permission_denied');
});

for(const [label,settings,expected] of [
  ['timeout',{response:{status:null,error:{code:'ETIMEDOUT'},stdout:'',stderr:''}},'network_timeout'],
  ['spawn not started',{response:{status:null,pid:0,error:{code:'ENOENT'},stdout:'',stderr:''}},'request_not_started'],
  ['execution unknown',{response:{status:null,pid:0,error:{code:'ETIMEDOUT'},stdout:'',stderr:''}},'request_execution_unknown'],
  ['local permission text',{localDenied:true},'unknown'],
  ['unknown API result',{transient:true},'unknown'],
  ['wrong file size',{size:PNG.length+1},'download_file_invalid'],
  ['wrong MIME',{mime:'image/gif'},'download_image_invalid'],
  ['unsupported bytes',{bytes:Buffer.from('5249464612000000574542505650384c060000002f0000000000','hex'),mime:'image/webp'},'resource_format_unsupported'],
])test(`resource diagnostic ${label} retains bounded cause without changing retries`,t=>{
  const f=fixture(t);Object.assign(f.settings,settings);const result=f.run(),row=f.tasks()[0];
  const stage=['wrong file size','wrong MIME','unsupported bytes'].includes(label)?'download_validation':'resource_request';
  assert.deepEqual(result.failure,{stage,reason:expected,persisted:true});
  assert.equal(row.failure_reason,expected);assert.equal(row.reason,'transient_failure');assert.equal(row.state,'deferred');assert.equal(row.failures,1);
  assert.equal(result.request_budget.cli_attempts,2);assert.equal(result.request_budget.self_attempts,1);
});

for(const mode of ['changed','busy'])test(`resource diagnostic failed denial closing ${mode} is not confirmed remote refusal`,t=>{
  const f=fixture(t);f.settings.denied=true;
  if(mode==='changed')f.settings.profile=n=>n===2?'ou_synthetic_different_closer':SELF;
  else f.settings.remoteBusyAt=3;
  const result=f.run();
  assert.deepEqual(result.failure,{stage:'closing_account',reason:mode==='changed'?'account_changed':'sync_busy',persisted:mode==='changed'});
  assert.notEqual(f.tasks()[0].reason,'permission_denied');assert.notEqual(f.tasks()[0].failure_reason,'permission_denied');
  if(mode==='busy'){
    assert.equal(f.tasks()[0].state,'running');assert.equal(f.tasks()[0].failure_reason,null);
    assert.equal(f.localLeases,2,'stopped session cannot take a later metadata lease to persist diagnostics');
  }
});

test('resource diagnostic remains uncommitted when exact result CAS loses',t=>{
  const f=fixture(t);f.settings.bytes=Buffer.from('synthetic rejected bytes');
  f.settings.onDownload=()=>sqliteExec(f.db,'UPDATE lark_im_resource_work SET generation=generation+1;');
  const result=f.run();assert.equal(result.outcome,'execution_failed');
  assert.deepEqual(result.failure,{stage:'download_validation',reason:'download_image_invalid',persisted:false});
  assert.equal(f.tasks()[0].state,'running');assert.equal(f.tasks()[0].failure_stage,null);assert.equal(f.tasks()[0].failure_reason,null);
});

test('resource diagnostic restart reads retained cause and normal success clears it',t=>{
  const f=fixture(t);f.settings.bytes=Buffer.from('synthetic rejected bytes');f.run();
  const program=`import {sqliteQuery} from ${JSON.stringify(new URL('../dist/storage/sqlite/ingestion-store.js',import.meta.url).href)};
    import {normalizeResourceFailure} from ${JSON.stringify(new URL('../src/maintenance/enrich-resources.mjs',import.meta.url).href)};
    const row=sqliteQuery(process.argv[1],'SELECT failure_stage,failure_reason FROM lark_im_resource_work;')[0];
    process.stdout.write(JSON.stringify(normalizeResourceFailure({stage:row.failure_stage,reason:row.failure_reason})));`;
  const restarted=spawnSync(process.execPath,['--input-type=module','-e',program,f.db],{encoding:'utf8',timeout:15000});
  assert.equal(restarted.status,0,restarted.stderr);assert.deepEqual(JSON.parse(restarted.stdout),{stage:'download_validation',reason:'download_image_invalid'});
  f.advance(121000);delete f.settings.bytes;const next=f.run();
  assert.equal(next.available,1);assert.equal(next.failure,null);assert.equal(f.tasks()[0].failure_reason,null);assert.equal(f.tasks()[0].failure_stage,null);
  assert.equal(f.tasks()[0].attempts,2);assert.equal(f.tasks()[0].failures,1,'diagnostics do not reset existing counters');
});

test('resource diagnostic migration preserves pre-022 task byte values and keeps old cause unknown',t=>{
  const f=fixture(t);f.settings.transient=true;f.run();
  sqliteExec(f.db,"DROP TRIGGER lark_resource_failure_attempt_guard; DROP TRIGGER lark_resource_failure_association_guard; ALTER TABLE lark_im_resource_work DROP COLUMN failure_binding_key; ALTER TABLE lark_im_resource_work DROP COLUMN failure_source_fence; ALTER TABLE lark_im_resource_work DROP COLUMN failure_stage; ALTER TABLE lark_im_resource_work DROP COLUMN failure_reason; DELETE FROM schema_migrations WHERE version IN ('022','023');");
  const before=f.tasks();ensureInitialized(f.db);const after=f.tasks();
  assert.deepEqual(after.map(({failure_stage,failure_reason,failure_binding_key,failure_source_fence,...row})=>row),before);
  assert.equal(after[0].failure_stage,null);assert.equal(after[0].failure_reason,null);
  assert.deepEqual(normalizeResourceFailure({stage:after[0].failure_stage,reason:after[0].failure_reason}),{stage:'unknown',reason:'unknown'});
  assert.equal(sqliteQuery(f.db,"SELECT COUNT(*) n FROM schema_migrations WHERE version='022';")[0].n,1);
});

test('resource diagnostic SQL and summary exclude arbitrary strings paths identities and response objects',t=>{
  const f=fixture(t),secret='synthetic-private-payload/'+f.root;
  f.deps.enrichResources=()=>({results:[{record_id:1,state:'blocked',reason:secret,failure:{stage:secret,reason:{payload:secret},extra:secret}}],request_budget:null});
  const result=f.run();assert.deepEqual(result.failure,{stage:'unknown',reason:'unknown',persisted:true});
  const row=f.tasks()[0];assert.equal(row.failure_stage,'unknown');assert.equal(row.failure_reason,'unknown');
  assert.equal(row.state,'blocked');assert.equal(row.reason,'resource_invalid');
  assert(!JSON.stringify(result).includes(secret));
  assert.throws(()=>sqliteExec(f.db,`UPDATE lark_im_resource_work SET failure_reason=${q(secret)};`));
  assert.throws(()=>sqliteExec(f.db,`UPDATE lark_im_resource_work SET failure_stage=${q(secret)};`));
  assert(!JSON.stringify(f.tasks()).includes(secret));
});

for(const reason of ['permission_denied','restricted_mode','bot_user_out_of_chat'])test(`resource diagnostic producer-only ${reason} never upgrades remote evidence`,t=>{
  const f=fixture(t);f.deps.enrichResources=()=>({results:[{record_id:1,state:'blocked',reason,failure:{stage:'resource_request',reason}}],request_budget:null});
  const result=f.run();assert.deepEqual(result.failure,{stage:'resource_request',reason:'unverified_remote_failure',persisted:true});
  assert.equal(f.tasks()[0].reason,'resource_invalid');assert.equal(f.tasks()[0].failure_reason,'unverified_remote_failure');assert.equal(f.calls.length,0);
});

test('resource diagnostic exhaustion preserves final concrete cause without reopening work',t=>{
  const f=fixture(t);f.settings.bytes=Buffer.from('synthetic rejected bytes');
  for(let n=0;n<3;n++){f.run();f.advance(500000);}
  const before=f.tasks()[0],calls=f.calls.length;assert.equal(before.state,'exhausted');assert.equal(before.reason,'retry_exhausted');
  assert.equal(before.failure_reason,'download_image_invalid');assert.equal(f.run().request_budget.cli_attempts,0);assert.equal(f.calls.length,calls);
  assert.deepEqual(f.tasks()[0],before);
});

test('resource diagnostic migration CHECK vocabulary agrees with bounded exports',t=>{
  const f=fixture(t);f.settings.transient=true;f.run();
  for(const stage of RESOURCE_FAILURE_STAGES)sqliteExec(f.db,`UPDATE lark_im_resource_work SET failure_stage=${q(stage)};`);
  for(const reason of RESOURCE_FAILURE_REASONS)sqliteExec(f.db,`UPDATE lark_im_resource_work SET failure_reason=${q(reason)};`);
});

test('resource diagnostic new attempt clears prior cause in claim CAS before unknown interruption',t=>{
  const f=fixture(t);f.settings.bytes=Buffer.from('synthetic rejected bytes');f.run();
  const old=f.tasks()[0];assert.equal(old.failure_reason,'download_image_invalid');
  f.advance(121000);f.settings.remoteBusyAt=f.remoteLeases+1;
  const result=f.run(),current=f.tasks()[0];assert.equal(result.request_budget.stop_reason,'sync_busy');
  assert.equal(current.state,'running');assert.equal(current.attempts,2);assert(current.last_attempt_at_ms>old.last_attempt_at_ms);
  assert.equal(current.failure_stage,null);assert.equal(current.failure_reason,null);
  assert.deepEqual(result.failure,{stage:'opening_account',reason:'sync_busy',persisted:false});
});

const retainedFailure=row=>Object.fromEntries(['failure_stage','failure_reason','failure_binding_key','failure_source_fence'].map(key=>[key,row[key]]));
const currentResource=f=>resourceWorkIdentity(f.db,readMessageSnapshot(f.db,{recordIds:[1]}).rows[0]);
const exhaustInvalid=f=>{f.settings.bytes=Buffer.from('Synthetic invalid image bytes');for(let i=0;i<3;i++){assert.equal(f.run().outcome,i===2?'exhausted':'batch_deferred');f.advance(500000);}};
const scanWithoutClaim=f=>{const acquire=f.deps.tryAcquireLease;let calls=0;f.deps.tryAcquireLease=args=>++calls===1?acquire(args):{state:'busy'};};

for(const field of ['chat_name','sender_name','recipient_name'])test(`resource association retains actual exhausted failure across derived ${field}`,t=>{
  const f=fixture(t);exhaustInvalid(f);const before=f.tasks()[0],calls=f.calls.length;
  assert.equal(before.failure_binding_key,before.binding_key);assert.equal(before.failure_source_fence,before.source_fence);
  assert.equal(resourceWorkFailureEvidence(before,currentResource(f)).applicability,'exact_source');
  sqliteExec(f.db,`UPDATE records SET canonical_json=json_set(canonical_json,'$.${field}','Synthetic corrected name') WHERE id=1;`);
  const current=currentResource(f);
  assert.equal(resourceWorkFailureEvidence(before,current).applicability,'same_binding','fresh source comparison already sees drift before discovery');
  f.advance(61000);assert.equal(f.run().request_budget.cli_attempts,0);const after=f.tasks()[0];
  assert.equal(f.calls.length,calls);assert.notEqual(after.source_fence,before.source_fence);
  assert.deepEqual(retainedFailure(after),retainedFailure(before));
  for(const key of ['work_key','binding_key','state','reason','attempts','failures','deferrals','last_attempt_at_ms'])assert.equal(after[key],before[key],key);
  assert.equal(resourceWorkFailureEvidence(after,current).applicability,'same_binding');
});

test('resource association retains old binding on true version drift until the existing new-claim policy runs',t=>{
  const f=fixture(t);exhaustInvalid(f);const before=f.tasks()[0],calls=f.calls.length;
  sqliteExec(f.db,"UPDATE records SET external_version='Synthetic new resource version' WHERE id=1;");
  f.advance(61000);scanWithoutClaim(f);assert.equal(f.run().request_budget.stop_reason,'sync_busy');const after=f.tasks()[0];
  assert.equal(f.calls.length,calls);assert.equal(after.work_key,before.work_key);assert.notEqual(after.binding_key,before.binding_key);
  assert.deepEqual(retainedFailure(after),retainedFailure(before));
  assert.equal(resourceWorkFailureEvidence(after,currentResource(f)).applicability,'different_binding');
  assert.equal(after.state,'pending');assert.equal(after.attempts,0);assert.equal(after.failures,0,'original true-binding policy unchanged');
});

for(const change of ['resource','account'])test(`resource association does not transfer evidence to a different ${change} task`,t=>{
  const f=fixture(t);exhaustInvalid(f);const before=f.tasks()[0],calls=f.calls.length;
  const row=readMessageSnapshot(f.db,{recordIds:[1]}).rows[0],raw=JSON.parse(row.raw_json),canonical=JSON.parse(row.canonical_json);
  let actor=row.actor_id;
  if(change==='resource')raw.body.content=JSON.stringify({image_key:'synthetic_changed_resource'});
  else {actor='ou_synthetic_replacement_owner';raw.sender.id=actor;canonical.sender_id=actor;}
  const json=JSON.stringify(raw);
  sqliteExec(f.db,`UPDATE records SET actor_id=${q(actor)},raw_json=${q(json)},content_hash=${q(sha(json))},canonical_json=${q(JSON.stringify(canonical))} WHERE id=1;`);
  const identity=currentResource(f);assert(identity);assert.notEqual(identity.work_key,before.work_key);
  assert.equal(resourceWorkFailureEvidence(before,identity).applicability,'different_binding');
  f.advance(61000);scanWithoutClaim(f);assert.equal(f.run().request_budget.stop_reason,'sync_busy');
  assert.equal(f.calls.length,calls);assert.deepEqual(f.tasks().find(row=>row.work_key===before.work_key),before);
  const added=f.tasks().find(row=>row.work_key===identity.work_key);assert(added);assert.equal(added.state,'pending');assert.equal(added.attempts,0);
  assert.equal(resourceWorkFailureEvidence(added,identity),null);
});

test('resource association retains permanent denial without attributing it to corrected binding',t=>{
  const f=fixture(t);f.settings.denied=true;assert.equal(f.run().outcome,'blocked');const before=f.tasks()[0],calls=f.calls.length;
  sqliteExec(f.db,"UPDATE records SET external_version='Synthetic corrected denied version' WHERE id=1;");
  f.advance(61000);assert.equal(f.run().request_budget.cli_attempts,0);const after=f.tasks()[0];
  assert.equal(f.calls.length,calls);assert.deepEqual(retainedFailure(after),retainedFailure(before));
  assert.equal(after.reason,'permission_denied');assert.equal(after.state,'blocked');assert.equal(after.attempts,before.attempts);
  assert.equal(resourceWorkFailureEvidence(after,currentResource(f)).applicability,'different_binding');
});

test('resource association pre-claim source mismatch preserves prior attempt and only reports local diagnosis',t=>{
  const f=fixture(t);f.settings.bytes=Buffer.from('Synthetic invalid image bytes');f.run();const before=f.tasks()[0],calls=f.calls.length;
  sqliteExec(f.db,`UPDATE records SET canonical_json=json_set(canonical_json,'$.sender_name_account_key',${q(sha('synthetic-other-account'))}) WHERE id=1;`);
  f.advance(121000);const result=f.run(),after=f.tasks()[0];
  assert.equal(result.outcome,'source_changed');assert.deepEqual(result.failure,{stage:'source_fence',reason:'source_changed',persisted:false});
  assert.equal(f.calls.length,calls);assert.equal(after.attempts,before.attempts);assert.equal(after.last_attempt_at_ms,before.last_attempt_at_ms);
  assert.deepEqual(retainedFailure(after),retainedFailure(before));assert.equal(resourceWorkFailureEvidence(after,currentResource(f)).applicability,'unknown');
});

test('resource association post-claim source mismatch records the claimed source instead of changed source',t=>{
  const f=fixture(t),identity=currentResource(f);f.settings.bytes=Buffer.from('Synthetic invalid image bytes');
  f.settings.onDownload=()=>sqliteExec(f.db,"UPDATE records SET canonical_json=json_set(canonical_json,'$.chat_name','Synthetic concurrent title') WHERE id=1;");
  const result=f.run(),after=f.tasks()[0];assert.equal(result.outcome,'source_changed');
  assert.deepEqual(result.failure,{stage:'source_fence',reason:'source_changed',persisted:true});
  assert.equal(after.failure_binding_key,identity.binding_key);assert.equal(after.failure_source_fence,identity.source_fence);
  assert.equal(resourceWorkFailureEvidence(after,currentResource(f)).applicability,'same_binding');
});

test('resource association post-claim real binding drift never adopts the changed binding',t=>{
  const f=fixture(t),claimed=currentResource(f);f.settings.bytes=Buffer.from('Synthetic invalid image bytes');
  f.settings.onDownload=()=>sqliteExec(f.db,"UPDATE records SET external_version='Synthetic version changed during resource request' WHERE id=1;");
  const result=f.run(),after=f.tasks()[0],current=currentResource(f);
  assert.equal(result.outcome,'source_changed');assert.equal(result.failure.persisted,true);
  assert.equal(current.work_key,claimed.work_key);assert.notEqual(current.binding_key,claimed.binding_key);assert.notEqual(current.source_fence,claimed.source_fence);
  assert.equal(after.failure_binding_key,claimed.binding_key);assert.equal(after.failure_source_fence,claimed.source_fence);
  assert.equal(resourceWorkFailureEvidence(after,current).applicability,'different_binding');
  assert.equal(after.attempts,1);assert.equal(after.state,'blocked');assert.equal(downloads(f).length,1);
});

for(const point of ['scan','claim','result'])test(`resource association ${point} CAS conflict cannot partially write diagnostic provenance`,t=>{
  const f=fixture(t);f.settings.bytes=Buffer.from('Synthetic invalid image bytes');f.run();const before=f.tasks()[0];f.advance(121000);
  if(point==='scan')sqliteExec(f.db,"UPDATE records SET canonical_json=json_set(canonical_json,'$.chat_name','Synthetic conflicting title') WHERE id=1;");
  let changed=false;const marker=point==='scan'?'ON CONFLICT(source_id,account_key,work_key)':point==='claim'?"SET state='running',attempt_token":'failure_stage=\'download_validation\'';
  f.deps.sqliteWrite=(db,sql,label)=>{if(!changed&&sql.includes(marker)){changed=true;sqliteExec(db,point==='scan'?'UPDATE lark_im_resource_scan SET generation=generation+1;':'UPDATE lark_im_resource_work SET generation=generation+1;');}return sqliteQuery(db,sql,label);};
  const result=f.run(),after=f.tasks()[0];assert(changed);assert.equal(result.outcome,'execution_failed');
  if(point==='result')assert.deepEqual(retainedFailure(after),{failure_stage:null,failure_reason:null,failure_binding_key:null,failure_source_fence:null},'new claim cleared all fields; rejected result writes none');
  else {assert.deepEqual(retainedFailure(after),retainedFailure(before));assert.equal(after.attempts,before.attempts);assert.equal(after.source_fence,before.source_fence);}
});

test('resource association new claim clears all evidence before interruption and restart; later success remains clear',t=>{
  const f=fixture(t);f.settings.bytes=Buffer.from('Synthetic invalid image bytes');f.run();assert(f.tasks()[0].failure_binding_key);
  f.advance(121000);f.settings.remoteBusyAt=f.remoteLeases+1;assert.equal(f.run().request_budget.stop_reason,'sync_busy');
  const expected={failure_stage:null,failure_reason:null,failure_binding_key:null,failure_source_fence:null};assert.deepEqual(retainedFailure(f.tasks()[0]),expected);
  const program=`import {sqliteQuery} from ${JSON.stringify(new URL('../dist/storage/sqlite/ingestion-store.js',import.meta.url).href)};process.stdout.write(JSON.stringify(sqliteQuery(process.argv[1],'SELECT failure_stage,failure_reason,failure_binding_key,failure_source_fence FROM lark_im_resource_work;')[0]));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',program,f.db],{encoding:'utf8',timeout:15000});assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),expected);
  f.advance(121000);f.deps.ownerState=()=> 'dead';delete f.settings.bytes;assert.equal(f.run().available,1);assert.deepEqual(retainedFailure(f.tasks()[0]),expected);
});

test('resource association success clears an already retained failed attempt',t=>{
  const f=fixture(t);f.settings.bytes=Buffer.from('Synthetic invalid image bytes');f.run();f.advance(121000);delete f.settings.bytes;
  assert.equal(f.run().available,1);const row=f.tasks()[0];assert.equal(resourceWorkFailureEvidence(row,currentResource(f)),null);
  assert.equal(row.failure_binding_key,null);assert.equal(row.failure_source_fence,null);assert.equal(row.failures,1);assert.equal(row.attempts,2);
});

test('resource association 023 migration retains all prior values without inventing provenance and rolls back atomically',t=>{
  const f=fixture(t);f.settings.bytes=Buffer.from('Synthetic invalid image bytes');f.run();
  sqliteExec(f.db,"DROP TRIGGER lark_resource_failure_attempt_guard; DROP TRIGGER lark_resource_failure_association_guard; ALTER TABLE lark_im_resource_work DROP COLUMN failure_binding_key; ALTER TABLE lark_im_resource_work DROP COLUMN failure_source_fence; DELETE FROM schema_migrations WHERE version='023';");
  const before=f.tasks(),schema=sqliteQuery(f.db,"SELECT type,name,sql FROM sqlite_master ORDER BY type,name;"),versions=sqliteQuery(f.db,'SELECT * FROM schema_migrations ORDER BY version;');
  const dir=join(f.root,'synthetic-broken-migrations');mkdirSync(dir);
  const migration=readFileSync(new URL('../migrations/023_resource_failure_association.sql',import.meta.url),'utf8');
  writeFileSync(join(dir,'023_resource_failure_association.sql'),migration.replace('ALTER TABLE lark_im_resource_work ADD COLUMN failure_source_fence','SELECT * FROM synthetic_missing_migration_table;\nALTER TABLE lark_im_resource_work ADD COLUMN failure_source_fence'));
  assert.throws(()=>ensureInitialized(f.db,{migrationsDir:dir}),/synthetic_missing_migration_table/);
  assert.deepEqual(f.tasks(),before);assert.deepEqual(sqliteQuery(f.db,"SELECT type,name,sql FROM sqlite_master ORDER BY type,name;"),schema);
  assert.deepEqual(sqliteQuery(f.db,'SELECT * FROM schema_migrations ORDER BY version;'),versions);assert.equal(existsSync(`${f.db}.init.lock`),false);
  assert.deepEqual(ensureInitialized(f.db).applied,['023_resource_failure_association.sql']);const after=f.tasks()[0];
  assert.deepEqual(f.tasks().map(({failure_binding_key,failure_source_fence,...row})=>row),before);
  assert.equal(after.failure_binding_key,null);assert.equal(after.failure_source_fence,null);
  assert.equal(resourceWorkFailureEvidence(after,currentResource(f)).applicability,'unknown');assert.equal(after.failure_reason,'download_image_invalid');
  assert.deepEqual(ensureInitialized(f.db).applied,[]);
  for(const col of ['failure_binding_key','failure_source_fence'])for(const value of ['', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), 'Synthetic private string'])assert.throws(()=>sqliteExec(f.db,`UPDATE lark_im_resource_work SET ${col}=${q(value)};`));
});

test('resource association helper requires explicit complete current identity and both original hashes',t=>{
  const f=fixture(t);f.settings.bytes=Buffer.from('Synthetic invalid image bytes');f.run();const task=f.tasks()[0],identity=currentResource(f),before=f.tasks();
  assert.equal(resourceWorkFailureEvidence(task).applicability,'unknown');
  for(const key of ['failure_binding_key','failure_source_fence'])for(const value of [null,undefined,'',{},'A'.repeat(64)])assert.equal(resourceWorkFailureEvidence({...task,[key]:value},identity).applicability,'unknown');
  assert.equal(resourceWorkFailureEvidence(task,{...identity,binding_key:sha('different binding'),source_fence:task.failure_source_fence}).applicability,'different_binding','matching source alone is insufficient');
  assert.equal(resourceWorkFailureEvidence(task,{...identity,account_key:sha('different account')}).applicability,'different_binding');
  assert.equal(resourceWorkFailureEvidence(task,{...identity,work_key:sha('different endpoint')}).applicability,'different_binding');
  assert.equal(resourceWorkFailureEvidence(task,{...identity,source_id:'synthetic foreign source'}).applicability,'unknown');
  assert.deepEqual(f.tasks(),before,'projection is read-only and does not change state, retries or denial policy');
});

for(const recursive of [0,1])test(`resource legacy guards clear only new attempts/results with recursive_triggers=${recursive}`,t=>{
  const f=fixture(t);f.settings.bytes=Buffer.from('Synthetic invalid image bytes');f.run();const before=f.tasks()[0],diagnostic=retainedFailure(before);
  const sql=body=>sqliteExec(f.db,`PRAGMA recursive_triggers=${recursive};${body}`);
  const restore=()=>sql(`UPDATE lark_im_resource_work SET ${Object.entries(diagnostic).map(([key,value])=>`${key}=${q(value)}`).join(',')};`);
  const cleared={failure_stage:null,failure_reason:null,failure_binding_key:null,failure_source_fence:null};
  // The published 7c claim omitted all diagnostic columns. Its original state,
  // token, count, clock and generation changes remain the only task changes.
  sql(`UPDATE lark_im_resource_work SET state='running',attempt_token='synthetic-legacy-first',claim_owner='synthetic-legacy-owner',claim_until_ms=${f.wall+120000},last_attempt_at_ms=${f.wall+1},attempts=attempts+1,generation=generation+1;`);
  const claimed=f.tasks()[0];assert.deepEqual(retainedFailure(claimed),cleared);
  assert.deepEqual(claimed,{...before,...cleared,state:'running',attempt_token:'synthetic-legacy-first',claim_owner:'synthetic-legacy-owner',claim_until_ms:f.wall+120000,last_attempt_at_ms:f.wall+1,attempts:before.attempts+1,generation:before.generation+1});
  restore();sql("UPDATE lark_im_resource_work SET state='running',attempt_token='synthetic-legacy-first';");assert.deepEqual(retainedFailure(f.tasks()[0]),diagnostic,'same claim is not a new attempt');
  sql("UPDATE lark_im_resource_work SET attempt_token='synthetic-legacy-next';");assert.deepEqual(retainedFailure(f.tasks()[0]),cleared,'a changed running token is a new attempt');
  restore();sql("UPDATE lark_im_resource_work SET state='available',reason=NULL,attempt_token=NULL,claim_owner=NULL,claim_until_ms=0;");assert.deepEqual(retainedFailure(f.tasks()[0]),cleared);
  restore();const available=f.tasks()[0];sql(`UPDATE lark_im_resource_work SET state='available',source_fence=${q(sha('synthetic derived source'))};`);
  assert.deepEqual(f.tasks()[0],{...available,source_fence:sha('synthetic derived source')},'same-state available scan has no new success and preserves history');
});

for(const recursive of [0,1])test(`resource legacy association guard rejects stale pairing but preserves scan/new provenance with recursive_triggers=${recursive}`,t=>{
  const f=fixture(t);f.settings.bytes=Buffer.from('Synthetic invalid image bytes');f.run();const before=f.tasks()[0];
  const sql=body=>sqliteExec(f.db,`PRAGMA recursive_triggers=${recursive};${body}`);
  sql(`UPDATE lark_im_resource_work SET binding_key=${q(sha('synthetic corrected binding'))},source_fence=${q(sha('synthetic corrected source'))},failure_stage=failure_stage,failure_reason=failure_reason;`);
  assert.deepEqual(retainedFailure(f.tasks()[0]),retainedFailure(before),'same-value legacy permanent-denial scan does not erase association');
  const scanned=f.tasks()[0];sql("UPDATE lark_im_resource_work SET failure_stage='source_fence',failure_reason='source_changed';");
  assert.deepEqual(f.tasks()[0],{...scanned,failure_stage:'source_fence',failure_reason:'source_changed',failure_binding_key:null,failure_source_fence:null},'legacy diagnosis cannot inherit old hashes');
  sql(`UPDATE lark_im_resource_work SET failure_stage='download_validation',failure_reason='download_file_invalid',failure_binding_key=${q(scanned.binding_key)},failure_source_fence=${q(scanned.source_fence)};`);
  assert.equal(resourceWorkFailureEvidence(f.tasks()[0],scanned).applicability,'exact_source','new writer supplies a new explicit association');
});

test('resource legacy guard effects roll back with the original transaction and leave failed CAS unchanged',t=>{
  const f=fixture(t);f.settings.bytes=Buffer.from('Synthetic invalid image bytes');f.run();const before=f.tasks()[0];
  assert.throws(()=>sqliteExec(f.db,`PRAGMA recursive_triggers=ON;BEGIN IMMEDIATE;
    UPDATE lark_im_resource_work SET state='running',attempt_token='synthetic-rolled-back-token',claim_owner='synthetic-rolled-back-owner',claim_until_ms=${f.wall+120000},attempts=attempts+1,generation=generation+1;
    SELECT * FROM synthetic_missing_after_guard; COMMIT;`),/synthetic_missing_after_guard/);
  assert.deepEqual(f.tasks()[0],before,'the diagnosis and original task changes roll back together');
  sqliteExec(f.db,`UPDATE lark_im_resource_work SET failure_stage='source_fence',failure_reason='source_changed' WHERE generation=${before.generation+1};`);
  assert.deepEqual(f.tasks()[0],before,'no matching row means no trigger side effect');
  const triggers=sqliteQuery(f.db,"SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'lark_resource_failure_%' ORDER BY name;");
  assert.equal(triggers.length,2);assert.deepEqual(ensureInitialized(f.db).applied,[]);
  assert.deepEqual(sqliteQuery(f.db,"SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'lark_resource_failure_%' ORDER BY name;"),triggers);
});
