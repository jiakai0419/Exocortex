import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sqliteExec, sqliteQuery, quoteSql } from '../dist/storage/sqlite/ingestion-store.js';
import { larkWriteAdmissionSql } from '../dist/storage/sqlite/lark-write-admission.js';
import { captureRemoteAccountBinding, readRemoteAccountBinding, readRemoteAccountBindingWithSnapshot } from '../src/diagnostics/remote-account-binding.mjs';
import { captureLarkWriteAdmission } from '../src/diagnostics/lark-write-admission.mjs';
import { activityDatabaseKey } from '../src/diagnostics/lark-im-activity-evidence.mjs';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';

// Wholly authored evidence. Each contender uses another SQLite connection;
// only the local source files and files created by this fixture are observed.
const SELF = 'ou_paired_synthetic_self', OTHER = 'ou_paired_synthetic_other';
const accountKey = id => createHash('sha256').update(`lark.im\0${id}`).digest('hex');
const q = quoteSql;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-paired-account-'));
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  const db = join(dir,'synthetic.sqlite'), sidecar = `${db}.remote-account-binding.json`;
  const exec = sql => sqliteExec(db, sql);
  exec(`CREATE TABLE sources(id TEXT,enabled INTEGER,config_json TEXT);
    INSERT INTO sources VALUES('lark.im',1,'{}');
    CREATE TABLE records(source_id TEXT,direction TEXT,actor_id TEXT,canonical_json TEXT);
    CREATE TABLE sync_runs(source_id TEXT);
    CREATE TABLE sync_scopes(id TEXT,source_id TEXT,enabled INTEGER,config_json TEXT,cursor_json TEXT,name TEXT);
    INSERT INTO sync_scopes VALUES('synthetic_scope','lark.im',1,'{}',NULL,'Before');
    INSERT INTO records VALUES('lark.im','sent',${q(SELF)},${q(JSON.stringify({sender_id:SELF,sender_id_type:'open_id'}))});`);
  const writeSidecar = (id=SELF) => writeFileSync(sidecar, JSON.stringify({kind:'lark_im_remote_account_binding/v1',
    database_key:activityDatabaseKey(db),account_key:accountKey(id),evidence:'initialized_empty_database',bound_at:new Date(Date.now()-1000).toISOString()}),{mode:0o600});
  return {db,dir,sidecar,exec,writeSidecar};
}
function observedQuery() {
  const calls=[];
  const query=(db,sql,label,deps)=>{calls.push(label);return readOnlySqliteJson(db,sql,label,deps);};
  return {calls,query};
}
function admission(f,deps={}) { return captureLarkWriteAdmission(f.db,{selfOpenId:SELF,requireVerified:true,scopeIds:['synthetic_scope']},deps); }

test('paired fresh reader performs one aggregate and preserves ordinary public shape and bytes',t=>{
  const f=fixture(t),seen=observedQuery(),before=readFileSync(f.db);
  const paired=readRemoteAccountBindingWithSnapshot({db:f.db,selfOpenId:SELF},{query:seen.query});
  assert.deepEqual(seen.calls,['remote account binding']);
  assert.deepEqual(paired.snapshot,captureRemoteAccountBinding({db:f.db}));
  assert.deepEqual(paired.admission,readRemoteAccountBinding({db:f.db,selfOpenId:SELF}));
  assert.equal(paired.admission.state,'verified');
  assert.equal(Object.hasOwn(paired.admission,'snapshot'),false);
  assert.equal(paired.admission.tenant_verified,false);
  assert.deepEqual(readFileSync(f.db),before);
});

test('invalid self performs no aggregate and unavailable read never supplies a usable snapshot',t=>{
  const f=fixture(t),seen=observedQuery();
  const invalid=readRemoteAccountBindingWithSnapshot({db:f.db,selfOpenId:'invalid'},{query:seen.query});
  assert.equal(seen.calls.length,0);assert.equal(invalid.snapshot,null);assert.equal(invalid.admission.reason,'self_identity_unverified');
  const failed=readRemoteAccountBindingWithSnapshot({db:f.db,selfOpenId:SELF},{query:()=>{throw Error('synthetic private failure');}});
  assert.equal(failed.snapshot,null);assert.equal(failed.admission.reason,'database_evidence_unavailable');
});

