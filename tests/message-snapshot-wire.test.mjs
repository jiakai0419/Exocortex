import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {readMessageSnapshot} from '../src/diagnostics/message-read-snapshot.mjs';
import {readOnlySqliteJson,readOnlySqliteJsonLines} from '../src/storage/sqlite/readonly-query.mjs';

// All names, IDs, raw tokens and bytes are authored. Hex is used only to seed
// SQLite TEXT containing NUL without interpreting it as a SQL/CLI command.
const text=value=>value===null?'NULL':`CAST(X'${Buffer.from(String(value)).toString('hex')}' AS TEXT)`;
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'exocortex-synthetic-snapshot-wire-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=join(dir,'authored.sqlite');
  const raw=' {"integer":9007199254740993,"fraction":1.0000,"dup":1,"dup":2,"escape":"\\u0041"} \n';
  const wide=JSON.stringify({authored:'Synthetic wide source',items:Array.from({length:800},()=>({text:'Synthetic "quoted" \\path\nline\t汉字😀'}))});
  const values=[
    {body:'  Synthetic "quote" \\path\n\t\r\0汉字😀\u2028e\u0301  ',raw,canonical:' {"msg_type":"text","n":9007199254740997} '},
    {body:'[1,{"synthetic":true}]',raw:'not JSON\0synthetic\u2029',canonical:'not canonical JSON'},
    {body:null,raw:null,canonical:null},
    {body:'Synthetic wide body',raw:wide,canonical:'{"msg_type":"text"}'},
    {body:'__EXOCORTEX_JSON_LINES_BEGIN_V1__\n__EXOCORTEX_JSON_LINES_END_V1__\n.print injected\nSELECT 9;',raw:'{"authored":"sentinel text"}',canonical:'{}'},
  ];
  const config=' {"chat_id":"oc_synthetic_wire","n":9007199254740999,"duplicate":1,"duplicate":2} ';
  const input=`.bail on
CREATE TABLE records(id INTEGER PRIMARY KEY,source_id TEXT,record_type TEXT,direction TEXT,occurred_at TEXT,occurred_at_ms INTEGER,actor_id TEXT,container_id TEXT,external_id TEXT,external_version TEXT,content_hash TEXT,body TEXT,canonical_json TEXT,raw_json TEXT,first_seen_scope_id TEXT);
CREATE TABLE sync_scopes(id TEXT PRIMARY KEY,source_id TEXT,config_json TEXT);
INSERT INTO sync_scopes VALUES('synthetic-scope','lark.im',${text(config)});
${values.map((row,index)=>`INSERT INTO records VALUES(${index+1},'lark.im','lark.im.message','received','2026-01-02T03:04:05.000Z',${1000+index},'ou_synthetic_wire','oc_synthetic_wire','om_synthetic_wire_${index+1}','synthetic-version','synthetic-hash',${text(row.body)},${text(row.canonical)},${text(row.raw)},'synthetic-scope');`).join('\n')}
`;
  const seed=spawnSync('sqlite3',['-batch','-init','/dev/null',db],{input,encoding:'utf8',timeout:10000});
  assert.equal(seed.status,0,seed.stderr);assert.equal(seed.error,undefined);
  return {db,values,config};
}

test('actual snapshot framed wire preserves opaque source TEXT, Unicode/NUL, null, ordering and empty-page metadata',t=>{
  const {db,values,config}=setup(t),before=hash(db);
  const snapshot=readMessageSnapshot(db,{limit:100});
  assert.deepEqual(snapshot.population,{total:5,evaluated:5,not_evaluated:0});
  assert.deepEqual(snapshot.rows.map(row=>row.id),[5,4,3,2,1]);
  assert.equal(snapshot.as_of.source_max_record_id,5);
  assert.match(snapshot.as_of.read_at,/^\d{4}-\d\d-\d\dT/);
  for(const row of snapshot.rows){
    const expected=values[row.id-1];
    for(const [column,key] of [['body','body'],['raw_json','raw'],['canonical_json','canonical']]){
      assert.equal(row[column],expected[key]);
      if(expected[key]!==null)assert.deepEqual(Buffer.from(row[column]),Buffer.from(expected[key]));
    }
    assert.equal(row.scope_config_json,config);
  }
  assert.equal(snapshot.scopes.length,1);assert.equal(snapshot.scopes[0].config_json,config);
  const empty=readMessageSnapshot(db,{recordIds:[]});
  assert.deepEqual(empty.population,{total:0,evaluated:0,not_evaluated:0});
  assert.equal(empty.as_of.source_max_record_id,5);assert.deepEqual(empty.rows,[]);
  assert.equal(hash(db),before,'both reads preserve exact DB bytes');
});

test('same frozen actual snapshot SQL rows match old JSON and new framed encoding in every field including read_at',t=>{
  const {db}=setup(t);let sql;
  const oldSnapshot=readMessageSnapshot(db,{limit:100},{sqliteJson(path,query,label){
    if(label==='read message snapshot')sql=query;
    return readOnlySqliteJson(path,query,label,{timeoutMs:10000});
  }});
  assert.equal(oldSnapshot.rows.length,5);assert.match(sql,/^WITH/);
  // Freeze exactly one actual source SELECT once in this authored test database.
  // Both encoders then see identical rows, including the same read_at. This is
  // test setup, not a product temp table or a second production data snapshot.
  const freeze=spawnSync('sqlite3',['-batch','-init','/dev/null',db],{input:`.bail on\nCREATE TABLE synthetic_frozen_snapshot AS ${sql}`,encoding:'utf8',timeout:10000});
  assert.equal(freeze.status,0,freeze.stderr);assert.equal(freeze.error,undefined);
  const before=hash(db),columns=['kind','position','payload','total','evaluated','not_evaluated','source_max_record_id','read_at','schema_consistent'];
  const frozen='SELECT * FROM synthetic_frozen_snapshot ORDER BY kind,position;';
  const encoded=`SELECT json_object(${columns.flatMap(key=>[`'${key}'`,key==='payload'?"payload || ''":key]).join(',')}) FROM synthetic_frozen_snapshot ORDER BY kind,position;`;
  const prior=readOnlySqliteJson(db,frozen,'read message snapshot',{timeoutMs:10000});
  const next=readOnlySqliteJsonLines(db,encoded,'read message snapshot',{timeoutMs:10000});
  assert.deepEqual(next,prior,'no metadata timestamp or other field is excluded');
  assert.equal(next.find(row=>row.kind==='metadata').payload,null);
  assert(next.filter(row=>row.kind!=='metadata').every(row=>typeof row.payload==='string'));
  assert.equal(hash(db),before,'both wire encoders are read-only');
});
