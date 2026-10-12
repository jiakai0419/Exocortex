import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activityDatabaseKey } from '../src/diagnostics/lark-im-activity-evidence.mjs';
import { parseRemoteSampleCache } from '../src/diagnostics/remote-sample-cache.mjs';
import { createRemoteSamplePublication } from '../src/runtime/worker/remote-sample-cache-gate.mjs';
import { REMOTE_SAMPLE_GUARDIAN } from '../src/runtime/worker/remote-sample-process.mjs';
import { executeRemoteSampleAttempt, remoteSamplePaths, runScheduledRemoteSample,
  writeRemoteSampleState } from '../src/runtime/worker/remote-sample-scheduler.mjs';

const NOW = 1_900_000_000_000;
const ACCOUNT = 'b'.repeat(64);
const OTHER_ATTEMPT = '22222222-2222-4222-8222-222222222222';
const publicReceipt = (cli = 5, self = 2, maxCli = 5, maxSelf = 2) => ({ version: 1, complete: true,
  max_cli_attempts: maxCli, max_self_attempts: maxSelf, cli_attempts: cli, self_attempts: self });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-budget-receipt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite');
  writeFileSync(db, 'synthetic file identity; no business database', { mode: 0o600 });
  const databaseKey = activityDatabaseKey(db), paths = remoteSamplePaths(directory, databaseKey);
  const opts = { db, logDir: directory, remoteSampleIntervalSeconds: 900,
    maxApiCalls: 5, maxSelfCalls: 2, remoteSampleBudgetMs: 25000 };
  return { directory, db, databaseKey, paths, opts };
}

function parsedInvocation(args, settings) {
  const input = JSON.parse(settings.input), publication = JSON.parse(settings.env.EXOCORTEX_REMOTE_SAMPLE_PUBLICATION);
  assert.deepEqual(input.publication, publication);
  assert.match(publication.attemptId, /^[a-f0-9-]{36}$/);
  const guardian = args.indexOf(REMOTE_SAMPLE_GUARDIAN);
  assert.ok(guardian >= 0);
  return { input, publication, timeout: Number(args[guardian + 2]), settings };
}
function rawReceipt(input, cli = 5, self = 2) {
  return { ...publicReceipt(cli, self, input.collectorOptions.maxApiCalls, input.collectorOptions.maxSelfCalls),
    attempt_id: input.publication.attemptId };
}
function output(input, patch = {}) {
  return { outcome: 'ok', reason: 'sampled', next_due: NOW + 900000, cooldownsByOperation: {},
    cachePrepared: true, cacheWritten: true, budget_receipt: rawReceipt(input), ...patch };
}
function fakeRun(f, respond, deps = {}, opts = {}) {
  return runScheduledRemoteSample({ ...f.opts, ...opts }, { nowMs: () => NOW, ...deps,
    spawnSync(_command, args, settings) {
      const invocation = parsedInvocation(args, settings);
      const response = respond(invocation);
      return response?.stdout !== undefined || response?.error || response?.signal ? response
        : { status: 0, stdout: JSON.stringify(response) };
    } });
}
function noReceipt(value) { assert.equal(Object.hasOwn(value, 'budget_receipt'), false); }

test('strict sampler limits reach the child and only the matching raw receipt is returned without its token', t => {
  const f = fixture(t); let attempt;
  const result = fakeRun(f, ({ input, publication }) => {
    attempt = publication.attemptId;
    assert.equal(input.collectorOptions.maxApiCalls, 5);
    assert.equal(input.collectorOptions.maxSelfCalls, 2);
    assert.equal(input.collectorOptions.remoteSampleBudgetMs, 25000);
    assert.equal(input.returnReport, false);
    return output(input, { budget_receipt: rawReceipt(input, 3, 1) });
  });
  assert.equal(result.outcome, 'ok');
  assert.deepEqual(result.budget_receipt, publicReceipt(3, 1));
  assert.equal(JSON.stringify(result).includes(attempt), false);
});

