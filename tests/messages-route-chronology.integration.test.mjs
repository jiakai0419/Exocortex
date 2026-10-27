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
import { createNameResolver } from '../src/adapters/lark-im/name-resolver.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { bindCurrentSenderNames, prepareInlineNameOptions } from '../src/adapters/lark-im/name-history.mjs';
import { bindAcquiredMessageAccounts } from '../src/adapters/lark-im/message-account-evidence.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { nameRouteDescriptor, nameRouteAdmission, nextNameRouteState } from '../src/adapters/lark-im/name-route-state.mjs';

// All messages, people, account keys, route receipts and clocks are authored.
// Transport is synthetic; resolver, normalization, SQLite, CLI and quality are real.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AT = Date.UTC(2025, 5, 12, 8, 9, 10), T0 = AT + 1000, T1 = AT + 2000, T2 = AT + 3000, T3 = AT + 4000;
const SELF = { open_id: 'ou_synthetic_chronology_owner', name: 'Invented Chronology Owner' };
const ACCOUNT = recipientAccountKey(SELF.open_id), FOREIGN = recipientAccountKey('ou_synthetic_chronology_other_owner');
const TITLE = 'Invented Chronology Room', OPS = ['application_info', 'chat_bots'];
const hash = value => createHash('sha256').update(value).digest('hex');
const edit = (row, field, change) => { const value = JSON.parse(row[field]); change(value); row[field] = JSON.stringify(value); };
const D = at => ['denial', at], S = at => ['success', at], X = at => ['transient', at];

