import assert from 'node:assert/strict';
import test, { after } from 'node:test';
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
import { createHistoryCommandBudget, HistoryCommandBudgetError } from '../src/maintenance/history-command-budget.mjs';
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


import { runCli } from '../bin/exocortex.mjs';
import { MaintenanceRequestError } from '../src/maintenance/request-session.mjs';
import { writeFileSync } from 'node:fs';
const reports=mkdtempSync(join(tmpdir(),'synthetic-history-policy-report-'));
after(()=>rmSync(reports,{recursive:true,force:true}));
const errorTree=error=>({name:error?.name,message:error?.message,
 ...(error?.errors?{errors:Array.from(error.errors,errorTree)}:{}),
 ...(error?.cause?{cause:errorTree(error.cause)}:{})});
for(const scenario of ['unknown_without_commit','unknown_after_real_commit','known_prefix_then_unknown_real_commit']) {
 test(`unknown SQLite outcome must remain failure at cleanup cutoff: ${scenario}`,async t=>{
  const count=scenario==='known_prefix_then_unknown_real_commit'?2:1;
  const f=fixture(t,count);let transactionCalls=0,realCommitted=0,stdout='',stderr='',caught=[],rawErrors=[],domainReport;
  f.deps.executeLarkImHistory=(options,deps)=>{domainReport=executeLarkImHistory(options,deps);return domainReport;};
  const originalCommit=store.commitBoundedReplayRecords;
  f.deps.commit=(...args)=>{try{return originalCommit(...args);}catch(error){caught.push(errorTree(error));rawErrors.push(error);throw error;}};
  const original=childProcess.spawnSync;
  childProcess.spawnSync=(command,args,settings)=>{
   const transaction=command==='sqlite3'&&settings?.input?.includes('INSERT INTO bounded_replay_runs');
   if(!transaction)return original(command,args,settings);
   transactionCalls++;
   const unknown=transactionCalls===count;
   if(unknown&&scenario==='unknown_without_commit') {
    f.state.tick=29950;
    return {status:null,signal:'SIGKILL',error:Object.assign(new Error('synthetic unknown child outcome'),{code:'ETIMEDOUT'}),stdout:'[{"partial":"synthetic nonreceipt"}]',stderr:''};
   }
   const result=original(command,args,settings);assert.equal(result.status,0);realCommitted++;
   if(!unknown)return result;
   f.state.tick=29950;
   return {...result,status:null,signal:'SIGKILL',error:Object.assign(new Error('synthetic unknown child outcome after actual SQLite commit'),{code:'ETIMEDOUT'})};
  };
  syncBuiltinESMExports();
  let code;
  try {
   code=await runCli(['maintenance','history','--db',f.db,'--max-records',String(count),'--max-cli-attempts',count===1?'4':'12','--max-self-attempts',count===1?'1':'6','--max-seconds','30','--format','json'],{
    monotonicNow:()=>f.state.tick,startedMonotonicMs:0,env:{LARK_CLI:'synthetic-never-spawned'},deps:f.deps,
    stdout:{write:s=>{stdout+=s;}},stderr:{write:s=>{stderr+=s;}},
   });
  } finally {childProcess.spawnSync=original;syncBuiltinESMExports();}
  const report=JSON.parse(stdout);
  const evidence={scenario,code,report,stderr,transactionCalls,realCommitted,error_chain:caught,
   audit:store.sqliteQuery(f.db,'SELECT COUNT(*) AS count FROM bounded_replay_runs;'),
   checkpoint:store.sqliteQuery(f.db,'SELECT after_id,generation FROM lark_im_history_progress;'),
   remaining_locks:store.sqliteQuery(f.db,'SELECT COUNT(*) AS count FROM maintenance_locks;'),
   synthetic_api_calls:f.state.calls.length,actual_api_calls:0,default_lease_calls:0};
  writeFileSync(`${reports}/policy-${scenario}.json`,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
  assert.equal(transactionCalls,count);assert.ok(caught[0]?.errors?.length>=2,'storage must retain original unknown child + cleanup cutoff');
  assert.notEqual(code,0,'unknown SQLite child must not become a healthy published history receipt just because cleanup crossed work cutoff');
  assert.equal(report.ok,false);assert.equal(report.outcome,'batch_interrupted');assert.equal(report.processed,count-1);
  assert.equal(report.inserted+report.updated+report.duplicate+report.conflicts,count-1,'unknown suffix never becomes reported committed effects');
  assert.equal(report.request_budget.stop_reason,'time_budget');assert.equal(report.failure_diagnostic.kind,'unknown');
  assert.equal(report.request_budget.cli_attempts,f.state.calls.length);assert.equal(report.request_budget.cli_attempts,count===1?2:3);
  assert.equal(report.request_budget.self_attempts,count===1?1:2);assert.doesNotMatch(stdout+stderr,/synthetic unknown child/);
  assert.equal(domainReport.cause,rawErrors[0]);assert.equal(Object.getOwnPropertyDescriptor(domainReport,'cause').enumerable,false);
  assert.doesNotMatch(stdout,/synthetic unknown child|SIGKILL|ETIMEDOUT|AggregateError|ou_synthetic|oc_synthetic|om_synthetic/);
 });
}

const PRIVATE_SENTINEL='INVENTED_PRIVATE_HISTORY_EXCEPTION_PATH_SQL_TOKEN';
const failureCases=[
  ['direct command time',()=>new HistoryCommandBudgetError('time_budget'),true],
  ['direct session time',()=>new MaintenanceRequestError('time_budget'),true],
  ['direct session CLI',()=>new MaintenanceRequestError('cli_budget'),true],
  ['direct session sync admission',()=>new MaintenanceRequestError('sync_busy'),true],
  ['forged reason and name',()=>Object.assign(new Error(PRIVATE_SENTINEL),{name:'HistoryCommandBudgetError',reason:'time_budget'}),false],
  ['generic wrapper',()=>new Error(PRIVATE_SENTINEL,{cause:new HistoryCommandBudgetError('time_budget')}),false],
  ['unknown plus budget aggregate',()=>new AggregateError([new Error(PRIVATE_SENTINEL),new HistoryCommandBudgetError('time_budget')],PRIVATE_SENTINEL),false],
  ['two budget cleanup aggregate',()=>new AggregateError([new HistoryCommandBudgetError('time_budget'),new HistoryCommandBudgetError('time_budget')],PRIVATE_SENTINEL),false],
  ['typed stop with unknown cause',()=>Object.assign(new HistoryCommandBudgetError('time_budget'),{cause:new Error(PRIVATE_SENTINEL)}),false],
  ['typed stop with unknown errors',()=>Object.assign(new MaintenanceRequestError('time_budget'),{errors:[new Error(PRIVATE_SENTINEL)]}),false],
];
for(const [name,makeError,canDefer] of failureCases)test(`actual CLI separates direct admission from failed operation: ${name}`,async t=>{
  const f=fixture(t),failure=makeError();let stdout='',stderr='',domainReport,commits=0;
  f.deps.commit=(_db,options)=>{
    commits++;f.state.tick=29950;
    assert.throws(()=>options.executionBudget.assertReady(),error=>error instanceof HistoryCommandBudgetError);
    throw failure;
  };
  f.deps.executeLarkImHistory=(options,deps)=>{domainReport=executeLarkImHistory(options,deps);return domainReport;};
  const code=await runCli(['maintenance','history','--db',f.db,'--max-seconds','30','--format',name==='generic wrapper'?'text':'json'],{
    monotonicNow:()=>f.state.tick,startedMonotonicMs:0,env:{LARK_CLI:'synthetic-never-spawned'},deps:f.deps,
    stdout:{write:s=>{stdout+=s;}},stderr:{write:s=>{stderr+=s;}},
  });
  const report=JSON.parse(stdout);
  assert.equal(code,canDefer?0:2);assert.equal(report.ok,canDefer);assert.equal(report.processed,0);
  assert.equal(report.outcome,canDefer?'batch_deferred':'batch_interrupted');
  assert.equal(report.request_budget.cli_attempts,2);assert.equal(report.request_budget.self_attempts,1);
  assert.equal(f.state.calls.length,2);assert.equal(commits,1);
  assert.equal(report.request_budget.stop_reason,'time_budget');
  if(canDefer){assert.equal(report.failure_diagnostic,undefined);assert.equal(domainReport.cause,undefined);}
  else{
    assert.deepEqual(report.failure_diagnostic,{version:1,stage:'single_target',kind:'unknown'});
    assert.equal(domainReport.cause,failure);assert.equal(Object.getOwnPropertyDescriptor(domainReport,'cause').enumerable,false);
  }
  assert.doesNotMatch(stdout+stderr,new RegExp(PRIVATE_SENTINEL));
  assert.deepEqual(store.sqliteQuery(f.db,'SELECT * FROM records;'),f.before);
  assert.deepEqual(store.sqliteQuery(f.db,'SELECT * FROM bounded_replay_runs;'),[]);
  assert.deepEqual(store.sqliteQuery(f.db,'SELECT * FROM lark_im_history_progress;'),[]);
});

test('actual CLI keeps a real initial read error when work cutoff is observed afterward',async t=>{
  const f=fixture(t);let stdout='',stderr='',queries=0;
  const failure=new Error(PRIVATE_SENTINEL);
  f.deps.sqliteJson=()=>{queries++;f.state.tick=29950;throw failure;};
  const code=await runCli(['maintenance','history','--db',f.db,'--max-seconds','30','--format','json'],{
    monotonicNow:()=>f.state.tick,startedMonotonicMs:0,env:{LARK_CLI:'synthetic-never-spawned'},deps:f.deps,
    stdout:{write:s=>{stdout+=s;}},stderr:{write:s=>{stderr+=s;}},
  });
  assert.notEqual(code,0);assert.equal(JSON.parse(stdout).ok,false);assert.equal(queries,1);
  assert.equal(f.state.calls.length,0);assert.doesNotMatch(stdout+stderr,new RegExp(PRIVATE_SENTINEL));
  assert.deepEqual(store.sqliteQuery(f.db,'SELECT * FROM records;'),f.before);
});

for(const phase of ['capture_before_self','admit_after_self','hint_policy','write_admission','commit_binding'])
for(const failedRead of [false,true])test(`terminal read survives ${phase} helper: ${failedRead?'actual failure plus stop':'successful read then direct stop'}`,async t=>{
  const f=fixture(t);let stdout='',stderr='',domainReport,triggered=0,commits=0;
  const failure=new Error(PRIVATE_SENTINEL);
  const target=label=>phase==='capture_before_self'?label==='remote account binding'&&f.state.calls.length===0
    :phase==='admit_after_self'?label==='remote account binding'&&f.state.calls.length===1
    :phase==='hint_policy'?label==='read history debt policy'
    :phase==='write_admission'?label==='capture Lark source admission'
    :label==='remote account binding'&&f.state.calls.length===2;
  const query=(db,sql,label,options)=>{
    assert.equal(triggered,0,'no further actual SQLite read may start after terminal read evidence');
    const rows=readOnlySqliteJson(db,sql,label,options);
    if(target(label)){triggered++;f.state.tick=29950;if(failedRead)throw failure;}
    return rows;
  };
  f.deps.sqliteJson=query;
  if(phase==='hint_policy')f.deps.debtDeps={
    readState:()=>({status:'ready',state:{account_key:createHash('sha256').update('lark.im\0ou_synthetic_command_observer').digest('hex'),
      observations:{synthetic_hint:{target:f.before[0].occurred_at_ms}}}}),sqliteJson:query,
  };
  f.deps.commit=()=>{commits++;assert.fail('no commit after terminal read');};
  f.deps.executeLarkImHistory=(options,deps)=>{domainReport=executeLarkImHistory(options,deps);return domainReport;};
  const code=await runCli(['maintenance','history','--db',f.db,'--log-dir',join(f.db,'..'),'--max-seconds','30','--format','json'],{
    monotonicNow:()=>f.state.tick,startedMonotonicMs:0,env:{LARK_CLI:'synthetic-never-spawned'},deps:f.deps,
    stdout:{write:s=>{stdout+=s;}},stderr:{write:s=>{stderr+=s;}},
  });
  const report=JSON.parse(stdout),expectedCalls=phase==='capture_before_self'?0:phase==='commit_binding'?2:1;
  assert.equal(triggered,1);assert.equal(commits,0);assert.equal(f.state.calls.length,expectedCalls);
  assert.equal(report.request_budget.cli_attempts,expectedCalls);assert.equal(report.processed,0);
  assert.equal(code,failedRead?2:0);assert.equal(report.ok,!failedRead);
  assert.equal(report.outcome,failedRead?'batch_interrupted':'batch_deferred');
  if(failedRead){assert.ok(domainReport.cause instanceof AggregateError);assert.equal(domainReport.cause.cause,failure);
    assert.equal(report.failure_diagnostic.kind,'unknown');}
  else{assert.equal(domainReport.cause,undefined);assert.equal(report.failure_diagnostic,undefined);}
  assert.doesNotMatch(stdout+stderr,new RegExp(PRIVATE_SENTINEL));
  assert.deepEqual(store.sqliteQuery(f.db,'SELECT * FROM records;'),f.before);
  assert.deepEqual(store.sqliteQuery(f.db,'SELECT * FROM bounded_replay_runs;'),[]);
  assert.deepEqual(store.sqliteQuery(f.db,'SELECT * FROM lark_im_history_progress;'),[]);
});
