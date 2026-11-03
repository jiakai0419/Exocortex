import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureInitialized, INITIAL_ACCOUNT_KIND, quoteSql as q, sqliteExec, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';
import { syncReadiness } from '../src/diagnostics/message-readiness-sync.mjs';
import { normalizeReadinessObservation } from '../src/diagnostics/readiness-observer-result.mjs';
import { getLarkApiLeaseStdio, tryAcquireLarkApiLease } from '../src/runtime/lark-api-lease.mjs';

// Entirely invented records and private test-owned flock. The real observer,
// reader, account fences, ledger and SQLite transactions run without any API.
const SELF = { open_id: 'ou_invented_observer_budget_owner' };
const ACCOUNT = createHash('sha256').update(`lark.im\0${SELF.open_id}`).digest('hex');
const NOW = Date.parse('2044-03-04T05:06:00.000Z');
const FRAME = '__EXOCORTEX_JSON_LINES_BEGIN_V1__';
const inspect = (db, sql) => sqliteQuery(db, sql, 'inspect invented observer budget');
const isDomain = input => input.includes('CREATE TEMP TABLE __enrichment_effects');
const isFinish = input => isDomain(input) && input.includes('last_scanned_count=');
const isClaim = input => isDomain(input) && !isFinish(input);
const isRelease = input => /DELETE FROM maintenance_locks\s+WHERE name = 'global'\s+AND owner/.test(input);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'invented-readiness-budget-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'invented.sqlite'); ensureInitialized(db);
  const raw = { message_id: 'om_invented_observer_budget', chat_id: 'oc_invented_observer_budget',
    chat_type: 'group', chat_name: 'Invented Budget Group', msg_type: 'text', create_time: String(NOW - 1000),
    sender: { id: 'ou_invented_observer_budget_actor', id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: 'Invented unchanged body.' }) }, padding: 'x'.repeat(128 * 1024) };
  const canonical = { message_id: raw.message_id, chat_id: raw.chat_id, chat_type: 'group', chat_name: raw.chat_name,
    chat_name_source: 'message', sender_id: raw.sender.id, sender_id_type: 'open_id', sender_type: 'user', msg_type: 'text' };
  const binding = { initial_account_binding: { kind: INITIAL_ACCOUNT_KIND, account_key: ACCOUNT,
    reserved_at: '2025-01-01T00:00:00.000Z', confirmed_at: '2025-01-01T00:00:00.000Z' } };
  sqliteExec(db, `UPDATE sources SET config_json=${q(JSON.stringify(binding))} WHERE id='lark.im';
    INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,record_type,occurred_at,occurred_at_ms,
      actor_id,container_id,direction,body,canonical_json,raw_json)
    VALUES(1,'lark.im','lark.im.sent_by_me',${q(raw.message_id)},'1','lark.im.message',${q(new Date(NOW - 1000).toISOString())},
      ${NOW - 1000},${q(raw.sender.id)},${q(raw.chat_id)},'received','Invented unchanged body.',${q(JSON.stringify(canonical))},${q(JSON.stringify(raw))});`);
  const records = inspect(db, 'SELECT * FROM records;');
  return { db, directory, records, tick: 0, calls: [],
    scan: () => inspect(db, 'SELECT * FROM lark_im_message_readiness_scan;'),
    observations: () => inspect(db, 'SELECT * FROM lark_im_message_readiness;'),
    locks: () => inspect(db, 'SELECT * FROM maintenance_locks;') };
}

function run(f, fault = null, clock = () => f.tick) {
  const lease = tryAcquireLarkApiLease({ role: 'sync' }, { directory: join(f.directory, 'private-api') });
  assert.equal(lease.state, 'acquired'); assert(getLarkApiLeaseStdio());
  const original = childProcess.spawnSync;
  childProcess.spawnSync = (command, args, settings) => {
    assert.equal(command, 'sqlite3', 'observer must not spawn APIs or other processes');
    const input = String(settings.input || '');
    assert(Number.isSafeInteger(settings.timeout) && settings.timeout > 0 && settings.timeout <= 5000);
    assert.equal(settings.killSignal, 'SIGKILL');
    const call = { input, args, timeout: settings.timeout, tick: f.tick };
    f.calls.push(call);
    const execute = () => original(command, args, settings);
    return fault ? fault(call, execute, original, lease) : execute();
  };
  syncBuiltinESMExports();
  try {
    const result = syncReadiness(f.db, SELF, { now: () => NOW, monotonicNow: clock });
    assert.deepEqual(normalizeReadinessObservation(result), result, 'all receipts pass the shared closed schema');
    assert(!JSON.stringify(result).includes('invented'), 'no source, owner, SQL or exception text in receipt');
    return result;
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); lease.release(); }
}

