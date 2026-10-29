import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSharedLarkCooldown, writeSharedLarkCooldown } from '../src/runtime/lark-api-lease.mjs';

const moduleUrl=new URL('../src/runtime/lark-api-lease.mjs',import.meta.url).href;
const operation='message_history_bundle',nowMs=1800000000000;
const payloadFile=file=>fs.lstatSync(file).isDirectory()?join(file,'value.json'):file;
function fixture(t) {
  const directory=fs.mkdtempSync(join(tmpdir(),'exocortex-cooldown-publication-synthetic-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  return {directory};
}
function runChild(directory,untilMs=null,at=nowMs) {
  const source=`import {readSharedLarkCooldown,writeSharedLarkCooldown} from ${JSON.stringify(moduleUrl)};
    const directory=process.argv[1],operation=${JSON.stringify(operation)},nowMs=${at};
    const before=readSharedLarkCooldown({operation,nowMs},{directory});
    const published=${untilMs===null?'null':`writeSharedLarkCooldown({operation,nowMs,untilMs:${untilMs}},{directory})`};
    process.stdout.write(JSON.stringify({before,published,after:readSharedLarkCooldown({operation,nowMs},{directory})}));`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',source,directory],{encoding:'utf8',timeout:5000});
  assert.equal(result.error,undefined,result.error?.message);assert.equal(result.signal,null);
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}
function withPublicationHook(directory,hook,action) {
  const originalLink=fs.linkSync,originalRename=fs.renameSync;
  let invoked=false;
  for(const [key,original] of [['linkSync',originalLink],['renameSync',originalRename]]) fs[key]=function(source,target){
    if(!invoked&&String(source).startsWith(directory)&&String(target).endsWith('.json')) {
      invoked=true;return hook(()=>original(source,target),source,target);
    }
    return original(source,target);
  };
  syncBuiltinESMExports();
  try { const result=action();assert.equal(invoked,true,'actual publication boundary must be reached');return result; }
  finally {fs.linkSync=originalLink;fs.renameSync=originalRename;syncBuiltinESMExports();}
}

test('publication stays single-link and an independent longer reset survives the publication window',t=>{
  const deps=fixture(t);let concurrent,targetLinks;
  const published=withPublicationHook(deps.directory,(publish,source,target)=>{
    publish();targetLinks=fs.lstatSync(payloadFile(target)).nlink;
    concurrent=runChild(deps.directory,nowMs+8000);
  },()=>writeSharedLarkCooldown({operation,nowMs,untilMs:nowMs+1000},deps));
  assert.equal(targetLinks,1,'a normally published final inode must already meet the reader contract');
  assert.equal(concurrent.before.state,'cooldown');assert.equal(concurrent.before.untilMs,nowMs+1000);
  assert.equal(concurrent.published,true,'the longer reset must not be lost to a normal publisher');
  assert.equal(published,true);
  assert.deepEqual(readSharedLarkCooldown({operation,nowMs},deps),{state:'cooldown',untilMs:nowMs+8000});
});

test('a private temporary record is invisible before the atomic publication',t=>{
  const deps=fixture(t);let before;
  assert.equal(writeSharedLarkCooldown({operation,nowMs,untilMs:nowMs+1000},deps),true);
  assert.equal(withPublicationHook(deps.directory,(publish)=>{
    before=runChild(deps.directory);publish();
  },()=>writeSharedLarkCooldown({operation,nowMs,untilMs:nowMs+2000},deps)),true);
  assert.deepEqual(before.before,{state:'cooldown',untilMs:nowMs+1000});
  assert.equal(readSharedLarkCooldown({operation,nowMs},deps).untilMs,nowMs+2000);
});

for(const stage of ['before','after']) test(`publication ${stage}-operation failure cleans temporary files without erasing evidence`,t=>{
  const deps=fixture(t);
  const result=withPublicationHook(deps.directory,(publish)=>{
    if(stage==='after')publish();
    const error=new Error('synthetic publication fault');error.code='EIO';throw error;
  },()=>writeSharedLarkCooldown({operation,nowMs,untilMs:nowMs+1000},deps));
  assert.equal(result,false);
  const names=fs.readdirSync(join(deps.directory,'cooldowns'));
  assert.equal(names.some(name=>name.endsWith('.tmp')),false);
  assert.deepEqual(readSharedLarkCooldown({operation,nowMs},deps),stage==='before'
    ?{state:'ready',untilMs:null}:{state:'cooldown',untilMs:nowMs+1000});
});

test('same-expiry independent publishers all succeed and keep private single-link final records',async t=>{
  const deps=fixture(t);
  const results=await Promise.all(Array.from({length:8},(_,index)=>new Promise(resolve=>{
    const source=`import {writeSharedLarkCooldown} from ${JSON.stringify(moduleUrl)};
      const ok=writeSharedLarkCooldown({operation:${JSON.stringify(operation)},nowMs:${nowMs},untilMs:${nowMs+8000}},{directory:process.argv[1]});
      process.stdout.write(JSON.stringify({ok}));process.exitCode=ok?0:1;`;
    const child=spawn(process.execPath,['--input-type=module','-e',source,deps.directory]);
    let stdout='',stderr='',error=null;
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
    child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
    child.on('error',e=>error={name:e.name,message:e.message,code:e.code});
    child.on('close',(status,signal)=>{clearTimeout(timer);resolve({index,status,signal,error,stdout,stderr});});
  })));
  assert(results.every(result=>result.status===0&&!result.signal&&!result.error),JSON.stringify(results));
  assert.equal(readSharedLarkCooldown({operation,nowMs},deps).untilMs,nowMs+8000);
  const names=fs.readdirSync(join(deps.directory,'cooldowns'));
  assert.equal(names.length,1,'same-expiry publications occupy one immutable final entry');
  for(const name of names) {
    const info=fs.lstatSync(payloadFile(join(deps.directory,'cooldowns',name)));
    assert.equal(info.nlink,1);assert.equal(info.mode&0o777,0o600);assert.equal(info.isFile(),true);
  }
});

test('legacy reset evidence remains readable and is never replaced by a shorter publication',t=>{
  const deps=fixture(t),dir=join(deps.directory,'cooldowns');fs.mkdirSync(dir,{mode:0o700});
  const file=join(dir,`${operation}-${nowMs+9000}.json`);
  fs.writeFileSync(file,JSON.stringify({version:1,operation,untilMs:nowMs+9000}),{mode:0o600});
  const before=fs.lstatSync(file);
  assert.equal(writeSharedLarkCooldown({operation,nowMs,untilMs:nowMs+1000},deps),true);
  assert.equal(readSharedLarkCooldown({operation,nowMs},deps).untilMs,nowMs+9000);
  const after=fs.lstatSync(file);assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);
});

test('repeated equal and shorter resets do not spend the immutable-record capacity',t=>{
  const deps=fixture(t);
  assert.equal(writeSharedLarkCooldown({operation,nowMs,untilMs:nowMs+9000},deps),true);
  const dir=join(deps.directory,'cooldowns'),initial=fs.readdirSync(dir);
  for(let index=0;index<140;index++) {
    assert.equal(writeSharedLarkCooldown({operation,nowMs,untilMs:nowMs+(index%2?9000:1000)},deps),true);
  }
  assert.deepEqual(fs.readdirSync(dir),initial);
  assert.equal(readSharedLarkCooldown({operation,nowMs},deps).untilMs,nowMs+9000);
});

test('expired legacy and directory records are both pruned without deleting an active longer reset',t=>{
  const deps=fixture(t),dir=join(deps.directory,'cooldowns');
  assert.equal(writeSharedLarkCooldown({operation,nowMs,untilMs:nowMs+1},deps),true);
  fs.writeFileSync(join(dir,`other-${nowMs+1}.json`),JSON.stringify({version:1,operation:'other',untilMs:nowMs+1}),{mode:0o600});
  assert.equal(writeSharedLarkCooldown({operation,nowMs:nowMs+1,untilMs:nowMs+9000},deps),true);
  assert.equal(fs.readdirSync(dir).length,1);
  assert.equal(readSharedLarkCooldown({operation,nowMs:nowMs+1},deps).untilMs,nowMs+9000);
});

for(const kind of ['hardlink','symlink','permissions','malformed_name']) test(`published evidence still rejects ${kind}`,t=>{
  const deps=fixture(t);
  assert.equal(writeSharedLarkCooldown({operation,nowMs,untilMs:nowMs+1000},deps),true);
  const dir=join(deps.directory,'cooldowns'),entry=join(dir,fs.readdirSync(dir)[0]),file=payloadFile(entry);
  if(kind==='hardlink')fs.linkSync(file,join(deps.directory,'synthetic-alias'));
  if(kind==='symlink'){fs.renameSync(file,join(deps.directory,'synthetic-original'));fs.symlinkSync(join(deps.directory,'synthetic-original'),file);}
  if(kind==='permissions')fs.chmodSync(file,0o644);
  if(kind==='malformed_name')fs.renameSync(entry,join(dir,`${operation}-${nowMs+1000}-untrusted.json`));
  assert.equal(readSharedLarkCooldown({operation,nowMs},deps).state,'unavailable');
  assert.equal(writeSharedLarkCooldown({operation,nowMs,untilMs:nowMs+9000},deps),false);
});

for(const kind of ['directory_symlink','directory_permissions','extra_child','missing_payload']) test(`directory record rejects ${kind}`,t=>{
  const deps=fixture(t);
  assert.equal(writeSharedLarkCooldown({operation,nowMs,untilMs:nowMs+1000},deps),true);
  const dir=join(deps.directory,'cooldowns'),entry=join(dir,fs.readdirSync(dir)[0]);
  assert.equal(fs.lstatSync(entry).isDirectory(),true);
  if(kind==='directory_symlink'){const moved=join(deps.directory,'synthetic-original');fs.renameSync(entry,moved);fs.symlinkSync(moved,entry);}
  if(kind==='directory_permissions')fs.chmodSync(entry,0o755);
  if(kind==='extra_child')fs.writeFileSync(join(entry,'unexpected.json'),'{}',{mode:0o600});
  if(kind==='missing_payload')fs.unlinkSync(join(entry,'value.json'));
  assert.equal(readSharedLarkCooldown({operation,nowMs},deps).state,'unavailable');
  assert.equal(writeSharedLarkCooldown({operation,nowMs,untilMs:nowMs+9000},deps),false);
});

test('an independent reader sees no public half-deleted expired directory',t=>{
  const deps=fixture(t),dir=join(deps.directory,'cooldowns');
  assert.equal(writeSharedLarkCooldown({operation,nowMs,untilMs:nowMs+1},deps),true);
  fs.writeFileSync(join(dir,`other-${nowMs+5000}.json`),JSON.stringify({version:1,operation:'other',untilMs:nowMs+5000}),{mode:0o600});
  const original=fs.renameSync;let during;
  fs.renameSync=(source,target)=>{
    original(source,target);
    if(String(source).startsWith(dir)&&String(source).endsWith('.json')&&String(target).endsWith('.tmp'))
      during=runChild(deps.directory,null,nowMs+1);
  };
  syncBuiltinESMExports();
  try {assert.equal(writeSharedLarkCooldown({operation,nowMs:nowMs+1,untilMs:nowMs+9000},deps),true);}
  finally {fs.renameSync=original;syncBuiltinESMExports();}
  assert.deepEqual(during.before,{state:'cooldown',untilMs:nowMs+5000});
  assert.equal(readSharedLarkCooldown({operation,nowMs:nowMs+1},deps).untilMs,nowMs+9000);
  assert.equal(fs.readdirSync(dir).some(name=>name.endsWith('.tmp')),false);
});

test('a legacy file published at the same expiry cannot be overwritten by the directory publisher',t=>{
  const deps=fixture(t);let targetFile;
  const payload=JSON.stringify({version:1,operation,untilMs:nowMs+8000});
  assert.equal(withPublicationHook(deps.directory,(publish,source,target)=>{
    targetFile=target;fs.writeFileSync(target,payload,{flag:'wx',mode:0o600});publish();
  },()=>writeSharedLarkCooldown({operation,nowMs,untilMs:nowMs+8000},deps)),true);
  assert.equal(fs.lstatSync(targetFile).isFile(),true);
  assert.equal(fs.readFileSync(targetFile,'utf8'),payload);
  assert.equal(fs.readdirSync(join(deps.directory,'cooldowns')).length,1);
});

test('simultaneous same-expiry publishers at the record cap add only one final entry',async t=>{
  const deps=fixture(t),dir=join(deps.directory,'cooldowns'),barrier=join(deps.directory,'barrier');
  fs.mkdirSync(dir,{mode:0o700});fs.mkdirSync(barrier,{mode:0o700});
  for(let index=1;index<=127;index++)fs.writeFileSync(join(dir,`${operation}-${nowMs+index}.json`),
    JSON.stringify({version:1,operation,untilMs:nowMs+index}),{mode:0o600});
  const children=[],results=Array.from({length:8},(_,index)=>new Promise(resolve=>{
    const source=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      import {join} from 'node:path';import {writeSharedLarkCooldown} from ${JSON.stringify(moduleUrl)};
      const directory=process.argv[1],barrier=process.argv[2],index=process.argv[3];
      for(const key of ['linkSync','renameSync']){const original=fs[key];fs[key]=(source,target)=>{
        if(String(source).startsWith(directory)&&String(target).endsWith('.json')){
          fs.writeFileSync(join(barrier,index),'ready');const start=performance.now();
          while(!fs.existsSync(join(barrier,'release'))){if(performance.now()-start>5000)throw new Error('synthetic barrier timeout');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}
        }return original(source,target);};}syncBuiltinESMExports();
      const ok=writeSharedLarkCooldown({operation:${JSON.stringify(operation)},nowMs:${nowMs},untilMs:${nowMs+8000}},{directory});
      process.stdout.write(JSON.stringify({ok}));process.exitCode=ok?0:1;`;
    const child=spawn(process.execPath,['--input-type=module','-e',source,deps.directory,barrier,String(index)]);
    children.push(child);let stdout='',stderr='',error=null;
    const timer=setTimeout(()=>child.kill('SIGKILL'),6000);
    child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);
    child.on('error',e=>error={name:e.name,message:e.message,code:e.code});
    child.on('close',(status,signal)=>{clearTimeout(timer);resolve({index,status,signal,error,stdout,stderr});});
  }));
  const start=performance.now();let ready;
  try {
    while((ready=fs.readdirSync(barrier).length)<8&&performance.now()-start<5000)await new Promise(resolve=>setTimeout(resolve,5));
  } finally {fs.writeFileSync(join(barrier,'release'),'release');}
  const finished=await Promise.all(results);
  assert.equal(ready,8,JSON.stringify(finished));
  assert(finished.every(result=>result.status===0&&!result.signal&&!result.error),JSON.stringify(finished));
  assert.equal(fs.readdirSync(dir).length,128);
  assert.equal(readSharedLarkCooldown({operation,nowMs},deps).untilMs,nowMs+8000);
});

test('a temporary-directory collision does not clean a directory this writer did not create',t=>{
  const deps=fixture(t),original=fs.mkdirSync;let collision;
  fs.mkdirSync=(directory,options)=>{
    if(!collision&&String(directory).startsWith(deps.directory)&&String(directory).endsWith('.tmp')) {
      collision=directory;original(directory,{mode:0o700});
      fs.writeFileSync(join(directory,'value.json'),'synthetic existing owner',{mode:0o600});
    }
    return original(directory,options);
  };
  syncBuiltinESMExports();
  try {assert.equal(writeSharedLarkCooldown({operation,nowMs,untilMs:nowMs+1000},deps),false);}
  finally {fs.mkdirSync=original;syncBuiltinESMExports();}
  assert(collision);assert.equal(fs.readFileSync(join(collision,'value.json'),'utf8'),'synthetic existing owner');
});

test('failure cleanup does not follow a substituted temporary-directory symlink',t=>{
  const deps=fixture(t),outside=join(deps.directory,'synthetic-outside'),held=join(deps.directory,'held-original');
  fs.mkdirSync(outside,{mode:0o700});fs.writeFileSync(join(outside,'value.json'),'synthetic outside owner',{mode:0o600});
  let staged;
  assert.equal(withPublicationHook(deps.directory,(publish,source)=>{
    staged=source;fs.renameSync(source,held);fs.symlinkSync(outside,source);
    throw new Error('synthetic pre-publication failure after path replacement');
  },()=>writeSharedLarkCooldown({operation,nowMs,untilMs:nowMs+1000},deps)),false);
  assert.equal(fs.readFileSync(join(outside,'value.json'),'utf8'),'synthetic outside owner');
  assert.equal(fs.lstatSync(staged).isSymbolicLink(),true);
  assert.equal(fs.lstatSync(held).isDirectory(),true);
});
