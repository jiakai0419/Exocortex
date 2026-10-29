import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareSidecarFixture } from './helpers/sidecar-fixture.mjs';

// Fully invented identities, content, clocks and remote responses. The optional
// root replays this exact contract against a frozen source checkout only.
const ROOT=process.env.EXO_NAME_REVIEW_TEST_ROOT||dirname(dirname(fileURLToPath(import.meta.url)));
process.env.TZ='UTC';process.env.NO_COLOR='1';delete process.env.FORCE_COLOR;
const {ensureInitialized,reserveInitialLarkAccount,confirmInitialLarkAccountSql,sqliteExec,sqliteQuery,quoteSql:q}=await import(ROOT+'/dist/storage/sqlite/ingestion-store.js');
const {syncNames}=await import(ROOT+'/src/adapters/lark-im/name-sync.mjs');
const {recipientAccountKey}=await import(ROOT+'/src/adapters/lark-im/p2p-recipient.mjs');
const {nameTaskKey}=await import(ROOT+'/src/adapters/lark-im/name-evidence.mjs');
const {chatScopeId}=await import(ROOT+'/src/adapters/lark-im/core.mjs');
const {liveProbeContext}=await import(ROOT+'/src/diagnostics/live-probe-cache.mjs');
const {renderMessagesText}=await import(ROOT+'/src/terminal/messages-view.mjs');
const {bindAcquiredMessageAccounts}=await import(ROOT+'/src/adapters/lark-im/message-account-evidence.mjs');
const {readOnlySqliteJson}=await import(ROOT+'/src/storage/sqlite/readonly-query.mjs');
const NOW=Date.parse('2025-05-06T07:08:09.000Z'),MINUTE=60000;
const SELF={open_id:'ou_synthetic_review_isolation_owner',name:'Synthetic Review Owner'};
const ACCOUNT=recipientAccountKey(SELF.open_id),PEER='ou_synthetic_review_isolation_peer';
const CHAT='oc_synthetic_review_isolation_private',APP_CHAT='oc_synthetic_review_isolation_app';
const APP='cli_synthetic_review_isolation_application',APP_NAME='Synthetic Isolated Application',PEER_NAME='Synthetic Private Recipient';
const HUMAN='ou_synthetic_review_isolation_human',HUMAN_NAME='Synthetic Isolated Human';
const hash=value=>createHash('sha256').update(value).digest('hex');
const noNetwork=()=>{throw new Error('synthetic isolation test forbids network');};
globalThis.fetch=noNetwork;Socket.prototype.connect=noNetwork;

