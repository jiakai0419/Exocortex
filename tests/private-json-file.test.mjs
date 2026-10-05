import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readStableJsonFile } from '../src/diagnostics/private-json-file.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'exo-private-json-synthetic-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'evidence.json');
  writeFileSync(path,'{"synthetic":true}',{mode:0o600});
  return {root,path};
}

test('private JSON rejects open permissions, hardlinks, symlinks, oversize and missing distinctly',t=>{
  const {root,path}=fixture(t);
  assert.equal(readStableJsonFile(path).status,'ready');
  assert.equal(readStableJsonFile(join(root,'missing')).status,'missing');
  assert.equal(readStableJsonFile(path,{maxBytes:1}).status,'invalid');
  chmodSync(path,0o666);assert.equal(readStableJsonFile(path).status,'invalid');
  assert.equal(readStableJsonFile(path,{requirePrivate:false}).private,false);
  chmodSync(path,0o600);linkSync(path,join(root,'hardlink'));assert.equal(readStableJsonFile(path).status,'invalid');
  rmSync(join(root,'hardlink'));symlinkSync(path,join(root,'symlink'));assert.equal(readStableJsonFile(join(root,'symlink')).status,'invalid');
});

test('private JSON rejects in-place mutation and path replacement during a descriptor read',t=>{
  for(const replace of [false,true]) {
    const {path}=fixture(t);
    assert.equal(readStableJsonFile(path,{}, {afterRead(){
      if(replace) renameSync(path,`${path}.old`);
      writeFileSync(path,'{"synthetic":false}',{mode:0o600});
    }}).status,'invalid');
  }
});

test('a FIFO evidence path returns invalid within an isolated two-second process bound',t=>{
  const {root}=fixture(t), path=join(root,'fifo');
  assert.equal(spawnSync('mkfifo',[path]).status,0);
  const moduleUrl=new URL('../src/diagnostics/private-json-file.mjs',import.meta.url).href;
  const run=spawnSync(process.execPath,['--input-type=module','-e',`import {readStableJsonFile} from ${JSON.stringify(moduleUrl)}; process.stdout.write(readStableJsonFile(process.argv[1]).status);`,path],{encoding:'utf8',timeout:2000});
  assert.equal(run.error,undefined);assert.equal(run.status,0);assert.equal(run.stdout,'invalid');
});
