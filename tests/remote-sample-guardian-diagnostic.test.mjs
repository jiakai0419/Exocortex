import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REMOTE_SAMPLE_ANCHOR } from '../src/runtime/worker/remote-sample-anchor.mjs';
import { REMOTE_SAMPLE_GUARDIAN, runGuardedRemoteSampleProcess, safeGuardianDiagnostic } from '../src/runtime/worker/remote-sample-process.mjs';
import { runManualRemoteSample } from '../src/runtime/worker/remote-sample-scheduler.mjs';
import { runReadOnlyRemoteSample } from '../src/diagnostics/remote-sample.mjs';
import { publicRemoteReport, remoteSampleCache, parseRemoteSampleCache } from '../src/diagnostics/remote-sample-cache.mjs';
import { collectCheckReport } from '../src/diagnostics/check-report.mjs';
import { fixture, options, at } from './helpers/check-fixture.mjs';

const privateToken = 'SYNTHETIC_PRIVATE_PATH_BODY_TOKEN';
const diagnostic = (primary = 'watch_register', cleanup = null) => ({ version: 1,
  primary: primary ? { stage: primary, errno: 1 } : null, cleanup: cleanup ? { stage: cleanup, errno: 1 } : null });
const failureOutput = (value = diagnostic()) => JSON.stringify({ outcome: 'failed', reason: 'sample_process_failed', next_due: null, guardian_diagnostic: value });

