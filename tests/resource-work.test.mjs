import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {ensureInitialized,sqliteExec,sqliteQuery,quoteSql as q} from '../dist/storage/sqlite/ingestion-store.js';
import {SENT_SCOPE_ID} from '../src/adapters/lark-im/core.mjs';
import {readMessageSnapshot} from '../src/diagnostics/message-read-snapshot.mjs';
import {executeResourceWork,resourceWorkAvailable,resourceWorkIdentity} from '../src/maintenance/resource-work.mjs';
import {loadMessages} from '../src/diagnostics/messages-report.mjs';
import {enrichResources} from '../src/maintenance/enrich-resources.mjs';

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
        if(f.settings.localDenied)return {status:1,stdout:'',stderr:'permission denied: synthetic local launcher'};
        if(f.settings.denied)return {status:1,stdout:JSON.stringify({code:210508,msg:'synthetic remote denial'}),stderr:''};
        if(f.settings.transient)return {status:1,stdout:JSON.stringify({code:999999999,msg:'synthetic transient'}),stderr:''};
        const name=args[args.indexOf('--output')+1];writeFileSync(join(opts.cwd,name),PNG,{mode:0o600});
        return {status:0,stdout:JSON.stringify({saved_path:name,size_bytes:PNG.length,content_type:'image/png'}),stderr:''};
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
  assert.equal(sqliteQuery(f.db,'SELECT after_id FROM lark_im_resource_scan;')[0].after_id,20);
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
