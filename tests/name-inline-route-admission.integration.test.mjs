import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';
import { createSyncRunner } from '../src/adapters/lark-im/sync-runner.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { nameRouteDescriptor, nextNameRouteState } from '../src/adapters/lark-im/name-route-state.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import {
  confirmInitialLarkAccountSql, ensureInitialized, quoteSql, readScope,
  reserveInitialLarkAccount, sqliteExec, sqliteQuery,
} from '../dist/storage/sqlite/ingestion-store.js';

// Authored source/API/route data only. The two-batch case preserves the original
// independent counterexample's 12 denied apps + 1 fresh person, 26 records and
// 24 exact route rows. Only the remote transport is synthetic; normalization,
// resolver admission, storage, CLI parsing, readiness and rendering are real.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = { open_id: 'ou_synthetic_inline_owner', name: 'Synthetic Inline Owner' };
const ACCOUNT = recipientAccountKey(SELF.open_id);
const FOREIGN_ACCOUNT = recipientAccountKey('ou_synthetic_inline_other_owner');
const CHAT = 'oc_synthetic_inline_group', OTHER_CHAT = 'oc_synthetic_inline_other_group';
const TITLE = 'Synthetic Inline Group', FRESH = 'ou_synthetic_inline_fresh';
const FRESH_NAME = 'Synthetic Fresh Reader';
const APPS = Array.from({ length: 12 }, (_, index) => `cli_synthetic_inline_old_${index}`);
const page = items => ({ ok: true, data: { items, has_more: false } });
const hash = value => createHash('sha256').update(value).digest('hex');
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const canonical = row => JSON.parse(row.canonical_json);
const isContact = args => args[0] === 'contact' && args[1] === '+search-user';
const isApplication = args => args[0] === 'api' && args[1] === 'GET'
  && args[2].startsWith('/open-apis/application/v6/applications/');
const isBots = args => args.slice(0, 3).join(' ') === 'im chat.members bots';
const isName = args => isContact(args) || isApplication(args) || isBots(args)
  || args.slice(0, 3).join(' ') === 'im chat.members get';
const params = args => JSON.parse(args[args.indexOf('--params') + 1]);

