import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { runWorker, runCycle, runStep } from '../src/runtime/worker/worker.mjs';
import { WORKER_DEFAULTS } from '../src/runtime/worker/options.mjs';
import { REQUIRED_CYCLE_STEPS } from '../src/runtime/worker/step-vocabulary.mjs';
import { readIdleFairState, claimIdleLane } from '../src/runtime/worker/idle-fair-state.mjs';
import { tryAcquireLarkApiLease } from '../src/runtime/lark-api-lease.mjs';
import { ensureInitialized, reserveInitialLarkAccount, confirmInitialLarkAccountSql,
  sqliteExec, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';

globalThis.fetch = Socket.prototype.connect = () => { throw new Error('synthetic wiring test forbids network'); };
const value = (args, flag) => args[args.indexOf(flag) + 1];
const num = (args, flag) => Number(value(args, flag));
const counters = () => ({ calls: 0, attempts: 0, retries: 0, rate_limits: 0, timeouts: 0,
  wait_ms: 0, max_retry_after_ms: 0, cooldown_until_ms: 0, exhausted: 0, retry_after_unknown: 0,
  by_operation: {}, cooldowns_by_operation: {} });
function backoffSummary() {
  return { ok: false, partial: true, incomplete: true, transport: counters(), received: [], sent: {
    ok: false, list_complete: true, details_complete: false, incomplete: true, pending_details: 1,
    detail_retry: { ok: false, skipped: true, reason: 'details_not_due', detail_attempts: 0 },
    idle_detail_backoff: { version: 1, kind: 'saved_list_backoff', pending_details: 1, detail_attempts: 0 },
  } };
}
function stepName(argv) {
  if (argv[1] === 'maintenance') return argv[2] === 'prune-runs' ? 'retention' : argv[2];
  const scope = value(argv, '--scope');
  if (scope === 'sent') return 'sent';
  if (scope === 'received') return value(argv, '--received-mode') === 'hot' ? 'received-hot' : 'received-fair';
  const mode = value(argv, '--discovery-mode');
  return mode === 'hot' ? 'discover-hot' : mode === 'reconcile' ? 'discover-reconcile' : 'discover-catchup';
}
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-idle-wiring-synthetic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'authored.sqlite');
  writeFileSync(db, '');
  let ms = 0, cycle = 0;
  const calls = [], events = [], claims = [], hints = [], sleeps = [], scheduler = [];
  let fair = structuredClone(options.fair || { sequence: 10, last_served: { sample: 2, history: 4, resources: 10 } });
  const opts = { ...WORKER_DEFAULTS, db, logDir: '', intervalSeconds: 30, maxCycles: 2, ...options.opts };
  const now = () => 2208988800000 + ms, mono = () => ms;
  const advance = n => { ms += n; };
  const receipt = (args, cli, self, elapsed = 100) => ({ complete: true,
    max_cli_attempts: num(args, '--max-cli-attempts'), max_self_attempts: num(args, '--max-self-attempts'),
    cli_attempts: cli, self_attempts: self, max_seconds: num(args, '--max-seconds'),
    min_interval_ms: 1000, elapsed_ms: elapsed, stop_reason: null });
  const recordCall = (name, args, settings) => calls.push({ name, cycle, at: ms, args: [...args], timeout: settings.timeout });
  function processResult(_cmd, argv, settings) {
    const name = stepName(argv);
    recordCall(name, argv, settings);
    if (name === 'history') {
      advance(100);
      return { status: 0, stdout: JSON.stringify({ ok: true, profile: 'known_record_history/v1',
        outcome: 'batch_processed', processed: 1, request_budget: receipt(argv,
          options.historyCli ?? 9, options.historySelf ?? 4) }), stderr: '' };
    }
    advance(10);
    let summary = { ok: true, transport: counters() }, status = 0;
    if (name === 'sent' && options.forward !== 'healthy') {
      summary = backoffSummary(); status = 2;
      options.mutate?.(summary);
    }
    return { status, stdout: JSON.stringify(summary), stderr: '', ...(name === 'sent' ? options.processFailure : {}) };
  }
  const deps = {
    nowMs: now, monotonicNowMs: mono,
    sleepSeconds: seconds => { sleeps.push(seconds); advance(seconds * 1000); },
    writeScheduler: (_opts, event) => scheduler.push(event),
    hasHistoryWork: () => { hints.push('history'); return options.historyAvailable === true; },
    hasResourceWork: () => { hints.push('resources'); advance(options.hintMs || 0); return options.resourceAvailable !== false; },
    readIdleFairState: (_db, budget) => { hints.push('fair'); hints.push({ deadline: budget.monotonicDeadlineMs, at: ms }); return structuredClone(fair); },
    claimIdleLane: (_db, state, lane, eligible, budget) => {
      claims.push({ lane, eligible: [...eligible], state: structuredClone(state), at: ms, deadline: budget.monotonicDeadlineMs });
      if (options.claimFail) return null;
      assert.equal(state.sequence, fair.sequence);
      const order = eligible.slice().sort((a, b) => state.last_served[a] - state.last_served[b] ||
        ['sample','history','resources'].indexOf(a) - ['sample','history','resources'].indexOf(b));
      assert.equal(lane, order[0]);
      fair.last_served[lane] = ++fair.sequence;
      advance(options.claimMs || 0);
      return structuredClone(fair);
    },
    remoteSampleAdmission: () => { hints.push('sample'); return { outcome: 'due' }; },
    runRemoteSample: sampleOpts => {
      calls.push({ name: 'sample', cycle, at: ms, cli: sampleOpts.maxApiCalls, self: sampleOpts.maxSelfCalls,
        budgetMs: sampleOpts.remoteSampleBudgetMs });
      advance(100);
      return { outcome: 'ok', reason: 'sampled', budget_receipt: { version: 1, complete: true,
        max_cli_attempts: sampleOpts.maxApiCalls, max_self_attempts: sampleOpts.maxSelfCalls,
        cli_attempts: 12, self_attempts: 2 } };
    },
    runResources: (args, limits) => runStep('resources', args, {
      command: 'maintenance', nowMs: now, monotonicNowMs: mono, ...limits,
      runProcess: (_cmd, argv, settings) => {
        recordCall('resources', argv, settings); advance(options.resourceMs ?? 12000);
        return { status: 0, stderr: '', stdout: JSON.stringify({ ok: true, profile: 'known_record_resources/v1',
          outcome: 'processed', processed: 1, available: 1, deferred: 0, blocked: 0,
          request_budget: receipt(args, 3, 2, options.resourceMs ?? 12000) }) };
      },
    }),
    runCycle: (cycleOpts, n, cycleDeps) => {
      cycle = n;
      // Real worker/runCycle/runStep/core execution and projections. Only the
      // subprocess result boundary is authored; no CLI/API child is launched.
      return runCycle(cycleOpts, n, { ...cycleDeps,
        runStep: { runProcess: processResult },
        writeLog: { stdout: { write: line => events.push(JSON.parse(line)) } },
      });
    },
  };
  return { dir, db, opts, deps, calls, events, claims, hints, sleeps, scheduler,
    get fair() { return fair; }, run(extra = {}) { return runWorker(opts, { ...deps, ...extra }); } };
}
function optional(f) { return f.calls.filter(row => ['resources','history','sample'].includes(row.name)); }
function assertForwardOrder(f) {
  for (let n = 1; n <= f.opts.maxCycles; n++) {
    assert.deepEqual(f.calls.filter(row => row.cycle === n && REQUIRED_CYCLE_STEPS.includes(row.name)).map(row => row.name),
      [...REQUIRED_CYCLE_STEPS]);
    assert.deepEqual(f.events.filter(event => event.type === 'lark_im_worker_step' && event.cycle === n).map(event => event.name),
      [...REQUIRED_CYCLE_STEPS, 'history']);
  }
}

