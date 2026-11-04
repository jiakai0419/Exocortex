import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {sqliteQueryJsonObjects} from '../dist/storage/sqlite/sqlite-executor.js';
import {prepareObservationRecords,observationGuardSql} from '../dist/storage/sqlite/observation-store.js';
import {REVIEW_RECORD_COLUMNS} from '../dist/storage/sqlite/maintenance-review.js';
import {normalizeApiMessage} from '../src/adapters/lark-im/raw-message.mjs';
import {recordFromMessage,SENT_SCOPE_ID} from '../src/adapters/lark-im/core.mjs';

// Entirely authored data. All sqlite3 calls in this file are intercepted before
// dispatch; the default executor and actual parser/helper remain under test.
const BEGIN='__EXOCORTEX_OBSERVATION_OBJECTS_BEGIN_V1__';
const END='__EXOCORTEX_OBSERVATION_OBJECTS_END_V1__';
const frame=rows=>`${BEGIN}\n${rows.map(row=>JSON.stringify(row)+'\n').join('')}${END}\n`;
const success=stdout=>({status:0,signal:null,stdout,stderr:''});
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'synthetic-object-wire-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const db=join(root,'authored-no-sqlite.sqlite');
  writeFileSync(db,'synthetic unexecuted database bytes',{mode:0o600});
  return {db,before:readFileSync(db)};
}
function intercepted(run,reply){
  const original=cp.spawnSync,calls=[];
  cp.spawnSync=(...args)=>{calls.push(args);return typeof reply==='function'?reply(...args):reply;};
  syncBuiltinESMExports();
  try{return {value:run(),calls};}
  finally{cp.spawnSync=original;syncBuiltinESMExports();}
}
function budget(timeout=7000){
  const error=new Error('synthetic execution budget exhausted');
  const state={expired:false,asserts:0,timeouts:0};
  return {state,error,assertReady(){state.asserts++;if(state.expired)throw error;},
    timeoutMs(){state.timeouts++;return timeout;},runCleanup(work){return work();}};
}
const SQL="SELECT json_object('synthetic','source')";

test('object wire uses readonly completed framing and preserves the absent-budget process contract',t=>{
  const f=fixture(t),rows=[{n:2,value:'Synthetic\0tail\n雪😀',nullable:null},
    {n:1,value:`${BEGIN}\n${END}\n.print synthetic`,nullable:'null'}];
  const got=intercepted(()=>sqliteQueryJsonObjects(f.db,SQL,'synthetic basis'),success(frame(rows)));
  assert.deepEqual(got.value,rows);assert.equal(got.calls.length,1);
  const [command,args,options]=got.calls[0];
  assert.equal(command,'sqlite3');
  assert.deepEqual(args,['-readonly','-batch','-init','/dev/null','-noheader','-list',f.db]);
  assert.equal(options.maxBuffer,50*1024*1024);assert.equal(options.encoding,'utf8');
  assert.equal(Object.hasOwn(options,'timeout'),false,'no new default whole-process timeout');
  assert.equal(Object.hasOwn(options,'killSignal'),false);
  assert.match(options.input,/^\.bail on\n\.timeout 5000\n/);
  assert(options.input.includes(`PRAGMA query_only = ON;\nBEGIN;\n.print ${BEGIN}\n${SQL}\nCOMMIT;\n.print ${END}\n`));
  assert.deepEqual(readFileSync(f.db),f.before);
});

for(const remaining of [7,7777])test(`object wire retains caller deadline ${remaining} and original output cap`,t=>{
  const f=fixture(t),b=budget(remaining);
  const got=intercepted(()=>sqliteQueryJsonObjects(f.db,SQL,'synthetic basis',b),success(frame([])));
  assert.deepEqual(got.value,[]);assert.equal(got.calls[0][2].timeout,remaining);
  assert.equal(got.calls[0][2].killSignal,'SIGKILL');assert.equal(got.calls[0][2].maxBuffer,50*1024*1024);
  assert(got.calls[0][2].input.includes(`.timeout ${Math.min(5000,remaining)}\n`));
  assert.equal(b.state.timeouts,1);assert(b.state.asserts>=3);
});