const query=(f,sql)=>sqliteQuery(f.db,sql,'inspect synthetic review isolation');
const appState=f=>query(f,`SELECT * FROM lark_im_name_tasks WHERE namespace='app_id' AND actor_id=${q(APP)};`);
const routes=f=>query(f,'SELECT * FROM lark_im_name_routes ORDER BY route_key;');
const records=f=>query(f,'SELECT * FROM records ORDER BY id;');
function fixture(t,review){
 const dir=mkdtempSync(join(tmpdir(),'exo-synthetic-review-isolation-')),db=join(dir,'synthetic.sqlite');
 t.after(()=>rmSync(dir,{recursive:true,force:true}));ensureInitialized(db);
 reserveInitialLarkAccount(db,ACCOUNT,new Date(NOW).toISOString());sqliteExec(db,confirmInitialLarkAccountSql(new Date(NOW).toISOString()));
 const f={dir,db,now:NOW,calls:[]};
 const statements=[];
 for(const [id,chat,actor,namespace,direction,name] of [[1,APP_CHAT,APP,'app_id','received',null],[2,CHAT,SELF.open_id,'open_id','sent',SELF.name]]){
  const text=`Completely invented isolation message ${id}; spacing  preserved.`,at=NOW-1000+id;
  const raw={message_id:`om_synthetic_review_isolation_${id}`,chat_id:chat,chat_type:'p2p',msg_type:'text',
   sender:{id:actor,id_type:namespace,sender_type:namespace==='app_id'?'app':'user',...(name?{name}:{})},create_time:String(at),body:{content:JSON.stringify({text})}};
  const canonical={message_id:raw.message_id,chat_id:chat,chat_type:'p2p',msg_type:'text',sender_id:actor,sender_id_type:namespace,sender_type:raw.sender.sender_type,sender_name:name};
  statements.push(`INSERT INTO sync_scopes(id,source_id,name,enabled,config_json) VALUES(${q(chatScopeId(chat))},'lark.im',${q('Synthetic private scope '+id)},0,${q(JSON.stringify({chat_id:chat,chat_type:'p2p'}))});`);
  let row={id,source_id:'lark.im',first_seen_scope_id:direction==='sent'?'lark.im.sent_by_me':chatScopeId(chat),external_id:raw.message_id,external_version:String(at),record_type:'lark.im.message',occurred_at:new Date(at).toISOString(),occurred_at_ms:at,actor_id:actor,container_id:chat,direction,body:text,canonical_json:JSON.stringify(canonical),raw_json:JSON.stringify(raw)};
  row=bindAcquiredMessageAccounts([row],SELF,{acquiredAt:new Date(NOW).toISOString()})[0];
  statements.push(`INSERT INTO records(${Object.keys(row).join(',')}) VALUES(${Object.values(row).map(q).join(',')});`);
 }
 statements.push(`INSERT INTO lark_im_name_tasks(source_id,account_key,task_key,kind,chat_id,actor_id,namespace,latest_record_id,fresh_required_record_id,serviced_record_id,enqueued_at_ms,retry_at_ms)
  VALUES('lark.im',${q(ACCOUNT)},${q(nameTaskKey('sender',APP_CHAT,APP,'app_id'))},'sender',${q(APP_CHAT)},${q(APP)},'app_id',1,1,0,${NOW-1000},${NOW-1000});`);
 sqliteExec(db,statements.join('\n'));
 if(review!=='absent'){
  const path=db+'.name-recovery-review.json';
  const value={kind:'lark_name_recovery_review/v1',review_kind:'local_evidence_review',context:{source_id:'lark.im',database_key:liveProbeContext(db).database_key,account_key:review==='wrong-account'?'f'.repeat(64):ACCOUNT},reviewed_at:new Date(NOW).toISOString(),entries:[{namespace:'app_id',actor_id:APP,decision:'hold'}]};
  writeFileSync(path,review==='invalid-json'?'not JSON\n':JSON.stringify(value)+'\n',{mode:0o600});
  if(review==='unsafe-mode')chmodSync(path,0o644);
  prepareSidecarFixture(path);
 }
 writeFileSync(join(dir,'deny-network.mjs'),"import {Socket} from 'node:net';const no=()=>{throw Error('synthetic test forbids network')};globalThis.fetch=no;Socket.prototype.connect=no;Object.defineProperty(process.stdout,'columns',{value:100});\n");
 return f;
}
function run(f,{allowApp=false,allowHuman=false,readOnlyQuery}={}){
 const result=syncNames(f.db,SELF,{now:()=>f.now,monotonicNow:()=>0,readOnlyQuery,runLark:(args,options)=>{
  f.calls.push(args);assert.equal(options.retries,0);assert.ok(options.timeoutMs<=5000&&options.retryBudgetMs<=10000);
  assert.equal(query(f,'SELECT count(*) AS n FROM maintenance_locks;')[0].n,0);
  if(args[0]==='contact'&&args[1]==='+get-user')return SELF;
  if(args[0]==='api'&&args[1]==='POST'&&args[2]==='/open-apis/im/v1/chats/batch_query'){
   assert.deepEqual(JSON.parse(args[args.indexOf('--data')+1]).chat_ids,[CHAT]);
   return {code:0,data:{items:[{chat_id:CHAT,chat_mode:'p2p',chat_type:'private',p2p_target_type:'user',p2p_target_id:PEER}]}};
  }
  if(args[0]==='contact'&&args[1]==='+search-user'){
   const id=args[args.indexOf('--user-ids')+1];
   if(allowHuman&&id===HUMAN)return {users:[{open_id:HUMAN,name:HUMAN_NAME}]};
   assert.equal(id,PEER);return {users:[{open_id:PEER,name:PEER_NAME}]};
  }
  if(args[0]==='api'&&args[1]==='GET'&&args[2].endsWith('/'+APP)){
   assert(allowApp,'invalid review or hold must prevent the application request');return {data:{app:{app_id:APP,app_name:APP_NAME}}};
  }
  assert.fail('unexpected synthetic review isolation route');
 }});
 assert(result.calls<=4);return result;
}
function read(f,count=2){
 const before=hash(readFileSync(f.db)),out={};
 const env={...process.env,LARK_CLI:'/usr/bin/false',TZ:'UTC',NO_COLOR:'1'};delete env.FORCE_COLOR;
 for(const format of ['json','text']){
  const r=spawnSync(process.execPath,['--import',join(f.dir,'deny-network.mjs'),join(ROOT,'bin/exocortex.mjs'),'messages','--db',f.db,'--limit','100','--format',format],{cwd:f.dir,encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024,env});
  assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');out[format]=format==='json'?JSON.parse(r.stdout):r.stdout;
 }
 assert.equal(hash(readFileSync(f.db)),before,'messages CLI must not write the database');
 assert.equal(out.text,renderMessagesText(out.json,{columns:100}));assert.equal(out.json.length,count);
 return out;
}

