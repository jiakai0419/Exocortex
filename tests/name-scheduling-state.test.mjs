import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureInitialized, reserveInitialLarkAccount, confirmInitialLarkAccountSql,
  quoteSql as q, sqliteExec, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';
import { syncNames } from '../src/adapters/lark-im/name-sync.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
const NOW=Date.parse('2032-04-05T06:07:00Z'), SELF='ou_synthetic_schedule_owner', ACCOUNT=recipientAccountKey(SELF);
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'exo-synthetic-name-state-')),db=join(dir,'synthetic.sqlite');
  t.after(()=>rmSync(dir,{recursive:true,force:true})); ensureInitialized(db);
  reserveInitialLarkAccount(db,ACCOUNT,new Date().toISOString());sqliteExec(db,confirmInitialLarkAccountSql(new Date().toISOString()));
  return {db,now:NOW,calls:[]};
}
const query=(f,sql)=>sqliteQuery(f.db,sql,'inspect authored scheduling state');
function add(f,id,actor,chat='oc_synthetic_schedule_first',namespace='app_id') {
  const raw={message_id:`om_synthetic_schedule_${id}`,chat_id:chat,chat_type:'group',
    sender:{id:actor,id_type:namespace,sender_type:namespace==='app_id'?'app':'user'}};
  const canonical={message_id:raw.message_id,chat_id:chat,chat_type:'group',chat_name:'Synthetic Known Group',chat_name_state:'cleared',
    sender_id:actor,sender_id_type:namespace,sender_name:null,msg_type:'text'};
  sqliteExec(f.db,`INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,record_type,actor_id,container_id,direction,body,canonical_json,raw_json)
    VALUES(${id},'lark.im','lark.im.sent_by_me',${q(raw.message_id)},'synthetic-v1','lark.im.message',${q(actor)},${q(chat)},'received','Preserved synthetic body',${q(JSON.stringify(canonical))},${q(JSON.stringify(raw))});`);
}
function run(f, respond) {
  return syncNames(f.db,{open_id:SELF},{now:()=>f.now,monotonicNow:()=>0,
    syncRecipients:()=>assert.fail('group-only workload must not reserve an empty recipient turn'),
    runLark:(args,options)=>{
      f.calls.push(args);assert.equal(options.retries,0);
      if(args[0]==='contact'&&args[1]==='+get-user')return {open_id:SELF};
      if(args[0]==='im'&&args[1]==='chats')return {data:{chat_id:JSON.parse(args[args.indexOf('--params')+1]).chat_id,chat_mode:'group',name:'Synthetic Known Group'}};
      return respond(args);
    }});
}
const permission=operation=>{throw new Error(`lark-cli failed: kind=permission_denied code=210508 operation=${operation}`);};

test('typed permission state survives new traffic, while a different chat may use its exact bot route',t=>{
  const f=fixture(t),app='cli_synthetic_schedule_app';add(f,1,app);
  const first=run(f,args=>permission(args[0]==='api'?'application_info':'chat_bots'));
  assert.equal(first.calls,3);assert.equal(first.updated,0);
  const task=query(f,"SELECT * FROM lark_im_name_tasks WHERE kind='sender';")[0];
  assert.equal(task.blocked_reason,'permission_denied');assert.equal(task.attempt_token,null);
  assert.equal(query(f,'SELECT COUNT(*) AS n FROM lark_im_name_routes WHERE blocked=1 AND failure_code=210508;')[0].n,2);
  const attempts=f.calls.length;add(f,2,app);f.now+=60001;
  run(f,()=>assert.fail('new message must not reopen the exact denied route'));
  assert.equal(f.calls.slice(attempts).some(args=>args[0]==='api'||args[1]==='chat.members'),false);
  const other='oc_synthetic_schedule_second';add(f,3,app,other);f.now+=60001;
  const before=f.calls.length;
  for(let turn=0;turn<3;turn++) {
    run(f,args=>{
      assert.equal(args.slice(0,3).join(' '),'im chat.members bots');
      assert.equal(JSON.parse(args[args.indexOf('--params')+1]).chat_id,other);
      return {items:[{app_id:app,name:'Synthetic Exact App'}]};
    });f.now+=60001;
    if(JSON.parse(query(f,'SELECT canonical_json FROM records WHERE id=3;')[0].canonical_json).sender_name)break;
  }
  assert.equal(f.calls.slice(before).some(args=>args[0]==='api'),false,'same typed app shares only application-route denial');
  assert.equal(JSON.parse(query(f,'SELECT canonical_json FROM records WHERE id=3;')[0].canonical_json).sender_name,'Synthetic Exact App');
});

