import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { executeLarkImHistory, selectHistoryTarget } from '../src/maintenance/history.mjs';

// Every database, ID, timestamp, body and observation in this suite is synthetic.
const START = Date.parse('2026-02-01T00:00:00Z');
const CHAT = 'oc_synthetic_history_index_a', OTHER = 'oc_synthetic_history_index_b';
const SCOPE = chatScopeId(CHAT), q = store.quoteSql;
const migrations = fileURLToPath(new URL('../migrations/', import.meta.url));
function fixture(t, legacy = false) {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-history-index-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite');
  let options;
  if (legacy) {
    const old = join(dir, 'legacy-migrations'); mkdirSync(old);
    for (const name of readdirSync(migrations).filter(name => /^00\d_|^010_/.test(name))) {
      copyFileSync(join(migrations, name), join(old, name));
    }
    options = { migrationsDir: old };
  }
  store.ensureInitialized(db, options);
  store.sqliteExec(db, `UPDATE sources SET config_json=json_set(config_json,'$.initial_sync_start_ms',${START})
    WHERE id='lark.im';
    ${[CHAT, OTHER].map(chat => `INSERT INTO sync_scopes(id,source_id,name,config_json)
      VALUES(${q(chatScopeId(chat))},'lark.im',${q(chat)},${q(JSON.stringify({ chat_id: chat }))});`).join('\n')}`);
  return { db };
}
function seed(f, perChat = 1) {
  store.sqliteExec(f.db, `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<${perChat * 2})
    INSERT INTO records(source_id,first_seen_scope_id,external_id,external_version,record_type,
      occurred_at_ms,container_id,direction,body,raw_json,canonical_json)
    SELECT 'lark.im','lark.im.sent_by_me','om_synthetic_history_index_'||i,${q(String(START + 20000))},'lark.im.message',
      ${START}+(i*7919%${perChat})*1000,CASE WHEN i<=${perChat} THEN ${q(CHAT)} ELSE ${q(OTHER)} END,
      'sent','Synthetic preserved body',
      json_object('message_id','om_synthetic_history_index_'||i,'msg_type','text',
        'create_time',CAST(${START}+(i*7919%${perChat})*1000 AS TEXT),'update_time',${q(String(START + 20000))},
        'chat_id',CASE WHEN i<=${perChat} THEN ${q(CHAT)} ELSE ${q(OTHER)} END,
        'body',json_object('content','{"text":"Synthetic preserved body"}')),
      '{"source_api":"im.v1.messages","synthetic_unknown":{"preserve":true}}' FROM n;
    INSERT INTO lark_im_history_progress(scope_id,generation,after_id,sweep_max_id,completed_sweeps)
      VALUES(${q(SCOPE)},7,${Math.floor(perChat / 2)},${perChat},3);`);
}
function businessSnapshot(db) {
  const schema = store.sqliteQuery(db, "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger') AND name<>'schema_migrations' ORDER BY type,name;");
  const tables = schema.filter(row => row.type === 'table');
  return { schema, rows: Object.fromEntries(tables.map(row => [row.name,
    store.sqliteQuery(db, `SELECT * FROM "${row.name.replaceAll('"', '""')}" ORDER BY rowid;`)])) };
}

