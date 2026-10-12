import assert from 'node:assert/strict';
import test from 'node:test';
import { runWorker, runStep } from '../src/runtime/worker/worker.mjs';
import { buildCycleStepSpecs, runCycleWithRunner } from '../dist/runtime/worker/lark-im-worker-core.js';
import { WORKER_DEFAULTS } from '../src/runtime/worker/options.mjs';
import { parseRouteOptions } from '../src/cli/registry.mjs';

function nextForwardStarts(historyMs, intervalSeconds = 30) {
  let tick = 2208988800000;
  const starts = [], sleeps = [];
  const opts = { ...WORKER_DEFAULTS, intervalSeconds, db: '/tmp/synthetic-history-idle.sqlite',
    logDir: '', maxCycles: 4, remoteSampleIntervalSeconds: 0 };
  const ok = runWorker(opts, {
    nowMs: () => tick, sleepSeconds: seconds => { sleeps.push(seconds); tick += seconds * 1000; },
    runCycle: (cycleOpts, cycle, deps) => runCycleWithRunner(cycleOpts, cycle, (name, args, command) => {
      if (name === 'sent') starts.push(tick);
      return runStep(name, args, { command, nowMs: () => tick, runProcess: () => {
        tick += name === 'history' ? historyMs : 1000;
        return { status: 0, stdout: '{"ok":true}', stderr: '' };
      } });
    }, () => {}, () => new Date(tick).toISOString(), deps.onComplete),
  });
  assert.equal(ok, true);
  return { starts: starts.map(value => value - starts[0]), sleeps };
}

test('history batch spends configured idle allowance without delaying the next forward start', () => {
  const withoutHistory = nextForwardStarts(0);
  for (const duration of [1000, 12_000, 25_000, 30_000]) {
    const batch = nextForwardStarts(duration);
    assert.deepEqual(batch.starts, withoutHistory.starts);
    assert.deepEqual(batch.sleeps, Array(3).fill(30 - duration / 1000));
  }
  assert.deepEqual(nextForwardStarts(25_000, 60).sleeps, [35, 35, 35]);
});

test('slow local commit tails are visible as forward delay and never become negative sleep', () => {
  const overrun = nextForwardStarts(37_000);
  const baseline = nextForwardStarts(0);
  assert.deepEqual(overrun.sleeps, [0, 0, 0]);
  assert.deepEqual(overrun.starts.map((value, index) => value - baseline.starts[index]), [0, 7000, 14000, 21000]);
});

test('worker passes one cumulative batch budget and bounds remote time by configured idle allowance', () => {
  for (const [interval, expected] of [[60, '25'], [30, '25'], [15, '10'], [3, '1']]) {
    const step = buildCycleStepSpecs({ ...WORKER_DEFAULTS, intervalSeconds: interval }, 1).find(item => item.name === 'history');
    assert.equal(step.command, 'maintenance');
    const parsed = parseRouteOptions('maintenance.history', step.args.slice(1)).options;
    assert.equal(parsed.maxRecords, 12);
    assert.equal(parsed.maxCliAttempts, 12);
    assert.equal(parsed.maxSeconds, Number(expected));
    assert.ok(parsed.logDir.endsWith('logs/lark-im'));
  }
  const standalone = parseRouteOptions('maintenance.history', ['--db', 'synthetic.sqlite']).options;
  assert.equal(standalone.maxRecords, 1);
  assert.equal(standalone.maxCliAttempts, 4);
  assert.equal(standalone.logDir, undefined);
});

test('batch receipts keep bounded counters and reasons without propagating target details', () => {
  const event = runStep('history', [], { command: 'maintenance', runProcess: () => ({ status: 0, stderr: '',
    stdout: JSON.stringify({ ok: true, profile: 'known_record_history/v1', outcome: 'batch_processed',
      processed: 6, priority_processed: 4, fair_processed: 2, failed: 0, priority_hint_reason: 'ready',
      fair_round_reason: 'ready', record_id: 123, targets: ['synthetic-private-id'], raw: 'synthetic-private-body' }) }) });
  assert.equal(event.summary.processed, 6);
  assert.equal(event.summary.priority_processed, 4);
  assert.equal(event.summary.fair_processed, 2);
  assert.equal(event.summary.priority_hint_reason, 'ready');
  assert.doesNotMatch(JSON.stringify(event.summary), /synthetic-private|record_id|targets/);
});

