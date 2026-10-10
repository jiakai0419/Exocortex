import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeLarkImReplay, validateReplayOptions, parseReplayTime } from "../src/maintenance/replay.mjs";
import { runMaintenanceCommand } from "../src/cli/maintenance-command.mjs";
import { parseRouteOptions } from "../src/cli/registry.mjs";
import { createCommandContext } from "../src/cli/context.mjs";
import { createMaintenanceRequestSession } from "../src/maintenance/request-session.mjs";
function parseArgs(argv) { return validateReplayOptions(parseRouteOptions("maintenance.replay",argv).options); }
function runReplay(argv, io) {
  const parsed=parseRouteOptions("maintenance.replay",argv);
  return runMaintenanceCommand(parsed.options, { ...createCommandContext({ stdout:io.stdout, stderr:io.stderr,
    now:io.deps.now }), provided:parsed.provided, deps:io.deps });
}
import { chatScopeId } from "../src/adapters/lark-im/core.mjs";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";
import { prepareChatWindowRecords } from "../src/adapters/lark-im/sync-runner.mjs";
import { readOnlySqliteJson } from "../src/storage/sqlite/readonly-query.mjs";
import { ensureInitialized, quoteSql, sqliteExec, upsertRecordsSql } from "../dist/storage/sqlite/ingestion-store.js";

// Independent synthetic window; no production timestamps or replay counts.
const START = "2040-04-12T04:00:00+02:00";
const END = "2040-04-12T10:00:00+02:00";
const START_MS = Date.parse(START);
const END_MS = Date.parse(END);
const SELF = { open_id: "ou_synthetic_self", name: "Synthetic Self" };
const CHAT = "oc_synthetic_replay";
const SCOPE = chatScopeId(CHAT);
const ro = (db, sql) => readOnlySqliteJson(db, sql, "read synthetic replay fixture");
const sql = (db, value) => sqliteExec(db, value, "write synthetic replay fixture");

function fixture(t, chats = [CHAT]) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-replay-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "synthetic.sqlite");
  ensureInitialized(db);
  sql(db, `UPDATE sources SET config_json='{"initial_sync_start_ms":${START_MS}}' WHERE id='lark.im';`);
  for (const chat of chats) {
    sql(db, `INSERT INTO sync_scopes (id,source_id,name,config_json,cursor_json,cursor_updated_at)
      VALUES (${quoteSql(chatScopeId(chat))},'lark.im',${quoteSql(chat)},${quoteSql(JSON.stringify({chat_id:chat,chat_type:"group"}))},
        '{"created_at_ms":${END_MS + 86400000},"message_id":"future-cursor"}',${quoteSql(new Date(END_MS + 86400000).toISOString())});`);
  }
  return { db, dir };
}

function options(db, {apply = true, chats = [CHAT], start = START, end = END, messageIds = [], maxCliAttempts, maxSeconds} = {}) {
  return parseArgs(["--db",db,...chats.flatMap((chat) => ["--scope-id",chatScopeId(chat)]),"--start",start,"--end",end,
    ...messageIds.flatMap((id) => ["--message-id",id]),
    ...(maxCliAttempts === undefined ? [] : ["--max-cli-attempts",String(maxCliAttempts)]),
    ...(maxSeconds === undefined ? [] : ["--max-seconds",String(maxSeconds)]),
    ...(apply ? ["--apply"] : [])]);
}

function message(id = "om_synthetic_root", overrides = {}) {
  return normalizeApiMessage({message_id:id,chat_id:CHAT,create_time:String(START_MS + 1000),update_time:String(START_MS + 1000),
    msg_type:"text",sender:{id:"ou_synthetic_peer",sender_type:"user"},body:{content:JSON.stringify({text:`Synthetic ${id}`})},...overrides});
}

function records(messages, chat = CHAT) {
  return prepareChatWindowRecords(messages,chatScopeId(chat),null,START_MS,END_MS,SELF.open_id,{self:SELF},{chat_id:chat,chat_type:"group"});
}

function seedRecords(db, rows) { sql(db, upsertRecordsSql(rows)); }
function run(db, messages, extra = {}, opts = {}) {
  return executeLarkImReplay(options(db, opts),{getSelfProfile:()=>SELF,fetchChatMessages:()=>({messages,pages:1}),now:()=>END_MS+1000,...extra});
}
function protectedState(db) {
  return Object.fromEntries(["sources","sync_scopes","sync_runs"].map((table)=>[table,ro(db,`SELECT * FROM ${table} ORDER BY id;`)]));
}
function assertNoRepair(db) {
  assert.equal(ro(db,"SELECT count(*) AS n FROM bounded_replay_runs;")[0].n,0);
  assert.equal(ro(db,"SELECT count(*) AS n FROM records;")[0].n,0);
  assert.equal(ro(db,"SELECT count(*) AS n FROM maintenance_locks;")[0].n,0);
}

