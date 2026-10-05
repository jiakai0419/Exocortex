import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { SAMPLE_POLICY, selectSampleChats, compareSampleMessage, evaluateSample, digest } from '../src/diagnostics/remote-sample-core.mjs';
import { createSampleApi, collectRemoteSample } from '../src/diagnostics/remote-sample.mjs';
import { remoteSampleCache, parseRemoteSampleCache, writeRemoteSampleCache, summarizeRemoteSample } from '../src/diagnostics/remote-sample-cache.mjs';
import { readLiveProbeCache } from '../src/diagnostics/live-probe-cache.mjs';

const now = Date.parse('2030-01-03T12:00:00Z');
const created = now - 3600000;
const binding = {state:'verified',evidence:'single_sent_actor',database_key:'a'.repeat(64),account_key:'b'.repeat(64)};
const row = (i) => ({id:chatScopeId(`synthetic_${i}`), chat_id:`synthetic_${i}`,source_id:'lark.im',enabled:1,hot_rank:i,hot_seen_at:new Date(now).toISOString()});
const remote = (id='synthetic_message') => ({message_id:id,chat_id:'synthetic_0',msg_type:'text',create_time:String(created),update_time:String(created),body:{content:'{"text":"synthetic text"}'}});
const local = (message=remote()) => ({external_id:message.message_id,source_id:'lark.im',record_type:'lark.im.message',container_id:message.chat_id,external_version:message.update_time,
  raw_json:JSON.stringify(message),canonical_json:JSON.stringify({source_api:'im.v1.messages'})});
const keyFor = (m) => digest([binding.database_key,binding.account_key,m.chat_id,m.message_id,Number(m.create_time)]);
function evaluate(messages=[remote()], records=new Map(), coverage={}, previous={}, at=now) {
  return evaluateSample({messages,records,coverage,binding,previous,now:at,windowEnd:now-600000});
}

test('hot slots cannot starve a stable inventory; disabled and unknown scopes excluded', () => {
  const inventory = Array.from({length:14},(_,i)=>row(i));
  inventory.push({...row(15),enabled:0},{...row(16),id:'foreign'});
  let rotation=0; const seen=new Set();
  for(let i=0;i<8;i++){const selected=selectSampleChats(inventory,rotation,now);rotation=selected.rotation;selected.selected.forEach(r=>seen.add(r.chat_id));assert.equal(selected.hot,2);assert.equal(selected.eligible,14);assert.equal(selected.selected.length,5);}
  assert.equal(seen.size,14);
});

test('native static comparison ignores object key order, retains array order and source identity', () => {
  const m=remote();m.body.content='{"b":[1,2],"a":"x"}';const l=local(m);const raw=JSON.parse(l.raw_json);raw.body.content='{"a":"x","b":[1,2]}';l.raw_json=JSON.stringify(raw);
  assert.equal(compareSampleMessage(m,l).content,'equal');
  raw.body.content='{"a":"x","b":[2,1]}';l.raw_json=JSON.stringify(raw);assert.equal(compareSampleMessage(m,l).kind,'content');
  assert.equal(compareSampleMessage(m,{...l,container_id:'different'}).kind,'identity_conflict');
  assert.equal(compareSampleMessage(m,{...l,source_id:'other'}).kind,'identity_conflict');
  assert.equal(compareSampleMessage(m,{...l,canonical_json:'{}'}).kind,'incomparable');
});

test('dynamic cards and merged children never become body mismatches; version direction is explicit', () => {
  for(const msg_type of ['interactive','merge_forward']) {const m={...remote(),msg_type};const l=local(m);m.body.content='{"dynamic":"another rendering"}';assert.deepEqual(compareSampleMessage(m,l),{kind:'match',content:'unverified'});}
  const m=remote(), l=local(m);m.update_time=String(created+10);assert.equal(compareSampleMessage(m,l).kind,'version');
  m.update_time=String(created-10);assert.equal(compareSampleMessage(m,l).kind,'local_newer');
  m.update_time='0';assert.equal(compareSampleMessage(m,l).kind,'incomparable');
});

