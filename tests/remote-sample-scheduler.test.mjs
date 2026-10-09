import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activityDatabaseKey } from '../src/diagnostics/lark-im-activity-evidence.mjs';
import { executeRemoteSampleAttempt, readRemoteSampleState, readScheduledRemoteCooldowns, remoteSamplePaths,
  REMOTE_SAMPLE_LOCK_WRAPPER, REMOTE_SAMPLE_MAX_BACKOFF_MS, REMOTE_SAMPLE_OBSERVATION_TTL_MS,
  createRemoteSampleController, REMOTE_SAMPLE_GUARDIAN, runManualRemoteSample, runScheduledRemoteSample, startScheduledRemoteSample,
  sanitizeRemoteObservations, validateRemoteSampleState, writeRemoteSampleState } from '../src/runtime/worker/remote-sample-scheduler.mjs';
import { invalidateRemoteSampleCache } from '../src/diagnostics/remote-sample-cache.mjs';
import { createRemoteSamplePublication } from '../src/runtime/worker/remote-sample-cache-gate.mjs';
import { parseArgs, runWorker } from '../src/runtime/worker/worker.mjs';
import { parseWorkerProgramArguments, validateWorkerOptions, workerProgramArguments } from '../src/runtime/worker/options.mjs';
import { parseRouteOptions } from '../src/cli/registry.mjs';
import { startOwnedProcess, waitUntil as waitForCondition } from './helpers/owned-process.mjs';

const START = Date.parse('2030-01-01T12:00:00Z');
const OBS_KEY = 'a'.repeat(64);
const ACCOUNT = 'b'.repeat(64);
const observation = (now = START) => ({ kind: 'missing', first_seen: now, last_seen: now, run_finished: 0, target: now - 3_600_000 });
function fixture(t, { preserveOnFailure = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'exo-synthetic-schedule-'));
  let passed = !preserveOnFailure;
  t.after(() => {
    if (passed) rmSync(dir, { force: true, recursive: true });
    else t.diagnostic(`Failed synthetic fixture retained: ${dir}`);
  });
  const db = join(dir, 'invented.sqlite'); writeFileSync(db, 'synthetic identity only', { mode: 0o600 });
  const key = activityDatabaseKey(db); const paths = remoteSamplePaths(dir, key);
  const opts = { db, logDir: dir, remoteSampleIntervalSeconds: 900, publication: createRemoteSamplePublication(dir, key) };
  let now = START; let calls = 0; let caches = 0; let latestOptions;
  const result = () => ({ outcome: 'ok', rotation: 3, observations: { [OBS_KEY]: observation(now) },
    report: { status: 'healthy' }, cacheContext: { account_key: ACCOUNT, auth_identity_verified: true }, cooldownsByOperation: {} });
  const deps = { nowMs: () => now, invalidateCache: () => true, collect: (_db, options) => { calls++; latestOptions = options; return result(); },
    writeCache: path => { assert.equal(path, opts.publication.stagePath); caches++; return {}; } };
  return { opts, key, paths, deps, result, setNow: value => { now = value; }, now: () => now,
    calls: () => calls, caches: () => caches, options: () => latestOptions,
    markPassed: () => { passed = true; },
    state: () => readRemoteSampleState(paths.state, key, now).state };
}

function remainingCaseMs(deadline, maximum = 2000) {
  const remaining = Math.floor(deadline - performance.now());
  assert.ok(remaining > 0, 'synthetic case deadline exceeded');
  return Math.min(maximum, remaining);
}

function ownCaseProcess(t, command, args, deadline, cleanupSignal = 'SIGTERM') {
  remainingCaseMs(deadline);
  const owner = startOwnedProcess(command, args, { deadline });
  // Give a guardian time to run its own group cleanup before the helper's
  // watchdog. Mark this as failure even if cleanup then exits successfully.
  const guardianWatchdog = cleanupSignal === 'SIGTERM' ? setTimeout(() => {
    owner.signalOnce('SIGTERM');
    owner.stop('synthetic_guardian_watchdog');
  }, Math.max(0, deadline - performance.now() - 3000)) : null;
  owner.result.then(() => clearTimeout(guardianWatchdog));
  t.after(async () => {
    // Body, watchdog and cleanup all share the helper's single signal slot.
    clearTimeout(guardianWatchdog);
    owner.signalOnce(cleanupSignal);
    await owner.result;
  });
  return owner;
}

function assertOwnedResult(result, { code = 0, signal = null } = {}) {
  assert.equal(result.failure, null, 'owned process watchdog or execution failed');
  assert.equal(result.signalError, null, 'owned process signal failed');
  assert.equal(result.code, code);
  assert.equal(result.signal, signal);
}

test('interval default, supported range, disable and service serialization agree', () => {
  assert.equal(parseArgs([]).remoteSampleIntervalSeconds, 900);
  for (const value of [0, 900, 1100, 1800]) {
    const args = ['--remote-sample-interval-seconds', String(value)];
    const opts = parseArgs(args);
    assert.equal(opts.remoteSampleIntervalSeconds, value);
    assert.equal(parseWorkerProgramArguments(workerProgramArguments(opts)).remoteSampleIntervalSeconds, value);
    assert.equal(parseRouteOptions('service.install', args).options.remoteSampleIntervalSeconds, value);
  }
  for (const value of ['1', '899', '1801', '-1', '1.1', 'NaN']) {
    assert.throws(() => parseArgs(['--remote-sample-interval-seconds', value]));
    assert.throws(() => validateWorkerOptions(parseRouteOptions('service.install', ['--remote-sample-interval-seconds', value]).options));
  }
});

