import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareLocalSenderNames } from '../src/adapters/lark-im/name-history.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';
import { createSyncRunner } from '../src/adapters/lark-im/sync-runner.mjs';
import { ensureInitialized, quoteSql, reserveInitialLarkAccount, confirmInitialLarkAccountSql,
  sqliteExec, sqliteQuery, upsertRecordsSql, readScope } from '../dist/storage/sqlite/ingestion-store.js';

// New synthetic identities, bodies, snapshots and disposable databases only.
const START = Date.parse('2037-03-04T05:00:00Z'), CHAT = 'oc_synthetic_local_first';
const ACTOR = 'ou_synthetic_local_reader', APP = 'cli_synthetic_local_bot';
const SELF = { open_id: 'ou_synthetic_local_owner', name: 'Synthetic Owner' };
const ACCOUNT_KEY = createHash('sha256').update(`lark.im\0${SELF.open_id}`).digest('hex');
const SCOPE = 'lark.im.received.chat.synthetic_local_first';
const CONFIG = { chat_id: CHAT, chat_type: 'group', chat_name: 'Synthetic Local Group' };
const OPTIONS = { startMs: START, endMs: START + 60_000, endExplicit: true,
  stableHorizonSeconds: 30, pageSize: 50, maxPages: 2, chatPageSize: 100, chatTypes: 'group',
  lockTtlSeconds: 600, retries: 0, retryDelayMs: 0 };
const canonical = record => JSON.parse(record.canonical_json);
const page = items => ({ ok: true, data: { items, has_more: false } });
function native(id, offset = 1, sender = { id: ACTOR, id_type: 'open_id', sender_type: 'user' }) {
  return { message_id: `om_synthetic_local_${id}`, chat_id: CHAT, msg_type: 'text',
    create_time: String(START + offset), update_time: String(START + offset + 1), sender,
    body: { content: JSON.stringify({ text: `Synthetic unchanged body ${id}.` }) } };
}
function normalized(raw) { return normalizeApiMessage(raw); }
function record(raw) { return recordFromMessage(normalized(raw), SCOPE, 'received', {}, CONFIG); }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'exo-local-first-')), db = join(root, 'synthetic.sqlite');
  t.after(() => rmSync(root, { force: true, recursive: true }));
  ensureInitialized(db);
  reserveInitialLarkAccount(db, ACCOUNT_KEY, new Date().toISOString());
  sqliteExec(db, `${confirmInitialLarkAccountSql(new Date().toISOString())}
    UPDATE sources SET config_json=json_set(config_json,'$.initial_sync_start_ms',${START}) WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${quoteSql(SCOPE)},'lark.im',
      'Synthetic local group',${quoteSql(JSON.stringify(CONFIG))});`);
  return db;
}
function donor(db, { actor = ACTOR, namespace = 'open_id', source = 'contact', name = 'Synthetic Reader', changes = {}, id = `donor_${actor}` } = {}) {
  const row = record(native(id, 0, { id: actor, id_type: namespace, sender_type: namespace === 'app_id' ? 'app' : 'user' }));
  row.canonical_json = JSON.stringify({ ...canonical(row), sender_name: name, sender_name_source: source,
    sender_name_confidence: 'high', sender_name_observed_at: '2036-01-01T00:00:00.000Z',
    sender_name_account_key: ACCOUNT_KEY, ...changes });
  sqliteExec(db, upsertRecordsSql([row]));
  return row;
}
const saved = (db, id) => sqliteQuery(db, `SELECT * FROM records WHERE external_id=${quoteSql(id)};`)[0];
const plan = (db, messages) => prepareLocalSenderNames(db, messages, SCOPE, 'received', SELF, CONFIG);

