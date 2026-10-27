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
import { createLarkCliRunner, createTransportState, transportOperation } from '../src/adapters/lark-im/transport.mjs';
import { readLarkExecutionReceipt } from '../src/adapters/lark-im/transport-execution.mjs';
import { createNameResolver } from '../src/adapters/lark-im/name-resolver.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { bindCurrentSenderNames } from '../src/adapters/lark-im/name-history.mjs';
import { bindAcquiredMessageAccounts } from '../src/adapters/lark-im/message-account-evidence.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { nameRouteDescriptor, nextNameRouteState } from '../src/adapters/lark-im/name-route-state.mjs';
import { syncNames } from '../src/adapters/lark-im/name-sync.mjs';

// Entirely invented accounts, messages and subprocess results. The transport,
// resolver, persisted route reducer, SQLite and messages/quality CLI are real.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AT = Date.UTC(2025, 7, 3), OLD = AT + 1000, RESULT = AT + 2000, LOCAL = AT + 5000;
const SELF = { open_id: 'ou_synthetic_boundary_owner', name: 'Invented Boundary Owner' };
const ACCOUNT = recipientAccountKey(SELF.open_id), TITLE = 'Invented Execution Room';
const OPS = ['application_info', 'chat_bots'];
const hash = value => createHash('sha256').update(value).digest('hex');
const sql = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : quoteSql(value);
const insert = (table, value) => `INSERT INTO ${table}(${Object.keys(value).join(',')}) VALUES(${Object.values(value).map(sql).join(',')});`;
const argsFor = (op, actor, chat) => op === 'application_info'
  ? ['api', 'GET', `/open-apis/application/v6/applications/${actor}`]
  : ['im', 'chat.members', 'bots', '--params', JSON.stringify({ chat_id: chat })];

// Keep the independent twelve preexecution oracles, including timeout results
// without a pid: the transport's ETIMEDOUT contract supplies launch evidence.
const original = [
  ['shared_unavailable', 'fallback', 'inline', 'blocked'],
  ['monotonic_nan', 'fallback', 'inline', 'blocked'],
  ['spawn_throw', 'fallback', 'inline', 'blocked'],
  ['spawn_enoent', 'fallback', 'inline', 'blocked'],
  ['shared_wait', 'fallback', 'inline', 'blocked'],
  ['empty_success', 'fallback', 'inline', 'enriching'],
  ['timeout_no_pid', 'fallback', 'inline', 'enriching'],
  ['shared_unavailable', 'primary', 'inline', 'blocked'],
  ['spawn_enoent', 'primary', 'inline', 'blocked'],
  ['shared_unavailable', 'fallback', 'saved', 'blocked'],
  ['spawn_enoent', 'fallback', 'saved', 'blocked'],
  ['timeout_no_pid', 'fallback', 'saved', 'enriching'],
].map(([mode, side, path, state], index) => ({ mode, side, path, state, label: `original ${index + 1}: ${mode} ${side} ${path}` }));
const noStart = ['monotonic_throw', 'wall_throw', 'wall_nan', 'shared_throw', 'sleep_throw', 'lease_throw',
  'spawn_eacces', 'spawn_unknown', 'budget_expired'];
const executed = ['timeout', 'network_error', 'invalid_json', 'api_denial', 'cooldown_write_false', 'cooldown_write_throw',
  'retry_shared_throw', 'retry_shared_unavailable', 'retry_monotonic_throw', 'retry_wall_throw', 'retry_sleep_throw', 'retry_spawn_throw'];
const extended = [...noStart, ...executed].flatMap(mode => ['inline', 'saved'].map((path, index) => ({ mode,
  path, side: index ? 'primary' : 'fallback', state: noStart.includes(mode) || mode === 'api_denial' ? 'blocked' : 'enriching',
  label: `${mode}: ${index ? 'primary' : 'fallback'} ${path}` })));
