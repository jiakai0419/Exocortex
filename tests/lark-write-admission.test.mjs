import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, copyFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureInitialized, sqliteExec, sqliteQuery, quoteSql, reserveInitialLarkAccount, confirmInitialLarkAccountSql } from '../dist/storage/sqlite/ingestion-store.js';
import { larkWriteAdmissionSql } from '../dist/storage/sqlite/lark-write-admission.js';
import { captureLarkWriteAdmission } from '../src/diagnostics/lark-write-admission.mjs';
import { activityDatabaseKey } from '../src/diagnostics/lark-im-activity-evidence.mjs';
import { executeLarkImReplay, validateReplayOptions } from '../src/maintenance/replay.mjs';
import { executeEnrichment } from '../src/maintenance/enrich.mjs';
import { createMaintenanceRequestSession } from '../src/maintenance/request-session.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';

// Fictional identities/data only. sqliteExec opens a separate SQLite connection
// each time: the contender really commits after observation, before writer BEGIN.
const A='ou_admission_a', B='ou_admission_b', PEER='ou_admission_peer', CHAT='oc_admission_room';
const SCOPE=chatScopeId(CHAT), START=Date.parse('2040-01-01T00:00:00Z'), END=START+60_000;
const key=id=>createHash('sha256').update(`lark.im\0${id}`).digest('hex');
const q=quoteSql;
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'synthetic-write-admission-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=join(dir,'fixture.sqlite'); ensureInitialized(db);
  sqliteExec(db,`UPDATE sources SET config_json='{"initial_sync_start_ms":${START},"opaque":9007199254740993}' WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(SCOPE)},'lark.im','Synthetic room','{"chat_id":"${CHAT}","chat_type":"group","opaque":9007199254740993}');`);
  return {db,dir};
}
function sent(db,id=B) {
  sqliteExec(db,`INSERT INTO records(source_id,first_seen_scope_id,external_id,record_type,direction,actor_id,canonical_json,raw_json)
    VALUES('lark.im','lark.im.sent_by_me',${q(`synthetic_${id}`)},'lark.im.message','sent',${q(id)},${q(JSON.stringify({sender_id:id,sender_id_type:'open_id'}))},'{}');`);
}
function bind(db,id=A,confirmed=false) {
  reserveInitialLarkAccount(db,key(id),new Date(Date.now()-1000).toISOString());
  if(confirmed) sqliteExec(db,`BEGIN IMMEDIATE;${confirmInitialLarkAccountSql(new Date().toISOString())}COMMIT;`);
}
function guarded(db,admission) {
  sqliteExec(db,`BEGIN IMMEDIATE;${larkWriteAdmissionSql(admission.fence)}
    UPDATE sync_scopes SET name='Admitted' WHERE id=${q(SCOPE)};COMMIT;`);
}
const name=db=>sqliteQuery(db,`SELECT name FROM sync_scopes WHERE id=${q(SCOPE)}`)[0].name;
const count=(db,table)=>sqliteQuery(db,`SELECT COUNT(*) n FROM ${table}`)[0].n;

for(const mutation of ['foreign initial binding','foreign sent actor','disabled source','source config','scope disabled','scope config']) {
  test(`final SQL rejects ${mutation} committed after the last JS check`,t=>{
    const {db}=fixture(t), admission=captureLarkWriteAdmission(db,{selfOpenId:A,scopeIds:[SCOPE]});
    admission.assertCurrent();
    if(mutation==='foreign initial binding') bind(db,B,true);
    else if(mutation==='foreign sent actor') sent(db);
    else sqliteExec(db,{
      'disabled source':"UPDATE sources SET enabled=0 WHERE id='lark.im'",
      'source config':"UPDATE sources SET config_json=json_set(config_json,'$.opaque',9007199254740992) WHERE id='lark.im'",
      'scope disabled':`UPDATE sync_scopes SET enabled=0 WHERE id=${q(SCOPE)}`,
      'scope config':`UPDATE sync_scopes SET config_json=json_set(config_json,'$.opaque',9007199254740992) WHERE id=${q(SCOPE)}`,
    }[mutation]);
    assert.throws(()=>guarded(db,admission),/failed/);
    assert.equal(name(db),'Synthetic room');
  });
}

