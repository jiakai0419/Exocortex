import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { createNameResolver } from '../src/adapters/lark-im/name-resolver.mjs';
import { displayP2pRecipient, makeRecipientEvidence, parseP2pTarget } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { enrichRecords } from '../src/maintenance/enrich-records.mjs';
import { ensureInitialized, readScope, createRun, succeedRecordRun, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';

// All identities, names, dates and message content are newly invented here.
const SELF = 'ou_synthetic_partner_author';
const PEER = 'ou_synthetic_partner_reader';
const CHAT = 'oc_synthetic_partner_room';
const SCOPE = 'lark.im.sent_by_me';
const AT = Date.UTC(2058, 3, 9, 10, 11, 12);
const NAME = 'Synthetic Lantern Reader';
function message(partner, revision = 0) {
  return { message_id: 'om_synthetic_partner_message', create_time: String(AT), update_time: String(AT + revision),
    sender: { id: SELF, id_type: 'open_id', sender_type: 'user', name: 'Synthetic Lantern Author' },
    chat_id: CHAT, chat_type: 'p2p', msg_type: 'text', content: { text: 'Arrange four synthetic lanterns.' },
    chat_partner: partner };
}
function project(partner, context = {}, revision = 0) {
  const input = message(partner, revision), before = JSON.stringify(input);
  const record = recordFromMessage(input, SCOPE, 'sent', context);
  assert.equal(JSON.stringify(input), before, 'normalization preserves the supplied source');
  assert.equal(record.raw_json, before);
  assert.equal(record.content_hash, createHash('sha256').update(before).digest('hex'));
  return { record, canonical: JSON.parse(record.canonical_json), raw: JSON.parse(record.raw_json) };
}
function recipient(sample, evidence) {
  return displayP2pRecipient(sample.record, sample.canonical, sample.raw,
    { chat_id: CHAT, ...(evidence ? { p2p_recipient: evidence } : {}) });
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-typed-partner-synthetic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite'); ensureInitialized(db);
  return {
    db,
    write(record) {
      const scope = readScope(db, SCOPE), run = createRun(db, scope, { synthetic: true });
      return succeedRecordRun(db, scope, run, [record], 1, { kind: 'synthetic.cursor/v1', occurred_at_ms: AT }, {});
    },
    read() { return sqliteQuery(db, 'SELECT * FROM records;', 'read synthetic typed partner')[0]; },
  };
}

for (const type of ['open_id', 'user_id', 'union_id']) {
  for (const shape of ['field', 'declared']) test(`normalization and recipient display retain explicit ${type} in ${shape} form`, () => {
    // Same spelling deliberately tests that namespace is not inferred from ou_.
    const identity = shape === 'field' ? { [type]: PEER } : { id: PEER, id_type: type };
    const s = project({ ...identity, name: NAME });
    assert.deepEqual(s.canonical.chat_partner, { ...identity, name: NAME });
    assert.equal(recipient(s), NAME);
    const evidence = makeRecipientEvidence(CHAT, SELF, { id_type: 'open_id', id: 'ou_synthetic_other_peer' },
      'Synthetic Unrelated Lookup', '2025-03-04T05:06:07.000Z');
    if (type !== 'open_id') assert.equal(recipient(s, evidence), NAME, 'open-ID cache cannot overwrite another namespace');
  });

  for (const state of ['known', 'cleared']) test(`stored ${type} ${state} survives a later missing-name observation for the same typed identity`, t => {
    const f = fixture(t), identity = { [type]: PEER };
    const first = project({ ...identity, ...(state === 'known' ? { name: NAME } : { name_state: 'cleared' }) });
    f.write(first.record);
    const next = project(identity, {}, 1000); f.write(next.record);
    const stored = f.read(), canonical = JSON.parse(stored.canonical_json);
    assert.deepEqual(canonical.chat_partner, { ...identity, name: state === 'known' ? NAME : null,
      ...(state === 'cleared' ? { name_state: 'cleared' } : {}) });
    for (const field of ['raw_json', 'content_hash', 'external_version', 'body', 'actor_id', 'container_id', 'occurred_at_ms']) {
      assert.equal(stored[field], next.record[field], field);
    }
    const renamed = project({ ...identity, name: 'Synthetic New Lantern Reader' }, {}, 2000);
    f.write(renamed.record);
    assert.deepEqual(JSON.parse(f.read().canonical_json).chat_partner, { ...identity, name: 'Synthetic New Lantern Reader' });
  });
}

test('only explicit valid open-ID partners consume person lookup maps; source clear and names keep priority', () => {
  const context = { contacts: new Map([[PEER, 'Synthetic Contact']]), chat_members: new Map([[`${CHAT}:${PEER}`, 'Synthetic Member']]),
    apps: new Map([[PEER, 'Synthetic Wrong Application']]), app_fallbacks: new Map([[`${CHAT}:${PEER}`, 'Synthetic Wrong Bot']]) };
  assert.equal(project({ open_id: PEER }, context).canonical.chat_partner.name, 'Synthetic Member');
  assert.equal(project({ open_id: PEER, name: NAME }, context).canonical.chat_partner.name, NAME);
  assert.deepEqual(project({ open_id: PEER, name: NAME, name_state: 'cleared' }, context).canonical.chat_partner,
    { open_id: PEER, name: null, name_state: 'cleared' });
  for (const identity of [{ user_id: PEER }, { union_id: PEER }, { id: PEER }, { id: PEER, id_type: 'user_id' },
    { id: PEER, id_type: 'union_id' }, { open_id: 'synthetic_invalid_open_id' }]) {
    const s = project(identity, context);
    assert.deepEqual(s.canonical.chat_partner, { ...identity, name: null });
  }
  const appOnly = { apps: context.apps, app_fallbacks: context.app_fallbacks };
  assert.equal(project({ open_id: PEER }, appOnly).canonical.chat_partner.name, null);
});

test('untyped, malformed and conflicting source partner identities never become valid typed recipients', () => {
  for (const partner of [{ id: PEER, name: NAME }, { id: PEER, id_type: 'opaque', name: NAME },
    { user_id: {}, name: NAME }, { union_id: [PEER], name: NAME },
    { id: PEER, id_type: 'open_id', open_id: 'ou_synthetic_conflict', name: NAME },
    { open_id: PEER, sender_id: { open_id: 'ou_synthetic_conflict' }, name: NAME }]) {
    const s = project(partner);
    for (const [key, value] of Object.entries(partner).filter(([key]) => key !== 'name')) assert.deepEqual(s.canonical.chat_partner[key], value);
    assert.equal(recipient(s), '未知');
  }
  assert.equal(project([]).canonical.chat_partner, null);
});

test('partner lookup requests require explicit open-ID evidence and do not query user/union/untyped/clear values', () => {
  const denied = [{ user_id: PEER }, { union_id: PEER }, { id: PEER }, { open_id: 'synthetic_invalid' },
    { id: PEER, id_type: 'user_id' }, { open_id: PEER, name_state: 'cleared' },
    { id: PEER, id_type: 'open_id', open_id: 'ou_synthetic_conflict' }];
  const resolver = createNameResolver({ run: () => assert.fail('unsupported partner must not query contacts or any other API') });
  for (const partner of denied) resolver.buildPeopleContext([message(partner)], {}, null);
  const requests = [];
  const allowed = createNameResolver({ run(args) {
    requests.push(args);
    assert.equal(args[0], 'contact');
    return { users: [{ open_id: PEER, name: NAME }] };
  } });
  const context = allowed.buildPeopleContext([message({ id: PEER, id_type: 'open_id' })], {}, null);
  assert.equal(requests.length, 1);
  assert.equal(context.contacts.get(PEER), NAME);
  assert.equal(project({ id: PEER, id_type: 'open_id' }, context).canonical.chat_partner.name, NAME);
});

test('ID echoes in any explicit partner alias are unknown during lookup and projection', () => {
  const USER = 'synthetic_partner_user_alias';
  const s = project({ open_id: PEER, user_id: USER, name: USER }, { contacts: new Map([[PEER, USER]]) });
  assert.equal(s.canonical.chat_partner.name, null);
  const calls = [];
  const resolver = createNameResolver({ run(args) { calls.push(args); return { users: [{ open_id: PEER, name: USER }] }; } });
  const context = resolver.buildPeopleContext([message({ open_id: PEER, user_id: USER, name: USER })], {}, null);
  assert.equal(calls.length, 1, 'source echo does not suppress a supported lookup');
  assert.equal(context.contacts.has(PEER), false, 'a response echo of a source alias is not cached as a name');
});

test('storage rejects namespace collisions and cross-source conflicting typed identities', t => {
  const cases = [
    [{ user_id: PEER }, { union_id: PEER }],
    [{ open_id: PEER }, { user_id: PEER }],
    [{ user_id: PEER }, { id: PEER }],
    [{ user_id: PEER }, { user_id: 'synthetic_other_user' }],
    [{ open_id: PEER, user_id: 'synthetic_alias_before' }, { open_id: PEER, user_id: 'synthetic_alias_after' }],
  ];
  for (const [before, after] of cases) {
    const f = fixture(t); f.write(project({ ...before, name: NAME }).record);
    f.write(project(after, {}, 1000).record);
    assert.equal(JSON.parse(f.read().canonical_json).chat_partner.name, null);
  }
  const f = fixture(t), old = project({ user_id: PEER, name: NAME });
  old.canonical.chat_partner = { open_id: PEER, name: NAME };
  old.record.canonical_json = JSON.stringify(old.canonical);
  f.write(old.record); f.write(project({ user_id: PEER }, {}, 1000).record);
  assert.equal(JSON.parse(f.read().canonical_json).chat_partner.name, null, 'legacy contradictory projection cannot donate a name');
});

test('storage permits an explicit compatible alias addition, but never resurrects an ID echo', t => {
  const f = fixture(t); f.write(project({ open_id: PEER, name: NAME }).record);
  f.write(project({ open_id: PEER, user_id: 'synthetic_extra_user_alias' }, {}, 1000).record);
  assert.equal(JSON.parse(f.read().canonical_json).chat_partner.name, NAME);
  const g = fixture(t), alias = 'synthetic_new_alias';
  g.write(project({ open_id: PEER, name: alias }).record);
  g.write(project({ open_id: PEER, user_id: alias }, {}, 1000).record);
  assert.equal(JSON.parse(g.read().canonical_json).chat_partner.name, null);
});

test('official recipient relationships retain the strict open-ID parser', () => {
  const target = { chat_id: CHAT, chat_mode: 'p2p', p2p_target_type: 'user', p2p_target_id: PEER };
  assert.deepEqual(parseP2pTarget({ items: [target] }, CHAT), { id_type: 'open_id', id: PEER });
  for (const value of ['synthetic_user_id', CHAT, 'ou_bad space', '', null]) {
    assert.equal(parseP2pTarget({ items: [{ ...target, p2p_target_id: value }] }, CHAT), null);
  }
});

test('general maintenance preserves typed partner identities, known names and clears without cross-namespace lookup', t => {
  for (const type of ['user_id', 'union_id']) for (const state of ['known', 'unknown', 'cleared']) {
    const f = fixture(t), original = project({ [type]: PEER,
      ...(state === 'known' ? { name: NAME } : state === 'cleared' ? { name_state: 'cleared' } : {}) });
    f.write(original.record);
    const before = f.read(), calls = [];
    enrichRecords({ db: f.db, limit: 10, dryRun: false }, { runLark(args) {
      calls.push(args);
      assert.deepEqual(args.slice(0, 2), ['contact', '+get-user'], 'typed user/union ID must not be sent to open-ID contact search');
      return { open_id: SELF, name: 'Synthetic Lantern Author' };
    } });
    const after = f.read();
    assert.deepEqual(JSON.parse(after.canonical_json).chat_partner, original.canonical.chat_partner);
    for (const field of ['raw_json', 'content_hash', 'external_version', 'body', 'actor_id', 'container_id', 'occurred_at_ms']) assert.equal(after[field], before[field], field);
    assert.equal(calls.length, 1);
  }
});

test('general maintenance leaves legacy mistyped partner identity untouched and its existing raw-name reading still works', t => {
  const f = fixture(t), original = project({ user_id: 'synthetic_legacy_partner', name: NAME });
  original.canonical.chat_partner = { open_id: 'synthetic_legacy_partner', name: NAME };
  original.record.canonical_json = JSON.stringify(original.canonical); f.write(original.record);
  const before = f.read();
  enrichRecords({ db: f.db, limit: 10, dryRun: false }, { runLark(args) {
    assert.deepEqual(args.slice(0, 2), ['contact', '+get-user']);
    return { open_id: SELF, name: 'Synthetic Lantern Author' };
  } });
  const after = f.read(), canonical = JSON.parse(after.canonical_json), raw = JSON.parse(after.raw_json);
  assert.deepEqual(canonical.chat_partner, original.canonical.chat_partner);
  assert.equal(displayP2pRecipient(after, canonical, raw), NAME);
  assert.equal(after.raw_json, before.raw_json);
});

test('general maintenance can refresh a canonical-only typed open-ID clear but never a clear in the source', t => {
  const f = fixture(t), canonicalOnly = project(undefined);
  canonicalOnly.canonical.chat_partner = { id: PEER, id_type: 'open_id', name: null, name_state: 'cleared' };
  canonicalOnly.record.canonical_json = JSON.stringify(canonicalOnly.canonical); f.write(canonicalOnly.record);
  let searches = 0;
  enrichRecords({ db: f.db, limit: 10, dryRun: false }, { runLark(args) {
    if (args[1] === '+get-user') return { open_id: SELF, name: 'Synthetic Lantern Author' };
    assert.equal(args[1], '+search-user'); searches++;
    return { users: [{ open_id: PEER, name: NAME }] };
  } });
  assert.equal(searches, 1);
  assert.deepEqual(JSON.parse(f.read().canonical_json).chat_partner, { id: PEER, id_type: 'open_id', name: NAME });
  const g = fixture(t), sourceClear = project({ open_id: PEER, name_state: 'cleared' });
  g.write(sourceClear.record);
  enrichRecords({ db: g.db, limit: 10, dryRun: false }, { runLark(args) {
    assert.equal(args[1], '+get-user'); return { open_id: SELF, name: 'Synthetic Lantern Author' };
  } });
  assert.deepEqual(JSON.parse(g.read().canonical_json).chat_partner, sourceClear.canonical.chat_partner);
});

test('explicit maintenance retains legacy canonical-only known names while source clears and alias echoes remain cleared', t => {
  const runLark = args => {
    assert.equal(args[1], '+get-user', 'known names, source clears and non-open IDs require no contact lookup');
    return { open_id: SELF, name: 'Synthetic Lantern Author' };
  };
  for (const type of ['open_id', 'user_id', 'union_id']) {
    const f = fixture(t), original = project(undefined);
    original.canonical.chat_partner = { [type]: PEER, name: NAME, name_state: 'cleared' };
    original.record.canonical_json = JSON.stringify(original.canonical); f.write(original.record);
    enrichRecords({ db: f.db, limit: 10, dryRun: false }, { runLark });
    assert.deepEqual(JSON.parse(f.read().canonical_json).chat_partner, { [type]: PEER, name: NAME });
    assert.equal(f.read().raw_json, original.record.raw_json);
  }
  const echo = fixture(t), original = project(undefined);
  original.canonical.chat_partner = { user_id: PEER, name: PEER, name_state: 'cleared' };
  original.record.canonical_json = JSON.stringify(original.canonical); echo.write(original.record);
  enrichRecords({ db: echo.db, limit: 10, dryRun: false }, { runLark });
  assert.deepEqual(JSON.parse(echo.read().canonical_json).chat_partner, { user_id: PEER, name: null, name_state: 'cleared' });
  const cleared = fixture(t), source = project({ open_id: PEER, name: NAME, name_state: 'cleared' });
  source.canonical.chat_partner.name = NAME;
  source.record.canonical_json = JSON.stringify(source.canonical); cleared.write(source.record);
  enrichRecords({ db: cleared.db, limit: 10, dryRun: false }, { runLark });
  assert.deepEqual(JSON.parse(cleared.read().canonical_json).chat_partner, { open_id: PEER, name: null, name_state: 'cleared' });
  assert.equal(cleared.read().raw_json, source.record.raw_json);
});

test('general maintenance adds a missing typed canonical partner from exact raw evidence without rewriting source identity', t => {
  const f = fixture(t), original = project({ union_id: 'synthetic_union_partner', display_name: NAME });
  original.canonical.chat_partner = null; original.record.canonical_json = JSON.stringify(original.canonical); f.write(original.record);
  enrichRecords({ db: f.db, limit: 10, dryRun: false }, { runLark(args) {
    assert.equal(args[1], '+get-user'); return { open_id: SELF, name: 'Synthetic Lantern Author' };
  } });
  const after = f.read();
  assert.deepEqual(JSON.parse(after.canonical_json).chat_partner, { union_id: 'synthetic_union_partner', name: NAME });
  assert.equal(after.raw_json, original.record.raw_json);
});
