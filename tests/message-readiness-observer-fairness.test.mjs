import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ensureInitialized, quoteSql as q, sqliteExec, INITIAL_ACCOUNT_KIND } from '../dist/storage/sqlite/ingestion-store.js';
import { readOnlySqliteJson, SqliteReadError } from '../src/storage/sqlite/readonly-query.mjs';
import { captureLarkWriteAdmission } from '../src/diagnostics/lark-write-admission.mjs';
import { commitEnrichmentUpdates } from '../src/maintenance/enrichment-commit.mjs';
import { executeMessages } from '../src/cli/messages-command.mjs';
import { readMessagesMetadata } from '../src/diagnostics/messages-report.mjs';
import { observeMessageReadiness } from '../src/diagnostics/message-readiness-ledger.mjs';
import { normalizeReadinessObservation } from '../src/diagnostics/readiness-observer-result.mjs';

// All data is authored. The real SQLite selector, account admission, guarded
// writer and complete messages projection run locally; no API is consulted.
const SELF = 'ou_synthetic_fair_observer', ACTOR = 'ou_synthetic_fair_author';
const ACCOUNT = createHash('sha256').update(`lark.im\0${SELF}`).digest('hex');
const CHAT = 'oc_synthetic_fairness_workshop', NOW = Date.parse('2045-02-03T04:05:06.000Z');
const ROLE_BYTES = 2 * 1024 * 1024;
const query = db => (sql, label = 'synthetic fairness read') => readOnlySqliteJson(db, sql, label);

