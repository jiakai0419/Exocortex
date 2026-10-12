import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, fstatSync, linkSync, lstatSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSyncLarkApiLease, getLarkApiLeaseStdio, tryAcquireLarkApiLease } from '../src/runtime/lark-api-lease.mjs';
import { createMaintenanceRequestSession } from '../src/maintenance/request-session.mjs';
import { startOwnedProcess, waitUntil } from './helpers/owned-process.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-history-priority-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let elapsed = 0;
  const deps = { directory: join(root, 'lease'), clock: () => 2_000_000_000_000 + elapsed,
    monotonicClock: () => elapsed };
  return { root, deps, now: () => elapsed, advance: ms => { elapsed += ms; },
    acquire: options => tryAcquireLarkApiLease(options, deps) };
}

test('a declared sync waiter blocks later probe handoffs after the one active request', t => {
  const f = fixture(t), contenders = [];
  let holder = f.acquire({ role: 'probe' }), result;
  assert.equal(holder.state, 'acquired');
  try {
    result = acquireSyncLarkApiLease({}, { clock: f.deps.clock, monotonicClock: f.deps.monotonicClock,
      acquire: f.acquire, sleep(ms) {
        f.advance(ms);
        // Deterministic adversarial ordering, not a production timing claim.
        // A local commit can follow a finished request immediately; the next
        // network request still has >=1s since the earlier request finished.
        if (f.now() === 1000 || f.now() === 3000) {
          holder.release();
          holder = f.acquire({ role: 'probe' });
          contenders.push(holder.state);
        }
      } });
    assert.deepEqual(contenders, ['busy'], 'a waiting sync must prevent request -> commit -> request probe chaining');
    assert.equal(result.state, 'acquired');
    assert.equal(f.now(), 1000, 'sync waits only for the initial holder in this synthetic ordering');
  } finally { holder.release(); result?.release(); }
});

test('one shared batch session releases the real API lease throughout every 1s gap', t => {
  const f = fixture(t), starts = [], gaps = [];
  const session = createMaintenanceRequestSession({ maxCliAttempts: 12, maxSeconds: 25 }, {
    env: { LARK_CLI: 'synthetic-only-no-executable' }, now: f.deps.clock, monotonicClock: f.deps.monotonicClock,
    tryAcquireLease: f.acquire,
    readSharedCooldown: () => ({ state: 'ready', untilMs: null }), writeSharedCooldown: () => true,
    spawnSync(_command, _args, settings) {
      assert.ok(Array.isArray(settings.stdio) && settings.stdio.length === 4);
      const contender = f.acquire({ role: 'sync' });
      try { assert.equal(contender.state, 'busy'); } finally { contender.release(); }
      starts.push(f.now()); f.advance(50);
      return { status: 0, signal: null, stdout: '{}', stderr: '' };
    },
    sleep(ms) {
      const before = f.now();
      const foreground = acquireSyncLarkApiLease({}, { clock: f.deps.clock,
        monotonicClock: f.deps.monotonicClock, acquire: f.acquire, sleep: () => assert.fail('gap must be unlocked') });
      try { assert.equal(foreground.state, 'acquired'); } finally { foreground.release(); }
      assert.equal(f.now(), before); gaps.push(ms); f.advance(ms);
    },
  });
  for (let i = 0; i < 6; i++) session.runLark(['api', 'GET', '/open-apis/im/v1/messages']);
  assert.equal(session.summary().cli_attempts, 6);
  assert.deepEqual(gaps, [1000, 1000, 1000, 1000, 1000]);
  assert.deepEqual(starts, [0, 1050, 2100, 3150, 4200, 5250]);
});