test('a due asynchronous sample replaces history and gets the whole idle interval before forward resumes', () => {
  let tick = 2208988800000, sampleFinish = null, sampleCalls = 0;
  const starts = [], historyCycles = [], receipts = [];
  const opts = { ...WORKER_DEFAULTS, intervalSeconds: 30, maxCycles: 3, logDir: '', db: '/tmp/synthetic-sample-idle.sqlite' };
  runWorker(opts, {
    nowMs: () => tick, monotonicNowMs: () => tick, sleepSeconds: seconds => { tick += seconds * 1000; },
    writeScheduler: () => {},
    runRemoteSample: sampleOpts => {
      assert.equal(sampleOpts.remoteSampleBudgetMs, 25_000);
      sampleCalls++;
      if (sampleCalls !== 1) return { outcome: 'not_due' };
      sampleFinish = tick + 25_000;
      return { outcome: 'started', reason: 'sample_started' };
    },
    runCycle: (cycleOpts, cycle, deps) => runCycleWithRunner(cycleOpts, cycle, (name, args, command) => {
      if (name === 'sent') {
        starts.push(tick);
        if (cycle > 1) assert.ok(tick >= sampleFinish, 'the admitted sample finishes before the next foreground start');
      }
      if (name === 'history') historyCycles.push(cycle);
      return runStep(name, args, { command, nowMs: () => tick, monotonicNowMs: () => tick,
        runProcess: () => { tick += name === 'history' ? 25_000 : 1000; return { status: 0, stdout: '{"ok":true}', stderr: '' }; } });
    }, (_opts, event) => receipts.push(event), () => new Date(tick).toISOString(), deps.onComplete, deps.beforeHistory),
  });
  assert.deepEqual(starts.map(value => value - starts[0]), [0, 36_000, 72_000]);
  assert.deepEqual(historyCycles, [2, 3]);
  assert.equal(receipts.find(row => row.cycle === 1 && row.name === 'history').summary.outcome, 'sample_scheduled');
});

for (const jump of [-60_000, 60_000]) {
  test(`history idle credit is monotonic across a wall-clock adjustment of ${jump}ms`, () => {
    let elapsed = 0, wallOffset = 0;
    const sleeps = [];
    const wall = () => 2208988800000 + elapsed + wallOffset;
    const opts = { ...WORKER_DEFAULTS, intervalSeconds: 30, maxCycles: 2, remoteSampleIntervalSeconds: 0,
      logDir: '', db: '/tmp/synthetic-clock-adjustment.sqlite' };
    runWorker(opts, {
      nowMs: wall, monotonicNowMs: () => elapsed,
      sleepSeconds: seconds => { sleeps.push(seconds); elapsed += seconds * 1000; },
      runCycle: (cycleOpts, cycle, deps) => runCycleWithRunner(cycleOpts, cycle, (name, args, command) =>
        runStep(name, args, { command, nowMs: wall, monotonicNowMs: () => elapsed, runProcess: () => {
          elapsed += name === 'history' ? 25_000 : 1000;
          if (name === 'history') wallOffset += jump;
          return { status: 0, stdout: '{"ok":true}', stderr: '' };
        } }), () => {}, () => new Date(wall()).toISOString(), deps.onComplete, deps.beforeHistory),
    });
    assert.deepEqual(sleeps, [5]);
  });
}

test('retention on every cycle still admits samples and the final finite cycle completes history', () => {
  let tick = 2208988800000, samples = 0;
  const historyCycles = [], order = [];
  const opts = { ...WORKER_DEFAULTS, intervalSeconds: 30, maxCycles: 3, retentionEveryCycles: 1,
    logDir: '', db: '/tmp/synthetic-retention-idle.sqlite' };
  runWorker(opts, {
    nowMs: () => tick, sleepSeconds: seconds => { tick += seconds * 1000; }, writeScheduler: () => {},
    runRemoteSample: () => { samples++; order.push('sample'); return { outcome: 'started' }; },
    runCycle: (cycleOpts, cycle, deps) => runCycleWithRunner(cycleOpts, cycle, (name, args, command) => {
      order.push(name);
      if (name === 'history') historyCycles.push(cycle);
      return runStep(name, args, { command, nowMs: () => tick, runProcess: () => {
        tick += 1000; return { status: 0, stdout: '{"ok":true}', stderr: '' };
      } });
    }, () => {}, () => new Date(tick).toISOString(), deps.onComplete, deps.beforeHistory),
  });
  assert.equal(samples, 2);
  assert.deepEqual(historyCycles, [3]);
  assert.equal(order[order.indexOf('sample') - 1], 'retention');
});
