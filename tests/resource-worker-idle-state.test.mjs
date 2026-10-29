import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ensureInitialized, reserveInitialLarkAccount, confirmInitialLarkAccountSql,
  sqliteExec, sqliteQuery, quoteSql as q } from '../dist/storage/sqlite/ingestion-store.js';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { tryAcquireLarkApiLease } from '../src/runtime/lark-api-lease.mjs';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';
import { readIdleFairState, claimIdleLane, IDLE_FAIR_LANES } from '../src/runtime/worker/idle-fair-state.mjs';

const SELF = 'ou_synthetic_idle_fair_owner', ACCOUNT = recipientAccountKey(SELF);
const HERE = fileURLToPath(import.meta.url);
globalThis.fetch = Socket.prototype.connect = () => { throw new Error('synthetic idle test forbids network'); };
const leaseDeps = directory => ({ tryAcquireLease: (options, deps = {}) =>
  tryAcquireLarkApiLease(options, { ...deps, directory }) });
const oldest = (state, eligible = IDLE_FAIR_LANES) => [...eligible].sort((a, b) =>
  state.last_served[a] - state.last_served[b] || IDLE_FAIR_LANES.indexOf(a) - IDLE_FAIR_LANES.indexOf(b))[0];

if (process.argv[2] === '--claim') {
  const [db, directory] = process.argv.slice(3), deps = leaseDeps(directory);
  const state = readIdleFairState(db, deps);
  assert(state); const lane = oldest(state), result = claimIdleLane(db, state, lane, [...IDLE_FAIR_LANES], deps);
  assert(result); console.log(JSON.stringify({ lane, state: result, pid: process.pid })); process.exit(0);
}

function fixture(t, { confirmed = true, bound = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'exo-idle-fair-synthetic-')), db = join(dir, 'authored.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  ensureInitialized(db);
  if (bound) {
    reserveInitialLarkAccount(db, ACCOUNT, new Date().toISOString());
    if (confirmed) sqliteExec(db, confirmInitialLarkAccountSql(new Date().toISOString()));
  }
  const directory = join(dir, 'private-api-lease');
  const deps = leaseDeps(directory);
  return { dir, db, directory, deps,
    read: () => readIdleFairState(db, deps),
    row: () => sqliteQuery(db, 'SELECT * FROM lark_im_idle_fair_state;')[0] || null,
    count: () => sqliteQuery(db, 'SELECT COUNT(*) AS n FROM lark_im_idle_fair_state;')[0].n };
}
function claim(f, eligible = [...IDLE_FAIR_LANES]) {
  const state = f.read(); assert(state);
  const lane = oldest(state, eligible), result = claimIdleLane(f.db, state, lane, eligible, f.deps);
  assert(result); return { lane, state: result };
}

test('migration loads automatically; local read neither initializes state nor changes account/source data', t => {
  const f = fixture(t), before = sqliteQuery(f.db, "SELECT * FROM sources WHERE id='lark.im';");
  assert(sqliteQuery(f.db, 'SELECT version FROM schema_migrations;').some(row => Number(row.version) === 20));
  const state = f.read(); assert(state); assert.equal(state.exists, false);
  assert.deepEqual(state.last_served, { sample: 0, history: 0, resources: 0 });
  assert.equal(f.count(), 0); assert.equal(state.account_key, ACCOUNT);
  assert.deepEqual(sqliteQuery(f.db, "SELECT * FROM sources WHERE id='lark.im';"), before);
  assert.equal(sqliteQuery(f.db, 'SELECT COUNT(*) AS n FROM records;')[0].n, 0);
  assert.equal(readIdleFairState(join(f.dir, 'missing.sqlite')), null);
});

test('three lanes rotate first opportunities across nine independent process restarts', t => {
  const f = fixture(t), turns = [];
  for (let n = 0; n < 9; n++) {
    const child = spawnSync(process.execPath, [HERE, '--claim', f.db, f.directory], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0, child.stderr); turns.push(JSON.parse(child.stdout));
  }
  assert.deepEqual(turns.map(value => value.lane), [...IDLE_FAIR_LANES, ...IDLE_FAIR_LANES, ...IDLE_FAIR_LANES]);
  assert.equal(new Set(turns.map(value => value.pid)).size, 9);
  assert.equal(f.row().generation, 9); assert.equal(f.row().sequence, 9);
  assert.deepEqual(f.read().last_served, { sample: 7, history: 8, resources: 9 });
});

