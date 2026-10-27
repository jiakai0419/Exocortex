import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { patchTopLevelJsonMemberText } from '../dist/core/json-text-patch.js';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { bindAcquiredMessageAccounts, readMessageAccountEvidence } from '../src/adapters/lark-im/message-account-evidence.mjs';

// All records/identities are authored here. No DB, API, account, or fixture file
// is read; the producer clock is explicit and the reader clock is injectable.
const SELF = { open_id: 'ou_synthetic_acquisition_self' };
const ACCOUNT = recipientAccountKey(SELF.open_id);
const SOURCE_AT = Date.UTC(2020, 0, 1, 0, 0, 0);
const ACQUIRED_AT = '2020-01-02T00:00:00.000Z';
const LATER_AT = '2020-01-03T00:00:00.000Z';
const READ_NOW = Date.parse('2020-01-04T00:00:00.000Z');
const digest = text => createHash('sha256').update(text).digest('hex');

function fixture({ direction = 'received', namespace = 'open_id', system = false, version = true, native = false } = {}) {
  const actor = direction === 'sent' ? SELF.open_id : namespace === 'app_id'
    ? 'cli_synthetic_acquisition_app' : 'ou_synthetic_acquisition_actor';
  const source = { message_id: 'om_synthetic_acquisition', chat_id: 'oc_synthetic_acquisition',
    chat_type: 'p2p', msg_type: system ? 'system' : 'text', create_time: String(SOURCE_AT),
    ...(version ? { update_time: String(SOURCE_AT + 1000) } : {}),
    ...(system ? {} : { sender: { id: actor, id_type: namespace, sender_type: namespace === 'app_id' ? 'app' : 'user' } }),
    content: 'Completely invented source text.' };
  const message = native ? { ...source, source_api: 'im.v1.messages', raw_api: source } : source;
  return recordFromMessage(message, 'lark.im.received.chat.synthetic_acquisition', direction);
}
const parsed = row => [JSON.parse(row.canonical_json), JSON.parse(row.raw_json)];
const read = (row, now = READ_NOW) => readMessageAccountEvidence(row, ...parsed(row), now);
const bind = (row, acquiredAt = ACQUIRED_AT) => bindAcquiredMessageAccounts([row], SELF, { acquiredAt })[0];
function changeCanonical(row, change) {
  const canonical = JSON.parse(row.canonical_json); change(canonical);
  return { ...row, canonical_json: JSON.stringify(canonical) };
}
function changeRaw(row, change) {
  const raw = JSON.parse(row.raw_json); change(raw);
  const raw_json = JSON.stringify(raw);
  return { ...row, raw_json, content_hash: digest(raw_json) };
}
function rejected(row) {
  assert.equal(bind(row), row, 'invalid acquisition must preserve the exact input record');
  assert.equal(read(row), null, 'invalid source cannot validate an existing proof');
}

test('real normalized source yields exact account proof without any sender-name success', () => {
  for (const native of [false, true]) for (const version of [false, true]) {
    const original = fixture({ native, version });
    assert.equal(JSON.parse(original.canonical_json).sender_name, null);
    const row = bind(original), proof = read(row);
    assert.deepEqual(proof, { schema: 'lark_message_acquisition/v1', source_id: 'lark.im', account_key: ACCOUNT,
      external_id: original.external_id, container_id: original.container_id,
      source_hash: original.content_hash, source_version: original.external_version, acquired_at: ACQUIRED_AT });
    const ownAccount = { state: 'verified', account_key: proof.account_key };
    assert.equal(ownAccount.account_key, ACCOUNT); // No actor-name evidence is required.
    assert.equal(read(original), null);
  }
});

test('binder changes only its owned canonical member and never mutates input or non-name data', () => {
  const original = fixture();
  original.canonical_json = original.canonical_json.replace('{', '{\n  "unknown_big":900719925474099312345,\n  ');
  const before = structuredClone(original);
  Object.freeze(original);
  const row = bind(original);
  assert.deepEqual(original, before);
  for (const field of Object.keys(original).filter(field => field !== 'canonical_json')) assert.equal(row[field], original[field], field);
  assert.equal(patchTopLevelJsonMemberText(row.canonical_json, 'message_account_evidence'), original.canonical_json);
  assert(row.canonical_json.includes('900719925474099312345'));
  assert(read(row));
});

