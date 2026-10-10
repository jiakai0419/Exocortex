import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, chmodSync, realpathSync, rmSync, readFileSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import { prepareObservationRecords } from '../dist/storage/sqlite/observation-store.js';
import { sourceRelation } from '../dist/core/lark-observation.js';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { prepareChatWindowRecords } from '../src/adapters/lark-im/sync-runner.mjs';
import { executeLarkImHistory, selectHistoryTarget } from '../src/maintenance/history.mjs';
import { executeLarkImReplay, validateReplayOptions } from '../src/maintenance/replay.mjs';

// Only authored synthetic data; every request boundary is injected.
const SELF = { open_id: 'ou_invented_observer', name: 'Invented Observer' };
const CHAT = 'oc_invented_archive', SCOPE = chatScopeId(CHAT);
const hash = text => createHash('sha256').update(text).digest('hex');
const q = store.quoteSql;
const rows = f => store.sqliteQuery(f.db, 'SELECT * FROM records ORDER BY id;');
const state = f => store.sqliteQuery(f.db, 'SELECT * FROM record_observation_state ORDER BY record_id;');
function fixture(t, count = 1) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'invented-observation-'))); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = { dir, db: join(dir, 'synthetic.sqlite'), start: Math.floor((Date.now()-86400000)/1000)*1000, calls: 0 };
  store.ensureInitialized(f.db);
  const confirmed = new Date(f.start).toISOString();
  store.sqliteExec(f.db, `UPDATE sources SET config_json=${q(JSON.stringify({initial_sync_start_ms:f.start,
    initial_account_binding:{kind:store.INITIAL_ACCOUNT_KIND,account_key:hash(`lark.im\0${SELF.open_id}`),reserved_at:confirmed,confirmed_at:confirmed}}))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(SCOPE)},'lark.im','Invented scope',${q(JSON.stringify({chat_id:CHAT,chat_type:'group'}))});`);
  f.messages = Array.from({length:count},(_,i)=>native(f,i));
  store.sqliteExec(f.db, store.upsertRecordsSql(records(f, f.messages)));
  return f;
}
function native(f, index=0, change={}) {
  return {message_id:`om_invented_archive_${index}`,chat_id:CHAT,msg_type:'text',
    create_time:String(f.start+1100+index), update_time:String(f.start+1100+index),
    sender:{id:`ou_invented_author_${index}`,id_type:'open_id',sender_type:'user'},
    body:{content:JSON.stringify({text:`Invented initial ${index}`})},...change};
}
function records(f, messages) {
  return prepareChatWindowRecords(messages.map(m=>normalizeApiMessage(m)), SCOPE, null, f.start, f.start+60000,
    SELF.open_id,{self:SELF},{chat_id:CHAT,chat_type:'group'});
}
function normal(f, record) {
  const scope=store.readScope(f.db,SCOPE), run=store.createRun(f.db,scope);
  return store.succeedRecordRun(f.db,scope,run,[record],1,{created_at_ms:f.start+60000},{});
}
function replayOptions(f, extra={}) {
  return validateReplayOptions({db:f.db,scopeIds:[SCOPE],messageIds:rows(f).map(r=>r.external_id),
    start:new Date(f.start).toISOString(),end:new Date(f.start+60000).toISOString(),
    maxCliAttempts:4,maxSeconds:30,reviewOut:join(f.dir,'review.json'),...extra});
}
function replay(f, messages, opts=replayOptions(f)) {
  return executeLarkImReplay(opts,{getSelfProfile:()=>{f.calls++;return SELF;},
    fetchChatMessages:()=>{f.calls++;return {messages:messages.map(m=>normalizeApiMessage(m)),pages:1};}});
}
const approved = (options, preview) => {const {reviewOut,...rest}=options;return {...rest,apply:true,reviewIn:reviewOut,reviewSha256:preview.review.sha256};};
function history(f, messages=f.messages, extra={}) {
  return executeLarkImHistory({db:f.db,maxCliAttempts:4,maxSeconds:30},{
    createRequestSession:()=>({runLark:()=>{throw Error('unexpected real boundary');},assertReady(){},summary:()=>({cli_attempts:2,max_cli_attempts:4,max_seconds:30,elapsed_ms:1})}),
    getSelfProfile:()=>{f.calls++;return SELF;},
    fetchChatMessageList:(chat,start,end)=>{f.calls++;assert.equal(chat,CHAT);assert.ok(end-start<=1000);return {messages:messages.map(m=>normalizeApiMessage(m)),pages:1};},...extra});
}

