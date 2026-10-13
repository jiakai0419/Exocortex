import assert from 'node:assert/strict';
import test from 'node:test';
import { runWorker } from '../src/runtime/worker/worker.mjs';
import { runCycleWithRunner } from '../dist/runtime/worker/lark-im-worker-core.js';
import { WORKER_DEFAULTS } from '../src/runtime/worker/options.mjs';

// Only orchestration is real: clocks, step results and collector receipts are
// synthetic. The guardian/token chain has its own real-process tests.
const EPOCH = Date.parse('2035-01-01T00:00:00Z');
function fixture(options = {}) {
  let clock = 0, wallOffset = 0, currentCycle = 0, nextDue = 0;
  const jobs = [], starts = [], sleeps = [], events = [], scheduleEvents = [], admissions = [];
  const opts = { ...WORKER_DEFAULTS, intervalSeconds: 30, maxCycles: 4,
    db: '/tmp/synthetic-idle-budget.sqlite', logDir: '', ...options.opts };
  const advance = ms => { clock += ms; };
  const sample = (sampleOpts, sampleDeps) => {
    jobs.push({ name: 'sample', cycle: currentCycle, at: clock, opts: sampleOpts });
    const value = options.sample?.({ cycle: currentCycle, opts: sampleOpts, deps: sampleDeps, advance }) || { duration: 7000, cli: 5, self: 2 };
    advance(value.duration || 0);
    if (value.throw) throw new Error('synthetic collector failure');
    if (options.wallJump) wallOffset += options.wallJump;
    if (!value.outcome || value.outcome === 'ok') nextDue = clock + (options.dueIntervalMs ?? 60_000);
    return { outcome: value.outcome || 'ok', reason: 'sampled', next_due: EPOCH + nextDue,
      ...(value.cooldowns ? { cooldownsByOperation: value.cooldowns } : {}),
      ...(value.noReceipt ? {} : { budget_receipt: value.receipt || { version: 1, complete: true,
        max_cli_attempts: sampleOpts.maxApiCalls, max_self_attempts: sampleOpts.maxSelfCalls,
        cli_attempts: value.cli ?? 5, self_attempts: value.self ?? 2 } }) };
  };
  const ok = runWorker(opts, {
    nowMs: () => EPOCH + clock + wallOffset, monotonicNowMs: () => clock,
    hasHistoryWork: () => options.historyAvailable !== false,
    remoteSampleAdmission: (_opts, deps) => {
      const admission = typeof options.admission === 'function'
        ? options.admission({ cycle: currentCycle, clock, deps })
        : options.admission || { outcome: options.notDue || options.dueIntervalMs !== undefined && clock < nextDue ? 'not_due' : 'due' };
      admissions.push({ cycle: currentCycle, ...admission });
      return admission;
    },
    runRemoteSample: sample,
    writeScheduler: (_opts, event) => scheduleEvents.push(event),
    sleepSeconds: seconds => { sleeps.push({ cycle: currentCycle, seconds }); advance(seconds * 1000); },
    runCycle: (cycleOpts, cycle, deps) => {
      currentCycle = cycle;
      starts.push(clock);
      return runCycleWithRunner(cycleOpts, cycle, (name, args) => {
        const start = clock;
        let summary = { ok: true };
        if (name === 'history') {
          const arg = key => Number(args[args.indexOf(key) + 1]);
          const grant = { cli: arg('--max-cli-attempts'), self: arg('--max-self-attempts'), seconds: arg('--max-seconds') };
          jobs.push({ name, cycle, at: clock, grant });
          const value = options.history?.({ cycle, grant, advance }) || { duration: 8000, cli: 6, self: 4, processed: 12 };
          advance(value.duration || 0);
          summary = { ok: value.ok !== false, profile: 'known_record_history/v1', outcome: value.outcome || 'batch_processed',
            processed: value.processed ?? 12, cursor_policy: 'unchanged', coverage: 'known_rows_only',
            ...(value.noReceipt ? {} : { request_budget: value.receipt || { max_cli_attempts: grant.cli, max_self_attempts: grant.self,
              cli_attempts: value.cli ?? 6, self_attempts: value.self ?? 4, stop_reason: value.stopReason || null,
              elapsed_ms: value.duration || 0 } }) };
        } else advance(1000);
        return { name, ok: summary.ok, exit_code: summary.ok ? 0 : 2,
          started_at: new Date(EPOCH + start).toISOString(), finished_at: new Date(EPOCH + clock).toISOString(),
          elapsed_ms: clock - start, summary, stderr: '' };
      }, (_opts, event) => events.push(event), () => new Date(EPOCH + clock).toISOString(), deps.onComplete, deps.beforeHistory);
    },
  });
  return { ok, jobs, starts, sleeps, events, scheduleEvents, admissions };
}

