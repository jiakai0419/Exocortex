import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureInitialized, quoteSql as q, sqliteExec, INITIAL_ACCOUNT_KIND } from '../dist/storage/sqlite/ingestion-store.js';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';
import { captureLarkWriteAdmission } from '../src/diagnostics/lark-write-admission.mjs';
import { commitEnrichmentUpdates } from '../src/maintenance/enrichment-commit.mjs';
import { executeMessages } from '../src/cli/messages-command.mjs';
import { readMessagesMetadata } from '../src/diagnostics/messages-report.mjs';
import { observeMessageReadiness, planReadinessObservations, readinessSourceVersionKey } from '../src/diagnostics/message-readiness-ledger.mjs';

// All fixtures are authored; real SQLite, admission, locks and message-reading
// pipeline are used. No real database, identity, payload or API is consulted.
const SELF = 'ou_synthetic_observer', ACTOR = 'ou_synthetic_observed_actor';
const ACCOUNT = createHash('sha256').update(`lark.im\0${SELF}`).digest('hex');
const NOW = Date.parse('2045-01-01T00:00:00.000Z'), CHAT = 'oc_synthetic_observed_group';
const checksum = value => createHash('sha256').update(value).digest('hex');
const query = db => (sql, label = 'synthetic readiness inspection') => readOnlySqliteJson(db, sql, label);
function insert(db, id, { named = false, padding = '' } = {}) {
  const raw = { message_id: `om_synthetic_observed_${id}`, chat_id: CHAT, chat_type: 'group',
    chat_name: 'Invented Observed Workshop', msg_type: 'text', create_time: String(NOW - 1000 + id),
    sender: { id: ACTOR, id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: `Invented observation ${id}.` }) }, padding };
  const canonical = { message_id: raw.message_id, chat_id: CHAT, chat_type: 'group', chat_name: raw.chat_name,
    chat_name_source: 'message', sender_id: ACTOR, sender_id_type: 'open_id', sender_type: 'user', msg_type: 'text',
    ...(named ? { sender_name: 'Invented Mira', sender_name_source: 'contact', sender_name_confidence: 'high', sender_name_account_key: ACCOUNT } : {}) };
  const row = { id, source_id: 'lark.im', first_seen_scope_id: 'lark.im.sent_by_me', external_id: raw.message_id,
    external_version: '1', record_type: 'lark.im.message', occurred_at: new Date(NOW - 1000 + id).toISOString(),
    occurred_at_ms: NOW - 1000 + id, actor_id: ACTOR, container_id: CHAT, direction: 'received',
    body: `Invented observation ${id}.`, raw_json: JSON.stringify(raw), canonical_json: JSON.stringify(canonical), content_hash: checksum(JSON.stringify(raw)) };
  sqliteExec(db, `INSERT INTO records(${Object.keys(row).join(',')}) VALUES(${Object.values(row).map(q).join(',')});`);
}
function read(db, ids, now) {
  const messages = executeMessages({ db, direction: 'all', limit: 40, search: '', recordIds: ids });
  const metadata = readMessagesMetadata(messages);
  assert.equal(metadata.observation_complete, true);
  // The fixture controls the observer clock, after the actual snapshot and
  // mapping validation. Production uses SQLite's original read_at unchanged.
  metadata.as_of = { ...metadata.as_of, read_at: new Date(now).toISOString() };
  return { messages, metadata };
}
function commitFor(db) {
  const admission = captureLarkWriteAdmission(db, { selfOpenId: SELF, requireVerified: true });
  return (updates, reason) => commitEnrichmentUpdates(db, updates, {
    dryRun: false, reason, label: 'synthetic readiness commit',
    writeAdmission: admission.fence, admissionBeforeCommit: admission.assertCurrent,
  });
}
function fixture(t, count = 1, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'exo-synthetic-readiness-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = { dir, db: join(dir, 'synthetic.sqlite'), now: NOW, reads: [] };
  ensureInitialized(f.db);
  const binding = { initial_account_binding: { kind: INITIAL_ACCOUNT_KIND, account_key: ACCOUNT,
    reserved_at: '2025-01-01T00:00:00.000Z', confirmed_at: '2025-01-01T00:00:00.000Z' } };
  sqliteExec(f.db, `UPDATE sources SET config_json=${q(JSON.stringify(binding))} WHERE id='lark.im';`);
  for (let id = 1; id <= count; id++) insert(f.db, id, opts);
  f.query = query(f.db); f.commit = commitFor(f.db);
  f.readRows = (db, ids) => { f.reads.push(ids); return read(db, ids, f.now); };
  f.run = (extra = {}) => observeMessageReadiness(f.db, { observerAccountKey: ACCOUNT, query: f.query,
    readRows: f.readRows, commit: f.commit, nowMs: f.now, ...extra });
  return f;
}
const ledger = f => f.query('SELECT * FROM lark_im_message_readiness ORDER BY record_id;');
const scan = f => f.query('SELECT * FROM lark_im_message_readiness_scan;')[0];
function setName(f, name = 'Invented Mira') {
  sqliteExec(f.db, `UPDATE records SET canonical_json=json_set(canonical_json,'$.sender_name',${q(name)},
    '$.sender_name_source','contact','$.sender_name_confidence','high','$.sender_name_account_key',${q(ACCOUNT)});`);
}
function removeName(f) { sqliteExec(f.db, "UPDATE records SET canonical_json=json_remove(canonical_json,'$.sender_name');"); }

