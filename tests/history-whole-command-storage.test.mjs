import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { commitBoundedReplayRecords, ensureInitialized, quoteSql, releaseMaintenanceLock, REVIEW_LIFETIME_MS,
  sqliteExec, sqliteQuery, upsertRecordsSql } from '../dist/storage/sqlite/ingestion-store.js';
import { BoundedReplayCleanupError } from '../dist/storage/sqlite/lark-ingestion.js';
import { initializeDatabase } from '../dist/storage/sqlite/initialize.js';
import { createReplayExecutionEvidence, readReplayExecutionEvidence } from '../dist/storage/sqlite/execution-evidence.js';

// Only authored databases and test-owned SQLite processes are used. No adapter,
// API lease, cooldown root or user configuration is involved in this storage seam.
const START = Date.parse('2042-02-03T04:00:00.000Z');
const CHAT = 'oc_synthetic_command_storage';
const SCOPE = `lark.im.received.chat.${CHAT}`;
const SOURCE_CONFIG = JSON.stringify({ initial_sync_start_ms: START });
const SCOPE_CONFIG = JSON.stringify({ chat_id: CHAT, chat_type: 'group' });
const hash = value => createHash('sha256').update(value).digest('hex');
const read = (db, sql) => sqliteQuery(db, sql, 'inspect synthetic storage');

function record(version = 100) {
  const raw = JSON.stringify({ message_id: 'om_synthetic_command_storage', chat_id: CHAT, msg_type: 'text',
    create_time: String(START + 1000), update_time: String(START + version),
    sender: { id: 'ou_synthetic_command_author', id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: `Synthetic storage body ${version}` }) } });
  return { source_id: 'lark.im', first_seen_scope_id: SCOPE, external_id: 'om_synthetic_command_storage',
    external_version: String(version), record_type: 'lark.im.message', occurred_at: new Date(START + 1000).toISOString(),
    occurred_at_ms: START + 1000, actor_id: 'ou_synthetic_command_author', container_id: CHAT,
    direction: 'received', title: null, body: `Synthetic storage body ${version}`, content_hash: hash(raw), raw_json: raw,
    canonical_json: JSON.stringify({ source_api: 'im.v1.messages', sender_id: 'ou_synthetic_command_author',
      sender_id_type: 'open_id', chat_id: CHAT, chat_type: 'group', msg_type: 'text', text: `Synthetic storage body ${version}` }) };
}

function fixture(t, initialize = ensureInitialized) {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-history-storage-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite');
  initialize(db);
  sqliteExec(db, `UPDATE sources SET config_json=${quoteSql(SOURCE_CONFIG)} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${quoteSql(SCOPE)},'lark.im','Synthetic budget scope',${quoteSql(SCOPE_CONFIG)});
    ${upsertRecordsSql([record()])}`, 'seed synthetic command storage');
  const before = read(db, 'SELECT * FROM records;');
  const scope = { id: SCOPE, source_id: 'lark.im', enabled: 1, config_json: SCOPE_CONFIG };
  return { db, before, scope };
}

function options(f, overrides = {}) {
  return { scope: f.scope, initialSyncStartMs: START, startMs: START, endMs: START + 60_000,
    planId: '1'.repeat(64), attemptId: 'synthetic-command-attempt', selfIdHash: '2'.repeat(64),
    pages: 1, fetchedCount: 1, records: [record(101)], ...overrides };
}

