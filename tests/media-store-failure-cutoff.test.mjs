import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as store from '../src/adapters/lark-im/media-resource-store.mjs';
import {createResourceCommandBudget,HistoryCommandBudgetError} from '../src/maintenance/history-command-budget.mjs';

const GIF=Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b','hex');
const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'synthetic-store-failure-cutoff-')));
  t.after(()=>{const cache=join(root,'resources');if(fs.existsSync(cache))fs.chmodSync(cache,0o700);fs.rmSync(root,{recursive:true,force:true});});
  const db=join(root,'invented.db');fs.writeFileSync(db,'invented database identity',{mode:0o600});
  const now=Date.now(),raw_json=JSON.stringify({message_id:'om_invented_failure',chat_id:'oc_invented_failure',msg_type:'image',body:{content:'{"image_key":"img_invented_failure"}'}});
  const row={id:1,source_id:'lark.im',record_type:'lark.im.message',external_id:'om_invented_failure',external_version:'1',raw_json,
    content_hash:sha(raw_json),canonical_json:'{}',actor_id:'ou_invented_failure',container_id:'oc_invented_failure',direction:'sent',
    occurred_at:new Date(now).toISOString(),occurred_at_ms:now,body:'Invented'};
  const binding=store.makeMediaResourceBinding(db,row,sha('invented account'),{type:'image',resource:{kind:'image_key',key:'img_invented_failure',state:'reference_only'}});
  assert.ok(binding);
  return {root,db,binding,cache:join(root,'resources'),fence:store.makeMediaPendingSourceFence(row),now,
    options:{nowMs:now,openingAtMs:now-2,originalClosingAtMs:now-1,stopReason:'time_budget'}};
}
function retain(f,deps={}) {return store.retainPendingMediaResource(f.cache,f.binding,f.fence,GIF,f.options,deps);}
function pending(f,deps={}) {return store.readPendingMediaResource(f.cache,f.binding,f.fence,{nowMs:f.now+1},deps);}
function setup(t,operation,invalid) {
  const f=fixture(t);let watch,method='fstatSync',active=true;
  let work,expected,normal;
  if(operation==='available_read'||operation==='available_image') {
    const published=store.publishMediaResource(f.cache,f.binding,GIF,{nowMs:f.now});assert.equal(published.status,'available');
    const manifest=join(f.cache,`${published.binding_digest}.json`);
    if(operation==='available_image') {
      const bytes=invalid?Buffer.from(GIF.subarray(0,-1)):GIF;
      const value=JSON.parse(fs.readFileSync(manifest));value.sha256=sha(bytes);value.size_bytes=bytes.length;
      fs.writeFileSync(join(f.cache,`${value.sha256}.blob`),bytes,{mode:0o600});fs.writeFileSync(manifest,JSON.stringify(value));
      f.imageBytes=bytes;method='imageHeader';expected='resource_image_invalid';
    } else {
      if(invalid)fs.chmodSync(manifest,0o644);watch=manifest;expected='resource_verification_failed';
    }
    work=deps=>store.readMediaResource(f.cache,f.binding,deps);normal='available';
  } else if(operation==='publication') {
    method='lstatSync';watch=f.cache;active=false;normal='available';expected='resource_publish_failed';
    work=deps=>store.publishMediaResource(f.cache,f.binding,GIF,{nowMs:f.now},{...deps,beforeManifest(){
      if(invalid)fs.chmodSync(f.cache,0o500);active=true;
    }});
  } else if(operation==='retention') {
    method='lstatSync';watch=f.db;normal='pending';expected='resource_pending_invalid';
    if(invalid){fs.renameSync(f.db,join(f.root,'original-db'));fs.mkdirSync(f.db,{mode:0o700});}
    work=deps=>retain(f,deps);
  } else {
    const saved=retain(f);assert.equal(saved.status,'pending');
    const dir=join(f.cache,'pending-v1',saved.receipt.slot);
    expected='resource_pending_invalid';
    if(operation==='retention_image') {
      const bytes=invalid?Buffer.from(GIF.subarray(0,-1)):GIF;
      const manifest=join(dir,'manifest.json'),value=JSON.parse(fs.readFileSync(manifest));
      value.sha256=sha(bytes);value.size_bytes=bytes.length;
      fs.writeFileSync(join(dir,'payload.blob'),bytes);fs.writeFileSync(manifest,JSON.stringify(value));
      f.imageBytes=bytes;method='imageHeader';work=deps=>retain(f,deps);normal='pending';
    } else if(operation==='pending_read') {
      watch=join(dir,'payload.blob');if(invalid)fs.chmodSync(watch,0o644);
      work=deps=>pending(f,deps);normal='pending';
    } else if(operation==='reclaim') {
      method='lstatSync';watch=join(f.cache,'pending-v1',`.cleanup-${saved.receipt.slot}.json`);
      if(invalid)fs.symlinkSync(f.db,watch);
      work=deps=>store.reclaimPendingMediaResources(f.cache,{nowMs:f.now+1},deps);normal='ready';
    } else {
      watch=join(dir,'manifest.json');if(invalid)fs.chmodSync(watch,0o644);
      work=deps=>store.discardPendingMediaResource(f.cache,saved.receipt,deps);normal='removed';
    }
  }
  return {...f,watch,method,work,expected,normal,isActive:()=>active};
}
function observe(f,expire) {
  let tick=0,hit=false,after=0,cleanupNoops=0,helpersAfter=0,result,error;const owned=new Map(),original={};
  const budget=createResourceCommandBudget({maxSeconds:1},{monotonicClock:()=>tick});
  const crossing=()=>{if(hit)return;hit=true;if(expire)tick=1000;};
  const operations=['openSync','lstatSync','fstatSync','readSync','realpathSync','readdirSync','mkdirSync','writeFileSync','fsyncSync','linkSync','unlinkSync','rmdirSync'];
  for(const method of operations) {
    original[method]=fs[method];fs[method]=(...args)=>{
      if(expire&&hit)after++;
      const path=method==='fstatSync'?owned.get(args[0]):args[0];
      const matched=method===f.method&&f.isActive()&&path===f.watch;
      try{const value=original[method](...args);if(method==='openSync')owned.set(value,args[0]);if(matched)crossing();return value;}
      catch(e){
        if(expire&&hit&&method==='unlinkSync'&&e.code==='ENOENT'&&/\/\.[0-9a-f-]{36}\.tmp$/.test(String(args[0]))){after--;cleanupNoops++;}
        if(matched)crossing();throw e;
      }
    };
  }
  const close=fs.closeSync;fs.closeSync=(fd,...args)=>{owned.delete(fd);return close(fd,...args);};
  const spawn=cp.spawnSync;cp.spawnSync=(...args)=>{if(expire&&hit)helpersAfter++;return spawn(...args);};
  const string=Buffer.prototype.toString;Buffer.prototype.toString=function(...args){
    const value=string.apply(this,args);
    if(f.method==='imageHeader'&&args[0]==='latin1'&&args[1]===0&&args[2]===6&&this.equals(f.imageBytes))crossing();
    return value;
  };
  syncBuiltinESMExports();
  try{result=f.work({executionBudget:budget});}catch(e){error=e;}
  finally{Object.assign(fs,original);fs.closeSync=close;cp.spawnSync=spawn;Buffer.prototype.toString=string;syncBuiltinESMExports();}
  return {result,error,hit,after,cleanupNoops,helpersAfter,budget:budget.summary(),open:owned.size};
}
for(const operation of ['available_read','available_image','publication','retention','retention_image','pending_read','reclaim','discard'])for(const invalid of [false,true])for(const expire of [false,true]) {
  test(`${operation}: established invalid=${invalid} and deadline=${expire} remain independent`,t=>{
    const f=setup(t,operation,invalid),observed=observe(f,expire);
    assert.equal(observed.hit,true,'real boundary must be reached');
    if(expire&&!invalid) {
      assert(observed.error instanceof HistoryCommandBudgetError);
      assert.equal(observed.error.reason,'time_budget');assert.equal(observed.result,undefined);
    } else {
      assert.equal(observed.error,undefined);
      assert.equal(observed.result.status,invalid?'invalid':f.normal);
      if(invalid)assert.equal(observed.result.reason,f.expected);
    }
    assert.equal(observed.budget.stop_reason,expire?'time_budget':null);
    assert.equal(observed.after,0,'no filesystem operation admitted after crossing');
    assert.equal(observed.helpersAfter,0,'no helper admitted after crossing');
    assert(observed.cleanupNoops<=(operation==='publication'&&expire?1:0),'only the existing publication finally may attempt its absent private temporary name');
    assert.equal(observed.open,0,'all owned descriptors closed');
  });
}

