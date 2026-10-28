import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureInitialized, sqliteExec, sqliteQuery, quoteSql, upsertRecordsSql,
  readScope, createRun, succeedRecordRun, commitBoundedReplayRecords }
  from '../dist/storage/sqlite/ingestion-store.js';
import { boundedReplayProjectionSql, recordWritesSql, REVIEW_EFFECTIVE_COLUMNS }
  from '../dist/storage/sqlite/record-storage.js';
import { runFenceGuardSql } from '../dist/storage/sqlite/sync-run-fence.js';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { bindAcquiredMessageAccounts } from '../src/adapters/lark-im/message-account-evidence.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';

// Every record, identity, proof, clock and database in this file is invented.
// No network adapter, existing database or production process is used.
const AT = Date.parse('2025-04-03T02:00:00.000Z');
const ACQUIRED = '2025-04-03T03:00:00.123Z';
const CHAT = 'oc_synthetic_phase_boundary_room';
const SCOPE = chatScopeId(CHAT);
const NOTES = 'synthetic.phase.notes';
const NOTE_SCOPE = 'synthetic.phase.notes.scope';
const SELF_A = { open_id: 'ou_synthetic_phase_self_a' };
const SELF_B = { open_id: 'ou_synthetic_phase_self_b' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'exocortex-sql-phase-synthetic-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite');
  ensureInitialized(db);
  sqliteExec(db, `UPDATE sources SET config_json=${quoteSql(JSON.stringify({ initial_sync_start_ms: AT - 60_000 }))}
      WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,enabled,config_json) VALUES
      (${quoteSql(SCOPE)},'lark.im','Invented phase room',1,${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});
    INSERT INTO sources(id,kind,display_name) VALUES(${quoteSql(NOTES)},'test','Invented phase notes');
    INSERT INTO sync_scopes(id,source_id,name) VALUES(${quoteSql(NOTE_SCOPE)},${quoteSql(NOTES)},'Invented phase note scope');`,
  'initialize synthetic phase fixture');
  return { db };
}

function record(id, { revision = 1000, body = 'An entirely invented phase boundary message.', app = false } = {}) {
  const raw = { message_id: id, chat_id: CHAT, chat_type: 'group', msg_type: 'text',
    create_time: String(AT), update_time: String(AT + revision),
    sender: { id: app ? 'cli_synthetic_phase_app' : 'ou_synthetic_phase_actor',
      id_type: app ? 'app_id' : 'open_id', sender_type: app ? 'app' : 'user',
      ...(app ? {} : { name: 'Invented Exact Phase Person' }) },
    body: { content: JSON.stringify({ text: body }) } };
  return recordFromMessage(normalizeApiMessage(raw), SCOPE, 'received', {}, { chat_id: CHAT, chat_type: 'group' });
}

function acquired(value, self = SELF_A, acquiredAt = ACQUIRED) {
  const result = bindAcquiredMessageAccounts([value], self, { acquiredAt })[0];
  assert.ok(JSON.parse(result.canonical_json).message_account_evidence, 'the real acquisition producer creates the invented proof');
  return result;
}

function project(value, additions) {
  return { ...value, canonical_json: JSON.stringify({ ...JSON.parse(value.canonical_json), ...additions }) };
}

function rows(db) { return sqliteQuery(db, 'SELECT * FROM records ORDER BY source_id,external_id;', 'read synthetic phase records'); }
function state(db) { return sqliteQuery(db, 'SELECT * FROM record_observation_state ORDER BY record_id;', 'read synthetic observation state'); }

