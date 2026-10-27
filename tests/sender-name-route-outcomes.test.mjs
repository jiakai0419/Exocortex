import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNameResolver} from '../src/adapters/lark-im/name-resolver.mjs';
import {readSenderNameRouteFailures,sanitizeSenderNameObservation,senderNameRouteTargetKey} from '../src/adapters/lark-im/sender-name-observation.mjs';
import {normalizeApiMessage} from '../src/adapters/lark-im/raw-message.mjs';
import {recordFromMessage} from '../src/adapters/lark-im/message-record.mjs';
import {bindAcquiredMessageAccounts} from '../src/adapters/lark-im/message-account-evidence.mjs';
import {recipientAccountKey} from '../src/adapters/lark-im/p2p-recipient.mjs';
import {ensureInitialized,sqliteExec,sqliteQuery,upsertRecordsSql} from '../dist/storage/sqlite/ingestion-store.js';

const SELF={open_id:'ou_invented_route_owner',name:'Invented Route Owner'}, APP='cli_invented_route_app', CHAT='oc_invented_route_room';
const ACCOUNT=recipientAccountKey(SELF.open_id), AT=Date.parse('2025-04-01T10:01:00.000Z');
const binding={account_key:ACCOUNT,actor_id:APP,namespace:'app_id',chat_id:CHAT};
const decode=row=>JSON.parse(row.canonical_json);
const native=(chat=CHAT)=>({message_id:`om_invented_route_${chat}`,chat_id:chat,chat_type:'group',msg_type:'text',create_time:String(AT-60000),update_time:String(AT-1),
  sender:{id:APP,id_type:'app_id',sender_type:'app'},body:{content:JSON.stringify({text:'Invented route outcome message.'})}});
