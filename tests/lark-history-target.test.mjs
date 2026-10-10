import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { prepareChatWindowRecords } from '../src/adapters/lark-im/sync-runner.mjs';
import { executeLarkImHistory } from '../src/maintenance/history.mjs';

// Real history selector, adapter, request-session budget and database transaction.
// Only OS transport/lease boundaries are injected, never an actual API call.
test('unrelated merge roots never consume the selected ordinary history target budget',t=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'synthetic-history-merges-')));chmodSync(dir,0o700);
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=join(dir,'synthetic.sqlite'),start=Math.floor((Date.now()-86400000)/1000)*1000;
  const self={open_id:'ou_synthetic_observer',name:'Synthetic Observer'},chat='oc_synthetic_history',scope=chatScopeId(chat);
  const q=store.quoteSql,hash=text=>createHash('sha256').update(text).digest('hex');
  store.ensureInitialized(db);
  const confirmed=new Date(start).toISOString();
  store.sqliteExec(db,`UPDATE sources SET config_json=${q(JSON.stringify({initial_sync_start_ms:start,
    initial_account_binding:{kind:store.INITIAL_ACCOUNT_KIND,account_key:hash(`lark.im\0${self.open_id}`),reserved_at:confirmed,confirmed_at:confirmed}}))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(scope)},'lark.im','Synthetic scope',${q(JSON.stringify({chat_id:chat,chat_type:'group'}))});`);
  const native=id=>({message_id:id,chat_id:chat,msg_type:'text',create_time:String(start+1100),update_time:String(start+1100),
    sender:{id:'ou_synthetic_author',id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({text:'Synthetic ordinary target'})}});
  const target=native('om_synthetic_target');
  const roots=Array.from({length:3},(_,i)=>({...native(`om_synthetic_merge_${i}`),msg_type:'merge_forward',body:{content:'{}'}}));
  store.sqliteExec(db,store.upsertRecordsSql(prepareChatWindowRecords([normalizeApiMessage(target)],scope,null,start,start+60000,
    self.open_id,{self},{chat_id:chat,chat_type:'group'})));
  const before=store.sqliteQuery(db,'SELECT * FROM records;');
  const outcomes=[];
  for(let sweep=0;sweep<2;sweep++){
    const calls=[];let tick=0,held=false;
    const result=executeLarkImHistory({db,maxCliAttempts:4,maxSeconds:30},{requestSessionDeps:{
      env:{LARK_CLI:'synthetic-never-spawned'},monotonicClock:()=>tick,now:()=>Date.now(),
      sleep:ms=>{assert.equal(held,false);tick+=ms;},
      tryAcquireLease:()=>{assert.equal(held,false);held=true;return {state:'acquired',release(){held=false;}};},
      readSharedCooldown:()=>({state:'ready'}),writeSharedCooldown:()=>true,
      spawnSync:(_cmd,args)=>{
        assert.equal(held,true);calls.push(args);
        if(calls.length===1)return {status:0,stdout:JSON.stringify(self),stderr:''};
        const path=args[2];let data;
        if(path==='/open-apis/im/v1/messages')data={items:[target,...roots],has_more:false,page_token:''};
        else{const root=roots.find(r=>path.endsWith(r.message_id));assert.ok(root);
          data={items:[root,{...native(`${root.message_id}_child`),upper_message_id:root.message_id}]};}
        return {status:0,stdout:JSON.stringify({code:0,data}),stderr:''};
      },
    }});
    assert.equal(result.ok,true);assert.equal(result.outcome,'processed');assert.equal(calls.length,2);
    assert.equal(result.request_budget.cli_attempts,2);assert.equal(held,false);
    assert.deepEqual(store.sqliteQuery(db,'SELECT * FROM records;'),before);
    outcomes.push({outcome:result.outcome,calls:calls.map(args=>args[2]),budget:result.request_budget});
  }
  const progress=store.sqliteQuery(db,'SELECT completed_sweeps FROM lark_im_history_progress;')[0];
  assert.equal(progress.completed_sweeps,2);
  t.diagnostic(JSON.stringify({outcomes,progress,historyError:store.sqliteQuery(db,'SELECT history_error FROM record_observation_state;')[0]}));
});

