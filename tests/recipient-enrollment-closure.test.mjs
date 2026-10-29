import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// All inputs are invented here. The optional root only permits replaying these
// exact tests against a frozen code checkout; no production database is input.
const HERE=fileURLToPath(import.meta.url), ROOT=process.env.EXOCORTEX_RECIPIENT_TEST_ROOT||dirname(dirname(HERE));
process.env.TZ='UTC';process.env.NO_COLOR='1';delete process.env.FORCE_COLOR;
const {ensureInitialized,quoteSql:q,sqliteExec,sqliteQuery,reserveInitialLarkAccount,confirmInitialLarkAccountSql}=await import(ROOT+'/dist/storage/sqlite/ingestion-store.js');
const {runCli}=await import(ROOT+'/bin/exocortex.mjs');
const {syncNames}=await import(ROOT+'/src/adapters/lark-im/name-sync.mjs');
const {prepareRecipientWork}=await import(ROOT+'/src/adapters/lark-im/recipient-sync.mjs');
const {createLarkImAdapter}=await import(ROOT+'/src/adapters/lark-im/adapter.mjs');
const {chatScopeId}=await import(ROOT+'/src/adapters/lark-im/core.mjs');
const {recipientAccountKey,makeRecipientEvidence}=await import(ROOT+'/src/adapters/lark-im/p2p-recipient.mjs');
const {nameTaskKey}=await import(ROOT+'/src/adapters/lark-im/name-evidence.mjs');
const {tryAcquireLarkApiLease}=await import(ROOT+'/src/runtime/lark-api-lease.mjs');
const {renderMessagesText}=await import(ROOT+'/src/terminal/messages-view.mjs');
const {readOnlySqliteJson}=await import(ROOT+'/src/storage/sqlite/readonly-query.mjs');
const SELF={open_id:'ou_synthetic_enrollment_owner',name:'Synthetic enrollment owner'};
const PEER='ou_synthetic_enrollment_peer', NAME='Synthetic exact recipient';
const CHAT='oc_synthetic_enrollment_private', DRIVER='oc_synthetic_enrollment_driver';
const NOW=Date.parse('2025-03-04T05:06:07.000Z'), ACCOUNT=recipientAccountKey(SELF.open_id);
const hash=value=>createHash('sha256').update(value).digest('hex');
function noNetwork(){const reject=()=>{throw new Error('synthetic enrollment test forbids network')};globalThis.fetch=reject;Socket.prototype.connect=reject;}
function fixtureRoot(dir){assert(dir.startsWith(tmpdir())&&dir.includes('/exocortex-recipient-enrollment-'));return dir;}
function api(calls,{allowDebtNames=false}={}){return (args,options={})=>{
 calls.push(args);
 if(args[0]==='contact'&&args[1]==='+get-user')return SELF;
 if(args[0]==='api'&&args[1]==='GET'&&args[2]==='/open-apis/im/v1/messages')return {code:0,data:{items:[],has_more:false}};
 if(args[0]==='api'&&args[1]==='POST'&&args[2]==='/open-apis/im/v1/chats/batch_query'){
  assert.equal(options.retries,0);
  const {chat_ids}=JSON.parse(args[args.indexOf('--data')+1]);
  assert.deepEqual(chat_ids,[CHAT]);
  return {code:0,data:{items:[{chat_id:CHAT,chat_mode:'p2p',chat_type:'private',p2p_target_type:'user',p2p_target_id:PEER}]}};
 }
 if(args[0]==='contact'&&args[1]==='+search-user'){
  const ids=args[args.indexOf('--user-ids')+1].split(',');
  if(!allowDebtNames)assert.deepEqual(ids,[PEER]);
  return {users:ids.map(open_id=>({open_id,name:open_id===PEER?NAME:'Synthetic recovered debt '+open_id}))};
 }
 throw new Error('unexpected synthetic enrollment route '+args.slice(0,3).join(' '));
};}

