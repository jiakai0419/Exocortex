import assert from 'node:assert/strict';
import test from 'node:test';
import cp from 'node:child_process';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensureInitialized,INITIAL_ACCOUNT_KIND,quoteSql as q,sqliteExec,sqliteQuery} from '../dist/storage/sqlite/ingestion-store.js';
import {syncReadiness} from '../src/diagnostics/message-readiness-sync.mjs';
import {executeMessages,renderMessagesText} from '../src/cli/messages-command.mjs';
import {normalizeReadinessObservation} from '../src/diagnostics/readiness-observer-result.mjs';
import {makeMediaResourceBinding,publishMediaResource,readMediaResource,resourceStorePath} from '../src/adapters/lark-im/media-resource-store.mjs';
import {createHistoryCommandBudget,HistoryCommandBudgetError} from '../src/maintenance/history-command-budget.mjs';
import {getLarkApiLeaseStdio,tryAcquireLarkApiLease} from '../src/runtime/lark-api-lease.mjs';

// Authored records and one-pixel JPEG bytes only. The actual observer, SQLite,
// private lease, cached resource verification and native helper run locally.
// Faults replace only owned invocation outcomes/clock; no API or service runs.
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SELF={open_id:'ou_authored_observer_media_owner'};
const hash=x=>createHash('sha256').update(x).digest('hex');
const ACCOUNT=hash(`lark.im\0${SELF.open_id}`),NOW=Date.parse('2044-03-04T05:06:00.000Z');
const FRAME='__EXOCORTEX_JSON_LINES_BEGIN_V1__';
const inspect=(db,sql)=>sqliteQuery(db,sql,'inspect authored media budget');
const helperPath=()=>fs.realpathSync(process.env.EXOCORTEX_JPEG_VALIDATOR??join(ROOT,'build/native/jpeg-validator'));
const isFinish=sql=>sql.includes('CREATE TEMP TABLE __enrichment_effects')&&sql.includes('last_scanned_count=');
function jpeg(){
  const segment=(marker,body)=>{const head=Buffer.from([255,marker,0,0]);head.writeUInt16BE(body.length+2,2);return Buffer.concat([head,body]);};
  const dc=Buffer.alloc(18);dc[1]=1;const ac=Buffer.alloc(18);ac[0]=16;ac[1]=1;
  return Buffer.concat([Buffer.from([255,216]),segment(0xdb,Buffer.from([0,...Array(64).fill(1)])),
    segment(0xc0,Buffer.from([8,0,1,0,1,1,1,0x11,0])),segment(0xc4,Buffer.concat([dc,ac])),
    segment(0xda,Buffer.from([1,1,0,0,63,0])),Buffer.from([0x3f,255,217])]);
}
function resourceFingerprint(cache){
  return fs.readdirSync(cache).sort().map(name=>({name,sha256:hash(fs.readFileSync(join(cache,name)))}));
}
function fixture(t,types=['image','image']){
  const directory=fs.mkdtempSync(join(tmpdir(),'authored-observer-media-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const db=join(directory,'authored.sqlite');ensureInitialized(db);
  const binding={initial_account_binding:{kind:INITIAL_ACCOUNT_KIND,account_key:ACCOUNT,
    reserved_at:'2025-01-01T00:00:00.000Z',confirmed_at:'2025-01-01T00:00:00.000Z'}};
  sqliteExec(db,`UPDATE sources SET config_json=${q(JSON.stringify(binding))} WHERE id='lark.im';`);
  const rows=types.map((type,index)=>{
    const id=index+1,body=type==='image'?'Authored image.':`Authored later text ${id}.`;
    const content=JSON.stringify(type==='image'?{image_key:`img_authored_observer_${id}`}:{text:body});
    const raw={message_id:`om_authored_observer_${id}`,chat_id:'oc_authored_observer_media',chat_type:'group',msg_type:type,
      create_time:String(NOW-id*1000),sender:{id:SELF.open_id,id_type:'open_id',sender_type:'user',name:'Authored Sender'},body:{content}};
    const canonical={message_id:raw.message_id,chat_id:raw.chat_id,chat_type:'group',chat_name:'Authored Group',chat_name_source:'message',
      msg_type:type,sender_id:SELF.open_id,sender_id_type:'open_id',sender_type:'user',sender_name:'Authored Sender',sender_name_source:'message_sender'};
    const raw_json=JSON.stringify(raw);
    return{id,source_id:'lark.im',first_seen_scope_id:'lark.im.sent_by_me',external_id:raw.message_id,external_version:'1',
      record_type:'lark.im.message',occurred_at:new Date(NOW-id*1000).toISOString(),occurred_at_ms:NOW-id*1000,
      actor_id:SELF.open_id,container_id:raw.chat_id,direction:'sent',body,canonical_json:JSON.stringify(canonical),raw_json,content_hash:hash(raw_json)};
  });
  sqliteExec(db,rows.map(row=>{const fields=Object.keys(row);return`INSERT INTO records(${fields.join(',')}) VALUES(${fields.map(k=>q(row[k])).join(',')});`;}).join('\n'));
  const cache=resourceStorePath(db),bindings=[];
  for(const row of rows){const raw=JSON.parse(row.raw_json);if(raw.msg_type!=='image')continue;
    const resourceBinding=makeMediaResourceBinding(db,row,ACCOUNT,{type:'image',resource:{kind:'image_key',key:JSON.parse(raw.body.content).image_key,state:'reference_only'}});
    assert(resourceBinding);const result=publishMediaResource(cache,resourceBinding,jpeg(),{nowMs:NOW});
    assert.equal(result.status,'available','real installed helper must accept the authored cached JPEG');bindings.push(resourceBinding);
  }
  const f={db,directory,cache,bindings,rows,tick:0,now:NOW,calls:[],clockFault:null,failClose:false,closeFaultInjected:false,laterBodyParses:0,
    laterBodies:new Set(rows.filter(row=>JSON.parse(row.raw_json).msg_type==='text').map(row=>JSON.parse(row.raw_json).body.content))};
  f.records=inspect(db,'SELECT * FROM records ORDER BY id;');f.resources=resourceFingerprint(cache);
  f.ledger=()=>inspect(db,'SELECT * FROM lark_im_message_readiness ORDER BY record_id;');
  f.scan=()=>inspect(db,'SELECT * FROM lark_im_message_readiness_scan;');
  f.unchanged=()=>{assert.deepEqual(inspect(db,'SELECT * FROM records ORDER BY id;'),f.records);assert.deepEqual(resourceFingerprint(cache),f.resources);};
  return f;
}
function withChildren(observer,work){
  const original=cp.spawnSync;cp.spawnSync=(...args)=>observer(original,...args);syncBuiltinESMExports();
  try{return work();}finally{cp.spawnSync=original;syncBuiltinESMExports();}
}
function run(f,fault=null){
  const lease=tryAcquireLarkApiLease({role:'sync'},{directory:join(f.directory,'private-api')});
  assert.equal(lease.state,'acquired');assert(getLarkApiLeaseStdio());
  const helper=helperPath(),parse=JSON.parse,close=fs.closeSync;
  JSON.parse=function(value,...args){if(f.laterBodies.has(value))f.laterBodyParses++;return parse(value,...args);};
  fs.closeSync=fd=>{close(fd);if(f.failClose){f.failClose=false;f.closeFaultInjected=true;throw new Error('AUTHORED_PRIVATE_CLEANUP_ERROR');}};
  syncBuiltinESMExports();
  try{
    const result=withChildren((original,command,args,settings)=>{
      assert(command==='sqlite3'||command===helper,'observer may launch only local SQLite or verified JPEG helper');
      const call={kind:command===helper?'jpeg':'sqlite',tick:f.tick,timeout:settings.timeout,input:String(command==='sqlite3'?settings.input:''),
        inputBytes:command===helper?settings.input.length:null,maxBuffer:settings.maxBuffer,killSignal:settings.killSignal};
      assert(Number.isSafeInteger(call.timeout)&&call.timeout>0&&call.timeout<=5000);
      assert.equal(call.killSignal,'SIGKILL');f.calls.push(call);
      const execute=()=>{const response=original(command,args,settings);if(command==='sqlite3')f.tick+=10;return response;};
      return fault?fault(call,execute,original):execute();
    },()=>syncReadiness(f.db,SELF,{now:()=>f.now,monotonicNow:()=>{
      if(f.clockFault==='throw')throw new Error('AUTHORED_PRIVATE_CLOCK_ERROR');
      return f.clockFault==='nonfinite'?NaN:f.clockFault==='reversed'?-1:f.tick;
    }}));
    assert.deepEqual(normalizeReadinessObservation(result),result);
    assert.doesNotMatch(JSON.stringify(result),/AUTHORED_PRIVATE|Authored|ou_authored|om_authored|\.sqlite|image_key/);
    assert.equal(result.command_budget.max_ms,5000);assert(result.scanned<=40);
    assert.equal(result.observed+result.deferred,result.scanned);return result;
  }finally{JSON.parse=parse;fs.closeSync=close;syncBuiltinESMExports();lease.release();}
}
function assertAbort(f,result,kind='time_budget'){
  assert.equal(result.reason,'observation_failed');assert.equal(result.diagnostic.stage,'read');assert.equal(result.diagnostic.kind,kind);
  assert.equal(result.claim_state,'confirmed');assert.equal(result.finish_state,'not_started');
  assert.equal(result.scanned,f.rows.length);assert.equal(result.observed,0);assert.equal(result.deferred,f.rows.length);
  assert.equal(result.command_budget.stop_reason,kind);assert.equal(f.ledger().length,0);
  assert.equal(f.scan()[0].generation,1);assert.equal(f.scan()[0].tail_after_id,0);assert.equal(f.scan()[0].history_after_id,0);
  assert(!f.calls.some(call=>isFinish(call.input)));f.unchanged();
}
const messages=f=>executeMessages({db:f.db,direction:'all',limit:40,search:''});

test('real cached JPEG helpers share the observer remainder and default messages retain JSON/text behavior',t=>{
  const f=fixture(t),ordinary=[];
  const before=withChildren((original,command,args,settings)=>{if(command===helperPath())ordinary.push(settings.timeout);return original(command,args,settings);},()=>messages(f));
  assert.deepEqual(ordinary,[5000,5000]);assert(before.every(row=>row.display.media.resource.state==='available'));
  const textBefore=renderMessagesText(before,{stream:{isTTY:false}});
  const result=run(f,(call,execute)=>{const answer=execute();if(call.kind==='jpeg')f.tick+=250;return answer;});
  const native=f.calls.filter(call=>call.kind==='jpeg');assert.equal(native.length,2);
  for(const call of native){assert.equal(call.timeout,4000-call.tick);assert.equal(call.maxBuffer,8192);assert.equal(call.inputBytes,jpeg().length);}
  assert(native[1].timeout<native[0].timeout);assert.equal(result.reason,'observed');assert.equal(result.observed,2);
  assert.equal(result.claim_state,'confirmed');assert.equal(result.finish_state,'confirmed');assert.equal(result.cleanup_state,'succeeded');
  assert.deepEqual(messages(f),before);assert.equal(renderMessagesText(messages(f),{stream:{isTTY:false}}),textBefore);f.unchanged();
});

for(const response of ['timeout','success'])test(`JPEG ${response} at shared work cutoff aborts before the second helper without marking valid cached bytes bad`,t=>{
  const f=fixture(t);
  const result=run(f,(call,execute)=>{
    if(call.kind!=='jpeg')return execute();
    if(response==='success'){const answer=execute();f.tick=4001;return answer;}
    f.tick+=call.timeout;
    return{status:null,signal:'SIGKILL',error:Object.assign(new Error('AUTHORED_PRIVATE_TIMEOUT'),{code:'ETIMEDOUT'}),stdout:'',stderr:'AUTHORED_PRIVATE_STDERR'};
  });
  assert.equal(f.calls.filter(call=>call.kind==='jpeg').length,1);assertAbort(f,result);
  assert(messages(f).every(row=>row.display.media.resource.state==='available'),'a budget abort is not evidence against cached bytes');
  f.tick=0;f.now+=60000;f.calls=[];const recovered=run(f);assert.equal(recovered.observed,2);assert.equal(recovered.reason,'observed');f.unchanged();
});

test('media expiry stops a following text body and following image while retaining the entire selected denominator',t=>{
  const f=fixture(t,['image','text','image']);
  const result=run(f,(call,execute)=>{const answer=execute();if(call.kind==='jpeg')f.tick=4001;return answer;});
  assert.equal(f.calls.filter(call=>call.kind==='jpeg').length,1);assert.equal(f.laterBodyParses,0);assertAbort(f,result);
});

test('expiry after the framed snapshot launches no resource helper or text projection',t=>{
  const f=fixture(t,['image','text','image']);
  const result=run(f,(call,execute)=>{const answer=execute();if(call.input.includes(FRAME))f.tick=4001;return answer;});
  assert.equal(f.calls.filter(call=>call.kind==='jpeg').length,0);assert.equal(f.laterBodyParses,0);assertAbort(f,result);
});

for(const mode of ['throw','nonfinite','reversed'])test(`clock ${mode} after JPEG execution stops later projections with a finite clock diagnostic`,t=>{
  const f=fixture(t,['image','text','image']);
  const result=run(f,(call,execute)=>{const answer=execute();if(call.kind==='jpeg')f.clockFault=mode;return answer;});
  assert.equal(f.calls.filter(call=>call.kind==='jpeg').length,1);assert.equal(f.laterBodyParses,0);assertAbort(f,result,'clock_unavailable');
  assert.equal(result.command_budget.complete,false);
});

test('helper descriptor cleanup failure cannot replace an established budget abort at the actual observer boundary',t=>{
  const f=fixture(t);
  const result=run(f,(call,execute)=>{const answer=execute();if(call.kind==='jpeg'){f.tick=4001;f.failClose=true;}return answer;});
  assert(f.closeFaultInjected);assert.equal(f.calls.filter(call=>call.kind==='jpeg').length,1);assertAbort(f,result);
});

test('cache-read expiry throws the typed budget error before native verification and leaves cache unchanged',t=>{
  const f=fixture(t),state={tick:0},budget=createHistoryCommandBudget({maxSeconds:5},{monotonicClock:()=>state.tick});let helpers=0;
  withChildren((original,command,args,settings)=>{if(command===helperPath())helpers++;return original(command,args,settings);},()=>{
    assert.throws(()=>readMediaResource(f.cache,f.bindings[0],{executionBudget:budget,afterBlobRead(){state.tick=4001;}}),
      error=>error instanceof HistoryCommandBudgetError&&error.reason==='time_budget');
  });
  assert.equal(helpers,0);f.unchanged();
});

test('a genuine native invalid-image result inside the remaining budget stays a media failure, not a budget abort',t=>{
  const f=fixture(t);
  const result=run(f,(call,execute)=>call.kind==='jpeg'?{status:10,signal:null,stdout:JSON.stringify({version:1,status:'invalid'}),stderr:''}:execute());
  assert.equal(f.calls.filter(call=>call.kind==='jpeg').length,2);assert.equal(result.reason,'observed');assert.equal(result.observed,2);
  assert.equal(result.command_budget.stop_reason,null);assert.equal(result.diagnostic,undefined);
  assert(f.ledger().every(row=>row.state==='blocked'&&row.first_ready_observed_at_ms===null));
  assert(messages(f).every(row=>row.display.media.resource.state==='available'),'controlled failure does not mutate good cache');f.unchanged();
});

test('media verification still cannot save a stale observation after the selected source changes before finish',t=>{
  const f=fixture(t);let changed=false;
  const result=run(f,(call,execute,original)=>{
    if(isFinish(call.input)&&!changed){changed=true;const altered=original('sqlite3',[f.db],{input:"UPDATE records SET external_version='2' WHERE id=1;",encoding:'utf8',timeout:1000});assert.equal(altered.status,0);}
    return execute();
  });
  assert(changed);assert.equal(result.reason,'observed');assert.equal(result.observed,1);assert.equal(result.deferred,1);
  assert.deepEqual(f.ledger().map(row=>row.record_id),[2]);assert.equal(result.finish_state,'confirmed');
  const after=inspect(f.db,'SELECT * FROM records ORDER BY id;');assert.deepEqual(after,[{...f.records[0],external_version:'2'},f.records[1]]);
  assert.deepEqual(resourceFingerprint(f.cache),f.resources);
});
