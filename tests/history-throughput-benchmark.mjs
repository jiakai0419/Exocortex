#!/usr/bin/env node
// Explicit, opt-in performance experiment. All rows and remote responses are
// authored below; this file never reads a production database or spawns a CLI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, list) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), list[i + 1]]);
  return pairs;
}, []));
const root = resolve(args.root || new URL('..', import.meta.url).pathname);
const number = (key, fallback) => args[key] === undefined ? fallback : Number(args[key]);
const rowCount = number('rows', 182), scopeCount = number('scopes', 91);
const maxCycles = number('cycles', 10000), latencyMs = number('latency-ms', 250);
const forwardMs = number('forward-ms', 62000), intervalSeconds = number('interval-seconds', 30);
const arrivalsPerCycle = number('arrivals-per-cycle', 0);
const debtCount = number('debts', 20), sameVersionCount = number('same-version-debts', Math.floor(debtCount / 2));
const serialIdle = args['serial-idle'] === 'true';
const layout = args.layout || 'balanced';
assert.ok(Number.isInteger(rowCount) && rowCount >= 20 && rowCount <= 20000);
assert.ok(Number.isInteger(scopeCount) && scopeCount >= 1 && scopeCount <= rowCount);
assert.ok(['balanced', 'skewed'].includes(layout));
assert.ok(Number.isInteger(maxCycles) && maxCycles > 0 && maxCycles <= 100000);
assert.ok(Number.isFinite(latencyMs) && latencyMs >= 0 && latencyMs <= 10000);
assert.ok(Number.isInteger(arrivalsPerCycle) && arrivalsPerCycle >= 0 && arrivalsPerCycle <= 3);
assert.ok(Number.isInteger(debtCount) && debtCount >= 1 && debtCount <= rowCount);
assert.ok(Number.isInteger(sameVersionCount) && sameVersionCount >= 0 && sameVersionCount <= debtCount);
const load = path => import(pathToFileURL(join(root, path)).href);
const [store, history, worker, core, options, normalizer, syncRunner, larkCore, sampler, sampleCore,
  bindingModule, scheduler] = await Promise.all([
  load('dist/storage/sqlite/ingestion-store.js'), load('src/maintenance/history.mjs'),
  load('src/runtime/worker/worker.mjs'), load('dist/runtime/worker/lark-im-worker-core.js'),
  load('src/runtime/worker/options.mjs'), load('src/adapters/lark-im/raw-message.mjs'),
  load('src/adapters/lark-im/sync-runner.mjs'), load('src/adapters/lark-im/core.mjs'),
  load('src/diagnostics/remote-sample.mjs'), load('src/diagnostics/remote-sample-core.mjs'),
  load('src/diagnostics/remote-account-binding.mjs'), load('src/runtime/worker/remote-sample-scheduler.mjs'),
]);
const START = Date.parse('2026-02-01T00:00:00Z');
const SELF = { open_id: 'ou_synthetic_throughput_observer', name: 'Synthetic Observer' };
const hash = text => createHash('sha256').update(text).digest('hex');
const harnessHash = hash(readFileSync(new URL(import.meta.url)));
const fixtureDir = mkdtempSync(join(tmpdir(), 'synthetic-history-throughput-'));
chmodSync(fixtureDir, 0o700);
const db = join(fixtureDir, 'synthetic.sqlite'), logDir = join(fixtureDir, 'logs');
let clock = Date.now(), startedClock = clock, currentCycle = 0;
const wallStarted = performance.now(), q = store.quoteSql;
const remote = [], debtIds = new Set(), twoConfirmation = new Set();
const firstFetched = new Map(), firstProcessed = new Map(), accepted = new Map(), closed = new Map();
const requestEvents = [], commits = [], cycleEvents = [], samples = [], sleeps = [], sentStarts = [];
const invocationEvents = [];
const sampleInsteadOfHistory = [];
let heldLease = false, requestNo = 0, samplerRequests = 0, scanCompletedAt = null;
let nextSampleAt = clock + 900000, rotation = 0, observations;
let observedCount = 0, initialObservationKeys;
let arrivals = 0;
let background = null, finishBackground = () => {};

