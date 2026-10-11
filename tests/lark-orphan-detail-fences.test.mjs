import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import { pendingDetailContextKey } from '../dist/storage/sqlite/pending-detail-observation.js';
import { captureLarkWriteAdmission } from '../src/diagnostics/lark-write-admission.mjs';
import { activityDatabaseKey } from '../src/diagnostics/lark-im-activity-evidence.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { createSyncRunner } from '../src/adapters/lark-im/sync-runner.mjs';

// Every row and identity is synthetic. Tests use the real store and SQLite;
// no adapter, live source, user database or API call is involved.
const START = Date.parse('2026-01-01T00:00:00Z');
const CHAT = 'oc_synthetic_orphan_fences', SCOPE = chatScopeId(CHAT);
const SELF = 'ou_synthetic_orphan_fences_self';
const q = store.quoteSql, sha = text => createHash('sha256').update(text).digest('hex');
const raw = (snapshot = 1, changes = {}) => ({ message_id: 'om_synthetic_orphan_fences', chat_id: CHAT,
  create_time: String(START + 1000), update_time: String(START + 2000), msg_type: 'merge_forward',
  sender: { id: 'ou_synthetic_orphan_fences_author', id_type: 'open_id', sender_type: 'user' },
  body: { content: JSON.stringify({ snapshot }) }, ...changes });
const complete = (snapshot = 2, changes = {}) => {
  const root = raw(snapshot, changes);
  return recordFromMessage(normalizeApiMessage(root, { mergeItems: [root,
    { ...raw(), message_id: root.message_id + '_child', upper_message_id: root.message_id,
      msg_type: 'text', body: { content: '{"text":"Synthetic full child"}' } }] }), SCOPE, 'received');
};
const readTask = f => store.sqliteQuery(f.db, 'SELECT * FROM lark_im_detail_tasks ORDER BY message_id;')[0];
const allRecords = f => store.sqliteQuery(f.db, 'SELECT * FROM records ORDER BY id;');
const fullCursor = f => store.readScope(f.db, SCOPE).cursor_json;
const taskSnapshot = f => ({ tasks: store.sqliteQuery(f.db, 'SELECT * FROM lark_im_detail_tasks ORDER BY message_id;'),
  records: allRecords(f), progress: store.sqliteQuery(f.db, 'SELECT * FROM lark_im_list_progress ORDER BY scope_id;'),
  full: fullCursor(f) });

