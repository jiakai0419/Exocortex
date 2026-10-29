import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSharedLarkCooldown, writeSharedLarkCooldown } from '../src/runtime/lark-api-lease.mjs';

const operation='application_info',nowMs=1800000000000;
const payload='value.json',sentinel='synthetic other owner';
function fixture(t,lane) {
  const directory=fs.mkdtempSync(join(tmpdir(),'exocortex-owned-cooldown-synthetic-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const deps={directory};
  if(lane==='retire')assert.equal(writeSharedLarkCooldown({operation,nowMs,untilMs:nowMs+1},deps),true);
  assert.equal(writeSharedLarkCooldown({operation:'other',nowMs,untilMs:nowMs+7000},deps),true);
  return {directory,store:join(directory,'cooldowns'),deps,lane,at:lane==='retire'?nowMs+1:nowMs};
}
function targetBoundary(f,source,target) {
  if(!String(source).startsWith(f.store)||!String(target).startsWith(f.store))return false;
  return f.lane==='writer'?String(source).endsWith('.tmp')&&String(target).endsWith('.json')
    :String(source).endsWith('.json')&&String(target).endsWith('.tmp');
}
function faultAtBoundary(f,timing,mutate=()=>{}) {
  const original=fs.renameSync;let observed;
  fs.renameSync=(source,target)=>{
    if(!observed&&targetBoundary(f,source,target)) {
      observed={source,target};
      if(timing==='after')original(source,target);
      const ownedPath=f.lane==='writer'?source:target;
      // Writer after-publication faults operate on no temporary path. Mutation
      // scenarios use writer-before or retirement before/after intentionally.
      observed.details=mutate(ownedPath,original,observed);
      const error=new Error('synthetic bounded rename fault');error.code='EIO';throw error;
    }
    return original(source,target);
  };
  syncBuiltinESMExports();let result;
  try {result=writeSharedLarkCooldown({operation,nowMs:f.at,untilMs:nowMs+9000},f.deps);}
  finally {fs.renameSync=original;syncBuiltinESMExports();}
  assert(observed,'the actual product rename boundary must be reached');
  assert.equal(result,false);
  return observed;
}
function assertExistingMaximum(f) {
  assert.deepEqual(readSharedLarkCooldown({operation,nowMs:f.at},f.deps),{state:'cooldown',untilMs:nowMs+7000});
}
const mutations={
  directory(f,path,rename){
    const original=fs.lstatSync(path),held=join(f.directory,'held-original-directory');
    rename(path,held);fs.mkdirSync(path,{mode:0o700});
    fs.writeFileSync(join(path,payload),sentinel,{mode:0o600});
    const replacement=fs.lstatSync(path);assert.notEqual(replacement.ino,original.ino);
    return ()=>{assert.equal(fs.readFileSync(join(path,payload),'utf8'),sentinel);assert.equal(fs.lstatSync(path).ino,replacement.ino);assert.equal(fs.lstatSync(held).ino,original.ino);};
  },
  payload(f,path,rename){
    const file=join(path,payload),original=fs.lstatSync(file),held=join(f.directory,'held-original-payload');
    rename(file,held);fs.writeFileSync(file,sentinel,{mode:0o600});
    const replacement=fs.lstatSync(file);assert.notEqual(replacement.ino,original.ino);
    return ()=>{assert.equal(fs.readFileSync(file,'utf8'),sentinel);assert.equal(fs.lstatSync(file).ino,replacement.ino);assert.equal(fs.lstatSync(held).ino,original.ino);};
  },
  injected_payload(f,path){
    assert.deepEqual(fs.readdirSync(path),[]);fs.writeFileSync(join(path,payload),sentinel,{mode:0o600});
    const replacement=fs.lstatSync(join(path,payload));
    return ()=>{assert.equal(fs.readFileSync(join(path,payload),'utf8'),sentinel);assert.equal(fs.lstatSync(join(path,payload)).ino,replacement.ino);};
  },
  symlink(f,path,rename){
    const held=join(f.directory,'held-original-directory'),outside=join(f.directory,'synthetic-outside');
    rename(path,held);fs.mkdirSync(outside,{mode:0o700});fs.writeFileSync(join(outside,payload),sentinel,{mode:0o600});fs.symlinkSync(outside,path);
    return ()=>{assert.equal(fs.readFileSync(join(outside,payload),'utf8'),sentinel);assert.equal(fs.lstatSync(path).isSymbolicLink(),true);assert.equal(fs.lstatSync(held).isDirectory(),true);};
  },
  unknown(f,path){
    const file=join(path,payload),before=fs.existsSync(file)?fs.readFileSync(file):null;
    const unknown=join(path,'unexpected-owner.json');fs.writeFileSync(unknown,sentinel,{mode:0o600});
    return ()=>{assert.equal(fs.readFileSync(unknown,'utf8'),sentinel);assert.equal(fs.lstatSync(path).isDirectory(),true);if(before)assert.deepEqual(fs.readFileSync(file),before,'an unknown child blocks the entire cleanup');};
  },
};

for(const kind of ['directory','payload','symlink','unknown'])test(`writer error cleanup preserves a ${kind} substitution`,t=>{
  const f=fixture(t,'writer');
  const observed=faultAtBoundary(f,'before',(path,rename)=>mutations[kind](f,path,rename));
  observed.details();assertExistingMaximum(f);
});

for(const timing of ['before','after'])for(const kind of ['directory',timing==='before'?'injected_payload':'payload','symlink','unknown'])
test(`retirement ${timing}-rename cleanup preserves a ${kind} substitution`,t=>{
  const f=fixture(t,'retire');
  const observed=faultAtBoundary(f,timing,(path,rename)=>mutations[kind](f,path,rename));
  observed.details();assertExistingMaximum(f);
});

for(const lane of ['writer','retire'])for(const timing of ['before','after'])
test(`${lane} ${timing}-rename fault cleans only its own temporary objects`,t=>{
  const f=fixture(t,lane);
  const observed=faultAtBoundary(f,timing);
  assert.equal(fs.readdirSync(f.store).some(name=>name.endsWith('.tmp')),false);
  const expected=lane==='writer'&&timing==='after'?nowMs+9000:nowMs+7000;
  assert.deepEqual(readSharedLarkCooldown({operation,nowMs:f.at},f.deps),{state:'cooldown',untilMs:expected});
  if(lane==='writer'&&timing==='after')assert.equal(fs.lstatSync(observed.target).isDirectory(),true,'published evidence must remain');
  if(lane==='retire')assert.equal(fs.existsSync(observed.source),timing==='before','only an executed retirement moves the source');
});

test('retirement destination creation collision does not acquire or clean that directory',t=>{
  const f=fixture(t,'retire'),original=fs.mkdirSync;let collision;
  fs.mkdirSync=(directory,options)=>{
    if(!collision&&String(directory).startsWith(f.store)&&String(directory).endsWith('.tmp')) {
      collision=directory;original(directory,{mode:0o700});fs.writeFileSync(join(directory,payload),sentinel,{mode:0o600});
    }
    return original(directory,options);
  };
  syncBuiltinESMExports();let result;
  try {result=writeSharedLarkCooldown({operation,nowMs:f.at,untilMs:nowMs+9000},f.deps);}
  finally {fs.mkdirSync=original;syncBuiltinESMExports();}
  assert(collision);assert.equal(result,false);assert.equal(fs.readFileSync(join(collision,payload),'utf8'),sentinel);assertExistingMaximum(f);
});

for(const lane of ['writer','retire'])test(`${lane} cleanup rechecks directory identity before removing an emptied directory`,t=>{
  const f=fixture(t,lane),originalUnlink=fs.unlinkSync,originalRename=fs.renameSync;
  let staged,swapped=false,replacementInode;
  fs.renameSync=(source,target)=>{
    if(!staged&&targetBoundary(f,source,target)) {
      if(lane==='retire')originalRename(source,target);
      staged=lane==='writer'?source:target;
      const error=new Error('synthetic cleanup trigger');error.code='EIO';throw error;
    }
    return originalRename(source,target);
  };
  fs.unlinkSync=file=>{
    const result=originalUnlink(file);
    if(!swapped&&staged&&file===join(staged,payload)) {
      swapped=true;originalRename(staged,join(f.directory,'held-emptied-owner'));fs.mkdirSync(staged,{mode:0o700});replacementInode=fs.lstatSync(staged).ino;
    }
    return result;
  };
  syncBuiltinESMExports();let result;
  try {result=writeSharedLarkCooldown({operation,nowMs:f.at,untilMs:nowMs+9000},f.deps);}
  finally {fs.renameSync=originalRename;fs.unlinkSync=originalUnlink;syncBuiltinESMExports();}
  assert.equal(result,false);assert.equal(swapped,true,'the owned payload cleanup path must execute');
  assert.equal(fs.lstatSync(staged).ino,replacementInode,'the replacement empty directory must survive');
  assertExistingMaximum(f);
});
