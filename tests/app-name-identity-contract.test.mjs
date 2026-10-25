import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Socket } from 'node:net';
import test from 'node:test';
import { ensureInitialized, reserveInitialLarkAccount, confirmInitialLarkAccountSql, readScope, createRun, succeedRecordRun, sqliteQuery, sqliteExec, quoteSql } from '../dist/storage/sqlite/ingestion-store.js';
import { mergeLarkNameProjectionSql } from '../dist/storage/sqlite/lark-name-projection.js';
import { createNameResolver } from '../src/adapters/lark-im/name-resolver.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { senderNameTarget, nameTaskKey } from '../src/adapters/lark-im/name-evidence.mjs';
import { prepareSenderWork } from '../src/adapters/lark-im/sender-name-work.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { enrichRecords } from '../src/maintenance/enrich-records.mjs';
import { syncNames } from '../src/adapters/lark-im/name-sync.mjs';
import { readRemoteAccountBinding } from '../src/diagnostics/remote-account-binding.mjs';

// All identities, payloads and API responses are authored here. Real store and
// messages CLI operate only on a temporary synthetic DB; remote calls are mocks.
const APP='cli_authored_identity_app', CHAT='oc_authored_identity_chat';
const SELF={open_id:'ou_authored_identity_self',name:'Authored Self'}, ACCOUNT=recipientAccountKey(SELF.open_id);
const AT=Date.UTC(2038,4,6), SCOPE='lark.im.sent_by_me', ROOT=resolve(import.meta.dirname,'..');
if (process.argv[2] === '--synthetic-name-cycle') {
  const deny=()=>{throw new Error('authored app scheduler forbids network')};globalThis.fetch=deny;Socket.prototype.connect=deny;
  const db=process.argv[3], phase=Number(process.argv[4]), nowMs=Number(process.argv[5]), calls=[];
  assert(db.startsWith(tmpdir()) && db.includes('/exo-app-identity-'));
  const result=syncNames(db,SELF,{now:()=>nowMs,monotonicNow:()=>0,syncRecipients:()=>({reason:'idle'}),runLark:(args,options)=>{
    calls.push(args.slice(0,3));assert.equal(options.retries,0);assert(options.timeoutMs<=5000);
    if(args[0]==='contact'&&args[1]==='+get-user')return SELF;
    if(args[0]==='api') {assert.equal(args[2],`/open-apis/application/v6/applications/${APP}`);
      if(!phase)throw new Error('Authored permission denial');return {app:{app_id:APP,app_name:'Persistently Verified App'}};}
    if(args[0]==='im'&&args[1]==='chat.members'&&args[2]==='bots')return {items:[{bot_name:'Unbound Other Bot'}]};
    throw new Error('Unexpected authored app route');
  }});
  process.stdout.write(JSON.stringify({result,calls,pid:process.pid}));process.exit(0);
}

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'exo-app-identity-')),db=join(dir,'synthetic.sqlite');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));ensureInitialized(db);
  const message={message_id:'om_authored_identity_message',chat_id:CHAT,chat_type:'group',
    sender:{id:APP,id_type:'app_id',sender_type:'app'},msg_type:'text',create_time:String(AT),
    content:{text:'Only invented application prose.'},unknown:{keep:['original',9001]}};
  const query=sql=>sqliteQuery(db,sql,'inspect authored application record');
  const row=()=>query('SELECT * FROM records ORDER BY id;')[0];
  const write=record=>{const scope=readScope(db,SCOPE),run=createRun(db,scope,{synthetic:true});
    succeedRecordRun(db,scope,run,[record],1,{kind:'synthetic.cursor/v1',occurred_at_ms:AT},{});};
  const ingest=run=>write(recordFromMessage(message,SCOPE,'received',createNameResolver({run,now:()=>AT}).buildPeopleContext([message],{},SELF)));
  const setCanonical=c=>sqliteExec(db,`UPDATE records SET canonical_json=${quoteSql(JSON.stringify(c))};`,'seed authored legacy projection');
  const display=()=>{
    const deny=join(dir,'deny-network.mjs');writeFileSync(deny,"import {Socket} from 'node:net'; const deny=()=>{throw new Error('synthetic test forbids network')}; globalThis.fetch=deny; Socket.prototype.connect=deny;\n");
    const before=readFileSync(db),cli=spawnSync(process.execPath,['--import',deny,join(ROOT,'bin/exocortex.mjs'),'messages','--db',db,'--format','json'],
      {cwd:dir,encoding:'utf8',timeout:10000,env:{...process.env,LARK_CLI:'/usr/bin/false',NO_COLOR:'1'}});
    assert.equal(cli.status,0,cli.stderr);assert.deepEqual(readFileSync(db),before,'messages is read-only');
    return JSON.parse(cli.stdout)[0].display;
  };
  const task=()=>({source_id:'lark.im',kind:'sender',account_key:ACCOUNT,chat_id:CHAT,actor_id:APP,namespace:'app_id',
    task_key:nameTaskKey('sender',CHAT,APP,'app_id'),latest_record_id:row().id,after_record_id:0,evidence_json:null});
  const work=(runLark,state=task())=>prepareSenderWork(state,{db,self:SELF,accountKey:ACCOUNT,nowMs:AT+1000,
    query:(sql)=>query(sql),runLark});
  return {dir,db,message,row,write,ingest,setCanonical,display,work};
}
const canonical=f=>JSON.parse(f.row().canonical_json);
const exact=name=>()=>({app:{app_id:APP,app_name:name}});
const unbound=args=>args[0]==='api'?{app:{app_id:APP}}:{items:[{bot_id:'invented_other_bot',name:'Unmapped Wrong Bot'}]};
function preserved(before,after) {
  for(const key of Object.keys(before)) if(!['canonical_json','updated_at'].includes(key)) assert.deepEqual(after[key],before[key],key);
  const old=JSON.parse(before.canonical_json),next=JSON.parse(after.canonical_json);
  for(const key of Object.keys(old)) if(!key.startsWith('sender_name')) assert.deepEqual(next[key],old[key],key);
}
function legacy(f) {
  f.ingest(exact('Originally Exact'));
  const c=canonical(f); for(const key of Object.keys(c)) if(key.startsWith('sender_name')) delete c[key];
  Object.assign(c,{sender_name:'Legacy Guessed Display',sender_name_source:'chat_bot_unique',sender_name_confidence:'medium'});
  f.setCanonical(c);return f.row();
}