function fixture(t, { through011 = false, queue = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-orphan-fences-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite');
  if (through011) {
    const oldMigrations = join(dir, 'through011'); mkdirSync(oldMigrations);
    const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
    for (const name of readdirSync(migrations).filter(name => /^\d{3}_.*\.sql$/.test(name) && name.slice(0, 3) <= '011')) {
      copyFileSync(join(migrations, name), join(oldMigrations, name));
    }
    store.ensureInitialized(db, { migrationsDir: oldMigrations });
  } else store.ensureInitialized(db);
  store.sqliteExec(db, `UPDATE sources SET config_json=${q(JSON.stringify({ initial_sync_start_ms: START,
    initial_account_binding: { kind: store.INITIAL_ACCOUNT_KIND, account_key: sha(`lark.im\0${SELF}`),
      reserved_at: '2026-01-01T00:00:00.000Z', confirmed_at: '2026-01-01T00:00:00.000Z' } }))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(SCOPE)},'lark.im','Synthetic orphan fence scope',
      ${q(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`);
  const f = { db, dir };
  if (queue) list(f, [raw()]);
  return f;
}

function list(f, roots, records = []) {
  const scope = store.readScope(f.db, SCOPE), run = store.createRun(f.db, scope);
  const start = store.readLarkListProgress(f.db, scope)?.cursor.created_at_ms ?? START;
  return store.commitLarkListRun(f.db, scope, run, records, roots, roots.length + records.length,
    { created_at_ms: START + 60000 }, { initial_sync_start_ms: START,
      list_window_start_ms: start, list_window_end_ms: START + 60000 });
}

function begin(f, { startedAtMs = Date.now() } = {}) {
  const scope = store.readScope(f.db, SCOPE);
  const admission = captureLarkWriteAdmission(f.db, { selfOpenId: SELF, requireVerified: true, scopeIds: [SCOPE] });
  scope.writeAdmission = admission.fence; scope.assertWriteAdmission = admission.assertCurrent;
  const task = store.readPendingLarkDetails(f.db, scope, { limit: 1, now: '2099-01-01T00:00:00.000Z' })[0];
  assert.ok(task, 'synthetic pending task exists');
  const run = store.createRun(f.db, scope), databaseKey = activityDatabaseKey(f.db);
  const acquisition = { task, attempt: `detail-run:${run}`, startedAtMs, databaseKey,
    contextKey: pendingDetailContextKey(databaseKey, scope) };
  return { scope, run, acquisition };
}

function finish(f, selected, record = complete()) {
  return store.finishLarkDetailRun(f.db, selected.scope, selected.run, [{ message_id: selected.acquisition.task.message_id,
    fingerprint: selected.acquisition.task.fingerprint, record, acquisition: selected.acquisition }]);
}

function seedCandidate(f) {
  const selected = begin(f), cursor = fullCursor(f);
  const result = finish(f, selected);
  assert.equal(result.inserted, 0); assert.equal(result.pending_details, 1);
  assert.equal(allRecords(f).length, 0); assert.equal(fullCursor(f), cursor);
  assert.ok(readTask(f).candidate_json);
  return selected;
}

test('a repeated detail-run acquisition cannot rewrite evidence or become its own confirmation', t => {
  const f = fixture(t), selected = seedCandidate(f), saved = taskSnapshot(f);
  assert.throws(() => finish(f, selected), /commit Lark progress/);
  assert.deepEqual(taskSnapshot(f), saved, 'replay rollback preserves the original candidate and cursor');
  const later = begin(f);
  assert.ok(later.acquisition.startedAtMs > readTask(f).candidate_observed_at_ms);
  assert.equal(finish(f, later).inserted, 1);
  assert.equal(readTask(f).status, 'complete');
  assert.equal(readTask(f).candidate_json, null);
  assert.equal(JSON.parse(fullCursor(f)).created_at_ms, START + 60000);
});

for (const offset of [-1, 0]) test(`overlapping acquisition start (${offset}) cannot confirm the earlier complete response`, t => {
  const f = fixture(t); seedCandidate(f);
  const candidateTime = readTask(f).candidate_observed_at_ms, cursor = fullCursor(f);
  const selected = begin(f, { startedAtMs: candidateTime + offset });
  const result = finish(f, selected);
  assert.equal(result.inserted, 0); assert.equal(result.pending_details, 1);
  assert.equal(allRecords(f).length, 0); assert.equal(fullCursor(f), cursor);
  assert.equal(readTask(f).candidate_attempt, selected.acquisition.attempt);
});

test('descriptor ABA is rejected even when list generation and root bytes return to the selected values', t => {
  const f = fixture(t); seedCandidate(f); const selected = begin(f), old = readTask(f);
  store.sqliteExec(f.db, `UPDATE lark_im_detail_tasks SET raw_root_json=${q(JSON.stringify(raw(3)))} WHERE scope_id=${q(SCOPE)};
    UPDATE lark_im_detail_tasks SET raw_root_json=${q(old.raw_root_json)} WHERE scope_id=${q(SCOPE)};`);
  assert.equal(readTask(f).raw_root_json, old.raw_root_json);
  assert.equal(readTask(f).descriptor_generation, old.descriptor_generation + 2);
  const saved = taskSnapshot(f);
  assert.throws(() => finish(f, selected), /commit Lark progress/);
  assert.deepEqual(taskSnapshot(f), saved);
});

test('candidate-only ABA is rejected by evidence generation without requiring a descriptor or list change', t => {
  const f = fixture(t); seedCandidate(f); const selected = begin(f), old = readTask(f);
  store.sqliteExec(f.db, `UPDATE lark_im_detail_tasks SET candidate_json=${q(JSON.stringify(complete(3)))},
      evidence_generation=evidence_generation+1 WHERE scope_id=${q(SCOPE)};
    UPDATE lark_im_detail_tasks SET candidate_json=${q(old.candidate_json)},
      evidence_generation=evidence_generation+1 WHERE scope_id=${q(SCOPE)};`);
  assert.equal(readTask(f).descriptor_generation, old.descriptor_generation);
  assert.equal(readTask(f).candidate_json, old.candidate_json);
  assert.equal(readTask(f).evidence_generation, old.evidence_generation + 2);
  const saved = taskSnapshot(f);
  assert.throws(() => finish(f, selected), /commit Lark progress/);
  assert.deepEqual(taskSnapshot(f), saved);
});

test('a concurrently inserted complete record changes the owner and prevents orphan acceptance', t => {
  const f = fixture(t); seedCandidate(f); const selected = begin(f);
  const other = store.readScope(f.db, 'lark.im.sent_by_me'), run = store.createRun(f.db, other);
  const independent = { ...complete(3), first_seen_scope_id: other.id };
  store.succeedRecordRun(f.db, other, run, [independent], 1, { created_at_ms: START + 60000 }, {});
  const saved = taskSnapshot(f);
  assert.equal(saved.records.length, 1);
  assert.throws(() => finish(f, selected), /commit Lark progress/);
  assert.deepEqual(taskSnapshot(f), saved);
  assert.equal(readTask(f).status, 'pending');
});

for (const [label, mutation] of [
  ['source policy', `UPDATE sources SET config_json=json_set(config_json,'$.synthetic_policy','changed') WHERE id='lark.im';`],
  ['source disabled', `UPDATE sources SET enabled=0 WHERE id='lark.im';`],
  ['scope policy', `UPDATE sync_scopes SET config_json=json_set(config_json,'$.synthetic_policy','changed') WHERE id=${q(SCOPE)};`],
  ['scope disabled', `UPDATE sync_scopes SET enabled=0 WHERE id=${q(SCOPE)};`],
  ['account binding', `UPDATE sources SET config_json=json_set(config_json,'$.initial_account_binding.account_key',
    ${q(sha('synthetic-other-account'))}) WHERE id='lark.im';`],
]) test(`orphan acceptance is fenced against changed ${label}`, t => {
  const f = fixture(t); seedCandidate(f); const selected = begin(f);
  store.sqliteExec(f.db, mutation); const saved = taskSnapshot(f);
  assert.throws(() => finish(f, selected));
  assert.deepEqual(taskSnapshot(f), saved);
});

for (const mode of ['missing admission', 'unverified admission', 'missing callback']) {
  test(`orphan acquisition refuses ${mode}`, t => {
    const f = fixture(t), selected = begin(f), saved = taskSnapshot(f);
    if (mode === 'missing admission') delete selected.scope.writeAdmission;
    if (mode === 'unverified admission') selected.scope.writeAdmission.requireVerified = false;
    if (mode === 'missing callback') delete selected.scope.assertWriteAdmission;
    assert.throws(() => finish(f, selected), /verified request admission/);
    assert.deepEqual(taskSnapshot(f), saved);
  });
}

test('an acquisition cannot substitute another run identity', t => {
  const f = fixture(t), selected = begin(f), saved = taskSnapshot(f);
  selected.acquisition.attempt = `detail-run:${selected.run + 1}`;
  assert.throws(() => finish(f, selected), /invalid pending detail observation acquisition/);
  assert.deepEqual(taskSnapshot(f), saved);
});

for (const mode of ['missing scope', 'different config', 'different source', 'different enabled state']) {
  test(`locked scope snapshot refuses an admission with ${mode}`, t => {
    const f = fixture(t), selected = begin(f), saved = taskSnapshot(f);
    const admitted = selected.scope.writeAdmission.scopes[0];
    if (mode === 'missing scope') selected.scope.writeAdmission.scopes = [];
    if (mode === 'different config') admitted.config_json = JSON.stringify({ chat_id: CHAT, synthetic_policy: 'different' });
    if (mode === 'different source') admitted.source_id = 'synthetic.other';
    if (mode === 'different enabled state') admitted.enabled = 0;
    assert.throws(() => finish(f, selected), /pending detail scope admission changed/);
    assert.deepEqual(taskSnapshot(f), saved);
  });
}

test('stronger orphan admission retains the command source policy fence captured before the retry', t => {
  const f = fixture(t);
  const originalAdmission = captureLarkWriteAdmission(f.db, { selfOpenId: SELF });
  store.sqliteExec(f.db, `UPDATE sources SET config_json=json_set(config_json,'$.synthetic_policy','changed') WHERE id='lark.im';`);
  const saved = taskSnapshot(f);
  const root = raw(), child = { ...raw(), message_id: 'om_synthetic_source_fence_child', upper_message_id: root.message_id,
    msg_type: 'text', body: { content: '{"text":"Synthetic complete child"}' } };
  const runner = createSyncRunner({
    fetchMessageDetails: () => normalizeApiMessage(root, { mergeItems: [root, child] }),
    buildPeopleContext: () => ({ self: { open_id: SELF } }), reuseKnownSenderNames: (_db, rows) => rows,
  });
  const results = runner.retryDetails(f.db, { detailLimit: 1, detailScope: SCOPE, detailBudgetMs: 30000,
    lockTtlSeconds: 600, retries: 0, retryDelayMs: 0, writeAdmission: originalAdmission }, { open_id: SELF });
  assert.ok(results.some(result => result.ok === false));
  assert.deepEqual(taskSnapshot(f), saved, 'new verification must not replace the command source-policy predecessor');
});

test('an 011 detail database is rejected by the first pending read before any API or migration', t => {
  const f = fixture(t, { through011: true }), scope = store.readScope(f.db, SCOPE);
  const migrations = store.sqliteQuery(f.db, 'SELECT * FROM schema_migrations ORDER BY version;');
  const columns = store.sqliteQuery(f.db, "PRAGMA table_info('lark_im_detail_tasks');");
  const tasks = store.sqliteQuery(f.db, 'SELECT * FROM lark_im_detail_tasks;');
  assert.throws(() => store.readPendingLarkDetails(f.db, scope), /descriptor_generation/);
  let requests = 0;
  const runner = createSyncRunner({ fetchMessageDetails: () => { requests++; assert.fail('unexpected transport'); } });
  assert.throws(() => runner.retryDetails(f.db, { detailLimit: 1, detailScope: SCOPE, detailBudgetMs: 30000,
    lockTtlSeconds: 600, retries: 0, retryDelayMs: 0 }, { open_id: SELF }), /descriptor_generation/);
  assert.equal(requests, 0);
  assert.deepEqual(store.sqliteQuery(f.db, 'SELECT * FROM schema_migrations ORDER BY version;'), migrations);
  assert.deepEqual(store.sqliteQuery(f.db, "PRAGMA table_info('lark_im_detail_tasks');"), columns);
  assert.deepEqual(store.sqliteQuery(f.db, 'SELECT * FROM lark_im_detail_tasks;'), tasks);
  assert.deepEqual(store.sqliteQuery(f.db, "SELECT * FROM sync_runs WHERE status='running';"), []);
});

test('migration 012 preserves every existing table value from 011 and initializes only bounded detail slots', t => {
  const f = fixture(t, { through011: true, queue: false });
  const ordinary = recordFromMessage(normalizeApiMessage(raw(1, { message_id: 'om_synthetic_prior_record',
    msg_type: 'text', body: { content: '{"text":"Synthetic pre-migration record"}' } })), SCOPE, 'received');
  const second = raw(1, { message_id: 'om_synthetic_second_task' });
  list(f, [raw(), second], [ordinary]);
  const scope = store.readScope(f.db, SCOPE), run = store.createRun(f.db, scope);
  const secondTask = store.sqliteQuery(f.db, `SELECT * FROM lark_im_detail_tasks WHERE message_id=${q(second.message_id)};`)[0];
  store.finishLarkDetailRun(f.db, scope, run, [{ message_id: second.message_id, fingerprint: secondTask.fingerprint,
    record: complete(1, { message_id: second.message_id }) }]);
  store.sqliteExec(f.db, `UPDATE record_observation_state SET candidate_json=${q(JSON.stringify(ordinary))},
      candidate_generation=0,candidate_attempt='synthetic-pre-migration',candidate_policy='synthetic-old-policy',
      candidate_context='synthetic-old-context',candidate_observed_at_ms=${START} WHERE record_id=(SELECT MIN(id) FROM records);
    INSERT INTO lark_im_history_progress(scope_id,generation,after_id,sweep_max_id,completed_sweeps)
      VALUES(${q(SCOPE)},3,1,2,1);`);
  const identifiers = text => '"' + text.replaceAll('"', '""') + '"';
  const tables = store.sqliteQuery(f.db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")
    .map(row => row.name);
  const before = new Map(tables.map(name => {
    const columns = store.sqliteQuery(f.db, `PRAGMA table_info(${identifiers(name)});`).map(row => row.name);
    return [name, { columns, rows: store.sqliteQuery(f.db, `SELECT * FROM ${identifiers(name)};`) }];
  }));
  assert.equal(before.get('schema_migrations').rows.at(-1).version, '011');
  assert.deepEqual(store.ensureInitialized(f.db).applied, ['012_pending_detail_observation.sql']);
  for (const [name, saved] of before) {
    const current = store.sqliteQuery(f.db, `SELECT ${saved.columns.map(identifiers).join(',')} FROM ${identifiers(name)};`);
    assert.deepEqual(name === 'schema_migrations' ? current.filter(row => row.version !== '012') : current,
      saved.rows, `migration preserves all previous values in ${name}`);
  }
  const slots = store.sqliteQuery(f.db, `SELECT descriptor_generation,evidence_generation,candidate_json,candidate_generation,
    candidate_attempt,candidate_policy,candidate_context,candidate_observed_at_ms FROM lark_im_detail_tasks;`);
  assert.equal(slots.length, 2);
  for (const slot of slots) assert.deepEqual(slot, { descriptor_generation: 0, evidence_generation: 0,
    candidate_json: null, candidate_generation: null, candidate_attempt: null, candidate_policy: null,
    candidate_context: null, candidate_observed_at_ms: null });
  assert.deepEqual(store.ensureInitialized(f.db).applied, [], 'upgrade is idempotent');
});
