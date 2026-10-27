import assert from 'node:assert/strict';
import test from 'node:test';
import {createLarkCliRunner,createTransportState,getTransportStats,transportOperation} from '../src/adapters/lark-im/transport.mjs';
import {readLarkExecutionReceipt} from '../src/adapters/lark-im/transport-execution.mjs';
import {createNameResolver} from '../src/adapters/lark-im/name-resolver.mjs';
import {normalizeApiMessage} from '../src/adapters/lark-im/raw-message.mjs';
const AT=Date.UTC(2025,8,1),RESULT=AT+2000,LOCAL=AT+5000;
const APP='cli_invented_exit_contract',CHAT='oc_invented_exit_contract';
const SELF={open_id:'ou_invented_exit_owner',name:'Invented Owner'};
const args=['api','GET',`/open-apis/application/v6/applications/${APP}`];
const output=(status,value)=>({status,pid:4321,stdout:JSON.stringify(value),stderr:'',signal:null,output:[]});
const deny={error:{type:'api',code:210508,message:'pt_invented_private_response'}};
const capture=action=>{try{action();assert.fail('expected finite failure');}catch(error){return error;}};
const message=()=>normalizeApiMessage({message_id:'om_invented_exit_message',chat_id:CHAT,chat_type:'group',msg_type:'text',
 create_time:String(AT),update_time:String(AT+1),sender:{id:APP,id_type:'app_id',sender_type:'app'},
 body:{content:JSON.stringify({text:'Invented unchanged source body.'})}});

for(const status of [0,1])test(`process exit ${status} preserves an API denial as the same finite failed execution`,()=>{
 const receipts=[],state=createTransportState();let calls=0;
 const run=createLarkCliRunner({state,clock:()=>RESULT,monotonicClock:()=>0,spawn(){calls++;return output(status,deny);}});
 const error=capture(()=>run(args,{retries:3,onExecutionReceipt:value=>receipts.push(value)}));
 assert.equal(calls,1,'terminal API denial cannot retry');assert.doesNotMatch(error.message,/pt_invented|private_response/);
 const receipt=readLarkExecutionReceipt(error,'application_info');assert.equal(receipt.status,'valid');
 assert.deepEqual(receipt.value,{version:1,launch_attempted:true,execution:'started',result_at_ms:RESULT,
   result_kind:'permission_denied',result_code:210508,remote_result:true});assert.deepEqual(receipts,[receipt.value]);
 assert.match(error.message,/kind=permission_denied code=210508/);assert.equal(getTransportStats(state,RESULT).attempts,1);
});

for(const [code,kind]of [[99991400,'rate_limited'],[2200,'internal_error']])test(`exit0 ${kind} uses identical bounded retry and accounting to nonzero exit`,()=>{
 const cases=[];
 for(const status of [0,1]){let calls=0,clock=RESULT,elapsed=0;const sleeps=[],receipts=[],state=createTransportState();
  const run=createLarkCliRunner({state,clock:()=>clock,monotonicClock:()=>elapsed,
   sleep(ms){sleeps.push(ms);clock+=ms;elapsed+=ms;},spawn(){calls++;return calls===1?output(status,{error:{type:'api',code,...(code===2200?{message:'Internal Error'}:{})},response:{headers:{'x-ogw-ratelimit-reset':'0.001'}}}):output(0,{data:{app:{app_id:APP,app_name:'Invented App'}}});}});
  const value=run(args,{retries:1,retryDelayMs:1,retryBudgetMs:20,onExecutionReceipt:value=>receipts.push(value)});
  assert.equal(value.data.app.app_name,'Invented App');assert.equal(calls,2);assert.equal(receipts[0].result_kind,kind);
  assert.equal(receipts[0].remote_result,true);assert.equal(receipts[1].result_kind,'success');
  cases.push({calls,sleeps,receipts,stats:getTransportStats(state,clock)});
 }
 assert.deepEqual(cases[0],cases[1]);
});

for(const value of [{data:{app:{app_id:APP,app_name:'Invented App'}}},{data:{items:[]}},null])test(`successful exit0 payload stays unchanged (${value===null?'null':value.data.app?'app':'empty'})`,()=>{
 const run=createLarkCliRunner({state:createTransportState(),clock:()=>RESULT,monotonicClock:()=>0,spawn:()=>output(0,value)});
 let receipt;assert.deepEqual(run(args,{onExecutionReceipt:value=>{receipt=value;}}),value);
 assert.equal(receipt.result_kind,'success');assert.equal(receipt.result_at_ms,RESULT);assert.equal(receipt.remote_result,false);
});

