import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {resourceProducerFixture as fixture} from './helpers/resource-producer-fixture.mjs';
import {createResourceCommandBudget,createHistoryCommandBudget,isHistoryCommandBudget,HistoryCommandBudgetError} from '../src/maintenance/history-command-budget.mjs';
import {createMaintenanceRequestSession,MaintenanceRequestError} from '../src/maintenance/request-session.mjs';
import {enrichResources} from '../src/maintenance/enrich-resources.mjs';
import {readMessageSnapshot} from '../src/diagnostics/message-read-snapshot.mjs';
import {makeMediaResourceBinding,publishMediaResource,readMediaResource,readPendingMediaResource,makeMediaPendingSourceFence} from '../src/adapters/lark-im/media-resource-store.mjs';
import {projectionAccount} from '../src/adapters/lark-im/message-projection-evidence.mjs';

function spawns(observe,work) {
  const original=cp.spawnSync;cp.spawnSync=(...args)=>observe(original,...args);syncBuiltinESMExports();
  try{return work();}finally{cp.spawnSync=original;syncBuiltinESMExports();}
}
function patchedFs(patches,work) {
  const originals={};for(const key of Object.keys(patches)){originals[key]=fs[key];fs[key]=(...args)=>patches[key](originals[key],...args);}
  syncBuiltinESMExports();try{return work();}finally{Object.assign(fs,originals);syncBuiltinESMExports();}
}
function prepared(t) {
  const f=fixture(t);f.add('image',['synthetic_producer_budget']);f.options.maxSeconds=3;
  const row=f.row(1),canonical=JSON.parse(row.canonical_json),raw=JSON.parse(row.raw_json);
  f.binding=makeMediaResourceBinding(f.db,row,projectionAccount(row,canonical,raw).account_key,
    {type:'image',resource:{kind:'image_key',key:'synthetic_producer_budget',state:'reference_only'}});
  f.fence=makeMediaPendingSourceFence(row);
  return f;
}

test('resource factory keeps original origin, no extra reserve, and private brand',()=>{
  let clock=501;
  const budget=createResourceCommandBudget({maxSeconds:3},{startedMonotonicMs:1,monotonicClock:()=>clock});
  assert(isHistoryCommandBudget(budget));assert.equal(budget.timeoutMs(),2500);assert.equal(budget.summary().elapsed_ms,500);
  const history=createHistoryCommandBudget({maxSeconds:3},{monotonicClock:()=>clock});assert.equal(history.timeoutMs(),2250);
  clock=3001;assert.throws(()=>budget.assertReady(),e=>e instanceof HistoryCommandBudgetError&&e.reason==='time_budget');
  assert.throws(()=>budget.runCleanup(()=>assert.fail('no new grace')),HistoryCommandBudgetError);
});
test('remaining provider only shortens and cannot restore previously consumed time',()=>{
  let clock=0,remaining=500;
  const budget=createResourceCommandBudget({maxSeconds:3},{monotonicClock:()=>clock,remainingTimeMs:()=>remaining});
  assert.equal(budget.timeoutMs(),500);clock=100;remaining=10000;assert.equal(budget.timeoutMs(),400);
  clock=500;assert.throws(()=>budget.assertReady(),e=>e.reason==='time_budget');assert.equal(budget.summary().stop_reason,'time_budget');
});
for(const mode of ['reversed','nonfinite','throws'])test(`resource clock ${mode} remains a typed observer abort`,()=>{
  let clock=1,bad=false;
  const budget=createResourceCommandBudget({maxSeconds:3},{monotonicClock(){if(bad&&mode==='throws')throw Error('Synthetic private detail');return bad?(mode==='reversed'?0:NaN):clock;}});
  bad=true;assert.throws(()=>budget.assertReady(),e=>e instanceof HistoryCommandBudgetError&&e.reason==='clock_unavailable');
  assert.equal(budget.summary().stop_reason,'clock_unavailable');assert(!budget.summary().complete);
});
test('future origin and untrusted shaped producer budget are rejected before reads',t=>{
  assert.throws(()=>createResourceCommandBudget({maxSeconds:3},{startedMonotonicMs:2,monotonicClock:()=>1}),HistoryCommandBudgetError);
  const f=prepared(t);let reads=0;
  assert.throws(()=>enrichResources({...f.options,recordIds:[1],apply:true},{...f.deps,
    executionBudget:{assertReady(){},timeoutMs(){return 3000;}},readSnapshot(){reads++;}}),TypeError);
  assert.equal(reads,0);assert.equal(f.calls.length,0);
});

