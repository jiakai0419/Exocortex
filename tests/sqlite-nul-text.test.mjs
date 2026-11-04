import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {ensureInitialized,quoteSql as q,sqliteExec,sqliteQuery,upsertRecordsSql,
  createRun,readScope,succeedRecordRun} from '../dist/storage/sqlite/ingestion-store.js';
import {normalizeApiMessage} from '../src/adapters/lark-im/raw-message.mjs';
import {recordFromMessage,SENT_SCOPE_ID} from '../src/adapters/lark-im/core.mjs';
import {executeResourceWork} from '../src/maintenance/resource-work.mjs';
import {prepareObservationRecords} from '../dist/storage/sqlite/observation-store.js';

// Authored data only: exercise the production SQL encoder, transaction writers,
// renderer, resource enrollment and actual read-only messages command.
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const AT=Date.UTC(2025,6,7,8,9,10);
const bytes=value=>Buffer.from(value,'utf8').toString('hex').toUpperCase();
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'synthetic-nul-text-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const db=join(root,'messages.sqlite');ensureInitialized(db);return {root,db};
}
function record(id,text,{version=AT+id,type='post'}={}) {
  const raw={message_id:`om_synthetic_nul_${id}`,chat_id:'oc_synthetic_nul_room',chat_type:'group',
    chat_name:'Synthetic NUL Room',msg_type:type,create_time:String(AT+id),update_time:String(version),
    sender:{id:'ou_synthetic_nul_author',id_type:'open_id',sender_type:'user',name:'Synthetic NUL Author'},
    body:{content:JSON.stringify(type==='text'?{text}:{title:'Synthetic post',content:[[{tag:'text',text},
      {tag:'img',image_key:`synthetic_nul_image_${id}`}]]})}};
  return recordFromMessage(normalizeApiMessage(raw),SENT_SCOPE_ID,'sent');
}
const inspect=db=>sqliteQuery(db,'SELECT external_id,hex(body) body_hex,hex(title) title_hex,raw_json,canonical_json,external_version FROM records ORDER BY id;');

test('SQL TEXT literals retain exact NUL bytes and cannot terminate the SQL program',t=>{
  const {db}=fixture(t);
  const values=['\0','\0start','end\0','a\0b\0c','雪\0🌱',"quote'\0); DROP TABLE records; --",
    'line\n\0after\r\n',String.raw`literal\u0000`+'\0actual'];
  sqliteExec(db,'CREATE TABLE synthetic_text(id INTEGER PRIMARY KEY,value TEXT);');
  for(const [i,value] of values.entries()) {
    const expression=q(value);assert(!expression.includes('\0'));
    assert.match(expression,/^CAST\(X'[a-f0-9]+' AS TEXT\)$/);
    sqliteExec(db,`INSERT INTO synthetic_text VALUES(${i},${expression});`);
    const row=sqliteQuery(db,`SELECT typeof(value) kind,hex(value) bytes,value IS ${expression} exact,
      value IS ${q(value+'different')} prefix_only FROM synthetic_text WHERE id=${i};`)[0];
    assert.deepEqual(row,{kind:'text',bytes:bytes(value),exact:1,prefix_only:0});
  }
  assert.equal(sqliteQuery(db,'SELECT count(*) n FROM records;')[0].n,0);
});

test('ordinary SQL and NULL encoding stay byte-for-byte unchanged',()=>{
  for(const value of ['',"O'Brien",'雪🌱','a\nb','literal\\u0000',0,23,false,true])
    assert.equal(q(value),`'${String(value).replaceAll("'","''")}'`);
  assert.equal(q(null),'NULL');assert.equal(q(undefined),'NULL');
});

test('ordinary upsert and fenced sync commit preserve NUL bodies and titles, including updates and rollback',t=>{
  const {db}=fixture(t),first={...record(1,'Synthetic before\0first tail'),title:'Synthetic title\0tail'};
  const neighbor=record(2,'Synthetic unaffected neighbor');
  sqliteExec(db,`BEGIN IMMEDIATE;${upsertRecordsSql([first,neighbor])}COMMIT;`);
  assert.equal(inspect(db)[0].body_hex,bytes(first.body));assert.equal(inspect(db)[0].title_hex,bytes(first.title));
  const scope=readScope(db,SENT_SCOPE_ID),run=createRun(db,scope);
  const changed={...record(1,'Synthetic before\0second tail',{version:AT+20}),title:'Synthetic title\0second'};
  const effects=succeedRecordRun(db,scope,run,[changed],1,{created_at_ms:AT+20},{});
  assert.equal(effects.updated,1);assert.equal(inspect(db)[0].body_hex,bytes(changed.body));
  assert.equal(inspect(db)[0].title_hex,bytes(changed.title));
  assert.equal(inspect(db)[1].body_hex,bytes(neighbor.body));
  const equivalent=prepareObservationRecords(db,[changed]);
  assert.equal(equivalent[0].observation.action,'equivalent');
  assert.equal(equivalent[0].observation.before.body,changed.body);
  assert.equal(equivalent[0].observation.before.title,changed.title);
  sqliteExec(db,`BEGIN;${upsertRecordsSql(equivalent)}COMMIT;`);
  const before=inspect(db);
  assert.throws(()=>sqliteExec(db,`BEGIN IMMEDIATE;${upsertRecordsSql([
    record(1,'Synthetic rolled back\0tail',{version:AT+30}),record(3,'Synthetic rollback neighbor')
  ])}SELECT * FROM synthetic_missing_table;COMMIT;`),/synthetic_missing_table/);
  assert.deepEqual(inspect(db),before,'a failed transaction cannot expose a NUL record or its neighboring insert');
  const prepared=prepareObservationRecords(db,[record(1,'Synthetic next\0tail',{version:AT+40})]);
  const winner=changed.body.replace('second tail','competing suffix');
  sqliteExec(db,`UPDATE records SET body=${q(winner)} WHERE external_id=${q(changed.external_id)};`);
  const raced=inspect(db);
  assert.throws(()=>sqliteExec(db,`BEGIN;${upsertRecordsSql(prepared)}COMMIT;`),/CHECK constraint/);
  assert.deepEqual(inspect(db),raced,'a suffix-only competing source invalidates the full predecessor CAS');
});

