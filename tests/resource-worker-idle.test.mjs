import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runGuardedWorkerStep, WORKER_STEP_GUARDIAN } from '../src/runtime/worker/step-process.mjs';
import { createMaintenanceRequestSession } from '../src/maintenance/request-session.mjs';
import { runWorker, runStep, runCycle, compactResourceSummary } from '../src/runtime/worker/worker.mjs';
import { runCycleWithRunner } from '../dist/runtime/worker/lark-im-worker-core.js';
import { WORKER_DEFAULTS } from '../src/runtime/worker/options.mjs';
import { instrumentResourceGuardian, readResourceGuardianPhases, shellPhase, assertResourceTailPrerequisites, archiveResourceGuardianEvidence } from './helpers/resource-guardian-phases.mjs';

const readArg = (args, flag) => Number(args[args.indexOf(flag) + 1]);
function harness(options = {}) {
  let time = 0, cycle = 0;
  const calls = [], first = [], forwards = [], sleeps = [], events = [], grants = [];
  const fair = options.fair || { sequence: 0, last_served: { sample: 0, history: 0, resources: 0 } };
  const opts = { ...WORKER_DEFAULTS, db: '/tmp/synthetic-unopened-resource-idle.sqlite', logDir: '',
    intervalSeconds: 30, maxCycles: 4, ...options.opts };
  const now = () => 2208988800000 + time;
  const mono = () => time;
  const advance = ms => { time += ms; };
  const receipt = (args, used, self, elapsed = 0) => ({ complete: true,
    max_cli_attempts: readArg(args, '--max-cli-attempts'), cli_attempts: used,
    max_self_attempts: readArg(args, '--max-self-attempts'), self_attempts: self,
    max_seconds: readArg(args, '--max-seconds'), min_interval_ms: 1000, elapsed_ms: elapsed, stop_reason: null });
  function mark(name, args = [], limits) {
    if (!calls.some(c => c.cycle === cycle)) first.push(name);
    calls.push({ name, cycle, args, limits, at: time });
  }
  function history(args, limits) {
    mark('history', args, limits);
    const duration = options.historyMs ?? 100;
    advance(duration);
    const grant = readArg(args, '--max-cli-attempts');
    const step = { name: 'history', ok: true, exit_code: 0, stderr: '', elapsed_ms: duration,
      summary: { ok: true, profile: 'known_record_history/v1', outcome: 'batch_processed', processed: 1,
        request_budget: receipt(args, options.historyCalls ?? grant, Math.min(2, grant), duration) } };
    options.mutateHistory?.(step);
    return step;
  }
  const resourceRun = (args, limits) => {
    mark('resources', args, limits);
    return runStep('resources', args, { command: 'maintenance', nowMs: now, monotonicNowMs: mono, ...limits,
      runProcess: (_command, _argv, settings) => {
        grants.push({ ...settings, at: time });
        const duration = options.resourceMs ?? 100;
        advance(duration);
        const budget = receipt(args, options.resourceCalls ?? 3, 2, duration);
        const summary = { ok: !options.resourceFail, profile: 'known_record_resources/v1', outcome: options.resourceFail ? 'blocked' : 'processed',
          processed: 1, available: options.resourceFail ? 0 : 1, deferred: 0, blocked: options.resourceFail ? 1 : 0,
          request_budget: budget, secret: 'synthetic-private-raw', record_id: 123, resource_path: '/private/synthetic' };
        if (options.mutateResource) options.mutateResource(summary, advance);
        return { status: options.resourceFail ? 1 : 0, stdout: JSON.stringify(summary), stderr: '' };
      } });
  };
  const deps = {
    nowMs: now, monotonicNowMs: mono,
    sleepSeconds: seconds => { sleeps.push(seconds); advance(seconds * 1000); },
    writeScheduler: () => {},
    hasHistoryWork: () => options.historyAvailable !== false,
    hasResourceWork: () => options.resourceAvailable !== false,
    runResources: resourceRun,
    readIdleFairState: () => structuredClone(fair),
    claimIdleLane: (_db, state, lane, eligible) => {
      if (options.claimFail) return null;
      assert.equal(state.sequence, fair.sequence);
      const order = eligible.slice().sort((a, b) => fair.last_served[a] - fair.last_served[b] ||
        ['sample', 'history', 'resources'].indexOf(a) - ['sample', 'history', 'resources'].indexOf(b));
      assert.equal(lane, order[0]);
      fair.last_served[lane] = ++fair.sequence;
      advance(options.claimMs ?? 0);
      return structuredClone(fair);
    },
    remoteSampleAdmission: () => ({ outcome: options.sampleDue === false ? 'not_due' : 'due' }),
    runRemoteSample: sampleOpts => {
      mark('sample');
      calls.at(-1).sampleBudget = sampleOpts.remoteSampleBudgetMs;
      advance(options.sampleMs ?? 100);
      return { outcome: 'ok', reason: 'sampled', budget_receipt: { version: 1, complete: true,
        max_cli_attempts: sampleOpts.maxApiCalls, max_self_attempts: sampleOpts.maxSelfCalls,
        cli_attempts: options.sampleCalls ?? 12, self_attempts: 2 } };
    },
    runCycle: (cycleOpts, cycleNumber, cycleDeps) => {
      cycle = cycleNumber;
      return runCycleWithRunner(cycleOpts, cycleNumber, (name, args, command, limits) => {
        if (name === 'sent') forwards.push(time);
        if (name === 'history') return history(args, limits);
        advance(10);
        const at = new Date(now()).toISOString();
        return { name, ok: true, exit_code: 0, stderr: '', started_at: at, finished_at: at, elapsed_ms: 10, summary: { ok: true } };
      }, (_opts, event) => events.push(event), () => new Date(now()).toISOString(), cycleDeps.onComplete, cycleDeps.beforeHistory);
    },
  };
  return { opts, deps, fair, calls, first, forwards, sleeps, events, grants, now, mono, advance,
    run() { return runWorker(opts, { ...deps, ...options.deps }); } };
}