test('the actual observer bounds admission/claim/framed reads/finish/releases with one fresh five-second budget', t => {
  const f = fixture(t);
  const result = run(f, (call, execute) => { const value = execute(); f.tick += 10; return value; });
  assert.equal(result.reason, 'observed'); assert.equal(result.observed, 1);
  assert.equal(result.claim_state, 'confirmed'); assert.equal(result.finish_state, 'confirmed');
  assert.equal(result.cleanup_state, 'succeeded'); assert.equal(result.command_budget.max_ms, 5000);
  assert.equal(result.command_budget.stop_reason, null);
  assert(f.calls.length > 10); assert.equal(f.calls[0].timeout, 4000);
  for (const call of f.calls) assert.equal(call.timeout, 5000 - call.tick - (isRelease(call.input) ? 100 : 1000));
  const frames = f.calls.filter(call => call.input.includes(FRAME));
  assert.equal(frames.length, 1); assert(frames[0].args.includes('-list')); assert(!frames[0].args.includes('-json'));
  assert.equal(f.calls.filter(call => isDomain(call.input)).length, 2);
  assert.equal(f.calls.filter(call => isRelease(call.input)).length, 2);
  assert.deepEqual(inspect(f.db, 'SELECT * FROM records;'), f.records); assert.equal(f.locks().length, 0);
});

test('an exhausted admission starts no second read and never falls back to a thirty-second default', t => {
  const f = fixture(t);
  const result = run(f, (_call, execute) => { const value = execute(); f.tick = 4001; return value; });
  assert.equal(f.calls.length, 1); assert.equal(result.diagnostic.stage, 'admission');
  assert.equal(result.diagnostic.kind, 'time_budget'); assert.equal(result.claim_state, 'not_started');
  assert.equal(result.command_budget.stop_reason, 'time_budget'); assert.equal(f.scan().length, 0);
});

test('the required admission recheck preserves a reader error swallowed by the account inspector', t => {
  const f = fixture(t); let acquired = false, injected = false;
  const result = run(f, (call, execute) => {
    if (acquired && !injected && call.args.includes('-readonly')) {
      injected = true;
      return { status: 1, stdout: '', stderr: 'invented unavailable account read' };
    }
    const value = execute();
    if (call.input.includes('INSERT OR IGNORE INTO maintenance_locks')) acquired = true;
    return value;
  });
  assert(injected); assert.equal(result.claim_state, 'not_started');
  assert.equal(result.diagnostic.stage, 'claim'); assert.equal(result.diagnostic.kind, 'sqlite_read');
  assert.equal(result.cleanup_state, 'succeeded');
  assert.equal(f.calls.filter(call => isDomain(call.input)).length, 0); assert.equal(f.locks().length, 0);
});

for (const mode of ['throw', 'nonfinite', 'reversed']) test(`invalid observer clock ${mode} cannot start a database child`, t => {
  const f = fixture(t); let calls = 0;
  const result = run(f, null, () => { calls++; if (mode === 'throw') throw new Error('invented clock secret');
    return mode === 'nonfinite' ? NaN : calls === 1 ? 10 : 9; });
  assert.equal(f.calls.length, 0); assert.equal(result.diagnostic.kind, 'clock_unavailable');
  assert.equal(result.command_budget.complete, false); assert.equal(result.command_budget.stop_reason, 'clock_unavailable');
});

test('the framed read timeout retains safe read evidence after a confirmed claim', t => {
  const f = fixture(t);
  const result = run(f, (call, execute) => call.input.includes(FRAME)
    ? { status: null, error: Object.assign(new Error('invented payload must remain private'), { code: 'ETIMEDOUT' }), stdout: '', stderr: 'invented private stderr' }
    : execute());
  assert.equal(result.reason, 'observation_failed'); assert.equal(result.claim_state, 'confirmed');
  assert.equal(result.diagnostic.stage, 'read'); assert.equal(result.diagnostic.kind, 'sqlite_read');
  assert.equal(result.diagnostic.read.kind, 'timeout'); assert.equal(result.observed, 0);
  assert.equal(result.finish_state, 'confirmed'); assert.equal(f.scan()[0].last_deferred_count, 1);
});

