import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureInitialized,quoteSql,sqliteExec,sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';
import { syncNames } from '../src/adapters/lark-im/name-sync.mjs';
import { loadMessages } from '../src/diagnostics/messages-report.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';

// Entirely authored fixtures, never derived from local accounts or messages.
const SELF='ou_synthetic_name_owner', CHAT='oc_synthetic_name_group', NOW=Date.parse('2025-01-02T03:04:05.000Z');
function fixture(t, count=1, options={}) {
  const dir=mkdtempSync(join(tmpdir(),'exo-name-sync-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const f={db:join(dir,'synthetic.sqlite'),now:NOW,elapsed:0,calls:[],name:'Current synthetic title',mode:'group'};
  ensureInitialized(f.db);
  const statements=[];
  if(options.scope) statements.push(`INSERT INTO sync_scopes(id,source_id,name,enabled,config_json)
    VALUES(${quoteSql(chatScopeId(CHAT))},'lark.im','authored group',0,${quoteSql(JSON.stringify({chat_id:CHAT,chat_type:'group',chat_name:'Legacy scope title'}))});`);
  for(let id=1;id<=count;id++) {
    // These title/recipient scheduling cases start with an exact native sender name.
    const raw={message_id:`om_synthetic_name_${id}`,chat_id:CHAT,chat_type:'group',sender:{id:SELF,id_type:'open_id',sender_type:'user',name:'Synthetic Owner'}};
    const canonical={message_id:raw.message_id,chat_id:CHAT,chat_type:'group',sender_id:SELF,sender_id_type:'open_id',sender_name:'Synthetic Owner',chat_name:'Legacy message title',...options.canonical};
    statements.push(`INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,record_type,actor_id,container_id,direction,body,canonical_json,raw_json)
      VALUES(${id},'lark.im','lark.im.sent_by_me',${quoteSql(raw.message_id)},'opaque-name-version','lark.im.message',${quoteSql(SELF)},${quoteSql(CHAT)},'sent',
      'Authored body remains byte-for-byte.',${quoteSql(JSON.stringify(canonical))},${quoteSql(JSON.stringify(raw))});`);
  }
  sqliteExec(f.db,statements.join('\n'),'create authored name fixtures');
  return f;
}
const rows=f=>sqliteQuery(f.db,'SELECT * FROM records ORDER BY id;','inspect synthetic records');
const tasks=f=>sqliteQuery(f.db,'SELECT * FROM lark_im_name_tasks ORDER BY task_key;','inspect synthetic work');
function run(f, overrides={}) {
  if(f.hasRun)f.now+=60001;
  f.hasRun=true;
  return syncNames(f.db,{open_id:SELF,name:'Synthetic Owner'},{now:()=>f.now,monotonicNow:()=>f.elapsed,
    syncRecipients:()=>({reason:'idle'}),runLark:(args,opts)=>{
      f.calls.push(args); assert.equal(opts.retries,0); assert.ok(opts.timeoutMs<=5000&&opts.retryBudgetMs<=10000);
      assert.equal(sqliteQuery(f.db,'SELECT count(*) AS n FROM maintenance_locks;','inspect short transaction')[0].n,0);
      if(args[0]==='contact') return {open_id:SELF,name:'Synthetic Owner'};
      if(args.slice(0,3).join(' ')==='im chats get') return {data:{chat_id:CHAT,chat_mode:f.mode,name:f.name}};
      throw new Error('unexpected synthetic API route');
    },...overrides});
}
function assertNameOnly(before,after) {
  assert.equal(before.length,after.length);
  for(let i=0;i<before.length;i++) {
    const a={...before[i]},b={...after[i]}; delete a.canonical_json;delete b.canonical_json; assert.deepEqual(b,a);
    const ca=JSON.parse(before[i].canonical_json),cb=JSON.parse(after[i].canonical_json);
    delete cb.chat_name_account_key; assert.deepEqual(cb,ca);
  }
}
test('no inherited API lease produces no claims or database writes',t=>{
  const f=fixture(t),before=readFileSync(f.db);
  assert.equal(syncNames(f.db,{open_id:SELF}).reason,'lease_unavailable');
  assert.deepEqual(readFileSync(f.db),before);
});
test('current official title works without a scope, preserving every content column',t=>{
  const f=fixture(t),before=rows(f);
  const result=run(f); assert.equal(result.reason,'resolved'); assert.equal(result.calls,2); assert.equal(result.updated,1);
  assertNameOnly(before,rows(f));
  const output=loadMessages(f.db,{direction:'all',limit:10,search:''});
  assert.equal(output[0].display.chat,f.name); assert.equal(output[0].canonical.chat_name,'Legacy message title');
  assert.equal(sqliteQuery(f.db,`SELECT count(*) AS n FROM sync_scopes WHERE id=${quoteSql(chatScopeId(CHAT))};`,'no collection scope')[0].n,0);
  assert.equal(tasks(f)[0].retry_at_ms,f.now+24*60*60_000);
});
test('disabled scope stays disabled, and sparse metadata never destroys a known observation',t=>{
  const f=fixture(t,1,{scope:true});run(f);const first=tasks(f)[0].evidence_json;
  f.now+=24*60*60_000;f.name=null;run(f);run(f);
  assert.equal(tasks(f)[0].evidence_json,first);
  assert.equal(loadMessages(f.db,{direction:'all',limit:10,search:''})[0].display.chat,'Current synthetic title');
  assert.equal(sqliteQuery(f.db,`SELECT enabled FROM sync_scopes WHERE id=${quoteSql(chatScopeId(CHAT))};`,'scope unchanged')[0].enabled,0);
});
test('title refresh changes only display and retains the new title after empty metadata',t=>{
  const f=fixture(t);run(f);f.now+=86400001;f.name='Renamed synthetic group';run(f);run(f);
  assert.equal(loadMessages(f.db,{direction:'all',limit:10,search:''})[0].display.chat,f.name);
  f.now+=86400001;f.name='';run(f);run(f);
  assert.equal(loadMessages(f.db,{direction:'all',limit:10,search:''})[0].display.chat,'Renamed synthetic group');
});
test('explicit clear cannot be enrolled or revived',t=>{
  const f=fixture(t,1,{canonical:{chat_name:null,chat_name_state:'cleared'}});const before=rows(f);
  run(f);assert.equal(tasks(f).length,0);assert.deepEqual(rows(f),before);assert.equal(f.calls.length,0);
});
test('profile mismatch after lookup commits neither evidence nor name projection',t=>{
  const f=fixture(t),before=rows(f);
  const result=run(f,{runLark:args=>args[0]==='contact'?{open_id:'ou_synthetic_other_owner'}:{data:{chat_id:CHAT,chat_mode:'group',name:'Wrong account title'}}});
  assert.equal(result.reason,'account_conflict');assert.deepEqual(rows(f),before);assert.equal(tasks(f)[0].evidence_json,null);
  assert.ok(tasks(f)[0].attempt_token);
});
test('concurrent message change rolls back evidence and allows claim expiry recovery',t=>{
  const f=fixture(t);let changed=false;
  const result=run(f,{runLark:args=>{
    if(args[0]==='contact') return {open_id:SELF};
    if(!changed){sqliteExec(f.db,"UPDATE records SET body='Concurrent authored edit' WHERE id=1;",'inject concurrent content');changed=true;}
    return {data:{chat_id:CHAT,chat_mode:'group',name:'Delayed title'}};
  }});
  assert.equal(result.reason,'unavailable');assert.equal(tasks(f)[0].evidence_json,null);
  assert.equal(JSON.parse(rows(f)[0].canonical_json).chat_name_account_key,undefined);
  f.now+=300001;run(f);run(f);
  assert.equal(tasks(f)[0].outcome,'resolved');assert.equal(rows(f)[0].body,'Concurrent authored edit');
});
test('group projection advances in bounded pages across new coordinator invocations',t=>{
  const f=fixture(t,45),before=rows(f);let changes=[];
  for(let i=0;i<6;i++){const result=run(f);changes.push(result.updated);f.now++;}
  assert.ok(changes.every(n=>n<=20));assert.equal(rows(f).filter(row=>JSON.parse(row.canonical_json).chat_name_account_key).length,45);
  assertNameOnly(before,rows(f));assert.equal(f.calls.filter(args=>args[0]==='im').length,1);
});
test('all optional roles share four request slots and the remaining deadline',t=>{
  const f=fixture(t,1,{canonical:{chat_type:'p2p'}});
  // Clear group declarations in the raw fixture too, leaving recipient work.
  sqliteExec(f.db,"UPDATE records SET raw_json=json_set(raw_json,'$.chat_type','p2p');",'author p2p fixture');
  const result=run(f,{syncRecipients:(db,self,deps)=>{
    assert.ok(deps.budgetMs<=10000);
    for(let n=0;n<10;n++) deps.runLark(['contact','synthetic']);return {reason:'completed'};
  }});
  assert.equal(result.reason,'budget');assert.equal(result.calls,4);assert.equal(f.calls.length,4);
});
test('successive worker commands share a persisted one-minute opportunity',t=>{
  const f=fixture(t);run(f);const before=readFileSync(f.db),calls=f.calls.length;
  const second=syncNames(f.db,{open_id:SELF},{now:()=>f.now+1,runLark:()=>assert.fail('cadence must not request')});
  assert.equal(second.reason,'cadence');assert.equal(f.calls.length,calls);assert.deepEqual(readFileSync(f.db),before);
});
test('a role result cannot accidentally disable exponential failure backoff',t=>{
  const f=fixture(t);
  const failure={prepareChatWork:()=>({outcome:'failed',retryDelayMs:300000,updates:[]})};
  run(f,failure);assert.equal(tasks(f)[0].failures,1);
  f.now+=300001;run(f,failure);run(f,failure);
  assert.equal(tasks(f)[0].failures,2);
  assert.equal(tasks(f)[0].retry_at_ms-tasks(f)[0].last_attempt_at_ms,600000);
});
test('historical scan fixes a horizon so new arrivals cannot starve old rows',t=>{
  const f=fixture(t,121);run(f);
  const scan=()=>sqliteQuery(f.db,`SELECT * FROM lark_im_name_scan WHERE account_key=${quoteSql(recipientAccountKey(SELF))};`,'inspect fair scan')[0];
  assert.equal(scan().after_record_id,40);assert.equal(scan().horizon_record_id,121);
  sqliteExec(f.db,"INSERT INTO records SELECT 999,source_id,first_seen_scope_id,'om_synthetic_new_tail',external_version,record_type,occurred_at,occurred_at_ms,received_at,actor_id,container_id,direction,title,body,content_hash,canonical_json,raw_json,created_at,updated_at FROM records WHERE id=1;",'author continuous arrival');
  run(f);assert.equal(scan().after_record_id,80);assert.equal(scan().horizon_record_id,121);
});
