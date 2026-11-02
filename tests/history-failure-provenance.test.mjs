import assert from 'node:assert/strict';
import test from 'node:test';
import { createLarkCliRunner, createTransportState, readLarkExecutionFailure } from '../src/adapters/lark-im/transport.mjs';
import { createMaintenanceRequestSession, MaintenanceRequestError } from '../src/maintenance/request-session.mjs';
import { createHistoryCommandBudget } from '../src/maintenance/history-command-budget.mjs';
import { historyFailureDiagnostic, historyOperation, preserveHistoryFailure } from '../src/maintenance/history-diagnostics.mjs';
import { SqliteReadError } from '../src/storage/sqlite/readonly-query.mjs';
import { sanitizeHistoryDiagnostic } from '../dist/core/history-diagnostics.js';
import { compactHistorySummary } from '../dist/runtime/worker/lark-im-worker-core.js';

const PRIVATE = 'SYNTHETIC_PRIVATE_BODY_SQL_PATH_TOKEN';
const SELF = ['contact', '+get-user', '--as', 'user'];
function caught(work) { try { work(); } catch(error) { return error; } assert.fail('expected failure'); }
function runner(spawn, overrides = {}) {
  return createLarkCliRunner({ bin:'synthetic-lark', spawn, state:createTransportState(),
    clock:()=>2_000_000_000_000, monotonicClock:()=>0, readSharedCooldown:()=>({state:'ready'}),
    writeSharedCooldown:()=>true, ...overrides });
}
const failed = (code, status=1) => ({status, signal:null, stdout:JSON.stringify({error:{type:'api',code,message:PRIVATE}}),stderr:''});
const timeout = () => ({status:null, signal:'SIGKILL', pid:42, stdout:'',stderr:PRIVATE,
  error:Object.assign(new Error(PRIVATE),{code:'ETIMEDOUT'})});
function diagnostic(error, operation='opening_self') {
  const same=caught(()=>historyOperation(operation,()=>{throw error;}));
  assert.equal(same,error);
  const value=historyFailureDiagnostic(error,'batch_prepare','failure');
  assert.doesNotMatch(JSON.stringify(value),new RegExp(PRIVATE));
  return value;
}

for (const [name,spawn,kind,execution,remote,resultCode] of [
  ['timeout',timeout,'network_timeout','started',false,null],
  ['exec unavailable',()=>({status:null,pid:0,stdout:'',stderr:PRIVATE,error:Object.assign(new Error(PRIVATE),{code:'ENOENT'})}), 'request_not_started','not_started',false,null],
  ['spawn throws',()=>{throw new Error(PRIVATE);},'request_execution_unknown','unknown',false,null],
  ['API rejected with nonzero exit',()=>failed(210508),'permission_denied','started',true,210508],
  ['API rejected with exit zero',()=>failed(210508,0),'permission_denied','started',true,210508],
  ['invalid JSON',()=>({status:0,stdout:'{'+PRIVATE,stderr:'',signal:null}),'request_invalid_json','started',false,null],
]) test(`genuine runner ${name} has finite provenance, not copied error text`,()=>{
  const error=caught(()=>runner(spawn)(SELF,{retries:0}));
  const value=diagnostic(error);
  assert.equal(value.kind,kind); assert.equal(value.operation,'opening_self');
  assert.equal(value.transport.operation,'self_profile'); assert.equal(value.transport.execution,execution);
  assert.equal(value.transport.remote_result,remote); assert.equal(value.transport.result_code,resultCode);
  assert.equal(readLarkExecutionFailure(new Error(error.message)),null);
  assert.equal(historyFailureDiagnostic(new Error(error.message),'batch_prepare','failure').kind,'unknown');
  const copy=readLarkExecutionFailure(error); copy.receipt.result_kind='permission_denied';
  assert.deepEqual(historyFailureDiagnostic(error,'batch_prepare','failure'),value);
  const summary=compactHistorySummary({ok:false,outcome:'batch_interrupted',processed:0,failure_diagnostic:value,
    request_budget:{cli_attempts:1,self_attempts:1,stop_reason:null}});
  assert.deepEqual(summary.failure_diagnostic,value);
  assert.doesNotMatch(JSON.stringify(summary),new RegExp(PRIVATE));
});

