import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCli } from '../bin/exocortex.mjs';
import { ensureInitialized, quoteSql as q, sqliteExec, INITIAL_ACCOUNT_KIND } from '../dist/storage/sqlite/ingestion-store.js';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';
import { syncReadiness } from '../src/diagnostics/message-readiness-sync.mjs';
import { createSyncRunner } from '../src/adapters/lark-im/sync-runner.mjs';
import { executeLarkImSync, normalizeSyncOptions } from '../src/adapters/lark-im/sync-command.mjs';
import { getLarkApiLeaseStdio, tryAcquireLarkApiLease } from '../src/runtime/lark-api-lease.mjs';

const HERE = fileURLToPath(import.meta.url), ROOT = dirname(dirname(HERE));
const SELF = { open_id: 'ou_synthetic_readiness_sync_owner', name: 'Invented Owner' };
const ACTOR = 'ou_synthetic_readiness_sync_actor', CHAT = 'oc_synthetic_readiness_sync_group';
const ACCOUNT = createHash('sha256').update(`lark.im\0${SELF.open_id}`).digest('hex');
const START = Date.parse('2025-01-02T00:00:00.000Z');

// All records and identities are authored. The child uses the real parser,
// runner, account admission, private flock, read pipeline and SQLite writer.
// Only profile/list API boundaries are replaced with authored empty responses.
if (process.argv[2] === '--synthetic-cycle') {
  const [directory, phaseText, clockText, mode] = process.argv.slice(3);
  assert(directory.startsWith(tmpdir()) && directory.includes('exo-readiness-sync-synthetic-'));
  const reject = () => { throw new Error('synthetic readiness test forbids network'); };
  globalThis.fetch = reject; Socket.prototype.connect = reject;
  const db = join(directory, 'synthetic.sqlite'), phase = Number(phaseText);
  let stdout = '', stderr = '', names = 0, lists = 0, readiness = null, profiles = 0;
  const deps = {
    getSelfProfile: () => { profiles++; assert(getLarkApiLeaseStdio()); return SELF; },
    resetTransportStats() {}, getTransportStats: () => ({ calls: 0 }),
    tryAcquireLarkApiLease: options => tryAcquireLarkApiLease(options, { directory: join(directory, 'private-api-state') }),
    syncRunnerDeps: {
      fetchSentMessageList: () => { lists++; assert(getLarkApiLeaseStdio()); return { messages: [], detailRoots: [], pages: 1 }; },
      fetchChatMessageList: reject, fetchChatDiscoveryPage: reject, fetchMessageDetails: reject, buildPeopleContext: reject,
      syncNames: () => { names++; throw new Error('synthetic name tail failed'); },
      ...(mode === 'default' ? {} : { syncReadiness: (path, self) => {
        readiness = syncReadiness(path, self, { now: () => Number(clockText) }); return readiness;
      } }),
    },
  };
  const code = await runCli(['sync', '--db', db, '--scope', 'sent', '--start', new Date(START).toISOString(),
    '--end', new Date(START + phase * 60000).toISOString(), '--format', 'json'], {
    root: ROOT, cwd: directory, env: {}, deps,
    stdout: { write: text => stdout += text }, stderr: { write: text => stderr += text },
  });
  assert.equal(getLarkApiLeaseStdio(), undefined, 'the CLI releases its real flock after both tails');
  process.stdout.write(JSON.stringify({ code, stdout, stderr, names, lists, profiles, readiness, pid: process.pid }));
} else {
  function fixture(t) {
    const directory = mkdtempSync(join(tmpdir(), 'exo-readiness-sync-synthetic-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const db = join(directory, 'synthetic.sqlite'); ensureInitialized(db);
    const raw = { message_id: 'om_synthetic_readiness_sync_old', chat_id: CHAT, chat_type: 'group',
      chat_name: 'Invented Stable Group', msg_type: 'text', create_time: String(START + 1000),
      sender: { id: ACTOR, id_type: 'open_id', sender_type: 'user' }, body: { content: '{"text":"Invented old body."}' } };
    const canonical = { message_id: raw.message_id, chat_id: CHAT, chat_type: 'group', chat_name: raw.chat_name,
      chat_name_source: 'message', sender_id: ACTOR, sender_id_type: 'open_id', sender_type: 'user', msg_type: 'text' };
    const binding = { initial_account_binding: { kind: INITIAL_ACCOUNT_KIND, account_key: ACCOUNT,
      reserved_at: '2025-01-01T00:00:00.000Z', confirmed_at: '2025-01-01T00:00:00.000Z' } };
    sqliteExec(db, `UPDATE sources SET config_json=${q(JSON.stringify(binding))} WHERE id='lark.im';
      INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,record_type,occurred_at,occurred_at_ms,
        actor_id,container_id,direction,body,canonical_json,raw_json)
      VALUES(1,'lark.im','lark.im.sent_by_me',${q(raw.message_id)},'1','lark.im.message',${q(new Date(START + 1000).toISOString())},
        ${START + 1000},${q(ACTOR)},${q(CHAT)},'received','Invented old body.',${q(JSON.stringify(canonical))},${q(JSON.stringify(raw))});`);
    const query = sql => readOnlySqliteJson(db, sql, 'inspect synthetic sync observation');
    const ledger = () => query('SELECT * FROM lark_im_message_readiness;');
    function cycle(phase, clock = Date.now(), mode = '') {
      const result = spawnSync(process.execPath, [HERE, '--synthetic-cycle', directory, String(phase), String(clock), mode], {
        encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LARK_CLI: '/usr/bin/false' },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(result.stderr, '');
      const value = JSON.parse(result.stdout);
      assert.equal(value.code, 0, value.stderr || value.stdout); assert.equal(value.stderr, '');
      assert.equal(value.names, 1); assert.equal(value.profiles, 1); assert.equal(value.lists, 1);
      const summary = JSON.parse(value.stdout);
      assert.equal(summary.ok, true); assert.equal(summary.sent.scanned, 0); assert.equal(summary.sent.list_complete, true);
      assert.equal(Object.hasOwn(summary, 'readiness'), false, 'status/public sync shape remains unchanged');
      return value;
    }
    return { directory, db, query, ledger, cycle };
  }

  test('default runner observes an actual empty successful CLI cycle despite the name tail throwing', t => {
    const f = fixture(t), records = f.query('SELECT * FROM records;');
    const result = f.cycle(1, Date.now(), 'default');
    assert.equal(result.readiness, null, 'the production default hook was used without replacing it');
    assert.equal(f.ledger().length, 1); assert.equal(f.ledger()[0].state, 'enriching');
    assert.equal(f.ledger()[0].observer_account_key, ACCOUNT);
    assert.deepEqual(f.query('SELECT * FROM records;'), records);
  });

  test('separate CLI processes observe old-record recovery and regression without any new message', t => {
    const f = fixture(t), now = Date.now(), original = f.query('SELECT * FROM records;')[0];
    const first = f.cycle(1, now), missing = f.ledger()[0];
    assert.equal(first.readiness.observed, 1);
    sqliteExec(f.db, `UPDATE records SET canonical_json=json_set(canonical_json,'$.sender_name','Invented Recovered Human',
      '$.sender_name_source','contact','$.sender_name_confidence','high','$.sender_name_account_key',${q(ACCOUNT)});`);
    const second = f.cycle(2, now + 60001), ready = f.ledger()[0];
    assert.notEqual(first.pid, second.pid); assert.equal(second.readiness.observed, 1);
    assert.equal(ready.state, 'ready'); assert.equal(ready.first_missing_observed_at_ms, missing.first_missing_observed_at_ms);
    assert(ready.first_ready_observed_at_ms >= missing.last_observed_at_ms);
    const before = f.ledger();
    assert.equal(f.cycle(3, now + 60002).readiness.reason, 'cadence'); assert.deepEqual(f.ledger(), before);
    sqliteExec(f.db, "UPDATE records SET canonical_json=json_remove(canonical_json,'$.sender_name');");
    assert.equal(f.cycle(4, now + 120002).readiness.observed, 1);
    assert.equal(f.ledger()[0].observed_regression_count, 1); assert.equal(f.ledger()[0].state, 'enriching');
    const final = f.query('SELECT * FROM records;')[0];
    for (const key of Object.keys(original).filter(key => key !== 'canonical_json')) assert.equal(final[key], original[key]);
    assert.equal(f.query('SELECT COUNT(*) AS n FROM records;')[0].n, 1);
  });

  test('a failing actual mapping read leaves collection successful and persists observation deferral', t => {
    const f = fixture(t), records = f.query('SELECT * FROM records;');
    writeFileSync(`${f.db}.chat-app-names.json`, '{"invalid":"synthetic mapping"}', { mode: 0o600 });
    const result = f.cycle(1);
    assert.equal(result.readiness.reason, 'observation_failed'); assert.equal(result.readiness.deferred, 1);
    assert.equal(f.ledger().length, 0);
    const scan = f.query('SELECT * FROM lark_im_message_readiness_scan;')[0];
    assert.equal(scan.last_scanned_count, 1); assert.equal(scan.last_deferred_count, 1);
    assert.deepEqual(f.query('SELECT * FROM records;'), records);
  });

  test('default wrapper refuses a missing API lease before opening or changing a database', t => {
    const f = fixture(t), before = readFileSync(f.db);
    assert.equal(syncReadiness(f.db, SELF).reason, 'lease_unavailable');
    assert.equal(createSyncRunner().syncReadiness('/synthetic/not-opened.sqlite', SELF).reason, 'lease_unavailable');
    assert.deepEqual(readFileSync(f.db), before);
  });

  for (const [result, expected] of [[{ ok: true, list_complete: true }, 1],
    [{ ok: false, list_complete: true, pending_details: 1 }, 1], [{ ok: false }, 0], [{ ok: true, skipped: true }, 0]]) {
    test(`observation selection respects committed-list success ${JSON.stringify(result)}`, () => {
      let observed = 0;
      const options = normalizeSyncOptions({ db: '/synthetic/not-opened.sqlite', scope: 'sent',
        start: '2025-01-02T00:00:00Z', end: '2025-01-02T01:00:00Z' });
      const before = { database_key: 'synthetic', empty: false, binding_absent: false };
      const summary = executeLarkImSync(options, { ensureInitialized() {}, captureRemoteAccountBinding: () => before,
        getSelfProfile: () => SELF, readRemoteAccountBinding: () => ({ state: 'verified', database_key: 'synthetic' }),
        ensureSourceInitialSyncStart: (_db, _source, start) => start, reserveSyncAccountBinding() {},
        captureLarkWriteAdmission: () => ({ fence: {}, assertCurrent() {} }), recordSuccessfulSyncBinding() {},
        syncRunner: { syncSent: () => result, syncNames() { throw new Error('synthetic name failure'); },
          syncReadiness() { observed++; throw new Error('synthetic observation failure'); } } });
      assert.equal(observed, expected); assert.equal(summary.sent, result);
      assert.equal(summary.ok, result.ok !== false);
    });
  }
}
