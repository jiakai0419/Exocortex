import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import { prepareChatWindowRecords } from '../src/adapters/lark-im/sync-runner.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { activityDatabaseKey } from '../src/diagnostics/lark-im-activity-evidence.mjs';
import { digest, sampleScopeHash } from '../src/diagnostics/remote-sample-core.mjs';
import { writeRemoteSampleState, remoteSamplePaths } from '../src/runtime/worker/remote-sample-scheduler.mjs';
import { executeLarkImHistory } from '../src/maintenance/history.mjs';

const SELF={open_id:'ou_synthetic_ticket_self',name:'Synthetic ticket observer'};
const CHAT='oc_synthetic_ticket',SCOPE=chatScopeId(CHAT),q=store.quoteSql;
const sha=value=>createHash('sha256').update(value).digest('hex');

// Fresh authored data, real source-proof/queue/CAS/record transactions. Only
// remote boundaries are replaced; SQLite's actual transaction clock and the
// 30-minute review fence remain intact in every test.
function fixture(t) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'synthetic-verification-ticket-')));chmodSync(dir,0o700);
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const f={dir,db:join(dir,'synthetic.sqlite'),clock:Date.now()-5000};
  f.start=Math.floor((f.clock-86400000)/1000)*1000;
  store.ensureInitialized(f.db);
  f.binding={database_key:activityDatabaseKey(f.db),account_key:sha(`lark.im\0${SELF.open_id}`)};
  const confirmed=new Date(f.start).toISOString();
  store.sqliteExec(f.db,`UPDATE sources SET config_json=${q(JSON.stringify({initial_sync_start_ms:f.start,
    initial_account_binding:{kind:store.INITIAL_ACCOUNT_KIND,account_key:f.binding.account_key,reserved_at:confirmed,confirmed_at:confirmed}}))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(SCOPE)},'lark.im','Synthetic ticket scope',${q(JSON.stringify({chat_id:CHAT,chat_type:'group'}))});`);
  f.remote={message_id:'om_synthetic_ticket',chat_id:CHAT,msg_type:'text',deleted:false,
    create_time:String(f.start+2000),update_time:String(f.start+2000),
    sender:{id:'ou_synthetic_ticket_author',id_type:'open_id',sender_type:'user'},body:{content:'{"text":"Synthetic initial"}'}};
  store.sqliteExec(f.db,store.upsertRecordsSql(prepareChatWindowRecords([normalizeApiMessage(f.remote)],SCOPE,null,f.start,f.start+60000,
    SELF.open_id,{self:SELF},{chat_id:CHAT,chat_type:'group'})));
  f.firstSeen=f.clock;f.floor=f.start+50000;
  f.publish=(time=Date.now(),floor=f.floor)=>{
    const finding=digest([f.binding.database_key,f.binding.account_key,CHAT,f.remote.message_id,Number(f.remote.create_time)]);
    const state={kind:'lark_im_remote_sample_schedule/v1',...f.binding,written_at:time,next_due:time+900000,
      failures:0,rotation:0,observations:{[finding]:{kind:'version',target:Number(f.remote.create_time),
        first_seen:f.firstSeen,last_seen:time,run_finished:time,last_checked:time,scope_hash:sampleScopeHash(f.binding,CHAT),debts:{version:floor}}},
      last_outcome:'ok',cooldowns:{},blocked_reason:null};
    writeRemoteSampleState(remoteSamplePaths(dir,f.binding.database_key).state,state,time);return time;
  };
  f.publish(f.clock);
  f.query=sql=>store.sqliteQuery(f.db,sql);
  f.debt=()=>f.query('SELECT * FROM lark_im_history_debt')[0];
  f.record=()=>f.query('SELECT * FROM records')[0];
  f.generation=()=>f.query('SELECT generation FROM record_observation_state')[0].generation;
  f.run=(deps={})=>{
    let cliAttempts=0;
    return executeLarkImHistory({db:f.db,logDir:dir,maxRecords:1,maxCliAttempts:4,maxSeconds:30},{
      now:()=>Date.now(),
      createRequestSession:()=>({runLark(){throw Error('unexpected synthetic transport');},assertReady(){},
        summary:()=>({cli_attempts:cliAttempts,max_cli_attempts:4,max_seconds:30,elapsed_ms:1,stop_reason:null})}),
      getSelfProfile:()=>{cliAttempts++;return SELF;},
      fetchChatMessageList:()=>{cliAttempts++;f.onFetch?.();return {messages:[normalizeApiMessage(f.remote)],pages:1};},
      ...deps,
    });
  };
  return f;
}

test('first equivalent acquisition receives one ticket; unchanged-generation duplicates do not renew it',t=>{
  const f=fixture(t);f.run();const first=f.debt();
  assert.equal(first.verification_generation,0);assert.ok(first.verification_requested_at_ms>0);
  f.publish();f.run();const second=f.debt();
  assert.equal(second.verification_generation,0);assert.equal(second.verification_requested_at_ms,first.verification_requested_at_ms);
  assert.ok(second.generation>first.generation);
});

test('local metadata and equivalent derived projection churn cannot issue repeated fast tickets',t=>{
  const f=fixture(t);f.run();const first=f.debt(),raw=f.record().raw_json;
  for(let n=0;n<3;n++){
    store.sqliteExec(f.db,`UPDATE records SET received_at=${q(`2099-01-0${n+1}T00:00:00Z`)},body=${q(`Synthetic stale derived projection ${n}`)},
      canonical_json=json_set(canonical_json,'$.synthetic_metadata_revision',${n}) WHERE id=1;`);
    f.publish();const result=f.run();assert.equal(result.updated,1,'equivalent source repairs a derived projection');
    assert.equal(f.debt().verification_requested_at_ms,first.verification_requested_at_ms);
    assert.equal(f.debt().verification_generation,f.generation());assert.equal(f.record().raw_json,raw);
  }
});