for(const review of ['invalid-json','unsafe-mode','wrong-account','hold'])test(`${review} application review preserves exact app debt while the real recipient path completes`,t=>{
 const f=fixture(t,review),source=records(f),tasks=appState(f),routeRows=routes(f),before=read(f);
 assert(before.json.find(row=>row.id===2).readiness.reasons.includes('recipient_identity_unknown'));
 const result=run(f);assert.equal(result.calls,4);
 const after=read(f),target=after.json.find(row=>row.id===2);
 assert.equal(target.display.recipient,PEER_NAME);assert.equal(target.readiness.state,'ready');assert(after.text.includes(PEER_NAME));
 assert.deepEqual(after.json.map(row=>row.id),before.json.map(row=>row.id));
 assert.deepEqual(records(f),source,'recipient repair does not rewrite either source message');
 assert.deepEqual(appState(f),tasks,'application task is neither claimed nor reset');assert.deepEqual(routes(f),routeRows,'local policy failure is not a remote route result');
 f.now+=MINUTE;assert.equal(run(f).calls,0,'there is no application request on the next eligible opportunity');
 assert.deepEqual(appState(f),tasks);assert.deepEqual(routes(f),routeRows);assert.deepEqual(records(f),source);
});

test('absent optional review permits normal recipient and application work with real CLI names',t=>{
 const f=fixture(t,'absent'),source=records(f),before=read(f);
 assert.equal(run(f).calls,4);assert.equal(read(f).json.find(row=>row.id===2).display.recipient,PEER_NAME);
 f.now+=MINUTE;const app=run(f,{allowApp:true});assert.equal(app.calls,2);assert.equal(app.reason,'resolved');
 const after=read(f);assert.equal(after.json.find(row=>row.id===1).display.sender,'应用：'+APP_NAME);assert(after.text.includes(APP_NAME));
 assert.deepEqual(after.json.map(row=>row.id),before.json.map(row=>row.id));
 const current=records(f);
 for(let i=0;i<source.length;i++)for(const key of ['raw_json','body','actor_id','container_id','direction','occurred_at','occurred_at_ms','external_id','external_version'])assert.equal(current[i][key],source[i][key],key);
});