test("explicit timezone times, calendar validity and one to three unique scopes are required", () => {
  assert.equal(parseReplayTime("2040-04-12T02:00:00Z","--start"),START_MS);
  for (const value of ["2040-04-12","2040-04-12T04:00:00","2040-02-30T00:00:00Z","2040-04-12T24:00:00Z","2040-04-12T04:00:00+24:00"]) {
    assert.throws(()=>parseReplayTime(value,"--start"));
  }
  for (const chats of [[],[CHAT,CHAT],[CHAT,"oc_2","oc_3","oc_4"]]) assert.throws(()=>options("/synthetic",{chats}));
  assert.throws(()=>options("/synthetic",{start:END,end:START}));
  assert.throws(()=>parseArgs(["--db","/synthetic","--scope-id",SCOPE,"--start",START,"--end",END,"--apply","--dry-run"]));
  assert.equal(parseRouteOptions("maintenance.replay",["--help"]).help,true);
});

test("inserts three synthetic thread replies, retains the root and repeats idempotently without changing normal evidence", (t) => {
  const {db} = fixture(t);
  const root = message();
  const messages = [root,...Array.from({length:3},(_,i)=>message(`om_reply_${i}`,{
    create_time:String(START_MS+2000+i),root_id:root.message_id,parent_id:root.message_id,thread_id:"omt_synthetic",
    ...(i===0 ? {sender:{id:SELF.open_id,sender_type:"user"}} : {}),
  }))];
  seedRecords(db,records([root]));
  const before = protectedState(db);
  const deps = {fetchChatMessages:(chat,start,end)=>{
    assert.equal(chat,CHAT); assert.equal(start,START_MS); assert.equal(end,END_MS);
    assert.equal(ro(db,"SELECT count(*) AS n FROM maintenance_locks;")[0].n,0);
    return {messages,pages:2};
  }};
  const first = run(db,messages,deps);
  assert.equal(first.ok,true);
  assert.deepEqual([first.scopes[0].inserted,first.scopes[0].updated,first.scopes[0].duplicate,first.scopes[0].conflicts],[3,0,1,0]);
  const saved = ro(db,"SELECT * FROM records ORDER BY external_id;");
  assert.equal(saved.length,4);
  assert.equal(saved.find((row)=>row.external_id==="om_reply_0").direction,"sent");
  for (const row of saved) assert.equal(row.content_hash,createHash("sha256").update(row.raw_json).digest("hex"));
  const reply = JSON.parse(saved.find((row)=>row.external_id==="om_reply_1").canonical_json);
  assert.equal(reply.root_id,root.message_id);
  assert.equal(reply.parent_id,root.message_id);
  assert.equal(reply.thread_id,"omt_synthetic");
  const second = run(db,messages,deps);
  assert.equal(second.ok,true);
  assert.equal(second.plan_id,first.plan_id);
  assert.notEqual(second.attempt_id,first.attempt_id);
  assert.deepEqual([second.scopes[0].inserted,second.scopes[0].updated,second.scopes[0].duplicate,second.scopes[0].conflicts],[0,0,4,0]);
  assert.deepEqual(ro(db,"SELECT * FROM records ORDER BY external_id;"),saved);
  assert.deepEqual(protectedState(db),before);
  assert.equal(ro(db,"SELECT count(*) AS n FROM bounded_replay_runs;")[0].n,2);
  assert.equal(ro(db,"SELECT count(*) AS n FROM maintenance_locks;")[0].n,0);
});

test("strict version protection preserves old, same-version changed, opaque, unknown and enriched facts", (t) => {
  const {db} = fixture(t);
  const names = ["old","equal_changed","opaque","unknown","newer","identical"];
  const original = names.map((id)=>message(id));
  const rows = records(original).map((record)=>({...record,
    ...(record.external_id==="opaque" ? {external_version:"opaque-v1"} : {}),
    ...(record.external_id==="unknown" ? {external_version:null} : {}),
    ...(record.external_id==="identical" ? {body:"Privately enriched preserved body",canonical_json:'{"enriched":true}'} : {}),
  }));
  seedRecords(db,rows);
  const before = ro(db,"SELECT * FROM records ORDER BY external_id;");
  const incoming = names.map((id)=>message(id,{
    update_time:String(START_MS+(id==="old" ? 999 : id==="newer" ? 2000 : 1000)),
    ...(id==="identical" ? {} : {body:{content:'{"text":"Changed synthetic text"}'}}),
  }));
  const result=run(db,incoming);
  assert.equal(result.ok,true);
  assert.deepEqual([result.scopes[0].inserted,result.scopes[0].updated,result.scopes[0].duplicate,result.scopes[0].conflicts],[0,1,1,4]);
  const after=ro(db,"SELECT * FROM records ORDER BY external_id;");
  for (const row of before) if(row.external_id!=="newer") assert.deepEqual(after.find((value)=>value.id===row.id),row);
  assert.equal(after.find((row)=>row.external_id==="newer").external_version,String(START_MS+2000));
});

