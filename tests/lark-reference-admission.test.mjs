import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import { prepareObservationRecords } from '../dist/storage/sqlite/observation-store.js';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';

// Invented data, a fresh SQLite database per test, and no transport boundary.
const START=Date.parse('2026-01-01T00:00:00Z'),CHAT='oc_reference_admission',SCOPE=chatScopeId(CHAT);
const clone=value=>JSON.parse(JSON.stringify(value));
const row=raw=>recordFromMessage(normalizeApiMessage(raw),SCOPE,'received');
function card(field,label) {
  return {message_id:'om_reference_admission',chat_id:CHAT,msg_type:'interactive',
    create_time:String(START+1000),update_time:String(START+2000),
    sender:{id:'ou_invented_reference_author',id_type:'open_id',sender_type:'user'},
    mentions:[{key:'@_user_1',id:'typed-alice',id_type:'user_id',name:'Invented Alice'}],
    body:{content:JSON.stringify({
      json_card:JSON.stringify({elements:[{tag:'at',property:{[field]:label}}]}),
      json_attachment:{at_users:{bridge:{mention_key:'@_user_1',user_id:'native-alias',content:'Invented Alice'}}},
    })}};
}
function fixture(t,raw) {
  const dir=mkdtempSync(join(tmpdir(),'invented-reference-admission-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=join(dir,'synthetic.sqlite');store.ensureInitialized(db);
  store.sqliteExec(db,`INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${store.quoteSql(SCOPE)},'lark.im','Invented reference scope',
    ${store.quoteSql(JSON.stringify({chat_id:CHAT,chat_type:'group'}))});`);
  store.sqliteExec(db,store.upsertRecordsSql([row(raw)]));
  return db;
}
const current=db=>store.sqliteQuery(db,'SELECT * FROM records;')[0];
function normal(db,record) {
  const scope=store.readScope(db,SCOPE),run=store.createRun(db,scope);
  return store.succeedRecordRun(db,scope,run,[record],1,{created_at_ms:START+4000},{});
}

for(const [field,before,after] of [
  ['user_id','typed-alice','bridge'],
  ['user_id','typed-alice','@_user_1'],
  ['userID','bridge','typed-alice'],
  ['userID','bridge','@_user_1'],
])test(`normal and replay admission retain raw/body consistency on unresolved ${field}:${after}`,t=>{
  const a=card(field,before),b=card(field,after),incoming=row(b),db=fixture(t,a),old=current(db);
  assert.equal(old.body,'@Invented Alice');assert.equal(incoming.body,'@未知用户');
  assert.equal(prepareObservationRecords(db,[incoming])[0].observation.action,'conflict');
  const projected=store.sqliteQuery(db,store.boundedReplayProjectionSql([incoming],{dbPath:db}))[0];
  assert.equal(projected.outcome,'conflict');
  const result=normal(db,incoming);
  assert.equal(result.updated,0);assert.equal(result.conflicts,1);assert.deepEqual(current(db),old);
  assert.equal(row(JSON.parse(current(db).raw_json)).body,current(db).body);
  const evidence=store.sqliteQuery(db,'SELECT candidate_json FROM record_observation_state;')[0];
  assert.equal(JSON.parse(evidence.candidate_json).raw_json,incoming.raw_json);
});

test('a valid coordinated rename refreshes projection while retained raw reproduces the saved body',t=>{
  const a=card('userID','bridge'),b=clone(a),db=fixture(t,a),old=current(db);
  b.mentions[0].key='@_user_42';
  const content=JSON.parse(b.body.content);content.json_attachment.at_users.bridge.mention_key='@_user_42';
  b.body.content=JSON.stringify(content);
  // Make a real, reparable derived projection difference; source stays intact.
  store.sqliteExec(db,"UPDATE records SET body='Invented obsolete projection';");
  const incoming=row(b);assert.equal(prepareObservationRecords(db,[incoming])[0].observation.action,'equivalent');
  const result=normal(db,incoming),saved=current(db);
  assert.equal(result.updated,1);assert.equal(result.conflicts,undefined);
  assert.equal(saved.raw_json,old.raw_json);assert.equal(saved.content_hash,old.content_hash);
  assert.equal(saved.body,incoming.body);assert.equal(row(JSON.parse(saved.raw_json)).body,saved.body);
});