test('successful sample persists private rotation/account/observations and exact due across restart', async t => {
  const f = fixture(t);
  assert.equal((await executeRemoteSampleAttempt(f.opts, f.deps)).outcome, 'ok');
  assert.equal(f.calls(), 1); assert.equal(f.caches(), 1);
  assert.equal(f.state().rotation, 3); assert.equal(f.state().account_key, ACCOUNT);
  assert.deepEqual(f.state().observations, { [OBS_KEY]: observation() });
  assert.equal(f.state().next_due, START + 900_000);
  assert.equal(f.state().failures, 0);
  assert.equal(statSync(f.paths.state).mode & 0o777, 0o600);
  assert.equal(statSync(f.paths.directory).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(f.paths.directory), [f.key + '.json']);
  assert.equal((await executeRemoteSampleAttempt(f.opts, f.deps)).outcome, 'not_due');
  f.setNow(START + 900_000);
  await executeRemoteSampleAttempt(f.opts, f.deps);
  assert.equal(f.calls(), 2); assert.equal(f.options().rotation, 3);
  assert.equal(f.options().accountKey, ACCOUNT);
  assert.deepEqual(f.options().previousObservations, { [OBS_KEY]: observation() });
  assert.equal(f.options().cacheTtlMs, 1_800_000);
  assert.equal(f.options().maxApiCalls, 12); assert.equal(f.options().minApiGapMs, 1000);
  assert.equal(f.options().totalTimeoutMs, 55_000);
});

test('30-minute cadence passes a one-hour TTL without changing the request budget', async t => {
  const f = fixture(t);
  await executeRemoteSampleAttempt({ ...f.opts, remoteSampleIntervalSeconds: 1800 }, f.deps);
  assert.equal(f.state().next_due, START + 1_800_000); assert.equal(f.options().cacheTtlMs, 3_600_000);
});

test('failure backoff doubles from 15 minutes to six hours and survives restart', async t => {
  const f = fixture(t); const intervals = [];
  const failed = { ...f.deps, collect: () => ({ outcome: 'failed', report: { status: 'unavailable' } }) };
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = f.now();
    const sampled = await executeRemoteSampleAttempt(f.opts, failed);
    assert.equal(sampled.outcome, 'failed');
    intervals.push(f.state().next_due - before);
    f.setNow(f.state().next_due);
  }
  assert.deepEqual(intervals, [900000, 1800000, 3600000, 7200000, 14400000, 21600000, 21600000, 21600000]);
  assert.equal(f.state().failures, 8); assert.equal(f.state().rotation, 0);
  await executeRemoteSampleAttempt(f.opts, f.deps);
  assert.equal(f.state().failures, 0);
});

test('busy is retried after a minute without increasing failures or committing partial rotation', async t => {
  const f = fixture(t);
  await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: () => ({ outcome: 'failed' }) });
  f.setNow(f.state().next_due);
  const before = f.now();
  const sampled = await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: () => ({ outcome: 'busy', rotation: 99, observations: {} }) });
  assert.equal(sampled.outcome, 'busy'); assert.equal(f.state().failures, 1);
  assert.equal(f.state().rotation, 0); assert.equal(f.state().next_due, before + 60_000);
});

test('a pre-reserved attempt survives child interruption and prevents immediate restart requests', async t => {
  const f = fixture(t); let writes = 0;
  const sampled = await executeRemoteSampleAttempt(f.opts, { ...f.deps, writeState: (...args) => {
    if (++writes === 2) throw new Error('synthetic interrupted commit');
    writeRemoteSampleState(...args);
  } });
  assert.equal(sampled.reason, 'state_write_failed'); assert.equal(f.state().last_outcome, 'attempting');
  assert.equal(f.state().failures, 1); assert.equal(f.state().next_due, START + 900_000);
  assert.equal((await executeRemoteSampleAttempt(f.opts, f.deps)).outcome, 'not_due');
  assert.equal(f.calls(), 1);
});

test('failure to reserve state never starts API collection', async t => {
  const f = fixture(t);
  assert.equal((await executeRemoteSampleAttempt(f.opts, { ...f.deps, writeState: () => { throw Error('invented disk failure'); } })).reason, 'state_write_failed');
  assert.equal(f.calls(), 0); assert.equal(existsSync(f.paths.state), false);
});

test('cache write failure is separate from sync and does not advance rotation', async t => {
  const f = fixture(t);
  const sampled = await executeRemoteSampleAttempt(f.opts, { ...f.deps, writeCache: () => { throw Error('invented cache failure'); } });
  assert.equal(sampled.outcome, 'failed'); assert.equal(f.state().rotation, 0); assert.equal(f.state().failures, 1);
});

