import assert from 'node:assert/strict';
import test from 'node:test';
import { runWorker, runStep, runCycle } from '../src/runtime/worker/worker.mjs';
import { runCycleWithRunner } from '../dist/runtime/worker/lark-im-worker-core.js';
import { WORKER_DEFAULTS } from '../src/runtime/worker/options.mjs';

// Exercise real worker orchestration and summary projection; only replace the
// child-process boundary. No database, shared lease, or remote request is used.
function exercise({ history = {}, forwardFailure = false, retentionFailure = false, historyMs = 1000, fairMs = 1000 } = {}) {
  let tick = 2208988800000, samples = 0;
  const observed = [], decisions = [], historySteps = [], cycles = [];
  const opts = { ...WORKER_DEFAULTS, db: '/tmp/synthetic-not-opened-history-scheduling.sqlite',
    adaptiveFair: true, receivedScopesPerCycle: 50, maxCycles: 3,
    ...(retentionFailure ? { retentionEveryCycles: 1 } : {}) };
  const ok = runWorker(opts, {
    nowMs: () => tick, sleepSeconds: () => {},
    writeScheduler: (_opts, event) => decisions.push(event),
    runRemoteSample: () => { samples++; return { outcome: 'not_due' }; },
    runCycle: (cycleOpts, cycle, deps) => runCycleWithRunner(cycleOpts, cycle, (name, args, command) => {
      observed.push([cycle, name, cycleOpts.receivedScopesPerCycle]);
      const summary = name === 'history'
        ? { ok: false, profile: 'known_record_history/v1', outcome: 'missing', cursor_policy: 'unchanged',
          request_budget: { cli_attempts: 2, max_cli_attempts: 4, max_seconds: 30, elapsed_ms: 1000, stop_reason: null }, ...history }
        : { ok: !((forwardFailure && name === 'received-hot') || (retentionFailure && name === 'retention')),
          transport: { calls: 0, attempts: 0, rate_limits: 0, timeouts: 0, exhausted: 0 },
          ...(name === 'received-fair' ? { received: Array.from({ length: cycleOpts.receivedScopesPerCycle }, () => ({ ok: true, scanned: 1, records: 1 })) } : {}) };
      const step = runStep(name, args, { command, nowMs: () => tick, runProcess: () => {
        tick += name === 'history' ? historyMs : name === 'received-fair' ? fairMs : 1000;
        return { status: summary.ok ? 0 : 2, stdout: JSON.stringify(summary), stderr: '' };
      } });
      if (name === 'history') historySteps.push(step);
      return step;
    }, (_opts, event) => { if (event.type === 'lark_im_worker_cycle') cycles.push(event); },
    () => new Date(tick).toISOString(), deps.onComplete),
  });
  return { ok, samples, observed, decisions, historySteps, cycles };
}

test('a genuine forward failure still halves the fair batch and blocks diagnostic admission', () => {
  const result = exercise({ forwardFailure: true });
  assert.equal(result.ok, false);
  assert.equal(result.samples, 0);
  assert.deepEqual(result.decisions.map(event => event.next_batch), [25, 12, 10]);
  assert.ok(result.decisions.every(event => event.pressure.failed_steps === 1));
});

test('separating history debt preserves the existing retention failure scheduling policy', () => {
  const result = exercise({ retentionFailure: true });
  assert.equal(result.ok, false);
  assert.equal(result.samples, 0);
  assert.deepEqual(result.decisions.map(event => event.next_batch), [25, 12, 10]);
  assert.ok(result.decisions.every(event => event.pressure.failed_steps === 1));
});

test('bounded history work has a separate elapsed measure from healthy forward throughput', () => {
  const result = exercise({ historyMs: 30_000, fairMs: 20_000 });
  assert.deepEqual(result.decisions.map(event => event.next_batch), [50, 50, 50]);
  assert.equal(result.samples, 3);
  assert.equal(result.decisions[0].durations.work_ms, 55_000);
  assert.equal(result.decisions[0].durations.history_ms, 30_000);
  assert.equal(result.decisions[0].durations.forward_work_ms, 25_000);
});

for (const stopReason of ['rate_limited', 'rate_cooldown']) {
  test(`history ${stopReason} remains shared transport pressure after real runStep compaction`, () => {
    const result = exercise({ history: { outcome: 'fetch_unavailable', request_budget: { cli_attempts: 2, stop_reason: stopReason } } });
    assert.deepEqual(result.decisions.map(event => event.next_batch), [25, 12, 10]);
    assert.ok(result.decisions.every(event => event.pressure.rate_limits === 1 && event.pressure.failed_steps === 0));
    assert.equal(result.historySteps[0].summary.request_budget.stop_reason, stopReason);
    // Admission delegates to the diagnostic controller's independent due/lease/
    // shared cooldown gates; a business failure does not replace those gates.
    assert.equal(result.samples, 3);
  });
}