test('three continuously eligible lanes each get first service within three slices', () => {
  const f = harness();
  assert.equal(f.run(), true);
  assert.deepEqual(f.first.slice(0, 3), ['sample', 'history', 'resources']);
  assert.equal(f.fair.sequence, 4);
  const resources = f.calls.find(c => c.name === 'resources');
  assert.equal(readArg(resources.args, '--max-cli-attempts'), 3);
  assert.equal(readArg(resources.args, '--max-self-attempts'), 2);
  assert.equal(readArg(resources.args, '--max-seconds'), 23);
  assert(f.grants.every(g => g.timeout <= 23_000));
  for (let cycle = 1; cycle <= 4; cycle++) {
    const jobs = f.calls.filter(c => c.cycle === cycle);
    const calls = jobs.reduce((sum, c) => sum + (c.name === 'sample' ? 12 : c.name === 'resources' ? 3 : readArg(c.args, '--max-cli-attempts')), 0);
    assert(calls <= 12);
  }
  assert.doesNotMatch(JSON.stringify(f.events), /synthetic-private|resource_path|record_id/);
});

test('a failed resource first attempt rotates and does not hold either older peer behind it', () => {
  const fair = { sequence: 2, last_served: { sample: 1, history: 2, resources: 0 } };
  const f = harness({ fair, resourceFail: true, opts: { maxCycles: 4 } });
  f.run();
  assert.deepEqual(f.first.slice(0, 3), ['resources', 'sample', 'history']);
  assert.equal(f.calls.filter(c => c.cycle === 1).length, 1);
  assert.equal(f.fair.last_served.resources, 6); // it is eligible again on the final slice after both peers served
});

test('sample disabled still admits resource work within existing idle allowance', () => {
  const f = harness({ historyAvailable: false, opts: { remoteSampleIntervalSeconds: 0, maxCycles: 2 } });
  f.run();
  assert.deepEqual(f.first, ['resources', 'resources']);
  assert(f.calls.every(c => c.name === 'resources'));
  assert.equal(f.forwards[1] - f.forwards[0], 30_060);
});

