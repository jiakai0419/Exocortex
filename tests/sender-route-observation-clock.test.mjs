import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNameResolver} from '../src/adapters/lark-im/name-resolver.mjs';
import {readSenderNameRouteFailures,sanitizeSenderNameObservation} from '../src/adapters/lark-im/sender-name-observation.mjs';
import {normalizeApiMessage} from '../src/adapters/lark-im/raw-message.mjs';
import {recordFromMessage} from '../src/adapters/lark-im/message-record.mjs';
import {bindAcquiredMessageAccounts} from '../src/adapters/lark-im/message-account-evidence.mjs';
import {recipientAccountKey} from '../src/adapters/lark-im/p2p-recipient.mjs';
import {ensureInitialized,sqliteExec,sqliteQuery,upsertRecordsSql} from '../dist/storage/sqlite/ingestion-store.js';

const AT=Date.parse('2025-05-01T10:00:00Z'),SELF={open_id:'ou_invented_clock_owner',name:'Invented Clock Owner'};
const APP='cli_invented_clock_app',CHAT='oc_invented_clock_room',ACCOUNT=recipientAccountKey(SELF.open_id);
const binding={account_key:ACCOUNT,actor_id:APP,namespace:'app_id',chat_id:CHAT};
const iso=value=>new Date(value).toISOString(),copy=value=>JSON.parse(JSON.stringify(value)),canonical=row=>JSON.parse(row.canonical_json);
function message(){return normalizeApiMessage({message_id:'om_invented_clock_message',chat_id:CHAT,chat_type:'group',msg_type:'text',
  create_time:String(AT),update_time:String(AT+1),sender:{id:APP,id_type:'app_id',sender_type:'app'},
  body:{content:JSON.stringify({text:'Invented route clock preservation body.'})}});}
function record(context={}){return recordFromMessage(message(),'lark.im.sent_by_me','received',context,
  {chat_id:CHAT,chat_type:'group',chat_name:'Invented Clock Room'});}