// The first 18 cases preserve the independent frozen 861 expectations exactly.
// Each inline v1 attempt has one observation clock; table routes have their own
// last-attempt clocks. One operation's newer clock must never decide its peer.
const matrix = [
  { label: '01 newer inline fallback transient than both old table denials', inline: 'transient', at: T1, table: [D(T0), D(T0)], state: 'enriching' },
  { label: '02 new fallback denial after inline transient with old primary', inline: 'transient', at: T1, table: [D(T0), D(T2)], state: 'blocked' },
  { label: '03 new primary denial cannot erase the newer inline fallback transient', inline: 'transient', at: T1, table: [D(T2), D(T0)], state: 'enriching' },
  { label: '04 equal inline transient and table denial retain explicit denial', inline: 'transient', at: T1, table: [D(T1), D(T1)], state: 'blocked' },
  { label: '05 older inline transient cannot undo both newer table denials', inline: 'transient', at: T0, table: [D(T1), D(T1)], state: 'blocked' },
  { label: '06 new fallback denial after inline not-requested with old primary', inline: 'not_requested', at: T1, table: [D(T0), D(T2)], state: 'blocked' },
  { label: '07 strictly newer actual fallback success withdraws inline pair', inline: 'permission', at: T1, table: [D(T0), S(T2)], state: 'enriching' },
  { label: '08 strictly newer actual primary success withdraws inline pair', inline: 'permission', at: T1, table: [S(T2), D(T0)], state: 'enriching' },
  { label: '09 strictly newer actual fallback transient withdraws inline pair', inline: 'permission', at: T1, table: [D(T0), X(T2)], state: 'enriching' },
  { label: '10 equal table success does not recover inline denial', inline: 'permission', at: T1, table: [D(T0), S(T1)], state: 'blocked' },
  { label: '11 older table success does not recover inline denial', inline: 'permission', at: T1, table: [D(T0), S(T0)], state: 'blocked' },
  { label: '12 recovery admission alone is not a new response', inline: 'permission', at: T1, table: [D(T0), ['recover', T0]], state: 'blocked' },
  { label: '13 newer denial then recovery is not successful response', inline: 'permission', at: T1, table: [D(T0), ['recover', T2]], state: 'blocked' },
  { label: '14 missing fallback row does not recover inline denial', inline: 'permission', at: T1, table: [D(T0), null], state: 'blocked' },
  { label: '15 generation and retry clocks alone are not a new response', inline: 'permission', at: T1, table: [D(T0), ['generation', T0]], state: 'blocked' },
  { label: '16 foreign-chat fallback success cannot recover this pair', inline: 'permission', at: T1, table: [D(T0), ['foreign_chat_success', T2]], state: 'blocked' },
  { label: '17 future fallback success cannot recover this pair', inline: 'permission', at: T1, table: [D(T0), ['future_success', T2]], state: 'blocked' },
  { label: '18 exact inline double denial needs no table rows', inline: 'permission', at: T1, table: [null, null], state: 'blocked' },
  { label: '19 symmetric new primary denial after inline primary transient', inline: 'primary_transient', at: T1, table: [D(T2), D(T0)], state: 'blocked' },
  { label: '20 symmetric new fallback denial does not erase primary transient', inline: 'primary_transient', at: T1, table: [D(T0), D(T2)], state: 'enriching' },
  { label: '21 equal primary transient and explicit denial remain denied', inline: 'primary_transient', at: T1, table: [D(T1), D(T1)], state: 'blocked' },
  { label: '22 no request cannot erase the denial that triggered admission skip', inline: 'not_requested', at: T1, table: [D(T0), D(T0)], state: 'blocked' },
  { label: '23 equal not-requested cannot clear explicit denial', inline: 'not_requested', at: T1, table: [D(T0), D(T1)], state: 'blocked' },
  { label: '24 actual newer unclassified runner failure replaces its old denial', inline: 'unknown', at: T1, table: [D(T0), D(T0)], state: 'enriching' },
  { label: '25 actual unclassified runner failure at equal time cannot clear denial', inline: 'unknown', at: T1, table: [D(T0), D(T1)], state: 'blocked' },
  { label: '26 inline primary denial and newer table fallback denial combine', inline: 'transient', at: T1, table: [S(T0), D(T2)], state: 'blocked' },
  { label: '27 inline fallback denial and newer table primary denial combine', inline: 'primary_transient', at: T1, table: [D(T2), S(T0)], state: 'blocked' },
  { label: '28 latest fallback denial cannot erase newer primary success', inline: 'permission', at: T1, table: [S(T2), D(T3)], state: 'enriching' },
  { label: '29 latest primary denial cannot erase newer fallback success', inline: 'permission', at: T1, table: [D(T3), S(T2)], state: 'enriching' },
  { label: '30 equal contradictory observations prefer denial per operation', inline: 'transient', at: T1, table: [S(T1), D(T1)], state: 'blocked' },
  { label: '31 foreign-account fallback success cannot recover this pair', inline: 'permission', at: T1, table: [D(T0), ['foreign_account_success', T2]], state: 'blocked' },
  { label: '32 foreign-actor fallback success cannot recover this pair', inline: 'permission', at: T1, table: [D(T0), ['foreign_actor_success', T2]], state: 'blocked' },
  { label: '33 foreign namespace success cannot recover this pair', inline: 'permission', at: T1, table: [D(T0), ['foreign_namespace_success', T2]], state: 'blocked' },
  { label: '34 valid native name survives latest exact double denial', inline: 'permission', at: T1, table: [D(T2), D(T2)], state: 'ready', name: 'native' },
  { label: '35 valid adopted name survives latest exact double denial', inline: 'permission', at: T1, table: [D(T2), D(T2)], state: 'ready', name: 'adopted' },
  { label: '36 absent inline diagnostics allow exact current table pair', inline: 'permission', at: T1, table: [D(T2), D(T2)], state: 'blocked', canonical: 'no_observation' },
  { label: '37 generic single failure does not pretend to be a paired attempt', inline: 'permission', at: T1, table: [D(T2), D(T2)], state: 'blocked', canonical: 'no_companion' },
  // Current v1 contract: an invalid companion supplies uncertainty, not a new
  // event or permission recovery. Its unusable clock cannot arbitrate routes.
  { label: '38 invalid companion remains unknown without mixing routes', inline: 'permission', at: T1, table: [D(T0), D(T2)], state: 'enriching', canonical: 'bad_companion' },
  { label: '39 missing primary table row cannot hide a newer exact fallback success', inline: 'permission', at: T1, table: [null, S(T2)], state: 'enriching' },
  { label: '40 missing fallback table row cannot hide a newer exact primary success', inline: 'permission', at: T1, table: [S(T2), null], state: 'enriching' },
  { label: '41 invalid primary table route cannot erase newer exact fallback success', inline: 'permission', at: T1, table: [['invalid_route', T0], S(T2)], state: 'enriching' },
  { label: '42 v2 actual fallback response time outranks an intermediate table denial', inline: 'transient', at: T0,
    routeTimes: [T0, T2], table: [D(T0), D(T1)], state: 'enriching' },
  { label: '43 v2 later fallback clock cannot hide an intermediate primary denial', inline: 'primary_transient', at: T0,
    routeTimes: [T0, T2], table: [D(T1), D(T0)], state: 'blocked' },
  { label: '44 unknown route with no result cannot erase stored denial', inline: 'permission', at: T1,
    canonical: 'unknown_fallback', table: [D(T0), D(T0)], state: 'blocked' },
  { label: '45 unknown route with no result supplies no denial without prior evidence', inline: 'permission', at: T1,
    canonical: 'unknown_fallback', table: [null, null], state: 'enriching' },
  { label: '46 pre-request failure cannot erase stored remote denial', inline: 'pre_request', at: T1, table: [D(T0), D(T0)], state: 'blocked' },
  { label: '47 pre-request failure cannot invent remote denial without prior evidence', inline: 'pre_request', at: T1, table: [null, null], state: 'enriching' },
  { label: '48 actual persisted blocked fallback admission cannot clear itself', inline: 'known_route_skip', schema: 2,
    at: T1, table: [null, D(T0)], state: 'blocked' },
  { label: '49 admission skip without prior fallback evidence stays unknown', inline: 'not_requested', schema: 2,
    at: T1, table: [null, null], state: 'enriching' },
  { label: '50 newer local command unavailability cannot erase inline remote denial', inline: 'permission', at: T1,
    table: [D(T0), ['command_unavailable', T2]], state: 'blocked' },
];