for(const operation of ['available_missing','pending_missing','reclaim_missing','discard_removed'])for(const expire of [false,true]) {
  test(`${operation}: normal absence at deadline=${expire} cannot become fake corruption or late success`,t=>{
    const f=fixture(t);let work,watch,normal;
    if(operation==='discard_removed') {
      const saved=retain(f);assert.equal(store.discardPendingMediaResource(f.cache,saved.receipt).status,'removed');
      watch=join(f.cache,'pending-v1',saved.receipt.slot);normal='removed';
      work=deps=>store.discardPendingMediaResource(f.cache,saved.receipt,deps);
    } else {
      watch=f.cache;normal=operation==='reclaim_missing'?'ready':'missing';
      work=deps=>operation==='available_missing'?store.readMediaResource(f.cache,f.binding,deps):operation==='pending_missing'?pending(f,deps):store.reclaimPendingMediaResources(f.cache,{nowMs:f.now},deps);
    }
    const observed=observe({...f,watch,method:'lstatSync',work,isActive:()=>true},expire);
    assert.equal(observed.hit,true);
    if(expire) {assert(observed.error instanceof HistoryCommandBudgetError);assert.equal(observed.error.reason,'time_budget');assert.equal(observed.result,undefined);}
    else {assert.equal(observed.error,undefined);assert.equal(observed.result.status,normal);}
    assert.equal(observed.budget.stop_reason,expire?'time_budget':null);
    assert.equal(observed.after,0);assert.equal(observed.helpersAfter,0);assert.equal(observed.open,0);
  });
}
