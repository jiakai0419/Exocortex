import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {fixture} from './resource-producer-deadline.fixture.mjs';
import {enrichResources,readResourcePreparationOutcome} from '../src/maintenance/enrich-resources.mjs';
import {sqliteQuery} from '../dist/storage/sqlite/ingestion-store.js';
import {isHistoryCommandBudget} from '../src/maintenance/history-command-budget.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const expired of [false,true])test(`independent actual producer finish cutoff=${expired} retains established cache rejection`,t=>{
 const f=fixture(t);f.add('image',['synthetic_finish_boundary']);
 assert.equal(enrichResources({...f.options,recordIds:[1],apply:true},f.deps).available,1);
 const name=fs.readdirSync(f.resourceDir).find(name=>name.endsWith('.json')),path=join(f.resourceDir,name),manifest=JSON.parse(fs.readFileSync(path));
 const bytes=fs.readFileSync(join(f.resourceDir,`${manifest.sha256}.blob`)).subarray(0,-1);
 manifest.sha256=sha(bytes);manifest.size_bytes=bytes.length;fs.writeFileSync(join(f.resourceDir,`${manifest.sha256}.blob`),bytes,{mode:0o600});fs.writeFileSync(path,JSON.stringify(manifest));
 const cache=()=>fs.readdirSync(f.resourceDir).sort().map(name=>[name,sha(fs.readFileSync(join(f.resourceDir,name)))]),cacheBefore=cache();
 const before=sqliteQuery(f.db,'SELECT * FROM records ORDER BY id;');
 f.tick=1;f.calls.length=0;f.writes.length=0;f.options.maxSeconds=3;
 let seen=false,broken=false,stackAtBoundary,writes=0,writesAtBoundary,childrenAfter=0,producer,proof;
 const clock=()=>{
  const stack=new Error('synthetic clock call-site observation').stack;
  // Select a real clock read by producer finish->assertReady, after preparation.
  // No validator return or producer result is replaced. This models the ordinary
  // clock crossing specifically between preparation end and finish observation.
  if(!seen&&/at finish \(file:.*\/src\/maintenance\/enrich-resources\.mjs:/.test(stack)&&/at (?:Object\.)?assertReady /.test(stack)){
   seen=true;stackAtBoundary=stack;writesAtBoundary=writes;if(expired){broken=true;f.tick=4001;}
  }
  return f.tick;
 };
 f.deps.monotonicClock=clock;f.deps.requestSessionDeps.monotonicClock=clock;
 f.deps.sqliteWrite=(db,sql,label,budget)=>{assert(isHistoryCommandBudget(budget));writes++;return sqliteQuery(db,sql,label,budget);};
 f.deps.enrichResources=(options,deps)=>{
  assert.equal(options.db,f.db);producer=enrichResources(options,deps);
  proof=readResourcePreparationOutcome(producer,deps.executionBudget,options.resourceTargets[0]);return producer;
 };
 const original=cp.spawnSync;cp.spawnSync=(...args)=>{if(broken)childrenAfter++;return original(...args);};syncBuiltinESMExports();
 let report;
 try{report=f.run();}finally{cp.spawnSync=original;syncBuiltinESMExports();}
 assert.equal(seen,true,'the natural producer finish clock boundary must actually be reached');
 assert.equal(producer.results[0].reason,'resource_image_invalid','actual cached decoder established the local rejection before this boundary');
 assert.equal(f.calls.length,0);assert.equal(childrenAfter,0);
 assert.deepEqual(sqliteQuery(f.db,'SELECT * FROM records ORDER BY id;'),before);assert.deepEqual(cache(),cacheBefore);
 const task=f.tasks()[0];
 if(expired){assert.equal(writes,writesAtBoundary);assert.equal(task.state,'running');assert.equal(task.failure_reason,null);}
 else {assert.equal(task.state,'blocked');assert.equal(task.failure_reason,'resource_image_invalid');}
 const observation={candidate:'synthetic candidate under test',synthetic_only:true,expired,real_finish_boundary_reached:seen,
  exact_same_db_and_producer:true,only_clock_modeled:true,proof_present:proof!==null,producer_reason:producer.results[0].reason,
  producer_budget:producer.request_budget,queue_failure:report.failure,queue_outcome:report.outcome,queue_receipt_complete:report.request_budget.complete,
  queue_stop:report.request_budget.stop_reason,scripted_requests:0,external_requests:0,writes_after_boundary:writes-writesAtBoundary,
  subprocesses_after_cutoff:childrenAfter,source_preserved:true,cache_preserved:true,task_state:task.state,clock_call_stack:stackAtBoundary};
 t.diagnostic(JSON.stringify({...observation,clock_call_stack:undefined,producer_budget:undefined}));
 assert.deepEqual(report.failure,{stage:'selection',reason:'resource_image_invalid',persisted:!expired},'known cache rejection survives later finish cutoff without claiming durable write');
 assert.equal(report.request_budget.stop_reason,expired?'time_budget':null);
});
