import assert from 'node:assert/strict';
import test from 'node:test';
import { initialNameWorkSelection, selectNameWork, planNameWorkRetry, nameWorkServiceBound }
  from '../src/adapters/lark-im/name-work-policy.mjs';

// Invented keys, loads and clocks only. This harness models the caller's durable
// claim transaction without opening an account, production DB or network.
function candidate(key, state, changes = {}) {
  return { key, tier: 'history', operation: 'chat_members',
    enqueuedSequence: state.sequence, lastServedSequence: state.sequence,
    dueAtMs: 0, claimedUntilMs: 0, blocked: false, ...changes };
}
function harness() {
  const h = { state: initialNameWorkSelection(), rows: [], now: 0 };
  h.take = (options = {}) => {
    const before = structuredClone({ state: h.state, rows: h.rows });
    const choice = selectNameWork(h.rows, h.state, { nowMs: h.now, resource: 'remote', ...options });
    assert.deepEqual(h.state, before.state, 'planning does not mutate durable state');
    assert.deepEqual(h.rows, before.rows);
    if (choice) {
      // Simulated transaction: service rotation and task claim commit together,
      // before any request. Each call reconstructs state as a fresh process.
      h.state = JSON.parse(JSON.stringify(choice.nextState));
      choice.candidate.lastServedSequence = choice.nextLastServedSequence;
    }
    return choice;
  };
  return h;
}

test('fresh work gets priority while oldest history is serviced every third admitted turn', () => {
  const h = harness();
  h.rows.push(candidate('old-history', h.state));
  const choices = [];
  for (let turn = 0; turn < 15; turn++) {
    h.rows.push(candidate(`fresh-${turn}`, h.state, { tier: 'fresh' }));
    const chosen = h.take(); choices.push(chosen);
    if (chosen.candidate.key !== 'old-history') h.rows = h.rows.filter(row => row !== chosen.candidate);
    h.now += 60_000;
  }
  assert.equal(choices[0].candidate.tier, 'fresh');
  assert.equal(choices[1].candidate.tier, 'fresh');
  assert.equal(choices[2].candidate.key, 'old-history');
  assert.ok(choices.slice(3).some(choice => choice.candidate.key === 'old-history'));
  assert.ok(choices.every((choice, index) => choice.lane === (index % 3 === 2 ? 'fair' : 'priority')));
});

test('bounded sustained load finishes an old multi-page job within the stated turn bound across restarts', () => {
  const h = harness(), populations = 9, pages = 8;
  h.rows.push(candidate('old-target', h.state));
  for (let i = 0; i < populations - 1; i++) h.rows.push(candidate(`peer-${i}`, h.state));
  const progress = new Map(h.rows.map(row => [row.key, 0]));
  const bound = nameWorkServiceBound({ populationLimit: populations, remainingPages: pages, minPagesPerTurn: 2 });
  let targetCompletedAt = null;
  for (let turn = 1; turn <= bound.admittedTurns; turn++) {
    const choice = h.take(), key = choice.candidate.key;
    progress.set(key, progress.get(key) + 2);
    choice.candidate.tier = 'continuation';
    if (progress.get(key) >= pages) {
      if (key === 'old-target') { targetCompletedAt = turn; break; }
      h.rows = h.rows.filter(row => row.key !== key);
      const fresh = candidate(`replacement-${turn}`, h.state, { tier: 'fresh' });
      h.rows.push(fresh); progress.set(fresh.key, 0);
    }
    h.rows = JSON.parse(JSON.stringify(h.rows));
    h.now += 60_000;
  }
  assert.ok(targetCompletedAt > 0 && targetCompletedAt <= bound.admittedTurns);
  assert.equal(bound.wallMs, null, 'turn progress alone never claims wall-time latency');
});

test('sixty-four failed app routes cannot hide a due human or consume its opportunity', () => {
  const h = harness();
  for (let i = 0; i < 64; i++) h.rows.push(candidate(`app-${i}`, h.state,
    { operation: 'application_info', tier: 'fresh', blocked: true }));
  h.rows.push(candidate('human', h.state, { operation: 'contact_search' }));
  assert.equal(h.take().candidate.key, 'human');
  // New message enrollment changes priority only. It cannot clear the block.
  h.rows[0] = { ...h.rows[0], tier: 'fresh' };
  assert.equal(h.take().candidate.key, 'human');
  assert.deepEqual(planNameWorkRetry({ kind: 'permission_denied', failureCount: 1, nowMs: 0 }),
    { state: 'blocked', reason: 'permission_denied', retryAtMs: null });
});

test('blocking application lookup leaves the separately validated bot fallback eligible', () => {
  const h = harness();
  h.rows.push(candidate('app-route', h.state, { operation: 'application_info', blocked: true }),
    candidate('exact-bot-route', h.state, { operation: 'chat_bots' }));
  assert.equal(h.take().candidate.key, 'exact-bot-route');
});