test('actual pipeline observations preserve first clocks and count ready regressions once', t => {
  const f = fixture(t), original = f.query('SELECT * FROM records;');
  assert.deepEqual(f.run(), { reason: 'observed', scanned: 1, observed: 1, deferred: 0 });
  assert.equal(ledger(f)[0].state, 'enriching');
  assert.equal(ledger(f)[0].first_missing_observed_at_ms, NOW);
  f.now += 60000; f.run();
  assert.equal(ledger(f)[0].first_missing_observed_at_ms, NOW);
  setName(f); f.now += 60000; f.run();
  assert.equal(ledger(f)[0].state, 'ready');
  assert.equal(ledger(f)[0].first_ready_observed_at_ms, NOW + 120000);
  removeName(f); f.now += 60000; f.run();
  assert.equal(ledger(f)[0].observed_regression_count, 1);
  f.now += 60000; f.run();
  assert.equal(ledger(f)[0].observed_regression_count, 1);
  setName(f); f.now += 60000; f.run(); removeName(f); f.now += 60000; f.run();
  assert.equal(ledger(f)[0].observed_regression_count, 2);
  const current = f.query('SELECT * FROM records;');
  for (const key of Object.keys(original[0]).filter(key => key !== 'canonical_json')) assert.equal(current[0][key], original[0][key]);
  assert(!Object.hasOwn(ledger(f)[0], 'first_complete_at'), 'no fabricated true-completion clock');
});

test('already-ready first encounter has no invented missing period; source changes start new observed epoch', t => {
  const f = fixture(t, 1, { named: true }); f.run();
  const first = ledger(f)[0];
  assert.equal(first.first_missing_observed_at_ms, null); assert.equal(first.first_ready_observed_at_ms, NOW);
  sqliteExec(f.db, "UPDATE records SET external_version='2',raw_json=json_set(raw_json,'$.observed_extra','authored');");
  f.now += 60000; f.run();
  const second = ledger(f)[0];
  assert.equal(second.source_epoch, 2); assert.notEqual(second.source_version_key, first.source_version_key);
  assert.equal(second.first_ready_observed_at_ms, f.now); assert.equal(second.observed_regression_count, 0);
});

test('same-timestamp replay is idempotent; contradictory and rollback observations defer', t => {
  const f = fixture(t); f.run();
  const data = read(f.db, [1], NOW), previous = ledger(f);
  const plan = value => planReadinessObservations({ ...value, previous: ledger(f), observerAccountKey: ACCOUNT });
  assert.equal(f.commit(plan(data).updates, 'synthetic replay').updated, 1);
  assert.equal(ledger(f)[0].observed_regression_count, 0);
  setName(f);
  assert.equal(plan(read(f.db, [1], NOW)).deferred, 1);
  assert.equal(plan(read(f.db, [1], NOW - 1)).deferred, 1);
  assert.equal(plan(read(f.db, [1], NOW - 1)).updates.length, 0);
  assert.equal(ledger(f)[0].first_missing_observed_at_ms, previous[0].first_missing_observed_at_ms);
});