if(process.argv[2]==='--synthetic-prepare'){
 noNetwork();
 const dir=fixtureRoot(process.argv[3]),db=join(dir,'synthetic.sqlite'),calls=[];
 const work=prepareRecipientWork(db,SELF,{runLark:api(calls),now:()=>Number(process.argv[4]),monotonicNow:()=>0});
 console.log(JSON.stringify({pending:work.pending,freshOrder:work.freshOrder,calls:calls.length,pid:process.pid}));
}else if(process.argv[2]==='--synthetic-cycle'){
 noNetwork();
 const dir=fixtureRoot(process.argv[3]),db=join(dir,'synthetic.sqlite'),at=Number(process.argv[4]),calls=[];
 const remote=api(calls),adapter=createLarkImAdapter({run:remote});
 let stdout='',stderr='',report=null,leaseAcquired=false;
 const code=await runCli(['sync','--db',db,'--scope','received','--start',new Date(NOW-60000).toISOString(),
  '--end',new Date(NOW+60000).toISOString(),'--received-scopes-per-run','1','--max-pages','1','--format','json'],{
  stdout:{write:s=>stdout+=s},stderr:{write:s=>stderr+=s},deps:{getSelfProfile:adapter.getSelfProfile,
   syncRunnerDeps:{...adapter,syncNames:(path,self)=>{report=syncNames(path,self,{runLark:remote,now:()=>at});return report;}},
   tryAcquireLarkApiLease:opts=>{const lease=tryAcquireLarkApiLease(opts,{directory:join(dir,'api-state')});leaseAcquired=lease.state==='acquired';return lease;}}});
 console.log(JSON.stringify({code,stdout,stderr,report,leaseAcquired,calls,pid:process.pid}));
}else{
 function fixture(t,{background=40,offset=0,scopeType='p2p',rawType='p2p',actor=SELF.open_id,driver=true}={}){
  const dir=mkdtempSync(join(tmpdir(),'exocortex-recipient-enrollment-')),db=join(dir,'synthetic.sqlite');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));ensureInitialized(db);
  reserveInitialLarkAccount(db,ACCOUNT,new Date(NOW).toISOString());sqliteExec(db,confirmInitialLarkAccountSql(new Date(NOW).toISOString()));
  const statements=[];
  if(driver)statements.push(`INSERT INTO sync_scopes(id,source_id,name,enabled,config_json) VALUES(${q(chatScopeId(DRIVER))},'lark.im','Synthetic empty driver',1,${q(JSON.stringify({chat_id:DRIVER,chat_type:'group',chat_name:'Synthetic driver'}))});`);
  statements.push(`INSERT INTO sync_scopes(id,source_id,name,enabled,config_json) VALUES(${q(chatScopeId(CHAT))},'lark.im','Synthetic private scope',0,${q(JSON.stringify({chat_id:CHAT,chat_type:scopeType,chat_name:'A title is not a person'}))});`);
  const targetId=offset+background+1;
  for(let id=offset+1;id<=offset+background*2+1;id++){
   const target=id===targetId,chat=target?CHAT:`oc_synthetic_enrollment_received_${id}`,sender=target?actor:`ou_synthetic_enrollment_received_${id}`;
   const text=`Invented enrollment message ${id}; spacing  stays.`,at=NOW-10000+id;
   const raw={message_id:`om_synthetic_enrollment_${id}`,chat_id:chat,chat_type:target?rawType:'p2p',msg_type:'text',
    sender:{id:sender,id_type:'open_id',sender_type:'user',name:target?SELF.name:'Synthetic native author'},
    create_time:String(at),body:{content:JSON.stringify({text})}};
   const canonical={message_id:raw.message_id,chat_id:chat,chat_type:raw.chat_type,msg_type:'text',sender_id:sender,
    sender_id_type:'open_id',sender_type:'user',sender_name:raw.sender.name};
   if(!target)statements.push(`INSERT INTO sync_scopes(id,source_id,name,enabled,config_json) VALUES(${q(chatScopeId(chat))},'lark.im',${q('Synthetic background p2p '+id)},0,${q(JSON.stringify({chat_id:chat,chat_type:'p2p'}))});`);
   const row={id,source_id:'lark.im',first_seen_scope_id:target?'lark.im.sent_by_me':chatScopeId(chat),external_id:raw.message_id,
    external_version:String(at),record_type:'lark.im.message',occurred_at:new Date(at).toISOString(),occurred_at_ms:at,
    actor_id:sender,container_id:chat,direction:target?'sent':'received',body:text,canonical_json:JSON.stringify(canonical),raw_json:JSON.stringify(raw)};
   statements.push(`INSERT INTO records(${Object.keys(row).join(',')}) VALUES(${Object.values(row).map(q).join(',')});`);
  }
  sqliteExec(db,statements.join('\n'));
  writeFileSync(join(dir,'deny-network.mjs'),`import {Socket} from 'node:net'; const no=()=>{throw new Error('synthetic read forbids network')}; globalThis.fetch=no; Socket.prototype.connect=no;Object.defineProperty(process.stdout,'columns',{value:100});\n`);
  return {dir,db,targetId,now:NOW,calls:[]};
 }
 const query=(f,sql)=>sqliteQuery(f.db,sql,'inspect synthetic recipient closure');
 const rows=f=>query(f,'SELECT * FROM records ORDER BY id;');
 const state=f=>query(f,`SELECT * FROM lark_im_recipient_state WHERE account_key=${q(ACCOUNT)} AND chat_id=${q(CHAT)};`)[0];
 function cycle(f){const result=spawnSync(process.execPath,[HERE,'--synthetic-cycle',f.dir,String(f.now)],{cwd:f.dir,encoding:'utf8',timeout:30000,
  maxBuffer:2*1024*1024,env:{...process.env,LARK_CLI:'/usr/bin/false',TZ:'UTC',NO_COLOR:'1'}});assert.equal(result.status,0,result.stderr||result.stdout);assert.equal(result.stderr,'');
  const r=JSON.parse(result.stdout);assert.equal(r.code,0,r.stderr||r.stdout);assert.equal(r.stderr,'');assert(r.leaseAcquired);assert.equal(JSON.parse(r.stdout).ok,true);assert(r.report.calls<=4);return r;}
 function read(f){
  const before=hash(readFileSync(f.db));
  const outputs=['json','text'].map(format=>{const r=spawnSync(process.execPath,['--import',join(f.dir,'deny-network.mjs'),join(ROOT,'bin/exocortex.mjs'),'messages','--db',f.db,'--limit','100','--format',format],
   {cwd:f.dir,encoding:'utf8',timeout:15000,maxBuffer:3*1024*1024,env:{...process.env,LARK_CLI:'/usr/bin/false',TZ:'UTC',NO_COLOR:'1'}});assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');return r.stdout;});
  assert.equal(hash(readFileSync(f.db)),before,'actual messages is read-only');
  const json=JSON.parse(outputs[0]);assert.equal(outputs[1],renderMessagesText(json,{columns:100}));return {json,text:outputs[1],target:json.find(row=>row.id===f.targetId)};
 }
 const direct=(f,options)=>syncNames(f.db,SELF,{runLark:api(f.calls,options),now:()=>f.now,monotonicNow:()=>0});
 const prepare=(f,deps={})=>prepareRecipientWork(f.db,SELF,{runLark:api(f.calls),now:()=>f.now,monotonicNow:()=>0,...deps});
 function senderDebtSql(id,at=NOW-20000-id){
  const chat=`oc_synthetic_enrollment_debt_${id}`,actor=`ou_synthetic_enrollment_debt_${id}`,text=`Invented old identity debt ${id}`;
  const raw={message_id:`om_synthetic_enrollment_debt_${id}`,chat_id:chat,chat_type:'p2p',msg_type:'text',
   sender:{id:actor,id_type:'open_id',sender_type:'user'},create_time:String(at),body:{content:JSON.stringify({text})}};
  const canonical={message_id:raw.message_id,chat_id:chat,chat_type:'p2p',msg_type:'text',sender_id:actor,sender_id_type:'open_id',sender_type:'user',sender_name:null};
  return `INSERT INTO sync_scopes(id,source_id,name,enabled,config_json) VALUES(${q(chatScopeId(chat))},'lark.im',${q('Synthetic old p2p '+id)},0,${q(JSON.stringify({chat_id:chat,chat_type:'p2p'}))});
   INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,record_type,occurred_at,occurred_at_ms,actor_id,container_id,direction,body,canonical_json,raw_json)
   VALUES(${id},'lark.im',${q(chatScopeId(chat))},${q(raw.message_id)},${q(String(at))},'lark.im.message',${q(new Date(at).toISOString())},${at},${q(actor)},${q(chat)},'received',${q(text)},${q(JSON.stringify(canonical))},${q(JSON.stringify(raw))});
   INSERT INTO lark_im_name_tasks(source_id,account_key,task_key,kind,chat_id,actor_id,namespace,latest_record_id,fresh_required_record_id,serviced_record_id,enqueued_at_ms,retry_at_ms)
   VALUES('lark.im',${q(ACCOUNT)},${q(nameTaskKey('sender',chat,actor,'open_id'))},'sender',${q(chat)},${q(actor)},'open_id',${id},${id},0,${NOW-10000},${NOW-10000});`;
 }
 function sameChatRow(f,id,text){
  const original=query(f,`SELECT * FROM records WHERE id=${f.targetId};`)[0],at=NOW-1000+id;
  const raw=JSON.parse(original.raw_json),canonical=JSON.parse(original.canonical_json);
  raw.message_id=`om_synthetic_enrollment_more_${id}`;canonical.message_id=raw.message_id;raw.create_time=String(at);raw.body.content=JSON.stringify({text});
  return {...original,id,external_id:raw.message_id,external_version:String(at),occurred_at:new Date(at).toISOString(),occurred_at_ms:at,body:text,
   canonical_json:JSON.stringify(canonical),raw_json:JSON.stringify(raw)};
 }
 function appendRows(f,items){sqliteExec(f.db,items.map(row=>`INSERT INTO records(${Object.keys(row).join(',')}) VALUES(${Object.values(row).map(q).join(',')});`).join('\n'));}
 function measuredPrepare(f){
  const pages=[];
  const work=prepare(f,{readOnlyQuery:(db,sql,label,options)=>{
   const result=readOnlySqliteJson(db,sql,label,options);
   const records=result.filter(row=>Object.hasOwn(row,'raw_json')&&Object.hasOwn(row,'canonical_json'));
   if(records.length)pages.push(records.map(row=>['body','raw_json','canonical_json'].reduce((n,key)=>n+(typeof row[key]==='string'?Buffer.byteLength(row[key]):0),0)));
   return result;
  }});
  return {work,pages};
 }
 function assertPayloadBounds(pages){
  assert(pages.length>0,'actual sent-page query output was measured');
  assert(pages.every(rows=>rows.every(bytes=>bytes<=2*1024*1024)),'no oversized source payload is materialized as an identity witness');
  assert(pages.every(rows=>rows.reduce((a,b)=>a+b,0)<=2*1024*1024),'each recipient source page is at most 2 MiB');
  assert(pages.flat().reduce((a,b)=>a+b,0)<=8*1024*1024,'all recipient preparation payload shares an 8 MiB ceiling');
 }

 test('real sync CLI enrolls and resolves own private sent message between two received pages',t=>{
  const f=fixture(t),before=rows(f),old=read(f);assert(old.target.readiness.reasons.includes('recipient_identity_unknown'));
  const r=cycle(f);assert(state(f),'eligible sent target must have persisted recovery work despite both general witness pages excluding it');
  const after=read(f);assert.equal(after.target.display.recipient,NAME);assert.equal(after.target.readiness.state,'ready');
  assert.deepEqual(rows(f),before,'relationship preparation cannot rewrite source or neighbouring records');
  assert.deepEqual(after.json.map(row=>row.id),old.json.map(row=>row.id));assert.equal(r.report.calls,4);
 });
 test('recipient scan completion does not suppress later exact p2p evidence on the same stored message',t=>{
  const f=fixture(t,{background:0,scopeType:'group',rawType:'unknown',driver:false});
  sqliteExec(f.db,`INSERT INTO lark_im_recipient_scan(account_key,after_record_id,generation) VALUES(${q(ACCOUNT)},1,1);
   UPDATE sync_scopes SET config_json=${q(JSON.stringify({chat_id:CHAT,chat_type:'p2p',chat_name:'Still not a person'}))} WHERE id=${q(chatScopeId(CHAT))};`);
  const before=rows(f);const r=direct(f);assert(state(f),'completed scan still revisits changed scope evidence');
  assert.equal(read(f).target.readiness.state,'ready');assert.equal(read(f).target.display.recipient,NAME);assert.deepEqual(rows(f),before);assert(r.calls<=4);
 });
 test('new private relationship gets its real freshness order ahead of eighty older sender tasks',t=>{
  const f=fixture(t,{background:0,offset:80,driver:false});
  sqliteExec(f.db,Array.from({length:80},(_,i)=>senderDebtSql(i+1)).join('\n'));
  const before=rows(f),r=direct(f),after=read(f);
  assert(state(f),'fresh recipient work is durably enrolled before selection');
  assert.equal(after.target.display.recipient,NAME,'recipient freshness is the actual newest required source record, not zero');
  assert.equal(after.target.readiness.state,'ready');assert.deepEqual(rows(f),before);assert.equal(r.calls,4);
  assert(f.calls.every(args=>args[1]!=='+search-user'||args[args.indexOf('--user-ids')+1]===PEER),'first shared opportunity belongs to newer relationship');
 });
 test('queued unattempted private work ranks the latest same-chat witness rather than its old retry witness',t=>{
  const f=fixture(t,{background:0,driver:false}),old=rows(f)[0];
  const raw=JSON.parse(old.raw_json),canonical=JSON.parse(old.canonical_json);raw.message_id='om_synthetic_enrollment_later_same_chat';canonical.message_id=raw.message_id;
  raw.create_time=String(NOW-1);raw.body.content='{"text":"Synthetic later same-chat message"}';
  const newer={...old,id:100,external_id:raw.message_id,external_version:String(NOW-1),occurred_at:new Date(NOW-1).toISOString(),occurred_at_ms:NOW-1,
   body:'Synthetic later same-chat message',canonical_json:JSON.stringify(canonical),raw_json:JSON.stringify(raw)};
  sqliteExec(f.db,`INSERT INTO records(${Object.keys(newer).join(',')}) VALUES(${Object.values(newer).map(q).join(',')});
   INSERT INTO lark_im_recipient_state(source_id,account_key,chat_id,enqueued_at_ms,retry_at_ms) VALUES('lark.im',${q(ACCOUNT)},${q(CHAT)},${NOW-1000},${NOW-1000});`);
  const before=rows(f),work=prepare(f);assert(work.pending);assert.equal(work.freshOrder,100,'old queue witness cannot lower the actual new identity requirement');
  assert.equal(f.calls.length,0);assert.equal(work.run().reason,'completed');assert.deepEqual(rows(f),before);assert.equal(read(f).target.readiness.state,'ready');
 });
 for(const slot of [0,1,2])test(`continuous newer sender arrivals cannot postpone a fresh recipient beyond three admitted opportunities from slot ${slot}`,t=>{
  const f=fixture(t,{background:0,offset:80,driver:false});
  sqliteExec(f.db,Array.from({length:80},(_,i)=>senderDebtSql(i+1)).join('\n')+
   `INSERT INTO lark_im_name_scan(account_key,schedule_sequence,schedule_slot,recipient_last_served_sequence) VALUES(${q(ACCOUNT)},0,${slot},0);`);
  const original=rows(f),trace=[];let firstService=null;
  for(let turn=1;turn<=3;turn++){
   const id=81+turn;sqliteExec(f.db,senderDebtSql(id,NOW+turn));
   const previous=query(f,`SELECT schedule_sequence FROM lark_im_name_scan WHERE account_key=${q(ACCOUNT)};`)[0].schedule_sequence;
   const report=direct(f,{allowDebtNames:true});assert(report.calls<=4);
   const scan=query(f,`SELECT * FROM lark_im_name_scan WHERE account_key=${q(ACCOUNT)};`)[0];
   assert.equal(scan.schedule_sequence,previous+1,'count actual admitted choices, not idle calls');
   const current=state(f);if(firstService===null&&current?.last_attempt_at_ms>0)firstService=turn;
   trace.push({turn,slot:scan.schedule_slot,recipientServed:current?.last_attempt_at_ms>0});f.now+=60001;
  }
  assert(firstService!==null&&firstService<=3,JSON.stringify({slot,firstService,trace}));
  const oldServed=query(f,'SELECT count(*) AS n FROM lark_im_name_tasks WHERE latest_record_id<=80 AND last_served_sequence>0;')[0].n;
  assert(oldServed>=1,'the every-third globally oldest lane still advances old name work');
  const after=read(f);assert.equal(after.target.display.recipient,NAME);assert.equal(after.target.readiness.state,'ready');
  const current=rows(f);for(const before of original){const actual=current.find(row=>row.id===before.id);for(const key of Object.keys(before).filter(key=>key!=='canonical_json'))assert.deepEqual(actual[key],before[key]);}
 });
 for(const [label,options] of [['group',{scopeType:'group',rawType:'group'}],['foreign sent account',{actor:'ou_synthetic_enrollment_foreign'}]])test(`${label} cannot enroll a personal recipient`,t=>{
  const f=fixture(t,{background:0,driver:false,...options}),before=rows(f);direct(f);assert.equal(state(f),undefined);assert.deepEqual(rows(f),before);
  assert.equal(f.calls.some(args=>args[2]==='/open-apis/im/v1/chats/batch_query'),false);
 });
 for(const claimed of [false,true])test(`independent scan preserves existing ${claimed?'claim':'failure backoff'} verbatim`,t=>{
  const f=fixture(t,{background:0,driver:false});
  sqliteExec(f.db,`INSERT INTO lark_im_recipient_state(source_id,account_key,chat_id,enqueued_at_ms,last_attempt_at_ms,retry_at_ms,failures,attempt_token,generation)
   VALUES('lark.im',${q(ACCOUNT)},${q(CHAT)},${NOW-600000},${NOW-1000},${NOW+300000},3,${q(claimed?'synthetic-held-claim':null)},7);`);
  const before=state(f);direct(f);assert.deepEqual(state(f),before);assert.equal(f.calls.length,0);
 });
 test('already trusted exact relationship stays readable with no request or queue churn',t=>{
  const f=fixture(t,{background:0,driver:false}),evidence=makeRecipientEvidence(CHAT,SELF.open_id,{id_type:'open_id',id:PEER},NAME,new Date(NOW-1000).toISOString());
  sqliteExec(f.db,`INSERT INTO lark_im_recipient_state(source_id,account_key,chat_id,evidence_json,attempt_evidence_json,retry_at_ms) VALUES('lark.im',${q(ACCOUNT)},${q(CHAT)},${q(JSON.stringify(evidence))},${q(JSON.stringify(evidence))},${Number.MAX_SAFE_INTEGER});`);
  const before=state(f);direct(f);assert.deepEqual(state(f),before);assert.equal(f.calls.length,0);assert.equal(read(f).target.readiness.state,'ready');
 });
 test('local enrollment survives process exit before any role is claimed, then the actual CLI resolves it',t=>{
  const f=fixture(t,{background:0});
  const result=spawnSync(process.execPath,[HERE,'--synthetic-prepare',f.dir,String(f.now)],{cwd:f.dir,encoding:'utf8',timeout:15000,maxBuffer:1024*1024,env:{...process.env,LARK_CLI:'/usr/bin/false'}});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');const initial=JSON.parse(result.stdout);
  assert(initial.pending);assert.equal(initial.freshOrder,f.targetId);assert.equal(initial.calls,0);
  const enrolled=state(f);assert(enrolled);assert.equal(enrolled.attempt_token,null);assert.equal(enrolled.last_attempt_at_ms,0);
  const r=cycle(f);assert.notEqual(r.pid,initial.pid);assert.equal(read(f).target.display.recipient,NAME);assert.equal(read(f).target.readiness.state,'ready');
 });
 test('recipient enrollment remains durable when a different newer role receives the first shared opportunity',t=>{
  const f=fixture(t,{background:0}),chat='oc_synthetic_enrollment_new_group',id=2,at=NOW-10;
  const raw={message_id:'om_synthetic_enrollment_new_group',chat_id:chat,chat_type:'group',msg_type:'text',
   sender:{id:SELF.open_id,id_type:'open_id',sender_type:'user',name:SELF.name},create_time:String(at),body:{content:'{"text":"Synthetic newer group"}'}};
  const canonical={message_id:raw.message_id,chat_id:chat,chat_type:'group',msg_type:'text',sender_id:SELF.open_id,sender_id_type:'open_id',sender_type:'user',sender_name:SELF.name};
  sqliteExec(f.db,`INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,record_type,occurred_at,occurred_at_ms,actor_id,container_id,direction,body,canonical_json,raw_json)
   VALUES(${id},'lark.im','lark.im.sent_by_me',${q(raw.message_id)},${q(String(at))},'lark.im.message',${q(new Date(at).toISOString())},${at},${q(SELF.open_id)},${q(chat)},'sent','Synthetic newer group',${q(JSON.stringify(canonical))},${q(JSON.stringify(raw))});`);
  direct(f);const enrolled=state(f);assert(enrolled);assert.equal(enrolled.attempt_token,null);assert.equal(enrolled.last_attempt_at_ms,0);
  const selected=query(f,"SELECT * FROM lark_im_name_tasks WHERE kind='chat';")[0];assert(selected);assert(selected.last_attempt_at_ms>0,'newer group role was actually selected');
  assert.equal(f.calls.some(args=>args[2]==='/open-apis/im/v1/chats/batch_query'),false);
  f.now+=60001;cycle(f);assert.equal(read(f).target.readiness.state,'ready');
 });
 test('a prepared recipient continuation is consumed at most once',t=>{
  const f=fixture(t,{background:0,driver:false}),work=prepare(f);assert(work.pending);assert.equal(f.calls.length,0);
  const before=rows(f),first=work.run();assert.equal(first.reason,'completed');assert.equal(first.calls,4);assert.equal(read(f).target.readiness.state,'ready');
  const saved=state(f),count=f.calls.length;assert.equal(work.run().reason,'already_consumed');assert.equal(f.calls.length,count);assert.deepEqual(state(f),saved);assert.deepEqual(rows(f),before);
 });
 for(const change of ['row','scope','state','account'])test(`prepared claim rejects stale ${change} before any remote request`,t=>{
  const f=fixture(t,{background:0,driver:false}),work=prepare(f);assert(work.pending);assert.equal(f.calls.length,0);
  if(change==='row')sqliteExec(f.db,"UPDATE records SET body='Synthetic concurrent body' WHERE id=1;");
  if(change==='scope')sqliteExec(f.db,`UPDATE sync_scopes SET config_json=json_set(config_json,'$.synthetic_revision',2) WHERE id=${q(chatScopeId(CHAT))};`);
  if(change==='state')sqliteExec(f.db,`UPDATE lark_im_recipient_state SET generation=generation+1,retry_at_ms=${NOW+9999} WHERE chat_id=${q(CHAT)};`);
  if(change==='account')sqliteExec(f.db,`UPDATE sources SET config_json=json_set(config_json,'$.initial_account_binding.account_key',${q(recipientAccountKey('ou_synthetic_replaced_owner'))}) WHERE id='lark.im';`);
  const before=state(f),recordBefore=rows(f),result=work.run();assert.equal(result.reason,'unavailable');assert.equal(f.calls.length,0);assert.deepEqual(state(f),before);assert.deepEqual(rows(f),recordBefore);
 });
 test('preparation and its later claim share one monotonic deadline',t=>{
  const f=fixture(t,{background:0,driver:false});let elapsed=0;const work=prepare(f,{monotonicNow:()=>elapsed});assert(work.pending);
  const before=state(f);elapsed=10000;assert.equal(work.run().reason,'budget');assert.equal(f.calls.length,0);assert.deepEqual(state(f),before);
 });
 test('recipient source, scope and assertCurrent admission reads reach sqlite with the same remaining deadline',t=>{
  const f=fixture(t,{background:0,driver:false}),observed=[];let elapsed=0,phase='prepare';
  const work=prepare(f,{budgetMs:2000,monotonicNow:()=>elapsed,
   readOnlyQuery:(db,sql,label,options)=>{
    const expected=2000-elapsed;assert.equal(options.timeoutMs,expected);
    const result=readOnlySqliteJson(db,sql,label,{...options,spawnSync:(command,args,childOptions)=>{
     assert.equal(childOptions.timeout,expected,'actual sqlite timeout must not revert to its 30-second default');
     assert(childOptions.timeout>0&&childOptions.timeout<=2000);assert.equal(childOptions.killSignal,'SIGKILL');
     observed.push({label,phase,timeout:childOptions.timeout});return spawnSync(command,args,childOptions);
    }});elapsed+=7;return result;
   },enrichRecipients:(_options,deps)=>{phase='finish';deps.onRecipientResult({chat_id:CHAT,outcome:'unresolved'});return {updated:0};}});
  assert(work.pending);const preparedCount=observed.length;phase='claim';assert.equal(work.run().reason,'completed');
  assert.equal(f.calls.length,0,'this admission-only control performs no remote work');
  assert.equal(observed.filter(row=>row.label==='capture Lark source admission').length,2,'both initial and result admission use the bounded reader');
  const scopes=observed.findIndex(row=>row.label==='capture Lark admission scopes');assert(scopes>=0);
  assert(observed.slice(scopes+1,preparedCount).some(row=>row.label==='remote account binding'),'enrollment assertCurrent uses the same reader');
  assert(observed.some(row=>row.phase==='claim'&&row.label==='remote account binding'),'claim assertCurrent retains the preparation deadline');
  assert(observed.filter(row=>row.phase==='finish'&&row.label==='remote account binding').length>=3,'result capture, identity and assertCurrent reads remain bounded');
  assert(observed.every((row,index)=>index===0||row.timeout<observed[index-1].timeout),'each observed local read consumes the single budget');
 });
 test('budget exhausted before scope admission makes no recipient enrollment or remote request',t=>{
  const f=fixture(t,{background:0,driver:false}),before=rows(f);let elapsed=0,expired=false,scopeReads=0;
  const work=prepare(f,{budgetMs:2000,monotonicNow:()=>elapsed,readOnlyQuery:(db,sql,label,options)=>{
   if(label==='capture Lark admission scopes')scopeReads+=1;
   const result=readOnlySqliteJson(db,sql,label,options);
   if(label==='read exact recipient states'){elapsed=2000;expired=true;}
   return result;
  }});
  assert(expired);assert.equal(work.reason,'budget');assert.equal(scopeReads,0,'expired scope lookup is rejected before starting sqlite');
  assert.equal(f.calls.length,0);assert.equal(state(f),undefined);assert.deepEqual(query(f,'SELECT * FROM lark_im_recipient_scan;'),[]);assert.deepEqual(rows(f),before);
 });
 test('budget exhausted inside claim revalidation cannot fall back to an unbounded admission read or publish a claim',t=>{
  const f=fixture(t,{background:0,driver:false});let phase='prepare',claimClockReads=0,claimQueries=0;
  const work=prepare(f,{budgetMs:2000,monotonicNow:()=>phase==='claim'?(++claimClockReads===1?1500:2000):0,
   readOnlyQuery:(db,sql,label,options)=>{if(phase==='claim')claimQueries+=1;return readOnlySqliteJson(db,sql,label,options);}});
  assert(work.pending);const before=state(f),sourceBefore=rows(f);phase='claim';const result=work.run();
  assert.equal(result.reason,'unavailable','account revalidation conservatively rejects unavailable evidence');
  assert(claimClockReads>=2);assert.equal(claimQueries,0,'no sqlite subprocess begins after the shared deadline');
  assert.equal(f.calls.length,0);assert.deepEqual(state(f),before);assert.deepEqual(rows(f),sourceBefore);
 });
 for(const failure of ['read_failure','budget'])test(`recipient preparation ${failure} is not reported as idle when no other role is due`,t=>{
  const f=fixture(t,{background:0,driver:false}),before=rows(f);let elapsed=0,headers=0;
  const result=syncNames(f.db,SELF,{runLark:api(f.calls),now:()=>f.now,monotonicNow:()=>elapsed,
   readOnlyQuery:(db,sql,label,options)=>{
    if(label==='read recipient witness headers'){
     headers+=1;if(failure==='read_failure')throw new Error('Synthetic recipient page read failure');
     const value=readOnlySqliteJson(db,sql,label,options);elapsed=10000;return value;
    }
    return readOnlySqliteJson(db,sql,label,options);
   }});
  assert.equal(headers,1);assert.equal(result.reason,failure==='budget'?'budget':'unavailable');assert.equal(result.calls,0);assert.equal(f.calls.length,0);
  assert.deepEqual(query(f,'SELECT * FROM lark_im_name_tasks;'),[],'no other role can conceal this preparation failure');
  const scan=query(f,'SELECT next_attempt_at_ms,schedule_sequence,schedule_slot,recipient_last_served_sequence FROM lark_im_name_scan;')[0];
  assert.deepEqual(scan,{next_attempt_at_ms:0,schedule_sequence:0,schedule_slot:0,recipient_last_served_sequence:0},'failure cannot consume an admitted remote opportunity');
  assert.deepEqual(query(f,'SELECT * FROM lark_im_recipient_scan;'),[]);assert.equal(state(f),undefined);assert.deepEqual(rows(f),before);
 });
 test('oversized old sent payload does not block bounded discovery of forty smaller new witnesses',t=>{
  const f=fixture(t,{background:0,driver:false}),large='x'.repeat(1100000);
  sqliteExec(f.db,`UPDATE records SET body=${q(large)},raw_json=json_set(raw_json,'$.body.content',${q(JSON.stringify({text:large}))}) WHERE id=1;`);
  appendRows(f,Array.from({length:40},(_,i)=>sameChatRow(f,i+2,`Synthetic smaller message ${i+2}`)));
  const before=rows(f),first=measuredPrepare(f);assertPayloadBounds(first.pages);assert(first.work.pending);assert.equal(first.work.freshOrder,41);
  assert.equal(query(f,`SELECT after_record_id FROM lark_im_recipient_scan WHERE account_key=${q(ACCOUNT)};`)[0].after_record_id,40);
  const second=measuredPrepare(f);assertPayloadBounds(second.pages);assert(second.work.pending);assert.equal(second.work.freshOrder,41);
  assert.equal(query(f,`SELECT after_record_id FROM lark_im_recipient_scan WHERE account_key=${q(ACCOUNT)};`)[0].after_record_id,41);
  assert.equal(f.calls.length,0);assert.equal(second.work.run().reason,'completed');assert.deepEqual(rows(f),before,'capacity handling cannot truncate or rewrite source body/raw');
  const evidence=JSON.parse(state(f).evidence_json);assert.equal(evidence.recipient.name,NAME);
 });
 test('page byte exhaustion leaves a normal unprocessed sent witness for the following cursor page',t=>{
  const f=fixture(t,{background:0,driver:false}),text='z'.repeat(600000);
  sqliteExec(f.db,`UPDATE records SET body=${q(text)},raw_json=json_set(raw_json,'$.body.content',${q(JSON.stringify({text}))}) WHERE id=1;`);
  appendRows(f,[sameChatRow(f,2,text),sameChatRow(f,3,text),sameChatRow(f,4,'Synthetic short tail')]);
  const before=rows(f),first=measuredPrepare(f);assertPayloadBounds(first.pages);assert(first.work.pending);
  assert.equal(query(f,`SELECT after_record_id FROM lark_im_recipient_scan WHERE account_key=${q(ACCOUNT)};`)[0].after_record_id,1,'normal row 2 exceeds remaining page capacity and stays unprocessed');
  const second=measuredPrepare(f);assertPayloadBounds(second.pages);assert.equal(query(f,`SELECT after_record_id FROM lark_im_recipient_scan WHERE account_key=${q(ACCOUNT)};`)[0].after_record_id,2,'next invocation must visit that exact row');
  assert.equal(f.calls.length,0);assert.deepEqual(rows(f),before);
 });
}