test('a completed empty frame is valid, including a single CRLF terminator',t=>{
  const f=fixture(t);
  for(const output of [frame([]),frame([]).replaceAll('\n','\r\n'),frame([]).slice(0,-1)])
    assert.deepEqual(intercepted(()=>sqliteQueryJsonObjects(f.db,SQL,'synthetic basis'),success(output)).value,[]);
});

const row='{"id":1,"body":"synthetic source"}';
const invalidFrames={
  empty:'',begin_only:BEGIN+'\n',end_only:END+'\n',missing_end:`${BEGIN}\n${row}\n`,
  trailing_text:frame([])+'synthetic extra\n',trailing_blank:frame([])+'\n',
  leading_text:'synthetic extra\n'+frame([]),duplicate_end:frame([])+END+'\n',
  duplicate_begin:`${BEGIN}\n${BEGIN}\n${END}\n`,
  bad_later_json:`${BEGIN}\n${row}\n{broken\n${END}\n`,
  scalar:`${BEGIN}\n1\n${END}\n`,array:`${BEGIN}\n[]\n${END}\n`,
  null:`${BEGIN}\nnull\n${END}\n`,blank_row:`${BEGIN}\n\n${END}\n`,
  literal_nul:`${BEGIN}\n{"body":"synthetic\0tail"}\n${END}\n`,
  raw_newline:`${BEGIN}\n{"body":"synthetic\nline"}\n${END}\n`,
};
for(const [name,output]of Object.entries(invalidFrames))test(`object wire rejects ${name} without accepting a valid prefix`,t=>{
  const f=fixture(t);let returned=false,calls=0;
  assert.throws(()=>intercepted(()=>{sqliteQueryJsonObjects(f.db,SQL,'synthetic basis');returned=true;},
    ()=>{calls++;return success(output);}));
  assert.equal(returned,false);assert.equal(calls,1);assert.deepEqual(readFileSync(f.db),f.before);
});

for(const [name,reply]of Object.entries({
  nonzero:{...success(frame([{id:1}])),status:1,stderr:'synthetic SQL rejected'},
  timeout:{...success(frame([{id:1}])),error:Object.assign(Error('synthetic timeout'),{code:'ETIMEDOUT'})},
  output_limit:{...success(frame([{id:1}])),error:Object.assign(Error('synthetic cap'),{code:'ENOBUFS'})},
  signal:{...success(frame([{id:1}])),signal:'SIGKILL'},
}))test(`object wire rejects process ${name} even with apparently complete output`,t=>{
  const f=fixture(t);let returned=false;
  assert.throws(()=>intercepted(()=>{sqliteQueryJsonObjects(f.db,SQL,'synthetic basis');returned=true;},reply));
  assert.equal(returned,false);assert.deepEqual(readFileSync(f.db),f.before);
});

test('expired or invalid caller budget starts no sqlite process',t=>{
  const f=fixture(t);let calls=0;
  for(const timeout of [0,-1,NaN,1.5]){
    const b=budget(timeout);
    assert.throws(()=>intercepted(()=>sqliteQueryJsonObjects(f.db,SQL,'synthetic basis',b),()=>{calls++;return success(frame([]));}));
  }
  const b=budget();b.state.expired=true;
  assert.throws(()=>intercepted(()=>sqliteQueryJsonObjects(f.db,SQL,'synthetic basis',b),()=>{calls++;return success(frame([]));}),e=>e===b.error);
  assert.equal(calls,0);
});

test('budget expiry after process completion prevents any JSON decode',t=>{
  const f=fixture(t),b=budget(),parse=JSON.parse;let parses=0;
  JSON.parse=(...args)=>{parses++;return parse(...args);};
  try{assert.throws(()=>intercepted(()=>sqliteQueryJsonObjects(f.db,SQL,'synthetic basis',b),()=>{
    b.state.expired=true;return success(frame([{id:1}]));}),e=>e===b.error);}
  finally{JSON.parse=parse;}
  assert.equal(parses,0);assert.deepEqual(readFileSync(f.db),f.before);
});