test("default preview makes no business, permission, schema or audit changes", (t) => {
  const {db,dir}=fixture(t);
  chmodSync(dir,0o755); chmodSync(db,0o644);
  const before=readFileSync(db);
  const result=run(db,[message()],{}, {apply:false});
  assert.equal(result.ok,true); assert.equal(result.dry_run,true);
  assert.equal(result.scopes[0].missing_candidates,1);
  assert.deepEqual(readFileSync(db),before);
  assert.equal(statSync(db).mode&0o777,0o644); assert.equal(statSync(dir).mode&0o777,0o755);
  assertNoRepair(db);
});

test("duplicate page items dedupe exact facts, choose a provably newer version, and reject ambiguous facts", (t) => {
  const {db}=fixture(t);
  const first=message("om_duplicate");
  assert.equal(run(db,[first,first]).scopes[0].inserted,1);
  const conflicting=message("om_ambiguous",{body:{content:'{"text":"Different"}'}});
  assert.equal(run(db,[message("om_ambiguous"),conflicting]).ok,false);
  assert.equal(ro(db,"SELECT count(*) AS n FROM records WHERE external_id='om_ambiguous';")[0].n,0);
  const newer=message("om_newest",{update_time:String(START_MS+5000),body:{content:'{"text":"Newer"}'}});
  assert.equal(run(db,[newer,message("om_newest")]).ok,true);
  assert.equal(ro(db,"SELECT external_version FROM records WHERE external_id='om_newest';")[0].external_version,String(START_MS+5000));
});

test("missing database and missing audit schema fail before any remote lookup or write", (t) => {
  const {db,dir}=fixture(t);
  const unavailable=join(dir,"missing-parent","missing.sqlite");
  let lookups=0;
  const deps={getSelfProfile:()=>{lookups++;return SELF;}};
  assert.throws(()=>run(unavailable,[],deps));
  assert.equal(existsSync(join(dir,"missing-parent")),false);
  sql(db,"DROP TABLE bounded_replay_runs;");
  assert.throws(()=>run(db,[],deps),/migrate/);
  assert.equal(lookups,0);
  const preview=run(db,[],deps,{apply:false});
  assert.equal(preview.ok,true); assert.equal(preview.audit_schema_ready,false);
  assert.equal(ro(db,"SELECT name FROM sqlite_master WHERE name='bounded_replay_runs';").length,0);
});

test("baseline, future window, disabled or inconsistent selection fails closed before API", async (t) => {
  const cases={
    missing_baseline:"UPDATE sources SET config_json='{}';",
    seconds_baseline:`UPDATE sources SET config_json='{"initial_sync_start_ms":${Math.floor(START_MS / 1000)}}';`,
    source_disabled:"UPDATE sources SET enabled=0;",
    scope_disabled:`UPDATE sync_scopes SET enabled=0 WHERE id=${quoteSql(SCOPE)};`,
    wrong_chat:`UPDATE sync_scopes SET config_json='{"chat_id":"oc_wrong"}' WHERE id=${quoteSql(SCOPE)};`,
    unsupported:`UPDATE sync_scopes SET config_json='{"chat_id":"${CHAT}","unsupported_reason":"unavailable"}' WHERE id=${quoteSql(SCOPE)};`,
  };
  for (const [name,mutation] of Object.entries(cases)) await t.test(name,(t)=>{
    const {db}=fixture(t); sql(db,mutation);
    assert.throws(()=>run(db,[],{getSelfProfile:()=>{assert.fail("unexpected API");}}));
    assertNoRepair(db);
  });
  const {db}=fixture(t);
  assert.throws(()=>run(db,[],{}, {start:new Date(START_MS - 1000).toISOString()}),/baseline/);
  assert.throws(()=>run(db,[],{now:()=>END_MS-1}),/future/);
  assertNoRepair(db);
});

