import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { quoteSql as q, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { activityDatabaseKey } from '../src/diagnostics/lark-im-activity-evidence.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { digest, sampleScopeHash } from '../src/diagnostics/remote-sample-core.mjs';
import { scopeObservationContext } from '../src/maintenance/scope-config-policy.mjs';
import { resolveRemoteSampleDue } from '../src/runtime/worker/remote-sample-wake.mjs';

// Only an authored temporary SQLite fixture is used. The production bounded
// read-only ticket query runs; no collector, API, lease or service is started.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-wake-ticket-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite'), start = Date.parse('2031-02-03T12:00:00Z');
  const target = start - 3 * 86400000, chat = 'oc_synthetic_wake', id = 'om_synthetic_wake', scope = chatScopeId(chat);
  const sourceConfig = JSON.stringify({ initial_sync_start_ms: target - 1000 });
  const scopeConfig = JSON.stringify({ chat_id: chat, chat_type: 'group' });
  sqliteExec(db, `CREATE TABLE sources(id TEXT PRIMARY KEY,enabled INTEGER,config_json TEXT);
    CREATE TABLE sync_scopes(id TEXT PRIMARY KEY,source_id TEXT,enabled INTEGER,config_json TEXT);
    CREATE TABLE records(id INTEGER PRIMARY KEY,external_id TEXT,container_id TEXT,occurred_at_ms INTEGER,source_id TEXT,record_type TEXT);
    CREATE TABLE record_observation_state(record_id INTEGER PRIMARY KEY,generation INTEGER);
    CREATE TABLE lark_im_history_debt(record_id INTEGER PRIMARY KEY,finding_key TEXT,database_key TEXT,account_key TEXT,
      context_fingerprint TEXT,debt_fingerprint TEXT,scope_id TEXT,verification_generation INTEGER,verification_requested_at_ms INTEGER,status TEXT);
    INSERT INTO sources VALUES('lark.im',1,${q(sourceConfig)});
    INSERT INTO sync_scopes VALUES(${q(scope)},'lark.im',1,${q(scopeConfig)});
    INSERT INTO records VALUES(1,${q(id)},${q(chat)},${target},'lark.im','lark.im.message');
    INSERT INTO record_observation_state VALUES(1,3);`);
  const binding = { database_key: activityDatabaseKey(db), account_key: 'b'.repeat(64) };
  const key = digest([binding.database_key, binding.account_key, chat, id, target]);
  const observation = { kind: 'version', target, first_seen: start - 10000, last_seen: start - 10000,
    run_finished: 0, last_checked: start - 10000, scope_hash: sampleScopeHash(binding, chat), debts: { version: target } };
  const context = digest({ source: sourceConfig, scope, policy: scopeObservationContext(scopeConfig) });
  const debt = digest({ version: target });
  sqliteExec(db, `INSERT INTO lark_im_history_debt VALUES(1,${q(key)},${q(binding.database_key)},${q(binding.account_key)},
    ${q(context)},${q(debt)},${q(scope)},3,${start + 1000},'awaiting_verification');`);
  const state = { kind: 'lark_im_remote_sample_schedule/v1', ...binding, written_at: start, next_due: start + 900000,
    failures: 0, rotation: 0, observations: { [key]: observation }, last_outcome: 'ok', cooldowns: {}, blocked_reason: null };
  return { db, start, state, key, context, debt, sourceConfig, scopeConfig,
    resolve: () => resolveRemoteSampleDue({ db }, state, start + 60000),
    mutate: sql => sqliteExec(db, sql) };
}

test('real read-only ticket query wakes one valid generation without changing database or observations', t => {
  const f = fixture(t), before = readFileSync(f.db), saved = JSON.stringify(f.state);
  const result = f.resolve();
  assert.equal(result.next_due, f.start + 60000);
  assert.match(result.wake.state_hash, /^[a-f0-9]{64}$/);
  assert.equal(result.wake.not_before, result.next_due);
  assert.deepEqual(readFileSync(f.db), before);
  assert.equal(JSON.stringify(f.state), saved);
});

test('lock-side re-resolution rejects tickets changed after a successful parent precheck', t => {
  const f = fixture(t), unchanged = { next_due: f.state.next_due, wake: null };
  for (const [change, restore] of [
    ['UPDATE record_observation_state SET generation=4', 'UPDATE record_observation_state SET generation=3'],
    ['UPDATE lark_im_history_debt SET verification_generation=NULL', 'UPDATE lark_im_history_debt SET verification_generation=3'],
    [`UPDATE lark_im_history_debt SET verification_requested_at_ms=${f.start - 10000}`, `UPDATE lark_im_history_debt SET verification_requested_at_ms=${f.start + 1000}`],
    ["UPDATE lark_im_history_debt SET status='ready'", "UPDATE lark_im_history_debt SET status='awaiting_verification'"],
    ['UPDATE sources SET enabled=0', 'UPDATE sources SET enabled=1'],
    ['UPDATE sync_scopes SET enabled=0', 'UPDATE sync_scopes SET enabled=1'],
    [`UPDATE lark_im_history_debt SET account_key=${q('c'.repeat(64))}`, `UPDATE lark_im_history_debt SET account_key=${q(f.state.account_key)}`],
    [`UPDATE lark_im_history_debt SET database_key=${q('c'.repeat(64))}`, `UPDATE lark_im_history_debt SET database_key=${q(f.state.database_key)}`],
    [`UPDATE lark_im_history_debt SET context_fingerprint=${q('c'.repeat(64))}`, `UPDATE lark_im_history_debt SET context_fingerprint=${q(f.context)}`],
    [`UPDATE lark_im_history_debt SET debt_fingerprint=${q('c'.repeat(64))}`, `UPDATE lark_im_history_debt SET debt_fingerprint=${q(f.debt)}`],
    ["UPDATE sources SET config_json='{}'", `UPDATE sources SET config_json=${q(f.sourceConfig)}`],
    ["UPDATE sync_scopes SET config_json='{}'", `UPDATE sync_scopes SET config_json=${q(f.scopeConfig)}`],
  ]) {
    assert.ok(f.resolve().wake, 'parent precheck sees a valid ticket');
    f.mutate(change);
    assert.deepEqual(f.resolve(), unchanged, 'inner recheck must not reuse the earlier hint');
    f.mutate(restore);
  }
});