test('real sync then messages CLI displays exact local human and app names with zero name API calls', t => {
  const db = fixture(t); donor(db); donor(db, { actor: APP, namespace: 'app_id', source: 'application_api', name: 'Synthetic Exact App' });
  const human = native('human', 1000), app = native('app', 2000, { id: APP, id_type: 'app_id', sender_type: 'app' });
  const calls = [];
  const adapter = createLarkImAdapter({ run(args) {
    calls.push(args);
    assert.equal(args[2], '/open-apis/im/v1/messages', 'local known names must not invoke name APIs');
    return page([human, app]);
  } });
  const result = createSyncRunner(adapter).syncReceivedScope(db, OPTIONS, readScope(db, SCOPE), SELF);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(calls.length, 1);
  for (const [raw, expectedName, authority] of [[human, 'Synthetic Reader', 'contact'], [app, 'Synthetic Exact App', 'application_api']]) {
    const row = saved(db, raw.message_id), expected = record(raw);
    assert.equal(canonical(row).sender_name, expectedName);
    assert.equal(canonical(row).sender_name_source, 'local_history');
    assert.equal(canonical(row).sender_name_authority_source, authority);
    assert.equal(canonical(row).sender_name_account_key, ACCOUNT_KEY);
    assert.equal(canonical(row).sender_name_observed_at, '2036-01-01T00:00:00.000Z');
    for (const key of ['raw_json', 'body', 'content_hash', 'external_version', 'occurred_at', 'occurred_at_ms', 'actor_id', 'container_id'])
      assert.equal(row[key], expected[key], key);
  }
  const output = JSON.parse(execFileSync(process.execPath,
    ['bin/exocortex.mjs', 'messages', '--db', db, '--limit', '2', '--format', 'json'], { encoding: 'utf8' }));
  assert.deepEqual(output.map(row => row.external_id), [app.message_id, human.message_id]);
  assert.deepEqual(output.map(row => row.display.sender), ['应用：Synthetic Exact App', 'Synthetic Reader']);
  const text = execFileSync(process.execPath, ['bin/exocortex.mjs', 'messages', '--db', db, '--limit', '2', '--format', 'text'], { encoding: 'utf8' });
  assert.ok(text.includes('Synthetic Exact App') && text.includes('Synthetic Reader'));
});

test('a known sender cannot hide an explicit partner that still needs a contact lookup', t => {
  const db = fixture(t); donor(db);
  const partner = 'ou_synthetic_local_partner';
  const message = { ...native('partner', 1000), content: { text: 'Synthetic partner body' },
    chat_type: 'p2p', chat_partner: { id: partner, id_type: 'open_id' } };
  const calls = [];
  const adapter = createLarkImAdapter({ run(args) {
    calls.push(args); assert.equal(args[0], 'contact');
    return { users: [{ open_id: partner, name: 'Synthetic Partner' }, { open_id: ACTOR, name: 'Fresh Synthetic Reader' }] };
  } });
  const runner = createSyncRunner({ ...adapter, fetchChatMessageList: () => ({ messages: [message], pages: 1, window_end_ms: OPTIONS.endMs }) });
  const result = runner.syncReceivedScope(db, OPTIONS, readScope(db, SCOPE), SELF);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(calls.length, 1);
  const row = canonical(saved(db, message.message_id));
  assert.equal(row.chat_partner.name, 'Synthetic Partner');
  assert.equal(row.sender_name, 'Fresh Synthetic Reader', 'fresh exact evidence wins over a local preflight');
});

test('local preflight rejects guessed authority, source clears, typed collisions and foreign account evidence', t => {
  for (const [mode, settings] of [['guessed', { source: 'chat_bot_unique' }], ['foreign', { changes: { sender_name_account_key: 'f'.repeat(64) } }]]) {
    const db = fixture(t); donor(db, settings);
    const message = normalized(native(mode, 1000)), prepared = plan(db, [message]);
    assert.equal(prepared.lookupMessages.length, 1);
    assert.equal(canonical(prepared.apply([recordFromMessage(message, SCOPE, 'received', {}, CONFIG)])[0]).sender_name, null);
  }
  const db = fixture(t); donor(db);
  for (const sender of [{ id: ACTOR, id_type: 'user_id', sender_type: 'user' },
    { id: ACTOR, id_type: 'open_id', sender_type: 'user', name_state: 'cleared' }]) {
    const message = normalized(native('blocked', 1000, sender)), prepared = plan(db, [message]);
    assert.equal(prepared.lookupMessages.length, 1);
    assert.equal(canonical(prepared.apply([recordFromMessage(message, SCOPE, 'received', {}, CONFIG)])[0]).sender_name, null);
  }
});

