import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonical } from '../src/diagnostics/remote-sample-core.mjs';
import { resolveRemoteSampleDue, VERIFICATION_WAKE_GAP_MS } from '../src/runtime/worker/remote-sample-wake.mjs';

const START = Date.parse('2031-02-03T12:00:00Z');
const DATABASE = 'a'.repeat(64), ACCOUNT = 'b'.repeat(64);
const key = index => index.toString(16).padStart(64, '0');
const opts = { db: '/synthetic/never-opened.sqlite' };
function fixture() {
  const observations = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [key(index), {
    kind: 'version', first_seen: START - 10000, last_seen: START - 10000, run_finished: 0,
    target: START - 3 * 86400000, last_checked: START - 10000, debts: { version: START - 100000 },
  }]));
  return { kind: 'lark_im_remote_sample_schedule/v1', database_key: DATABASE, account_key: ACCOUNT,
    written_at: START, next_due: START + 900000, failures: 0, rotation: 0, observations,
    observation_overflow: false, last_outcome: 'ok', cooldowns: {}, blocked_reason: null };
}
const deps = (pending = [key(0)]) => ({ databaseKey: () => DATABASE, pendingVerifications: () => pending });
const unchanged = state => ({ next_due: state.next_due, wake: null });

test('one or many valid tickets use the same fixed 60-second floor without count or tail tuning', () => {
  assert.equal(VERIFICATION_WAKE_GAP_MS, 60000);
  const state = fixture(), before = JSON.stringify(state);
  for (const count of [1, 2, 5, 8]) {
    const result = resolveRemoteSampleDue(opts, state, START + 60000, {}, deps(Array.from({ length: count }, (_, index) => key(index))));
    assert.deepEqual(result, { next_due: START + 60000, wake: {
      state_hash: createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex'), not_before: START + 60000,
    } });
    assert.deepEqual(Object.keys(result).sort(), ['next_due', 'wake']);
  }
  assert.equal(JSON.stringify(state), before, 'wake resolution never mutates observations or schedule state');
});

test('before 60 seconds, absent state and ordinary due require no database or ticket query', () => {
  const state = fixture(), forbidden = { databaseKey: () => assert.fail('no database read'), pendingVerifications: () => assert.fail('no query') };
  assert.deepEqual(resolveRemoteSampleDue(opts, state, START + 59999, {}, forbidden), unchanged(state));
  assert.deepEqual(resolveRemoteSampleDue(opts, state, state.next_due, {}, forbidden), unchanged(state));
  assert.deepEqual(resolveRemoteSampleDue(opts, null, START, {}, forbidden), { next_due: START, wake: null });
});

test('unhealthy, unbound, malformed and noncanonical future states retain original due', () => {
  for (const patch of [{ last_outcome: 'failed' }, { last_outcome: 'busy' }, { last_outcome: 'attempting' },
    { failures: 1 }, { failures: false }, { account_key: null }, { blocked_reason: 'cooldown_invalid' },
    { kind: 'other' }, { database_key: 'bad' }, { rotation: false }, { rotation: 0.5 },
    { rotation: Number.MAX_SAFE_INTEGER + 1 }, { observation_overflow: 0 }, { observations: [] },
    { observations: {} }, { extra: 1 }, { written_at: START + 60001 }, { cooldowns: [] }]) {
    const state = { ...fixture(), ...patch };
    assert.deepEqual(resolveRemoteSampleDue(opts, state, START + 60000, {}, {
      databaseKey: () => assert.fail('unsafe state read'), pendingVerifications: () => assert.fail('unsafe state queried'),
    }), unchanged(state));
  }
  const state = fixture(); state.observations[key(0)].unexpected = '非ASCII';
  assert.deepEqual(resolveRemoteSampleDue(opts, state, START + 60000, {}, deps()), unchanged(state));
});

