import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ensureInitialized,sqliteExec,sqliteQuery,quoteSql as q} from '../dist/storage/sqlite/ingestion-store.js';
import {SENT_SCOPE_ID} from '../src/adapters/lark-im/core.mjs';
import {renderApiMessageContent} from '../src/adapters/lark-im/raw-message.mjs';
import {readMessageSnapshot} from '../src/diagnostics/message-read-snapshot.mjs';
import {makeMediaPendingSourceFence} from '../src/adapters/lark-im/media-resource-store.mjs';
import {projectEmbeddedMediaResources} from '../src/adapters/lark-im/media-resource-projection.mjs';
import {executeResourceWork,resourceWorkIdentities,resourceWorkCapabilityEvidence} from '../src/maintenance/resource-work.mjs';

const AT=Date.UTC(2025,4,2),SELF='ou_synthetic_nul_enrollment';
const sha=value=>createHash('sha256').update(value).digest('hex');
const GIF=Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b','hex');
const prefix='Synthetic 雪 before\0';
const allowed=()=> 'message_image';
// Seed authored TEXT independently of the encoder being exercised by the
// product's enrollment/claim/result writes. No read or source fence is injected.
const seedValue=value=>typeof value==='string'&&value.includes('\0')
  ?`CAST(X'${Buffer.from(value,'utf8').toString('hex')}' AS TEXT)`:q(value);

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'synthetic-resource-nul-enrollment-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const db=join(root,'messages.sqlite');ensureInitialized(db);
  const f={root,db,resourceDir:join(root,'resources'),wall:AT+100000,tick:1,next:1,
    calls:[],reads:[],settings:{},authored:new Map()};
  f.add=(text=prefix+'after',key='synthetic_shared_image')=>{
    const id=f.next++,raw={message_id:`om_synthetic_nul_${id}`,chat_id:'oc_synthetic_nul_room',
      msg_type:'post',chat_type:'group',create_time:String(AT+id),
      sender:{id:SELF,id_type:'open_id',sender_type:'user',name:'Synthetic Reader'},
      body:{content:JSON.stringify({title:'Synthetic source',content:[[
        {tag:'text',text},{tag:'img',image_key:key}
      ]]})}};
    const rendered=renderApiMessageContent(raw);
    assert.equal(rendered.text.includes('\0'),text.includes('\0'),'real renderer retains authored NUL');
    const canonical={message_id:raw.message_id,chat_id:raw.chat_id,chat_type:'group',chat_name:'Synthetic Room',
      msg_type:'post',sender_id:SELF,sender_id_type:'open_id',sender_type:'user',sender_name:'Synthetic Reader',
      sender_name_source:'message_sender',content_rendering:{...rendered}};
    delete canonical.content_rendering.text;
    const raw_json=JSON.stringify(raw),row={id,source_id:'lark.im',record_type:'lark.im.message',external_id:raw.message_id,
      external_version:String(AT+id),first_seen_scope_id:SENT_SCOPE_ID,actor_id:SELF,container_id:raw.chat_id,
      direction:'sent',occurred_at:new Date(AT+id).toISOString(),occurred_at_ms:AT+id,
      raw_json,canonical_json:JSON.stringify(canonical),content_hash:sha(raw_json),body:rendered.text};
    sqliteExec(db,`INSERT INTO records(${Object.keys(row)}) VALUES(${Object.values(row).map(seedValue)});`);
    f.authored.set(id,row);return id;
  };
  f.options={db,resourceDir:f.resourceDir,maxCliAttempts:3,maxSelfAttempts:2,maxSeconds:30};
  f.deps={tmpdir:root,now:()=>f.wall,monotonicClock:()=>f.tick,
    tryAcquireLease:()=>({state:'acquired',release(){}}),
    requestSessionDeps:{monotonicClock:()=>f.tick,now:()=>f.wall,sleep:ms=>{f.tick+=ms;},
      tryAcquireLease:()=>({state:'acquired',release(){}}),readSharedCooldown:()=>({state:'ready'}),writeSharedCooldown:()=>true,
      spawnSync(command,wrapped,options){
        assert.equal(command,'python3');assert(wrapped[2].includes('RLIMIT_FSIZE'));
        const args=wrapped.slice(4);f.calls.push(args);f.tick+=10;
        if(args[0]==='contact'){
          f.settings.onProfile?.(f.calls.filter(value=>value[0]==='contact').length);
          return {status:0,stdout:JSON.stringify({open_id:SELF}),stderr:''};
        }
        assert.equal(args[0],'api');assert.equal(args[1],'GET');
        assert.equal(args[2],`/open-apis/im/v1/messages/${f.settings.expectedExternal}/resources/synthetic_shared_image`);
        const name=args[args.indexOf('--output')+1];writeFileSync(join(options.cwd,name),GIF,{mode:0o600});
        return {status:0,stdout:JSON.stringify({saved_path:name,size_bytes:GIF.length,content_type:'image/gif'}),stderr:''};
      }}};
  f.run=()=>{
    assert.equal(f.deps.sqliteJson,undefined);assert.equal(f.deps.readSnapshot,undefined);
    const original=cp.spawnSync;
    cp.spawnSync=(command,args,options)=>{
      const output=original(command,args,options);
      if(command==='sqlite3'&&options.input?.includes('AS encoded_row FROM records')){
        assert(args.includes('-readonly'));assert(!args.includes('-json'));assert(options.timeout>0&&options.timeout<=2000);
        assert.equal(output.status,0);const lines=output.stdout.trimEnd().split('\n');
        assert.equal(lines.shift(),'__EXOCORTEX_JSON_LINES_BEGIN_V1__');
        assert.equal(lines.pop(),'__EXOCORTEX_JSON_LINES_END_V1__');
        f.reads.push(lines.map(line=>JSON.parse(line)));
      }
      return output;
    };syncBuiltinESMExports();
    try{return executeResourceWork(f.options,f.deps);}
    finally{cp.spawnSync=original;syncBuiltinESMExports();}
  };
  f.row=id=>readMessageSnapshot(db,{recordIds:[id]}).rows[0];
  f.tasks=()=>sqliteQuery(db,'SELECT * FROM lark_im_resource_work ORDER BY record_id,work_key;');
  f.scan=()=>sqliteQuery(db,'SELECT * FROM lark_im_resource_scan;')[0];
  f.bytes=id=>sqliteQuery(db,`SELECT hex(body) AS body FROM records WHERE id=${id};`)[0].body;
  f.setBody=(id,body)=>sqliteExec(db,`UPDATE records SET body=${seedValue(body)} WHERE id=${id};`);
  f.beforeWrite=callback=>{f.deps.sqliteWrite=(path,sql,label,budget)=>{
    assert(!sql.includes('\0'),'the product SQL program has no literal NUL');
    callback(sql);return sqliteQuery(path,sql,label,budget);
  };};
  f.advance=()=>{f.wall+=61000;f.tick+=61000;};
  return f;
}