test('a fresh conflict from another queried message cannot be hidden by cached global authority', t => {
  const db = fixture(t); donor(db);
  const message = normalized(native('conflict', 1000)), prepared = plan(db, [message]);
  assert.equal(prepared.lookupMessages.length, 0);
  const output = prepared.apply([recordFromMessage(message, SCOPE, 'received', {}, CONFIG)], {
    sender_name_observations: new Map([[JSON.stringify(['oc_synthetic_other_chat', ACTOR, 'open_id']),
      { status: 'conflict', source: 'contact' }]]) });
  assert.equal(canonical(output[0]).sender_name, null);
});

test('foreign donor chat and verification account markers cannot skip remote lookup', t => {
  for (const changes of [{ chat_name_account_key: 'f'.repeat(64) },
    { sender_name_verification: { status: 'resolved', account_key: 'f'.repeat(64) } }]) {
    const db = fixture(t); donor(db, { changes });
    const message = normalized(native('foreign_donor', 1000)), prepared = plan(db, [message]);
    assert.equal(prepared.lookupMessages.length, 1);
    const pending = recordFromMessage(message, SCOPE, 'received', {}, CONFIG);
    assert.strictEqual(prepared.apply([pending])[0], pending);
    // Unrelated-account evidence is excluded, rather than poisoning a separate
    // exact authority known to belong to this source's admitted account.
    donor(db, { id: 'compatible_account' });
    assert.equal(plan(db, [message]).lookupMessages.length, 0);
  }
});

test('unmarked legacy names cannot be adopted, while same-account adoption survives a later failed lookup', t => {
  for (const marker of [undefined, null, '', 'f'.repeat(64)]) {
    const db = fixture(t); donor(db, { changes: { sender_name_account_key: marker } });
    const message = normalized(native('unbound_legacy', 1000)), prepared = plan(db, [message]);
    assert.equal(prepared.lookupMessages.length, 1);
    const before = recordFromMessage(message, SCOPE, 'received', {}, CONFIG);
    assert.strictEqual(prepared.apply([before])[0], before);
  }
  const db = fixture(t); donor(db, { changes: { sender_name_verification: {
    status: 'failed', reason: 'temporarily_unavailable', source: 'contact', account_key: ACCOUNT_KEY } } });
  const message = normalized(native('adopted_failed_latest', 1000)), prepared = plan(db, [message]);
  assert.equal(prepared.lookupMessages.length, 0);
  const output = canonical(prepared.apply([recordFromMessage(message, SCOPE, 'received', {}, CONFIG)])[0]);
  assert.equal(output.sender_name, 'Synthetic Reader');
  assert.equal(output.sender_name_account_key, ACCOUNT_KEY);
  assert.equal(output.sender_name_observed_at, '2036-01-01T00:00:00.000Z');
  assert.equal(output.sender_name_verification, undefined, 'borrowing adoption does not invent a latest lookup');
});

