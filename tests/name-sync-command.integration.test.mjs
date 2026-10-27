import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, fstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCli } from '../bin/exocortex.mjs';
import { ensureInitialized, quoteSql, sqliteExec, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { syncNames } from '../src/adapters/lark-im/name-sync.mjs';
import { readRemoteAccountBinding } from '../src/diagnostics/remote-account-binding.mjs';
import { createLarkCliRunner, createTransportState, getTransportStats, resetTransportStats } from '../src/adapters/lark-im/transport.mjs';
import { getLarkApiLeaseStdio, readSharedLarkCooldown, tryAcquireLarkApiLease, writeSharedLarkCooldown } from '../src/runtime/lark-api-lease.mjs';

// Entirely invented fixture. The public parser/command, native adapter,
// transport, cross-process flock, account admission, SQLite and syncNames all
// run normally. Only the remote executable responds from invented API data.
// The coordinator's explicit wall-clock seam advances retry time without a
// five-minute sleep; monotonic budgets and process/lock timing remain real.
const HERE = fileURLToPath(import.meta.url), ROOT = dirname(dirname(HERE));
const SELF = { open_id: 'ou_synthetic_name_command_owner', name: 'Synthetic Owner' };
const ACTOR = 'ou_synthetic_name_command_old_actor', OTHER = 'ou_synthetic_name_command_new_actor';
const CHAT = 'oc_synthetic_name_command_group', SCOPE = chatScopeId(CHAT);
const AT = Date.UTC(2026, 1, 2, 3, 4, 0), RECOVERED = 'Synthetic Recovered Author';
const hash = value => createHash('sha256').update(value).digest('hex');
const source = (key, actor, offset, name) => ({ message_id: `om_synthetic_name_command_${key}`,
  chat_id: CHAT, chat_type: 'group', msg_type: 'text', create_time: String(AT + offset), update_time: String(AT + offset + 1),
  sender: { id: actor, id_type: 'open_id', sender_type: 'user', ...(name ? { name } : {}) },
  body: { content: JSON.stringify({ text: `Synthetic message ${key}; spacing  stays.` }) },
  uninterpreted: { synthetic: true, whitespace: '  keep  ', integer_text: '9007199254740993' } });
const OLD = source('old', ACTOR, 1000), NEW = source('new', OTHER, 121000, 'Synthetic New Author');
const allowedNameFields = new Set(['sender_name', 'sender_name_state', 'sender_name_source', 'sender_name_confidence',
  'sender_name_resolution_status', 'sender_name_resolution_reason', 'sender_name_authority_source',
  'sender_name_account_key', 'sender_name_observed_at', 'sender_name_verification', 'chat_name_account_key']);

function fixtureRoot(path) {
  assert(path.startsWith(tmpdir()) && path.includes('/exocortex-name-command-synthetic-'));
  return path;
}
function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}
function noNetwork() {
  const reject = () => { throw new Error('synthetic name command test forbids network'); };
  globalThis.fetch = reject;
  Socket.prototype.connect = reject;
}