for (const [label, change] of [
  ['raw', "raw_json=json_set(raw_json,'$.new_source','synthetic')"],
  ['version', "external_version='2'"], ['actor', "actor_id='synthetic_other_actor'"],
  ['container', "container_id='synthetic_other_chat'"], ['direction', 'direction=NULL'],
  ['event time', 'occurred_at_ms=occurred_at_ms+1'], ['event text', "occurred_at='2040-01-01T00:00:00.000Z'"],
  ['external identity', "external_id='synthetic_other_message'"],
]) test(`source CAS rejects concurrent ${label} without dropping collected data`, t => {
  const f = fixture(t), commit = f.commit;
  const result = f.run({ commit(updates, reason) {
    if (reason.endsWith('_finish')) sqliteExec(f.db, `UPDATE records SET ${change};`);
    return commit(updates, reason);
  } });
  assert.equal(result.observed, 0); assert.equal(result.deferred, 1); assert.deepEqual(ledger(f), []);
  assert.equal(f.query('SELECT COUNT(*) AS n FROM records;')[0].n, 1);
  assert.equal(scan(f).last_deferred_count, 1);
});

test('canonical change after the snapshot preserves the truthful past incomplete observation', t => {
  const f = fixture(t), commit = f.commit;
  const result = f.run({ commit(updates, reason) {
    if (reason.endsWith('_finish')) setName(f);
    return commit(updates, reason);
  } });
  assert.equal(result.observed, 1); assert.equal(ledger(f)[0].state, 'enriching');
  assert.equal(read(f.db, [1], f.now + 1).messages[0].readiness.state, 'ready');
  f.now += 60000; f.run(); assert.equal(ledger(f)[0].state, 'ready');
});

test('a stale ledger predecessor cannot overwrite a newer observation', t => {
  const f = fixture(t); f.run();
  const oldPlan = planReadinessObservations({ ...read(f.db, [1], NOW + 1), previous: ledger(f), observerAccountKey: ACCOUNT });
  setName(f); f.now += 60000; f.run();
  const newer = ledger(f);
  assert.equal(f.commit(oldPlan.updates, 'synthetic stale predecessor').updated, 0);
  assert.deepEqual(ledger(f), newer);
});

test('account changes after the reading refuse the entire admitted commit', t => {
  const f = fixture(t), commit = f.commit;
  const result = f.run({ commit(updates, reason) {
    if (reason.endsWith('_finish')) sqliteExec(f.db, "UPDATE records SET direction='sent';");
    return commit(updates, reason);
  } });
  assert.equal(result.reason, 'observation_failed'); assert.equal(result.observed, 0);
  assert.equal(ledger(f).length, 0); assert.equal(scan(f).generation, 1);
});

test('partial mapping, invalid protocol and thrown reads never invent a successful observation', t => {
  const f = fixture(t);
  assert.equal(f.run({ readRows(db, ids) { const value = read(db, ids, f.now); value.metadata.observation_complete = false; return value; } }).reason, 'invalid_observation');
  assert.equal(ledger(f).length, 0);
  assert.equal(scan(f).last_scanned_count, 1); assert.equal(scan(f).last_deferred_count, 1);
  assert.equal(scan(f).history_after_id, 1);
  f.now += 60000;
  assert.equal(f.run({ readRows() { throw new Error('synthetic mapping changed'); } }).reason, 'observation_failed');
  assert.equal(ledger(f).length, 0);
  assert.equal(scan(f).last_observed_count, 0); assert.equal(scan(f).last_deferred_count, 1);
  f.now += 60000;
  const result = f.run({ readRows(db, ids) { const value = read(db, ids, f.now); value.messages[0].readiness = { version: 1, state: 'ready' }; return value; } });
  assert.equal(result.observed, 0); assert.equal(result.deferred, 1);
  assert.equal(ledger(f).length, 0); assert.equal(scan(f).last_deferred_count, 1);
});