test("self identity must be verified and match existing sent record evidence", (t) => {
  const {db}=fixture(t);
  seedRecords(db,records([message("om_self",{sender:{id:SELF.open_id,sender_type:"user"}})]));
  for (const profile of [null,{open_id:"guessed"},{open_id:"ou_other_account"}]) {
    assert.throws(()=>run(db,[],{getSelfProfile:()=>profile,fetchChatMessages:()=>assert.fail("unexpected fetch")}));
  }
  assert.equal(ro(db,"SELECT count(*) AS n FROM bounded_replay_runs;")[0].n,0);
});

test("incomplete, malformed or cross-chat responses never partially commit", async (t) => {
  const cases={
    transport_error:()=>{throw new Error("private partial network payload");},
    incomplete:()=>({messages:[message()],pages:1,has_more:true}),
    zero_pages:()=>({messages:[message()],pages:0}),
    excess_pages:()=>({messages:[message()],pages:41}),
    malformed:()=>({messages:[message(),{}],pages:1}),
    cross_chat:()=>({messages:[message("om_wrong",{chat_id:"oc_other"})],pages:1}),
  };
  for(const [name,fetchChatMessages] of Object.entries(cases)) await t.test(name,(t)=>{
    const {db}=fixture(t);
    const result=run(db,[],{fetchChatMessages});
    assert.equal(result.ok,false);
    assert.doesNotMatch(JSON.stringify(result),/private partial network payload/);
    assertNoRepair(db);
  });
});

test("exact inclusive millisecond limits trim conservative remote overlap", (t) => {
  const {db}=fixture(t);
  const times=[START_MS-1,START_MS,END_MS,END_MS+1];
  const result=run(db,times.map((time,i)=>message(`om_edge_${i}`,{create_time:String(time)})));
  assert.equal(result.ok,true); assert.equal(result.scopes[0].inserted,2);
  assert.deepEqual(ro(db,"SELECT external_id FROM records ORDER BY external_id;").map((row)=>row.external_id),["om_edge_1","om_edge_2"]);
});

test("a failed later remote scope leaves every staged scope unwritten", (t) => {
  const chats=[CHAT,"oc_synthetic_second"];
  const {db}=fixture(t,chats);
  const before=protectedState(db);
  const fetch=(chat)=>({messages:[message(`om_${chat}`,{chat_id:chat})],pages:1});
  const first=run(db,[],{fetchChatMessages:(chat)=>{if(chat!==CHAT)throw new Error("interrupted");return fetch(chat);}},{chats});
  assert.equal(first.ok,false); assert.equal(first.scopes[0].index,2); assert.equal(first.scopes[0].ok,false);
  assertNoRepair(db);
  const second=run(db,[],{fetchChatMessages:fetch},{chats});
  assert.equal(second.ok,true); assert.equal(second.scopes[0].inserted,1); assert.equal(second.scopes[1].inserted,1);
  assert.deepEqual(protectedState(db),before);
});

test("a complete empty scope records only separate zero-count repair evidence", (t) => {
  const {db}=fixture(t);
  const before=protectedState(db);
  const result=run(db,[]);
  assert.equal(result.ok,true);
  assert.deepEqual([result.scopes[0].inserted,result.scopes[0].updated,result.scopes[0].duplicate,result.scopes[0].conflicts],[0,0,0,0]);
  const audit=ro(db,"SELECT * FROM bounded_replay_runs;");
  assert.equal(audit.length,1);
  assert.equal(audit[0].candidate_count,0); assert.equal(audit[0].fetched_count,0);
  assert.equal(audit[0].window_start_ms,START_MS); assert.equal(audit[0].window_end_ms,END_MS);
  assert.equal(audit[0].self_id_hash,createHash("sha256").update(SELF.open_id).digest("hex"));
  assert.deepEqual(protectedState(db),before);
});

test("scope and baseline changes during fetch are guarded inside the commit transaction", async (t) => {
  const cases={
    config:`UPDATE sync_scopes SET config_json='{"chat_id":"${CHAT}","changed":true}' WHERE id=${quoteSql(SCOPE)};`,
    disabled:`UPDATE sync_scopes SET enabled=0 WHERE id=${quoteSql(SCOPE)};`,
    baseline:`UPDATE sources SET config_json='{"initial_sync_start_ms":${START_MS+1}}' WHERE id='lark.im';`,
  };
  for (const [name,mutation] of Object.entries(cases)) await t.test(name,(t)=>{
    const {db}=fixture(t);
    const result=run(db,[],{fetchChatMessages:()=>{sql(db,mutation);return {messages:[message()],pages:1};}});
    assert.equal(result.ok,false); assertNoRepair(db);
  });
});

