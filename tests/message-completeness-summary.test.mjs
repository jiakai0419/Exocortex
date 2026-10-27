import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { evaluateMessageCompleteness } from '../src/adapters/lark-im/message-completeness.mjs';
import { summarizeMessageCompleteness, selectMessageReadinessObservations,
  MESSAGE_COMPLETENESS_SUMMARY_LIMIT } from '../src/diagnostics/message-completeness-summary.mjs';

// Real evaluator results over authored data; the summary does not reimplement
// sender/content quality. Tests never open a database or an external API.
const AT = Date.UTC(2050, 0, 1), READ = AT + 120_000;
function message(state = 'ready', sourceTime = AT, change = () => {}) {
  const row = { source_id: 'lark.im', record_type: 'lark.im.message', external_id: 'om_authored_summary',
    container_id: 'oc_authored_summary', actor_id: 'ou_authored_summary', direction: 'received', occurred_at_ms: sourceTime };
  const raw = { message_id: row.external_id, chat_id: row.container_id, create_time: String(sourceTime),
    msg_type: 'text', chat_type: 'group', chat_name: 'Authored Summary Room',
    sender: { id: row.actor_id, id_type: 'open_id', name: 'Authored Person' } };
  const canonical = { message_id: row.external_id, chat_id: row.container_id, msg_type: 'text', chat_type: 'group',
    sender_id: row.actor_id, sender_id_type: 'open_id' };
  const evidence = { prepared: true, sender: { id: row.actor_id, id_type: 'open_id', name: raw.sender.name, source: 'message_sender' },
    conversation: { id: row.container_id, type: 'group', title: { value: raw.chat_name, source: 'message' } },
    content: { state: 'complete' } };
  if (state === 'captured') evidence.prepared = false;
  if (state === 'enriching') evidence.sender.name = '';
  if (state === 'blocked') canonical.sender_name_state = 'cleared';
  const input = { row, raw, canonical, evidence, display: {} }; change(input);
  return { ...row, readiness: evaluateMessageCompleteness(input) };
}
function metadata(evaluated, total = evaluated) {
  return { population: { total, evaluated, not_evaluated: total - evaluated },
    as_of: { read_at: new Date(READ).toISOString(), source_max_record_id: total },
    filter: { direction: 'all', search: '' } };
}
function conserved(summary) {
  assert.equal(Object.values(summary.counts).reduce((a, b) => a + b, 0), summary.population.evaluated);
  assert.equal(summary.incomplete, summary.population.evaluated - summary.counts.ready);
  if (summary.population.total !== null) assert.equal(summary.population.total,
    summary.population.evaluated + summary.population.not_evaluated);
}

test('actual shared evaluator states partition the evaluated page; reasons may overlap', () => {
  const rows = ['captured', 'enriching', 'ready', 'blocked'].map(state => message(state));
  rows.push(message('enriching', AT, f => { f.evidence.conversation.title = null; }));
  const s = summarizeMessageCompleteness(rows, metadata(5, 12));
  assert.deepEqual(s.counts, { captured: 1, enriching: 2, ready: 1, blocked: 1 });
  assert.equal(s.incomplete, 4); assert.equal(s.reasons.sender_name_missing, 2);
  assert.equal(s.reasons.conversation_name_missing, 1); assert.equal(s.reasons.name_explicitly_cleared, 1);
  assert.equal(s.evaluation.status, 'bounded'); assert.equal(s.evaluation.complete, false);
  assert.equal(s.population.not_evaluated, 7); conserved(s);
});

test('empty valid population is a complete stored snapshot, with no invented timestamps', () => {
  const s = summarizeMessageCompleteness([], metadata(0));
  assert.equal(s.scope, 'stored_lark_im_messages'); assert.equal(s.evaluation.status, 'complete');
  assert.equal(s.evaluation.complete, true); assert.equal(s.incomplete, 0);
  assert.equal(s.timing.oldest_source_at, null); assert.equal(s.timing.oldest_source_age_ms, null);
  assert.deepEqual(s.timing.first_missing, { oldest_at: null, oldest_age_ms: null, unknown_count: 0 });
  conserved(s);
});