test('missing needs target coverage and later same-target successful window, never arbitrary success', () => {
  const m=remote(),key=keyFor(m);
  const first=evaluate();assert.equal(first.counts.pending_sync,1);assert.equal(first.counts.confirmed_missing,0);
  const covered={[key]:{covered:true,latest_finished_ms:now-1000,details_pending:false}};
  const second=evaluate([m],new Map(),covered);assert.equal(second.counts.suspected_missing,1);
  const next=now+SAMPLE_POLICY.intervalMs;
  assert.equal(evaluate([m],new Map(),covered,second.observations,next).counts.confirmed_missing,0);
  assert.equal(evaluate([m],new Map(),{[key]:{covered:false,latest_finished_ms:next-1}},second.observations,next).counts.confirmed_missing,0);
  assert.equal(evaluate([m],new Map(),{[key]:{covered:true,latest_finished_ms:next-1}},second.observations,next).counts.confirmed_missing,1);
  assert.equal(evaluate([m],new Map(),{[key]:{covered:true,latest_finished_ms:next-1,details_pending:true}},second.observations,next).counts.confirmed_missing,0);
});

test('unrevisited and incomparable findings persist, matching revisit clears, expiry is explicit', () => {
  const first=evaluate();
  assert.equal(evaluate([],new Map(),{},first.observations).counts.unresolved_prior,1);
  assert.equal(Object.keys(evaluate([remote()],new Map([[remote().message_id,{...local(),canonical_json:'{}'}]]),{},first.observations).observations).length,1);
  assert.equal(Object.keys(evaluate([remote()],new Map([[remote().message_id,local()]]),{},first.observations).observations).length,0);
  assert.equal(evaluate([],new Map(),{},first.observations,now+SAMPLE_POLICY.observationTtlMs+1).counts.expired_observations,1);
});

function collector(overrides={}) {
  let calls=0;
  const deps={now:()=>now,context:()=>({database_key:binding.database_key}),readBinding:()=>binding,
    loadInventory:()=>[row(0)],inspectSnapshot:()=>({coverage:{},records:new Map([[remote().message_id,local()]])}),
    api:{count:()=>calls,deadline:now+55000,call:(path)=>{calls++;return path.includes('authen')?{code:0,data:{open_id:'ou_synthetic_self',tenant_key:'synthetic_tenant'}}:{code:0,data:{items:[remote()],has_more:false,page_token:''}}}},...overrides};
  return {deps,run:(options={})=>collectRemoteSample('/synthetic/db',options,deps)};
}

test('collector produces bounded public report, trims stability buffer, and publishes no payload', () => {
  const result=collector().run();assert.equal(result.outcome,'ok');assert.equal(result.report.status,'healthy');assert.equal(result.report.probe.api_calls,3);
  assert.equal(Date.parse(result.report.window.end),now-600000);assert.equal(result.report.findings.content_equal,1);
  const serialized=JSON.stringify(remoteSampleCache(result));for(const token of ['synthetic_message','synthetic text','ou_synthetic','synthetic_tenant','synthetic_0'])assert.equal(serialized.includes(token),false);
  assert.equal(summarizeRemoteSample(remoteSampleCache(result),now,{database_key:binding.database_key}).status,'sampled');
});