test('normal injected cycle has no implicit resource or scheduling database reads', () => {
  let cycles = 0;
  const result = runWorker({ ...WORKER_DEFAULTS, db: '/definitely/missing/synthetic.sqlite', logDir: '', maxCycles: 1 }, {
    runCycle: () => { cycles++; return true; }, sleepSeconds: () => {},
  });
  assert.equal(result, true);
  assert.equal(cycles, 1);
});

test('metadata claim refusal neither starts optional jobs nor consumes a service age', () => {
  const f = harness({ claimFail: true, opts: { maxCycles: 2 } });
  f.run();
  assert.deepEqual(f.calls, []);
  assert.equal(f.fair.sequence, 0);
  assert(f.events.filter(e => e.name === 'history').every(e => e.summary.idle_outcome === 'state_unavailable'));
});

test('metadata work consumes the same deadline; exhausted remaining budget starts no child', () => {
  const f = harness({ claimMs: 25_000, opts: { maxCycles: 1, remoteSampleIntervalSeconds: 0 }, historyAvailable: false });
  f.run();
  assert.deepEqual(f.calls, []);
  assert.equal(f.fair.sequence, 1); // injected late success is not compensated or called actual service
  assert.equal(f.events.find(e => e.name === 'history').summary.idle_outcome, 'admission_expired');
});

for (const [label, mutate] of [
  ['incomplete receipt', s => { s.request_budget.complete = false; }],
  ['unknown stop reason', s => { s.request_budget.stop_reason = 'synthetic-private-error'; }],
  ['missing exact limit', s => { delete s.request_budget.max_seconds; }],
  ['impossible self count', s => { s.request_budget.self_attempts = 3; }],
  ['missing result count', s => { delete s.available; }],
  ['foreign profile', s => { s.profile = 'synthetic/unknown'; }],
]) {
  test(`${label} receives no speculative refund or later job`, () => {
    const fair = { sequence: 2, last_served: { sample: 1, history: 2, resources: 0 } };
    const f = harness({ fair, mutateResource: mutate, opts: { maxCycles: 1 } });
    f.run();
    assert.deepEqual(f.first, ['resources']);
    assert.equal(f.calls.length, 1);
    assert.equal(f.events.find(e => e.name === 'history').summary.idle_outcome, 'untrusted_result');
  });
}

test('resource local tail exceeding allowance stops the slice and cannot create negative sleep', () => {
  const fair = { sequence: 2, last_served: { sample: 1, history: 2, resources: 0 } };
  const f = harness({ fair, resourceMs: 40_000, opts: { maxCycles: 2 } });
  f.run();
  assert.equal(f.calls.filter(c => c.cycle === 1).length, 1);
  assert.equal(f.sleeps[0], 0);
  assert.equal(f.grants[0].timeout, 23_000);
  // The fake executor deliberately ignores the guardian timeout: the measured
  // overrun is retained, not presented as an enforced real-process result.
  assert.equal(f.forwards[1] - f.forwards[0], 40_060);
});

test('a clock rollback during resource execution permanently closes the slice', () => {
  const fair = { sequence: 2, last_served: { sample: 1, history: 2, resources: 0 } };
  const f = harness({ fair, mutateResource: (_s, advance) => advance(-500), opts: { maxCycles: 1 } });
  f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.events.find(e => e.name === 'history').summary.idle_outcome, 'clock_unavailable');
});

test('last spawn boundary rereads remaining time and reserves outer guardian cleanup', () => {
  let invoked = 0;
  for (const remaining of [0, 1000, 2000, NaN]) {
    const step = runStep('resources', [], { timeoutMs: 23_000, remainingTimeMs: () => remaining,
      runProcess: () => { invoked++; return { status: 0, stdout: '{"ok":true}', stderr: '' }; } });
    assert.equal(step.ok, false);
  }
  assert.equal(invoked, 0);
  let actual;
  runStep('resources', [], { timeoutMs: 23_000, remainingTimeMs: () => 4_500,
    runProcess: (_cmd, _args, settings) => { actual = settings.timeout; return { status: 0, stdout: '{"ok":true}', stderr: '' }; } });
  assert.equal(actual, 2_500);
});

