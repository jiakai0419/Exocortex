import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {fixture} from './resource-producer-deadline.fixture.mjs';
import {enrichResources} from '../src/maintenance/enrich-resources.mjs';

// Actual private file descriptors and hardlinks, with only time modeled. This
// tests the producer -> queue report path, including no post-deadline writeback.
for(const invalidLink of [false,true])for(const expire of [false,true]) {
  test(`download fstat rejection survives independent deadline: nlink=${invalidLink?2:1}, expired=${expire}`,t=>{
    const f=fixture(t);f.add('image',['synthetic_validation_cutoff']);f.options.maxSeconds=3;
    let producer,observedLinks=null,cutoffInjected=false,writesAtCutoff=null;
    f.deps.enrichResources=(...args)=>producer=enrichResources(...args);
    const transport=f.deps.requestSessionDeps.spawnSync;
    f.deps.requestSessionDeps.spawnSync=(command,wrapped,options)=>{
      const result=transport(command,wrapped,options),args=wrapped.slice(4);
      if(invalidLink&&args[0]==='api') {
        const name=args[args.indexOf('--output')+1];
        fs.linkSync(join(options.cwd,name),join(options.cwd,'synthetic-owned-second-link'));
      }
      return result;
    };
    const original={openSync:fs.openSync,fstatSync:fs.fstatSync,closeSync:fs.closeSync},fds=new Set();
    fs.openSync=(path,...args)=>{const fd=original.openSync(path,...args);if(String(path).endsWith('/resource-0.bin'))fds.add(fd);return fd;};
    fs.fstatSync=(fd,...args)=>{
      const value=original.fstatSync(fd,...args);
      if(fds.has(fd)&&!cutoffInjected) {
        observedLinks=Number(value.nlink);
        if(expire){writesAtCutoff=f.writes.length;f.tick=4001;cutoffInjected=true;}
      }
      return value;
    };
    fs.closeSync=(fd,...args)=>{fds.delete(fd);return original.closeSync(fd,...args);};
    syncBuiltinESMExports();
    let report;
    try {report=f.run();}finally{Object.assign(fs,original);syncBuiltinESMExports();}
    const expected=invalidLink?'download_file_invalid':expire?'time_budget':null;
    assert.equal(observedLinks,invalidLink?2:1);
    assert.equal(producer.results[0].reason,expected);
    assert.deepEqual(producer.results[0].failure,expected?{stage:'download_validation',reason:expected}:null);
    assert.equal(report.failure?.reason??null,expected);
    assert.equal(report.request_budget.stop_reason,expire?'time_budget':null);
    assert.equal(producer.request_budget.stop_reason,expire?'time_budget':null);
    assert.equal(producer.available,!invalidLink&&!expire?1:0);
    assert.equal(f.calls.length,!invalidLink&&!expire?3:2);
    assert.equal(f.calls.filter(args=>args[0]==='api').length,1);
    assert.equal(fds.size,0,'owned descriptor is closed even after rejection/expiry');
    const task=f.tasks()[0];
    if(expire) {
      assert.equal(f.writes.length,writesAtCutoff,'no result writeback after the original deadline');
      assert.equal(task.state,'running','existing claim recovery remains responsible for an unacknowledged result');
      assert.equal(task.failure_reason,null);
      assert.equal(report.failure.persisted,false);
      assert.equal(producer.results[0].publication_state,undefined);
      assert.equal(producer.results[0].pending_state,undefined);
      assert.equal(fs.existsSync(f.resourceDir),false,'no cache/pending publication after cutoff');
    } else if(invalidLink) {
      assert.equal(report.failure.persisted,true);
      assert.equal(task.failure_reason,'download_file_invalid');
      assert.equal(task.state,'deferred');
    } else {
      assert.equal(task.state,'available');
      assert.equal(producer.results[0].publication_state,'confirmed');
    }
    t.diagnostic(JSON.stringify({invalid_link:invalidLink,expired:expire,nlink:observedLinks,
      failure:report.failure,budget:report.request_budget,scripted_calls:f.calls.length,external_requests:0}));
  });
}

const GIF=Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b','hex');
for(const invalidImage of [false,true])for(const expire of [false,true]) {
  test(`decoded image rejection survives independent deadline: invalid=${invalidImage}, expired=${expire}`,t=>{
    const f=fixture(t);f.add('image',['synthetic_image_cutoff']);f.options.maxSeconds=3;
    const bytes=invalidImage?Buffer.from(GIF.subarray(0,-1)):Buffer.from(GIF);
    let producer,seenHeader=false,writesAtCutoff=null;
    f.deps.enrichResources=(...args)=>producer=enrichResources(...args);
    const transport=f.deps.requestSessionDeps.spawnSync;
    f.deps.requestSessionDeps.spawnSync=(command,wrapped,options)=>{
      const result=transport(command,wrapped,options),args=wrapped.slice(4);
      if(args[0]==='api') {
        const name=args[args.indexOf('--output')+1];fs.writeFileSync(join(options.cwd,name),bytes,{mode:0o600});
        return {...result,stdout:JSON.stringify({saved_path:name,size_bytes:bytes.length,content_type:'image/gif'})};
      }return result;
    };
    const original=Buffer.prototype.toString;
    Buffer.prototype.toString=function(...args){
      const value=original.apply(this,args);
      // Observe the real validator's header read; never change bytes/results.
      if(args[0]==='latin1'&&args[1]===0&&args[2]===6&&this.equals(bytes)) {
        seenHeader=true;
        if(expire){writesAtCutoff??=f.writes.length;f.tick=4001;}
      }
      return value;
    };
    let report;
    try {report=f.run();}finally{Buffer.prototype.toString=original;}
    const expected=invalidImage?'download_image_invalid':expire?'time_budget':null;
    assert.equal(seenHeader,true);
    assert.equal(producer.results[0].reason,expected);
    assert.deepEqual(producer.results[0].failure,expected?{stage:'download_validation',reason:expected}:null);
    assert.equal(report.failure?.reason??null,expected);
    assert.equal(report.request_budget.stop_reason,expire?'time_budget':null);
    assert.equal(producer.request_budget.stop_reason,expire?'time_budget':null);
    assert.equal(producer.available,!invalidImage&&!expire?1:0);
    assert.equal(f.calls.length,!invalidImage&&!expire?3:2);
    assert.equal(f.calls.filter(args=>args[0]==='api').length,1);
    const task=f.tasks()[0];
    if(expire) {
      assert.equal(f.writes.length,writesAtCutoff);
      assert.equal(task.state,'running');assert.equal(task.failure_reason,null);
      assert.equal(report.failure.persisted,false);
      assert.equal(producer.results[0].publication_state,undefined);
      assert.equal(producer.results[0].pending_state,undefined);
      assert.equal(fs.existsSync(f.resourceDir),false);
    } else if(invalidImage) {
      assert.equal(report.failure.persisted,true);assert.equal(task.failure_reason,'download_image_invalid');
    } else assert.equal(task.state,'available');
    t.diagnostic(JSON.stringify({invalid_image:invalidImage,expired:expire,
      failure:report.failure,budget:report.request_budget,scripted_calls:f.calls.length,external_requests:0}));
  });
}