test('invalid explicit count and duration limits reject before any guardian spawn', t => {
  const f = fixture(t);
  for (const patch of [{ maxApiCalls: 0 }, { maxApiCalls: -1 }, { maxApiCalls: 13 }, { maxApiCalls: 1.5 },
    { maxApiCalls: '5' }, { maxApiCalls: null }, { maxApiCalls: NaN }, { maxSelfCalls: 0 },
    { maxSelfCalls: 7 }, { maxSelfCalls: false }, { maxSelfCalls: 1.5 }, { remoteSampleBudgetMs: 999 },
    { remoteSampleBudgetMs: 55001 }, { remoteSampleBudgetMs: Infinity }, { remoteSampleBudgetMs: '25000' }]) {
    let spawns = 0;
    const result = runScheduledRemoteSample({ ...f.opts, ...patch }, { nowMs: () => NOW,
      spawnSync() { spawns++; throw new Error('invalid budget must not spawn'); } });
    assert.equal(spawns, 0);
    assert.equal(result.outcome, 'failed');
    noReceipt(result);
  }
});

test('wrong token, schema, caps or actual counters cannot refund a reservation', t => {
  const f = fixture(t);
  const changes = [() => undefined, () => null, () => ({}), r => ({ ...r, attempt_id: OTHER_ATTEMPT }),
    r => ({ ...r, complete: false }), r => ({ ...r, complete: 1 }), r => ({ ...r, version: '1' }),
    r => ({ ...r, extra: 0 }), r => ({ ...r, max_cli_attempts: 12 }), r => ({ ...r, max_self_attempts: 6 }),
    r => ({ ...r, cli_attempts: -1 }), r => ({ ...r, cli_attempts: 6 }), r => ({ ...r, self_attempts: 3 }),
    r => ({ ...r, cli_attempts: 1, self_attempts: 2 }), r => ({ ...r, cli_attempts: 1.5 }),
    r => ({ ...r, cli_attempts: '0' }), r => ({ ...r, self_attempts: false }),
    r => ({ ...r, cli_attempts: Number.MAX_SAFE_INTEGER + 1 }),
    r => { const { self_attempts, ...missing } = r; return missing; }];
  for (const change of changes) {
    const result = fakeRun(f, ({ input }) => output(input, { budget_receipt: change(rawReceipt(input)) }));
    noReceipt(result);
  }
  let saved;
  fakeRun(f, ({ input }) => { saved = rawReceipt(input); return output(input); });
  noReceipt(fakeRun(f, ({ input }) => output(input, { budget_receipt: saved })));
});

test('guardian nonzero, signal, timeout, malformed output or diagnostic never accepts even a valid receipt', t => {
  const f = fixture(t);
  const diagnostic = { version: 1, primary: { stage: 'cache_publish', errno: null }, cleanup: null };
  for (const transform of [
    value => ({ status: 2, stdout: JSON.stringify(value) }),
    value => ({ status: null, signal: 'SIGTERM', stdout: JSON.stringify(value) }),
    value => ({ status: null, error: { code: 'ETIMEDOUT' }, stdout: JSON.stringify(value) }),
    value => ({ status: 0, stdout: JSON.stringify({ ...value, guardian_diagnostic: diagnostic }) }),
    value => ({ status: 0, stdout: JSON.stringify({ ...value, report: { guardian_diagnostic: diagnostic } }) }),
    () => ({ status: 0, stdout: '{incomplete' }),
    () => ({ status: 0, stdout: '' }),
  ]) {
    const result = fakeRun(f, ({ input }) => transform(output(input)));
    assert.equal(result.outcome, 'failed');
    noReceipt(result);
  }
});

test('public report normalization to zero is not an accounting receipt', t => {
  const f = fixture(t);
  for (const probe of [{}, { api_calls: 'bad', self_calls: false }, { api_calls: -1, self_calls: 0 }]) {
    const result = fakeRun(f, ({ input }) => output(input, { budget_receipt: undefined,
      report: { status: 'unavailable', reason: 'api_unavailable', probe } }), { returnReport: true });
    assert.equal(result.report.probe.api_calls, 0);
    noReceipt(result);
  }
  noReceipt(fakeRun(f, ({ input }) => output(input, { outcome: 'failed', reason: 'sample_failed',
    budget_receipt: undefined })));
});

