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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'synthetic-history-bulk-'))); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const f = { dir, db: join(dir, 'synthetic.sqlite'), logDir: dir, wall: Date.now(), tick: 0,
    messages: [], scopes: [], calls: [], attempts: [], held: false, mode: 'ok', latency: 10 };
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
          if(args[0]==='contact')return {status:0,stdout:JSON.stringify(f.onSelf?.() || SELF),stderr:''};
          if(args[2]==='/open-apis/im/v1/messages/mget') {
            const params=JSON.parse(args[args.indexOf('--params')+1]);
            const items=params.message_ids.map(id=>f.messages.find(m=>m.message_id===id));
            const injected=f.onMget?.(items,params);
            return injected || {status:0,stdout:JSON.stringify({code:0,data:{items}}),stderr:''};
          }
          if(args[2]!=='/open-apis/im/v1/messages') {
            const injected=f.onDetail?.(args);
            if(injected)return injected;
            throw Error('unexpected synthetic detail');
          }
          const params=JSON.parse(args[args.indexOf('--params')+1]);
          const messages=f.messages.filter(m=>m.chat_id===params.container_id && Number(m.create_time)>=Number(params.start_time)*1000 && Number(m.create_time)<Number(params.end_time)*1000);
          f.attempts.push(messages[0]?.message_id);
          const injected=f.onList?.(messages,args);
          if(injected)return injected;
          return {status:0,stdout:JSON.stringify({code:0,data:{items:messages,has_more:false,page_token:''}}),stderr:''};
        }},...deps});
  };
  return f;
}


const envelope=items=>({status:0,stdout:JSON.stringify({code:0,data:{items}}),stderr:''});

test('two bounded native mget groups process twelve ordinary rows with four self attempts and six CLI calls',t=>{
  const f=fixture(t),r=f.run();
  assert.equal(r.processed,12);assert.equal(r.fair_processed,12);assert.equal(r.request_budget.cli_attempts,6);
  assert.equal(r.request_budget.self_attempts,4);assert.equal(r.request_budget.max_self_attempts,6);
  assert.equal(f.query('SELECT completed_sweeps FROM lark_im_history_progress')[0].completed_sweeps,1);
  assert.deepEqual(f.calls.map(a=>a[0]==='contact'?'self':'mget'),['self','mget','self','self','mget','self']);
});

test('cross-chat pool uses actual fair selection and preserves every independent scope checkpoint',t=>{
  const f=fixture(t,[2,2,2,2,2,2]),r=f.run();
  assert.equal(r.processed,12);assert.equal(r.request_budget.cli_attempts,6);
  assert.deepEqual(f.query('SELECT completed_sweeps FROM lark_im_history_progress').map(x=>x.completed_sweeps),Array(6).fill(1));
});

test('pool is only a hint: exact two-priority one-fair commit order and separate progress survive',t=>{
  const f=fixture(t);f.state([8,9,10,11]);const lanes=[],ids=[];
  const r=f.run({maxRecords:6},{commit:(db,o)=>{lanes.push(o.history.scheduling.lane);ids.push(o.history.selectedId);return store.commitBoundedReplayRecords(db,o);}});
  assert.equal(r.processed,6);assert.deepEqual(lanes,['priority','priority','fair','priority','priority','fair']);
  assert.deepEqual(ids,[9,10,1,11,12,2]);assert.equal(f.query('SELECT after_id FROM lark_im_history_progress')[0].after_id,2);
});

test('one three-call, two-self allowance performs one group without resetting the ledger',t=>{
  const f=fixture(t),r=f.run({maxCliAttempts:3,maxSelfAttempts:2});
  assert.equal(r.processed,6);assert.equal(r.request_budget.cli_attempts,3);assert.equal(r.request_budget.self_attempts,2);
});

test('one remaining self allowance uses the original ordinary single acquisition',t=>{
  const f=fixture(t),r=f.run({maxSelfAttempts:1});
  assert.equal(r.processed,1);assert.equal(r.request_budget.cli_attempts,2);assert.equal(r.request_budget.self_attempts,1);
  assert.equal(r.request_budget.stop_reason,'self_budget');
});

