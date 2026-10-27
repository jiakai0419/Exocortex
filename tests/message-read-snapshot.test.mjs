import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureInitialized, quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { readOnlySqliteJson, SqliteReadError } from '../src/storage/sqlite/readonly-query.mjs';
import { readMessageSnapshot } from '../src/diagnostics/message-read-snapshot.mjs';
import { readinessSourceVersionKey } from '../src/diagnostics/message-readiness-ledger.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';

// Fully authored fixtures. No real account, message, screenshot, or API data.
const CHAT = 'oc_synthetic_snapshot_a', OTHER_CHAT = 'oc_synthetic_snapshot_b';
const ACTOR = 'ou_synthetic_snapshot_a', OTHER_ACTOR = 'ou_synthetic_snapshot_b';
const ACCOUNT = 'synthetic_snapshot_account';
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture(t, { names = true, recipients = true, observations = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'exo-message-snapshot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite');
  ensureInitialized(db);
  if (!names) sqliteExec(db, 'DROP TABLE lark_im_name_tasks;');
  if (!recipients) sqliteExec(db, 'DROP TABLE lark_im_recipient_state;');
  if (!observations) sqliteExec(db, 'DROP TABLE lark_im_message_readiness;');
  return { dir, db };
}
function recordSql(id, options = {}) {
  const row = { source: 'lark.im', scope: 'lark.im.sent_by_me', type: 'lark.im.message',
    direction: 'received', chat: CHAT, actor: ACTOR, at: id * 1000,
    external: `om_synthetic_${id}`, body: `Synthetic body ${id}`, canonical: '{}', raw: '{}', ...options };
  return `INSERT INTO records(id,source_id,first_seen_scope_id,external_id,record_type,direction,
    container_id,actor_id,occurred_at,occurred_at_ms,body,canonical_json,raw_json)
    VALUES(${id},${[row.source,row.scope,row.external,row.type,row.direction,row.chat,row.actor,
      new Date(row.at).toISOString(),row.at,row.body,row.canonical,row.raw].map(quoteSql).join(',')});`;
}
function scopeSql(id, config, source = 'lark.im') {
  return `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${[id,source,id,config].map(quoteSql).join(',')});`;
}
function taskSql(key, kind = 'sender', chat = CHAT, actor = ACTOR, source = 'lark.im') {
  return `INSERT INTO lark_im_name_tasks(source_id,account_key,task_key,kind,chat_id,actor_id,namespace,evidence_json,latest_record_id)
    VALUES(${[source,ACCOUNT,key,kind,chat,kind === 'sender' ? actor : '',kind === 'sender' ? 'open_id' : '',
      '{"phase":"old"}',1].map(quoteSql).join(',')});`;
}
function recipientSql(chat = CHAT, source = 'lark.im') {
  return `INSERT INTO lark_im_recipient_state(source_id,account_key,chat_id,evidence_json)
    VALUES(${[source,ACCOUNT,chat,'{"phase":"old"}'].map(quoteSql).join(',')});`;
}
function observationSql(id, overrides = {}, source = { external_version: null, raw_json: '{}' }) {
  const value = { source_id: 'lark.im', record_id: id, observer_account_key: 'a'.repeat(64), contract_version: 1,
    source_version_key: readinessSourceVersionKey(source), source_epoch: 1, state: 'enriching',
    reasons_json: '["sender_name_missing"]', first_observed_at_ms: 1000, first_missing_observed_at_ms: 1000,
    first_ready_observed_at_ms: null, last_observed_at_ms: 1000, observed_regression_count: 0, generation: 1,
    ...overrides };
  return `INSERT INTO lark_im_message_readiness(${Object.keys(value).join(',')}) VALUES(${Object.values(value).map(quoteSql).join(',')});`;
}

