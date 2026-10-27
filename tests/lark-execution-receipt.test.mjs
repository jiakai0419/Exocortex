import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {createLarkCliRunner,createTransportState} from '../src/adapters/lark-im/transport.mjs';
import {readLarkExecutionReceipt,validateLarkExecutionReceipt,formatLarkExecutionReceipt} from '../src/adapters/lark-im/transport-execution.mjs';
import {nameLookupFailure,sanitizeSenderNameObservation} from '../src/adapters/lark-im/sender-name-observation.mjs';
const AT=Date.UTC(2025,0,1),OP='application_info',ARGS=['api','GET','/open-apis/application/v6/applications/cli_invented_receipt'];
const copy=x=>JSON.parse(JSON.stringify(x));
const receipt={version:1,launch_attempted:true,execution:'started',result_at_ms:AT,result_kind:'permission_denied',result_code:210508,remote_result:true};
const message=value=>`lark-cli failed: kind=permission_denied code=210508 operation=${OP} ${formatLarkExecutionReceipt(value)}`;
const failure=()=>nameLookupFailure(message(receipt),OP);
const observation=()=>({status:'failed',reason:'request_failed',source:'application_api',cached:false,
  observed_at:new Date(AT+100).toISOString(),account_key:'a'.repeat(64),failure:failure()});
const invoke=deps=>createLarkCliRunner({state:createTransportState(),clock:()=>AT,monotonicClock:()=>0,...deps});
const capture=fn=>{try{fn();assert.fail('expected safe error');}catch(error){assert(error instanceof Error);return error;}};
const result=(extras={})=>({status:1,pid:4321,stdout:'',stderr:'',...extras});

test('finite receipt survives Error and string boundaries, never borrowing an absent legacy receipt',()=>{
  for(const value of [message(receipt),Error(message(receipt))]) assert.deepEqual(readLarkExecutionReceipt(value,OP),{status:'valid',value:receipt});
  assert.deepEqual(readLarkExecutionReceipt('lark-cli failed: kind=network_timeout operation=application_info',OP),{status:'absent'});
  assert.equal(nameLookupFailure('lark-cli failed: kind=network_timeout operation=application_info',OP).version,1);
  assert.deepEqual(failure(),{version:2,operation:OP,kind:'permission_denied',code:210508,stage:'response_error',execution:receipt});
});
for(const [label,edit] of [
  ['partial',s=>s.replace(' remote_result=1','')],['bare marker',s=>'lark-cli failed: kind=permission_denied operation=application_info receipt_v'],
  ['duplicate',s=>s+' receipt_v=1'],['contradiction',s=>s.replace('execution=started','execution=not_started')],
  ['wrong operation',s=>s.replace('operation=application_info','operation=chat_bots')],
  ['unknown field',s=>s+' private_target=pt_invented_secret'],['invalid boolean',s=>s.replace('remote_result=1','remote_result=true')],
  ['unknown version',s=>s.replace('receipt_v=1','receipt_v=2')],['unsafe integer',s=>s.replace(`result_at_ms=${AT}`,'result_at_ms=9007199254740992')],
]) test(`explicit ${label} receipt cannot fall back to legacy response authority`,()=>{
  const text=edit(message(receipt));assert.equal(readLarkExecutionReceipt(text,OP).status,'invalid');
  assert.deepEqual(nameLookupFailure(text,OP),{version:1,operation:OP,kind:'unknown',code:null,stage:'execution_unknown'});
  assert.doesNotMatch(JSON.stringify(nameLookupFailure(text,OP)),/pt_invented_secret|private_target/);
});

test('receipt validator rejects impossible states, extra data and nonfinite clocks',()=>{
  for(const item of [{...receipt,execution:'unknown'},{...receipt,launch_attempted:false},{...receipt,result_at_ms:Infinity},
    {...receipt,result_at_ms:-1},{...receipt,result_code:-1},{...receipt,remote_result:false},
    {...receipt,result_kind:'success'},{...receipt,body:'invented secret'},{...receipt,remote_result:1}]) assert.equal(validateLarkExecutionReceipt(item),false);
  assert(validateLarkExecutionReceipt({...receipt,result_at_ms:null}));
  assert(validateLarkExecutionReceipt({version:1,launch_attempted:false,execution:'not_started',result_at_ms:null,result_kind:null,result_code:null,remote_result:false}));
});

test('sanitizer bounds execution clock by both diagnostic clock and explicit as-of',()=>{
  const value=observation();assert.deepEqual(sanitizeSenderNameObservation(value,undefined,AT+100),value);
  for(const at of [AT+101,AT+1000]){const changed=copy(value);changed.failure.execution.result_at_ms=at;
    assert.equal(sanitizeSenderNameObservation(changed,undefined,AT+2000).failure,undefined);}
  assert.equal(sanitizeSenderNameObservation(value,undefined,AT-1).failure,undefined);
  const missing=copy(value);missing.failure.execution.result_at_ms=null;
  assert.equal(sanitizeSenderNameObservation(missing,undefined,AT+100).failure.execution.result_at_ms,null);
  for(const change of [{kind:'permission_denied'},{code:210508},{version:2,execution:receipt}]){
    const value=observation();value.failure={version:1,operation:OP,kind:'unknown',code:null,stage:'execution_unknown',...change};
    assert.equal(sanitizeSenderNameObservation(value,undefined,AT+100).failure,undefined);
  }
});

