import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import { OBSERVATION_POLICY } from '../dist/core/lark-observation.js';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { createSyncRunner } from '../src/adapters/lark-im/sync-runner.mjs';

// All rows, identities and interleaved writes are authored synthetic data.
// The temporary spawn hook matches only this fixture's exact database path.
// It changes no production dependency and never invokes a remote transport.
const START = Date.parse('2026-04-01T00:00:00.000Z');
const NOW = '2099-01-01T00:00:00.000Z';
const CHAT = 'oc_synthetic_detail_read_races', SCOPE = chatScopeId(CHAT);
const q = store.quoteSql;
const roots = ['z_first', 'a_second', 'm_third', 'b_unselected'].map((name, index) => ({
  message_id: `om_synthetic_read_${name}`, chat_id: CHAT,
  create_time: String(START + (index + 1) * 1000), update_time: String(START + 10000),
  msg_type: 'merge_forward',
  sender: { id: 'ou_synthetic_read_author', id_type: 'open_id', sender_type: 'user' },
  body: { content: '{"snapshot":1}' },
}));
function complete(root, snapshot = 2) {
  const changed = { ...root, body: { content: JSON.stringify({ snapshot }) } };
  const child = { ...root, message_id: `${root.message_id}_child`, upper_message_id: root.message_id,
    msg_type: 'text', body: { content: '{"text":"Synthetic complete read-race child"}' } };
  return recordFromMessage(normalizeApiMessage(changed, { mergeItems: [changed, child] }), SCOPE, 'received');
}
function fixture(t, { through011 = false, queue = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-detail-read-races-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite');
  if (through011) {
    const oldMigrations = join(directory, 'through011'); mkdirSync(oldMigrations);
    const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
    for (const name of readdirSync(migrations).filter(name => /^\d{3}_.*\.sql$/.test(name) && name.slice(0, 3) <= '011')) {
      copyFileSync(join(migrations, name), join(oldMigrations, name));
    }
    store.ensureInitialized(db, { migrationsDir: oldMigrations });
  } else store.ensureInitialized(db);
  store.sqliteExec(db, `UPDATE sources SET config_json=${q(JSON.stringify({ initial_sync_start_ms: START }))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(SCOPE)},'lark.im','Synthetic read-race scope',
      ${q(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`);
  const f = { db, directory };
  if (queue) {
    const scope = store.readScope(db, SCOPE), run = store.createRun(db, scope);
    store.commitLarkListRun(db, scope, run, [], roots, roots.length,
      { created_at_ms: START + 60000 }, { initial_sync_start_ms: START,
        list_window_start_ms: START, list_window_end_ms: START + 60000 });
    store.sqliteExec(db, roots.map(root => `UPDATE lark_im_detail_tasks SET retry_at='2030-01-01T00:00:00.000Z',
      evidence_generation=evidence_generation+1,candidate_json=${q(JSON.stringify(complete(root)))},
      candidate_generation=descriptor_generation,candidate_attempt='synthetic-earlier-detail-read',
      candidate_policy=${q(OBSERVATION_POLICY)},candidate_context='synthetic-read-race-context',candidate_observed_at_ms=${START}
      WHERE scope_id=${q(SCOPE)} AND message_id=${q(root.message_id)};`).join('\n'));
  }
  return f;
}
const read = (f, limit = 3) => store.readPendingLarkDetails(f.db, store.readScope(f.db, SCOPE), { limit, now: NOW });
const rows = f => store.sqliteQuery(f.db, 'SELECT * FROM lark_im_detail_tasks ORDER BY occurred_at_ms;');
const coverage = f => ({
  scope: store.readScope(f.db, SCOPE),
  progress: store.sqliteQuery(f.db, 'SELECT * FROM lark_im_list_progress;'),
  runs: store.sqliteQuery(f.db, 'SELECT * FROM sync_runs;'),
});

function afterLightRead(f, mutationSql, work = () => read(f)) {
  const originalSpawn = childProcess.spawnSync;
  let injections = 0, lightweightReads = 0, fullReads = 0;
  const selectedIds = [];
  childProcess.spawnSync = function (command, args, options) {
    const result = originalSpawn(command, args, options);
    if (command !== 'sqlite3' || !Array.isArray(args) || !args.includes(f.db)) return result;
    const sql = String(options?.input || '');
    if (/SELECT d\.\*, EXISTS\(/.test(sql) && sql.includes('FROM lark_im_detail_tasks d')) fullReads++;
    if (!/SELECT message_id, descriptor_generation, evidence_generation FROM lark_im_detail_tasks/.test(sql)) return result;
    lightweightReads++;
    assert.equal(result.status, 0, String(result.stderr));
    const selected = JSON.parse(String(result.stdout));
    assert.ok(selected.every(row => !('candidate_json' in row) && !('raw_root_json' in row)), 'selection exports no large payloads');
    selectedIds.push(...selected.map(row => row.message_id));
    assert.equal(injections, 0, 'one fixed lightweight horizon per read');
    const mutated = originalSpawn('sqlite3', [f.db], {
      input: `.bail on\nPRAGMA foreign_keys=ON;\nBEGIN IMMEDIATE;\n${mutationSql}\nCOMMIT;\n`, encoding: 'utf8',
    });
    assert.equal(mutated.status, 0, String(mutated.stderr));
    assert.equal(mutated.error, undefined);
    injections++;
    return result;
  };
  syncBuiltinESMExports();
  try {
    const value = work();
    assert.equal(injections, 1, 'the race occurred after the lightweight query returned');
    return { value, selectedIds, lightweightReads, fullReads };
  } finally {
    childProcess.spawnSync = originalSpawn;
    syncBuiltinESMExports();
  }
}

for (const mutation of ['descriptor change', 'descriptor ABA', 'candidate evidence change', 'completion', 'deletion', 'rescheduled retry']) {
  test(`two-stage pending read defers ${mutation} and keeps stable selected rows in their original order`, t => {
    const f = fixture(t), before = rows(f), savedCoverage = coverage(f), target = before[1];
    const changed = { ...roots[1], body: { content: '{"snapshot":3}' } };
    const where = `WHERE scope_id=${q(SCOPE)} AND message_id=${q(target.message_id)}`;
    let sql;
    if (mutation === 'descriptor change') sql = `UPDATE lark_im_detail_tasks SET raw_root_json=${q(JSON.stringify(changed))} ${where};`;
    else if (mutation === 'descriptor ABA') sql = `UPDATE lark_im_detail_tasks SET raw_root_json=${q(JSON.stringify(changed))} ${where};
      UPDATE lark_im_detail_tasks SET raw_root_json=${q(target.raw_root_json)} ${where};`;
    else if (mutation === 'candidate evidence change') sql = `UPDATE lark_im_detail_tasks SET evidence_generation=evidence_generation+1,
      candidate_json=${q(JSON.stringify(complete(roots[1], 4)))} ${where};`;
    else if (mutation === 'completion') sql = `UPDATE lark_im_detail_tasks SET status='complete' ${where};`;
    else if (mutation === 'deletion') sql = `DELETE FROM lark_im_detail_tasks ${where};`;
    else sql = `UPDATE lark_im_detail_tasks SET retry_at='2100-01-01T00:00:00.000Z' ${where};`;

    const result = afterLightRead(f, sql);
    assert.deepEqual(result.selectedIds, roots.slice(0, 3).map(row => row.message_id));
    assert.deepEqual(result.value.map(row => row.message_id), [roots[0].message_id, roots[2].message_id]);
    assert.equal(result.lightweightReads, 1); assert.equal(result.fullReads, 3);
    assert.ok(!result.value.some(row => row.message_id === roots[3].message_id), 'a freed slot does not cause out-of-order backfill');
    for (const row of result.value) {
      const original = before.find(saved => saved.message_id === row.message_id);
      assert.deepEqual(row, { ...original, record_exists: 0, raw_root: JSON.parse(original.raw_root_json), raw: JSON.parse(original.raw_root_json) });
    }
    assert.deepEqual(coverage(f), savedCoverage, 'reading and its task-only race never fabricate progress or coverage');
    assert.equal(store.sqliteQuery(f.db, 'SELECT COUNT(*) n FROM records;')[0].n, 0);
    const current = rows(f).find(row => row.message_id === target.message_id);
    if (mutation === 'descriptor ABA') {
      assert.equal(current.raw_root_json, target.raw_root_json);
      assert.equal(current.descriptor_generation, target.descriptor_generation + 2, 'the real trigger records ABA even with restored bytes');
    } else if (mutation === 'candidate evidence change') {
      assert.equal(current.descriptor_generation, target.descriptor_generation);
      assert.equal(current.evidence_generation, target.evidence_generation + 1);
    }
    // The fixed read only defers a changed task; later reads may select its new
    // current state. Completed/deleted/not-due tasks remain ineligible.
    const later = read(f, 100);
    const remainsPending = !['completion', 'deletion', 'rescheduled retry'].includes(mutation);
    assert.equal(later.some(row => row.message_id === target.message_id), remainsPending);
    assert.ok(later.some(row => row.message_id === roots[3].message_id));
  });
}

test('record ownership is acquired in the same query as the full task after an intervening insertion', t => {
  const f = fixture(t), before = rows(f), savedCoverage = coverage(f);
  const inserted = complete(roots[1], 1);
  const result = afterLightRead(f, store.upsertRecordsSql([inserted]));
  assert.deepEqual(result.value.map(row => row.message_id), roots.slice(0, 3).map(row => row.message_id));
  assert.deepEqual(result.value.map(row => row.record_exists), [0, 1, 0], 'the full second row cannot inherit a stale orphan-owner flag');
  for (let index = 0; index < result.value.length; index++) {
    assert.deepEqual(result.value[index], { ...before[index], record_exists: index === 1 ? 1 : 0,
      raw_root: JSON.parse(before[index].raw_root_json), raw: JSON.parse(before[index].raw_root_json) });
  }
  assert.equal(result.lightweightReads, 1); assert.equal(result.fullReads, 3);
  assert.deepEqual(rows(f), before, 'ownership detection is read-only for the detail descriptors');
  assert.deepEqual(coverage(f), savedCoverage);
  assert.equal(store.sqliteQuery(f.db, 'SELECT COUNT(*) n FROM records;')[0].n, 1);
});

test('an empty 011 queue still rejects a direct pending read without silently migrating or acquiring a run', t => {
  const f = fixture(t, { through011: true, queue: false }), scope = store.readScope(f.db, SCOPE);
  const snapshot = () => ({
    schema: store.sqliteQuery(f.db, "SELECT * FROM sqlite_master ORDER BY type,name;"),
    migrations: store.sqliteQuery(f.db, 'SELECT * FROM schema_migrations ORDER BY version;'),
    tasks: rows(f), records: store.sqliteQuery(f.db, 'SELECT * FROM records;'), coverage: coverage(f),
  });
  const before = snapshot();
  assert.deepEqual(before.tasks, []); assert.equal(before.migrations.at(-1).version, '011');
  assert.throws(() => store.readPendingLarkDetails(f.db, scope, { limit: 100, now: NOW }), /descriptor_generation/);
  assert.deepEqual(snapshot(), before);
  let requests = 0;
  const runner = createSyncRunner({ fetchMessageDetails: () => { requests++; assert.fail('no remote transport in empty queue test'); } });
  // With no due scope, the outer scheduler remains a harmless no-op. A direct
  // pending read must nevertheless compile its 012 preflight before returning [].
  assert.deepEqual(runner.retryDetails(f.db, { detailLimit: 20, detailScope: SCOPE, detailBudgetMs: 30000,
    lockTtlSeconds: 600, retries: 0, retryDelayMs: 0 }, { open_id: 'ou_synthetic_read_self' }), []);
  assert.equal(requests, 0); assert.deepEqual(snapshot(), before);
});