test('internal observation selection is bounded and does not change public latest selection',t=>{
  const f=fixture(t);
  sqliteExec(f.db,recordSql(1)+recordSql(2)+recordSql(3));
  const before=sha(f.db);
  assert.deepEqual(readMessageSnapshot(f.db,{limit:2,recordIds:[1,3]}).rows.map(row=>row.id),[3,1]);
  assert.deepEqual(readMessageSnapshot(f.db,{limit:2}).rows.map(row=>row.id),[3,2]);
  assert.deepEqual(readMessageSnapshot(f.db,{recordIds:[]}).population,{total:0,evaluated:0,not_evaluated:0});
  for(const ids of [[1,1],[0],[-1],[1.5],Array.from({length:41},(_,i)=>i+1)])
    assert.throws(()=>readMessageSnapshot(f.db,{recordIds:ids}),/invalid internal message selection/);
  assert.equal(sha(f.db),before);
});
function recorder() {
  const calls = [];
  return { calls, sqliteJson(db, sql, label) { calls.push({ sql, label }); return readOnlySqliteJson(db, sql, label); } };
}

test('one data SELECT preserves selected text, first-seen scope, missing rows, ordering and denominator', t => {
  const f = fixture(t), deps = recorder();
  const canonical = ' { "unknown": 9007199254740993, "escape": "\\u0041" }\n';
  const raw = '{"unknown":9007199254740995,"nested":{"x":1,"x":2}}';
  const scope = '{ "kind": "synthetic", "unknown": 9007199254740997 }';
  sqliteExec(f.db, `UPDATE sync_scopes SET config_json=${quoteSql(scope)} WHERE id='lark.im.sent_by_me';`
    + recordSql(1, { at: 1000, external: 'om_synthetic_b', canonical, raw, body: '  synthetic\nbody  ' })
    + recordSql(2, { at: 1000, external: 'om_synthetic_c', direction: 'sent', body: null })
    + recordSql(3, { at: 900 }) + recordSql(4, { at: 800, type: 'synthetic.other_type' }));
  const before = sha(f.db), result = readMessageSnapshot(f.db, { limit: 2 }, deps);
  assert.equal(sha(f.db), before, 'read-only snapshot must not write the database');
  assert.equal(deps.calls.length, 2);
  assert.match(deps.calls[0].sql, /^SELECT name FROM sqlite_schema/);
  assert.doesNotMatch(deps.calls[0].sql, /FROM records|FROM sync_scopes/);
  assert.match(deps.calls[1].sql, /^WITH/);
  assert.doesNotMatch(deps.calls[1].sql, /\b(?:CREATE|UPDATE|INSERT|DELETE|DROP|TEMP)\b/);
  assert.deepEqual(result.rows.map(row => row.id), [2, 1], 'an incomplete selected row must not be skipped');
  assert.deepEqual(result.population, { total: 3, evaluated: 2, not_evaluated: 1 });
  assert.equal(result.as_of.source_max_record_id, 3, 'other record types do not enlarge the message source watermark');
  assert.match(result.as_of.read_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(result.rows[1].canonical_json, canonical);
  assert.equal(result.rows[1].raw_json, raw);
  assert.equal(result.rows[1].body, '  synthetic\nbody  ');
  assert.equal(result.rows[1].scope_config_json, scope);
  assert.equal(result.rows[1].type_scope_id, 'lark.im.sent_by_me');
  assert.equal(result.rows[1].type_scope_source_id, 'lark.im');
  assert.equal(result.rows[1].source_id, 'lark.im');
});

test('direction, literal quoting, LIKE wildcards and limit share one exact population', t => {
  const f = fixture(t);
  sqliteExec(f.db, recordSql(1, { body: 'alpha_one' }) + recordSql(2, { body: 'alphaXone', direction: 'sent' })
    + recordSql(3, { body: "quote's needle" }) + recordSql(4, { body: 'beta\\literal' }) + recordSql(5, { body: null })
    + "INSERT INTO sources(id,kind,display_name) VALUES('synthetic.other','test','Synthetic');"
    + scopeSql('synthetic.other.scope', '{}', 'synthetic.other')
    + recordSql(99, { source: 'synthetic.other', scope: 'synthetic.other.scope', body: 'alpha_one' }));
  for (const [options, ids, total] of [
    [{ search: 'alpha_one', limit: 1 }, [2], 2],
    [{ search: 'alpha_one', direction: 'received' }, [1], 1],
    [{ search: "quote's" }, [3], 1],
    [{ search: '\\literal' }, [4], 1],
    [{ search: '%' }, [4, 3, 2, 1], 4],
    [{ search: "' OR 1=1 --" }, [], 0],
    [{ direction: 'sent' }, [2], 1],
  ]) {
    const result = readMessageSnapshot(f.db, options);
    assert.deepEqual(result.rows.map(row => row.id), ids);
    assert.deepEqual(result.population, { total, evaluated: ids.length, not_evaluated: total - ids.length });
    assert.equal(result.as_of.source_max_record_id, 5, 'the source watermark is not limited to the filtered page');
  }
});

test('related evidence is selected by source and exact chat/actor, with scope text left for identity validation', t => {
  const f = fixture(t), exactScope = chatScopeId(CHAT);
  const duplicateConfig = `{"chat_id":${JSON.stringify(CHAT)},"chat_id":${JSON.stringify(OTHER_CHAT)}}`;
  sqliteExec(f.db, 'PRAGMA ignore_check_constraints=ON;'
    + "INSERT INTO sources(id,kind,display_name) VALUES('synthetic.other','test','Synthetic');"
    + scopeSql(exactScope, JSON.stringify({ chat_id: CHAT, chat_name: 'Synthetic exact' }))
    + scopeSql('synthetic.wrong.scope.id', JSON.stringify({ chat_id: CHAT, chat_name: 'Synthetic impostor' }))
    + scopeSql('synthetic.duplicate.scope', duplicateConfig)
    + scopeSql('synthetic.foreign.scope', JSON.stringify({ chat_id: CHAT }), 'synthetic.other')
    + scopeSql('synthetic.unrelated.scope', JSON.stringify({ chat_id: OTHER_CHAT }))
    + scopeSql('synthetic.invalid.scope', 'not JSON')
    + recordSql(1, { at: 3000, scope: exactScope }) + recordSql(2, { at: 2000, chat: OTHER_CHAT, actor: OTHER_ACTOR })
    + recordSql(3, { at: 1000, actor: OTHER_ACTOR })
    + taskSql('selected-sender') + taskSql('selected-chat', 'chat')
    + taskSql('wrong-actor', 'sender', CHAT, OTHER_ACTOR) + taskSql('wrong-chat', 'chat', OTHER_CHAT)
    + taskSql('foreign-sender', 'sender', CHAT, ACTOR, 'synthetic.other')
    + recipientSql() + recipientSql(OTHER_CHAT) + recipientSql(CHAT, 'synthetic.other'));
  const result = readMessageSnapshot(f.db, { limit: 1 });
  assert.deepEqual(result.rows.map(row => row.id), [1]);
  assert.deepEqual(result.nameTasks.map(task => task.task_key).sort(), ['selected-chat', 'selected-sender']);
  assert.equal(result.recipients.length, 1);
  assert.equal(result.recipients[0].chat_id, CHAT);
  assert.deepEqual(result.scopes.map(scope => scope.id).sort(),
    [exactScope, 'synthetic.wrong.scope.id', 'synthetic.duplicate.scope'].sort());
  assert.equal(result.scopes.find(scope => scope.id === 'synthetic.duplicate.scope').config_json, duplicateConfig,
    'the collector must not parse away ambiguity and manufacture trusted metadata');
  assert.equal(result.scopes.filter(scope => scope.id === chatScopeId(CHAT) && scope.source_id === 'lark.im').length, 1,
    'only the projection caller can apply the exact scope-id binding');
});

for (const [names, recipients, observations] of [[false, false, true], [false, true, true], [true, false, true],
  [true, true, false], [false, false, false]]) {
  test(`legacy optional tables names=${names} recipients=${recipients} observations=${observations} use the same single data statement`, t => {
    const f = fixture(t, { names, recipients, observations }), deps = recorder();
    sqliteExec(f.db, recordSql(1) + (names ? taskSql('selected-sender') : '') + (recipients ? recipientSql() : ''));
    const result = readMessageSnapshot(f.db, {}, deps);
    assert.equal(deps.calls.length, 2);
    assert.deepEqual(result.available, { names, recipients, observations });
    assert.deepEqual(result.observations, []);
    assert.equal(result.nameTasks.length, Number(names));
    assert.equal(result.recipients.length, Number(recipients));
    assert.deepEqual(result.population, { total: 1, evaluated: 1, not_evaluated: 0 });
  });
}

test('empty population and a payload-heavy unevaluated row have explicit denominators', t => {
  const f = fixture(t);
  const empty = readMessageSnapshot(f.db);
  assert.deepEqual(empty.population, { total: 0, evaluated: 0, not_evaluated: 0 });
  assert.equal(empty.as_of.source_max_record_id, 0);
  const largeRaw = JSON.stringify({ authored_padding: 'x'.repeat(512 * 1024) });
  sqliteExec(f.db, recordSql(1, { at: 2000 }) + recordSql(2, { at: 1000, raw: largeRaw }));
  const deps = recorder(), result = readMessageSnapshot(f.db, { limit: 1 }, deps);
  assert.deepEqual(result.population, { total: 2, evaluated: 1, not_evaluated: 1 });
  assert.equal(result.as_of.source_max_record_id, 2);
  assert.ok(JSON.stringify(result).length < 5000, 'unevaluated raw payload must not be loaded into the result');
  const metadataCte = deps.calls[1].sql.split('), selected_ids')[0];
  assert.doesNotMatch(metadataCte, /canonical_json|raw_json/, 'population CTE selects metadata only');
});

test('historical observations require exact selected source version and one v1 observer', t => {
  const f = fixture(t), deps = recorder();
  const whitespaceRaw = ' {"authored":"source"} ', versionRaw = '{"authored":"version"}';
  sqliteExec(f.db, 'PRAGMA ignore_check_constraints=ON;'
    + Array.from({ length: 9 }, (_, index) => recordSql(index + 1,
      index === 2 ? { raw: whitespaceRaw } : index === 3 ? { raw: versionRaw } : {})).join('\n')
    + "UPDATE records SET external_version='synthetic-v2' WHERE id=4;"
    + observationSql(1)
    + observationSql(2) + observationSql(2, { contract_version: 2 })
    + observationSql(3, {}, { external_version: null, raw_json: whitespaceRaw.trim() })
    + observationSql(4, {}, { external_version: 'synthetic-v1', raw_json: versionRaw })
    + observationSql(5) + observationSql(5, { observer_account_key: 'b'.repeat(64), source_version_key: 'c'.repeat(64) })
    + observationSql(6) + observationSql(6, { observer_account_key: 'b'.repeat(64), reasons_json: '["PRIVATE_BAD_REASON"]' })
    + observationSql(7, { observer_account_key: 'not-an-account' })
    + observationSql(8, { last_observed_at_ms: Date.now() + 86_400_000 })
    + observationSql(9, { reasons_json: '["PRIVATE_BAD_REASON"]' }));
  const before = sha(f.db);
  const result = readMessageSnapshot(f.db, { limit: 8 }, deps);
  assert.deepEqual(result.rows.map(row => row.id), [9, 8, 7, 6, 5, 4, 3, 2]);
  assert.deepEqual(result.observations.map(item => item.record_id), [2], 'non-v1 history is ignored; invalid or conflicting v1 history is unknown');
  assert.doesNotMatch(JSON.stringify(result.observations), /PRIVATE_BAD_REASON|not-an-account/);
  assert.equal(deps.calls.length, 2);
  assert.ok(deps.calls[1].sql.includes('HAVING COUNT(*)=1'), 'SQL bounds candidate history before payload serialization');
  const selected = readMessageSnapshot(f.db, { recordIds: [1, 2] });
  assert.deepEqual(selected.observations.map(item => item.record_id), [1, 2]);
  assert.deepEqual(selected.rows.map(row => row.id), [2, 1]);
  assert.equal(sha(f.db), before);
});

for (const removal of [false, true]) {
  test(`observation schema ${removal ? 'removal' : 'creation'} race fails closed without a second data read`, t => {
    const f = fixture(t, { observations: removal }), calls = [];
    assert.throws(() => readMessageSnapshot(f.db, {}, { sqliteJson(db, sql, label) {
      calls.push(label);
      const result = readOnlySqliteJson(db, sql, label);
      if (calls.length === 1) sqliteExec(db, removal ? 'DROP TABLE lark_im_message_readiness;'
        : 'CREATE TABLE lark_im_message_readiness(synthetic_only INTEGER);');
      return result;
    } }), error => error instanceof SqliteReadError && error.reason === (removal ? 'read_failed' : 'invalid_response'));
    assert.equal(calls.length, 2);
  });
}

test('schema creation between preflight and data read fails instead of returning stale availability', t => {
  const f = fixture(t, { names: false }), calls = [];
  assert.throws(() => readMessageSnapshot(f.db, {}, { sqliteJson(db, sql, label) {
    calls.push(label);
    const result = readOnlySqliteJson(db, sql, label);
    if (calls.length === 1) sqliteExec(db, 'CREATE TABLE lark_im_name_tasks(synthetic_only INTEGER);');
    return result;
  } }), error => error instanceof SqliteReadError && error.reason === 'invalid_response');
  assert.equal(calls.length, 2);
});

test('schema removal between preflight and data read errors without a multi-read fallback', t => {
  const f = fixture(t), calls = [];
  assert.throws(() => readMessageSnapshot(f.db, {}, { sqliteJson(db, sql, label) {
    calls.push(label);
    const result = readOnlySqliteJson(db, sql, label);
    if (calls.length === 1) sqliteExec(db, 'DROP TABLE lark_im_name_tasks;');
    return result;
  } }), error => error instanceof SqliteReadError && error.reason === 'read_failed');
  assert.equal(calls.length, 2);
});

test('ambiguous first-seen scope rows cannot multiply the page or hide a denominator mismatch', t => {
  const f = fixture(t);
  // A deliberately malformed legacy table lacks the normal primary key. Its
  // duplicate ID spans sources and must not turn one record into two messages.
  sqliteExec(f.db, `ALTER TABLE sync_scopes RENAME TO synthetic_original_scopes;
    CREATE TABLE sync_scopes AS SELECT * FROM synthetic_original_scopes;
    INSERT INTO sources(id,kind,display_name) VALUES('synthetic.other','test','Synthetic');
    INSERT INTO sync_scopes(id,source_id,name,config_json)
      VALUES('lark.im.sent_by_me','synthetic.other','Synthetic conflicting scope','{}');
    ${recordSql(1)}`);
  assert.throws(() => readMessageSnapshot(f.db),
    error => error instanceof SqliteReadError && error.reason === 'invalid_response');
});

test('a writer committing during the exact SELECT cannot mix rows, evidence, counts or watermark', t => {
  const f = fixture(t), scope = chatScopeId(CHAT);
  sqliteExec(f.db, 'PRAGMA journal_mode=WAL;'
    + scopeSql(scope, JSON.stringify({ chat_id: CHAT, phase: 'old' }))
    + recordSql(1, { scope, body: 'old synthetic needle' }) + recordSql(2, { scope, body: 'old synthetic needle' })
    + taskSql('selected-sender') + recipientSql() + observationSql(1) + observationSql(2));
  const mutation = `BEGIN IMMEDIATE;
    UPDATE records SET body='new synthetic needle';
    UPDATE sync_scopes SET config_json=${quoteSql(JSON.stringify({ chat_id: CHAT, phase: 'new' }))} WHERE id=${quoteSql(scope)};
    UPDATE lark_im_name_tasks SET evidence_json='{"phase":"new"}';
    UPDATE lark_im_recipient_state SET evidence_json='{"phase":"new"}';
    UPDATE lark_im_message_readiness SET state='ready',reasons_json='[]',first_ready_observed_at_ms=2000,last_observed_at_ms=2000,generation=2;
    ${recordSql(3, { scope, body: 'new synthetic needle' })}
    ${observationSql(3, { state: 'ready', reasons_json: '[]', first_ready_observed_at_ms: 2000, last_observed_at_ms: 2000, generation: 2 })} COMMIT;`;
  // SQLite invokes this test-only LIKE UDF after reading a record, so the read
  // snapshot already exists. A separate WAL writer commits during that same
  // SELECT. The UDF delegates matching to native SQLite on an in-memory DB.
  // The actual production SQL is neither rewritten nor replaced by a mock.
  const python = String.raw`
import json,pathlib,sqlite3,sys
p=json.load(sys.stdin)
r=sqlite3.connect(pathlib.Path(p['db']).as_uri()+'?mode=ro',uri=True,timeout=5,isolation_level=None)
r.row_factory=sqlite3.Row
r.execute('PRAGMA query_only=ON')
r.execute('BEGIN')
w=sqlite3.connect(p['db'],timeout=5,isolation_level=None)
native=sqlite3.connect(':memory:')
committed=False
calls=0
def matching(pattern,body):
 global committed,calls
 calls+=1
 if not committed:
  w.executescript(p['mutation'])
  committed=True
 return native.execute('SELECT ? LIKE ?',(body,pattern)).fetchone()[0]
r.create_function('like',2,matching)
rows=[dict(row) for row in r.execute(p['sql'])]
r.execute('COMMIT')
r.close();w.close();native.close()
print(json.dumps({'rows':rows,'writer_committed_during_select':committed,'like_calls':calls}))
`;
  const calls = [], gates = [];
  const result = readMessageSnapshot(f.db, { search: 'synthetic needle', limit: 1 }, { sqliteJson(db, sql, label) {
    calls.push(label);
    if (calls.length === 1) return readOnlySqliteJson(db, sql, label);
    const run = spawnSync('python3', ['-c', python], {
      input: JSON.stringify({ db, sql, mutation }), encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(run.status, 0, run.stderr);
    const value = JSON.parse(run.stdout); gates.push(value);
    return value.rows;
  } });
  assert.equal(calls.length, 2);
  assert.equal(gates.length, 1);
  assert.equal(gates[0].writer_committed_during_select, true);
  assert.ok(gates[0].like_calls >= 1);
  assert.deepEqual(result.population, { total: 2, evaluated: 1, not_evaluated: 1 });
  assert.equal(result.as_of.source_max_record_id, 2);
  assert.deepEqual(result.rows.map(row => row.id), [2]);
  assert.equal(result.rows[0].body, 'old synthetic needle');
  assert.equal(JSON.parse(result.rows[0].scope_config_json).phase, 'old');
  assert.equal(JSON.parse(result.scopes[0].config_json).phase, 'old');
  assert.equal(JSON.parse(result.nameTasks[0].evidence_json).phase, 'old');
  assert.equal(JSON.parse(result.recipients[0].evidence_json).phase, 'old');
  assert.deepEqual(result.observations.map(item => [item.record_id, item.state, item.generation, item.first_ready_observed_at_ms]),
    [[2, 'enriching', 1, null]], 'history must come from the same old SQLite snapshot as the selected source bytes');
  const after = readMessageSnapshot(f.db, { search: 'synthetic needle', limit: 1 });
  assert.deepEqual(after.population, { total: 3, evaluated: 1, not_evaluated: 2 });
  assert.equal(after.as_of.source_max_record_id, 3);
  assert.equal(after.rows[0].body, 'new synthetic needle');
  assert.equal(JSON.parse(after.scopes[0].config_json).phase, 'new');
  assert.equal(JSON.parse(after.nameTasks[0].evidence_json).phase, 'new');
  assert.equal(JSON.parse(after.recipients[0].evidence_json).phase, 'new');
  assert.deepEqual(after.observations.map(item => [item.record_id, item.state, item.generation, item.first_ready_observed_at_ms]),
    [[3, 'ready', 2, 2000]]);
});

test('invalid filters fail before SQL and malformed query envelopes fail closed', t => {
  for (const options of [{ limit: 0 }, { limit: 1.5 }, { limit: Infinity }, { direction: 'unknown' }, { search: '\0' }]) {
    assert.throws(() => readMessageSnapshot('unused', options, { sqliteJson() { assert.fail('invalid options queried SQLite'); } }), TypeError);
  }
  const f = fixture(t);
  let calls = 0;
  assert.throws(() => readMessageSnapshot(f.db, {}, { sqliteJson(db, sql, label) {
    calls++;
    const rows = readOnlySqliteJson(db, sql, label);
    if (calls === 2) rows[0].total = 1;
    return rows;
  } }), error => error instanceof SqliteReadError && error.reason === 'invalid_response');
});

test('1000 selected records use bounded wire rows within one snapshot without aggregate-text timeout', t => {
  const f = fixture(t);
  sqliteExec(f.db, Array.from({ length: 1003 }, (_, index) => recordSql(index + 1,
    { raw: '{"authored":"escaped \\u0041 and nested text"}', canonical: '{ "authored": 9007199254740993 }' })
    + observationSql(index + 1, {}, { external_version: null, raw_json: '{"authored":"escaped \\u0041 and nested text"}' })).join('\n'));
  const before = sha(f.db), calls = [];
  const start = performance.now();
  const result = readMessageSnapshot(f.db, { limit: 1000 }, { sqliteJson(db, sql, label) {
    // The former aggregate wire hit the production 30s timeout even for this
    // small fixture. Bound the real SQLite subprocess; do not raise timeouts.
    const rows = readOnlySqliteJson(db, sql, label, { timeoutMs: 5000 });
    calls.push({ label, rows });
    return rows;
  } });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.population, { total: 1003, evaluated: 1000, not_evaluated: 3 });
  assert.equal(result.rows[0].id, 1003); assert.equal(result.rows.at(-1).id, 4);
  assert.equal(result.rows[0].raw_json, '{"authored":"escaped \\u0041 and nested text"}');
  assert.equal(result.rows[0].canonical_json, '{ "authored": 9007199254740993 }');
  assert.equal(calls[1].rows.filter(row => row.kind === 'metadata').length, 1);
  assert.equal(calls[1].rows.filter(row => row.kind === 'row').length, 1000);
  assert.equal(calls[1].rows.filter(row => row.kind === 'observation').length, 1000);
  assert.equal(result.observations.length, 1000);
  assert.deepEqual(result.observations.map(item => item.record_id), Array.from({ length: 1000 }, (_, index) => index + 4));
  assert.equal(sha(f.db), before);
  t.diagnostic(JSON.stringify({ selected: 1000, elapsed_ms: Math.round(performance.now() - start) }));
});

test('split wire rejects unknown kinds, missing/duplicate positions, duplicate metadata and invalid payloads', t => {
  const f = fixture(t);
  sqliteExec(f.db, recordSql(1) + recordSql(2));
  for (const change of [
    rows => { rows.find(row => row.kind === 'row').kind = 'unknown'; },
    rows => { rows.find(row => row.kind === 'row').position = 2; },
    rows => { rows.push({ ...rows.find(row => row.kind === 'row') }); },
    rows => { rows.push({ ...rows.find(row => row.kind === 'metadata') }); },
    rows => { rows.find(row => row.kind === 'row').payload = '[]'; },
    rows => { rows.find(row => row.kind === 'row').payload = '{'; },
  ]) {
    assert.throws(() => readMessageSnapshot(f.db, {}, { sqliteJson(db, sql, label) {
      const rows = readOnlySqliteJson(db, sql, label);
      if (label === 'read message snapshot') change(rows);
      return rows;
    } }), error => error instanceof SqliteReadError && error.reason === 'invalid_response');
  }
});