test('resource compaction never forwards paths, identifiers, unknown diagnostics or invented counters', () => {
  const value = compactResourceSummary({ ok: true, profile: 'known_record_resources/v1', outcome: 'processed', processed: 1,
    resource_path: '/private/synthetic', actor_id: 'synthetic', raw: {}, request_budget: { cli_attempts: null,
      max_cli_attempts: 3, complete: false, stop_reason: 'synthetic-secret', error: 'synthetic-secret' } });
  assert.equal(value.processed, 1);
  assert.equal(value.available, undefined);
  assert.equal(value.request_budget.cli_attempts, undefined);
  assert.equal(value.request_budget.complete, false);
  assert.doesNotMatch(JSON.stringify(value), /synthetic|resource_path|actor_id|raw|error/);
});


test('sampler-only eligibility preserves its existing 55-second allowance', () => {
  const f = harness({ historyAvailable: false, resourceAvailable: false, opts: { intervalSeconds: 60, maxCycles: 2 } });
  f.run();
  assert.equal(f.calls[0].name, 'sample');
  assert.equal(f.calls[0].sampleBudget, 55_000);
});

// Keep the production monotonic clock, work deadline and cleanup allowance.
// A shell builtin reaches the invented local tail without an unrelated second
// Node bootstrap. Production Node startup still spends the same work deadline;
// this test does not promise any runtime can start within 300ms on a suspended host.
function resourceTailFixture(t, { delayedAnchor = false, delayBeforeWorker = false, delayedShell = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-resource-idle-guardian-'));
  let retain = true;
  t.after(() => {
    if (!retain) { rmSync(dir, { recursive: true, force: true }); return; }
    try {
      const files = Object.fromEntries(readdirSync(dir).map(name => {
        const data = readFileSync(join(dir, name));
        return [name, { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }];
      }));
      writeFileSync(join(dir, 'evidence-manifest.json'), JSON.stringify(files, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      t.diagnostic(JSON.stringify({ observation: 'synthetic_resource_guardian_retained/v1', directory: dir, files }));
    } catch { t.diagnostic(JSON.stringify({ observation: 'synthetic_resource_guardian_retained/v1', directory: dir, state: 'retention_failed' })); }
  });
  const marker = join(dir, 'entered-tail'), anchorMarker = join(dir, 'entered-anchor');
  const script = join(dir, 'child.sh');
  writeFileSync(script, shellPhase('entry') + (delayedShell ? '/bin/sleep 0.4\n' : '') +
    `printf '%s' '{"ok":true,"profile":"known_record_resources/v1"}'\n` + shellPhase('output_returned') +
    `printf '%s' 'synthetic' > "$2"\n` + shellPhase('tail_returned') + `exec /bin/sleep 10\n`);
  const env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C',
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' };
  const started = performance.now();
  let captured, workTimeout, outerTimeout, guardianProcess, binding, sourceEvidence, rawGuardianResult;
  const step = runStep('resources', [marker, join(dir, 'worker.jsonl')], { execPath: '/bin/sh', scriptPath: script, timeoutMs: 300,
    remainingTimeMs: () => 2300 - (performance.now() - started),
    runProcess: (command, args, options) => {
      workTimeout = options.timeout;
      captured = runGuardedWorkerStep(command, args, { ...options, env }, {
        spawnSync: (binary, argv, settings) => {
          assert.equal(argv[1], WORKER_STEP_GUARDIAN);
          outerTimeout = settings.timeout;
          const instrumented = instrumentResourceGuardian(argv[1], dir, { delayBeforeWorker });
          binding = instrumented.binding;
          let source = instrumented.source;
          let executedAnchor = instrumented.anchorSource;
          if (delayedAnchor) {
            // Only the invented anchor's startup is delayed. The guardian's
            // original deadline, READY/GO checks and cleanup code are unchanged.
            const declaration = source.split('\n').find(line => line.startsWith('ANCHOR_CODE='));
            assert(declaration);
            const prelude = `import os,time\nwith open(${JSON.stringify(anchorMarker)},'x') as f: f.write('synthetic')\ntime.sleep(1.0)\n`;
            source = source.replace(declaration, `${declaration}\nANCHOR_CODE=${JSON.stringify(prelude)}+ANCHOR_CODE`);
            executedAnchor = prelude + executedAnchor;
          }
          binding.executed_guardian_sha256 = createHash('sha256').update(source).digest('hex');
          binding.executed_anchor_sha256 = createHash('sha256').update(executedAnchor).digest('hex');
          sourceEvidence = { 'executed-guardian.py': source, 'executed-anchor.py': executedAnchor,
            'source-binding.json': JSON.stringify(binding, null, 2) + '\n' };
          const result = spawnSync(binary, [argv[0], source, ...argv.slice(2)], settings);
          rawGuardianResult = result;
          guardianProcess = { status: result.status ?? null, signal: result.signal ?? null,
            error_code: result.error?.code ?? null, stdout_bytes: Buffer.byteLength(result.stdout || ''),
            stderr_bytes: Buffer.byteLength(result.stderr || ''),
            stderr_sha256: createHash('sha256').update(result.stderr || '').digest('hex') };
          return result;
        },
      });
      return captured;
    },
  });
  const archive = archiveResourceGuardianEvidence({ ...sourceEvidence,
    'guardian-stdout.txt': rawGuardianResult?.stdout || '', 'guardian-stderr.txt': rawGuardianResult?.stderr || '' },
  (name, value) => writeFileSync(join(dir, name), value, { mode: 0o600, flag: 'wx' }));
  const elapsed = performance.now() - started;
  return { step, captured, marker, anchorMarker, elapsed, workTimeout, outerTimeout, guardianProcess,
    binding, archive, phases: readResourceGuardianPhases(dir), releaseEvidence: () => { retain = archive.state !== 'written' || guardianProcess?.stderr_bytes !== 0; }, intervention: delayedAnchor ? 'anchor_prelude_1000ms'
      : delayBeforeWorker ? 'before_worker_spawn_400ms' : delayedShell ? 'shell_before_output_400ms' : 'none' };
}

function observeResourceGuardian(t, f) {
  let expectedJson = false;
  try { expectedJson = JSON.stringify(JSON.parse(f.captured?.stdout || '')) ===
    JSON.stringify({ ok: true, profile: 'known_record_resources/v1' }); } catch { /* report, never accept */ }
  t.diagnostic(JSON.stringify({ observation: 'synthetic_resource_guardian_phase/v1',
    work_timeout_ms: f.workTimeout ?? null, outer_timeout_ms: f.outerTimeout ?? null,
    elapsed_ms: f.elapsed, anchor_marker: f.intervention === 'anchor_prelude_1000ms' ? existsSync(f.anchorMarker) : null,
    tail_marker: existsSync(f.marker),
    stdout_bytes: Buffer.byteLength(f.captured?.stdout || ''), stderr_bytes: Buffer.byteLength(f.captured?.stderr || ''),
    expected_json: expectedJson, guardian_process: f.guardianProcess ?? null,
    wrapper_status: f.captured?.status ?? null, wrapper_signal: f.captured?.signal ?? null, guardian_diagnostic: f.step.guardian_diagnostic ?? null,
    intervention: f.intervention, source_binding: f.binding, archive: f.archive, phases: f.phases }));
}

function assertResourceGuardianDeadline(f) {
  assert(f.workTimeout > 0 && f.workTimeout <= 300, 'original 300ms work grant is never enlarged');
  assert.equal(f.outerTimeout, f.workTimeout + 2000, 'original cleanup reserve is retained');
  assert(f.outerTimeout <= 2300, 'whole synchronous backstop stays inside the original allowance');
  assert.equal(f.step.ok, false);
  assert.equal(f.step.exit_code, undefined);
  assert(['deadline', 'anchor_deadline'].includes(f.step.guardian_diagnostic?.primary?.stage),
    `require an actual deadline result, got ${JSON.stringify(f.step.guardian_diagnostic)}`);
  assert.equal(f.step.guardian_diagnostic.cleanup, null, 'guardian reported no cleanup error');
  assert(f.elapsed < 3000, 'bounded guardian exited well before the ten-second synthetic tail');
}

function assertObservedCleanup(f) {
  assert.equal(f.archive.state, 'written', 'artifact failure is a separate observation gate');
  assert.equal(f.phases.guardian.state, 'valid');
  const events = f.phases.guardian.events;
  assert(events.some(e => e.phase === 'group_kill_returned'));
  assert(events.some(e => e.phase === 'anchor_reap_returned' && e.sigkill));
  assert(events.some(e => e.phase === 'cleanup_finished' && e.killed === true && e.reaped === true && e.cleanup_error === false));
  // These observations concern the owned group syscall and anchor wait only;
  // they are not an inventory of all processes or proof about unrelated PIDs.
}

test('resource admission exhausted before spawn starts no guardian or child', () => {
  let elapsed = 301, invoked = 0;
  const step = runStep('resources', [], { timeoutMs: 300, remainingTimeMs: () => 2300 - elapsed,
    runProcess: () => { invoked++; throw Error('must not start a child after admission expired'); } });
  assert.equal(invoked, 0);
  assert.equal(step.ok, false);
  assert.equal(step.exit_code, undefined);
  assert.equal(step.summary, null);
  assert.equal(step.stderr, 'worker step idle deadline elapsed');
  assert.equal(step.guardian_diagnostic, undefined, 'no guardian was started');
});

test('the real guardian expires during anchor startup before the resource child enters its tail', t => {
  const f = resourceTailFixture(t, { delayedAnchor: true });
  observeResourceGuardian(t, f);
  assert.equal(existsSync(f.anchorMarker), true, 'the controlled slow anchor actually started');
  assert.equal(existsSync(f.marker), false, 'startup time consumed the grant before worker launch');
  assert.equal(f.captured.stdout, '');
  assertResourceGuardianDeadline(f);
  assertObservedCleanup(f);
  f.releaseEvidence();
});

test('the existing real guardian encloses a slow resource local tail', t => {
  const f = resourceTailFixture(t);
  observeResourceGuardian(t, f);
  assertResourceTailPrerequisites(existsSync(f.marker), f.captured.stdout);
  assertResourceGuardianDeadline(f); // success JSON cannot bypass the guardian deadline
  assertObservedCleanup(f);
  assert.equal(f.phases.anchor.state, 'valid');
  assert(f.phases.anchor.events.some(e => e.phase === 'worker_spawn_returned'));
  assert.equal(f.phases.worker.state, 'valid');
  assert.deepEqual(f.phases.worker.events.map(e => e.phase), ['entry', 'output_returned', 'tail_returned']);
  assert(f.phases.worker.events.slice(1).every(e => e.return_code === 0));
  f.releaseEvidence();
});

test('phase control records the post-GO pause with no observed worker spawn return', t => {
  const f = resourceTailFixture(t, { delayBeforeWorker: true });
  observeResourceGuardian(t, f);
  assert.equal(f.phases.anchor.state, 'valid');
  assert(f.phases.anchor.events.some(e => e.phase === 'worker_spawn_begin'));
  assert(!f.phases.anchor.events.some(e => e.phase === 'worker_spawn_returned'));
  assert.equal(f.phases.worker.state, 'missing');
  assert.equal(existsSync(f.marker), false);
  assert.equal(f.captured.stdout, '');
  assertResourceGuardianDeadline(f);
  assertObservedCleanup(f);
  const g = f.phases.guardian.events;
  const interval = g.find(e => e.phase === 'group_kill_returned').monotonic_us -
    g.find(e => e.phase === 'anchor_spawn_begin').monotonic_us;
  assert(interval >= 0 && interval < 400_000, 'same-guardian clock: kill returned before the authored 400ms pause could finish');
  f.releaseEvidence();
});

test('phase control distinguishes an entered worker from a missing output and tail', t => {
  const f = resourceTailFixture(t, { delayedShell: true });
  observeResourceGuardian(t, f);
  assert.equal(f.phases.worker.state, 'valid');
  assert.deepEqual(f.phases.worker.events.map(e => e.phase), ['entry']);
  assert.equal(existsSync(f.marker), false);
  assert.equal(f.captured.stdout, '');
  assertResourceGuardianDeadline(f);
  assertObservedCleanup(f);
  f.releaseEvidence();
});


for (const intervalSeconds of [8, 9, 10]) {
  test(`a ${intervalSeconds - 5}-second idle remainder cannot claim an impossible resource unit`, () => {
    const f = harness({ historyAvailable: false, opts: { intervalSeconds, maxCycles: 1, remoteSampleIntervalSeconds: 0 } });
    f.run();
    assert.equal(f.calls.length, 0);
    assert.equal(f.fair.sequence, 0);
  });
}

test('actual request-session fixed gaps require at least three remote seconds for the resource unit', () => {
  for (const [seconds, expectedCalls] of [[1, 1], [2, 2], [3, 3]]) {
    let time = 0, calls = 0;
    const session = createMaintenanceRequestSession({ db: '/synthetic/unopened', maxCliAttempts: 3, maxSelfAttempts: 2, maxSeconds: seconds }, {
      monotonicClock: () => time, now: () => 2208988800000 + time, sleep: ms => { time += ms; },
      tryAcquireLease: () => ({ state: 'acquired', release() {} }), readSharedCooldown: () => ({ state: 'ready' }),
      spawnSync: () => { calls++; return { status: 0, stdout: '{"ok":true}', stderr: '' }; },
    });
    let reason = null;
    try {
      session.runLark(['contact', '+get-user', '--as', 'user']);
      session.runLark(['api', 'GET', '/open-apis/im/v1/messages/synthetic/resources/synthetic']);
      session.runLark(['contact', '+get-user', '--as', 'user']);
    } catch (error) { reason = error.reason; }
    assert.equal(calls, expectedCalls);
    assert.equal(reason, seconds < 3 ? 'time_budget' : null);
  }
});


test('spare resource-only capacity serves two units without a second fair claim or larger budget', () => {
  const f = harness({ historyAvailable: false, opts: { remoteSampleIntervalSeconds: 0, maxCycles: 1 }, resourceMs: 8000 });
  assert.equal(f.run(), true);
  const work = f.calls.filter(c => c.name === 'resources');
  assert.equal(work.length, 2);
  assert.equal(f.fair.sequence, 1);
  assert.deepEqual(work.map(c => readArg(c.args, '--max-cli-attempts')), [3, 3]);
  assert.deepEqual(work.map(c => readArg(c.args, '--max-self-attempts')), [2, 2]);
  assert(work[1].limits.timeoutMs < work[0].limits.timeoutMs);
  assert.equal(work[1].at - work[0].at, 9000);
  const summary = f.events.find(e => e.name === 'history').summary.resources;
  assert.equal(summary.available, 2);
  assert.equal(summary.request_budget.cli_attempts, 6);
  assert.equal(summary.request_budget.self_attempts, 4);
  assert.equal(summary.units.length, 2);
});

test('surplus resources cannot jump an unserved eligible sampler or claim its next first turn', () => {
  const f = harness({ historyAvailable: false,
    fair: { sequence: 2, last_served: { sample: 1, history: 2, resources: 0 } }, opts: { maxCycles: 3 } });
  f.run();
  assert.deepEqual(f.calls.filter(c => c.cycle === 1).map(c => c.name), ['resources']);
  assert.equal(f.first[1], 'sample');
});

for (const [label, mutate] of [
  ['failed unit', s => { s.ok = false; s.outcome = 'blocked'; s.available = 0; s.blocked = 1; }],
  ['unknown receipt', s => { s.request_budget.complete = false; }],
  ['missing counter', s => { delete s.request_budget.cli_attempts; }],
  ['throw after spawn', () => { throw new Error('authored synthetic process failure'); }],
  ['clock rollback', (_s, advance) => advance(-10000)],
]) test(`second resource ${label} cannot hide the first unit or report an entirely successful slice`, () => {
  let n = 0;
  const f = harness({ historyAvailable: false, opts: { remoteSampleIntervalSeconds: 0, maxCycles: 1 }, resourceMs: 4000,
    mutateResource: (s, advance) => { if (++n === 2) mutate(s, advance); } });
  assert.equal(f.run(), false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.fair.sequence, 1);
  const result = f.events.find(e => e.name === 'history').summary;
  assert.equal(result.ok, false);
  assert.equal(f.events.find(e => e.name === 'history').ok, false);
  assert.equal(f.events.find(e => e.type === 'lark_im_worker_cycle').ok, false);
  assert.equal(result.resources.ok, false);
  assert.equal(result.resources.units.length, 2);
  assert.equal(result.resources.units[0].available, 1);
  if (label === 'failed unit') {
    assert.equal(result.resources.ok, false);
    assert.equal(result.resources.available, 1);
    assert.equal(result.resources.blocked, 1);
  } else if (label === 'clock rollback') assert.equal(result.idle_outcome, 'clock_unavailable');
  else {
    assert.equal(result.idle_outcome, 'untrusted_result');
    assert.equal(result.resources.ok, false);
    assert.equal(result.resources.request_budget.complete, false);
    assert.equal(result.resources.request_budget.cli_attempts, undefined);
  }
});

test('a measured slow first resource reserves equal work and original cleanup before considering surplus', () => {
  const f = harness({ historyAvailable: false, resourceMs: 12000,
    opts: { remoteSampleIntervalSeconds: 0, maxCycles: 1 } });
  f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.events.find(e => e.name === 'history').summary.resources.available, 1);
});

test('surplus uses balances after history and cannot exceed original self allowance', () => {
  const f = harness({ sampleDue: false, historyCalls: 3, historyMs: 100, resourceMs: 100,
    opts: { remoteSampleIntervalSeconds: 0, maxCycles: 1 } });
  f.run();
  assert.deepEqual(f.calls.map(c => c.name), ['history', 'resources', 'resources']);
  const result = f.events.find(e => e.name === 'history').summary;
  assert.equal(result.request_budget.self_attempts + result.resources.request_budget.self_attempts, 6);
  assert.equal(result.request_budget.cli_attempts + result.resources.request_budget.cli_attempts, 9);
  assert.equal(f.fair.sequence, 1);
});

test('worker preserves only finite resource failure evidence and its persistence receipt', () => {
  const projected = compactResourceSummary({ ok: false, failure: { stage: 'download_validation',
    reason: 'download_image_invalid', persisted: true, path: '/private/authored', body: 'authored content' } });
  assert.deepEqual(projected.failure, { stage: 'download_validation', reason: 'download_image_invalid', persisted: true });
  assert.deepEqual(compactResourceSummary({ ok: false, failure: { stage: 'authored private stage', reason: 'authored secret',
    persisted: 'true' } }).failure, { stage: 'unknown', reason: 'unknown', persisted: false });
  assert.equal(compactResourceSummary({ ok: true, failure: null }).failure, null);
  assert.equal(compactResourceSummary({ ok: false }).failure, undefined);
});

for (const [label, mutate] of [
  ['missing receipt', step => { delete step.summary.request_budget; }],
  ['mismatched grant', step => { step.summary.request_budget.max_cli_attempts++; }],
]) test(`history ${label} cannot become a successful logical idle cycle`, () => {
  const f = harness({ resourceAvailable: false, opts: { remoteSampleIntervalSeconds: 0, maxCycles: 1 }, mutateHistory: mutate });
  assert.equal(f.run(), false);
  const event = f.events.find(e => e.name === 'history');
  assert.equal(event.ok, false); assert.equal(event.summary.ok, false);
  assert.equal(event.summary.idle_outcome, 'untrusted_result');
  assert.equal(f.events.find(e => e.type === 'lark_im_worker_cycle').ok, false);
  assert.equal(f.calls.length, 1);
});