function increment(ms) { assert.ok(ms >= 0); clock += ms; finishBackground(); }
function lease() {
  assert.equal(heldLease, false, 'synthetic global API lease is never nested');
  heldLease = true;
  return { state: 'acquired', release() { assert.equal(heldLease, true); heldLease = false; } };
}
function sleep(ms) {
  assert.equal(heldLease, false, 'request gaps yield the API lease');
  increment(ms);
}
function remoteResponse(args, { diagnostic = false } = {}) {
  assert.equal(heldLease, true);
  const at = clock;
  increment(latencyMs);
  if (diagnostic) samplerRequests++; else requestNo++;
  invocationEvents.push({ cycle: currentCycle, diagnostic, self: args[0] === 'contact' || args[2]?.includes('/authen/'),
    at_ms: at - startedClock, finished_ms: clock - startedClock });
  if (args[0] === 'contact') return { status: 0, stdout: JSON.stringify(SELF), stderr: '' };
  const path = args[2], params = JSON.parse(args[args.indexOf('--params') + 1]);
  if (path.includes('/authen/')) return { status: 0, stdout: JSON.stringify({ code: 0,
    data: { open_id: SELF.open_id, tenant_key: 'synthetic_throughput_tenant' } }), stderr: '' };
  assert.ok(['/open-apis/im/v1/messages', '/open-apis/im/v1/messages/mget'].includes(path));
  const startMs = Number(params.start_time) * 1000, endMs = Number(params.end_time) * 1000;
  const items = path.endsWith('/mget') ? remote.filter(message => params.message_ids.includes(message.message_id)) :
    remote.filter(message => message.chat_id === params.container_id &&
      Number(message.create_time) >= startMs && Number(message.create_time) < endMs);
  assert.ok(items.length <= (diagnostic ? 20 : 50));
  for (const message of items) {
    const id = Number(message.message_id.slice('om_synthetic_throughput_'.length));
    if (!diagnostic && !firstFetched.has(id)) firstFetched.set(id, at - startedClock);
    requestEvents.push({ cycle: currentCycle, diagnostic, row: id, at_ms: at - startedClock });
  }
  return { status: 0, stdout: JSON.stringify({ code: 0, data: { items, has_more: false, page_token: '' } }), stderr: '' };
}