function fixture(t, chats = [CHAT]) {
  const directory = mkdtempSync(join(tmpdir(), 'exocortex-inline-route-synthetic-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const oldFetch = globalThis.fetch, oldConnect = Socket.prototype.connect;
  const deny = () => { throw new Error('synthetic inline acceptance forbids network'); };
  globalThis.fetch = deny; Socket.prototype.connect = deny;
  t.after(() => { globalThis.fetch = oldFetch; Socket.prototype.connect = oldConnect; });
  const db = join(directory, 'synthetic.sqlite'), now = Date.now(), start = now - 120_000;
  ensureInitialized(db);
  reserveInitialLarkAccount(db, ACCOUNT, new Date(now).toISOString());
  sqliteExec(db, confirmInitialLarkAccountSql(new Date(now).toISOString()));
  sqliteExec(db, `UPDATE sources SET config_json=json_set(config_json,'$.initial_sync_start_ms',${start})
    WHERE id='lark.im';
    ${chats.map((chat, index) => `INSERT INTO sync_scopes(id,source_id,name,config_json)
      VALUES(${quoteSql(chatScopeId(chat))},'lark.im',${quoteSql(`Synthetic inline scope ${index}`)},
        ${quoteSql(JSON.stringify({ chat_id: chat, chat_type: 'group', chat_name: TITLE }))});`).join('\n')}`);
  const guard = join(directory, 'deny-network.mjs'), attempted = join(directory, 'unexpected-lark-call');
  writeFileSync(guard, "import {Socket} from 'node:net'; const deny=()=>{throw new Error('synthetic messages forbids network')};globalThis.fetch=deny;Socket.prototype.connect=deny;\n");
  const rejectLark = join(directory, 'reject-lark');
  writeFileSync(rejectLark, `#!/bin/sh\nprintf attempted > ${shellQuote(attempted)}\nexit 97\n`, { mode: 0o700 });
  return { directory, db, now, start, guard, attempted, rejectLark };
}

function seedBlocked(f, actor, operations = ['application_info', 'chat_bots'], chat = CHAT, account = ACCOUNT) {
  for (const operation of operations) {
    const route = nameRouteDescriptor({ source_id: 'lark.im', account_key: account, kind: 'sender',
      chat_id: chat, actor_id: actor, namespace: 'app_id' }, operation);
    assert(route);
    const { row } = nextNameRouteState(route, null, {
      type: 'failure', error: new Error(`lark-cli failed: kind=permission_denied code=210508 operation=${operation}`),
    }, { nowMs: f.start });
    row.retry_at_ms = f.start + 86_400_000;
    row.generation = 7;
    assert.equal(row.blocked, 1); assert(row.retry_at_ms > Date.now());
    const keys = Object.keys(row);
    sqliteExec(f.db, `INSERT INTO lark_im_name_routes(${keys.join(',')})
      VALUES(${keys.map(key => quoteSql(row[key])).join(',')});`);
  }
}

const routes = f => sqliteQuery(f.db, 'SELECT * FROM lark_im_name_routes ORDER BY account_key,route_key;');
const stored = f => sqliteQuery(f.db, 'SELECT * FROM records ORDER BY occurred_at_ms DESC,external_id DESC;');
const options = (f, batch = 0) => ({ startMs: f.start, endMs: f.start + (batch + 1) * 60_000,
  endExplicit: true, stableHorizonSeconds: 30, pageSize: 50, maxPages: 2, chatPageSize: 100,
  chatTypes: 'group', lockTtlSeconds: 600, retries: 0, retryDelayMs: 0 });

function native(f, index, actor = FRESH, { batch = 0, chat = CHAT, type = 'text' } = {}) {
  const at = f.start + batch * 60_000 + index + 1000;
  return { message_id: `om_i${String(batch * 13 + index).padStart(4, '0')}_synthetic`,
    chat_id: chat, msg_type: type, create_time: String(at), update_time: String(at + 1),
    sender: { id: actor, id_type: actor === FRESH ? 'open_id' : 'app_id', sender_type: actor === FRESH ? 'user' : 'app' },
    body: { content: JSON.stringify({ text: `Synthetic batch ${batch} body ${index}; spacing  stays.` }) } };
}

function makeRunner(handler) {
  const calls = [], preparations = [];
  let active = null;
  const adapter = createLarkImAdapter({ run(args, opts) {
    calls.push({ args: [...args], options: { ...opts }, atMs: Date.now(), preparation: active });
    return handler(args, opts);
  } });
  const runner = createSyncRunner({ ...adapter, buildPeopleContext(messages, opts, self, config) {
    const preparation = { atMs: Date.now(), deadlineMs: opts.nameLookupDeadlineMs };
    preparations.push(preparation); active = preparation;
    try { return adapter.buildPeopleContext(messages, opts, self, config); }
    finally { active = null; }
  } });
  return { runner, calls, preparations };
}

function assertBoundedPreparation(capture) {
  for (const preparation of capture.preparations) {
    assert(Number.isSafeInteger(preparation.deadlineMs), 'the real list/detail caller supplies one batch deadline');
    assert(preparation.deadlineMs > preparation.atMs);
    assert(preparation.deadlineMs - preparation.atMs <= 5000, 'the whole preparation has at most five seconds');
  }
  for (const call of capture.calls.filter(value => isName(value.args))) {
    assert(call.preparation, 'every inline name call belongs to the captured real preparation');
    assert(Number.isInteger(call.options.timeoutMs) && call.options.timeoutMs > 0 && call.options.timeoutMs <= 5000);
    assert(Number.isInteger(call.options.retryBudgetMs) && call.options.retryBudgetMs > 0 && call.options.retryBudgetMs <= 5000);
    assert.equal(call.options.timeoutMs, call.options.retryBudgetMs);
    assert(call.options.timeoutMs <= call.preparation.deadlineMs - call.preparation.atMs);
    assert.equal(call.options.retries, 0);
  }
}

function actualMessages(f, limit) {
  const before = stored(f), routeBefore = routes(f), beforeHash = hash(readFileSync(f.db));
  const invoke = format => {
    const result = spawnSync(process.execPath, ['--import', f.guard, join(ROOT, 'bin/exocortex.mjs'),
      'messages', '--db', f.db, '--limit', String(limit), '--format', format], {
      cwd: f.directory, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LARK_CLI: f.rejectLark, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(result.stderr, '');
    return result.stdout;
  };
  const json = JSON.parse(invoke('json')), text = invoke('text');
  const expectedIds = before.slice(0, limit).map(row => row.external_id);
  assert.deepEqual(json.map(row => row.external_id), expectedIds, 'unknown senders do not disappear from the selected page');
  const matches = [...text.matchAll(/om_i\d{4}\b/g)];
  assert.deepEqual(matches.map(match => match[0]), expectedIds.map(id => id.slice(0, 8)), 'text keeps every selected header in order');
  const block = id => {
    const index = matches.findIndex(match => match[0] === id.slice(0, 8)); assert(index >= 0);
    return text.slice(matches[index].index, matches[index + 1]?.index);
  };
  assert.equal(hash(readFileSync(f.db)), beforeHash, 'actual messages is read-only');
  assert.deepEqual(stored(f), before); assert.deepEqual(routes(f), routeBefore);
  assert.equal(existsSync(f.attempted), false, 'messages never starts the external name CLI');
  return { json, text, block };
}

function assertSourceRows(f, originals, mergeItems = new Map()) {
  const rows = stored(f);
  assert.equal(rows.length, originals.length);
  for (const source of originals) {
    const row = rows.find(value => value.external_id === source.message_id); assert(row);
    const expected = recordFromMessage(normalizeApiMessage(source, mergeItems.has(source.message_id)
      ? { mergeItems: mergeItems.get(source.message_id) } : {}), chatScopeId(source.chat_id), 'received', {},
    { chat_id: source.chat_id, chat_type: 'group', chat_name: TITLE });
    for (const key of ['source_id', 'record_type', 'external_id', 'external_version', 'body', 'raw_json',
      'content_hash', 'occurred_at', 'occurred_at_ms', 'actor_id', 'container_id', 'direction']) {
      assert.equal(row[key], expected[key], key);
    }
  }
}

function assertReady(view, source, name) {
  const row = view.json.find(value => value.external_id === source.message_id); assert(row);
  assert.equal(row.display.sender, source.sender.sender_type === 'app' ? `应用：${name}` : name);
  assert.equal(row.display.chat, TITLE); assert.equal(row.display.recipient, null);
  assert.equal(row.readiness.version, 1); assert.equal(row.readiness.state, 'ready');
  assert.deepEqual(row.readiness.requirements.map(value => value.field), ['sender', 'recipient', 'conversation', 'content']);
  assert.deepEqual(row.readiness.requirements.map(value => value.state), ['satisfied', 'not_applicable', 'satisfied', 'satisfied']);
  assert.deepEqual(row.readiness.reasons, []); assert.equal(row.readiness.next_action, 'none');
  const text = view.block(source.message_id);
  assert(text.includes(`  发送人  ${row.display.sender}\n`)); assert(text.includes(`  群      ${TITLE}\n`));
  assert(!text.includes('  状态    ')); assert(!text.includes('  接收人'));
  assert.equal(row.actor_id, source.sender.id); assert.equal(row.occurred_at_ms, Number(source.create_time));
  return row;
}

test('two real received batches skip all 24 isolated routes while preserving 26 messages and fresh readiness', t => {
  const f = fixture(t);
  for (const actor of APPS) seedBlocked(f, actor);
  const routeBefore = routes(f), originals = [];
  assert.equal(routeBefore.length, 24);
  let contactCalls = 0;
  for (let batch = 0; batch < 2; batch++) {
    const sources = [...APPS, FRESH].map((actor, index) => native(f, index, actor, { batch }));
    originals.push(...sources);
    const capture = makeRunner(args => {
      if (args[2] === '/open-apis/im/v1/messages') { assert.equal(params(args).container_id, CHAT); return page(sources); }
      if (isContact(args)) {
        assert.equal(args[args.indexOf('--user-ids') + 1], FRESH); contactCalls++;
        return { users: [{ open_id: FRESH, name: FRESH_NAME }] };
      }
      if (isApplication(args) || isBots(args)) throw new Error(`lark-cli failed: kind=permission_denied code=210508 operation=${isApplication(args) ? 'application_info' : 'chat_bots'}`);
      throw new Error('unexpected synthetic inline request');
    });
    const outcome = capture.runner.syncReceivedScope(f.db, options(f, batch), readScope(f.db, chatScopeId(CHAT)), SELF);
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(capture.calls.filter(call => isApplication(call.args) || isBots(call.args)).length, 0,
      'new messages cannot bypass already isolated app or bot routes');
    assert.equal(capture.calls.filter(call => isName(call.args)).length, batch === 0 ? 1 : 0,
      'the repeated fresh actor may use its exact persisted local authority');
    assert.equal(capture.calls.filter(call => call.args[2] === '/open-apis/im/v1/messages').length, 1);
    assertBoundedPreparation(capture);
    assert.deepEqual(routes(f), routeBefore, 'inline admission never resets retry, failure, generation or route outcome');
    assertSourceRows(f, originals);
    const view = actualMessages(f, 13);
    assert.equal(view.json.length, 13);
    assertReady(view, sources[12], FRESH_NAME);
    assert.equal(view.json.filter(row => row.readiness.state === 'ready').length, 1);
    for (const source of sources.slice(0, 12)) {
      const row = view.json.find(value => value.external_id === source.message_id); assert(row);
      assert.notEqual(row.readiness.state, 'ready'); assert.equal(canonical(stored(f).find(value => value.id === row.id)).sender_name, null);
      assert.deepEqual(row.raw.raw_api || row.raw, source);
      assert.equal(row.display.body, JSON.parse(source.body.content).text);
      const block = view.block(source.message_id);
      assert(block.includes('  状态    ')); assert(block.includes('  原因    '));
      assert(block.includes('messages --format json')); assert(!block.includes(`  发送人  ${FRESH_NAME}`));
    }
  }
  assert.equal(contactCalls, 1);
  assert.equal(stored(f).length, 26); assert.equal(routes(f).length, 24);
  const all = actualMessages(f, 26);
  assert.equal(all.json.length, 26); assert.equal(all.json.filter(row => row.readiness.state === 'ready').length, 2);
  assert.equal(all.json.filter(row => row.readiness.state !== 'ready').length, 24);
});

for (const blocked of [true, false]) {
  test(`actual merge-forward detail preparation ${blocked ? 'skips isolated app routes' : 'resolves its fresh human'} before first CLI read`, t => {
    const f = fixture(t), actor = blocked ? APPS[0] : FRESH;
    if (blocked) seedBlocked(f, actor);
    const routeBefore = routes(f), root = native(f, 0, actor, { type: 'merge_forward' });
    root.body = { content: 'Synthetic complete merge-forward root.' };
    const child = { ...native(f, 1, actor), upper_message_id: root.message_id };
    const capture = makeRunner(args => {
      if (args[2] === '/open-apis/im/v1/messages') return page([root]);
      if (args[2] === `/open-apis/im/v1/messages/${root.message_id}`) return page([root, child]);
      if (isContact(args)) return { users: [{ open_id: FRESH, name: FRESH_NAME }] };
      if (isApplication(args) || isBots(args)) throw new Error(`lark-cli failed: kind=permission_denied code=210508 operation=${isApplication(args) ? 'application_info' : 'chat_bots'}`);
      throw new Error('unexpected synthetic detail request');
    });
    const outcome = capture.runner.syncReceivedScope(f.db, options(f), readScope(f.db, chatScopeId(CHAT)), SELF);
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(capture.calls.filter(call => isApplication(call.args) || isBots(call.args)).length, 0);
    assert.equal(capture.calls.filter(call => isContact(call.args)).length, blocked ? 0 : 1);
    assert.equal(capture.calls.filter(call => !isName(call.args)).length, 2, 'only list and exact detail acquisition');
    assertBoundedPreparation(capture); assert.deepEqual(routes(f), routeBefore);
    assertSourceRows(f, [root], new Map([[root.message_id, [root, child]]]));
    const view = actualMessages(f, 1);
    if (blocked) {
      assert.notEqual(view.json[0].readiness.state, 'ready');
      assert(view.block(root.message_id).includes('  状态    '));
    } else assertReady(view, root, FRESH_NAME);
    assert.equal(sqliteQuery(f.db, "SELECT COUNT(*) AS n FROM lark_im_detail_tasks WHERE status='pending';")[0].n, 0);
  });
}

for (const mode of ['different actor', 'different account', 'different scoped chat']) {
  test(`inline route isolation does not suppress a ${mode} with exact successful authority`, t => {
    const f = fixture(t, [CHAT, OTHER_CHAT]);
    const actor = mode === 'different actor' ? 'cli_synthetic_inline_other_app' : APPS[0];
    const chat = mode === 'different scoped chat' ? OTHER_CHAT : CHAT;
    seedBlocked(f, APPS[0], ['application_info', 'chat_bots'], CHAT,
      mode === 'different account' ? FOREIGN_ACCOUNT : ACCOUNT);
    const routeBefore = routes(f), source = native(f, 0, actor, { chat });
    const expectedName = 'Synthetic Independent Application';
    const capture = makeRunner(args => {
      if (args[2] === '/open-apis/im/v1/messages') { assert.equal(params(args).container_id, chat); return page([source]); }
      if (isApplication(args)) {
        assert.equal(args[2].split('/').at(-1), actor);
        return { app: { app_id: actor, app_name: expectedName } };
      }
      if (isBots(args)) {
        assert.equal(params(args).chat_id, OTHER_CHAT);
        return { items: [{ app_id: actor, bot_name: expectedName }], has_more: false };
      }
      throw new Error('unexpected synthetic independent route');
    });
    const outcome = capture.runner.syncReceivedScope(f.db, options(f), readScope(f.db, chatScopeId(chat)), SELF);
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(capture.calls.filter(call => isApplication(call.args)).length, mode === 'different scoped chat' ? 0 : 1,
      'application authority is actor/account scoped, not chat scoped');
    assert.equal(capture.calls.filter(call => isBots(call.args)).length, mode === 'different scoped chat' ? 1 : 0,
      'a denied chat bot route cannot suppress another exact chat');
    assertBoundedPreparation(capture); assert.deepEqual(routes(f), routeBefore);
    assertSourceRows(f, [source]);
    assertReady(actualMessages(f, 1), source, expectedName);
  });
}