test('historical verification conflicts and every raw clear form block older otherwise valid names', t => {
  const variants = ['conflict', 'raw_sender', 'raw_top', 'wrapped_sender', 'wrapped_top'];
  for (const variant of variants) {
    const db = fixture(t); donor(db, { id: 'older_valid' });
    const rejected = donor(db, { id: 'negative_evidence', changes: variant === 'conflict'
      ? { sender_name_verification: { status: 'conflict', reason: 'conflicting_names', source: 'contact' } } : {} });
    if (variant !== 'conflict') {
      const raw = JSON.parse(rejected.raw_json);
      if (variant.endsWith('sender')) raw.sender.name_state = 'cleared';
      else raw.sender_name_state = 'cleared';
      rejected.raw_json = JSON.stringify(variant.startsWith('wrapped') ? { raw_api: raw } : raw);
      // Seed an existing legacy inconsistency. Normal upsert deliberately
      // preserves raw facts for the same external version.
      sqliteExec(db, `UPDATE records SET raw_json=${quoteSql(rejected.raw_json)}
        WHERE external_id=${quoteSql(rejected.external_id)};`);
    }
    const message = normalized(native(`after_${variant}`, 1000)), prepared = plan(db, [message]);
    assert.equal(prepared.lookupMessages.length, 1, variant);
    const pending = recordFromMessage(message, SCOPE, 'received', {}, CONFIG);
    assert.strictEqual(prepared.apply([pending])[0], pending, variant);
  }
});

test('a historical conflict uses the latest observation scope rather than an older adopted global source', t => {
  const db = fixture(t); donor(db, { id: 'global_valid' });
  const rejected = donor(db, { id: 'scoped_conflict', changes: {
    sender_name_verification: { status: 'conflict', reason: 'conflicting_names', source: 'chat_member' } } });
  const message = normalized(native('scope_check', 1000));
  assert.equal(plan(db, [message]).lookupMessages.length, 1, 'same-chat conflict blocks global borrowing');
  const otherChat = 'oc_synthetic_conflict_other';
  rejected.container_id = otherChat;
  rejected.canonical_json = JSON.stringify({ ...canonical(rejected), chat_id: otherChat });
  rejected.raw_json = JSON.stringify({ ...JSON.parse(rejected.raw_json), chat_id: otherChat });
  sqliteExec(db, `UPDATE records SET container_id=${quoteSql(rejected.container_id)},
    canonical_json=${quoteSql(rejected.canonical_json)},raw_json=${quoteSql(rejected.raw_json)}
    WHERE external_id=${quoteSql(rejected.external_id)};`);
  assert.equal(plan(db, [message]).lookupMessages.length, 0, 'different-chat member conflict is not global');
  rejected.canonical_json = JSON.stringify({ ...canonical(rejected), sender_name_verification: {
    status: 'conflict', reason: 'conflicting_names', source: 'contact' } });
  sqliteExec(db, `UPDATE records SET canonical_json=${quoteSql(rejected.canonical_json)}
    WHERE external_id=${quoteSql(rejected.external_id)};`);
  assert.equal(plan(db, [message]).lookupMessages.length, 1, 'contact conflict remains global');
});

test('remote failure cannot re-adopt a local name rejected by the whole batch alias union', t => {
  const db = fixture(t), alias = 'synthetic_local_revealed_alias'; donor(db, { name: alias });
  const first = { ...normalized(native('alias_before', 1000)), chat_type: 'p2p' };
  const second = { ...normalized(native('alias_after', 2000,
    { id: ACTOR, id_type: 'open_id', sender_type: 'user', user_id: alias })), chat_type: 'p2p' };
  const prepared = plan(db, [first, second]);
  assert.equal(prepared.lookupMessages.length, 2);
  let calls = 0;
  const adapter = createLarkImAdapter({ run(args) {
    calls++; assert.equal(args[0], 'contact'); throw new Error('synthetic contact unavailable');
  } });
  const context = adapter.buildPeopleContext(prepared.lookupMessages, { retries: 0 }, SELF, CONFIG);
  const before = [first, second].map(message => recordFromMessage(message, SCOPE, 'received', context, CONFIG));
  const output = prepared.apply(before, context);
  assert.equal(calls, 1);
  assert.deepEqual(output.map(row => canonical(row).sender_name), [null, null]);
  assert.deepEqual(output, before);
});

