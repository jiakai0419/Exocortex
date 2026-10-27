import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ensureInitialized,quoteSql,sqliteExec,reserveInitialLarkAccount,confirmInitialLarkAccountSql} from '../dist/storage/sqlite/ingestion-store.js';
import {normalizeApiMessage} from '../src/adapters/lark-im/raw-message.mjs';
import {recordFromMessage} from '../src/adapters/lark-im/message-record.mjs';
import {recipientAccountKey} from '../src/adapters/lark-im/p2p-recipient.mjs';
import {readMessageSnapshot} from '../src/diagnostics/message-read-snapshot.mjs';
import {readLocalSenderProjectionEvidence,reuseKnownSenderNames} from '../src/adapters/lark-im/name-history.mjs';
import {readOnlySqliteJson} from '../src/storage/sqlite/readonly-query.mjs';

// Entirely invented identity/source data; real SQLite, no network or production.
const SELF={open_id:'ou_synthetic_donor_owner',name:'Invented Owner'};
const ACCOUNT=recipientAccountKey(SELF.open_id), CHAT='oc_synthetic_donor_chat', AT=1735689600000;
const digest=value=>createHash('sha256').update(value).digest('hex');
function record(id,{donor=false,padding='',fields={}}={}) {
  const raw={message_id:`om_synthetic_donor_${id}`,chat_id:CHAT,chat_type:'group',msg_type:'text',
    create_time:String(AT+id),update_time:String(AT+id+1),sender:{id:SELF.open_id,id_type:'open_id',sender_type:'user'},
    body:{content:JSON.stringify({text:'Invented donor body.'})},...(padding?{authored_padding:padding}:{})};
  const value=recordFromMessage(normalizeApiMessage(raw),'lark.im.sent_by_me','sent',{self:SELF},{chat_id:CHAT,chat_type:'group',chat_name:'Invented Group'});
  value.canonical_json=JSON.stringify({...JSON.parse(value.canonical_json),sender_name:SELF.name,
    sender_name_source:donor?'contact':'self',sender_name_confidence:'high',
    ...(donor?{sender_name_account_key:ACCOUNT}:{}),...fields});
  return {id,...value};
}
function fixture(t,rows) {
  const dir=mkdtempSync(join(tmpdir(),'exocortex-donor-snapshot-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=join(dir,'synthetic.sqlite');ensureInitialized(db);
  reserveInitialLarkAccount(db,ACCOUNT,new Date().toISOString());sqliteExec(db,confirmInitialLarkAccountSql(new Date().toISOString()));
  const columns=Object.keys(rows[0]);
  sqliteExec(db,rows.map(row=>`INSERT INTO records(${columns.join(',')}) VALUES(${columns.map(key=>row[key]==null?'NULL':quoteSql(row[key])).join(',')});`).join('\n'));
  return db;
}
function projection(row,groups) {
  return readLocalSenderProjectionEvidence(row,JSON.parse(row.canonical_json),JSON.parse(row.raw_json),ACCOUNT,groups);
}

test('more than one hundred agreeing donors stay usable, irrelevant history does not consume donor capacity, and reading is one snapshot',t=>{
  const target=record(10000), donors=Array.from({length:150},(_,i)=>record(i+1,{donor:true}));
  const unnamed=Array.from({length:1100},(_,i)=>record(i+1000,{fields:{sender_name:null,sender_name_source:null,sender_name_confidence:null}}));
  const db=fixture(t,[target,...donors,...unnamed]),before=digest(readFileSync(db)),queries=[];
  const start=performance.now();
  const result=readMessageSnapshot(db,{limit:1},{sqliteJson(path,sql,label){queries.push(sql);return readOnlySqliteJson(path,sql,label);}});
  assert.equal(queries.length,2);assert.match(queries[1],/INDEXED BY records_name_sender/);
  assert.equal(result.senderDonors.length,1);assert.equal(result.senderDonors[0].complete,true);
  assert.equal(result.senderDonors[0].rows.length,150);assert.equal(projection(result.rows[0],result.senderDonors)?.name,SELF.name);
  assert.equal(result.population.total,1251);assert.equal(digest(readFileSync(db)),before);
  t.diagnostic(JSON.stringify({history_rows:1251,donors:150,read_ms:Math.ceil(performance.now()-start)}));
});

test('candidate overflow is explicit and cannot choose the first agreeing name',t=>{
  const target=record(10000),db=fixture(t,[target,...Array.from({length:1001},(_,i)=>record(i+1,{donor:true}))]);
  const result=readMessageSnapshot(db,{limit:1});
  assert.deepEqual(result.senderDonors,[{actor_id:SELF.open_id,complete:false,rows:[]}]);
  assert.equal(projection(result.rows[0],result.senderDonors),null);
});

test('oversized donor bytes defer the entire actor instead of hiding a conflicting source row',t=>{
  const target=record(10000),db=fixture(t,[target,record(1,{donor:true}),record(2,{donor:true,padding:'x'.repeat(1024*1024)})]);
  const result=readMessageSnapshot(db,{limit:1});
  assert.deepEqual(result.senderDonors,[{actor_id:SELF.open_id,complete:false,rows:[]}]);
  assert.equal(projection(result.rows[0],result.senderDonors),null);
});

test('the finite page byte budget never adopts a partial donor prefix',t=>{
  const target=record(10000),db=fixture(t,[target,...Array.from({length:18},(_,i)=>record(i+1,{donor:true,padding:'x'.repeat(480*1024)}))]);
  const result=readMessageSnapshot(db,{limit:1});
  assert.deepEqual(result.senderDonors,[{actor_id:SELF.open_id,complete:false,rows:[]}]);
  assert.equal(projection(result.rows[0],result.senderDonors),null);
});

test('known but unbound ingestion names can reuse authority; latest failure and unusable clocks do not erase adoption',t=>{
  const target=record(10000),donor=record(1,{donor:true,fields:{sender_name_observed_at:'2999-01-01T00:00:00.000Z',
    sender_name_verification:{status:'failed',source:'contact',account_key:ACCOUNT}}});
  const db=fixture(t,[target,donor]),result=readMessageSnapshot(db,{limit:1});
  const proof=projection(result.rows[0],result.senderDonors);
  assert.equal(proof?.name,SELF.name);assert.equal(proof?.observed_at,undefined);
  const filled=reuseKnownSenderNames(db,[target],SELF)[0],value=JSON.parse(filled.canonical_json);
  assert.equal(value.sender_name,SELF.name);assert.equal(value.sender_name_account_key,ACCOUNT);
  assert.equal(value.sender_name_source,'local_history');assert.equal(filled.raw_json,target.raw_json);assert.equal(filled.body,target.body);
});

test('a name echoing any typed alias remains an eligible donor target despite a plausible existing authority marker',t=>{
  let target=record(10000,{donor:true});
  const raw=JSON.parse(target.raw_json);(raw.raw_api||raw).sender.user_id='synthetic_other_namespace_alias';
  if(raw.sender)raw.sender.user_id='synthetic_other_namespace_alias';
  target.raw_json=JSON.stringify(raw);target.content_hash=digest(target.raw_json);
  target.canonical_json=JSON.stringify({...JSON.parse(target.canonical_json),sender_name:'synthetic_other_namespace_alias'});
  const db=fixture(t,[target,record(1,{donor:true})]),result=readMessageSnapshot(db,{limit:1});
  assert.equal(result.senderDonors.length,1);assert.equal(projection(result.rows[0],result.senderDonors)?.name,SELF.name);
});