test('normal ingestion and replay refuse the same equal-version conflict and retain unknown source data',t=>{
  const f=fixture(t), before=rows(f), changed=native(f,0,{body:{content:'{"text":"Invented edited","future":{"x":1}}'}});
  const effects=normal(f,records(f,[changed])[0]);
  assert.equal(effects.updated,0);assert.equal(effects.duplicate,0);assert.equal(effects.conflicts,1);
  assert.deepEqual(rows(f),before);assert.equal(JSON.parse(state(f)[0].candidate_json).raw_json,JSON.stringify(changed));
  const projected=store.sqliteQuery(f.db,store.boundedReplayProjectionSql(records(f,[changed]),{dbPath:f.db}));
  assert.equal(projected[0].outcome,'conflict');
  normal(f,records(f,[changed])[0]);assert.deepEqual(rows(f),before,'ordinary repeated arrival is not a confirmation');
  const opts=replayOptions(f), result=replay(f,[changed],opts);
  assert.equal(result.ok,true);assert.equal(result.review.changes,0);
  assert.equal(JSON.parse(readFileSync(opts.reviewOut)).records[0].outcome,'conflict');
});

test('equivalent source refreshes derived projection consistently and preserves raw/name/unknown canonical evidence',t=>{
  const f=fixture(t), original=rows(f)[0];
  store.sqliteExec(f.db, `UPDATE records SET body='Invented obsolete projection',canonical_json=json_set(canonical_json,
    '$.sender_name','Invented known name','$.sender_name_source','contact','$.future_local','keep') WHERE id=${original.id};`);
  const record=records(f,f.messages)[0];
  record.canonical_json=JSON.stringify({...JSON.parse(record.canonical_json),future_new:'also keep'});
  const prepared=prepareObservationRecords(f.db,[record])[0];
  const projected=store.sqliteQuery(f.db,store.boundedReplayProjectionSql([record],{dbPath:f.db}))[0];
  assert.equal(projected.outcome,'update');
  normal(f,record);const after=rows(f)[0];
  for(const [key,value] of Object.entries(JSON.parse(projected.after_json)))assert.deepEqual(after[key],value,key);
  assert.equal(after.raw_json,original.raw_json);assert.equal(after.content_hash,original.content_hash);
  assert.equal(JSON.parse(after.canonical_json).sender_name,'Invented known name');
  assert.equal(JSON.parse(after.canonical_json).future_local,'keep');assert.equal(JSON.parse(after.canonical_json).future_new,'also keep');
  assert.equal(prepared.observation.action,'equivalent');
});

test('history converges a missed equal-version edit across restarts without advancing source cursors',t=>{
  const f=fixture(t), before=rows(f)[0], cursor=store.readScope(f.db,SCOPE).cursor_json;
  const changed=native(f,0,{body:{content:'{"text":"Invented missed edit","unknown":{"must":"survive"}}'}});
  assert.equal(history(f,[changed]).outcome,'pending_observation');assert.equal(rows(f)[0].raw_json,before.raw_json);
  const pending=state(f)[0];assert.ok(pending.candidate_json);assert.equal(pending.candidate_generation,0);
  // The next function call reconstructs all selection state from SQLite.
  const result=history(f,[changed]);assert.equal(result.updated,1);assert.equal(result.ok,true);
  assert.equal(rows(f)[0].raw_json,JSON.stringify(changed));assert.equal(state(f)[0].candidate_json,null);
  assert.equal(JSON.parse(state(f)[0].previous_json).raw_json,before.raw_json);
  assert.equal(store.readScope(f.db,SCOPE).cursor_json,cursor);
  assert.equal(store.sqliteQuery(f.db,'SELECT completed_sweeps FROM lark_im_history_progress;')[0].completed_sweeps,2);
  assert.equal(f.calls,4);
});

test('lost commit acknowledgement reuses one durable attempt, never provides a second confirmation',t=>{
  const f=fixture(t), changed=native(f,0,{body:{content:'{"text":"Invented missed"}'}});
  let captured, first;
  history(f,[changed],{commit:(db,options)=>{captured=options;first=store.commitBoundedReplayRecords(db,options);return first;}});
  assert.deepEqual(store.commitBoundedReplayRecords(f.db,captured),first);
  assert.equal(store.sqliteQuery(f.db,'SELECT COUNT(*) n FROM bounded_replay_runs;')[0].n,1);
  assert.equal(rows(f)[0].body,'Invented initial 0');
  assert.throws(()=>store.commitBoundedReplayRecords(f.db,{...captured,records:[]}),/identity reused/);
});