function assertBlockedExact(f,id) {
  const task=f.tasks().find(value=>value.record_id===id),row=f.row(id);
  assert(task,'valid authored source is enrolled');
  const identities=resourceWorkIdentities(f.db,row);assert.equal(identities.length,1);
  const identity=identities[0];
  assert.equal(task.state,'blocked');assert.equal(task.reason,null);
  assert.equal(task.attempts,0);assert.equal(task.failures,0);assert.equal(task.attempt_token,null);
  assert.equal(task.work_key,identity.work_key);assert.equal(task.binding_key,identity.binding_key);
  assert.equal(task.source_fence,makeMediaPendingSourceFence(row));
  assert.deepEqual(resourceWorkCapabilityEvidence(task,identity),{reason:'resource_endpoint_unverified',
    association:{binding_key:task.binding_key,source_fence:task.source_fence},applicability:'exact_source'});
}

test('real rendered NUL post traverses default source read and SQLite enrollment with zero API attempts',t=>{
  const f=fixture(t),id=f.add(),before=f.bytes(id);
  assert.equal(resourceWorkIdentities(f.db,f.row(id)).length,1);
  const result=f.run();assert.equal(result.ok,true,JSON.stringify(result));assertBlockedExact(f,id);
  assert.equal(f.tasks().length,1);assert.equal(f.reads.length,1);
  assert.equal(f.reads[0][0].body,f.authored.get(id).body);
  assert.equal(f.bytes(id),before);assert.equal(f.scan().after_id,id);assert.equal(f.scan().generation,1);
  assert.equal(f.calls.length,0);assert.equal(result.request_budget.cli_attempts,0);
  assert.equal(result.request_budget.self_attempts,0);assert.equal(result.request_budget.max_seconds,30);
  assert.equal(result.request_budget.stop_reason,null);assert.equal(result.request_budget.complete,true);
});

test('mixed ordinary and same-prefix different-NUL-suffix rows enroll independently without source aliases',t=>{
  const f=fixture(t),ids=[f.add('Synthetic ordinary'),f.add(prefix+'A'),f.add(prefix+'B')];
  const before=ids.map(id=>f.bytes(id));f.run();assert.equal(f.tasks().length,3);
  for(const id of ids)assertBlockedExact(f,id);
  assert.deepEqual(f.reads[0].map(row=>row.id),ids);
  assert.deepEqual(f.reads[0].map(row=>row.body),ids.map(id=>f.authored.get(id).body));
  assert.equal(new Set(f.tasks().map(task=>task.work_key)).size,3);
  assert.equal(new Set(f.tasks().map(task=>task.source_fence)).size,3);
  assert.deepEqual(ids.map(id=>f.bytes(id)),before);assert.equal(f.calls.length,0);
});