test('latest-page bound explicitly accounts for rows beyond 1000 rather than claiming full coverage', () => {
  const rows = Array.from({ length: 1003 }, () => message());
  rows[1000] = message('blocked');
  const s = summarizeMessageCompleteness(rows, metadata(1003, 1100));
  assert.equal(s.limit, MESSAGE_COMPLETENESS_SUMMARY_LIMIT); assert.equal(s.population.evaluated, 1000);
  assert.equal(s.population.not_evaluated, 100); assert.equal(s.counts.ready, 1000); assert.equal(s.counts.blocked, 0);
  assert.equal(s.evaluation.input_truncated, true); assert.equal(s.evaluation.status, 'bounded'); conserved(s);
});

test('missing or invalid readiness fails closed and never echoes unknown reasons', () => {
  const good = message();
  const rows = [{}, null, { readiness: {} }, { ...good, readiness: { ...good.readiness, version: 9 } },
    { ...good, readiness: { ...good.readiness, state: 'some-private-name' } },
    { ...good, readiness: { ...good.readiness, reasons: ['SECRET_SOURCE_PAYLOAD'] } }];
  const s = summarizeMessageCompleteness(rows, metadata(rows.length));
  assert.equal(s.counts.captured, 6); assert.equal(s.counts.ready, 0);
  assert.equal(s.reasons.readiness_unavailable, 6); assert.equal(s.evaluation.invalid_readiness_count, 6);
  assert.equal(s.evaluation.status, 'invalid'); assert.equal(s.evaluation.complete, false);
  assert(!JSON.stringify(s).includes('SECRET_SOURCE_PAYLOAD')); assert(!JSON.stringify(s).includes('some-private-name'));
  conserved(s);
});

test('invalid protocol state/requirement combinations cannot claim ready', () => {
  const variants = [];
  let row = message('enriching'); row.readiness.state = 'ready'; variants.push(row);
  row = message(); row.readiness.requirements.pop(); variants.push(row);
  row = message(); row.readiness.requirements[1].field = 'sender'; variants.push(row);
  row = message(); row.readiness.next_action = 'send-private-text'; variants.push(row);
  row = message('blocked'); row.readiness.reasons = []; variants.push(row);
  const s = summarizeMessageCompleteness(variants, metadata(variants.length));
  assert.equal(s.evaluation.invalid_readiness_count, variants.length); assert.equal(s.counts.ready, 0); conserved(s);
});

test('duplicate finite reasons within one message are counted once', () => {
  const row = message('enriching'); row.readiness.reasons.push('sender_name_missing');
  const s = summarizeMessageCompleteness([row], metadata(1));
  assert.equal(s.reasons.sender_name_missing, 1); assert.equal(s.evaluation.invalid_readiness_count, 0); conserved(s);
});

test('population disagreement is unknown, not silently corrected into a complete claim', () => {
  for (const population of [
    { total: 10, evaluated: 1, not_evaluated: 8 }, { total: 1, evaluated: 0, not_evaluated: 1 },
    { total: -1, evaluated: 1, not_evaluated: 0 }, { total: '1', evaluated: 1, not_evaluated: 0 },
  ]) {
    const m = metadata(1); m.population = population;
    const s = summarizeMessageCompleteness([message()], m);
    assert.equal(s.population.total, null); assert.equal(s.population.not_evaluated, null);
    assert.equal(s.population.evaluated, 1); assert.equal(s.counts.ready, 1);
    assert.equal(s.evaluation.metadata_valid, false); assert.equal(s.evaluation.status, 'invalid'); conserved(s);
  }
});

test('page identities and direction cannot contradict the declared snapshot or filter', () => {
  const row = message(); row.id = 7;
  for (const maximum of [0, 6]) {
    const m = metadata(1); m.as_of.source_max_record_id = maximum;
    const s = summarizeMessageCompleteness([row], m);
    assert.equal(s.evaluation.metadata_valid, false); assert.equal(s.evaluation.status, 'invalid');
    assert.equal(s.evaluation.complete, false); conserved(s);
  }
  const m = metadata(1); m.as_of.source_max_record_id = 7; m.filter.direction = 'sent';
  assert.equal(summarizeMessageCompleteness([row], m).evaluation.status, 'invalid');
  m.filter.direction = 'received'; assert.equal(summarizeMessageCompleteness([row], m).evaluation.status, 'complete');
  const duplicate = metadata(2); duplicate.as_of.source_max_record_id = 7;
  assert.equal(summarizeMessageCompleteness([row, row], duplicate).evaluation.status, 'invalid');
  const other = { ...row, source_id: 'other' };
  assert.equal(summarizeMessageCompleteness([other], m).evaluation.status, 'invalid');
});