const controls = [
  { mode: 'shared_unavailable', side: 'fallback', path: 'inline', prior: false, state: 'enriching', label: 'no prior denial is invented by local failure' },
  { mode: 'spawn_eacces', side: 'primary', path: 'saved', prior: false, state: 'enriching', label: 'no prior saved route is invented by failed launch' },
  { mode: 'empty_success', side: 'fallback', path: 'saved', state: 'enriching', label: 'successful empty response keeps its actual result clock through callback and persistence' },
  { mode: 'shared_unavailable', side: 'fallback', path: 'inline', nativeName: true, state: 'ready', label: 'valid native name survives local failure and old denial' },
];
const stages = [
  ['initial_clock', 'blocked', 'not_started'], ['loop_clock', 'blocked', 'not_started'], ['remaining_clock', 'blocked', 'not_started'],
  ['initial_shared_unavailable', 'blocked', 'not_started'], ['initial_shared_throw', 'blocked', 'not_started'],
  ['initial_sleep_throw', 'blocked', 'not_started'], ['initial_shared_wait', 'blocked', 'not_started'],
  ['spawn_throw', 'blocked', 'unknown'], ['error_ENOENT', 'blocked', 'not_started'], ['error_EACCES', 'blocked', 'not_started'],
  ['error_E2BIG', 'blocked', 'not_started'], ['error_ENOEXEC', 'blocked', 'not_started'], ['timeout_pid0_unknown', 'blocked', 'unknown'],
  ['executed_parse_failure', 'enriching', 'started'], ['executed_rate_write_false', 'enriching', 'started'], ['executed_rate_write_throw', 'enriching', 'started'],
  ['after_timeout_shared_unavailable', 'enriching', 'started'], ['after_timeout_shared_throw', 'enriching', 'started'],
  ['after_timeout_clock', 'enriching', 'started'], ['after_timeout_sleep_throw', 'enriching', 'started'],
  ['after_timeout_spawn_throw', 'enriching', 'started'], ['after_timeout_ENOENT', 'enriching', 'started'],
  ['after_timeout_shared_wait', 'enriching', 'started'], ['after_timeout_shared_unavailable_intermediate_denial', 'blocked', 'started'],
  ['after_timeout_shared_wait_intermediate_denial', 'blocked', 'started'],
].map(([mode, state, execution]) => ({ mode, state, execution, stage: true, path: 'inline', side: 'fallback',
  label: `independent execution stage: ${mode}`, denialAt: mode.includes('intermediate_denial') ? RESULT + 50 : OLD }));