for (const stopReason of ['cli_budget', 'time_budget', 'sync_busy']) {
  test(`history slice stop ${stopReason} is not invented forward transport failure`, () => {
    const result = exercise({ history: { outcome: 'fetch_unavailable', request_budget: { cli_attempts: 4, stop_reason: stopReason } } });
    assert.deepEqual(result.decisions.map(event => event.next_batch), [50, 50, 50]);
    assert.equal(result.samples, 3);
    assert.equal(result.historySteps[0].summary.request_budget.stop_reason, stopReason);
  });
}

test('history operation cooldown still reaches diagnostics and defers related forward work', () => {
  let tick = 2208988800000;
  const cooldown = tick + 60_000, samples = [], calls = [], decisions = [], events = [];
  const opts = { ...WORKER_DEFAULTS, db: '/tmp/synthetic-not-opened-history-cooldown.sqlite', logDir: null,
    adaptiveFair: true, receivedScopesPerCycle: 50, maxCycles: 2 };
  const ok = runWorker(opts, {
    nowMs: () => tick, sleepSeconds: () => {}, writeScheduler: (_opts, event) => decisions.push(event),
    runRemoteSample: (_opts, deps) => { samples.push({ ...deps.cooldownsByOperation }); return { outcome: 'not_due' }; },
    runCycle: (cycleOpts, cycle, deps) => runCycle(cycleOpts, cycle, { ...deps,
      writeLog: { stdout: { write: line => events.push(JSON.parse(line)) } },
      runStep: { runProcess: (_command, args) => {
        calls.push([cycle, ...args]); tick += 1000;
        const history = args[1] === 'maintenance';
        const summary = history
          ? { ok: false, profile: 'known_record_history/v1', outcome: 'fetch_unavailable',
            request_budget: { stop_reason: 'rate_limited' },
            transport: { rate_limits: 1, cooldowns_by_operation: { message_history_bundle: cooldown } } }
          : { ok: true, transport: { calls: 0, attempts: 0, rate_limits: 0, timeouts: 0, exhausted: 0 } };
        return { status: summary.ok ? 0 : 2, stdout: JSON.stringify(summary), stderr: '' };
      } },
    }),
  });
  assert.equal(ok, false);
  assert.deepEqual(samples, [{ message_history_bundle: cooldown }]);
  assert.equal(decisions[0].pressure.rate_limits, 1); // Do not double-count the budget's same rate stop.
  assert.equal(decisions[0].pressure.failed_steps, 0);
  assert.deepEqual(events.filter(event => event.cycle === 2 && event.summary?.deferred).map(event => event.name),
    ['received-hot', 'received-fair', 'history']);
  assert.equal(calls.filter(([cycle]) => cycle === 2).length, 4); // Unrelated operations keep working.
});

test('history worker receipt logs only finite outcomes, budget reasons and result counters', () => {
  const result = exercise({ history: { outcome: 'pending_observation', conflicts: 1, updated: 0,
    raw: 'synthetic-private-payload', record_id: 123, reason: 'synthetic-private-reason',
    request_budget: { cli_attempts: 4, stop_reason: 'cli_budget', raw: 'synthetic-private-budget', elapsed_ms: -1 } } });
  const summary = result.historySteps[0].summary;
  assert.equal(summary.outcome, 'pending_observation');
  assert.equal(summary.conflicts, 1);
  assert.equal(summary.updated, 0);
  assert.equal(summary.request_budget.elapsed_ms, undefined);
  assert.doesNotMatch(JSON.stringify(summary), /synthetic-private|record_id/);
  const failedAdmission = runStep('history', [], { command: 'maintenance', runProcess: () => ({
    status: 1, stdout: JSON.stringify({ schema_version: 1, ok: false,
      error: { code: 'execution_failed', message: 'maintenance request stopped' },
      request_budget: { cli_attempts: 1, stop_reason: 'rate_limited' } }), stderr: '',
  }) });
  assert.equal(failedAdmission.ok, false);
  assert.equal(failedAdmission.summary.reason, 'execution_failed');
  assert.equal(failedAdmission.summary.request_budget.stop_reason, 'rate_limited');
  const unknown = exercise({ history: { outcome: 'synthetic-private-outcome',
    request_budget: { stop_reason: 'synthetic-private-reason' } } }).historySteps[0].summary;
  assert.equal(unknown.outcome, undefined);
  assert.equal(unknown.request_budget.stop_reason, undefined);
});

for (const outcome of ['missing', 'fetch_unavailable']) {
  test(`history ${outcome} keeps its failed result without penalizing healthy forward batches or diagnostics`, () => {
    const result = exercise({ history: { outcome } });
    assert.equal(result.ok, false);
    assert.deepEqual(result.decisions.map(event => event.next_batch), [50, 50, 50]);
    assert.equal(result.samples, 3);
    assert.equal(result.observed.filter(([, name]) => name !== 'history').length, 18);
    assert.ok(result.cycles.every(cycle => cycle.ok === false && cycle.failed_steps.join() === 'history'));
    assert.equal(result.historySteps[0].ok, false);
    assert.equal(result.historySteps[0].summary.outcome, outcome);
    assert.equal(result.historySteps[0].summary.request_budget.cli_attempts, 2);
    assert.equal(result.historySteps[0].summary.request_budget.stop_reason, null);
  });
}
