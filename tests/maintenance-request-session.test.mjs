import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaintenanceRequestSession, MaintenanceRequestError } from '../src/maintenance/request-session.mjs';
import { createNameResolver } from '../src/adapters/lark-im/name-resolver.mjs';
import { executeEnrichment } from '../src/maintenance/enrich.mjs';

const args = ['contact', '+search-user', '--user-ids', 'ou_synthetic', '--format', 'json'];
const fallback = ['im', 'chat.members', 'get', '--params', '{"chat_id":"oc_synthetic"}'];
const ok = (value = {}) => ({ status: 0, signal: null, stdout: JSON.stringify(value), stderr: '' });
const rateLimited = (code = 99991400, reset = 20, status = 1) => ({ ...ok({ error: { type: 'api', code,
  message: 'SYNTHETIC_PRIVATE_ERROR', detail: { headers: { 'x-ogw-ratelimit-reset': String(reset) } } } }), status });
function fixture(options = {}, overrides = {}) {
  const state = { now: 0, wallOffset: 0, held: false, events: [], requests: [], responses: [] };
  const deps = {
    env: { LARK_CLI: 'synthetic-cli', SYNTHETIC: 'one' }, now: () => 2_000_000_000_000 + state.now + state.wallOffset,
    monotonicClock: () => state.now,
    sleep(ms) { assert.equal(state.held, false); state.events.push(['sleep', ms]); state.now += ms; },
    tryAcquireLease(options) { state.events.push(['acquire', options]); assert.equal(options.role, 'probe'); state.held = true;
      return { state: 'acquired', stdio: ['pipe', 'pipe', 'pipe', 42], release() { state.events.push(['release']); state.held = false; } }; },
    readSharedCooldown(request) { state.events.push(['read', state.held, request]); return { state: 'ready', untilMs: null }; },
    writeSharedCooldown(request) { assert.equal(state.held, true); state.events.push(['publish', request]); return true; },
    spawnSync(command, argv, settings) { assert.equal(state.held, true); state.events.push(['spawn']); state.requests.push({ command, argv, settings }); return state.responses.shift() || ok(); },
    ...overrides,
  };
  const session = createMaintenanceRequestSession({ db: '/synthetic/db', ...options }, deps);
  return { session, state, deps };
}
function stopReason(reason) { return error => error instanceof MaintenanceRequestError && error.reason === reason; }

test('a command counts every actual CLI attempt and uses an unlocked one-second gap', () => {
  const f = fixture();
  f.session.runLark(args, { retries: 5, timeoutMs: 30_000, retryBudgetMs: 60_000 });
  f.session.runLark(fallback, { timeoutMs: 400, retryBudgetMs: 250 });
  assert.equal(f.session.summary().cli_attempts, 2);
  assert.equal(f.session.summary().min_interval_ms, 1000);
  assert.deepEqual(f.state.requests.map(r => r.settings.timeout), [5000, 250]);
  assert.ok(f.state.requests.every(r => r.command === 'synthetic-cli' && r.settings.env.SYNTHETIC === 'one'));
  assert.deepEqual(f.state.requests[0].settings.stdio, ['pipe', 'pipe', 'pipe', 42]);
  const kinds = f.state.events.map(e => e[0]);
  assert.ok(kinds.indexOf('release') < kinds.indexOf('sleep'));
  assert.ok(kinds.indexOf('sleep') < kinds.lastIndexOf('acquire'));
});

test('the completed Nth attempt may commit; the N+1 pagination or fallback attempt latches the budget', () => {
  const f = fixture({ maxCliAttempts: 2 });
  f.session.runLark(args); f.session.runLark(fallback); f.session.assertReady();
  const before = f.state.events.length;
  assert.throws(() => f.session.runLark([...fallback, '--page-token', 'synthetic-next']), stopReason('cli_budget'));
  assert.equal(f.state.events.length, before);
  assert.equal(f.state.requests.length, 2);
  assert.throws(f.session.assertReady, stopReason('cli_budget'));
});