for(const kind of ['missing','extra','duplicate','partial'])test(`mget ${kind} cannot write rows or move progress`,t=>{
  const f=fixture(t);f.onMget=items=>kind==='missing'?envelope(items.slice(1)):kind==='extra'?envelope([...items,{...items[0],message_id:'om_extra'}]):
    kind==='duplicate'?envelope([items[0],...items.slice(0,-1)]):{status:0,stdout:JSON.stringify({code:0,data:{items,has_more:true,page_token:'next'}}),stderr:''};
  const r=f.run({maxCliAttempts:3,maxSelfAttempts:2});assert.equal(r.outcome,'legacy_required');assert.equal(r.processed,0);assert.equal(r.request_budget.cli_attempts,2);
  assert.equal(r.request_budget.self_attempts,1);assert.equal(f.query('SELECT * FROM lark_im_history_progress').length,0);
});

test('changed identity at the closing self prevents every row in the group',t=>{
  const f=fixture(t);let n=0;f.onSelf=()=>++n===1?SELF:{...SELF,open_id:'ou_other'};
  const r=f.run();assert.equal(r.ok,false);assert.equal(r.processed,0);assert.equal(r.request_budget.self_attempts,2);
  assert.equal(f.query('SELECT * FROM lark_im_history_progress').length,0);
});

test('metadata generation changed during the request cannot be refreshed from the prefetched response',t=>{
  const f=fixture(t);f.onMget=()=>{store.sqliteExec(f.db,"UPDATE records SET received_at='2099-01-01' WHERE id=1;");};
  const r=f.run();assert.equal(r.processed,0);assert.equal(r.failed,0);
  assert.equal(f.query('SELECT * FROM lark_im_history_progress').length,0);
});

test('committed prefix remains exact when a later per-record CAS fails',t=>{
  const f=fixture(t);let n=0;
  const r=f.run({}, {commit:(db,o)=>{if(++n===2)store.sqliteExec(db,'UPDATE lark_im_history_scheduler SET generation=generation+1;');return store.commitBoundedReplayRecords(db,o);}});
  assert.equal(r.ok,false);assert.equal(r.processed,1);assert.equal(r.failed,0);assert.equal(r.duplicate,1);
  assert.equal(f.query('SELECT after_id FROM lark_im_history_progress')[0].after_id,1);
});

test('a deadline reached during one local commit cannot start another row from the same response',t=>{
  const f=fixture(t);let commits=0;
  const r=f.run({}, {commit:(db,o)=>{
    commits++;
    const effects=store.commitBoundedReplayRecords(db,o);
    f.tick+=30000;
    return effects;
  }});
  assert.equal(commits,1);assert.equal(r.processed,1);assert.equal(r.failed,0);
  assert.equal(r.request_budget.stop_reason,'time_budget');
  assert.equal(f.query('SELECT after_id FROM lark_im_history_progress')[0].after_id,1);
  assert.equal(f.query('SELECT generation FROM lark_im_history_scheduler')[0].generation,1);
});

test('a shared response cannot confirm its own same-version candidate on the next sweep',t=>{
  const f=fixture(t,[2]);f.messages[0].body={content:'{"text":"Synthetic changed source"}'};
  const first=f.run({maxSelfAttempts:2});assert.equal(first.processed,2);assert.equal(first.conflicts,1);assert.equal(first.updated,0);
  assert.notEqual(f.query('SELECT candidate_json FROM record_observation_state WHERE record_id=1')[0].candidate_json,null);
  const second=f.run({maxSelfAttempts:2});assert.equal(second.updated,1);
});

test('single-record public execution retains its original self then list acquisition',t=>{
  const f=fixture(t),r=f.run({maxRecords:1,maxCliAttempts:4});assert.equal(r.duplicate,1);assert.equal(r.request_budget.cli_attempts,2);
  assert.equal(f.calls[0][0],'contact');assert.equal(f.calls[1][2],'/open-apis/im/v1/messages');
});

function unexpectedMerge(f) {
  f.messages[0]={...f.messages[0],msg_type:'merge_forward',update_time:String(Number(f.messages[0].update_time)+1000),body:{content:'{}'}};
  const root=f.messages[0];
  f.onDetail=args=>{
    const params=JSON.parse(args[args.indexOf('--params')+1]);
    const child={...root,message_id:'om_synthetic_child',msg_type:'text',body:{content:'{"text":"Synthetic merge child"}'}};
    return {status:0,stdout:JSON.stringify({code:0,data:{items:params.page_token?[child]:[root],has_more:!params.page_token,page_token:params.page_token?'':'next'}}),stderr:''};
  };
}