test('child receipt uses raw collector counters and never invents zero after a collector exception', async t => {
  const f = fixture(t), publication = createRemoteSamplePublication(f.directory, f.databaseKey);
  const childOpts = { ...f.opts, publication };
  const sample = probe => ({ outcome: 'failed', report: { status: 'unavailable', reason: 'api_unavailable', probe },
    cooldownsByOperation: {}, cacheContext: null });
  const base = { nowMs: () => NOW, invalidateCache: () => true, writeState: () => {}, writeCache: () => true };
  const good = await executeRemoteSampleAttempt(childOpts, { ...base, collect: () => sample({ api_calls: 3, self_calls: 1 }) });
  assert.deepEqual(good.budget_receipt, { ...publicReceipt(3, 1), attempt_id: publication.attemptId });
  for (const probe of [{}, { api_calls: '0', self_calls: 0 }, { api_calls: 2, self_calls: false },
    { api_calls: 6, self_calls: 2 }, { api_calls: 1, self_calls: 2 }]) {
    noReceipt(await executeRemoteSampleAttempt(childOpts, { ...base, collect: () => sample(probe), returnReport: true }));
  }
  noReceipt(await executeRemoteSampleAttempt(childOpts, { ...base, collect() { throw new Error('synthetic unknown progress'); } }));
});

test('parent not_due and exact pre-child skip frames prove zero requests', t => {
  const f = fixture(t);
  writeRemoteSampleState(f.paths.state, { kind: 'lark_im_remote_sample_schedule/v1', database_key: f.databaseKey,
    account_key: ACCOUNT, written_at: NOW, next_due: NOW + 900000, failures: 0, rotation: 0,
    observations: {}, last_outcome: 'ok', cooldowns: {}, blocked_reason: null }, NOW);
  let spawns = 0;
  const preflight = runScheduledRemoteSample(f.opts, { nowMs: () => NOW,
    spawnSync() { spawns++; throw new Error('not due must not spawn'); } });
  assert.equal(preflight.outcome, 'not_due');
  assert.equal(spawns, 0);
  assert.deepEqual(preflight.budget_receipt, publicReceipt(0, 0));
  rmSync(f.paths.state);
  for (const frame of [{ outcome: 'busy', reason: 'scheduler_busy' },
    { outcome: 'not_due', reason: 'not_due', next_due: NOW + 900000, cooldownsByOperation: {}, cachePrepared: false }]) {
    assert.deepEqual(fakeRun(f, () => frame).budget_receipt, publicReceipt(0, 0));
  }
});

test('busy after API work and contradictory skip envelopes cannot claim a zero refund', t => {
  const f = fixture(t);
  noReceipt(fakeRun(f, () => ({ outcome: 'busy', reason: 'sync_busy', cooldownsByOperation: {} })));
  for (const frame of [
    { outcome: 'busy', reason: 'scheduler_busy', report: { probe: { api_calls: 3 } } },
    { outcome: 'busy', reason: 'scheduler_busy', budget_receipt: { attempt_id: OTHER_ATTEMPT } },
    { outcome: 'not_due', reason: 'not_due', cachePrepared: false, next_due: NOW + 900000,
      cooldownsByOperation: {}, report: { probe: { api_calls: 3 } } },
  ]) noReceipt(fakeRun(f, () => frame));
});

test('remaining budget is sampled after parent admission work and bounds guardian and child without a fresh 25 seconds', t => {
  const f = fixture(t); let elapsed = 0, remainingReads = 0;
  const result = fakeRun(f, ({ input, timeout, settings }) => {
    assert.equal(remainingReads, 1);
    assert.equal(input.collectorOptions.remoteSampleBudgetMs, 23625);
    assert.equal(timeout, 23625);
    assert.equal(settings.timeout, 25625, 'cleanup grace remains outside the request allowance');
    assert.equal(settings.killSignal, 'SIGTERM');
    return output(input);
  }, { databaseKey: () => { elapsed += 1375; return f.databaseKey; },
    remainingTimeMs: () => { remainingReads++; return 25000 - elapsed; } });
  assert.deepEqual(result.budget_receipt, publicReceipt());
  fakeRun(f, ({ input, timeout, settings }) => {
    assert.equal(input.collectorOptions.remoteSampleBudgetMs, 25000);
    assert.equal(timeout, 25000, 'the remote allowance is not shortened to 23 seconds');
    assert.equal(settings.timeout, 27000);
    return output(input);
  }, { remainingTimeMs: () => 25000 });
});

test('exhausted or invalid remaining time starts no child and proves zero requests', t => {
  const f = fixture(t);
  for (const remaining of [0, -1, 999, NaN, Infinity]) {
    let spawns = 0;
    const result = runScheduledRemoteSample(f.opts, { nowMs: () => NOW, remainingTimeMs: () => remaining,
      spawnSync() { spawns++; throw new Error('no remaining time'); } });
    assert.equal(spawns, 0);
    assert.deepEqual(result.budget_receipt, publicReceipt(0, 0));
  }
});

