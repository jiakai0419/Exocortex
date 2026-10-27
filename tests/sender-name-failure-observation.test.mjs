import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNameResolver} from '../src/adapters/lark-im/name-resolver.mjs';
import {nameLookupFailure,sanitizeSenderNameObservation} from '../src/adapters/lark-im/sender-name-observation.mjs';
import {normalizeApiMessage} from '../src/adapters/lark-im/raw-message.mjs';
import {recordFromMessage} from '../src/adapters/lark-im/message-record.mjs';
import {bindAcquiredMessageAccounts} from '../src/adapters/lark-im/message-account-evidence.mjs';
import {recipientAccountKey} from '../src/adapters/lark-im/p2p-recipient.mjs';
import {ensureInitialized,sqliteExec,sqliteQuery,quoteSql,upsertRecordsSql} from '../dist/storage/sqlite/ingestion-store.js';

// Only authored identities, source records and public finite error descriptors.
const SELF={open_id:'ou_synthetic_error_owner',name:'Invented Error Owner'},APP='cli_synthetic_error_app';
const CHAT='oc_synthetic_error_room',ACTOR='ou_synthetic_error_person',ACCOUNT=recipientAccountKey(SELF.open_id);
const AT=Date.parse('2025-01-01T00:00:00.000Z'), OBSERVED='2025-01-01T00:01:00.000Z';
const SOURCES={contact_search:'contact',chat_members:'chat_member',application_info:'application_api',chat_bots:'chat_bot_app_id'};
const canonical=row=>JSON.parse(row.canonical_json);
function source(app=true) { return {message_id:'om_synthetic_error_message',chat_id:CHAT,chat_type:'group',msg_type:'text',
  create_time:String(AT),update_time:String(AT+1),sender:{id:app?APP:ACTOR,id_type:app?'app_id':'open_id',sender_type:app?'app':'user'},
  body:{content:JSON.stringify({text:'Invented failure preservation body.'})}}; }