test('rate-limit reset longer than six hours persists and is restored before another request', async t => {
  const f = fixture(t); const until = START + 8 * 3_600_000;
  const sampled = await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: (_db, options) => {
    assert.equal(options.cooldownsByOperation.contact_search, START + 100_000);
    return { outcome: 'failed', cooldownsByOperation: { message_history_bundle: until }, report: { status: 'unavailable' } };
  }, cooldownsByOperation: { contact_search: START + 100_000 } });
  assert.equal(sampled.outcome, 'failed'); assert.equal(f.state().next_due, until);
  assert.ok(f.state().next_due - START > REMOTE_SAMPLE_MAX_BACKOFF_MS);
  assert.equal(readScheduledRemoteCooldowns(f.opts, { nowMs: f.now }).message_history_bundle, until);
  let spawnCalls = 0;
  const parent = runScheduledRemoteSample(f.opts, { nowMs: f.now, spawnSync: () => { spawnCalls++; } });
  assert.equal(parent.outcome, 'not_due'); assert.equal(parent.cooldownsByOperation.message_history_bundle, until);
  assert.equal(spawnCalls, 0);
});

test('untrustworthy remote reset beyond seven days blocks future sampling instead of shortening it', async t => {
  const f = fixture(t);
  const sampled = await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: () => ({ outcome: 'failed',
    cooldownsByOperation: { message_history_bundle: START + REMOTE_SAMPLE_OBSERVATION_TTL_MS + 1 }, report: { status: 'unavailable' } }) });
  assert.equal(sampled.reason, 'state_invalid'); assert.equal(f.state().blocked_reason, 'cooldown_invalid');
  f.setNow(START + REMOTE_SAMPLE_MAX_BACKOFF_MS + 1);
  assert.equal((await executeRemoteSampleAttempt(f.opts, f.deps)).reason, 'state_invalid'); assert.equal(f.calls(), 0);
});

for (const [name, mutate] of [
  ['wrong DB', s => { s.database_key = 'f'.repeat(64); }],
  ['future write', s => { s.written_at = START + 1; }],
  ['unexplained future due', s => { s.next_due = START + REMOTE_SAMPLE_MAX_BACKOFF_MS + 1; }],
  ['wrong schema', s => { s.kind = 'invented/v999'; }],
  ['negative rotation', s => { s.rotation = -1; }],
  ['unexpected private field', s => { s.body = 'SYNTHETIC_SECRET_BODY'; }],
  ['future observation', s => { s.observations[OBS_KEY].last_seen = START + 1; }],
  ['raw observation key', s => { s.observations = { invented_message_id: observation() }; }],
]) test(`malformed persisted evidence fails closed without reset or requests: ${name}`, async t => {
  const f = fixture(t); await executeRemoteSampleAttempt(f.opts, f.deps);
  const state = f.state(); mutate(state); writeFileSync(f.paths.state, JSON.stringify(state));
  const before = readFileSync(f.paths.state, 'utf8');
  assert.equal((await executeRemoteSampleAttempt(f.opts, f.deps)).reason, 'state_invalid');
  assert.equal(runScheduledRemoteSample(f.opts, { nowMs: f.now }).reason, 'state_invalid');
  assert.equal(f.calls(), 1); assert.equal(readFileSync(f.paths.state, 'utf8'), before);
});

test('corrupt, permissive or symlinked state cannot trigger a request', async t => {
  const f = fixture(t); await executeRemoteSampleAttempt(f.opts, f.deps);
  writeFileSync(f.paths.state, '{broken');
  assert.equal(runScheduledRemoteSample(f.opts, { nowMs: f.now }).reason, 'state_invalid');
  writeFileSync(f.paths.state, '{}'); chmodSync(f.paths.state, 0o644);
  assert.equal(readRemoteSampleState(f.paths.state, f.key, START).status, 'invalid');
  const target = f.paths.state + '.target'; rmSync(f.paths.state); writeFileSync(target, '{}', { mode: 0o600 });
  symlinkSync(target, f.paths.state);
  assert.equal(readRemoteSampleState(f.paths.state, f.key, START).status, 'invalid');
  assert.equal(f.calls(), 1);
});

test('observation privacy, count and retention bounds reject invalid shapes', () => {
  const expired = { [OBS_KEY]: observation(START - REMOTE_SAMPLE_OBSERVATION_TTL_MS - 1) };
  assert.deepEqual(sanitizeRemoteObservations(expired, START), expired);
  assert.equal(sanitizeRemoteObservations({ [OBS_KEY]: { ...observation(), body: 'SYNTHETIC_BODY' } }, START), null);
  assert.equal(sanitizeRemoteObservations(Object.fromEntries(Array.from({ length: 201 }, (_, n) => [n.toString(16).padStart(64, '0'), observation()])), START), null);
  assert.equal(validateRemoteSampleState({}, 'f'.repeat(64), START), null);
});

test('database replacement during collection cannot publish a cache or advance old state', async t => {
  const f = fixture(t); let keys = 0;
  const sampled = await executeRemoteSampleAttempt(f.opts, { ...f.deps, databaseKey: () => ++keys === 1 ? f.key : 'd'.repeat(64) });
  assert.equal(sampled.reason, 'database_changed'); assert.equal(f.caches(), 0);
  assert.equal(f.state().last_outcome, 'attempting'); assert.equal(f.state().rotation, 0);
});