test('unexpected merge does not consume a closing bulk self and switches to a fresh four-call legacy acquisition',t=>{
  const f=fixture(t);unexpectedMerge(f);
  const r=f.run({maxRecords:6,maxCliAttempts:6,maxSelfAttempts:3});
  assert.equal(r.processed,1);assert.equal(r.updated,1);assert.equal(r.request_budget.cli_attempts,6);assert.equal(r.request_budget.self_attempts,2);
  assert.deepEqual(f.calls.map(a=>a[0]==='contact'?'self':a[2].endsWith('/mget')?'mget':a[2]==='/open-apis/im/v1/messages'?'list':'detail'),
    ['self','mget','self','list','detail','detail']);
  assert.equal(f.query('SELECT after_id FROM lark_im_history_progress')[0].after_id,1);
});

test('three-call allowance leaves unexpected merge untouched; a later full allowance makes progress',t=>{
  const f=fixture(t);unexpectedMerge(f);
  const before=f.query('SELECT raw_json FROM records WHERE id=1')[0].raw_json;
  const first=f.run({maxRecords:6,maxCliAttempts:3,maxSelfAttempts:2});
  assert.equal(first.outcome,'legacy_required');assert.equal(first.processed,0);assert.equal(first.request_budget.cli_attempts,2);
  assert.equal(f.query('SELECT raw_json FROM records WHERE id=1')[0].raw_json,before);
  assert.equal(f.query('SELECT * FROM lark_im_history_progress').length,0);
  const second=f.run({maxRecords:6,maxCliAttempts:6,maxSelfAttempts:3});assert.equal(second.updated,1);assert.equal(second.processed,1);
});

test('known merge keeps original two-detail-page route without an mget',t=>{
  const f=fixture(t);unexpectedMerge(f);
  const config={chat_id:f.messages[0].chat_id,chat_type:'group'};
  store.sqliteExec(f.db,store.upsertRecordsSql(prepareChatWindowRecords([normalizeApiMessage(f.messages[0])],f.scopes[0],null,f.start,f.start+10000,SELF.open_id,{self:SELF},config)));
  const r=f.run({maxRecords:6,maxCliAttempts:4,maxSelfAttempts:2});
  assert.equal(r.processed,1);assert.equal(r.request_budget.cli_attempts,4);assert.equal(r.request_budget.self_attempts,1);
  assert.equal(f.calls.some(a=>a[2]?.endsWith('/mget')),false);
});

test('failed self is charged, and a self allowance of zero launches no request',t=>{
  const f=fixture(t);f.onSelf=()=>({open_id:'ou_other'});
  const failed=f.run();assert.equal(failed.processed,0);assert.equal(failed.request_budget.self_attempts,1);assert.equal(failed.request_budget.cli_attempts,1);
  const skipped=f.run({maxSelfAttempts:0});assert.equal(skipped.processed,0);assert.equal(skipped.request_budget.self_attempts,0);
  assert.equal(skipped.request_budget.cli_attempts,0);assert.equal(skipped.request_budget.stop_reason,'self_budget');
});

test('no eligible records produces an explicit zero-attempt receipt',t=>{
  const f=fixture(t,[0]),r=f.run();assert.equal(r.outcome,'no_eligible_known_record');
  assert.equal(r.request_budget.cli_attempts,0);assert.equal(r.request_budget.self_attempts,0);assert.equal(r.processed,0);
});


test('wrong chat in any mget item rejects the complete reply before the first commit',t=>{
  const f=fixture(t);f.onMget=items=>envelope(items.map((item,n)=>n===5?{...item,chat_id:'oc_wrong'}:item));
  const r=f.run({maxCliAttempts:3,maxSelfAttempts:2});assert.equal(r.outcome,'legacy_required');assert.equal(r.processed,0);
  assert.equal(f.query('SELECT * FROM lark_im_history_progress').length,0);
});

test('bulk 429 latches the shared ledger and leaves all selected rows untouched',t=>{
  const f=fixture(t);f.onMget=()=>({status:1,stdout:JSON.stringify({code:99991400,msg:'synthetic rate limit'}),stderr:''});
  const r=f.run();assert.equal(r.request_budget.stop_reason,'rate_limited');assert.equal(r.request_budget.cli_attempts,2);
  assert.equal(r.request_budget.self_attempts,1);assert.equal(r.processed,0);assert.equal(f.query('SELECT * FROM lark_im_history_progress').length,0);
});

