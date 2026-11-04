import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {fixture} from './resource-producer-deadline.fixture.mjs';
import {enrichResources,readResourcePreparationOutcome} from '../src/maintenance/enrich-resources.mjs';
import {sqliteExec,sqliteQuery,quoteSql as q} from '../dist/storage/sqlite/ingestion-store.js';
import {makeMediaPendingSourceFence} from '../src/adapters/lark-im/media-resource-store.mjs';
import {isHistoryCommandBudget} from '../src/maintenance/history-command-budget.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),key='synthetic_same_target_different_source';
function setup(t,foreign) {
 const f=fixture(t);f.add('image',[key]);
 if(foreign){
  const row=sqliteQuery(f.db,'SELECT * FROM records;')[0],raw=JSON.parse(row.raw_json),canonical=JSON.parse(row.canonical_json);
  raw.message_id='om_synthetic_foreign_preparation';canonical.message_id=raw.message_id;
  raw.chat_id='oc_synthetic_foreign_preparation';canonical.chat_id=raw.chat_id;canonical.chat_name='Synthetic Foreign Room';
  const rawJson=JSON.stringify(raw);
  sqliteExec(f.db,`UPDATE records SET external_id=${q(raw.message_id)},container_id=${q(raw.chat_id)},raw_json=${q(rawJson)},canonical_json=${q(JSON.stringify(canonical))},content_hash=${q(sha(rawJson))};`);
 }
 assert.equal(enrichResources({...f.options,recordIds:[1],apply:true},f.deps).available,1);
 const name=fs.readdirSync(f.resourceDir).find(n=>n.endsWith('.json')),path=join(f.resourceDir,name),manifest=JSON.parse(fs.readFileSync(path));
 let bytes=fs.readFileSync(join(f.resourceDir,`${manifest.sha256}.blob`));
 if(foreign){bytes=bytes.subarray(0,-1);manifest.sha256=sha(bytes);manifest.size_bytes=bytes.length;fs.writeFileSync(join(f.resourceDir,`${manifest.sha256}.blob`),bytes,{mode:0o600});fs.writeFileSync(path,JSON.stringify(manifest));}
 f.tick=1;f.calls.length=0;f.writes.length=0;f.options.maxSeconds=3;
 return {f,bytes,cache:()=>fs.readdirSync(f.resourceDir).sort().map(n=>[n,sha(fs.readFileSync(join(f.resourceDir,n)))])};
}
test('independent same-budget foreign DB/source preparation must not become the selected queue target diagnostic',t=>{
 const local=setup(t,false),foreign=setup(t,true),a=local.f,b=foreign.f;
 const beforeA=sqliteQuery(a.db,'SELECT * FROM records ORDER BY id;'),beforeB=sqliteQuery(b.db,'SELECT * FROM records ORDER BY id;');
 const fenceA=makeMediaPendingSourceFence(beforeA[0]),fenceB=makeMediaPendingSourceFence(beforeB[0]);
 assert.notEqual(a.db,b.db);assert.notEqual(fenceA,fenceB);assert.equal(beforeA[0].id,beforeB[0].id);
 const cacheA=local.cache(),cacheB=foreign.cache();let producer,proof,originalBudget,broken=false,writes=0,writesAtStop,childrenAfter=0;
 a.deps.sqliteWrite=(db,sql,label,budget)=>{assert(isHistoryCommandBudget(budget));writes++;return sqliteQuery(db,sql,label,budget);};
 a.deps.enrichResources=(options,deps)=>{
  assert.equal(options.db,a.db);originalBudget=deps.executionBudget;
  // Fault-inject only this trusted dependency seam. The foreign report is produced
  // by actual code on its actual private DB/cache, not constructed by the test.
  producer=enrichResources({...options,db:b.db,resourceDir:b.resourceDir},deps);
  proof=readResourcePreparationOutcome(producer,originalBudget,options.resourceTargets[0]);return producer;
 };
 const string=Buffer.prototype.toString,spawn=cp.spawnSync;
 Buffer.prototype.toString=function(...args){const out=string.apply(this,args);if(args[0]==='latin1'&&args[1]===0&&args[2]===6&&this.equals(foreign.bytes)&&!broken){broken=true;writesAtStop=writes;a.tick=4001;}return out;};
 cp.spawnSync=(...args)=>{if(broken)childrenAfter++;return spawn(...args);};syncBuiltinESMExports();
 let result;
 try{result=a.run();}finally{Buffer.prototype.toString=string;cp.spawnSync=spawn;syncBuiltinESMExports();}
 assert.equal(broken,true);assert.equal(a.calls.length,0);assert.equal(b.calls.length,0);assert.equal(childrenAfter,0);assert.equal(writes,writesAtStop);
 assert.deepEqual(sqliteQuery(a.db,'SELECT * FROM records ORDER BY id;'),beforeA);assert.deepEqual(sqliteQuery(b.db,'SELECT * FROM records ORDER BY id;'),beforeB);
 assert.deepEqual(local.cache(),cacheA);assert.deepEqual(foreign.cache(),cacheB);
 const task=a.tasks()[0];assert.equal(task.state,'running');assert.equal(task.failure_reason,null);assert.equal(task.failure_stage,null);
 const observation={candidate:'synthetic candidate under test',synthetic_only:true,requires_trusted_dependency_fault_injection:true,
  distinct_db:true,distinct_source_fence:fenceA!==fenceB,same_target_fields:true,same_original_budget:true,
  local_cache_valid:true,foreign_cache_invalid:true,foreign_preparation_proof_accepted:proof!==null,
  producer_reason:producer.results[0].reason,queue_failure:result.failure,queue_outcome:result.outcome,receipt_complete:result.request_budget.complete,
  stop:result.request_budget.stop_reason,requests:0,post_stop_writes:writes-writesAtStop,post_stop_subprocesses:childrenAfter,
  both_source_databases_preserved:true,both_cache_snapshots_preserved:true,claim_state:task.state};
 t.diagnostic(JSON.stringify(observation));
 assert.equal(result.failure,null,'foreign source rejection must not be attributed to the local selected target');
 assert.equal(result.outcome,'execution_failed');assert.equal(result.request_budget.complete,false);
});