test('oldest source age refers to incomplete rows and never claims first-missing or completion latency', () => {
  const rows = [message('ready', AT - 999_000), message('enriching', AT + 30_000), message('blocked', AT)];
  rows.forEach(row => {
    row.updated_at = '2050-01-01T00:01:59.000Z'; row.first_missing_at = '2050-01-01T00:01:58.000Z';
    row.readiness.completed_at = '2050-01-01T00:01:57.000Z';
  });
  const s = summarizeMessageCompleteness(rows, metadata(3));
  assert.equal(s.timing.oldest_source_at, new Date(AT).toISOString()); assert.equal(s.timing.oldest_source_age_ms, 120_000);
  assert.equal(s.timing.basis, 'source_occurrence_not_first_missing');
  assert.deepEqual(s.timing.first_missing, { oldest_at: null, oldest_age_ms: null, unknown_count: 2 });
  assert.deepEqual(s.timing.completion, { latest_at: null, latency_ms: null, unknown_count: 1 });
});

test('unknown and future source times do not get zero ages or fallback updated_at clocks', () => {
  const rows = [message('enriching'), message('enriching'), message('enriching')];
  rows[0].occurred_at_ms = null; rows[0].occurred_at = new Date(AT).toISOString(); rows[0].updated_at = new Date(AT).toISOString();
  rows[1].occurred_at_ms = Number.MAX_SAFE_INTEGER; rows[2].occurred_at_ms = READ + 5000;
  const s = summarizeMessageCompleteness(rows, metadata(3));
  assert.equal(s.timing.source_time_unknown_count, 2); assert.equal(s.timing.source_age_unknown_count, 3);
  assert.equal(s.timing.oldest_source_at, new Date(READ + 5000).toISOString()); assert.equal(s.timing.oldest_source_age_ms, null);
});

test('missing snapshot time and invalid safe metadata remain explicitly unavailable', () => {
  const m = metadata(1); m.as_of.read_at = 'PRIVATE_INVALID_CLOCK'; m.as_of.source_max_record_id = 'PRIVATE_ID';
  m.filter.direction = 'PRIVATE_DIRECTION'; m.filter.search = { private: 'PRIVATE_QUERY' };
  const s = summarizeMessageCompleteness([message('enriching')], m);
  assert.deepEqual(s.as_of, { read_at: null, source_max_record_id: null });
  assert.deepEqual(s.filter, { direction: 'unknown', has_search: false });
  assert.equal(s.evaluation.status, 'invalid'); assert.equal(s.timing.oldest_source_age_ms, null);
  assert.equal(s.timing.source_age_unknown_count, 1); assert(!JSON.stringify(s).includes('PRIVATE_'));
});

test('public summary never exposes search text, identities, content, paths or private diagnostics', () => {
  const row = message('enriching'); row.body = row.actor_id = row.external_id = row.raw_json = 'PRIVATE_SENTINEL';
  row.canonical = { private: 'PRIVATE_SENTINEL' }; row.readiness.private_debug = 'PRIVATE_SENTINEL';
  row.readiness.requirements.forEach(item => { item.evidence = 'PRIVATE_SENTINEL'; });
  const m = metadata(1); m.filter.search = 'PRIVATE_SENTINEL'; m.db = '/PRIVATE_SENTINEL/database';
  const s = summarizeMessageCompleteness([row], m);
  assert.equal(s.filter.has_search, true); assert.equal(s.counts.enriching, 1);
  assert(!JSON.stringify(s).includes('PRIVATE_SENTINEL')); assert.equal(s.evaluation.status, 'complete');
});

test('non-array input cannot masquerade as an empty successful population', () => {
  const s = summarizeMessageCompleteness({ readiness: message().readiness }, metadata(0));
  assert.equal(s.population.total, null); assert.equal(s.evaluation.complete, false);
  assert.equal(s.evaluation.status, 'invalid'); conserved(s);
});

test('absent or null snapshot metadata cannot manufacture a complete population', () => {
  for (const meta of [undefined, null]) {
    const s = summarizeMessageCompleteness([message()], meta);
    assert.equal(s.counts.ready, 1); assert.equal(s.population.total, null);
    assert.equal(s.population.not_evaluated, null); assert.equal(s.evaluation.status, 'invalid');
    assert.equal(s.evaluation.complete, false); conserved(s);
  }
});

