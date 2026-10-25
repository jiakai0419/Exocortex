import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/u,'');
const {ensureInitialized,reserveInitialLarkAccount,confirmInitialLarkAccountSql,quoteSql,sqliteExec,sqliteQuery}=await import(`${ROOT}/dist/storage/sqlite/ingestion-store.js`);
const {syncNames}=await import(`${ROOT}/src/adapters/lark-im/name-sync.mjs`);
const {chatScopeId}=await import(`${ROOT}/src/adapters/lark-im/core.mjs`);
const {recipientAccountKey}=await import(`${ROOT}/src/adapters/lark-im/p2p-recipient.mjs`);
const {nameTaskKey}=await import(`${ROOT}/src/adapters/lark-im/name-evidence.mjs`);
const SELF='ou_independent_round_two_self', ACTOR='ou_independent_round_two_actor', CHAT='oc_independent_round_two_chat';
const ACCOUNT=recipientAccountKey(SELF), NOW=Date.parse('2026-09-01T00:00:00.000Z');
const digest=value=>createHash('sha256').update(value).digest('hex');

// Every row, account and response is authored below. This worker never invokes
// a connector. A separate process ensures progress survives JS module restarts.
if(process.argv[2]==='worker') {
  const result=syncNames(process.argv[3],{open_id:SELF},{now:()=>Number(process.argv[4]),monotonicNow:()=>0,
    syncRecipients:()=>({reason:'idle'}),runLark:(args,opts)=>{
      assert.equal(opts.retries,0);assert.ok(opts.timeoutMs<=5000&&opts.retryBudgetMs<=10000);
      if(args[0]==='contact'&&args[1]==='+search-user')return {users:[{open_id:ACTOR,name:'Verified Synthetic Actor'}]};
      if(args[0]==='contact')return {open_id:SELF};
      if(args.slice(0,3).join(' ')==='im chats get')return {data:{chat_id:CHAT,chat_mode:'group',name:'Verified Synthetic Group'}};
      throw new Error('Unexpected synthetic route');
    }});
  process.stdout.write(JSON.stringify(result));process.exit(0);
}
const execute=(f,sql)=>sqliteExec(f.db,sql,'author synthetic round two fixture');
const query=(f,sql)=>sqliteQuery(f.db,sql,'inspect synthetic round two fixture');
function add(f,first,last,{unknown=false,bytes=0}={}) {
  const sql=[];
  for(let id=first;id<=last;id++) {
    const raw={message_id:`om_independent_round_two_${id}`,chat_id:CHAT,chat_type:'group',sender:{id:ACTOR,id_type:'open_id',sender_type:'user'}};
    const canonical={message_id:raw.message_id,chat_id:CHAT,chat_type:'group',sender_id:ACTOR,sender_id_type:'open_id',sender_name:unknown?null:'Known Synthetic Actor',chat_name:null};
    sql.push(`INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,record_type,actor_id,container_id,direction,body,canonical_json,raw_json)
      VALUES(${id},'lark.im',${quoteSql(chatScopeId(CHAT))},${quoteSql(raw.message_id)},'synthetic-version','lark.im.message',${quoteSql(ACTOR)},${quoteSql(CHAT)},'received',
      ${bytes?`printf('%.*c',${bytes},'x')`:quoteSql('Synthetic body preserved')},${quoteSql(JSON.stringify(canonical))},${quoteSql(JSON.stringify(raw))});`);
  }
  execute(f,sql.join('\n'));f.latest=last;
}
function fixture(t,count,options={}) {
  const dir=mkdtempSync(join(tmpdir(),'exo-independent-round-two-')),f={dir,db:join(dir,'synthetic.sqlite'),now:NOW};
  t.after(()=>rmSync(dir,{recursive:true,force:true}));ensureInitialized(f.db);
  reserveInitialLarkAccount(f.db,ACCOUNT,new Date().toISOString());
  execute(f,confirmInitialLarkAccountSql(new Date().toISOString()));
  execute(f,`INSERT INTO sync_scopes(id,source_id,name,enabled,config_json) VALUES(${quoteSql(chatScopeId(CHAT))},'lark.im','Synthetic unnamed scope',0,${quoteSql(JSON.stringify({chat_id:CHAT,chat_type:'group'}))});`);
  add(f,1,count,options);return f;
}
function seedTask(f,latest,kind='chat') {
  const actor=kind==='sender'?ACTOR:'',namespace=kind==='sender'?'open_id':'';
  execute(f,`INSERT INTO lark_im_name_tasks(source_id,account_key,task_key,kind,chat_id,actor_id,namespace,latest_record_id,retry_at_ms)
    VALUES('lark.im',${quoteSql(ACCOUNT)},${quoteSql(nameTaskKey(kind,CHAT,actor,namespace))},${quoteSql(kind)},${quoteSql(CHAT)},${quoteSql(actor)},${quoteSql(namespace)},${latest},${f.now});`);
}
function cycle(f,step=60001) {
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'worker',f.db,String(f.now)],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);assert.ok(result.calls<=4);
  f.now+=step;return {result,tasks:query(f,'SELECT * FROM lark_im_name_tasks ORDER BY kind;')};
}
const chat=f=>query(f,"SELECT * FROM lark_im_name_tasks WHERE kind='chat';")[0];
const marks=f=>query(f,"SELECT id,json_extract(canonical_json,'$.chat_name_account_key') AS marker,json_extract(canonical_json,'$.sender_name') AS sender FROM records ORDER BY id;");
function displayed(f) {
  const guard=join(f.dir,'deny-network.mjs');
  writeFileSync(guard,"import { Socket } from 'node:net'; const deny=()=>{throw new Error('Synthetic test forbids network')}; globalThis.fetch=deny; Socket.prototype.connect=deny;\n");
  execute(f,'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');const before=digest(readFileSync(f.db));
  const cli=spawnSync(process.execPath,['--import',guard,join(ROOT,'bin/exocortex.mjs'),'messages','--db',f.db,'--direction','received','--format','json','--limit','1000','--search','Synthetic body preserved'],{
    cwd:f.dir,encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024,env:{...process.env,LARK_CLI:'/usr/bin/false',NO_COLOR:'1'}});
  assert.equal(cli.status,0,cli.stderr||cli.stdout);assert.equal(digest(readFileSync(f.db)),before,'messages CLI must remain read-only');
  return JSON.parse(cli.stdout);
}