test('unbound remains unbound; the final SQL preserves unknown integer text',t=>{
  const {db}=fixture(t), a=captureLarkWriteAdmission(db,{selfOpenId:A,scopeIds:[SCOPE]});
  guarded(db,a); assert.equal(name(db),'Admitted');
  const text=sqliteQuery(db,"SELECT config_json FROM sources WHERE id='lark.im'")[0].config_json;
  assert.equal(text,`{"initial_sync_start_ms":${START},"opaque":9007199254740993}`);
});

test('same-account pending to confirmed is an admitted transition',t=>{
  const {db}=fixture(t); bind(db);
  const a=captureLarkWriteAdmission(db,{selfOpenId:A,scopeIds:[SCOPE]});
  sqliteExec(db,`BEGIN IMMEDIATE;${confirmInitialLarkAccountSql(new Date().toISOString())}COMMIT;`);
  a.assertCurrent(); guarded(db,a); assert.equal(name(db),'Admitted');
});

test('same-account reservation after an unbound read is allowed, foreign is not',t=>{
  const {db}=fixture(t), a=captureLarkWriteAdmission(db,{selfOpenId:A});
  bind(db,A,true); guarded(db,a); assert.equal(name(db),'Admitted');
});

test('verified history policy cannot be downgraded to pending or unbound',t=>{
  for(const path of ['pending','absent']) {
    const {db}=fixture(t); bind(db,A,true);
    const a=captureLarkWriteAdmission(db,{selfOpenId:A,requireVerified:true});
    sqliteExec(db,`UPDATE sources SET config_json=${path==='pending'?"json_set(config_json,'$.initial_account_binding.confirmed_at',null)":"json_remove(config_json,'$.initial_account_binding')"} WHERE id='lark.im'`);
    assert.throws(()=>guarded(db,a),/failed/);
    assert.equal(name(db),'Synthetic room');
  }
});

test('local-only enrichment cannot silently adopt a concurrent identity',t=>{
  const {db}=fixture(t), a=captureLarkWriteAdmission(db);
  bind(db,A,true); assert.throws(()=>guarded(db,a),/failed/);
});

for(const baseline of ['empty','received only']) for(const contender of [A,B]) {
  test(`ordinary replay ${baseline}, competing ${contender===A?'same':'other'} account`,t=>{
    const {db}=fixture(t);
    if(baseline==='received only') sqliteExec(db,`INSERT INTO records(source_id,first_seen_scope_id,external_id,record_type,direction,raw_json)
      VALUES('lark.im',${q(SCOPE)},'synthetic_legacy','lark.im.message','received','{}');`);
    const incoming=normalizeApiMessage({message_id:'om_admission',chat_id:CHAT,create_time:String(START+1000),update_time:String(START+1000),
      msg_type:'text',sender:{id:A,id_type:'open_id',sender_type:'user'},body:{content:'{"text":"Synthetic admission"}'}});
    const report=executeLarkImReplay(validateReplayOptions({db,scopeIds:[SCOPE],start:'2040-01-01T00:00:00Z',end:'2040-01-01T00:01:00Z',apply:true}),{
      now:()=>END+1000,getSelfProfile:()=>({open_id:A,name:'Synthetic A'}),fetchChatMessages:()=>{
        if(baseline==='empty') bind(db,contender,true); else sent(db,contender);
        return {messages:[incoming],pages:1};
      },
    });
    assert.equal(report.ok,contender===A);
    assert.equal(sqliteQuery(db,"SELECT * FROM records WHERE external_id='om_admission'").length,contender===A?1:0);
    assert.equal(count(db,'bounded_replay_runs'),contender===A?1:0);
    assert.equal(count(db,'maintenance_locks'),0);
  });
}

function seedName(db,id=1) {
  const raw={message_id:`om_name_${id}`,chat_id:CHAT,msg_type:'text',sender:{id:PEER,id_type:'open_id',sender_type:'user'},body:{content:'{"text":"Synthetic body"}'}};
  sqliteExec(db,`INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,record_type,occurred_at_ms,actor_id,container_id,direction,body,canonical_json,raw_json)
    VALUES(${id},'lark.im',${q(SCOPE)},${q(raw.message_id)},'1','lark.im.message',${START+id},${q(PEER)},${q(CHAT)},'received','Synthetic body',
    ${q(JSON.stringify({sender_id:PEER,sender_id_type:'open_id',sender_type:'user',chat_id:CHAT,chat_type:'p2p',msg_type:'text'}))},${q(JSON.stringify(raw))});`);
}

