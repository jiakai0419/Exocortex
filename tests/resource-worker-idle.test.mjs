import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createMaintenanceRequestSession } from '../src/maintenance/request-session.mjs';
import { runWorker, runStep, runCycle, compactResourceSummary } from '../src/runtime/worker/worker.mjs';
import { runCycleWithRunner } from '../dist/runtime/worker/lark-im-worker-core.js';
import { WORKER_DEFAULTS } from '../src/runtime/worker/options.mjs';

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
    return { name: 'history', ok: true, exit_code: 0, stderr: '', elapsed_ms: duration,
      summary: { ok: true, profile: 'known_record_history/v1', outcome: 'batch_processed', processed: 1,
        request_budget: receipt(args, options.historyCalls ?? grant, Math.min(2, grant), duration) } };
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

test('the existing real guardian encloses a slow resource local tail', t => {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-resource-idle-guardian-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'entered-tail'), script = join(dir, 'child.mjs');
  writeFileSync(script, `import {writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(marker)},'synthetic');
    process.stdout.write(JSON.stringify({ok:true,profile:'known_record_resources/v1'}));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);`);
  const started = performance.now();
  const step = runStep('resources', [], { scriptPath: script, timeoutMs: 300,
    remainingTimeMs: () => 2300 - (performance.now() - started) });
  const elapsed = performance.now() - started;
  assert.equal(existsSync(marker), true, 'synthetic child entered its local tail');
  assert.equal(step.ok, false);
  assert(step.guardian_diagnostic, 'a success JSON cannot bypass the guardian deadline');
  assert(elapsed < 3000, 'bounded guardian exited well before the ten-second synthetic tail');
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
