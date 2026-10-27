import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateObservation } from '../dist/storage/sqlite/observation-store.js';
import { OBSERVATION_POLICY } from '../dist/core/lark-observation.js';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';

// Entirely authored synthetic source evidence; no database, clock or transport.
const raw = (text = 'Synthetic A') => ({ message_id: 'om_synthetic_evaluator', chat_id: 'oc_synthetic_evaluator',
  msg_type: 'text', create_time: '1800000000000', update_time: '1800000001000',
  sender: { id: 'ou_synthetic_evaluator', id_type: 'open_id', sender_type: 'user' },
  body: { content: JSON.stringify({ text }) } });
const row = value => recordFromMessage(normalizeApiMessage(value), 'synthetic.scope', 'received');
const before = row(raw()), incoming = row(raw('Synthetic B'));
const acquisition = (changes = {}) => ({ attempt: 'synthetic-second', startedAtMs: 102, confirm: true,
  contextKey: 'synthetic-context', ...changes });
const state = (candidate = incoming, changes = {}) => ({ generation: 3, evidenceGeneration: 7,
  candidate_json: JSON.stringify(candidate), candidate_generation: 3, candidate_attempt: 'synthetic-first',
  candidate_policy: OBSERVATION_POLICY, candidate_context: 'synthetic-context', candidate_observed_at_ms: 100, ...changes });
const evaluate = (changes = {}) => evaluateObservation(changes.before ?? before, changes.incoming ?? incoming,
  changes.state === undefined ? state() : changes.state, acquisition(changes.acquisition));

test('a new source observation has no invented predecessor or candidate', () => {
  const result = evaluateObservation(null, incoming, null, acquisition());
  assert.equal(result.action, 'accept');
  assert.equal(result.reason, 'new_observation');
  assert.equal(result.preserveCandidate, false);
  assert.deepEqual(result.record, incoming);
});

test('the first same-version difference remains conflict without qualified stored evidence', () => {
  for (const value of [null, state(incoming, { candidate_json: null }), state(incoming, { candidate_context: null })]) {
    const result = evaluate({ state: value });
    assert.equal(result.action, 'conflict');
    assert.equal(result.reason, 'same_version_source_difference');
  }
});

test('a later independently acquired equivalent candidate confirms without changing caller evidence', () => {
  const saved = state(), original = structuredClone(saved), next = acquisition();
  const result = evaluateObservation(Object.freeze(before), Object.freeze(incoming), Object.freeze(saved), Object.freeze(next));
  assert.equal(result.action, 'accept');
  assert.equal(result.reason, 'repeated_observation_not_latest_proof');
  assert.equal(result.preserveCandidate, false);
  assert.deepEqual(saved, original);
});

test('candidate time must strictly precede the next acquisition start', () => {
  for (const startedAtMs of [99, 100, NaN, Infinity, 101.5]) {
    assert.equal(evaluate({ acquisition: { startedAtMs } }).action, 'conflict', String(startedAtMs));
  }
  assert.equal(evaluate({ acquisition: { startedAtMs: 101 } }).action, 'accept');
});

test('replaying the same acquisition cannot confirm or refresh its original candidate qualification', () => {
  const saved = state(), original = structuredClone(saved);
  for (const startedAtMs of [99, 100, 1000]) {
    const result = evaluateObservation(before, incoming, saved,
      acquisition({ attempt: saved.candidate_attempt, startedAtMs }));
    assert.equal(result.action, 'conflict');
    assert.equal(result.preserveCandidate, true);
    assert.deepEqual(saved, original);
  }
  // A genuine later attempt is still measured against the original observation,
  // not the later wall time at which the same request was replayed.
  assert.equal(evaluateObservation(before, incoming, saved, acquisition({ startedAtMs: 101 })).action, 'accept');
});

test('an acquisition identity cannot be reused for different source evidence or context', () => {
  const saved = state(), original = structuredClone(saved);
  for (const [record, changes] of [
    [row(raw('Synthetic C')), {}],
    [incoming, { contextKey: 'synthetic-other-context' }],
    [incoming, { contextKey: undefined }],
  ]) {
    assert.throws(() => evaluateObservation(before, record, saved,
      acquisition({ attempt: saved.candidate_attempt, ...changes })), /acquisition identity reused/);
    assert.deepEqual(saved, original);
  }
});

test('ordinary equivalent retries retain qualification without becoming confirming acquisitions', () => {
  const result = evaluate({ acquisition: { confirm: false, contextKey: 'synthetic-new-context' } });
  assert.equal(result.action, 'conflict');
  assert.equal(result.preserveCandidate, true);
  assert.equal(evaluate({ acquisition: { confirm: true, contextKey: 'synthetic-new-context' } }).action, 'conflict');
  assert.equal(evaluate({ incoming: row(raw('Synthetic C')), acquisition: { confirm: false } }).preserveCandidate, false);
});

test('generation, policy, context, valid attempt and valid observation time all qualify confirmation', () => {
  for (const changes of [
    { candidate_generation: 2 }, { candidate_policy: 'synthetic-old-policy' }, { candidate_context: 'synthetic-other' },
    { candidate_attempt: null }, { candidate_attempt: '' }, { candidate_observed_at_ms: null },
    { candidate_observed_at_ms: -1 }, { candidate_observed_at_ms: 99.5 },
  ]) assert.equal(evaluate({ state: state(incoming, changes) }).action, 'conflict', JSON.stringify(changes));
  assert.equal(evaluate({ acquisition: { attempt: '' } }).action, 'conflict');
  assert.equal(evaluate({ acquisition: { basis: new Map([[incoming.external_id, 2]]) } }).action, 'stale');
  assert.equal(evaluate({ acquisition: { basis: new Map([[incoming.external_id, 3]]) } }).action, 'accept');
});