test('new eligibility and failed spawned work cannot reset older lane service age', t => {
  const f = fixture(t), two = ['sample', 'history'];
  for (let n = 0; n < 4; n++) claim(f, two);
  assert.deepEqual(f.read().last_served, { sample: 3, history: 4, resources: 0 });
  assert.equal(claim(f).lane, 'resources');
  // A subsequent lane failure has no refund/reset API. Its first opportunity
  // has happened, so a fresh process observes the same service sequence.
  assert.equal(claim(f).lane, 'sample');
  assert.equal(claim(f).lane, 'history');
  assert.equal(claim(f).lane, 'resources');
  assert.equal(f.row().sequence, 8);
});

test('wrong lane, invalid eligibility and foreign state cannot claim an opportunity', t => {
  const f = fixture(t), state = f.read();
  for (const [lane, eligible] of [['history', [...IDLE_FAIR_LANES]], ['sample', []],
    ['sample', ['sample', 'sample']], ['sample', ['sample', 'unknown']]])
    assert.equal(claimIdleLane(f.db, state, lane, eligible, f.deps), null);
  assert.equal(claimIdleLane(f.db, { ...state }, 'sample', ['sample'], f.deps), null);
  assert.equal(f.count(), 0);
});

test('full before-image CAS rejects stale INSERT and stale UPDATE snapshots', t => {
  const f = fixture(t), first = f.read(), staleInsert = f.read();
  assert(claimIdleLane(f.db, first, 'sample', [...IDLE_FAIR_LANES], f.deps));
  assert.equal(claimIdleLane(f.db, staleInsert, 'sample', [...IDLE_FAIR_LANES], f.deps), null);
  const staleUpdate = f.read(); claim(f);
  assert.equal(claimIdleLane(f.db, staleUpdate, 'history', [...IDLE_FAIR_LANES], f.deps), null);
  assert.equal(f.row().sequence, 2);
  const before = f.read();
  sqliteExec(f.db, 'UPDATE lark_im_idle_fair_state SET sample_last_served=0;');
  assert.equal(claimIdleLane(f.db, before, 'resources', [...IDLE_FAIR_LANES], f.deps), null);
  assert.equal(f.row().sequence, 2, 'CAS includes all lane ages, not only generation');
});

for (const variant of ['unbound', 'pending', 'disabled', 'mixed sent actors'])
test(`local ${variant} account/source evidence fails closed without state adoption`, t => {
  const f = fixture(t, { confirmed: variant !== 'pending', bound: variant !== 'unbound' });
  if (variant === 'disabled') sqliteExec(f.db, "UPDATE sources SET enabled=0 WHERE id='lark.im';");
  if (variant === 'mixed sent actors') for (const [id, actor] of [[1, SELF], [2, 'ou_synthetic_idle_other']])
    sqliteExec(f.db, `INSERT INTO records(id,source_id,first_seen_scope_id,external_id,record_type,direction,actor_id,raw_json)
      VALUES(${id},'lark.im','lark.im.sent_by_me',${q('om_synthetic_idle_' + id)},'lark.im.message','sent',${q(actor)},'{}');`);
  assert.equal(f.read(), null); assert.equal(f.count(), 0);
});

for (const variant of ['account', 'source']) test(`${variant} drift after read refuses the claim`, t => {
  const f = fixture(t), state = f.read();
  const patch = variant === 'account' ? "'$.initial_account_binding.account_key'," + q(recipientAccountKey('ou_synthetic_idle_other'))
    : "'$.synthetic_changed',true";
  sqliteExec(f.db, `UPDATE sources SET config_json=json_set(config_json,${patch}) WHERE id='lark.im';`);
  assert.equal(claimIdleLane(f.db, state, 'sample', [...IDLE_FAIR_LANES], f.deps), null); assert.equal(f.count(), 0);
});