test('parent launches one hard-limited private child and returns no unrecognized child fields', t => {
  const f = fixture(t); let observed;
  const sampled = runScheduledRemoteSample(f.opts, { nowMs: f.now, cooldownsByOperation: { self_profile: START + 10_000 }, spawnSync: (command, args, options) => {
    observed = { command, args, options };
    return { status: 0, stdout: JSON.stringify({ outcome: 'ok', reason: 'sampled', next_due: START + 900_000,
      body: 'SYNTHETIC_SECRET_BODY', observations: { invented: 'SYNTHETIC_ID' }, cooldownsByOperation: {} }), stderr: 'SYNTHETIC_SECRET_ERROR' };
  } });
  assert.equal(observed.command, 'python3'); assert.equal(observed.options.timeout, 62_000);
  assert.deepEqual(observed.args.slice(0, 4), ['-c', REMOTE_SAMPLE_LOCK_WRAPPER, f.paths.lock, 'python3']);
  assert.equal(observed.args[5], REMOTE_SAMPLE_GUARDIAN); assert.equal(observed.args[7], '60000');
  assert.equal(observed.options.killSignal, 'SIGTERM'); assert.equal(observed.options.maxBuffer, 64 * 1024);
  assert.equal(JSON.parse(observed.options.input).cooldownsByOperation.self_profile, START + 10_000);
  assert.deepEqual(JSON.parse(observed.options.env.EXOCORTEX_REMOTE_SAMPLE_PUBLICATION), JSON.parse(observed.options.input).publication);
  assert.equal(sampled.outcome, 'ok'); assert.doesNotMatch(JSON.stringify(sampled), /SYNTHETIC|observations|body|stderr/);
});

for (const processResult of [
  { status: null, signal: 'SIGKILL', stdout: '{"outcome":"ok","reason":"sampled"}' },
  { status: 0, error: Error('invented timeout'), stdout: '{"outcome":"ok","reason":"sampled"}' },
  { status: 0, stdout: 'not JSON' }, { status: 2, stdout: '{"outcome":"ok","reason":"sampled"}' },
]) test('invalid/terminated process cannot claim a successful sample', t => {
  const f = fixture(t);
  assert.equal(runScheduledRemoteSample(f.opts, { nowMs: f.now, spawnSync: () => processResult }).outcome, 'failed');
});

test('disabled and absent-database schedules perform no subprocess or state writes', t => {
  const f = fixture(t); const deps = { nowMs: f.now, spawnSync: () => { throw Error('must not spawn'); } };
  assert.equal(runScheduledRemoteSample({ ...f.opts, remoteSampleIntervalSeconds: 0 }, deps).outcome, 'disabled');
  assert.equal(runScheduledRemoteSample({ ...f.opts, db: join(f.opts.logDir, 'absent.sqlite') }, deps).reason, 'database_unavailable');
  assert.equal(existsSync(f.paths.directory), false);
});

test('worker samples only successful cycles and keeps diagnostic failures out of sync success', () => {
  const order = []; const events = [];
  let cycle = 0;
  const ok = runWorker(parseArgs(['--max-cycles', '3']), { nowMs: () => START,
    runCycle: () => { order.push('sync'); return ++cycle !== 2; }, sleepSeconds: () => {},
    runRemoteSample: (_opts, deps) => { order.push('sample'); assert.ok(deps.cooldownsByOperation); return { outcome: 'failed', reason: 'sample_failed' }; },
    writeScheduler: (_opts, event) => events.push(event) });
  assert.equal(ok, false); assert.deepEqual(order, ['sync', 'sample', 'sync', 'sync', 'sample']);
  assert.equal(events.length, 2); assert.ok(events.every(e => e.type === 'lark_im_remote_sample_schedule'));
  for (const sample of [() => ({ outcome: 'failed', reason: 'sample_failed' }), () => { throw Error('invented child exception'); }]) {
    assert.equal(runWorker(parseArgs(['--once']), { runCycle: () => true, runRemoteSample: sample, writeScheduler: () => {} }), true);
  }
});

test('worker passes diagnostic endpoint cooldown to the next sync cycle', () => {
  let calls = 0;
  const ok = runWorker(parseArgs(['--max-cycles', '2']), { nowMs: () => START,
    runCycle: (_opts, cycle, deps) => {
      if (cycle === 2) assert.equal(deps.cooldownsByOperation.message_history_bundle, START + 50_000);
      return true;
    }, sleepSeconds: () => {}, writeScheduler: () => {},
    runRemoteSample: () => { calls++; return { outcome: 'failed', reason: 'sample_failed', cooldownsByOperation: { message_history_bundle: START + 50_000 } }; } });
  assert.equal(ok, true); assert.equal(calls, 2);
});

