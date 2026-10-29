import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureInitialized, reserveInitialLarkAccount, confirmInitialLarkAccountSql,
  quoteSql as q, sqliteExec, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';
import { syncNames } from '../src/adapters/lark-im/name-sync.mjs';
import { nameTaskKey } from '../src/adapters/lark-im/name-evidence.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';

// Authored records and responses only. Every scheduler turn starts a separate
// process, but uses the real coordinator, recipient producer and SQLite commits.
const HERE = fileURLToPath(import.meta.url), ROOT = dirname(dirname(HERE));
const NOW = Date.parse('2025-06-01T10:00:00Z'), STEP = 60001;
const SELF = 'ou_synthetic_recipient_priority_owner', SELF_NAME = 'Synthetic Priority Owner';
const ACCOUNT = recipientAccountKey(SELF), TITLE = 'Synthetic Priority Group';
const OLD = 'ou_synthetic_recipient_priority_old_';
const peer = id => `ou_synthetic_recipient_priority_peer_${id}`;
const peerName = id => `Synthetic Priority Peer ${id}`;
const hash = value => createHash('sha256').update(value).digest('hex');
const rejectNetwork = () => { throw new Error('Synthetic recipient priority test forbids network'); };
globalThis.fetch = rejectNetwork; Socket.prototype.connect = rejectNetwork;