for(const statuses of [[0,0],[0,1],[1,0],[1,1]])test(`resolver preserves both API failure receipts for exits ${statuses.join('/')}`,()=>{
 const run=createLarkCliRunner({state:createTransportState(),clock:()=>RESULT,monotonicClock:()=>0,
  spawn(_cmd,args){return output(statuses[transportOperation(args)==='application_info'?0:1],deny);}});
 const resolver=createNameResolver({run,now:()=>LOCAL});const context=resolver.buildPeopleContext([message()],{},SELF);
 const observation=[...context.sender_name_observations.values()][0];assert.equal(observation.reason,'request_failed');
 assert.equal(observation.observed_at,new Date(LOCAL).toISOString());assert.equal(observation.route_failures.routes.length,2);
 for(const route of observation.route_failures.routes){assert.equal(route.status,'failed');assert.equal(route.observed_at,new Date(LOCAL).toISOString());
  assert.equal(route.failure.version,2);assert.equal(route.failure.kind,'permission_denied');assert.equal(route.failure.code,210508);
  assert.equal(route.failure.execution.remote_result,true);assert.equal(route.failure.execution.result_at_ms,RESULT);}
});

test('later local retry diagnosis retains its own clock and the independent earlier actual result',()=>{
 let wall=RESULT,botsStarted=0;const run=createLarkCliRunner({state:createTransportState(),clock:()=>wall,monotonicClock:()=>0,
  readSharedCooldown({operation}){if(operation==='chat_bots'&&botsStarted){wall=LOCAL;return {state:'unavailable'};}return {state:'ready'};},
  spawn(_cmd,args){if(transportOperation(args)==='application_info')return output(1,deny);
   botsStarted++;return {status:null,pid:4321,error:{code:'ETIMEDOUT'},stdout:'',stderr:''};}});
 const resolver=createNameResolver({run,now:()=>wall});const context=resolver.buildPeopleContext([message()],{retries:1,retryDelayMs:0},SELF);
 const observation=[...context.sender_name_observations.values()][0],fallback=observation.route_failures.routes[1];
 assert.equal(botsStarted,1);assert.equal(fallback.failure.kind,'unknown');assert.equal(fallback.observed_at,new Date(LOCAL).toISOString());
 assert.equal(fallback.failure.execution.result_kind,'network_timeout');assert.equal(fallback.failure.execution.result_at_ms,RESULT);
 assert.equal(fallback.failure.execution.remote_result,false);assert.equal(observation.observed_at,new Date(RESULT).toISOString(),'earlier primary route clock is unchanged');
});

for(const [label,flags,expectedCode,remote]of [
 ['direct unknown code',{code:123456},123456,true],['declared ok false',{ok:false},null,false],
 ['declared success false',{success:false},null,false],['local error',{error:{type:'local',code:210508}},null,false],
 ['string code',{code:'210508'},null,false],['negative code',{code:-1},null,false],
 ['unsafe code',{code:Number.MAX_SAFE_INTEGER+1},null,false],
 ['typed API string code',{error:{type:'api',code:'210508'}},null,true],
 ['untyped error',{error:{code:210508}},null,false],
 ['code0 plus failure',{code:0,ok:false},null,false],
 ['unknown code with denial prose',{code:123456,msg:'permission denied'},123456,true],
])for(const status of [0,1])test(`${label} at exit ${status} cannot adopt an adjacent app name or fabricate permission`,()=>{
 const payload={...flags,app:{app_id:APP,app_name:'Invented Must Not Be Adopted'}};
 const run=createLarkCliRunner({state:createTransportState(),clock:()=>RESULT,monotonicClock:()=>0,spawn:()=>output(status,payload)});
 const error=capture(()=>run(args));const execution=readLarkExecutionReceipt(error,'application_info').value;
 assert.equal(execution.execution,'started');assert.equal(execution.result_kind,'unknown');assert.equal(execution.result_code,expectedCode);assert.equal(execution.remote_result,remote);
 const resolver=createNameResolver({run,now:()=>LOCAL});const context=resolver.buildPeopleContext([message()],{},SELF);
 assert.equal(context.apps.has(APP),false);assert.equal(context.app_fallbacks.size,0);
 const observation=[...context.sender_name_observations.values()][0];assert.equal(observation.status,'failed');assert.equal(observation.reason,'request_failed');
 assert.equal(observation.failure.execution.result_kind,'unknown');assert.notEqual(observation.failure.code,210508);
});

for(const status of [0,1])test(`direct numeric API denial at exit ${status} supplies precise response evidence`,()=>{
 const run=createLarkCliRunner({state:createTransportState(),clock:()=>RESULT,monotonicClock:()=>0,
  spawn:()=>output(status,{code:210508,msg:'Invented denial',app:{app_id:APP,app_name:'Invented Must Not Be Adopted'}})});
 const error=capture(()=>run(args));const receipt=readLarkExecutionReceipt(error,'application_info').value;
 assert.equal(receipt.result_kind,'permission_denied');assert.equal(receipt.result_code,210508);assert.equal(receipt.remote_result,true);
});

