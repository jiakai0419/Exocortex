import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {ensureInitialized,sqliteExec,sqliteQuery,quoteSql as q} from '../dist/storage/sqlite/ingestion-store.js';
import {executeResourceWork} from '../src/maintenance/resource-work.mjs';
import {MEDIA_RESOURCE_SOURCE_FIELDS as FIELDS} from '../src/adapters/lark-im/media-resource-store.mjs';
import {renderApiMessageContent} from '../src/adapters/lark-im/raw-message.mjs';
import {SENT_SCOPE_ID} from '../src/adapters/lark-im/core.mjs';

const BEGIN='__EXOCORTEX_JSON_LINES_BEGIN_V1__',END='__EXOCORTEX_JSON_LINES_END_V1__';
const AT=Date.UTC(2025,4,2),SELF='ou_synthetic_wire_owner';
const sqlValue=value=>typeof value==='string'&&value.includes('\0')?`CAST(X'${Buffer.from(value).toString('hex')}' AS TEXT)`:q(value);
const sourceRead=options=>options.input?.includes('AS encoded_row FROM records');
function observeSpawns(observer,run) {
  const original=cp.spawnSync;cp.spawnSync=(...args)=>observer(original,...args);syncBuiltinESMExports();
  try{return run();}finally{cp.spawnSync=original;syncBuiltinESMExports();}
}
function fixture(t,count=1,{long=false,nulBody=false}={}) {
  const root=mkdtempSync(join(tmpdir(),'synthetic-resource-wire-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const db=join(root,'messages.sqlite');ensureInitialized(db);const expected=[];
  const padding=(`Synthetic 雪 ' " slash\\ newline\n${BEGIN}\n${END}\n`).repeat(long?420:1);
  const inserts=[];
  for(let id=1;id<=count;id++) {
    const type=id%2?'post':'interactive',key=`synthetic_wire_${id}`,alias=`synthetic_alias_${id}`;
    const payload=type==='post'?{title:'Synthetic title',content:[[{tag:'text',text:padding},{tag:'img',image_key:key}]]}
      :{json_card:{body:{elements:[{tag:'plain_text',content:'Synthetic card'}, {tag:'img',property:{imageID:alias}}]}},
        json_attachment:{images:{[alias]:{origin_key:key}}}};
    const raw={message_id:`om_synthetic_wire_${id}`,chat_id:'oc_synthetic_wire',msg_type:type,chat_type:'group',
      create_time:String(AT+id),sender:{id:SELF,id_type:'open_id',sender_type:'user',name:'Synthetic Reader'},
      synthetic_note:'escaped NUL \0 and literal \\u0000',synthetic_padding:type==='interactive'?padding:undefined,
      body:{content:JSON.stringify(payload)}};
    const rendered=renderApiMessageContent(raw),canonical={message_id:raw.message_id,chat_id:raw.chat_id,chat_type:'group',
      msg_type:type,chat_name:'Synthetic Room',sender_id:SELF,sender_id_type:'open_id',sender_type:'user',
      sender_name:'Synthetic Reader',sender_name_source:'message_sender',content_rendering:{...rendered}};
    delete canonical.content_rendering.text;
    const raw_json=JSON.stringify(raw),row={id,source_id:'lark.im',record_type:'lark.im.message',external_id:raw.message_id,
      external_version:id%3?String(AT+id):null,content_hash:createHash('sha256').update(raw_json).digest('hex'),
      raw_json,canonical_json:JSON.stringify(canonical),actor_id:SELF,container_id:raw.chat_id,direction:'sent',
      occurred_at:new Date(AT+id).toISOString(),occurred_at_ms:AT+id,body:nulBody?'Synthetic before\0after\n'+END:rendered.text};
    const source=Object.fromEntries(FIELDS.map(field=>[field,row[field]]));
    const bytes=Object.values(source).reduce((n,value)=>n+(value===null?0:Buffer.byteLength(String(value))),0);
    assert(bytes<=128*1024);if(long)assert(bytes>30*1024);
    expected.push(source);
    const stored={...row,first_seen_scope_id:SENT_SCOPE_ID};
    inserts.push(`INSERT INTO records(${Object.keys(stored)}) VALUES(${Object.values(stored).map(sqlValue)});`);
  }
  sqliteExec(db,`BEGIN;${inserts.join('\n')}COMMIT;`);
  const f={db,root,expected,tick:1,requests:0};
  f.options={db,resourceDir:join(root,'resources'),maxCliAttempts:3,maxSelfAttempts:2,maxSeconds:30};
  f.deps={now:()=>AT+100000,monotonicClock:()=>f.tick,tryAcquireLease:()=>({state:'acquired',release(){}}),
    requestSessionDeps:{spawnSync(){f.requests++;throw Error('unexpected synthetic external request');}}};
  f.run=()=>executeResourceWork(f.options,f.deps);return f;
}

test('default resource enrollment reads forty long post/card sources through framed rows with exact fields and order',t=>{
  const f=fixture(t,40,{long:true}),reads=[],writes=[];f.deps.monotonicClock=()=>performance.now();
  const result=observeSpawns((run,command,args,options)=>{
    if(command==='sqlite3'&&sourceRead(options)) {
      assert.deepEqual(args.slice(0,-1),['-readonly','-batch','-init','/dev/null','-noheader','-list']);
      assert.equal(options.killSignal,'SIGKILL');assert(options.timeout>0&&options.timeout<=2000);
      assert.match(options.input,/COMMIT;\n\.print __EXOCORTEX_JSON_LINES_END_V1__\n$/);
      const output=run(command,args,options);assert.equal(output.status,0);
      const lines=output.stdout.trimEnd().split('\n');assert.equal(lines.shift(),BEGIN);assert.equal(lines.pop(),END);
      const rows=lines.map(line=>JSON.parse(line));reads.push(rows);
      assert.deepEqual(rows,f.expected);assert(rows.every(row=>JSON.stringify(Object.keys(row))===JSON.stringify(FIELDS)));
      return output;
    }
    if(command==='sqlite3'&&options.input?.includes('CREATE TEMP TABLE __resource_scan_source'))writes.push(options.timeout);
    return run(command,args,options);
  },()=>f.run());
  assert.equal(result.ok,true);assert.equal(reads.length,1);assert.equal(reads[0].length,40);
  assert.equal(writes.length,1);assert(writes[0]>0&&writes[0]<=30000);
  assert.equal(sqliteQuery(f.db,'SELECT COUNT(*) n FROM lark_im_resource_work;')[0].n,40);
  assert.equal(sqliteQuery(f.db,"SELECT COUNT(*) n FROM lark_im_resource_work WHERE state='blocked' AND attempts=0;")[0].n,40);
  assert.equal(f.requests,0);assert.equal(result.request_budget.max_seconds,30);assert.equal(result.request_budget.stop_reason,null);
});

test('SQL JSON encoding preserves an actual TEXT NUL before the enrollment write boundary',t=>{
  const f=fixture(t,1,{nulBody:true});let rows,writes=0;
  f.deps.sqliteWrite=()=>{writes++;throw Error('synthetic stop at first write boundary');};
  const result=observeSpawns((run,command,args,options)=>{
    const output=run(command,args,options);
    if(command==='sqlite3'&&sourceRead(options)) {
      assert.equal(output.status,0);assert(!output.stdout.includes('\0'),'wire contains JSON-escaped NUL, never raw framing NUL');
      const lines=output.stdout.trimEnd().split('\n');lines.shift();lines.pop();rows=lines.map(line=>JSON.parse(line));
    }return output;
  },()=>f.run());
  assert.deepEqual(rows,f.expected);assert(rows[0].body.includes('\0'));assert.equal(writes,1);
  assert.equal(result.outcome,'execution_failed');assert.equal(f.requests,0);
  assert.equal(sqliteQuery(f.db,'SELECT COUNT(*) n FROM lark_im_resource_work;')[0].n,0);
});

for(const [name,alter] of [
  ['missing COMMIT end frame',text=>text.replace(`${END}\n`,'')],
  ['prefix before begin',text=>'unexpected\n'+text],
  ['suffix after end',text=>text+'unexpected\n'],
  ['raw NUL framing',text=>text.replace(BEGIN,BEGIN+'\0')],
  ['invalid later row',text=>text.replace(`\n${END}`,`\n{broken\n${END}`)],
  ['nonobject row',text=>text.replace(`\n${END}`,`\n[]\n${END}`)],
])test(`default source wire rejects ${name} without accepting a prefix or writing`,t=>{
  const f=fixture(t,2);let intercepted=0,writes=0;f.deps.sqliteWrite=()=>{writes++;throw Error('unexpected write');};
  const result=observeSpawns((run,command,args,options)=>{
    const output=run(command,args,options);
    if(command==='sqlite3'&&sourceRead(options)){intercepted++;assert.equal(output.status,0);return {...output,stdout:alter(output.stdout)};}
    return output;
  },()=>f.run());
  assert.equal(intercepted,1);assert.equal(result.ok,false);assert.equal(result.outcome,'execution_failed');
  assert.equal(result.read_diagnostic.operation,'source_rows');
  assert(['invalid_shape','invalid_json'].includes(result.read_diagnostic.diagnostic.kind));
  assert.equal(writes,0);assert.equal(f.requests,0);
  assert.equal(sqliteQuery(f.db,'SELECT generation FROM lark_im_resource_scan;')[0].generation,0);
});

test('default source timeout receives the original two-second maximum and makes no write',t=>{
  const f=fixture(t),timeouts=[];let writes=0;f.deps.sqliteWrite=()=>{writes++;};
  const result=observeSpawns((run,command,args,options)=>{
    if(command==='sqlite3'&&sourceRead(options)){
      timeouts.push(options.timeout);return {status:null,signal:'SIGKILL',error:{code:'ETIMEDOUT'},stdout:'',stderr:''};
    }return run(command,args,options);
  },()=>f.run());
  assert.deepEqual(timeouts,[2000]);assert.equal(result.read_diagnostic.diagnostic.timeout_ms,2000);
  assert.equal(result.read_diagnostic.diagnostic.kind,'timeout');assert.equal(result.request_budget.stop_reason,null);
  assert.equal(writes,0);assert.equal(f.requests,0);
});

test('source read gets remaining whole grant and a late successful read cannot enroll',t=>{
  const f=fixture(t);f.options.maxSeconds=3;let sourceTimeout,writes=0,readsAfter=0,ended=false;
  f.deps.sqliteWrite=()=>{writes++;};
  const result=observeSpawns((run,command,args,options)=>{
    if(command==='sqlite3'&&ended)readsAfter++;
    if(command==='sqlite3'&&options.input?.includes('ORDER BY id LIMIT 20;'))f.tick=2501;
    const output=run(command,args,options);
    if(command==='sqlite3'&&sourceRead(options)){sourceTimeout=options.timeout;f.tick=3001;ended=true;}
    return output;
  },()=>f.run());
  assert.equal(sourceTimeout,500);assert.equal(result.request_budget.max_seconds,3);
  assert.equal(result.request_budget.stop_reason,'time_budget');assert.equal(result.ok,false);
  assert.equal(writes,0);assert.equal(readsAfter,0);assert.equal(f.requests,0);
});

test('explicit injected row reader keeps its original raw-row SQL interface',t=>{
  const f=fixture(t),reads=[];
  f.deps.sqliteJson=(db,sql,label)=>{if(label==='read bounded resource source rows')reads.push(sql);return sqliteQuery(db,sql,label);};
  const result=f.run();assert.equal(result.ok,true);assert.equal(reads.length,1);
  assert.match(reads[0],/^SELECT id,source_id,/);assert.doesNotMatch(reads[0],/encoded_row|json_object/);
  assert.equal(sqliteQuery(f.db,'SELECT COUNT(*) n FROM lark_im_resource_work;')[0].n,1);
  assert.equal(f.requests,0);
});
