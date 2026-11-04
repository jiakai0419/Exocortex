import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import * as store from '../src/adapters/lark-im/media-resource-store.mjs';
import {createResourceCommandBudget,HistoryCommandBudgetError} from '../src/maintenance/history-command-budget.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const GIF=Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b','hex');
const moduleUrl=new URL('../src/adapters/lark-im/media-resource-store.mjs',import.meta.url).href;
const budgetUrl=new URL('../src/maintenance/history-command-budget.mjs',import.meta.url).href;
function setup(t,quarantine=false) {
  const root=fs.mkdtempSync(join(tmpdir(),'synthetic-pending-cleanup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const db=join(root,'invented.db');fs.writeFileSync(db,'invented database',{mode:0o600});
  const raw_json=JSON.stringify({message_id:'om_invented_cleanup',chat_id:'oc_invented_cleanup',msg_type:'image',body:{content:'{"image_key":"img_invented_cleanup"}'}});
  const now=Date.now(),row={id:1,source_id:'lark.im',record_type:'lark.im.message',external_id:'om_invented_cleanup',external_version:'1',
    raw_json,content_hash:sha(raw_json),canonical_json:'{}',actor_id:'ou_invented_cleanup',container_id:'oc_invented_cleanup',direction:'sent',occurred_at:new Date(now).toISOString(),occurred_at_ms:now,body:'Invented'};
  const binding=store.makeMediaResourceBinding(db,row,sha('invented owner'),{type:'image',resource:{kind:'image_key',key:'img_invented_cleanup',state:'reference_only'}});
  const f={root,db,cache:join(root,'resources'),binding,fence:store.makeMediaPendingSourceFence(row),now,gif:GIF.toString('hex')};
  const saved=store.retainPendingMediaResource(f.cache,binding,f.fence,GIF,{nowMs:now,openingAtMs:now-2,originalClosingAtMs:quarantine?null:now-1,stopReason:'time_budget'});
  assert.equal(saved.status,quarantine?'quarantined':'pending');f.receipt=saved.receipt;
  f.neighbor=join(root,'neighbor');fs.writeFileSync(f.neighbor,'unchanged fictional neighbor',{mode:0o600});return f;
}
function invoke(f,kind,budget) {
  const deps={executionBudget:budget};
  if(kind==='reclaim')return store.reclaimPendingMediaResources(f.cache,{nowMs:f.now+store.MEDIA_PENDING_TTL_MS+1},deps);
  if(kind==='discard')return store.discardPendingMediaResource(f.cache,f.receipt,deps);
  return store.retainPendingMediaResource(f.cache,f.binding,f.fence,GIF,{nowMs:f.now+10,openingAtMs:f.now+8,originalClosingAtMs:f.now+9,stopReason:'time_budget',freshDownload:true},deps);
}
const phases=['prepare_open','prepare_partial_write','prepare_write','prepare_fsync','intent_link','prepare_unlink','manifest_unlink','payload_unlink','claim_unlink','slot_rmdir','intent_unlink'];
function cut(f,kind,phase) {
  let tick=0,hit=false,after=0;const tracked=new Map(),original={},budget=createResourceCommandBudget({maxSeconds:1},{monotonicClock:()=>tick});
  const selected=(name,args)=>{
    const path=typeof args[0]==='string'?args[0]:tracked.get(args[0]);
    const base=typeof path==='string'?basename(path):'';
    return phase==='prepare_open'&&name==='openSync'&&base.endsWith('.preparing')
      ||phase.startsWith('prepare_')&&['prepare_partial_write','prepare_write','prepare_fsync'].includes(phase)&&base.endsWith('.preparing')&&name===(phase==='prepare_fsync'?'fsyncSync':'writeFileSync')
      ||phase==='intent_link'&&name==='linkSync'&&String(args[1]).endsWith('.json')
      ||phase==='prepare_unlink'&&name==='unlinkSync'&&base.endsWith('.preparing')
      ||phase==='manifest_unlink'&&name==='unlinkSync'&&base==='manifest.json'
      ||phase==='payload_unlink'&&name==='unlinkSync'&&base==='payload.blob'
      ||phase==='claim_unlink'&&name==='unlinkSync'&&base==='claim.json'
      ||phase==='slot_rmdir'&&name==='rmdirSync'&&base===f.receipt.slot
      ||phase==='intent_unlink'&&name==='unlinkSync'&&base===`.cleanup-${f.receipt.slot}.json`;
  };
  for(const name of ['openSync','writeFileSync','fsyncSync','linkSync','unlinkSync','rmdirSync']) {
    original[name]=fs[name];fs[name]=(...args)=>{
      const match=selected(name,args);
      if(hit&&name!=='openSync')after++;
      if(match&&phase==='prepare_partial_write')args[1]=args[1].subarray(0,13);
      const result=original[name](...args);
      if(name==='openSync')tracked.set(result,args[0]);
      if(match){hit=true;tick=1000;}return result;
    };
  }
  syncBuiltinESMExports();
  try {assert.throws(()=>invoke(f,kind,budget),error=>error instanceof HistoryCommandBudgetError&&error.reason==='time_budget');}
  finally {Object.assign(fs,original);syncBuiltinESMExports();}
  assert.equal(hit,true,phase);assert.equal(after,0,'no mutation after cutoff');
}
function restart(f,kind) {
  const script=`import * as s from ${JSON.stringify(moduleUrl)};import {createResourceCommandBudget as budget} from ${JSON.stringify(budgetUrl)};
const f=JSON.parse(process.argv[1]),kind=process.argv[2],deps=()=>({executionBudget:budget({maxSeconds:3})});
let first,second;const at=kind==='reclaim'?f.now+s.MEDIA_PENDING_TTL_MS+2:f.now+11;
if(kind==='discard'){first=s.discardPendingMediaResource(f.cache,f.receipt,deps());second=s.discardPendingMediaResource(f.cache,f.receipt,deps());}
else if(kind==='reclaim'){first=s.reclaimPendingMediaResources(f.cache,{nowMs:at},deps());second=s.reclaimPendingMediaResources(f.cache,{nowMs:at},deps());}
else {const options={nowMs:at,openingAtMs:at-2,originalClosingAtMs:at-1,stopReason:'time_budget',freshDownload:true};first=s.retainPendingMediaResource(f.cache,f.binding,f.fence,Buffer.from(f.gif,'hex'),options,deps());second=s.retainPendingMediaResource(f.cache,f.binding,f.fence,Buffer.from(f.gif,'hex'),options,deps());}
const next=s.retainPendingMediaResource(f.cache,f.binding,f.fence,Buffer.from(f.gif,'hex'),{nowMs:at+1,openingAtMs:at-1,originalClosingAtMs:at,stopReason:'time_budget'},deps());
const stale=s.discardPendingMediaResource(f.cache,f.receipt,deps());console.log(JSON.stringify({first:first.status,second:second.status,next:next.status,stale:stale.status,new_generation:next.receipt?.generation!==f.receipt.generation}));`;
  const run=spawnSync(process.execPath,['--input-type=module','-e',script,JSON.stringify(f),kind],{encoding:'utf8',timeout:10000});
  assert.equal(run.status,0,run.stderr);return JSON.parse(run.stdout);
}
for(const kind of ['reclaim','discard','replace'])for(const phase of phases)test(`${kind} resumes in a fresh process after ${phase}`,t=>{
  const f=setup(t,kind==='replace'),dbBefore=fs.readFileSync(f.db),neighborBefore=fs.readFileSync(f.neighbor);cut(f,kind,phase);
  const observed=restart(f,kind),success={reclaim:'ready',discard:'removed',replace:'pending'}[kind];
  assert.deepEqual(observed,{first:success,second:success,next:'pending',stale:'invalid',new_generation:true});
  assert.deepEqual(fs.readFileSync(f.db),dbBefore);assert.deepEqual(fs.readFileSync(f.neighbor),neighborBefore);
  assert.equal(fs.readdirSync(join(f.cache,'pending-v1')).filter(n=>n.startsWith('.cleanup-')).length,0);
});
for(const attack of ['unknown_file','changed_file','hardlink','symlink','permissions','replaced_directory','corrupt_intent','changed_intent_proof'])test(`cleanup does not delete ${attack} replacement`,t=>{
  const f=setup(t);cut(f,'discard','manifest_unlink');const dir=join(f.cache,'pending-v1',f.receipt.slot),payload=join(dir,'payload.blob'),intent=join(f.cache,'pending-v1',`.cleanup-${f.receipt.slot}.json`);
  if(attack==='unknown_file')fs.writeFileSync(join(dir,'unowned'),'preserve',{mode:0o600});
  if(attack==='changed_file'){fs.renameSync(payload,join(f.root,'saved'));fs.writeFileSync(payload,GIF,{mode:0o600});}
  if(attack==='hardlink')fs.linkSync(payload,join(f.root,'external-link'));
  if(attack==='symlink'){fs.unlinkSync(payload);fs.symlinkSync(f.neighbor,payload);}
  if(attack==='permissions')fs.chmodSync(payload,0o644);
  if(attack==='replaced_directory'){fs.renameSync(dir,join(f.root,'original-slot'));fs.mkdirSync(dir,{mode:0o700});fs.writeFileSync(join(dir,'claim.json'),'new generation',{mode:0o600});}
  if(attack==='corrupt_intent')fs.writeFileSync(intent,'{}');
  if(attack==='changed_intent_proof'){const doc=JSON.parse(fs.readFileSync(intent));doc.proof.generation='00000000-0000-0000-0000-000000000001';fs.writeFileSync(intent,JSON.stringify(doc));}
  const files=fs.readdirSync(dir).sort();const result=store.discardPendingMediaResource(f.cache,f.receipt);
  assert.equal(result.status,'invalid');assert.deepEqual(fs.readdirSync(dir).sort(),files);assert.equal(fs.readFileSync(f.neighbor,'utf8'),'unchanged fictional neighbor');
});
test('old unanchored residue is not reinterpreted as new cleanup authority',t=>{
  const f=setup(t),dir=join(f.cache,'pending-v1',f.receipt.slot);fs.unlinkSync(join(dir,'claim.json'));
  const before=fs.readdirSync(dir).sort();assert.equal(store.reclaimPendingMediaResources(f.cache,{nowMs:f.now+store.MEDIA_PENDING_TTL_MS+1}).status,'invalid');assert.deepEqual(fs.readdirSync(dir).sort(),before);
});
test('read excludes a valid deleting generation without mutating it',t=>{
  const f=setup(t);cut(f,'discard','manifest_unlink');const root=join(f.cache,'pending-v1'),before=fs.readdirSync(root).sort();
  assert.equal(store.readPendingMediaResource(f.cache,f.binding,f.fence,{nowMs:f.now+1}).status,'missing');assert.deepEqual(fs.readdirSync(root).sort(),before);
});