// Only this fixture interpreter runs. It substitutes every OS/process module,
// rejects unmocked imports and does not spawn, watch, signal or wait for a child.
function mockGuardian(scenario = {}, mode = 'guardian') {
  const result = spawnSync('python3', [fileURLToPath(new URL('./remote_sample_guardian_mock.py', import.meta.url))], {
    input: JSON.stringify({ code: mode === 'anchor' ? REMOTE_SAMPLE_ANCHOR : REMOTE_SAMPLE_GUARDIAN, mode, scenario }), encoding: 'utf8', timeout: 5000, maxBuffer: 262144,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.uncaught, null);
  assert.equal(observed.stderr, '');
  assert.equal(observed.stdout.includes(privateToken), false);
  assert.equal(observed.calls.includes('wait_unbounded'), false);
  return observed;
}

const envelope = (observed) => JSON.parse(observed.stdout).guardian_diagnostic;
const safeFailure = (primary, cleanup = null, primaryErrno = null, cleanupErrno = 1) => ({ version: 1,
  primary: primary ? { stage: primary, errno: primaryErrno } : null,
  cleanup: cleanup ? { stage: cleanup, errno: cleanupErrno } : null });

for (const primary of ['guardian_setup', 'control_create', 'control_nonblocking', 'child_spawn', 'capture_nonblocking', 'capture_read', 'control_read', 'control_write']) {
  test(`mock guardian preserves safe primary stage ${primary}`, () => {
    const observed = mockGuardian({ primary });
    assert.equal(observed.exit_code, 2);
    assert.deepEqual(envelope(observed), safeFailure(primary, null, 1));
    assert.equal(observed.calls.filter((value) => value === primary).length, 1);
    assert.ok(observed.calls.filter((value) => value === 'group_kill').length <= 1);
    if (['capture_nonblocking', 'capture_read'].includes(primary)) assert.equal(observed.calls.includes('capture_drain'), false);
  });
}

for (const cleanup of ['group_kill', 'child_reap', 'capture_drain', 'capture_close']) {
  test(`mock guardian preserves independent cleanup stage ${cleanup}`, () => {
    const observed = mockGuardian({ primary: 'control_read', cleanup });
    assert.equal(observed.exit_code, 2);
    assert.deepEqual(envelope(observed), safeFailure('control_read', cleanup, 1));
    assert.equal(observed.calls.filter((value) => value === cleanup).length, 1);
    if (cleanup === 'group_kill') assert.equal(observed.calls.includes('child_reap'), false);
  });
}

test('mock guardian successful fast worker retains live anchor until single group kill', () => {
  for (const scenario of [{}, { live_descendants: true }, { status_chunk_bytes: 1 }]) {
    const observed = mockGuardian(scenario);
    assert.equal(observed.exit_code, 0);
    assert.equal(observed.stdout, '{"outcome":"ok","synthetic":true}');
    assert.equal(observed.spawns.length, 1);
    assert.equal(observed.spawns[0].kwargs.start_new_session, true);
    assert.equal(observed.spawns[0].kwargs.close_fds, true);
    assert.deepEqual(observed.spawns[0].kwargs.pass_fds, [40, 43]);
    assert.deepEqual(observed.frames, [{ role: 'control', frame: { version: 1, type: 'go' } }]);
    const ops = observed.operations;
    assert.ok(ops.findLastIndex((op) => op.op === 'pipe') < ops.findIndex((op) => op.op === 'Popen'));
    assert.equal(ops.filter((op) => op.op === 'killpg').length, 1);
    assert.equal(ops.some((op) => op.op === 'poll'), false);
    assert.ok(ops.findIndex((op) => op.op === 'wait') > ops.findIndex((op) => op.op === 'killpg'));
    assert.equal(ops.find((op) => op.op === 'wait').timeout, 1);
    assert.ok(Object.values(observed.pipe_closed).every(Boolean));
    for (const fd of [17, 41, 42]) assert.equal(observed.nonblocking[String(fd)], true);
  }
});

test('mock guardian never retries denied kill or reaps before successful termination', () => {
  const denied = mockGuardian({ cleanup: ['group_kill', 'capture_drain', 'capture_close', 'control_close'] });
  assert.equal(denied.exit_code, 2);
  // Setup descriptor close fails first, so preserve that first cleanup failure.
  assert.deepEqual(envelope(denied), safeFailure(null, 'control_close'));
  assert.equal(denied.calls.filter((value) => value === 'group_kill').length, 1);
  assert.equal(denied.calls.includes('child_reap'), false);
  const killOnly = mockGuardian({ cleanup: 'group_kill' });
  assert.deepEqual(envelope(killOnly), safeFailure(null, 'group_kill'));
  assert.equal(killOnly.calls.includes('child_reap'), false);
  const gone = mockGuardian({ already_gone: true });
  assert.equal(gone.exit_code, 2);
  assert.deepEqual(envelope(gone), safeFailure(null, 'group_kill', null, 3));
  assert.equal(gone.calls.filter((value) => value === 'child_reap').length, 1);
});

test('mock guardian preserves confirmed worker failure independently of cleanup outcome', () => {
  for (const scenario of [{}, { cleanup: 'group_kill' }, { cleanup: 'capture_drain' }, { reap_timeout: true }]) {
    const observed = mockGuardian({ worker_returncode: 7, ...scenario });
    assert.equal(observed.exit_code, 2);
    const cleaning = scenario.reap_timeout ? 'child_reap' : scenario.cleanup || null;
    assert.deepEqual(envelope(observed), safeFailure('child_exit', cleaning, null, scenario.reap_timeout ? null : 1));
    assert.equal(observed.calls.filter((value) => value === 'child_reap').length, scenario.cleanup === 'group_kill' ? 0 : 1);
  }
  const unknown = mockGuardian({ deadline: true, no_done: true, reap_timeout: true });
  assert.deepEqual(envelope(unknown), safeFailure('deadline', 'child_reap', null, null));
});

test('confirmed unexpected anchor exit survives an independent capture-close failure', () => {
  // Reviewer counterexample: DONE(0), successful wait returning anchor code 0,
  // then stdout.close raises. Neither independently confirmed error may vanish.
  const observed = mockGuardian({ anchor_returncode: 0, cleanup: 'capture_close' });
  assert.equal(observed.exit_code, 2);
  assert.deepEqual(envelope(observed), safeFailure('anchor_lost', 'capture_close'));
  for (const scenario of [{ reap_timeout: true }, { anchor_returncode: null }]) {
    const unknown = mockGuardian({ ...scenario, cleanup: 'capture_close' });
    assert.equal(envelope(unknown).primary, null);
    assert.deepEqual(envelope(unknown).cleanup, { stage: 'child_reap', errno: null });
  }
});

test('mock guardian rejects malformed, duplicated, premature and oversized frames', () => {
  const ready = { version: 1, type: 'ready' };
  for (const scenario of [
    { duplicate_ready: true }, { duplicate_done: true }, { status_frames: [{ version: 1, type: 'done', code: 0 }] },
    { ready_frame: { ...ready, private: privateToken } }, { ready_frame: { ...ready, version: true } },
    { status_raw: 'x'.repeat(257) }, { status_raw: '{invalid}\n' },
    { done_frame: { version: 1, type: 'done', code: true } }, { done_frame: { version: 1, type: 'done', code: 256 } },
    { done_frame: { version: 1, type: 'error', stage: privateToken, errno: 1 } },
    { done_frame: { version: 1, type: 'error', stage: 'anchor_worker_spawn', errno: 0 } },
  ]) {
    const observed = mockGuardian(scenario);
    assert.equal(observed.exit_code, 2);
    assert.deepEqual(envelope(observed), safeFailure('control_protocol'));
  }
  for (const scenario of [{ status_eof: true }, { status_eof_after_go: true }, { anchor_returncode: 0 }]) {
    const observed = mockGuardian(scenario);
    assert.deepEqual(envelope(observed), safeFailure('anchor_lost'));
  }
  const anchorError = mockGuardian({ anchor_error: true, anchor_error_stage: 'anchor_worker_spawn', anchor_errno: 1 });
  assert.deepEqual(envelope(anchorError), safeFailure('anchor_worker_spawn', null, 1));
});

test('mock guardian distinguishes deadline, caller loss, signal, output overflow and partial GO', () => {
  for (const [scenario, stage] of [[{ deadline: true }, 'deadline'], [{ overflow: true }, 'output_limit'],
    [{ parent_exit: true }, 'parent_exit'], [{ parent_exit_after_go: true }, 'parent_exit'],
    [{ parent_exit_after_reads: 2 }, 'parent_exit'], [{ signal_stop: true }, 'signal_stop'],
    [{ write_chunk_bytes: 2 }, 'control_write']]) {
    const observed = mockGuardian(scenario);
    assert.equal(observed.exit_code, 2);
    assert.deepEqual(envelope(observed), safeFailure(stage));
    if (scenario.deadline) assert.ok(observed.fake_elapsed_ms <= 5);
    if (scenario.parent_exit) assert.equal(observed.calls.includes('child_spawn'), false);
    if (scenario.parent_exit_after_reads) assert.equal(observed.go_sent, false);
  }
  const blocked = mockGuardian({ write_blocked: true });
  assert.equal(envelope(blocked).primary.stage, 'control_write');
  assert.ok([11, 35].includes(envelope(blocked).primary.errno));
});

test('mock guardian fails control close and background silently without starting worker', () => {
  const close = mockGuardian({ cleanup: 'control_close' });
  assert.equal(close.go_sent, false);
  assert.deepEqual(envelope(close), safeFailure(null, 'control_close'));
  const background = mockGuardian({ background: true, primary: 'control_read' });
  assert.equal(background.exit_code, 2);
  assert.equal(background.stdout, '');
  assert.deepEqual(background.primary, { stage: 'control_read', errno: 1 });
});

test('mock guardian does not retry failed result write, flush or timed-out reap', () => {
  const publish = mockGuardian({ primary: 'result_publish' });
  assert.equal(publish.exit_code, 2);
  assert.equal(publish.stdout, '');
  assert.deepEqual(publish.primary, { stage: 'result_publish', errno: 1 });
  assert.equal(publish.calls.filter((value) => value === 'result_publish').length, 1);
  assert.equal(publish.calls.at(-1), 'immediate_exit');
  const flush = mockGuardian({ publish_flush: true });
  assert.equal(flush.exit_code, 2);
  assert.deepEqual(flush.primary, { stage: 'result_publish', errno: 1 });
  assert.equal(flush.calls.filter((value) => value === 'publish_flush').length, 1);
  assert.equal(flush.calls.at(-1), 'immediate_exit');
  const reap = mockGuardian({ reap_timeout: true });
  assert.deepEqual(envelope(reap), safeFailure(null, 'child_reap', null, null));
  assert.equal(reap.calls.filter((value) => value === 'child_reap').length, 1);
});

test('mock anchor starts worker only after GO and separates worker result from anchor lifetime', () => {
  for (const code of [0, 7, -15]) {
    const observed = mockGuardian({ worker_returncode: code }, 'anchor');
    assert.equal(observed.spawns.length, 1);
    assert.equal(observed.spawns[0].kwargs.start_new_session, false);
    assert.equal(observed.spawns[0].kwargs.close_fds, true);
    assert.deepEqual(observed.spawns[0].kwargs.pass_fds, []);
    assert.deepEqual(observed.frames.map((entry) => entry.frame), [{ version: 1, type: 'ready' }, { version: 1, type: 'done', code }]);
    assert.equal(observed.calls.includes('group_kill'), false);
    assert.equal(observed.calls.includes('child_reap'), false);
    assert.equal(observed.calls.at(-1), 'immediate_exit');
  }
});

test('mock anchor bounds missing GO and rejects invalid, duplicate or private control fields', () => {
  for (const scenario of [{ control_eof: true }, { control_raw: 'x'.repeat(257) },
    { control_frames: [{ version: 1, type: 'go', private: privateToken }] },
    { control_frames: [{ version: true, type: 'go' }] },
    { control_frames: [{ version: 1, type: 'go' }, { version: 1, type: 'go' }] }]) {
    const observed = mockGuardian(scenario, 'anchor');
    assert.equal(observed.spawns.length, 0);
    assert.deepEqual(observed.primary, { stage: 'anchor_protocol', errno: null });
    assert.equal(observed.calls.includes('group_kill'), false);
  }
  const noGo = mockGuardian({ no_go: true, deadline: true }, 'anchor');
  assert.equal(noGo.spawns.length, 0);
  assert.equal(noGo.primary.stage, 'anchor_deadline');
  assert.ok(noGo.fake_elapsed_ms <= 1005.001);
});

for (const primary of ['anchor_setup', 'anchor_control_read', 'anchor_control_write', 'anchor_worker_spawn', 'anchor_worker_poll']) {
  test(`mock anchor safe failure ${primary} remains under single guardian ownership`, () => {
    const observed = mockGuardian({ primary }, 'anchor');
    assert.deepEqual(observed.primary, { stage: primary, errno: 1 });
    assert.equal(observed.calls.includes('group_kill'), false);
    if (primary === 'anchor_worker_poll') assert.equal(observed.calls.filter((step) => step === primary).length, 1);
    if (primary === 'anchor_control_write') assert.equal(observed.calls.filter((step) => step === primary).length, 1);
    assert.ok(observed.fake_elapsed_ms <= 6000.001);
  });
}

test('anchor never parks on a control descriptor whose nonblocking setup failed', () => {
  // Reviewer counterexample: setting control fd nonblocking raises, while the
  // pipe remains open and empty. A real read here could outlive every deadline.
  for (const fd of [40, 43]) {
    const observed = mockGuardian({ set_blocking_fail_fd: fd, no_go: true, park_until_deadline: true }, 'anchor');
    assert.deepEqual(observed.primary, { stage: 'anchor_setup', errno: 1 });
    assert.equal(observed.spawns.length, 0);
    assert.equal(observed.calls.includes('blocking_read_forbidden'), false);
    const reads = observed.operations.filter(op => op.op === 'read' && op.args[0] === 40);
    if (fd === 40) assert.equal(reads.length, 0);
    else assert.ok(reads.length > 0);
    assert.ok(observed.fake_elapsed_ms <= 6000.001);
  }
});

test('mock anchor shares absolute deadline, parks after completion and exits on parent loss', () => {
  const parked = mockGuardian({ park_until_deadline: true }, 'anchor');
  assert.equal(parked.primary, null);
  assert.ok(parked.fake_elapsed_ms >= 6000 && parked.fake_elapsed_ms <= 6000.001);
  assert.equal(parked.calls.filter((step) => step === 'anchor_worker_poll').length, 1);
  const lost = mockGuardian({ parent_exit: true }, 'anchor');
  assert.equal(lost.spawns.length, 0);
  assert.deepEqual(lost.primary, { stage: 'anchor_parent_exit', errno: null });
  const running = mockGuardian({ deadline: true, worker_running: true }, 'anchor');
  assert.deepEqual(running.primary, { stage: 'anchor_deadline', errno: null });
  assert.equal(running.calls.includes('group_kill'), false);
});

test('mock cache guardian invalidates under lock before spawn and commits only after all cleanup', () => {
  const observed = mockGuardian({ cache_enabled: true });
  assert.equal(observed.exit_code, 0);
  assert.equal(observed.cache_prepared, true);
  assert.equal(observed.cache_committed, true);
  assert.deepEqual(observed.spawns[0].kwargs.pass_fds, [40, 43, 200]);
  const ops = observed.operations;
  const prepare = ops.findIndex((op) => op.op === 'cache_rename' && op.role === 'marker');
  const publish = ops.findIndex((op) => op.op === 'cache_rename' && op.role === 'stage');
  assert.ok(prepare < ops.findIndex((op) => op.op === 'pipe'));
  assert.ok(publish > ops.findIndex((op) => op.op === 'wait'));
  assert.ok(publish > ops.findLastIndex((op) => op.op === 'close'));
  assert.equal(observed.calls.at(-1), 'immediate_exit');
});

test('stale parent due precheck cannot invalidate a newer lock-held completion', () => {
  // Exact reviewer ordering: B passes its parent's due check and pauses. A
  // finishes, writes a future next_due and publishes this cache. Only then B
  // acquires the same lock. Model B's guardian at that lock-held entry point.
  const current = JSON.stringify({ synthetic: true, outcome: 'A-completed', status: 'healthy', ok: true,
    checked_at: '2027-01-15T08:00:00.000Z', expires_at: '2027-01-15T08:30:00.000Z' });
  for (const background of [false, true]) {
    const observed = mockGuardian({ cache_enabled: true, cache_not_due: true, cache_target_raw: current, background });
    assert.equal(observed.exit_code, 0);
    assert.equal(observed.cache_files['/synthetic/cache/live-probe.json'].content, current);
    assert.equal(observed.cache_prepared, false);
    assert.equal(observed.cache_committed, false);
    assert.equal(observed.cache_discarded, false);
    assert.equal(observed.spawns.length, 0);
    assert.equal(observed.calls.includes('control_create'), false);
    assert.equal(observed.cache_operations.some(op => ['write', 'rename', 'unlink', 'fsync'].includes(op.op)), false);
    if (background) assert.equal(observed.stdout, '');
    else assert.deepEqual(JSON.parse(observed.stdout), { outcome: 'not_due', reason: 'not_due',
      next_due: 1800000900000, cooldownsByOperation: {}, cachePrepared: false });
  }
});

test('mock cache startup and cleanup failures never publish prepared positive stage', () => {
  for (const scenario of [{ primary: 'control_create' }, { primary: 'child_spawn' }, { anchor_error: true },
    { cleanup: 'group_kill' }, { reap_timeout: true }, { cleanup: 'capture_close' }, { worker_returncode: 2 }]) {
    const observed = mockGuardian({ cache_enabled: true, ...scenario });
    assert.equal(observed.exit_code, 2);
    assert.equal(observed.cache_prepared, true);
    assert.equal(observed.cache_committed, false);
    assert.equal(observed.cache_discarded, true);
  }
});

test('mock cache result-channel failure happens before final commit and is not retried', () => {
  for (const scenario of [{ primary: 'result_publish' }, { publish_flush: true }]) {
    const observed = mockGuardian({ cache_enabled: true, ...scenario });
    assert.equal(observed.exit_code, 2);
    assert.equal(observed.cache_committed, false);
    assert.equal(observed.cache_discarded, true);
    assert.deepEqual(observed.primary, { stage: 'result_publish', errno: 1 });
    assert.equal(observed.calls.at(-1), 'immediate_exit');
  }
});

test('mock cache publication failure cannot succeed even after buffered result was delivered', () => {
  for (const scenario of [{ cache_missing_stage: true }, { cache_fault: { op: 'rename', role: 'stage', errno: 1 } }]) {
    const observed = mockGuardian({ cache_enabled: true, ...scenario });
    assert.equal(observed.exit_code, 2);
    assert.equal(observed.cache_committed, false);
    assert.equal(observed.primary.stage, 'cache_publish');
    const wrapped = runGuardedRemoteSampleProcess('synthetic', [], {}, { spawnSync: () => ({ status: observed.exit_code, stdout: observed.stdout }) });
    assert.equal(wrapped.guardian_diagnostic.primary.stage, 'guardian_result');
  }
  const denied = mockGuardian({ cache_enabled: true, cache_fault: { op: 'open', role: 'stage', errno: 1 } });
  assert.equal(denied.cache_discarded, false);
  assert.equal(denied.cache_operations.filter((op) => op.op === 'open' && op.role === 'stage').length, 1);
});

test('mock final commit rechecks deadline, caller and stop after publication fsync', () => {
  for (const [event, stage] of [[{ advance_ms: 6000 }, 'deadline'], [{ parent_exit: true }, 'parent_exit'], [{ signal: true }, 'signal_stop']]) {
    const observed = mockGuardian({ cache_enabled: true, cache_event: { op: 'fsync', role: 'directory', occurrence: 2, ...event } });
    assert.equal(observed.exit_code, 2);
    assert.equal(observed.cache_prepared, true);
    assert.equal(observed.cache_committed, false);
    assert.equal(observed.primary.stage, stage);
  }
});

test('mock cache skip code is explicit and cannot publish a stale stage', () => {
  const skipped = mockGuardian({ cache_enabled: true, worker_returncode: 3 });
  assert.equal(skipped.exit_code, 0);
  assert.equal(skipped.cache_prepared, true);
  assert.equal(skipped.cache_committed, false);
  assert.equal(skipped.cache_discarded, true);
  const ordinary = mockGuardian({ worker_returncode: 3 });
  assert.deepEqual(envelope(ordinary), safeFailure('child_exit'));
});

test('mock guardian rejects a duplicate terminal frame split across reads', () => {
  const observed = mockGuardian({ duplicate_done: true, status_chunk_bytes: 1 });
  assert.equal(observed.exit_code, 2);
  assert.deepEqual(envelope(observed), safeFailure('control_protocol'));
});

test('diagnostic schema rejects unknown fields, stages, versions and invalid errno', () => {
  assert.deepEqual(safeGuardianDiagnostic(diagnostic()), diagnostic());
  for (const value of [null, [], { ...diagnostic(), version: 2 }, { ...diagnostic(), message: privateToken },
    { version: 1, primary: null, cleanup: null }, { ...diagnostic(), primary: { stage: privateToken, errno: 1 } },
    { ...diagnostic(), primary: { stage: 'watch_create', errno: 1, path: privateToken } },
    { ...diagnostic(), cleanup: { stage: 'watch_create', errno: 1 } },
    ...[-1, 0, 4096, 1.5, '1'].map((errno) => ({ ...diagnostic(), primary: { stage: 'watch_create', errno } }))]) {
    assert.equal(safeGuardianDiagnostic(value), null);
  }
});

test('process wrapper uses injected spawn only and preserves safe guardian envelope', () => {
  let calls = 0;
  const result = runGuardedRemoteSampleProcess('synthetic', [], {}, { spawnSync: (_bin, _args, opts) => {
    calls++; assert.equal(opts.killSignal, 'SIGTERM'); assert.equal(opts.timeout, 62000);
    return { status: 2, stdout: failureOutput(diagnostic('watch_register', 'group_kill')), stderr: privateToken };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result.guardian_diagnostic, diagnostic('watch_register', 'group_kill'));
});

test('process wrapper maps its failures without leaking exceptions or trusting malformed envelopes', () => {
  for (const [child, stage] of [[{ status: null, error: { code: 'ETIMEDOUT', errno: -60 } }, 'guardian_timeout'],
    [{ status: null, error: { code: 'ENOBUFS' } }, 'guardian_output_limit'], [{ status: 1, stdout: privateToken }, 'guardian_result'],
    [{ status: 0, stdout: failureOutput({ ...diagnostic(), path: privateToken }) }, 'guardian_result']]) {
    const result = runGuardedRemoteSampleProcess('synthetic', [], {}, { spawnSync: () => child });
    assert.equal(result.guardian_diagnostic.primary.stage, stage);
    assert.equal(JSON.stringify(result.guardian_diagnostic).includes(privateToken), false);
  }
  const result = runGuardedRemoteSampleProcess('synthetic', [], {}, { spawnSync: () => { throw Object.assign(new Error(privateToken), { errno: -1 }); } });
  assert.deepEqual(result.guardian_diagnostic, diagnostic('guardian_spawn'));
  assert.equal(JSON.stringify(result).includes(privateToken), false);
});

test('read-only and manual cache-writing entry points preserve safe diagnostics with fake spawn', () => {
  const spawn = () => ({ status: 2, stdout: failureOutput(), stderr: privateToken });
  const readonly = runReadOnlyRemoteSample('/synthetic/db', {}, { now: () => at, spawnSync: spawn });
  assert.equal(readonly.outcome, 'failed');
  assert.deepEqual(readonly.report.guardian_diagnostic, diagnostic());
  assert.equal(JSON.stringify(readonly).includes(privateToken), false);
  const logDir = mkdtempSync(join(tmpdir(), 'exocortex-synthetic-guardian-'));
  try {
    let invalidated = 0;
    const manual = runManualRemoteSample({ db: '/synthetic/db', logDir }, { nowMs: () => at,
      databaseKey: () => 'a'.repeat(64), invalidateCache: () => { invalidated++; }, spawnSync: spawn });
    assert.equal(manual.outcome, 'failed');
    assert.deepEqual(manual.guardian_diagnostic, diagnostic());
    assert.equal(invalidated, 0);
    assert.equal(JSON.stringify(manual).includes(privateToken), false);
  } finally { rmSync(logDir, { recursive: true, force: true }); }
});

test('check report fallback exposes diagnostic and never marks a diagnosed report passed', async () => {
  const f = fixture(); delete f.deps.collectLagReport;
  f.deps.runManualRemoteSample = () => ({ outcome: 'failed', reason: 'sample_process_failed', guardian_diagnostic: diagnostic() });
  const failed = await collectCheckReport(options({ live: true, writeLiveCache: true }), f.context, f.deps);
  assert.equal(failed.checks.live.status, 'unavailable');
  assert.deepEqual(failed.checks.live.evidence.guardian_diagnostic, diagnostic());
  const healthy = { schema_version: 3, ok: true, status: 'healthy', missing_count: 0,
    binding: { state: 'verified', evidence: 'single_sent_actor' },
    window: { start: new Date(at - 86400000).toISOString(), end: new Date(at - 600000).toISOString() },
    probe: { remote_messages_checked: 1, probe_errors: 0 } };
  const baseline = fixture(); delete baseline.deps.collectLagReport;
  baseline.deps.collectRemoteSample = () => ({ outcome: 'ok', report: healthy });
  const passed = await collectCheckReport(options({ live: true }), baseline.context, baseline.deps);
  assert.equal(passed.checks.live.status, 'passed');
  assert.equal(passed.exit_code, 0);
  for (const value of [diagnostic(), { ...diagnostic(), message: privateToken }]) {
    const g = fixture(); delete g.deps.collectLagReport;
    g.deps.collectRemoteSample = () => ({ outcome: 'ok', report: { ...healthy, guardian_diagnostic: value } });
    const result = await collectCheckReport(options({ live: true }), g.context, g.deps);
    assert.notEqual(result.checks.live.status, 'passed');
    assert.equal(result.exit_code, 1);
    assert.equal(result.checks.live.evidence.ok, false);
    assert.equal(JSON.stringify(result).includes(privateToken), false);
  }
});

test('public projection and cache parser cannot turn guardian failures into positive evidence', () => {
  const base = { schema_version: 3, ok: true, status: 'healthy', checked_at: new Date(at).toISOString(),
    binding: { state: 'verified', evidence: 'single_sent_actor' }, probe: { remote_messages_checked: 1 } };
  for (const value of [diagnostic(), { ...diagnostic(), path: privateToken }]) {
    const result = publicRemoteReport({ ...base, guardian_diagnostic: value });
    assert.equal(result.ok, false); assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'sample_process_failed');
    assert.equal(JSON.stringify(result).includes(privateToken), false);
  }
  const cache = remoteSampleCache({ report: { ...base, ok: false, status: 'unavailable', guardian_diagnostic: diagnostic(), probe: {},
    window: { start: new Date(at - 86400000).toISOString(), end: new Date(at - 600000).toISOString() } },
    cacheContext: { database_key: 'a'.repeat(64), account_key: 'b'.repeat(64), auth_identity_verified: true } });
  assert.deepEqual(parseRemoteSampleCache(cache)?.guardian_diagnostic, diagnostic());
  assert.equal(parseRemoteSampleCache({ ...cache, ok: true }), null);
  assert.equal(parseRemoteSampleCache({ ...cache, status: 'healthy' }), null);
  assert.equal(parseRemoteSampleCache({ ...cache, guardian_diagnostic: { ...diagnostic(), path: privateToken } }), null);
});