test('actual runWorker resources-only wiring preserves partial health, cycle order and peer service ages', t => {
  const f = fixture(t);
  assert.equal(f.run(), false);
  assert.deepEqual(optional(f).map(row => row.name), ['resources','resources']);
  assert.equal(f.hints.includes('history'), true, 'bounded known-record history hint remains eligible');
  assert.equal(f.hints.includes('sample'), false, 'no sampling admission query');
  assert.deepEqual(f.claims.map(row => row.eligible), [['resources'], ['resources']]);
  assert.deepEqual(f.fair, { sequence: 12, last_served: { sample: 2, history: 4, resources: 12 } });
  assert(f.events.filter(event => event.type === 'lark_im_worker_cycle').every(event =>
    event.ok === false && JSON.stringify(event.failed_steps) === '["sent"]'));
  assert(f.events.filter(event => event.name === 'history').every(event => event.summary.processed === 0 &&
    event.summary.resources.available === 1 && event.summary.idle_outcome === 'completed'));
  assertForwardOrder(f);
});

test('resources-only children remain inside original 25-second/12-CLI/6-self shared allowance', t => {
  const f = fixture(t, { opts: { intervalSeconds: 60 }, hintMs: 500 });
  assert.equal(f.run(), false);
  for (const call of optional(f)) {
    assert.equal(call.name, 'resources');
    assert.equal(num(call.args, '--max-cli-attempts'), 3);
    assert.equal(num(call.args, '--max-self-attempts'), 2);
    assert.equal(num(call.args, '--max-seconds'), 22);
    assert.equal(call.timeout, 22_500, '500ms hint and 2s guardian cleanup are charged inside 25s');
  }
  assert(f.hints.filter(row => typeof row === 'object').every(row => row.deadline - row.at === 24_500));
  assert(f.claims.every(row => row.deadline - row.at === 18_500));
  for (let cycle = 1; cycle <= 2; cycle++) {
    const work = optional(f).filter(row => row.cycle === cycle);
    assert(work.reduce((n, row) => n + num(row.args, '--max-cli-attempts'), 0) <= 12);
    assert(work.reduce((n, row) => n + num(row.args, '--max-self-attempts'), 0) <= 6);
  }
  assert(f.sleeps.every(seconds => seconds === 47.5), 'measured 12.5s idle gets no extra allowance');
});