test("active sync lock prevents repair without resetting or recovering the lock", (t) => {
  const {db}=fixture(t);
  sql(db,`INSERT INTO sync_locks (scope_id,locked_by,locked_at,expires_at) VALUES (${quoteSql(SCOPE)},'synthetic_owner','2000-01-01T00:00:00Z','2000-01-01T00:01:00Z');`);
  const before=ro(db,"SELECT * FROM sync_locks;");
  assert.equal(run(db,[message()]).ok,false);
  assertNoRepair(db); assert.deepEqual(ro(db,"SELECT * FROM sync_locks;"),before);
});

test("audit insertion failure rolls back record changes and releases the repair lease", (t) => {
  const {db}=fixture(t);
  sql(db,"CREATE TRIGGER reject_repair BEFORE INSERT ON bounded_replay_runs BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");
  assert.equal(run(db,[message()]).ok,false);
  assertNoRepair(db);
});

function installCommitInterleaving(dir,db,mutation) {
  const path=join(dir,"sqlite3");
  writeFileSync(path,`#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const input=readFileSync(0,'utf8');
if(input.includes('CREATE TEMP TABLE __replay_guard')) {
  const changed=spawnSync('/usr/bin/sqlite3',[${JSON.stringify(db)}],{input:${JSON.stringify(mutation)},encoding:'utf8'});
  if(changed.status!==0)process.exit(71);
}
const out=spawnSync('/usr/bin/sqlite3',process.argv.slice(2),{input,encoding:'utf8'});
process.stdout.write(out.stdout||'');process.stderr.write(out.stderr||'');process.exit(out.status??72);
`);
  chmodSync(path,0o755);
}

test("transaction rechecks expiry and ownership, releasing only its own lease", async (t) => {
  for(const replaced of [false,true]) await t.test(replaced?"replaced":"expired",(t)=>{
    const {db,dir}=fixture(t);
    installCommitInterleaving(dir,db,replaced ? "UPDATE maintenance_locks SET owner='synthetic_successor';" : "UPDATE maintenance_locks SET expires_at='2000-01-01T00:00:00Z';");
    const priorPath=process.env.PATH;
    try {
      process.env.PATH=`${dir}:${priorPath}`;
      assert.equal(run(db,[message()]).ok,false);
    } finally {process.env.PATH=priorPath;}
    assert.equal(ro(db,"SELECT count(*) AS n FROM records;")[0].n,0);
    assert.equal(ro(db,"SELECT count(*) AS n FROM bounded_replay_runs;")[0].n,0);
    const locks=ro(db,"SELECT * FROM maintenance_locks;");
    assert.equal(locks.length,replaced?1:0);
    if(replaced)assert.equal(locks[0].owner,"synthetic_successor");
  });
});

test("CLI summaries expose conflicts and failures using nonzero status without private payloads", (t) => {
  const {db}=fixture(t);
  let stdout="",stderr="";
  const argv=["--db",db,"--scope-id",SCOPE,"--start",START,"--end",END,"--apply"];
  const code=runReplay(argv,{stdout:{write:(value)=>{stdout+=value;}},stderr:{write:(value)=>{stderr+=value;}},
    deps:{getSelfProfile:()=>SELF,fetchChatMessages:()=>{throw new Error("secret-synthetic-body");},now:()=>END_MS+1000}});
  assert.equal(code,2); assert.equal(stderr,""); assert.equal(JSON.parse(stdout).ok,false);
  assert.doesNotMatch(stdout,/secret-synthetic-body/);
  assertNoRepair(db);
});

test("exact replay validates unique IDs, one scope and local identity before requests", async (t) => {
  for (const messageIds of [[""],[" om_spaced"],["om_dup","om_dup"]]) {
    assert.throws(() => options("/synthetic",{messageIds}));
  }
  assert.throws(() => options("/synthetic",{messageIds:Array.from({length:101},(_,i)=>`om_${i}`)}),/at most 100/);
  assert.throws(() => options("/synthetic",{messageIds:["om_target"],chats:[CHAT,"oc_another"]}),/one scope/);
  const cases = {
    absent: "DELETE FROM records;",
    wrong_chat: "UPDATE records SET container_id='oc_not_selected';",
    wrong_type: "UPDATE records SET record_type='synthetic.other';",
    wrong_source: "INSERT INTO sources(id,kind,display_name) VALUES('synthetic.other','synthetic','Synthetic'); UPDATE records SET source_id='synthetic.other';",
    before_window: `UPDATE records SET occurred_at_ms=${START_MS-1};`,
    after_window: `UPDATE records SET occurred_at_ms=${END_MS+1};`,
    unknown_version: "UPDATE records SET external_version=NULL;",
    opaque_version: "UPDATE records SET external_version='opaque';",
  };
  for (const [name,mutation] of Object.entries(cases)) await t.test(name,(t)=>{
    const {db}=fixture(t);
    seedRecords(db,records([message("om_target")]));
    sql(db,mutation);
    const before=ro(db,"SELECT * FROM records;");
    assert.throws(()=>run(db,[],{getSelfProfile:()=>assert.fail("no API before target validation")},{messageIds:["om_target"]}),/exact replay requires/);
    assert.deepEqual(ro(db,"SELECT * FROM records;"),before);
    assert.equal(ro(db,"SELECT count(*) AS n FROM bounded_replay_runs;")[0].n,0);
  });
});