test('fixed horizon and scope rotation bound starvation while new traffic arrives',t=>{
  const f=fixture(t,2);
  history(f,[f.messages[0]]);
  const horizon=store.sqliteQuery(f.db,'SELECT sweep_max_id FROM lark_im_history_progress;')[0].sweep_max_id;
  store.sqliteExec(f.db,store.upsertRecordsSql(records(f,[native(f,2)])));
  const selection=selectHistoryTarget(f.db);assert.equal(selection.record.external_id,f.messages[1].message_id);
  assert.equal(selection.checkpoint.nextSweepMaxId,horizon);
  history(f,[f.messages[1]]);
  assert.equal(store.sqliteQuery(f.db,'SELECT completed_sweeps FROM lark_im_history_progress;')[0].completed_sweeps,1);
  assert.equal(selectHistoryTarget(f.db).record.external_id,f.messages[0].message_id);
  assert.equal(selectHistoryTarget(f.db).checkpoint.nextSweepMaxId,rows(f).at(-1).id);
});

for(const failure of ['missing','permission','incomplete'])test(`historical ${failure} records debt without deleting or falsely verifying a row`,t=>{
  const f=fixture(t,2), before=rows(f);
  const result=history(f,[],{fetchChatMessageList:()=>{if(failure==='permission')throw Error('invented forbidden secret');return {messages:[],pages:1,has_more:failure==='incomplete'};}});
  assert.equal(result.ok,false);assert.deepEqual(rows(f),before);assert.ok(state(f)[0].history_error);
  assert.equal(selectHistoryTarget(f.db).record.id,before[1].id);
  assert.doesNotMatch(JSON.stringify(result),/secret|om_invented|oc_invented/);
});

test('disabled source/scope performs no history API; local source/account drift fails the transaction',t=>{
  const f=fixture(t);
  store.sqliteExec(f.db,`UPDATE sync_scopes SET enabled=0 WHERE id=${q(SCOPE)};`);
  assert.equal(history(f).outcome,'no_eligible_known_record');assert.equal(f.calls,0);
  store.sqliteExec(f.db,`UPDATE sync_scopes SET enabled=1 WHERE id=${q(SCOPE)}; UPDATE sources SET enabled=0 WHERE id='lark.im';`);
  assert.equal(history(f).outcome,'no_eligible_known_record');assert.equal(f.calls,0);
  store.sqliteExec(f.db,"UPDATE sources SET enabled=1 WHERE id='lark.im';");
  assert.throws(()=>history(f,f.messages,{fetchChatMessageList:()=>{store.sqliteExec(f.db,"UPDATE sources SET enabled=0 WHERE id='lark.im';");return {messages:f.messages.map(m=>normalizeApiMessage(m)),pages:1};}}));
  assert.equal(store.sqliteQuery(f.db,'SELECT COUNT(*) n FROM lark_im_history_progress;')[0].n,0);
});

test('a late fetch cannot overwrite an ABA local change or qualify its stale candidate as confirmation',t=>{
  const f=fixture(t), before=rows(f)[0], changed=native(f,0,{body:{content:'{"text":"Invented stale"}'}});
  const result=history(f,[changed],{fetchChatMessageList:()=>{
    store.sqliteExec(f.db,`UPDATE records SET body='temporary invented'; UPDATE records SET body=${q(before.body)},updated_at=${q(before.updated_at)};`);
    return {messages:[normalizeApiMessage(changed)],pages:1};
  }});
  assert.equal(result.conflicts,1);assert.deepEqual(rows(f)[0],before);
  assert.equal(state(f)[0].candidate_generation,null);assert.equal(state(f)[0].reason,'local_generation_changed');
  assert.equal(history(f,[changed]).conflicts,1,'stale evidence is not the first confirmation');
  assert.equal(history(f,[changed]).updated,1);
});

test('older evidence stays pending and explicit deletion follows observation policy',t=>{
  const f=fixture(t), before=rows(f)[0], older=native(f,0,{update_time:String(f.start),body:{content:'{"text":"Invented older"}'}});
  history(f,[older]);history(f,[older]);assert.deepEqual(rows(f)[0],before);
  const deleted=native(f,0,{deleted:true});history(f,[deleted]);assert.deepEqual(rows(f)[0],before);
  history(f,[deleted]);assert.equal(JSON.parse(rows(f)[0].raw_json).deleted,true);
});