test('untyped arbitrary remote-looking payload cannot establish permission rejection',()=>{
  const error=caught(()=>runner(()=>({status:1,stdout:PRIVATE,stderr:'permission denied',signal:null}))(SELF));
  const value=diagnostic(error);
  assert.equal(value.kind,'unknown'); assert.equal(value.transport.remote_result,false);
  for(const lookalike of [error.message,{message:error.message,cause:error,kind:'permission_denied'},
    new AggregateError([error],PRIVATE,{cause:error}),Object.assign(new Error(PRIVATE),{cause:error})]) {
    assert.deepEqual(historyFailureDiagnostic(lookalike,'batch_prepare','failure'),{version:1,stage:'batch_prepare',kind:'unknown'});
  }
});

for(const reason of ['clock_unavailable','shared_cooldown_unavailable','lease_unavailable','retry_wait_unavailable'])
  test(`genuine local transport ${reason} stays separate from a remote result`,()=>{
    let calls=0;
    const overrides=reason==='clock_unavailable'?{clock:()=>{throw Error(PRIVATE);}}
      :reason==='shared_cooldown_unavailable'?{readSharedCooldown:()=>{throw Error(PRIVATE);}}
      :reason==='lease_unavailable'?{getLeaseStdio:()=>{throw Error(PRIVATE);}}
      :{state:createTransportState(),monotonicClock:()=>0,sleep:()=>{throw Error(PRIVATE);},readSharedCooldown:()=>({state:'cooldown',untilMs:2_000_000_000_100})};
    const error=caught(()=>runner(()=>{calls++;return failed(210508);},overrides)(SELF));
    const value=diagnostic(error);
    assert.equal(calls,0); assert.equal(value.transport.execution,'not_started');
    assert.equal(value.transport.remote_result,false); assert.equal(value.transport.local_reason,reason);
    assert.equal(value.kind,'request_not_started');
  });

test('only registered cutoff wrappers keep the earlier read category and deepest operation',()=>{
  const cause=caught(()=>historyOperation('message_prepare',()=>historyOperation('candidate_pool',()=>{
    throw Object.assign(new SqliteReadError('read_failed',PRIVATE),{path:PRIVATE,sql:PRIVATE});
  })));
  const wrapper=preserveHistoryFailure(new AggregateError([cause,new Error(PRIVATE)],PRIVATE,{cause}),cause);
  const twice=preserveHistoryFailure(new AggregateError([wrapper],PRIVATE,{cause:wrapper}),wrapper);
  historyOperation('storage_commit',()=>undefined);
  const result=diagnostic(twice,'binding_recheck');
  assert.deepEqual(result,{version:1,stage:'batch_prepare',kind:'read_failed',operation:'candidate_pool'});
  assert.equal(historyFailureDiagnostic(new AggregateError([cause],PRIVATE,{cause}),'batch_prepare','failure').kind,'unknown');
  assert.equal(historyFailureDiagnostic(Object.assign(new Error(PRIVATE),{reason:'read_failed',name:'SqliteReadError'}),'batch_prepare','failure').kind,'unknown');
});