function stageTransportProbe(spec) {
  const mode = spec.mode.replace('_intermediate_denial', ''), target = 'chat_bots', state = createTransportState();
  let active = '', wall = OLD + 100, elapsed = 0, monotonicCalls = 0, sharedCalls = 0, launches = 0;
  const trace = [], errors = new Map(), receipts = new Map(), targetActive = () => active === target, after = () => launches > 0;
  const transport = createLarkCliRunner({ bin: 'invented-stage-cli', state, clock: () => wall,
    monotonicClock: () => {
      if (!targetActive()) return 0;
      monotonicCalls++;
      if (mode === 'initial_clock' && monotonicCalls === 1 || mode === 'loop_clock' && monotonicCalls === 2
        || mode === 'remaining_clock' && monotonicCalls === 3 || mode === 'after_timeout_clock' && after()) {
        wall = LOCAL; return NaN;
      }
      return elapsed;
    },
    readSharedCooldown: () => {
      if (!targetActive()) return { state: 'ready' };
      sharedCalls++;
      if (mode === 'initial_shared_unavailable' && sharedCalls === 1 || mode === 'after_timeout_shared_unavailable' && after()) { wall = LOCAL; return { state: 'unavailable' }; }
      if (mode === 'initial_shared_throw' && sharedCalls === 1 || mode === 'after_timeout_shared_throw' && after()) { wall = LOCAL; throw Error('Invented stage reader failure'); }
      if (mode === 'initial_shared_wait' || mode === 'after_timeout_shared_wait' && after()) { wall = LOCAL; return { state: 'cooldown', untilMs: wall + 10000000 }; }
      if (mode === 'initial_sleep_throw') return { state: 'cooldown', untilMs: wall + 10 };
      return { state: 'ready' };
    },
    writeSharedCooldown: () => { wall = LOCAL; if (mode === 'executed_rate_write_throw') throw Error('Invented stage writer failure'); return false; },
    sleep: () => { wall = LOCAL; throw Error('Invented stage sleep failure'); },
    spawn: () => {
      trace.push({ event: 'launch_attempt', operation: active });
      if (!targetActive()) { wall = OLD + 100; trace.push({ event: 'started', operation: active }); return { pid: 100, status: 1, stdout: '', stderr: JSON.stringify({ error: { type: 'api', code: 210508 } }) }; }
      launches++; wall = launches === 1 ? RESULT - 50 : LOCAL;
      if (mode === 'spawn_throw' || mode === 'after_timeout_spawn_throw' && launches === 2) throw Error('Invented prestart stage failure');
      const code = mode.startsWith('error_') ? mode.slice(6) : mode === 'after_timeout_ENOENT' && launches === 2 ? 'ENOENT' : null;
      if (code) return { pid: 0, status: null, error: { code }, stdout: '', stderr: '' };
      if (mode === 'timeout_pid0_unknown') { wall = RESULT; return { pid: 0, status: null, error: { code: 'ETIMEDOUT' }, stdout: '', stderr: '' }; }
      trace.push({ event: 'started', operation: active }); wall = RESULT; elapsed = 10;
      if (mode === 'executed_parse_failure') return { pid: 200, status: 0, stdout: 'invented malformed output', stderr: '' };
      if (mode.startsWith('executed_rate_write_')) return { pid: 200, status: 1, stdout: '', stderr: JSON.stringify({ error: { type: 'api', code: 99991400 } }) };
      return { pid: 200, status: null, error: { code: 'ETIMEDOUT' }, stdout: '', stderr: '' };
    },
  });
  const run = (args, options = {}) => {
    active = transportOperation(args); wall = targetActive() ? RESULT - 100 : OLD + 100;
    try { return transport(args, { ...options, retries: 1, retryBudgetMs: 1000, retryDelayMs: mode === 'after_timeout_sleep_throw' ? 10 : 0,
      onExecutionReceipt: value => { receipts.set(active, { status: 'valid', value }); options.onExecutionReceipt?.(value); } }); }
    catch (error) { errors.set(active, error); receipts.set(active, readLarkExecutionReceipt(error, active)); throw error; }
  };
  return { run, trace, errors, receipts, target, state, clock: () => wall };
}