test('invalid exact witness plus twenty oversized predecessors advances fallback across process restarts',t=>{
  const f=fixture(t,45);seedTask(f,45);
  execute(f,"UPDATE records SET body=printf('%.*c',2200000,'x') WHERE id<=20; UPDATE records SET canonical_json=json_set(canonical_json,'$.chat_name_state','cleared') WHERE id>=22;");
  const first=cycle(f);assert.equal(first.result.reason,'witness_unavailable');
  assert.equal(chat(f).witness_after_record_id,20);assert.equal(chat(f).witness_horizon_record_id,45);
  for(let n=0;n<8;n++)cycle(f,360001);
  assert.equal(marks(f).find(row=>row.id===21).marker,ACCOUNT);
  assert.equal(marks(f).find(row=>row.id===45).marker,null);
  assert.equal(displayed(f).find(row=>row.id===21).display.chat,'Verified Synthetic Group');
  assert.equal(query(f,`SELECT enabled FROM sync_scopes WHERE id=${quoteSql(chatScopeId(CHAT))};`)[0].enabled,0);
});

test('fixed projection horizon completes before old capacity debt is revisited despite continuous arrivals',t=>{
  const f=fixture(t,45);execute(f,"UPDATE records SET body=printf('%.*c',2200000,'x') WHERE id=1;");
  cycle(f);assert.equal(chat(f).after_record_id,20);assert.equal(chat(f).projection_horizon_record_id,45);
  let completed=false,restored=false;
  for(let n=0;n<12;n++) {
    add(f,f.latest+1,f.latest+30);cycle(f);
    const state=chat(f);
    if(!completed) {
      assert.equal(state.projection_horizon_record_id,45,'incoming traffic cannot move an active horizon');
      if(state.after_record_id>=45) {
        completed=true;assert.equal(state.projection_deferred,1);
        execute(f,"UPDATE records SET body='Synthetic body preserved' WHERE id=1;");
      }
    }
    if(completed&&marks(f)[0].marker===ACCOUNT){restored=true;break;}
  }
  assert.ok(completed);assert.ok(restored,'old repaired capacity debt must be reached even while latest increases');
  assert.equal(displayed(f).find(row=>row.id===1).display.chat,'Verified Synthetic Group');
});

test('aggregate byte limit keeps the first unprocessed normal row at the next cursor',t=>{
  const f=fixture(t,7,{bytes:800000});cycle(f);
  assert.equal(chat(f).after_record_id,2);assert.deepEqual(marks(f).filter(row=>row.marker).map(row=>row.id),[1,2]);
  for(let n=0;n<7;n++)cycle(f);
  assert.equal(marks(f).filter(row=>row.marker).length,7);assert.equal(chat(f).after_record_id,7);
});

for(const [field,value] of [['latest_record_id',3],['after_record_id',1],['projection_horizon_record_id',2],['projection_deferred',1],['witness_after_record_id',1],['witness_horizon_record_id',2]]) {
  test(`a concurrent ${field} change rejects the entire prepared projection`,t=>{
    const f=fixture(t,2);let injected=false;
    const result=syncNames(f.db,{open_id:SELF},{now:()=>f.now,monotonicNow:()=>0,syncRecipients:()=>({reason:'idle'}),runLark:args=>{
      if(args[0]==='contact')return {open_id:SELF};
      assert.equal(args.slice(0,3).join(' '),'im chats get');
      execute(f,`UPDATE lark_im_name_tasks SET ${field}=${value} WHERE kind='chat';`);injected=true;
      return {data:{chat_id:CHAT,chat_mode:'group',name:'Must Never Be Adopted'}};
    }});
    assert.ok(injected);assert.equal(result.reason,'unavailable');
    assert.equal(chat(f)[field],value,'the concurrent author remains intact');
    assert.equal(chat(f).evidence_json,null);assert.ok(chat(f).attempt_token,'the rejected result cannot release a changed claim');
    assert.ok(marks(f).every(row=>row.marker===null),'record updates must roll back together with task progress');
  });
}