test("exact replay updates only selected existing messages and binds sorted IDs into the plan", (t) => {
  const {db}=fixture(t);
  const ids=["om_selected_a","om_selected_b","om_unselected"];
  seedRecords(db,records(ids.map((id)=>message(id))));
  const before=ro(db,"SELECT * FROM records ORDER BY id;");
  const incoming=ids.concat("om_new_unselected").map((id)=>message(id,{update_time:String(START_MS+9000)}));
  const first=run(db,incoming,{}, {messageIds:ids.slice(0,2),apply:false});
  const reverse=run(db,incoming,{}, {messageIds:ids.slice(0,2).reverse(),apply:false});
  const subset=run(db,incoming,{}, {messageIds:[ids[0]],apply:false});
  assert.equal(first.plan_id,reverse.plan_id); assert.notEqual(first.plan_id,subset.plan_id);
  assert.equal(first.scopes[0].candidates,2); assert.equal(first.scopes[0].fetched,4);
  assert.deepEqual(ro(db,"SELECT * FROM records ORDER BY id;"),before);
  const applied=run(db,incoming,{}, {messageIds:ids.slice(0,2)});
  assert.equal(applied.ok,true); assert.equal(applied.scopes[0].inserted,0); assert.equal(applied.scopes[0].updated,2);
  const after=ro(db,"SELECT * FROM records ORDER BY id;");
  assert.equal(after.length,3); assert.deepEqual(after[2],before[2]);
  assert.equal(ro(db,"SELECT candidate_count,fetched_count FROM bounded_replay_runs;")[0].candidate_count,2);
});

test("exact replay never hides missing, repeated, changed or malformed remote facts behind selection", async (t) => {
  const target=message("om_target");
  const cases={
    missing:[message("om_not_target")],
    identical_duplicate:[target,target],
    newer_duplicate:[target,message("om_target",{update_time:String(START_MS+8000)})],
    duplicate_outside_overlap:[target,message("om_target",{create_time:String(END_MS+1)})],
    moved_creation:[message("om_target",{create_time:String(START_MS+2000)})],
    moved_outside:[message("om_target",{create_time:String(END_MS+1)})],
    malformed_unselected:[target,{}],
    cross_chat_unselected:[target,message("om_other_chat",{chat_id:"oc_other"})],
  };
  for (const [name,messages] of Object.entries(cases)) await t.test(name,(t)=>{
    const {db}=fixture(t); seedRecords(db,records([target]));
    const before=ro(db,"SELECT * FROM records;");
    const result=run(db,messages,{}, {messageIds:["om_target"]});
    assert.equal(result.ok,false); assert.deepEqual(ro(db,"SELECT * FROM records;"),before);
    assert.equal(ro(db,"SELECT count(*) AS n FROM bounded_replay_runs;")[0].n,0);
  });
});

test("exact replay transaction fence rejects deletion, version and same-version identity changes", async (t) => {
  for (const kind of ["deleted","updated","same_version_chat","same_version_time"]) await t.test(kind,(t)=>{
    const {db,dir}=fixture(t); seedRecords(db,records([message("om_target")]));
    const changed=records([message("om_target")])[0];
    if(kind==="same_version_chat") changed.container_id="oc_concurrent_move";
    if(kind==="same_version_time") changed.occurred_at_ms=END_MS+1000;
    const mutation=kind==="deleted" ? "DELETE FROM records WHERE external_id='om_target';" : kind==="updated"
      ? `UPDATE records SET external_version='${START_MS+7000}' WHERE external_id='om_target';`
      : `UPDATE records SET container_id=${quoteSql(changed.container_id)},occurred_at_ms=${changed.occurred_at_ms} WHERE external_id='om_target';`;
    installCommitInterleaving(dir,db,mutation);
    const priorPath=process.env.PATH;
    let result;
    try {
      process.env.PATH=`${dir}:${priorPath}`;
      result=run(db,[message("om_target",{update_time:String(START_MS+9000)})],{}, {messageIds:["om_target"]});
    } finally {process.env.PATH=priorPath;}
    assert.equal(result.ok,false);
    const rows=ro(db,"SELECT external_version,container_id,occurred_at_ms FROM records;");
    if(kind==="deleted") assert.equal(rows.length,0);
    else if(kind==="updated") assert.equal(rows[0].external_version,String(START_MS+7000));
    else {
      assert.equal(rows[0].external_version,String(START_MS+1000));
      assert.equal(rows[0].container_id,changed.container_id);
      assert.equal(rows[0].occurred_at_ms,changed.occurred_at_ms);
    }
    assert.equal(ro(db,"SELECT count(*) AS n FROM bounded_replay_runs;")[0].n,0);
    assert.equal(ro(db,"SELECT count(*) AS n FROM maintenance_locks;")[0].n,0);
  });
});