function transportProbe(spec, actor, chat) {
  const target = spec.side === 'primary' ? OPS[0] : OPS[1], state = createTransportState();
  let active = '', wall = RESULT, elapsed = 0, targetLaunches = 0, targetResults = 0, resultWallReads = 0;
  const trace = [], errors = new Map(), receipts = new Map();
  const targetActive = () => active === target;
  const afterResult = () => targetActive() && targetResults > 0;
  const localThrow = () => { wall = LOCAL; throw Error('Invented local boundary exception'); };
  const transport = createLarkCliRunner({ bin: 'invented-boundary-cli', state,
    clock: () => {
      if (targetActive() && spec.mode === 'wall_throw'
        || afterResult() && spec.mode === 'retry_wall_throw' && resultWallReads++ > 0) return localThrow();
      return targetActive() && spec.mode === 'wall_nan' ? NaN : wall;
    },
    monotonicClock: () => {
      if (targetActive() && spec.mode === 'monotonic_throw' || afterResult() && spec.mode === 'retry_monotonic_throw') return localThrow();
      if (targetActive() && spec.mode === 'monotonic_nan') return NaN;
      if (targetActive() && spec.mode === 'budget_expired') { elapsed += 1001; return elapsed; }
      return elapsed;
    },
    readSharedCooldown: () => {
      if (targetActive() && spec.mode === 'shared_throw' || afterResult() && spec.mode === 'retry_shared_throw') return localThrow();
      if (targetActive() && spec.mode === 'shared_unavailable' || afterResult() && spec.mode === 'retry_shared_unavailable') { wall = LOCAL; return { state: 'unavailable' }; }
      if (targetActive() && spec.mode === 'shared_wait') return { state: 'cooldown', untilMs: wall + 1000000 };
      if (targetActive() && spec.mode === 'sleep_throw') return { state: 'cooldown', untilMs: wall + 1 };
      return { state: 'ready' };
    },
    writeSharedCooldown: () => {
      if (targetActive() && spec.mode === 'cooldown_write_throw') return localThrow();
      if (targetActive() && spec.mode === 'cooldown_write_false') { wall = LOCAL; return false; }
      return true;
    },
    getLeaseStdio: () => { if (targetActive() && spec.mode === 'lease_throw') return localThrow(); return undefined; },
    sleep: ms => {
      if (targetActive() && ['sleep_throw', 'retry_sleep_throw'].includes(spec.mode)) return localThrow();
      elapsed += ms; wall += ms;
    },
    spawn: (_bin, args) => {
      const operation = transportOperation(args); trace.push({ event: 'launch_attempt', operation });
      if (targetActive()) targetLaunches++;
      if (targetActive() && spec.mode === 'spawn_throw' || afterResult() && spec.mode === 'retry_spawn_throw') return localThrow();
      if (targetActive() && ['spawn_enoent', 'spawn_eacces', 'spawn_unknown'].includes(spec.mode))
        return { pid: 0, status: null, error: { code: spec.mode === 'spawn_enoent' ? 'ENOENT' : spec.mode === 'spawn_eacces' ? 'EACCES' : 'SYNTHETIC_START_ERROR' }, stdout: '', stderr: '' };
      trace.push({ event: 'started', operation });
      if (targetActive()) targetResults++;
      if (targetActive() && ['timeout', 'timeout_no_pid', 'network_error'].includes(spec.mode)) return {
        ...(spec.mode === 'timeout_no_pid' ? {} : { pid: 4242 }), status: null,
        error: { code: spec.mode === 'network_error' ? 'ECONNRESET' : 'ETIMEDOUT' }, stdout: '', stderr: '' };
      if (targetActive() && spec.mode === 'invalid_json') return { pid: 4242, status: 0, stdout: '{invented malformed JSON', stderr: '' };
      if (targetActive() && spec.mode === 'empty_success') return { pid: 4242, status: 0,
        stdout: JSON.stringify(operation === 'application_info' ? { app: { app_id: actor } } : { items: [] }), stderr: '' };
      if (targetActive() && (spec.mode.startsWith('retry_') || spec.mode.startsWith('cooldown_write_'))) {
        return { pid: 4242, status: 1, stdout: '', stderr: JSON.stringify({ error: { type: 'api', code: 99991400,
          message: 'Invented rate limit', headers: { 'x-ogw-ratelimit-reset': '0.001' } } }) };
      }
      return { pid: 4242, status: 1, stdout: '', stderr: JSON.stringify({ error: { type: 'api', code: 210508, message: 'Invented denial' } }) };
    },
  });
  const run = (args, options = {}) => {
    active = transportOperation(args); wall = RESULT; elapsed = 0;
    try { return transport(args, { ...options, retries: targetActive() && spec.mode.startsWith('retry_') ? 1 : 0, retryBudgetMs: 1000, retryDelayMs: 1,
      onExecutionReceipt: value => { receipts.set(active, { status: 'valid', value }); options.onExecutionReceipt?.(value); } }); }
    catch (error) { errors.set(active, error); receipts.set(active, readLarkExecutionReceipt(error, active)); throw error; }
  };
  return { run, trace, errors, receipts, target, state, clock: () => Number.isFinite(wall) ? wall : LOCAL,
    targetLaunches: () => targetLaunches, targetResults: () => targetResults };
}

