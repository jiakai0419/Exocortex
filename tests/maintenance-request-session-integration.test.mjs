import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { ensureInitialized, quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { executeEnrichment } from '../src/maintenance/enrich.mjs';
import { createMaintenanceRequestSession, MaintenanceRequestError } from '../src/maintenance/request-session.mjs';
import { tryAcquireLarkApiLease, readSharedLarkCooldown, writeSharedLarkCooldown } from '../src/runtime/lark-api-lease.mjs';

const q = quoteSql;
const success = value => ({ status: 0, signal: null, stdout: JSON.stringify(value), stderr: '' });
const limited = () => ({ status: 1, signal: null, stdout: JSON.stringify({ error: {
  type: 'api', code: 99991400, message: 'SYNTHETIC_PRIVATE_RATE_LIMIT', detail: { headers: { 'x-ogw-ratelimit-reset': '60' } },
} }), stderr: '' });

function read(db, sql, json = false) {
  const result = spawnSync('sqlite3', ['-readonly', ...(json ? ['-json'] : []), db, sql], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return json ? JSON.parse(result.stdout || '[]') : result.stdout;
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-maintenance-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'synthetic.sqlite'); ensureInitialized(db);
  for (let index = 1; index <= 2; index++) {
    const cid = `oc_synthetic_budget_${index}`, app = `cli_synthetic_budget_${index}`;
    const scope = `lark.im.received.chat.synthetic-budget-${index}`;
    const raw = { message_id: `om_synthetic_budget_${index}`, chat_id: cid, msg_type: 'text',
      create_time: String(2_700_000_000_000 + index), sender: { id: app, id_type: 'app_id', sender_type: 'app' },
      content: { text: `Synthetic receipt ${index}.` } };
    const canonical = { sender_id: app, sender_id_type: 'app_id', sender_type: 'app', sender_name: null,
      chat_id: cid, chat_type: 'group', chat_name: null, msg_type: 'text', content: raw.content };
    sqliteExec(db, `INSERT INTO sync_scopes(id,source_id,name,config_json,updated_at)
      VALUES(${q(scope)},'lark.im',${q(`Synthetic budget scope ${index}`)},${q(JSON.stringify({ chat_id: cid, chat_type: 'group', chat_name: null }))},'2055-01-01T00:00:00.000Z');
      INSERT INTO records(source_id,first_seen_scope_id,external_id,external_version,record_type,occurred_at,occurred_at_ms,
        actor_id,container_id,direction,body,content_hash,canonical_json,raw_json)
      VALUES('lark.im',${q(scope)},${q(raw.message_id)},'synthetic-version','lark.im.message','2055-01-01T00:00:00.000Z',
        ${2_700_000_000_000 + index},${q(app)},${q(cid)},'received',${q(raw.content.text)},'synthetic-hash',${q(JSON.stringify(canonical))},${q(JSON.stringify(raw))});`);
  }
  const state = { offset: 0, calls: [], successfulNames: 0, maxSeconds: 30, leaseEvents: [] };
  const directory = join(root, 'api-state');
  const now = () => Math.floor(Date.now() + state.offset);
  const monotonicClock = () => performance.now() + state.offset;
  const deps = {
    now, monotonicClock, env: { LARK_CLI: 'synthetic-only-never-executed' },
    sleep(ms) { state.offset += ms; },
    tryAcquireLease(options) {
      // Keep the real 2-second runtime boundary. If a host suspension, helper
      // error or unsafe fixture blocks it, retain the underlying evidence
      // rather than reporting only the command's public lease_unavailable.
      const started = performance.now(), event = { role: options.role };
      const lease = tryAcquireLarkApiLease(options, { directory, clock: now, monotonicClock,
        spawnSync(command, args, settings) {
          const helperStarted = performance.now();
          const result = spawnSync(command, args, settings);
          Object.assign(event, { helper_timeout_ms: settings.timeout,
            helper_elapsed_ms: performance.now() - helperStarted, helper_status: result.status,
            helper_signal: result.signal, helper_error_code: result.error?.code ?? null });
          return result;
        },
      });
      Object.assign(event, { state: lease.state, reason: lease.reason, elapsed_ms: performance.now() - started });
      state.leaseEvents.push(event);
      return lease;
    },
    readSharedCooldown: options => readSharedLarkCooldown(options, { directory }),
    writeSharedCooldown: options => writeSharedLarkCooldown(options, { directory }),
  };
  return { root, db, state, directory, deps };
}
function assertNoCommit(f, before) {
  assert.equal(read(f.db, '.dump'), before, 'all synthetic tables, including records/scopes/audit, remain byte-for-byte equal in the SQL dump');
  assert.equal(read(f.db, 'SELECT count(*) FROM maintenance_locks;').trim(), '0');
  assert.ok(existsSync(join(f.directory, 'api.lock')), 'the real kernel lease was used in the private fixture directory');
  const acquired = tryAcquireLarkApiLease({ role: 'sync' }, { directory: f.directory });
  assert.equal(acquired.state, 'acquired', 'the stopped command released its real API lease'); acquired.release();
}

for (const target of ['records', 'scopes']) for (const failure of ['budget', 'rate_limit', 'timeout']) {
  test(`${target}: a resolved name followed by ${failure} cannot partially commit through best-effort catches`, t => {
    const f = fixture(t); const before = read(f.db, '.dump');
    f.deps.spawnSync = (_command, args, settings) => {
      f.state.calls.push(args);
      assert.ok(Array.isArray(settings.stdio) && settings.stdio.length === 4, 'real lease descriptor reaches the CLI spawn boundary');
      assert.ok(settings.timeout > 0 && settings.timeout <= 5000);
      assert.equal(read(f.db, 'SELECT count(*) FROM maintenance_locks;').trim(), '0');
      if (args[0] === 'contact' && args[1] === '+get-user') return success({ open_id: 'ou_synthetic_self', name: 'Synthetic Self' });
      if (f.state.successfulNames++ === 0) {
        if (target === 'records') {
          assert.ok(args[2].startsWith('/open-apis/application/v6/applications/'));
          return success({ data: { app: { app_name: 'Synthetic Resolved Application' } } });
        }
        assert.deepEqual(args.slice(0, 3), ['im', 'chats', 'get']);
        return success({ data: { name: 'Synthetic Resolved Room' } });
      }
      if (failure === 'rate_limit') return limited();
      if (failure === 'timeout') {
        f.state.offset += 30_001;
        return { status: null, signal: 'SIGKILL', stdout: '', stderr: '', error: { code: 'ETIMEDOUT', message: 'synthetic timeout' } };
      }
      assert.fail('CLI count budget must reject this attempt before spawn');
    };
    const maxCliAttempts = failure === 'budget' ? target === 'records' ? 2 : 1 : 12;
    const reason = failure === 'budget' ? 'cli_budget' : failure === 'rate_limit' ? 'rate_limited' : 'time_budget';
    assert.throws(() => executeEnrichment({ target, db: f.db, apply: true, maxCliAttempts, maxSeconds: 30 },
      { requestSessionDeps: f.deps }), error => {
      assert.ok(error instanceof MaintenanceRequestError);
      assert.equal(error.reason, reason, `real kernel lease diagnostics: ${JSON.stringify(f.state.leaseEvents)}`);
      return true;
    });
    assert.ok(f.state.successfulNames >= 1, 'a useful remote name was obtained before the later stop');
    assert.equal(f.state.calls.length, (target === 'records' ? 2 : 1) + (failure === 'budget' ? 0 : 1));
    assertNoCommit(f, before);
  });
}

test('independent maintenance sessions share durable cooldown, and the stopped first session cannot switch operations', t => {
  const f = fixture(t); let calls = 0;
  const deps = { ...f.deps, spawnSync: () => { calls++; return limited(); } };
  const first = createMaintenanceRequestSession({ db: f.db }, deps);
  const application = ['api', 'GET', '/open-apis/application/v6/applications/cli_synthetic_shared'];
  assert.throws(() => first.runLark(application), error => error.reason === 'rate_limited');
  const published = readdirSync(join(f.directory, 'cooldowns')).filter(name => name.startsWith('application_info-'));
  assert.equal(published.length, 1);
  const second = createMaintenanceRequestSession({ db: f.db }, deps);
  assert.throws(() => second.runLark(application), error => error.reason === 'rate_cooldown');
  assert.throws(() => first.runLark(['contact', '+get-user']), error => error.reason === 'rate_limited');
  assert.throws(first.assertReady, error => error.reason === 'rate_limited');
  assert.equal(calls, 1, 'neither a new command nor a different fallback bypasses the established stop');
  assert.equal(second.summary().cli_attempts, 0);
});

test('a real sync kernel lease excludes maintenance without any CLI spawn or wait', t => {
  const f = fixture(t), before = read(f.db, '.dump');
  const sync = f.deps.tryAcquireLease({ role: 'sync' });
  assert.equal(sync.state, 'acquired', JSON.stringify(f.state.leaseEvents));
  try {
    const session = createMaintenanceRequestSession({ db: f.db }, { ...f.deps,
      spawnSync() { assert.fail('maintenance must not execute a CLI while sync holds the real kernel lease'); },
      sleep() { assert.fail('maintenance must not wait for an occupied kernel lease'); },
    });
    assert.throws(() => session.runLark(['contact', '+get-user']), error => error.reason === 'sync_busy');
    assert.equal(session.summary().cli_attempts, 0);
    assert.equal(f.state.leaseEvents.at(-1).reason, 'lark_api_busy', JSON.stringify(f.state.leaseEvents));
    assert.throws(session.assertReady, error => error.reason === 'sync_busy');
  } finally { sync.release(); }
  assertNoCommit(f, before);
});

test('a real sync kernel lease can take the unlocked inter-request gap and blocks the next maintenance spawn', t => {
  const f = fixture(t), before = read(f.db, '.dump');
  let sync, calls = 0, gaps = 0;
  const deps = { ...f.deps,
    spawnSync(_command, _args, settings) {
      assert.equal(settings.stdio.length, 4);
      const contender = f.deps.tryAcquireLease({ role: 'sync' });
      try { assert.equal(contender.state, 'busy', JSON.stringify(f.state.leaseEvents)); }
      finally { contender.release(); }
      calls++;
      return success({});
    },
    sleep(ms) {
      // Only elapsed waiting is synthetic. Both owners and contenders take
      // the real Python/flock path on distinct descriptors in our own file.
      gaps++;
      assert.ok(ms > 0 && ms <= 1000);
      assert.equal(sync, undefined, 'a gap must not overwrite an owned sync descriptor');
      sync = f.deps.tryAcquireLease({ role: 'sync' });
      assert.equal(sync.state, 'acquired', JSON.stringify(f.state.leaseEvents));
      f.state.offset += ms;
    },
  };
  try {
    const session = createMaintenanceRequestSession({ db: f.db }, deps);
    session.runLark(['contact', '+get-user']);
    assert.throws(() => session.runLark(['im', 'chats', 'get']), error => error.reason === 'sync_busy');
    assert.equal(gaps, 1); assert.equal(calls, 1);
    assert.equal(session.summary().cli_attempts, 1);
    assert.equal(f.state.leaseEvents.at(-1).reason, 'lark_api_busy', JSON.stringify(f.state.leaseEvents));
    sync.release(); sync = undefined;
    // The stopped session stays stopped; a fresh command can use the released
    // lease. This is a real handoff opportunity, not a FIFO priority promise.
    assert.throws(session.assertReady, error => error.reason === 'sync_busy');
    createMaintenanceRequestSession({ db: f.db }, deps).runLark(['contact', '+get-user']);
    assert.equal(calls, 2);
  } finally { sync?.release(); }
  assertNoCommit(f, before);
});

test('a successful real helper returning after its two-second boundary fails closed before any CLI or DB write', t => {
  const f = fixture(t), before = read(f.db, '.dump');
  let observed, helpers = 0, calls = 0;
  const deps = { ...f.deps,
    tryAcquireLease(options) {
      const result = tryAcquireLarkApiLease(options, { directory: f.directory,
        clock: f.deps.now, monotonicClock: f.deps.monotonicClock,
        spawnSync(command, args, settings) {
          assert.ok(settings.timeout > 0 && settings.timeout <= 2000);
          const helper = spawnSync(command, args, settings);
          assert.equal(helper.status, 0, 'the private real kernel lock was acquired successfully');
          assert.equal(helper.error, undefined); assert.equal(helper.signal, null);
          helpers++;
          // Controlled monotonic elapsed time models suspension/scheduling
          // after a successful helper. It does not identify the cause of a
          // historical helper failure for which no result was recorded.
          f.state.offset += 2001;
          return helper;
        },
      });
      observed = { state: result.state, reason: result.reason };
      return result;
    },
    spawnSync() { calls++; assert.fail('a late lease helper cannot authorize a business CLI'); },
  };
  assert.throws(() => executeEnrichment({ target: 'records', db: f.db, apply: true }, { requestSessionDeps: deps }),
    error => error instanceof MaintenanceRequestError && error.reason === 'lease_unavailable');
  assert.deepEqual(observed, { state: 'unavailable', reason: 'lease_helper_unavailable' });
  assert.equal(helpers, 1, 'no helper retry is allowed'); assert.equal(calls, 0);
  assertNoCommit(f, before);
});
