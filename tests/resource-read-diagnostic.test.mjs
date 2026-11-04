import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ensureInitialized,sqliteExec,sqliteQuery,quoteSql as q} from '../dist/storage/sqlite/ingestion-store.js';
import {readOnlySqliteJson,readSqliteReadDiagnostic,SqliteReadError} from '../src/storage/sqlite/readonly-query.mjs';
import {resourceReadDiagnostic,copyResourceReadDiagnostic} from '../src/diagnostics/resource-read-diagnostic.mjs';
import {executeResourceWork} from '../src/maintenance/resource-work.mjs';
import {SENT_SCOPE_ID} from '../src/adapters/lark-im/core.mjs';
import {runStep} from '../src/runtime/worker/worker.mjs';

const PRIVATE='SYNTHETIC_PRIVATE_SQL_LABEL_TOKEN_BODY',AT=Date.UTC(2025,4,3);
function ownedError(child={status:null,error:{code:'ETIMEDOUT'},signal:'SIGKILL',stdout:'',stderr:PRIVATE}) {
  let caught;
  try {readOnlySqliteJson('/synthetic/'+PRIVATE,`SELECT '${PRIVATE}';`,PRIVATE,
    {timeoutMs:2000,monotonicNowMs:()=>1,spawnSync:()=>child});}catch(error){caught=error;}
  assert(caught instanceof SqliteReadError);assert(readSqliteReadDiagnostic(caught));return caught;
}
function observingSpawns(observe,run) {
  const original=cp.spawnSync;cp.spawnSync=(...args)=>observe(original,...args);syncBuiltinESMExports();
  try{return run();}finally{cp.spawnSync=original;syncBuiltinESMExports();}
}
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'synthetic-resource-diagnostic-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=join(dir,'messages.sqlite');ensureInitialized(db);
  sqliteExec(db,`INSERT INTO records(source_id,first_seen_scope_id,external_id,record_type,actor_id,direction,canonical_json,raw_json)
    VALUES('lark.im',${q(SENT_SCOPE_ID)},'om_synthetic_diagnostic','lark.im.message','ou_synthetic_diagnostic','sent','{}','{}');`);
  const f={db,tick:1,writes:0,requests:0,leases:0};
  f.options={db,maxCliAttempts:3,maxSelfAttempts:2,maxSeconds:3};
  f.deps={now:()=>AT,monotonicClock:()=>f.tick,
    tryAcquireLease:()=>{f.leases++;return {state:'acquired',release(){}};},
    sqliteWrite:()=>{f.writes++;throw Error('unexpected write after rejected read');},
    requestSessionDeps:{spawnSync(){f.requests++;throw Error('unexpected external request');}}};
  f.run=()=>executeResourceWork(f.options,f.deps);return f;
}

test('resource diagnosis uses owned SQLite evidence and a fixed operation category without exception prose',()=>{
  const error=ownedError(),value=resourceReadDiagnostic('read bounded resource source rows',error);
  assert.equal(value.operation,'source_rows');assert.equal(value.diagnostic.kind,'timeout');
  assert.equal(value.diagnostic.timeout_ms,2000);assert.equal(value.diagnostic.spawn_code,'ETIMEDOUT');
  assert(Object.isFrozen(value));assert(Object.isFrozen(value.diagnostic));
  assert.doesNotMatch(JSON.stringify(value),new RegExp(PRIVATE));
  assert.equal(resourceReadDiagnostic(PRIVATE,error).operation,'unknown');
  assert.deepEqual(copyResourceReadDiagnostic(JSON.parse(JSON.stringify(value))),value);
});

test('ordinary Errors and prototype-forged SQLite errors cannot claim owned diagnosis',()=>{
  const owned=ownedError(),diagnostic=readSqliteReadDiagnostic(owned);
  for(const error of [Object.assign(Error(PRIVATE),{name:'SqliteReadError',reason:'read_timeout',diagnostic,read_diagnostic:diagnostic}),
    Object.assign(Object.create(SqliteReadError.prototype),{reason:'read_timeout',diagnostic}),{diagnostic}]) {
    assert.equal(resourceReadDiagnostic('read resource scan',error),null);
  }
});