test('a caller supplied or previously returned snapshot cannot replace a fresh observation',t=>{
  const f=fixture(t),first=readRemoteAccountBindingWithSnapshot({db:f.db,selfOpenId:SELF});
  f.exec(`UPDATE records SET actor_id=${q(OTHER)},canonical_json=NULL;`);
  const next=readRemoteAccountBindingWithSnapshot({db:f.db,selfOpenId:SELF,snapshot:first.snapshot});
  assert.equal(next.snapshot.sent_actor,OTHER);assert.equal(next.admission.state,'conflict');
  first.snapshot.sent_actor=OTHER;
  f.exec(`UPDATE records SET actor_id=${q(SELF)};`);
  assert.equal(readRemoteAccountBindingWithSnapshot({db:f.db,selfOpenId:SELF}).snapshot.sent_actor,SELF);
});

test('assertCurrent returns exactly its newly validated snapshot and never memoizes between boundaries',t=>{
  const f=fixture(t),seen=observedQuery(),a=admission(f,{query:seen.query});seen.calls.length=0;
  const first=a.assertCurrent();assert.equal(first.sent_records,1);assert.deepEqual(seen.calls,['remote account binding']);
  f.exec(`INSERT INTO records VALUES('lark.im','sent',${q(SELF)},NULL);`);seen.calls.length=0;
  const second=a.assertCurrent();assert.equal(second.sent_records,2);assert.notDeepEqual(second,first);
  assert.deepEqual(seen.calls,['remote account binding']);
});

for(const mutation of ['sent actor','canonical identity','initial binding','pending initial','absent sent evidence']) {
  test(`fresh assertCurrent rejects ${mutation} at the next validation boundary`,t=>{
    const f=fixture(t),a=admission(f);assert.equal(a.assertCurrent().conflict,false);
    if(mutation==='sent actor') f.exec(`UPDATE records SET actor_id=${q(OTHER)};`);
    else if(mutation==='canonical identity') f.exec(`UPDATE records SET canonical_json=${q(JSON.stringify({sender_id:OTHER}))};`);
    else if(mutation==='absent sent evidence') f.exec('DELETE FROM records;');
    else {
      const at=new Date(Date.now()-1000).toISOString();
      f.exec(`UPDATE sources SET config_json=${q(JSON.stringify({initial_account_binding:{kind:'lark_im_initial_account/v1',account_key:accountKey(mutation==='initial binding'?OTHER:SELF),reserved_at:at,confirmed_at:mutation==='pending initial'?null:at}}))};`);
    }
    assert.throws(()=>a.assertCurrent());
  });
}

for(const mutation of ['foreign','malformed','removed']) {
  test(`sidecar ${mutation} remains fenced between successive assertions`,t=>{
    const f=fixture(t);f.writeSidecar();const a=admission(f);a.assertCurrent();
    if(mutation==='foreign') f.writeSidecar(OTHER);
    else if(mutation==='malformed') writeFileSync(f.sidecar,'{}');
    else rmSync(f.sidecar);
    assert.throws(()=>a.assertCurrent());
  });
}

test('sidecar mutation during the aggregate is checked against the new snapshot',t=>{
  const f=fixture(t);f.writeSidecar();
  const pair=readRemoteAccountBindingWithSnapshot({db:f.db,selfOpenId:SELF},{query:(...args)=>{
    const rows=readOnlySqliteJson(...args);f.writeSidecar(OTHER);return rows;
  }});
  assert.equal(pair.admission.state,'conflict');
});

test('database file replacement is rejected both during capture and after admission',t=>{
  const f=fixture(t),replacement=join(f.dir,'replacement.sqlite');
  const replace=()=>{copyFileSync(f.db,replacement);renameSync(replacement,f.db);};
  const pair=readRemoteAccountBindingWithSnapshot({db:f.db,selfOpenId:SELF},{query:(...args)=>{const rows=readOnlySqliteJson(...args);replace();return rows;}});
  assert.equal(pair.snapshot,null);assert.equal(pair.admission.state,'unavailable');
  const a=admission(f);replace();assert.throws(()=>a.assertCurrent());
});

