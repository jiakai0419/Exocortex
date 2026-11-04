import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ensureInitialized,sqliteExec,sqliteQuery,quoteSql as q} from '../../dist/storage/sqlite/ingestion-store.js';
import {SENT_SCOPE_ID} from '../../src/adapters/lark-im/core.mjs';
import {renderApiMessageContent} from '../../src/adapters/lark-im/raw-message.mjs';
import {readMessageSnapshot} from '../../src/diagnostics/message-read-snapshot.mjs';
import {enrichResources} from '../../src/maintenance/enrich-resources.mjs';

const SELF='ou_synthetic_multi_resource',AT=Date.UTC(2025,4,1),sha=x=>createHash('sha256').update(x).digest('hex');
const GIF=Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b','hex');
const allowed=()=> 'message_image';
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'synthetic-embedded-work-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const db=join(root,'messages.sqlite');ensureInitialized(db);
  const f={root,db,resourceDir:join(root,'resources'),wall:AT+100000,tick:1,next:1,calls:[],writes:[],settings:{}};
  f.add=(type='post',keys=['synthetic_image'],padding='',payload=null)=>{
    const id=f.next++,raw={message_id:`om_synthetic_embedded_work_${id}`,chat_id:'oc_synthetic_embedded_work',msg_type:type,chat_type:'group',
      create_time:String(AT+id),sender:{id:SELF,id_type:'open_id',sender_type:'user',name:'Synthetic Reader'},
      body:{content:JSON.stringify(payload??(type==='post'?{title:'Synthetic source',content:[[{tag:'text',text:`Synthetic text ${padding}`},...keys.map(image_key=>({tag:'img',image_key}))]]}
        :type==='image'?{image_key:keys[0]}:type==='interactive'?{elements:[{tag:'plain_text',content:`Synthetic card ${padding}`}]}:{text:`Synthetic prose ${padding}`}))}};
    const rendered=renderApiMessageContent(raw),canonical={message_id:raw.message_id,chat_id:raw.chat_id,chat_type:'group',chat_name:'Synthetic Room',
      msg_type:type,sender_id:SELF,sender_id_type:'open_id',sender_type:'user',sender_name:'Synthetic Reader',sender_name_source:'message_sender',content_rendering:{...rendered}};
    delete canonical.content_rendering.text;
    const raw_json=JSON.stringify(raw),row={id,source_id:'lark.im',record_type:'lark.im.message',external_id:raw.message_id,external_version:String(AT+id),
      first_seen_scope_id:SENT_SCOPE_ID,actor_id:SELF,container_id:raw.chat_id,direction:'sent',occurred_at:new Date(AT+id).toISOString(),occurred_at_ms:AT+id,
      raw_json,canonical_json:JSON.stringify(canonical),content_hash:sha(raw_json),body:rendered.text};
    sqliteExec(db,`INSERT INTO records(${Object.keys(row)}) VALUES(${Object.values(row).map(q)});`);return id;
  };
  f.options={db,resourceDir:f.resourceDir,maxCliAttempts:3,maxSelfAttempts:2,maxSeconds:30};
  f.deps={tmpdir:root,now:()=>f.wall,monotonicClock:()=>f.tick,
    tryAcquireLease:()=>({state:'acquired',release(){}}),
    sqliteWrite:(db,sql,label,budget)=>{f.writes.push(sql);f.settings.beforeWrite?.(sql);return sqliteQuery(db,sql,label,budget);},
    requestSessionDeps:{monotonicClock:()=>f.tick,now:()=>f.wall,sleep:ms=>{f.tick+=ms;},
      tryAcquireLease:()=>({state:'acquired',release(){}}),readSharedCooldown:()=>({state:'ready'}),writeSharedCooldown:()=>true,
      spawnSync(command,wrapped,options){
        assert.equal(command,'python3');const args=wrapped.slice(4);f.calls.push(args);f.tick+=10;
        if(args[0]==='contact')return {status:0,stdout:JSON.stringify({open_id:SELF}),stderr:''};
        assert.equal(args[0],'api');assert.equal(args[1],'GET');
        const key=decodeURIComponent(args[2].split('/').at(-1));
        if(f.settings.denied?.has(key))return {status:1,stdout:JSON.stringify({code:210508,msg:'Synthetic exact resource denied'}),stderr:''};
        const bytes=f.settings.invalid?.has(key)?Buffer.from('Synthetic invalid image bytes'):GIF;
        const name=args[args.indexOf('--output')+1];writeFileSync(join(options.cwd,name),bytes,{mode:0o600});
        return {status:0,stdout:JSON.stringify({saved_path:name,size_bytes:bytes.length,content_type:'image/gif'}),stderr:''};
      }} };
  f.run=()=>enrichResources({...f.options,recordIds:[1],apply:true},f.deps);
  f.advance=(ms=61000)=>{f.wall+=ms;f.tick+=ms;};
  f.tasks=()=>sqliteQuery(db,'SELECT * FROM lark_im_resource_work ORDER BY record_id,work_key;');
  f.row=id=>readMessageSnapshot(db,{recordIds:[id]}).rows[0];
  f.downloads=()=>f.calls.filter(args=>args[0]==='api').map(args=>decodeURIComponent(args[2].split('/').at(-1)));
  return f;
}



export {fixture as resourceProducerFixture};