test('010-only history fails before any API without migrating; explicit 011 upgrade preserves all stored state', t => {
  const f = fixture(t, true); seed(f);
  store.sqliteExec(f.db, `UPDATE record_observation_state SET generation=4,evidence_generation=9,
    previous_json='{"synthetic":"previous"}',last_observed_json='{"synthetic":"last"}',
    candidate_json='{"synthetic":"pending"}',candidate_generation=4,candidate_attempt='synthetic-attempt',
    candidate_context='synthetic-context',candidate_policy='lark_raw_observation/v1',candidate_observed_at_ms=${START},
    history_error='missing',reason='synthetic-unresolved';
    UPDATE sync_scopes SET cursor_json='{"created_at_ms":${START}}' WHERE id=${q(SCOPE)};
    INSERT INTO lark_im_list_progress(scope_id,anchor_cursor_json,cursor_json,coverage_start_ms,generation,scope_config_json,updated_at)
      VALUES(${q(SCOPE)},'{"created_at_ms":${START}}','{"created_at_ms":${START + 60000}}',${START},2,
        ${q(JSON.stringify({ chat_id: CHAT }))},'2026-02-01T00:01:00.000Z');
    INSERT INTO lark_im_detail_tasks(scope_id,message_id,raw_root_json,fingerprint,external_version,occurred_at_ms,
      status,attempt_count,retry_at,last_error_type,last_error_message,created_at,updated_at)
      VALUES(${q(SCOPE)},'om_synthetic_pending_root','{"synthetic":"queued"}',${q('a'.repeat(64))},${q(String(START))},${START},
        'pending',3,'2026-02-01T00:02:00.000Z','MessageDetailError','source_version_conflict',
        '2026-02-01T00:00:00.000Z','2026-02-01T00:01:00.000Z');`);
  const before = businessSnapshot(f.db), bytes = readFileSync(f.db);
  const previousMigrations = store.sqliteQuery(f.db, 'SELECT * FROM schema_migrations ORDER BY version;');
  assert.equal(previousMigrations.at(-1).version, '010');
  assert.throws(() => selectHistoryTarget(f.db), /select history scope failed/);
  assert.throws(() => executeLarkImHistory({ db: f.db }, {
    createRequestSession: () => assert.fail('Missing index must fail before remote access'),
  }), /select history scope failed/);
  assert.deepEqual(readFileSync(f.db), bytes, 'read-only history must not apply an index migration');
  assert.deepEqual(businessSnapshot(f.db), before);
  assert.deepEqual(store.sqliteQuery(f.db, 'SELECT * FROM schema_migrations ORDER BY version;'), previousMigrations);

  assert.deepEqual(store.ensureInitialized(f.db).applied, ['011_lark_history_container_index.sql']);
  assert.deepEqual(businessSnapshot(f.db), before, 'index construction must retain every row, trigger, column and checkpoint');
  assert.deepEqual(store.sqliteQuery(f.db, "SELECT * FROM schema_migrations WHERE version<>'011' ORDER BY version;"), previousMigrations);
  assert.equal(selectHistoryTarget(f.db).record.first_seen_scope_id, 'lark.im.sent_by_me');
  assert.deepEqual(store.ensureInitialized(f.db).applied, [], 'initializer remains idempotent');
  assert.deepEqual(businessSnapshot(f.db), before);
});

test('actual scope-horizon and next-record queries use bounded ID seeks on a large synthetic history', t => {
  const f = fixture(t), perChat = 15000; seed(f, perChat);
  const queries = [];
  const selected = selectHistoryTarget(f.db, { sqliteJson: (db, sql, label) => {
    queries.push({ sql, label });
    return readOnlySqliteJson(db, sql, label);
  } });
  assert.equal(selected.record.id, perChat / 2 + 1);
  assert.equal(selected.checkpoint.nextSweepMaxId, perChat);
  const bounded = queries.filter(query => ['select history scope', 'select history record'].includes(query.label));
  assert.equal(bounded.length, 2, 'profile the SQL that the real selector actually executes');
  const measured = spawnSync('python3', ['-c', `import json, pathlib, sqlite3, sys
payload = json.load(sys.stdin)
db = sqlite3.connect(pathlib.Path(payload['db']).resolve().as_uri() + '?mode=ro', uri=True)
db.execute('PRAGMA query_only=ON')
result = []
for query in payload['queries']:
    plan = [row[3] for row in db.execute('EXPLAIN QUERY PLAN ' + query['sql'])]
    steps = [0]
    def progress():
        steps[0] += 1
        return int(steps[0] > 5000)
    db.set_progress_handler(progress, 1)
    error = None
    try:
        rows = len(db.execute(query['sql']).fetchall())
    except sqlite3.OperationalError as failure:
        rows = None
        error = str(failure)
    db.set_progress_handler(None, 0)
    result.append(dict(label=query['label'], plan=plan, vm_steps=steps[0], rows=rows, error=error))
print(json.dumps(result))
`], { input: JSON.stringify({ db: f.db, queries: bounded }), encoding: 'utf8', timeout: 5000 });
  assert.equal(measured.status, 0, measured.stderr);
  const profiles = JSON.parse(measured.stdout);
  for (const profile of profiles) {
    assert.equal(profile.error, null, JSON.stringify(profile));
    assert.equal(profile.rows, 1);
    assert.ok(profile.vm_steps < 2000, JSON.stringify(profile));
    assert.ok(profile.plan.some(detail => /USING INDEX records_history_container_id/.test(detail)), JSON.stringify(profile));
  }
  assert.ok(profiles.find(profile => profile.label === 'select history record').plan
    .every(detail => !/TEMP B-TREE/.test(detail)), 'one-row lookup must not sort a chat history');
  t.diagnostic(JSON.stringify({ rows: perChat * 2, profiles }));
});