test('a route CAS conflict rolls back name, route result and scheduling result together',t=>{
  const f=fixture(t),actor='ou_synthetic_schedule_person';add(f,1,actor,undefined,'open_id');
  const first=run(f,()=>{throw new Error('lark-cli failed: kind=network_timeout operation=contact_search');});
  assert.equal(first.reason,'failed');
  const route=query(f,"SELECT * FROM lark_im_name_routes WHERE operation='contact_search';")[0];
  f.now+=300001;let changed=false;
  const result=run(f,args=>{
    if(args[0]==='contact') {
      sqliteExec(f.db,`UPDATE lark_im_name_routes SET generation=generation+1 WHERE route_key=${q(route.route_key)};`);
      changed=true;return {users:[{open_id:actor,name:'Must not commit'}]};
    }
    assert.fail('unexpected member fallback');
  });
  assert.equal(changed,true);assert.equal(result.reason,'unavailable');
  assert.equal(JSON.parse(query(f,'SELECT canonical_json FROM records WHERE id=1;')[0].canonical_json).sender_name,null);
  const task=query(f,"SELECT * FROM lark_im_name_tasks WHERE kind='sender';")[0];
  assert.ok(task.attempt_token);assert.equal(task.schedule_failures,1);
  assert.equal(query(f,`SELECT failures FROM lark_im_name_routes WHERE route_key=${q(route.route_key)};`)[0].failures,1);
});

test('three unclassified task failures are exhausted separately from permission and fresh rows cannot reset them',t=>{
  const f=fixture(t),app='cli_synthetic_schedule_unknown';add(f,1,app);
  for(let turn=0;turn<9;turn++) {
    run(f,()=>{throw new Error('Synthetic private prose without a transport descriptor');});
    f.now+=600001;
    const task=query(f,"SELECT * FROM lark_im_name_tasks WHERE kind='sender';")[0];
    if(task.blocked_reason)break;
  }
  const task=query(f,"SELECT * FROM lark_im_name_tasks WHERE kind='sender';")[0];
  assert.ok(['retry_exhausted','routes_blocked'].includes(task.blocked_reason));
  assert.notEqual(task.blocked_reason,'permission_denied');
  assert.equal(query(f,"SELECT COUNT(*) AS n FROM lark_im_name_routes WHERE failure_kind='permission_denied';")[0].n,0);
  f.now=task.last_attempt_at_ms+60001;
  assert.ok(f.now<task.retry_at_ms,'fresh traffic arrives before the bounded recovery probe');
  add(f,2,app);const before=f.calls.length;
  run(f,()=>assert.fail('new record cannot reset a terminal failure episode'));
  assert.equal(f.calls.slice(before).some(args=>args[0]==='api'||args[1]==='chat.members'),false);
});

test('a nonempty legacy label without its own adopted account is enrolled and repaired by exact current authority',t=>{
  const f=fixture(t),actor='ou_synthetic_unproven_person';add(f,1,actor,undefined,'open_id');
  const original=query(f,'SELECT * FROM records WHERE id=1;')[0];
  const legacy={...JSON.parse(original.canonical_json),sender_name:'Synthetic Legacy Label',sender_name_source:'contact',sender_name_confidence:'high'};
  sqliteExec(f.db,`UPDATE records SET canonical_json=${q(JSON.stringify(legacy))} WHERE id=1;`);
  const result=run(f,args=>{
    assert.equal(args.slice(0,2).join(' '),'contact +search-user');
    return {users:[{open_id:actor,name:'Synthetic Verified Current Name'}]};
  });
  assert.equal(result.reason,'resolved');assert.equal(result.calls,2);assert.equal(result.updated,1);
  const row=query(f,'SELECT * FROM records WHERE id=1;')[0],canonical=JSON.parse(row.canonical_json);
  assert.equal(canonical.sender_name,'Synthetic Verified Current Name');
  assert.equal(canonical.sender_name_account_key,ACCOUNT);
  assert.equal(canonical.sender_name_verification.status,'resolved');
  assert.equal(canonical.sender_name_verification.reason,'exact_id_match');
  assert.equal(canonical.sender_name_verification.account_key,ACCOUNT);
  assert.equal(canonical.sender_name_source,'contact');
  assert.equal(row.raw_json,original.raw_json);assert.equal(row.body,original.body);
  assert.equal(row.content_hash,original.content_hash);assert.equal(row.occurred_at,original.occurred_at);
  assert.equal(query(f,"SELECT outcome FROM lark_im_name_tasks WHERE kind='sender';")[0].outcome,'resolved');
});

test('a proven adopted name does not enroll extra sender work, and a foreign account label is never re-bound',t=>{
  for(const account of [ACCOUNT,'f'.repeat(64)]) {
    const f=fixture(t),actor='ou_synthetic_proven_person';add(f,1,actor,undefined,'open_id');
    const row=query(f,'SELECT * FROM records WHERE id=1;')[0];
    const canonical={...JSON.parse(row.canonical_json),sender_name:'Synthetic Bound Name',sender_name_source:'contact',sender_name_confidence:'high',sender_name_account_key:account};
    sqliteExec(f.db,`UPDATE records SET canonical_json=${q(JSON.stringify(canonical))} WHERE id=1;`);
    const before=query(f,'SELECT canonical_json FROM records WHERE id=1;')[0].canonical_json;
    const result=run(f,()=>assert.fail('proven or foreign label must not trigger a remote repair'));
    assert.equal(result.calls,0);assert.equal(f.calls.length,0);
    assert.equal(query(f,"SELECT COUNT(*) AS n FROM lark_im_name_tasks WHERE kind='sender';")[0].n,0);
    assert.equal(query(f,'SELECT canonical_json FROM records WHERE id=1;')[0].canonical_json,before);
  }
});
