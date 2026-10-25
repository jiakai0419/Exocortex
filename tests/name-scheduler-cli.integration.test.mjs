import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, fstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCli } from '../bin/exocortex.mjs';
import { confirmInitialLarkAccountSql, ensureInitialized, quoteSql, reserveInitialLarkAccount, sqliteExec, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';
import { chatScopeId, SENT_SCOPE_ID } from '../src/adapters/lark-im/core.mjs';
import { syncNames } from '../src/adapters/lark-im/name-sync.mjs';
import { readRemoteAccountBinding } from '../src/diagnostics/remote-account-binding.mjs';
import { createLarkCliRunner, createTransportState, getTransportStats, resetTransportStats } from '../src/adapters/lark-im/transport.mjs';
import { getLarkApiLeaseStdio, readSharedLarkCooldown, tryAcquireLarkApiLease, writeSharedLarkCooldown } from '../src/runtime/lark-api-lease.mjs';

// Only the remote executable is replaced. Every cycle runs the real CLI parser,
// command, native adapter, private flock, account admission, SQLite and syncNames
// in a new process; the received content response is always empty. All data is
// invented here. The explicit name-clock seam advances days without sleeping.
const HERE = fileURLToPath(import.meta.url), ROOT = dirname(dirname(HERE));
const SELF = { open_id: 'ou_synthetic_scheduler_owner', name: 'Synthetic Scheduler Owner' };
const ACTOR = 'ou_synthetic_scheduler_author', AUTHOR = 'Synthetic Scheduler Author';
const CHAT = 'oc_synthetic_scheduler_target', DRIVER = 'oc_synthetic_scheduler_empty_driver';
const TITLE = 'Synthetic Current Scheduler Group', AT = Date.UTC(2025, 1, 2, 3, 4, 0);
const hash = value => createHash('sha256').update(value).digest('hex');
const ACCOUNT = hash(`lark.im\0${SELF.open_id}`), DAY = 86400000;
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function fixtureRoot(path) {
  assert(path.startsWith(tmpdir()) && path.includes('/exocortex-name-scheduler-synthetic-'));
  return path;
}
function noNetwork() {
  const reject = () => { throw new Error('synthetic scheduler test forbids network'); };
  globalThis.fetch = reject; Socket.prototype.connect = reject;
}

if (process.argv[2] === '--synthetic-remote') {
  noNetwork();
  const dir = fixtureRoot(process.env.SYNTHETIC_SCHEDULER_ROOT), phase = Number(process.env.SYNTHETIC_SCHEDULER_PHASE);
  const args = process.argv.slice(3), params = () => JSON.parse(args[args.indexOf('--params') + 1]);
  const held = fstatSync(3), lock = statSync(join(dir, 'api-state', 'api.lock'));
  assert.equal(held.dev, lock.dev); assert.equal(held.ino, lock.ino);
  const record = value => appendFileSync(join(dir, `calls-${phase}.jsonl`), JSON.stringify({ inheritedLease: true, ...value }) + '\n');
  const respond = value => process.stdout.write(JSON.stringify(value));
  if (args[0] === 'contact' && args[1] === '+get-user') {
    record({ route: 'self' }); respond(SELF);
  } else if (args[0] === 'api' && args[1] === 'GET' && args[2] === '/open-apis/im/v1/messages') {
    assert.equal(params().container_id, DRIVER);
    record({ route: 'messages', count: 0 }); respond({ code: 0, data: { items: [], has_more: false } });
  } else if (args[0] === 'im' && args[1] === 'chats' && args[2] === 'get') {
    assert.equal(params().chat_id, CHAT);
    record({ route: 'chat', nameAvailable: phase !== 0 });
    respond({ data: { chat_id: CHAT, chat_mode: 'group', name: phase === 0 ? null : TITLE } });
  } else {
    record({ route: 'unexpected', command: args.slice(0, 3) });
    process.stderr.write('unexpected synthetic scheduler remote route'); process.exitCode = 1;
  }
} else if (process.argv[2] === '--synthetic-cycle') {
  noNetwork();
  const dir = fixtureRoot(process.argv[3]), phase = Number(process.argv[4]), nowMs = Number(process.argv[5]);
  const db = join(dir, 'synthetic.sqlite'), directory = join(dir, 'api-state');
  const state = createTransportState();
  const remote = createLarkCliRunner({ bin: join(dir, 'fake-lark'), state,
    readSharedCooldown: opts => readSharedLarkCooldown(opts, { directory }),
    writeSharedCooldown: opts => writeSharedLarkCooldown(opts, { directory }),
  });
  const adapter = createLarkImAdapter({ run: remote });
  let stdout = '', stderr = '', nameReport = null, leaseAcquired = false, contentionVerified = false;
  const code = await runCli(['sync', '--db', db, '--scope', 'received', '--start', new Date(AT).toISOString(),
    '--end', new Date(AT + (phase + 1) * 60000).toISOString(), '--received-scopes-per-run', '1',
    '--max-pages', '1', '--retries', '1', '--format', 'json'], {
    stdout: { write: value => stdout += value }, stderr: { write: value => stderr += value },
    deps: { getSelfProfile: adapter.getSelfProfile, getTransportStats: () => getTransportStats(state), resetTransportStats: () => resetTransportStats(state),
      syncRunnerDeps: { ...adapter, syncNames: (path, self) => {
        assert.equal(path, db); assert.equal(self.open_id, SELF.open_id); assert(getLarkApiLeaseStdio());
        nameReport = syncNames(path, self, { runLark: remote, now: () => nowMs });
        return nameReport;
      } },
      tryAcquireLarkApiLease: options => {
        const lease = tryAcquireLarkApiLease(options, { directory });
        leaseAcquired = lease.state === 'acquired';
        if (leaseAcquired) {
          const contender = tryAcquireLarkApiLease({ role: 'probe', db }, { directory });
          contentionVerified = contender.state === 'busy'; contender.release(); assert(contentionVerified);
        }
        return lease;
      },
    },
  });
  const callsPath = join(dir, `calls-${phase}.jsonl`);
  const calls = existsSync(callsPath) ? readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  console.log(JSON.stringify({ code, stdout, stderr, nameReport, leaseAcquired, contentionVerified, calls, pid: process.pid }));
} else {
  function fixture(t, count, { oversized = [], scope = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'exocortex-name-scheduler-synthetic-')), db = join(dir, 'synthetic.sqlite');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'fake-lark'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(HERE)} --synthetic-remote "$@"\n`, { mode: 0o700 });
    writeFileSync(join(dir, 'reject-lark'), '#!/bin/sh\nprintf called > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
    writeFileSync(join(dir, 'deny-network.mjs'), `import {writeFileSync} from 'node:fs'; import {Socket} from 'node:net';
const reject=()=>{writeFileSync(process.env.SYNTHETIC_NETWORK_MARKER,'called');throw new Error('synthetic messages CLI forbids network')};
globalThis.fetch=reject;Socket.prototype.connect=reject;\n`);
    ensureInitialized(db);
    reserveInitialLarkAccount(db, ACCOUNT, new Date().toISOString());
    sqliteExec(db, confirmInitialLarkAccountSql(new Date().toISOString()), 'confirm invented scheduler account');
    sqliteExec(db, `INSERT INTO sync_scopes(id,source_id,name,enabled,config_json) VALUES(${quoteSql(chatScopeId(DRIVER))},
      'lark.im','Synthetic empty driver',1,${quoteSql(JSON.stringify({ chat_id: DRIVER, chat_type: 'group', chat_name: 'Synthetic Driver' }))});
      ${scope ? `INSERT INTO sync_scopes(id,source_id,name,enabled,config_json) VALUES(${quoteSql(chatScopeId(CHAT))},
        'lark.im','Synthetic unnamed disabled target',0,${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});` : ''}`);
    const began = Date.now() - 30 * DAY, runs = [];
    function append(first, last, huge = []) {
      const statements = [];
      for (let id = first; id <= last; id++) {
        const message = `om_synthetic_scheduler_${id}`, at = AT - id * 1000;
        const raw = { message_id: message, chat_id: CHAT, chat_type: 'group', msg_type: 'text',
          sender: { id: ACTOR, id_type: 'open_id', sender_type: 'user' }, opaque: { literal: '  preserved  ' } };
        const canonical = { message_id: message, chat_id: CHAT, chat_type: 'group', chat_name: null,
          msg_type: 'text', sender_id: ACTOR, sender_id_type: 'open_id', sender_name: AUTHOR };
        const text = '{\n "opaque_large":9007199254740993, "opaque_nested":{"x":9007199254740997,"spaces":"  keep  "},\n ' + JSON.stringify(canonical).slice(1);
        statements.push(`INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,record_type,
          occurred_at,occurred_at_ms,actor_id,container_id,direction,title,body,content_hash,canonical_json,raw_json)
          VALUES(${id},'lark.im',${quoteSql(scope ? chatScopeId(CHAT) : SENT_SCOPE_ID)},${quoteSql(message)},'opaque-synthetic-version','lark.im.message',
          ${quoteSql(new Date(at).toISOString())},${at},${quoteSql(ACTOR)},${quoteSql(CHAT)},'received','Synthetic retained title',
          ${huge.includes(id) ? "printf('%.*c',2200000,'x')" : quoteSql(`Synthetic normal body ${id}; spacing  stays.`)},
          ${quoteSql(`opaque-synthetic-content-hash-${id}`)},${quoteSql(text)},${quoteSql(JSON.stringify(raw))});`);
      }
      sqliteExec(db, statements.join('\n'), 'author invented legacy received rows');
    }
    append(1, count, oversized);
    const scopeBefore = sqliteQuery(db, `SELECT * FROM sync_scopes WHERE id=${quoteSql(chatScopeId(CHAT))};`);
    function cycle(phase, offset) {
      const result = spawnSync(process.execPath, [HERE, '--synthetic-cycle', dir, String(phase), String(began + offset)], {
        cwd: dir, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, LARK_CLI: join(dir, 'fake-lark'), SYNTHETIC_SCHEDULER_ROOT: dir, SYNTHETIC_SCHEDULER_PHASE: String(phase) },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(result.stderr, '');
      const output = JSON.parse(result.stdout); success(output);
      const task = sqliteQuery(db, "SELECT * FROM lark_im_name_tasks WHERE kind='chat';")[0];
      const marked = sqliteQuery(db, "SELECT count(*) AS n FROM records WHERE json_extract(canonical_json,'$.chat_name_account_key') IS NOT NULL;")[0].n;
      runs.push({ ...output, task, marked, nowMs: began + offset });
      return runs.at(-1);
    }
    return { dir, db, append, cycle, runs, scopeBefore };
  }
  function success(result) {
    assert.equal(result.code, 0, result.stderr || result.stdout); assert.equal(result.stderr, '');
    assert(result.leaseAcquired && result.contentionVerified);
    assert(result.calls.every(call => call.inheritedLease)); assert(!result.calls.some(call => call.route === 'unexpected'));
    assert(result.calls.some(call => call.route === 'messages' && call.count === 0));
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true); assert.equal(summary.received.length, 1); assert.equal(summary.received[0].ok, true);
    assert.equal(summary.received[0].records, 0); assert.equal(summary.received[0].inserted, 0);
    assert(!Object.hasOwn(summary, 'names') && !Object.hasOwn(summary, 'recipients'), 'public sync output shape stays unchanged');
    assert(result.nameReport && result.nameReport.calls <= 4);
  }
  function snapshot(db) {
    // Read rows one at a time: twenty 2.2 MiB witnesses must not make the test's
    // inspection bypass the product's own capacity bounds or dump large text.
    const script = `import hashlib,json,sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