if (process.argv[2] === '--synthetic-remote') {
  noNetwork();
  const dir = fixtureRoot(process.env.SYNTHETIC_NAME_ROOT), phase = Number(process.env.SYNTHETIC_NAME_PHASE);
  const args = process.argv.slice(3), calls = join(dir, `calls-${phase}.jsonl`);
  const held = fstatSync(3), lock = statSync(join(dir, 'api-state', 'api.lock'));
  assert.equal(held.dev, lock.dev); assert.equal(held.ino, lock.ino, 'real transport must inherit the test-owned flock');
  const record = value => appendFileSync(calls, JSON.stringify({ phase, inheritedLease: true, ...value }) + '\n');
  const params = () => JSON.parse(args[args.indexOf('--params') + 1]);
  const respond = value => process.stdout.write(JSON.stringify(value));
  if (args[0] === 'contact' && args[1] === '+get-user') {
    record({ route: 'self' });
    respond(process.env.SYNTHETIC_NAME_OTHER_ACCOUNT === '1' ? { ...SELF, open_id: 'ou_synthetic_wrong_owner' } : SELF);
  } else if (args[0] === 'api' && args[1] === 'GET' && args[2] === '/open-apis/im/v1/messages') {
    const p = params(), startMs = Number(p.start_time) * 1000, endMs = Number(p.end_time) * 1000;
    assert.equal(p.container_id, CHAT);
    const available = phase === 1 ? [OLD] : phase === 2 ? [NEW] : [];
    const items = available.filter(message => Number(message.create_time) >= startMs && Number(message.create_time) <= endMs);
    record({ route: 'messages', startMs, endMs, messageIds: items.map(message => message.message_id) });
    respond({ code: 0, data: { items, has_more: false } });
  } else if (args[0] === 'contact' && args[1] === '+search-user') {
    assert(args.includes(ACTOR), 'only the invented missing actor can need contact lookup');
    record({ route: 'contact', restored: phase > 1 });
    if (phase === 1) { process.stderr.write('synthetic permission denied'); process.exitCode = 1; }
    else respond({ users: [{ open_id: ACTOR, name: RECOVERED }] });
  } else if (args[0] === 'im' && args[1] === 'chat.members' && args[2] === 'get') {
    assert.equal(params().chat_id, CHAT);
    record({ route: 'members', restored: phase > 1 });
    if (phase === 1) { process.stderr.write('synthetic permission denied'); process.exitCode = 1; }
    else respond({ items: [{ member_id: ACTOR, member_id_type: 'open_id', name: RECOVERED }], has_more: false });
  } else if (args[0] === 'im' && args[1] === 'chats' && args[2] === 'get') {
    assert.equal(params().chat_id, CHAT); record({ route: 'chat' });
    respond({ data: { chat_id: CHAT, chat_mode: 'group', name: 'Synthetic Current Group' } });
  } else {
    record({ route: 'unexpected', command: args.slice(0, 3) });
    process.stderr.write('unexpected synthetic remote route'); process.exitCode = 1;
  }
} else if (process.argv[2] === '--synthetic-cycle') {
  noNetwork();
  const dir = fixtureRoot(process.argv[3]), phase = Number(process.argv[4]), nowMs = Number(process.argv[5]);
  const db = join(dir, 'synthetic.sqlite'), directory = join(dir, 'api-state'), bin = join(dir, 'fake-lark');
  assert(inside(dir, db) && inside(dir, bin));
  const state = createTransportState();
  const remote = createLarkCliRunner({ bin, state,
    readSharedCooldown: opts => readSharedLarkCooldown(opts, { directory }),
    writeSharedCooldown: opts => writeSharedLarkCooldown(opts, { directory }),
  });
  const adapter = createLarkImAdapter({ run: remote });
  let stdout = '', stderr = '', nameReport = null, leaseAcquired = false, contentionVerified = false;
  const code = await runCli(['sync', '--db', db, '--scope', 'received', '--start', new Date(AT).toISOString(),
    '--end', new Date(AT + (phase === 1 ? 60000 : phase === 2 ? 180000 : phase * 120000)).toISOString(),
    '--received-scopes-per-run', '1', '--max-pages', '2', '--retries', '1', '--format', 'json'], {
    stdout: { write: value => stdout += value }, stderr: { write: value => stderr += value },
    deps: { getSelfProfile: adapter.getSelfProfile, getTransportStats: () => getTransportStats(state), resetTransportStats: () => resetTransportStats(state),
      syncRunnerDeps: { ...adapter, syncNames: (path, profile) => {
        assert.equal(path, db); assert.equal(profile.open_id, SELF.open_id);
        assert(getLarkApiLeaseStdio(), 'the genuine coordinator runs under the real CLI API lease');
        nameReport = syncNames(path, profile, { runLark: remote, now: () => nowMs });
        return nameReport;
      } },
      tryAcquireLarkApiLease: options => {
        const lease = tryAcquireLarkApiLease(options, { directory });
        leaseAcquired = lease.state === 'acquired';
        if (leaseAcquired) {
          const contender = tryAcquireLarkApiLease({ role: 'probe', db }, { directory });
          contentionVerified = contender.state === 'busy'; contender.release();
          assert(contentionVerified, 'an independent descriptor must not bypass the live flock');
        }
        return lease;
      },
    },
  });
  const callsPath = join(dir, `calls-${phase}.jsonl`);
  const calls = existsSync(callsPath) ? readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  console.log(JSON.stringify({ code, stdout, stderr, nameReport, leaseAcquired, contentionVerified, calls, pid: process.pid }));
} else {
  function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'exocortex-name-command-synthetic-')), db = join(dir, 'synthetic.sqlite');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    // Executing this test file in remote mode supplies only fake API responses;
    // it cannot register tests or touch another database/coordination directory.
    writeFileSync(join(dir, 'fake-lark'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(HERE)} --synthetic-remote "$@"\n`, { mode: 0o700 });
    ensureInitialized(db);
    sqliteExec(db, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${quoteSql(SCOPE)},'lark.im',
      'Synthetic historical name group',${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: 'group', chat_name: 'Synthetic Historical Group' }))});`);
    const started = Date.now();
    function cycle(phase, minutes, extraEnv = {}) {
      const result = spawnSync(process.execPath, [HERE, '--synthetic-cycle', dir, String(phase), String(started + minutes * 60000)], {
        cwd: dir, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, LARK_CLI: join(dir, 'fake-lark'), SYNTHETIC_NAME_ROOT: dir, SYNTHETIC_NAME_PHASE: String(phase), ...extraEnv },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stderr, '');
      return JSON.parse(result.stdout);
    }
    const old = () => sqliteQuery(db, `SELECT * FROM records WHERE external_id=${quoteSql(OLD.message_id)};`)[0];
    return { dir, db, cycle, old };
  }
  function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
  function success(result) {
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, ''); assert(result.leaseAcquired && result.contentionVerified);
    assert(result.calls.every(call => call.inheritedLease));
    assert.equal(result.calls.some(call => call.route === 'unexpected'), false);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true); assert.equal(summary.received.length, 1); assert.equal(summary.received[0].ok, true);
    assert.equal(Object.hasOwn(summary, 'names'), false); assert.equal(Object.hasOwn(summary, 'recipients'), false);
    assert(result.nameReport && result.nameReport.calls <= 4, 'the real optional coordinator must run within its shared call cap');
    return summary.received[0];
  }

  // Independent lexical check: compare every non-name top-level JSON member's
  // exact value bytes, without JS number coercion or the production patcher.
  function retainedMembers(text) {
    const members = [], segments = []; let start = 1, depth = 0, quoted = false, escaped = false;
    for (let index = 1; index < text.length; index++) {
      const ch = text[index];
      if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue; }
      if (ch === '"') { quoted = true; continue; }
      if (ch === '{' || ch === '[') depth++;
      if (ch === ']' || ch === '}') { if (depth === 0) { segments.push(text.slice(start, index)); break; } depth--; }
      if (ch === ',' && depth === 0) { segments.push(text.slice(start, index)); start = index + 1; }
    }
    for (const segment of segments) {
      const match = /^\s*("(?:[^"\\]|\\.)*")\s*:([\s\S]*)$/.exec(segment);
      assert(match, 'valid independently tokenized top-level member');
      const name = JSON.parse(match[1]);
      if (!allowedNameFields.has(name)) members.push([name, match[2].trim()]);
    }
    return members;
  }
  function preserveContent(before, after) {
    assert.deepEqual(Object.fromEntries(Object.entries(after).filter(([key]) => key !== 'canonical_json')),
      Object.fromEntries(Object.entries(before).filter(([key]) => key !== 'canonical_json')),
      'name recovery must leave every non-canonical column byte-for-byte intact, including updated_at');
    assert.deepEqual(retainedMembers(after.canonical_json), retainedMembers(before.canonical_json),
      'every non-name canonical member retains its exact bytes, order and unknown integer precision');
  }
  function databaseContents(db) {
    const result = spawnSync('sqlite3', ['-readonly', db, '.dump'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }

  test('real sync CLI heals quarantined historical sender after a bounded recovery probe and process restarts', t => {
    const f = fixture(t);
    const first = f.cycle(1, 0), firstRun = success(first);
    assert.equal(firstRun.inserted, 1);
    assert.equal(JSON.parse(f.old().canonical_json).sender_name, null);
    assert(first.calls.some(call => call.route === 'contact' && !call.restored));
    assert(first.calls.some(call => call.route === 'members' && !call.restored));
    const account = readRemoteAccountBinding({ db: f.db, selfOpenId: SELF.open_id });
    assert.equal(account.state, 'verified', 'the real command establishes account admission before the name tail');
    const failedTask = sqliteQuery(f.db, "SELECT * FROM lark_im_name_tasks WHERE kind='sender';")[0];
    assert(failedTask, 'the failed historical sender must have a durable task');
    assert.equal(failedTask.blocked_reason,'permission_denied');
    assert.equal(failedTask.retry_at_ms-failedTask.last_attempt_at_ms,86400000,'only a bounded daily recovery probe may recheck denied routes');
    assert.equal(failedTask.attempt_token, null); assert(failedTask.retry_at_ms > failedTask.last_attempt_at_ms);
    // Unknown fields are authored locally in this synthetic fixture to make
    // unintended JSON reserialization observable in the subsequent real pass.
    const oldText = f.old().canonical_json;
    sqliteExec(f.db, `UPDATE records SET canonical_json=${quoteSql('{\n "opaque_large":9007199254740993,\n "opaque_nested":{"keep":9007199254740997,"space":"  preserved  "},' + oldText.slice(1))}
      WHERE external_id=${quoteSql(OLD.message_id)};`);
    const before = f.old();
    const second = f.cycle(2, 1), secondRun = success(second);
    assert.equal(secondRun.inserted, 1);
    assert(second.calls.filter(call => call.route === 'messages').every(call => call.startMs > Number(OLD.create_time)));
    assert.equal(JSON.parse(f.old().canonical_json).sender_name, null, 'no new old-actor message can conceal the historical gap');
    preserveContent(before, f.old());
    const third = f.cycle(3, 1441), thirdRun = success(third);
    assert.equal(thirdRun.records, 0, 'a successful empty content cycle still invokes persisted name work');
    preserveContent(before, f.old());
    const fourth = f.cycle(4, 1442), fourthRun = success(fourth);
    assert.equal(fourthRun.records, 0);
    const after = f.old(), canonical = JSON.parse(after.canonical_json);
    assert.equal(canonical.sender_name, RECOVERED, JSON.stringify({ reports: [first, second, third, fourth].map(value => value.nameReport) }));
    assert.equal(canonical.sender_name_verification.status, 'resolved');
    assert.equal(canonical.sender_name_verification.account_key, hash(`lark.im\0${SELF.open_id}`));
    preserveContent(before, after);
    assert.equal(new Set([first.pid, second.pid, third.pid, fourth.pid]).size, 4, 'every cycle restarts the process and resolver caches');
    for (const cycle of [second, third, fourth]) {
      assert(cycle.calls.filter(call => call.route === 'messages').every(call => !call.messageIds.includes(OLD.message_id)));
    }
    assert([third, fourth].some(cycle => cycle.calls.some(call => ['contact', 'members'].includes(call.route) && call.restored)),
      'historical debt is healed by a genuine restored name request during an empty cycle');
    assert.equal(sqliteQuery(f.db, `SELECT count(*) AS n FROM records WHERE actor_id=${quoteSql(ACTOR)};`)[0].n, 1);
    assert.equal(sqliteQuery(f.db, "SELECT count(*) AS n FROM sync_scopes WHERE id LIKE 'lark.im.received.chat.%';")[0].n, 1,
      'name work must not create collection scopes');
    assert.equal(sqliteQuery(f.db, "SELECT count(*) AS n FROM sync_locks;")[0].n, 0);
    assert.equal(sqliteQuery(f.db, "SELECT count(*) AS n FROM maintenance_locks;")[0].n, 0);
    const contender = tryAcquireLarkApiLease({ role: 'probe', db: f.db }, { directory: join(f.dir, 'api-state') });
    assert.equal(contender.state, 'acquired', 'the CLI releases its real API lease after each process'); contender.release();
  });

  test('real API flock and account admission reject an empty sync before any name recovery write', t => {
    const f = fixture(t);
    success(f.cycle(1, 0));
    sqliteExec(f.db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
    const before = hash(readFileSync(f.db)), contents = databaseContents(f.db);
    const held = tryAcquireLarkApiLease({ role: 'sync', db: f.db }, { directory: join(f.dir, 'api-state') });
    assert.equal(held.state, 'acquired');
    let blocked;
    try { blocked = f.cycle(8, 8); } finally { held.release(); }
    assert.equal(blocked.code, 1); assert.equal(blocked.leaseAcquired, false); assert.equal(blocked.nameReport, null);
    assert.deepEqual(blocked.calls, []); assert.match(JSON.parse(blocked.stdout).error.message, /API is busy/);
    assert.equal(hash(readFileSync(f.db)), before);
    const conflict = f.cycle(9, 9, { SYNTHETIC_NAME_OTHER_ACCOUNT: '1' });
    assert.equal(conflict.code, 1); assert.equal(conflict.nameReport, null);
    assert.deepEqual(conflict.calls.map(call => call.route), ['self']);
    assert.equal(databaseContents(f.db), contents, 'real account rejection must precede content/name writes');
  });
}