test('saved and inherited cooldowns independently block wake and never alter saved due', () => {
  const now = START + 120000;
  for (const operation of ['self_profile', 'message_history_bundle', 'other']) {
    const state = fixture(), cooling = { [operation]: now + 1 };
    assert.deepEqual(resolveRemoteSampleDue(opts, state, now, cooling, deps()), unchanged(state));
    const saved = { ...state, cooldowns: cooling };
    assert.deepEqual(resolveRemoteSampleDue(opts, saved, now, {}, deps()), unchanged(saved));
    const ready = resolveRemoteSampleDue(opts, state, now, { [operation]: now }, deps());
    assert.equal(ready.wake.not_before, now);
  }
  for (const cooldowns of [null, [], { other: false }, { other: NaN }, { other: '0' }]) {
    const state = fixture();
    assert.deepEqual(resolveRemoteSampleDue(opts, state, now, cooldowns, deps()), unchanged(state));
  }
});

test('missing, duplicate, oversized, malformed and ineligible ticket results cannot wake', () => {
  const state = fixture();
  for (const pending of [null, {}, [], [key(0), key(0)], Array.from({ length: 201 }, (_, index) => key(index)),
    ['bad'], [false], [{ key: key(0) }], [key(100)]]) {
    assert.deepEqual(resolveRemoteSampleDue(opts, state, START + 60000, {}, deps(pending)), unchanged(state));
  }
  const unstable = { ...state, observations: { [key(0)]: { ...state.observations[key(0)], target: START - 300000 } } };
  assert.deepEqual(resolveRemoteSampleDue(opts, unstable, START + 60000, {}, deps()), unchanged(unstable));
  assert.deepEqual(resolveRemoteSampleDue(opts, state, START + 60000, {}, { ...deps(), pendingVerifications() { throw new Error('synthetic'); } }), unchanged(state));
});

test('a validated recent ticket wakes within the existing gap only after its complete route is stable', () => {
  const state = fixture(); state.observations[key(0)].target = START - 3600000;
  assert.equal(resolveRemoteSampleDue(opts, state, START + 60000, {}, deps()).next_due, START + 60000);
  const end = START + 60000 - 600000;
  state.observations[key(0)].target = end - 2000;
  assert.ok(resolveRemoteSampleDue(opts, state, START + 60000, {}, deps()).wake);
  state.observations[key(0)].target += 1000;
  assert.deepEqual(resolveRemoteSampleDue(opts, state, START + 60000, {}, deps()), unchanged(state));
});

test('database identity is checked both before and after the ticket read', () => {
  const state = fixture(); let reads = 0;
  assert.deepEqual(resolveRemoteSampleDue(opts, state, START + 60000, {}, {
    ...deps(), databaseKey: () => ++reads === 1 ? DATABASE : 'c'.repeat(64),
  }), unchanged(state));
  assert.equal(reads, 2);
  assert.deepEqual(resolveRemoteSampleDue(opts, state, START + 60000, {}, {
    ...deps(), databaseKey: () => null, pendingVerifications: () => assert.fail('replaced database queried'),
  }), unchanged(state));
});

test('full canonical state hash is stable across key order and integer JSON spellings', () => {
  const state = fixture();
  const reverse = value => value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([field, item]) => [field, reverse(item)])) : value;
  const equivalent = JSON.parse(JSON.stringify(reverse(state)).replace('"rotation":0', '"rotation":-0.0')
    .replace(`"written_at":${START}`, `"written_at":${START}e0`));
  assert.deepEqual(resolveRemoteSampleDue(opts, equivalent, START + 60000, {}, deps()),
    resolveRemoteSampleDue(opts, state, START + 60000, {}, deps()));
  const changed = fixture(); changed.observations[key(1)].debts.version++;
  assert.notEqual(resolveRemoteSampleDue(opts, changed, START + 60000, {}, deps()).wake.state_hash,
    resolveRemoteSampleDue(opts, state, START + 60000, {}, deps()).wake.state_hash);
});