test('numeric code0 success still adopts its exact application name once',()=>{
 let calls=0;const run=createLarkCliRunner({state:createTransportState(),clock:()=>RESULT,monotonicClock:()=>0,
  spawn(){calls++;return output(0,{code:0,app:{app_id:APP,app_name:'Invented Legitimate App'}});}});
 const context=createNameResolver({run,now:()=>LOCAL}).buildPeopleContext([message()],{},SELF);
 assert.equal(context.apps.get(APP),'Invented Legitimate App');assert.equal(calls,1);
 const observation=[...context.sender_name_observations.values()][0];assert.equal(observation.status,'resolved');
 assert.equal(observation.observed_at,new Date(RESULT).toISOString(),'successful result retains actual acquisition clock');
});

for(const value of [[{code:210508,label:'invented array item'}],[{error:{type:'api',code:210508}}],
 JSON.stringify({code:210508}),42,true])test(`successful non-object root remains a payload (${JSON.stringify(value)})`,()=>{
 let receipt;const run=createLarkCliRunner({state:createTransportState(),clock:()=>RESULT,monotonicClock:()=>0,spawn:()=>output(0,value)});
 assert.deepEqual(run(args,{onExecutionReceipt:value=>{receipt=value;}}),value);
 assert.equal(receipt.result_kind,'success');assert.equal(receipt.result_code,null);assert.equal(receipt.remote_result,false);
});

for(const status of [0,1])for(const stdout of [{},{code:0,app:{app_id:APP,app_name:'Invented Must Not Hide Stderr'}}])
 test(`stderr API failure is independent of a successful stdout root at exit ${status}`,()=>{
 const run=createLarkCliRunner({state:createTransportState(),clock:()=>RESULT,monotonicClock:()=>0,
  spawn:()=>({...output(status,stdout),stderr:JSON.stringify(deny)})});
 const error=capture(()=>run(args));const receipt=readLarkExecutionReceipt(error,'application_info').value;
 assert.equal(receipt.result_kind,'permission_denied');assert.equal(receipt.result_code,210508);assert.equal(receipt.remote_result,true);
 assert.match(error.message,/kind=permission_denied code=210508/);
});

for(const [stderr,kind,code,remote]of [
 [{error:{type:'api',code:2200,message:'Internal Error'}},'internal_error',2200,true],
 [{error:{type:'api',code:'210508'}},'unknown',null,true],
 [{ok:false},'unknown',null,false],
])test(`two declared failures use only stderr's own ${kind}/${code} evidence`,()=>{
 const run=createLarkCliRunner({state:createTransportState(),clock:()=>RESULT,monotonicClock:()=>0,
  spawn:()=>({...output(0,deny),stderr:JSON.stringify(stderr)})});
 const error=capture(()=>run(args,{retries:0}));const receipt=readLarkExecutionReceipt(error,'application_info').value;
 assert.equal(receipt.result_kind,kind);assert.equal(receipt.result_code,code);assert.equal(receipt.remote_result,remote);
 assert.match(error.message,new RegExp(`kind=${kind}(?: |$)`));if(code===null)assert.doesNotMatch(error.message,/(?:^| )code=210508(?: |$)/);
});


for(const [code,kind]of [[210508,'permission_denied'],[231203,'restricted_mode'],[230002,'bot_user_out_of_chat']])
 for(const prose of ['TLS handshake timeout','Restricted Mode','too many requests'])for(const status of [0,1])
 test(`finite API code ${code} wins over ${prose} at exit ${status}`,()=>{
  let calls=0;const receipts=[],state=createTransportState();
  const run=createLarkCliRunner({state,clock:()=>RESULT,monotonicClock:()=>0,
   sleep:()=>assert.fail('known denial cannot enter transient retry'),spawn(){calls++;return output(status,{error:{type:'api',code,message:prose}});}});
  const error=capture(()=>run(args,{retries:1,retryDelayMs:0,onExecutionReceipt:value=>receipts.push(value)}));
  const receipt=readLarkExecutionReceipt(error,'application_info').value;
  assert.equal(calls,1);assert.equal(getTransportStats(state,RESULT).retries,0);assert.equal(receipts.length,1);
  assert.equal(receipt.result_kind,kind);assert.equal(receipt.result_code,code);assert.equal(receipt.remote_result,true);
  assert.match(error.message,new RegExp(`kind=${kind} code=${code}(?: |$)`));
 });
