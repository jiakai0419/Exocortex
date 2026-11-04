import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fixture} from './resource-producer-deadline.fixture.mjs';
import {enrichResources} from '../src/maintenance/enrich-resources.mjs';
import {readMessageSnapshot} from '../src/diagnostics/message-read-snapshot.mjs';
import {isHistoryCommandBudget} from '../src/maintenance/history-command-budget.mjs';

// Same authored fixture, 3-second grant, and 0/4000ms modeled preparation as
// the original independent counterexample. The modeled clock is not a claim
// about elapsed production time or the outer guardian's behavior.
for(const cost of [0,4000])test(`whole resource producer retains original deadline after ${cost}ms preparation`,t=>{
  const f=fixture(t);f.add('image',['synthetic_producer_budget']);f.options.maxSeconds=3;
  const deadline=f.tick+3000;let reads=0,active=false,producer;
  const sql=[],commands=[],transport=f.deps.requestSessionDeps.spawnSync;
  f.deps.requestSessionDeps.spawnSync=(...args)=>{commands.push({at:f.tick});return transport(...args);};
  f.deps.enrichResources=(options,deps)=>{
    assert(isHistoryCommandBudget(deps.executionBudget));active=true;
    try{return producer=enrichResources(options,{...deps,readSnapshot(...args){
      const result=readMessageSnapshot(...args);if(++reads===1)f.tick+=cost;return result;
    }});}finally{active=false;}
  };
  const original=cp.spawnSync;
  cp.spawnSync=(command,args,options)=>{
    if(active)sql.push({command,at:f.tick,timeout:options.timeout});
    return original(command,args,options);
  };syncBuiltinESMExports();
  let report;
  try{report=f.run();}finally{cp.spawnSync=original;syncBuiltinESMExports();}
  t.diagnostic(JSON.stringify({modeled_preparation_ms:cost,producer_sql:sql,transport_calls:commands.length}));
  assert.equal(sql.length,cost===0?4:2,'two default selection reads; only the live grant admits the two publication snapshot reads');
  for(const dispatch of sql){
    assert(dispatch.at<deadline,'no producer helper or SQLite after the original deadline');
    assert(Number.isInteger(dispatch.timeout)&&dispatch.timeout>0&&dispatch.timeout<=deadline-dispatch.at);
  }
  assert(commands.every(command=>command.at<deadline));
  if(cost===0){
    assert.equal(commands.length,3);assert.equal(producer.available,1);assert.equal(report.ok,true);
    assert.equal(f.tasks()[0].state,'available');
  }else{
    assert.equal(commands.length,0);assert.equal(producer.available,0);assert.equal(report.ok,false);
    assert.equal(report.outcome,'batch_deferred');assert.equal(report.request_budget.stop_reason,'time_budget');
    assert.equal(report.request_budget.complete,true);assert.equal(report.request_budget.cli_attempts,0);
    assert.deepEqual(report.failure,{stage:'selection',reason:'time_budget',persisted:false});
    assert.equal(f.tasks()[0].state,'running','no late result write; existing owner-qualified claim recovery remains responsible');
    assert.equal(f.tasks()[0].attempts,1);
  }
});

for(const mode of ['unproved_stop','wrong_target','wrong_cli','nonzero_calls','wrong_elapsed'])test(`untrusted preparation receipt ${mode} never becomes a complete zero-call result`,t=>{
  const f=fixture(t);f.add('image',['synthetic_producer_budget']);f.options.maxSeconds=3;
  f.deps.enrichResources=(options,deps)=>{
    if(mode!=='unproved_stop'){
      f.tick+=4000;assert.throws(()=>deps.executionBudget.assertReady());
    }
    const b=deps.executionBudget.summary();
    const receipt={max_cli_attempts:options.maxCliAttempts,max_self_attempts:2,max_seconds:options.maxSeconds,
      cli_attempts:0,self_attempts:0,min_interval_ms:1000,elapsed_ms:b.elapsed_ms,stop_reason:'time_budget'};
    const item={...options.resourceTargets[0],state:'blocked',reason:'batch_stopped',failure:{stage:'selection',reason:'time_budget'}};
    if(mode==='wrong_target')item.resource_key='synthetic_different_resource';
    if(mode==='wrong_cli')receipt.max_cli_attempts++;
    if(mode==='nonzero_calls')receipt.cli_attempts=1;
    if(mode==='wrong_elapsed')receipt.elapsed_ms+=1;
    return {results:[item],request_budget:receipt};
  };
  const report=f.run();assert.equal(report.ok,false);assert.equal(report.outcome,'execution_failed');
  assert.equal(report.request_budget.complete,false);assert.equal(report.request_budget.cli_attempts,null);
  assert.equal(f.tasks()[0].state,'running');assert.equal(f.calls.length,0);
});