test('real ingestion and store retain exact application names through failure plus unbound bot; API recovery updates actual messages display',t=>{
  const f=fixture(t);f.ingest(exact('Exact App Before'));
  const before=f.row();assert.equal(f.display().sender,'应用：Exact App Before');
  f.ingest(unbound);assert.equal(canonical(f).sender_name,'Exact App Before');
  assert.equal(canonical(f).sender_name_source,'application_api');assert.equal(canonical(f).sender_name_confidence,'high');
  assert.equal(senderNameTarget(f.row()).needsVerification,false);preserved(before,f.row());
  assert.equal(f.display().sender,'应用：Exact App Before');
  f.ingest(exact('Exact App Renamed'));assert.equal(canonical(f).sender_name,'Exact App Renamed');
  assert.equal(f.display().sender,'应用：Exact App Renamed');preserved(before,f.row());
});

test('normalizer rejects supplied guessed contexts and merge refuses new or transferred guessed projections',t=>{
  const f=fixture(t);
  const c=JSON.parse(recordFromMessage(f.message,SCOPE,'received',{app_fallbacks:new Map([[`${CHAT}:${APP}`,
    {name:'Injected Guess',source:'chat_bot_unique',confidence:'medium'}]])}).canonical_json);
  assert.equal(c.sender_name,null);
  f.ingest(exact('Exact Predecessor'));const before=f.row();
  const guess={...canonical(f),sender_name:'Injected Guess',sender_name_source:'chat_bot_unique',sender_name_confidence:'medium'};
  const merge=(old,next)=>sqliteQuery(f.db,`SELECT ${mergeLarkNameProjectionSql(quoteSql(JSON.stringify(old)),quoteSql(JSON.stringify(next)),
    quoteSql(APP),quoteSql(APP),quoteSql(CHAT),quoteSql(CHAT),quoteSql(before.raw_json),quoteSql(before.raw_json))} AS value;`)[0].value;
  assert.equal(JSON.parse(merge(canonical(f),guess)).sender_name,'Exact Predecessor');
  assert.throws(()=>merge({...c,sender_name:null,sender_name_source:null},guess),/malformed JSON/);
  assert.throws(()=>merge(guess,{...guess,message_id:'om_authored_different_message'}),/malformed JSON/);
  assert.deepEqual(f.row(),before,'synthetic SQL checks never write');
});