test('kernel lock excludes another worker and releases automatically on SIGKILL', { timeout: 20_000 }, async t => {
  const deadline = performance.now() + 10_000;
  const f = fixture(t, { preserveOnFailure: true }); const lock = join(f.opts.logDir, 'synthetic.lock');
  const script = join(f.opts.logDir, 'hold.mjs');
  writeFileSync(script, "import{fstatSync}from'node:fs';process.stdout.write(String(fstatSync(Number(process.env.EXOCORTEX_REMOTE_SAMPLE_LOCK_FD)).isFile())+'\\n');setTimeout(()=>process.exit(2),20000);\n");
  // The wrapper execs the same Python interpreter. This small Python program
  // then execs the synthetic Node owner without dropping its inherited fd.
  const execNode = 'import os,sys;os.execv(sys.argv[1],sys.argv[1:])';
  const args = ['-c', REMOTE_SAMPLE_LOCK_WRAPPER, lock, 'python3', '-c', execNode, process.execPath, script];
  const owner = ownCaseProcess(t, 'python3', args, deadline, 'SIGKILL');
  let output = '';
  owner.child.stdout.on('data', chunk => { output += String(chunk); });
  const watchdog = setTimeout(() => owner.stop('synthetic_lock_watchdog'), 5_000);
  t.after(() => clearTimeout(watchdog));
  try {
    await waitForCondition(() => output.includes('true'), deadline, 'synthetic_lock_ready');
    const contender = ['-c', REMOTE_SAMPLE_LOCK_WRAPPER, lock, 'python3', '-c', execNode, process.execPath, '-e', 'process.stdout.write("acquired")'];
    const competing = spawnSync('python3', contender, { encoding: 'utf8', timeout: remainingCaseMs(deadline) });
    assert.equal(competing.status, 0); assert.equal(JSON.parse(competing.stdout).reason, 'scheduler_busy');
    assert.equal(owner.signalOnce('SIGKILL'), true, 'the test body must own the only termination attempt');
    assertOwnedResult(await owner.result, { code: null, signal: 'SIGKILL' });
    const restarted = spawnSync('python3', contender, { encoding: 'utf8', timeout: remainingCaseMs(deadline) });
    assert.equal(restarted.status, 0); assert.equal(restarted.stdout, 'acquired');
    assert.equal(statSync(lock).mode & 0o777, 0o600);
    remainingCaseMs(deadline);
    f.markPassed();
  } finally { clearTimeout(watchdog); }
});

test('a parent observing killed child cannot overwrite cache outside the guardian-held lock', t => {
  const f = fixture(t);
  writeFileSync(f.paths.cache, JSON.stringify({ status: 'healthy', ok: true }), { mode: 0o600 });
  const sampled = runScheduledRemoteSample(f.opts, { nowMs: f.now,
    invalidateCache: () => { throw Error('parent must not publish outside the lock'); },
    spawnSync: () => ({ status: null, signal: 'SIGKILL', stdout: '' }) });
  assert.equal(sampled.outcome, 'failed');
  const cache = JSON.parse(readFileSync(f.paths.cache, 'utf8'));
  // This fake spawn never executes the guardian. Its lock-held prepare hook
  // owns invalidation; the parent must not race another attempt's publication.
  assert.deepEqual(cache, { status: 'healthy', ok: true });
  assert.equal(statSync(f.paths.cache).mode & 0o777, 0o600);
});

test('state commit failure after collection cannot publish a positive cache', async t => {
  const f = fixture(t); let writes = 0;
  writeFileSync(f.paths.cache, JSON.stringify({ status: 'healthy', ok: true }), { mode: 0o600 });
  const sampled = await executeRemoteSampleAttempt(f.opts, { ...f.deps, invalidateCache: invalidateRemoteSampleCache,
    collect: () => {
      const pending = JSON.parse(readFileSync(f.paths.cache, 'utf8'));
      assert.equal(pending.ok, false); assert.equal(pending.reason, 'attempting');
      return f.result();
    }, writeState: (...args) => { if (++writes === 2) throw Error('invented failed commit'); writeRemoteSampleState(...args); } });
  assert.equal(sampled.reason, 'state_write_failed'); assert.equal(f.caches(), 0);
  assert.equal(JSON.parse(readFileSync(f.paths.cache, 'utf8')).ok, false);
});

test('collector exceptions with no report leave no previous green cache', async t => {
  const f = fixture(t);
  writeFileSync(f.paths.cache, JSON.stringify({ status: 'healthy', ok: true }), { mode: 0o600 });
  const sampled = await executeRemoteSampleAttempt(f.opts, { ...f.deps, invalidateCache: invalidateRemoteSampleCache,
    collect: () => { throw Error('SYNTHETIC_PRIVATE_ERROR'); } });
  assert.equal(sampled.outcome, 'failed');
  const cache = readFileSync(f.paths.cache, 'utf8');
  assert.equal(JSON.parse(cache).ok, false); assert.doesNotMatch(cache, /SYNTHETIC_PRIVATE_ERROR/);
});

test('failure to retract previous cache prevents any new API collection', async t => {
  const f = fixture(t);
  const sampled = await executeRemoteSampleAttempt(f.opts, { ...f.deps, invalidateCache: () => { throw Error('invented cache unwritable'); } });
  assert.equal(sampled.reason, 'cache_write_failed'); assert.equal(f.calls(), 0);
});

test('successful cache stage preparation observes already committed state', async t => {
  const f = fixture(t);
  const sampled = await executeRemoteSampleAttempt(f.opts, { ...f.deps, writeCache: () => {
    assert.equal(f.state().last_outcome, 'ok'); assert.equal(f.state().rotation, 3); return {};
  } });
  assert.equal(sampled.outcome, 'ok'); assert.equal(sampled.cachePrepared, true);
});