test('v4 accepts a proven representation-only fresh response while legacy approvals remain byte exact',t=>{
  for(const schema of ['v4','v3','v2','v1']) {
    const f=fixture(t), opts=replayOptions(f), changed=native(f,0,{update_time:String(f.start+9000),body:{content:'{"text":"Invented approved","future":{"a":1,"b":2}}'}});
    const preview=replay(f,[changed],opts);assert.equal(preview.ok,true);
    const input=approved(opts,preview);
    if(schema!=='v4') {
      const a=JSON.parse(readFileSync(opts.reviewOut));a.schema=`exocortex_private_maintenance_review/${schema}`;
      for(const r of a.records)delete r.proof;
      if(schema!=='v3'){delete a.binding.scope_config_policy;for(const s of a.binding.scopes)s.config_sha256=hash(store.readScope(f.db,SCOPE).config_json);}
      if(schema==='v1') { // v1 only supports interactive; exercised separately by the legacy card suite.
        continue;
      }
      writeFileSync(opts.reviewOut,JSON.stringify(a));input.reviewSha256=hash(readFileSync(opts.reviewOut));
    }
    const bytes=readFileSync(opts.reviewOut), before=rows(f), drift={...changed,body:{content:' {"future":{"b":2,"a":1},"text":"Invented approved"} '}};
    assert.equal(sourceRelation(JSON.stringify(changed),JSON.stringify(drift)),'json_representation');
    const result=replay(f,[drift],input);
    assert.equal(result.ok,schema==='v4',JSON.stringify(result));
    assert.deepEqual(readFileSync(opts.reviewOut),bytes);
    if(schema!=='v4') {
      assert.deepEqual(rows(f),before);const receipt=result.scopes[0].failure_evidence;assert.ok(receipt);
      const path=join(f.dir,receipt.file);assert.equal(statSync(path).mode&0o777,0o600);assert.equal(hash(readFileSync(path)),receipt.sha256);
      const saved=JSON.parse(readFileSync(path));assert.equal(saved.decisions[0].observed.raw_json,JSON.stringify(drift));
    }
  }
});

test('v4 rejects unknown source drift and saves the exact fresh candidate without modifying approval or records',t=>{
  const f=fixture(t), opts=replayOptions(f), before=rows(f);
  const changed=native(f,0,{update_time:String(f.start+9000),body:{content:'{"text":"Invented approved","hidden":"a"}'}});
  const preview=replay(f,[changed],opts), input=approved(opts,preview), bytes=readFileSync(opts.reviewOut);
  const drift={...changed,body:{content:'{"text":"Invented approved","hidden":"b"}'}};
  const result=replay(f,[drift],input);assert.equal(result.ok,false);assert.match(JSON.stringify(result),/proposal_changed/);
  assert.deepEqual(rows(f),before);assert.deepEqual(readFileSync(opts.reviewOut),bytes);
  const evidence=JSON.parse(readFileSync(join(f.dir,result.scopes[0].failure_evidence.file)));
  assert.equal(evidence.decisions[0].observed.raw_json,JSON.stringify(drift));
  assert.equal(evidence.decisions[0].comparison.projection,'different');
  assert.equal(readdirSync(f.dir).filter(name=>name.startsWith('.replay-rejected')).length,1);
});

function cardAliases(f, swapped=false, sameNames=false) {
  const ids=swapped?['b','a']:['a','b'], names=sameNames?['Same invented name','Same invented name']:['Invented A','Invented B'];
  return native(f,0,{msg_type:'interactive',update_time:String(f.start+9000),body:{content:JSON.stringify({
    json_card:JSON.stringify({elements:['a','b'].map(id=>({tag:'at',property:{userID:`native-${id}`}}))}),
    json_attachment:{at_users:Object.fromEntries(['a','b'].map((id,i)=>[`native-${id}`,
      {mention_key:`@_user_${swapped?2-i:i+1}`,user_id:`native-${id}`,content:names[i]}]))}
  })},mentions:ids.map((id,i)=>({key:`@_user_${i+1}`,id:`ou_invented_${id}`,id_type:'open_id',name:names[id==='a'?0:1]}))});
}
test('v4 whole reference proof accepts coordinated aliases and rejects same-name target rebinding',t=>{
  for(const rebinding of [false,true]) {
    const f=fixture(t), opts=replayOptions(f), candidate=cardAliases(f,false,rebinding);
    const preview=replay(f,[candidate],opts);assert.equal(preview.ok,true,JSON.stringify(preview));
    const fresh=cardAliases(f,true,rebinding);
    if(rebinding)fresh.mentions=candidate.mentions;
    const result=replay(f,[fresh],approved(opts,preview));
    assert.equal(result.ok,!rebinding,JSON.stringify(result));
    if(rebinding){assert.match(JSON.stringify(result),/proposal_changed/);assert.equal(rows(f)[0].body,'Invented initial 0');}
    else assert.equal(rows(f)[0].body,'@Invented A\n@Invented B');
  }
});