test('summary uses only supplied time and never mutates its frozen inputs', () => {
  const rows = [message('enriching'), message()], m = metadata(2);
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  freeze(rows); freeze(m); const before = JSON.stringify([rows, m]), original = Date.now;
  try {
    Date.now = () => { throw new Error('summary must not read a wall clock'); };
    const a = summarizeMessageCompleteness(rows, m), b = summarizeMessageCompleteness(rows, m);
    assert.deepEqual(a, b); assert.equal(JSON.stringify([rows, m]), before);
  } finally { Date.now = original; }
});

// Entirely authored historical observations, independently hashed from exact
// source bytes. A historical state is deliberately not a current-state proof.
const digest = value => createHash('sha256').update(value).digest('hex');
const OBSERVER = digest('invented summary observer'), OTHER_OBSERVER = digest('other invented observer');
const sourceKey = row => digest(JSON.stringify([row.external_version, digest(row.raw_json)]));
function observedMessage(id, state = 'ready') {
  const row = { ...message(state), id, external_id: `om_authored_observation_${id}`,
    external_version: '17', occurred_at: new Date(AT).toISOString() };
  row.raw_json = JSON.stringify({ message_id: row.external_id, chat_id: row.container_id,
    create_time: String(AT), sender: { id: row.actor_id, id_type: 'open_id' },
    body: { content: 'PRIVATE_AUTHORED_HISTORY_BODY' } });
  return row;
}
function sourceProof(row) {
  return Object.fromEntries(['id', 'source_id', 'record_type', 'external_id', 'external_version',
    'actor_id', 'container_id', 'direction', 'occurred_at', 'occurred_at_ms', 'raw_json'].map(key => [key, row[key]]));
}
function observation(row, overrides = {}) {
  return { source_id: 'lark.im', record_id: row.id, observer_account_key: OBSERVER,
    contract_version: 1, source_version_key: sourceKey(row), source_epoch: 1,
    state: 'ready', reasons_json: '[]', first_observed_at_ms: AT + 10_000,
    first_missing_observed_at_ms: AT + 10_000, first_ready_observed_at_ms: AT + 20_000,
    last_observed_at_ms: AT + 30_000, observed_regression_count: 0, generation: 3, ...overrides };
}
function historyMetadata(rows, observations) {
  return { ...metadata(rows.length), source_records: rows.map(sourceProof), observations };
}
function historyConserved(summary) {
  for (const key of ['first_missing_observed', 'first_ready_observed', 'observed_regressions']) {
    const metric = summary.timing[key];
    assert.equal(metric.known_count + metric.unknown_count, summary.population.evaluated, key);
  }
  conserved(summary);
}

test('historical clocks use the whole selected page and cannot replace current readiness or true completion', () => {
  const rows = [observedMessage(1, 'blocked'), observedMessage(2), observedMessage(3)];
  const history = [observation(rows[0]), observation(rows[1], { state: 'enriching',
    reasons_json: '["sender_name_missing"]', first_observed_at_ms: AT + 20_000,
    first_missing_observed_at_ms: AT + 20_000, first_ready_observed_at_ms: null })];
  const s = summarizeMessageCompleteness(rows, historyMetadata(rows, history));
  assert.deepEqual(s.counts, { captured: 0, enriching: 0, ready: 2, blocked: 1 });
  assert.deepEqual(s.timing.first_missing_observed, { oldest_at: new Date(AT + 10_000).toISOString(),
    oldest_age_ms: 110_000, known_count: 2, unknown_count: 1 });
  assert.deepEqual(s.timing.first_ready_observed, { latest_at: new Date(AT + 20_000).toISOString(), known_count: 1, unknown_count: 2 });
  assert.deepEqual(s.timing.observed_regressions, { regression_count: 0, known_count: 2, unknown_count: 1 });
  assert.deepEqual(s.timing.first_missing, { oldest_at: null, oldest_age_ms: null, unknown_count: 1 });
  assert.deepEqual(s.timing.completion, { latest_at: null, latency_ms: null, unknown_count: 2 });
  assert.equal(s.reasons.name_explicitly_cleared, 1);
  assert.equal(s.reasons.sender_name_missing, 0, 'past ledger reasons do not become current reasons');
  historyConserved(s);
});

