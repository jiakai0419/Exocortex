import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import * as store from '../src/adapters/lark-im/media-resource-store.mjs';
import {createResourceCommandBudget,HistoryCommandBudgetError} from '../src/maintenance/history-command-budget.mjs';

const GIF_A=Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b','hex');
const GIF_B=Buffer.from(GIF_A);GIF_B[13]=1;
const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'synthetic-callback-cutoff-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const db=join(root,'invented.db');fs.writeFileSync(db,'invented binding file',{mode:0o600});
  const at=Date.UTC(2031,1,2),raw_json=JSON.stringify({message_id:'om_invented_callback',chat_id:'oc_invented_callback',msg_type:'image',body:{content:'{"image_key":"img_invented_callback"}'}});
  const row={id:1,source_id:'lark.im',record_type:'lark.im.message',external_id:'om_invented_callback',external_version:'1',
    raw_json,content_hash:sha(raw_json),canonical_json:'{}',actor_id:'ou_invented_callback',container_id:'oc_invented_callback',direction:'sent',occurred_at:new Date(at).toISOString(),occurred_at_ms:at,body:'Invented callback'};
  const binding=store.makeMediaResourceBinding(db,row,sha('invented callback owner'),{type:'image',resource:{kind:'image_key',key:'img_invented_callback',state:'reference_only'}});
  assert(binding);const f={root,db,binding,at,cache:join(root,'resources'),fence:store.makeMediaPendingSourceFence(row),options:{nowMs:at,openingAtMs:at-2,originalClosingAtMs:at-1,stopReason:'time_budget'}};
  f.seed=store.retainPendingMediaResource(f.cache,binding,f.fence,GIF_A,f.options);assert.equal(f.seed.status,'pending');return f;
}
function files(path) {
  return fs.readdirSync(path).sort().flatMap(name=>{const full=join(path,name),info=fs.lstatSync(full);
    return info.isDirectory()?files(full).map(child=>({path:name+'/'+child.path,sha256:child.sha256})):[{path:name,sha256:sha(fs.readFileSync(full))}];});
}
function observe(f,{invalid,boundary,stop='live',failure=null}) {
  let tick=0,hit=false,cut=false,lockReads=0,callbackReturned=false,postParent=false,helperCalls=0;
  const afterOperations=[],original={},before=files(f.cache),beforeDb=sha(fs.readFileSync(f.db));
  const budget=createResourceCommandBudget({maxSeconds:1},{monotonicClock:()=>tick});
  const cross=()=>{assert.equal(hit,false,'one selected boundary');hit=true;if(stop!=='live'){cut=true;tick=stop==='clock_unavailable'?NaN:1000;}};
  const operations=['realpathSync','lstatSync','openSync','fstatSync','readSync','readdirSync','writeFileSync','fsyncSync','linkSync','unlinkSync','mkdirSync','rmdirSync','closeSync'];
  for(const name of operations) {
    original[name]=fs[name];fs[name]=(...args)=>{
      if(cut)afterOperations.push(name);
      const lock=name==='lstatSync'&&typeof args[0]==='string'&&basename(args[0])==='.mutation.lock';
      if(lock)lockReads++;
      const selectedLock=lock&&lockReads===(boundary==='before_callback'?1:2);
      if(selectedLock&&failure==='lock_replaced'){
        original.renameSync(args[0],join(f.root,'original-owned-lock'));
        original.writeFileSync(args[0],'',{mode:0o600});
      }
      const value=original[name](...args);
      if(selectedLock&&failure) {
        hit=true;
        if(failure==='EIO')throw Object.assign(new Error('invented completion error'),{code:'EIO'});
        if(failure==='forged_budget')throw Object.assign(new Error('invented untrusted stop'),{name:'HistoryCommandBudgetError',reason:'time_budget'});
      }
      if(selectedLock&&['lock_read','before_callback'].includes(boundary)&&!failure)cross();
      if(lock&&lockReads===2)postParent=true;
      if(name==='lstatSync'&&args[0]===join(f.cache,'pending-v1')&&postParent&&boundary==='directory_read')cross();
      return value;
    };
  }
  original.renameSync=fs.renameSync;
  const equals=Buffer.prototype.equals;Buffer.prototype.equals=function(other){const result=equals.call(this,other);
    if(!callbackReturned&&this.length===GIF_A.length&&Buffer.isBuffer(other)&&other.length===GIF_A.length
      &&equals.call(this,GIF_A)&&(equals.call(other,GIF_A)||equals.call(other,GIF_B))){
      callbackReturned=true;if(boundary==='callback_return')cross();
    }return result;
  };
  const spawn=cp.spawnSync;cp.spawnSync=(...args)=>{if(cut)afterOperations.push('spawnSync');helperCalls++;return spawn(...args);};
  syncBuiltinESMExports();let result,error;
  try {result=store.retainPendingMediaResource(f.cache,f.binding,f.fence,invalid?GIF_B:GIF_A,f.options,{executionBudget:budget});}
  catch(e){error=e;}
  finally{Object.assign(fs,original);Buffer.prototype.equals=equals;cp.spawnSync=spawn;syncBuiltinESMExports();}
  const budgetResult=budget.summary(),current=store.readPendingMediaResource(f.cache,f.binding,f.fence,{nowMs:f.at});
  assert.equal(hit,true,'selected actual boundary reached');assert.equal(helperCalls,1,'real flock helper retained');
  assert(afterOperations.every(name=>name==='closeSync'),'no post-stop work except closing owned fd');
  assert.deepEqual(files(f.cache),before);assert.equal(sha(fs.readFileSync(f.db)),beforeDb);
  assert.equal(current.status,'pending');assert.equal(current.receipt.generation,f.seed.receipt.generation);assert.equal(sha(current.bytes),sha(GIF_A));
  // Inspect the exact old lock inode, even when the path was replaced. This is
  // a separate test-owned nonblocking probe after the invocation has returned.
  const ownedLock=failure==='lock_replaced'?join(f.root,'original-owned-lock'):join(f.cache,'pending-v1','.mutation.lock');
  const release=cp.spawnSync('python3',['-B','-c','import fcntl,sys\nf=open(sys.argv[1],"r+")\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(73)',ownedLock],{encoding:'utf8',timeout:1000});
  assert.equal(release.status,0,'already-owned lock descriptor was released');
  assert.equal(store.retainPendingMediaResource(f.cache,f.binding,f.fence,GIF_A,f.options).status,'pending');
  return {result,error,budget:budgetResult,lockReads,callbackReturned,afterOperations};
}
for(const boundary of ['callback_return','lock_read','directory_read'])for(const invalid of [false,true])for(const stop of ['live','time_budget','clock_unavailable'])test(`returned invalid=${invalid}, ${stop} at ${boundary} stays distinct`,t=>{
  const f=fixture(t),seen=observe(f,{invalid,boundary,stop});
  assert.equal(seen.budget.stop_reason,stop==='live'?null:stop);
  if(invalid){assert.equal(seen.error,undefined);assert.equal(seen.result.status,'invalid');assert.equal(seen.result.reason,'resource_pending_conflict');}
  else if(stop==='live'){assert.equal(seen.error,undefined);assert.equal(seen.result.status,'pending');}
  else {assert(seen.error instanceof HistoryCommandBudgetError);assert.equal(seen.error.reason,stop);assert.equal(seen.result,undefined);}
});
for(const invalid of [false,true])for(const stop of ['time_budget','clock_unavailable'])test(`before callback ${stop} cannot manufacture rejection for invalid=${invalid}`,t=>{
  const seen=observe(fixture(t),{invalid,boundary:'before_callback',stop});
  assert.equal(seen.callbackReturned,false);assert(seen.error instanceof HistoryCommandBudgetError);assert.equal(seen.error.reason,stop);assert.equal(seen.result,undefined);
});
for(const invalid of [false,true])for(const failure of ['EIO','forged_budget','lock_replaced'])test(`non-budget completion ${failure} keeps original store failure for invalid=${invalid}`,t=>{
  const seen=observe(fixture(t),{invalid,boundary:'lock_read',failure});
  assert.equal(seen.budget.stop_reason,null);assert.equal(seen.error,undefined);assert.equal(seen.result.status,'invalid');assert.equal(seen.result.reason,'resource_pending_invalid');
});