test('detail queue, list ingestion and replay use one conservative equal-version selection rule',t=>{
  const f=fixture(t,0), root=native(f,0,{msg_type:'merge_forward',body:{content:'{"title":"Invented bundle"}'}});
  const child=native(f,1,{upper_message_id:root.message_id});
  const record=children=>records(f,[root])[0];
  const detail=items=>prepareChatWindowRecords([normalizeApiMessage(root,{mergeItems:[root,...items]})],SCOPE,null,
    f.start,f.start+60000,SELF.open_id,{self:SELF},{chat_id:CHAT,chat_type:'group'})[0];
  function queue(raw) {
    const scope=store.readScope(f.db,SCOPE), run=store.createRun(f.db,scope);
    store.commitLarkListRun(f.db,scope,run,[],[raw],1,{created_at_ms:f.start+60000},{initial_sync_start_ms:f.start,
      list_window_start_ms:scope.cursor?.created_at_ms??f.start,list_window_end_ms:f.start+60000});
    return store.readPendingLarkDetails(f.db,store.readScope(f.db,SCOPE),{now:'2099-01-01T00:00:00Z'})[0];
  }
  const task=queue(root), scope=store.readScope(f.db,SCOPE), run=store.createRun(f.db,scope);
  store.finishLarkDetailRun(f.db,scope,run,[{message_id:root.message_id,fingerprint:task.fingerprint,record:detail([child])}],{});
  const before=rows(f)[0];
  const changed=detail([{...child,body:{content:'{"text":"Invented changed child"}'}}]);
  normal(f,changed);assert.deepEqual(rows(f)[0],before);
  assert.equal(store.sqliteQuery(f.db,store.boundedReplayProjectionSql([changed],{dbPath:f.db}))[0].outcome,'conflict');
  const expanded=JSON.parse(before.raw_json), repr=structuredClone(expanded);
  repr.raw_api_expansions.merge_forward.items[1].body.content=' { "text" : "Invented initial 1" } ';
  assert.equal(sourceRelation(before.raw_json,JSON.stringify(repr)),'json_representation');
});

test('candidate evidence transaction binds its own generation as well as the selected row',t=>{
  const f=fixture(t), a=records(f,[native(f,0,{body:{content:'{"text":"Invented candidate A"}'}})])[0];
  const b=records(f,[native(f,0,{body:{content:'{"text":"Invented candidate B"}'}})])[0];
  const prepared=prepareObservationRecords(f.db,[a]);
  normal(f,b);
  assert.throws(()=>store.sqliteExec(f.db,`BEGIN IMMEDIATE;${store.upsertRecordsSql(prepared)}COMMIT;`),/CHECK constraint/);
  assert.equal(JSON.parse(state(f)[0].candidate_json).body,'Invented candidate B');
});

test('private rejection evidence is bounded and cannot be used as approval input',t=>{
  const f=fixture(t), opts=replayOptions(f), candidate=native(f,0,{update_time:String(f.start+9000),body:{content:'{"text":"Approved invented"}'}});
  const preview=replay(f,[candidate],opts), input=approved(opts,preview);
  const drift=native(f,0,{update_time:String(f.start+9000),body:{content:'{"text":"Unapproved invented"}'}});
  let receipt;
  for(let i=0;i<3;i++) {const result=replay(f,[drift],input);assert.equal(result.ok,false);receipt=result.scopes[0].failure_evidence;assert.ok(receipt);}
  const fourth=replay(f,[drift],input);assert.match(JSON.stringify(fourth),/evidence_capacity/);
  assert.equal(readdirSync(f.dir).filter(name=>name.startsWith('.replay-rejected')).length,3);
  assert.throws(()=>replay(f,[drift],{...input,reviewIn:join(f.dir,receipt.file),reviewSha256:receipt.sha256}),/invalid_file/);
  assert.equal(rows(f)[0].body,'Invented initial 0');
});