function historyInput(f, attempt) {
  const now=Date.now(),before=read(f.db,'SELECT * FROM records ORDER BY id;');
  const progress=read(f.db,`SELECT * FROM lark_im_history_progress WHERE scope_id=${quoteSql(f.scope.id)};`)[0];
  const generation=read(f.db,`SELECT generation FROM record_observation_state WHERE record_id=${before[0].id};`)[0].generation;
  return options(f,{records:[record()],attemptId:attempt,executionBudget:budget(),
    executionEvidence:createReplayExecutionEvidence(attempt,'a'.repeat(64)),
    observationAcquisition:{attempt,startedAtMs:now,basis:new Map([[record().external_id,generation]]),confirm:true,contextKey:'3'.repeat(64)},
    reviewFence:{createdAtMs:now,expiresAtMs:now+REVIEW_LIFETIME_MS,sourceConfigJson:SOURCE_CONFIG,sentActor:null,
      records:before,scopes:[f.scope]},
    history:{generation:progress?.generation||0,afterId:progress?.after_id||0,sweepMaxId:progress?.sweep_max_id||0,
      completedSweeps:progress?.completed_sweeps||0,selectedId:before[0].id,nextSweepMaxId:before[0].id,
      startedAtMs:now,error:null,requestBudget:{}}});
}

test('marked history receipts retain newest 64 plus all current references and never evict unmarked manual audits',t=>{
  const f=fixture(t),manual=commitBoundedReplayRecords(f.db,options(f,{records:[record()]}));
  const audits=[];
  for(let i=0;i<70;i++) {
    const input=historyInput(f,`invented-retention-${i}`),r=commitBoundedReplayRecords(f.db,input);audits.push(r.audit_id);
    assert.equal(readReplayExecutionEvidence(input.executionEvidence).receipt_validated,true);
    if(i===0)sqliteExec(f.db,`INSERT INTO lark_im_history_scheduler(id,generation,priority_streak,last_attempt_id,last_result_json,fair_round)
      VALUES(1,1,0,'invented-retained-scheduler',${quoteSql(JSON.stringify({effects:{audit_id:r.audit_id}}))},0);`,'retain scheduler audit');
    if(i===1)sqliteExec(f.db,`INSERT INTO lark_im_history_debt(record_id,scope_id,finding_key,database_key,account_key,context_fingerprint,debt_fingerprint,debts_json,enqueued_at_ms,sample_checked_at_ms,last_result_json)
      VALUES(${f.before[0].id},${quoteSql(SCOPE)},'invented-finding','invented-db','invented-account','invented-context','invented-debt','{}',0,0,${quoteSql(JSON.stringify({effects:{audit_id:r.audit_id}}))});`,'retain debt audit');
    if(i===2)sqliteExec(f.db,`INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES('invented-reference-scope','lark.im','Invented reference','{}');
      INSERT INTO lark_im_history_progress(scope_id,generation,sweep_max_id,after_id,last_attempt_at_ms,last_attempt_id,last_result_json,completed_sweeps)
      VALUES('invented-reference-scope',1,1,1,0,'invented-retained-progress',${quoteSql(JSON.stringify({effects:{audit_id:r.audit_id}}))},0);`,'retain progress audit');
    // Insertion order, not a wall clock or same-millisecond tie, drives eviction.
    sqliteExec(f.db,`UPDATE bounded_replay_runs SET finished_at='2042-01-01T00:00:00.000Z' WHERE id=${quoteSql(r.audit_id)};`,'invented tied clocks');
  }
  const rows=read(f.db,'SELECT id,history_record_id,history_fence_hash FROM bounded_replay_runs ORDER BY rowid;');
  assert.equal(rows.length,68);assert.equal(rows[0].id,manual.audit_id);assert.equal(rows[0].history_record_id,null);
  assert.deepEqual(rows.filter(r=>r.history_record_id!==null).map(r=>r.id),[...audits.slice(0,3),...audits.slice(-64)]);
  assert.ok(rows.filter(r=>r.history_record_id!==null).every(r=>/^[a-f0-9]{64}$/.test(r.history_fence_hash)));
  // A null reference cannot poison NOT IN and retain an unbounded tail.
  sqliteExec(f.db,"UPDATE lark_im_history_scheduler SET last_result_json=NULL; UPDATE lark_im_history_debt SET last_result_json=NULL; UPDATE lark_im_history_progress SET last_result_json=NULL WHERE scope_id='invented-reference-scope';",'retire invented reference');
  const next=commitBoundedReplayRecords(f.db,historyInput(f,'invented-retention-next'));
  const after=read(f.db,'SELECT id FROM bounded_replay_runs WHERE history_record_id IS NOT NULL ORDER BY rowid;');
  assert.deepEqual(after.map(r=>r.id),[...audits.slice(-63),next.audit_id]);
  assert.equal(read(f.db,`SELECT COUNT(*) n FROM bounded_replay_runs WHERE id=${quoteSql(manual.audit_id)};`)[0].n,1);
});