test('no usable observation means unknown regression count; a proven zero and prior regressions remain distinct', () => {
  const row = observedMessage(1);
  const none = summarizeMessageCompleteness([row], historyMetadata([row], []));
  assert.deepEqual(none.timing.observed_regressions, { regression_count: null, known_count: 0, unknown_count: 1 });
  const readyFirst = observation(row, { first_missing_observed_at_ms: null,
    first_ready_observed_at_ms: AT + 10_000, generation: 1 });
  const zero = summarizeMessageCompleteness([row], historyMetadata([row], [readyFirst]));
  assert.deepEqual(zero.timing.observed_regressions, { regression_count: 0, known_count: 1, unknown_count: 0 });
  assert.equal(zero.timing.first_missing_observed.known_count, 0);
  const regressed = observation(row, { state: 'blocked', reasons_json: '["content_unsupported"]',
    observed_regression_count: 2, generation: 6 });
  const s = summarizeMessageCompleteness([row], historyMetadata([row], [regressed]));
  assert.equal(s.counts.ready, 1);
  assert.deepEqual(s.timing.observed_regressions, { regression_count: 2, known_count: 1, unknown_count: 0 });
  for (const result of [none, zero, s]) historyConserved(result);
});

test('observer uniqueness precedes stale-version and invalid-field filtering, while v2 is ignored', () => {
  const row = observedMessage(1), valid = observation(row), proof = sourceProof(row);
  for (const second of [
    { ...valid, observer_account_key: OTHER_OBSERVER },
    { ...valid, observer_account_key: OTHER_OBSERVER, source_version_key: digest('different source version') },
    { ...valid, observer_account_key: OTHER_OBSERVER, last_observed_at_ms: READ + 1 },
    { ...valid, observer_account_key: 'INVALID_PRIVATE_OBSERVER' }, valid,
  ]) {
    for (const candidates of [[valid, second], [second, valid]]) {
      assert.deepEqual(selectMessageReadinessObservations([proof], candidates, READ), []);
      const s = summarizeMessageCompleteness([row], historyMetadata([row], candidates));
      assert.deepEqual(s.timing.observed_regressions, { regression_count: null, known_count: 0, unknown_count: 1 });
    }
  }
  const v2 = { ...valid, observer_account_key: OTHER_OBSERVER, contract_version: 2 };
  assert.deepEqual(selectMessageReadinessObservations([proof], [v2, valid], READ), [valid]);
  assert.deepEqual(selectMessageReadinessObservations([proof], [v2], READ), []);
});

test('observation version hash distinguishes exact raw bytes and nullable external version from derived projection', () => {
  const row = observedMessage(1), original = observation(row);
  for (const changed of [{ ...row, raw_json: `${row.raw_json}\n` }, { ...row, external_version: '18' }]) {
    assert.deepEqual(selectMessageReadinessObservations([sourceProof(changed)], [original], READ), []);
  }
  const nullable = { ...row, external_version: null }, nullHistory = observation(nullable);
  assert.deepEqual(selectMessageReadinessObservations([sourceProof(nullable)], [nullHistory], READ), [nullHistory]);
  assert.deepEqual(selectMessageReadinessObservations([sourceProof({ ...nullable, external_version: 'null' })], [nullHistory], READ), []);
  const derived = { ...row, body: 'new derived body', canonical_json: '{"sender_name":"new derived name"}', content_hash: 'wrong derived shortcut' };
  const s = summarizeMessageCompleteness([derived], historyMetadata([derived], [original]));
  assert.equal(s.timing.observed_regressions.known_count, 1, 'derived fields cannot invalidate the accepted-source epoch');
});