for(const mode of ['complete','cli_budget','deadline','rate_limit'])test(`history uses the real shared request session with ${mode}, no lookup fanout or uncounted retries`,t=>{
  const f=fixture(t), before=rows(f), calls=[];
  let tick=0, held=false, releases=0, cooldownWrites=0;
  const result=executeLarkImHistory({db:f.db,maxCliAttempts:mode==='cli_budget'?2:4,maxSeconds:30},{requestSessionDeps:{
    env:{LARK_CLI:'synthetic-cli'},monotonicClock:()=>tick,now:()=>Date.now(),
    sleep:ms=>{assert.equal(held,false);tick+=ms;},
    tryAcquireLease:opts=>{assert.equal(opts.role,'probe');assert.equal(held,false);held=true;return {state:'acquired',release(){held=false;releases++;}};},
    readSharedCooldown:()=>({state:'ready'}),writeSharedCooldown:()=>{assert.equal(held,true);cooldownWrites++;return true;},
    spawnSync:(_command,args,settings)=>{
      assert.equal(held,true);assert.ok(settings.timeout<=30000);calls.push(args);
      if(calls.length===1)return {status:0,stdout:JSON.stringify(SELF),stderr:''};
      assert.equal(args[2],'/open-apis/im/v1/messages');
      const params=JSON.parse(args[args.indexOf('--params')+1]);assert.equal(params.card_msg_content_type,'raw_card_content');
      if(mode==='deadline')tick=30001;
      if(mode==='rate_limit')return {status:1,stdout:JSON.stringify({error:{type:'api',code:99991400,message:'Invented secret',detail:{headers:{'x-ogw-ratelimit-reset':'20'}}}}),stderr:''};
      return {status:0,stdout:JSON.stringify({code:0,data:{items:f.messages,has_more:mode==='cli_budget',page_token:mode==='cli_budget'?'invented-next':''}}),stderr:''};
    }
  }});
  assert.equal(result.ok,mode==='complete',JSON.stringify(result));assert.equal(calls.length,2);assert.equal(releases,2);assert.equal(held,false);
  assert.equal(result.request_budget.cli_attempts,2);assert.deepEqual(rows(f),before);
  if(mode!=='complete')assert.equal(result.request_budget.stop_reason,{cli_budget:'cli_budget',deadline:'time_budget',rate_limit:'rate_limited'}[mode]);
  assert.equal(cooldownWrites,mode==='rate_limit'?1:0);
  assert.doesNotMatch(JSON.stringify(result),/secret|oc_invented|om_invented/);
});

test('migration preserves legacy nineteen-column rows, and status exposes unresolved evidence without migrating on read',async t=>{
  const {buildStatus}=await import('../src/diagnostics/sync-status-report.mjs');
  const f=fixture(t), before=rows(f);
  store.sqliteExec(f.db,`DROP TRIGGER record_observation_insert; DROP TRIGGER record_observation_generation;
    DROP TABLE record_observation_state; DROP TABLE lark_im_history_progress; DROP INDEX records_history_scope_id;
    DELETE FROM schema_migrations WHERE version='010';`);
  const bytes=readFileSync(f.db);
  assert.equal(buildStatus(f.db).source_observations.evidence,'legacy_unavailable');assert.deepEqual(readFileSync(f.db),bytes);
  store.ensureInitialized(f.db);assert.deepEqual(rows(f),before);
  assert.equal(store.sqliteQuery(f.db,"SELECT COUNT(*) n FROM pragma_table_info('records');")[0].n,19);
  assert.equal(state(f)[0].observed_at_ms,null);assert.equal(state(f)[0].reason,'legacy_observation');
  normal(f,records(f,[native(f,0,{body:{content:'{"text":"Invented conflict"}'}})])[0]);
  const status=buildStatus(f.db).source_observations;
  assert.equal(status.pending,1);assert.equal(status.coverage,'processed_known_rows_not_source_completeness');
});

test('history rotates enabled scopes independently of a permanently missing older record',t=>{
  const f=fixture(t), otherChat='oc_invented_second_archive', otherScope=chatScopeId(otherChat);
  store.sqliteExec(f.db,`INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(otherScope)},'lark.im','Invented second scope',${q(JSON.stringify({chat_id:otherChat,chat_type:'group'}))});`);
  const other=native(f,1,{chat_id:otherChat});
  const records=prepareChatWindowRecords([normalizeApiMessage(other)],otherScope,null,f.start,f.start+60000,SELF.open_id,{self:SELF},{chat_id:otherChat,chat_type:'group'});
  store.sqliteExec(f.db,store.upsertRecordsSql(records));
  const first=selectHistoryTarget(f.db);
  history(f,[],{fetchChatMessageList:()=>({messages:[],pages:1})});
  const second=selectHistoryTarget(f.db);assert.notEqual(second.scope.id,first.scope.id);
  history(f,[],{fetchChatMessageList:()=>({messages:[],pages:1})});
  assert.equal(selectHistoryTarget(f.db).scope.id,first.scope.id);
});

test('a legacy mixed approval cannot authorize an extra equal-version projection refresh',async t=>{
  const {stable}=await import('../dist/core/lark-observation.js');
  const {effectiveRecord}=await import('../src/maintenance/review-artifact.mjs');
  const f=fixture(t,2);
  store.sqliteExec(f.db,"UPDATE records SET body='Invented privately retained projection' WHERE external_id='om_invented_archive_1';");
  const before=rows(f), opts=replayOptions(f), observed=[native(f,0,{update_time:String(f.start+9000),body:{content:'{"text":"Invented approved newer"}'}}),f.messages[1]];
  const preview=replay(f,observed,opts);assert.equal(preview.review.changes,2);
  // Author the documented legacy wire shape: the old strict projector leaves
  // the equal-version member unchanged while approving the newer member.
  const artifact=JSON.parse(readFileSync(opts.reviewOut));artifact.schema='exocortex_private_maintenance_review/v3';
  for(const entry of artifact.records)delete entry.proof;
  const unchanged=artifact.records[1];unchanged.outcome='duplicate';unchanged.changed_fields=[];
  unchanged.proposal_sha256=hash(stable(effectiveRecord(before[1])));
  unchanged.display.after=unchanged.display.before;unchanged.opaque.after=unchanged.opaque.before;unchanged.opaque.changed_fields=[];
  writeFileSync(opts.reviewOut,JSON.stringify(artifact));
  const result=replay(f,observed,{...approved(opts,preview),reviewSha256:hash(readFileSync(opts.reviewOut))});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.scopes[0].updated,1);
  assert.deepEqual(rows(f)[1],before[1]);
});