test('an already active local commit is not preempted and can exhaust sync total 5s', t => {
  const f = fixture(t);
  const session = createMaintenanceRequestSession({ maxCliAttempts: 12, maxSeconds: 25 }, {
    monotonicClock: f.deps.monotonicClock, tryAcquireLease: f.acquire,
    readSharedCooldown: () => ({ state: 'ready', untilMs: null }), writeSharedCooldown: () => true,
  });
  session.withCommit(() => {
    const result = acquireSyncLarkApiLease({}, { clock: f.deps.clock, monotonicClock: f.deps.monotonicClock,
      acquire: f.acquire, sleep: ms => f.advance(ms) });
    try { assert.notEqual(result.state, 'acquired'); assert.equal(f.now(), 5000); }
    finally { result.release(); }
  });
  const next = f.acquire({ role: 'probe' });
  try { assert.equal(next.state, 'acquired', 'expired sync intent must be closed'); } finally { next.release(); }
});

test('an announced sync also prevents a new actual local commit from entering', t => {
  const f = fixture(t), owner = f.acquire({ role: 'probe' });
  const session = createMaintenanceRequestSession({ maxCliAttempts: 12, maxSeconds: 25 }, {
    monotonicClock: f.deps.monotonicClock, tryAcquireLease: f.acquire,
    readSharedCooldown: () => ({ state: 'ready', untilMs: null }), writeSharedCooldown: () => true,
  });
  let entered = false, result;
  try {
    result = acquireSyncLarkApiLease({}, { clock: f.deps.clock, monotonicClock: f.deps.monotonicClock,
      acquire: f.acquire, sleep(ms) {
        f.advance(ms); owner.release();
        assert.throws(() => session.withCommit(() => { entered = true; }), error => error.reason === 'sync_busy');
      } });
    assert.equal(result.state, 'acquired'); assert.equal(entered, false);
    assert.equal(session.summary().stop_reason, 'sync_busy'); assert.equal(session.summary().cli_attempts, 0);
  } finally { owner.release(); result?.release(); }
});

test('multiple sync waiters share intent and the remaining waiter still excludes probes', t => {
  const f = fixture(t), owner = f.acquire({ role: 'probe' });
  assert.equal(owner.state, 'acquired');
  let nested = false, outer;
  try {
    outer = acquireSyncLarkApiLease({}, { clock: f.deps.clock, monotonicClock: f.deps.monotonicClock,
      acquire: f.acquire, sleep(ms) {
        f.advance(ms); assert.equal(nested, false); nested = true;
        const inner = acquireSyncLarkApiLease({}, { clock: f.deps.clock, monotonicClock: f.deps.monotonicClock,
          acquire: f.acquire, sleep(innerMs) {
            f.advance(innerMs); owner.release();
            const blocked = f.acquire({ role: 'probe' });
            try { assert.equal(blocked.state, 'busy'); } finally { blocked.release(); }
          } });
        try { assert.equal(inner.state, 'acquired', 'two shared waiters do not exclude each other'); }
        finally { inner.release(); }
        const stillBlocked = f.acquire({ role: 'probe' });
        try { assert.equal(stillBlocked.state, 'busy', 'outer waiter retains intent after inner returns'); }
        finally { stillBlocked.release(); }
      } });
    assert.equal(outer.state, 'acquired'); assert.equal(f.now(), 200);
  } finally { owner.release(); outer?.release(); }
  const next = f.acquire({ role: 'probe' });
  try { assert.equal(next.state, 'acquired'); } finally { next.release(); }
});

test('unsafe or replaced intent paths fail closed and do not leak a descriptor', t => {
  const f = fixture(t), path = join(f.deps.directory, 'sync-intent.lock');
  const initial = f.acquire({ role: 'probe' }); initial.release();
  chmodSync(path, 0o644);
  assert.equal(f.acquire({ role: 'probe' }).state, 'unavailable');
  chmodSync(path, 0o600);
  const hardlink = `${path}.hardlink`; linkSync(path, hardlink);
  assert.equal(f.acquire({ role: 'probe' }).state, 'unavailable'); rmSync(hardlink);
  const saved = `${path}.saved`; renameSync(path, saved); symlinkSync(saved, path);
  assert.equal(f.acquire({ role: 'probe' }).state, 'unavailable');
  rmSync(path); renameSync(saved, path);
  let calls = 0;
  const replaced = tryAcquireLarkApiLease({ role: 'probe' }, { ...f.deps,
    spawnSync(command, args, settings) {
      const result = spawnSync(command, args, settings);
      if (++calls === 1) { renameSync(path, saved); writeFileSync(path, '', { mode: 0o600 }); }
      return result;
    } });
  assert.equal(replaced.state, 'unavailable');
  assert.equal(calls, 1, 'inode change stops before trying API acquisition');
  rmSync(path); renameSync(saved, path);
  const next = f.acquire({ role: 'probe' });
  try { assert.equal(next.state, 'acquired'); } finally { next.release(); }
});

