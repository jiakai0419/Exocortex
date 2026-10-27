import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import test from 'node:test';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Socket} from 'node:net';
const ROOT=dirname(dirname(fileURLToPath(import.meta.url)));
const OUT=tmpdir();
const {ensureInitialized,reserveInitialLarkAccount,confirmInitialLarkAccountSql,quoteSql:q,sqliteExec:exec,sqliteQuery:query}=await import(`${ROOT}/dist/storage/sqlite/ingestion-store.js`);
const {syncNames}=await import(`${ROOT}/src/adapters/lark-im/name-sync.mjs`);
const {chatScopeId}=await import(`${ROOT}/src/adapters/lark-im/core.mjs`);
const {recipientAccountKey}=await import(`${ROOT}/src/adapters/lark-im/p2p-recipient.mjs`);
const SELF='ou_synthetic_latency_self', CHAT='oc_synthetic_latency_group', FRESH='ou_synthetic_latency_fresh';
const NOW=Date.parse('2026-09-01T00:00:00.000Z'),ACCOUNT=recipientAccountKey(SELF);
const reject=()=>{throw new Error('This authored probe forbids network')};globalThis.fetch=reject;Socket.prototype.connect=reject;
if(process.argv[2]==='turn'){
 const db=process.argv[3],at=Number(process.argv[4]),calls=[];
 const result=syncNames(db,{open_id:SELF,name:'Synthetic Owner'},{now:()=>at,monotonicNow:()=>0,syncRecipients:()=>({reason:'idle'}),runLark:(args,opts)=>{
  assert.equal(opts.retries,0);assert(opts.timeoutMs<=5000);calls.push(args.slice(0,3).join(' '));
  if(args[0]==='contact'&&args[1]==='+get-user')return {open_id:SELF,name:'Synthetic Owner'};
  if(args[0]==='contact'&&args[1]==='+search-user'){
   if(args.join(' ').includes(FRESH))return {users:[{open_id:FRESH,name:'Synthetic Fresh Author'}]};
   throw new Error('synthetic permanent permission denial for old actors');
  }
  if(args.slice(0,3).join(' ')==='im chat.members get')throw new Error('synthetic old member permission denial');
  if(args.slice(0,3).join(' ')==='im chats get')return {data:{chat_id:CHAT,chat_mode:'group',name:'Synthetic Known Group'}};
  throw new Error('unexpected synthetic route '+args.slice(0,3).join(' '));
 }});
 console.log(JSON.stringify({result,calls}));process.exit(0);
}
test('actual separate-process name coordinator serves the new exact identity despite twelve old failing tasks',t=>{
const dir=mkdtempSync(join(OUT,'synthetic-backlog-')),db=join(dir,'synthetic.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));ensureInitialized(db);
reserveInitialLarkAccount(db,ACCOUNT,new Date().toISOString());exec(db,confirmInitialLarkAccountSql(new Date().toISOString()));
exec(db,`INSERT INTO sync_scopes(id,source_id,name,enabled,config_json) VALUES(${q(chatScopeId(CHAT))},'lark.im','Synthetic group',0,${q(JSON.stringify({chat_id:CHAT,chat_type:'group',chat_name:'Synthetic Known Group'}))});`);
function add(id,actor,at){const message=`om_synthetic_latency_${id}`;const raw={message_id:message,chat_id:CHAT,chat_type:'group',create_time:String(at),sender:{id:actor,id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({text:'Synthetic body '+id})}};
 const canonical={message_id:message,chat_id:CHAT,chat_type:'group',sender_id:actor,sender_id_type:'open_id',sender_name:null,chat_name:'Synthetic Known Group',msg_type:'text'};
 exec(db,`INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,record_type,occurred_at,occurred_at_ms,actor_id,container_id,direction,body,canonical_json,raw_json) VALUES(${id},'lark.im',${q(chatScopeId(CHAT))},${q(message)},'synthetic-v1','lark.im.message',${q(new Date(at).toISOString())},${at},${q(actor)},${q(CHAT)},'received',${q('Synthetic body '+id)},${q(JSON.stringify(canonical))},${q(JSON.stringify(raw))});`);}
for(let i=1;i<=12;i++)add(i,`ou_synthetic_latency_old_${i}`,NOW-86400000+i);
function turn(at){const p=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'turn',db,String(at)],{encoding:'utf8',timeout:15000,env:{...process.env,LARK_CLI:'/usr/bin/false'}});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);}
const turns=[{atMs:NOW,...turn(NOW)}];add(13,FRESH,NOW+1);
const guard=join(dir,'deny-network.mjs');writeFileSync(guard,"import {Socket} from 'node:net';const deny=()=>{throw Error('no network')};globalThis.fetch=deny;Socket.prototype.connect=deny;\n");
const hash=()=>createHash('sha256').update(readFileSync(db)).digest('hex');
function show(format='json'){
 exec(db,'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');const before=hash();
 const p=spawnSync(process.execPath,['--import',guard,join(ROOT,'bin/exocortex.mjs'),'messages','--db',db,'--direction','received','--limit','1','--format',format],{encoding:'utf8',timeout:10000,env:{...process.env,LARK_CLI:'/usr/bin/false',NO_COLOR:'1'},cwd:dir});
 assert.equal(p.status,0,p.stderr);assert.equal(hash(),before);return format==='json'?JSON.parse(p.stdout):p.stdout;
}
const first=show(),firstText=show('text');assert.equal(first[0].external_id,'om_synthetic_latency_13');
let fullAt=null;
for(let minute=1;minute<=8;minute++){const atMs=NOW+60001*minute;turns.push({atMs,...turn(atMs)});const current=show();const terminal=show('text');if(current[0].display.sender==='Synthetic Fresh Author'&&terminal.includes('Synthetic Fresh Author')&&fullAt===null)fullAt=atMs;}
assert.ok(fullAt!==null&&fullAt-(NOW+1)<=120000,'fresh exact identity must become readable within two nominal one-minute opportunities');
const last=show(),lastText=show('text'),freshTask=query(db,`SELECT kind,outcome,last_attempt_at_ms,retry_at_ms FROM lark_im_name_tasks WHERE actor_id=${q(FRESH)};`)[0];
assert.equal(last.length,1);assert.equal(last[0].external_id,'om_synthetic_latency_13');
assert.equal(last[0].display.sender,'Synthetic Fresh Author');assert(lastText.includes('Synthetic Fresh Author'));
assert.ok(freshTask.last_attempt_at_ms>0);
assert.equal(first[0].external_id,last[0].external_id);
assert.equal(first[0].body,last[0].body);
assert(turns.every(turn=>turn.result.calls<=4));
const servedOld=query(db,`SELECT COUNT(*) AS n FROM lark_im_name_tasks WHERE kind='sender' AND actor_id<>${q(FRESH)} AND last_attempt_at_ms>0;`)[0].n;
assert.ok(servedOld>=2,'old failure debt retains fair opportunities after the fresh message');
// This oracle measures only the postcommit suffix; the worker publisher test
// separately covers source occurrence and acquisition. Every read above is
// the genuine CLI with network disabled and byte-identical synthetic storage.
});