function record(id, spec, probe) {
  const actor = `cli_synthetic_boundary_${id}`, chat = `oc_synthetic_boundary_${id}`;
  const native = { message_id: `om_b${String(id).padStart(4, '0')}_synthetic_boundary`, chat_id: chat, chat_type: 'group', msg_type: 'text',
    create_time: String(AT + id), update_time: String(AT + id + 1),
    sender: { id: actor, id_type: 'app_id', sender_type: 'app', ...(spec.nativeName ? { name: 'Invented Native Boundary App' } : {}) },
    body: { content: JSON.stringify({ text: `Invented unchanged boundary body ${id}.` }) } };
  const message = normalizeApiMessage(native);
  const resolver = createNameResolver({ now: spec.path === 'inline' ? probe.clock : () => OLD,
    run: spec.path === 'inline' ? probe.run : args => { throw Error(`lark-cli failed: kind=permission_denied code=210508 operation=${transportOperation(args)}`); } });
  const context = resolver.buildPeopleContext([message], {}, SELF);
  let row = recordFromMessage(message, 'lark.im.sent_by_me', 'received', context, { chat_id: chat, chat_type: 'group', chat_name: TITLE });
  [row] = bindAcquiredMessageAccounts(bindCurrentSenderNames([row], SELF), SELF, { acquiredAt: new Date(AT + 500).toISOString() });
  if (spec.prior === false && spec.path === 'saved') {
    const canonical = JSON.parse(row.canonical_json); delete canonical.sender_name_verification; row.canonical_json = JSON.stringify(canonical);
  }
  return { ...row, id };
}
function routeRows(row, spec, probe) {
  if (spec.path === 'saved') { try { probe.run(argsFor(probe.target, row.actor_id, row.container_id)); } catch { /* inspected below */ } }
  const routes = [];
  for (const operation of OPS) {
    const route = nameRouteDescriptor({ source_id: 'lark.im', account_key: ACCOUNT, kind: 'sender',
      actor_id: row.actor_id, namespace: 'app_id', chat_id: row.container_id }, operation);
    const previous = spec.prior === false ? null : nextNameRouteState(route, null,
      { type: 'failure', error: `lark-cli failed: kind=permission_denied code=210508 operation=${operation}` },
      { nowMs: operation === probe.target ? spec.denialAt ?? OLD : OLD }).row;
    let value = previous;
    if (spec.path === 'saved' && operation === probe.target) {
      const recovered = nextNameRouteState(route, previous, { type: 'recover' }, { nowMs: LOCAL }).row;
      const event = probe.errors.has(operation) ? { type: 'failure', error: probe.errors.get(operation) }
        : { type: 'success', execution: probe.receipts.get(operation)?.value };
      const next = nextNameRouteState(route, recovered, event, { nowMs: LOCAL });
      // As in the coordinator, recovery is provisional until an executed result.
      if (next.changed) value = next.row;
      if (noStart.includes(spec.mode) || ['shared_unavailable', 'monotonic_nan', 'spawn_throw', 'spawn_enoent', 'shared_wait'].includes(spec.mode)) {
        assert.equal(next.changed, false, `${spec.label}: no new persisted route result`);
        assert.deepEqual(value, previous, `${spec.label}: old route generation and all clocks remain exact`);
      }
    }
    if (value) routes.push(value);
  }
  return routes;
}
function neighbor(id, at) {
  const message = normalizeApiMessage({ message_id: `om_n${id}_synthetic_boundary_neighbor`, chat_id: 'oc_synthetic_boundary_neighbor',
    chat_type: 'group', chat_name: TITLE, msg_type: 'text', create_time: String(at), update_time: String(at + 1),
    sender: { id: 'ou_synthetic_boundary_neighbor', id_type: 'open_id', sender_type: 'user', name: 'Invented Ready Neighbor' },
    body: { content: JSON.stringify({ text: `Invented preserved neighbor body ${id}.` }) } });
  return { ...recordFromMessage(message, 'lark.im.sent_by_me', 'received'), id };
}
function fixture(t, specs) {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-route-boundary-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite'), marker = join(directory, 'unexpected-network'), cli = join(directory, 'reject-cli'), guard = join(directory, 'reject-network.mjs');
  writeFileSync(cli, '#!/bin/sh\nprintf called > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
  writeFileSync(guard, `import {writeFileSync} from 'node:fs';import {Socket} from 'node:net';const deny=()=>{writeFileSync(process.env.SYNTHETIC_NETWORK_MARKER,'called');throw Error('boundary test forbids network');};globalThis.fetch=deny;Socket.prototype.connect=deny;Object.defineProperty(process.stdout,'columns',{value:120});\n`);
  ensureInitialized(db);
  const entries = specs.map((spec, i) => {
    const probe = spec.stage ? stageTransportProbe(spec) : transportProbe(spec, `cli_synthetic_boundary_${i + 1}`, `oc_synthetic_boundary_${i + 1}`);
    const row = record(i + 1, spec, probe), routes = routeRows(row, spec, probe);
    return { ...spec, row, routes, probe };
  });
  const neighbors = [neighbor(1001, AT - 1000), neighbor(1002, AT - 2000)];
  sqliteExec(db, [...entries.map(value => value.row), ...neighbors].map(row => insert('records', row)).join('\n')
    + entries.flatMap(value => value.routes).map(row => insert('lark_im_name_routes', row)).join('\n'));
  sqliteExec(db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  return { directory, db, marker, cli, guard, entries, neighbors };
}
function snapshot(f) {
  const dump = spawnSync('sqlite3', ['-readonly', f.db, '.dump'], { encoding: 'utf8', timeout: 10000 }); assert.equal(dump.status, 0, dump.stderr);
  return { hash: hash(readFileSync(f.db)), dump: dump.stdout, mtime: statSync(f.db).mtimeMs, files: readdirSync(f.directory).sort() };
}
function run(f, args) {
  const env = { ...process.env, TZ: 'UTC', NO_COLOR: '1', LARK_CLI: f.cli, SYNTHETIC_NETWORK_MARKER: f.marker }; delete env.FORCE_COLOR;
  const child = spawnSync(process.execPath, ['--import', f.guard, ...args], { cwd: f.directory, env, encoding: 'utf8', timeout: 20000, maxBuffer: 12 * 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr || child.stdout); assert.equal(child.stderr, ''); assert.equal(existsSync(f.marker), false); return child.stdout;
}
const messages = (f, format, limit = 100) => run(f, [join(ROOT, 'bin/exocortex.mjs'), 'messages', '--db', f.db, '--limit', String(limit), '--format', format]);
const header = row => `RECEIVED ${new Date(row.occurred_at).toLocaleString('en-US', { timeZone: 'UTC' })}  ${row.external_id.slice(0, 8)}...  群聊`;
async function acceptance(t, specs) {
  const f = fixture(t, specs), before = snapshot(f), ordered = [...f.entries].reverse();
  const rows = JSON.parse(messages(f, 'json')), text = messages(f, 'text'), expectedRows = [...ordered.map(value => value.row), ...f.neighbors];
  assert.deepEqual(rows.map(row => row.id), expectedRows.map(row => row.id));
  for (const [index, value] of ordered.entries()) await t.test(value.label, () => {
    const got = rows[index], p = value.probe, receipt = p.receipts.get(p.target);
    if (!value.nativeName && value.mode !== 'empty_success') {
      assert.equal(receipt?.status, 'valid', `${value.label}: finite execution receipt`);
      assert.deepEqual(readLarkExecutionReceipt(p.errors.get(p.target).message, p.target), receipt, 'receipt survives the existing string boundary');
      const expectedStarted = value.execution ? value.execution === 'started' : value.state === 'enriching' && value.prior !== false || value.mode === 'api_denial';
      if (value.execution) assert.equal(receipt.value.execution, value.execution);
      else if (['spawn_unknown', 'spawn_throw'].includes(value.mode)) assert.equal(receipt.value.execution, 'unknown', 'an executor exception cannot prove either launch success or a completed result');
      else assert.equal(receipt.value.execution, expectedStarted ? 'started' : 'not_started', value.label);
      assert.equal(p.trace.filter(event => event.operation === p.target && event.event === 'started').length > 0, expectedStarted);
      if (!expectedStarted) { assert.equal(receipt.value.result_at_ms, null); assert.equal(receipt.value.remote_result, false); }
      if (['timeout', 'timeout_no_pid', 'network_error', 'invalid_json'].includes(value.mode)) assert.equal(receipt.value.remote_result, false);
      if (value.mode.startsWith('retry_') || value.mode.startsWith('cooldown_write_')) {
        assert.equal(receipt.value.result_at_ms, RESULT, 'later local failure cannot refresh the real result clock');
        assert.equal(receipt.value.remote_result, true); assert.equal(receipt.value.result_kind, 'rate_limited');
      }
      if (value.stage && expectedStarted) {
        assert.equal(receipt.value.result_at_ms, RESULT, 'stage chronology uses actual execution result, never local catch time');
        assert.equal(receipt.value.remote_result, value.mode.startsWith('executed_rate_write_'));
      }
      if (value.path === 'inline') {
        const observation = JSON.parse(value.row.canonical_json).sender_name_verification;
        const failure = observation.route_failures.routes.find(route => route.operation === p.target).failure;
        assert.equal(failure.version, 2, 'new diagnostics explicitly preserve execution provenance');
        assert.deepEqual(failure.execution, receipt.value, 'local diagnostic persists the bounded actual-result receipt');
      }
    }
    if (value.mode === 'empty_success') {
      assert.equal(receipt?.status, 'valid', 'successful JSON carries execution evidence through the optional callback');
      assert.equal(receipt.value.result_kind, 'success'); assert.equal(receipt.value.result_at_ms, RESULT);
      if (value.path === 'saved') assert.equal(value.routes.find(route => route.operation === p.target).last_attempt_at_ms, RESULT);
    }
    for (const field of ['id','source_id','external_id','actor_id','container_id','direction','occurred_at','occurred_at_ms','body','raw_json','canonical_json']) assert.equal(got[field], value.row[field], `${value.label}: ${field}`);
    assert.equal(got.display.body, value.row.body); assert.equal(got.readiness.state, value.state, value.label);
    assert.deepEqual(got.readiness.reasons, value.state === 'blocked' ? ['permission_denied'] : value.state === 'enriching' ? ['sender_name_missing'] : []);
    assert.equal(got.readiness.next_action, value.state === 'blocked' ? 'review_permissions' : value.state === 'enriching' ? 'resolve_sender' : 'none');
    const start = text.indexOf(header(value.row)), end = text.indexOf(header(expectedRows[index + 1])); assert(start >= 0 && end > start);
    const block = text.slice(start, end).trimEnd();
    if (value.state === 'ready') assert(block.includes(value.row.body) && block.includes('Invented Native Boundary App'));
    else assert.equal(block, `${header(value.row)}\n  状态    ${value.state === 'blocked' ? '准备受阻' : '等待完整信息'}\n  原因    ${value.state === 'blocked' ? '来源权限不足' : '发送人名称待补全'}\n  查看    messages --format json 可检查已保存内容与原因`);
  });
  for (const [index, row] of f.neighbors.entries()) {
    const got = rows[ordered.length + index]; assert.equal(got.readiness.state, 'ready');
    for (const key of ['body','raw_json','canonical_json','occurred_at','actor_id','container_id']) assert.equal(got[key], row[key]);
    assert(text.includes(`${header(row)}\n  发送人  Invented Ready Neighbor\n  群      ${TITLE}\n  类型    user / 文本\n  消息    ${row.body}`));
  }
  assert.deepEqual(JSON.parse(messages(f, 'json', 1)), [rows[0]], 'limit one never skips the selected exception');
  const quality = JSON.parse(run(f, ['--input-type=module', '-e', `import {collectQualityReport} from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/diagnostics/lark-im-quality-report.mjs')).href)};process.stdout.write(JSON.stringify(collectQualityReport(process.argv[1])));`, f.db]));
  const counts = { captured: 0, enriching: 0, ready: 2, blocked: 0 }; for (const spec of specs) counts[spec.state]++;
  assert.deepEqual(quality.completeness.counts, counts); assert.equal(quality.completeness.population.evaluated, specs.length + 2);
  assert.deepEqual(snapshot(f), before, 'messages and quality retain DB bytes, clocks, rows, schema and filesystem');
}

test('the independent twelve preexecution expectations hold through actual transport and CLI', t => acceptance(t, original));
test('every local execution boundary preserves distinct diagnostics and actual results in CLI', t => acceptance(t, extended));
test('local failures neither invent prior denial nor demote an already valid name', t => acceptance(t, controls));
test('all twenty-five independent execution-stage and intermediate-denial expectations remain exact', t => acceptance(t, stages));

test('real name synchronization never publishes provisional recovery when the target command did not start', t => {
  const spec = { mode: 'api_denial', side: 'fallback', path: 'saved', state: 'blocked', label: 'persisted recovery witness' };
  const f = fixture(t, [spec]), targetRow = f.entries[0].row;
  const owner = recordFromMessage(normalizeApiMessage({ message_id: 'om_synthetic_boundary_self_binding',
    chat_id: 'oc_synthetic_boundary_self_room', chat_type: 'group', chat_name: TITLE, msg_type: 'text',
    create_time: String(AT - 4000), update_time: String(AT - 3999),
    sender: { id: SELF.open_id, id_type: 'open_id', sender_type: 'user', name: SELF.name },
    body: { content: JSON.stringify({ text: 'Invented complete sent owner binding.' }) } }), 'lark.im.sent_by_me', 'sent');
  sqliteExec(f.db, insert('records', { ...owner, id: 3000 }));
  const recordsBefore = readOnlySqliteJson(f.db, 'SELECT * FROM records ORDER BY id;', 'synthetic before recovery');
  let now = LOCAL + 1000;
  const initial = syncNames(f.db, SELF, { now: () => now, monotonicNow: () => 0,
    syncRecipients: () => ({ reason: 'idle' }), runLark: () => assert.fail('initial exact blocked routes must be skipped') });
  const tasks = readOnlySqliteJson(f.db, "SELECT * FROM lark_im_name_tasks WHERE kind='sender';", 'synthetic blocked work');
  assert.equal(tasks.length, 1, JSON.stringify(initial)); assert.equal(tasks[0].blocked_reason, 'permission_denied');
  const routesBefore = readOnlySqliteJson(f.db, 'SELECT * FROM lark_im_name_routes ORDER BY route_key;', 'synthetic before recovery routes');
  now = tasks[0].retry_at_ms + 1;
  // Author an ordinary future refresh schedule for unrelated complete titles;
  // the next real coordinator turn should select the due sender recovery.
  sqliteExec(f.db, `UPDATE lark_im_name_tasks SET retry_at_ms=${now + 86400000} WHERE kind='chat';`);
  const probe = transportProbe({ mode: 'shared_unavailable', side: 'fallback' }, targetRow.actor_id, targetRow.container_id);
  const result = syncNames(f.db, SELF, { now: () => now, monotonicNow: () => 0,
    syncRecipients: () => ({ reason: 'idle' }), runLark: (args, options) => transportOperation(args) === 'self_profile' ? SELF : probe.run(args, options) });
  assert.equal(result.attempted, 1, JSON.stringify(result));
  assert.equal(probe.receipts.get('chat_bots')?.status, 'valid', JSON.stringify({ result, trace: probe.trace }));
  assert.equal(probe.receipts.get('chat_bots').value.execution, 'not_started');
  assert.equal(probe.trace.filter(event => event.operation === 'chat_bots' && event.event === 'started').length, 0);
  const routesAfter = readOnlySqliteJson(f.db, 'SELECT * FROM lark_im_name_routes ORDER BY route_key;', 'synthetic after recovery routes');
  assert.deepEqual(routesAfter.find(row => row.operation === 'chat_bots'), routesBefore.find(row => row.operation === 'chat_bots'),
    'a failed local recovery launch cannot replace the old denial, generation, retry or result clock');
  assert.deepEqual(readOnlySqliteJson(f.db, 'SELECT * FROM records ORDER BY id;', 'synthetic after recovery'), recordsBefore,
    'a failed recovery leaves every stored content, identity and canonical byte unchanged');
  const readBefore = snapshot(f), got = JSON.parse(messages(f, 'json')).find(row => row.id === targetRow.id);
  assert.equal(got.readiness.state, 'blocked'); assert.equal(got.readiness.next_action, 'review_permissions');
  assert.deepEqual(snapshot(f), readBefore, 'displaying recovery debt remains read-only');
});