function prepared(operation='application_info',descriptor='kind=permission_denied code=210508',opts={}) {
  const app=['application_info','chat_bots'].includes(operation),native=source(app),calls=[];
  const resolver=createNameResolver({now:()=>Date.parse(OBSERVED),run(args){
    const called=args[0]==='contact'?'contact_search':args[0]==='api'?'application_info':args[2]==='get'?'chat_members':'chat_bots';
    calls.push(called);
    if(called===operation)throw new Error(descriptor.startsWith('PRIVATE')?descriptor:`lark-cli failed: ${descriptor} operation=${operation}`);
    return called==='contact_search'?{users:[]}:called==='application_info'?{app:{app_id:APP}}:{items:[]};
  }});
  const message=normalizeApiMessage(native),context=resolver.buildPeopleContext([message],opts,SELF);
  const row=recordFromMessage(message,'lark.im.sent_by_me','received',context,{chat_id:CHAT,chat_type:'group',chat_name:'Invented Error Room'});
  return {row,message,calls,resolver,context};
}
function plain(message=normalizeApiMessage(source())) {
  return recordFromMessage(message,'lark.im.sent_by_me','received',{}, {chat_id:CHAT,chat_type:'group',chat_name:'Invented Error Room'});
}
function fixture(t,initial) {
  const dir=mkdtempSync(join(tmpdir(),'exocortex-safe-name-failure-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=join(dir,'synthetic.sqlite');ensureInitialized(db);
  const write=row=>sqliteExec(db,upsertRecordsSql([row]));
  const read=()=>sqliteQuery(db,'SELECT * FROM records;')[0];
  write(initial);sqliteExec(db,"UPDATE records SET updated_at='2000-01-01T00:00:00.000Z';");
  return {db,write,read};
}

for(const operation of Object.keys(SOURCES)) for(const [descriptor,kind,code,stage] of [
  ['kind=permission_denied code=210508','permission_denied',210508,'response_error'],
  ['kind=unknown code=10014','unknown',10014,'response_error'],
  ['kind=network_timeout timeout_ms=5000','network_timeout',null,'request_error'],
]) test(`${operation} preserves only safe ${kind}/${code} in the actual selected canonical observation`,()=>{
  const f=prepared(operation,descriptor),observation=canonical(f.row).sender_name_verification;
  assert.equal(observation.status,'failed');assert.equal(observation.reason,'request_failed');
  assert.equal(observation.source,SOURCES[operation]);assert.equal(observation.account_key,ACCOUNT);
  assert.deepEqual(observation.failure,{version:1,operation,kind,code,stage});
  assert.equal(observation.observed_at,OBSERVED);assert.equal(observation.cached,false);
  assert.equal(canonical(f.row).sender_name,null);assert.equal(canonical(f.row).sender_name_account_key,undefined);
});

test('private exception prose and forged descriptor fields never become classified authority or stored text',()=>{
  const f=prepared('application_info','PRIVATE kind=permission_denied code=210508 cli_hidden_identity');
  assert.deepEqual(canonical(f.row).sender_name_verification.failure,
    {version:1,operation:'application_info',kind:'unknown',code:null,stage:'unknown'});
  assert.doesNotMatch(f.row.canonical_json,/PRIVATE|cli_hidden_identity/);
  for(const descriptor of ['lark-cli failed: kind=permission_denied code=210508 operation=contact_search',
    'lark-cli failed: kind=permission_denied code=210508 target=PRIVATE operation=application_info']) {
    assert.equal(nameLookupFailure(new Error(descriptor),'application_info').kind,'unknown');
    assert.equal(nameLookupFailure(new Error(descriptor),'application_info').code,null);
  }
});

test('budget and admission skips remain distinguishable from executed response failures',()=>{
  const budget=prepared('application_info','kind=permission_denied code=210508',{nameLookupDeadlineMs:0});
  assert.equal(budget.calls.length,0);
  const observation=canonical(budget.row).sender_name_verification;
  assert.equal(observation.reason,'budget_exhausted');assert.equal(observation.failure.stage,'not_requested');
  assert.equal(observation.failure.kind,'budget_exhausted');assert.equal(observation.failure.code,null);
  const skipped=prepared('application_info','kind=permission_denied code=210508',{nameRouteAdmission:()=>false});
  assert.equal(skipped.calls.length,0);assert.equal(canonical(skipped.row).sender_name_verification,undefined);
  assert.equal(nameLookupFailure(new Error('lark-cli failed: kind=rate_limited retry_after_source=shared operation=application_info retry_exhausted=1'),
    'application_info').stage,'not_requested');
});

test('new optional failure envelope has a strict source/operation/type/field whitelist',()=>{
  const observation=canonical(prepared().row).sender_name_verification;
  for(const failure of [{...observation.failure,version:'1'},{...observation.failure,operation:'chat_bots'},
    {...observation.failure,kind:'PRIVATE'}, {...observation.failure,code:'210508'},
    {...observation.failure,code:-1},{...observation.failure,code:Number.MAX_SAFE_INTEGER+1},
    {...observation.failure,stage:'not_requested'},{...observation.failure,private_error:'PRIVATE'}]) {
    const clean=sanitizeSenderNameObservation({...observation,failure});assert.equal(clean.failure,undefined);
    assert.doesNotMatch(JSON.stringify(clean),/PRIVATE/);
  }
  assert.equal(sanitizeSenderNameObservation({...observation,status:'resolved'}).failure,undefined);
});

test('exact no-query replay retains a failed diagnostic without an adopted name, without renewing either clock',t=>{
  const original=prepared().row;
  const [bound]=bindAcquiredMessageAccounts([original],SELF,{acquiredAt:OBSERVED});
  assert(canonical(bound).message_account_evidence);
  const f=fixture(t,bound),before=f.read();f.write(plain());const after=f.read();
  assert.deepEqual(after,before);
  assert.equal(canonical(after).sender_name_account_key,undefined);
  assert.equal(canonical(after).sender_name,null);
  const changed=prepared('application_info','kind=unknown code=10014').row;
  f.write(changed);const latest=f.read();
  assert.equal(canonical(latest).sender_name_verification.failure.code,10014);
  assert.notEqual(latest.updated_at,before.updated_at);
  for(const key of ['raw_json','body','external_version','content_hash','actor_id','container_id','occurred_at','occurred_at_ms'])
    assert.equal(latest[key],before[key],key);
});

for(const mode of ['foreign_account','changed_source','explicit_clear','no_account_anchor','malformed_failure']) {
  test(`failed no-name diagnosis cannot cross ${mode}`,t=>{
    let [old]=bindAcquiredMessageAccounts([prepared().row],SELF,{acquiredAt:OBSERVED});
    let incoming=plain();
    if(mode==='foreign_account') [incoming]=bindAcquiredMessageAccounts([incoming],{open_id:'ou_synthetic_other_account'},{acquiredAt:OBSERVED});
    if(mode==='changed_source') {const native=source();native.update_time=String(AT+2);native.body.content=JSON.stringify({text:'Invented new source version.'});incoming=plain(normalizeApiMessage(native));}
    if(mode==='explicit_clear') incoming.canonical_json=JSON.stringify({...canonical(incoming),sender_name_state:'cleared'});
    if(mode==='no_account_anchor') {const value=canonical(old);delete value.message_account_evidence;old={...old,canonical_json:JSON.stringify(value)};}
    if(mode==='malformed_failure') {const value=canonical(old);value.sender_name_verification.failure.extra='PRIVATE';old={...old,canonical_json:JSON.stringify(value)};}
    const f=fixture(t,old);f.write(incoming);
    assert.equal(canonical(f.read()).sender_name_verification,undefined);
    assert.equal(canonical(f.read()).sender_name_account_key,undefined);
  });
}