test('no writer defaults, malformed proofs and asynchronous callbacks fail closed', t => {
  const f = fixture(t), data = read(f.db, [1], NOW), before = readFileSync(f.db);
  assert.equal(observeMessageReadiness(f.db, { observerAccountKey: ACCOUNT, nowMs: NOW }).reason, 'invalid_dependencies');
  assert.equal(f.run({ query: () => Promise.resolve([]) }).reason, 'invalid_scan');
  for (const edit of [value => { value.metadata.as_of.read_at = null; },
    value => { delete value.metadata.source_records[0].external_version; },
    value => { value.metadata.source_records[0].actor_id = 'other'; },
    value => { value.metadata.source_records[0].raw_json += '\0'; },
    value => { value.messages[0].external_version = 'different'; }]) {
    const value = structuredClone(data); edit(value);
    assert.equal(planReadinessObservations({ ...value, observerAccountKey: ACCOUNT }).reason, 'invalid_observation');
  }
  assert.deepEqual(readFileSync(f.db), before);
});

test('existing real sync lock prevents cadence and ledger writes', t => {
  const f = fixture(t);
  sqliteExec(f.db, "INSERT INTO sync_locks(scope_id,locked_by,locked_at,expires_at) VALUES('lark.im.sent_by_me','synthetic_owner','2000-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');");
  const original = f.query('SELECT * FROM records;');
  assert.equal(f.run().reason, 'observation_failed');
  assert.equal(ledger(f).length, 0); assert.equal(scan(f), undefined); assert.equal(f.reads.length, 0);
  assert.deepEqual(f.query('SELECT * FROM records;'), original);
});

test('a lost scan claim rolls back the entire short final transaction', t => {
  const f = fixture(t), commit = f.commit;
  assert.equal(f.run({ commit(updates, reason) {
    if (reason.endsWith('_finish')) sqliteExec(f.db, 'UPDATE lark_im_message_readiness_scan SET generation=generation+1;');
    return commit(updates, reason);
  } }).reason, 'observation_failed');
  assert.equal(ledger(f).length, 0);
  assert.equal(f.query('SELECT COUNT(*) AS n FROM records;')[0].n, 1);
});

test('durable history horizon keeps progressing while the independent new tail receives traffic', t => {
  const f = fixture(t, 65); f.run();
  assert.equal(f.reads[0].length, 40); assert.equal(scan(f).tail_after_id, 65);
  assert.equal(scan(f).history_after_id, 20); assert.equal(scan(f).history_horizon_id, 65);
  for (let id = 66; id <= 90; id++) insert(f.db, id);
  f.now += 60000; f.run();
  assert.equal(scan(f).history_after_id, 40); assert.equal(scan(f).history_horizon_id, 65); assert.equal(scan(f).tail_after_id, 85);
  f.now += 60000; f.run(); assert.equal(scan(f).history_after_id, 60);
  f.now += 60000; f.run(); assert.equal(scan(f).history_after_id, 65);
  assert.equal(ledger(f).length, 90); assert(f.reads.every(ids => ids.length <= 40 && new Set(ids).size === ids.length));
});

test('capacity deferrals remain visible and do not prevent later historical rows', t => {
  const f = fixture(t, 0); insert(f.db, 1, { padding: 'x'.repeat(2 * 1024 * 1024) });
  for (let id = 2; id <= 45; id++) insert(f.db, id);
  const first = f.run();
  assert.equal(first.scanned, 40); assert.equal(first.observed, 39); assert.equal(first.deferred, 1);
  assert.equal(scan(f).history_after_id, 20);
  f.now += 60000; f.run();
  assert.equal(scan(f).history_after_id, 40); assert.equal(ledger(f).length, 44);
  assert(!ledger(f).some(row => row.record_id === 1));
});

test('actual snapshot growth is deferred despite the earlier small metadata selection', t => {
  const f = fixture(t), padding = 'x'.repeat(2 * 1024 * 1024);
  const result = f.run({ readRows(db, ids) {
    sqliteExec(db, `UPDATE records SET canonical_json=json_set(canonical_json,'$.authored_padding',${q(padding)});`);
    return read(db, ids, f.now);
  } });
  assert.equal(result.reason, 'capacity_deferred'); assert.equal(result.observed, 0); assert.equal(result.deferred, 1);
  assert.equal(ledger(f).length, 0); assert.equal(scan(f).last_deferred_count, 1);
  const data = read(f.db, [1], NOW);
  assert.equal(planReadinessObservations({ ...data, observerAccountKey: ACCOUNT }).reason, 'capacity_deferred');
});