try {
  store.ensureInitialized(db);
  const scopes = Array.from({ length: scopeCount }, (_, i) => {
    const chat = `oc_synthetic_throughput_${String(i).padStart(5, '0')}`;
    return { chat, id: larkCore.chatScopeId(chat), config: { chat_id: chat, chat_type: 'group' } };
  });
  store.sqliteExec(db, `UPDATE sources SET config_json=${q(JSON.stringify({ initial_sync_start_ms: START,
    initial_account_binding: { kind: store.INITIAL_ACCOUNT_KIND,
      account_key: hash(`lark.im\0${SELF.open_id}`), reserved_at: new Date(START).toISOString(),
      confirmed_at: new Date(START).toISOString() } }))} WHERE id='lark.im';\n` +
    scopes.map((scope, i) => `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(scope.id)},'lark.im',
      ${q(`Synthetic throughput scope ${i}`)},${q(JSON.stringify(scope.config))});`).join('\n'));
  const initial = [];
  for (let n = 1; n <= rowCount; n++) {
    const scopeIndex = layout === 'balanced' ? (n - 1) % scopeCount :
      n <= rowCount - scopeCount + 1 ? 0 : n - (rowCount - scopeCount + 1);
    const scope = scopes[scopeIndex], created = START + n * 5000;
    const old = { message_id: `om_synthetic_throughput_${n}`, chat_id: scope.chat, msg_type: 'text',
      create_time: String(created), update_time: String(created + 1000), deleted: false,
      sender: { id: 'ou_synthetic_throughput_author', id_type: 'open_id', sender_type: 'user' },
      body: { content: JSON.stringify({ text: `Synthetic original ${n}` }) } };
    const fresh = structuredClone(old);
    if (n > rowCount - debtCount) {
      debtIds.add(n);
      if (n > rowCount - sameVersionCount) twoConfirmation.add(n);
      else fresh.update_time = String(created + 2000);
      fresh.body.content = JSON.stringify({ text: `Synthetic edited ${n}` });
    }
    remote.push(fresh);
    initial.push(...syncRunner.prepareChatWindowRecords([normalizer.normalizeApiMessage(old)], scope.id, null,
      created, created + 1000, SELF.open_id, { self: SELF }, scope.config));
  }
  store.sqliteExec(db, store.upsertRecordsSql(initial));
  const binding = bindingModule.readRemoteAccountBinding({ db, selfOpenId: SELF.open_id });
  assert.equal(binding.state, 'verified');
  const keyFor = message => sampleCore.digest([binding.database_key, binding.account_key,
    message.chat_id, message.message_id, Number(message.create_time)]);
  const oldRows = new Map(store.sqliteQuery(db, 'SELECT * FROM records;').map(row => [row.external_id, row]));
  const debtMessages = remote.filter((_, i) => debtIds.has(i + 1));
  observations = sampleCore.evaluateSample({ messages: debtMessages, records: oldRows,
    coverage: Object.fromEntries(debtMessages.map(message => [keyFor(message),
      { covered: true, details_pending: false, latest_finished_ms: clock - 3600001 }])),
    binding, now: clock - 3600000, windowEnd: clock - 3600000 }).observations;
  assert.equal(Object.keys(observations).length, debtCount);
  initialObservationKeys = new Map(debtMessages.map(message => [keyFor(message), Number(message.message_id.slice('om_synthetic_throughput_'.length))]));
  // Distinct scheduler-only timestamps remove database-salted hash ordering as
  // a source of variation between otherwise identical candidate/baseline runs.
  for (const [key, id] of initialObservationKeys) observations[key].last_checked += id;
  const statePath = scheduler.remoteSamplePaths(logDir, binding.database_key).state;
  const addArrivals = () => {
    for (let i = 0; i < arrivalsPerCycle; i++) {
      const n = remote.length + 1;
      const scope = scopes[layout === 'skewed' ? 0 : (n - 1) % scopes.length], created = START + n * 5000;
      const message = { message_id: `om_synthetic_throughput_${n}`, chat_id: scope.chat, msg_type: 'text',
        create_time: String(created), update_time: String(created + 1000), deleted: false,
        sender: { id: 'ou_synthetic_throughput_author', id_type: 'open_id', sender_type: 'user' },
        body: { content: JSON.stringify({ text: `Synthetic arrival ${n}` }) } };
      remote.push(message);
      store.sqliteExec(db, store.upsertRecordsSql(syncRunner.prepareChatWindowRecords([normalizer.normalizeApiMessage(message)],
        scope.id, null, created, created + 1000, SELF.open_id, { self: SELF }, scope.config)));
      arrivals++;
    }
  };
  const publishState = (at = clock) => scheduler.writeRemoteSampleState(statePath, {
    kind: 'lark_im_remote_sample_schedule/v1', database_key: binding.database_key, account_key: binding.account_key,
    written_at: at, next_due: nextSampleAt, failures: 0, rotation, observations,
    observation_overflow: false, last_outcome: 'ok', cooldowns: {}, blocked_reason: null,
  }, clock);
  publishState();

  // Real SQLite has its own wall clock. Rebase only the review TTL into that
  // clock; all row/scope/account/admission/CAS/observation checks stay real.
  // History and scheduler time are virtual so days can be evaluated promptly.
  const commitWithClock = (path, command) => {
    const now = Date.now();
    const result = store.commitBoundedReplayRecords(path, { ...command, reviewFence: {
      ...command.reviewFence, createdAtMs: now, expiresAtMs: now + 1800000,
    } });
    const id = command.history.selectedId, at = clock - startedClock;
    if (!firstProcessed.has(id)) { firstProcessed.set(id, at); if (id <= rowCount) observedCount++; }
    if (observedCount === rowCount && scanCompletedAt === null) scanCompletedAt = at;
    const entry = { cycle: currentCycle, row: id, at_ms: at,
      lane: command.history.scheduling?.lane || 'fair', error: command.history.error,
      updated: result.updated, duplicate: result.duplicate, conflicts: result.conflicts };
    commits.push(entry);
    if (debtIds.has(id) && result.updated > 0 && !accepted.has(id)) {
      const actual = store.sqliteQuery(db, `SELECT raw_json FROM records WHERE id=${id};`)[0];
      assert.deepEqual(JSON.parse(actual.raw_json), remote[id - 1]);
      accepted.set(id, at);
      if (twoConfirmation.has(id)) assert.ok(commits.filter(item => item.row === id).length >= 2,
        'same-version update cannot count as accepted on its first acquisition');
    }
    return result;
  };
  const historyDeps = { now: () => clock, commit: commitWithClock,
    requestSessionDeps: { env: { LARK_CLI: 'synthetic_never_spawned' }, monotonicClock: () => clock,
      now: () => clock, sleep, tryAcquireLease: lease,
      readSharedCooldown: () => ({ state: 'ready' }), writeSharedCooldown: () => true,
      spawnSync: (_command, commandArgs) => remoteResponse(commandArgs) } };
  const opts = { ...options.WORKER_DEFAULTS, db, logDir, intervalSeconds,
    maxCycles, adaptiveFair: false, retentionEveryCycles: maxCycles + 1, remoteSampleIntervalSeconds: 900 };
  const frame = args['history-max-records'] ? { maxRecords: number('history-max-records'),
    maxCliAttempts: number('history-max-cli', 12), maxSeconds: number('history-max-seconds', 25), logDir } : null;
  const summaries = [], localHistoryCosts = [];
  finishBackground = () => {
    if (!background || clock < background.finishedAt) return;
    const done = background;
    background = null;
    observations = done.result.observations;
    rotation = done.result.rotation;
    nextSampleAt = done.nextDue;
    for (const key of done.beforeKeys) if (!Object.hasOwn(observations, key) && initialObservationKeys.has(key)) {
      const id = initialObservationKeys.get(key);
      assert.ok(accepted.has(id), 'only a fresh independent sample may retire local accepted debt');
      closed.set(id, done.finishedAt - startedClock);
    }
    publishState(done.finishedAt);
    if (scanCompletedAt !== null && closed.size === debtCount) opts.maxCycles = currentCycle;
  };
  worker.runWorker(opts, { nowMs: () => clock, monotonicNowMs: () => clock,
    ...(serialIdle ? { hasHistoryWork: () => true,
      remoteSampleAdmission: (sampleOptions, admissionDeps) => scheduler.readScheduledRemoteSampleAdmission(sampleOptions, admissionDeps) } : {}),
    sleepSeconds: seconds => { sleeps.push({ cycle: currentCycle, milliseconds: seconds * 1000 }); increment(seconds * 1000); },
    writeScheduler() {},
    runCycle: (cycleOpts, cycle, deps) => {
      currentCycle = cycle;
      if (cycle % 100 === 0) process.stderr.write(`${JSON.stringify({ progress: true, cycle,
        distinct_processed: firstProcessed.size, accepted: accepted.size, closed: closed.size })}\n`);
      let forwardStep = 0;
      return core.runCycleWithRunner(cycleOpts, cycle, (name, commandArgs, command) => {
        if (name === 'sent') sentStarts.push(clock - startedClock);
        return worker.runStep(name, commandArgs, { command, nowMs: () => clock, monotonicNowMs: () => clock,
          runProcess: () => {
            let result;
            if (name === 'history') {
              const findNumber = (flag, fallback) => commandArgs.includes(flag) ? Number(commandArgs[commandArgs.indexOf(flag) + 1]) : fallback;
              const historyOptions = frame || { db, logDir,
                maxRecords: findNumber('--max-records', 1), maxCliAttempts: findNumber('--max-cli-attempts', 4),
                ...(commandArgs.includes('--max-self-attempts') ? { maxSelfAttempts: findNumber('--max-self-attempts', 6) } : {}),
                maxSeconds: findNumber('--max-seconds', 30) };
              const localStarted = performance.now(), cpuStarted = process.cpuUsage();
              result = history.executeLarkImHistory({ db, ...historyOptions }, historyDeps);
              const cpu = process.cpuUsage(cpuStarted);
              localHistoryCosts.push({ wall_ms: performance.now() - localStarted,
                node_cpu_ms: (cpu.user + cpu.system) / 1000 });
              summaries.push({ cycle, at_ms: clock - startedClock, ...result });
              addArrivals();
            } else {
              increment(Math.floor(forwardMs / 6) + (forwardStep++ < forwardMs % 6 ? 1 : 0));
              result = { ok: true, transport: { calls: 0, attempts: 0, rate_limits: 0, timeouts: 0, exhausted: 0 } };
            }
            return { status: result.ok ? 0 : 2, stdout: JSON.stringify(result), stderr: '' };
          } });
      }, (_opts, event) => {
        if (event.type === 'lark_im_worker_cycle') cycleEvents.push(event);
        if (event.name === 'history' && event.summary?.outcome === 'sample_scheduled') sampleInsteadOfHistory.push(cycle);
      }, () => new Date(clock).toISOString(), deps.onComplete, deps.beforeHistory);
    },
    runRemoteSample: sampleOptions => {
      finishBackground();
      if (background) return { outcome: 'running' };
      if (serialIdle) {
        const admission = scheduler.readScheduledRemoteSampleAdmission(sampleOptions, { nowMs: () => clock });
        if (admission.outcome !== 'due') return admission;
      } else if (clock < nextSampleAt) return { outcome: 'not_due' };
      const beforeKeys = new Set(Object.keys(observations)), sampledAt = clock;
      const result = sampler.collectRemoteSample(db, { previousObservations: observations,
        accountKey: binding.account_key, rotation, remoteSampleBudgetMs: sampleOptions.remoteSampleBudgetMs,
        maxApiCalls: sampleOptions.maxApiCalls, maxSelfCalls: sampleOptions.maxSelfCalls,
        env: { LARK_CLI: 'synthetic_never_spawned' } }, {
        now: () => clock, sleep, tryAcquireLease: lease,
        readSharedCooldown: () => ({ state: 'ready' }), writeSharedCooldown: () => true,
        spawnSync: (_command, commandArgs) => remoteResponse(commandArgs, { diagnostic: true }),
      });
      assert.equal(result.outcome, 'ok', JSON.stringify(result.report));
      const finishedAt = clock;
      samples.push({ cycle: currentCycle, start_ms: sampledAt - startedClock, finish_ms: clock - startedClock,
        remaining: Object.keys(result.observations).length, history: result.report.history || null,
        calls: result.report.probe.api_calls, self_calls: result.report.probe.self_calls ?? 2, outcome: result.outcome });
      const nextDue = scheduler.nextRemoteSampleDue ? scheduler.nextRemoteSampleDue({ finished: clock,
        ok: result.outcome === 'ok', busy: result.outcome === 'busy', interval: 900000, backoff: 900000,
        verified: result.cacheContext?.auth_identity_verified === true && Boolean(result.cacheContext?.account_key),
        pendingVerification: result.pendingVerification, cooldowns: result.cooldownsByOperation || {} }) : clock + 900000;
      // Execute the actual child logic above, but place its completion on the
      // background timeline. The worker receives only its actual start result;
      // the child's duration is not synchronously added to foreground work.
      background = { result, beforeKeys, finishedAt, nextDue };
      if (serialIdle) {
        finishBackground();
        return { outcome: result.outcome, reason: 'sampled', next_due: nextDue,
          cooldownsByOperation: result.cooldownsByOperation, budget_receipt: { version: 1, complete: true,
            max_cli_attempts: sampleOptions.maxApiCalls, max_self_attempts: sampleOptions.maxSelfCalls,
            cli_attempts: result.report.probe.api_calls, self_attempts: result.report.probe.self_calls } };
      }
      clock = sampledAt;
      return { outcome: 'started', next_due: nextDue };
    },
  });
  const elapsed = clock - startedClock;
  let consecutivePriority = 0, maxConsecutivePriority = 0;
  for (const entry of commits) {
    consecutivePriority = entry.lane === 'priority' ? consecutivePriority + 1 : 0;
    maxConsecutivePriority = Math.max(maxConsecutivePriority, consecutivePriority);
    assert.ok(consecutivePriority <= 2, 'priority debt must yield to a fair record after at most two commits');
  }
  assert.ok(summaries.every(summary => summary.request_budget.cli_attempts <= summary.request_budget.max_cli_attempts));
  assert.ok(samples.every(sample => sample.calls <= 12));
  if (serialIdle) {
    for (let cycle = 1; cycle <= currentCycle; cycle++) {
      const calls = invocationEvents.filter(event => event.cycle === cycle);
      assert.ok(calls.length <= 12, `cycle ${cycle} shares at most 12 CLI attempts`);
      assert.ok(calls.filter(event => event.self).length <= 6, `cycle ${cycle} shares at most 6 identity attempts`);
      for (let index = 1; index < calls.length; index++) assert.ok(calls[index].at_ms - calls[index - 1].finished_ms >= 1000,
        `cycle ${cycle} preserves the gap across actor boundaries`);
    }
  }
  const summarize = values => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return { observed: sorted.length, p50_ms: sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * .5) - 1)] : null,
      p95_ms: sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] : null,
      max_ms: sorted.length ? sorted.at(-1) : null };
  };
  const targets = [...debtIds].map(id => ({ row: id, requires_two_confirmations: twoConfirmation.has(id),
    first_fetch_ms: firstFetched.get(id) ?? null, first_processed_ms: firstProcessed.get(id) ?? null,
    local_accepted_ms: accepted.get(id) ?? null, independent_closed_ms: closed.get(id) ?? null }));
  const report = {
    schema: 'history_throughput_synthetic/v1', root, synthetic_only: true,
    harness_sha256: harnessHash,
    workload: { rows: rowCount, scopes: scopeCount, known_debts: debtCount, same_version_debts: sameVersionCount, layout,
      request_latency_ms: latencyMs, forward_work_ms: forwardMs, interval_seconds: intervalSeconds,
      arrivals_per_cycle: arrivalsPerCycle, max_cycles: maxCycles },
    model_boundary: ['Actual history selector, adapter, request budget, SQLite commit and observation reducer',
      'Actual runWorker, runCycleWithRunner and runStep; six forward child steps are fixed synthetic work',
      'Actual collector, request budget, SQLite snapshot and observation retirement; remote transport is synthetic',
      'Only SQLite review-TTL clock translated to real wall time; no account/row/CAS check disabled',
      'Sampler due is actual nextRemoteSampleDue when available, ordinary 900s interval on the old baseline',
      serialIdle ? 'Serial collector naturally advances the model clock; candidate admission helper reads actual state and tickets' :
        'Collector starts through actual beforeHistory hook when available; completion is an asynchronous modeled event',
      'Synthetic receipts omit guardian/publication-token execution; this model is static auxiliary evidence only',
      'Ordinary baseline collector starts after history. Both versions receive the same idle-overlap model',
      'Process guardian overhead and competing external processes are outside this experiment',
      'Actual runner/batch wall time is recorded separately, not added to deterministic modeled request/work/sleep time',
      'Batch node_cpu_ms covers only the Node process; SQLite subprocess CPU is not included in that field'],
    measured: { wall_elapsed_ms: Math.round(performance.now() - wallStarted), modeled_elapsed_ms: elapsed,
      cycles: currentCycle, committed_attempts: commits.length, distinct_processed: firstProcessed.size,
      initial_distinct_processed: observedCount, arrivals, arrivals_processed: firstProcessed.size - observedCount,
      successful_committed_attempts: commits.filter(item => item.error === null).length,
      first_sweep_complete_ms: scanCompletedAt, history_cli_attempts: requestNo, sampler_cli_attempts: samplerRequests,
      known_local_accepted: accepted.size, known_independent_closed: closed.size,
      pending_sample_completion_ms: background ? background.finishedAt - startedClock : null,
      max_consecutive_priority_commits: maxConsecutivePriority,
      sample_instead_of_history_cycles: sampleInsteadOfHistory.length,
      attempts_per_minute: commits.length / elapsed * 60000,
      unique_first_sweep_records_per_minute: scanCompletedAt === null ? null : rowCount / scanCompletedAt * 60000,
      debt_first_touch: summarize(targets.map(target => target.first_processed_ms)),
      debt_local_accepted: summarize(targets.map(target => target.local_accepted_ms)),
      debt_independent_closed: summarize(targets.map(target => target.independent_closed_ms)),
      local_history_batch_cost: { wall: { ...summarize(localHistoryCosts.map(cost => cost.wall_ms)),
          mean_ms: localHistoryCosts.reduce((sum, cost) => sum + cost.wall_ms, 0) / localHistoryCosts.length },
        node_cpu: { ...summarize(localHistoryCosts.map(cost => cost.node_cpu_ms)),
          mean_ms: localHistoryCosts.reduce((sum, cost) => sum + cost.node_cpu_ms, 0) / localHistoryCosts.length } },
      next_sent_intervals: summarize(sentStarts.slice(1).map((at, i) => at - sentStarts[i])) },
    targets, samples, history_slices: summaries.map(result => ({ cycle: result.cycle, at_ms: result.at_ms,
      ok: result.ok, outcome: result.outcome, processed: result.processed ?? 1,
      priority_processed: result.priority_processed ?? 0, fair_processed: result.fair_processed ?? 1,
      request_budget: result.request_budget })),
    fair_progress: store.sqliteQuery(db, 'SELECT scope_id,generation,after_id,sweep_max_id,completed_sweeps FROM lark_im_history_progress ORDER BY scope_id;'),
    commits, sleeps, invocation_events: invocationEvents,
    code_hashes: Object.fromEntries(['src/maintenance/history.mjs', 'src/runtime/worker/worker.mjs',
      'dist/runtime/worker/lark-im-worker-core.js', 'src/diagnostics/remote-sample.mjs']
      .map(path => [path, hash(readFileSync(join(root, path)))])),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  assert.equal(heldLease, false);
  rmSync(fixtureDir, { recursive: true, force: true });
}