for (const reason of ['busy', 'unavailable']) test(`a ${reason} lease stops immediately without consuming a CLI attempt`, () => {
  const f = fixture({}, { tryAcquireLease: () => ({ state: reason, release() { assert.fail('unowned release'); } }) });
  assert.throws(() => f.session.runLark(args), stopReason(reason === 'busy' ? 'sync_busy' : 'lease_unavailable'));
  assert.equal(f.session.summary().cli_attempts, 0); assert.equal(f.state.requests.length, 0);
  assert.throws(f.session.assertReady, MaintenanceRequestError);
});

for (const state of ['cooldown', 'unavailable']) test(`known shared ${state} prevents lease acquisition and spawning`, () => {
  const f = fixture({}, { readSharedCooldown: () => ({ state, untilMs: 9_000_000_000_000 }) });
  assert.throws(() => f.session.runLark(args), stopReason(state === 'cooldown' ? 'rate_cooldown' : 'shared_cooldown_unavailable'));
  assert.equal(f.state.events.length, 0); assert.equal(f.session.summary().cli_attempts, 0);
});

test('cooldown is checked again after lease acquisition and rejection releases the descriptor', () => {
  let calls = 0;
  const f = fixture({}, { readSharedCooldown: () => ({ state: ++calls === 1 ? 'ready' : 'cooldown', untilMs: 9_000_000_000_000 }) });
  assert.throws(() => f.session.runLark(args), stopReason('rate_cooldown'));
  assert.equal(calls, 2); assert.equal(f.state.held, false); assert.equal(f.state.requests.length, 0);
  assert.deepEqual(f.state.events.map(e => e[0]), ['acquire', 'release']);
});

for (const code of [99991400, 9499]) for (const status of [0, 1]) test(`rate-limit envelope code ${code}, CLI exit ${status}, publishes while held then stops all operations`, () => {
  const f = fixture(); f.state.responses.push(rateLimited(code, 20, status));
  assert.throws(() => f.session.runLark(args), stopReason('rate_limited'));
  const kinds = f.state.events.map(e => e[0]); assert.ok(kinds.indexOf('publish') < kinds.indexOf('release'));
  const before = f.state.events.length;
  assert.throws(() => f.session.runLark(fallback), stopReason('rate_limited'));
  assert.equal(f.state.events.length, before); assert.equal(f.state.requests.length, 1);
  assert.throws(f.session.assertReady, stopReason('rate_limited'));
  assert.doesNotMatch(JSON.stringify(f.session.summary()), /SYNTHETIC_PRIVATE_ERROR|ou_synthetic|oc_synthetic/);
});

test('a zero reset rate limit still latches even when no future cooldown is published', () => {
  const f = fixture(); f.state.responses.push(rateLimited(99991400, 0));
  assert.throws(() => f.session.runLark(args), stopReason('rate_limited'));
  assert.equal(f.state.events.filter(e => e[0] === 'publish').length, 0);
  assert.throws(() => f.session.runLark(fallback), stopReason('rate_limited'));
  assert.throws(f.session.assertReady, stopReason('rate_limited')); assert.equal(f.state.requests.length, 1);
});

test('failed shared rate-limit publication prevents every later request and commit', () => {
  const f = fixture({}, { writeSharedCooldown: () => false }); f.state.responses.push(rateLimited());
  assert.throws(() => f.session.runLark(args), stopReason('shared_cooldown_unavailable'));
  assert.equal(f.state.held, false); assert.throws(f.session.assertReady, stopReason('shared_cooldown_unavailable'));
});

test('ordinary permission failures permit a later fallback; successful content mentioning throttling is not an envelope failure', () => {
  const f = fixture(); f.state.responses.push({ ...ok({ code: 210508, msg: 'synthetic permission' }), status: 0 },
    ok({ code: 0, data: { text: 'kind=rate_limited code=99991400' } }));
  assert.throws(() => f.session.runLark(args), /permission_denied/); f.session.assertReady();
  assert.equal(f.session.runLark(fallback).data.text, 'kind=rate_limited code=99991400');
  assert.equal(f.state.events.filter(e => e[0] === 'publish').length, 0); assert.equal(f.session.summary().cli_attempts, 2);
});