test('sample actual surplus funds history with one CLI/self ledger, one deadline and a one-second gap', () => {
  const result = fixture();
  assert.equal(result.ok, true);
  const [sample, history] = result.jobs.filter(job => job.cycle === 1);
  assert.equal(sample.name, 'sample'); assert.equal(sample.opts.maxApiCalls, 12); assert.equal(sample.opts.maxSelfCalls, 2);
  assert.equal(sample.opts.remoteSampleBudgetMs, 25_000);
  assert.equal(history.name, 'history'); assert.equal(history.at - sample.at, 8000);
  assert.deepEqual(history.grant, { cli: 7, self: 4, seconds: 17 });
  assert.deepEqual(result.starts, [0, 36_000, 72_000, 108_000]);
  assert.equal(result.events.find(e => e.cycle === 1 && e.name === 'history').elapsed_ms, 16_000);
  assert.deepEqual(result.sleeps.filter(s => s.cycle === 1).map(s => s.seconds), [1, 14]);
});

test('ordinary-to-merge with only three residual calls retains priority and receives a full next slice', () => {
  const result = fixture({
    sample: () => ({ duration: 7000, cli: 9, self: 2 }),
    history: ({ cycle }) => cycle === 1 ? { duration: 5000, cli: 3, self: 2, processed: 0, outcome: 'legacy_required' }
      : { duration: 10_000, cli: 7, self: 3, processed: 1 },
  });
  const first = result.jobs.filter(job => job.cycle === 1);
  assert.equal(first[1].grant.cli, 3);
  const second = result.jobs.filter(job => job.cycle === 2);
  assert.deepEqual(second.map(job => job.name), ['history']);
  assert.deepEqual(second[0].grant, { cli: 12, self: 6, seconds: 25 });
  assert.equal(result.jobs.find(job => job.cycle === 3).name, 'sample', 'the sample skipped after the writer keeps its age');
});

test('a full slow sample cannot repeatedly starve history; the deferred sample then keeps its own age', () => {
  const result = fixture({ sample: () => ({ duration: 25_000, cli: 12, self: 2 }) });
  assert.deepEqual(result.jobs.filter(job => job.cycle === 1).map(job => job.name), ['sample']);
  assert.deepEqual(result.jobs.filter(job => job.cycle === 2).map(job => job.name), ['history']);
  assert.deepEqual(result.jobs.filter(job => job.cycle === 3).map(job => job.name), ['sample']);
  assert.deepEqual(result.starts, [0, 36_000, 72_000, 108_000]);
});