if (process.argv[2] === '--turn') {
  const db = process.argv[3], now = Number(process.argv[4]), calls = [];
  const metadataModes = JSON.parse(process.argv[5] || '{}');
  const result = syncNames(db, { open_id: SELF, name: SELF_NAME }, {
    now: () => now, monotonicNow: () => 0,
    runLark: (args, options) => {
      assert.equal(options.retries, 0);
      assert(options.timeoutMs > 0 && options.timeoutMs <= 5000);
      assert(options.retryBudgetMs > 0 && options.retryBudgetMs <= 10000);
      const call = { route: args.slice(0, 3).join(' ') }; calls.push(call);
      if (args[0] === 'contact' && args[1] === '+get-user') return { open_id: SELF, name: SELF_NAME };
      if (args[0] === 'contact' && args[1] === '+search-user') {
        const ids = args[args.indexOf('--user-ids') + 1].split(','); call.ids = ids;
        if (ids.some(id => id.startsWith(OLD))) throw new Error('lark-cli failed: kind=unknown operation=contact_search');
        return { users: ids.map(open_id => ({ open_id,
          name: open_id.includes('_peer_') ? peerName(open_id.split('_').at(-1)) : 'Synthetic New Sender' })) };
      }
      if (args.slice(0, 3).join(' ') === 'im chat.members get')
        throw new Error('lark-cli failed: kind=unknown operation=chat_members');
      if (args.slice(0, 3).join(' ') === 'im chats get') {
        const params = JSON.parse(args[args.indexOf('--params') + 1]); call.chat = params.chat_id;
        const mode = metadataModes[params.chat_id] || 'group';
        return { data: { chat_id: params.chat_id, chat_mode: mode, name: mode === 'group' ? TITLE : null } };
      }
      if (args[0] === 'api' && args[2] === '/open-apis/im/v1/chats/batch_query') {
        const ids = JSON.parse(args[args.indexOf('--data') + 1]).chat_ids; call.chats = ids;
        assert(ids.length <= 20);
        return { code: 0, data: { items: ids.map(chat_id => ({ chat_id, chat_mode: 'p2p',
          p2p_target_type: 'user', p2p_target_id: peer(chat_id.split('_').at(-1)) })) } };
      }
      assert.fail(`Unexpected synthetic route ${call.route}`);
    },
  });
  assert(result.calls <= 4); assert.equal(calls.length, result.calls);
  console.log(JSON.stringify({ result, calls, pid: process.pid, now }));
  process.exit(0);
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exo-recipient-priority-synthetic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = { dir, db: join(dir, 'authored.sqlite'), rows: [], turns: [], metadataModes: {} };
  ensureInitialized(f.db); reserveInitialLarkAccount(f.db, ACCOUNT, new Date().toISOString());
  sqliteExec(f.db, confirmInitialLarkAccountSql(new Date().toISOString()));
  writeFileSync(join(dir, 'reject-cli'), '#!/bin/sh\nprintf called > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
  writeFileSync(join(dir, 'deny-network.mjs'), `import {writeFileSync} from 'node:fs';import {Socket} from 'node:net';
const deny=()=>{writeFileSync(process.env.SYNTHETIC_NETWORK_MARKER,'called');throw new Error('Synthetic read forbids network')};
globalThis.fetch=deny;Socket.prototype.connect=deny;Object.defineProperty(process.stdout,'columns',{value:120,configurable:true});\n`);
  return f;
}
function add(f, id, { kind = 'recipient', actor = kind === 'sender' ? `${OLD}${id}` : SELF,
  direction = kind === 'sender' ? 'received' : 'sent', mode = kind === 'recipient' ? 'p2p' : 'group',
  known = kind !== 'sender', invalidRawIdentity = false, omitMode = false } = {}) {
  const external = `om_r${String(id).padStart(4, '0')}_synthetic_priority`;
  const container = `oc_synthetic_recipient_priority_${id}`, at = NOW - 86400000 + id;
  const body = `Synthetic priority body ${id}.`;
  const name = actor === SELF ? SELF_NAME : 'Synthetic Native Sender';
  const raw = { message_id: invalidRawIdentity ? external + '_mismatch' : external,
    chat_id: container, ...(omitMode ? {} : { chat_type: mode }), msg_type: 'text', create_time: String(at),
    update_time: String(at + 1), sender: { id: actor, id_type: 'open_id', sender_type: 'user', ...(known ? { name } : {}) },
    body: { content: JSON.stringify({ text: body }) } };
  const canonical = { message_id: external, chat_id: container, ...(omitMode ? {} : { chat_type: mode }), msg_type: 'text',
    sender_id: actor, sender_id_type: 'open_id', sender_type: 'user', sender_name: known ? name : null,
    ...(kind === 'chat' ? { chat_name: null } : mode === 'group' || mode === 'topic' ? { chat_name_state: 'cleared' } : {}) };
  const row = { id, source_id: 'lark.im', first_seen_scope_id: 'lark.im.sent_by_me', external_id: external,
    external_version: String(at + 1), record_type: 'lark.im.message', occurred_at: new Date(at).toISOString(),
    occurred_at_ms: at, actor_id: actor, container_id: container, direction, body,
    content_hash: hash(JSON.stringify(raw)), canonical_json: JSON.stringify(canonical), raw_json: JSON.stringify(raw) };
  const columns = Object.keys(row);
  sqliteExec(f.db, `INSERT INTO records(${columns.join(',')}) VALUES(${columns.map(key => q(row[key])).join(',')});`);
  f.rows.push(row); return row;
}
function seedOld(f, row) {
  sqliteExec(f.db, `INSERT INTO lark_im_name_tasks(source_id,account_key,task_key,kind,chat_id,actor_id,
    namespace,latest_record_id,retry_at_ms,enqueued_at_ms,fresh_required_record_id,outcome,failures,schedule_failures)
    VALUES('lark.im',${q(ACCOUNT)},${q(nameTaskKey('sender', row.container_id, row.actor_id, 'open_id'))},
    'sender',${q(row.container_id)},${q(row.actor_id)},'open_id',${row.id},${NOW - 1},${NOW - 86400000},${row.id},'failed',1,1);`);
}
function turn(f, now) {
  const child = spawnSync(process.execPath, [HERE, '--turn', f.db, String(now), JSON.stringify(f.metadataModes)], {
    cwd: f.dir, encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, LARK_CLI: join(f.dir, 'reject-cli'), SYNTHETIC_NETWORK_MARKER: join(f.dir, 'network') },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout); assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout); f.turns.push(result); return result;
}
function observe(f) {
  sqliteExec(f.db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  const before = hash(readFileSync(f.db)), files = readdirSync(f.dir).sort();
  const read = format => {
    const child = spawnSync(process.execPath, ['--import', join(f.dir, 'deny-network.mjs'), join(ROOT, 'bin/exocortex.mjs'),
      'messages', '--db', f.db, '--format', format, '--limit', '100'], {
      cwd: f.dir, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, TZ: 'UTC', NO_COLOR: '1', LARK_CLI: join(f.dir, 'reject-cli'), SYNTHETIC_NETWORK_MARKER: join(f.dir, 'network') },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout); assert.equal(child.stderr, '');
    return child.stdout;
  };
  const rows = JSON.parse(read('json')), text = read('text');
  assert.equal(hash(readFileSync(f.db)), before); assert.deepEqual(readdirSync(f.dir).sort(), files);
  assert(!existsSync(join(f.dir, 'network')));
  const ordered = [...f.rows].sort((a, b) => b.occurred_at_ms - a.occurred_at_ms
    || (a.external_id < b.external_id ? 1 : a.external_id > b.external_id ? -1 : 0));
  assert.deepEqual(rows.map(row => row.external_id), ordered.map(row => row.external_id), 'all source versions stay in the denominator and order');
  for (const original of f.rows) {
    const actual = rows.find(row => row.external_id === original.external_id);
    for (const key of ['id', 'source_id', 'external_id', 'direction', 'body', 'occurred_at', 'occurred_at_ms'])
      assert.equal(actual[key], original[key], key);
    assert.deepEqual(actual.raw, JSON.parse(original.raw_json));
  }
  return { rows, text };
}
function isReady(observation, row) {
  const actual = observation.rows.find(value => value.external_id === row.external_id);
  const prefix = row.external_id.slice(0, 8), start = observation.text.indexOf(prefix);
  assert(start >= 0); const tail = observation.text.slice(start), nextHeader = tail.slice(1).search(/\n(?:SENT|RECEIVED) /);
  const block = nextHeader < 0 ? tail : tail.slice(0, nextHeader + 1);
  return actual.readiness.state === 'ready' && actual.display.sender === SELF_NAME
    && actual.display.recipient === peerName(row.id) && block.includes(`接收人  ${peerName(row.id)}`)
    && block.includes(`消息    ${row.body}`);
}

for (const startSlot of [0, 2]) test(`latest private recipient becomes readable within two opportunities despite twelve old failed senders (start slot ${startSlot})`, t => {
  const f = fixture(t);
  sqliteExec(f.db, `INSERT INTO lark_im_name_scan(account_key,schedule_slot) VALUES(${q(ACCOUNT)},${startSlot});`);
  for (let id = 1; id <= 12; id++) seedOld(f, add(f, id, { kind: 'sender' }));
  const fresh = add(f, 13), initial = observe(f);
  const recipients = [fresh];
  const countServedOld = () => sqliteQuery(f.db, `SELECT COUNT(*) AS n FROM lark_im_name_tasks WHERE kind='sender'
    AND actor_id LIKE ${q(OLD + '%')} AND last_attempt_at_ms>=${NOW};`)[0].n;
  assert.equal(initial.rows.length, 13); assert.equal(isReady(initial, fresh), false);
  let firstReady = null, lastObservation = initial;
  for (let opportunity = 0; opportunity < 2; opportunity++) {
    const at = NOW + opportunity * STEP; turn(f, at);
    lastObservation = observe(f);
    if (isReady(lastObservation, fresh) && firstReady === null) firstReady = at;
    if (opportunity === 0) {
      const beforeMinute = turn(f, NOW + 59999);
      assert.equal(beforeMinute.result.reason, 'cadence'); assert.equal(beforeMinute.result.calls, 0);
    }
  }
  assert(firstReady !== null && firstReady - NOW <= STEP,
    `latest recipient must be ready within two admitted opportunities; denominator=${f.rows.length}, turns=${JSON.stringify(f.turns.map(x => ({ now: x.now, result: x.result, routes: x.calls.map(c => c.route) })))}, readiness=${JSON.stringify(lastObservation.rows.find(row => row.id === fresh.id)?.readiness)}, text=${JSON.stringify(lastObservation.text.slice(0,350))}`);
  const unchangedGate = turn(f, NOW + STEP + 1);
  assert.equal(unchangedGate.result.reason, 'cadence'); assert.equal(unchangedGate.result.calls, 0);
  const oldBeforeContinuousArrivals = countServedOld(); let continuousFairTurns = 0;
  for (let opportunity = 2; opportunity < 8; opportunity++) {
    recipients.push(add(f, 12 + opportunity));
    const before = countServedOld(), slot = sqliteQuery(f.db,
      `SELECT schedule_slot FROM lark_im_name_scan WHERE account_key=${q(ACCOUNT)};`)[0].schedule_slot;
    assert.equal(slot, (startSlot + opportunity) % 3, 'cadence rejections must not advance scheduler slots');
    turn(f, NOW + opportunity * STEP); observe(f);
    if (slot === 2) {
      continuousFairTurns++;
      assert(countServedOld() > before, 'each fair slot must serve old work while new private messages keep arriving');
    }
  }
  assert.equal(continuousFairTurns, 2);
  assert(countServedOld() >= oldBeforeContinuousArrivals + continuousFairTurns,
    'old service must advance during continuous fresh arrivals, independently of initial idle capacity');
  assert.equal(new Set(f.turns.map(value => value.pid)).size, f.turns.length);
  assert(f.turns.every(value => value.result.calls <= 4));
  const after = observe(f); assert.equal(after.rows.length, 19);
  assert.equal(after.rows.filter(row => row.readiness.state === 'ready').length, 7);
  assert.equal(after.rows.filter(row => row.readiness.state !== 'ready').length, 12);
  for (const recipient of recipients) assert(isReady(after, recipient),
    `recipient ${recipient.id} must have its own exact peer name and body in JSON and text`);
  assert.equal(sqliteQuery(f.db, "SELECT COUNT(*) AS n FROM lark_im_name_tasks WHERE kind='chat';")[0].n, 0);
});

for (const variant of ['exact group scope', 'fractional event timestamp'])
test(`a higher record ID with ${variant} cannot inflate recipient priority`, t => {
  const f = fixture(t), recipient = add(f, 1);
  const actor = 'ou_synthetic_recipient_priority_new_sender';
  add(f, 2, { kind: 'sender', actor });
  const ineligible = add(f, 3, variant === 'exact group scope' ? { mode: 'unknown' } : {});
  if (variant === 'exact group scope') {
    sqliteExec(f.db, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(
      ${q(chatScopeId(ineligible.container_id))},'lark.im','Synthetic exact scope',
      ${q(JSON.stringify({ chat_id: ineligible.container_id, chat_type: 'group', chat_name: TITLE }))});`);
  } else {
    ineligible.occurred_at_ms = 0.5;
    sqliteExec(f.db, 'UPDATE records SET occurred_at_ms=0.5 WHERE id=3;');
  }
  const first = turn(f, NOW);
  assert(first.calls.some(call => call.ids?.includes(actor)),
    'the middle eligible sender must outrank the older eligible recipient');
  assert(!first.calls.some(call => call.chats),
    'a witness rejected by recipient execution must not lend its higher ID to recipient priority');
  const second = turn(f, NOW + STEP);
  assert(second.calls.some(call => call.chats?.includes(recipient.container_id)));
  assert(!second.calls.some(call => call.chats?.includes(ineligible.container_id)),
    'the same ineligible witness must remain excluded by actual recipient execution');
  const current = observe(f); assert.equal(current.rows.length, 3);
  assert(isReady(current, recipient));
});

for (const kind of ['sender', 'chat']) test(`a genuinely newer fresh ${kind} precedes the recipient, which completes next`, t => {
  const f = fixture(t), recipient = add(f, 1);
  add(f, 2, { kind, ...(kind === 'sender' ? { actor: 'ou_synthetic_recipient_priority_new_sender' } : {}) });
  const first = turn(f, NOW);
  assert(!first.calls.some(call => call.chats), 'the newer eligible role wins the first priority turn');
  assert(first.calls.some(call => kind === 'sender' ? call.ids?.includes('ou_synthetic_recipient_priority_new_sender') : call.chat));
  const second = turn(f, NOW + STEP);
  assert(second.calls.some(call => call.chats?.includes(recipient.container_id)));
  assert.equal(second.result.calls, 4);
  assert(isReady(observe(f), recipient));
});

for (const [label, options] of [
  ['explicit group', { mode: 'group' }],
  ['explicit topic', { mode: 'topic' }],
  ['received direction', { direction: 'received' }],
  ['contradictory native message identity', { invalidRawIdentity: true }],
]) test(`a higher record ID with ${label} cannot inflate recipient priority`, t => {
  const f = fixture(t), recipient = add(f, 1);
  const actor = 'ou_synthetic_recipient_priority_new_sender';
  add(f, 2, { kind: 'sender', actor }); add(f, 3, options);
  const first = turn(f, NOW);
  assert(first.calls.some(call => call.ids?.includes(actor)), 'the middle eligible sender must outrank the older eligible recipient');
  assert(!first.calls.some(call => call.chats), 'unqualified highest ID must not lend its rank to recipient work');
  turn(f, NOW + STEP);
  const current = observe(f); assert.equal(current.rows.length, 3);
  assert(isReady(current, recipient));
});

test('a higher foreign sent actor preserves whole-source account rejection before scheduling', t => {
  const f = fixture(t); add(f, 1);
  add(f, 2, { kind: 'sender', actor: 'ou_synthetic_recipient_priority_new_sender' });
  add(f, 3, { actor: 'ou_synthetic_recipient_priority_foreign' });
  const first = turn(f, NOW);
  assert.equal(first.result.reason, 'unavailable', JSON.stringify(first));
  assert.equal(first.result.calls, 0);
  for (const table of ['lark_im_name_scan', 'lark_im_name_tasks', 'lark_im_recipient_state'])
    assert.equal(sqliteQuery(f.db, `SELECT COUNT(*) AS n FROM ${table};`)[0].n, 0, 'account conflict cannot reserve or claim work');
  assert.equal(observe(f).rows.length, 3, 'the conflicting source version remains visible in the denominator');
});

test('a fresh sent message without a declared mode still reaches exact p2p evidence within two opportunities', t => {
  const f = fixture(t);
  for (let id = 1; id <= 12; id++) seedOld(f, add(f, id, { kind: 'sender' }));
  const fresh = add(f, 13, { omitMode: true }); f.metadataModes[fresh.container_id] = 'p2p';
  assert(!Object.hasOwn(JSON.parse(fresh.raw_json), 'chat_type'));
  assert(!Object.hasOwn(JSON.parse(fresh.canonical_json), 'chat_type'));
  for (let opportunity = 0; opportunity < 2; opportunity++) turn(f, NOW + opportunity * STEP);
  const current = observe(f);
  assert.equal(current.rows.length, 13);
  assert(isReady(current, fresh), JSON.stringify(current.rows.find(row => row.id === fresh.id)?.readiness));
  assert(f.turns.some(value => value.calls.some(call => call.chats?.includes(fresh.container_id))));
});