test('confirmation cannot combine observations from two account or source-policy contexts',t=>{
  const f=fixture(t), changed=native(f,0,{body:{content:'{"text":"Invented pending snapshot"}'}});
  history(f,[changed]);const before=rows(f);
  const otherSelf={open_id:'ou_invented_different_observer',name:'Invented Other Observer'};
  store.sqliteExec(f.db,`UPDATE sources SET config_json=json_set(config_json,'$.initial_account_binding.account_key',${q(hash(`lark.im\0${otherSelf.open_id}`))}) WHERE id='lark.im';`);
  const second=history(f,[changed],{getSelfProfile:()=>otherSelf});
  assert.equal(second.conflicts,1);assert.deepEqual(rows(f),before);
  assert.equal(history(f,[changed],{getSelfProfile:()=>otherSelf}).updated,1);
});

test('autonomous historical recheck requires a verified account association',t=>{
  const f=fixture(t), before=rows(f);
  store.sqliteExec(f.db,"UPDATE sources SET config_json=json_remove(config_json,'$.initial_account_binding') WHERE id='lark.im';");
  let fetches=0;
  assert.throws(()=>history(f,f.messages,{fetchChatMessageList:()=>{fetches++;return {messages:[],pages:1};}}),/account identity unavailable/);
  assert.equal(fetches,0);assert.deepEqual(rows(f),before);
  assert.equal(store.sqliteQuery(f.db,'SELECT COUNT(*) n FROM lark_im_history_progress;')[0].n,0);
});

test('automatic history retains one audit receipt per scope without pruning explicit repair audits',t=>{
  const f=fixture(t), changed=native(f,0,{update_time:String(f.start+9000),body:{content:'{"text":"Invented explicit repair"}'}});
  const {reviewOut,...options}=replayOptions(f,{apply:true,reviewOut:undefined});
  assert.equal(replay(f,[changed],options).ok,true);
  const manual=store.sqliteQuery(f.db,'SELECT id FROM bounded_replay_runs;')[0].id;
  for(let i=0;i<4;i++)history(f,[changed]);
  const audits=store.sqliteQuery(f.db,'SELECT id FROM bounded_replay_runs;');
  assert.equal(audits.length,2);assert.ok(audits.some(row=>row.id===manual));
  assert.equal(store.sqliteQuery(f.db,'SELECT generation FROM lark_im_history_progress;')[0].generation,4);
});


test('unversioned native observations expose unordered debt and cannot silently establish a numeric baseline',async t=>{
  const f=fixture(t), unversioned={...f.messages[0]};delete unversioned.update_time;
  store.sqliteExec(f.db,'DELETE FROM records;');
  store.sqliteExec(f.db,store.upsertRecordsSql(records(f,[unversioned])));
  const before=rows(f), changed=native(f,0,{body:{content:'{"text":"Invented numeric candidate"}'}});
  for(let i=0;i<2;i++)assert.equal(normal(f,records(f,[changed])[0]).conflicts,1);
  assert.deepEqual(rows(f),before);assert.equal(state(f)[0].reason,'source_version_unordered');
  assert.equal(selectHistoryTarget(f.db),null);
  const {buildStatus}=await import('../src/diagnostics/sync-status-report.mjs');
  assert.equal(buildStatus(f.db).source_observations.pending_unordered_versions,1);
});

test('history confirmation resets on unknown scope policy changes but not the existing discovery scheduling projection',t=>{
  const f=fixture(t), changed=native(f,0,{body:{content:'{"text":"Invented stable candidate"}'}});
  assert.equal(history(f,[changed]).conflicts,1);const before=rows(f), first=state(f)[0].candidate_context;
  store.sqliteExec(f.db,`UPDATE sync_scopes SET config_json=json_set(config_json,'$.unknown_future_policy','changed') WHERE id=${q(SCOPE)};`);
  assert.equal(history(f,[changed]).conflicts,1);assert.deepEqual(rows(f),before);
  assert.notEqual(state(f)[0].candidate_context,first);
  store.sqliteExec(f.db,`UPDATE sync_scopes SET config_json=json_set(config_json,'$.hot_rank',4,'$.hot_seen_at','invented','$.last_hot_snapshot_id','invented') WHERE id=${q(SCOPE)};`);
  assert.equal(history(f,[changed]).updated,1);
});