test('no-self local admission returns no account snapshot and does not claim remote verification',t=>{
  const f=fixture(t),seen=observedQuery(),a=captureLarkWriteAdmission(f.db,{}, {query:seen.query});seen.calls.length=0;
  assert.equal(a.assertCurrent(),null);assert.equal(a.fence.selfOpenId,null);
  assert.equal(seen.calls.length,0);
});

for(const mutation of ['source','scope','sent canonical']) {
  test(`unchanged transaction fence rejects ${mutation} changed after the last assertion`,t=>{
    const f=fixture(t),a=admission(f);a.assertCurrent();
    if(mutation==='source') f.exec("UPDATE sources SET enabled=0;");
    else if(mutation==='scope') f.exec("UPDATE sync_scopes SET config_json='{} '; ");
    else f.exec(`UPDATE records SET canonical_json=${q(JSON.stringify({sender_id:OTHER}))};`);
    assert.throws(()=>f.exec(`BEGIN IMMEDIATE;${larkWriteAdmissionSql(a.fence)} UPDATE sync_scopes SET name='After';COMMIT;`));
    assert.equal(sqliteQuery(f.db,'SELECT name FROM sync_scopes')[0].name,'Before');
  });
}

for(const state of ['empty','received only','runs only','cursor only','foreign source only','sent']) {
  test(`presence queries preserve original account decisions for ${state}`,t=>{
    const f=fixture(t);f.exec('DELETE FROM records;');
    if(state==='received only') f.exec(`INSERT INTO records VALUES('lark.im','received',${q(OTHER)},NULL);`);
    if(state==='runs only') f.exec("INSERT INTO sync_runs VALUES('lark.im'),('lark.im');");
    if(state==='cursor only') f.exec("UPDATE sync_scopes SET cursor_json='{}';");
    if(state==='foreign source only') f.exec("INSERT INTO sync_runs VALUES('other');INSERT INTO records VALUES('other','sent','ou_foreign',NULL);INSERT INTO sync_scopes VALUES('other','other',1,'{}','{}','Foreign');");
    if(state==='sent') f.exec(`INSERT INTO records VALUES('lark.im','sent',${q(SELF)},NULL),('lark.im','sent',${q(SELF)},NULL);`);
    let observed;
    const countQuery=(db,sql,label,deps)=>{
      observed=sql;
      const legacy=sql.replace(/EXISTS\(SELECT 1 FROM (records|sync_runs|sync_scopes) WHERE ([^)]*)\)/g,'(SELECT COUNT(*) FROM $1 WHERE $2)');
      assert.notEqual(legacy,sql);
      return readOnlySqliteJson(db,legacy,label,deps);
    };
    const fresh=readRemoteAccountBindingWithSnapshot({db:f.db,selfOpenId:SELF});
    const original=readRemoteAccountBindingWithSnapshot({db:f.db,selfOpenId:SELF},{query:countQuery});
    assert.deepEqual(fresh,original);
    assert.equal(fresh.snapshot.empty,['empty','foreign source only'].includes(state));
    assert.equal((observed.match(/EXISTS\(SELECT 1 FROM/g)||[]).length,3);
    assert.match(observed,/COUNT\(\*\) AS sent_records/);
    assert.match(observed,/COUNT\(DISTINCT actor_id\) AS sent_actors/);
    assert.equal(fresh.snapshot.sent_records,state==='sent'?2:0);
  });
}

for(const mutation of ['removed','malformed','foreign','same-account replacement']) {
  test(`sidecar ${mutation} during fresh account read cannot retain stale file proof`,t=>{
    const f=fixture(t);f.writeSidecar();let armed=false;
    const a=admission(f,{query:(...args)=>{
      const rows=readOnlySqliteJson(...args);
      if(armed) {
        armed=false;
        if(mutation==='removed') rmSync(f.sidecar);
        else if(mutation==='malformed') writeFileSync(f.sidecar,'{}');
        else if(mutation==='foreign') f.writeSidecar(OTHER);
        else f.writeSidecar(SELF);
      }
      return rows;
    }});
    armed=true;
    if(mutation==='same-account replacement') {
      assert.equal(a.assertCurrent().sent_actor,SELF);assert.equal(a.fence.sidecarVerified,true);
    } else assert.throws(()=>a.assertCurrent());
  });
}