test('source proofs must exactly match selected row identity, source bytes and any exposed version', () => {
  const row = observedMessage(1), valid = observation(row);
  for (const field of ['id', 'source_id', 'record_type', 'external_id', 'actor_id', 'container_id',
    'direction', 'occurred_at', 'occurred_at_ms', 'raw_json', 'external_version']) {
    const m = historyMetadata([row], [valid]);
    m.source_records[0][field] = typeof row[field] === 'number' ? row[field] + 1 : 'PRIVATE_WRONG_PROOF';
    const s = summarizeMessageCompleteness([row], m);
    assert.equal(s.timing.observed_regressions.known_count, 0, field);
    assert.equal(s.counts.ready, 1, 'history failure cannot change current readiness');
  }
  const hidden = { ...row }; delete hidden.external_version;
  const m = historyMetadata([row], [valid]);
  assert.equal(summarizeMessageCompleteness([hidden], m).timing.observed_regressions.known_count, 1,
    'a private snapshot proof may supply a non-enumerable source version lost by a display spread');
  m.source_records.push({ ...m.source_records[0] });
  assert.equal(summarizeMessageCompleteness([hidden], m).timing.observed_regressions.known_count, 0, 'duplicate proofs are ambiguous');
  m.source_records[1].raw_json = '{"different":"PRIVATE_CONTRADICTORY_PROOF"}';
  assert.equal(summarizeMessageCompleteness([hidden], m).timing.observed_regressions.known_count, 0,
    'a mismatching duplicate proof cannot disappear before ambiguity is checked');
});

test('malformed or duplicate source proofs cannot bind an otherwise valid historical observation', () => {
  const row = observedMessage(1), valid = observation(row), proof = sourceProof(row);
  const missingVersion = { ...proof }; delete missingVersion.external_version;
  for (const bad of [missingVersion, { ...proof, source_id: 'synthetic.other' },
    { ...proof, record_type: 'synthetic.other' }, { ...proof, id: 0 }, { ...proof, id: 1.5 },
    { ...proof, external_version: 17 }, { ...proof, external_version: '17\0PRIVATE_SUFFIX' },
    { ...proof, raw_json: null }, { ...proof, raw_json: [row.raw_json] },
    { ...proof, raw_json: `${row.raw_json}\0` }, { ...proof, raw_json: 'x'.repeat(2 * 1024 * 1024 + 1) }]) {
    assert.deepEqual(selectMessageReadinessObservations([bad], [valid], READ), []);
  }
  assert.deepEqual(selectMessageReadinessObservations([proof, proof], [valid], READ), []);
  for (const [proofs, entries] of [[null, [valid]], [[proof], null], [{}, [valid]], [[proof], {}]]) {
    assert.deepEqual(selectMessageReadinessObservations(proofs, entries, READ), []);
  }
});

