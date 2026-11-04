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
    sqliteWrite:(db,sql,label,budget)=>{f.writes.push(sql);f.settings.beforeWrite?.(sql);return sqliteQuery(db,sql,label,budget);},
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

function closingMutation(f,action,closingSelf=null) {
  const run=f.deps.requestSessionDeps.spawnSync;let contacts=0;
  f.deps.requestSessionDeps.spawnSync=(command,args,options)=>{
    const result=run(command,args,options);
    if(args.slice(4)[0]==='contact'&&++contacts===2){action?.();if(closingSelf)return {...result,stdout:JSON.stringify({open_id:closingSelf})};}
    return result;
  };
}
const rename=f=>sqliteExec(f.db,"UPDATE records SET canonical_json=json_set(canonical_json,'$.chat_name','Synthetic changed room');");
const prepare=(t,type='image')=>{const f=fixture(t);f.add(type,['synthetic_exact_denial']);
  if(type==='post')f.deps.resourceCapability=allowed;f.settings.denied=new Set(['synthetic_exact_denial']);return f;};
const deniedTask=f=>f.tasks().find(task=>task.failure_reason==='permission_denied');
function restartWithoutRequests(f) {
  const program=`import {executeResourceWork} from ${JSON.stringify(new URL('../src/maintenance/resource-work.mjs',import.meta.url).href)};
    const result=executeResourceWork(${JSON.stringify(f.options)},{now:()=>${f.wall},monotonicClock:()=>1,
      resourceCapability:()=> 'message_image',tryAcquireLease:()=>({state:'acquired',release(){}}),
      requestSessionDeps:{spawnSync(){throw Error('forbidden synthetic repeated request');}}});process.stdout.write(JSON.stringify(result));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8',timeout:15000});
  assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);assert.equal(result.request_budget.cli_attempts,0);return result;
}

// Preserve the independent four matched inputs; only the expected correct
// refusal/no-second-GET oracle changes from the archived baseline diagnostic.
for(const type of ['image','post'])for(const mutate of [false,true])test(`${type} confirmed refusal with closing-name-change=${mutate} never repeats its endpoint`,t=>{
  const f=prepare(t,type),source=f.row(1);closingMutation(f,mutate?()=>rename(f):null);
  const first=f.run(),before=f.tasks()[0],downloads=f.downloads().length;
  assert.equal(first.outcome,'blocked');assert.equal(first.blocked,1);assert.equal(first.processed,0);assert.equal(downloads,1);
  assert.equal(before.reason,'permission_denied');assert.equal(before.failure_stage,'resource_request');assert.equal(before.attempts,1);
  assert.equal(before.failure_binding_key,before.binding_key);assert.equal(before.failure_source_fence,before.source_fence);
  assert.equal(first.failure.persisted,true);assert.equal(first.request_budget.cli_attempts,3);assert.equal(first.request_budget.self_attempts,2);
  const originalIdentity=resourceWorkIdentities(f.db,source,f.deps)[0];assert.equal(before.failure_source_fence,originalIdentity.source_fence);
  f.advance();f.run();const after=f.tasks()[0];assert.equal(f.downloads().length-downloads,0);
  assert.equal(after.reason,'permission_denied');assert.equal(after.attempts,1);assert.equal(after.work_key,before.work_key);
  assert.equal(after.failure_source_fence,before.failure_source_fence);assert.equal(source.raw_json,f.row(1).raw_json);
  assert.equal(resourceWorkFailureEvidence(after,resourceWorkIdentities(f.db,f.row(1),f.deps)[0]).applicability,mutate?'same_binding':'exact_source');
  f.advance();restartWithoutRequests(f);assert.equal(f.tasks()[0].reason,'permission_denied');
});

for(const mode of ['version','resource_key','message_id'])test(`confirmed refusal stays on its original endpoint after source ${mode} drift`,t=>{
  const f=prepare(t),before=f.row(1),oldIdentity=resourceWorkIdentities(f.db,before)[0];
  closingMutation(f,()=>{
    const raw=JSON.parse(before.raw_json),canonical=JSON.parse(before.canonical_json),fields={external_version:'synthetic_version_changed'};
    if(mode==='resource_key')raw.body.content=JSON.stringify({image_key:'synthetic_new_resource'});
    if(mode==='message_id'){raw.message_id='om_synthetic_new_endpoint';canonical.message_id=raw.message_id;fields.external_id=raw.message_id;}
    const raw_json=JSON.stringify(raw);Object.assign(fields,{raw_json,canonical_json:JSON.stringify(canonical),content_hash:sha(raw_json)});
    sqliteExec(f.db,`UPDATE records SET ${Object.entries(fields).map(([k,v])=>`${k}=${q(v)}`)} WHERE id=1;`);
  });
  const first=f.run(),denied=deniedTask(f);assert.equal(first.blocked,1);assert(denied);
  assert.equal(denied.work_key,oldIdentity.work_key);assert.equal(denied.failure_binding_key,oldIdentity.binding_key);
  assert.equal(denied.failure_source_fence,oldIdentity.source_fence);
  if(mode!=='version')f.settings.denied.clear();f.advance();f.run();
  const oldPath=`/open-apis/im/v1/messages/${before.external_id}/resources/synthetic_exact_denial`;
  assert.equal(f.calls.filter(args=>args[0]==='api'&&args[2]===oldPath).length,1);
  if(mode!=='version'){
    const current=resourceWorkIdentities(f.db,f.row(1))[0];assert.notEqual(current.work_key,oldIdentity.work_key);
    const newer=f.tasks().find(task=>task.work_key===current.work_key);assert(newer);assert.notEqual(newer.reason,'permission_denied');
    assert.equal(f.tasks().find(task=>task.work_key===oldIdentity.work_key).reason,'permission_denied');
  }
});

test('matching closing profile cannot override changed local account admission',t=>{
  const f=prepare(t);closingMutation(f,()=>sqliteExec(f.db,`UPDATE records SET actor_id='ou_synthetic_different',
    canonical_json=json_set(canonical_json,'$.sender_id','ou_synthetic_different');`));
  const result=f.run();assert.equal(result.outcome,'execution_failed');assert.equal(result.failure.persisted,false);
  assert.equal(f.tasks()[0].state,'running');assert.equal(f.tasks()[0].failure_reason,null);assert.equal(result.blocked,0);
});

test('a changed source configuration cannot admit the old refusal result',t=>{
  const f=prepare(t);closingMutation(f,()=>sqliteExec(f.db,"UPDATE sources SET config_json=json_set(config_json,'$.synthetic_option','changed') WHERE id='lark.im';"));
  const result=f.run();assert.equal(result.outcome,'execution_failed');assert.equal(result.failure.persisted,false);
  assert.equal(f.tasks()[0].state,'running');assert.equal(result.blocked,0);
});

test('source mutation between refusal observation and transaction fails its observed-source CAS',t=>{
  const f=prepare(t);closingMutation(f,()=>rename(f));let changed=false;
  f.settings.beforeWrite=sql=>{if(!changed&&sql.includes("failure_stage='resource_request'")){changed=true;
    sqliteExec(f.db,"UPDATE records SET body=body||' Synthetic concurrent mutation';");}};
  const result=f.run();assert(changed);assert.equal(result.outcome,'execution_failed');assert.equal(result.failure.persisted,false);
  assert.equal(f.tasks()[0].state,'running');assert.equal(f.tasks()[0].failure_reason,null);assert.equal(result.blocked,0);
});

for(const [label,mutation] of [
  ['generation','generation=generation+1'],['token',"attempt_token='synthetic_changed_token'"],
  ['binding',`binding_key='${'e'.repeat(64)}'`],['source fence',`source_fence='${'f'.repeat(64)}'`],
  ['owner',"claim_owner='pid:999999'"],['expiry','claim_until_ms=claim_until_ms+1'],['attempts','attempts=attempts+1'],
  ['record','record_id=2'],['account',`account_key='${'a'.repeat(64)}'`],['endpoint',`work_key='${'b'.repeat(64)}'`],
])test(`confirmed refusal cannot cross a changed task ${label}`,t=>{
  const f=prepare(t);if(label==='record')f.add('text',[]);closingMutation(f,()=>rename(f));let changed=false;
  f.settings.beforeWrite=sql=>{if(!changed&&sql.includes("failure_stage='resource_request'")){changed=true;
    sqliteExec(f.db,`UPDATE lark_im_resource_work SET ${mutation};`);changed='applied';}};
  const result=f.run();assert.equal(changed,'applied');assert.equal(result.outcome,'execution_failed');assert.equal(result.failure.persisted,false);
  assert.equal(result.blocked,0);assert.equal(result.available,0);assert(f.tasks().every(task=>task.reason!=='permission_denied'));
});

for(const mode of ['local_reason','different_closing'])test(`${mode} is not confirmed refusal despite name drift`,t=>{
  const f=prepare(t);closingMutation(f,()=>rename(f),mode==='different_closing'?'ou_synthetic_other':null);
  if(mode==='local_reason'){
    f.settings.denied.clear();const run=f.deps.requestSessionDeps.spawnSync;
    f.deps.requestSessionDeps.spawnSync=(command,args,opts)=>{
      if(args.slice(4)[0]==='api'){rename(f);throw Object.assign(new Error('Synthetic local refusal word'),{code:210508,reason:'permission_denied'});}
      return run(command,args,opts);
    };
  }
  const result=f.run();assert.equal(result.ok,false);assert(f.tasks().every(task=>task.reason!=='permission_denied'));
  assert.notEqual(result.failure?.reason,'permission_denied');assert.equal(result.available,0);
});

test('successful bytes still cannot publish or count success after closing-source drift',t=>{
  const f=prepare(t);f.settings.denied.clear();closingMutation(f,()=>rename(f));
  const result=f.run();assert.equal(result.ok,false);assert.equal(result.available,0);assert.equal(result.processed,0);
  assert.equal(f.tasks()[0].reason,'source_changed');assert.equal(f.tasks()[0].failure_reason,'source_changed');
  const row=f.row(1),projection=projectEmbeddedMediaResources(f.db,f.resourceDir,row,JSON.parse(row.canonical_json),JSON.parse(row.raw_json));
  assert(projection.resources.every(resource=>resource.status!=='available'));
});

for(const mode of ['before','after'])test(`unknown refusal commit ${mode} dispatch remains unknown and restart reads durable state`,t=>{
  const f=prepare(t);closingMutation(f,()=>rename(f));const write=f.deps.sqliteWrite;
  f.deps.sqliteWrite=(db,sql,label,budget)=>{
    if(!sql.includes("failure_stage='resource_request'"))return write(db,sql,label,budget);
    if(mode==='after')write(db,sql,label,budget);throw Error('Synthetic unknown result acknowledgement');
  };
  const result=f.run();assert.equal(result.outcome,'execution_failed');assert.equal(result.failure.persisted,false);
  assert.equal(result.blocked,0);assert.equal(result.available,0);assert.equal(f.tasks()[0].state,mode==='after'?'blocked':'running');
  f.deps.sqliteWrite=write;f.advance();const restarted=restartWithoutRequests(f);assert.equal(restarted.request_budget.cli_attempts,0);
  assert.equal(f.tasks()[0].state,mode==='after'?'blocked':'running');
  assert.equal(f.downloads().length,1);
});


for(const [code,reason] of [[231203,'restricted_mode'],[230002,'bot_user_out_of_chat']])test(`confirmed ${reason} also survives closing-source drift`,t=>{
  const f=prepare(t),run=f.deps.requestSessionDeps.spawnSync;
  f.deps.requestSessionDeps.spawnSync=(command,args,options)=>{
    const result=run(command,args,options);return args.slice(4)[0]==='api'?{...result,stdout:JSON.stringify({code,msg:'Synthetic exact refusal'})}:result;
  };
  closingMutation(f,()=>rename(f));const result=f.run();assert.equal(result.blocked,1);assert.equal(f.tasks()[0].reason,reason);
  assert.equal(f.tasks()[0].failure_reason,reason);assert.equal(result.failure.persisted,true);f.advance();f.run();
  assert.equal(f.downloads().length,1);assert.equal(f.tasks()[0].attempts,1);
});