test("a local later-scope commit failure retains only earlier atomic audited commits", (t) => {
  const chats=[CHAT,"oc_local_failure"];
  const {db}=fixture(t,chats);
  sql(db,`CREATE TRIGGER reject_second_audit BEFORE INSERT ON bounded_replay_runs
    WHEN NEW.scope_id=${quoteSql(chatScopeId(chats[1]))} BEGIN SELECT RAISE(ABORT,'synthetic second audit failure'); END;`);
  const result=run(db,[],{fetchChatMessages:(chat)=>({messages:[message(`om_${chat}`,{chat_id:chat})],pages:1})},{chats});
  assert.equal(result.ok,false); assert.equal(result.scopes[0].inserted,1); assert.equal(result.scopes[1].ok,false);
  assert.deepEqual(ro(db,"SELECT scope_id FROM bounded_replay_runs;").map((row)=>row.scope_id),[SCOPE]);
  assert.deepEqual(ro(db,"SELECT container_id FROM records;").map((row)=>row.container_id),[CHAT]);
});

function replayTransportFixture(respond) {
  let elapsed=0, attempts=0, releases=0;
  const deps={ now:()=>END_MS+1000+elapsed, monotonicClock:()=>elapsed,
    sleep(ms){elapsed+=ms;}, readSharedCooldown:()=>({state:"ready"}), writeSharedCooldown:()=>true,
    tryAcquireLease:()=>({state:"acquired",release(){releases++;}}),
    spawnSync(command,args){
      attempts++;
      const result=respond(args,attempts);
      return {status:0,stdout:JSON.stringify(result),stderr:"",pid:100+attempts,signal:null,output:[]};
    },
  };
  return { createRequestSession:(options)=>createMaintenanceRequestSession(options,deps),
    attempts:()=>attempts,releases:()=>releases,advance:(ms)=>{elapsed+=ms;} };
}
const nativeList=(items,hasMore=false)=>({code:0,data:{items,has_more:hasMore,page_token:hasMore?"synthetic_next_page":""}});

test("exact replay shares self/list actual-attempt budget and permits exactly the cap", (t) => {
  const {db}=fixture(t); seedRecords(db,records([message("om_target")]));
  const remote=message("om_target",{update_time:String(START_MS+9000)}).raw_api;
  const transport=replayTransportFixture((args)=>args[0]==="contact"?SELF:nativeList([remote,message("om_unselected").raw_api]));
  const result=executeLarkImReplay(options(db,{messageIds:["om_target"],maxCliAttempts:2}),
    {createRequestSession:transport.createRequestSession,now:()=>END_MS+1000});
  assert.equal(result.ok,true); assert.equal(result.scopes[0].updated,1);
  assert.equal(result.request_budget.cli_attempts,2); assert.equal(result.request_budget.stop_reason,null);
  assert.equal(transport.attempts(),2); assert.equal(transport.releases(),2);
  assert.equal(ro(db,"SELECT count(*) AS n FROM records;")[0].n,1);
});

test("self, pagination and merge details cannot bypass the exact replay attempt cap", async (t) => {
  for (const kind of ["self_only","pagination","merge_detail"]) await t.test(kind,(t)=>{
    const {db}=fixture(t); seedRecords(db,records([message("om_target")]));
    const before=ro(db,"SELECT * FROM records;");
    const remote=message("om_target",{update_time:String(START_MS+9000)}).raw_api;
    const merge={...message("om_extra_merge").raw_api,msg_type:"merge_forward",body:{content:"{}"}};
    const transport=replayTransportFixture((args)=>args[0]==="contact"?SELF:
      nativeList(kind==="merge_detail"?[remote,merge]:[remote],kind==="pagination"));
    const limit=kind==="self_only"?1:2;
    const result=executeLarkImReplay(options(db,{messageIds:["om_target"],maxCliAttempts:limit}),
      {createRequestSession:transport.createRequestSession,now:()=>END_MS+1000});
    assert.equal(result.ok,false); assert.equal(result.request_budget.stop_reason,"cli_budget");
    assert.equal(transport.attempts(),limit); assert.equal(result.request_budget.cli_attempts,limit);
    assert.deepEqual(ro(db,"SELECT * FROM records;"),before);
    assert.equal(ro(db,"SELECT count(*) AS n FROM bounded_replay_runs;")[0].n,0);
  });
});