for (const [label, options] of [
  ['missing producer proof', { mutate: raw => { delete raw.sent.idle_detail_backoff; } }],
  ['raw invalid cooldown', { mutate: raw => { raw.transport.cooldowns_by_operation.synthetic_unknown = 0; } }],
  ['raw timeout', { mutate: raw => { raw.transport.timeouts = 1; } }],
  ['non-success exit', { processFailure: { status: 1 } }],
  ['guardian rejected late summary', { processFailure: { guardian_diagnostic: { primary: { stage: 'deadline' } } } }],
  ['unclassified stderr', { processFailure: { stderr: 'synthetic unexpected diagnostic' } }],
]) test(`actual runWorker none prevents both optional work and core history fallback: ${label}`, t => {
  const f = fixture(t, options), before = structuredClone(f.fair);
  assert.equal(f.run(), false);
  assert.deepEqual(optional(f), []);
  assert.deepEqual(f.hints, [], 'none never consults optional queues or sampling');
  assert.deepEqual(f.claims, []);
  assert.deepEqual(f.fair, before);
  const events = f.events.filter(event => event.name === 'history');
  assert.equal(events.length, 2, 'truthy logical history events still complete both cycles');
  assert(events.every(event => event.summary.idle_outcome === 'forward_not_ready' && event.summary.processed === 0 &&
    event.summary.cursor_policy === 'unchanged' && event.elapsed_ms === 0 && event.ok === true));
  assertForwardOrder(f);
});

test('resource absence or fair CAS refusal does not silently enable history/sample or reset age', t => {
  for (const options of [{ resourceAvailable: false }, { claimFail: true }, { claimMs: 25_000 }]) {
    const f = fixture(t, options), before = structuredClone(f.fair);
    assert.equal(f.run(), false);
    assert.deepEqual(optional(f), []);
    assert.equal(f.hints.includes('history'), true);
    assert.equal(f.hints.includes('sample'), false);
    assert.equal(f.fair.last_served.history, before.last_served.history);
    assert.equal(f.fair.last_served.sample, before.last_served.sample);
    if (!options.claimMs) assert.deepEqual(f.fair, before);
    // A late successful CAS remains a committed opportunity; it is never
    // compensated even though the rechecked deadline prevents the child.
    else assert.equal(f.fair.sequence, before.sequence + 2);
  }
});

test('normal healthy worker retains history/resource service with exactly the shared 12/6 total cap', t => {
  const f = fixture(t, { forward: 'healthy', historyAvailable: true, opts: { maxCycles: 1 },
    fair: { sequence: 2, last_served: { history: 0, resources: 1, sample: 2 } } });
  assert.equal(f.run(), true);
  const work = optional(f);
  assert.deepEqual(work.map(row => row.name), ['history','resources']);
  assert.equal(num(work[0].args, '--max-cli-attempts'), 12);
  assert.equal(num(work[0].args, '--max-self-attempts'), 6);
  assert.equal(num(work[1].args, '--max-cli-attempts'), 3);
  assert.equal(num(work[1].args, '--max-self-attempts'), 2);
  const idle = f.events.find(event => event.name === 'history').summary;
  assert.equal(idle.request_budget.cli_attempts + idle.resources.request_budget.cli_attempts, 12,
    'actual returned history and resource usage together consume exactly the original CLI cap');
  assert.equal(idle.request_budget.self_attempts + idle.resources.request_budget.self_attempts, 6,
    'actual returned history and resource usage together consume exactly the original self cap');
  assert(f.hints.includes('history'));
  assert.equal(f.claims[0].lane, 'history');
  assert(f.claims[0].eligible.includes('resources'));
  assertForwardOrder(f);
});

