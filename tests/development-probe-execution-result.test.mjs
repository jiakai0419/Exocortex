import assert from 'node:assert/strict';
import test from 'node:test';
import {createProbeRunner,PROBE_TIMEOUT_MS,PROBE_MAX_BUFFER_BYTES} from '../src/development/probe-support.mjs';
const PRIVATE='invented-private-probe-detail',AT=Date.UTC(2025,0,1);
const response=(stdout,extra={})=>({status:0,signal:null,pid:4321,stdout,stderr:'',output:[],...extra});
function probe(result,args=['api','GET','/invented'],options={}){
 const calls=[];const run=createProbeRunner({clock:()=>AT,spawn(bin,argv,settings){calls.push({bin,argv,settings});return result;}});
 return {record:run('invented',args,options),calls};
}

test('malformed first observation is failed despite a successful process and finite transport error',()=>{
 const {record,calls}=probe(response(PRIVATE));
 assert.equal(record.ok,false);assert.equal(record.json_parse_failed,true);assert.equal(record.json,null);
 assert.equal(record.stdout_excerpt,PRIVATE);assert.equal(record.exit_code,0);assert.equal(record.execution_error,false);assert.equal(calls.length,1);
 assert(calls[0].settings.timeout>0 && calls[0].settings.timeout<=PROBE_TIMEOUT_MS);assert.equal(calls[0].settings.maxBuffer,PROBE_MAX_BUFFER_BYTES);
});

test('keepStdout preserves a successful numeric version observation without treating it as JSON',()=>{
 const {record,calls}=probe(response('lark-cli 7.8.9\n'),['--version'],{keepStdout:true});
 assert.equal(record.ok,true);assert.equal(record.stdout,'lark-cli 7.8.9');assert.equal(record.json,null);
 assert.equal(record.json_parse_failed,false);assert.equal(record.failure_kind,null);assert.equal(calls.length,1);
});

for(const envelope of [{code:210508,msg:PRIVATE},{error:{type:'api',code:210508,message:PRIVATE}}])
 for(const keepStdout of [false,true])test(`exit0 API failure retains original response, keepStdout=${keepStdout}`,()=>{
 const raw=JSON.stringify(envelope);const {record,calls}=probe(response(raw),['api','GET','/invented'],{keepStdout});
 assert.equal(record.ok,false);assert.equal(record.exit_code,0);assert.equal(record.json_parse_failed,false);
 assert.equal(record.failure_kind,'permission_denied');assert.deepEqual(record.json,envelope);assert.equal(record.stdout_excerpt,undefined);
 assert.equal(calls.length,1);if(keepStdout)assert.equal(record.stdout,raw);
});

test('zero-code success keeps its exact structured first observation',()=>{
 const json={code:0,data:{items:[],private_detail:PRIVATE}};const {record}=probe(response(JSON.stringify(json)));
 assert.equal(record.ok,true);assert.equal(record.failure_kind,null);assert.equal(record.json_parse_failed,false);assert.deepEqual(record.json,json);
});

test('keepStdout cannot waive a failed process or started timeout',()=>{
 for(const result of [response(PRIVATE,{status:1}),response(PRIVATE,{status:null,error:{code:'ETIMEDOUT'},signal:'SIGKILL'})]){
  const {record,calls}=probe(result,['--version'],{keepStdout:true});assert.equal(record.ok,false);assert.equal(calls.length,1);
  assert.equal(record.stdout,PRIVATE);
 }
});


test('private raw observation does not overwrite the transport finite classification',()=>{
 const json={code:'210508',msg:'permission denied '+PRIVATE};const {record}=probe(response(JSON.stringify(json)));
 assert.equal(record.ok,false);assert.deepEqual(record.json,json);assert.equal(record.failure_kind,'unknown');
 assert.equal(record.json_parse_failed,false);
});


test('keepStdout cannot waive an explicit API denial inside warning-prefixed non-JSON output',()=>{
 const raw='warning\n'+JSON.stringify({error:{type:'api',code:210508,message:PRIVATE}});
 const {record,calls}=probe(response(raw),['api','GET','/invented'],{keepStdout:true});
 assert.equal(record.ok,false);assert.equal(record.failure_kind,'permission_denied');
 assert.equal(record.json_parse_failed,true);assert.equal(record.stdout,raw);assert.equal(record.stdout_excerpt,raw);
 assert.equal(record.json,null);assert.equal(calls.length,1);
});

test('keepStdout cannot waive a local clock failure after a successful text-output process',()=>{
 let spawned=false,failed=false,calls=0;
 const run=createProbeRunner({clock(){if(spawned&&!failed){failed=true;throw Error('invented local clock failure');}return AT;},
  spawn(){spawned=true;calls++;return response('lark-cli 7.8.9');}});
 const record=run('invented',['--version'],{keepStdout:true});
 assert.equal(calls,1);assert.equal(record.exit_code,0);assert.equal(record.ok,false);
 assert.equal(record.failure_kind,'unknown');assert.equal(record.json_parse_failed,true);assert.equal(record.stdout,'lark-cli 7.8.9');
});