function makeRecord(id, spec, db, preseeded) {
  const actor = `cli_synthetic_chronology_actor_${id}`, chat = `oc_synthetic_chronology_chat_${id}`;
  const native = { message_id: `om_t${String(id).padStart(4, '0')}_synthetic_time`, chat_id: chat, chat_type: 'group', msg_type: 'text',
    create_time: String(AT + id), update_time: String(AT + id + 1), sender: { id: actor, id_type: 'app_id', sender_type: 'app' },
    body: { content: JSON.stringify({ text: `Invented chronology body ${id}.` }) } };
  let clock = spec.at;
  const calls = [], resolver = createNameResolver({ now: () => clock, run(args) {
    const operation = args[0] === 'api' ? 'application_info' : 'chat_bots'; calls.push(operation);
    if (spec.routeTimes) clock = spec.routeTimes[OPS.indexOf(operation)];
    const transient = spec.inline === 'transient' && operation === 'chat_bots'
      || spec.inline === 'primary_transient' && operation === 'application_info';
    const unknown = spec.inline === 'unknown' && operation === 'chat_bots';
    if (spec.inline === 'pre_request' && operation === 'chat_bots')
      throw new Error('lark-cli failed: kind=command_unavailable spawn_code=ENOENT operation=chat_bots');
    throw new Error(`lark-cli failed: kind=${transient ? 'network_timeout timeout_ms=5000' : unknown ? 'unknown' : 'permission_denied code=210508'} operation=${operation}`);
  } });
  const message = normalizeApiMessage(native);
  let options = spec.inline === 'not_requested' ? { nameRouteAdmission: ({ operation }) => operation !== 'chat_bots' } : {};
  let persistedBefore = null;
  if (spec.inline === 'known_route_skip') {
    const descriptor = nameRouteDescriptor({ source_id: 'lark.im', account_key: ACCOUNT, kind: 'sender', actor_id: actor, namespace: 'app_id', chat_id: chat }, 'chat_bots');
    const denied = nextNameRouteState(descriptor, null, { type: 'failure', error: 'lark-cli failed: kind=permission_denied code=210508 operation=chat_bots' }, { nowMs: T0 }).row;
    assert.deepEqual(nameRouteAdmission(descriptor, denied, T1), { allowed: false, state: 'blocked' });
    sqliteExec(db, `INSERT INTO lark_im_name_routes(${Object.keys(denied).join(',')}) VALUES(${Object.values(denied).map(value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : quoteSql(value)).join(',')});`);
    preseeded.add(denied.route_key);
    persistedBefore = readOnlySqliteJson(db, 'SELECT * FROM lark_im_name_routes ORDER BY route_key;', 'synthetic pre-admission routes');
    options = prepareInlineNameOptions(db, [message], SELF, { chat_id: chat, chat_type: 'group' });
  }
  const context = resolver.buildPeopleContext([message], options, SELF);
  assert.deepEqual(calls, ['not_requested', 'known_route_skip'].includes(spec.inline) ? ['application_info'] : OPS, `${spec.label}: actual synthetic route calls`);
  if (persistedBefore) assert.deepEqual(readOnlySqliteJson(db, 'SELECT * FROM lark_im_name_routes ORDER BY route_key;', 'synthetic post-admission routes'), persistedBefore,
    'blocked admission performs no fallback request, recovery, generation change or clock refresh');
  let row = recordFromMessage(message, 'lark.im.sent_by_me', 'received', context, { chat_id: chat, chat_type: 'group', chat_name: TITLE });
  [row] = bindCurrentSenderNames([row], SELF);
  const produced = JSON.parse(row.canonical_json).sender_name_verification;
  if (spec.routeTimes) {
    assert.equal(produced.route_failures.version, 2, 'the actual producer retains per-operation observation clocks');
    assert.deepEqual(produced.route_failures.routes.map(route => route.observed_at), spec.routeTimes.map(at => new Date(at).toISOString()));
    assert.equal(produced.observed_at, new Date(spec.routeTimes[0]).toISOString(), 'selected primary clock is not silently moved to the later fallback');
  } else if (spec.schema !== 2) edit(row, 'canonical_json', c => {
    // Author the existing v1 persisted shape to test legacy cohort semantics;
    // do not relabel that common clock as a precise response time for each route.
    c.sender_name_verification.route_failures.version = 1;
    for (const route of c.sender_name_verification.route_failures.routes) delete route.observed_at;
  });
  if (spec.name === 'native') {
    edit(row, 'raw_json', raw => { raw.sender.name = 'Invented Native Clock App'; });
    row.content_hash = hash(row.raw_json);
    edit(row, 'canonical_json', c => { c.sender_name = 'Invented Native Clock App'; c.sender_name_source = 'message_sender'; });
  } else if (spec.name === 'adopted') edit(row, 'canonical_json', c => {
    c.sender_name = 'Invented Adopted Clock App'; c.sender_name_source = 'application_api'; c.sender_name_confidence = 'high'; c.sender_name_account_key = ACCOUNT;
  });
  edit(row, 'canonical_json', c => {
    if (spec.canonical === 'no_observation') delete c.sender_name_verification;
    if (spec.canonical === 'no_companion') delete c.sender_name_verification.route_failures;
    if (spec.canonical === 'bad_companion') c.sender_name_verification.route_failures.target_key = hash('invented wrong chronology target');
    if (spec.canonical === 'unknown_fallback') {
      const fallback = c.sender_name_verification.route_failures.routes[1]; fallback.status = 'unknown'; fallback.failure = null;
      if (c.sender_name_verification.route_failures.version === 2) fallback.observed_at = null;
    }
    if (spec.canonical === 'missing_time') delete c.sender_name_verification.observed_at;
    if (spec.canonical === 'invalid_time') c.sender_name_verification.observed_at = 'invented-invalid-clock';
    if (spec.canonical === 'future_time') c.sender_name_verification.observed_at = new Date(Date.now() + 86400000).toISOString();
  });
  [row] = bindAcquiredMessageAccounts([row], SELF, { acquiredAt: new Date(AT + 500).toISOString() });
  if (spec.inline === 'known_route_skip') {
    const saved = JSON.parse(row.canonical_json).sender_name_verification;
    assert.equal(saved.route_failures.version, 2); assert.equal(saved.route_failures.routes[1].status, 'not_requested');
    assert.equal(saved.route_failures.routes[1].failure, null); assert.equal(calls.filter(op => op === 'chat_bots').length, 0);
  }
  if (spec.inline === 'pre_request') assert.equal(JSON.parse(row.canonical_json).sender_name_verification.route_failures.routes[1].failure.stage, 'not_requested');
  assert(JSON.parse(row.canonical_json).message_account_evidence, spec.label);
  return { ...row, id };
}
function routeRows(row, spec) {
  const rows = [];
  for (const [index, item] of spec.table.entries()) {
    if (!item) continue;
    const [kind, suppliedAt] = item, operation = OPS[index];
    const descriptor = nameRouteDescriptor({ source_id: 'lark.im', account_key: kind === 'foreign_account_success' ? FOREIGN : ACCOUNT,
      kind: 'sender', actor_id: kind === 'foreign_actor_success' ? 'cli_synthetic_chronology_foreign_actor' : row.actor_id,
      namespace: kind === 'foreign_namespace_success' ? 'open_id' : 'app_id',
      chat_id: kind === 'foreign_chat_success' ? 'oc_synthetic_chronology_foreign_chat' : row.container_id },
    kind === 'foreign_namespace_success' ? 'chat_members' : operation);
    assert(descriptor);
    const at = kind === 'future_success' ? Date.now() + 86400000 : suppliedAt;
    const success = kind.includes('success');
    const event = success ? { type: 'success' } : { type: 'failure', error: `lark-cli failed: kind=${kind === 'transient'
      ? 'network_timeout timeout_ms=5000' : kind === 'command_unavailable' ? 'command_unavailable spawn_code=ENOENT' : 'permission_denied code=210508'} operation=${operation}` };
    let saved = nextNameRouteState(descriptor, null, event, { nowMs: at }).row;
    if (kind === 'recover') saved = nextNameRouteState(descriptor, saved, { type: 'recover' }, { nowMs: T3 }).row;
    if (kind === 'generation') { saved.generation = 999; saved.retry_at_ms = T3; }
    if (kind === 'invalid_route') saved.operation = 'other';
    if (kind === 'zero_success') saved.last_attempt_at_ms = 0;
    if (kind === 'missing_success') delete saved.last_attempt_at_ms; // Persisted legacy default is 0; no response clock is created.
    if (kind === 'invalid_success') saved.last_attempt_at_ms = 'invented-invalid-clock';
    rows.push(saved);
  }
  return rows;
}
function neighbor(id, at) {
  const message = normalizeApiMessage({ message_id: `om_n${String(id).padStart(4, '0')}_synthetic_neighbor`, chat_id: 'oc_synthetic_chronology_neighbors',
    chat_type: 'group', chat_name: TITLE, msg_type: 'text', create_time: String(at), update_time: String(at + 1),
    sender: { id: 'ou_synthetic_chronology_neighbor', id_type: 'open_id', sender_type: 'user', name: 'Invented Ready Neighbor' },
    body: { content: JSON.stringify({ text: `Invented preserved neighbor body ${id}.` }) } });
  return { ...recordFromMessage(message, 'lark.im.sent_by_me', 'received'), id };
}
function fixture(t, specs) {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-route-chronology-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite'), marker = join(directory, 'unexpected-network'), cli = join(directory, 'reject-cli'), guard = join(directory, 'reject-network.mjs');
  writeFileSync(cli, '#!/bin/sh\nprintf called > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
  writeFileSync(guard, `import {writeFileSync} from 'node:fs';import {Socket} from 'node:net';
const deny=()=>{writeFileSync(process.env.SYNTHETIC_NETWORK_MARKER,'called');throw Error('chronology test forbids network');};
globalThis.fetch=deny;Socket.prototype.connect=deny;Object.defineProperty(process.stdout,'columns',{value:120});\n`);
  ensureInitialized(db);
  const preseeded = new Set();
  const entries = specs.map((spec, index) => ({ ...spec, row: makeRecord(index + 1, spec, db, preseeded) }));
  const neighbors = [neighbor(1001, AT - 1000), neighbor(1002, AT - 2000)];
  const insert = (table, value) => `INSERT INTO ${table}(${Object.keys(value).join(',')}) VALUES(${Object.values(value).map(v => v === null ? 'NULL' : typeof v === 'number' ? String(v) : quoteSql(v)).join(',')});`;
  sqliteExec(db, 'PRAGMA ignore_check_constraints=ON;\n' + [...entries.map(value => value.row), ...neighbors].map(row => insert('records', row)).join('\n')
    + entries.flatMap(value => routeRows(value.row, value)).filter(row => !preseeded.has(row.route_key))
      .map(row => insert('lark_im_name_routes', row)).join('\n'));
  sqliteExec(db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  return { directory, db, marker, cli, guard, entries, neighbors };
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
const reason = state => state === 'blocked' ? 'permission_denied' : state === 'enriching' ? 'sender_name_missing' : null;
const label = state => state === 'blocked' ? '来源权限不足' : '发送人名称待补全';
function caseAssertions(got, textBlock, value) {
  for (const field of ['id','source_id','external_id','actor_id','container_id','direction','occurred_at','occurred_at_ms','body','raw_json','canonical_json'])
    assert.equal(got[field], value.row[field], `${value.label}: ${field}`);
  assert.equal(got.display.body, value.row.body);
  assert.equal(got.readiness.state, value.state, value.label);
  assert.deepEqual(got.readiness.reasons, reason(value.state) ? [reason(value.state)] : []);
  assert.equal(got.readiness.next_action, value.state === 'blocked' ? 'review_permissions' : value.state === 'enriching' ? 'resolve_sender' : 'none');
  if (value.state === 'ready') {
    assert(textBlock.includes(value.row.body) && textBlock.includes(got.display.sender)); assert(!textBlock.includes('状态    '));
  } else assert.equal(textBlock, `${header(value.row)}\n  状态    ${value.state === 'blocked' ? '准备受阻' : '等待完整信息'}\n  原因    ${label(value.state)}\n  查看    messages --format json 可检查已保存内容与原因`);
}
async function acceptance(t, specs) {
  const f = fixture(t, specs), before = snapshot(f), ordered = [...f.entries].reverse();
  const rows = JSON.parse(messages(f, 'json')), text = messages(f, 'text');
  const expectedRows = [...ordered.map(value => value.row), ...f.neighbors];
  assert.deepEqual(rows.map(row => row.id), expectedRows.map(row => row.id));
  for (const [index, value] of ordered.entries()) await t.test(value.label, () => {
    const start = text.indexOf(header(value.row)), end = text.indexOf(header(expectedRows[index + 1]));
    assert(start >= 0 && end > start, 'header, time and selected position stay fixed');
    caseAssertions(rows[index], text.slice(start, end).trimEnd(), value);
  });
  for (const [index, row] of f.neighbors.entries()) {
    const got = rows[ordered.length + index];
    assert.equal(got.readiness.state, 'ready');
    for (const key of ['body','raw_json','canonical_json','occurred_at','actor_id','container_id']) assert.equal(got[key], row[key]);
    assert(text.includes(`${header(row)}\n  发送人  Invented Ready Neighbor\n  群      ${TITLE}\n  类型    user / 文本\n  消息    ${row.body}`));
  }
  assert.deepEqual(JSON.parse(messages(f, 'json', 1)), [rows[0]], 'limit one keeps the newest actual selected exception');
  const quality = JSON.parse(run(f, ['--input-type=module', '-e', `import {collectQualityReport} from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/diagnostics/lark-im-quality-report.mjs')).href)};process.stdout.write(JSON.stringify(collectQualityReport(process.argv[1])));`, f.db]));
  const counts = { captured: 0, enriching: 0, ready: 2, blocked: 0 }; for (const spec of specs) counts[spec.state]++;
  await t.test('quality has the same expected per-operation chronology and conserved population', () => {
    assert.deepEqual(quality.completeness.counts, counts);
    assert.equal(quality.completeness.reasons.permission_denied, counts.blocked);
    assert.equal(quality.completeness.reasons.sender_name_missing, counts.enriching);
    assert.equal(quality.completeness.population.evaluated, specs.length + 2);
  });
  assert.deepEqual(snapshot(f), before, 'read-only CLI/quality preserve all records, route receipts, clocks, schema and files');
}

test('each operation independently selects its latest valid route evidence in actual CLI and quality', async t => {
  await acceptance(t, matrix);
});

for (const [label, canonical, table, state] of [
  ['missing inline time remains unknown, never a later observation', 'missing_time', [D(T0), D(T2)], 'enriching'],
  ['invalid inline time remains unknown, never a later observation', 'invalid_time', [D(T0), D(T2)], 'enriching'],
  ['future inline time remains unknown, never a later observation', 'future_time', [D(T0), D(T2)], 'enriching'],
  ['zero table response time cannot recover inline denial', undefined, [D(T0), ['zero_success', T2]], 'blocked'],
  ['missing table response time cannot recover inline denial', undefined, [D(T0), ['missing_success', T2]], 'blocked'],
  ['invalid table response time cannot recover inline denial', undefined, [D(T0), ['invalid_success', T2]], 'blocked'],
]) test(label, async t => {
  await acceptance(t, [{ label, canonical, inline: 'permission', at: T1, table, state }]);
});
