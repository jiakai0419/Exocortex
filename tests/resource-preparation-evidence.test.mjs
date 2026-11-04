import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fixture} from './resource-producer-deadline.fixture.mjs';
import * as producer from '../src/maintenance/enrich-resources.mjs';
import {createResourceCommandBudget} from '../src/maintenance/history-command-budget.mjs';
import {resourceWorkIdentity} from '../src/maintenance/resource-work.mjs';
const {enrichResources}=producer,sha=x=>createHash('sha256').update(x).digest('hex');
function manifest(f,key) {
  const path=fs.readdirSync(f.resourceDir).filter(name=>name.endsWith('.json')).map(name=>join(f.resourceDir,name))
    .find(path=>JSON.parse(fs.readFileSync(path)).binding.key===key);
  assert(path);return {path,value:JSON.parse(fs.readFileSync(path))};
}
function corrupt(f,key) {
  const m=manifest(f,key),bytes=fs.readFileSync(join(f.resourceDir,`${m.value.sha256}.blob`)).subarray(0,-1);
  m.value.sha256=sha(bytes);m.value.size_bytes=bytes.length;
  fs.writeFileSync(join(f.resourceDir,`${m.value.sha256}.blob`),bytes,{mode:0o600});fs.writeFileSync(m.path,JSON.stringify(m.value));return bytes;
}
function cutoff(f,n,run) {
  let seen=0,writesAt=null;const original=Buffer.prototype.toString;
  Buffer.prototype.toString=function(...args) {
    const value=original.apply(this,args);
    if(args[0]==='latin1'&&args[1]===0&&args[2]===6&&value.startsWith('GIF')) {
      if(++seen===n){writesAt=f.writes.length;f.tick=4001;}
    }return value;
  };
  try{return {value:run(),seen,writesAt};}finally{Buffer.prototype.toString=original;}
}
// Exact original independent queue -> producer -> real private GIF cache path;
// truncate only authored GIF and update its manifest hash/length. Header-return
// clock is modeled, never remote transport or production timing.
for(const invalid of [false,true])for(const expired of [false,true])test(`cache preparation invalid=${invalid} expired=${expired} preserves observed facts`,t=>{
  const f=fixture(t);f.add('image',['synthetic_cached_cutoff']);
  assert.equal(enrichResources({...f.options,recordIds:[1],apply:true},f.deps).available,1);
  if(invalid)corrupt(f,'synthetic_cached_cutoff');
  f.calls.length=0;f.writes.length=0;f.tick=1;f.options.maxSeconds=3;
  let result;f.deps.enrichResources=(...args)=>result=enrichResources(...args);
  const observed=cutoff(f,expired?1:Infinity,()=>f.run()),report=observed.value;
  assert.equal(observed.seen,1);assert.equal(f.calls.length,0);
  const reason=invalid?'resource_image_invalid':expired?'batch_stopped':null;
  assert.equal(result.results[0].reason,reason);assert.equal(result.available,!invalid&&!expired?1:0);
  assert.equal(report.request_budget.stop_reason,expired?'time_budget':null);
  if(expired) {
    assert.equal(f.writes.length-observed.writesAt,0);assert.equal(report.request_budget.complete,true);
    assert.deepEqual(report.failure,{stage:'selection',reason:invalid?'resource_image_invalid':'time_budget',persisted:false});
    assert.equal(f.tasks()[0].state,'running');
  } else if(invalid)assert.deepEqual(report.failure,{stage:'selection',reason:'resource_image_invalid',persisted:true});
  t.diagnostic(JSON.stringify({invalid,expired,reason,queue_failure:report.failure,calls:f.calls.length,writes_after_cutoff:expired?f.writes.length-observed.writesAt:null}));
});