for(const inherited of [false,true])for(const preparation of [0,4000])test(`${inherited?'inherited':'direct'} producer original 3-second grant after ${preparation}ms modeled preparation`,t=>{
  const f=prepared(t),before=fs.readFileSync(f.db),dispatches=[],calls=[];
  if(inherited)f.deps.executionBudget=createResourceCommandBudget({maxSeconds:3},{startedMonotonicMs:1,monotonicClock:()=>f.tick});
  let reads=0;f.deps.readSnapshot=(...args)=>{const value=readMessageSnapshot(...args);if(++reads===1)f.tick+=preparation;return value;};
  const transport=f.deps.requestSessionDeps.spawnSync;
  f.deps.requestSessionDeps.spawnSync=(...args)=>{calls.push(f.tick);return transport(...args);};
  const report=spawns((run,command,args,options)=>{
    if(command==='sqlite3')dispatches.push({at:f.tick,timeout:options.timeout});return run(command,args,options);
  },()=>f.run());
  assert(dispatches.every(d=>d.at<3001&&d.timeout>0&&d.timeout<=3001-d.at));
  assert.equal(calls.length,preparation?0:3);assert(calls.every(at=>at<3001));
  assert.equal(report.available,preparation?0:1);assert.equal(report.ok,preparation===0);
  assert.equal(report.request_budget.stop_reason,preparation?'time_budget':null);
  assert.equal(report.request_budget.max_cli_attempts,3);assert.equal(report.request_budget.max_self_attempts,2);
  assert.equal(report.request_budget.cli_attempts,preparation?0:3);assert.equal(report.request_budget.self_attempts,preparation?0:2);
  if(preparation){assert.equal(reads,1);assert.equal(report.results[0].failure.reason,'time_budget');assert(!fs.existsSync(f.resourceDir));}
  assert.deepEqual(fs.readFileSync(f.db),before);assert(!fs.readdirSync(f.root).some(name=>name.startsWith('exocortex-media-')));
});
test('already expired inherited budget starts no snapshot, staging, helper or API',t=>{
  const f=prepared(t);f.deps.executionBudget=createResourceCommandBudget({maxSeconds:3},{monotonicClock:()=>f.tick});f.tick=4001;
  let children=0,reads=0;f.deps.readSnapshot=()=>{reads++;assert.fail('snapshot must not start');};
  const report=spawns((...args)=>{children++;assert.fail('subprocess must not start');},()=>f.run());
  assert.equal(reads,0);assert.equal(children,0);assert.equal(f.calls.length,0);assert.equal(report.request_budget.cli_attempts,0);
  assert.equal(report.request_budget.stop_reason,'time_budget');assert.equal(report.results[0].reason,'batch_stopped');
});
test('session rechecks trusted deadline after grant before entering publication action',()=>{
  let clock=1,entered=0,released=0;
  const budget=createResourceCommandBudget({maxSeconds:3},{monotonicClock:()=>clock});
  const session=createMaintenanceRequestSession({maxSeconds:3,maxCliAttempts:3,maxSelfAttempts:2},{commandBudget:budget,monotonicClock:()=>clock,
    tryAcquireLease(){clock=4001;return {state:'acquired',release(){released++;}};}});
  assert.throws(()=>session.withCommit(()=>{entered++;}),e=>e instanceof MaintenanceRequestError&&e.reason==='time_budget');
  assert.equal(entered,0);assert.equal(released,1);assert.equal(session.summary().cli_attempts,0);
});
test('publication source reread exhausting deadline starts no publication or retention helper',t=>{
  const f=prepared(t);let reads=0;const children=[];
  f.deps.readSnapshot=(...args)=>{const value=readMessageSnapshot(...args);if(++reads===2)f.tick=4001;return value;};
  const report=spawns((run,command,args,options)=>{children.push({at:f.tick,command});return run(command,args,options);},()=>f.run());
  assert.equal(reads,2);assert.equal(f.calls.length,3);assert.equal(report.available,0);
  assert.equal(report.results[0].pending_state,'not_retained');assert.equal(report.results[0].pending_reason,'time_budget');
  assert.equal(report.results[0].failure.reason,'time_budget');assert(!fs.existsSync(f.resourceDir));
  assert(children.every(x=>x.at<3001));
});
for(const expire of [false,true])test(`pending preservation ${expire?'without':'within'} the original remainder`,t=>{
  const f=prepared(t);let leases=0,reads=0;const children=[];
  f.deps.requestSessionDeps.tryAcquireLease=()=>++leases===4?{state:'busy'}:{state:'acquired',release(){}};
  f.deps.readSnapshot=(...args)=>{const value=readMessageSnapshot(...args);if(++reads===2&&expire)f.tick=4001;return value;};
  const report=spawns((run,command,args,options)=>{children.push({at:f.tick,command,timeout:options.timeout});return run(command,args,options);},()=>f.run());
  assert.equal(report.stop_reason,'sync_busy');assert.equal(f.calls.length,3);assert.equal(report.available,0);
  assert.equal(report.results[0].pending_state,expire?'not_retained':'retained');
  assert(children.every(x=>x.at<3001));
  if(expire){assert.equal(report.results[0].pending_reason,'time_budget');assert(!fs.existsSync(f.resourceDir));}
  else {assert.equal(readPendingMediaResource(f.resourceDir,f.binding,f.fence,{nowMs:f.wall}).status,'pending');
    assert(children.filter(x=>x.command==='python3').every(x=>x.timeout<=970));}
});
test('cached real JPEG expires after reading bytes without starting its decoder',t=>{
  const prefix=process.env.EXOCORTEX_LIBJPEG_PREFIX;assert(prefix,'prepared official JPEG test SDK is required');
  const f=prepared(t),encoded=cp.spawnSync(join(prefix,'bin/cjpeg'),['-grayscale'],{
    input:Buffer.concat([Buffer.from('P5\n2 1\n255\n'),Buffer.from([20,230])]),timeout:10000,maxBuffer:1024*1024});
  assert.equal(encoded.status,0);assert.equal(publishMediaResource(f.resourceDir,f.binding,encoded.stdout,{nowMs:f.wall}).status,'available');
  let helpers=0;const blobFd=new Set();
  const report=patchedFs({openSync(run,path,...args){const fd=run(path,...args);if(String(path).endsWith('.blob'))blobFd.add(fd);return fd;},
    readSync(run,fd,...args){const n=run(fd,...args);if(blobFd.has(fd))f.tick=4001;return n;},closeSync(run,fd){blobFd.delete(fd);return run(fd);}},()=>
    spawns((run,command,...args)=>{if(String(command).includes('jpeg-validator'))helpers++;return run(command,...args);},()=>f.run()));
  assert.equal(helpers,0);assert.equal(f.calls.length,0);assert.equal(report.request_budget.stop_reason,'time_budget');
  assert.equal(report.results[0].failure.reason,'time_budget');assert.equal(readMediaResource(f.resourceDir,f.binding).status,'available');
});
test('actual manifest publication followed by lost acknowledgement remains unknown, not zero effects',t=>{
  const f=prepared(t);let manifestLinked=false;
  const report=patchedFs({linkSync(run,from,to){const result=run(from,to);
    if(String(to).endsWith('.json')){manifestLinked=true;f.tick=4001;}return result;}},()=>f.run());
  assert(manifestLinked);assert.equal(report.available,0);assert.equal(report.results[0].publication_state,'unknown');
  assert.equal(report.results[0].pending_state,'not_retained');assert.equal(report.request_budget.stop_reason,'time_budget');
  assert.equal(readMediaResource(f.resourceDir,f.binding).status,'available','late lost acknowledgement cannot prove rollback');
});
test('an unbudgeted read hook cannot forge a trusted command deadline',t=>{
  const f=prepared(t);assert.equal(f.run().available,1);
  const result=readMediaResource(f.resourceDir,f.binding,{afterBlobRead(){throw new HistoryCommandBudgetError('time_budget');}});
  assert.equal(result.status,'invalid');assert.equal(result.reason,'resource_verification_failed');
});
for(const boundary of ['parent_realpath','stage_mkdir'])test(`zero-session ${boundary} expiry retains exact preparation-stop evidence`,t=>{
  const f=prepared(t),target={record_id:1,resource_key:'synthetic_producer_budget',reference_kind:'image_key'};
  f.options.resourceTargets=[target];let stages=0,sessions=0,cacheChecked=false;
  const cachePath=join(fs.realpathSync(f.root),'resources');
  f.deps.createRequestSession=(...args)=>{sessions++;return createMaintenanceRequestSession(...args);};
  const report=patchedFs({realpathSync(run,path,...args){const result=run(path,...args);
    if(boundary==='parent_realpath'&&cacheChecked&&path===f.root)f.tick=4001;return result;},
    lstatSync(run,path,...args){if(path===cachePath)cacheChecked=true;return run(path,...args);},
    mkdtempSync(run,path,...args){if(String(path).includes('exocortex-media-'))stages++;
      const result=run(path,...args);if(boundary==='stage_mkdir'&&String(path).includes('exocortex-media-'))f.tick=4001;return result;}},()=>f.run());
  assert.equal(sessions,0);assert.equal(f.calls.length,0);assert.equal(stages,boundary==='stage_mkdir'?1:0);
  assert.deepEqual(report.results,[{...target,state:'blocked',reason:'batch_stopped',failure:{stage:'selection',reason:'time_budget'}}]);
  assert.equal(report.request_budget.max_cli_attempts,3);assert.equal(report.request_budget.cli_attempts,0);
  assert.equal(report.request_budget.max_self_attempts,2);assert.equal(report.request_budget.self_attempts,0);
  assert.equal(report.request_budget.max_seconds,3);assert.equal(report.request_budget.elapsed_ms,4000);
  assert.equal(report.request_budget.stop_reason,'time_budget');assert.equal(report.available,0);
  assert(!fs.readdirSync(f.root).some(name=>name.startsWith('exocortex-media-')));
});
test('unrelated staging failure is not preparation budget or permission evidence',t=>{
  const f=prepared(t);let sessions=0;
  f.deps.createRequestSession=(...args)=>{sessions++;return createMaintenanceRequestSession(...args);};
  const report=patchedFs({mkdtempSync(run,path,...args){if(String(path).includes('exocortex-media-'))throw Error('Synthetic local staging failure');return run(path,...args);}},()=>f.run());
  assert.equal(sessions,0);assert.equal(f.calls.length,0);assert.equal(report.request_budget.stop_reason,null);
  assert.equal(report.results[0].failure.reason,'unknown');assert.notEqual(report.stop_reason,'time_budget');
  assert(!JSON.stringify(report).includes('Synthetic local staging failure'));
});
