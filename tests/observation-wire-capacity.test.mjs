import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import test from 'node:test';
import {sqliteExec,quoteSql as q} from '../dist/storage/sqlite/sqlite-executor.js';
import {prepareObservationRecords} from '../dist/storage/sqlite/observation-store.js';

const BEGIN='__EXOCORTEX_OBSERVATION_OBJECTS_BEGIN_V1__',END='__EXOCORTEX_OBSERVATION_OBJECTS_END_V1__';
const CAP=50*1024*1024,AT=Date.UTC(2025,5,6),STAMP='2025-06-06T00:00:00.000Z';
const RECORD=['id','source_id','first_seen_scope_id','external_id','external_version','record_type',
  'occurred_at','occurred_at_ms','received_at','actor_id','container_id','direction','title','body','content_hash',
  'canonical_json','raw_json','created_at','updated_at'];
const STATE=['observation_generation','evidence_generation','candidate_json','candidate_generation',
  'candidate_attempt','candidate_policy','candidate_context','candidate_observed_at_ms'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const originalSpawn=cp.spawnSync;
let haltRealCalls=false;

function swapSpawn(spawn,work) {
  cp.spawnSync=spawn;syncBuiltinESMExports();
  try{return work();}finally{cp.spawnSync=originalSpawn;syncBuiltinESMExports();}
}

function deadline() {
  const began=performance.now(),end=began+30000;
  const assertReady=()=>assert(performance.now()<end,'original thirty-second operation deadline');
  return {began,assertReady,timeoutMs(cap=30000){assertReady();return Math.min(cap,Math.ceil(end-performance.now()));},
    runCleanup:work=>work()};
}

function authored(index) {
  const id=index+1,body=`Synthetic row ${index}\0tail 雪\n${BEGIN}\n${END}`;
  const raw={message_id:`om_synthetic_observation_capacity_${index}`,chat_id:'oc_synthetic_capacity',
    msg_type:'text',create_time:String(AT+index),body:{content:JSON.stringify({text:body})},
    synthetic_metadata:'\\'.repeat(100*1024)};
  const raw_json=JSON.stringify(raw),record={id,source_id:'lark.im',first_seen_scope_id:'lark.im.sent_by_me',
    external_id:raw.message_id,external_version:String(AT+index),record_type:'lark.im.message',
    occurred_at:index%2?null:new Date(AT+index).toISOString(),occurred_at_ms:AT+index,received_at:STAMP,
    actor_id:index%2?null:'ou_synthetic_capacity',container_id:index%2?null:raw.chat_id,direction:index%2?null:'sent',
    title:index%2?null:'Synthetic title\0suffix',body,content_hash:hash(raw_json),
    canonical_json:JSON.stringify({source_api:'im.v1.messages',message_id:raw.message_id}),raw_json,created_at:STAMP,updated_at:STAMP};
  assert.deepEqual(Object.keys(record),RECORD);
  const state={observation_generation:100+index,evidence_generation:900+index,
    candidate_json:index%2?null:JSON.stringify({synthetic:'small inert candidate\0tail'}),
    candidate_generation:index%2?null:100+index,candidate_attempt:index%2?null:'Synthetic attempt\0tail',
    candidate_policy:index%2?null:'synthetic_inert_policy',candidate_context:index%2?null:'Synthetic context\0tail',
    candidate_observed_at_ms:index%2?null:AT-1};
  assert.deepEqual(Object.keys(state),STATE);
  const {id:ignored,received_at,created_at,updated_at,...incoming}=record;
  return {record,state,incoming};
}

test('actual default observation helper preserves one hundred 100 KiB escape-heavy predecessors within original cap and deadline',t=>{
  assert.equal(haltRealCalls,false,'no later real operation after an unresolved failure');
  const root=mkdtempSync(join(tmpdir(),'synthetic-observation-wire-capacity-')),db=join(root,'authored.sqlite');
  const rows=Array.from({length:100},(_,i)=>authored(i)),receipts=[];let complete=false,phase='setup',lastOutput='';
  t.after(()=>{
    if(complete)rmSync(root,{recursive:true,force:true});
    else {
      haltRealCalls=true;
      writeFileSync(join(root,'RECEIPTS.json'),JSON.stringify(receipts,null,2)+'\n');
      writeFileSync(join(root,'LAST-STDOUT.txt'),lastOutput);
      t.diagnostic(`authored failure fixture retained: ${root}; no retry or unknown-process cleanup`);
    }
  });
  const observed=(command,args,options)=>{
    assert.equal(haltRealCalls,false,'real dispatch halted after prior child failure');
    assert.equal(command,'sqlite3');assert.equal(args.at(-1),resolve(db));assert.notEqual(options.shell,true);
    assert(options.timeout>0&&options.timeout<=30000);assert.equal(options.maxBuffer,CAP);assert.equal(options.killSignal,'SIGKILL');
    if(phase==='observation') {
      assert.deepEqual(args,['-readonly','-batch','-init','/dev/null','-noheader','-list',resolve(db)]);
      assert.match(options.input,/PRAGMA query_only = ON;\nBEGIN;/);
      assert.match(options.input,/\nCOMMIT;\n\.print __EXOCORTEX_OBSERVATION_OBJECTS_END_V1__\n$/);
      assert.doesNotMatch(options.input,/AS before_json/);
    }
    const began=performance.now();let result;
    try{result=originalSpawn(command,args,options);}catch(error){haltRealCalls=true;receipts.push({phase,thrown:true,child_status:'unknown'});throw error;}
    lastOutput=String(result.stdout||'');
    const receipt={phase,pid:result.pid,status:result.status,signal:result.signal??null,error_code:result.error?.code??null,
      timeout_ms:options.timeout,max_buffer_bytes:options.maxBuffer,elapsed_ms:performance.now()-began,
      stdout_bytes:Buffer.byteLength(lastOutput),stderr_bytes:Buffer.byteLength(String(result.stderr||'')),
      direct_native_spawn_sync:true};
    receipts.push(receipt);writeFileSync(join(root,'RECEIPTS.json'),JSON.stringify(receipts,null,2)+'\n');
    if(result.status!==0||result.signal||result.error)haltRealCalls=true;
    // Do not replace native status or transport: product code handles failure.
    return result;
  };
  const migrations=['001_ingestion_core.sql','002_lark_im_source.sql','010_lark_observation_state.sql']
    .map(name=>readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8')).join('\n');
  const seed=rows.map(({record,state})=>`INSERT INTO records(${RECORD}) VALUES(${RECORD.map(k=>q(record[k]))});
    UPDATE record_observation_state SET ${STATE.map(k=>`${k==='observation_generation'?'generation':k}=${q(state[k])}`).join(',')}
    WHERE record_id=${record.id};`).join('\n');
  const setup=deadline();
  swapSpawn(observed,()=>sqliteExec(db,`BEGIN;${migrations}\n${seed}\nCOMMIT;`,'seed authored capacity fixture',setup));
  const setupElapsed=performance.now()-setup.began;assert.equal(haltRealCalls,false);
  const before=hash(readFileSync(db)),input=rows.map(row=>row.incoming).reverse();phase='observation';
  const budget=deadline();
  const prepared=swapSpawn(observed,()=>prepareObservationRecords(db,input,
    {attempt:'synthetic_capacity_attempt',startedAtMs:AT+1000},budget));
  const helperElapsed=performance.now()-budget.began;
  assert.equal(haltRealCalls,false);assert(helperElapsed<30000);
  assert.equal(receipts.length,2);assert.equal(receipts[0].phase,'setup');assert.equal(receipts[1].phase,'observation');
  assert(receipts.every(r=>Number.isInteger(r.pid)&&r.pid>0&&r.status===0&&r.signal===null&&r.error_code===null));
  assert.equal(hash(readFileSync(db)),before,'default predecessor read preserves the authored database bytes');
  assert.equal(prepared.length,100);
  const lines=lastOutput.trimEnd().split('\n');assert.equal(lines.shift(),BEGIN);assert.equal(lines.pop(),END);
  assert.equal(lines.length,100);assert(!lastOutput.includes('\0'),'NUL is escaped inside JSON, not part of the wire frame');
  const expected=new Map(rows.map(({record,state})=>[record.external_id,{...record,...state}]));
  const actual=lines.map(line=>JSON.parse(line));
  for(const row of actual) {
    assert.deepEqual(Object.keys(row),[...RECORD,...STATE]);assert.deepEqual(row,expected.get(row.external_id));
    for(const key of Object.keys(row))assert.equal(typeof row[key],typeof expected.get(row.external_id)[key],key);
  }
  assert.equal(new Set(actual.map(row=>row.external_id)).size,100);
  for(const [i,item] of prepared.entries()) {
    const expectedRow=rows[99-i];assert.equal(item.external_id,input[i].external_id);
    assert.deepEqual(item.observation.before,expectedRow.record);assert.equal(item.observation.action,'equivalent');
    assert.equal(item.observation.generation,expectedRow.state.observation_generation);
    assert.equal(item.observation.evidenceGeneration,expectedRow.state.evidence_generation);
    assert.equal(item.body,expectedRow.record.body);assert.equal(item.raw_json,expectedRow.record.raw_json);
  }
  const wireBytes=Buffer.byteLength(lastOutput);
  assert(wireBytes>39*1024*1024&&wireBytes<CAP,'real complete output fits original50MiB despite old double-escape lower bound exceeding it');
  const output={records:100,metadata_bytes_each:100*1024,source_fields:19,state_fields:8,nul_and_null_exact:true,
    output_bytes:wireBytes,max_buffer_bytes:CAP,setup_elapsed_ms:setupElapsed,helper_elapsed_ms:helperElapsed,
    child_receipts:receipts,db_unchanged:true,helper_elapsed_includes_observational_receipt_io:true,
    full_wire_oracle_and_evidence_file_io_after_helper:true};
  if(process.env.EXOCORTEX_OBSERVATION_WIRE_EVIDENCE) {
    const target=process.env.EXOCORTEX_OBSERVATION_WIRE_EVIDENCE;
    writeFileSync(join(target,'capacity-read-stdout.jsonl'),lastOutput,{mode:0o600});
    writeFileSync(join(target,'capacity-read-result.json'),JSON.stringify(output,null,2)+'\n',{mode:0o600});
  }
  t.diagnostic(JSON.stringify(output));complete=true;
});