for(const [label,extras,expected] of [
  ['missing pid timeout',{status:null,error:{code:'ETIMEDOUT'}},'started'],
  ['explicit pid0 timeout',{status:null,pid:0,error:{code:'ETIMEDOUT'}},'unknown'],
  ['pid timeout',{status:null,pid:4321,error:{code:'ETIMEDOUT'}},'started'],
  ...['ENOENT','EACCES','E2BIG','ENOEXEC'].map(code=>[code,{status:null,pid:0,error:{code}},'not_started']),
])test(`command boundary ${label} is ${expected}`,()=>{
  const spawnResult={stdout:'',stderr:'',...extras};
  const error=capture(()=>invoke({spawn:()=>spawnResult})(ARGS));const parsed=readLarkExecutionReceipt(error,OP);
  assert.equal(parsed.status,'valid');assert.equal(parsed.value.execution,expected);
  assert.equal(parsed.value.remote_result,false);assert.equal(parsed.value.result_at_ms,expected==='started'?AT:null);
});

test('structured API response is distinct from private prose and malformed JSON',()=>{
  for(const status of [0,1]){
    let actual;const run=invoke({spawn:()=>result({status,stdout:JSON.stringify({error:{type:'api',code:210508,message:'pt_invented_secret'}})})});
    try{run(ARGS,{onExecutionReceipt:value=>{actual=value;throw Error('ignored observer');}});}catch(error){assert.equal(readLarkExecutionReceipt(error,OP).status,'valid');}
    assert.deepEqual(actual,receipt);
  }
  const prose=capture(()=>invoke({spawn:()=>result({stderr:'code=210508 pt_invented_secret'})})(ARGS));
  const evidence=nameLookupFailure(prose,OP);assert.equal(evidence.version,2);assert.equal(evidence.code,null);
  assert.notEqual(evidence.stage,'response_error');assert.equal(evidence.execution.remote_result,false);
  assert.equal(evidence.execution.result_code,null);assert.doesNotMatch(JSON.stringify(evidence),/pt_invented_secret/);
  const invalid=capture(()=>invoke({spawn:()=>result({status:0,stdout:'pt_invented_secret not json'})})(ARGS));
  assert.match(invalid.message,/reason=invalid_json/);const invalidReceipt=readLarkExecutionReceipt(invalid,OP).value;
  assert.equal(invalidReceipt.execution,'started');assert.equal(invalidReceipt.result_kind,'unknown');assert.equal(invalidReceipt.remote_result,false);
});

test('retry exec failure preserves earlier timeout and callback clock rather than final local failure',()=>{
  let attempts=0,wall=AT;const callbacks=[];
  const run=invoke({clock:()=>wall,spawn:()=>{attempts++;if(attempts===1)return result({status:null,error:{code:'ETIMEDOUT'}});
    wall=AT+5000;return result({status:null,pid:0,error:{code:'ENOENT'}});},sleep:()=>{wall=AT+1000;}});
  const error=capture(()=>run(ARGS,{retries:1,retryDelayMs:0,onExecutionReceipt:value=>callbacks.push(value)}));
  assert.match(error.message,/kind=command_unavailable/);const parsed=readLarkExecutionReceipt(error,OP).value;
  assert.equal(attempts,2);assert.equal(parsed.result_kind,'network_timeout');assert.equal(parsed.result_at_ms,AT);assert.equal(parsed.remote_result,false);
  assert.deepEqual(callbacks,[parsed]);const local=nameLookupFailure(error,OP);assert.equal(local.kind,'command_unavailable');assert.equal(local.stage,'not_requested');assert.deepEqual(local.execution,parsed);
});

test('real local spawn timeout and failed executable are distinguishable without a remote call',()=>{
  const timeout=spawnSync(process.execPath,['-e','setInterval(()=>{},1000)'],{encoding:'utf8',timeout:25,killSignal:'SIGKILL'});
  assert.equal(timeout.error?.code,'ETIMEDOUT');assert(timeout.pid>0);
  const timed=capture(()=>invoke({spawn:()=>timeout})(ARGS));assert.equal(readLarkExecutionReceipt(timed,OP).value.execution,'started');
  const missing=spawnSync('/nonexistent-exocortex-synthetic-execution',[],{encoding:'utf8'});
  assert.equal(missing.error?.code,'ENOENT');const failed=capture(()=>invoke({spawn:()=>missing})(ARGS));
  assert.equal(readLarkExecutionReceipt(failed,OP).value.execution,'not_started');
});