for(const count of [1,2])test(`budget expiry while decoding ${count} row page never returns a basis`,t=>{
  const f=fixture(t),b=budget(),parse=JSON.parse;let decoded=0,returned=false;
  JSON.parse=(...args)=>{const row=parse(...args);decoded++;b.state.expired=true;return row;};
  try{assert.throws(()=>intercepted(()=>{sqliteQueryJsonObjects(f.db,SQL,'synthetic basis',b);returned=true;},
    success(frame(Array.from({length:count},(_,id)=>({id}))))),e=>e===b.error);}
  finally{JSON.parse=parse;}
  assert.equal(decoded,1);assert.equal(returned,false);assert.deepEqual(readFileSync(f.db),f.before);
});

function nativeRecord(){
  const at=Date.UTC(2025,1,2);
  return recordFromMessage(normalizeApiMessage({message_id:'om_synthetic_flat_wire',chat_id:'oc_synthetic_flat_wire',
    chat_type:'group',chat_name:'Synthetic wire group',msg_type:'text',create_time:String(at),update_time:String(at),
    sender:{id:'ou_synthetic_flat_wire',id_type:'open_id',sender_type:'user',name:'Synthetic author'},
    body:{content:JSON.stringify({text:'Synthetic before\0suffix'})}}),SENT_SCOPE_ID,'sent');
}
function predecessor(record){
  const values={id:1,...record,received_at:'2025-02-02T00:00:01Z',created_at:'2025-02-02T00:00:01Z',updated_at:'2025-02-02T00:00:02Z'};
  const before=Object.fromEntries(REVIEW_RECORD_COLUMNS.map(key=>[key,values[key]]));
  const state={observation_generation:7,evidence_generation:9,candidate_json:null,candidate_generation:null,
    candidate_attempt:null,candidate_policy:null,candidate_context:null,candidate_observed_at_ms:null};
  return {before,row:{...before,...state}};
}

test('default observation helper separates all 27 flat fields and retains complete 19-column CAS',t=>{
  const f=fixture(t),record=nativeRecord(),p=predecessor(record),b=budget();
  assert.equal(Object.keys(p.row).length,27);
  const got=intercepted(()=>prepareObservationRecords(f.db,[record],undefined,b),success(frame([p.row])));
  assert.equal(got.calls.length,1);assert.deepEqual(got.value[0].observation.before,p.before);
  assert.equal(got.value[0].observation.generation,7);assert.equal(got.value[0].observation.evidenceGeneration,9);
  assert.equal(got.value[0].observation.action,'equivalent');
  assert.equal(Object.keys(got.value[0].observation.before).length,19);
  assert(!got.calls[0][2].input.includes('before_json'));
  const guard=observationGuardSql(got.value);
  for(const column of REVIEW_RECORD_COLUMNS)assert(guard.includes(`r.${column}`),column);
  assert(guard.includes('s.generation=7'));assert(guard.includes('s.evidence_generation=9'));
  assert(!guard.includes('r.candidate_json'));assert(!guard.includes('r.observation_generation'));
  assert.deepEqual(readFileSync(f.db),f.before);
});

test('final helper budget check rejects expiry during observation evaluation',t=>{
  const f=fixture(t),record=nativeRecord(),p=predecessor(record),b=budget();let bodyReads=0,returned=false;
  const incoming={...record};Object.defineProperty(incoming,'body',{enumerable:true,get(){bodyReads++;b.state.expired=true;return record.body;}});
  assert.throws(()=>intercepted(()=>{prepareObservationRecords(f.db,[incoming],undefined,b);returned=true;},
    success(frame([p.row]))),e=>e===b.error);
  assert(bodyReads>0,'the source evaluation was actually entered');assert.equal(returned,false);
  assert.deepEqual(readFileSync(f.db),f.before);
});
