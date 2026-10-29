import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ensureInitialized, reserveInitialLarkAccount, confirmInitialLarkAccountSql,
  upsertRecordsSql, quoteSql as q, sqliteExec, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';
import { liveProbeContext } from '../src/diagnostics/live-probe-cache.mjs';
import { syncNames } from '../src/adapters/lark-im/name-sync.mjs';
import { nameTaskKey } from '../src/adapters/lark-im/name-evidence.mjs';
import { nameRouteDescriptor } from '../src/adapters/lark-im/name-route-state.mjs';
import { formatLarkExecutionReceipt } from '../src/adapters/lark-im/transport-execution.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { bindAcquiredMessageAccounts } from '../src/adapters/lark-im/message-account-evidence.mjs';
import { renderMessagesText } from '../src/terminal/messages-view.mjs';
import { prepareSidecarFixture } from './helpers/sidecar-fixture.mjs';

// All identities, messages, clocks and API responses are authored from scratch.
// This file never opens a real account, service, database or API session.
process.env.TZ='UTC';
const ROOT=dirname(dirname(fileURLToPath(import.meta.url)));
const NOW=Date.parse('2025-03-04T05:06:07.000Z'), MINUTE=60000, WINDOW=5*MINUTE, DAY=24*60*MINUTE;
const SELF={open_id:'ou_synthetic_reviewed_recovery_owner',name:'Synthetic Recovery Owner'};
const ACCOUNT=recipientAccountKey(SELF.open_id), APP='cli_synthetic_reviewed_old_application';
const CHAT='oc_synthetic_reviewed_old_conversation';
const query=(f,sql)=>sqliteQuery(f.db,sql,'inspect synthetic reviewed recovery');
const task=(f,actor=APP)=>query(f,`SELECT * FROM lark_im_name_tasks WHERE kind='sender' AND actor_id=${q(actor)} ORDER BY task_key;`)[0];
const routes=f=>query(f,'SELECT * FROM lark_im_name_routes ORDER BY route_key;');
const nameFor=actor=>`Synthetic name for ${actor.replace(/^cli_synthetic_/, '')}`;

