import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Script } from 'node:vm';

const cacheSource = readFileSync(new URL('./remote-sample-cache-acceptance.test.mjs', import.meta.url), 'utf8');
const lifecycleSource = readFileSync(new URL('./remote-sample-process-cleanup.test.mjs', import.meta.url), 'utf8');
function between(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'the actual acceptance body must remain identifiable');
  return source.slice(from, to);
}
const finished = stdout => ({ failure: null, signalError: null, signalAttempted: false,
  signal: null, code: 0, stdout: Buffer.from(JSON.stringify(stdout)), stderr: Buffer.alloc(0) });
const diagnostic = (stage, cleanup) => ({ version: 1, primary: { stage, errno: null }, cleanup });

// Execute the actual acceptance callbacks, completed() and traceAttempt() in
// memory. Every file, process, PID wait and lock probe below is a fake; no
// acceptance module is imported or allowed to launch its real-process matrix.
async function cacheCase(index, cleanup) {
  const calls = [], files = new Map(), fixture = { root: '/invented', logDir: '/invented/logs',
    deadline: 10000, owned: [], attempts: [], observed: [] };
  const cfg = { nonce: 'synthetic', callerRecord: 'caller', guardianRecord: 'guardian',
    anchorRecord: 'anchor', workerRecord: 'worker', leaseRecord: 'lease' };
  for (const [role, pid, ppid] of [['caller', 41, 40], ['guardian', 42, 41], ['anchor', 43, 42],
    ...(index === 1 ? [['worker', 44, 43]] : [])]) {
    files.set(role, JSON.stringify({ role, pid, ppid, nonce: cfg.nonce }));
  }
  files.set('/invented/logs/live-probe.json', JSON.stringify({ kind: 'lark_im_live_probe_cache/pending', ok: false, reason: 'attempting' }));
  const output = { result: { outcome: 'failed', reason: 'sample_process_failed',
    guardian_diagnostic: diagnostic(index === 0 ? 'child_exit' : 'guardian_result', cleanup) },
    outer: { pid: 42, status: 2, signal: null, error_code: null }, publication: { stagePath: '/invented/absent-stage' } };
  const handle = { child: { pid: 41 }, result: Promise.resolve(finished(output)), stop: () => calls.push('stop') };
  let callback;
  const source = between(cacheSource, 'async function completed(', 'function seedHealthy(')
    + between(cacheSource, 'const CASES = [', "test('real synthetic cache publication")
    + `\nCASES.splice(0, ${index}); CASES.length = 1;\n`
    + cacheSource.slice(cacheSource.indexOf("test('real synthetic cache publication"));
  new Script(source).runInNewContext({ assert, Buffer, join, process: { pid: 40 }, performance: { now: () => 0 },
    test: (_name, body) => { callback = body; }, caseFixture: () => fixture, database: () => '/invented/db',
    seedHealthy: () => ({ bytes: Buffer.from('synthetic healthy seed') }),
    attempt: () => { fixture.owned.push(handle); return { cfg, handle }; },
    readJson: path => JSON.parse(files.get(path)), existsSync: path => files.has(path),
    readFileSync: path => Buffer.from(files.get(path)), parseRemoteSampleCache: () => null,
    verifyReleased: async () => { calls.push('pid_wait', 'lock_probe'); }, rmSync: () => calls.push('remove_fixture') });
  let error;
  try { await callback({ test: async (_name, body) => body({ skip: () => assert.fail('unexpected skip'), diagnostic() {} }) }); }
  catch (value) { error = value; }
  return { calls, error, observed: fixture.observed };
}

async function lifecycleCase(cleanup) {
  const calls = [], nonce = 'synthetic', files = new Map([
    ['caller', { nonce, pid: 41 }], ['guardian', { nonce, pid: 42 }], ['worker', { nonce, pid: 44, anchor: 43 }],
  ]);
  const result = { outcome: 'failed', guardian_diagnostic: diagnostic('child_exit', cleanup) };
  const handle = { child: { pid: 41 }, result: Promise.resolve(finished(result)), stop: () => calls.push('stop') };
  let callback;
  const source = between(lifecycleSource, 'function recorded(', 'function fixture(')
    + '\nlet firstFailure = null;\n'
    + between(lifecycleSource, 'function lifecycleTest(', "for (const kind of ['manual_cache', 'read_only'])")
    + "\nlifecycleTest('synthetic', 'read_only', 'fast7');\n";
  new Script(source).runInNewContext({ assert, Buffer, join, performance: { now: () => 0 },
    test: (_name, _options, body) => { callback = body; },
    fixture: () => ({ directory: '/invented', nonce, callerRecord: 'caller', guardianRecord: 'guardian', workerRecord: 'worker' }),
    startOwnedProcess: () => handle, process: { execPath: '/invented/node' },
    readFileSync: path => JSON.stringify(files.get(path)),
    waitForPidsToExit: async () => calls.push('pid_wait'), assertReleased: async () => calls.push('lock_probe'),
    rmSync: () => calls.push('remove_fixture') });
  let error;
  try { await callback({ skip: () => assert.fail('unexpected skip'), diagnostic() {} }); }
  catch (value) { error = value; }
  return { calls, error };
}

for (const [name, run] of [['cache startup failure', cleanup => cacheCase(0, cleanup)],
  ['cache missing stage', cleanup => cacheCase(1, cleanup)], ['lifecycle worker failure', lifecycleCase]]) {
  test(`${name} accepts explicit successful cleanup before observing release`, async () => {
    const output = await run(null);
    assert.equal(output.error, undefined);
    assert.deepEqual(output.calls, ['pid_wait', 'lock_probe', 'remove_fixture']);
    if (output.observed) assert.ok(output.observed.length >= 3, 'actual traceAttempt validated the fictional process chain');
  });
  for (const [label, cleanup] of [['group_kill errno1', { stage: 'group_kill', errno: 1 }],
    ['capture_close errno1', { stage: 'capture_close', errno: 1 }], ['missing cleanup', undefined]]) {
    test(`${name} rejects ${label} before PID waits or lock probes`, async () => {
      const output = await run(cleanup);
      assert.equal(output.error?.code, 'ERR_ASSERTION');
      assert.equal(output.calls.includes('pid_wait'), false);
      assert.equal(output.calls.includes('lock_probe'), false);
      assert.equal(output.calls.includes('remove_fixture'), false);
      if (output.observed) assert.deepEqual(output.observed, []);
    });
  }
}