test('request timeout excludes lease-helper time and the command deadline ignores wall-clock corrections', () => {
  const f = fixture({ maxSeconds: 2 }, { tryAcquireLease() { f.state.now += 1600; f.state.held = true;
    return { state: 'acquired', release() { f.state.held = false; } }; } });
  f.state.wallOffset = -1_000_000;
  f.session.runLark(args); assert.equal(f.state.requests[0].settings.timeout, 400);
  f.state.now = 2000; assert.throws(f.session.assertReady, stopReason('time_budget'));
});

test('parser empty record IDs remain absent, and a commit receipt is not replaced by a post-commit timeout', () => {
  let now = 0;
  const result = executeEnrichment({ target: 'records', db: '/synthetic', recordIds: [], maxSeconds: 1 }, {
    requestSessionDeps: { monotonicClock: () => now },
    enrichRecords(_options, { assertReady }) { assertReady(); now = 2000; return { ok: true, updated: 1 }; },
  });
  assert.equal(result.updated, 1); assert.equal(result.request_budget.elapsed_ms, 2000);
  assert.equal(result.request_budget.stop_reason, null);
  assert.equal(executeEnrichment({ target: 'scopes', recordIds: [] }, {
    runLark() { assert.fail('remote'); }, enrichScopes: () => ({ ok: true }),
  }).ok, true);
});

test('a lease acquired after the absolute budget expires is released without spawning', () => {
  let now = 0, released = 0;
  const f = fixture({ maxSeconds: 1 }, { monotonicClock: () => now,
    tryAcquireLease() { now = 1000; return { state: 'acquired', release() { released++; } }; } });
  assert.throws(() => f.session.runLark(args), stopReason('time_budget')); assert.equal(released, 1);
  assert.equal(f.session.summary().cli_attempts, 0);
});

test('the interval cannot spend beyond the deadline, and sleep cannot borrow a lease', () => {
  const f = fixture({ maxSeconds: 1 }); f.session.runLark(args);
  assert.throws(() => f.session.runLark(fallback), stopReason('time_budget'));
  assert.equal(f.state.events.filter(e => e[0] === 'sleep').length, 0); assert.equal(f.state.requests.length, 1);
});

test('a waiting sync can acquire during the unlocked gap and the next maintenance request cannot spawn', () => {
  let syncOwns = false;
  const f = fixture({}, { sleep(ms) { assert.equal(f.state.held, false); f.state.now += ms; syncOwns = true; },
    tryAcquireLease() { if (syncOwns) return { state: 'busy' }; f.state.held = true; return { state: 'acquired', release() { f.state.held = false; } }; } });
  f.session.runLark(args);
  assert.throws(() => f.session.runLark(fallback), stopReason('sync_busy'));
  assert.equal(f.state.requests.length, 1); assert.equal(f.state.now, 1000);
});

test('resolver best-effort catches cannot erase a stop condition before commit', () => {
  const f = fixture({ maxCliAttempts: 1 });
  const resolver = createNameResolver({ run: f.session.runLark });
  resolver.resolveContactNames(Array.from({ length: 31 }, (_, i) => `ou_synthetic_${i}`), {});
  assert.equal(f.state.requests.length, 1);
  let committed = false;
  assert.throws(() => { f.session.assertReady(); committed = true; }, stopReason('cli_budget'));
  assert.equal(committed, false);
});

test('invalid budgets and names-only selections fail before any domain or remote call', () => {
  for (const options of [{ maxCliAttempts: 0 }, { maxCliAttempts: 1001 }, { maxSeconds: 0 }, { maxSeconds: 181 }]) {
    assert.throws(() => createMaintenanceRequestSession(options), RangeError);
  }
  const deps = { runLark() { assert.fail('remote'); }, enrichRecords() { assert.fail('domain'); } };
  for (const options of [{ namesOnly: true }, { recordIds: [1] }, { namesOnly: true, recordIds: [] },
    { namesOnly: true, recordIds: [1, 1] }, { namesOnly: true, recordIds: ['1'] },
    { namesOnly: true, recordIds: [1], limit: 1 }, { namesOnly: true, recordIds: [1], probeApps: true },
    { namesOnly: true, recordIds: [1], senderOnly: true, senderId: 'ou_synthetic' }]) {
    assert.throws(() => executeEnrichment({ target: 'records', ...options }, deps));
  }
});