test('empty sample, unknown binding, switch of account/database and wrong chat never yield green', () => {
  const unknown=collector({readBinding:()=>({...binding,state:'unverified'})}).run();assert.equal(unknown.report.ok,false);assert.equal(unknown.report.probe.api_calls,1);
  const noChats=collector({loadInventory:()=>[]}).run();assert.equal(noChats.report.reason,'no_eligible_chats');assert.equal(noChats.report.probe.api_calls,0);
  const empty=collector({api:{count:()=>3,deadline:now+55000,call:p=>p.includes('authen')?{data:{open_id:'ou_synthetic_self',tenant_key:'tenant'}}:{code:0,data:{items:[],has_more:false,page_token:''}}}}).run();assert.equal(empty.report.ok,false);
  let identities=0;const switched=collector({api:{count:()=>3,deadline:now+55000,call:p=>p.includes('authen')?{data:{open_id:`ou_${identities++}`,tenant_key:'tenant'}}:{code:0,data:{items:[remote()],has_more:false,page_token:''}}}}).run();assert.equal(switched.report.reason,'account_changed');
  let snapshots=0;const replaced=collector({context:()=>({database_key:snapshots++?'c'.repeat(64):binding.database_key})}).run();assert.equal(replaced.report.reason,'database_changed');
  const wrong=collector({api:{count:()=>2,deadline:now+55000,call:p=>p.includes('authen')?{data:{open_id:'ou_synthetic_self',tenant_key:'tenant'}}:{code:0,data:{items:[{...remote(),chat_id:'foreign'}],has_more:false,page_token:''}}}}).run();assert.equal(wrong.outcome,'failed');
});

test('list pagination stops at two pages, reports truncation, freezes params, rejects duplicate page items', () => {
  const params=[];let seq=0;
  const sample=collector({inspectSnapshot:()=>({coverage:{},records:new Map()}),api:{count:()=>params.length+2,deadline:now+55000,call:(p,q)=>{
    if(p.includes('authen')) return {data:{open_id:'ou_synthetic_self',tenant_key:'tenant'}};
    params.push(q);seq++;return {code:0,data:{items:[remote(`synthetic_${seq}`)],has_more:true,page_token:`token${seq}`}};
  }}}).run();assert.equal(params.length,2);assert.equal(sample.report.probe.truncated_chats,1);assert.equal(params[0].end_time,params[1].end_time);assert.equal(params[1].page_token,'token1');
});

test('per-request pacing and lease release bound all API work; busy does not wait or spawn', () => {
  let at=now,held=false,spawned=0,releases=0;const waits=[];
  const api=createSampleApi('synthetic',{},{now:()=>at,sleep:ms=>{assert.equal(held,false);waits.push(ms);at+=ms},tryAcquireLease:()=>{held=true;return{state:'acquired',release:()=>{held=false;releases++}}},spawnSync:(bin,args,opts)=>{spawned++;assert.ok(opts.timeout<=4000);assert.equal(opts.maxBuffer,2*1024*1024);at+=20;return{status:0,stdout:'{"code":0,"data":{}}'}}});
  for(let i=0;i<12;i++)api.call('/open-apis/im/v1/messages');assert.throws(()=>api.call('/open-apis/im/v1/messages'),/request_budget/);assert.equal(spawned,12);assert.equal(releases,12);assert.equal(waits.length,11);
  const busy=createSampleApi('synthetic',{},{now:()=>now,tryAcquireLease:()=>({state:'busy'}),spawnSync:()=>assert.fail('busy spawned')});assert.throws(()=>busy.call('/open-apis/im/v1/messages'),/sync_busy/);
});

test('rate reset is not clipped to local retry budget; offline/timeout release leases without raw error', () => {
  let released=0;
  const api=createSampleApi('synthetic',{},{now:()=>now,tryAcquireLease:()=>({state:'acquired',release:()=>released++}),spawnSync:()=>({status:1,stderr:'{"code":99991400,"headers":{"x-ogw-ratelimit-reset":"7200"},"msg":"synthetic private"}'})});
  assert.throws(()=>api.call('/open-apis/im/v1/messages'),e=>e.reason==='rate_limited'&&e.retryAtMs===now+7200000&&!e.message.includes('private'));assert.equal(released,1);
  const cool=createSampleApi('synthetic',{cooldownsByOperation:{self_profile:now+1}},{now:()=>now,tryAcquireLease:()=>assert.fail('cooldown acquired')});assert.throws(()=>cool.call('/open-apis/authen/v1/user_info'),/rate_cooldown/);
});