test('deadline during bulk acquisition leaves no fake failure checkpoint',t=>{
  const f=fixture(t);f.latency=1000;
  const r=f.run({maxSeconds:3});assert.equal(r.request_budget.stop_reason,'time_budget');assert.equal(r.processed,0);assert.equal(r.failed,0);
  assert.equal(f.query('SELECT * FROM lark_im_history_progress').length,0);
});

test('lease loss after the complete identity bracket preserves the uncommitted group',t=>{
  const f=fixture(t);let n=0;f.onSelf=()=>{if(++n===2)f.mode='busy';return SELF;};
  const r=f.run();assert.equal(r.request_budget.stop_reason,'sync_busy');assert.equal(r.processed,0);assert.equal(r.failed,0);
  assert.equal(r.request_budget.cli_attempts,3);assert.equal(f.query('SELECT * FROM lark_im_history_progress').length,0);
});

test('bulk audit stores one selected item and labels its shared native response without claiming list coverage',t=>{
  const f=fixture(t);f.run({maxRecords:6,maxSelfAttempts:2});
  const audits=f.query('SELECT fetched_count,candidate_count,page_count FROM bounded_replay_runs');
  assert.ok(audits.length>0);assert.ok(audits.every(row=>row.fetched_count===1 && row.candidate_count===1 && row.page_count===1));
  const saved=JSON.parse(f.query('SELECT last_result_json FROM lark_im_history_progress')[0].last_result_json);
  assert.equal(saved.request_budget.acquisition_mode,'targeted_native_ids');assert.equal(saved.request_budget.batch_targets,6);
});


test('repeated bad bulk ID falls back to fresh single acquisitions so healthy neighbors advance',t=>{
  const f=fixture(t),bad=f.messages[1].message_id,seen=[];
  const before=f.query('SELECT raw_json FROM records WHERE id=2')[0].raw_json;
  f.onMget=items=>envelope(items.filter(item=>item.message_id!==bad));
  f.onList=items=>items.some(item=>item.message_id===bad)?{status:0,stdout:JSON.stringify({code:0,data:{items:[],has_more:false,page_token:''}}),stderr:''}:undefined;
  const commit=(db,o)=>{seen.push(o.history.selectedId);return store.commitBoundedReplayRecords(db,o);};
  for(let n=0;n<3;n++){const r=f.run({}, {commit});assert.ok(r.processed>0);assert.ok(r.request_budget.cli_attempts<=12);assert.ok(r.request_budget.self_attempts<=6);}
  assert.ok(seen.includes(12),'the invalid second ID cannot pin the first fair horizon');
  assert.equal(f.query('SELECT raw_json FROM records WHERE id=2')[0].raw_json,before);
  assert.equal(f.query('SELECT candidate_json FROM record_observation_state WHERE record_id=2')[0].candidate_json,null);
});

for(const kind of ['chat','create'])test(`repeated wrong ${kind} identity is discarded before a fresh legacy failure lets healthy neighbors advance`,t=>{
  const f=fixture(t),bad=f.messages[1].message_id,seen=[];
  const before=f.query('SELECT raw_json FROM records WHERE id=2')[0].raw_json;
  const wrong=item=>item.message_id!==bad?item:kind==='chat'?{...item,chat_id:'oc_wrong'}:{...item,create_time:String(Number(item.create_time)+1000)};
  f.onMget=items=>envelope(items.map(wrong));
  f.onList=items=>({status:0,stdout:JSON.stringify({code:0,data:{items:items.map(wrong),has_more:false,page_token:''}}),stderr:''});
  const commit=(db,o)=>{
    seen.push(o.history.selectedId);
    if(o.history.selectedId===2){assert.equal(o.history.error,'identity');assert.equal(o.records.length,0);}
    return store.commitBoundedReplayRecords(db,o);
  };
  for(let n=0;n<3;n++){const r=f.run({}, {commit});assert.ok(r.processed>0);assert.ok(r.request_budget.cli_attempts<=12);assert.ok(r.request_budget.self_attempts<=6);}
  assert.ok(seen.includes(12));
  assert.equal(f.query('SELECT raw_json FROM records WHERE id=2')[0].raw_json,before);
  assert.equal(f.query('SELECT candidate_json FROM record_observation_state WHERE record_id=2')[0].candidate_json,null);
});