test('failed reading attempts persist visible debt and advance a bounded historical prefix', t => {
  const f = fixture(t, 61);
  const result = f.run({ readRows() { throw new Error('synthetic mapping failure'); } });
  assert.equal(result.deferred, 40); assert.equal(ledger(f).length, 0);
  assert.equal(scan(f).last_scanned_count, 40); assert.equal(scan(f).last_deferred_count, 40);
  assert.equal(scan(f).history_after_id, 20); assert.equal(scan(f).history_horizon_id, 61);
  f.now += 60000; f.run();
  assert.equal(scan(f).history_after_id, 40); assert.equal(ledger(f).length, 20);
  assert.equal(ledger(f)[0].record_id, 21);
});

test('empty population records an empty bounded attempt without inventing observations', t => {
  const f = fixture(t, 0);
  assert.deepEqual(f.run(), { reason: 'observed', scanned: 0, observed: 0, deferred: 0 });
  assert.equal(f.reads.length, 0); assert.equal(ledger(f).length, 0);
  assert.equal(scan(f).history_horizon_id, 0); assert.equal(scan(f).last_scanned_count, 0);
});

test('restart preserves the cadence and resumes the saved historical cursor', t => {
  const f = fixture(t, 61); f.run();
  const moduleUrl = new URL('../src/diagnostics/message-readiness-ledger.mjs', import.meta.url).href;
  const readUrl = new URL('../src/storage/sqlite/readonly-query.mjs', import.meta.url).href;
  const commandUrl = new URL('../src/cli/messages-command.mjs', import.meta.url).href;
  const reportUrl = new URL('../src/diagnostics/messages-report.mjs', import.meta.url).href;
  const admissionUrl = new URL('../src/diagnostics/lark-write-admission.mjs', import.meta.url).href;
  const commitUrl = new URL('../src/maintenance/enrichment-commit.mjs', import.meta.url).href;
  const script = `import {observeMessageReadiness} from ${JSON.stringify(moduleUrl)};
    import {readOnlySqliteJson} from ${JSON.stringify(readUrl)};
    import {executeMessages} from ${JSON.stringify(commandUrl)};
    import {readMessagesMetadata} from ${JSON.stringify(reportUrl)};
    import {captureLarkWriteAdmission} from ${JSON.stringify(admissionUrl)};
    import {commitEnrichmentUpdates} from ${JSON.stringify(commitUrl)};
    const [db,account,self,clock]=process.argv.slice(1), nowMs=Number(clock);
    const admission=captureLarkWriteAdmission(db,{selfOpenId:self,requireVerified:true});
    const result=observeMessageReadiness(db,{observerAccountKey:account,nowMs,query:(sql,label)=>readOnlySqliteJson(db,sql,label),
      readRows:(db,ids)=>{const messages=executeMessages({db,direction:'all',limit:40,search:'',recordIds:ids});
        const metadata=readMessagesMetadata(messages);metadata.as_of.read_at=new Date(nowMs).toISOString();return {messages,metadata};},
      commit:(updates,reason)=>commitEnrichmentUpdates(db,updates,{dryRun:false,reason,label:'synthetic restarted observation',
        writeAdmission:admission.fence,admissionBeforeCommit:admission.assertCurrent})});
    process.stdout.write(JSON.stringify(result));`;
  const run = now => { const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.db, ACCOUNT, SELF, String(now)], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout); };
  const before = readFileSync(f.db);
  assert.equal(run(NOW + 1).reason, 'cadence'); assert.deepEqual(readFileSync(f.db), before);
  assert.equal(run(NOW + 60000).observed, 20); assert.equal(scan(f).history_after_id, 40);
});

test('account observers are separate historical contexts and do not write record ownership', t => {
  const f = fixture(t); f.run(); const before = f.query('SELECT canonical_json FROM records;');
  const other = checksum('synthetic other observer');
  // Pure plans only label the already admitted observer; production admission
  // is supplied by the caller, never derived from this table's account field.
  const plan = planReadinessObservations({ ...read(f.db, [1], NOW + 1), observerAccountKey: other });
  assert.equal(plan.updates.length, 1);
  assert.notEqual(readinessSourceVersionKey(read(f.db, [1], NOW).metadata.source_records[0]), other);
  assert.deepEqual(f.query('SELECT canonical_json FROM records;'), before);
});
