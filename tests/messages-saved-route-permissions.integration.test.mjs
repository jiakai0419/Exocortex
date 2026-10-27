import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { ensureInitialized, quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';
import { readMessageSnapshot } from '../src/diagnostics/message-read-snapshot.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { bindAcquiredMessageAccounts } from '../src/adapters/lark-im/message-account-evidence.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { nameRouteDescriptor, nextNameRouteState } from '../src/adapters/lark-im/name-route-state.mjs';
import { senderNameRouteTargetKey } from '../src/adapters/lark-im/sender-name-observation.mjs';
import { readSavedSenderRouteBlockers, readSavedSenderRouteEvidence } from '../src/adapters/lark-im/saved-sender-route-failures.mjs';

// All records, route receipts, identities, accounts and names are invented.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AT = Date.UTC(2025, 2, 4, 5, 6, 7), ROUTE_AT = AT + 10000;
const SELF = { open_id: 'ou_synthetic_saved_route_owner', name: 'Invented Route Owner' };
const ACCOUNT = recipientAccountKey(SELF.open_id), OTHER = recipientAccountKey('ou_synthetic_saved_route_foreign');
const CHAT = 'oc_synthetic_saved_route_room', TITLE = 'Invented Saved Route Room';
const operations = ['application_info', 'chat_bots'];
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function edit(row, field, fn) { const value = JSON.parse(row[field]); fn(value); row[field] = JSON.stringify(value); }
function target(id, { self = SELF, nativeName = null } = {}) {
  const actor = `cli_synthetic_saved_route_${id}`;
  const native = { message_id: `om_r${String(id).padStart(4, '0')}_synthetic_route`, chat_id: CHAT, chat_type: 'group',
    msg_type: 'text', create_time: String(AT + id), update_time: String(AT + id + 1),
    sender: { id: actor, id_type: 'app_id', sender_type: 'app', ...(nativeName ? { name: nativeName } : {}) },
    body: { content: JSON.stringify({ text: `Invented route body ${id}.` }) } };
  let row = recordFromMessage(normalizeApiMessage(native), 'lark.im.sent_by_me', 'received', {},
    { chat_id: CHAT, chat_type: 'group', chat_name: TITLE });
  [row] = bindAcquiredMessageAccounts([row], self, { acquiredAt: new Date(AT + 5000).toISOString() });
  assert(JSON.parse(row.canonical_json).message_account_evidence, 'fixture has valid exact acquisition proof');
  return { ...row, id };
}
function task(row, overrides = {}) {
  return { source_id: 'lark.im', account_key: JSON.parse(row.canonical_json).message_account_evidence?.account_key || ACCOUNT,
    kind: 'sender', actor_id: row.actor_id, namespace: 'app_id', chat_id: row.container_id, ...overrides };
}
function denial(row, operation, overrides = {}) {
  const descriptor = nameRouteDescriptor(task(row, overrides), operation);
  assert(descriptor);
  return nextNameRouteState(descriptor, null, { type: 'failure',
    error: `lark-cli failed: kind=permission_denied code=210508 operation=${operation}` }, { nowMs: ROUTE_AT }).row;
}
function observation(row, fallback = 'not_requested', at = ROUTE_AT + 1000) {
  const primary = { version: 1, operation: 'application_info', kind: 'permission_denied', code: 210508, stage: 'response_error' };
  const second = fallback === 'permission' ? { ...primary, operation: 'chat_bots' }
    : fallback === 'transient' ? { version: 1, operation: 'chat_bots', kind: 'network_timeout', code: null, stage: 'request_error' } : null;
  return { status: 'failed', reason: 'request_failed', source: 'application_api', cached: false,
    observed_at: new Date(at).toISOString(), account_key: ACCOUNT, failure: primary,
    route_failures: { version: 1, attempt_key: hash(`invented-route-attempt-${row.id}`),
      target_key: senderNameRouteTargetKey(ACCOUNT, row.actor_id, CHAT), account_key: ACCOUNT,
      routes: [{ operation: 'application_info', status: 'failed', failure: primary },
        { operation: 'chat_bots', status: second ? 'failed' : fallback, failure: second }] } };
}
function data() {
  const entries = [], routes = [];
  function add(label, change = () => {}, state = 'enriching', reason = 'sender_name_missing') {
    const row = target(entries.length + 1), pair = operations.map(operation => denial(row, operation));
    const value = { label, row, routes: pair, state, reason };
    change(value); entries.push(value); routes.push(...value.routes);
  }
  add('both exact current routes denied', () => {}, 'blocked', 'permission_denied');
  add('only primary route denied', value => { value.routes.pop(); });
  add('fallback recovered', value => { value.routes[1] = nextNameRouteState(nameRouteDescriptor(task(value.row), 'chat_bots'),
    value.routes[1], { type: 'recover' }, { nowMs: ROUTE_AT + 1 }).row; });
  add('fallback transient', value => { Object.assign(value.routes[1], { failure_kind: 'network_timeout', failure_code: null, blocked: 0 }); });
  add('fallback unknown with same numeric code', value => { Object.assign(value.routes[1], { failure_kind: 'unknown', blocked: 0 }); });
  add('fallback command unavailable is not API permission', value => { Object.assign(value.routes[1], { failure_kind: 'command_unavailable', failure_code: null }); });
  add('wrong permission code', value => { value.routes[1].failure_code = 210509; });
  add('future observation clock', value => { value.routes[1].last_attempt_at_ms = Date.now() + 60000; });
  add('zero observation clock', value => { value.routes[1].last_attempt_at_ms = 0; });
  add('foreign account routes', value => { value.routes = operations.map(operation => denial(value.row, operation, { account_key: OTHER })); });
  add('foreign actor routes', value => { value.routes = operations.map(operation => denial(value.row, operation, { actor_id: 'cli_synthetic_other_actor' })); });
  add('foreign fallback chat', value => { value.routes[1] = denial(value.row, 'chat_bots', { chat_id: 'oc_synthetic_other_room' }); });
  add('wrong declared route operation', value => { value.routes[0].operation = 'chat_bots'; });
  add('wrong route hash', value => { value.routes[1].route_key = hash('invented unrelated route hash'); });
  add('foreign route source', value => { value.routes[1].source_id = 'synthetic.other'; });
  add('namespace-isolated human routes', value => { value.routes = ['contact_search', 'chat_members'].map(operation => {
    const descriptor = nameRouteDescriptor(task(value.row, { namespace: 'open_id' }), operation);
    return nextNameRouteState(descriptor, null, { type: 'failure', error: `lark-cli failed: kind=permission_denied code=210508 operation=${operation}` }, { nowMs: ROUTE_AT }).row;
  }); });
  add('no current acquisition proof', value => { edit(value.row, 'canonical_json', c => { delete c.message_account_evidence; }); });
  add('native name survives newer denied routes', value => { value.row = target(value.row.id, { nativeName: 'Invented Native App' }); }, 'ready', null);
  add('adopted exact name survives newer denied routes', value => { edit(value.row, 'canonical_json', c => {
    c.sender_name = 'Invented Adopted App'; c.sender_name_source = 'application_api'; c.sender_name_confidence = 'high'; c.sender_name_account_key = ACCOUNT;
  }); }, 'ready', null);
  add('explicit clear is not rewritten as permission', value => { edit(value.row, 'canonical_json', c => { c.sender_name_state = 'cleared'; }); }, 'blocked', 'name_explicitly_cleared');
  add('newer unattempted fallback supersedes old denials', value => { edit(value.row, 'canonical_json', c => { c.sender_name_verification = observation(value.row); }); });
  add('newer transient fallback supersedes old denials', value => { edit(value.row, 'canonical_json', c => { c.sender_name_verification = observation(value.row, 'transient'); }); });
  add('newer unresolved fallback supersedes old denials', value => { edit(value.row, 'canonical_json', c => { c.sender_name_verification = observation(value.row, 'unresolved'); }); });
  add('older unattempted fallback cannot erase current table denials', value => { edit(value.row, 'canonical_json', c => { c.sender_name_verification = observation(value.row, 'not_requested', ROUTE_AT - 1); }); }, 'blocked', 'permission_denied');
  add('newer exact double denial agrees', value => { edit(value.row, 'canonical_json', c => { c.sender_name_verification = observation(value.row, 'permission'); }); }, 'blocked', 'permission_denied');
  add('malformed newer companion cannot strengthen table diagnosis', value => { edit(value.row, 'canonical_json', c => {
    c.sender_name_verification = observation(value.row); c.sender_name_verification.route_failures.target_key = hash('invented mismatched target');
  }); });
  for (const result of ['success', 'transient', 'unknown']) add(`newer actual ${result} fallback supersedes old inline double denial`, value => {
    edit(value.row, 'canonical_json', c => { c.sender_name_verification = observation(value.row, 'permission', ROUTE_AT); });
    const descriptor = nameRouteDescriptor(task(value.row), 'chat_bots');
    const recovered = nextNameRouteState(descriptor, value.routes[1], { type: 'recover' }, { nowMs: ROUTE_AT + 1000 }).row;
    value.routes[1] = nextNameRouteState(descriptor, recovered, result === 'success' ? { type: 'success' }
      : { type: 'failure', error: `lark-cli failed: kind=${result === 'transient' ? 'network_timeout' : 'unknown'} operation=chat_bots` },
    { nowMs: ROUTE_AT + 2000 }).row;
  });
  for (const result of ['recover_only', 'later_denial_then_recover', 'equal_success', 'older_success', 'missing_primary', 'foreign_fallback'])
    add(`${result} cannot masquerade as a newer exact successful lookup`, value => {
      edit(value.row, 'canonical_json', c => { c.sender_name_verification = observation(value.row, 'permission', ROUTE_AT); });
      const descriptor = nameRouteDescriptor(task(value.row), 'chat_bots');
      if (result === 'recover_only') value.routes[1] = nextNameRouteState(descriptor, value.routes[1], { type: 'recover' }, { nowMs: ROUTE_AT + 1000 }).row;
      else if (result === 'later_denial_then_recover') {
        const later = { ...value.routes[1], last_attempt_at_ms: ROUTE_AT + 2000, generation: 2 };
        value.routes[1] = nextNameRouteState(descriptor, later, { type: 'recover' }, { nowMs: ROUTE_AT + 3000 }).row;
      } else if (['equal_success', 'older_success'].includes(result)) value.routes[1] = nextNameRouteState(descriptor, null,
        { type: 'success' }, { nowMs: ROUTE_AT - Number(result === 'older_success') }).row;
      else {
        value.routes[1] = nextNameRouteState(result === 'foreign_fallback'
          ? nameRouteDescriptor(task(value.row, { chat_id: 'oc_synthetic_foreign_recovery' }), 'chat_bots') : descriptor,
        null, { type: 'success' }, { nowMs: ROUTE_AT + 2000 }).row;
        if (result === 'missing_primary') value.routes.shift();
      }
    }, 'blocked', 'permission_denied');
  add('latest exact denied stays selected at limit one', () => {}, 'blocked', 'permission_denied');
  return { entries, routes };
}
function fixture(t, values, { missingTable = false, noIndex = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-saved-route-read-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite'), marker = join(directory, 'unexpected-network'), cli = join(directory, 'reject-cli'), guard = join(directory, 'reject-network.mjs');
  writeFileSync(cli, '#!/bin/sh\nprintf called > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
  writeFileSync(guard, `import {writeFileSync} from 'node:fs';import {Socket} from 'node:net';
const deny=()=>{writeFileSync(process.env.SYNTHETIC_NETWORK_MARKER,'called');throw Error('route test forbids network');};
globalThis.fetch=deny;Socket.prototype.connect=deny;Object.defineProperty(process.stdout,'columns',{value:120});\n`);
  ensureInitialized(db);
  if (noIndex) sqliteExec(db, 'ALTER TABLE lark_im_name_routes RENAME TO old_routes; CREATE TABLE lark_im_name_routes AS SELECT * FROM old_routes; DROP TABLE old_routes;');
  const insert = (table, row) => `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.values(row).map(value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : quoteSql(value)).join(',')});`;
  sqliteExec(db, 'PRAGMA ignore_check_constraints=ON;\n' + values.entries.map(value => insert('records', value.row)).join('\n')
    + values.routes.map(row => insert('lark_im_name_routes', row)).join('\n'));
  if (missingTable) sqliteExec(db, 'DROP TABLE lark_im_name_routes;');
  sqliteExec(db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  return { directory, db, marker, cli, guard };
}
function snapshot(f) {
  const dump = spawnSync('sqlite3', ['-readonly', f.db, '.dump'], { encoding: 'utf8', timeout: 10000 }); assert.equal(dump.status, 0, dump.stderr);
  return { hash: hash(readFileSync(f.db)), dump: dump.stdout, mtime: statSync(f.db).mtimeMs, files: readdirSync(f.directory).sort() };
}
function run(f, args) {
  const env = { ...process.env, TZ: 'UTC', NO_COLOR: '1', LARK_CLI: f.cli, SYNTHETIC_NETWORK_MARKER: f.marker }; delete env.FORCE_COLOR;
  const p = spawnSync(process.execPath, ['--import', f.guard, ...args], { cwd: f.directory, env, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(p.status, 0, p.stderr || p.stdout); assert.equal(p.stderr, ''); assert.equal(existsSync(f.marker), false); return p.stdout;
}
const messages = (f, format, limit = 100) => run(f, [join(ROOT, 'bin/exocortex.mjs'), 'messages', '--db', f.db, '--limit', String(limit), '--format', format]);
const header = row => `RECEIVED ${new Date(row.occurred_at).toLocaleString('en-US', { timeZone: 'UTC' })}  ${row.external_id.slice(0, 8)}...  群聊`;
const reasonLabel = { permission_denied: '来源权限不足', sender_name_missing: '发送人名称待补全', name_explicitly_cleared: '来源已清除名称' };

test('actual CLI and quality consume exact saved paired permission routes, keep positive names, and reject unrelated or superseded evidence', t => {
  const values = data(), f = fixture(t, values), before = snapshot(f), expected = [...values.entries].reverse();
  const rows = JSON.parse(messages(f, 'json')), text = messages(f, 'text');
  assert.deepEqual(rows.map(row => row.id), expected.map(value => value.row.id));
  for (const [index, value] of expected.entries()) {
    const got = rows[index];
    for (const field of ['id','source_id','external_id','actor_id','container_id','direction','occurred_at','occurred_at_ms','body','raw_json','canonical_json'])
      assert.equal(got[field], value.row[field], `${value.label}: ${field}`);
    assert.equal(got.display.body, value.row.body, value.label);
    assert.equal(got.readiness.state, value.state, value.label);
    assert.deepEqual(got.readiness.reasons, value.reason ? [value.reason] : [], value.label);
    assert.equal(got.readiness.next_action, value.reason === 'permission_denied' ? 'review_permissions'
      : value.state === 'ready' ? 'none' : value.reason === 'name_explicitly_cleared' ? 'review_explicit_clear' : 'resolve_sender', value.label);
    const start = text.indexOf(header(value.row)), end = index + 1 < expected.length ? text.indexOf(header(expected[index + 1].row)) : text.length;
    assert(start >= 0 && end > start, value.label);
    const block = text.slice(start, end).trimEnd();
    if (value.reason) assert.equal(block, `${header(value.row)}\n  状态    ${value.state === 'blocked' ? '准备受阻' : '等待完整信息'}\n  原因    ${reasonLabel[value.reason]}\n  查看    messages --format json 可检查已保存内容与原因`, value.label);
    else assert(block.includes(value.row.body) && block.includes(got.display.sender) && !block.includes('状态    '), value.label);
  }
  const counts = { captured: 0, enriching: 0, ready: 0, blocked: 0 }; for (const value of expected) counts[value.state]++;
  const quality = JSON.parse(run(f, ['--input-type=module', '-e', `import {collectQualityReport} from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/diagnostics/lark-im-quality-report.mjs')).href)};process.stdout.write(JSON.stringify(collectQualityReport(process.argv[1])));`, f.db]));
  assert.deepEqual(quality.completeness.counts, counts);
  assert.equal(quality.completeness.reasons.permission_denied, expected.filter(value => value.reason === 'permission_denied').length);
  assert.deepEqual(JSON.parse(messages(f, 'json', 1)), [rows[0]], 'limit one cannot skip a denied latest row');
  assert.deepEqual(snapshot(f), before, 'reading never changes records, routes, retry clocks, tasks, schema or files');
});

test('missing legacy route table or required bounded index keeps route evidence unknown', async t => {
  for (const option of [{ missingTable: true }, { noIndex: true }]) await t.test(JSON.stringify(option), t => {
    const row = target(1), f = fixture(t, { entries: [{ row }], routes: operations.map(operation => denial(row, operation)) }, option), before = snapshot(f);
    const calls = [], saved = readMessageSnapshot(f.db, {}, { sqliteJson(db, sql, label) { calls.push(sql); return readOnlySqliteJson(db, sql, label); } });
    assert.equal(calls.length, 2); assert.equal(saved.nameRoutes.available, false); assert.deepEqual(saved.nameRoutes.accounts, []);
    const [got] = JSON.parse(messages(f, 'json')); assert.equal(got.readiness.state, 'enriching'); assert.deepEqual(got.readiness.reasons, ['sender_name_missing']);
    assert.deepEqual(snapshot(f), before);
  });
});

test('bounded account route prefixes mark overflow unknown, never choose a convenient denial pair', t => {
  const row = target(1), routes = operations.map(operation => denial(row, operation));
  for (let index = routes.length; index < 1025; index++) routes.push({ ...routes[0], route_key: hash(`invented unrelated route ${index}`) });
  const f = fixture(t, { entries: [{ row }], routes }), before = snapshot(f), calls = [];
  const saved = readMessageSnapshot(f.db, {}, { sqliteJson(db, sql, label) { calls.push(sql); return readOnlySqliteJson(db, sql, label); } });
  assert.equal(calls.length, 2); assert.match(calls[0], /^SELECT name FROM sqlite_schema/); assert.doesNotMatch(calls[0], /FROM records/);
  assert.match(calls[1], /INDEXED BY sqlite_autoindex_lark_im_name_routes_1/); assert.match(calls[1], /LIMIT 1025/);
  assert.deepEqual(saved.nameRoutes, { available: true, accounts: [{ account_key: ACCOUNT, complete: false, rows: [] }] });
  const [got] = JSON.parse(messages(f, 'json')); assert.equal(got.readiness.state, 'enriching'); assert.deepEqual(got.readiness.reasons, ['sender_name_missing']);
  assert.deepEqual(snapshot(f), before);
});

test('pure saved route reader rejects duplicates, incomplete snapshots and invalid account/namespace/observation evidence', () => {
  const row = target(1), canonical = JSON.parse(row.canonical_json), raw = JSON.parse(row.raw_json), pair = operations.map(operation => denial(row, operation));
  const saved = { available: true, accounts: [{ account_key: ACCOUNT, complete: true, rows: pair }] }, account = { state: 'verified', account_key: ACCOUNT };
  assert.equal(readSavedSenderRouteBlockers(row, canonical, raw, account, saved).length, 2);
  for (const change of [
    v => { v.available = false; }, v => { v.accounts[0].complete = false; },
    v => { v.accounts.push(clone(v.accounts[0])); }, v => { v.accounts[0].rows.push(clone(pair[0])); },
    v => { v.accounts[0].rows[0].last_attempt_at_ms = 1.5; }, v => { v.accounts[0].rows[0].generation = 0; },
    v => { v.accounts[0].rows[0].failure_code = '210508'; }, v => { v.accounts[0].rows[0].extra = 'invented invalid field'; },
  ]) { const copy = clone(saved); change(copy); assert.deepEqual(readSavedSenderRouteBlockers(row, canonical, raw, account, copy), []); }
  assert.deepEqual(readSavedSenderRouteBlockers(row, canonical, raw, { state: 'unknown' }, saved), []);
  assert.deepEqual(readSavedSenderRouteBlockers(row, canonical, raw, { state: 'verified', account_key: OTHER }, saved), []);
  const conflicting = clone(canonical); conflicting.sender_id_type = 'open_id';
  assert.deepEqual(readSavedSenderRouteBlockers(row, conflicting, raw, account, saved), []);
  assert.deepEqual(readSavedSenderRouteBlockers(row, canonical, raw, account, saved, ROUTE_AT - 1), []);
});

test('route account and total payload caps leave omitted accounts unknown in the actual CLI', async t => {
  for (const [label, accountCount, perAccount] of [['account cap', 33, 2], ['payload cap', 3, 1024]])
    await t.test(label, t => {
      const entries = [], routes = [];
      for (let id = 1; id <= accountCount; id++) {
        const row = target(id, { self: { open_id: `ou_synthetic_bounded_route_owner_${id}`, name: 'Invented Bounded Owner' } });
        entries.push({ row });
        const pair = operations.map(operation => denial(row, operation)); routes.push(...pair);
        for (let index = 2; index < perAccount; index++) routes.push({ ...pair[0], route_key: hash(`invented capacity filler ${id}/${index}`) });
      }
      const f = fixture(t, { entries, routes }), before = snapshot(f), saved = readMessageSnapshot(f.db, { limit: 100 });
      assert(saved.nameRoutes.accounts.length <= 32);
      assert(saved.nameRoutes.accounts.reduce((n, group) => n + group.rows.length, 0) <= 2048);
      const rows = JSON.parse(messages(f, 'json'));
      assert.deepEqual(rows.map(row => row.id), [...entries].reverse().map(value => value.row.id));
      assert.equal(rows.filter(row => row.readiness.state === 'enriching').length, 1);
      assert.equal(rows.filter(row => row.readiness.state === 'blocked').length, accountCount - 1);
      assert(rows.every(row => row.readiness.reasons.length === 1 && ['permission_denied','sender_name_missing'].includes(row.readiness.reasons[0])));
      if (label === 'account cap') assert.equal(rows.find(row => row.id === 1).readiness.state, 'enriching');
      else assert.equal(saved.nameRoutes.accounts.filter(group => !group.complete).length, 1);
      assert.deepEqual(snapshot(f), before);
    });
});