for(const mode of ['complete','incomplete','permission','page_limit','item_limit','size_limit'])
test(`selected history merge uses only its bounded complete detail closure: ${mode}`,t=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'synthetic-history-selected-')));chmodSync(dir,0o700);
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=join(dir,'synthetic.sqlite'),start=Math.floor((Date.now()-86400000)/1000)*1000;
  const self={open_id:'ou_synthetic_observer',name:'Synthetic Observer'},chat='oc_synthetic_history',scope=chatScopeId(chat);
  const q=store.quoteSql,hash=text=>createHash('sha256').update(text).digest('hex'),confirmed=new Date(start).toISOString();
  store.ensureInitialized(db);
  store.sqliteExec(db,`UPDATE sources SET config_json=${q(JSON.stringify({initial_sync_start_ms:start,
    initial_account_binding:{kind:store.INITIAL_ACCOUNT_KIND,account_key:hash(`lark.im\0${self.open_id}`),reserved_at:confirmed,confirmed_at:confirmed}}))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(scope)},'lark.im','Synthetic scope',${q(JSON.stringify({chat_id:chat,chat_type:'group'}))});`);
  const native=id=>({message_id:id,chat_id:chat,msg_type:'text',create_time:String(start+1100),update_time:String(start+1100),
    sender:{id:'ou_synthetic_author',id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({text:'Synthetic child'})}});
  const root={...native('om_synthetic_selected'),msg_type:'merge_forward',body:{content:'{}'}};
  const siblings=Array.from({length:3},(_,i)=>({...root,message_id:`om_synthetic_other_${i}`}));
  const child={...native('om_synthetic_child'),upper_message_id:root.message_id};
  const selected=normalizeApiMessage(root,{mergeItems:[root,child]});
  store.sqliteExec(db,store.upsertRecordsSql(prepareChatWindowRecords([selected],scope,null,start,start+60000,self.open_id,{self},{chat_id:chat,chat_type:'group'})));
  const before=store.sqliteQuery(db,'SELECT * FROM records;'),calls=[];
  let tick=0,held=false;
  const result=executeLarkImHistory({db,maxCliAttempts:4,maxSeconds:30},{requestSessionDeps:{
    env:{LARK_CLI:'synthetic-never-spawned'},monotonicClock:()=>tick,now:()=>Date.now(),sleep:ms=>{assert.equal(held,false);tick+=ms;},
    tryAcquireLease:()=>{assert.equal(held,false);held=true;return {state:'acquired',release(){held=false;}};},
    readSharedCooldown:()=>({state:'ready'}),writeSharedCooldown:()=>true,
    spawnSync:(_cmd,args)=>{
      assert.equal(held,true);calls.push(args);
      if(calls.length===1)return {status:0,stdout:JSON.stringify(self),stderr:''};
      const path=args[2];let data;
      if(path==='/open-apis/im/v1/messages')data={items:[...siblings,root],has_more:false,page_token:''};
      else {
        assert.equal(path,`/open-apis/im/v1/messages/${root.message_id}`,'no unrelated detail fetch');
        if(mode==='permission')return {status:1,stdout:JSON.stringify({error:{code:99991672,message:'Synthetic permission secret'}}),stderr:''};
        const fresh={...child,body:{content:'{"text":"Synthetic child","unknown_provenance":7}'}};
        const items=mode==='incomplete'?[root]:mode==='item_limit'
          ?[root,...Array.from({length:100},(_,i)=>({...fresh,message_id:`om_synthetic_child_${i}`}))]:[root,fresh];
        if(mode==='size_limit')fresh.unknown_source_payload='x'.repeat(1024*1024);
        if(mode==='page_limit')data={items:calls.length===3?[root]:[fresh],has_more:true,page_token:`synthetic-next-${calls.length}`};
        else data={items};
      }
      return {status:0,stdout:JSON.stringify({code:0,data}),stderr:''};
    },
  }});
  assert.equal(held,false);assert.equal(calls.length,mode==='page_limit'?4:3);
  assert.equal(result.request_budget.cli_attempts,calls.length);
  assert.equal(result.ok,mode==='complete');assert.deepEqual(store.sqliteQuery(db,'SELECT * FROM records;'),before);
  const evidence=store.sqliteQuery(db,'SELECT * FROM record_observation_state;')[0];
  if(mode==='complete') {
    assert.equal(result.outcome,'pending_observation');
    const saved=JSON.parse(JSON.parse(evidence.candidate_json).raw_json);
    assert.equal(JSON.parse(saved.raw_api_expansions.merge_forward.items[1].body.content).unknown_provenance,7);
  } else { assert.ok(evidence.history_error); assert.equal(evidence.candidate_json,null); }
  assert.doesNotMatch(JSON.stringify(result),/permission secret|om_synthetic|oc_synthetic/);
});