test('invalid application review does not block an unrelated human sender or the next recipient opportunity',t=>{
 const f=fixture(t,'invalid-json'),chat='oc_synthetic_review_isolation_human_chat',at=NOW-10,text='Wholly invented unrelated human message.';
 const raw={message_id:'om_synthetic_review_isolation_human',chat_id:chat,chat_type:'p2p',msg_type:'text',sender:{id:HUMAN,id_type:'open_id',sender_type:'user'},create_time:String(at),body:{content:JSON.stringify({text})}};
 const canonical={message_id:raw.message_id,chat_id:chat,chat_type:'p2p',msg_type:'text',sender_id:HUMAN,sender_id_type:'open_id',sender_type:'user',sender_name:null};
 let row={id:3,source_id:'lark.im',first_seen_scope_id:chatScopeId(chat),external_id:raw.message_id,external_version:String(at),record_type:'lark.im.message',occurred_at:new Date(at).toISOString(),occurred_at_ms:at,actor_id:HUMAN,container_id:chat,direction:'received',body:text,canonical_json:JSON.stringify(canonical),raw_json:JSON.stringify(raw)};
 row=bindAcquiredMessageAccounts([row],SELF,{acquiredAt:new Date(NOW).toISOString()})[0];
 sqliteExec(f.db,`INSERT INTO sync_scopes(id,source_id,name,enabled,config_json) VALUES(${q(chatScopeId(chat))},'lark.im','Synthetic unrelated human scope',0,${q(JSON.stringify({chat_id:chat,chat_type:'p2p'}))});
  INSERT INTO records(${Object.keys(row).join(',')}) VALUES(${Object.values(row).map(q).join(',')});`);
 const before=read(f,3),source=records(f),tasks=appState(f);
 assert.equal(run(f,{allowHuman:true}).calls,2);
 const human=read(f,3).json.find(value=>value.id===3);assert.equal(human.display.sender,HUMAN_NAME);assert.equal(human.readiness.state,'ready');
 f.now+=MINUTE;assert.equal(run(f).calls,4);
 const after=read(f,3);assert.equal(after.json.find(value=>value.id===2).display.recipient,PEER_NAME);assert.equal(after.json.find(value=>value.id===2).readiness.state,'ready');
 assert(after.text.includes(HUMAN_NAME)&&after.text.includes(PEER_NAME));assert.deepEqual(after.json.map(value=>value.id),before.json.map(value=>value.id));
 assert.deepEqual(appState(f),tasks);assert.equal(routes(f).filter(value=>['application_info','chat_bots'].includes(value.operation)).length,0);
 const current=records(f);for(let i=0;i<source.length;i++)for(const key of ['raw_json','body','actor_id','container_id','direction','occurred_at','occurred_at_ms','external_id','external_version'])assert.equal(current[i][key],source[i][key],key);
});

test('application review replacement fences an early missing-witness update and its cadence',t=>{
 const f=fixture(t,'absent'),path=f.db+'.name-recovery-review.json';
 const value={kind:'lark_name_recovery_review/v1',review_kind:'local_evidence_review',context:{source_id:'lark.im',database_key:liveProbeContext(f.db).database_key,account_key:ACCOUNT},reviewed_at:new Date(NOW).toISOString(),entries:[]};
 writeFileSync(path,JSON.stringify(value)+'\n',{mode:0o600});prepareSidecarFixture(path);
 sqliteExec(f.db,'DELETE FROM records;');const before=appState(f);let replaced=false;
 const result=run(f,{readOnlyQuery:(db,sql,label,options)=>{
  const rows=readOnlySqliteJson(db,sql,label,options);
  if(label==='read exact name witness'&&!replaced){
   replaced=true;const replacement=path+'.replacement';
   writeFileSync(replacement,JSON.stringify({...value,entries:[{namespace:'app_id',actor_id:APP,decision:'hold'}]})+'\n',{mode:0o600});prepareSidecarFixture(replacement);renameSync(replacement,path);
  }
  return rows;
 }});
 assert(replaced,'the review changed after selection, before the early missing-witness commit');
 assert.equal(result.calls,0);
 assert.deepEqual(appState(f),before,'no missing-witness result may bypass the changed application review');
 assert.deepEqual(routes(f),[]);
 const scan=query(f,'SELECT schedule_sequence,next_attempt_at_ms FROM lark_im_name_scan;')[0];
 assert.equal(scan.schedule_sequence,0);assert.equal(scan.next_attempt_at_ms,0,'failed early commit must not consume remote cadence');
 assert.equal(result.reason,'unavailable');
});
