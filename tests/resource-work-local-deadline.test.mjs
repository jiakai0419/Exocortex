import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {once} from 'node:events';
import {ensureInitialized,sqliteExec,sqliteQuery,quoteSql as q} from '../dist/storage/sqlite/ingestion-store.js';
import {captureLarkWriteAdmission} from '../src/diagnostics/lark-write-admission.mjs';
import {executeResourceWork} from '../src/maintenance/resource-work.mjs';
import {renderApiMessageContent} from '../src/adapters/lark-im/raw-message.mjs';
import {SENT_SCOPE_ID} from '../src/adapters/lark-im/core.mjs';

const AT=Date.UTC(2025,4,1),SELF='ou_synthetic_sql_deadline';
function fixture(t,count=1,slots=2) {
  const root=mkdtempSync(join(tmpdir(),'synthetic-resource-deadline-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const db=join(root,'messages.sqlite');ensureInitialized(db);
  for(let i=1;i<=count;i++) {
    const raw={message_id:`om_synthetic_deadline_${i}`,chat_id:'oc_synthetic_deadline',msg_type:'post',chat_type:'group',
      create_time:String(AT+i),sender:{id:SELF,id_type:'open_id',sender_type:'user',name:'Synthetic Reader'},
      body:{content:JSON.stringify({title:'Synthetic',content:[[{tag:'text',text:'SyntheticCostSource'.repeat(900)},
        ...Array.from({length:slots},(_,j)=>({tag:'img',image_key:`synthetic_${j}`}))]]})}};
    const rendered=renderApiMessageContent(raw),canonical={message_id:raw.message_id,chat_id:raw.chat_id,chat_type:'group',
      msg_type:'post',chat_name:'Synthetic Room',sender_id:SELF,sender_id_type:'open_id',sender_type:'user',sender_name:'Synthetic Reader',
      sender_name_source:'message_sender',content_rendering:{...rendered}};delete canonical.content_rendering.text;
    const raw_json=JSON.stringify(raw),row={id:i,source_id:'lark.im',record_type:'lark.im.message',external_id:raw.message_id,
      external_version:String(AT+i),first_seen_scope_id:SENT_SCOPE_ID,actor_id:SELF,container_id:raw.chat_id,direction:'sent',
      occurred_at:new Date(AT+i).toISOString(),occurred_at_ms:AT+i,raw_json,canonical_json:JSON.stringify(canonical),
      content_hash:createHash('sha256').update(raw_json).digest('hex'),body:rendered.text};
    sqliteExec(db,`INSERT INTO records(${Object.keys(row)}) VALUES(${Object.values(row).map(q)});`);
  }
  const f={db,tick:1,requests:0};
  f.options={db,maxCliAttempts:3,maxSelfAttempts:2,maxSeconds:1};
  f.deps={now:()=>AT+100000,monotonicClock:()=>f.tick,tryAcquireLease:()=>({state:'acquired',release(){}}),
    requestSessionDeps:{spawnSync(){f.requests++;throw Error('unexpected synthetic external request');}}};
  f.run=()=>executeResourceWork(f.options,f.deps);
  f.tasks=()=>sqliteQuery(db,'SELECT * FROM lark_im_resource_work;');return f;
}
function observingSpawns(observe,work) {
  const original=cp.spawnSync;cp.spawnSync=(...args)=>observe(original,...args);syncBuiltinESMExports();
  try{return work();}finally{cp.spawnSync=original;syncBuiltinESMExports();}
}

test('admission recheck exhausting the original grant prevents write dispatch entirely',t=>{
  const f=fixture(t);let writes=0;
  f.deps.captureWriteAdmission=(...args)=>{const admission=captureLarkWriteAdmission(...args);
    return {...admission,assertCurrent(){admission.assertCurrent();f.tick=1001;}};};
  f.deps.sqliteWrite=()=>{writes++;throw Error('must not dispatch');};
  const report=f.run();assert.equal(writes,0);assert.equal(report.ok,false);assert.equal(report.outcome,'batch_deferred');
  assert.equal(report.request_budget.stop_reason,'time_budget');assert.equal(f.tasks().length,0);assert.equal(f.requests,0);
});

test('default SQLite executor receives the remaining original timeout after prior local work',t=>{
  const f=fixture(t);let writes=0;const observed=[];
  f.deps.captureWriteAdmission=(...args)=>{const admission=captureLarkWriteAdmission(...args);
    return {...admission,assertCurrent(){admission.assertCurrent();f.tick=401;}};};
  const report=observingSpawns((run,command,args,options)=>{
    if(command==='sqlite3'&&options.input?.includes('CREATE TEMP TABLE __resource_scan_source')){
      writes++;observed.push({timeout:options.timeout,killSignal:options.killSignal,input:options.input});
    }
    return run(command,args,options);
  },()=>f.run());
  assert.equal(report.ok,true);assert.equal(writes,1);assert.equal(observed[0].timeout,600);
  assert.equal(observed[0].killSignal,'SIGKILL');assert.match(observed[0].input,/\.timeout 600\n/);
  assert.equal(f.tasks().length,2);assert.equal(f.requests,0);
});

for(const mode of ['confirmed','throw_before','throw_after'])test(`late ${mode} keeps execution result separate from a later budget stop`,t=>{
  const f=fixture(t);let writes=0,readsAfter=0,ended=false;
  f.deps.sqliteJson=(db,sql,label,settings)=>{if(ended)readsAfter++;return sqliteQuery(db,sql,label);};
  f.deps.sqliteWrite=(db,sql,label,budget)=>{
    writes++;assert.equal(typeof budget?.timeoutMs,'function');assert.equal(budget.timeoutMs(),1000);
    const result=mode==='throw_before'?null:sqliteQuery(db,sql,label,budget);ended=true;f.tick=1001;
    if(mode!=='confirmed')throw Error('Synthetic unknown write outcome');return result;
  };
  const report=f.run();assert.equal(report.ok,false);assert.equal(report.request_budget.stop_reason,'time_budget');
  assert.equal(report.outcome,mode==='confirmed'?'batch_deferred':'execution_failed');assert.equal(writes,1);assert.equal(readsAfter,0);
  assert.equal(f.tasks().length,mode==='throw_before'?0:2,'a failed command is not evidence of transaction rollback');
  assert.equal(report.available,0);assert.equal(f.requests,0);
});

test('actual SQLite lock wait and subprocess timeout are bounded by the same one-second grant',async t=>{
  const f=fixture(t);f.deps.monotonicClock=()=>performance.now();
  const child=cp.spawn('python3',['-c',"import sqlite3,sys\nc=sqlite3.connect(sys.argv[1],isolation_level=None)\nc.execute('BEGIN IMMEDIATE')\nprint('ready',flush=True)\nsys.stdin.readline()\nc.rollback()\nc.close()",f.db],{stdio:['pipe','pipe','pipe']});
  let timer;const closed=once(child,'close');let stdout='';
  try {
    await Promise.race([new Promise((resolve,reject)=>{child.stdout.on('data',bytes=>{stdout+=bytes;if(stdout.includes('ready'))resolve();});child.once('error',reject);}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('synthetic lock owner did not become ready')),5000);})]);clearTimeout(timer);
    const start=performance.now(),spawns=[];
    const report=observingSpawns((run,command,args,options)=>{
      if(command==='sqlite3'&&options.input?.includes('CREATE TEMP TABLE __resource_scan_source')){
        const result=run(command,args,options);spawns.push({timeout:options.timeout,error:result.error?.code,signal:result.signal,status:result.status});return result;
      }return run(command,args,options);
    },()=>f.run());
    const elapsed=performance.now()-start;assert.equal(spawns.length,1);assert(spawns[0].timeout>0&&spawns[0].timeout<=1000);
    assert.notEqual(spawns[0].status,0);assert.equal(report.ok,false);assert.equal(report.outcome,'execution_failed');
    assert(elapsed<2500,'bounded wait includes process teardown, never the default five-second busy timeout');
    assert.equal(f.tasks().length,0);assert.equal(f.requests,0);
    t.diagnostic(JSON.stringify({elapsed_ms:elapsed,sqlite:spawns[0],stop_reason:report.request_budget.stop_reason}));
  } finally {
    clearTimeout(timer);child.stdin.end('release\n');
    const end=setTimeout(()=>child.kill('SIGKILL'),2000);await closed;clearTimeout(end);
  }
});