test('expired private observations survive repeated due attempts until the collector verifies a match', async t => {
  const f = fixture(t); await executeRemoteSampleAttempt(f.opts, f.deps);
  f.setNow(START + REMOTE_SAMPLE_OBSERVATION_TTL_MS + 1);
  let sawExpired = false;
  await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: (_db, options) => {
    sawExpired = Boolean(options.previousObservations[OBS_KEY]); return { ...f.result(), observations: options.previousObservations };
  } });
  assert.equal(sawExpired, true); assert.deepEqual(f.state().observations, { [OBS_KEY]: observation(START) });
  f.setNow(f.state().next_due);
  await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: (_db, options) => {
    assert.deepEqual(options.previousObservations, { [OBS_KEY]: observation(START) });
    return { ...f.result(), observations: options.previousObservations };
  } });
  assert.deepEqual(f.state().observations, { [OBS_KEY]: observation(START) });
});

test('overflow debt survives restart, collector omission and cache failure; a verified new account isolates it', async t => {
  const f = fixture(t);
  await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: () => ({ ...f.result(), observationOverflow: true }) });
  assert.equal(f.state().observation_overflow, true);
  f.setNow(f.state().next_due);
  await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: (_db, options) => {
    assert.equal(options.previousOverflow, true); return { ...f.result(), observations: {}, observationOverflow: false };
  } });
  assert.equal(f.state().observation_overflow, true);
  f.setNow(f.state().next_due);
  await executeRemoteSampleAttempt(f.opts, { ...f.deps, writeCache: () => false });
  assert.equal(f.state().observation_overflow, true);
  f.setNow(f.state().next_due);
  await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: () => ({ ...f.result(), observations: {}, observationOverflow: false,
    cacheContext: { account_key: 'c'.repeat(64), auth_identity_verified: true } }) });
  assert.equal(f.state().account_key, 'c'.repeat(64));
  assert.equal(f.state().observation_overflow, false);
  assert.deepEqual(f.state().observations, {});
});

test('unverified changed account cannot inherit, erase or rebind the previous account observations', async t => {
  const f = fixture(t); await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: () => ({ ...f.result(), observationOverflow: true }) });
  f.setNow(f.state().next_due);
  const sampled = await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: () => ({ ...f.result(),
    cacheContext: { account_key: 'c'.repeat(64), auth_identity_verified: false }, report: { status: 'inconclusive' } }) });
  assert.equal(sampled.outcome, 'failed'); assert.deepEqual(f.state().observations, { [OBS_KEY]: observation(START) });
  assert.equal(f.state().account_key, ACCOUNT); assert.equal(f.state().last_outcome, 'failed');
  assert.equal(f.state().observation_overflow, true);
  f.setNow(f.state().next_due);
  await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: (_db, options) => {
    assert.equal(options.accountKey, ACCOUNT); assert.equal(options.previousOverflow, true);
    assert.deepEqual(options.previousObservations, { [OBS_KEY]: observation(START) });
    return { ...f.result(), observations: options.previousObservations, observationOverflow: options.previousOverflow };
  } });
  assert.equal(f.state().observation_overflow, true);
});

test('a failed historical request advances only its attempt order, with no evidence refresh or deletion', async t => {
  const f = fixture(t); await executeRemoteSampleAttempt(f.opts, f.deps);
  f.setNow(f.state().next_due);
  const before = f.state().observations[OBS_KEY];
  await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: () => ({ ...f.result(), outcome: 'failed', observations: {},
    historyAttempt: { key: OBS_KEY, checked_at: f.now(), database_key: f.key, source_id: 'lark.im' }, report: { status: 'unavailable', reason: 'api_unavailable' } }) });
  assert.deepEqual(f.state().observations[OBS_KEY], { ...before, last_checked: f.now() });
  assert.equal(f.state().rotation, 3);
  f.setNow(f.state().next_due);
  const attempted = f.state().observations[OBS_KEY];
  await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: () => ({ ...f.result(), outcome: 'failed', observations: {},
    historyAttempt: { key: OBS_KEY, checked_at: f.now(), database_key: f.key, source_id: 'lark.im', body: 'SYNTHETIC_SECRET' }, report: { status: 'unavailable', reason: 'api_unavailable' } }) });
  assert.deepEqual(f.state().observations[OBS_KEY], attempted);
  for (const changes of [{ database_key: 'd'.repeat(64) }, { source_id: 'synthetic.foreign' }]) {
    f.setNow(f.state().next_due);
    await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: () => ({ ...f.result(), outcome: 'failed', observations: {},
      historyAttempt: { key: OBS_KEY, checked_at: f.now(), database_key: f.key, source_id: 'lark.im', ...changes },
      report: { status: 'unavailable', reason: 'api_unavailable' } }) });
    assert.deepEqual(f.state().observations[OBS_KEY], attempted);
  }
});

test('failed publication rolls account, observations and overflow back to one consistent namespace', async t => {
  const f = fixture(t); await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: () => ({ ...f.result(), observationOverflow: true }) });
  f.setNow(f.state().next_due);
  await executeRemoteSampleAttempt(f.opts, { ...f.deps, writeCache: () => false, collect: () => ({ ...f.result(), observations: {},
    observationOverflow: false, cacheContext: { account_key: 'c'.repeat(64), auth_identity_verified: true } }) });
  assert.equal(f.state().account_key, ACCOUNT);
  assert.deepEqual(f.state().observations, { [OBS_KEY]: observation(START) });
  assert.equal(f.state().observation_overflow, true);
});

