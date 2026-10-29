import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {chmodSync,existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {makeMediaResourceBinding,makeMediaPendingSourceFence,readMediaResource,readPendingMediaResource,
  retainPendingMediaResource,discardPendingMediaResource,reclaimPendingMediaResources,MEDIA_PENDING_TTL_MS,MAX_PENDING_MEDIA_RESOURCES} from '../src/adapters/lark-im/media-resource-store.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const GIF=Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b','hex');
const AT=Date.UTC(2026,0,2),ACCOUNT=sha('synthetic pending owner');
function setup(t){
  const root=mkdtempSync(join(tmpdir(),'synthetic-media-pending-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const db=join(root,'fake.db');writeFileSync(db,'synthetic database placeholder',{mode:0o600});
  const raw_json=JSON.stringify({message_id:'om_pending_synthetic',chat_id:'oc_pending_synthetic',msg_type:'image',body:{content:'{"image_key":"img_pending_synthetic"}'}});
  const row={id:1,source_id:'lark.im',record_type:'lark.im.message',external_id:'om_pending_synthetic',external_version:'synthetic-v1',
    content_hash:sha(raw_json),raw_json,canonical_json:'{}',actor_id:'ou_synthetic',container_id:'oc_pending_synthetic',direction:'sent',occurred_at:'2026-01-02T00:00:00.000Z',occurred_at_ms:AT,body:'Synthetic fallback'};
  const binding=makeMediaResourceBinding(db,row,ACCOUNT,{type:'image',resource:{kind:'image_key',key:'img_pending_synthetic',state:'reference_only'}});
  const cache=join(root,'resources'),fence=makeMediaPendingSourceFence(row);
  return{root,db,row,binding,cache,fence};
}
const retain=(f,opts={})=>retainPendingMediaResource(f.cache,f.binding,f.fence,GIF,{nowMs:AT+20,openingAtMs:AT,originalClosingAtMs:AT+10,stopReason:'sync_busy',...opts});
const read=(f,opts={})=>readPendingMediaResource(f.cache,f.binding,f.fence,{nowMs:AT+30,...opts});
const slot=f=>join(f.cache,'pending-v1','slot-00');

test('pending is separately bound and never visible to the ordinary available reader',t=>{
  const f=setup(t),before=readFileSync(f.db);assert.equal(read(f).status,'missing');assert(!existsSync(f.cache));
  const saved=retain(f);assert.equal(saved.status,'pending');assert.deepEqual(saved.bytes,GIF);
  assert.equal(readMediaResource(f.cache,f.binding).status,'missing');assert.deepEqual(readFileSync(f.db),before);
  assert.equal(saved.opening_at_ms,AT);assert.equal(saved.original_closing_at_ms,AT+10);
  const again=retain(f,{nowMs:AT+100});assert.equal(again.expires_at_ms,saved.expires_at_ms);
  assert.equal(discardPendingMediaResource(f.cache,saved.receipt).status,'removed');assert.equal(read(f).status,'missing');
});
test('closing-unverified is immutable quarantine, never upgraded by later observations',t=>{
  const f=setup(t),saved=retain(f,{originalClosingAtMs:null});assert.equal(saved.status,'quarantined');
  assert.equal(retain(f,{nowMs:AT+100,originalClosingAtMs:AT+99}).status,'quarantined');
  assert.equal(readMediaResource(f.cache,f.binding).status,'missing');
});
for(const stopReason of ['permission_denied','unknown','cooldown','lease_evidence_unavailable','profile_unverified','account_changed','download_file_invalid'])test(`no retention for ${stopReason}`,t=>{
  const f=setup(t);assert.equal(retain(f,{stopReason}).status,'invalid');assert(!existsSync(f.cache));
});
for(const stopReason of ['sync_busy','cli_budget','self_budget','time_budget'])test(`bounded local ${stopReason} retains evidence`,t=>assert.equal(retain(setup(t),{stopReason}).status,'pending'));
for(const [field,value] of [['id',2],['source_id','other'],['external_version','v2'],['canonical_json','{"different":true}'],['body','other'],['actor_id','different'],['occurred_at_ms',AT+1]])test(`exact source fence includes ${field}`,t=>{
  const f=setup(t);retain(f);assert.equal(readPendingMediaResource(f.cache,f.binding,makeMediaPendingSourceFence({...f.row,[field]:value}),{nowMs:AT+30}).status,'missing');
});
test('wrong account/key/version/database cannot borrow pending bytes',t=>{
  const f=setup(t);retain(f);
  for(const changes of [{account_key:sha('other')},{key:'other'},{external_version:'v2'}])assert.equal(readPendingMediaResource(f.cache,{...f.binding,...changes},f.fence,{nowMs:AT+30}).status,'missing');
  renameSync(f.db,f.db+'.old');writeFileSync(f.db,'different synthetic database');assert.equal(read(f).status,'invalid');
});
for(const kind of ['modified','missing','symlink','hardlink','public mode','manifest','directory'])test(`pending fails closed for ${kind}`,t=>{
  const f=setup(t);retain(f);const blob=join(slot(f),'payload.blob');
  if(kind==='modified')writeFileSync(blob,'different bytes');
  if(kind==='missing')rmSync(blob);
  if(kind==='symlink'){rmSync(blob);symlinkSync(f.db,blob);}
  if(kind==='hardlink')linkSync(blob,join(f.root,'extra-link'));
  if(kind==='public mode')chmodSync(blob,0o644);
  if(kind==='manifest')writeFileSync(join(slot(f),'manifest.json'),'{}');
  if(kind==='directory')chmodSync(slot(f),0o755);
  assert.equal(read(f).status,'invalid');assert.equal(retain(f).status,'invalid');
});
test('read detects replacement during verification',t=>{
  const f=setup(t);retain(f);
  const result=readPendingMediaResource(f.cache,f.binding,f.fence,{nowMs:AT+30},{afterBlobRead(){const p=join(slot(f),'payload.blob');renameSync(p,p+'.old');writeFileSync(p,GIF,{mode:0o600});}});
  assert.equal(result.status,'invalid');
});
test('expiry is fixed, reads never collect, apply reclaims and stale receipt cannot delete a replacement',t=>{
  const f=setup(t),first=retain(f),expires=first.expires_at_ms;
  assert.equal(read(f,{nowMs:expires}).status,'missing');assert(existsSync(slot(f)));
  const next=retain(f,{nowMs:expires,openingAtMs:expires-20,originalClosingAtMs:expires-10});assert.equal(next.status,'pending');
  assert.notEqual(next.receipt.generation,first.receipt.generation);
  assert.equal(discardPendingMediaResource(f.cache,first.receipt).status,'invalid');
  assert.equal(read(f,{nowMs:expires+1}).status,'pending');
});
test('twenty live entries bound capacity; expired complete and partial reservations can be reclaimed',t=>{
  const f=setup(t);for(let i=0;i<MAX_PENDING_MEDIA_RESOURCES;i++)assert.equal(retain({...f,fence:sha(String(i))}).status,'pending');
  assert.equal(retain(f).reason,'resource_pending_capacity');
  assert.equal(readdirSync(join(f.cache,'pending-v1')).filter(name=>name.startsWith('slot-')).length,20);
  rmSync(join(slot(f),'manifest.json')); // completed claim + blob, interrupted manifest publication
  const later=AT+20+MEDIA_PENDING_TTL_MS;assert.equal(retain(f,{nowMs:later,openingAtMs:later-2,originalClosingAtMs:later-1}).status,'pending');
  assert.equal(readdirSync(join(f.cache,'pending-v1')).filter(name=>name.startsWith('slot-')).length,1);
});
test('invalid time and invalid/oversize pixels create no cache',t=>{
  const f=setup(t);for(const options of [{nowMs:NaN},{openingAtMs:AT+30},{originalClosingAtMs:AT-1}])assert.equal(retain(f,options).status,'invalid');
  for(const bytes of [Buffer.alloc(16*1024*1024+1),Buffer.from('invalid image')])assert.equal(retainPendingMediaResource(f.cache,f.binding,f.fence,bytes,{nowMs:AT,openingAtMs:AT,originalClosingAtMs:AT,stopReason:'sync_busy'}).status,'invalid');
  assert(!existsSync(f.cache));
});
test('private local mutation contention returns immediately; process death releases it without stale-lock deletion',async t=>{
  const f=setup(t);retain(f);const lock=join(f.cache,'pending-v1','.mutation.lock');
  const child=spawn('python3',['-B','-c','import fcntl,sys,time\nf=open(sys.argv[1],"r+")\nfcntl.flock(f,fcntl.LOCK_EX)\nprint("locked",flush=True)\ntime.sleep(10)',lock],{stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill('SIGKILL'));await once(child.stdout,'data');
  const started=Date.now();assert.equal(retain({...f,fence:sha('new')}).reason,'resource_pending_busy');assert(Date.now()-started<1500);
  const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;
  assert.equal(retain({...f,fence:sha('new')}).status,'pending');assert(existsSync(lock));
});


for(const target of ['directory','claim','payload'])test(`expired cleanup preserves concurrent replacement of ${target}`,t=>{
  const f=setup(t),first=retain(f),at=first.expires_at_ms;
  const outcome=reclaimPendingMediaResources(f.cache,{nowMs:at},{beforeReclaim(){
    if(target==='directory'){renameSync(slot(f),slot(f)+'.saved');mkdirSync(slot(f),{mode:0o700});writeFileSync(join(slot(f),'claim.json'),'replacement',{mode:0o600});}
    else {const path=join(slot(f),target==='claim'?'claim.json':'payload.blob');renameSync(path,join(f.root,target+'.saved'));writeFileSync(path,'replacement',{mode:0o600});}
  }});
  assert.equal(outcome.status,'invalid');assert(existsSync(slot(f)));
  assert.equal(readFileSync(join(slot(f),target==='payload'?'payload.blob':'claim.json'),'utf8'),'replacement');
});
test('fresh bytes plus original closing may create a new generation, later self alone may not',t=>{
  const f=setup(t),old=retain(f,{originalClosingAtMs:null});
  assert.equal(retain(f,{nowMs:AT+100,originalClosingAtMs:AT+99}).status,'quarantined');
  const next=retain(f,{nowMs:AT+100,openingAtMs:AT+80,originalClosingAtMs:AT+99,freshDownload:true});
  assert.equal(next.status,'pending');assert.notEqual(next.receipt.generation,old.receipt.generation);
  assert.equal(discardPendingMediaResource(f.cache,old.receipt).status,'invalid');
});
for(const phase of ['claim','payload','manifest'])test(`SIGKILL during pending ${phase} exclusive write remains unavailable and reclaimable`,t=>{
  const f=setup(t),at=Date.now(),module=new URL('../src/adapters/lark-im/media-resource-store.mjs',import.meta.url).href;
  const program=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {retainPendingMediaResource} from ${JSON.stringify(module)};
const [config,phase]=process.argv.slice(1),f=JSON.parse(config),original=fs.writeFileSync;
fs.writeFileSync=function(fd,bytes,...args){const selected=Buffer.isBuffer(bytes)&&(phase==='payload'?bytes.toString('hex')===f.gif:bytes.includes(Buffer.from(phase==='claim'?'lark_media_pending_claim/v1':'lark_media_pending/v1')));
if(selected){original(fd,bytes.subarray(0,Math.max(1,Math.floor(bytes.length/2))),...args);process.kill(process.pid,'SIGKILL');}return original(fd,bytes,...args);};syncBuiltinESMExports();
retainPendingMediaResource(f.cache,f.binding,f.fence,Buffer.from(f.gif,'hex'),{nowMs:f.at,openingAtMs:f.at,originalClosingAtMs:f.at,stopReason:'sync_busy'});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',program,JSON.stringify({...f,at,gif:GIF.toString('hex')}),phase],{encoding:'utf8',timeout:5000});
  assert.equal(child.signal,'SIGKILL',child.stderr);assert.equal(readMediaResource(f.cache,f.binding).status,'missing');
  const later=at+MEDIA_PENDING_TTL_MS+2000;
  assert.equal(reclaimPendingMediaResources(f.cache,{nowMs:later}).status,'ready');
  assert.equal(retain(f,{nowMs:later,openingAtMs:later,originalClosingAtMs:later}).status,'pending');
});
test('concurrent processes cannot admit more than the twentieth private slot',async t=>{
  const f=setup(t);for(let i=0;i<19;i++)assert.equal(retain({...f,fence:sha(String(i))}).status,'pending');
  const module=new URL('../src/adapters/lark-im/media-resource-store.mjs',import.meta.url).href;
  const program=`import {retainPendingMediaResource} from ${JSON.stringify(module)};const f=JSON.parse(process.argv[1]);console.log(JSON.stringify(retainPendingMediaResource(f.cache,f.binding,f.fence,Buffer.from(f.gif,'hex'),f.options)));`;
  const results=await Promise.all(Array.from({length:8},(_,i)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',program,JSON.stringify({...f,fence:sha('race-'+i),gif:GIF.toString('hex'),options:{nowMs:AT+20,openingAtMs:AT,originalClosingAtMs:AT+10,stopReason:'sync_busy'}})],{stdio:['ignore','pipe','pipe']});
    let output='',error='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>error+=x);child.on('error',reject);
    child.on('exit',code=>code===0?resolve(JSON.parse(output)):reject(new Error(error)));
  })));
  assert.equal(results.filter(x=>x.status==='pending').length,1);
  assert(results.filter(x=>x.status!=='pending').every(x=>['resource_pending_busy','resource_pending_capacity'].includes(x.reason)));
  assert.equal(readdirSync(join(f.cache,'pending-v1')).filter(x=>x.startsWith('slot-')).length,20);
});