test('typed human namespaces and app can bind; no-actor system does not invent a human', () => {
  for (const namespace of ['open_id', 'user_id', 'union_id', 'app_id']) assert(read(bind(fixture({ namespace }))));
  const row = bind(fixture({ system: true }));
  assert(read(row));
  assert.equal(row.actor_id, null);
  assert.equal(JSON.parse(row.canonical_json).sender_name, null);
});

test('sent must be this exact typed self and explicit self cannot be mislabeled received', () => {
  assert(read(bind(fixture({ direction: 'sent' }))));
  rejected({ ...fixture(), direction: 'sent' });
  rejected({ ...fixture({ direction: 'sent' }), direction: 'received' });
  rejected(fixture({ direction: 'sent', namespace: 'user_id' }));
  const row = bind(fixture({ direction: 'sent' }));
  const wrong = changeCanonical(row, c => { c.message_account_evidence.account_key = 'a'.repeat(64); });
  assert.equal(read(wrong), null);
  const otherNamespace = fixture({ namespace: 'user_id' });
  const explicitSelf = changeRaw(otherNamespace, raw => { raw.sender.open_id = SELF.open_id; });
  rejected(explicitSelf);
  const sameBytes = JSON.parse(otherNamespace.raw_json); sameBytes.sender.id = SELF.open_id;
  const sameBytesRecord = recordFromMessage(sameBytes, otherNamespace.first_seen_scope_id, 'received');
  assert(read(bind(sameBytesRecord)), 'user_id bytes alone never become an open_id account claim');
});

test('missing admission time or self, invalid ISO times, and future proof fail closed', () => {
  const row = fixture();
  for (const self of [null, {}, { open_id: 'untyped-self' }]) assert.equal(bindAcquiredMessageAccounts([row], self, { acquiredAt: ACQUIRED_AT })[0], row);
  assert.equal(bindAcquiredMessageAccounts([row], SELF)[0], row);
  for (const at of [null, 1234, '', '2020-01-02', '2020-01-02T00:00:00Z', '1969-12-31T23:59:59.999Z',
    new Date(Date.now() + 60000).toISOString()]) assert.equal(bind(row, at), row);
  const valid = bind(row);
  assert.equal(read(valid, Date.parse(ACQUIRED_AT) - 1), null);
  for (const now of [NaN, Infinity, -1, READ_NOW + 0.5]) assert.equal(read(valid, now), null);
  assert.equal(read(valid, Date.parse(ACQUIRED_AT)).acquired_at, ACQUIRED_AT);
});

test('reading does not renew a proof; a separately authorized fresh acquisition may record a new time', () => {
  const row = bind(fixture()), before = structuredClone(row);
  assert.equal(read(row, READ_NOW).acquired_at, ACQUIRED_AT);
  assert.deepEqual(row, before);
  assert.equal(bind(row), row);
  const next = bind(row, LATER_AT);
  assert.equal(read(next).acquired_at, LATER_AT);
  assert.equal(read(row).acquired_at, ACQUIRED_AT);
  assert.equal(bind(next, ACQUIRED_AT), next, 'do not move an existing observation clock backwards');
  // This is not a DB replay test: storage must separately retain old proof when
  // a re-normalized identical source no longer carries its previous canonical.
});

test('source server clock skew does not fabricate or invalidate acquisition time', () => {
  const row = fixture();
  const earlier = '2019-12-31T23:59:59.000Z';
  const bound = bind(row, earlier);
  assert.equal(read(bound).acquired_at, earlier);
  assert.equal(bound.occurred_at_ms, SOURCE_AT);
});

test('an explicit millisecond source clock is exact even when encoded as a numeric string', () => {
  const original = fixture(), raw = JSON.parse(original.raw_json);
  delete raw.create_time; raw.create_time_ms = String(SOURCE_AT);
  const row = recordFromMessage(raw, original.first_seen_scope_id, 'received');
  assert(read(bind(row)));
  rejected(changeRaw(row, source => { source.create_time_ms = String(SOURCE_AT / 1000); }));
});