test('history-confirmed received details remain coverage debt until a fresh accepted detail retry completes',t=>{
  const f=fixture(t,0), root=native(f,0,{msg_type:'merge_forward',body:{content:'{}'}});
  const child=native(f,1,{upper_message_id:root.message_id});
  const freshChild={...child,body:{content:'{"text":"Invented stable child","unknown_source_field":4}'}};
  const expanded=items=>normalizeApiMessage(root,{mergeItems:[root,...items]});
  const detail=items=>prepareChatWindowRecords([expanded(items)],SCOPE,null,f.start,f.start+60000,SELF.open_id,{self:SELF},{chat_id:CHAT,chat_type:'group'})[0];
  store.sqliteExec(f.db,store.upsertRecordsSql([detail([child])]));
  let scope=store.readScope(f.db,SCOPE),run=store.createRun(f.db,scope);
  store.commitLarkListRun(f.db,scope,run,[],[root],1,{created_at_ms:f.start+60000},{initial_sync_start_ms:f.start,list_window_start_ms:f.start,list_window_end_ms:f.start+60000});
  const finish=()=>{scope=store.readScope(f.db,SCOPE);run=store.createRun(f.db,scope);const task=store.readPendingLarkDetails(f.db,scope,{now:'2099-01-01T00:00:00Z'})[0];
    return store.finishLarkDetailRun(f.db,scope,run,[{message_id:root.message_id,fingerprint:task.fingerprint,record:detail([freshChild])}]);};
  assert.equal(finish().pending_details,1);const before=rows(f),cursor=store.readScope(f.db,SCOPE).cursor_json;
  const deps={fetchChatMessageList:()=>({messages:[],detailRoots:[root],pages:1}),fetchMessageDetails:()=>expanded([freshChild])};
  assert.equal(history(f,[],deps).conflicts,1);assert.deepEqual(rows(f),before);
  assert.equal(history(f,[],deps).updated,1);
  assert.equal(store.readScope(f.db,SCOPE).cursor_json,cursor);
  assert.equal(store.sqliteQuery(f.db,'SELECT status FROM lark_im_detail_tasks;')[0].status,'pending');
  const completed=finish();assert.equal(completed.full_cursor_promoted,true);assert.equal(completed.conflicts,undefined);
  assert.equal(store.readScope(f.db,SCOPE).cursor.created_at_ms,f.start+60000);
  assert.equal(JSON.parse(rows(f)[0].raw_json).raw_api_expansions.merge_forward.items[1].body.content,freshChild.body.content);
});


for(const [beforeValue,afterValue] of [
  ['9007199254740992','9007199254740993'],
  ['1.00000000000000001','1.00000000000000002'],
])test(`history config context preserves unsafe numeric source text: ${beforeValue}`,t=>{
  const f=fixture(t), changed=native(f,0,{body:{content:'{"text":"Invented numeric context candidate"}'}});
  assert.equal(JSON.parse(beforeValue),JSON.parse(afterValue),'the JS numeric projection is intentionally identical');
  const config=value=>`{"chat_id":"${CHAT}","chat_type":"group","unknown_future_id":${value}}`;
  store.sqliteExec(f.db,`UPDATE sync_scopes SET config_json=${q(config(beforeValue))} WHERE id=${q(SCOPE)};`);
  assert.equal(history(f,[changed]).conflicts,1);const before=rows(f),first=state(f)[0].candidate_context;
  store.sqliteExec(f.db,`UPDATE sync_scopes SET config_json=${q(config(afterValue))} WHERE id=${q(SCOPE)};`);
  assert.equal(history(f,[changed]).conflicts,1);assert.deepEqual(rows(f),before);
  assert.notEqual(state(f)[0].candidate_context,first);
  // In this fallback even hot-only changes reset confirmation: do not project
  // any unverified JSON through rounded JS numbers to preserve the exception.
  const hot=config(afterValue).slice(0,-1)+',"hot_rank":2}';
  store.sqliteExec(f.db,`UPDATE sync_scopes SET config_json=${q(hot)} WHERE id=${q(SCOPE)};`);
  assert.equal(history(f,[changed]).conflicts,1);assert.deepEqual(rows(f),before);
  assert.equal(history(f,[changed]).updated,1,'two distinct reads under unchanged exact config can still confirm');
});