test('legacy guessed names remain visible and retryable after failure; fresh exact background evidence corrects them without changing source content',t=>{
  const f=fixture(t),before=legacy(f);
  assert.equal(senderNameTarget(before).unknown,false);assert.equal(senderNameTarget(before).needsVerification,true);
  const failed=f.work(unbound);assert.equal(failed.updates.length,0);assert.deepEqual(f.row(),before);
  assert.equal(f.display().sender,'应用：Legacy Guessed Display');
  const result=f.work(exact('Verified Replacement'));assert.equal(result.outcome,'resolved');assert.equal(result.updates.length,1);
  for(const sql of result.updates)sqliteExec(f.db,sql,'apply authored name-only CAS');
  assert.equal(f.display().sender,'应用：Verified Replacement');assert.equal(canonical(f).sender_name_source,'application_api');
  assert.equal(senderNameTarget(f.row()).needsVerification,false);preserved(before,f.row());
});

test('legacy review retains clear, exact source and explicit account boundaries',t=>{
  const f=fixture(t);legacy(f);const original=canonical(f);
  for(const extra of [{sender_name_state:'cleared'},{sender_name_account_key:'f'.repeat(64)},
    {chat_name_account_key:'f'.repeat(64)},{sender_name_source:'application_api',sender_name_confidence:'high'}]) {
    f.setCanonical({...original,...extra});const before=f.row();
    const result=f.work(exact('Must Not Replace'));assert.equal(result.updates.length,0);assert.deepEqual(f.row(),before);
  }
  f.setCanonical(original);
  sqliteExec(f.db,"INSERT INTO sources(id,kind,display_name) VALUES('synthetic.other','synthetic','Authored source'); UPDATE records SET source_id='synthetic.other';",'seed foreign source');
  const before=f.row();assert.equal(f.work(exact('Must Not Replace')).updates.length,0);assert.deepEqual(f.row(),before);
});

test('general and names-only maintenance preserve failed legacy guesses as debt and adopt only exact recovered app evidence',t=>{
  const f=fixture(t);let before=legacy(f);
  const options={db:f.db,limit:10,dryRun:false,probeApps:false};
  const run=args=>args[0]==='contact'&&args[1]==='user'&&args[2]==='get'?{data:{user:SELF}}:unbound(args);
  const first=enrichRecords(options,{runLark:run});assert.deepEqual(f.row(),before);assert.equal(first.unresolved_name_targets,1);
  const specific=enrichRecords({...options,namesOnly:true,recordIds:[before.id]},{runLark:unbound});
  assert.equal(specific.unresolved,1);assert.equal(specific.resolved,0);assert.deepEqual(f.row(),before);
  const recovered=enrichRecords({...options,namesOnly:true,recordIds:[before.id]},{runLark:exact('Maintenance Exact')});
  assert.equal(recovered.updated,1);assert.equal(recovered.resolved,1);preserved(before,f.row());
  assert.equal(f.display().sender,'应用：Maintenance Exact');assert.equal(canonical(f).sender_name_source,'application_api');
  before=legacy(f);
  const bot=enrichRecords(options,{runLark:args=>args[0]==='contact'?{data:{user:SELF}}:args[0]==='api'?{app:{app_id:APP}}:
    {items:[{app_id:APP,bot_name:'Exact Bot Recovery'}]}});
  assert.equal(bot.updated,1);assert.equal(canonical(f).sender_name_source,'chat_bot_app_id');
  assert.equal(f.display().sender,'应用：Exact Bot Recovery');preserved(before,f.row());
});