test('idempotent replay validates the actual target/fence/effects audit without an additional SQL call',t=>{
  const f=fixture(t),input=historyInput(f,'invented-idempotent-receipt');
  const effects=commitBoundedReplayRecords(f.db,input);assert.equal(readReplayExecutionEvidence(input.executionEvidence).receipt_validated,true);
  const again={...input,executionBudget:budget(),executionEvidence:createReplayExecutionEvidence(input.attemptId,'a'.repeat(64))};
  let calls=0;
  const replay=withSpawn((run,...args)=>{calls++;return run(...args)},()=>commitBoundedReplayRecords(f.db,again));
  assert.deepEqual(replay,effects);assert.equal(calls,1);assert.equal(readReplayExecutionEvidence(again.executionEvidence).receipt_validated,true);
  const row=read(f.db,'SELECT last_result_json FROM lark_im_history_progress;')[0],saved=JSON.parse(row.last_result_json);
  for(const mutation of ['forged_effect','missing_audit','wrong_fence','legacy_marker']) {
    sqliteExec(f.db,`UPDATE lark_im_history_progress SET last_result_json=${quoteSql(row.last_result_json)};`,'restore authored receipt');
    sqliteExec(f.db,`UPDATE bounded_replay_runs SET history_record_id=${f.before[0].id},history_fence_hash=${quoteSql(saved.history_key)} WHERE id=${quoteSql(effects.audit_id)};`,'restore authored fence');
    if(mutation==='forged_effect')sqliteExec(f.db,"UPDATE lark_im_history_progress SET last_result_json=json_set(last_result_json,'$.effects.updated',7);",'corrupt invented receipt');
    if(mutation==='missing_audit')sqliteExec(f.db,"UPDATE lark_im_history_progress SET last_result_json=json_set(last_result_json,'$.effects.audit_id','00000000-0000-0000-0000-000000000000');",'invent missing audit');
    if(mutation==='wrong_fence')sqliteExec(f.db,"UPDATE bounded_replay_runs SET history_fence_hash='invalid';",'invent wrong fence');
    if(mutation==='legacy_marker')sqliteExec(f.db,"UPDATE bounded_replay_runs SET history_record_id=NULL,history_fence_hash=NULL;",'simulate unmarked legacy audit');
    const token=createReplayExecutionEvidence(input.attemptId,'a'.repeat(64));
    const replay=()=>commitBoundedReplayRecords(f.db,{...input,executionBudget:budget(),executionEvidence:token});
    if(mutation==='legacy_marker')replay();else assert.throws(replay,/history receipt audit mismatch/);
    assert.equal(readReplayExecutionEvidence(token).receipt_validated,false,mutation);
    assert.equal(readReplayExecutionEvidence(token).commit_state,'unknown',mutation);
  }
});