for (const dueIntervalMs of [900_000, 60_000]) {
  for (const interrupted of [false, true]) {
    test(`${dueIntervalMs / 1000}s due sampling survives persistent ${interrupted ? 'interrupted' : 'time-exhausted'} zero-progress history`, () => {
      const run = processed => fixture({ dueIntervalMs, opts: { maxCycles: 80, remoteSampleIntervalSeconds: 900 },
        history: ({ grant }) => ({ duration: interrupted ? 2030 : grant.seconds * 1000,
          cli: interrupted ? 3 : 2, self: interrupted ? 2 : 1, processed,
          ok: !interrupted, outcome: interrupted ? 'batch_interrupted' : processed ? 'batch_processed' : 'batch_deferred',
          stopReason: interrupted ? null : 'time_budget' }),
      });
      const result = run(0), control = run(1);
      const sampleCycles = result.jobs.filter(job => job.name === 'sample').map(job => job.cycle);
      assert.deepEqual(sampleCycles, dueIntervalMs === 900_000 ? [1, 27, 53, 79]
        : Array.from({ length: 40 }, (_, index) => index * 2 + 1));
      assert.deepEqual(sampleCycles, control.jobs.filter(job => job.name === 'sample').map(job => job.cycle));
      assert.deepEqual(result.admissions.filter(item => item.outcome === 'due').map(item => item.cycle), sampleCycles);
      assert.deepEqual(result.starts, Array.from({ length: 80 }, (_, index) => index * 36_000));
      assert.deepEqual(result.starts, control.starts, 'no request budget is borrowed from new forward sync');
      assert.equal(result.ok, !interrupted, 'independent service must not turn business failure into success');
      for (let cycle = 1; cycle <= 80; cycle++) {
        const jobs = result.jobs.filter(job => job.cycle === cycle);
        const history = result.events.find(event => event.cycle === cycle && event.name === 'history');
        const budget = history.summary.request_budget;
        assert.equal(history.summary.processed, 0);
        assert.equal(history.summary.cursor_policy, 'unchanged');
        assert.ok(budget.cli_attempts + jobs.filter(job => job.name === 'sample').length * 5 <= 12);
        assert.ok(budget.self_attempts + jobs.filter(job => job.name === 'sample').length * 2 <= 6);
        assert.ok(history.elapsed_ms <= 25_000);
        assert.equal(new Set(jobs.map(job => job.name)).size, jobs.length, 'at most one admission per job per slice');
      }
    });
  }
}

for (const [name, sample] of [
  ['failed result', { outcome: 'failed', cli: 3, self: 2 }],
  ['busy with zero attempts', { outcome: 'busy', cli: 0, self: 0 }],
  ['missing receipt', { noReceipt: true }],
  ['collector exception', { throw: true }],
]) test(`a persistently ${name} sampler spends its first opportunity without starving history`, () => {
  const result = fixture({ opts: { maxCycles: 8 }, sample: () => ({ duration: 1000, ...sample }) });
  assert.deepEqual(result.jobs.filter(job => job.name === 'sample').map(job => job.cycle), [1, 3, 5, 7]);
  assert.deepEqual(result.jobs.filter(job => job.name === 'history').map(job => job.cycle), [2, 4, 6, 8]);
  assert.ok(result.jobs.filter(job => job.name === 'history').every(job => job.grant.cli === 12 && job.grant.self === 6));
});

for (const stopReason of ['sync_busy', 'lease_unavailable', 'rate_limited', 'rate_cooldown',
  'shared_cooldown_unavailable', 'clock_unavailable']) {
  test(`zero-request history ${stopReason} spends its first turn but still stops the current idle slice`, () => {
    const result = fixture({ history: () => ({ duration: 1000, cli: 0, self: 0, processed: 0,
      outcome: 'batch_deferred', stopReason }) });
    assert.deepEqual(result.jobs.filter(job => job.cycle === 2).map(job => job.name), ['history']);
    assert.equal(result.jobs.find(job => job.cycle === 3).name, 'sample');
  });
}

test('unknown history consumption stops its slice without retaining every future first opportunity', () => {
  const result = fixture({ history: () => ({ duration: 1000, processed: 0, ok: false,
    outcome: 'batch_interrupted', noReceipt: true }) });
  assert.deepEqual(result.jobs.filter(job => job.cycle === 2).map(job => job.name), ['history']);
  assert.equal(result.jobs.find(job => job.cycle === 3).name, 'sample');
  assert.equal(result.ok, false);
});

