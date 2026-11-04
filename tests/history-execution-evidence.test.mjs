import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCli} from '../bin/exocortex.mjs';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import {prepareChatWindowRecords} from '../src/adapters/lark-im/sync-runner.mjs';
import {normalizeApiMessage} from '../src/adapters/lark-im/raw-message.mjs';
import {chatScopeId} from '../src/adapters/lark-im/core.mjs';
import {createMaintenanceRequestSession} from '../src/maintenance/request-session.mjs';
import {tryAcquireLarkApiLease,readLarkApiLeaseFailure} from '../src/runtime/lark-api-lease.mjs';
import {compactHistorySummary} from '../dist/runtime/worker/lark-im-worker-core.js';
import {sanitizeHistoryCommitEvidence} from '../dist/core/history-diagnostics.js';
import {createReplayExecutionEvidence,readReplayExecutionEvidence} from '../dist/storage/sqlite/execution-evidence.js';

const SELF={open_id:'ou_invented_execution_observer',name:'Invented observer'};
const hash=value=>createHash('sha256').update(value).digest('hex'),q=store.quoteSql;
function fixture(t,mode) {
  const dir=mkdtempSync(join(tmpdir(),'authored-history-execution-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const f={dir,db:join(dir,'authored.sqlite'),directory:join(dir,'lease'),tick:0,leases:0,helpers:0,api:0,blocker:null};
  t.after(()=>f.blocker?.release());
  store.ensureInitialized(f.db);
  const start=Math.floor((Date.now()-86400000)/1000)*1000,scope=chatScopeId('oc_invented_execution');
  const config={chat_id:'oc_invented_execution',chat_type:'group'};
  store.sqliteExec(f.db,`UPDATE sources SET config_json=${q(JSON.stringify({initial_sync_start_ms:start,
    initial_account_binding:{kind:store.INITIAL_ACCOUNT_KIND,account_key:hash(`lark.im\0${SELF.open_id}`),reserved_at:new Date(start).toISOString(),confirmed_at:new Date(start).toISOString()}}))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(scope)},'lark.im','Invented execution',${q(JSON.stringify(config))});`);
  f.messages=Array.from({length:2},(_,i)=>({message_id:`om_invented_execution_${i}`,chat_id:config.chat_id,msg_type:'text',deleted:false,
    create_time:String(start+(i+1)*2000),update_time:String(start+(i+1)*2000),
    sender:{id:'ou_invented_author',id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({text:`Invented body ${i}`})}}));
  store.sqliteExec(f.db,store.upsertRecordsSql(prepareChatWindowRecords(f.messages.map(normalizeApiMessage),scope,null,start,start+10000,SELF.open_id,{self:SELF},config)));
  f.query=sql=>store.sqliteQuery(f.db,sql,'inspect invented execution');
  if(mode==='cas')store.sqliteExec(f.db,"CREATE TRIGGER invented_cas BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT,'invented CAS conflict'); END;");
  if(mode==='cleanup')store.sqliteExec(f.db,"CREATE TRIGGER invented_cleanup BEFORE DELETE ON maintenance_locks BEGIN SELECT RAISE(ABORT,'invented cleanup failure'); END;");
  const deps={monotonicClock:()=>f.tick,sleep:ms=>{f.tick+=ms},readSharedCooldown:()=>({state:'ready'}),writeSharedCooldown:()=>true,
    tryAcquireLease(options) {
      const commit=++f.leases===4;
      if(commit&&mode==='forged')return {state:'unavailable',reason:'lease_deadline',lease:{reason:'lark_api_busy'}};
      if(commit&&mode==='busy') {
        f.blocker=tryAcquireLarkApiLease({role:'sync'},{directory:f.directory,monotonicClock:()=>f.tick});
        assert.equal(f.blocker.state,'acquired');
      }
      if(commit&&mode==='deadline')f.tick+=2001;
      return tryAcquireLarkApiLease(options,{directory:f.directory,monotonicClock:()=>f.tick,
        spawnSync(command,args,settings) {
          f.helpers++;
          if(commit&&['enoent','timeout','dual'].includes(mode)) {
            if(mode==='dual')f.tick=24001;
            return {status:null,signal:null,error:Object.assign(new Error('INVENTED_PRIVATE_ERROR'),{code:mode==='timeout'?'ETIMEDOUT':'ENOENT'})};
          }
          const result=childProcess.spawnSync(command,args,settings);
          assert.equal(result.error,undefined);
          if(mode==='busy'&&commit)assert.ok([0,75].includes(result.status));else assert.equal(result.status,0);
          if(commit&&mode==='evidence')unlinkSync(join(f.directory,'sync-intent.lock'));
          return result;
        }});
    },
    spawnSync(_command,args) {
      f.api++;
      const value=args[0]==='contact'?SELF:{code:0,data:{items:f.messages}};
      return {status:0,stdout:JSON.stringify(value),stderr:''};
    }};
  f.run=async()=> {
    let stdout='',stderr='';const original=childProcess.spawnSync;
    if(mode==='unknown') {
      childProcess.spawnSync=(command,args,settings)=>{
        const result=original(command,args,settings);
        if(command==='sqlite3'&&settings.input?.includes('INSERT INTO bounded_replay_runs'))return {...result,status:null,signal:'SIGKILL'};
        return result;
      };syncBuiltinESMExports();
    }
    try {
      const code=await runCli(['maintenance','history','--db',f.db,'--format','json','--max-records','2','--max-cli-attempts','6','--max-self-attempts','4','--max-seconds','25'],{
        cwd:dir,root:dir,monotonicNow:()=>f.tick,startedMonotonicMs:0,env:{LARK_CLI:'invented-never-executed'},
        stdout:{write:v=>{stdout+=v}},stderr:{write:v=>{stderr+=v}},deps:{requestSessionDeps:deps,
          ...(mode==='pre_sql'?{commit(db,options){return store.commitBoundedReplayRecords(db,{...options,reviewBeforeCommit(){throw Error('INVENTED_PRIVATE_BEFORE_SQL')}})}}:{}),
          ...(mode==='pre_budget'?{createRequestSession(options,sessionDeps){const s=createMaintenanceRequestSession(options,sessionDeps);return {...s,withCommit(...args){f.tick=24001;return s.withCommit(...args)}}}}:{})}});
      assert.equal(stderr,'');const report=JSON.parse(stdout);assert.doesNotMatch(stdout,/INVENTED_PRIVATE|ou_invented|oc_invented|om_invented/);
      return {code,report,compact:compactHistorySummary(report)};
    }finally{childProcess.spawnSync=original;syncBuiltinESMExports();}
  };
  return f;
}

const cases=[['busy','lark_api_busy'],['deadline','lease_deadline'],['enoent','lease_helper_unavailable'],
  ['timeout','lease_helper_unavailable'],['evidence','lease_evidence_unavailable'],['forged',null],
  ['pre_budget',null],['pre_sql',null],['cas',null],['unknown',null],['success',null],['cleanup',null],['dual','lease_helper_unavailable']];
for(const [mode,reason] of cases)test(`13-boundary actual CLI/SQLite matrix: ${mode}`,async t=>{
  const f=fixture(t,mode),result=await f.run(),r=result.report,c=result.compact;
  assert.ok(r.request_budget.cli_attempts<=6);assert.ok(r.request_budget.self_attempts<=4);assert.equal(r.command_budget.max_ms,25000);
  if(reason) {
    assert.equal(r.failure_diagnostic.lease.reason,reason);assert.equal(r.failure_diagnostic.lease.phase,'commit');
    if(mode==='busy')assert.equal(r.failure_diagnostic.lease.stage,'api');
    assert.deepEqual(c.failure_diagnostic,r.failure_diagnostic);
    assert.ok(r.failure_diagnostic.lease.grant_ms>=0&&r.failure_diagnostic.lease.grant_ms<=2000);
  }
  if(['busy','deadline','enoent','timeout','evidence','forged','pre_budget','dual'].includes(mode)) {
    assert.equal(r.commit_evidence.action_entered,false);assert.equal(r.commit_evidence.sql_execution,'not_started');
    assert.equal(r.commit_evidence.commit_state,'not_started');assert.equal(f.query('SELECT COUNT(*) n FROM bounded_replay_runs')[0].n,0);
    assert.equal(f.api,3);assert.equal(r.processed,0);
  }
  if(mode==='forged')assert.equal(r.failure_diagnostic.lease,undefined);
  if(mode==='pre_budget') {assert.equal(f.leases,3);assert.equal(r.command_budget.stop_reason,'time_budget');}
  if(mode==='pre_sql') {assert.equal(r.commit_evidence.action_entered,true);assert.equal(r.commit_evidence.sql_execution,'not_started');assert.equal(r.commit_evidence.receipt_validated,false);}
  if(['cas','unknown'].includes(mode)) {
    assert.equal(r.commit_evidence.action_entered,true);assert.equal(r.commit_evidence.sql_execution,'started');
    assert.equal(r.commit_evidence.receipt_validated,false);assert.equal(r.failed_target_commit_state,'unknown');
    assert.equal(f.query('SELECT COUNT(*) n FROM bounded_replay_runs')[0].n,mode==='unknown'?1:0);
  }
  if(['success','cleanup'].includes(mode)) {
    assert.equal(r.returned_commit_evidence.length,mode==='success'?2:1);
    for(const e of r.returned_commit_evidence) {assert.equal(e.commit_state,'committed');assert.equal(e.sql_execution,'started');assert.equal(e.receipt_validated,true);assert.ok(e.audit_ref);}
    assert.deepEqual(c.returned_commit_evidence,r.returned_commit_evidence);
    if(mode==='cleanup')assert.equal(r.returned_commit_evidence[0].cleanup_state,'failed');
  }
  if(mode==='dual') {assert.equal(r.failure_diagnostic.kind,'lease_unavailable');assert.equal(r.command_budget.stop_reason,'time_budget');assert.equal(r.request_budget.stop_reason,'lease_unavailable');}
  if(r.commit_evidence)assert.deepEqual(c.commit_evidence,r.commit_evidence);
});

test('opaque registries and closed public evidence reject fabricated receipts',()=>{
  const forged={state:'unavailable',reason:'lease_deadline'};
  assert.equal(readLarkApiLeaseFailure(forged),null);assert.equal(readReplayExecutionEvidence(forged),null);
  const initial=readReplayExecutionEvidence(createReplayExecutionEvidence('invented-attempt','1'.repeat(64)));
  assert.equal(initial.commit_state,'not_started');assert.ok(sanitizeHistoryCommitEvidence(initial));
  assert.equal(sanitizeHistoryCommitEvidence({...initial,receipt_validated:true,commit_state:'committed'}),null);
  assert.equal(sanitizeHistoryCommitEvidence({...initial,sql_execution:'started'}),null);
  assert.equal(sanitizeHistoryCommitEvidence({...initial,private_payload:'INVENTED_PRIVATE'}),null);
});