const message=(chat=CHAT)=>normalizeApiMessage(native(chat));
const deny=operation=>new Error(`lark-cli failed: kind=permission_denied code=210508 operation=${operation}`);
function producer(mode='permission',options={}) {
  const calls=[];
  const resolver=createNameResolver({now:()=>AT,run(args){
    const operation=args[0]==='api'?'application_info':'chat_bots';calls.push(operation);
    if(operation==='application_info')throw deny(operation);
    if(mode==='permission')throw deny(operation);
    if(mode==='timeout')throw new Error('lark-cli failed: kind=network_timeout operation=chat_bots timeout_ms=5000');
    if(mode==='unknown')throw new Error('lark-cli failed: kind=unknown code=10014 operation=chat_bots');
    if(mode==='malformed')return {unexpected:'ignored private result'};
    if(mode==='success')return {items:[{app_id:APP,name:'Invented Fallback Name'}]};
    return {items:[]};
  }});
  const context=resolver.buildPeopleContext([message()],{...(mode==='skip'?{nameRouteAdmission:route=>route.operation!=='chat_bots'}:{}),...options},SELF);
  const row=recordFromMessage(message(),'lark.im.sent_by_me','received',context,{chat_id:CHAT,chat_type:'group',chat_name:'Invented Route Room'});
  return {resolver,calls,context,row,observation:decode(row).sender_name_verification};
}
const plain=(msg=message())=>recordFromMessage(msg,'lark.im.sent_by_me','received',{}, {chat_id:CHAT,chat_type:'group',chat_name:'Invented Route Room'});
function fixture(t,row) {
  const dir=mkdtempSync(join(tmpdir(),'exocortex-invented-route-outcomes-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=join(dir,'synthetic.sqlite');ensureInitialized(db);
  const write=record=>sqliteExec(db,upsertRecordsSql([record]));const read=()=>sqliteQuery(db,'SELECT * FROM records;')[0];
  write(row);sqliteExec(db,"UPDATE records SET updated_at='2000-01-01T00:00:00.000Z';");return {write,read};
}

for (const [mode,status,kind] of [['permission','failed','permission_denied'],['timeout','failed','network_timeout'],
  ['skip','not_requested',null],['empty','unresolved',null],['unknown','failed','unknown'],['malformed','failed',null]]) {
  test(`primary permission and fallback ${mode} retain distinct exact-attempt outcomes`,()=>{
    const result=producer(mode),envelope=readSenderNameRouteFailures(result.observation,binding);
    assert(envelope);assert.equal(envelope.account_key,ACCOUNT);assert.equal(envelope.target_key,senderNameRouteTargetKey(ACCOUNT,APP,CHAT));
    assert.match(envelope.attempt_key,/^[0-9a-f]{64}$/);assert.equal(result.observation.failure.code,210508);
    assert.deepEqual(envelope.routes[0],{operation:'application_info',status:'failed',failure:result.observation.failure});
    assert.equal(envelope.routes[1].status,status);assert.equal(envelope.routes[1].failure?.kind??null,kind);
    assert.deepEqual(result.calls,mode==='skip'?['application_info']:['application_info','chat_bots']);
    assert.equal(envelope.routes.every(route=>route.status==='failed' && route.failure?.kind==='permission_denied'
      && route.failure.code===210508 && route.failure.stage==='response_error'),mode==='permission');
    assert.equal(decode(result.row).sender_name_account_key,undefined);assert.equal(decode(result.row).sender_name,null);
  });
}

test('successful exact fallback remains adopted and carries no failed-route schema',()=>{
  const result=producer('success');assert.equal(result.observation.status,'resolved');
  assert.equal(result.observation.source,'chat_bot_app_id');assert.equal(result.observation.route_failures,undefined);
  assert.equal(decode(result.row).sender_name,'Invented Fallback Name');assert.equal(result.observation.account_key,ACCOUNT);
});

test('budget absence is not a response failure and no-context direct calls cannot combine past routes',()=>{
  const result=producer('permission',{nameLookupDeadlineMs:0});assert.equal(result.calls.length,0);
  const envelope=readSenderNameRouteFailures(result.observation,binding);assert(envelope);
  for(const route of envelope.routes)assert.equal(route.failure.stage,'not_requested');
  const resolver=producer().resolver;
  resolver.resolveApplicationNames([APP],{});
  resolver.resolveChatBotAppFallbackNames(new Map([[CHAT,new Set([APP])]]),new Map(),{});
  assert.equal(resolver.senderNameObservation(APP,CHAT,'app_id').route_failures,undefined);
});

test('attempt and target bindings prevent reuse across calls, accounts, actors, namespaces and chats',()=>{
  const result=producer(),first=result.observation;
  const second=result.resolver.buildPeopleContext([message()],{nameRouteAdmission:route=>route.operation!=='chat_bots'},SELF)
    .sender_name_observations.get(JSON.stringify([CHAT,APP,'app_id']));
  assert.notEqual(second.route_failures.attempt_key,first.route_failures.attempt_key);
  assert.equal(second.route_failures.routes[1].status,'not_requested');assert.equal(second.route_failures.routes[1].failure,null);
  for(const change of [{account_key:'a'.repeat(64)},{actor_id:'cli_invented_other'},{namespace:'open_id'},{chat_id:'oc_invented_other'}])
    assert.equal(readSenderNameRouteFailures(first,{...binding,...change}),null);
  const third=result.resolver.buildPeopleContext([message()],{}, {open_id:'ou_invented_second_owner',name:'Invented Other Owner'})
    .sender_name_observations.get(JSON.stringify([CHAT,APP,'app_id']));
  assert.notEqual(third.route_failures.account_key,first.route_failures.account_key);
  assert.notEqual(third.route_failures.target_key,first.route_failures.target_key);
});

test('same-batch shared app outcome cannot borrow another chat fallback',()=>{
  const OTHER='oc_invented_other_route',calls=[];
  const resolver=createNameResolver({now:()=>AT,run(args){
    if(args[0]==='api')throw deny('application_info');
    const chat=JSON.parse(args[args.indexOf('--params')+1]).chat_id;calls.push(chat);
    if(chat===CHAT)throw deny('chat_bots');return {items:[]};
  }});
  const ctx=resolver.buildPeopleContext([message(),message(OTHER)],{},SELF);
  const first=ctx.sender_name_observations.get(JSON.stringify([CHAT,APP,'app_id']));
  const second=ctx.sender_name_observations.get(JSON.stringify([OTHER,APP,'app_id']));
  assert.equal(first.route_failures.attempt_key,second.route_failures.attempt_key);
  assert.notEqual(first.route_failures.target_key,second.route_failures.target_key);
  assert.equal(first.route_failures.routes[1].failure.kind,'permission_denied');
  assert.equal(second.route_failures.routes[1].status,'unresolved');assert.deepEqual(calls,[CHAT,OTHER]);
});

test('strict companion sanitizer rejects malformed, foreign and private fields but retains primary diagnosis',()=>{
  const observation=producer().observation;
  const variants=[null,[],{}, {...observation.route_failures,extra:'PRIVATE'}, {...observation.route_failures,version:'1'},
    {...observation.route_failures,account_key:'a'.repeat(64)}, {...observation.route_failures,attempt_key:'PRIVATE'},
    {...observation.route_failures,target_key:'b'.repeat(64)}, {...observation.route_failures,routes:observation.route_failures.routes.slice(0,1)},
    {...observation.route_failures,routes:[...observation.route_failures.routes].reverse()}];
  for(const routeChange of [{extra:'PRIVATE'},{operation:'contact_search'},{status:'resolved'}, {failure:{...observation.failure,operation:'chat_bots'}},
    {failure:{...observation.failure,code:'210508'}},{failure:{...observation.failure,stage:'not_requested'}}])
    variants.push({...observation.route_failures,routes:[{...observation.route_failures.routes[0],...routeChange},observation.route_failures.routes[1]]});
  for(const route_failures of variants){
    const clean=sanitizeSenderNameObservation({...observation,route_failures},binding);
    assert.equal(clean.route_failures,undefined);assert.deepEqual(clean.failure,observation.failure);assert.doesNotMatch(JSON.stringify(clean),/PRIVATE/);
  }
  assert.equal(readSenderNameRouteFailures({...observation,route_failures:undefined},binding),null);
  const ctx={...producer().context,sender_name_observations:new Map([[JSON.stringify([CHAT,APP,'app_id']),
    {...observation,route_failures:{...observation.route_failures,target_key:'b'.repeat(64)}}]])};
  const row=recordFromMessage(message(),'lark.im.sent_by_me','received',ctx,{chat_id:CHAT,chat_type:'group'});
  assert.equal(decode(row).sender_name_verification.route_failures,undefined);
  assert.deepEqual(decode(row).sender_name_verification.failure,observation.failure);
});

for(const mode of ['permission','empty','skip','timeout'])test(`real storage no-query replay preserves ${mode} envelope, body and all clocks exactly`,t=>{
  const [bound]=bindAcquiredMessageAccounts([producer(mode).row],SELF,{acquiredAt:new Date(AT).toISOString()});
  const f=fixture(t,bound),before=f.read();f.write(plain());assert.deepEqual(f.read(),before);
  assert.equal(decode(f.read()).sender_name_account_key,undefined);
  const fresh=producer('unknown').row;f.write(fresh);const after=f.read();
  assert.notEqual(after.updated_at,before.updated_at);assert.notEqual(decode(after).sender_name_verification.route_failures.attempt_key,
    decode(before).sender_name_verification.route_failures.attempt_key);
  for(const key of ['body','raw_json','content_hash','external_version','actor_id','container_id','occurred_at','occurred_at_ms'])assert.equal(after[key],before[key],key);
});

for(const mode of ['foreign_account','new_source','changed_route_operation','private_route_field','duplicate_route_key','scalar_route','wrong_selected_failure','null_envelope'])
  test(`real storage does not retain companion across ${mode}`,t=>{
    let [old]=bindAcquiredMessageAccounts([producer().row],SELF,{acquiredAt:new Date(AT).toISOString()});let incoming=plain();
    const value=decode(old),envelope=value.sender_name_verification.route_failures;
    if(mode==='foreign_account')[incoming]=bindAcquiredMessageAccounts([incoming],{open_id:'ou_invented_other_owner'},{acquiredAt:new Date(AT).toISOString()});
    if(mode==='new_source'){const raw=native();raw.update_time=String(AT+1);incoming=plain(normalizeApiMessage(raw));}
    if(mode==='changed_route_operation')envelope.routes[1].operation='application_info';
    if(mode==='private_route_field')envelope.routes[1].error='PRIVATE';
    if(mode==='scalar_route')envelope.routes[1]='PRIVATE';
    if(mode==='wrong_selected_failure')envelope.routes[0].failure.code=10014;
    if(mode==='null_envelope')value.sender_name_verification.route_failures=null;
    old={...old,canonical_json:JSON.stringify(value)};
    if(mode==='duplicate_route_key')old.canonical_json=old.canonical_json.replace('"operation":"chat_bots"','"operation":"chat_bots","operation":"chat_bots"');
    const f=fixture(t,old);f.write(incoming);assert.equal(decode(f.read()).sender_name_verification,undefined);
    assert.equal(decode(f.read()).sender_name_account_key,undefined);
  });
