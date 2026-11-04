import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResourceCommandBudget, HistoryCommandBudgetError } from '../src/maintenance/history-command-budget.mjs';
import { makeMediaResourceBinding, makeMediaPendingSourceFence, publishMediaResource, readMediaResource,
  readPendingMediaResource, retainPendingMediaResource, reclaimPendingMediaResources, discardPendingMediaResource,
  MEDIA_PENDING_TTL_MS } from '../src/adapters/lark-im/media-resource-store.mjs';

// Authored source identities and 1x1 pixels only. Instrumentation observes real
// local file/lock boundaries; it neither replaces the budget brand nor uses API.
const GIF=Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b','hex');
const JPEG=Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9','hex');
const AT=Date.UTC(2041,1,2),sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(t) {
  const root=fs.mkdtempSync(join(tmpdir(),'authored-store-producer-deadline-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const db=join(root,'synthetic.db'),cache=join(root,'resources');
  fs.writeFileSync(db,'Authored private database identity',{mode:0o600});
  const raw_json=JSON.stringify({message_id:'om_authored_deadline',chat_id:'oc_authored_deadline',msg_type:'image',
    body:{content:'{"image_key":"img_authored_deadline"}'}});
  const row={id:1,source_id:'lark.im',record_type:'lark.im.message',external_id:'om_authored_deadline',external_version:'authored-v1',
    content_hash:sha(raw_json),raw_json,canonical_json:'{}',actor_id:'ou_authored_deadline',container_id:'oc_authored_deadline',
    direction:'sent',occurred_at:new Date(AT).toISOString(),occurred_at_ms:AT,body:'Authored fallback'};
  const binding=makeMediaResourceBinding(db,row,sha('Authored account'),{type:'image',resource:{kind:'image_key',key:'img_authored_deadline',state:'reference_only'}});
  assert.ok(binding);
  const fence=makeMediaPendingSourceFence(row),options={nowMs:AT+20,openingAtMs:AT,originalClosingAtMs:AT+10,stopReason:'sync_busy'};
  return {root,db,cache,binding,fence,options};
}
function clock() {
  let tick=0;
  const budget=createResourceCommandBudget({maxSeconds:1},{monotonicClock:()=>tick});
  return {budget,set:n=>{tick=n;}};
}
function instrument(overrides,work) {
  const saved=[];
  for(const [owner,key,wrap] of overrides) {const original=owner[key];saved.push([owner,key,original]);owner[key]=wrap(original);}
  syncBuiltinESMExports();
  try{return work();}finally{for(const [owner,key,original] of saved)owner[key]=original;syncBuiltinESMExports();}
}
const budgetError=error=>error instanceof HistoryCommandBudgetError&&error.reason==='time_budget';
const retain=(f,deps={})=>retainPendingMediaResource(f.cache,f.binding,f.fence,GIF,f.options,deps);
const pending=(f,deps={})=>readPendingMediaResource(f.cache,f.binding,f.fence,{nowMs:AT+30},deps);

for(const name of ['publish','read','retain','reclaim','discard'])test(`expired ${name} starts zero filesystem operations or helpers`,t=>{
  const f=fixture(t),saved=retain(f),c=clock();c.set(1001);let operations=0,helpers=0;
  const deps={executionBudget:c.budget},calls={
    publish:()=>publishMediaResource(f.cache,f.binding,JPEG,{nowMs:AT},deps),read:()=>pending(f,deps),
    retain:()=>retain(f,deps),reclaim:()=>reclaimPendingMediaResources(f.cache,{nowMs:AT+MEDIA_PENDING_TTL_MS},deps),
    discard:()=>discardPendingMediaResource(f.cache,saved.receipt,deps),
  };
  const changed=['openSync','lstatSync','realpathSync','mkdirSync','readSync','writeFileSync','linkSync','unlinkSync'];
  instrument([...changed.map(key=>[fs,key,original=>(...args)=>{operations++;return original(...args);}]),
    [childProcess,'spawnSync',original=>(...args)=>{helpers++;return original(...args);}]],()=>assert.throws(calls[name],budgetError));
  assert.equal(operations,0);assert.equal(helpers,0);assert.equal(pending(f).status,'pending');
});

test('unbranded budget cannot authorize pending/publication work',t=>{
  const f=fixture(t),fake={assertReady(){},timeoutMs(){return 1000;}};
  for(const call of [()=>retain(f,{executionBudget:fake}),()=>pending(f,{executionBudget:fake}),
    ()=>publishMediaResource(f.cache,f.binding,GIF,{nowMs:AT},{executionBudget:fake})])assert.throws(call,TypeError);
  assert.equal(fs.existsSync(f.cache),false);
});

test('binding preparation consumes the original grant before JPEG can start',t=>{
  const f=fixture(t),c=clock();let helpers=0;
  instrument([[fs,'lstatSync',original=>(path,...args)=>{const result=original(path,...args);if(String(path)===f.binding.database.path)c.set(1001);return result;}],
    [childProcess,'spawnSync',()=>()=>{helpers++;assert.fail('JPEG/helper after budget');}]],
    ()=>assert.throws(()=>publishMediaResource(f.cache,f.binding,JPEG,{nowMs:AT},{executionBudget:c.budget}),budgetError));
  assert.equal(helpers,0);assert.equal(fs.existsSync(f.cache),false);
});

test('pending blob read cutoff never starts JPEG validation or mutation helper',t=>{
  const f=fixture(t);assert.equal(retain(f).status,'pending');
  const slot=join(f.cache,'pending-v1','slot-00'),manifest=JSON.parse(fs.readFileSync(join(slot,'manifest.json'),'utf8'));
  manifest.sha256=sha(JPEG);manifest.size_bytes=JPEG.length;manifest.mime_type='image/jpeg';
  fs.writeFileSync(join(slot,'payload.blob'),JPEG);fs.writeFileSync(join(slot,'manifest.json'),JSON.stringify(manifest));
  const c=clock();let helpers=0;
  instrument([[childProcess,'spawnSync',()=>()=>{helpers++;assert.fail('late JPEG/helper');}]],
    ()=>assert.throws(()=>pending(f,{executionBudget:c.budget,afterBlobRead:()=>c.set(1001)}),budgetError));
  assert.equal(helpers,0);assert.equal(fs.existsSync(join(slot,'manifest.json')),true);
});

test('publication cutoff leaves the verified blob but publishes no manifest',t=>{
  const f=fixture(t),c=clock();
  assert.throws(()=>publishMediaResource(f.cache,f.binding,GIF,{nowMs:AT},{executionBudget:c.budget,beforeManifest:()=>c.set(1001)}),budgetError);
  const names=fs.readdirSync(f.cache);assert.equal(names.filter(n=>n.endsWith('.blob')).length,1);
  assert.equal(names.filter(n=>n.endsWith('.json')).length,0);assert.equal(names.some(n=>n.endsWith('.tmp')),false);
  assert.equal(readMediaResource(f.cache,f.binding).status,'missing');
});

test('retention lock receives only the remaining grant and preserves normal success',t=>{
  const f=fixture(t),c=clock();c.set(650);const timeouts=[];
  const saved=instrument([[childProcess,'spawnSync',original=>(command,args,settings)=>{
    timeouts.push(settings.timeout);return original(command,args,settings);
  }]],()=>retain(f,{executionBudget:c.budget}));
  assert.equal(saved.status,'pending');assert.deepEqual(timeouts,[350]);
  assert.equal(pending(f,{executionBudget:c.budget}).status,'pending');
  assert.equal(discardPendingMediaResource(f.cache,saved.receipt,{executionBudget:c.budget}).status,'removed');
});

test('a mutation helper finishing after cutoff cannot start retention writes',t=>{
  const f=fixture(t),c=clock();let helpers=0;
  instrument([[childProcess,'spawnSync',original=>(...args)=>{helpers++;const result=original(...args);c.set(1001);return result;}]],
    ()=>assert.throws(()=>retain(f,{executionBudget:c.budget}),budgetError));
  assert.equal(helpers,1);assert.deepEqual(fs.readdirSync(join(f.cache,'pending-v1')),['.mutation.lock']);
  assert.equal(retain(f).status,'pending','owned descriptor closes even when budget aborts');
});

test('reclaim cutoff before deletion keeps the selected pending generation',t=>{
  const f=fixture(t),saved=retain(f),c=clock();
  assert.throws(()=>reclaimPendingMediaResources(f.cache,{nowMs:saved.expires_at_ms},
    {executionBudget:c.budget,beforeReclaim:()=>c.set(1001)}),budgetError);
  assert.equal(pending(f).status,'pending');
});

test('a manifest linked before the acknowledgement cutoff remains published, not rolled back',t=>{
  const f=fixture(t),c=clock();let linked=0;
  instrument([[fs,'linkSync',original=>(source,target)=>{const result=original(source,target);
    if(String(target).endsWith('.json')){linked++;c.set(1001);}return result;}]],
    ()=>assert.throws(()=>publishMediaResource(f.cache,f.binding,GIF,{nowMs:AT},{executionBudget:c.budget}),budgetError));
  assert.equal(linked,1);assert.equal(readMediaResource(f.cache,f.binding).status,'available');
  assert.equal(fs.readdirSync(f.cache).some(n=>n.endsWith('.tmp')),false);
});

test('pending manifest written before cutoff remains unacknowledged and readable',t=>{
  const f=fixture(t),c=clock();let manifests=0;
  instrument([[fs,'writeFileSync',original=>(file,bytes,...args)=>{const result=original(file,bytes,...args);
    if(Buffer.isBuffer(bytes)&&bytes.includes(Buffer.from('lark_media_pending/v1'))){manifests++;c.set(1001);}return result;}]],
    ()=>assert.throws(()=>retain(f,{executionBudget:c.budget}),budgetError));
  assert.equal(manifests,1);assert.equal(pending(f).status,'pending');
  assert.equal(retain(f).status,'pending','unknown acknowledgement is not an instruction to recreate its generation');
});

test('the exact budget error survives public catch boundaries',t=>{
  const f=fixture(t),c=clock(),error=new HistoryCommandBudgetError('time_budget');
  assert.throws(()=>publishMediaResource(f.cache,f.binding,GIF,{nowMs:AT},
    {executionBudget:c.budget,beforeManifest:()=>{throw error;}}),seen=>seen===error);
  const saved=retain(f);
  assert.throws(()=>reclaimPendingMediaResources(f.cache,{nowMs:saved.expires_at_ms},
    {executionBudget:c.budget,beforeReclaim:()=>{throw error;}}),seen=>seen===error);
});