test('malformed observation hashes, states, reasons, clocks and epochs fail closed without leaking data', () => {
  const row = observedMessage(1), valid = observation(row), proof = sourceProof(row);
  const changes = [
    { observer_account_key: 'A'.repeat(64) }, { source_version_key: 'z'.repeat(64) },
    { source_version_key: digest('wrong raw') }, { state: 'PRIVATE_INVALID_STATE' },
    { reasons_json: '["PRIVATE_INVALID_REASON"]' }, { reasons_json: '{}' }, { reasons_json: '[oops' },
    { reasons_json: '["sender_name_missing","sender_name_missing"]', state: 'enriching' },
    { state: 'ready', reasons_json: '["sender_name_missing"]' },
    { state: 'enriching', reasons_json: '[]' }, { state: 'blocked', reasons_json: '[]' },
    { first_observed_at_ms: -1 }, { first_observed_at_ms: AT + 30_001 },
    { first_observed_at_ms: AT + 9000 }, { last_observed_at_ms: READ + 1 },
    { last_observed_at_ms: 8_640_000_000_000_001 }, { last_observed_at_ms: String(READ) },
    { first_missing_observed_at_ms: AT + 9999 }, { first_ready_observed_at_ms: AT + 30_001 },
    { first_missing_observed_at_ms: null, first_ready_observed_at_ms: null },
    { first_ready_observed_at_ms: null }, { state: 'enriching', reasons_json: '["sender_name_missing"]', first_missing_observed_at_ms: null },
    { source_epoch: 0 }, { source_epoch: 1.5 }, { source_epoch: 4 },
    { generation: 0 }, { generation: 2.5 }, { generation: Number.MAX_SAFE_INTEGER + 1 },
    { observed_regression_count: -1 }, { observed_regression_count: 0.5 },
    { observed_regression_count: 3 }, { observed_regression_count: 1, first_missing_observed_at_ms: null, first_ready_observed_at_ms: AT + 10_000 },
    { private_extra: 'PRIVATE_UNEXPECTED_FIELD' },
  ];
  for (const change of changes) {
    const bad = { ...valid, ...change };
    assert.deepEqual(selectMessageReadinessObservations([proof], [bad], READ), [], JSON.stringify(change));
    const s = summarizeMessageCompleteness([row], historyMetadata([row], [bad]));
    assert.equal(s.timing.observed_regressions.regression_count, null);
    assert.equal(s.timing.first_missing_observed.known_count, 0);
    assert.equal(s.timing.first_ready_observed.known_count, 0);
    assert(!JSON.stringify(s).includes('PRIVATE_')); historyConserved(s);
  }
  for (const invalidReadAt of [null, -1, READ + 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(selectMessageReadinessObservations([proof], [valid], invalidReadAt), []);
  }
  const missingField = { ...valid }; delete missingField.generation;
  assert.deepEqual(selectMessageReadinessObservations([proof], [missingField], READ), []);
});

test('impossible observed transition histories cannot claim a zero regression or simultaneous first states', () => {
  const row = observedMessage(1), proof = sourceProof(row);
  for (const change of [
    { first_ready_observed_at_ms: AT + 10_000 },
    { first_ready_observed_at_ms: AT + 10_000, first_missing_observed_at_ms: AT + 20_000 },
    { first_ready_observed_at_ms: AT + 10_000, first_missing_observed_at_ms: AT + 30_000, observed_regression_count: 1 },
    { state: 'enriching', reasons_json: '["content_partial"]' },
    { state: 'blocked', reasons_json: '["content_unsupported"]', observed_regression_count: 1,
      first_ready_observed_at_ms: AT + 30_000 },
  ]) assert.deepEqual(selectMessageReadinessObservations([proof], [observation(row, change)], READ), [], JSON.stringify(change));
});

test('regression sum overflow becomes unknown without discarding valid historical clocks', () => {
  const rows = [observedMessage(1), observedMessage(2)];
  const entries = rows.map(row => observation(row, { generation: Number.MAX_SAFE_INTEGER,
    observed_regression_count: Number.MAX_SAFE_INTEGER - 1 }));
  const s = summarizeMessageCompleteness(rows, historyMetadata(rows, entries));
  assert.deepEqual(s.timing.observed_regressions, { regression_count: null, known_count: 0, unknown_count: 2 });
  assert.equal(s.timing.first_missing_observed.known_count, 2);
  assert.equal(s.timing.first_ready_observed.known_count, 2);
  historyConserved(s);
});

test('history summaries keep the 1000-row cutoff and do not expose observer identities or source data', () => {
  const rows = Array.from({ length: 1001 }, (_, index) => observedMessage(index + 1));
  const observations = [observation(rows[0]), observation(rows[1000], { observed_regression_count: 99, generation: 101 })];
  const m = historyMetadata(rows, observations);
  const s = summarizeMessageCompleteness(rows, m);
  assert.equal(s.population.evaluated, 1000);
  assert.equal(s.population.not_evaluated, 1);
  assert.deepEqual(s.timing.observed_regressions, { regression_count: 0, known_count: 1, unknown_count: 999 });
  assert.equal(s.timing.first_missing_observed.known_count, 1);
  assert.equal(s.timing.first_ready_observed.known_count, 1);
  assert(!JSON.stringify(s).includes(OBSERVER));
  assert(!JSON.stringify(s).includes('PRIVATE_AUTHORED_HISTORY_BODY'));
  assert(!JSON.stringify(s).includes(rows[0].external_id));
  historyConserved(s);
});

test('observation reduction is deterministic on frozen inputs and invalid snapshot metadata keeps clocks unknown', () => {
  const rows = [observedMessage(1)], m = historyMetadata(rows, [observation(rows[0])]);
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  freeze(rows); freeze(m);
  const before = JSON.stringify([rows, m]), realNow = Date.now;
  try {
    Date.now = () => { throw new Error('history summary must use the snapshot clock'); };
    const first = summarizeMessageCompleteness(rows, m);
    assert.deepEqual(summarizeMessageCompleteness(rows, m), first);
    assert.equal(JSON.stringify([rows, m]), before);
  } finally { Date.now = realNow; }
  const invalid = { ...m, as_of: { ...m.as_of, read_at: 'PRIVATE_INVALID_TIME' } };
  const s = summarizeMessageCompleteness(rows, invalid);
  assert.equal(s.timing.observed_regressions.regression_count, null);
  assert.equal(s.timing.first_missing_observed.known_count, 0);
  assert.equal(s.timing.first_ready_observed.known_count, 0);
  assert(!JSON.stringify(s).includes('PRIVATE_INVALID_TIME'));
});
