import assert from 'node:assert/strict';
import test from 'node:test';
import { runWorker } from '../src/runtime/worker/worker.mjs';
import { runCycleWithRunner } from '../dist/runtime/worker/lark-im-worker-core.js';
import { WORKER_DEFAULTS } from '../src/runtime/worker/options.mjs';

// Only orchestration is real: clocks, step results and collector receipts are
// synthetic. The guardian/token chain has its own real-process tests.
const EPOCH = Date.parse('2035-01-01T00:00:00Z');
function fixture(options = {}) {
  let clock = 0, wallOffset = 0, currentCycle = 0;
  const jobs = [], starts = [], sleeps = [], events = [], scheduleEvents = [];
  const opts = { ...WORKER_DEFAULTS, intervalSeconds: 30, maxCycles: 4,
    db: '/tmp/synthetic-idle-budget.sqlite', logDir: '', ...options.opts };
  const advance = ms => { clock += ms; };
  const sample = sampleOpts => {
    jobs.push({ name: 'sample', cycle: currentCycle, at: clock, opts: sampleOpts });
    const value = options.sample?.({ cycle: currentCycle, opts: sampleOpts, advance }) || { duration: 7000, cli: 5, self: 2 };
    advance(value.duration || 0);
    if (options.wallJump) wallOffset += options.wallJump;
    return { outcome: value.outcome || 'ok', reason: 'sampled', next_due: EPOCH + clock + 60_000,
      ...(value.noReceipt ? {} : { budget_receipt: value.receipt || { version: 1, complete: true,
        max_cli_attempts: sampleOpts.maxApiCalls, max_self_attempts: sampleOpts.maxSelfCalls,
        cli_attempts: value.cli ?? 5, self_attempts: value.self ?? 2 } }) };
  };
  const ok = runWorker(opts, {
    nowMs: () => EPOCH + clock + wallOffset, monotonicNowMs: () => clock,
    hasHistoryWork: () => options.historyAvailable !== false,
    remoteSampleAdmission: () => options.admission || ({ outcome: options.notDue ? 'not_due' : 'due' }),
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
            ...(value.noReceipt ? {} : { request_budget: { max_cli_attempts: grant.cli, max_self_attempts: grant.self,
              cli_attempts: value.cli ?? 6, self_attempts: value.self ?? 4, stop_reason: value.stopReason || null,
              elapsed_ms: value.duration || 0 } }) };
        } else advance(1000);
        return { name, ok: summary.ok, exit_code: summary.ok ? 0 : 2,
          started_at: new Date(EPOCH + start).toISOString(), finished_at: new Date(EPOCH + clock).toISOString(),
          elapsed_ms: clock - start, summary, stderr: '' };
      }, (_opts, event) => events.push(event), () => new Date(EPOCH + clock).toISOString(), deps.onComplete, deps.beforeHistory);
    },
  });
  return { ok, jobs, starts, sleeps, events, scheduleEvents };
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