test('explicit pending partner aliases also reject a local sender name after the real resolver rejects it', t => {
  const db = fixture(t), alias = 'synthetic_local_partner_alias'; donor(db, { name: alias });
  const first = { ...normalized(native('partner_alias_sender', 1000)), chat_type: 'p2p' };
  const second = { ...normalized(native('partner_alias_lookup', 2000,
    { id: 'ou_synthetic_local_named_second', id_type: 'open_id', sender_type: 'user', name: 'Synthetic Named Second' })),
    chat_type: 'p2p', chat_partner: { id: ACTOR, id_type: 'open_id', user_id: alias } };
  const prepared = plan(db, [first, second]);
  assert.equal(prepared.lookupMessages.length, 2);
  let calls = 0;
  const adapter = createLarkImAdapter({ run(args) {
    calls++; assert.equal(args[0], 'contact'); return { users: [{ open_id: ACTOR, name: alias }] };
  } });
  const context = adapter.buildPeopleContext(prepared.lookupMessages, { retries: 0 }, SELF, CONFIG);
  assert.equal(context.contacts.has(ACTOR), false, 'existing resolver rejects the partner ID echo');
  const before = [first, second].map(message => recordFromMessage(message, SCOPE, 'received', context, CONFIG));
  const output = prepared.apply(before, context);
  assert.equal(calls, 1);
  assert.deepEqual(output.map(row => canonical(row).sender_name), [null, 'Synthetic Named Second']);
  assert.deepEqual(output, before);
});

test('a real partner query exports its conflict for a locally known sender without extra requests', t => {
  const db = fixture(t); donor(db);
  const first = { ...normalized(native('partner_conflict_sender', 1000)), chat_type: 'p2p' };
  const second = { ...normalized(native('partner_conflict_lookup', 2000,
    { id: 'ou_synthetic_local_second', id_type: 'open_id', sender_type: 'user', name: 'Synthetic Second' })),
    chat_type: 'p2p', chat_partner: { id: ACTOR, id_type: 'open_id' } };
  const prepared = plan(db, [first, second]);
  assert.deepEqual(prepared.lookupMessages.map(message => message.message_id), [first.message_id, second.message_id]);
  let calls = 0;
  const adapter = createLarkImAdapter({ run(args) {
    calls++; assert.equal(args[0], 'contact');
    assert.equal(args[args.indexOf('--user-ids') + 1], ACTOR);
    return { users: [{ open_id: ACTOR, name: 'Conflicting Synthetic One' },
      { open_id: ACTOR, name: 'Conflicting Synthetic Two' }] };
  } });
  const context = adapter.buildPeopleContext(prepared.lookupMessages, { retries: 0 }, SELF, CONFIG);
  const output = prepared.apply([first, second].map(message => recordFromMessage(message, SCOPE, 'received', context, CONFIG)), context);
  assert.equal(calls, 1);
  assert.equal(canonical(output[0]).sender_name, null);
  assert.equal(canonical(output[0]).sender_name_verification.status, 'conflict');
});

test('history cleared during another lookup is rechecked before a local name is adopted', t => {
  const db = fixture(t); donor(db);
  const known = normalized(native('local_before_clear', 1000));
  const unknown = normalized(native('other_lookup', 2000,
    { id: 'ou_synthetic_local_unknown', id_type: 'open_id', sender_type: 'user' }));
  const prepared = plan(db, [known, unknown]);
  assert.deepEqual(prepared.lookupMessages.map(message => message.message_id), [unknown.message_id]);
  sqliteExec(db, `UPDATE records SET canonical_json=json_set(canonical_json,'$.sender_name',NULL,
    '$.sender_name_state','cleared') WHERE actor_id=${quoteSql(ACTOR)};`);
  const output = prepared.apply([recordFromMessage(known, SCOPE, 'received', {}, CONFIG)]);
  assert.equal(canonical(output[0]).sender_name, null);
});