test('025 preserves predecessor rows and permits rollback-era explicit audit reads and writes',t=>{
  const directory=mkdtempSync(join(tmpdir(),'invented-receipt-migration-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const migrations=join(directory,'migrations');mkdirSync(migrations);
  const current=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(current))if(name.endsWith('.sql')&&!name.startsWith('025_'))copyFileSync(new URL(name,current),join(migrations,name));
  const f=fixture(t,db=>initializeDatabase(db,{migrationsDir:migrations}));
  const columns='id,plan_id,attempt_id,source_id,scope_id,initial_sync_start_ms,window_start_ms,window_end_ms,self_id_hash,page_count,fetched_count,candidate_count,inserted_count,updated_count,duplicate_count,conflict_count,finished_at';
  const oldInsert=id=>`INSERT INTO bounded_replay_runs(${columns}) VALUES(${quoteSql(id)},'invented-manual-plan','invented-manual-attempt','lark.im',${quoteSql(SCOPE)},${START},${START},${START+10000},'invented-self',1,0,0,0,0,0,0,'2042-02-03T04:00:00.000Z');`;
  sqliteExec(f.db,oldInsert('invented-old-audit'),'seed old unmarked audit');
  const before=read(f.db,`SELECT ${columns} FROM bounded_replay_runs;`),records=read(f.db,'SELECT * FROM records;');
  initializeDatabase(f.db);
  assert.deepEqual(read(f.db,`SELECT ${columns} FROM bounded_replay_runs;`),before);
  assert.deepEqual(read(f.db,'SELECT * FROM records;'),records);
  assert.deepEqual(read(f.db,'SELECT history_record_id,history_fence_hash FROM bounded_replay_runs;'),[{history_record_id:null,history_fence_hash:null}]);
  sqliteExec(f.db,oldInsert('invented-rollback-audit'),'rollback-era explicit-column write');
  assert.equal(read(f.db,'SELECT COUNT(*) n FROM bounded_replay_runs WHERE history_record_id IS NULL;')[0].n,2);
  const newReceipt=commitBoundedReplayRecords(f.db,historyInput(f,'invented-upgraded-attempt'));
  assert.equal(read(f.db,`SELECT history_record_id FROM bounded_replay_runs WHERE id=${quoteSql(newReceipt.audit_id)};`)[0].history_record_id,f.before[0].id);
  assert.equal(read(f.db,'PRAGMA foreign_key_check;').length,0);
});

// The storage contract is structural. This fixture consumes real monotonic time
// and reserves cleanup within one original grant; it never freezes or extends it.
function budget(totalMs = 5000, reserveMs = 500) {
  const deadline = performance.now() + totalMs;
  let cleaning = false, cleanups = 0;
  const calls = [];
  const left = () => Math.floor(deadline - (cleaning ? 0 : reserveMs) - performance.now());
  const assertReady = () => { if (left() <= 0) throw new Error('synthetic command deadline exhausted'); };
  return { calls, get cleanups() { return cleanups; },
    assertReady,
    timeoutMs(capMs = 30_000) { assertReady(); const value = Math.min(capMs, left());
      assert.ok(value > 0); calls.push({ value, capMs, cleaning }); return value; },
    runCleanup(work) { const before = cleaning; cleaning = true; cleanups += 1;
      try { assertReady(); return work(); } finally { cleaning = before; } },
  };
}

function withSpawn(observer, work) {
  const original = childProcess.spawnSync;
  childProcess.spawnSync = (command, args, settings) => observer(original, command, args, settings);
  syncBuiltinESMExports();
  try { return work(); }
  finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
}

function assertNoCommit(f) {
  assert.deepEqual(read(f.db, 'SELECT * FROM records;'), f.before);
  assert.equal(read(f.db, 'SELECT COUNT(*) AS n FROM bounded_replay_runs;')[0].n, 0);
}

function assertUnlocked(f) {
  assert.deepEqual(read(f.db, 'SELECT * FROM maintenance_locks;'), []);
}

async function holdExclusive(t, db) {
  // Rollback journal mode makes the authored exclusive writer block reads too.
  sqliteExec(db, 'PRAGMA journal_mode=DELETE;', 'select synthetic lock mode');
  const holder = spawn('python3', ['-I', '-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute('BEGIN EXCLUSIVE')
print('synthetic-ready',flush=True)
sys.stdin.read(); c.rollback(); c.close()`, db], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (holder.exitCode === null) holder.kill('SIGKILL'); });
  const ready = await Promise.race([
    once(holder.stdout, 'data', { signal: AbortSignal.timeout(3000) }),
    once(holder, 'exit').then(() => { throw new Error('synthetic holder exited before admission'); }),
  ]);
  assert.equal(String(ready[0]).trim(), 'synthetic-ready');
  return async () => { const exited = once(holder, 'exit'); holder.stdin.end();
    assert.deepEqual(await exited, [0, null]); };
}

test('SQLite keeps the exact no-budget invocation and bounds opt-in process and busy timeouts', t => {
  const f = fixture(t), seen = [];
  const result = withSpawn((run, command, args, settings) => {
    seen.push({ command, args, settings }); return run(command, args, settings);
  }, () => [sqliteQuery(f.db, 'SELECT 7 AS value;', 'legacy'),
    sqliteQuery(f.db, 'SELECT 7 AS value;', 'bounded', budget(1000, 100))]);
  assert.deepEqual(result, [[{ value: 7 }], [{ value: 7 }]]);
  assert.equal(seen[0].settings.input, '.bail on\n.timeout 5000\nPRAGMA foreign_keys = ON;\nSELECT 7 AS value;');
  assert.equal(Object.hasOwn(seen[0].settings, 'timeout'), false);
  assert.equal(Object.hasOwn(seen[0].settings, 'killSignal'), false);
  assert.ok(seen[1].settings.timeout > 0 && seen[1].settings.timeout <= 900);
  assert.equal(seen[1].settings.killSignal, 'SIGKILL');
  assert.equal(seen[1].settings.input.split('\n')[1], `.timeout ${seen[1].settings.timeout}`);
  assertNoCommit(f);
});

test('invalid budget timeouts never become unbounded SQLite children', t => {
  const f = fixture(t);
  for (const value of [0, -1, NaN, Infinity, undefined, 0.5]) {
    let spawned = false;
    withSpawn(() => { spawned = true; throw new Error('forbidden spawn'); }, () => {
      assert.throws(() => sqliteExec(f.db, 'DELETE FROM records;', 'invalid budget', {
        assertReady() {}, timeoutMs() { return value; }, runCleanup(work) { return work(); },
      }), /positive integer timeout/);
    });
    assert.equal(spawned, false);
  }
  assertNoCommit(f);
});

test('a real blocked read consumes its current remainder without modifying the database', async t => {
  const f = fixture(t), release = await holdExclusive(t, f.db), started = performance.now();
  try { assert.throws(() => sqliteQuery(f.db, 'SELECT * FROM records;', 'bounded blocked read', budget(500, 150)),
    /bounded blocked read failed|deadline exhausted/); }
  finally { await release(); }
  assert.ok(performance.now() - started < 2000, 'the old five-second busy wait is not retained');
  assertNoCommit(f); assertUnlocked(f);
});

test('native observation preparation is bounded before maintenance-lock acquisition', async t => {
  const f = fixture(t), release = await holdExclusive(t, f.db), b = budget(500, 150);
  try { assert.throws(() => commitBoundedReplayRecords(f.db, options(f, { executionBudget: b })),
    /read observation basis failed|deadline exhausted/); }
  finally { await release(); }
  assert.equal(b.cleanups, 0, 'no maintenance acquisition has been attempted');
  assertNoCommit(f); assertUnlocked(f);
});

test('history receipt, observation read, preflight, acquire, commit and release share one budget', t => {
  const f = fixture(t), b = budget(), now = Date.now(), seen = [];
  const generation = read(f.db, 'SELECT generation FROM record_observation_state;')[0].generation;
  const input = options(f, { records: [record()], executionBudget: b,
    observationAcquisition: { attempt: 'synthetic-command-attempt', startedAtMs: now,
      basis: new Map([[record().external_id, generation]]), confirm: true, contextKey: '3'.repeat(64) },
    reviewFence: { createdAtMs: now - 1000, expiresAtMs: now - 1000 + REVIEW_LIFETIME_MS,
      sourceConfigJson: SOURCE_CONFIG, sentActor: null, records: f.before, scopes: [f.scope] },
    history: { generation: 0, afterId: 0, sweepMaxId: 0, completedSweeps: 0, selectedId: f.before[0].id,
      nextSweepMaxId: f.before[0].id, startedAtMs: now, error: null, requestBudget: {} },
  });
  const result = withSpawn((run, command, args, settings) => {
    seen.push(settings); return run(command, args, settings);
  }, () => commitBoundedReplayRecords(f.db, input));
  assert.equal(result.duplicate, 1);
  assert.equal(seen.length, 6);
  assert.match(seen[0].input, /SELECT last_attempt_id,last_result_json/);
  assert.match(seen[1].input, /observation_generation/);
  assert.match(seen[2].input, /PRAGMA query_only=ON/);
  assert.match(seen[3].input, /INSERT OR IGNORE INTO maintenance_locks/);
  assert.match(seen[4].input, /INSERT INTO bounded_replay_runs/);
  assert.match(seen[5].input, /DELETE FROM maintenance_locks[\s\S]*AND owner =/);
  assert.equal(b.calls.length, 6);
  assert.equal(b.calls[2].capMs, 5000);
  assert.deepEqual(b.calls.map(call => call.cleaning), [false, false, false, false, false, true]);
  assert.deepEqual(seen.map(settings => settings.timeout), b.calls.map(call => call.value));
  assert.equal(b.cleanups, 1); assertUnlocked(f);
  assert.deepEqual(commitBoundedReplayRecords(f.db, { ...input, executionBudget: budget() }), result,
    'same history acquisition remains a receipt-only idempotent read');
  const failure = commitBoundedReplayRecords(f.db, { ...input, executionBudget: budget(), records: [], fetchedCount: 0,
    attemptId: 'synthetic-failed-history-attempt',
    observationAcquisition: { ...input.observationAcquisition, attempt: 'synthetic-failed-history-attempt' },
    history: { ...input.history, generation: 1, afterId: f.before[0].id, sweepMaxId: f.before[0].id,
      completedSweeps: 1, error: 'incomplete' },
  });
  assert.deepEqual([failure.inserted, failure.updated, failure.duplicate, failure.conflicts], [0, 0, 0, 0],
    'an audited zero-record failed history attempt has a valid zero-sum receipt');
  assert.equal(read(f.db, `SELECT candidate_count FROM bounded_replay_runs WHERE id=${quoteSql(failure.audit_id)};`)[0].candidate_count, 0);
  assert.equal(read(f.db, 'SELECT history_error FROM record_observation_state;')[0].history_error, 'incomplete');
  assertUnlocked(f);
});

test('a real slow commit times out and rolls back records and audit while reserved cleanup releases its lock', t => {
  const f = fixture(t);
  sqliteExec(f.db, `CREATE TRIGGER synthetic_slow_update BEFORE UPDATE ON records BEGIN
    SELECT sum(n) FROM (WITH RECURSIVE sequence(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM sequence WHERE n<1000000000)
      SELECT n FROM sequence); END;`, 'install synthetic slow transaction');
  const b = budget(1500, 800), started = performance.now();
  assert.throws(() => commitBoundedReplayRecords(f.db, options(f, { executionBudget: b })), /commit bounded replay failed/);
  assert.ok(performance.now() - started < 2500);
  assert.equal(b.cleanups, 1); assertNoCommit(f); assertUnlocked(f);
});

test('work expiry before commit uses the original grant cleanup reserve and never commits late', t => {
  const f = fixture(t), b = budget(1000, 800);
  assert.throws(() => commitBoundedReplayRecords(f.db, options(f, { executionBudget: b,
    reviewBeforeCommit() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 220); },
  })), /deadline exhausted/);
  assert.equal(b.cleanups, 1); assert.ok(b.calls.at(-1).cleaning);
  assertNoCommit(f); assertUnlocked(f);
});

test('an unknown acquisition outcome still cleans only its own possibly committed lock', t => {
  const f = fixture(t), b = budget();
  withSpawn((run, command, args, settings) => {
    const result = run(command, args, settings);
    if (settings.input.includes('INSERT OR IGNORE INTO maintenance_locks')) {
      assert.equal(result.status, 0);
      return { ...result, status: null, error: Object.assign(new Error('synthetic lost acquire outcome'), { code: 'ETIMEDOUT' }) };
    }
    return result;
  }, () => assert.throws(() => commitBoundedReplayRecords(f.db, options(f, { executionBudget: b })), /synthetic lost acquire outcome/));
  assert.equal(b.cleanups, 1); assertNoCommit(f); assertUnlocked(f);
});

test('a missing successful acquire receipt is unknown and cannot strand its committed owner', t => {
  const f = fixture(t), b = budget();
  withSpawn((run, command, args, settings) => {
    const answer = run(command, args, settings);
    if (settings.input.includes('INSERT OR IGNORE INTO maintenance_locks')) {
      assert.equal(answer.status, 0); return { ...answer, stdout: '[]' };
    }
    return answer;
  }, () => assert.throws(() => commitBoundedReplayRecords(f.db, options(f, { executionBudget: b })), /acquire maintenance lock returned invalid evidence/));
  assert.equal(b.cleanups, 1); assertNoCommit(f); assertUnlocked(f);
});

test('parseable commit stdout with an unknown child outcome never becomes reported success', t => {
  const f = fixture(t), b = budget();
  withSpawn((run, command, args, settings) => {
    const result = run(command, args, settings);
    if (settings.input.includes('INSERT INTO bounded_replay_runs')) {
      assert.equal(result.status, 0); assert.ok(JSON.parse(result.stdout)[0].audit_id);
      return { ...result, status: null, signal: 'SIGKILL' };
    }
    return result;
  }, () => assert.throws(() => commitBoundedReplayRecords(f.db, options(f, { executionBudget: b })), /commit bounded replay failed/));
  assert.equal(read(f.db, 'SELECT COUNT(*) AS n FROM bounded_replay_runs;')[0].n, 1,
    'an unknown result does not prove that the transaction rolled back');
  assert.equal(read(f.db, 'SELECT body FROM records;')[0].body, record(101).body);
  assertUnlocked(f);
});

test('known committed effects survive work cutoff at child return and prohibit a subsequent write', t => {
  const f = fixture(t), clock = budget();
  let stopped = false, cleaning = false, transactions = 0;
  const assertReady = () => { if (stopped && !cleaning) throw new Error('synthetic work cutoff'); clock.assertReady(); };
  const b = { assertReady, timeoutMs(cap) { assertReady(); return clock.timeoutMs(cap); },
    runCleanup(work) { return clock.runCleanup(() => { cleaning = true;
      try { return work(); } finally { cleaning = false; } }); } };
  const result = withSpawn((run, command, args, settings) => {
    const answer = run(command, args, settings);
    if (settings.input.includes('INSERT INTO bounded_replay_runs')) {
      assert.equal(answer.status, 0); stopped = true; transactions += 1;
    }
    return answer;
  }, () => {
    const effects = commitBoundedReplayRecords(f.db, options(f, { executionBudget: b }));
    assert.throws(() => sqliteExec(f.db, 'DELETE FROM records;', 'forbidden next write', b), /work cutoff/);
    return effects;
  });
  assert.equal(result.updated, 1); assert.equal(transactions, 1); assert.equal(clock.cleanups, 1);
  assert.equal(read(f.db, 'SELECT id FROM bounded_replay_runs;')[0].id, result.audit_id);
  assert.equal(read(f.db, 'SELECT body FROM records;')[0].body, record(101).body); assertUnlocked(f);
});

test('malformed successful receipts cannot manufacture trusted committed cleanup effects', t => {
  const f = fixture(t);
  for (const mutate of [row => { row.audit_id = 'synthetic-unrelated-audit'; },
    row => { row.duplicate = '1'; }, row => { row.updated = -1; }, row => { row.inserted = 7; }]) {
    withSpawn((run, command, args, settings) => {
      const answer = run(command, args, settings);
      if (settings.input.includes('INSERT INTO bounded_replay_runs')) {
        assert.equal(answer.status, 0); const rows = JSON.parse(answer.stdout); mutate(rows[0]);
        return { ...answer, stdout: JSON.stringify(rows) };
      }
      return answer;
    }, () => assert.throws(() => commitBoundedReplayRecords(f.db, options(f, { executionBudget: budget() })), error => {
      assert.equal(error instanceof BoundedReplayCleanupError, false);
      assert.match(error.message, /invalid evidence/); return true;
    }));
    assertUnlocked(f);
  }
  assert.equal(read(f.db, 'SELECT COUNT(*) AS n FROM bounded_replay_runs;')[0].n, 4,
    'invalid receipts remain unknown even though these authored transactions committed');
});

for (const primaryFails of [false, true]) test(`release failure is visible and preserves primary failure: ${primaryFails}`, t => {
  const f = fixture(t), primary = new Error('synthetic primary failure');
  sqliteExec(f.db, `CREATE TRIGGER synthetic_release_denied BEFORE DELETE ON maintenance_locks
    BEGIN SELECT RAISE(ABORT,'synthetic release failure'); END;`, 'install synthetic release failure');
  assert.throws(() => commitBoundedReplayRecords(f.db, options(f, { executionBudget: budget(),
    reviewBeforeCommit() { if (primaryFails) throw primary; },
  })), error => {
    if (primaryFails) { assert.ok(error instanceof AggregateError); assert.equal(error.cause, primary);
      assert.equal(error.errors[0], primary); assert.match(error.errors[1].message, /synthetic release failure/); }
    else {
      assert.ok(error instanceof BoundedReplayCleanupError);
      assert.match(error.cause.message, /synthetic release failure/);
      assert.equal(error.committedEffects.updated, 1); assert.ok(Object.isFrozen(error.committedEffects));
      assert.equal(read(f.db, 'SELECT id FROM bounded_replay_runs;')[0].id, error.committedEffects.audit_id);
    }
    return true;
  });
  assert.equal(read(f.db, 'SELECT COUNT(*) AS n FROM maintenance_locks;')[0].n, 1);
  if (primaryFails) assertNoCommit(f);
  else assert.equal(read(f.db, 'SELECT COUNT(*) AS n FROM bounded_replay_runs;')[0].n, 1,
    'cleanup failure cannot be described as a complete rollback');
});

test('fully expired cleanup performs no deletion and preserves both failures', t => {
  const f = fixture(t), b = budget(500, 250);
  assert.throws(() => commitBoundedReplayRecords(f.db, options(f, { executionBudget: b,
    reviewBeforeCommit() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 520); },
  })), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    for (const item of error.errors) assert.match(item.message, /deadline exhausted/);
    return true;
  });
  assertNoCommit(f);
  assert.equal(read(f.db, 'SELECT COUNT(*) AS n FROM maintenance_locks;')[0].n, 1,
    'no extra deadline is created to erase the lock');
});

test('cleanup never deletes a replacement owner and no-budget replay still commits normally', t => {
  const f = fixture(t), primary = new Error('synthetic replaced lock');
  assert.throws(() => commitBoundedReplayRecords(f.db, options(f, { executionBudget: budget(),
    reviewBeforeCommit() { sqliteExec(f.db, "UPDATE maintenance_locks SET owner='synthetic replacement owner';", 'replace synthetic owner'); throw primary; },
  })), error => error === primary);
  assertNoCommit(f);
  assert.equal(read(f.db, 'SELECT owner FROM maintenance_locks;')[0].owner, 'synthetic replacement owner');
  releaseMaintenanceLock(f.db, 'synthetic replacement owner');
  const result = commitBoundedReplayRecords(f.db, options(f));
  assert.equal(result.updated, 1); assert.equal(result.conflicts, 0);
  assert.equal(read(f.db, 'SELECT body FROM records;')[0].body, record(101).body);
  assertUnlocked(f);
});
