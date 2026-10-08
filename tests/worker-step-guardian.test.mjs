import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WORKER_STEP_GUARDIAN, runGuardedWorkerStep, STEP_MAX_OUTPUT_BYTES } from '../src/runtime/worker/step-process.mjs';
import { WORKER_STEP_ANCHOR } from '../src/runtime/worker/remote-sample-anchor.mjs';
import { runStep } from '../src/runtime/worker/worker.mjs';

const privateToken = 'SYNTHETIC_PRIVATE_PATH_BODY_TOKEN';
function mock(scenario = {}, mode = 'guardian') {
  const result = spawnSync('python3', [fileURLToPath(new URL('./remote_sample_guardian_mock.py', import.meta.url))], {
    input: JSON.stringify({ code: mode === 'anchor' ? WORKER_STEP_ANCHOR : WORKER_STEP_GUARDIAN,
      mode, profile: 'step', scenario }), encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.uncaught, null);
  assert.equal(observed.stderr, '');
  assert.equal(observed.stdout.includes(privateToken), false);
  assert.equal(observed.calls.includes('wait_unbounded'), false);
  assert.equal(observed.calls.includes('anchor_poll_forbidden'), false);
  assert.equal(observed.calls.includes('blocking_read_forbidden'), false);
  return observed;
}
const envelope = observed => JSON.parse(observed.stdout);
const diag = (primary, cleanup = null, errno = null, cleanupErrno = 1) => ({ version: 1,
  primary: primary ? { stage: primary, errno } : null,
  cleanup: cleanup ? { stage: cleanup, errno: cleanupErrno } : null });
const b64 = text => Buffer.from(text).toString('base64');
const wire = (extra = {}) => JSON.stringify({ version: 1, code: 0, stdout: b64('{"ok":true}'), stderr: '', diagnostic: null, ...extra });

for (const primary of ['guardian_setup', 'control_create', 'control_nonblocking', 'child_spawn',
  'capture_nonblocking', 'capture_read', 'control_read', 'control_write']) {
  test(`step guardian preserves ${primary} without retries or private exceptions`, () => {
    const observed = mock({ primary });
    assert.deepEqual(envelope(observed).diagnostic, diag(primary, null, 1));
    assert.equal(observed.calls.filter(call => call === primary).length, 1);
    assert.ok(observed.calls.filter(call => call === 'group_kill').length <= 1);
    if (primary === 'capture_read') assert.equal(observed.calls.includes('capture_drain'), false);
  });
}

for (const cleanup of ['group_kill', 'child_reap', 'capture_drain', 'capture_close', 'control_close']) {
  test(`step guardian retains independent ${cleanup} failure and rejects healthy output`, () => {
    const observed = mock({ primary: 'control_read', cleanup });
    const expectedPrimary = cleanup === 'control_close' ? null : 'control_read';
    assert.deepEqual(envelope(observed).diagnostic, diag(expectedPrimary, cleanup, expectedPrimary ? 1 : null));
    assert.ok(observed.calls.filter(call => call === 'group_kill').length <= 1);
    if (cleanup === 'group_kill') assert.equal(observed.calls.includes('child_reap'), false);
    const result = runGuardedWorkerStep('synthetic', [], { timeout: 5000 }, {
      spawnSync: () => ({ status: observed.exit_code, stdout: observed.stdout }),
    });
    assert.equal(result.status, null);
    assert.deepEqual(result.guardian_diagnostic, envelope(observed).diagnostic);
  });
}

test('step anchor uses the shared protocol, preserves stderr and ignores all sampler cache environment', () => {
  for (const code of [0, 2, 7, -15]) {
    const observed = mock({ worker_returncode: code, env: {
      EXOCORTEX_REMOTE_SAMPLE_PUBLICATION: 'invalid-private-cache-contract', EXOCORTEX_REMOTE_SAMPLE_LOCK_FD: 'bad',
    } }, 'anchor');
    assert.equal(observed.primary, null);
    assert.deepEqual(observed.frames.map(row => row.frame), [{ version: 1, type: 'ready' }, { version: 1, type: 'done', code }]);
    assert.equal(observed.spawns[0].kwargs.stderr, 'stderr');
    assert.equal(observed.spawns[0].kwargs.start_new_session, false);
    assert.deepEqual(observed.spawns[0].kwargs.pass_fds, []);
    assert.equal(observed.calls.includes('group_kill'), false);
  }
});

test('step guardian pins the owned group until one termination after every exit code', () => {
  for (const code of [0, 2, 3, 7, -15]) {
    const observed = mock({ worker_returncode: code, stderr_text: 'invented child stderr', live_descendants: true });
    assert.equal(envelope(observed).diagnostic, null);
    assert.equal(envelope(observed).code, code);
    assert.equal(Buffer.from(envelope(observed).stderr, 'base64').toString(), 'invented child stderr');
    assert.equal(observed.spawns[0].kwargs.start_new_session, true);
    assert.deepEqual(observed.spawns[0].kwargs.pass_fds, [40, 43]);
    const ops = observed.operations;
    assert.equal(ops.filter(op => op.op === 'killpg').length, 1);
    assert.equal(ops.some(op => op.op === 'poll'), false);
    assert.ok(ops.findIndex(op => op.op === 'wait') > ops.findIndex(op => op.op === 'killpg'));
    assert.equal(ops.find(op => op.op === 'wait').timeout, 1);
    assert.deepEqual(ops.filter(op => op.op === 'capture_close').map(op => op.fd), [17, 18]);
  }
});

test('step guardian rejects malformed, duplicate, truncated and extra terminal frames', () => {
  for (const scenario of [{ duplicate_ready: true }, { duplicate_done: true, status_chunk_bytes: 1 },
    { status_raw: 'x'.repeat(257) }, { status_raw: '{invalid}\n' },
    { done_frame: { version: 1, type: 'done', code: true } }, { done_frame: { version: 1, type: 'done', code: 256 } },
    { done_frame: { version: 1, type: 'done', code: 0, private: privateToken } },
    { done_frame: { version: 1, type: 'error', stage: privateToken, errno: 1 } }]) {
    assert.equal(envelope(mock(scenario)).diagnostic.primary.stage, 'control_protocol');
  }
  for (const scenario of [{ status_eof: true }, { status_eof_after_go: true }, { anchor_returncode: 0 }]) {
    assert.equal(envelope(mock(scenario)).diagnostic.primary.stage, 'anchor_lost');
  }
  assert.deepEqual(envelope(mock({ anchor_error: true })).diagnostic, diag('anchor_worker_spawn', null, 1));
});

test('step guardian bounds parent loss, stopping, deadlines and continuously writing streams', () => {
  for (const [scenario, stage] of [[{ parent_exit: true }, 'parent_exit'], [{ parent_exit_after_go: true }, 'parent_exit'],
    [{ parent_exit_after_reads: 2 }, 'parent_exit'], [{ parent_exit_after_kill: true }, 'parent_exit'],
    [{ signal_stop: true }, 'signal_stop'], [{ deadline: true }, 'deadline'],
    [{ write_chunk_bytes: 2 }, 'control_write'], [{ stderr_overflow: true }, 'output_limit'],
    [{ continuous_output: true, no_done: true, deadline: true, limit: STEP_MAX_OUTPUT_BYTES }, 'deadline']]) {
    const observed = mock(scenario);
    assert.equal(envelope(observed).diagnostic.primary.stage, stage);
    assert.ok(observed.fake_elapsed_ms < 5200);
    if (scenario.parent_exit || scenario.parent_exit_after_reads) assert.equal(observed.go_sent, false);
  }
});

test('step guardian never retries refused group signals, reap or failed result publication', () => {
  const absent = mock({ already_gone: true });
  assert.deepEqual(envelope(absent).diagnostic, diag(null, 'group_kill', null, 3));
  assert.equal(absent.calls.filter(call => call === 'group_kill').length, 1);
  const reap = mock({ reap_timeout: true });
  assert.deepEqual(envelope(reap).diagnostic, diag(null, 'child_reap', null, null));
  assert.equal(reap.calls.filter(call => call === 'child_reap').length, 1);
  for (const scenario of [{ primary: 'result_publish' }, { publish_flush: true }]) {
    const observed = mock(scenario);
    assert.equal(observed.exit_code, 2);
    assert.equal(observed.calls.filter(call => call === 'result_publish').length, 1);
    assert.equal(observed.calls.at(-1), 'immediate_exit');
  }
  for (const fd of [17, 18]) {
    const observed = mock({ set_blocking_fail_fd: fd });
    assert.equal(envelope(observed).diagnostic.primary.stage, 'capture_nonblocking');
    assert.equal(observed.operations.some(op => op.op === 'read' && op.args[0] === fd), false);
  }
});

test('step wrapper reserves envelope space and only signals its detached guardian with TERM', () => {
  let call;
  const result = runGuardedWorkerStep('synthetic-node', ['synthetic-script', 'sync'], { timeout: 600000, env: { SYNTHETIC: 'yes' } }, {
    spawnSync: (command, args, options) => { call = { command, args, options }; return { status: 0, stdout: wire() }; },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '{"ok":true}');
  assert.equal(call.command, 'python3');
  assert.equal(call.args[1], WORKER_STEP_GUARDIAN);
  assert.deepEqual(call.args.slice(-3), ['synthetic-node', 'synthetic-script', 'sync']);
  assert.equal(call.options.timeout, 602000);
  assert.equal(call.options.killSignal, 'SIGTERM');
  assert.equal(call.options.detached, true);
  assert.ok(call.options.maxBuffer > STEP_MAX_OUTPUT_BYTES * 4 / 3);
  assert.deepEqual(call.options.env, { SYNTHETIC: 'yes' });
});

test('step wrapper rejects corrupted envelopes and never leaks supervisor exceptions', () => {
  for (const stdout of ['', 'invalid', wire({ version: 2 }), wire({ code: true }), wire({ code: null }),
    wire({ stdout: '$bad' }), wire({ diagnostic: { ...diag('deadline'), private: privateToken } }),
    wire({ diagnostic: diag('deadline', privateToken) }), wire({ private: privateToken })]) {
    const result = runGuardedWorkerStep('synthetic', [], { timeout: 5000 }, { spawnSync: () => ({ status: 0, stdout, stderr: privateToken }) });
    assert.equal(result.status, null);
    assert.equal(result.guardian_diagnostic.primary.stage, 'guardian_result');
    assert.equal(JSON.stringify(result).includes(privateToken), false);
  }
  const result = runGuardedWorkerStep('synthetic', [], { timeout: 5000 }, { spawnSync: () => { throw new Error(privateToken); } });
  assert.deepEqual(result.guardian_diagnostic, diag('guardian_spawn'));
  for (const [error, stage] of [[{ code: 'ETIMEDOUT' }, 'guardian_timeout'], [{ code: 'ENOBUFS' }, 'guardian_output_limit']]) {
    const failed = runGuardedWorkerStep('synthetic', [], { timeout: 5000 }, { spawnSync: () => ({ status: null, error, stdout: wire({ diagnostic: diag('deadline', 'child_reap') }) }) });
    assert.equal(failed.status, null);
    assert.deepEqual(failed.guardian_diagnostic, diag('deadline', 'child_reap'));
    const onlyOuter = runGuardedWorkerStep('synthetic', [], { timeout: 5000 }, { spawnSync: () => ({ status: null, error }) });
    assert.equal(onlyOuter.guardian_diagnostic.primary.stage, stage);
  }
});

test('step wrapper retains exit and partial protocol, while cleanup failure defeats either', () => {
  for (const [code, summary, expected] of [[0, { ok: true }, true], [2, { ok: false, partial: true }, false], [7, { ok: false }, false]]) {
    const runProcess = (_command, _args, options) => runGuardedWorkerStep('synthetic', [], options, {
      spawnSync: () => ({ status: 0, stdout: wire({ code, stdout: b64(JSON.stringify(summary)) }) }),
    });
    const step = runStep('synthetic', [], { runProcess });
    assert.equal(step.ok, expected); assert.equal(step.exit_code, code);
    assert.equal(step.partial, code === 2 ? true : undefined);
    const failed = runStep('synthetic', [], { runProcess: (_command, _args, options) => runGuardedWorkerStep('synthetic', [], options, {
      spawnSync: () => ({ status: 0, stdout: wire({ code, stdout: b64(JSON.stringify(summary)), diagnostic: diag(null, 'group_kill') }) }),
    }) });
    assert.equal(failed.ok, false); assert.equal(failed.partial, undefined);
    assert.deepEqual(failed.guardian_diagnostic, diag(null, 'group_kill'));
  }
});