test('session timeout near cutoff preserves started result through its registered AggregateError',()=>{
  let now=0,released=0;
  const budget=createHistoryCommandBudget({maxSeconds:6},{monotonicClock:()=>now});
  const session=createMaintenanceRequestSession({db:'/synthetic/db',maxSeconds:6,maxCliAttempts:12,maxSelfAttempts:6},{
    commandBudget:budget,monotonicClock:()=>now,now:()=>2_000_000_000_000+now,
    tryAcquireLease:()=>({state:'acquired',release(){released++;}}),readSharedCooldown:()=>({state:'ready'}),
    writeSharedCooldown:()=>true,spawnSync(_cmd,_args,options){now+=options.timeout;return timeout();},
  });
  const error=caught(()=>historyOperation('opening_self',()=>session.runLark(SELF)));
  assert.ok(error instanceof AggregateError);
  const value=historyFailureDiagnostic(error,'batch_prepare','failure');
  assert.equal(value.kind,'network_timeout'); assert.equal(value.operation,'opening_self');
  assert.equal(value.transport.execution,'started'); assert.equal(value.transport.remote_result,false);
  assert.equal(session.summary().stop_reason,'time_budget'); assert.equal(session.summary().cli_attempts,1);
  assert.equal(released,1); assert.equal(now,5000);
});

test('local admission stops keep identity and have no claimed execution receipt',()=>{
  for(const reason of ['time_budget','lease_unavailable','sync_busy','shared_cooldown_unavailable']) {
    const error=new MaintenanceRequestError(reason);
    const actual=caught(()=>historyOperation('opening_self',()=>{throw error;}));
    assert.equal(actual,error);
    assert.deepEqual(historyFailureDiagnostic(error,'batch_prepare','failure'),
      {version:1,stage:'batch_prepare',kind:reason,operation:'opening_self'});
  }
});

test('all extended public fields are finite and exact; hints retain their old shape',()=>{
  const valid=diagnostic(caught(()=>runner(timeout)(SELF)));
  assert.deepEqual(sanitizeHistoryDiagnostic(valid,'failure'),valid);
  for(const bad of [
    {...valid,operation:PRIVATE},{...valid,kind:'success'}, {...valid,transport:{...valid.transport,message:PRIVATE}},
    {...valid,transport:{...valid.transport,operation:PRIVATE}},{...valid,transport:{...valid.transport,execution:PRIVATE}},
    {...valid,transport:{...valid.transport,result_kind:PRIVATE}},{...valid,transport:{...valid.transport,result_code:-1}},
    {...valid,transport:{...valid.transport,result_code:210508}},{...valid,transport:{...valid.transport,local_reason:PRIVATE}},
    {...valid,transport:{...valid.transport,execution:'not_started'}},{...valid,transport:{...valid.transport,result_kind:null}},
    {...valid,sql:PRIVATE},{...valid,transport:undefined},
  ]) assert.equal(sanitizeHistoryDiagnostic(bad,'failure'),null);
  assert.equal(sanitizeHistoryDiagnostic({...valid,stage:'metadata_read'},'hint'),null);
  const hinted=historyFailureDiagnostic(new SqliteReadError('read_timeout',PRIVATE),'metadata_read','hint');
  assert.deepEqual(hinted,{version:1,stage:'metadata_read',kind:'read_timeout'});
  assert.throws(()=>historyOperation(PRIVATE,()=>{}),TypeError);
});

test('last actual timeout remains visible after a later retry exec failure',()=>{
  let calls=0;
  const run=runner(()=>++calls===1?timeout():({status:null,pid:0,stdout:'',stderr:PRIVATE,
    error:Object.assign(new Error(PRIVATE),{code:'ENOENT'})}));
  const error=caught(()=>run(SELF,{retries:1,retryDelayMs:0}));
  const value=diagnostic(error);
  assert.equal(calls,2); assert.equal(value.kind,'network_timeout');
  assert.equal(value.transport.execution,'started'); assert.equal(value.transport.result_kind,'network_timeout');
  assert.equal(value.transport.remote_result,false);
});

test('trusted business result stays distinct from a later local result-clock failure',()=>{
  let responseReturned=false;
  const run=runner(()=>{responseReturned=true;return failed(210508);},{clock:()=>{
    if(responseReturned)throw Error(PRIVATE);return 2_000_000_000_000;
  }});
  const value=diagnostic(caught(()=>run(SELF)));
  assert.equal(value.kind,'permission_denied'); assert.equal(value.transport.remote_result,true);
  assert.equal(value.transport.result_code,210508); assert.equal(value.transport.local_reason,'clock_unavailable');
});
