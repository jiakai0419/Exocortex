import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { prepareChatWindowRecords } from '../src/adapters/lark-im/sync-runner.mjs';
import { executeLarkImHistory } from '../src/maintenance/history.mjs';
import { createHistoryCommandBudget } from '../src/maintenance/history-command-budget.mjs';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';

function fixture(t, count=1) {
  const dir=mkdtempSync(join(tmpdir(),'synthetic-history-whole-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=join(dir,'synthetic.sqlite'),start=Math.floor((Date.now()-86400000)/1000)*1000;
  const self={open_id:'ou_synthetic_command_observer',name:'Synthetic Observer'},chat='oc_synthetic_command_history',scope=chatScopeId(chat);
  const q=store.quoteSql,hash=text=>createHash('sha256').update(text).digest('hex'),confirmed=new Date(start).toISOString();
  store.ensureInitialized(db);
  store.sqliteExec(db,`UPDATE sources SET config_json=${q(JSON.stringify({initial_sync_start_ms:start,
    initial_account_binding:{kind:store.INITIAL_ACCOUNT_KIND,account_key:hash(`lark.im\0${self.open_id}`),reserved_at:confirmed,confirmed_at:confirmed}}))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(scope)},'lark.im','Synthetic command scope',${q(JSON.stringify({chat_id:chat,chat_type:'group'}))});`);
  const messages=Array.from({length:count},(_,i)=>({message_id:`om_synthetic_command_${i}`,chat_id:chat,msg_type:'text',create_time:String(start+1100+i),update_time:String(start+1100+i),
    sender:{id:'ou_synthetic_command_author',id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({text:`Synthetic command body ${i}`})}}));
  store.sqliteExec(db,store.upsertRecordsSql(prepareChatWindowRecords(messages.map(m=>normalizeApiMessage(m)),scope,null,start,start+60000,self.open_id,{self},{chat_id:chat,chat_type:'group'})));
  const state={tick:0,held:false,calls:[],timeouts:[],released:0};
  const budget=createHistoryCommandBudget({maxSeconds:30},{monotonicClock:()=>state.tick});
  const deps={historyCommandBudget:budget,requestSessionDeps:{
    env:{LARK_CLI:'synthetic-never-spawned'},monotonicClock:()=>state.tick,now:()=>Date.now(),
    sleep:ms=>{assert.equal(state.held,false);state.tick+=ms;},
    tryAcquireLease:()=>{assert.equal(state.held,false);state.held=true;return {state:'acquired',release(){state.held=false;state.released++;}};},
    readSharedCooldown:()=>({state:'ready'}),writeSharedCooldown:()=>true,
    spawnSync:(_cmd,args,settings)=>{
      assert.equal(state.held,true);state.calls.push(args);state.timeouts.push(settings.timeout);
      if(args[0]==='contact')return {status:0,stdout:JSON.stringify(self),stderr:''};
      return {status:0,stdout:JSON.stringify({code:0,data:{items:messages,has_more:false,page_token:''}}),stderr:''};
    },
  }};
  return {db,deps,state,budget,messages,scope,before:store.sqliteQuery(db,'SELECT * FROM records;')};
}

function withSpawn(observer, work) {
  const original=childProcess.spawnSync;
  childProcess.spawnSync=(...args)=>observer(original,...args);syncBuiltinESMExports();
  try{return work();}finally{childProcess.spawnSync=original;syncBuiltinESMExports();}
}

test('real selectors use decreasing SQLite deadlines and successful history includes initial read and commit time',t=>{
  const f=fixture(t),readTimeouts=[];
  const result=executeLarkImHistory({db:f.db}, {...f.deps,
    sqliteJson(db,sql,label,settings){readTimeouts.push(settings.timeoutMs);const rows=readOnlySqliteJson(db,sql,label,settings);f.state.tick+=5;return rows;},
  });
  assert.equal(result.ok,true);assert.equal(result.outcome,'processed');assert.equal(f.state.calls.length,2);
  assert.ok(readTimeouts.length>10);assert.ok(readTimeouts.at(-1)<readTimeouts[0]);
  assert.equal(readTimeouts[0],29000);assert.equal(result.request_budget.elapsed_ms,f.state.tick);
  assert.equal(result.request_budget.cli_attempts,2);assert.equal(f.state.held,false);
  assert.equal(store.sqliteQuery(f.db,'SELECT COUNT(*) AS n FROM bounded_replay_runs;')[0].n,1);
  assert.deepEqual(store.sqliteQuery(f.db,'SELECT * FROM maintenance_locks;'),[]);
});

test('remote deadline after actual responses keeps exact attempt counts and does not advance history',t=>{
  const f=fixture(t),spawn=f.deps.requestSessionDeps.spawnSync;
  let reads=0,readsAtResponse,commits=0;
  f.deps.sqliteJson=(...args)=>{reads++;return readOnlySqliteJson(...args);};
  f.deps.commit=()=>{commits++;assert.fail('no failure-checkpoint commit after direct time stop');};
  f.deps.requestSessionDeps.spawnSync=(...args)=>{const response=spawn(...args);if(f.state.calls.length===2){readsAtResponse=reads;f.state.tick=29500;}return response;};
  const result=executeLarkImHistory({db:f.db},f.deps);
  assert.equal(reads,readsAtResponse,'no subsequent binding/SQLite read after direct time stop');assert.equal(commits,0);
  assert.equal(result.outcome,'batch_deferred');assert.equal(result.processed,0);
  assert.equal(result.request_budget.cli_attempts,2);assert.equal(result.request_budget.self_attempts,1);
  assert.equal(result.request_budget.stop_reason,'time_budget');assert.equal(f.state.held,false);
  assert.deepEqual(store.sqliteQuery(f.db,'SELECT * FROM records;'),f.before);
  assert.deepEqual(store.sqliteQuery(f.db,'SELECT * FROM lark_im_history_progress;'),[]);
  assert.equal(store.sqliteQuery(f.db,'SELECT COUNT(*) AS n FROM bounded_replay_runs;')[0].n,0);
});

test('real COMMIT response after work cutoff preserves durable effects and releases only its owner',t=>{
  const f=fixture(t);let commits=0,cleanupTimeout;
  const result=withSpawn((run,command,args,settings)=>{
    const returned=run(command,args,settings);
    if(command==='sqlite3'&&settings.input?.includes('INSERT INTO bounded_replay_runs')){commits++;f.state.tick=29500;}
    if(command==='sqlite3'&&settings.input?.includes('DELETE FROM maintenance_locks'))cleanupTimeout=settings.timeout;
    return returned;
  },()=>executeLarkImHistory({db:f.db},f.deps));
  assert.equal(commits,1);assert.equal(result.ok,true);assert.equal(result.outcome,'processed');
  assert.equal(result.inserted+result.updated+result.duplicate+result.conflicts,1);
  assert.equal(result.request_budget.cli_attempts,2);assert.equal(result.request_budget.stop_reason,'time_budget');
  assert.ok(cleanupTimeout>0&&cleanupTimeout<=400);assert.equal(f.state.held,false);
  assert.deepEqual(store.sqliteQuery(f.db,'SELECT * FROM maintenance_locks;'),[]);
  assert.equal(store.sqliteQuery(f.db,'SELECT COUNT(*) AS n FROM bounded_replay_runs;')[0].n,1);
  assert.equal(store.sqliteQuery(f.db,'SELECT generation FROM lark_im_history_progress;')[0].generation,1);
});

for(const maxRecords of [1,2]) test(`known committed receipt plus cleanup failure stops a ${maxRecords}-target batch with explicit effects`,t=>{
  const f=fixture(t,maxRecords);let commits=0;
  const result=withSpawn((run,command,args,settings)=>{
    if(command==='sqlite3'&&settings.input?.includes("DELETE FROM maintenance_locks\n     WHERE name = 'global'"))return {status:1,stdout:'',stderr:'synthetic cleanup failure'};
    const returned=run(command,args,settings);
    if(command==='sqlite3'&&settings.input?.includes('INSERT INTO bounded_replay_runs'))commits++;
    return returned;
  },()=>executeLarkImHistory({db:f.db,maxRecords,maxSeconds:30},f.deps));
  assert.equal(commits,1);assert.equal(result.ok,false);assert.equal(result.outcome,maxRecords===1?'commit_cleanup_failed':'batch_interrupted');
  assert.equal(result.commit_state,'committed');assert.equal(result.cleanup_state,'failed');
  assert.equal(result.inserted+result.updated+result.duplicate+result.conflicts,1);
  assert.equal(f.state.calls.length,maxRecords===1?2:3);assert.equal(f.state.held,false);
  assert.equal(store.sqliteQuery(f.db,'SELECT COUNT(*) AS n FROM bounded_replay_runs;')[0].n,1);
  assert.equal(store.sqliteQuery(f.db,'SELECT COUNT(*) AS n FROM maintenance_locks;')[0].n,1);
  assert.doesNotMatch(JSON.stringify(result),/synthetic cleanup failure/);
});

test('batch keeps its first committed target at cutoff and a fresh invocation resumes the durable checkpoint',t=>{
  const f=fixture(t,2);let commits=0;
  const result=withSpawn((run,command,args,settings)=>{
    const returned=run(command,args,settings);
    if(command==='sqlite3'&&settings.input?.includes('INSERT INTO bounded_replay_runs')){commits++;f.state.tick=29500;}
    return returned;
  },()=>executeLarkImHistory({db:f.db,maxRecords:2,maxCliAttempts:12,maxSelfAttempts:6,maxSeconds:30},f.deps));
  assert.equal(result.processed,1);assert.equal(result.ok,true);assert.equal(commits,1);
  assert.equal(result.request_budget.cli_attempts,3);assert.equal(result.request_budget.stop_reason,'time_budget');
  const first=store.sqliteQuery(f.db,"SELECT after_id,generation,json_extract(last_result_json,'$.effects.audit_id') AS audit_id FROM lark_im_history_progress;")[0];
  assert.equal(first.after_id,f.before[0].id);assert.equal(first.generation,1);
  f.state.tick=0;f.state.calls=[];f.deps.historyCommandBudget=createHistoryCommandBudget({maxSeconds:30},{monotonicClock:()=>f.state.tick});
  const next=executeLarkImHistory({db:f.db},f.deps);
  assert.equal(next.ok,true);
  const resumed=store.sqliteQuery(f.db,'SELECT after_id,generation FROM lark_im_history_progress;')[0];
  assert.equal(resumed.after_id,f.before[1].id,JSON.stringify({next,first,resumed}));assert.equal(resumed.generation,2);
  const latestAudit=store.sqliteQuery(f.db,'SELECT id FROM bounded_replay_runs;');
  assert.deepEqual(latestAudit,[{id:next.audit_id}],'existing history policy retains the latest per-scope receipt');
  assert.notEqual(next.audit_id,first.audit_id);
  assert.equal(store.sqliteQuery(f.db,"SELECT COUNT(*) AS n FROM records WHERE json_type(canonical_json,'$.message_account_evidence')='object';")[0].n,2);
  const after=store.sqliteQuery(f.db,'SELECT * FROM records;');
  for(let i=0;i<after.length;i++) for(const key of Object.keys(after[i])) if(!['canonical_json','updated_at'].includes(key))assert.equal(after[i][key],f.before[i][key],key);
});

test('uncertain process result after a real COMMIT never promotes partial stdout into success or retries it',t=>{
  const f=fixture(t);let commits=0;
  assert.throws(()=>withSpawn((run,command,args,settings)=>{
    const returned=run(command,args,settings);
    if(command==='sqlite3'&&settings.input?.includes('INSERT INTO bounded_replay_runs')){
      commits++;return {...returned,status:null,signal:'SIGKILL',error:Object.assign(new Error('synthetic unknown exit'),{code:'ETIMEDOUT'})};
    }
    return returned;
  },()=>executeLarkImHistory({db:f.db},f.deps)),/commit bounded replay failed/);
  assert.equal(commits,1);assert.equal(f.state.calls.length,2);assert.equal(f.state.held,false);
  assert.equal(store.sqliteQuery(f.db,'SELECT COUNT(*) AS n FROM bounded_replay_runs;')[0].n,1,'durable audit remains available to existing CAS/idempotency recovery');
  assert.deepEqual(store.sqliteQuery(f.db,'SELECT * FROM maintenance_locks;'),[]);
});