test('cache is atomic/private and read-only projection rejects stale, future, wrong DB, failed evidence', t => {
  const root=mkdtempSync(join(tmpdir(),'exo-sample-synthetic-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=join(root,'cache.json'),result=collector().run();writeRemoteSampleCache(file,result);assert.equal(statSync(file).mode&0o777,0o600);
  const cache=readLiveProbeCache(file);assert.equal(cache.kind,'lark_im_live_probe_cache/v3');assert.equal(summarizeRemoteSample(cache,now+1800000,{database_key:binding.database_key}).reason,'expired');
  assert.equal(summarizeRemoteSample(cache,now-1,{database_key:binding.database_key}).reason,'invalid_timestamp');
  assert.equal(summarizeRemoteSample(cache,now,{database_key:'c'.repeat(64)}).reason,'context_mismatch');
  const failed={...result,report:{...result.report,status:'unavailable',ok:false,reason:'api_unavailable'}};writeRemoteSampleCache(file,failed);
  assert.equal(readLiveProbeCache(file).last_success_at,null);assert.equal(summarizeRemoteSample(readLiveProbeCache(file),now,{database_key:binding.database_key}).status,'unknown');
  assert.equal(readFileSync(file,'utf8').includes('synthetic text'),false);
});

test('regressions: valid CLI ok envelope, recent edit, incomparable prior and corrupt cache fail safely', () => {
  const api=createSampleApi('synthetic',{},{now:()=>now,tryAcquireLease:()=>({state:'acquired',release(){}}),spawnSync:()=>({status:0,stdout:'{"ok":true,"identity":"user","data":{}}'})});
  assert.equal(api.call('/open-apis/authen/v1/user_info').ok,true);
  const fresh={...remote(),update_time:String(now-1000)};
  const evaluated=evaluate([fresh],new Map([[fresh.message_id,local()]]));assert.equal(evaluated.counts.pending_sync,1);assert.equal(evaluated.counts.stale_version,0);
  const first=evaluate();const incomparable=evaluate([remote()],new Map([[remote().message_id,{...local(),external_version:null}]]),{},first.observations);
  assert.equal(incomparable.counts.unresolved_prior,1);
  const cache=remoteSampleCache(collector().run());delete cache.findings;assert.equal(parseRemoteSampleCache(cache),null);
});

test('collector consumes a single atomic proof and record snapshot, never split local reads', () => {
  let calls=0;
  const result=collector({inspectSnapshot:(_db,targets)=>{calls++;assert.equal(targets[0].message_id,remote().message_id);
    return {coverage:{[keyFor(remote())]:{covered:true,latest_finished_ms:now-1}},records:new Map([[remote().message_id,local()]])};},
    loadRecords:()=>assert.fail('split record read'),inspectCoverage:()=>assert.fail('split coverage read')}).run();
  assert.equal(calls,1);assert.equal(result.report.ok,true);assert.equal(result.report.findings.missing,0);
});

test('global known cooldown blocks a manual probe even without worker state and publishes new reset', () => {
  let released=false;
  const cooled=createSampleApi('synthetic',{},{now:()=>now,tryAcquireLease:()=>({state:'acquired',release(){released=true}}),
    readSharedCooldown:()=>({state:'cooldown',untilMs:now+10000}),spawnSync:()=>assert.fail('must not call')});
  assert.throws(()=>cooled.call('/open-apis/im/v1/messages'),e=>e.reason==='rate_cooldown'&&e.retryAtMs===now+10000);assert.equal(released,true);
  let published;
  const limited=createSampleApi('synthetic',{},{now:()=>now,tryAcquireLease:()=>({state:'acquired',release(){}}),readSharedCooldown:()=>({state:'ready'}),
    writeSharedCooldown:input=>{published=input;return true},spawnSync:()=>({status:1,stderr:'{"code":99991400,"headers":{"x-ogw-ratelimit-reset":"600"}}'})});
  assert.throws(()=>limited.call('/open-apis/im/v1/messages'),/rate_limited/);assert.equal(published.untilMs,now+600000);
});

test('cache reader rejects foreign source/schema and impossible positive sample counters before normalization', () => {
  const valid=remoteSampleCache(collector().run());assert.ok(parseRemoteSampleCache(valid));
  for(const mutate of [c=>{c.context.source_id='foreign'},c=>{c.schema_version=999},c=>{c.probe.api_calls=0},c=>{c.probe.pages=0},c=>{c.probe.chats_checked=0},c=>{c.probe.messages_per_chat=0}]){
    const value=structuredClone(valid);mutate(value);assert.equal(parseRemoteSampleCache(value),null);
  }
});

test('explicit native source identity contradictions and same-version type/deletion changes cannot pass as matches', () => {
  const m=remote();
  for(const field of ['message_id','chat_id','create_time']) {
    const l=local(m),raw=JSON.parse(l.raw_json);raw[field]=field==='create_time'?String(created-1):'contradictory';l.raw_json=JSON.stringify(raw);
    assert.equal(compareSampleMessage(m,l).kind,'identity_conflict');
    assert.equal(evaluate([m],new Map([[m.message_id,l]])).counts.identity_conflict,1);
  }
  const wrongType=local(m),raw=JSON.parse(wrongType.raw_json);raw.msg_type='post';wrongType.raw_json=JSON.stringify(raw);
  assert.equal(compareSampleMessage(m,wrongType).kind,'content');
  const retracted={...m,deleted:true},old=local({...m,deleted:false});assert.equal(compareSampleMessage(retracted,old).kind,'content');
});

test('a slow diagnostic request still leaves an unleased one-second gap for foreground sync', () => {
  let at=now,held=false;const waits=[];
  const api=createSampleApi('synthetic',{},{now:()=>at,tryAcquireLease:()=>{held=true;return{state:'acquired',release(){held=false}}},
    sleep:ms=>{assert.equal(held,false);waits.push(ms);at+=ms},spawnSync:()=>{at+=3000;return{status:0,stdout:'{"code":0,"data":{}}'}}});
  api.call('/open-apis/im/v1/messages');api.call('/open-apis/im/v1/messages');assert.deepEqual(waits,[1000]);
});


test('native identity type confusion never yields equal, healthy or sampled evidence', () => {
  for (const field of ['message_id', 'chat_id']) for (const value of [17, {}, [], true, null, '', ' ']) {
    const m=remote(), l=local(m), raw=JSON.parse(l.raw_json);raw[field]=value;l.raw_json=JSON.stringify(raw);
    assert.equal(compareSampleMessage(m,l).kind,'identity_conflict');
    const result=collector({inspectSnapshot:()=>({coverage:{},records:new Map([[m.message_id,l]])})}).run();
    assert.equal(result.report.ok,false);assert.equal(result.report.findings.identity_conflict,1);
    assert.notEqual(summarizeRemoteSample(remoteSampleCache(result),now,{database_key:binding.database_key}).status,'sampled');
  }
});

test('v3 evidence requires private regular single-link files without changing their modes', t => {
  const root=mkdtempSync(join(tmpdir(),'exo-cache-privacy-synthetic-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=join(root,'cache.json');writeRemoteSampleCache(file,collector().run());
  chmodSync(file,0o666);assert.equal(readLiveProbeCache(file),null);assert.equal(statSync(file).mode&0o777,0o666);
  chmodSync(file,0o600);linkSync(file,join(root,'linked.json'));assert.equal(readLiveProbeCache(file),null);
});

test('all sample counts enforce structural bounds and findings relationships, including direct projection', () => {
  const valid=remoteSampleCache(collector().run());
  const edits=[['hot_chats',999],['fair_chats',999],['eligible_chats',0],['eligible_chats',10001],['truncated_chats',999],
    ['truncated_chats',1],['hot_chats_requested',6],['hot_chats_found',2],['messages_per_chat',21],['unsupported_chats',2],['probe_errors',2]];
  for (const [field,value] of edits) {
    const c=structuredClone(valid);c.probe[field]=value;
    assert.equal(parseRemoteSampleCache(c),null,field);
    assert.equal(summarizeRemoteSample(c,now,{database_key:binding.database_key}).status,'unknown',field);
    c.ok=false;c.status='unavailable';assert.equal(parseRemoteSampleCache(c),null,`failure ${field}`);
  }
  for(const field of ['unresolved_prior','expired_observations','observation_overflow']) {
    const c=structuredClone(valid);c.ok=false;c.status='delayed';c.findings[field]=201;assert.equal(parseRemoteSampleCache(c),null,field);
  }
  const pending=collector({inspectSnapshot:()=>({coverage:{},records:new Map()})}).run();
  assert.ok(parseRemoteSampleCache(remoteSampleCache(pending)));
  for(const field of ['confirmed_missing','stale_version','content_equal','pending_sync']) {
    const c=remoteSampleCache(pending);c.findings[field]=2;assert.equal(parseRemoteSampleCache(c),null,field);
  }
});

test('probe forwards one absolute lease deadline and keeps the acquired descriptor inherited by API subprocess', () => {
  let at=now;
  const api=createSampleApi('synthetic',{},{now:()=>at,tryAcquireLease:options=>{
    assert.equal(options.deadlineMs,now+55000);at+=2000;return{state:'acquired',stdio:['pipe','pipe','pipe',42],release(){}};
  },spawnSync:(_bin,_args,opts)=>{assert.deepEqual(opts.stdio,['pipe','pipe','pipe',42]);assert.equal(opts.timeout,4000);return{status:0,stdout:'{"code":0,"data":{}}'};}});
  api.call('/open-apis/im/v1/messages');
});


test('positive evidence cannot normalize contradictory metadata or an oversized/unstable time window into sampled', () => {
  const valid=remoteSampleCache(collector().run());
  for(const mutate of [c=>{c.reason='account_changed'},c=>{c.reason='unknown'},c=>{delete c.probe.mode},c=>{c.probe.comparison='unknown'},
    c=>{c.last_success_at=new Date(now+1).toISOString()},c=>{c.checked_at=now},c=>{c.binding.tenant_verified=true}]) {
    const c=structuredClone(valid);mutate(c);assert.equal(parseRemoteSampleCache(c),null);
    assert.equal(summarizeRemoteSample(c,now,{database_key:binding.database_key}).status,'unknown');
  }
  for(const mutate of [c=>{c.window.start=new Date(now-600000-SAMPLE_POLICY.windowMs-1).toISOString()},c=>{c.window.end=new Date(now-600000+1).toISOString()}]) {
    const c=structuredClone(valid);mutate(c);assert.equal(summarizeRemoteSample(c,now,{database_key:binding.database_key}).reason,'invalid_timestamp');
  }
  const failed=structuredClone(valid);failed.ok=false;failed.status='unavailable';assert.equal(parseRemoteSampleCache(failed),null);
});


test('declared native records cannot hide invalid raw evidence behind the legacy incomparable path', () => {
  for (const raw_json of ['null','false','0','not-json','[]','{}',null]) {
    const m=remote(), l={...local(m),raw_json};
    assert.equal(compareSampleMessage(m,l).kind,'identity_conflict');
    const result=collector({inspectSnapshot:()=>({coverage:{},records:new Map([[m.message_id,l]])})}).run();
    assert.equal(result.report.ok,false);assert.equal(result.report.findings.identity_conflict,1);
    assert.notEqual(summarizeRemoteSample(remoteSampleCache(result),now,{database_key:binding.database_key}).status,'sampled');
  }
});