test('a local plan cannot overwrite an explicit clear, foreign marker or changed source record', t => {
  const db = fixture(t); donor(db);
  const message = normalized(native('predecessor', 1000)), prepared = plan(db, [message]);
  for (const change of [{ sender_name_state: 'cleared' }, { sender_name_account_key: 'e'.repeat(64) }]) {
    const row = recordFromMessage(message, SCOPE, 'received', {}, CONFIG);
    row.canonical_json = JSON.stringify({ ...canonical(row), ...change });
    assert.strictEqual(prepared.apply([row])[0], row);
  }
  const changed = recordFromMessage(normalized(native('predecessor', 2000)), SCOPE, 'received', {}, CONFIG);
  assert.strictEqual(prepared.apply([changed])[0], changed);
});

test('the local preview bound falls back without silently sampling a large batch', t => {
  const db = fixture(t), messages = Array.from({ length: 101 }, (_, i) => normalized(native(`large_${i}`, i + 1)));
  let reads = 0;
  const prepared = prepareLocalSenderNames(db, messages, SCOPE, 'received', SELF, CONFIG, (db, records) => { reads++; return records; });
  assert.equal(prepared.lookupMessages.length, messages.length); assert.equal(reads, 0);
  prepared.apply([]); assert.equal(reads, 1);
});

test('independent detail plans share one local allowance rather than multiplying it', t => {
  const db = fixture(t), budget = { remainingMs: 4500 }, message = normalized(native('bounded', 1000));
  let calls = 0;
  const reuse = (db, records, self, remaining) => {
    calls++; assert.ok(remaining <= 4500); budget.remainingMs = 0; return records;
  };
  // Exhaust the quota between plans, as the batch controller would after local
  // work. It is independent of the remote lookup's remaining deadline.
  prepareLocalSenderNames(db, [message], SCOPE, 'received', SELF, CONFIG, reuse, budget);
  budget.remainingMs = 0;
  prepareLocalSenderNames(db, [message], SCOPE, 'received', SELF, CONFIG, reuse, budget);
  assert.equal(calls, 1);
});

test('real detail completion uses local history even when remote naming has no remaining time', t => {
  const db = fixture(t); donor(db);
  const root = { ...native('bundle', 1000), msg_type: 'merge_forward', body: { content: 'Synthetic bundle' } };
  const child = { ...native('child', -1000), upper_message_id: root.message_id };
  const queue = createSyncRunner(createLarkImAdapter({ run(args) {
    if (args[2] === '/open-apis/im/v1/messages') return page([root]);
    throw new Error('synthetic detail temporarily unavailable');
  } }));
  assert.equal(queue.syncReceivedScope(db, OPTIONS, readScope(db, SCOPE), SELF).incomplete, true);
  sqliteExec(db, "UPDATE lark_im_detail_tasks SET retry_at='2000-01-01T00:00:00.000Z';");
  let clock = 0, nameCalls = 0;
  const runner = createSyncRunner({ nowMs: () => clock,
    fetchMessageDetails: () => { clock = 30_000; return normalizeApiMessage(root, { mergeItems: [root, child] }); },
    buildPeopleContext: () => { nameCalls++; throw new Error('spent remote name budget'); } });
  const results = runner.retryDetails(db, { ...OPTIONS, detailScope: SCOPE, detailBudgetMs: 30_000 }, SELF);
  assert.equal(results[0].ok, true, JSON.stringify(results)); assert.equal(nameCalls, 0);
  const row = saved(db, root.message_id), expected = recordFromMessage(normalizeApiMessage(root, { mergeItems: [root, child] }), SCOPE, 'received', {}, CONFIG);
  assert.equal(canonical(row).sender_name, 'Synthetic Reader');
  for (const key of ['raw_json', 'body', 'content_hash', 'external_version', 'occurred_at_ms']) assert.equal(row[key], expected[key], key);
});