test('unavailable binding cannot erase debt while leaving the old account namespace in place', async t => {
  const f = fixture(t); await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: () => ({ ...f.result(), observationOverflow: true }) });
  f.setNow(f.state().next_due);
  await executeRemoteSampleAttempt(f.opts, { ...f.deps, collect: () => ({ ...f.result(), observations: {}, observationOverflow: false,
    cacheContext: { auth_identity_verified: false }, report: { status: 'inconclusive', reason: 'account_unverified' } }) });
  assert.equal(f.state().account_key, ACCOUNT);
  assert.deepEqual(f.state().observations, { [OBS_KEY]: observation(START) });
  assert.equal(f.state().observation_overflow, true);
});

test('manual cache-writing sample shares due gate and only returns a sanitized report', async t => {
  const f = fixture(t); let options;
  const sampled = runManualRemoteSample(f.opts, { nowMs: f.now, collectorOptions: {
    startMs: START - 3_600_000, endMs: START - 900_000, hotChats: 1, messagesPerChat: 2, maxApiCalls: 999,
  }, spawnSync: (_command, _args, processOptions) => {
    options = JSON.parse(processOptions.input);
    return { status: 0, stdout: JSON.stringify({ outcome: 'ok', reason: 'sampled', cacheWritten: true, report: {
      status: 'inconclusive', checked_at: new Date(START).toISOString(), body: 'SYNTHETIC_SECRET_BODY', observations: { invented: 1 },
    } }) };
  } });
  assert.equal(options.returnReport, true); assert.equal(options.collectorOptions.hotChats, 1);
  assert.equal(options.collectorOptions.maxApiCalls, undefined); assert.equal(sampled.cacheWritten, true);
  assert.doesNotMatch(JSON.stringify(sampled), /SYNTHETIC|"observations":|"body":/);
  await executeRemoteSampleAttempt(f.opts, f.deps);
  assert.equal(runManualRemoteSample(f.opts, { nowMs: f.now, spawnSync: () => { throw Error('must not spawn'); } }).outcome, 'not_due');
});

const SCHEDULER_URL = new URL('../src/runtime/worker/remote-sample-scheduler.mjs', import.meta.url).href;
async function waitUntil(predicate, milliseconds = 3000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error('synthetic child observation timed out');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } }
function blockedProbe(f) {
  const script = join(f.opts.logDir, 'synthetic-blocked-probe.mjs');
  const ready = join(f.opts.logDir, 'synthetic-ready.json');
  writeFileSync(script, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,parent:process.ppid}),{mode:0o600});setTimeout(()=>process.exit(2),20000);\n`);
  return { script, ready };
}

test('FIFO scheduler state never blocks the read before the first sync cycle', t => {
  const f = fixture(t); mkdirSync(f.paths.directory, { mode: 0o700 });
  assert.equal(spawnSync('mkfifo', ['-m', '600', f.paths.state]).status, 0);
  const code = `import{readScheduledRemoteCooldowns,readRemoteSampleState,startScheduledRemoteSample}from ${JSON.stringify(SCHEDULER_URL)};
    const opts=JSON.parse(process.env.SYNTHETIC_OPTIONS);
    const restored=readScheduledRemoteCooldowns(opts);if(Object.keys(restored).length)throw Error('unexpected cooldown');
    const sample=startScheduledRemoteSample(opts,{spawn:()=>{throw Error('must not spawn')}});
    process.stdout.write(JSON.stringify({restored,sample,sync_can_start:true}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL',
    env: { ...process.env, SYNTHETIC_OPTIONS: JSON.stringify(f.opts) } });
  assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).sync_can_start, true);
  assert.equal(JSON.parse(child.stdout).sample.reason, 'state_invalid');
});

test('background start returns before a blocked probe and explicit stop kills its process group', async t => {
  const f = fixture(t); const probe = blockedProbe(f); const before = Date.now();
  const sample = startScheduledRemoteSample(f.opts, { scriptPath: probe.script });
  assert.equal(sample.outcome, 'started'); assert.equal(sample.reason, 'sample_started');
  assert.ok(Date.now() - before < 1000, 'launch must not wait for the blocked probe');
  t.after(() => sample.stop?.());
  await waitUntil(() => existsSync(probe.ready));
  const child = JSON.parse(readFileSync(probe.ready, 'utf8'));
  assert.equal(alive(child.pid), true);
  sample.stop();
  await waitUntil(() => !alive(child.pid));
});

test('guardian enforces its deadline independently of the worker event loop', { timeout: 20_000 }, async t => {
  const deadline = performance.now() + 10_000;
  const f = fixture(t, { preserveOnFailure: true }); const probe = blockedProbe(f); const before = Date.now();
  const guardian = ownCaseProcess(t, 'python3', ['-c', REMOTE_SAMPLE_LOCK_WRAPPER, join(f.opts.logDir, 'synthetic-deadline.lock'), 'python3',
    '-c', REMOTE_SAMPLE_GUARDIAN, String(process.pid), '600', process.execPath, probe.script], deadline);
  await waitForCondition(() => existsSync(probe.ready), deadline, 'synthetic_probe_ready');
  const child = JSON.parse(readFileSync(probe.ready, 'utf8'));
  // This blocks Node's loop: the separate supervisor must still enforce time.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
  assertOwnedResult(await guardian.result, { code: 2 });
  assert.ok(Date.now() - before < 3000); assert.equal(alive(child.pid), false);
  f.markPassed();
});