for(const expired of [false,true])test(`target metadata cannot overwrite actual cache rejection (expired=${expired})`,t=>{
  const f=fixture(t),key='synthetic_target_metadata';f.add('image',[key]);
  assert.equal(enrichResources({...f.options,recordIds:[1],apply:true},f.deps).available,1);corrupt(f,key);
  f.tick=1;f.calls.length=0;f.writes.length=0;
  const budget=createResourceCommandBudget({maxSeconds:3},{monotonicClock:()=>f.tick}),origin=resourceWorkIdentity(f.db,f.row(1));
  const target={record_id:1,resource_key:key,reference_kind:'image_key',state:'failed',reason:'permission_denied',failure:{stage:'resource_request',reason:'permission_denied'}};
  const result=cutoff(f,expired?1:Infinity,()=>enrichResources({...f.options,maxSeconds:3,recordIds:[1],resourceTargets:[target],apply:true},{...f.deps,executionBudget:budget})).value;
  assert.equal(result.results[0].reason,'resource_image_invalid');assert.equal(result.results[0].state,'blocked');
  assert.deepEqual(result.results[0].failure,{stage:'selection',reason:'resource_image_invalid'});
  assert.equal(producer.readResourcePreparationOutcome(result,budget,target,origin).failure.reason,'resource_image_invalid');
  assert.equal(result.request_budget?.stop_reason??null,expired?'time_budget':null);assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
});
for(const layout of ['records','slots'])for(const prefix of ['invalid','available'])for(const explicit of [false,true])test(`${layout} ${prefix} prefix survives later cutoff (exact=${explicit})`,t=>{
  const f=fixture(t),keys=['synthetic_first_cache','synthetic_second_cache','synthetic_unread_cache'];
  f.deps.resourceCapability=()=> 'message_image';
  const ids=layout==='records'?keys.map(key=>f.add('image',[key])):[f.add('post',keys)];
  for(const [index,key] of keys.entries()) {
    const id=layout==='records'?ids[index]:ids[0];
    assert.equal(enrichResources({...f.options,recordIds:[id],resourceTargets:[{record_id:id,resource_key:key,reference_kind:'image_key'}],apply:true},f.deps).available,1);
  }
  if(prefix==='invalid')corrupt(f,keys[0]);
  const before=fs.readdirSync(f.resourceDir).sort().map(name=>[name,sha(fs.readFileSync(join(f.resourceDir,name)))]);
  f.calls.length=0;f.writes.length=0;f.tick=1;
  const targets=keys.map((key,i)=>({record_id:layout==='records'?ids[i]:ids[0],resource_key:key,reference_kind:'image_key'}));
  const options={...f.options,maxSeconds:3,recordIds:ids,apply:true,...(explicit?{resourceTargets:targets}:{})};
  const observed=cutoff(f,2,()=>enrichResources(options,f.deps)),result=observed.value;
  assert.equal(observed.seen,2);assert.equal(result.results.length,3);
  assert.equal(result.results[0].state,prefix==='available'?'available':'blocked');
  assert.equal(result.results[0].reason,prefix==='available'?null:'resource_image_invalid');
  assert(result.results.slice(1).every(item=>item.reason==='batch_stopped'&&item.failure.reason==='time_budget'));
  if(layout==='slots'||explicit)assert.deepEqual(result.results.map(item=>item.resource_key),keys);
  assert.equal(result.request_budget.stop_reason,'time_budget');assert.equal(result.ok,false);
  assert.equal(result.available,prefix==='available'?1:0);assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
  assert.deepEqual(fs.readdirSync(f.resourceDir).sort().map(name=>[name,sha(fs.readFileSync(join(f.resourceDir,name)))]),before);
});
for(const change of ['none','reason','stage','state','key','reference','report_clone','budget','target',
  'origin_missing','origin_account_key','origin_binding_key','origin_source_fence'])test(`preparation proof remains exact under ${change}`,t=>{
  const f=fixture(t),key='synthetic_proof_cache';f.add('image',[key]);
  assert.equal(enrichResources({...f.options,recordIds:[1],apply:true},f.deps).available,1);corrupt(f,key);f.tick=1;f.calls.length=0;
  const target={record_id:1,resource_key:key,reference_kind:'image_key'},budget=createResourceCommandBudget({maxSeconds:3},{monotonicClock:()=>f.tick});
  const origin=resourceWorkIdentity(f.db,f.row(1));
  let result=cutoff(f,1,()=>enrichResources({...f.options,maxSeconds:3,recordIds:[1],resourceTargets:[target],apply:true},{...f.deps,executionBudget:budget})).value;
  const item=result.results[0];
  if(change==='reason')item.reason='permission_denied';
  if(change==='stage')item.failure.stage='resource_request';
  if(change==='state')item.state='available';
  if(change==='key')item.resource_key='synthetic_foreign';
  if(change==='reference')item.reference_kind='attachment_origin_key';
  if(change==='report_clone')result={...result};
  const otherBudget=createResourceCommandBudget({maxSeconds:3},{monotonicClock:()=>f.tick});
  const checkedOrigin=change==='origin_missing'?undefined:change.startsWith('origin_')?{...origin,[change.slice(7)]:'a'.repeat(64)}:origin;
  const checked=producer.readResourcePreparationOutcome(result,change==='budget'?otherBudget:budget,change==='target'?{...target,record_id:2}:target,checkedOrigin);
  if(change==='none')assert.equal(checked.failure.reason,'resource_image_invalid');else assert.equal(checked,null);
  assert.equal(f.calls.length,0);
});