function addRecord(f,id,actor=APP,chat=CHAT) {
  const raw={message_id:`om_synthetic_reviewed_recovery_${id}`,chat_id:chat,msg_type:'text',chat_type:'p2p',
    create_time:String(NOW-1000+id),update_time:String(NOW-500+id),
    sender:{id:actor,id_type:'app_id',sender_type:'app'},
    body:{content:JSON.stringify({text:`Authored recovery message ${id}.`})}};
  let row=recordFromMessage(normalizeApiMessage(raw),'lark.im.sent_by_me','received',{}, {chat_id:chat,chat_type:'p2p'});
  row=bindAcquiredMessageAccounts([row],SELF,{acquiredAt:new Date(NOW).toISOString()})[0];
  assert.ok(JSON.parse(row.canonical_json).message_account_evidence);
  sqliteExec(f.db,upsertRecordsSql([row]));
  return query(f,`SELECT * FROM records WHERE external_id=${q(raw.message_id)};`)[0];
}
function fixture(t,{review='retry_unknown',legacy=true,extraEntries=[]}={}) {
  const dir=mkdtempSync(join(tmpdir(),'exo-synthetic-reviewed-recovery-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const f={dir,db:join(dir,'synthetic.sqlite'),now:NOW,elapsed:0,calls:[],reviewPath:null};
  const migrations=join(dir,'through015');mkdirSync(migrations);
  for(const name of readdirSync(join(ROOT,'migrations')).filter(name=>/^\d{3}_.*\.sql$/.test(name)&&name.slice(0,3)<='015'))
    copyFileSync(join(ROOT,'migrations',name),join(migrations,name));
  ensureInitialized(f.db,{migrationsDir:migrations});
  reserveInitialLarkAccount(f.db,ACCOUNT,new Date(NOW-10000).toISOString());
  sqliteExec(f.db,confirmInitialLarkAccountSql(new Date(NOW-10000).toISOString()));
  const row=addRecord(f,1);
  if(legacy) sqliteExec(f.db,`INSERT INTO lark_im_name_tasks(source_id,account_key,task_key,kind,chat_id,actor_id,namespace,
    outcome,latest_record_id,retry_at_ms,last_attempt_at_ms,failures,generation)
    VALUES('lark.im',${q(ACCOUNT)},${q(nameTaskKey('sender',CHAT,APP,'app_id'))},'sender',${q(CHAT)},${q(APP)},'app_id',
    'failed',${row.id},${NOW+DAY},${NOW},9,4);`);
  const before=task(f);ensureInitialized(f.db);f.migrated=task(f);
  if(legacy) {
    for(const key of Object.keys(before))assert.deepEqual(f.migrated[key],before[key],`migration preserves ${key}`);
    assert.equal(f.migrated.schedule_failures,0);assert.equal(f.migrated.blocked_reason,null);
    assert.equal(f.migrated.serviced_record_id,row.id);
  }
  f.guard=join(dir,'deny-network.mjs');
  writeFileSync(f.guard,"import {Socket} from 'node:net';globalThis.fetch=()=>{throw Error('Synthetic test forbids network')};Socket.prototype.connect=globalThis.fetch;\n");
  if(review!==null)writeReview(f,[{namespace:'app_id',actor_id:APP,decision:review},...extraEntries]);
  return f;
}
function writeReview(f,entries,reviewedAt=NOW) {
  f.reviewPath=f.db+'.name-recovery-review.json';
  const value={kind:'lark_name_recovery_review/v1',review_kind:'local_evidence_review',
    context:{source_id:'lark.im',database_key:liveProbeContext(f.db).database_key,account_key:ACCOUNT},
    reviewed_at:new Date(reviewedAt).toISOString(),entries};
  writeFileSync(f.reviewPath,JSON.stringify(value)+'\n',{mode:0o600});prepareSidecarFixture(f.reviewPath);
  return value;
}
function readMessages(f,limit=100) {
  const output={};
  const env={...process.env,TZ:'UTC',NO_COLOR:'1',LARK_CLI:'/usr/bin/false'};delete env.FORCE_COLOR;
  for(const format of ['json','text']) {
    const r=spawnSync(process.execPath,['--import',f.guard,join(ROOT,'bin/exocortex.mjs'),'messages','--db',f.db,
      '--limit',String(limit),'--format',format],{cwd:f.dir,encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024,
      env});
    assert.equal(r.status,0,'actual synthetic messages CLI must succeed');assert.equal(r.stderr,'');
    output[format]=format==='json'?JSON.parse(r.stdout):r.stdout;
  }
  assert.equal(output.text,renderMessagesText(output.json,{columns:100}));
  return output;
}
function appFromArgs(args) {
  assert.equal(args[0],'api');return args[2].split('/').at(-1);
}
function run(f,{respond, ...deps}={}) {
  return syncNames(f.db,SELF,{now:()=>f.now,monotonicNow:()=>f.elapsed,
    syncRecipients:()=>assert.fail('received-only fixture cannot request recipient work'),
    runLark:(args,options)=>{
      f.calls.push({args,at:f.now,options});
      assert.equal(options.retries,0);assert.ok(options.timeoutMs<=5000&&options.retryBudgetMs<=10000);
      assert.equal(query(f,'SELECT count(*) AS n FROM maintenance_locks;')[0].n,0,'network work is outside write transaction');
      if(args[0]==='contact'&&args[1]==='+get-user')return SELF;
      if(respond)return respond(args,options);
      if(args[0]==='api') {const actor=appFromArgs(args);return {data:{app:{app_id:actor,app_name:nameFor(actor)}}};}
      if(args.slice(0,3).join(' ')==='im chat.members bots')return {items:[]};
      assert.fail('unexpected synthetic API route');
    },...deps});
}
function runAfterRestart(f,{crashAfterClaim=false}={}) {
  const script=join(f.dir,'synthetic-restarted-worker.mjs');
  writeFileSync(script,`import {syncNames} from ${JSON.stringify(join(ROOT,'src/adapters/lark-im/name-sync.mjs'))};
import {appendFileSync} from 'node:fs';
const self=${JSON.stringify(SELF)},at=Number(process.argv[3]);
const result=syncNames(process.argv[2],self,{now:()=>at,monotonicNow:()=>0,
...(process.argv[4]==='crash-after-claim'?{prepareSenderWork:()=>process.exit(73)}:{}),
syncRecipients:()=>{throw Error('unexpected recipient work')},runLark:args=>{
appendFileSync(${JSON.stringify(join(f.dir,'restarted-api-calls.jsonl'))},JSON.stringify({operation:args[0]})+'\\n');
if(args[0]==='contact'&&args[1]==='+get-user')return self;
if(args[0]==='api'){const actor=args[2].split('/').at(-1);return {data:{app:{app_id:actor,app_name:'Synthetic name for '+actor.replace(/^cli_synthetic_/,'')}}};}
throw Error('unexpected synthetic restarted route');}});
process.stdout.write(JSON.stringify(result));\n`);
  const r=spawnSync(process.execPath,['--import',f.guard,script,f.db,String(f.now),crashAfterClaim?'crash-after-claim':'run'],
    {cwd:f.dir,encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
  if(crashAfterClaim){assert.equal(r.status,73,'the synthetic worker must exit only after its claim');assert.equal(r.stdout,'');assert.equal(r.stderr,'');return {crashed:true};}
  assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');return JSON.parse(r.stdout);
}
function crashReviewedClaim(f) {
  assert.equal(task(f).reviewed_retry_at_ms,0);
  const result=runAfterRestart(f,{crashAfterClaim:true});assert.equal(result.crashed,true);
  assert.equal(existsSync(join(f.dir,'restarted-api-calls.jsonl')),false,'process died before any API request');
  const claimed=task(f);assert.ok(claimed.attempt_token);assert.equal(claimed.retry_at_ms,f.now+WINDOW);
  assert.equal(claimed.reviewed_retry_at_ms,NOW+DAY,'original waiting deadline must survive the short claim lease');
  assert.equal(routes(f).length,0);ensureInitialized(f.db);ensureInitialized(f.db);
  assert.deepEqual(task(f),claimed,'repeated migration cannot erase original due or alter the active claim');
  return claimed;
}
function assertMissing(f,count=1) {
  const output=readMessages(f);assert.equal(output.json.length,count);
  assert.equal(output.json.find(row=>row.actor_id===APP).readiness.state,'enriching');
  assert.ok(output.json.find(row=>row.actor_id===APP).readiness.reasons.includes('sender_name_missing'));
  return output;
}
function storeRoute(f,operation,kind,{actor=APP,failures=1,blocked=1,retryAt=NOW+DAY,lastAttempt=NOW}={}) {
  const descriptor=nameRouteDescriptor(task(f,actor),operation);assert.ok(descriptor);
  const row={...descriptor,failure_kind:kind,failure_code:kind==='permission_denied'?210508:null,
    failures,last_attempt_at_ms:lastAttempt,retry_at_ms:retryAt,blocked,generation:1};
  const columns=Object.keys(row);
  sqliteExec(f.db,`INSERT INTO lark_im_name_routes(${columns.join(',')}) VALUES(${columns.map(k=>q(row[k])).join(',')});`);
  return row;
}

test('reviewed old unknown becomes correctly readable at five minutes without resetting its migration history',t=>{
  const f=fixture(t),before=assertMissing(f),record=query(f,'SELECT * FROM records;')[0];
  for(const offset of [1,MINUTE,WINDOW-1]) {
    f.now=NOW+offset;ensureInitialized(f.db);assert.equal(run(f).calls,0);
    assert.equal(task(f).retry_at_ms,NOW+DAY);assert.equal(task(f).last_attempt_at_ms,NOW);
    assert.equal(task(f).failures,9);assert.equal(task(f).schedule_failures,0);assert.equal(routes(f).length,0);
  }
  assert.deepEqual(readMessages(f),before,'local waits neither erase the row nor manufacture a name');
  f.now=NOW+WINDOW;const result=runAfterRestart(f);
  assert.equal(result.reason,'resolved');assert.equal(result.calls,2);assert.equal(result.updated,1);
  const output=readMessages(f);assert.equal(output.json.length,1);assert.equal(output.json[0].readiness.state,'ready');
  assert.equal(output.json[0].display.sender,'应用：'+nameFor(APP));assert.ok(output.text.includes(nameFor(APP)));
  const after=query(f,'SELECT * FROM records;')[0];
  for(const field of ['raw_json','body','content_hash','external_version','actor_id','container_id','occurred_at','occurred_at_ms'])
    assert.equal(after[field],record[field],field);
  const settled=task(f);ensureInitialized(f.db);ensureInitialized(f.db);assert.deepEqual(task(f),settled);
  assert.equal(runAfterRestart(f).calls,0,'a second real process cannot reserve another account opportunity');
});

test('legacy acceleration requires an explicit valid unexpired review of that exact actor',t=>{
  for(const mode of ['missing','unlisted','expired','future_review']) {
    const f=fixture(t,{review:null});
    if(mode==='unlisted')writeReview(f,[{namespace:'app_id',actor_id:'cli_synthetic_unrelated_reviewed_actor',decision:'retry_unknown'}]);
    if(mode==='expired')writeReview(f,[{namespace:'app_id',actor_id:APP,decision:'retry_unknown'}],NOW-DAY-1);
    if(mode==='future_review')writeReview(f,[{namespace:'app_id',actor_id:APP,decision:'retry_unknown'}],NOW+WINDOW+1);
    f.now=NOW+WINDOW;assert.equal(run(f).calls,0,mode);assert.equal(task(f).retry_at_ms,NOW+DAY,mode);
    assert.equal(f.calls.length,0);assertMissing(f);
  }
});

test('a crashed accelerated claim with a missing review cannot use its short lease as ordinary retry permission',t=>{
  const f=fixture(t);f.now=NOW+WINDOW;const claimed=crashReviewedClaim(f);
  rmSync(f.reviewPath);f.now=claimed.retry_at_ms+1;
  for(let turn=0;turn<2;turn++) {
    assert.equal(runAfterRestart(f).calls,0);ensureInitialized(f.db);assert.deepEqual(task(f),claimed);
    f.now+=WINDOW;
  }
  assertMissing(f);f.now=NOW+DAY;
  assert.equal(runAfterRestart(f).reason,'resolved','only the original ordinary deadline removes the extra review condition');
  assert.equal(task(f).reviewed_retry_at_ms,0);assert.equal(task(f).attempt_token,null);
  assert.equal(readMessages(f).json[0].readiness.state,'ready');
});

test('review expiry after a crash cannot shorten the saved ordinary retry deadline',t=>{
  const f=fixture(t,{review:null});
  writeReview(f,[{namespace:'app_id',actor_id:APP,decision:'retry_unknown'}],NOW-DAY+WINDOW*2-1);
  f.now=NOW+WINDOW;const claimed=crashReviewedClaim(f);f.now=claimed.retry_at_ms+1;
  assert.equal(runAfterRestart(f).calls,0);ensureInitialized(f.db);assert.deepEqual(task(f),claimed);
  assert.equal(existsSync(join(f.dir,'restarted-api-calls.jsonl')),false);assertMissing(f);
});

test('a fresh process may resume a crashed reviewed claim only with the still-valid review and exact route admission',t=>{
  const f=fixture(t);f.now=NOW+WINDOW;const claimed=crashReviewedClaim(f);f.now=claimed.retry_at_ms+1;
  const resumed=runAfterRestart(f);assert.equal(resumed.reason,'resolved');assert.equal(resumed.calls,2);
  assert.equal(task(f).reviewed_retry_at_ms,0);assert.equal(task(f).attempt_token,null);
  const output=readMessages(f);assert.equal(output.json.length,1);assert.equal(output.json[0].readiness.state,'ready');
  assert.equal(output.json[0].display.sender,'应用：'+nameFor(APP));
});

test('a route denial recorded after a crash blocks reviewed claim resumption and its sibling route',t=>{
  const f=fixture(t);f.now=NOW+WINDOW;const claimed=crashReviewedClaim(f);
  const denied=storeRoute(f,'application_info','permission_denied',{lastAttempt:f.now+1});
  f.now=claimed.retry_at_ms+1;assert.equal(runAfterRestart(f).calls,0);
  assert.deepEqual(routes(f),[denied]);assert.deepEqual(task(f),claimed);
  assert.equal(existsSync(join(f.dir,'restarted-api-calls.jsonl')),false);assertMissing(f);
});

test('a committed no-request deferral preserves the reviewed original deadline across review removal',t=>{
  const f=fixture(t);f.now=NOW+WINDOW;
  const deferred=run(f,{prepareSenderWork:()=>({outcome:'deferred',updates:[]})});
  assert.equal(deferred.calls,0);assert.equal(f.calls.length,0);
  const saved=task(f);assert.equal(saved.outcome,'deferred');assert.equal(saved.attempt_token,null);
  assert.equal(saved.reviewed_retry_at_ms,NOW+DAY);assert.equal(saved.failures,9);assert.equal(saved.schedule_failures,0);
  assert.equal(routes(f).length,0);ensureInitialized(f.db);assert.deepEqual(task(f),saved);
  rmSync(f.reviewPath);f.now=saved.retry_at_ms+1;
  assert.equal(runAfterRestart(f).calls,0);assert.deepEqual(task(f),saved);assertMissing(f);
});

test('unstarted command receipts and final self verification cannot erase the reviewed original deadline',t=>{
  const f=fixture(t);f.now=NOW+WINDOW;
  const receipt={version:1,launch_attempted:false,execution:'not_started',result_at_ms:null,
    result_kind:null,result_code:null,remote_result:false};
  const result=run(f,{respond:(args,options)=>{
    const operation=args[0]==='api'?'application_info':'chat_bots';
    options.onExecutionReceipt(receipt);
    throw new Error(`lark-cli failed: kind=unknown operation=${operation} reason=lease_unavailable ${formatLarkExecutionReceipt(receipt)}`);
  }});
  assert.equal(result.calls,3,'two bounded CLI admission attempts and one final account check retain their quota accounting');
  assert.equal(routes(f).length,0,'no name route produced an execution result');
  const saved=task(f);assert.equal(saved.reviewed_retry_at_ms,NOW+DAY);assert.equal(saved.failures,9);
  assert.equal(saved.schedule_failures,0);assert.equal(saved.attempt_token,null);
  rmSync(f.reviewPath);f.now=saved.retry_at_ms+1;
  assert.equal(runAfterRestart(f).calls,0);assert.deepEqual(task(f),saved);assertMissing(f);
});

test('a reviewed hold excludes primary and sibling routes even after the review and old retry deadlines',t=>{
  const f=fixture(t,{review:'hold'}),before=task(f);
  for(const offset of [WINDOW,DAY+1,DAY*2]) {f.now=NOW+offset;assert.equal(run(f).calls,0);}
  assert.equal(f.calls.length,0);assert.equal(task(f).failures,before.failures);assert.equal(task(f).evidence_json,null);
  assert.equal(routes(f).length,0,'a hold is not a fabricated API response');assertMissing(f);
});

test('exact permission, unavailable command, exhausted and malformed route states cannot gain an early sibling attempt',t=>{
  for(const mode of ['permission_denied','command_unavailable','exhausted','future_route']) {
    const f=fixture(t);
    const original=storeRoute(f,'application_info',mode==='exhausted'?'network_timeout':mode==='future_route'?'network_timeout':mode,
      {failures:mode==='exhausted'?3:1,blocked:['permission_denied','command_unavailable'].includes(mode)?1:0,
        lastAttempt:mode==='future_route'?NOW+WINDOW+1:NOW,retryAt:mode==='exhausted'?NOW+MINUTE:NOW+DAY});
    f.now=NOW+WINDOW;assert.equal(run(f).calls,0,mode);assert.equal(f.calls.length,0,mode);
    assert.deepEqual(routes(f),[original],mode);assert.equal(task(f).retry_at_ms,NOW+DAY);assertMissing(f);
  }
});

test('future and active-claim task clocks do not manufacture accelerated eligibility',t=>{
  for(const mode of ['future_attempt','active_claim']) {
    const f=fixture(t);
    if(mode==='future_attempt')sqliteExec(f.db,`UPDATE lark_im_name_tasks SET last_attempt_at_ms=${NOW+WINDOW+1};`);
    else sqliteExec(f.db,"UPDATE lark_im_name_tasks SET attempt_token='synthetic_existing_claim';");
    f.now=NOW+WINDOW;assert.equal(run(f).calls,0,mode);assert.equal(task(f).retry_at_ms,NOW+DAY);
    assert.equal(f.calls.length,0);assertMissing(f);
  }
});

test('the five-minute window is fixed across restart and wall-clock rollback',t=>{
  const f=fixture(t);
  for(const offset of [WINDOW-2,MINUTE,WINDOW-1]) {
    f.now=NOW+offset;ensureInitialized(f.db);assert.equal(run(f).calls,0);assert.equal(task(f).retry_at_ms,NOW+DAY);
  }
  f.now=NOW+WINDOW;assert.equal(run(f).reason,'resolved');assert.equal(f.calls.length,2);
});

test('a backward wall clock after review loading cannot issue an accelerated request',t=>{
  const f=fixture(t);f.now=NOW+WINDOW;let changed=false;
  const result=run(f,{readOnlyQuery:(db,sql,label,options)=>{
    const rows=readOnlySqliteJson(db,sql,label,options);
    if(label==='read exact name witness'&&!changed){changed=true;f.now-=1;}
    return rows;
  }});
  assert.ok(changed);assert.equal(result.calls,0);assert.equal(f.calls.length,0);assertMissing(f);
});

test('normal increasing wall-clock observations do not invalidate one reviewed recovery turn',t=>{
  const f=fixture(t);f.now=NOW+WINDOW;let reads=0;
  const result=run(f,{now:()=>f.now+reads++});
  assert.ok(reads>2);assert.equal(result.reason,'resolved');assert.equal(result.calls,2);
  const output=readMessages(f);assert.equal(output.json.length,1);assert.equal(output.json[0].readiness.state,'ready');
});

test('review expiry after a permission response preserves the response without launching a sibling route',t=>{
  const f=fixture(t);f.now=NOW+DAY-1;
  const result=run(f,{respond:args=>{
    assert.equal(args[0],'api');f.now=NOW+DAY+1;
    throw new Error('lark-cli failed: kind=permission_denied code=210508 operation=application_info');
  }});
  assert.equal(result.calls,2,'the started result still needs the existing final self profile');
  assert.equal(f.calls.filter(call=>call.args[0]==='api').length,1);
  assert.equal(f.calls.filter(call=>call.args[0]==='contact').length,1);
  assert.equal(f.calls.some(call=>call.args[1]==='chat.members'),false);
  const saved=routes(f);assert.equal(saved.length,1);assert.equal(saved[0].operation,'application_info');
  assert.equal(saved[0].failure_kind,'permission_denied');assert.equal(saved[0].failure_code,210508);assert.equal(saved[0].blocked,1);
  assert.equal(saved[0].last_attempt_at_ms,NOW+DAY+1);
  const before=f.calls.length;f.now+=WINDOW;assert.equal(run(f).calls,0);assert.equal(f.calls.length,before);
  assertMissing(f);
});

test('a concurrent task change rolls back cadence and claim without a request',t=>{
  const f=fixture(t);f.now=NOW+WINDOW;let changed=false;
  const result=run(f,{readOnlyQuery:(db,sql,label,options)=>{
    const rows=readOnlySqliteJson(db,sql,label,options);
    if(label==='read exact name witness'&&!changed){changed=true;sqliteExec(db,'UPDATE lark_im_name_tasks SET generation=generation+1;');}
    return rows;
  }});
  assert.ok(changed);assert.equal(result.calls,0);assert.equal(f.calls.length,0);assert.equal(task(f).attempt_token,null);
  const scan=query(f,'SELECT * FROM lark_im_name_scan;')[0];assert.equal(scan.schedule_sequence,0);assert.equal(scan.next_attempt_at_ms,0);
  assertMissing(f);
});

test('a concurrent reviewed-discovery cursor change rolls back the remote claim and cadence',t=>{
  const f=fixture(t);f.now=NOW+WINDOW;
  sqliteExec(f.db,`INSERT INTO lark_im_name_recovery_scan(account_key,after_task_key,generation) VALUES(${q(ACCOUNT)},'',1);`);
  let changed=false;
  const result=run(f,{readOnlyQuery:(db,sql,label,options)=>{
    const rows=readOnlySqliteJson(db,sql,label,options);
    if(label==='read reviewed name cursor'&&!changed) {
      changed=true;sqliteExec(db,`UPDATE lark_im_name_recovery_scan SET generation=2 WHERE account_key=${q(ACCOUNT)};`);
    }
    return rows;
  }});
  assert.ok(changed);assert.equal(result.calls,0);assert.equal(f.calls.length,0);assert.equal(task(f).attempt_token,null);
  assert.deepEqual(query(f,'SELECT * FROM lark_im_name_recovery_scan;'),[{account_key:ACCOUNT,after_task_key:'',generation:2}]);
  const scan=query(f,'SELECT * FROM lark_im_name_scan;')[0];assert.equal(scan.schedule_sequence,0);assert.equal(scan.next_attempt_at_ms,0);
  assertMissing(f);
});

test('a changed review file before claim prevents both application and fallback requests',t=>{
  const f=fixture(t);f.now=NOW+WINDOW;let changed=false;
  const result=run(f,{readOnlyQuery:(db,sql,label,options)=>{
    const rows=readOnlySqliteJson(db,sql,label,options);
    if(label==='read exact name witness'&&!changed) {
      changed=true;const replacement=f.reviewPath+'.replacement';
      writeFileSync(replacement,readFileSync(f.reviewPath),{mode:0o600});prepareSidecarFixture(replacement);renameSync(replacement,f.reviewPath);
    }
    return rows;
  }});
  assert.ok(changed);assert.equal(result.calls,0);assert.equal(f.calls.length,0);assertMissing(f);
});

test('a route CAS race discards the candidate name and cannot publish a false recovery',t=>{
  const f=fixture(t);const original=storeRoute(f,'application_info','network_timeout',{blocked:0,retryAt:NOW+MINUTE});
  f.now=NOW+WINDOW;let changed=false;
  const result=run(f,{respond:args=>{
    const actor=appFromArgs(args);changed=true;
    sqliteExec(f.db,`UPDATE lark_im_name_routes SET generation=generation+1 WHERE route_key=${q(original.route_key)};`);
    return {data:{app:{app_id:actor,app_name:nameFor(actor)}}};
  }});
  assert.ok(changed);assert.equal(result.reason,'unavailable');assert.equal(result.calls,2);
  assert.equal(task(f).evidence_json,null);assert.ok(task(f).attempt_token);
  assert.deepEqual(routes(f),[{...original,generation:original.generation+1}]);assertMissing(f);
});

test('transient legacy failures retain minute-scale eligibility without rewriting them as permission',t=>{
  const f=fixture(t);f.now=NOW+WINDOW;
  for(let attempt=0;attempt<3;attempt++) {
    const at=f.now;
    const result=run(f,{respond:args=>{if(args[0]==='api')throw new Error('lark-cli failed: kind=network_timeout operation=application_info');return {items:[]};}});
    assert.ok(result.calls<=4);const saved=task(f);
    assert.ok(saved.retry_at_ms>at&&saved.retry_at_ms<=at+WINDOW,'generic task failure cannot inherit the old 24-hour delay');
    assert.notEqual(saved.blocked_reason,'permission_denied');
    assert.equal(routes(f).some(row=>row.failure_kind==='permission_denied'),false);
    f.now=saved.retry_at_ms;
  }
  assert.ok(['retry_exhausted','routes_blocked'].includes(task(f).blocked_reason));assertMissing(f);
});

test('legacy recovery shares the unchanged minute cadence and global-oldest fair turn with fresh messages',t=>{
  const f=fixture(t);f.now=NOW+WINDOW;
  const requested=[];
  for(let turn=0;turn<3;turn++) {
    const fresh=`cli_synthetic_reviewed_fresh_${turn}`;addRecord(f,turn+2,fresh,`oc_synthetic_reviewed_fresh_${turn}`);
    const result=run(f,{respond:args=>{const actor=appFromArgs(args);requested.push(actor);return {data:{app:{app_id:actor,app_name:nameFor(actor)}}};}});
    assert.equal(result.calls,2);const calls=f.calls.length;
    assert.equal(run(f).calls,0);assert.equal(f.calls.length,calls,'repeat process cannot add quota');
    if(turn<2)f.now+=MINUTE+1;
  }
  assert.equal(requested.length,3);assert.equal(requested[2],APP,'the third fair turn must serve old reviewed debt');
  const output=readMessages(f);assert.equal(output.json.length,4,'one unresolved fresh row remains in the denominator');
  assert.equal(output.json.find(row=>row.actor_id===APP).readiness.state,'ready');
  assert.equal(output.json.filter(row=>row.readiness.state==='enriching').length,1);
});

test('a bounded prefix of denied legacy candidates cannot hide the next recoverable application',t=>{
  const f=fixture(t,{review:null});
  for(let i=2;i<=65;i++) {
    const actor=`cli_synthetic_reviewed_prefix_${i}`,chat=`oc_synthetic_reviewed_prefix_${i}`;
    const row=addRecord(f,i,actor,chat);
    sqliteExec(f.db,`INSERT INTO lark_im_name_tasks(source_id,account_key,task_key,kind,chat_id,actor_id,namespace,
      outcome,latest_record_id,serviced_record_id,retry_at_ms,last_attempt_at_ms,failures,generation)
      VALUES('lark.im',${q(ACCOUNT)},${q(nameTaskKey('sender',chat,actor,'app_id'))},'sender',${q(chat)},${q(actor)},'app_id',
      'failed',${row.id},${row.id},${NOW+DAY},${NOW},9,4);`);
  }
  const ordered=query(f,"SELECT * FROM lark_im_name_tasks WHERE kind='sender' ORDER BY last_served_sequence,enqueued_sequence,task_key;");
  assert.equal(ordered.length,65);const recoverable=ordered.at(-1).actor_id;
  writeReview(f,ordered.map(row=>({namespace:'app_id',actor_id:row.actor_id,decision:'retry_unknown'})));
  for(const row of ordered.slice(0,64))storeRoute(f,'application_info','permission_denied',{actor:row.actor_id});
  f.now=NOW+WINDOW;
  assert.equal(run(f).calls,0,'the denied page may advance only local discovery');
  const cursor=query(f,'SELECT * FROM lark_im_name_recovery_scan;')[0];
  assert.equal(cursor.after_task_key,ordered[63].task_key);
  assert.equal(query(f,'SELECT next_attempt_at_ms FROM lark_im_name_scan;')[0].next_attempt_at_ms,0,'local discovery does not consume remote cadence');
  ensureInitialized(f.db);ensureInitialized(f.db);
  assert.deepEqual(query(f,'SELECT * FROM lark_im_name_recovery_scan;')[0],cursor,'migration restart cannot lose the denied prefix');
  f.now+=1;assert.equal(runAfterRestart(f).calls,2,'the next process sees the first admissible target beyond the saved prefix');
  assert.equal(task(f,recoverable).outcome,'resolved','oldest admissible candidate must remain visible beyond a denied prefix');
  assert.equal(f.calls.length,0,'the first process did not request any denied target');
  assert.equal(routes(f).filter(row=>row.failure_kind==='permission_denied').length,64);
  const output=readMessages(f);assert.equal(output.json.length,65);
  assert.equal(output.json.filter(row=>row.readiness.state==='ready').length,1);
});

test('a denied prefix of expired reviewed claims cannot hide the next resumable application across processes',t=>{
  const f=fixture(t,{review:null});
  for(let i=2;i<=65;i++) {
    const actor=`cli_synthetic_reviewed_resume_prefix_${i}`,chat=`oc_synthetic_reviewed_resume_prefix_${i}`;
    const row=addRecord(f,i,actor,chat);
    sqliteExec(f.db,`INSERT INTO lark_im_name_tasks(source_id,account_key,task_key,kind,chat_id,actor_id,namespace,
      outcome,latest_record_id,serviced_record_id,retry_at_ms,last_attempt_at_ms,failures,generation)
      VALUES('lark.im',${q(ACCOUNT)},${q(nameTaskKey('sender',chat,actor,'app_id'))},'sender',${q(chat)},${q(actor)},'app_id',
      'failed',${row.id},${row.id},${NOW+DAY},${NOW},9,4);`);
  }
  // These authored states are the same persisted fields exercised by the real
  // process-exit tests above: the short lease expired, but original due did not.
  sqliteExec(f.db,`UPDATE lark_im_name_tasks SET reviewed_retry_at_ms=${NOW+DAY},
    retry_at_ms=${NOW+WINDOW*2},last_attempt_at_ms=${NOW+WINDOW},
    fresh_required_record_id=latest_record_id,
    attempt_token='synthetic_crashed_claim_'||task_key,generation=generation+1;`);
  const ordered=query(f,"SELECT * FROM lark_im_name_tasks WHERE kind='sender' ORDER BY task_key;");
  assert.equal(ordered.length,65);const recoverable=ordered.at(-1).actor_id;
  writeReview(f,ordered.map(row=>({namespace:'app_id',actor_id:row.actor_id,decision:'retry_unknown'})));
  for(const row of ordered.slice(0,64))storeRoute(f,'application_info','permission_denied',
    {actor:row.actor_id,lastAttempt:NOW+WINDOW+1});
  f.now=NOW+WINDOW*2+1;
  assert.equal(runAfterRestart(f).calls,0,'a resumed claim must not enter ordinary due or bypass its denied route');
  assert.equal(existsSync(join(f.dir,'restarted-api-calls.jsonl')),false);
  const cursor=query(f,'SELECT * FROM lark_im_name_recovery_scan;')[0];
  assert.equal(cursor.after_task_key,ordered[63].task_key);
  assert.equal(query(f,'SELECT next_attempt_at_ms FROM lark_im_name_scan;')[0].next_attempt_at_ms,0);
  ensureInitialized(f.db);ensureInitialized(f.db);
  assert.deepEqual(query(f,'SELECT * FROM lark_im_name_recovery_scan;')[0],cursor);
  f.now+=1;const resumed=runAfterRestart(f);
  assert.equal(resumed.reason,'resolved');assert.equal(resumed.calls,2);
  assert.equal(task(f,recoverable).reviewed_retry_at_ms,0);assert.equal(task(f,recoverable).attempt_token,null);
  for(const denied of ordered.slice(0,64))assert.deepEqual(task(f,denied.actor_id),denied,'denied claims retain their original due and state');
  assert.equal(routes(f).filter(row=>row.failure_kind==='permission_denied').length,64);
  const output=readMessages(f);assert.equal(output.json.length,65);
  assert.equal(output.json.filter(row=>row.readiness.state==='ready').length,1);
  assert.equal(output.json.find(row=>row.actor_id===recoverable).display.sender,'应用：'+nameFor(recoverable));
});

test('one accelerated turn cannot exceed four CLI calls including final profile verification',t=>{
  const f=fixture(t);f.now=NOW+WINDOW;
  const result=run(f,{prepareSenderWork:(_task,{runLark})=>{
    for(let i=0;i<4;i++)runLark(['api','GET',`/open-apis/application/v6/applications/${APP}`]);
    return {outcome:'unresolved',updates:[]};
  }});
  assert.equal(result.calls,4);assert.equal(f.calls.length,4);
  assert.equal(f.calls.filter(call=>call.args[0]==='api').length,3);
  assert.equal(f.calls.filter(call=>call.args[0]==='contact').length,1);assertMissing(f);
});

test('the ten-second shared budget includes review, lookup and final account verification',t=>{
  const f=fixture(t);f.now=NOW+WINDOW;
  const result=run(f,{respond:args=>{const actor=appFromArgs(args);f.elapsed=10001;return {data:{app:{app_id:actor,app_name:nameFor(actor)}}};}});
  assert.equal(result.calls,1);assert.equal(f.calls.length,1);assert.equal(task(f).evidence_json,null);
  assert.equal(f.calls.some(call=>call.args[0]==='contact'),false);assertMissing(f);
});