test('confirmed claim cleanup failure prevents every subsequent selection/read/finish', t => {
  const f = fixture(t);
  const result = run(f, (call, execute) => isRelease(call.input)
    ? { status: 1, stdout: '', stderr: 'invented cleanup refusal' } : execute());
  assert.equal(result.reason, 'observation_failed'); assert.equal(result.claim_state, 'confirmed');
  assert.equal(result.finish_state, 'not_started'); assert.equal(result.cleanup_state, 'unknown');
  assert.equal(result.cleanup_diagnostic.stage, 'release'); assert.equal(result.observed, 0);
  assert.equal(f.calls.filter(call => call.input.includes(FRAME)).length, 0);
  assert.equal(f.calls.filter(call => isDomain(call.input)).length, 1); assert.equal(f.observations().length, 0);
});

test('confirmed finish and its exact observed count survive an unknown release result', t => {
  const f = fixture(t); let releases = 0;
  const result = run(f, (call, execute) => isRelease(call.input) && ++releases === 2
    ? { status: 1, stdout: '', stderr: 'invented finish cleanup refusal' } : execute());
  assert.equal(result.finish_state, 'confirmed'); assert.equal(result.observed, 1); assert.equal(result.deferred, 0);
  assert.equal(result.cleanup_state, 'unknown'); assert.equal(result.cleanup_diagnostic.stage, 'release');
  assert.equal(f.observations().length, 1); assert.equal(f.scan()[0].last_observed_count, 1);
});

test('a finish committed before total expiry keeps its evidence but starts no late release', t => {
  const f = fixture(t);
  const result = run(f, (call, execute) => { const value = execute(); if (isFinish(call.input)) f.tick = 5001; return value; });
  assert.equal(result.finish_state, 'confirmed'); assert.equal(result.observed, 1);
  assert.equal(result.cleanup_state, 'failed'); assert.equal(result.cleanup_diagnostic.kind, 'time_budget');
  assert.equal(result.command_budget.stop_reason, 'time_budget');
  assert.equal(f.calls.filter(call => isRelease(call.input)).length, 1);
  assert.equal(f.observations().length, 1); assert.equal(f.locks().length, 1);
});

test('an exhausted finish is not_started and preserves a previously confirmed claim', t => {
  const f = fixture(t);
  const result = run(f, (call, execute) => {
    const value = execute();
    if (call.input.includes('FROM lark_im_message_readiness WHERE')) f.tick = 4001;
    return value;
  });
  assert.equal(result.claim_state, 'confirmed'); assert.equal(result.finish_state, 'not_started');
  assert.equal(result.diagnostic.kind, 'time_budget'); assert.equal(result.observed, 0);
  assert.equal(f.calls.filter(call => isDomain(call.input)).length, 1); assert.equal(f.observations().length, 0);
});

test('an actual committed finish with a missing receipt remains unknown, never a claimed rollback', t => {
  const f = fixture(t);
  const result = run(f, (call, execute) => { const value = execute(); return isFinish(call.input) ? { ...value, stdout: '[]' } : value; });
  assert.equal(result.claim_state, 'confirmed'); assert.equal(result.finish_state, 'unknown');
  assert.equal(result.observed, 0); assert.equal(result.deferred, 1);
  assert.equal(f.observations().length, 1, 'lost receipt can follow real commit');
  assert.equal(f.locks().length, 0); assert.equal(result.cleanup_state, 'succeeded');
});

test('source/account change after the final JS admission is still rejected by the transaction fence', t => {
  const f = fixture(t); let changed = false;
  const result = run(f, (call, execute, original) => {
    if (isFinish(call.input)) {
      const mutation = original('sqlite3', [f.db], { input: "UPDATE sources SET config_json='{}' WHERE id='lark.im';", encoding: 'utf8', timeout: 1000 });
      assert.equal(mutation.status, 0); changed = true;
    }
    return execute();
  });
  assert(changed); assert.equal(result.finish_state, 'unknown'); assert.equal(result.observed, 0);
  assert.equal(f.observations().length, 0); assert.equal(f.scan()[0].generation, 1);
  assert.deepEqual(inspect(f.db, 'SELECT * FROM records;'), f.records); assert.equal(f.locks().length, 0);
});