test('exact content hash and external version are mandatory; changing source cannot reuse proof', () => {
  for (const patch of [{ content_hash: null }, { content_hash: 'a'.repeat(64) }, { external_version: undefined },
    { external_version: 'not-a-version' }, { external_version: String(SOURCE_AT) }, { external_version: null }]) rejected({ ...fixture(), ...patch });
  const old = bind(fixture());
  const changed = changeRaw(old, raw => { raw.content = 'Different invented source.'; });
  assert.equal(read(changed), null);
  assert.equal(bind(changed), changed, 'stale incoming proof is not silently laundered');
  const renormalized = changeRaw(fixture(), raw => { raw.content = 'Different invented source.'; });
  assert(read(bind(renormalized, LATER_AT)), 'fresh acquired normalized record can carry new proof');
  const absentVersion = fixture({ version: false });
  rejected({ ...absentVersion, external_version: String(SOURCE_AT) });
});

test('missing or contradictory message/chat/source/direction identity is rejected', () => {
  const changes = [r => ({ ...r, source_id: 'another.source' }), r => ({ ...r, record_type: 'other' }),
    r => ({ ...r, external_id: '' }), r => ({ ...r, container_id: '' }), r => ({ ...r, direction: 'unknown' }),
    r => changeRaw(r, x => { delete x.message_id; }), r => changeRaw(r, x => { delete x.chat_id; }),
    r => changeRaw(r, x => { x.id = 'other-message'; }), r => changeRaw(r, x => { x.chat = { id: 'other-chat' }; }),
    r => changeRaw(r, x => { x.source_id = 'another.source'; }), r => changeCanonical(r, x => { delete x.message_id; }),
    r => changeCanonical(r, x => { delete x.chat_id; }), r => changeCanonical(r, x => { x.source_id = 'another.source'; }),
    r => changeCanonical(r, x => { x.message_type = 'image'; })];
  for (const change of changes) rejected(change(fixture()));
});

test('typed actor contradictions and untyped prefix guesses cannot obtain account proof', () => {
  const changes = [r => ({ ...r, actor_id: 'another-actor' }),
    r => changeRaw(r, x => { delete x.sender.id_type; }),
    r => changeRaw(r, x => { x.sender.open_id = 'ou_synthetic_other'; }),
    r => changeRaw(r, x => { x.sender.sender_type = 'app'; }),
    r => changeCanonical(r, x => { x.sender_id_type = 'union_id'; }),
    r => changeCanonical(r, x => { x.sender_id = 'other-actor'; }),
    r => changeCanonical(r, x => { x.sender_type = 'app'; })];
  for (const change of changes) rejected(change(fixture()));
  rejected(fixture({ namespace: 'unrecognized_namespace' }));
  rejected(changeRaw(fixture(), x => { x.sender = []; }));
});

test('native wrapper identities, shared aliases, versions and times cannot disagree', () => {
  const original = fixture();
  const native = JSON.parse(original.raw_json);
  const wrapper = { ...native, raw_api: structuredClone(native) };
  const raw_json = JSON.stringify(wrapper);
  const wrapped = { ...original, raw_json, content_hash: digest(raw_json) };
  assert(read(bind(wrapped)));
  for (const change of [x => { x.sender.id = 'ou_synthetic_other'; }, x => { x.sender.id_type = 'union_id'; },
    x => { x.chat_id = 'other-chat'; }, x => { x.update_time = String(SOURCE_AT + 2000); },
    x => { x.create_time = String(SOURCE_AT + 2000); },
    x => { x.sender.user_id = 'first'; x.raw_api.sender.user_id = 'second'; }]) rejected(changeRaw(wrapped, change));
});

test('invalid or contradictory source event/version clocks cannot be signed', () => {
  const changes = [r => ({ ...r, occurred_at_ms: SOURCE_AT + 1 }), r => ({ ...r, occurred_at: '2020-01-01' }),
    r => changeRaw(r, x => { x.update_time = 'invalid'; }), r => changeRaw(r, x => { x.update_time = -1; }),
    r => changeRaw(r, x => { x.create_time = 'invalid'; }), r => changeRaw(r, x => { x.created_at = String(SOURCE_AT + 1); }),
    r => changeCanonical(r, x => { x.update_time_ms += 1; }), r => changeCanonical(r, x => { x.update_time = null; }),
    r => changeCanonical(r, x => { x.create_time_ms += 1; }),
    r => changeRaw(r, x => { x.update_time = [x.update_time]; }),
    r => changeRaw(r, x => { x.create_time = [x.create_time]; }),
    r => changeCanonical(r, x => { x.update_time = [x.update_time]; }),
    r => changeCanonical(r, x => { x.create_time_ms /= 1000; }),
    r => changeCanonical(r, x => { x.create_time_ms = String(x.create_time_ms); })];
  for (const change of changes) rejected(change(fixture()));
});