for(const changedId of [1,3])test(`NUL suffix-only enrollment race on row ${changedId} excludes only that stale source`,t=>{
  const f=fixture(t),ids=[f.add(prefix+'old-A'),f.add('Synthetic ordinary'),f.add(prefix+'old-B')];
  const original=f.authored.get(changedId).body,replacement=original.replace('old-','new-');
  assert.equal(original.split('\0')[0],replacement.split('\0')[0]);assert.notEqual(original,replacement);
  let changed=false;
  f.beforeWrite(sql=>{if(!changed&&sql.includes('CREATE TEMP TABLE __resource_scan_source')){
    changed=true;f.setBody(changedId,replacement);
  }});
  const result=f.run();assert.equal(result.ok,true,JSON.stringify(result));assert.equal(changed,true);
  assert.deepEqual(f.tasks().map(task=>task.record_id),ids.filter(id=>id!==changedId));
  for(const id of ids.filter(id=>id!==changedId))assertBlockedExact(f,id);
  assert.equal(f.bytes(changedId),Buffer.from(replacement).toString('hex').toUpperCase());
  assert.equal(f.scan().after_id,3);assert.equal(f.calls.length,0);
});

test('NUL source completes claim and result under the same fence using only a synthetic enabled endpoint',t=>{
  const f=fixture(t),id=f.add(),before=f.bytes(id);f.run();assertBlockedExact(f,id);
  const prior=f.tasks()[0];f.deps.resourceCapability=allowed;f.settings.expectedExternal=f.authored.get(id).external_id;f.advance();
  const result=f.run();assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.available,1);
  const task=f.tasks()[0];assert.equal(task.state,'available');assert.equal(task.attempts,1);assert.equal(task.failures,0);
  assert.equal(task.work_key,prior.work_key);assert.equal(task.binding_key,prior.binding_key);assert.equal(task.source_fence,prior.source_fence);
  assert.equal(task.attempt_token,null);assert.equal(task.claim_owner,null);assert.equal(task.claim_until_ms,0);
  assert.equal(f.calls.length,3);assert.equal(result.request_budget.max_cli_attempts,3);assert.equal(result.request_budget.cli_attempts,3);
  assert.equal(result.request_budget.max_self_attempts,2);assert.equal(result.request_budget.self_attempts,2);
  assert.equal(result.request_budget.max_seconds,30);assert(result.request_budget.elapsed_ms<=30000);
  assert.equal(f.bytes(id),before);
  const row=f.row(id),projection=projectEmbeddedMediaResources(f.db,f.resourceDir,row,JSON.parse(row.canonical_json),JSON.parse(row.raw_json));
  assert.equal(projection.resources.length,1);assert.equal(projection.resources[0].status,'available');
});

test('NUL suffix-only race at the claim write rejects CAS before any synthetic request',t=>{
  const f=fixture(t),id=f.add();f.deps.resourceCapability=allowed;
  let changed=false,queued;
  f.beforeWrite(sql=>{if(!changed&&sql.includes("SET state='running',attempt_token")){
    changed=true;queued=f.tasks()[0];f.setBody(id,f.authored.get(id).body.replace('after','changed'));
  }});
  const result=f.run();assert.equal(changed,true);assert.equal(result.outcome,'execution_failed');
  assert.equal(result.ok,false);assert.equal(result.available,0);assert.equal(f.calls.length,0);
  assert.deepEqual(f.tasks()[0],queued,'failed exact-source claim CAS leaves the task untouched');
  assert.equal(f.tasks()[0].state,'pending');assert.equal(f.tasks()[0].attempts,0);
});

test('NUL suffix-only race after result source read cannot overwrite the running claim as available',t=>{
  const f=fixture(t),id=f.add();f.deps.resourceCapability=allowed;f.settings.expectedExternal=f.authored.get(id).external_id;
  let changed=false,claimed;
  f.beforeWrite(sql=>{if(!changed&&sql.includes("UPDATE lark_im_resource_work SET state='available'")){
    changed=true;claimed=f.tasks()[0];f.setBody(id,f.authored.get(id).body.replace('after','changed'));
  }});
  const result=f.run();assert.equal(changed,true);assert.equal(result.outcome,'execution_failed');
  assert.equal(result.ok,false);assert.equal(result.available,0);assert.equal(f.calls.length,3);
  assert.deepEqual(f.tasks()[0],claimed,'failed result CAS preserves the claimed generation and receipt uncertainty');
  assert.equal(f.tasks()[0].state,'running');assert.equal(f.tasks()[0].attempts,1);
  assert.equal(f.tasks()[0].source_fence,makeMediaPendingSourceFence(f.authored.get(id)));
});

test('NUL suffix drift during the producer is retained as source_changed rather than successful completion',t=>{
  const f=fixture(t),id=f.add();f.deps.resourceCapability=allowed;f.settings.expectedExternal=f.authored.get(id).external_id;
  const before=makeMediaPendingSourceFence(f.row(id));let changed=false;
  f.settings.onProfile=n=>{if(n===2){changed=true;f.setBody(id,f.authored.get(id).body.replace('after','changed'));}};
  const result=f.run();assert.equal(changed,true);assert.equal(result.outcome,'source_changed');assert.equal(result.available,0);
  const task=f.tasks()[0];assert.equal(task.state,'blocked');assert.equal(task.reason,'source_changed');
  assert.equal(task.attempts,1);assert.equal(task.source_fence,before);assert.equal(task.failure_source_fence,before);
  assert.equal(task.attempt_token,null);assert.equal(task.claim_owner,null);assert.equal(f.calls.length,3);
  assert.notEqual(makeMediaPendingSourceFence(f.row(id)),before);
});