test('normal healthy non-final cycle still admits due sampling instead of globally disabling it', t => {
  const f = fixture(t, { forward: 'healthy', historyAvailable: true, fair: { sequence: 2, last_served: { sample: 0, history: 1, resources: 2 } } });
  assert.equal(f.run(), true);
  const first = optional(f)[0];
  assert.equal(first.name, 'sample');
  assert.equal(first.cli, 12);
  assert.equal(first.self, 2);
  assert.equal(first.budgetMs, 25_000);
  assert(f.hints.includes('sample'));
});

test('resources-only runWorker changes only its real durable fair age under an explicit private lease', t => {
  const f = fixture(t, { opts: { maxCycles: 1 } });
  ensureInitialized(f.db);
  const account = recipientAccountKey('ou_synthetic_idle_wiring_owner');
  reserveInitialLarkAccount(f.db, account, new Date().toISOString());
  sqliteExec(f.db, confirmInitialLarkAccountSql(new Date().toISOString()));
  const directory = join(f.dir, 'private-api-coordination');
  const leaseDeps = { tryAcquireLease: (options, deps = {}) => tryAcquireLarkApiLease(options, { ...deps, directory }) };
  for (const lane of ['sample', 'history', 'resources']) {
    const state = readIdleFairState(f.db, leaseDeps);
    assert(state);
    assert(claimIdleLane(f.db, state, lane, ['sample','history','resources'], leaseDeps));
  }
  const before = sqliteQuery(f.db, 'SELECT * FROM lark_im_idle_fair_state;')[0];
  const actualClaims = [];
  assert.equal(f.run({
    readIdleFairState: (db, deps) => readIdleFairState(db, { ...deps, ...leaseDeps }),
    claimIdleLane: (db, state, lane, eligible, deps) => {
      actualClaims.push({ lane, eligible: [...eligible] });
      return claimIdleLane(db, state, lane, eligible, { ...deps, ...leaseDeps });
    },
  }), false);
  assert.deepEqual(actualClaims, [{ lane: 'resources', eligible: ['resources'] }]);
  const after = sqliteQuery(f.db, 'SELECT * FROM lark_im_idle_fair_state;')[0];
  assert.equal(after.sequence, before.sequence + 1);
  assert.equal(after.generation, before.generation + 1);
  assert.equal(after.resources_last_served, after.sequence);
  assert.equal(after.history_last_served, before.history_last_served);
  assert.equal(after.sample_last_served, before.sample_last_served);
  assert.equal(after.account_key, before.account_key);
  assert.equal(after.database_key, before.database_key);
  assert.deepEqual(optional(f).map(row => row.name), ['resources']);
});


test('scheduled retention keeps its original position before resources-only idle work', t => {
  const f = fixture(t, { opts: { maxCycles: 1, retentionEveryCycles: 1 } });
  assert.equal(f.run(), false);
  assert.deepEqual(f.calls.map(row => row.name), [...REQUIRED_CYCLE_STEPS, 'retention', 'resources']);
  assert.deepEqual(f.events.filter(event => event.type === 'lark_im_worker_step').map(event => event.name),
    [...REQUIRED_CYCLE_STEPS, 'retention', 'history']);
  assert.deepEqual(optional(f).map(row => row.name), ['resources']);
  assert.deepEqual(f.events.find(event => event.type === 'lark_im_worker_cycle').failed_steps, ['sent']);
});


test('proved saved-list backoff restores bounded known-record history and resources without admitting sample', t => {
  const f = fixture(t, { historyAvailable: true, resourceMs: 100, opts: { maxCycles: 3 } });
  assert.equal(f.run(), false);
  assert.deepEqual(f.claims.map(row => row.lane), ['history', 'resources', 'history']);
  assert(f.claims.every(row => row.eligible.length === 2 && row.eligible.includes('history') && row.eligible.includes('resources')));
  assert.equal(f.calls.some(row => row.name === 'sample'), false);
  assert.equal(f.hints.includes('sample'), false);
  assert(f.events.filter(e => e.type === 'lark_im_worker_cycle').every(e => e.ok === false));
  assert(optional(f).filter(row => row.name === 'history').every(row =>
    num(row.args, '--max-records') === 12 && num(row.args, '--max-seconds') <= 22 && row.timeout <= 23000));
  assertForwardOrder(f);
});