// One subprocess means all fragments below really share the same connection.
// SELECTs deliberately emit one JSON object per line, avoiding a test parser for
// SQLite's concatenated -json result sets. Production SQL helpers are unchanged.
function script(db, sql, fails = false) {
  const result = spawnSync('sqlite3', ['-batch', '-bail', db], {
    input: `.bail on\n.timeout 5000\nPRAGMA foreign_keys=ON;\n${sql}`,
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  if (fails) assert.notEqual(result.status, 0, 'the deliberately invalid later projection must fail');
  else assert.equal(result.status, 0, result.stderr);
  return { values: result.stdout.trim() ? result.stdout.trim().split('\n').map(line => JSON.parse(line)) : [], stderr: result.stderr };
}

function observe(label, id) {
  return `SELECT json_object('label',${quoteSql(label)},'changed',changes(),
    'row',(SELECT json_object('body',body,'raw',raw_json,'canonical',canonical_json,'version',external_version,
      'updated_at',updated_at,'created_at',created_at,'received_at',received_at,'first_seen_scope_id',first_seen_scope_id)
      FROM records WHERE source_id='lark.im' AND external_id=${quoteSql(id)}),
    'generation',(SELECT s.generation FROM record_observation_state s JOIN records r ON r.id=s.record_id
      WHERE r.source_id='lark.im' AND r.external_id=${quoteSql(id)}));`;
}

test('same-connection upserts expose each record DML changes() across update, proof-preserving no-op, rejection and insertion', t => {
  const { db } = fixture(t), id = 'om_synthetic_phase_sequence';
  const old = acquired(record(id)), updated = acquired(record(id, { revision: 2000, body: 'Invented accepted newer body.' }));
  sqliteExec(db, upsertRecordsSql([old]));
  const before = rows(db)[0], beforeGeneration = state(db)[0].generation;
  const fresh = acquired(record('om_synthetic_phase_insert', { body: 'Invented inserted neighbor.' }), SELF_B);
  const result = script(db, `BEGIN IMMEDIATE;
    ${upsertRecordsSql([updated])}${observe('update', id)}
    ${upsertRecordsSql([record(id, { revision: 2000, body: updated.body })])}${observe('noop', id)}
    ${upsertRecordsSql([acquired(record(id, { revision: 500, body: 'Invented rejected older body.' }), SELF_B)])}${observe('reject', id)}
    ${upsertRecordsSql([fresh])}${observe('insert', fresh.external_id)}
    COMMIT;`).values;
  assert.deepEqual(result.map(({ label, changed }) => [label, changed]), [['update', 1], ['noop', 0], ['reject', 0], ['insert', 1]]);
  assert.equal(result[0].row.body, updated.body);
  assert.equal(result[0].row.raw, updated.raw_json);
  assert.equal(result[0].row.canonical, updated.canonical_json);
  assert.deepEqual(result[1].row, result[0].row, 'retaining a proof must not rewrite any selected record byte or clock');
  assert.deepEqual(result[2].row, result[0].row, 'an older source must not change names, account proof or source facts');
  assert.deepEqual(result.slice(0, 3).map(value => value.generation), Array(3).fill(beforeGeneration + 1));
  for (const column of ['created_at', 'received_at', 'first_seen_scope_id']) assert.equal(result[0].row[column], before[column]);
  assert.equal(result[3].row.canonical, fresh.canonical_json);
  assert.equal(rows(db).length, 2);
});

test('materialized rows keep compound source identities and distinct account proofs separate', t => {
  const { db } = fixture(t), shared = 'om_synthetic_phase_shared';
  const a = acquired(record(shared), SELF_A), b = acquired(record('om_synthetic_phase_account_b'), SELF_B);
  const note = { ...b, source_id: NOTES, first_seen_scope_id: NOTE_SCOPE, external_id: shared,
    record_type: 'synthetic.note', canonical_json: JSON.stringify({ invented_note: true,
      message_account_evidence: JSON.parse(b.canonical_json).message_account_evidence }) };
  sqliteExec(db, upsertRecordsSql([a, note, b]));
  const before = rows(db), beforeState = state(db);
  const incomingNote = { ...note, canonical_json: '{"invented_note":"independent replacement"}' };
  const result = script(db, `BEGIN IMMEDIATE; ${upsertRecordsSql([record(b.external_id), incomingNote, record(a.external_id)])}
    SELECT json_object('last_changed',changes()); COMMIT;`);
  assert.deepEqual(result.values, [{ last_changed: 0 }], 'a multi-record fragment still exposes the last record DML, not the batch total');
  const after = rows(db);
  for (const value of [a, b]) {
    const index = before.findIndex(row => row.source_id === value.source_id && row.external_id === value.external_id);
    assert.deepEqual(after[index], before[index], 'each Lark row retains only its own exact account proof');
  }
  const storedNote = after.find(value => value.source_id === NOTES);
  assert.equal(storedNote.canonical_json, incomingNote.canonical_json, 'another source neither donates nor inherits Lark projection data');
  assert.equal(storedNote.raw_json, note.raw_json);
  const accounts = after.filter(value => value.source_id === 'lark.im')
    .map(value => JSON.parse(value.canonical_json).message_account_evidence.account_key);
  assert.equal(new Set(accounts).size, 2);
  for (const value of after.filter(value => value.source_id === 'lark.im')) {
    assert.deepEqual(state(db).find(row => row.record_id === value.id), beforeState.find(row => row.record_id === value.id));
  }
});

test('recordWritesSql handles empty batches and same-connection reuse after rollback without stale phase rows', t => {
  const { db } = fixture(t), scope = readScope(db, SCOPE), run = createRun(db, scope), now = new Date().toISOString();
  const a = acquired(record('om_synthetic_phase_rollback_a')), b = acquired(record('om_synthetic_phase_rollback_b'), SELF_B);
  const effects = label => `SELECT json_object('label',${quoteSql(label)},'inserted',inserted,'updated',updated,
    'duplicate',duplicate,'conflicts',conflicts,'records',(SELECT COUNT(*) FROM records),
    'accepted',(SELECT COUNT(*) FROM __record_acceptance WHERE accepted)) FROM __write_effects;`;
  const result = script(db, `BEGIN IMMEDIATE;
    ${runFenceGuardSql(scope, run, now, { assert: true })}
    SAVEPOINT empty_phase; ${recordWritesSql([], now)} ${effects('empty')}
    ROLLBACK TO empty_phase; RELEASE empty_phase;
    SAVEPOINT discarded_phase; ${recordWritesSql([a], now)} ${effects('discarded')}
    ROLLBACK TO discarded_phase; RELEASE discarded_phase;
    ${recordWritesSql([b], now)} ${effects('committed')}
    COMMIT;`).values;
  assert.deepEqual(result, [
    { label: 'empty', inserted: 0, updated: 0, duplicate: 0, conflicts: 0, records: 0, accepted: 0 },
    { label: 'discarded', inserted: 1, updated: 0, duplicate: 0, conflicts: 0, records: 1, accepted: 1 },
    { label: 'committed', inserted: 1, updated: 0, duplicate: 0, conflicts: 0, records: 1, accepted: 1 },
  ]);
  assert.deepEqual(rows(db).map(value => [value.external_id, value.canonical_json]), [[b.external_id, b.canonical_json]]);
  assert.equal(state(db).length, 1, 'rolled-back phase insert and its observation trigger do not survive');
});

test('query-only replay projection and actual bounded commit share final account/name bytes and exact effects', t => {
  const { db } = fixture(t);
  const originals = [acquired(record('om_synthetic_phase_review_a')), acquired(record('om_synthetic_phase_review_b'), SELF_B),
    acquired(record('om_synthetic_phase_review_c'))];
  sqliteExec(db, upsertRecordsSql(originals));
  const before = rows(db), beforeState = state(db);
  const refreshed = acquired(record(originals[1].external_id), SELF_B, '2025-04-03T04:00:00.123Z');
  const incoming = [record(originals[0].external_id), project(refreshed, {
    sender_name: 'Invented Independently Renamed Person', sender_name_source: 'contact', sender_name_confidence: 'high',
    sender_name_account_key: JSON.parse(refreshed.canonical_json).message_account_evidence.account_key,
  }), record(originals[2].external_id, { revision: 500, body: 'Invented old source must remain rejected.' })];
  const bytes = hash(readFileSync(db));
  const projected = readOnlySqliteJson(db, boundedReplayProjectionSql(incoming, { dbPath: db }), 'synthetic read-only phase projection');
  assert.equal(hash(readFileSync(db)), bytes);
  assert.deepEqual(rows(db), before);
  assert.deepEqual(state(db), beforeState);
  assert.deepEqual(projected.map(value => value.outcome), ['duplicate', 'update', 'conflict']);
  const effective = projected.map(value => JSON.parse(value.after_json));
  const scope = readScope(db, SCOPE);
  const result = commitBoundedReplayRecords(db, { scope, initialSyncStartMs: AT - 60_000, startMs: AT,
    endMs: AT + 60_000, planId: '1'.repeat(64), attemptId: 'synthetic-phase-reviewed-commit', selfIdHash: '2'.repeat(64),
    pages: 1, fetchedCount: incoming.length, records: incoming });
  assert.deepEqual({ inserted: result.inserted, updated: result.updated, duplicate: result.duplicate, conflicts: result.conflicts },
    { inserted: 0, updated: 1, duplicate: 1, conflicts: 1 });
  const after = rows(db);
  assert.deepEqual(after.map(value => Object.fromEntries(REVIEW_EFFECTIVE_COLUMNS.map(key => [key, value[key]]))), effective);
  for (const index of [0, 2]) assert.deepEqual(after[index], before[index], 'duplicate and refused targets preserve every stored clock and field');
  assert.equal(JSON.parse(after[1].canonical_json).message_account_evidence.acquired_at, '2025-04-03T04:00:00.123Z');
  assert.equal(sqliteQuery(db, 'SELECT COUNT(*) AS count FROM bounded_replay_runs;')[0].count, 1);
});

function guessed(value) {
  return project(value, { sender_name: 'Invented Unbound Bot Guess', sender_name_source: 'chat_bot_unique', sender_name_confidence: 'high' });
}

for (const mode of ['upsert', 'recordWrites']) test(`${mode} skips unsafe merging for refused older input but rejects the same admitted app guess`, t => {
  const { db } = fixture(t), id = 'om_synthetic_phase_admission_app';
  const original = record(id, { app: true });
  assert.equal(JSON.parse(original.canonical_json).sender_name, null, 'there is no prior exact name that could legitimately replace the incoming guess');
  sqliteExec(db, upsertRecordsSql([original]));
  const before = rows(db);
  const lower = guessed(record(id, { revision: 500, app: true }));
  const higher = guessed(record(id, { revision: 2000, app: true }));
  if (mode === 'upsert') {
    const result = script(db, `BEGIN IMMEDIATE; ${upsertRecordsSql([lower])}
      SELECT json_object('changed',changes()); COMMIT;`).values;
    assert.deepEqual(result, [{ changed: 0 }]);
    assert.deepEqual(rows(db), before);
    assert.throws(() => sqliteExec(db, `BEGIN IMMEDIATE; ${upsertRecordsSql([higher])} COMMIT;`), /malformed JSON|unverified_app_name_projection/);
  } else {
    const scope = readScope(db, SCOPE), run = createRun(db, scope);
    const result = succeedRecordRun(db, scope, run, [lower], 1, { created_at_ms: AT + 60_000 }, {});
    assert.deepEqual(result, { inserted: 0, updated: 0, duplicate: 0, conflicts: 1 });
    assert.deepEqual(rows(db), before);
    const next = readScope(db, SCOPE), nextRun = createRun(db, next);
    assert.throws(() => succeedRecordRun(db, next, nextRun, [higher], 1, { created_at_ms: AT + 60_000 }, {}), /malformed JSON|unverified_app_name_projection/);
  }
  assert.deepEqual(rows(db), before);
});

function persistentState(db) {
  return Object.fromEntries(['records', 'record_observation_state', 'sync_runs', 'sync_scopes', 'sync_locks',
    'bounded_replay_runs', 'lark_im_list_progress', 'lark_im_detail_tasks', 'lark_im_history_progress',
    'lark_im_history_debt', 'lark_im_history_scheduler'].map(table =>
    [table, sqliteQuery(db, `SELECT * FROM ${table} ORDER BY rowid;`, `read synthetic ${table}`)]));
}

test('a late direct projection error rolls back an earlier executed record write and its generation', t => {
  const { db } = fixture(t), first = record('om_synthetic_phase_late_first'), last = record('om_synthetic_phase_late_last', { app: true });
  sqliteExec(db, upsertRecordsSql([acquired(first), last]));
  const before = persistentState(db);
  const result = script(db, `BEGIN IMMEDIATE;
    ${upsertRecordsSql([acquired(record(first.external_id, { revision: 2000, body: 'Invented write before failure.' }))])}
    SELECT json_object('first_changed',changes(),'first_body',(SELECT body FROM records WHERE external_id=${quoteSql(first.external_id)}));
    ${upsertRecordsSql([guessed(record(last.external_id, { revision: 2000, app: true }))])}
    COMMIT;`, true);
  assert.deepEqual(result.values, [{ first_changed: 1, first_body: 'Invented write before failure.' }]);
  assert.match(result.stderr, /malformed JSON|unverified_app_name_projection/);
  assert.deepEqual(persistentState(db), before, 'records, trigger state, runs, cursors, queues, locks and audit all roll back');
});

test('a late batch projection error rolls back observation evidence and every fenced run effect', t => {
  const { db } = fixture(t), first = record('om_synthetic_phase_batch_first'), last = record('om_synthetic_phase_batch_last', { app: true });
  sqliteExec(db, upsertRecordsSql([acquired(first), last]));
  const scope = readScope(db, SCOPE), run = createRun(db, scope);
  const before = persistentState(db);
  assert.throws(() => succeedRecordRun(db, scope, run, [
    acquired(record(first.external_id, { revision: 2000, body: 'Invented batch source update.' })),
    guessed(record(last.external_id, { revision: 2000, app: true })),
  ], 2, { created_at_ms: AT + 60_000 }, {}), /succeed record run.*(?:malformed JSON|unverified_app_name_projection)/s);
  assert.deepEqual(persistentState(db), before, 'failed materialization cannot publish preceding observation evidence or run progress');
});