function damageCache(f) {
 const name=fs.readdirSync(f.resourceDir).find(n=>n.endsWith('.json')),path=join(f.resourceDir,name),manifest=JSON.parse(fs.readFileSync(path));
 const bytes=fs.readFileSync(join(f.resourceDir,`${manifest.sha256}.blob`)).subarray(0,-1);
 manifest.sha256=sha(bytes);manifest.size_bytes=bytes.length;
 fs.writeFileSync(join(f.resourceDir,`${manifest.sha256}.blob`),bytes,{mode:0o600});fs.writeFileSync(path,JSON.stringify(manifest));
}
for(const origin of ['same','same_db_alias','foreign_identical_rows','same_db_source_change'])for(const expired of [false,true])
test(`actual local preparation origin=${origin} at finish expired=${expired}`,t=>{
 const local=setup(t,false),other=origin==='foreign_identical_rows'?setup(t,false):local,a=local.f,b=other.f;
 const sourceBefore=sqliteQuery(a.db,'SELECT * FROM records ORDER BY id;');
 if(a!==b)sqliteExec(b.db,`UPDATE records SET ${['created_at','received_at','updated_at'].map(k=>`${k}=${q(sourceBefore[0][k])}`).join(',')};`);
 if(a!==b)assert.deepEqual(sqliteQuery(b.db,'SELECT * FROM records ORDER BY id;'),sourceBefore,'database identity is the only initial source difference');
 const producerDb=origin==='same_db_alias'?join(a.root,'synthetic-database-alias.sqlite'):b.db;
 if(origin==='same_db_alias')fs.symlinkSync(a.db,producerDb);
 damageCache(b);const cacheA=local.cache(),cacheB=other.cache();
 let producer,hit=false,stopped=false,writes=0,lateWrites=0,lateChildren=0;
 const clock=()=>{
  if(!hit&&/at finish \(file:.*\/src\/maintenance\/enrich-resources\.mjs:/.test(new Error().stack)){
   hit=true;if(expired){a.tick=4001;stopped=true;}
  }return a.tick;
 };
 a.deps.monotonicClock=clock;a.deps.requestSessionDeps.monotonicClock=clock;
 a.deps.sqliteWrite=(db,sql,label,budget)=>{writes++;if(stopped)lateWrites++;return sqliteQuery(db,sql,label,budget);};
 a.deps.enrichResources=(options,deps)=>{
  if(origin==='same_db_source_change')sqliteExec(a.db,"UPDATE records SET canonical_json=json_set(canonical_json,'$.chat_name','Synthetic changed derived title');");
  producer=enrichResources({...options,db:producerDb,resourceDir:b.resourceDir},deps);return producer;
 };
 const spawn=cp.spawnSync;cp.spawnSync=(...args)=>{if(stopped)lateChildren++;return spawn(...args);};syncBuiltinESMExports();
 let result;try{result=a.run();}finally{cp.spawnSync=spawn;syncBuiltinESMExports();}
 assert.equal(hit,true);assert.equal(producer.results[0].reason,'resource_image_invalid');
 assert.equal(a.calls.length,0);assert.equal(b.calls.length,0);assert.equal(lateWrites,0);assert.equal(lateChildren,0);
 assert.deepEqual(local.cache(),cacheA);assert.deepEqual(other.cache(),cacheB);
 const task=a.tasks()[0];
 if(['same','same_db_alias'].includes(origin)) {
  assert.deepEqual(result.failure,{stage:'selection',reason:'resource_image_invalid',persisted:!expired});
  assert.equal(task.state,expired?'running':'blocked');
 } else {
  assert.equal(result.failure,null);assert.equal(result.outcome,'execution_failed');assert.equal(result.request_budget.complete,false);
  assert.equal(task.state,'running');assert.equal(task.failure_reason,null);
 }
 assert.equal(result.request_budget.stop_reason,expired?'time_budget':null);
 if(origin!=='same_db_source_change')assert.deepEqual(sqliteQuery(a.db,'SELECT * FROM records ORDER BY id;'),sourceBefore);
 else assert.notEqual(makeMediaPendingSourceFence(sqliteQuery(a.db,'SELECT * FROM records;')[0]),makeMediaPendingSourceFence(sourceBefore[0]));
 if(a!==b)assert.deepEqual(sqliteQuery(b.db,'SELECT * FROM records ORDER BY id;'),sourceBefore);
 t.diagnostic(JSON.stringify({origin,expired,queue_failure:result.failure,claim_state:task.state,lateWrites,lateChildren,writes}));
});