test('a genuinely newer accepted source renews an existing ticket after actual record mutation',t=>{
  const f=fixture(t);f.run();const first=f.debt();
  f.remote={...f.remote,update_time:String(f.start+3000),body:{content:'{"text":"Synthetic new source fact"}'}};
  f.publish();const result=f.run();assert.equal(result.updated,1);
  assert.ok(f.debt().verification_requested_at_ms>first.verification_requested_at_ms);
  assert.equal(f.debt().verification_generation,f.generation());
});

test('same-version candidate gets no new ticket until the second independent source observation is accepted',t=>{
  const f=fixture(t);f.run();const first=f.debt();
  f.remote={...f.remote,body:{content:'{"text":"Synthetic same-version source change"}'}};
  f.publish();assert.equal(f.run().conflicts,1);
  assert.equal(f.debt().verification_requested_at_ms,first.verification_requested_at_ms);
  assert.equal(f.query('SELECT candidate_json FROM record_observation_state')[0].candidate_json!==null,true);
  assert.equal(f.run().updated,1);
  assert.ok(f.debt().verification_requested_at_ms>first.verification_requested_at_ms);
  assert.equal(f.query('SELECT candidate_json FROM record_observation_state')[0].candidate_json,null);
});

test('older source acquisition only aligns the local generation and cannot renew a ticket',t=>{
  const f=fixture(t);f.run();const first=f.debt();
  store.sqliteExec(f.db,"UPDATE records SET received_at='2099-02-01T00:00:00Z' WHERE id=1;");
  f.remote={...f.remote,update_time:String(f.start+1999)};f.publish();f.run();
  assert.equal(f.debt().verification_generation,f.generation());
  assert.equal(f.debt().verification_requested_at_ms,first.verification_requested_at_ms);
});

test('a sample completed after writer start but before its commit cannot consume the later acceptance ticket',t=>{
  const f=fixture(t);f.run();const first=f.debt();
  f.remote={...f.remote,update_time:String(f.start+4000),body:{content:'{"text":"Synthetic accepted after sampling"}'}};
  let sampledAt,acquisition;
  f.onFetch=()=>{sampledAt=f.publish();};
  f.run({commit:(db,options)=>{acquisition=options.history;return store.commitBoundedReplayRecords(db,options);}});
  assert.ok(acquisition.startedAtMs<sampledAt);
  assert.ok(acquisition.commitReadyAtMs>=sampledAt);
  assert.ok(f.debt().verification_requested_at_ms>sampledAt);
  assert.ok(f.debt().verification_requested_at_ms>first.verification_requested_at_ms);
});

test('ticket time is clamped strictly after actual SQL commit time when injected acquisition clock lags',t=>{
  const f=fixture(t);let beforeCommit;
  f.run({now:()=>f.clock,commit:(db,options)=>{beforeCommit=Date.now();return store.commitBoundedReplayRecords(db,options);}});
  assert.ok(f.debt().verification_requested_at_ms>beforeCommit);
  assert.ok(f.debt().verification_requested_at_ms>f.clock);
});

test('injected post-acquisition commit-entry time is an exclusive ticket lower bound',t=>{
  const f=fixture(t);let fetched=false;
  const readyAt=Date.now()+100000;f.onFetch=()=>{fetched=true;};
  f.run({now:()=>fetched?readyAt:f.clock});
  assert.equal(f.debt().verification_requested_at_ms,readyAt+1);
});

test('a new debt fingerprint renews once; repeated samples of that same debt do not self-trigger',t=>{
  const f=fixture(t);f.run();const first=f.debt();
  f.publish(Date.now(),f.floor+1000);f.run();const second=f.debt();
  assert.equal(second.verification_generation,first.verification_generation);
  assert.ok(second.verification_requested_at_ms>first.verification_requested_at_ms);
  f.publish(Date.now(),f.floor+1000);f.run();
  assert.equal(f.debt().verification_requested_at_ms,second.verification_requested_at_ms);
});

test('lost-acknowledgement attempt replay cannot reissue a ticket or advance the queue generation',t=>{
  const f=fixture(t);let captured,effects;
  f.run({commit:(db,options)=>{captured=options;effects=store.commitBoundedReplayRecords(db,options);return effects;}});
  const before=f.debt();assert.deepEqual(store.commitBoundedReplayRecords(f.db,captured),effects);
  assert.deepEqual(f.debt(),before);
});

test('legacy direct history callers without commitReadyAtMs still receive a SQL-time ticket',t=>{
  const f=fixture(t);let beforeCommit;
  f.run({now:()=>f.clock,commit:(db,options)=>{
    const {commitReadyAtMs,...history}=options.history;assert.equal(commitReadyAtMs,f.clock);
    beforeCommit=Date.now();return store.commitBoundedReplayRecords(db,{...options,history});
  }});
  assert.ok(f.debt().verification_requested_at_ms>beforeCommit);
});

test('a commit-entry clock preceding acquisition is rejected before any queue or record mutation',t=>{
  const f=fixture(t),before=f.record();
  assert.throws(()=>f.run({commit:(db,options)=>store.commitBoundedReplayRecords(db,{...options,
    history:{...options.history,commitReadyAtMs:options.history.startedAtMs-1}})}),/invalid history commit clock/);
  assert.equal(f.debt(),undefined);assert.deepEqual(f.record(),before);
});