test('all existing nonnull account markers must be valid and agree, even failed diagnostics', () => {
  for (const field of ['sender_name_account_key', 'chat_name_account_key']) {
    for (const value of ['', 17, 'not-a-key', 'b'.repeat(64)]) rejected(changeCanonical(fixture(), c => { c[field] = value; }));
    for (const value of [null, ACCOUNT]) assert(read(bind(changeCanonical(fixture(), c => { c[field] = value; }))));
  }
  rejected(changeCanonical(fixture(), c => { c.sender_name_verification = { status: 'failed', account_key: 'b'.repeat(64) }; }));
  rejected(changeRaw(fixture(), r => { r.chat_name_account_key = 'b'.repeat(64); }));
  const row = changeCanonical(fixture(), c => {
    c.sender_name_state = 'cleared';
    c.sender_name_verification = { status: 'failed', reason: 'permission_denied', account_key: ACCOUNT };
  });
  assert(read(bind(row)), 'name failure/clear is independent of request-account proof');
});

test('proof schema is closed and every bound field is exact', () => {
  const original = bind(fixture());
  const changes = [p => { p.schema = 'other/v1'; }, p => { p.extra = true; }, p => { delete p.source_version; },
    p => { p.source_id = 'other'; }, p => { p.account_key = ''; }, p => { p.external_id = 'other'; },
    p => { p.container_id = 'other'; }, p => { p.source_hash = 'b'.repeat(64); },
    p => { p.source_version = null; }, p => { p.acquired_at = '2020-01-02'; }];
  for (const change of changes) rejected(changeCanonical(original, c => { change(c.message_account_evidence); }));
  rejected(changeCanonical(original, c => { c.message_account_evidence = null; }));
});

test('duplicate JSON keys at any depth are rejected despite plausible parsed objects', () => {
  const original = bind(fixture());
  for (const mutate of [r => ({ ...r, canonical_json: r.canonical_json.replace('{', '{"sender_id":"forged",') }),
    r => ({ ...r, canonical_json: r.canonical_json.replace('"schema":', '"schema":"other","schema":') }),
    r => { const raw_json = r.raw_json.replace('"sender":{', '"sender":{"id":"forged",'); return { ...r, raw_json, content_hash: digest(raw_json) }; },
    r => { const raw_json = r.raw_json.replace('{', '{"unrelated":{"x":1,"x":2},'); return { ...r, raw_json, content_hash: digest(raw_json) }; }]) rejected(mutate(original));
});

test('caller-supplied parsed objects cannot substitute for stored exact bytes or mutate read result', () => {
  const row = bind(fixture()), [canonical, raw] = parsed(row);
  assert.equal(readMessageAccountEvidence(row, { ...canonical, sender_name: 'Injected' }, raw, READ_NOW), null);
  assert.equal(readMessageAccountEvidence(row, canonical, { ...raw, sender: { ...raw.sender, id: 'other' } }, READ_NOW), null);
  const proof = read(row); proof.account_key = 'a'.repeat(64);
  assert.equal(read(row).account_key, ACCOUNT);
  assert.equal(readMessageAccountEvidence(row, canonical, raw, READ_NOW).source_hash, digest(row.raw_json));
});

test('a bad or oversized sibling leaves itself untouched without blocking a valid record', () => {
  const valid = fixture(), bad = { ...fixture(), raw_json: '{"bad":' };
  const oversized = changeCanonical(fixture(), c => { c.padding = 'x'.repeat(1024 * 1024); });
  const rows = bindAcquiredMessageAccounts([bad, valid, oversized], SELF, { acquiredAt: ACQUIRED_AT });
  assert.equal(rows[0], bad); assert(read(rows[1])); assert.equal(rows[2], oversized);
  assert.equal(read(oversized), null);
});