test('normal message ingestion enrolls NUL post and actual messages JSON/text retains every neighbor and suffix',t=>{
  const f=fixture(t),records=[record(1,'Synthetic older neighbor',{type:'text'}),record(2,'Synthetic before\0RESOURCE_NUL_TAIL'),
    record(3,'Synthetic visible\0UNIQUE_NUL_TAIL',{type:'text'}),record(4,'Synthetic newer neighbor',{type:'text'})];
  assert(records[1].body.includes('\0'));
  const scope=readScope(f.db,SENT_SCOPE_ID),run=createRun(f.db,scope);
  const effects=succeedRecordRun(f.db,scope,run,records,4,{created_at_ms:AT+4},{});
  assert.equal(effects.inserted,4);
  assert.deepEqual(inspect(f.db).map(row=>row.body_hex),records.map(row=>bytes(row.body)));
  let requests=0;
  const result=executeResourceWork({db:f.db,resourceDir:join(f.root,'resources'),maxCliAttempts:3,maxSelfAttempts:2,maxSeconds:30},
    {now:()=>AT+100000,monotonicClock:()=>1,tryAcquireLease:()=>({state:'acquired',release(){}}),
      requestSessionDeps:{spawnSync(){requests++;throw Error('forbidden synthetic external request');}}});
  assert.equal(result.ok,true);assert.equal(requests,0);
  assert.deepEqual(sqliteQuery(f.db,'SELECT record_id,state,attempts,failures FROM lark_im_resource_work ORDER BY record_id;'),
    [{record_id:2,state:'blocked',attempts:0,failures:0}]);
  sqliteExec(f.db,'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  const before=hash(readFileSync(f.db)),marker=join(f.root,'unexpected-network'),guard=join(f.root,'guard.mjs'),cli=join(f.root,'deny-cli');
  writeFileSync(guard,`import {Socket} from 'node:net';import {writeFileSync} from 'node:fs';
const deny=()=>{writeFileSync(process.env.SYNTHETIC_MARKER,'called');throw Error('network forbidden');};
globalThis.fetch=deny;Socket.prototype.connect=deny;Object.defineProperty(process.stdout,'columns',{value:180});`);
  writeFileSync(cli,'#!/bin/sh\nprintf called > "$SYNTHETIC_MARKER"\nexit 97\n',{mode:0o700});
  const outputs={};
  for(const format of ['json','text']) {
    const output=spawnSync(process.execPath,['--import',guard,join(ROOT,'bin/exocortex.mjs'),'messages','--db',f.db,
      '--limit','4','--direction','all','--format',format],{cwd:f.root,encoding:'utf8',timeout:20000,maxBuffer:4*1024*1024,
      env:{...process.env,TZ:'UTC',NO_COLOR:'1',LARK_CLI:cli,SYNTHETIC_MARKER:marker}});
    assert.equal(output.status,0,output.stderr||output.stdout);assert.equal(output.stderr,'');outputs[format]=output.stdout;
  }
  const projected=JSON.parse(outputs.json),ordered=[...records].reverse();
  assert.equal(projected.length,4);assert.equal(existsSync(marker),false);assert.equal(hash(readFileSync(f.db)),before);
  for(const [i,row] of projected.entries()) {
    for(const key of ['external_id','body','raw_json','canonical_json','occurred_at','actor_id','container_id','direction'])
      assert.equal(row[key],ordered[i][key],key);
    assert.equal(row.readiness.state,row.id===2?'blocked':'ready',
      'NUL does not change message completeness; unverified embedded endpoint remains blocked');
  }
  assert(outputs.json.includes('\\u0000'));assert(outputs.text.includes('UNIQUE_NUL_TAIL'));
  assert(outputs.text.indexOf('Synthetic newer neighbor')<outputs.text.indexOf('UNIQUE_NUL_TAIL'));
  assert(outputs.text.indexOf('UNIQUE_NUL_TAIL')<outputs.text.indexOf('Synthetic older neighbor'));
});
