import assert from 'node:assert/strict';
import test from 'node:test';
import { digest, evaluateSample, SAMPLE_POLICY } from '../src/diagnostics/remote-sample-core.mjs';

// Every identity, timestamp and body in this fixture is invented from scratch.
const NOW = Date.parse('2037-02-03T12:00:00Z');
const CREATED = NOW - 3_600_000;
const NEWER = CREATED + 1000;
const binding = { database_key: 'a'.repeat(64), account_key: 'b'.repeat(64) };
const base = { message_id: 'synthetic_parallel_debt_message', chat_id: 'synthetic_parallel_debt_chat',
  msg_type: 'interactive', create_time: String(CREATED), update_time: String(CREATED),
  deleted: false, body: { content: '{"card":"Invented alpha"}' } };
const key = digest([binding.database_key, binding.account_key, base.chat_id, base.message_id, CREATED]);
const local = message => ({ external_id: message.message_id, container_id: message.chat_id,
  source_id: 'lark.im', record_type: 'lark.im.message', external_version: message.update_time,
  raw_json: JSON.stringify(message), canonical_json: '{"source_api":"im.v1.messages"}' });
const evaluate = (remote, record, previous = {}, at = NOW) => evaluateSample({
  messages: [remote], records: new Map([[base.message_id, local(record)]]), coverage: {}, binding,
  previous, now: at, windowEnd: at - SAMPLE_POLICY.stableBufferMs,
});

test('a newer remote version retains the simultaneous explicit deletion contradiction after deletion evidence disappears', () => {
  const initialRemote = { ...base, update_time: String(NEWER), deleted: true };
  const first = evaluate(initialRemote, base);
  assert.equal(first.counts.stale_version, 1);
  assert.equal(first.counts.content_mismatch, 0, 'public categories remain mutually exclusive');
  const { deleted, ...partialRemote } = initialRemote;
  const second = evaluate(partialRemote, { ...base, update_time: String(NEWER) }, first.observations,
    NOW + SAMPLE_POLICY.intervalMs);
  assert.deepEqual(second.observations[key]?.debts, { deleted: NEWER },
    'equal versions cannot retire the earlier explicit deletion contradiction without deletion proof');
  assert.equal(second.counts.unresolved_prior, 1);
  const third = evaluate(initialRemote, initialRemote, second.observations, NOW + 2 * SAMPLE_POLICY.intervalMs);
  assert.deepEqual(third.observations, {}, 'same-version explicit agreement supplies the missing proof');
});

test('a newer remote static body contradiction survives a later unreadable body with equal versions', () => {
  const initialLocal = { ...base, msg_type: 'text', body: { content: '{"text":"Invented alpha"}' } };
  const initialRemote = { ...initialLocal, update_time: String(NEWER), body: { content: '{"text":"Invented beta"}' } };
  const first = evaluate(initialRemote, initialLocal);
  const second = evaluate({ ...initialRemote, body: { content: 'invented invalid JSON' } },
    { ...initialLocal, update_time: String(NEWER) }, first.observations, NOW + SAMPLE_POLICY.intervalMs);
  assert.deepEqual(second.observations[key]?.debts, { body: NEWER },
    'equal versions cannot retire the earlier comparable body contradiction without body proof');
  assert.equal(second.counts.unresolved_prior, 1);
  const third = evaluate(initialRemote, initialRemote, second.observations, NOW + 2 * SAMPLE_POLICY.intervalMs);
  assert.deepEqual(third.observations, {}, 'same-version static body equality supplies the missing proof');
  assert.equal(third.counts.content_equal, 1);
});

test('simultaneous version, type and explicit deletion discrepancies all retain their own version floors', () => {
  const first = evaluate({ ...base, update_time: String(NEWER), msg_type: 'text', deleted: true }, base);
  assert.deepEqual(first.observations[key]?.debts, { version: NEWER, type: NEWER, deleted: NEWER });
  assert.equal(first.counts.stale_version, 1);
  assert.equal(first.counts.content_mismatch, 0);
  assert.equal(first.counts.unresolved_prior, 0);
  const equal = { ...base, update_time: String(NEWER), msg_type: 'text', deleted: true };
  const second = evaluate(equal, equal, first.observations, NOW + SAMPLE_POLICY.intervalMs);
  assert.deepEqual(second.observations, {}, 'equal version, type and explicit deletion retire all three dimensions');
});

test('matching old-local deletion cannot borrow the newer remote version to settle a retained deletion floor', () => {
  const previous = { [key]: { kind: 'version', target: CREATED, first_seen: NOW - 1000,
    last_seen: NOW - 1000, run_finished: 0, debts: { version: NEWER, deleted: NEWER } } };
  const ahead = { ...base, update_time: String(NEWER + 1000) };
  const first = evaluate(ahead, base, previous);
  assert.deepEqual(first.observations[key]?.debts, { version: NEWER + 1000, deleted: NEWER },
    'equal deletion values at different versions do not prove the old contradiction was repaired');
  const { deleted, ...partial } = ahead;
  const second = evaluate(partial, ahead, first.observations, NOW + SAMPLE_POLICY.intervalMs);
  assert.deepEqual(second.observations[key]?.debts, { deleted: NEWER });
  const third = evaluate(ahead, ahead, second.observations, NOW + 2 * SAMPLE_POLICY.intervalMs);
  assert.deepEqual(third.observations, {});
});

test('equal static fields at different versions do not clear type, body or legacy content debt', () => {
  const previous = { [key]: { kind: 'version', target: CREATED, first_seen: NOW - 1000,
    last_seen: NOW - 1000, run_finished: 0,
    debts: { version: NEWER, type: NEWER, body: NEWER, deleted: NEWER, legacy_content: 0 } } };
  const stored = { ...base, msg_type: 'text', body: { content: '{"text":"Invented alpha"}' } };
  const ahead = { ...stored, update_time: String(NEWER + 1000) };
  const first = evaluate(ahead, stored, previous);
  assert.deepEqual(first.observations[key]?.debts,
    { version: NEWER + 1000, type: NEWER, body: NEWER, deleted: NEWER, legacy_content: 0 });
  assert.equal(first.counts.content_unverified, 1);
  assert.equal(first.counts.stale_version, 1);
  const second = evaluate(ahead, ahead, first.observations, NOW + SAMPLE_POLICY.intervalMs);
  assert.deepEqual(second.observations, {});
});

test('different dynamic card payloads at a newer version do not manufacture body debt', () => {
  const newer = { ...base, update_time: String(NEWER), body: { content: '{"card":"Invented beta"}' } };
  const first = evaluate(newer, base);
  assert.deepEqual(first.observations[key]?.debts, { version: NEWER });
  assert.equal(first.counts.content_unverified, 1);
  const second = evaluate(newer, { ...base, update_time: String(NEWER) }, first.observations,
    NOW + SAMPLE_POLICY.intervalMs);
  assert.deepEqual(second.observations, {});
  assert.equal(second.counts.content_unverified, 1);
});