test('guardian observes parent exit and removes an unfinished probe without waiting sixty seconds', { timeout: 20_000 }, async t => {
  const deadline = performance.now() + 10_000;
  const f = fixture(t, { preserveOnFailure: true }); const probe = blockedProbe(f); const launcher = join(f.opts.logDir, 'synthetic-parent.mjs');
  writeFileSync(launcher, `import{spawn}from'node:child_process';import{existsSync}from'node:fs';
    const guardian=spawn('python3',['-c',${JSON.stringify(REMOTE_SAMPLE_LOCK_WRAPPER)},${JSON.stringify(join(f.opts.logDir, 'parent-exit.lock'))},'python3',
      '-c',${JSON.stringify(REMOTE_SAMPLE_GUARDIAN)},String(process.pid),'60000',process.execPath,${JSON.stringify(probe.script)}],{stdio:'ignore',detached:true});
    guardian.unref();const timer=setInterval(()=>{if(existsSync(${JSON.stringify(probe.ready)})){clearInterval(timer);process.exit(0)}},10);setTimeout(()=>process.exit(2),2000).unref();\n`);
  const parent = ownCaseProcess(t, process.execPath, [launcher], deadline, 'SIGKILL');
  assertOwnedResult(await parent.result);
  const child = JSON.parse(readFileSync(probe.ready, 'utf8'));
  await waitForCondition(() => !alive(child.pid), deadline, 'synthetic_probe_exit');
  f.markPassed();
});

test('controller suppresses duplicate launches and stops its one owned job', () => {
  let now = START; let starts = 0; let stops = 0; let fallback;
  const controller = createRemoteSampleController({}, { nowMs: () => now, start: (_opts, deps) => {
    starts++; fallback = deps.notBeforeIfMissing;
    return { outcome: 'started', reason: 'sample_started', stop: () => { stops++; } };
  } });
  assert.equal(controller.run().outcome, 'started');
  assert.equal(controller.run().outcome, 'not_due'); assert.equal(starts, 1);
  now += 60_000; controller.run();
  assert.equal(starts, 2); assert.equal(fallback, START + 900_000); assert.equal(stops, 1);
  controller.stop(); controller.stop(); assert.equal(stops, 2);
});

test('worker continues sync while its diagnostic process is blocked and stops it on worker exit', async t => {
  const f = fixture(t); const probe = blockedProbe(f);
  const controller = createRemoteSampleController(f.opts, { scriptPath: probe.script });
  const events = []; let observedChild;
  const opts = { ...parseArgs(['--max-cycles', '2']), ...f.opts };
  const ok = runWorker(opts, { remoteSampleController: controller, runCycle: (_opts, cycle) => {
    if (cycle === 2) {
      assert.ok(existsSync(probe.ready)); observedChild = JSON.parse(readFileSync(probe.ready, 'utf8'));
      assert.equal(alive(observedChild.pid), true, 'second sync runs while diagnostic API child remains blocked');
    }
    return true;
  }, sleepSeconds: () => {
    const until = Date.now() + 2000;
    while (!existsSync(probe.ready) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }, writeScheduler: (_opts, event) => events.push(event) });
  assert.equal(ok, true); assert.equal(events.length, 1); assert.equal(events[0].outcome, 'started');
  await waitUntil(() => !alive(observedChild.pid));
});

test('worker finally stops the asynchronous diagnostic on sync exceptions', () => {
  let stopped = 0;
  assert.throws(() => runWorker(parseArgs(['--once']), { remoteSampleController: { run: () => ({}), stop: () => { stopped++; } },
    runCycle: () => { throw Error('synthetic sync exception'); } }), /synthetic sync exception/);
  assert.equal(stopped, 1);
});

test('guardian removes a spawned CLI descendant when the probe leader exits', { timeout: 20_000 }, async t => {
  const deadline = performance.now() + 10_000;
  const f = fixture(t, { preserveOnFailure: true }); const script = join(f.opts.logDir, 'synthetic-descendant.mjs');
  const ready = join(f.opts.logDir, 'synthetic-descendant.json');
  writeFileSync(script, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
    const descendant=spawn(process.execPath,['-e','setTimeout(()=>process.exit(2),20000)'],{stdio:'ignore'});
    writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:descendant.pid}),{mode:0o600});
    descendant.unref();setTimeout(()=>process.exit(0),100);\n`);
  const guardian = ownCaseProcess(t, 'python3', ['-c', REMOTE_SAMPLE_LOCK_WRAPPER, join(f.opts.logDir, 'synthetic-descendant.lock'), 'python3',
    '-c', REMOTE_SAMPLE_GUARDIAN, String(process.pid), '2000', process.execPath, script], deadline);
  await waitForCondition(() => existsSync(ready), deadline, 'synthetic_descendant_ready');
  const descendant = JSON.parse(readFileSync(ready, 'utf8'));
  assert.equal(alive(descendant.pid), true);
  assertOwnedResult(await guardian.result);
  await waitForCondition(() => !alive(descendant.pid), deadline, 'synthetic_descendant_exit');
  f.markPassed();
});