test('gate plus API helper work share one deadline; only API fd is exposed to a child', t => {
  const f = fixture(t), budgets = [];
  const result = acquireSyncLarkApiLease({}, { clock: f.deps.clock, monotonicClock: f.deps.monotonicClock,
    acquire: options => tryAcquireLarkApiLease(options, { ...f.deps,
      spawnSync(command, args, settings) {
        budgets.push(settings.timeout);
        assert.equal(getLarkApiLeaseStdio(), undefined, 'intent fd never becomes the API inheritance fd');
        if (budgets.length === 1) {
          const acquired = spawnSync(command, args, settings); f.advance(1900); return acquired;
        }
        f.advance(settings.timeout);
        return { error: { code: 'ETIMEDOUT' }, status: null };
      } }), sleep: () => assert.fail('helper error must not retry') });
  assert.equal(result.state, 'unavailable'); assert.deepEqual(budgets, [2000, 100]); assert.equal(f.now(), 2000);
  const next = f.acquire({ role: 'probe' });
  try {
    assert.equal(next.state, 'acquired', 'timed out sync released its intent');
    assert.equal(next.stdio.length, 4);
    assert.equal(fstatSync(next.stdio[3]).ino, lstatSync(join(f.deps.directory, 'api.lock')).ino);
    assert.notEqual(fstatSync(next.stdio[3]).ino, lstatSync(join(f.deps.directory, 'sync-intent.lock')).ino);
  } finally { next.release(); }
});

test('death of an owned waiting process releases intent without PID cleanup or unlink', { timeout: 11000 }, async t => {
  const f = fixture(t), holder = f.acquire({ role: 'probe' });
  assert.equal(holder.state, 'acquired');
  const moduleUrl = new URL('../src/runtime/lark-api-lease.mjs', import.meta.url).href;
  const deadline = performance.now() + 9000;
  const child = startOwnedProcess(process.execPath, ['--input-type=module', '-e', `
    import { acquireSyncLarkApiLease, tryAcquireLarkApiLease } from ${JSON.stringify(moduleUrl)};
    let announced = false;
    const result = acquireSyncLarkApiLease({}, {
      acquire: options => tryAcquireLarkApiLease(options, { directory: process.argv[1] }),
      sleep(ms) { if (!announced) { announced = true; process.stdout.write('waiting'); }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
    }); result.release();`, f.deps.directory], { deadline, cwd: f.root, detached: false, maxBytes: 1024 });
  let output = '', exited = false;
  child.child.stdout.on('data', chunk => { output += String(chunk); });
  child.result.then(() => { exited = true; });
  try {
    await waitUntil(() => output === 'waiting' || exited, deadline - 2000, 'synthetic_sync_intent_ready');
    assert.equal(output, 'waiting');
    assert.equal(child.signalOnce('SIGKILL'), true, 'signal only this direct owned child once');
    const result = await child.result;
    assert.equal(result.failure, null); assert.equal(result.signalError, null); assert.equal(result.signal, 'SIGKILL');
    holder.release();
    const next = f.acquire({ role: 'probe' });
    try { assert.equal(next.state, 'acquired'); } finally { next.release(); }
  } finally {
    holder.release();
    if (!exited) { child.stop('synthetic_intent_cleanup'); await child.result; }
  }
});