test('names-only admits a disabled provenance scope without adding self lookup or enabling it',t=>{
  const {db}=fixture(t);seedName(db);sqliteExec(db,`UPDATE sync_scopes SET enabled=0 WHERE id=${q(SCOPE)}`);
  const calls=[];
  const result=executeEnrichment({target:'records',db,apply:true,namesOnly:true,recordIds:[1]}, {runLark(args){calls.push(args);return {users:[{open_id:PEER,name:'Synthetic Person'}]};}});
  assert.equal(result.updated,1);assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,2),['contact','+search-user']);
  assert.equal(sqliteQuery(db,`SELECT enabled FROM sync_scopes WHERE id=${q(SCOPE)}`)[0].enabled,0);
});

test('names-only accounts cannot change between lookup and commit',t=>{
  const {db}=fixture(t);seedName(db);const before=sqliteQuery(db,'SELECT canonical_json FROM records')[0].canonical_json;
  assert.throws(()=>executeEnrichment({target:'records',db,apply:true,namesOnly:true,recordIds:[1]}, {runLark(){sent(db);return {users:[{open_id:PEER,name:'Synthetic Person'}]};}}));
  assert.equal(sqliteQuery(db,'SELECT canonical_json FROM records WHERE id=1')[0].canonical_json,before);
});

test('scope changes are a per-record CAS conflict, without broadening enabled policy',t=>{
  const {db}=fixture(t);seedName(db);
  const result=executeEnrichment({target:'records',db,apply:true,namesOnly:true,recordIds:[1]}, {runLark(){sqliteExec(db,`UPDATE sync_scopes SET enabled=0 WHERE id=${q(SCOPE)}`);return {users:[{open_id:PEER,name:'Synthetic Person'}]};}});
  assert.equal(result.updated,0);assert.equal(result.skipped_conflicts,1);
});

for(const mutation of ['foreign','malformed','replacement']) test(`external ${mutation} is detected before local commit`,t=>{
  const {db,dir}=fixture(t),a=captureLarkWriteAdmission(db,{selfOpenId:A});
  if(mutation==='replacement'){const replacement=join(dir,'replacement.sqlite');copyFileSync(db,replacement);renameSync(replacement,db);}
  else writeFileSync(`${db}.remote-account-binding.json`,mutation==='malformed'?'{}':JSON.stringify({kind:'lark_im_remote_account_binding/v1',database_key:activityDatabaseKey(db),account_key:key(B),evidence:'initialized_empty_database',bound_at:new Date().toISOString()}),{mode:0o600});
  assert.throws(()=>a.assertCurrent());assert.equal(name(db),'Synthetic room');
});

test('local commit lease holds across recheck/transaction and charges no remote attempt',()=>{
  let elapsed=0,held=false,released=0;
  const session=createMaintenanceRequestSession({maxSeconds:1},{monotonicClock:()=>elapsed,tryAcquireLease:options=>{
    assert.equal(options.monotonicDeadlineMs,elapsed+2000);held=true;return{state:'acquired',release(){held=false;released++;}};
  }});
  elapsed=2000; // Existing remote window is over; the local completion remains bounded.
  assert.equal(session.withCommit(()=>{assert.equal(held,true);return 'committed';}),'committed');
  assert.equal(released,1);assert.equal(held,false);assert.equal(session.summary().cli_attempts,0);
  assert.equal(session.summary().stop_reason,null);
});

test('a stopped request permits only the explicit failure-receipt local commit',()=>{
  let leases=0,spawns=0,held=false;
  const session=createMaintenanceRequestSession({maxCliAttempts:1,maxSeconds:30},{monotonicClock:()=>0,
    tryAcquireLease:()=>{leases++;held=true;return{state:'acquired',release(){held=false;}};},
    readSharedCooldown:()=>({state:'ready'}),writeSharedCooldown:()=>true,
    spawnSync:()=>{spawns++;return{status:0,stdout:'{}',stderr:''};},sleep:()=>{},
  });
  session.runLark(['contact','+get-user']);
  assert.throws(()=>session.runLark(['contact','+get-user']),/cli_budget/);
  const before=leases;
  assert.throws(()=>session.withCommit(()=>assert.fail('ordinary stopped commit')),/cli_budget/);
  assert.equal(leases,before);
  session.withCommit(()=>assert.equal(held,true),{allowStoppedForFailure:true});
  assert.equal(held,false);assert.equal(spawns,1);assert.equal(session.summary().cli_attempts,1);
  assert.equal(session.summary().stop_reason,'cli_budget');
  assert.throws(()=>session.runLark(['contact','+get-user']),/cli_budget/);
});
