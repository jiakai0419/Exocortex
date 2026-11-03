import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {readMessageSnapshot} from '../src/diagnostics/message-read-snapshot.mjs';
import {executeMessages} from '../src/cli/messages-command.mjs';
import {loadMessages,readMessagesMetadata} from '../src/diagnostics/messages-report.mjs';
import {readOnlySqliteJson} from '../src/storage/sqlite/readonly-query.mjs';

// Authored source text only. Hex preserves NUL/Unicode and opaque JSON tokens.
const text=value=>value===null?'NULL':`CAST(X'${Buffer.from(String(value)).toString('hex')}' AS TEXT)`;
const checksum=db=>createHash('sha256').update(readFileSync(db)).digest('hex');
function fixture(t,{wide=false}={}){
  const dir=mkdtempSync(join(tmpdir(),'exo-authored-budget-wire-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=join(dir,'authored.sqlite');
  const values=wide?[{body:'Invented wide body',canonical:'{"msg_type":"text"}',raw:JSON.stringify({msg_type:'text',
    body:{content:'{"text":"Invented wide body"}'},padding:'Invented "nested" \\escaped\n'.repeat(22000)})}]:[
    {body:'Invented "quote" \\path\n\0汉字😀',canonical:' {"fraction":1.0000,"duplicate":1,"duplicate":2} ',
      raw:' {"integer":9007199254740993,"escaped":"\\u0041"} \n'},
    {body:null,canonical:null,raw:'not JSON\0authored'},
    {body:'__EXOCORTEX_JSON_LINES_BEGIN_V1__\n__EXOCORTEX_JSON_LINES_END_V1__\n.print authored',canonical:'{}',raw:'{}'},
  ];
  const input=`.bail on
CREATE TABLE records(id INTEGER PRIMARY KEY,source_id TEXT,record_type TEXT,direction TEXT,occurred_at TEXT,occurred_at_ms INTEGER,actor_id TEXT,container_id TEXT,external_id TEXT,external_version TEXT,content_hash TEXT,body TEXT,canonical_json TEXT,raw_json TEXT,first_seen_scope_id TEXT);
CREATE TABLE sync_scopes(id TEXT PRIMARY KEY,source_id TEXT,config_json TEXT);
${values.map((v,i)=>`INSERT INTO records VALUES(${i+1},'lark.im','lark.im.message','received','2026-01-02T03:04:05.000Z',${1000+i},'ou_invented_actor','oc_invented_group','om_invented_budget_${i+1}','authored-version','authored-hash',${text(v.body)},${text(v.canonical)},${text(v.raw)},NULL);`).join('\n')}`;
  const seeded=childProcess.spawnSync('sqlite3',['-batch','-init','/dev/null',db],{input,encoding:'utf8',timeout:10000});
  assert.equal(seeded.status,0,seeded.stderr);assert.equal(seeded.error,undefined);
  return{db,values};
}
function observeSpawn(observe,work){
  const original=childProcess.spawnSync;
  childProcess.spawnSync=(...args)=>observe(original,...args);syncBuiltinESMExports();
  try{return work();}finally{childProcess.spawnSync=original;syncBuiltinESMExports();}
}

test('fresh deadline options reach both actual subprocesses without replacing the framed snapshot wire',t=>{
  const f=fixture(t),before=checksum(f.db),timeouts=[5000,4500],calls=[];let grants=0;
  const value=observeSpawn((original,command,args,options)=>{
    assert.equal(command,'sqlite3');calls.push({args,timeout:options.timeout,input:options.input});
    return original(command,args,options);
  },()=>readMessageSnapshot(f.db,{limit:40},{sqliteReadOptions:()=>({timeoutMs:timeouts[grants++]})}));
  assert.equal(grants,2);assert.deepEqual(calls.map(c=>c.timeout),timeouts);
  assert(calls[0].args.includes('-json'));assert(!calls[1].args.includes('-json'));
  assert(calls[1].args.includes('-list'));assert.match(calls[1].input,/\.print __EXOCORTEX_JSON_LINES_BEGIN_V1__/);
  assert.equal(value.rows.length,3);assert.equal(checksum(f.db),before);
});

test('same authored source and frozen snapshot clock match in legacy, default and budgeted wire paths',t=>{
  const f=fixture(t),before=checksum(f.db);
  // Only the observation clock is frozen at the actual subprocess boundary.
  // Every source/evidence byte and every returned field is compared unchanged.
  const freeze=sql=>sql.replaceAll("strftime('%Y-%m-%dT%H:%M:%fZ','now')","'2045-01-01T00:00:00.000Z'");
  const [legacy,normal,bounded]=observeSpawn((original,command,args,options)=>original(command,args,
    {...options,input:freeze(options.input)}),()=>[
    readMessageSnapshot(f.db,{limit:40},{sqliteJson:readOnlySqliteJson}),
    readMessageSnapshot(f.db,{limit:40}),
    readMessageSnapshot(f.db,{limit:40},{sqliteReadOptions:()=>({timeoutMs:5000})}),
  ]);
  assert.deepEqual(bounded,normal);assert.deepEqual(bounded,legacy);
  for(const row of bounded.rows){const authored=f.values[row.id-1];
    for(const [column,key]of[['body','body'],['canonical_json','canonical'],['raw_json','raw']])assert.equal(row[column],authored[key]);}
  assert.equal(checksum(f.db),before);
});

test('loadMessages carries the bounded default wire through actual messages projection for a large quoted source',t=>{
  const f=fixture(t,{wide:true}),before=checksum(f.db),started=performance.now();let grants=0;
  assert(Buffer.byteLength(f.values[0].raw)>650000);assert(Buffer.byteLength(f.values[0].raw)<2*1024*1024);
  const rows=executeMessages({db:f.db,direction:'all',limit:40,search:'',recordIds:[1]},
    {loadMessages:(db,options)=>loadMessages(db,options,{sqliteReadOptions:()=>{grants++;return{timeoutMs:Math.floor(5000-(performance.now()-started))};}})});
  assert.equal(grants,2);assert.equal(rows.length,1);assert.equal(rows[0].raw_json,f.values[0].raw);
  assert.equal(rows[0].canonical_json,f.values[0].canonical);assert.equal(rows[0].body,f.values[0].body);
  assert.equal(readMessagesMetadata(rows).observation_complete,true);assert.equal(checksum(f.db),before);
});

const invalidValues=[undefined,null,{},[],{timeoutMs:0},{timeoutMs:-1},{timeoutMs:NaN},{timeoutMs:Infinity},
  {timeoutMs:-Infinity},{timeoutMs:1.5},{timeoutMs:'5'},{timeoutMs:Number.MAX_SAFE_INTEGER+1}];
for(const [index,value]of invalidValues.entries())for(const at of[0,1]){
  test(`invalid timeout ${index} before ${at?'snapshot':'schema'} never starts that subprocess or falls back to30s`,t=>{
    const f=fixture(t);let callbacks=0,spawns=0;
    observeSpawn((original,...args)=>{spawns++;return original(...args);},()=>{
      assert.throws(()=>readMessageSnapshot(f.db,{limit:40},{sqliteReadOptions:()=>callbacks++===at?value:{timeoutMs:5000}}),RangeError);
    });
    assert.equal(callbacks,at+1);assert.equal(spawns,at);
  });
}

for(const provider of [null,5,{}])test(`nonfunction read-options provider ${typeof provider} cannot start a read`,()=>{
  let calls=0;
  assert.throws(()=>readMessageSnapshot('/tmp/authored-unused.sqlite',{},{sqliteReadOptions:provider,sqliteJson:()=>{calls++;return[];}}),TypeError);
  assert.equal(calls,0);
});

for(const at of[0,1])test(`provider failure before ${at?'snapshot':'schema'} preserves the error and starts no later read`,t=>{
  const f=fixture(t),marker=new Error('authored monotonic clock unavailable');let callbacks=0,spawns=0;
  observeSpawn((original,...args)=>{spawns++;return original(...args);},()=>{
    assert.throws(()=>readMessageSnapshot(f.db,{limit:40},{sqliteReadOptions:()=>{if(callbacks++===at)throw marker;return{timeoutMs:5000};}}),e=>e===marker);
  });
  assert.equal(callbacks,at+1);assert.equal(spawns,at);
});

test('existing test reader hooks remain compatible and receive fresh validated options when supplied',t=>{
  const f=fixture(t),calls=[];let grant=5000;
  const value=readMessageSnapshot(f.db,{limit:40},{sqliteReadOptions:()=>({timeoutMs:grant-=100}),
    sqliteJson(db,sql,label,options){calls.push(options);return readOnlySqliteJson(db,sql,label,options);}});
  assert.equal(value.rows.length,3);assert.deepEqual(calls,[{timeoutMs:4900},{timeoutMs:4800}]);
  const unbudgeted=[];
  readMessageSnapshot(f.db,{limit:40},{sqliteJson(db,sql,label,options){unbudgeted.push(options);return readOnlySqliteJson(db,sql,label);}});
  assert.deepEqual(unbudgeted,[undefined,undefined]);
});