test('source transaction fence rejects a race after all admission reads', t => {
  const f = fixture(t), state = f.read();
  const result = claimIdleLane(f.db, state, 'sample', [...IDLE_FAIR_LANES], { ...f.deps,
    spawnSync(command, args, options) {
      sqliteExec(f.db, "UPDATE sources SET config_json=json_set(config_json,'$.synthetic_race',true) WHERE id='lark.im';");
      return spawnSync(command, args, options);
    } });
  assert.equal(result, null); assert.equal(f.count(), 0);
});

test('replacement database before claim and copied persisted identity do not reset age', t => {
  const f = fixture(t), before = f.read();
  sqliteExec(f.db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  const replaced = join(f.dir, 'old.sqlite'); renameSync(f.db, replaced); copyFileSync(replaced, f.db);
  assert.equal(claimIdleLane(f.db, before, 'sample', [...IDLE_FAIR_LANES], f.deps), null);
  assert.equal(f.count(), 0);
  claim(f);
  sqliteExec(f.db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  const copied = join(f.dir, 'copied.sqlite'); copyFileSync(f.db, copied);
  assert.equal(readIdleFairState(copied, f.deps), null);
  assert.equal(sqliteQuery(copied, 'SELECT sequence FROM lark_im_idle_fair_state;')[0].sequence, 1);
});

for (const race of [false, true]) test(`maintenance exclusion is checked ${race ? 'inside the transaction' : 'before claiming'}`, t => {
  const f = fixture(t), state = f.read();
  const lock = () => sqliteExec(f.db, `INSERT INTO maintenance_locks(name,owner,acquired_at,expires_at,reason)
    VALUES('global','synthetic-idle-maintenance','2020-01-01T00:00:00.000Z','2999-01-01T00:00:00.000Z','synthetic');`);
  if (!race) lock();
  const result = claimIdleLane(f.db, state, 'sample', [...IDLE_FAIR_LANES], { ...f.deps,
    ...(race ? { spawnSync(command, args, options) { lock(); return spawnSync(command, args, options); } } : {}) });
  assert.equal(result, null); assert.equal(f.count(), 0); assert.equal(f.read(), null);
});

test('existing sync lock blocks optional first-service state without recovery', t => {
  const f = fixture(t), state = f.read();
  sqliteExec(f.db, `INSERT INTO sync_locks(scope_id,locked_by,locked_at,expires_at)
    VALUES('lark.im.sent_by_me','synthetic-unknown-owner','2020-01-01T00:00:00.000Z','2020-01-01T00:01:00.000Z');`);
  assert.equal(f.read(), null);
  assert.equal(claimIdleLane(f.db, state, 'sample', [...IDLE_FAIR_LANES], f.deps), null);
  assert.equal(f.count(), 0); assert.equal(sqliteQuery(f.db, 'SELECT COUNT(*) AS n FROM sync_locks;')[0].n, 1);
});

test('a private probe lease conflict does not advance any lane or leak the lease', t => {
  const f = fixture(t), state = f.read();
  const held = tryAcquireLarkApiLease({ role: 'sync' }, { directory: f.directory }); assert.equal(held.state, 'acquired');
  try { assert.equal(claimIdleLane(f.db, state, 'sample', [...IDLE_FAIR_LANES], f.deps), null); }
  finally { held.release(); }
  assert.equal(f.count(), 0); assert(claimIdleLane(f.db, state, 'sample', [...IDLE_FAIR_LANES], f.deps));
  const next = tryAcquireLarkApiLease({ role: 'probe' }, { directory: f.directory });
  try { assert.equal(next.state, 'acquired'); } finally { next.release(); }
});

for (const receipt of ['timeout', 'malformed success'])
test(`${receipt} after actual commit is unknown, never compensated`, t => {
  const f = fixture(t), state = f.read();
  assert.equal(claimIdleLane(f.db, state, 'sample', [...IDLE_FAIR_LANES], { ...f.deps,
    spawnSync(command, args, options) {
      assert(options.timeout > 0 && options.timeout <= 2000); assert.equal(options.killSignal, 'SIGKILL');
      assert(Array.isArray(options.stdio) && options.stdio.length === 4, 'SQLite inherits the actual private lease descriptor');
      const result = spawnSync(command, args, options); assert.equal(result.status, 0);
      return receipt === 'timeout'
        ? { ...result, error: Object.assign(new Error('synthetic uncertain receipt'), { code: 'ETIMEDOUT' }) }
        : { ...result, stdout: '{synthetic malformed receipt' };
    } }), null);
  assert.equal(f.row().sequence, 1);
  assert.equal(claim(f).lane, 'history', 'new observation retains the committed failed-receipt opportunity');
});

test('lease release failure cannot return a successful claim receipt', t => {
  const f = fixture(t), state = f.read();
  assert.equal(claimIdleLane(f.db, state, 'sample', [...IDLE_FAIR_LANES], { ...f.deps,
    tryAcquireLease(options, deps) {
      const held = f.deps.tryAcquireLease(options, deps);
      assert.equal(held.state, 'acquired');
      return { ...held, release() { held.release(); throw new Error('synthetic release uncertainty'); } };
    } }), null);
  assert.equal(f.row().sequence, 1, 'an uncertain release never rewinds an already committed opportunity');
  assert.equal(claim(f).lane, 'history');
});

test('database replacement after actual commit returns unknown and preserves the committed before-file', t => {
  const f = fixture(t), state = f.read(), committed = join(f.dir, 'committed.sqlite');
  sqliteExec(f.db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  assert.equal(claimIdleLane(f.db, state, 'sample', [...IDLE_FAIR_LANES], { ...f.deps,
    spawnSync(command, args, options) {
      const result = spawnSync(command, args, options); assert.equal(result.status, 0);
      renameSync(f.db, committed); copyFileSync(committed, f.db);
      return result;
    } }), null);
  assert.equal(sqliteQuery(committed, 'SELECT sequence FROM lark_im_idle_fair_state;')[0].sequence, 1);
  assert.equal(f.read(), null, 'copied scheduler identity cannot silently adopt the replacement file');
});

test('deadline reached after an actual commit forbids an optional spawn without refunding age', t => {
  const f = fixture(t), state = f.read(); let elapsed = 0;
  assert.equal(claimIdleLane(f.db, state, 'sample', [...IDLE_FAIR_LANES], { ...f.deps,
    monotonicNowMs: () => elapsed, timeoutMs: 1500, monotonicDeadlineMs: 1500,
    spawnSync(command, args, options) {
      assert(options.timeout <= 1500);
      const result = spawnSync(command, args, options); assert.equal(result.status, 0);
      elapsed = 1500; return result;
    } }), null);
  assert.equal(f.row().sequence, 1); assert.equal(claim(f).lane, 'history');
});

test('missing scheduling schema fails closed instead of migrating during ordinary read', t => {
  const f = fixture(t); sqliteExec(f.db, 'DROP TABLE lark_im_idle_fair_state;');
  assert.equal(f.read(), null);
  assert.equal(sqliteQuery(f.db, "SELECT name FROM sqlite_master WHERE name='lark_im_idle_fair_state';").length, 0);
});

test('remaining deadlines and rollback fail closed before further local work', t => {
  const f = fixture(t); let elapsed = 0, reads = 0;
  const state = readIdleFairState(f.db, { monotonicNowMs: () => elapsed, monotonicDeadlineMs: 40,
    readOnlyQuery(db, sql, label, options) {
      reads++; assert(options.timeoutMs <= 40); elapsed += 41;
      return readOnlySqliteJson(db, sql, label, options);
    } });
  assert.equal(state, null); assert.equal(reads, 1);
  let tick = 10;
  assert.equal(readIdleFairState(f.db, { monotonicNowMs: () => tick-- }), null);
  const before = f.read(); let attemptedLease = false;
  assert.equal(claimIdleLane(f.db, before, 'sample', [...IDLE_FAIR_LANES], { ...f.deps,
    monotonicNowMs: () => 100, monotonicDeadlineMs: 100,
    tryAcquireLease() { attemptedLease = true; assert.fail('expired budget cannot acquire a lease'); } }), null);
  assert.equal(attemptedLease, false); assert.equal(f.count(), 0);
});