test('identity, regressed and unordered versions cannot borrow an otherwise matching candidate', () => {
  const cases = [
    [{ ...incoming, container_id: 'oc_synthetic_other' }, 'conflict', 'identity_conflict'],
    [{ ...incoming, external_version: '1800000000001' }, 'older', 'source_timestamp_regressed'],
    [{ ...incoming, external_version: 'synthetic-unordered' }, 'conflict', 'source_version_unordered'],
  ];
  for (const [record, action, reason] of cases) {
    const result = evaluate({ incoming: record, state: state(record) });
    assert.equal(result.action, action); assert.equal(result.reason, reason);
  }
  assert.equal(evaluate({ state: state({ ...incoming, external_version: '1800000002000' }) }).action, 'conflict',
    'same raw bytes with a different candidate version are not a qualified equal-version confirmation');
});

test('representation and newer-source decisions preserve the established record behavior', () => {
  const reordered = row(Object.fromEntries(Object.entries(raw()).reverse()));
  const equivalent = evaluate({ incoming: reordered });
  assert.equal(equivalent.action, 'equivalent');
  assert.equal(equivalent.record.raw_json, before.raw_json);
  assert.equal(equivalent.record.content_hash, before.content_hash);
  const newer = evaluate({ incoming: row({ ...raw('Synthetic C'), update_time: '1800000002000' }) });
  assert.equal(newer.action, 'accept'); assert.equal(newer.reason, 'newer_observed_timestamp');
});

test('retained raw keeps only its own acquisition member without altering unknown JSON tokens', () => {
  const equivalent = row(Object.fromEntries(Object.entries(raw()).reverse()));
  const incomingProof = '{"source_hash":"incoming-raw-hash","acquired_at":"new-source-clock"}';
  const candidate = { ...equivalent, canonical_json: equivalent.canonical_json.slice(0, -1)
    + `,"message_account_evidence":${incomingProof},"new_unknown":9007199254740995}` };
  for (const oldProof of [undefined, 'null', '"invalid legacy proof"',
    '{ "source_hash" : "old-raw-hash", "unknown" : 9007199254740993, "clock":"\\u0041" }']) {
    const retainedMember = oldProof === undefined ? '' : `,"message_account_\\u0065vidence" : ${oldProof}`;
    const predecessor = { ...before, canonical_json: before.canonical_json.slice(0, -1)
      + `${retainedMember},"old_unknown":9007199254740997,"old_escape":"\\u0042"}` };
    const frozenBefore = Object.freeze(predecessor), frozenNext = Object.freeze(candidate);
    const result = evaluateObservation(frozenBefore, frozenNext, state(), acquisition());
    assert.equal(result.action, 'equivalent');
    assert.equal(result.record.raw_json, predecessor.raw_json);
    assert.equal(result.record.content_hash, predecessor.content_hash);
    const canonical = result.record.canonical_json, parsed = JSON.parse(canonical);
    assert.equal(Object.hasOwn(parsed, 'message_account_evidence'), oldProof !== undefined);
    if (oldProof !== undefined) assert.ok(canonical.includes(`"message_account_\\u0065vidence" : ${oldProof}`));
    assert.doesNotMatch(canonical, /incoming-raw-hash|new-source-clock/);
    for (const token of ['"new_unknown":9007199254740995', '"old_unknown":9007199254740997', '"old_escape":"\\u0042"']) {
      assert.ok(canonical.includes(token), token);
    }
    assert.equal(frozenBefore.canonical_json, predecessor.canonical_json);
    assert.equal(frozenNext.canonical_json, candidate.canonical_json);
  }
});

test('an exact source response can still add new evidence and an accepted source change keeps its fresh proof', () => {
  const proof = { source_hash: 'authored-exact-source-hash', acquired_at: 'authored-acquisition-clock' };
  const attach = record => ({ ...record, canonical_json: record.canonical_json.slice(0, -1)
    + `,"message_account_evidence":${JSON.stringify(proof)}}` });
  const exact = attach(before);
  const refreshed = evaluate({ incoming: exact });
  assert.equal(refreshed.action, 'equivalent');
  assert.deepEqual(JSON.parse(refreshed.record.canonical_json).message_account_evidence, proof);
  assert.equal(refreshed.record.raw_json, before.raw_json);
  const newer = attach(row({ ...raw('Synthetic accepted new source'), update_time: '1800000002000' }));
  const accepted = evaluate({ incoming: newer });
  assert.equal(accepted.action, 'accept');
  assert.equal(accepted.record.raw_json, newer.raw_json);
  assert.equal(accepted.record.canonical_json, newer.canonical_json);
});

test('a descriptor predecessor still requires equality of the complete candidate subtree', () => {
  const root = { ...raw(), msg_type: 'merge_forward', body: { content: '{"snapshot":1}' } };
  const changed = { ...root, body: { content: '{"snapshot":2}' } };
  const complete = text => recordFromMessage(normalizeApiMessage(changed, { mergeItems: [changed,
    { ...raw(text), message_id: 'om_synthetic_evaluator_child', upper_message_id: changed.message_id }] }),
  'synthetic.scope', 'received');
  const descriptor = row(root), first = complete('Synthetic child B'), another = complete('Synthetic child C');
  assert.equal(evaluateObservation(descriptor, first, state(first), acquisition()).action, 'accept');
  assert.equal(evaluateObservation(descriptor, another, state(first), acquisition()).action, 'conflict');
  assert.throws(() => evaluateObservation(descriptor, another, state(first),
    acquisition({ attempt: 'synthetic-first' })), /acquisition identity reused/);
});