test('a sampler 429 keeps its shared cooldown across rotated opportunities', () => {
  const until = EPOCH + 100_000;
  const result = fixture({ opts: { maxCycles: 6 },
    admission: ({ clock, deps }) => ({ outcome: deps.cooldownsByOperation.self_profile > EPOCH + clock ? 'not_due' : 'due' }),
    sample: ({ cycle }) => cycle === 1 ? { duration: 1000, outcome: 'failed', cli: 1, self: 1,
      cooldowns: { self_profile: until } } : { duration: 7000, cli: 5, self: 2 },
  });
  assert.deepEqual(result.jobs.filter(job => job.cycle === 1).map(job => job.name), ['sample']);
  assert.ok(result.jobs.filter(job => job.name === 'sample' && job.cycle > 1).every(job => EPOCH + job.at >= until));
  assert.equal(result.jobs.find(job => job.name === 'sample' && job.cycle > 1).cycle, 4);
  assert.deepEqual(result.starts, Array.from({ length: 6 }, (_, index) => index * 36_000));
});

for (const [name, value] of [
  ['missing receipt', { noReceipt: true }],
  ['missing self count', { receipt: { version: 1, complete: true, max_cli_attempts: 12, max_self_attempts: 2, cli_attempts: 0 } }],
  ['excess calls', { cli: 13 }],
  ['excess self calls', { cli: 5, self: 3 }],
  ['budget from another grant', { receipt: { version: 1, complete: true, max_cli_attempts: 5, max_self_attempts: 2, cli_attempts: 5, self_attempts: 2 } }],
  ['sync busy even with a complete receipt', { outcome: 'busy', cli: 1, self: 1 }],
]) test(`${name} stops optional work without a speculative refund`, () => {
  const result = fixture({ sample: () => ({ duration: 1000, ...value }) });
  assert.deepEqual(result.jobs.filter(job => job.cycle === 1).map(job => job.name), ['sample']);
});

test('confirmed absence of history preserves the full ordinary sample budget and cadence', () => {
  const result = fixture({ historyAvailable: false, opts: { intervalSeconds: 60 }, sample: () => ({ duration: 40_000, cli: 12, self: 2 }) });
  assert.equal(result.jobs.length, 3); assert.ok(result.jobs.every(job => job.name === 'sample'));
  assert.ok(result.jobs.every(job => job.opts.maxApiCalls === 12 && job.opts.remoteSampleBudgetMs === 55_000));
  assert.deepEqual(result.starts, [0, 66_000, 132_000, 198_000]);
});

test('both directions of wall clock change leave the monotonic shared allowance unchanged', () => {
  for (const wallJump of [-60_000, 60_000]) {
    const result = fixture({ wallJump });
    assert.equal(result.jobs.find(job => job.name === 'history').grant.seconds, 17);
    assert.deepEqual(result.starts, [0, 36_000, 72_000, 108_000]);
  }
});

test('real local/guardian overrun is counted once and cannot start a second job past the admission deadline', () => {
  const result = fixture({ sample: () => ({ duration: 37_000, cli: 5, self: 2 }) });
  assert.deepEqual(result.jobs.filter(job => job.cycle === 1).map(job => job.name), ['sample']);
  assert.equal(result.starts[1], 43_000);
  assert.equal(result.sleeps.find(s => s.cycle === 1).seconds, 0);
});

test('a not-due sampler leaves history its full ordinary budget without acquiring a collector process', () => {
  const result = fixture({ notDue: true });
  assert.ok(result.jobs.every(job => job.name === 'history'));
  assert.ok(result.jobs.every(job => job.grant.cli === 12 && job.grant.self === 6));
});

test('failed schedule admission retains the old failure log and starts no collector', () => {
  const result = fixture({ admission: { outcome: 'failed', reason: 'state_invalid', next_due: null } });
  assert.ok(result.jobs.every(job => job.name === 'history'));
  assert.equal(result.scheduleEvents.length, 3);
  assert.ok(result.scheduleEvents.every(event => event.outcome === 'failed' && event.reason === 'state_invalid'));
});

test('a backwards monotonic clock cannot admit the second job', () => {
  const result = fixture({ sample: () => ({ duration: -10_000, cli: 5, self: 2 }) });
  assert.deepEqual(result.jobs.filter(job => job.cycle === 1).map(job => job.name), ['sample']);
});
