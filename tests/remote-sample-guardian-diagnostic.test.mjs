import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
function mockGuardian(scenario = {}) {
  const result = spawnSync('python3', [fileURLToPath(new URL('./remote_sample_guardian_mock.py', import.meta.url))], {
    input: JSON.stringify({ code: REMOTE_SAMPLE_GUARDIAN, scenario }), encoding: 'utf8', timeout: 5000, maxBuffer: 262144,
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

for (const primary of ['guardian_setup', 'child_spawn', 'capture_nonblocking', 'watch_create', 'watch_register', 'capture_read', 'watch_poll', 'wait_observe']) {
  test(`mock guardian preserves safe primary stage ${primary}`, () => {
    const observed = mockGuardian({ primary, waitid: primary === 'wait_observe' });
    assert.equal(observed.exit_code, 2);
    assert.deepEqual(JSON.parse(observed.stdout).guardian_diagnostic, diagnostic(primary));
    assert.equal(observed.calls.filter((value) => value === primary).length, 1);
    assert.ok(observed.calls.filter((value) => value === 'group_kill').length <= 1);
    if (primary === 'capture_nonblocking') assert.equal(observed.calls.includes('capture_drain'), false);
    if (primary === 'capture_read') assert.equal(observed.calls.includes('capture_drain'), false);
  });
}

for (const cleanup of ['group_kill', 'child_reap', 'capture_drain', 'watch_close']) {
  test(`mock guardian preserves independent cleanup stage ${cleanup}`, () => {
    const observed = mockGuardian({ primary: 'watch_poll', cleanup });
    assert.equal(observed.exit_code, 2);
    assert.deepEqual(JSON.parse(observed.stdout).guardian_diagnostic, diagnostic('watch_poll', cleanup));
    assert.equal(observed.calls.filter((value) => value === cleanup).length, 1);
    if (cleanup === 'group_kill') assert.equal(observed.calls.includes('child_reap'), false);
  });
}

test('mock guardian treats cleanup-only failure as failed and bounds a reap after observed exit', () => {
  const observed = mockGuardian({ cleanup: 'group_kill' });
  assert.equal(observed.exit_code, 2);
  assert.deepEqual(JSON.parse(observed.stdout).guardian_diagnostic, diagnostic(null, 'group_kill'));
  assert.equal(observed.calls.filter((value) => value === 'group_kill').length, 1);
  assert.equal(observed.calls.includes('wait_timeout_bounded'), true);
});

test('mock guardian retains the first cleanup error when later cleanup also fails', () => {
  const observed = mockGuardian({ primary: 'watch_poll', cleanup: ['group_kill', 'capture_drain', 'watch_close'] });
  assert.deepEqual(JSON.parse(observed.stdout).guardian_diagnostic, diagnostic('watch_poll', 'group_kill'));
  assert.equal(observed.calls.includes('child_reap'), false);
  for (const step of ['group_kill', 'capture_drain', 'watch_close']) assert.equal(observed.calls.filter((value) => value === step).length, 1);
});

test('mock guardian keeps deadline, overflow, parent loss, signal and child exit distinct', () => {
  for (const [scenario, stage] of [[{ deadline: true }, 'deadline'], [{ overflow: true }, 'output_limit'],
    [{ parent_exit: true }, 'parent_exit'], [{ signal_stop: true }, 'signal_stop'], [{ child_returncode: 7 }, 'child_exit']]) {
    const observed = mockGuardian(scenario);
    assert.equal(observed.exit_code, 2);
    assert.deepEqual(JSON.parse(observed.stdout).guardian_diagnostic, { version: 1, primary: { stage, errno: null }, cleanup: null });
    assert.ok(observed.fake_elapsed_ms <= 5);
    if (scenario.parent_exit) assert.equal(observed.calls.includes('child_spawn'), false);
  }
});

test('mock guardian does not retry a failed result channel or a timed-out reap', () => {
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
  assert.equal(reap.exit_code, 2);
  assert.deepEqual(JSON.parse(reap.stdout).guardian_diagnostic, { version: 1, primary: null, cleanup: { stage: 'child_reap', errno: null } });
  assert.equal(reap.calls.filter((value) => value === 'child_reap').length, 1);
});

test('mock guardian preserves success bytes, handles already-gone group and fails background silently', () => {
  for (const scenario of [{}, { waitid: true }, { already_gone: true }]) {
    const observed = mockGuardian(scenario);
    assert.equal(observed.exit_code, 0);
    assert.equal(observed.stdout, '{"outcome":"ok","synthetic":true}');
    assert.equal(observed.calls.includes('wait_timeout_bounded'), true);
  }
  const background = mockGuardian({ background: true, primary: 'watch_register' });
  assert.equal(background.exit_code, 2);
  assert.equal(background.stdout, '');
  assert.deepEqual(background.primary, { stage: 'watch_register', errno: 1 });
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
    assert.equal(invalidated, 1);
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