test('forty sources with sixty-four slots use bounded default SQLite dispatch and honest outcome',t=>{
  const f=fixture(t,40,64);f.deps.monotonicClock=()=>performance.now();
  const start=performance.now(),spawns=[];
  const report=observingSpawns((run,command,args,options)=>{
    if(command==='sqlite3'&&options.input?.includes('CREATE TEMP TABLE __resource_scan_source')){
      const offset=performance.now()-start;const result=run(command,args,options);
      spawns.push({dispatch_ms:offset,timeout:options.timeout,sql_bytes:Buffer.byteLength(options.input),status:result.status,error:result.error?.code});return result;
    }return run(command,args,options);
  },()=>f.run());
  const elapsed=performance.now()-start,tasks=f.tasks().length;
  assert(spawns.length<=1);for(const observed of spawns){
    assert(Number.isSafeInteger(observed.timeout)&&observed.timeout>0&&observed.timeout<=1000);
    assert(observed.timeout<=Math.max(0,1000-observed.dispatch_ms)+20,'SQLite timeout must shrink with real preparation cost');
  }
  assert.equal(f.requests,0);assert([0,2560].includes(tasks),'enrollment remains atomic');
  if(report.ok){assert(report.request_budget.elapsed_ms<1000);assert.equal(tasks,2560);}
  else assert(['execution_failed','batch_deferred'].includes(report.outcome));
  if(report.request_budget.elapsed_ms>=1000){assert.equal(report.ok,false);assert.equal(report.request_budget.stop_reason,'time_budget');}
  assert(elapsed<2500,'no unbounded SQLite subprocess after preparation');
  t.diagnostic(JSON.stringify({elapsed_ms:elapsed,spawns,tasks,outcome:report.outcome,stop_reason:report.request_budget.stop_reason}));
});

for(const acknowledgement of ['returned','lost'])test(`late task-result commit ${acknowledgement} retains effects without a false successful command`,t=>{
  const f=fixture(t,1,1);f.options.maxSeconds=4;f.deps.resourceCapability=()=> 'message_image';
  // This control isolates queue acknowledgement, not byte/readiness authority.
  f.deps.enrichResources=options=>({request_budget:null,results:[{...options.resourceTargets[0],state:'available'}]});
  let resultWrites=0;
  f.deps.sqliteWrite=(db,sql,label,budget)=>{
    const result=sqliteQuery(db,sql,label,budget);
    if(sql.includes("UPDATE lark_im_resource_work SET state='available'")){
      resultWrites++;f.tick=4001;if(acknowledgement==='lost')throw Error('Synthetic lost result acknowledgement');
    }return result;
  };
  const report=f.run();assert.equal(resultWrites,1);assert.equal(f.tasks()[0].state,'available');
  assert.equal(report.ok,false);assert.equal(report.request_budget.stop_reason,'time_budget');
  assert.equal(report.outcome,acknowledgement==='returned'?'processed':'execution_failed');
  assert.equal(report.processed,acknowledgement==='returned'?1:0);assert.equal(f.requests,0);
});