test("a shared request budget exhausted in a later scope cannot commit an earlier staged scope", (t) => {
  const chats=[CHAT,"oc_budget_second"];
  const {db}=fixture(t,chats);
  const transport=replayTransportFixture((args)=>args[0]==="contact"?SELF:nativeList([message("om_first_scope").raw_api]));
  const result=executeLarkImReplay(options(db,{chats,maxCliAttempts:2}),
    {createRequestSession:transport.createRequestSession,now:()=>END_MS+1000});
  assert.equal(result.ok,false); assert.equal(result.request_budget.stop_reason,"cli_budget");
  assert.equal(transport.attempts(),2); assertNoRepair(db);
});

test("local commit work after remote completion retains receipts beyond the remote deadline", (t) => {
  const chats=[CHAT,"oc_commit_second"];
  const {db}=fixture(t,chats);
  const transport=replayTransportFixture((args)=>{
    if(args[0]==="contact") return SELF;
    const cid=JSON.parse(args[args.indexOf("--params")+1]).container_id;
    return nativeList([message(`om_${cid}`,{chat_id:cid}).raw_api]);
  });
  let commits=0;
  const result=executeLarkImReplay(options(db,{chats,maxCliAttempts:3,maxSeconds:5}),{
    createRequestSession:transport.createRequestSession,now:()=>END_MS+1000,
    commitBoundedReplayRecords(){commits++; transport.advance(6000); return {audit_id:`synthetic_${commits}`,inserted:1,updated:0,duplicate:0,conflicts:0};},
  });
  assert.equal(result.ok,true); assert.equal(commits,2); assert.equal(result.scopes.length,2);
  assert.equal(result.request_budget.stop_reason,null); assert.equal(result.request_budget.cli_attempts,3);
});

test("actual adapter pagination rejects a repeated exact target even with enough attempt budget", (t) => {
  const {db}=fixture(t); seedRecords(db,records([message("om_target")]));
  const before=ro(db,"SELECT * FROM records;");
  const incoming=message("om_target",{update_time:String(START_MS+9000)}).raw_api;
  const transport=replayTransportFixture((args,attempt)=>args[0]==="contact"?SELF:nativeList([incoming],attempt===2));
  const result=executeLarkImReplay(options(db,{messageIds:["om_target"],maxCliAttempts:3}),
    {createRequestSession:transport.createRequestSession,now:()=>END_MS+1000});
  assert.equal(result.ok,false); assert.equal(transport.attempts(),3);
  assert.equal(result.request_budget.stop_reason,null);
  assert.match(result.scopes[0].error,/repeated/);
  assert.deepEqual(ro(db,"SELECT * FROM records;"),before);
  assert.equal(ro(db,"SELECT count(*) AS n FROM bounded_replay_runs;")[0].n,0);
});

test("a changed second exact target blocks every selected record in the same transaction", (t) => {
  const {db,dir}=fixture(t);
  const ids=["om_target_first","om_target_second"];
  seedRecords(db,records(ids.map((id)=>message(id))));
  const firstBefore=ro(db,"SELECT * FROM records WHERE external_id='om_target_first';")[0];
  const moved=records([message(ids[1])])[0]; moved.container_id="oc_concurrent_move";
  installCommitInterleaving(dir,db,`UPDATE records SET container_id=${quoteSql(moved.container_id)} WHERE external_id=${quoteSql(moved.external_id)};`);
  const priorPath=process.env.PATH;
  let result;
  try {
    process.env.PATH=`${dir}:${priorPath}`;
    result=run(db,ids.map((id)=>message(id,{update_time:String(START_MS+9000)})),{}, {messageIds:ids});
  } finally {process.env.PATH=priorPath;}
  assert.equal(result.ok,false);
  assert.deepEqual(ro(db,"SELECT * FROM records WHERE external_id='om_target_first';")[0],firstBefore);
  assert.equal(ro(db,"SELECT container_id FROM records WHERE external_id='om_target_second';")[0].container_id,moved.container_id);
  assert.equal(ro(db,"SELECT count(*) AS n FROM bounded_replay_runs;")[0].n,0);
});