for(const late of [false,true])test(`actual default account-binding read rejection survives swallowed admission error${late?' and simultaneous deadline':''}`,t=>{
  const f=fixture(t);let failures=0,readsAfter=0,ended=false;
  const result=observingSpawns((run,command,args,options)=>{
    if(command==='sqlite3'&&ended)readsAfter++;
    if(command==='sqlite3'&&options.input?.includes('COUNT(DISTINCT actor_id) AS sent_actors')) {
      failures++;assert.equal(options.timeout,2000);ended=true;if(late)f.tick=3001;
      return {status:1,stdout:'',stderr:`Parse error near line 5: no such table: ${PRIVATE}`};
    }
    return run(command,args,options);
  },()=>f.run());
  assert.equal(failures,1);assert.equal(result.outcome,'execution_failed');assert.equal(result.ok,false);
  assert.equal(result.read_diagnostic.operation,'account_binding');
  assert.equal(result.read_diagnostic.diagnostic.kind,'process_exit');
  assert.equal(result.read_diagnostic.diagnostic.sqlite_kind,'schema_missing');
  assert.equal(result.read_diagnostic.diagnostic.status,1);
  assert.equal(result.request_budget.stop_reason,late?'time_budget':null);
  assert.equal(result.request_budget.cli_attempts,0);assert.equal(result.request_budget.self_attempts,0);
  assert.equal(f.writes,0);assert.equal(f.requests,0);assert.equal(f.leases,0);assert.equal(readsAfter,0);
  assert.doesNotMatch(JSON.stringify(result),new RegExp(PRIVATE));
  assert.equal(sqliteQuery(f.db,'SELECT generation FROM lark_im_resource_scan;')[0].generation,0);
});

test('ordinary read exception with a copied diagnostic property remains unclassified',t=>{
  const f=fixture(t),valid=resourceReadDiagnostic('read resource scan',ownedError());
  f.deps.sqliteJson=()=>{throw Object.assign(Error(PRIVATE),{read_diagnostic:valid,diagnostic:valid.diagnostic});};
  const result=f.run();assert.equal(result.outcome,'execution_failed');assert.equal(result.read_diagnostic,undefined);
  assert.equal(f.writes,0);assert.equal(f.requests,0);assert.equal(f.leases,0);
  assert.doesNotMatch(JSON.stringify(result),new RegExp(PRIVATE));
});

function resourceStep(diagnostic) {
  const report={ok:false,profile:'known_record_resources/v1',outcome:'execution_failed',processed:0,available:0,
    deferred:1,blocked:0,failure:null,read_diagnostic:diagnostic,secret:PRIVATE,record_id:123,
    request_budget:{complete:true,max_cli_attempts:3,cli_attempts:0,max_self_attempts:2,self_attempts:0,
      max_seconds:3,min_interval_ms:1000,elapsed_ms:17,stop_reason:null}};
  return runStep('resources',['enrich','--target','resources'],{command:'maintenance',nowMs:()=>AT,monotonicNowMs:()=>1,
    runProcess:()=>({status:2,stdout:JSON.stringify(report),stderr:''})});
}

test('worker runStep parses and compacts safe resource read evidence through its real resource entry',()=>{
  const diagnostic=resourceReadDiagnostic('read bounded resource source rows',ownedError());
  const result=resourceStep(diagnostic);assert.equal(result.ok,false);assert.equal(result.exit_code,2);
  assert.deepEqual(result.summary.read_diagnostic,diagnostic);assert.equal(result.summary.processed,0);
  assert.equal(result.summary.request_budget.cli_attempts,0);
  assert.doesNotMatch(JSON.stringify(result.summary),new RegExp(PRIVATE));
  assert.equal(result.summary.secret,undefined);assert.equal(result.summary.record_id,undefined);
});

for(const [name,mutate] of [
  ['outer secret',value=>({...value,secret:PRIVATE})],
  ['nested secret',value=>({...value,diagnostic:{...value.diagnostic,sql:PRIVATE}})],
  ['unknown operation',value=>({...value,operation:PRIVATE})],
  ['unsafe inner category',value=>({...value,diagnostic:{...value.diagnostic,sqlite_kind:PRIVATE}})],
  ['missing inner field',value=>{const copy=structuredClone(value);delete copy.diagnostic.stderr_bytes;return copy;}],
])test(`worker real resource entry rejects ${name} rather than leaking or trusting it`,()=>{
  const valid=resourceReadDiagnostic('read resource scan',ownedError()),invalid=mutate(valid);
  assert.equal(copyResourceReadDiagnostic(invalid),null);
  const result=resourceStep(invalid);assert.equal(result.summary.read_diagnostic,undefined);
  assert.equal(result.summary.outcome,'execution_failed');assert.equal(result.summary.request_budget.cli_attempts,0);
  assert.doesNotMatch(JSON.stringify(result.summary),new RegExp(PRIVATE));
});

test('diagnostic accessors are rejected without executing their getters',()=>{
  let reads=0;const valid=resourceReadDiagnostic('read resource scan',ownedError());
  const outer=Object.defineProperty({operation:'scan'},'diagnostic',{enumerable:true,get(){reads++;return valid.diagnostic;}});
  const nested={...valid,diagnostic:Object.defineProperty({...valid.diagnostic},'status',{enumerable:true,get(){reads++;return 0;}})};
  assert.equal(copyResourceReadDiagnostic(outer),null);assert.equal(copyResourceReadDiagnostic(nested),null);assert.equal(reads,0);
});