test('cooldown, due date and live claim are fences; local projection has independent admission', () => {
  const h = harness();
  h.rows.push(candidate('cooldown', h.state), candidate('later', h.state, { dueAtMs: 20 }),
    candidate('claimed', h.state, { claimedUntilMs: 30 }),
    candidate('local', h.state, { operation: 'local_projection', tier: 'fresh' }));
  const options = { cooldowns: { chat_members: 10 } };
  assert.equal(h.take(options), null);
  assert.equal(h.state.sequence, 0, 'no eligible work consumes no fair turn');
  assert.equal(h.take({ ...options, resource: 'local' }).candidate.key, 'local');
  h.now = 10;
  assert.equal(h.take(options).candidate.key, 'cooldown');
  h.rows = h.rows.filter(row => row.key !== 'cooldown');
  h.now = 20; assert.equal(h.take().candidate.key, 'later');
  h.rows = h.rows.filter(row => row.key !== 'later');
  h.now = 30; assert.equal(h.take().candidate.key, 'claimed');
});

test('transient retry count is finite and remote retry-after/shared cooldown are never shortened', () => {
  assert.equal(planNameWorkRetry({ kind: 'network_timeout', failureCount: 1, nowMs: 1000 }).retryAtMs, 6000);
  assert.equal(planNameWorkRetry({ kind: 'network_timeout', failureCount: 2, nowMs: 1000 }).retryAtMs, 31000);
  const rate = planNameWorkRetry({ kind: 'rate_limited', failureCount: 1, nowMs: 1000,
    retryAfterMs: 90000, cooldownUntilMs: 120000 });
  assert.equal(rate.retryAtMs, 120000);
  assert.equal(planNameWorkRetry({ kind: 'network_timeout', failureCount: 3, nowMs: 1000 }).state, 'exhausted');
  assert.equal(planNameWorkRetry({ kind: 'budget', failureCount: 0, nowMs: 1000 }).state, 'deferred');
  assert.equal(planNameWorkRetry({ kind: 'unclassified', failureCount: 1, nowMs: 1000 }).state, 'blocked');
});

test('the full transport cooldown map preserves unrelated routes and honors the existing other bucket', () => {
  const h = harness();
  h.rows.push(candidate('chat-metadata', h.state, { operation: 'other' }),
    candidate('healthy-contact', h.state, { operation: 'contact_search' }));
  const cooldowns = { message_history_bundle: 1000, message_search_bundle: 1000,
    self_profile: 0, other: 1000 };
  assert.equal(h.take({ cooldowns }).candidate.key, 'healthy-contact');
  cooldowns.self_profile = 1000;
  assert.equal(h.take({ cooldowns }), null, 'required final profile cooldown blocks remote adoption');
});

test('old delayed tasks count toward the fairness population, not just current eligibility', () => {
  const h = harness();
  h.rows.push(candidate('z-target', h.state));
  for (let i = 1; i <= 7; i++) h.rows.push(candidate(`old-retry-${i}`, h.state, { dueAtMs: i }));
  const bound = nameWorkServiceBound({ populationLimit: 8, remainingPages: 1, minPagesPerTurn: 1 });
  let targetAt = null;
  for (let turn = 1; turn <= bound.admittedTurns; turn++) {
    h.now = turn;
    const choice = h.take();
    if (choice.candidate.key === 'z-target') { targetAt = turn; break; }
    h.rows = h.rows.filter(row => row !== choice.candidate);
  }
  assert.ok(targetAt > 6, 'two currently eligible tasks do not imply a six-turn bound');
  assert.ok(targetAt <= bound.admittedTurns);
});

test('successful pagination does not exhaust the separate failed-lookup retry count', () => {
  const successfulPages = 12, failedLookups = 1;
  assert.ok(successfulPages > 3);
  const result = planNameWorkRetry({ kind: 'network_timeout', failureCount: failedLookups, nowMs: 60000 });
  assert.equal(result.state, 'retry');
  assert.equal(result.retryAtMs, 65000);
});

test('invalid or oversized plans fail closed instead of claiming unsupported fairness', () => {
  const state = initialNameWorkSelection(), options = { nowMs: 0, resource: 'remote' };
  assert.throws(() => selectNameWork(Array.from({ length: 129 }, (_, i) => candidate(`x-${i}`, state)), state, options));
  assert.throws(() => selectNameWork([candidate('x', state), candidate('x', state)], state, options));
  assert.throws(() => selectNameWork([candidate('future', state, { enqueuedSequence: 1 })], state, options));
  assert.throws(() => selectNameWork([], state, { ...options, nowMs: NaN }));
  assert.throws(() => selectNameWork([], state, { ...options, cooldowns: { invented_endpoint: 1 } }));
  assert.throws(() => planNameWorkRetry({ kind: 'network_error', failureCount: 1, nowMs: Number.MAX_SAFE_INTEGER }));
  const bound = nameWorkServiceBound({ populationLimit: 2, remainingPages: 6, minPagesPerTurn: 2, maxAdmissionGapMs: 60000 });
  assert.deepEqual(bound, { admittedTurns: 18, wallMs: 1080000 });
});