test('ordinary maintenance cannot infer an application namespace from a cli-looking person ID', t => {
  const f=fixture(t);f.ingest(exact('Prior App'));
  const raw={...f.message,sender:{id:APP,id_type:'open_id',sender_type:'user'}};
  const c={...canonical(f),sender_name:null,sender_name_source:null,sender_name_confidence:null,
    sender_id_type:'open_id',sender_type:'user'};
  sqliteExec(f.db,`UPDATE records SET raw_json=${quoteSql(JSON.stringify(raw))},canonical_json=${quoteSql(JSON.stringify(c))};`,
    'seed authored explicit person namespace');
  const before=f.row(),calls=[];
  enrichRecords({db:f.db,limit:10,dryRun:false,probeApps:true},{runLark:args=>{
    calls.push(args);assert.equal(args[0],'contact','an explicit person cannot enter the app route');return {data:{user:SELF}};
  }});
  assert.equal(calls.length,1);assert.equal(canonical(f).sender_name,null);preserved(before,f.row());
});


test('nonempty legacy guess is durably enrolled after failure and recovers across idle process restarts without a new actor message', t => {
  const f=fixture(t);
  reserveInitialLarkAccount(f.db,ACCOUNT,new Date().toISOString());
  sqliteExec(f.db,confirmInitialLarkAccountSql(new Date().toISOString()),'confirm authored account for name scheduling');
  legacy(f);
  // An authoritative title clear excludes unrelated chat-title work. It does
  // not permit clearing or replacing this sender's preserved guessed display.
  f.setCanonical({...canonical(f),chat_name_state:'cleared'});
  const before=f.row(), initialDisplay=f.display(), cycles=[];
  const cycle=(phase,step)=>{
    const run=spawnSync(process.execPath,[import.meta.filename,'--synthetic-name-cycle',f.db,String(phase),String(AT+step*360001)],
      {cwd:f.dir,encoding:'utf8',timeout:15000,env:{...process.env,LARK_CLI:'/usr/bin/false'}});
    assert.equal(run.status,0,run.stderr);assert.equal(run.stderr,'');const output=JSON.parse(run.stdout);
    assert(output.result.calls<=4);cycles.push(output);return output;
  };
  const first=cycle(0,0);
  const debt=sqliteQuery(f.db,"SELECT * FROM lark_im_name_tasks WHERE kind='sender';")[0];
  assert(debt,'a valid nonempty guess must enter durable work');assert.equal(debt.namespace,'app_id');
  assert.equal(debt.actor_id,APP);assert.equal(debt.account_key,ACCOUNT);assert.equal(debt.latest_record_id,before.id);
  assert.equal(debt.after_record_id,0);assert.equal(debt.evidence_json,null);assert(debt.retry_at_ms>AT);
  assert(first.calls.some(args=>args[0]==='api'));assert.deepEqual(f.row(),before);
  assert.equal(f.display().sender,'应用：Legacy Guessed Display');
  for(let step=1;step<=4 && canonical(f).sender_name!=='Persistently Verified App';step++)cycle(1,step);
  assert.equal(canonical(f).sender_name,'Persistently Verified App');assert.equal(canonical(f).sender_name_source,'application_api');
  assert.equal(canonical(f).sender_name_account_key,ACCOUNT);assert.equal(senderNameTarget(f.row()).needsVerification,false);
  assert.equal(new Set(cycles.map(item=>item.pid)).size,cycles.length);assert(cycles.length>=2);
  assert.equal(sqliteQuery(f.db,'SELECT count(*) AS n FROM records;')[0].n,1,'there was no new actor message');
  const finished=sqliteQuery(f.db,"SELECT * FROM lark_im_name_tasks WHERE kind='sender';")[0];
  assert.equal(finished.outcome,'resolved');assert.equal(finished.after_record_id,before.id);
  assert.equal(readRemoteAccountBinding({db:f.db,selfOpenId:SELF.open_id}).state,'verified');
  preserved(before,f.row());assert.equal(f.row().updated_at,before.updated_at);
  const shown=f.display();assert.equal(shown.sender,'应用：Persistently Verified App');
  const withoutSender=display=>{const value={...display};delete value.sender;return value;};
  assert.deepEqual(withoutSender(shown),withoutSender(initialDisplay),'body, time, chat and display structure remain stable');
});
