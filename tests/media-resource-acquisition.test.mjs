import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { ensureInitialized, quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { enrichResources } from '../src/maintenance/enrich-resources.mjs';
import { loadMessages } from '../src/diagnostics/messages-report.mjs';
import { renderMessagesText } from '../src/terminal/messages-view.mjs';
import { readMessageSnapshot } from '../src/diagnostics/message-read-snapshot.mjs';
import { SENT_SCOPE_ID } from '../src/adapters/lark-im/core.mjs';

// Tiny synthetic RGBA PNG; no production message, image or account is used.
const crc=bytes=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;};
const chunk=(tag,bytes)=>{const data=Buffer.concat([Buffer.from(tag),bytes]),length=Buffer.alloc(4),sum=Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);sum.writeUInt32BE(crc(data));return Buffer.concat([length,data,sum]);};
const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
const PNG=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),
  chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255]))),chunk('IEND',Buffer.alloc(0))]);
const SELF='ou_synthetic_resource_owner',AT=Date.UTC(2025,1,3);
const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture(t,count=1,sticker=false) {
  const root=mkdtempSync(join(tmpdir(),'synthetic-resource-acquisition-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const db=join(root,'messages.sqlite');ensureInitialized(db);
  const rows=Array.from({length:count},(_,index)=>{
    const id=index+1,type=sticker&&id===count?'sticker':'image',external=`om_synthetic_resource_${id}`,chat='oc_synthetic_resource_room';
    const raw={message_id:external,chat_id:chat,chat_type:'group',msg_type:type,create_time:String(AT+id),
      sender:{id:SELF,id_type:'open_id',sender_type:'user',name:'Synthetic Image Author'},
      body:{content:JSON.stringify(type==='image'?{image_key:`synthetic_image_${id}`}:{file_key:`synthetic_sticker_${id}`})}};
    const canonical={message_id:external,chat_id:chat,chat_type:'group',chat_name:'Synthetic Resource Room',msg_type:type,
      sender_id:SELF,sender_id_type:'open_id',sender_type:'user',sender_name:'Synthetic Image Author',sender_name_source:'message_sender'};
    const raw_json=JSON.stringify(raw);
    return {id,source_id:'lark.im',record_type:'lark.im.message',external_id:external,external_version:String(AT+id),
      first_seen_scope_id:SENT_SCOPE_ID,actor_id:SELF,container_id:chat,direction:'sent',occurred_at:new Date(AT+id).toISOString(),
      occurred_at_ms:AT+id,raw_json,canonical_json:JSON.stringify(canonical),content_hash:sha(raw_json),body:`Original synthetic fallback ${id}.`};
  });
  sqliteExec(db,rows.map(row=>{const keys=Object.keys(row);return `INSERT INTO records(${keys}) VALUES(${keys.map(key=>quoteSql(row[key])).join(',')});`;}).join('\n'));
  sqliteExec(db,'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  return {root,db,rows,resourceDir:join(root,'resources'),options:{db,target:'resources',recordIds:rows.map(row=>row.id),apply:true}};
}
function transport(f,settings={}) {
  let clock=1,profiles=0;const calls=[],stages=[];
  const deps={tmpdir:f.root,now:()=>AT+10000,requestSessionDeps:{
    monotonicClock:()=>clock,sleep:ms=>{clock+=ms;},now:()=>AT+clock,
    tryAcquireLease:()=>({state:'acquired',release(){}}),readSharedCooldown:()=>({state:'ready'}),writeSharedCooldown:()=>true,
    spawnSync(command,wrapped,opts) {
      assert.equal(command,'python3');assert(wrapped[2].includes('RLIMIT_FSIZE'));assert(wrapped[2].includes('os.umask(0o077)'));
      const args=wrapped.slice(4);calls.push(args);stages.push(opts.cwd);
      const ok=payload=>({status:0,stdout:JSON.stringify(payload),stderr:''});
      if(args[0]==='contact') {
        profiles++;settings.onProfile?.(profiles);
        return ok({open_id:settings.profile?.(profiles)??SELF});
      }
      assert.deepEqual(args.slice(0,2),['api','GET']);assert(args[2].includes('/resources/synthetic_image_'));
      assert(!args.includes('+messages-resources-download'));assert.equal(args[args.indexOf('--as')+1],'user');
      if(settings.denial)return {status:1,stdout:JSON.stringify({code:210508,msg:'permission denied: synthetic secret'}),stderr:''};
      const filename=args[args.indexOf('--output')+1],path=join(opts.cwd,filename);
      let bytes=settings.bytes??PNG;
      writeFileSync(path,bytes,{mode:0o600});
      settings.afterFile?.(path);
      return ok({saved_path:settings.savedPath??filename,size_bytes:settings.size??bytes.length,
        content_type:settings.mime??'image/png'});
    },
  }};
  return {deps,calls,stages};
}
const messages=(f)=>loadMessages(f.db,{direction:'all',search:'',limit:20,resourceDir:f.resourceDir});
const acquire=(f,wire,opts={})=>enrichResources({...f.options,resourceDir:f.resourceDir,...opts},wire.deps);

test('verified synthetic download reaches readable image content without source/DB changes; sticker stays explicit',t=>{
  const f=fixture(t,2,true),wire=transport(f),before=readFileSync(f.db),source=readMessageSnapshot(f.db,{limit:20}).rows;
  const preview=acquire(f,wire,{apply:false});assert.equal(wire.calls.length,0);assert.equal(preview.planned,1);
  assert.equal(preview.results[1].reason,'sticker_resource_unsupported');assert(!existsSync(f.resourceDir));
  const report=acquire(f,wire);assert.equal(report.available,1);assert.equal(report.failed,1);assert.equal(wire.calls.length,3);
  assert.equal(report.request_budget.self_attempts,2);assert(wire.stages.every(path=>!existsSync(path)));
  const output=messages(f),image=output.find(row=>row.id===1),sticker=output.find(row=>row.id===2);
  assert.equal(image.readiness.state,'ready');assert.equal(image.display.media.resource.availability,'available');
  assert.deepEqual(readFileSync(image.display.media.resource.path),PNG);assert.equal(image.display.media.resource.sha256,sha(PNG));
  assert.equal(sticker.readiness.state,'blocked');assert(sticker.readiness.reasons.includes('content_resource_unsupported'));
  assert.equal(image.body,f.rows[0].body);assert.equal(image.display.body,f.rows[0].body);
  const terminal=renderMessagesText(output,{columns:240});assert(terminal.replace(/\n +/g,'').includes(image.display.media.resource.path));
  assert(terminal.includes('image/png'));assert(!terminal.includes(f.rows[0].body));assert(terminal.includes('不支持读取贴纸'));
  assert.deepEqual(readFileSync(f.db),before);assert.deepEqual(readMessageSnapshot(f.db,{limit:20}).rows,source);
  const cached=transport(f);assert.equal(acquire(f,cached).available,1);assert.equal(cached.calls.length,0);
  writeFileSync(image.display.media.resource.path,Buffer.from('invalid synthetic bytes'),{mode:0o600});
  assert(messages(f).find(row=>row.id===1).readiness.reasons.includes('content_resource_invalid'));
  const corrupt=transport(f);assert.equal(acquire(f,corrupt).available,0);assert.equal(corrupt.calls.length,0);
});

test('remote denial stops the exact batch with no retry or publication',t=>{
  const f=fixture(t,2),wire=transport(f,{denial:true});const report=acquire(f,wire);
  assert.equal(wire.calls.length,2);assert.equal(report.stop_reason,'permission_denied');assert.equal(report.available,0);
  assert.deepEqual(report.results.map(item=>item.reason),['permission_denied','batch_stopped']);
  assert(!JSON.stringify(report).includes('synthetic secret'));assert(!existsSync(f.resourceDir));
  assert(wire.stages.every(path=>!existsSync(path)));
});

for(const [name,settings,expected] of [
  ['wrong starting account',{profile:()=> 'ou_synthetic_different_owner'},'account_mismatch'],
  ['changed closing account',{profile:n=>n===2?'ou_synthetic_changed_owner':SELF},'account_changed'],
  ['malformed self',{profile:()=>''},'profile_unverified'],
  ['incorrect byte count',{size:PNG.length+1},'download_file_invalid'],
  ['wrong MIME',{mime:'image/jpeg'},'download_image_invalid'],
  ['HTML cannot be an image',{bytes:Buffer.from('<html>synthetic failure</html>')},'download_image_invalid'],
  ['truncated container',{bytes:PNG.subarray(0,50)},'download_image_invalid'],
  ['unsupported WebP is not mislabeled as usable',{bytes:Buffer.from('5249464612000000574542505650384c060000002f0000000000','hex'),mime:'image/webp'},'resource_format_unsupported'],
  ['untrusted response path',{savedPath:'../unrelated-file'},'download_response_invalid'],
  ['world-readable staging',{afterFile:path=>chmodSync(path,0o644)},'download_file_invalid'],
  ['symbolic link staging',{afterFile:path=>{rmSync(path);symlinkSync('/dev/null',path);}},'download_file_invalid'],
]) test(name+' cannot publish or become ready',t=>{
  const f=fixture(t),wire=transport(f,settings),report=acquire(f,wire);
  if(['download_image_invalid','resource_format_unsupported'].includes(expected)) {
    assert.equal(report.stop_reason,undefined);assert.equal(report.results[0].reason,expected);
  } else assert.equal(report.stop_reason,expected);
  assert.equal(report.available,0);assert(!existsSync(f.resourceDir));
  assert.equal(messages(f)[0].readiness.state,'blocked');assert(wire.stages.every(path=>!existsSync(path)));
});

test('source change between download and commit invalidates that publication',t=>{
  const f=fixture(t),wire=transport(f,{onProfile:n=>{if(n===2)sqliteExec(f.db,"UPDATE records SET external_version='synthetic_new_version' WHERE id=1;");}});
  const report=acquire(f,wire);assert.equal(report.results[0].reason,'source_changed');assert.equal(report.available,0);
  assert(!existsSync(f.resourceDir));assert.equal(messages(f)[0].readiness.state,'blocked');
});

test('one changed source blocks only its own publication after the closing account fence',t=>{
  const f=fixture(t,3),wire=transport(f,{onProfile:n=>{if(n===2)sqliteExec(f.db,"UPDATE records SET external_version='synthetic_new_version' WHERE id=2;");}});
  const report=acquire(f,wire);
  assert.deepEqual(report.results.map(item=>item.reason),[null,'source_changed',null]);
  assert.equal(report.available,2);assert.equal(report.stop_reason,undefined);
  assert.deepEqual(messages(f).map(row=>[row.id,row.readiness.state]),[[3,'ready'],[2,'blocked'],[1,'ready']]);
});

test('closing account failure withholds every staged resource without assigning a resource denial',t=>{
  const f=fixture(t,3),wire=transport(f,{profile:n=>n===2?'ou_synthetic_changed_owner':SELF});
  const report=acquire(f,wire);
  assert.equal(report.stop_reason,'account_changed');assert.equal(wire.calls.length,5);
  assert.deepEqual(report.results.map(item=>item.reason),Array(3).fill('publication_not_attempted'));
  assert.equal(report.available,0);assert(!existsSync(f.resourceDir));
});

for(const [name,settings] of [
  ['world-readable download',{afterFile:path=>chmodSync(path,0o644)}],
  ['symbolic-link download',{afterFile:path=>{rmSync(path);symlinkSync('/dev/null',path);}}],
])test(name+' stops the batch without giving unrequested items file-error evidence',t=>{
  const f=fixture(t,3),wire=transport(f,settings),report=acquire(f,wire);
  assert.equal(report.stop_reason,'download_file_invalid');assert.equal(wire.calls.length,2);
  assert.deepEqual(report.results.map(item=>item.reason),['download_file_invalid','batch_stopped','batch_stopped']);
  assert.equal(report.available,0);assert(!existsSync(f.resourceDir));
});

test('shared lease contention after one download keeps later resources explicitly unrequested',t=>{
  const f=fixture(t,3),wire=transport(f);let leases=0;
  wire.deps.requestSessionDeps.tryAcquireLease=()=>++leases===3?{state:'busy'}:{state:'acquired',release(){}};
  const report=acquire(f,wire);
  assert.equal(report.stop_reason,'sync_busy');assert.equal(wire.calls.length,2);
  assert.deepEqual(report.results.map(item=>item.reason),['publication_not_attempted','batch_stopped','batch_stopped']);
  assert.equal(report.available,0);assert(!existsSync(f.resourceDir));
});

test('unsafe destination discovered at publication stops remaining staged resources',t=>{
  const f=fixture(t,3),wire=transport(f,{onProfile:n=>{if(n===2){mkdirSync(f.resourceDir,{mode:0o700});chmodSync(f.resourceDir,0o755);}}});
  const report=acquire(f,wire);
  assert.equal(report.stop_reason,'resource_publish_failed');assert.equal(wire.calls.length,5);
  assert.deepEqual(report.results.map(item=>item.reason),['resource_verification_failed','publication_not_attempted','publication_not_attempted']);
  assert.equal(report.available,0);assert.deepEqual(readdirSync(f.resourceDir),[]);
});

test('source version changes after successful caching cannot borrow old image evidence',t=>{
  const f=fixture(t);assert.equal(acquire(f,transport(f)).available,1);
  sqliteExec(f.db,"UPDATE records SET external_version='synthetic_later_version' WHERE id=1;");
  const output=messages(f)[0];assert.equal(output.readiness.state,'blocked');
  assert.equal(output.display.media.resource.availability,'unverified');
});

test('busy sync causes zero CLI calls and removes staging',t=>{
  const f=fixture(t),wire=transport(f);wire.deps.requestSessionDeps.tryAcquireLease=()=>({state:'busy'});
  const report=acquire(f,wire);assert.equal(report.stop_reason,'sync_busy');assert.equal(wire.calls.length,0);
  assert.equal(report.request_budget.cli_attempts,0);assert(!readdirSync(f.root).some(name=>name.startsWith('exocortex-media-')));
});