function row(id, opts = {}) {
  const raw = { message_id: `om_synthetic_fair_${id}`, chat_id: CHAT, chat_type: 'group',
    chat_name: 'Authored Fairness Workshop', msg_type: 'text', create_time: String(NOW - 100000 + id),
    sender: { id: ACTOR, id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: `Authored fairness sample ${id}.` }) }, padding: opts.padding || '' };
  const canonical = { message_id: raw.message_id, chat_id: CHAT, chat_type: 'group', chat_name: raw.chat_name,
    chat_name_source: 'message', sender_id: ACTOR, sender_id_type: 'open_id', sender_type: 'user', msg_type: 'text',
    sender_name: 'Authored Juniper', sender_name_source: 'contact', sender_name_confidence: 'high', sender_name_account_key: ACCOUNT };
  return { id, source_id: 'lark.im', first_seen_scope_id: 'lark.im.sent_by_me', external_id: raw.message_id,
    external_version: '1', record_type: 'lark.im.message', occurred_at: new Date(Number(raw.create_time)).toISOString(),
    occurred_at_ms: Number(raw.create_time), actor_id: ACTOR, container_id: CHAT, direction: 'received',
    body: `Authored fairness sample ${id}.`, raw_json: JSON.stringify(raw), canonical_json: JSON.stringify(canonical),
    content_hash: createHash('sha256').update(JSON.stringify(raw)).digest('hex') };
}
function insert(db, ids, options = () => ({})) {
  if (!ids.length) return;
  const rows = ids.map(id => row(id, options(id))), fields = Object.keys(rows[0]);
  sqliteExec(db, `INSERT INTO records(${fields.join(',')}) VALUES ${rows.map(value =>
    `(${fields.map(field => q(value[field])).join(',')})`).join(',')};`);
}
const range = (first, last) => Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);
function read(db, ids, now) {
  const messages = executeMessages({ db, direction: 'all', limit: 40, search: '', recordIds: ids });
  const metadata = readMessagesMetadata(messages);
  assert.equal(metadata.observation_complete, true);
  metadata.as_of = { ...metadata.as_of, read_at: new Date(now).toISOString() };
  return { messages, metadata };
}
function driver(db, now) {
  const admission = captureLarkWriteAdmission(db, { selfOpenId: SELF, requireVerified: true });
  return { observerAccountKey: ACCOUNT, nowMs: now, query: query(db), readRows: (path, ids) => read(path, ids, now),
    commit: (updates, reason) => commitEnrichmentUpdates(db, updates, { dryRun: false, reason,
      label: 'synthetic fairness commit', writeAdmission: admission.fence, admissionBeforeCommit: admission.assertCurrent }) };
}
function fixture(t, count, options) {
  const dir = mkdtempSync(join(tmpdir(), 'exo-synthetic-readiness-fairness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = { dir, db: join(dir, 'synthetic.sqlite'), now: NOW, reads: [] };
  ensureInitialized(f.db);
  sqliteExec(f.db, `UPDATE sources SET config_json=${q(JSON.stringify({ initial_account_binding: {
    kind: INITIAL_ACCOUNT_KIND, account_key: ACCOUNT, reserved_at: '2025-01-01T00:00:00.000Z',
    confirmed_at: '2025-01-01T00:00:00.000Z' } }))} WHERE id='lark.im';`);
  insert(f.db, range(1, count), options);
  f.query = query(f.db);
  f.run = extra => {
    const options = driver(f.db, f.now), base = options.readRows;
    const value = observeMessageReadiness(f.db, { ...options, readRows(path, ids) {
      assert(ids.length <= 40 && new Set(ids).size === ids.length); f.reads.push([...ids]); return base(path, ids);
    }, ...extra });
    assert.deepEqual(normalizeReadinessObservation(value), value, 'every result uses the closed public contract');
    return value;
  };
  return f;
}
const scan = f => f.query('SELECT * FROM lark_im_message_readiness_scan;')[0];
const ledger = f => f.query('SELECT * FROM lark_im_message_readiness ORDER BY record_id;');
function seedScan(f, { tail = 0, history = 0, horizon, generation = 2 } = {}) {
  const max = horizon ?? f.query('SELECT COALESCE(MAX(id),0) AS n FROM records;')[0].n;
  sqliteExec(f.db, `INSERT INTO lark_im_message_readiness_scan(source_id,observer_account_key,contract_version,
    tail_after_id,history_after_id,history_horizon_id,next_attempt_at_ms,last_attempt_at_ms,generation)
    VALUES('lark.im',${q(ACCOUNT)},1,${tail},${history},${max},${NOW},${NOW - 60000},${generation});`);
}

if (process.argv[2] === '--observe-child') {
  const [db, clock] = process.argv.slice(3);
  process.stdout.write(JSON.stringify(observeMessageReadiness(db, driver(db, Number(clock)))));
} else {
  test('more than885 old records plus ten new per opportunity preserves newest visibility and old fairness', t => {
    const f = fixture(t, 900); seedScan(f, { horizon: 900 });
    let previousTail = 0, previousHistory = 0;
    const sourceBefore = f.query('SELECT id,raw_json,body,canonical_json,external_version FROM records ORDER BY id;');
    for (let opportunity = 1; opportunity <= 45; opportunity++) {
      const first = 900 + (opportunity - 1) * 10 + 1, fresh = range(first, first + 9);
      insert(f.db, fresh);
      const result = f.run(), state = scan(f), rows = new Map(ledger(f).map(item => [item.record_id, item]));
      assert.equal(result.reason, 'observed'); assert.equal(result.claim_state, 'confirmed'); assert.equal(result.finish_state, 'confirmed');
      assert.equal(result.cleanup_state, 'unknown', 'compatibility callback has no private release receipt; this is not a fabricated cleanup failure');
      assert.equal(result.deferred, 0); assert(result.scanned <= 40);
      for (const id of fresh) {
        assert.equal(rows.get(id)?.first_ready_observed_at_ms, f.now, 'fresh row is observed on this opportunity, never backdated');
        assert.equal(rows.get(id)?.first_observed_at_ms, f.now);
      }
      assert.equal(state.tail_after_id, previousTail + 10, 'head must not jump the continuous watermark');
      assert.equal(state.history_after_id, Math.min(900, previousHistory + 20));
      assert.equal(state.history_horizon_id, 900, 'new traffic cannot move a running historical horizon');
      assert.equal(state.next_attempt_at_ms, f.now + 60000);
      previousTail = state.tail_after_id; previousHistory = state.history_after_id; f.now += 60000;
    }
    const all = new Set(ledger(f).map(item => item.record_id));
    assert(range(1, 1350).every(id => all.has(id)), 'all900 old rows and all450 fresh rows accounted for');
    assert.deepEqual(f.query('SELECT id,raw_json,body,canonical_json,external_version FROM records WHERE id<=900 ORDER BY id;'), sourceBefore);
  });

  test('first observer starts continuous debt at zero and head duplicates release slots without gaps', t => {
    const f = fixture(t, 35), first = f.run();
    assert.equal(first.scanned, 30); assert.equal(first.observed, 30);
    assert.equal(scan(f).tail_after_id, 10); assert.equal(scan(f).history_after_id, 20);
    f.now += 60000; f.run();
    assert.equal(scan(f).tail_after_id, 20); assert.equal(scan(f).history_after_id, 35);
    f.now += 60000; f.run();
    assert.equal(scan(f).tail_after_id, 35, 'duplicates in latest head allow all remaining contiguous tail rows');
    assert.equal(ledger(f).length, 35);
    assert(f.reads.every(ids => ids.length <= 40 && new Set(ids).size === ids.length));
  });

  test('eleven-row burst leaves the missed head row owed and the continuous tail eventually observes it', t => {
    const f = fixture(t, 900); seedScan(f, { tail: 870, history: 0, horizon: 900 });
    insert(f.db, range(901, 911)); const first = f.run();
    assert.equal(first.observed, first.scanned);
    let rows = new Map(ledger(f).map(item => [item.record_id, item]));
    assert(!rows.has(901), 'burst row outside newest10 is still genuinely unobserved');
    for (const id of range(902, 911)) assert.equal(rows.get(id).first_ready_observed_at_ms, NOW);
    assert.equal(scan(f).tail_after_id, 880);
    for (let opportunity = 1; opportunity <= 3; opportunity++) { f.now += 60000; f.run(); }
    rows = new Map(ledger(f).map(item => [item.record_id, item]));
    assert.equal(rows.get(901).first_ready_observed_at_ms, NOW + 180000, 'not assigned earlier burst/source/insert time');
    assert.equal(scan(f).tail_after_id, 911);
    assert.equal(f.query('SELECT COUNT(*) AS n FROM records WHERE id>=901;')[0].n, 11, 'unseen messages never filtered out of population');
  });

  test('head and continuous tail share2MiB while historical selection keeps its separate2MiB', t => {
    const f = fixture(t, 100, id => ({ padding: id >= 51 && id <= 60 || id >= 91 ? 'x'.repeat(120000) : '' }));
    seedScan(f, { tail: 50, history: 0, horizon: 100 });
    const result = f.run(), selected = f.reads[0];
    assert.equal(result.scanned, 40); assert.equal(result.observed, 37); assert.equal(result.deferred, 3);
    assert.equal(scan(f).tail_after_id, 57, 'capacity-deferred58–60 remain ahead of the continuous cursor');
    assert.equal(scan(f).history_after_id, 20);
    const sizes = new Map(f.query('SELECT id,length(CAST(raw_json AS BLOB))+length(CAST(canonical_json AS BLOB))+length(CAST(body AS BLOB)) AS bytes FROM records;').map(item => [item.id, item.bytes]));
    const recentBytes = selected.filter(id => id >= 51).reduce((sum, id) => sum + sizes.get(id), 0);
    const historyBytes = selected.filter(id => id <= 20).reduce((sum, id) => sum + sizes.get(id), 0);
    assert(recentBytes <= ROLE_BYTES); assert(historyBytes <= ROLE_BYTES);
    assert(range(1, 20).every(id => selected.includes(id)), 'head payload cannot consume the history byte grant');
    assert.equal(ledger(f).length, 37); assert.equal(f.query('SELECT COUNT(*) AS n FROM records;')[0].n, 100);
    assert(range(58, 60).every(id => !ledger(f).some(row => row.record_id === id)));
    f.now += 60000; f.run();
    const after = new Map(ledger(f).map(row => [row.record_id, row]));
    for (const id of range(58, 60)) assert.equal(after.get(id).first_ready_observed_at_ms, NOW + 60000);
  });

  test('restart preserves cadence, head visibility and contiguous watermarks without rebuilding progress', t => {
    const f = fixture(t, 900); seedScan(f, { tail: 100, history: 200, horizon: 900 });
    insert(f.db, range(901, 910)); f.run(); const before = readFileSync(f.db), current = scan(f);
    const child = clock => {
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--observe-child', f.db, String(clock)], { encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
    };
    assert.equal(child(NOW + 1).reason, 'cadence'); assert.deepEqual(readFileSync(f.db), before);
    insert(f.db, range(911, 920)); const next = child(NOW + 60000);
    assert.equal(next.reason, 'observed'); assert.equal(next.finish_state, 'confirmed');
    assert.equal(scan(f).tail_after_id, current.tail_after_id + 10); assert.equal(scan(f).history_after_id, current.history_after_id + 20);
    const rows = new Map(ledger(f).map(item => [item.record_id, item]));
    for (const id of range(911, 920)) assert.equal(rows.get(id).first_ready_observed_at_ms, NOW + 60000);
    for (const id of range(901, 910)) assert.equal(rows.get(id).first_ready_observed_at_ms, NOW);
  });

  test('post-claim selection failure retains claim and cannot move either watermark', t => {
    const f = fixture(t, 900); seedScan(f, { tail: 100, history: 200, horizon: 900 }); const before = scan(f);
    const result = f.run({ query(sql, label) {
      if (label === 'select latest readiness observations') throw new Error('private synthetic SQL/path/token');
      return f.query(sql, label);
    } });
    assert.equal(result.reason, 'observation_failed'); assert.equal(result.diagnostic.stage, 'select');
    assert.equal(result.claim_state, 'confirmed'); assert.equal(result.finish_state, 'not_started');
    assert.equal(scan(f).generation, before.generation + 1); assert.equal(scan(f).tail_after_id, 100); assert.equal(scan(f).history_after_id, 200);
    assert.equal(ledger(f).length, 0); assert.doesNotMatch(JSON.stringify(result), /private synthetic|SQL\/path\/token/);
    f.now += 60000; assert.equal(f.run().reason, 'observed'); assert.equal(scan(f).tail_after_id, 110);
  });

  test('failed framed reading retains safe diagnostic, deferred denominator and confirmed bounded finish', t => {
    const f = fixture(t, 900); seedScan(f, { tail: 100, history: 200, horizon: 900 });
    const diagnostic = { version: 1, stage: 'snapshot_query', kind: 'timeout', status: null, signal: 'SIGKILL',
      spawn_code: 'ETIMEDOUT', sqlite_kind: 'unknown', elapsed_ms: 4000, timeout_ms: 4000, max_buffer_bytes: 50 * 1024 * 1024, stdout_bytes: 1000, stderr_bytes: 0 };
    const result = f.run({ readRows() { throw new SqliteReadError('read_timeout', 'synthetic private content', diagnostic); } });
    assert.equal(result.reason, 'observation_failed'); assert.equal(result.claim_state, 'confirmed'); assert.equal(result.finish_state, 'confirmed');
    assert.equal(result.scanned, 40); assert.equal(result.observed, 0); assert.equal(result.deferred, 40);
    assert.equal(result.diagnostic.stage, 'read'); assert.equal(result.diagnostic.kind, 'sqlite_read'); assert.deepEqual(result.diagnostic.read, diagnostic);
    assert.equal(scan(f).tail_after_id, 110); assert.equal(scan(f).history_after_id, 220); assert.equal(ledger(f).length, 0);
    assert.doesNotMatch(JSON.stringify(result), /synthetic private content/);
  });

  test('unknown finish does not claim success or rollback, even when synthetic callback committed before losing its response', t => {
    const f = fixture(t, 35), base = driver(f.db, f.now);
    const result = f.run({ commit(updates, reason) {
      const receipt = base.commit(updates, reason);
      if (reason.endsWith('_finish')) throw new Error('synthetic lost final response');
      return receipt;
    } });
    assert.equal(result.reason, 'observation_failed'); assert.equal(result.claim_state, 'confirmed'); assert.equal(result.finish_state, 'unknown');
    assert.equal(result.observed, 0); assert.equal(result.deferred, result.scanned); assert.equal(result.diagnostic.stage, 'finish');
    assert.equal(ledger(f).length, 30, 'actual committed effects remain; result is honest about lost confirmation');
    f.now += 60000; f.run(); assert.equal(ledger(f).length, 35);
  });

  test('head observation remains source-CAS protected and later epoch starts at its actual observation', t => {
    const f = fixture(t, 900); seedScan(f, { horizon: 900 }); insert(f.db, range(901, 910));
    const base = driver(f.db, f.now); let changed = false;
    const first = f.run({ commit(updates, reason) {
      if (reason.endsWith('_finish') && !changed) { changed = true; sqliteExec(f.db, "UPDATE records SET external_version='2',raw_json=json_set(raw_json,'$.source_edit','authored') WHERE id=910;"); }
      return base.commit(updates, reason);
    } });
    assert.equal(first.deferred, 1); assert(!ledger(f).some(item => item.record_id === 910));
    f.now += 60000; f.run(); let item = ledger(f).find(item => item.record_id === 910);
    assert.equal(item.first_ready_observed_at_ms, NOW + 60000); assert.equal(item.source_epoch, 1);
    sqliteExec(f.db, "UPDATE records SET external_version='3',raw_json=json_set(raw_json,'$.source_edit','new authored source') WHERE id=910;");
    f.now += 60000; f.run(); item = ledger(f).find(item => item.record_id === 910);
    assert.equal(item.source_epoch, 2); assert.equal(item.first_ready_observed_at_ms, NOW + 120000);
  });
}