test('real Python guardian publishes a private synthetic stage before accepting its matching budget receipt', { timeout: 8000 }, t => {
  const f = fixture(t), childPath = join(f.directory, 'synthetic-child.mjs');
  const cacheUrl = new URL('../src/diagnostics/remote-sample-cache.mjs', import.meta.url).href;
  const code = `import assert from 'node:assert/strict';
    import { readFileSync, fstatSync, lstatSync } from 'node:fs';
    import { writeRemoteSampleCache } from ${JSON.stringify(cacheUrl)};
    const input=JSON.parse(readFileSync(0,'utf8'));
    const publication=JSON.parse(process.env.EXOCORTEX_REMOTE_SAMPLE_PUBLICATION);
    assert.deepEqual(input.publication,publication);
    const held=fstatSync(Number(process.env.EXOCORTEX_REMOTE_SAMPLE_LOCK_FD)),named=lstatSync(publication.lockPath);
    assert.ok(held.isFile()&&held.dev===named.dev&&held.ino===named.ino);
    assert.equal(JSON.parse(readFileSync(publication.cachePath,'utf8')).reason,'attempting');
    const now=Date.now(),end=Math.floor((now-600000)/60000)*60000;
    const report={schema_version:3,status:'inconclusive',ok:false,reason:'no_usable_remote_messages',checked_at:new Date(now).toISOString(),
      window:{start:new Date(end-86400000).toISOString(),end:new Date(end).toISOString()},
      probe:{hot_chats_requested:2,hot_chats_found:2,messages_per_chat:20,remote_messages_checked:0,unsupported_chats:0,
        probe_errors:0,eligible_chats:2,hot_chats:1,fair_chats:1,chats_checked:2,pages:2,truncated_chats:0,api_calls:5,self_calls:2},
      findings:{},binding:{state:'verified',evidence:'single_sent_actor'}};
    assert.ok(writeRemoteSampleCache(publication.stagePath,{report,cacheContext:{database_key:${JSON.stringify(f.databaseKey)},
      account_key:${JSON.stringify(ACCOUNT)},auth_identity_verified:true}}));
    const receipt={version:1,complete:true,attempt_id:publication.attemptId,max_cli_attempts:input.collectorOptions.maxApiCalls,
      max_self_attempts:input.collectorOptions.maxSelfCalls,cli_attempts:5,self_attempts:2};
    process.stdout.write(JSON.stringify({outcome:'ok',reason:'sampled',next_due:now+900000,cooldownsByOperation:{},
      cachePrepared:true,cacheWritten:true,report,budget_receipt:receipt})+'\\n');`;
  writeFileSync(childPath, code, { mode: 0o600 });
  let publication;
  const result = runScheduledRemoteSample(f.opts, { scriptPath: childPath, returnReport: true, remainingTimeMs: () => 3000,
    spawnSync(command, args, settings) {
      publication = parsedInvocation(args, settings).publication;
      // This exact child only writes the synthetic stage. No collector, API or
      // shared API lock code runs; only its private scheduler flock is used.
      const env = { PATH: process.env.PATH || '/usr/bin:/bin', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
        EXOCORTEX_REMOTE_SAMPLE_PUBLICATION: settings.env.EXOCORTEX_REMOTE_SAMPLE_PUBLICATION,
        EXOCORTEX_REMOTE_SAMPLE_CAPTURE: settings.env.EXOCORTEX_REMOTE_SAMPLE_CAPTURE,
        EXOCORTEX_REMOTE_SAMPLE_INPUT: '', EXOCORTEX_REMOTE_SAMPLE_WAKE: '' };
      return spawnSync(command, args, { ...settings, env });
    } });
  assert.equal(result.outcome, 'ok', JSON.stringify(result));
  assert.equal(result.guardian_diagnostic, undefined);
  assert.equal(result.cacheWritten, true);
  assert.deepEqual(result.budget_receipt, publicReceipt());
  assert.equal(JSON.stringify(result).includes(publication.attemptId), false);
  assert.equal(existsSync(publication.stagePath), false);
  assert.equal(statSync(publication.cachePath).mode & 0o777, 0o600);
  const cache = JSON.parse(readFileSync(publication.cachePath, 'utf8'));
  assert.ok(parseRemoteSampleCache(cache));
  assert.equal(cache.context.database_key, f.databaseKey);
  assert.equal(cache.probe.api_calls, 5);
});