function produce(mode='timeout',offset=0){
  let clock=AT+offset;const calls=[];
  const resolver=createNameResolver({now:()=>clock,run(args){
    const operation=args[0]==='api'?'application_info':'chat_bots';calls.push(operation);
    clock=AT+offset+(operation==='application_info'?100:300);
    if(operation==='application_info'&&mode==='primary_unresolved')return {app:{app_id:APP}};
    if(operation==='chat_bots'&&mode==='empty')return {items:[]};
    if(operation==='chat_bots'&&mode==='timeout')throw Error('lark-cli failed: kind=network_timeout operation=chat_bots timeout_ms=5000');
    throw Error(`lark-cli failed: kind=permission_denied code=210508 operation=${operation}`);
  }});
  const options=mode==='skip'?{nameRouteAdmission:({operation})=>{
    if(operation==='chat_bots'){clock=AT+offset+200;return false;}return true;
  }}:{};
  const context=resolver.buildPeopleContext([message()],options,SELF),row=record(context);
  return {row,calls,observation:canonical(row).sender_name_verification};
}
function fixture(t,old){
  const dir=mkdtempSync(join(tmpdir(),'exocortex-invented-route-clock-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=join(dir,'synthetic.sqlite');ensureInitialized(db);
  const write=value=>sqliteExec(db,upsertRecordsSql([value])),read=()=>sqliteQuery(db,'SELECT * FROM records;')[0];
  write(old);sqliteExec(db,"UPDATE records SET updated_at='2000-01-01T00:00:00.000Z';");return {write,read};
}
function bound(row){return bindAcquiredMessageAccounts([row],SELF,{acquiredAt:iso(AT+50)})[0];}

for(const mode of ['timeout','empty','permission','primary_unresolved'])test(`v2 captures actual ${mode} route clocks independently`,()=>{
  const {observation,calls}=produce(mode),envelope=readSenderNameRouteFailures(observation,binding);
  assert(envelope);assert.equal(envelope.version,2);
  assert.deepEqual(envelope.routes.map(value=>value.observed_at),[iso(AT+100),iso(AT+300)]);
  assert.equal(observation.observed_at,iso(AT+(mode==='primary_unresolved'?300:100)));
  assert.deepEqual(calls,['application_info','chat_bots']);
  assert.equal(envelope.routes[1].status,mode==='empty'?'unresolved':'failed');
});

test('admission skip records its own decision time without claiming an API response',()=>{
  const {observation,calls}=produce('skip'),envelope=readSenderNameRouteFailures(observation,binding);
  assert(envelope);assert.equal(observation.observed_at,iso(AT+100));
  assert.deepEqual(envelope.routes[1],{operation:'chat_bots',status:'not_requested',observed_at:iso(AT+200),failure:null});
  assert.deepEqual(calls,['application_info']);
});

test('unknown route has no clock, and v1 remains unchanged legacy cohort data',()=>{
  const observation=copy(produce('primary_unresolved').observation);
  observation.route_failures.routes[0]={operation:'application_info',status:'unknown',observed_at:null,failure:null};
  const value=readSenderNameRouteFailures(observation,binding);assert(value);
  assert.equal(value.routes[0].observed_at,null);assert.equal(value.routes[1].observed_at,observation.observed_at);
  const legacy=copy(produce().observation);legacy.route_failures.version=1;
  for(const route of legacy.route_failures.routes)delete route.observed_at;
  assert.deepEqual(sanitizeSenderNameObservation(legacy,binding),legacy);
  assert.equal(readSenderNameRouteFailures(legacy,binding).version,1);
  assert(legacy.route_failures.routes.every(route=>!Object.hasOwn(route,'observed_at')));
});

test('invalid or invented v2 route clock is stripped without erasing the primary diagnostic',()=>{
  const original=produce().observation;
  for(const clock of [undefined,null,42,'PRIVATE','2025-05-01T10:00:00Z',iso(-1),iso(Date.now()+86400000)]){
    const observation=copy(original);if(clock===undefined)delete observation.route_failures.routes[1].observed_at;
    else observation.route_failures.routes[1].observed_at=clock;
    const clean=sanitizeSenderNameObservation(observation,binding);
    assert.equal(clean.route_failures,undefined);assert.deepEqual(clean.failure,original.failure);assert.doesNotMatch(JSON.stringify(clean),/PRIVATE/);
  }
  const selected=copy(original);selected.route_failures.routes[0].observed_at=iso(AT+99);
  assert.equal(readSenderNameRouteFailures(selected,binding),null);
  const unknown=copy(original);Object.assign(unknown.route_failures.routes[1],{status:'unknown',failure:null});
  assert.equal(readSenderNameRouteFailures(unknown,binding),null,'unknown cannot borrow a real route clock');
  const v1=copy(original);v1.route_failures.version=1;
  assert.equal(readSenderNameRouteFailures(v1,binding),null,'v1 cannot hide v2 timestamps behind its smaller whitelist');
});

for(const version of [1,2])test(`real storage preserves v${version} source and clock bytes on exact no-query replay`,t=>{
  const initial=produce().row;
  if(version===1){const value=canonical(initial);value.sender_name_verification.route_failures.version=1;
    for(const route of value.sender_name_verification.route_failures.routes)delete route.observed_at;
    initial.canonical_json=JSON.stringify(value);}
  const f=fixture(t,bound(initial)),before=f.read();f.write(record());assert.deepEqual(f.read(),before);
  assert.equal(canonical(f.read()).sender_name_verification.route_failures.version,version);
  const renewed=produce('permission',1000).row;f.write(renewed);const after=f.read();
  assert.equal(canonical(after).sender_name_verification.route_failures.version,2);
  assert.deepEqual(canonical(after).sender_name_verification.route_failures.routes.map(value=>value.observed_at),[iso(AT+1100),iso(AT+1300)]);
  assert.notEqual(after.updated_at,before.updated_at);
  for(const key of ['body','raw_json','content_hash','external_version','actor_id','container_id','occurred_at','occurred_at_ms'])assert.equal(after[key],before[key],key);
});

for(const mode of ['missing_clock','future_clock','malformed_clock','hour_24','invalid_calendar_date','selected_clock_mismatch','unknown_has_clock','duplicate_clock'])
  test(`real storage does not perpetuate invalid v2 ${mode}`,t=>{
    let old=bound(produce().row);const value=canonical(old),routes=value.sender_name_verification.route_failures.routes;
    if(mode==='missing_clock')delete routes[1].observed_at;
    if(mode==='future_clock')routes[1].observed_at=iso(Date.now()+86400000);
    if(mode==='malformed_clock')routes[1].observed_at='PRIVATE';
    if(mode==='hour_24')routes[1].observed_at='2025-05-01T24:00:00.000Z';
    if(mode==='invalid_calendar_date')routes[1].observed_at='2025-02-30T10:00:00.000Z';
    if(mode==='selected_clock_mismatch')routes[0].observed_at=iso(AT+99);
    if(mode==='unknown_has_clock')Object.assign(routes[1],{status:'unknown',failure:null});
    old={...old,canonical_json:JSON.stringify(value)};
    if(mode==='duplicate_clock')old.canonical_json=old.canonical_json.replace(`"observed_at":"${iso(AT+300)}"`,
      `"observed_at":"${iso(AT+300)}","observed_at":"${iso(AT+300)}"`);
    const f=fixture(t,old);f.write(record());assert.equal(canonical(f.read()).sender_name_verification,undefined);
    assert.equal(canonical(f.read()).sender_name_account_key,undefined);
  });

test('reader applies one explicit as-of clock to each v2 route without using a hidden wall clock',()=>{
  const observation=produce().observation;
  assert.equal(readSenderNameRouteFailures(observation,binding,AT+200),null,'fallback is future relative to caller as-of');
  assert(readSenderNameRouteFailures(observation,binding,AT+300));
  assert.equal(readSenderNameRouteFailures(observation,binding,NaN),null);
  assert.equal(sanitizeSenderNameObservation(observation,binding,AT+200).route_failures,undefined);
  assert.deepEqual(sanitizeSenderNameObservation(observation,binding,AT+300),observation);
});
