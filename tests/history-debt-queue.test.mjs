import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, chmodSync, rmSync, readFileSync } from 'node:fs';
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
import { loadHistoryDebtHints, mergeHistoryDebtHints, readHistoryDebtSchedule, readHistoryFairRound } from '../src/maintenance/history-debt.mjs';

const SELF = { open_id: 'ou_synthetic_debt_observer', name: 'Synthetic observer' };
const hash = text => createHash('sha256').update(text).digest('hex');
const q = store.quoteSql;

/** Everything is authored here. Real selector, shared session and transaction;
 * only the OS API/lease boundary and deterministic wall/monotonic clocks differ. */
function fixture(t, sizes = [12]) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-history-debt-'))); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const f = { dir, db: join(dir, 'synthetic.sqlite'), logDir: dir, wall: Date.now(), tick: 0,
    messages: [], scopes: [], calls: [], attempts: [], listAttempts: [], held: false, mode: 'ok', latency: 10 };
  f.start = Math.floor((f.wall - 86400000) / 1000) * 1000;
  store.ensureInitialized(f.db);
  f.binding = { database_key: activityDatabaseKey(f.db), account_key: hash(`lark.im\0${SELF.open_id}`) };
  const confirmed = new Date(f.start).toISOString();
  store.sqliteExec(f.db, `UPDATE sources SET config_json=${q(JSON.stringify({initial_sync_start_ms:f.start,
    initial_account_binding:{kind:store.INITIAL_ACCOUNT_KIND,account_key:f.binding.account_key,reserved_at:confirmed,confirmed_at:confirmed}}))} WHERE id='lark.im';`);
  function addScope(index, count) {
    const chat = `oc_synthetic_debt_${index}`, scope = chatScopeId(chat); f.scopes.push(scope);
    store.sqliteExec(f.db, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(scope)},'lark.im',${q(`Synthetic scope ${index}`)},${q(JSON.stringify({chat_id:chat,chat_type:'group'}))});`);
    const messages = Array.from({length:count}, (_, n) => ({message_id:`om_synthetic_debt_${index}_${n}`,chat_id:chat,msg_type:'text',deleted:false,
      create_time:String(f.start + (n+1)*2000),update_time:String(f.start + (n+1)*2000),
      sender:{id:'ou_synthetic_debt_author',id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({text:`Synthetic ${index}/${n}`})}}));
    f.messages.push(...messages);
    if (messages.length) store.sqliteExec(f.db, store.upsertRecordsSql(prepareChatWindowRecords(messages.map(message => normalizeApiMessage(message)), scope,
      null, f.start, f.start + (count+2)*2000, SELF.open_id, {self:SELF}, {chat_id:chat,chat_type:'group'})));
    return messages;
  }
  sizes.forEach((count,index) => addScope(index,count)); f.addScope=addScope;
  f.state = (indices, changes={}) => {
    f.wall=Date.now();
    const observations = Object.fromEntries(indices.map(index => {
      const message = f.messages[index], target = Number(message.create_time);
      return [digest([f.binding.database_key,f.binding.account_key,message.chat_id,message.message_id,target]),
        {kind:'version',target,first_seen:f.wall,last_seen:f.wall,run_finished:f.wall,last_checked:f.wall,
          scope_hash:sampleScopeHash(f.binding,message.chat_id),debts:{version:Number(message.update_time)+1000}}];
    }));
    const state = {kind:'lark_im_remote_sample_schedule/v1',...f.binding,written_at:f.wall,next_due:f.wall+900000,
      failures:0,rotation:0,observations,last_outcome:'ok',cooldowns:{},blocked_reason:null,...changes};
    writeRemoteSampleState(remoteSamplePaths(dir,f.binding.database_key).state,state,f.wall); return state;
  };
  f.query = sql => store.sqliteQuery(f.db,sql);
  f.run = (options={}, deps={}) => {
    return executeLarkImHistory({db:f.db,logDir:dir,maxRecords:12,maxCliAttempts:12,maxSeconds:25,...options}, {
      now:()=>Date.now(),
      requestSessionDeps:{env:{LARK_CLI:'synthetic-never-spawned'},monotonicClock:()=>f.tick,now:()=>Date.now(),
        sleep:ms=>{assert.equal(f.held,false);f.tick+=ms;},
        tryAcquireLease:()=>{if(f.mode==='busy')return {state:'busy'};assert.equal(f.held,false);f.held=true;return {state:'acquired',release(){f.held=false;}};},
        readSharedCooldown:()=>({state:'ready'}),writeSharedCooldown:()=>true,
        spawnSync:(_command,args)=>{
          assert.equal(f.held,true); f.calls.push(args); f.tick+=f.latency;
          if(args[0]==='contact') {
            const injected=f.onSelf?.(args);
            return injected || {status:0,stdout:JSON.stringify(SELF),stderr:''};
          }
          const params=JSON.parse(args[args.indexOf('--params')+1]);
          if(args[2]==='/open-apis/im/v1/messages/mget') {
            const messages=params.message_ids.map(id=>f.messages.find(message=>message.message_id===id));
            const injected=f.onMget?.(messages,args);
            return injected || {status:0,stdout:JSON.stringify({code:0,data:{items:messages}}),stderr:''};
          }
          assert.equal(args[2],'/open-apis/im/v1/messages');
          const messages=f.messages.filter(m=>m.chat_id===params.container_id && Number(m.create_time)>=Number(params.start_time)*1000 && Number(m.create_time)<Number(params.end_time)*1000);
          f.listAttempts.push(messages[0]?.message_id);
          const injected=f.onList?.(messages,args);
          if(injected)return injected;
          return {status:0,stdout:JSON.stringify({code:0,data:{items:messages,has_more:false,page_token:''}}),stderr:''};
        }},...deps,commit:(db,options)=>{
          f.attempts.push(options.reviewFence.records[0].external_id);
          return (deps.commit || store.commitBoundedReplayRecords)(db,options);
        }});
  };
  return f;
}

test('one shared twelve-call budget performs twelve ordinary rows in two bracketed acquisitions and one gap ledger',t=>{
  const f=fixture(t),result=f.run();
  assert.equal(result.processed,12);assert.equal(result.fair_processed,12);assert.equal(result.request_budget.cli_attempts,6);
  assert.equal(result.request_budget.self_attempts,4);
  assert.equal(result.fair_round_reason,'ready');
  assert.equal(result.request_budget.stop_reason,null);assert.equal(result.request_budget.elapsed_ms,5060);
  assert.equal(new Set(f.attempts).size,12);assert.equal(f.query('SELECT generation FROM lark_im_history_scheduler')[0].generation,12);
  assert.equal(f.query('SELECT generation FROM lark_im_history_progress')[0].generation,12);assert.equal(f.held,false);
});

test('priority scheduling persists two-to-one weighting without moving fair checkpoints',t=>{
  const f=fixture(t);f.state([8,9,10,11]);
  const first=f.run({maxRecords:2,maxCliAttempts:4});
  assert.equal(first.priority_processed,2);assert.equal(f.query('SELECT * FROM lark_im_history_progress').length,0);
  assert.deepEqual(f.attempts,['om_synthetic_debt_0_8','om_synthetic_debt_0_9']);
  const second=f.run({maxRecords:3,maxCliAttempts:6});
  assert.equal(second.priority_processed,2);assert.equal(second.fair_processed,1);
  assert.deepEqual(f.attempts.slice(2),['om_synthetic_debt_0_0','om_synthetic_debt_0_10','om_synthetic_debt_0_11']);
  assert.equal(f.query('SELECT after_id FROM lark_im_history_progress')[0].after_id,1);
  assert.equal(f.query("SELECT COUNT(*) AS n FROM lark_im_history_debt WHERE status='awaiting_verification'")[0].n,4);
  assert.equal(Object.keys(JSON.parse(readFileSync(remoteSamplePaths(f.dir,f.binding.database_key).state)).observations).length,4,'writer never clears finding');
});

test('a new sample reactivates verification-waiting debt but its existing cooldown remains',t=>{
  const f=fixture(t);f.state([10]);f.run({maxRecords:1,maxCliAttempts:4});
  assert.equal(f.query('SELECT status FROM lark_im_history_debt')[0].status,'awaiting_verification');
  f.wall+=100;f.state([10]);
  const loaded=loadHistoryDebtHints(f.db,f.dir,f.binding,f.wall);
  assert.equal(readHistoryDebtSchedule(f.db,loaded,f.wall).selected.record_id,11);
});

test('permission failure backs off the bad target and permits other old debt plus fair work',t=>{
  const f=fixture(t);f.state([8,9,10]);
  f.onList=messages=>messages[0].message_id.endsWith('_8') ? {status:1,stdout:JSON.stringify({code:99991672,msg:'Synthetic permission unavailable'}),stderr:''}:null;
  f.onMget=messages=>messages.some(message=>message.message_id.endsWith('_8')) ? {status:1,stdout:JSON.stringify({code:99991672,msg:'Synthetic permission unavailable'}),stderr:''}:null;
  const result=f.run();assert.equal(result.failed,1);assert.equal(result.processed,5);
  assert.equal(f.attempts.filter(id=>id.endsWith('_8')).length,1);
  const debt=f.query('SELECT * FROM lark_im_history_debt WHERE record_id=9')[0];
  assert.equal(debt.failures,1);assert.equal(debt.status,'ready');assert.ok(debt.next_due_at_ms>f.wall);
  assert.ok(result.fair_processed>=2);assert.equal(f.query('SELECT COUNT(*) AS n FROM records')[0].n,12);
});

for(const failure of ['rate','deadline','lease'])test(`batch ${failure} preserves committed targets and does not invent a failed checkpoint`,t=>{
  const f=fixture(t);f.state([8,9]);let acquisitions=0;
  f.onMget=()=>{
    acquisitions++;
    if(acquisitions===1 && failure==='lease')f.mode='busy';
    if(acquisitions!==2)return null;
    if(failure==='rate')return {status:1,stdout:JSON.stringify({code:99991400,msg:'request rate limit',error:{rate_limit_reset:60}}),stderr:'HTTP 429'};
    if(failure==='deadline'){f.tick+=30000;}
    return null;
  };
  const result=f.run();
  assert.equal(result.processed,failure==='lease'?0:6);
  assert.equal(f.query('SELECT COUNT(*) AS n FROM lark_im_history_debt')[0].n,failure==='lease'?0:2);
  assert.equal(f.query('SELECT COUNT(*) AS n FROM record_observation_state WHERE history_error IS NOT NULL')[0].n,0);
  assert.ok(result.request_budget.stop_reason);assert.equal(f.held,false);
});

test('fair round covers a skewed queue once before recycling small scopes despite different prior sweep totals',t=>{
  const f=fixture(t,[1,8,1]);
  store.sqliteExec(f.db,`INSERT INTO lark_im_history_progress(scope_id,completed_sweeps) VALUES(${q(f.scopes[0])},400),(${q(f.scopes[1])},2),(${q(f.scopes[2])},90);`);
  f.run({maxRecords:6});f.run({maxRecords:4,maxCliAttempts:8});
  assert.equal(f.attempts.length,10);assert.equal(new Set(f.attempts).size,10,'no small scope recycles before the large scope finishes');
  const rounds=f.query('SELECT * FROM lark_im_history_round');assert.deepEqual(rounds.map(row=>row.baseline_sweeps).sort((a,b)=>a-b),[2,90,400]);
  f.run({maxRecords:1,maxCliAttempts:4});assert.equal(f.query('SELECT fair_round FROM lark_im_history_scheduler')[0].fair_round,1);
});

test('new eligible scope joins current fair round and disabled scope does not block remaining scopes',t=>{
  const f=fixture(t,[1,8]);f.run({maxRecords:2,maxCliAttempts:4});
  const added=f.addScope(2,1)[0];store.sqliteExec(f.db,`UPDATE sync_scopes SET enabled=0 WHERE id=${q(f.scopes[1])};`);
  f.run({maxRecords:1,maxCliAttempts:4});assert.equal(f.attempts.at(-1),added.message_id);
  assert.equal(f.query('SELECT fair_round FROM lark_im_history_scheduler')[0].fair_round,0);
  store.sqliteExec(f.db,`UPDATE sync_scopes SET enabled=1 WHERE id=${q(f.scopes[1])};`);
  f.run({maxRecords:1,maxCliAttempts:4});assert.match(f.attempts.at(-1),/^om_synthetic_debt_1_/);
});

test('priority commit replay is idempotent and a competing schedule generation rolls back all record and queue writes',t=>{
  const f=fixture(t);f.state([10]);let captured,effects;
  f.run({maxRecords:1,maxCliAttempts:4},{commit:(db,options)=>{captured=options;effects=store.commitBoundedReplayRecords(db,options);return effects;}});
  assert.deepEqual(store.commitBoundedReplayRecords(f.db,captured),effects);
  assert.equal(f.query('SELECT generation FROM lark_im_history_scheduler')[0].generation,1);
  f.wall+=100;f.state([11]);
  const before=f.query('SELECT * FROM records');
  assert.throws(()=>f.run({maxRecords:1,maxCliAttempts:4},{commit:(db,options)=>{
    store.sqliteExec(db,'UPDATE lark_im_history_scheduler SET generation=generation+1 WHERE id=1;');
    return store.commitBoundedReplayRecords(db,options);
  }}),/commit bounded replay/);
  assert.deepEqual(f.query('SELECT * FROM records'),before);
  assert.equal(f.query('SELECT record_id FROM lark_im_history_debt')[0].record_id,11);
});

for(const mode of ['invalid','account','overflow','salt'])test(`unusable ${mode} sample hints fall back to fair native history without changing findings`,t=>{
  const f=fixture(t);const state=f.state([10]);let reads=0;
  const loaded=loadHistoryDebtHints(f.db,f.dir,f.binding,f.wall,{readState:()=>{
    reads++;if(mode==='invalid')return {status:'invalid',state:null};
    if(mode==='account')return {status:'ready',state:{...state,account_key:'a'.repeat(64)}};
    if(mode==='salt')return {status:'ready',state:{...state,observations:{['f'.repeat(64)]:Object.values(state.observations)[0]}}};
    return {status:'ready',state};
  },...(mode==='overflow'?{sqliteJson:(_db,_sql,label)=>label==='read history debt policy'?[{enabled:1,config_json:JSON.stringify({initial_sync_start_ms:f.start})}]:Array(20001).fill({})}:{})});
  assert.equal(reads,1);assert.ok(loaded.hints===null||loaded.hints.length===0);
  assert.equal(f.query('SELECT COUNT(*) AS n FROM lark_im_history_debt')[0].n,0);
});

test('scope inventory overflow reports bounded legacy-fair fallback instead of pretending a truncated full round',()=>{
  const result=readHistoryFairRound('never-opened',{fair_round:7},{sqliteJson:()=>Array(10001).fill({scope_id:'synthetic'})});
  assert.equal(result.reason,'scope_budget');assert.equal(result.state,null);assert.equal(result.eligibleScopeIds,null);
});

test('continuous new debt cannot jump ahead of unattempted old debt or consume every fair slot',()=>{
  const h=id=>({record_id:id,finding_key:String(id),database_key:'db',account_key:'account',context_fingerprint:'policy',debt_fingerprint:'debt',enqueued_at_ms:id,sample_checked_at_ms:100});
  const rows=mergeHistoryDebtHints([h(1),h(2),h(3)],[{...h(1),generation:1,last_attempt_at_ms:99,next_due_at_ms:0,failures:0,status:'ready'}]);
  rows.sort((a,b)=>a.last_attempt_at_ms-b.last_attempt_at_ms||a.enqueued_at_ms-b.enqueued_at_ms);
  assert.deepEqual(rows.map(row=>row.record_id),[2,3,1]);
});

test('same record generation cannot create repeated fast verification tickets after sampler leaves debt unresolved',t=>{
  const f=fixture(t);f.state([10]);f.run({maxRecords:1,maxCliAttempts:4});
  const first=f.query('SELECT * FROM lark_im_history_debt')[0];assert.equal(first.verification_generation,0);assert.ok(first.verification_requested_at_ms>0);
  f.state([10]);f.run({maxRecords:1,maxCliAttempts:4});
  const second=f.query('SELECT * FROM lark_im_history_debt')[0];assert.equal(second.generation,2);
  assert.equal(second.verification_requested_at_ms,first.verification_requested_at_ms);assert.equal(second.verification_generation,first.verification_generation);
});

test('a same-version conflict creates no fast verification ticket before independent acceptance',t=>{
  const f=fixture(t);f.state([10]);f.messages[10].body.content='{"text":"Synthetic changed source"}';
  const first=f.run({maxRecords:1,maxCliAttempts:4});assert.equal(first.conflicts,1);
  const debt=f.query('SELECT * FROM lark_im_history_debt')[0];assert.equal(debt.status,'ready');assert.equal(debt.verification_requested_at_ms,0);
  assert.equal(debt.verification_generation,null);assert.equal(f.query('SELECT candidate_json FROM record_observation_state WHERE record_id=11')[0].candidate_json!==null,true);
});

test('queue changes outside scheduler CAS still roll back acquisition and preserve concurrent queue state',t=>{
  const f=fixture(t);f.state([10]);f.run({maxRecords:1,maxCliAttempts:4});f.state([10]);
  assert.throws(()=>f.run({maxRecords:1,maxCliAttempts:4},{commit:(db,options)=>{
    store.sqliteExec(db,'UPDATE lark_im_history_debt SET failures=2 WHERE record_id=11;');
    return store.commitBoundedReplayRecords(db,options);
  }}),/commit bounded replay/);
  assert.equal(f.query('SELECT generation,failures FROM lark_im_history_debt')[0].generation,1);
  assert.equal(f.query('SELECT failures FROM lark_im_history_debt')[0].failures,2);
});

test('default one-record execution also participates in scheduler and fair-round CAS',t=>{
  const f=fixture(t);const result=f.run({maxRecords:1,maxCliAttempts:4,logDir:null});assert.equal(result.outcome,'processed');
  assert.equal(f.query('SELECT generation FROM lark_im_history_scheduler')[0].generation,1);
  assert.equal(f.query('SELECT COUNT(*) AS n FROM lark_im_history_round')[0].n,1);
});

test('later admission failure returns exact earlier batch counters without inventing a target failure',t=>{
  const f=fixture(t);let commits=0;
  const result=f.run({}, {commit:(db,options)=>{
    if(commits++)throw new Error('Synthetic concurrent admission changed');
    return store.commitBoundedReplayRecords(db,options);
  }});
  assert.equal(result.outcome,'batch_interrupted');assert.equal(result.processed,1);assert.equal(result.failed,0);assert.equal(result.ok,false);
  assert.equal(f.query('SELECT generation FROM lark_im_history_scheduler')[0].generation,1);
});

test('hot discovery scheduling metadata cannot reset a completed small-scope fair baseline',t=>{
  const f=fixture(t,[1,8]);f.run({maxRecords:2,maxCliAttempts:4});
  const before=f.query(`SELECT * FROM lark_im_history_round WHERE scope_id=${q(f.scopes[0])}`);
  store.sqliteExec(f.db,`UPDATE sync_scopes SET config_json=json_patch(config_json,
    '{"hot_rank":2,"hot_seen_at":"2030-01-01T00:00:00Z","last_hot_snapshot_id":"synthetic-new-snapshot"}') WHERE id=${q(f.scopes[0])};`);
  assert.deepEqual(f.query(`SELECT * FROM lark_im_history_round WHERE scope_id=${q(f.scopes[0])}`),before);
  f.run({maxRecords:3,maxCliAttempts:6});
  assert.ok(f.attempts.slice(2).every(id=>id.startsWith('om_synthetic_debt_1_')),'completed small hot scope stays paused');
  store.sqliteExec(f.db,`UPDATE sync_scopes SET config_json=json_set(config_json,'$.synthetic_future_policy',1) WHERE id=${q(f.scopes[0])};`);
  assert.equal(f.query(`SELECT * FROM lark_im_history_round WHERE scope_id=${q(f.scopes[0])}`).length,0,'real policy change reenrolls safely');
});

test('a due independent second observation precedes newly enqueued debt and issues one accepted-generation verification ticket',t=>{
  const f=fixture(t);f.state([8]);f.messages[8].body.content='{"text":"Synthetic independently confirmed change"}';
  f.run({maxRecords:1,maxCliAttempts:4});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100);
  f.state([8,9,10]);
  const result=f.run({maxRecords:1,maxCliAttempts:4});
  assert.equal(f.attempts.at(-1),'om_synthetic_debt_0_8');assert.equal(result.updated,1);
  const accepted=f.query('SELECT * FROM lark_im_history_debt WHERE record_id=9')[0];
  assert.equal(accepted.status,'awaiting_verification');assert.equal(accepted.verification_generation,1);assert.ok(accepted.verification_requested_at_ms>0);
  assert.equal(f.query('SELECT candidate_json FROM record_observation_state WHERE record_id=9')[0].candidate_json,null);
});

test('all two hundred retained hints fit the metadata, queue CAS and transaction bounds',t=>{
  const f=fixture(t,[210]);f.state(Array.from({length:200},(_,i)=>i+10));
  const result=f.run({maxRecords:3,maxCliAttempts:6});
  assert.equal(result.processed,3);assert.equal(result.priority_processed,2);assert.equal(result.fair_processed,1);
  assert.equal(f.query('SELECT COUNT(*) AS n FROM lark_im_history_debt')[0].n,200);
  assert.equal(new Set(f.attempts).size,3);
});

test('round CAS supports more than SQLite expression-depth count of retired baselines',t=>{
  const f=fixture(t);const rows=Array.from({length:1100},(_,index)=>({scope:chatScopeId(`oc_synthetic_retired_${index}`),index}));
  store.sqliteExec(f.db,rows.map(({scope,index})=>`INSERT INTO sync_scopes(id,source_id,name,config_json,enabled)
    VALUES(${q(scope)},'lark.im',${q(`Synthetic retired ${index}`)},${q(JSON.stringify({chat_id:`oc_synthetic_retired_${index}`}))},0);
    INSERT INTO lark_im_history_round(scope_id,round,baseline_sweeps) VALUES(${q(scope)},0,${index});`).join('\n'));
  const result=f.run({maxRecords:1,maxCliAttempts:4});assert.equal(result.ok,true);
  assert.equal(f.query('SELECT COUNT(*) AS n FROM lark_im_history_round')[0].n,1);
});

test('continuous new scopes cannot jump ahead of a due old large-scope round',t=>{
  const f=fixture(t,[8]);f.run({maxRecords:1,maxCliAttempts:4});
  f.addScope(1,1);f.addScope(2,1);
  f.run({maxRecords:1,maxCliAttempts:4});
  assert.equal(f.attempts.at(-1),'om_synthetic_debt_0_1','old scope retains earlier scheduling age');
  f.run({maxRecords:2,maxCliAttempts:4});
  assert.ok(f.attempts.some(id=>id.startsWith('om_synthetic_debt_1_')));
  assert.ok(f.attempts.some(id=>id.startsWith('om_synthetic_debt_2_')));
});

test('retiring a queue hint retains the fair sweep audit that currently shares its receipt',t=>{
  const f=fixture(t);f.state([0]);
  f.run({maxRecords:1,maxCliAttempts:4}); // priority only
  f.run({maxRecords:1,maxCliAttempts:4}); // fair visits same record and shares receipt
  const fair=f.query('SELECT last_result_json FROM lark_im_history_progress')[0];
  const audit=JSON.parse(fair.last_result_json).effects.audit_id;
  f.state([]);
  // A priority on a different hinted record imports retirement without replacing
  // the still-current fair scope receipt.
  f.state([10]);f.run({maxRecords:1,maxCliAttempts:4});
  assert.equal(f.query(`SELECT COUNT(*) AS n FROM bounded_replay_runs WHERE id=${q(audit)}`)[0].n,1);
});