c.row_factory=sqlite3.Row
out=[]
for row in c.execute('SELECT * FROM records ORDER BY id'):
 d=dict(row); canonical=d.pop('canonical_json')
 out.append({'id':d['id'],'other':hashlib.sha256(json.dumps(d,ensure_ascii=False,separators=(',',':')).encode()).hexdigest(),'canonical':canonical})
print(json.dumps(out))`;
    const result = spawnSync('python3', ['-B', '-c', script, db], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  }
  // Independent token scanner preserves unknown large numbers, whitespace in
  // values, and member order. Only the exact per-message title binding may grow.
  function retainedMembers(text) {
    const segments = []; let start = 1, depth = 0, quoted = false, escaped = false;
    for (let i = 1; i < text.length; i++) {
      const ch = text[i];
      if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue; }
      if (ch === '"') { quoted = true; continue; }
      if (ch === '[' || ch === '{') depth++;
      if (ch === ']' || ch === '}') { if (depth === 0) { segments.push(text.slice(start, i)); break; } depth--; }
      if (ch === ',' && depth === 0) { segments.push(text.slice(start, i)); start = i + 1; }
    }
    return segments.flatMap(segment => {
      const match = /^\s*("(?:[^"\\]|\\.)*")\s*:([\s\S]*)$/.exec(segment); assert(match);
      const key = JSON.parse(match[1]); return key === 'chat_name_account_key' ? [] : [[key, match[2].trim()]];
    });
  }
  function preserve(before, after) {
    assert.equal(after.length, before.length);
    for (let index = 0; index < before.length; index++) {
      assert.equal(after[index].id, before[index].id); assert.equal(after[index].other, before[index].other,
        `every non-canonical field of row ${before[index].id}, including timestamps/body/raw/version/hash, stays byte-for-byte intact`);
      assert.deepEqual(retainedMembers(after[index].canonical), retainedMembers(before[index].canonical));
    }
  }
  function messages(f) {
    sqliteExec(f.db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;', 'seal invented DB for read-only CLI check');
    const before = hash(readFileSync(f.db)), files = readdirSync(f.dir).sort(), marker = join(f.dir, 'unexpected-network');
    const result = spawnSync(process.execPath, ['--import', join(f.dir, 'deny-network.mjs'), join(ROOT, 'bin/exocortex.mjs'),
      'messages', '--db', f.db, '--direction', 'received', '--format', 'json', '--limit', '100', '--search', 'Synthetic normal body'], {
      cwd: f.dir, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, LARK_CLI: join(f.dir, 'reject-lark'), SYNTHETIC_NETWORK_MARKER: marker, NO_COLOR: '1' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(result.stderr, '');
    assert(!existsSync(marker)); assert.equal(hash(readFileSync(f.db)), before); assert.deepEqual(readdirSync(f.dir).sort(), files);
    return JSON.parse(result.stdout);
  }
  function finish(f, original, beforeMessages, count) {
    preserve(original, snapshot(f.db));
    assert.equal(readRemoteAccountBinding({ db: f.db, selfOpenId: SELF.open_id }).state, 'verified');
    assert.deepEqual(sqliteQuery(f.db, `SELECT * FROM sync_scopes WHERE id=${quoteSql(chatScopeId(CHAT))};`), f.scopeBefore,
      'title work neither creates a target collection scope nor changes its disabled configuration');
    assert.equal(new Set(f.runs.map(run => run.pid)).size, f.runs.length);
    assert.equal(sqliteQuery(f.db, 'SELECT count(*) AS n FROM sync_locks;')[0].n, 0);
    assert.equal(sqliteQuery(f.db, 'SELECT count(*) AS n FROM maintenance_locks;')[0].n, 0);
    const after = messages(f);
    assert.equal(after.length, count); assert.deepEqual(after.map(row => row.id), beforeMessages.map(row => row.id), 'display order stays identical');
    for (let index = 0; index < after.length; index++) {
      const old = beforeMessages[index], current = after[index];
      assert.deepEqual(Object.keys(current), Object.keys(old), 'public JSON envelope remains unchanged');
      assert.deepEqual(Object.keys(current.display), Object.keys(old.display), 'display structure remains unchanged');
      const oldDisplay = { ...old.display }, newDisplay = { ...current.display };
      delete oldDisplay.chat; delete newDisplay.chat; assert.deepEqual(newDisplay, oldDisplay, 'all other presentation values stay identical');
      assert.equal(current.canonical.sender_name, AUTHOR); assert.equal(current.body, old.body);
      assert.equal(current.display.chat, TITLE, JSON.stringify({ unhealedId: current.id, cycles: f.runs.map(run => ({
        reason: run.nameReport.reason, marked: run.marked, after: run.task?.after_record_id, latest: run.task?.latest_record_id })) }));
      assert.equal(current.canonical.chat_name_account_key, ACCOUNT);
    }
    return after;
  }

  test('empty sync CLI advances past an oversized predecessor to the 21st legacy received title', t => {
    const f = fixture(t, 21, { oversized: [1], scope: true }), original = snapshot(f.db), before = messages(f);
    assert.equal(before.length, 20); assert(before.every(row => row.display.chat !== TITLE));
    for (let i = 0; i < 9; i++) f.cycle(i + 1, i * 360001);
    finish(f, original, before, 20);
    const huge = snapshot(f.db)[0]; assert.equal(huge.canonical, original[0].canonical, 'oversized row is retained without pretending it was bound');
    const last = f.runs.at(-1); assert(last.task && Number.isSafeInteger(last.task.retry_at_ms));
    assert(last.task.retry_at_ms <= last.nowMs + DAY, 'capacity debt retains a bounded future opportunity');
    assert(f.runs.some(run => run.nameReport.reason === 'capacity_deferred'));
  });

  test('daily empty sync opportunities cross metadata freshness without starving 45 legacy received titles', t => {
    const f = fixture(t, 45), original = snapshot(f.db), before = messages(f);
    assert.equal(before.length, 45); assert(before.every(row => row.display.chat !== TITLE));
    for (let i = 0; i < 9; i++) f.cycle(i + 1, i * (DAY + 1));
    finish(f, original, before, 45);
    assert(f.runs.filter(run => run.calls.some(call => call.route === 'chat')).length > 1, 'actual metadata refresh boundaries were exercised');
    assert(f.runs.every((run, index) => index === 0 || run.marked >= f.runs[index - 1].marked));
  });

  test('twenty newer oversized rows cannot hide an already queued exact historical witness from sync CLI', t => {
    const f = fixture(t, 1);
    const first = f.cycle(0, 0);
    assert(first.task && first.task.latest_record_id === 1); assert.equal(first.marked, 0);
    assert(first.calls.some(call => call.route === 'chat' && !call.nameAvailable), 'the old exact row is durably queued before newer large rows exist');
    f.append(2, 21, Array.from({ length: 20 }, (_, index) => index + 2));
    const original = snapshot(f.db), before = messages(f);
    for (let i = 1; i <= 5; i++) f.cycle(i, i * (DAY + 1));
    finish(f, original, before, 1);
    assert(!f.runs.slice(1).some(run => run.nameReport.reason === 'witness_unavailable'), 'the queued historical exact witness remains selectable');
    assert(f.runs.slice(1).some(run => run.calls.some(call => call.route === 'chat' && call.nameAvailable)));
    assert(snapshot(f.db).slice(1).every((row, index) => row.canonical === original[index + 1].canonical));
  });
}
