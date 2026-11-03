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

// Authored data only. Real SQLite, messages projection, account admission and
// guarded commits exercise the allocation and persisted cursors together.
const SELF = 'ou_authored_byte_observer', ACTOR = 'ou_authored_byte_author';
const ACCOUNT = createHash('sha256').update(`lark.im\0${SELF}`).digest('hex');
const CHAT = 'oc_authored_byte_workshop', NOW = Date.parse('2045-02-03T04:05:06.000Z');
const BYTES = 2 * 1024 * 1024;
const range = (first, last) => Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index);
const query = db => (sql, label = 'authored byte fairness read') => readOnlySqliteJson(db, sql, label);
const payloadSize = row => ['raw_json', 'canonical_json', 'body'].reduce((sum, field) => sum + Buffer.byteLength(row[field] ?? ''), 0);

function authoredRow(id, bytes) {
  const raw = { message_id: `om_authored_byte_${id}`, chat_id: CHAT, chat_type: 'group',
    chat_name: 'Authored Byte Workshop', msg_type: 'text', create_time: String(NOW - 100000 + id),
    sender: { id: ACTOR, id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: `Authored byte sample ${id}.` }) }, padding: '' };
  const canonical = { message_id: raw.message_id, chat_id: CHAT, chat_type: 'group', chat_name: raw.chat_name,
    chat_name_source: 'message', sender_id: ACTOR, sender_id_type: 'open_id', sender_type: 'user', msg_type: 'text',
    sender_name: 'Authored Linden', sender_name_source: 'contact', sender_name_confidence: 'high', sender_name_account_key: ACCOUNT };
  const row = { id, source_id: 'lark.im', first_seen_scope_id: 'lark.im.sent_by_me', external_id: raw.message_id,
    external_version: '1', record_type: 'lark.im.message', occurred_at: new Date(Number(raw.create_time)).toISOString(),
    occurred_at_ms: Number(raw.create_time), actor_id: ACTOR, container_id: CHAT, direction: 'received',
    body: `Authored byte sample ${id}.`, raw_json: JSON.stringify(raw), canonical_json: JSON.stringify(canonical), content_hash: '' };
  if (bytes !== undefined) {
    assert(bytes >= payloadSize(row)); raw.padding = 'x'.repeat(bytes - payloadSize(row)); row.raw_json = JSON.stringify(raw);
    assert.equal(payloadSize(row), bytes, 'exact payload boundary is authored, not approximated');
  }
  row.content_hash = createHash('sha256').update(row.raw_json).digest('hex');
  return row;
}
function insert(db, ids, sizes = () => undefined) {
  if (!ids.length) return;
  const rows = ids.map(id => authoredRow(id, sizes(id))), fields = Object.keys(rows[0]);
  sqliteExec(db, `INSERT INTO records(${fields.join(',')}) VALUES ${rows.map(row =>
    `(${fields.map(field => q(row[field])).join(',')})`).join(',')};`);
}
function driver(db, now) {
  const admission = captureLarkWriteAdmission(db, { selfOpenId: SELF, requireVerified: true });
  return { observerAccountKey: ACCOUNT, nowMs: now, query: query(db), readRows(path, ids) {
    assert(ids.length <= 40 && new Set(ids).size === ids.length);
    const messages = executeMessages({ db: path, direction: 'all', limit: 40, search: '', recordIds: ids });
    const metadata = readMessagesMetadata(messages);
    assert.equal(metadata.observation_complete, true);
    metadata.as_of = { ...metadata.as_of, read_at: new Date(now).toISOString() };
    return { messages, metadata };
  }, commit: (updates, reason) => commitEnrichmentUpdates(db, updates, { dryRun: false, reason,
    label: 'authored byte fairness commit', writeAdmission: admission.fence, admissionBeforeCommit: admission.assertCurrent }) };
}
function fixture(t, count = 35, sizes = id => id === 1 || id === 35 ? BYTES - 100 : undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'exo-authored-byte-fairness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = { dir, db: join(dir, 'authored.sqlite'), now: NOW, reads: [] };
  ensureInitialized(f.db);
  sqliteExec(f.db, `UPDATE sources SET config_json=${q(JSON.stringify({ initial_account_binding: {
    kind: INITIAL_ACCOUNT_KIND, account_key: ACCOUNT, reserved_at: '2025-01-01T00:00:00.000Z',
    confirmed_at: '2025-01-01T00:00:00.000Z' } }))} WHERE id='lark.im';`);
  insert(f.db, range(1, count), sizes); f.query = query(f.db);
  f.run = extra => {
    const options = driver(f.db, f.now), base = options.readRows;
    const result = observeMessageReadiness(f.db, { ...options, readRows(path, ids) {
      f.reads.push([...ids]); return base(path, ids);
    }, ...extra });
    assert.deepEqual(normalizeReadinessObservation(result), result);
    assert(result.scanned <= 40 && result.observed + result.deferred === result.scanned);
    return result;
  };
  return f;
}
const scan = f => f.query('SELECT * FROM lark_im_message_readiness_scan;')[0];
const ledger = f => f.query('SELECT * FROM lark_im_message_readiness ORDER BY record_id;');
function seed(f, { tail = 1, history = 0, horizon = 35 } = {}) {
  sqliteExec(f.db, `INSERT INTO lark_im_message_readiness_scan(source_id,observer_account_key,contract_version,
    tail_after_id,history_after_id,history_horizon_id,next_attempt_at_ms,last_attempt_at_ms,generation)
    VALUES('lark.im',${q(ACCOUNT)},1,${tail},${history},${horizon},${NOW},${NOW - 60000},2);`);
}
function later(f, times = 1) {
  for (let index = 0; index < times; index++) { f.now += 60000; assert.equal(f.run().reason, 'observed'); }
}
function sourceDigest(f) {
  return createHash('sha256').update(JSON.stringify(f.query('SELECT * FROM records ORDER BY id;'))).digest('hex');
}

if (process.argv[2] === '--observe-child') {
  const [db, clock] = process.argv.slice(3);
  process.stdout.write(JSON.stringify(observeMessageReadiness(db, driver(db, Number(clock)))));
} else {
  test('two legal near-limit rows cannot perpetually hide19 small historical rows', t => {
    const f = fixture(t); seed(f); const before = sourceDigest(f), seenAt = new Map();
    for (let opportunity = 0; opportunity < 6; opportunity++) {
      const result = f.run(); assert.equal(result.reason, 'observed');
      for (const id of f.reads.at(-1)) if (!seenAt.has(id)) seenAt.set(id, f.now);
      if (!opportunity) {
        assert.deepEqual(f.reads.at(-1), [35, 1]);
        assert.equal(scan(f).tail_after_id, 1); assert.equal(scan(f).history_after_id, 1);
        assert.equal(result.observed, 2); assert.equal(result.deferred, 28);
      }
      if (opportunity === 1) {
        assert(range(2, 20).every(id => ledger(f).some(row => row.record_id === id)));
        assert.equal(scan(f).tail_after_id, 11); assert.equal(scan(f).history_after_id, 21);
      }
      if (opportunity === 2) assert.equal(ledger(f).length, 35, 'all35 legal rows covered within3 opportunities');
      f.now += 60000;
    }
    assert.equal(sourceDigest(f), before);
    for (const row of ledger(f)) {
      // These two raw objects exceed the separate1MiB identity JSON limit.
      // Observation capacity permits them; it must not turn blocked into ready.
      const large = row.record_id === 1 || row.record_id === 35;
      assert.equal(row.state, large ? 'blocked' : 'ready');
      assert.equal(row.first_ready_observed_at_ms, large ? null : seenAt.get(row.record_id));
      assert.equal(row.first_observed_at_ms, seenAt.get(row.record_id)); assert.equal(row.source_epoch, 1);
    }
  });

  test('exact2MiB rows stay eligible and consume neither more than their role grant nor both grants', t => {
    const f = fixture(t, 35, id => id === 1 || id === 35 ? BYTES : undefined); seed(f);
    const result = f.run(); assert.equal(result.observed, 2); assert.deepEqual(f.reads[0], [35, 1]);
    assert.equal(scan(f).tail_after_id, 1); assert.equal(scan(f).history_after_id, 1);
    const sizes = f.query('SELECT id,length(CAST(raw_json AS BLOB))+length(CAST(canonical_json AS BLOB))+length(CAST(body AS BLOB)) AS bytes FROM records WHERE id IN(1,35);');
    assert(sizes.every(row => row.bytes === BYTES));
    later(f, 2); assert.equal(ledger(f).length, 35);
  });

  test('oversized predecessor and terminal rows remain deferred without blocking legal successors', t => {
    const f = fixture(t, 35, id => id === 1 || id === 35 ? BYTES + 1 : undefined); seed(f, { tail: 0 });
    const first = f.run(); assert(first.deferred >= 2);
    assert.equal(scan(f).tail_after_id, 10); assert.equal(scan(f).history_after_id, 20);
    assert(ledger(f).some(row => row.record_id === 2));
    later(f, 2); assert.equal(scan(f).tail_after_id, 35); assert.equal(scan(f).history_after_id, 20);
    assert.deepEqual(ledger(f).map(row => row.record_id), range(2, 34));
    assert(f.reads.every(ids => !ids.includes(1) && !ids.includes(35)));
    assert.equal(f.query('SELECT COUNT(*) AS n FROM records;')[0].n, 35);
  });

  test('a short partially allocated historical page cannot claim its horizon; an empty page can', t => {
    const f = fixture(t, 8, id => id === 1 || id === 8 ? BYTES : undefined); seed(f, { horizon: 8 });
    f.run(); assert.equal(scan(f).history_after_id, 1, 'short page still owes its legal excluded rows');
    later(f); assert.equal(scan(f).history_after_id, 8); assert.equal(ledger(f).length, 8);
    const empty = fixture(t, 0, () => undefined); seed(empty, { tail: 0, horizon: 35 });
    assert.equal(empty.run().observed, 0); assert.equal(scan(empty).history_after_id, 35); assert.equal(scan(empty).tail_after_id, 0);
  });

  test('continuous large newest arrivals keep their own observation and cannot starve a fixed old horizon', t => {
    const f = fixture(t, 60, id => id === 1 ? BYTES : undefined); seed(f, { tail: 0, horizon: 60 });
    for (let opportunity = 0; opportunity < 8; opportunity++) {
      const id = 61 + opportunity; insert(f.db, [id], () => BYTES); f.run();
      const fresh = ledger(f).find(row => row.record_id === id);
      assert.equal(fresh?.first_observed_at_ms, f.now);
      assert.equal(fresh?.state, 'blocked'); assert.equal(fresh?.first_ready_observed_at_ms, null);
      if (opportunity <= 3) assert.equal(scan(f).history_horizon_id, 60);
      if (opportunity === 3) assert(range(1, 60).every(old => ledger(f).some(row => row.record_id === old)));
      f.now += 60000;
    }
    assert.equal(f.query('SELECT COUNT(*) AS n FROM records;')[0].n, 68);
  });

  test('the persisted blocked prefix survives a fresh process and cadence does not fabricate earlier observations', t => {
    const f = fixture(t); seed(f); f.run(); const before = readFileSync(f.db);
    const child = clock => {
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--observe-child', f.db, String(clock)], { encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
    };
    assert.equal(child(NOW + 1).reason, 'cadence'); assert.deepEqual(readFileSync(f.db), before);
    assert.equal(child(NOW + 60000).finish_state, 'confirmed');
    assert.equal(scan(f).tail_after_id, 11); assert.equal(scan(f).history_after_id, 21);
    for (const row of ledger(f).filter(row => row.record_id >= 2 && row.record_id <= 21)) {
      assert.equal(row.first_ready_observed_at_ms, NOW + 60000);
    }
  });

  test('historical-role overlap may advance a tail prefix that received no recent-role bytes', t => {
    const f = fixture(t, 35, id => id === 35 ? BYTES : undefined); seed(f, { tail: 1, history: 1 });
    f.run(); assert.deepEqual(f.reads[0], [35, ...range(2, 21)]);
    assert.equal(scan(f).tail_after_id, 11); assert.equal(scan(f).history_after_id, 21);
    assert.equal(new Set(f.reads[0]).size, 21, 'overlap is read and charged only once');
  });

  test('a failed read keeps its safe error and deferred count without jumping across byte-excluded rows', t => {
    const f = fixture(t); seed(f);
    const diagnostic = { version: 1, stage: 'snapshot_query', kind: 'timeout', status: null, signal: 'SIGKILL',
      spawn_code: 'ETIMEDOUT', sqlite_kind: 'unknown', elapsed_ms: 4000, timeout_ms: 4000,
      max_buffer_bytes: 50 * 1024 * 1024, stdout_bytes: 1000, stderr_bytes: 0 };
    const result = f.run({ readRows() { throw new SqliteReadError('read_timeout', 'authored private error', diagnostic); } });
    assert.equal(result.reason, 'observation_failed'); assert.equal(result.finish_state, 'confirmed');
    assert.equal(result.scanned, 30); assert.equal(result.observed, 0); assert.equal(result.deferred, 30);
    assert.deepEqual(result.diagnostic.read, diagnostic); assert.doesNotMatch(JSON.stringify(result), /authored private error/);
    assert.equal(scan(f).tail_after_id, 1); assert.equal(scan(f).history_after_id, 1); assert.equal(ledger(f).length, 0);
    later(f, 5); assert.equal(ledger(f).length, 35);
    assert(ledger(f).every(row => row.first_observed_at_ms > NOW));
    assert(ledger(f).every(row => row.first_ready_observed_at_ms === null || row.first_ready_observed_at_ms > NOW));
  });

  test('scan CAS rejection cannot save candidate prefix progress or observations', t => {
    const f = fixture(t); seed(f); const base = driver(f.db, f.now);
    const result = f.run({ commit(updates, reason) {
      if (reason.endsWith('_finish')) sqliteExec(f.db, 'UPDATE lark_im_message_readiness_scan SET generation=generation+1;');
      return base.commit(updates, reason);
    } });
    assert.equal(result.reason, 'observation_failed'); assert.equal(result.finish_state, 'unknown');
    assert.equal(result.observed, 0); assert.equal(ledger(f).length, 0);
    assert.equal(scan(f).tail_after_id, 1); assert.equal(scan(f).history_after_id, 0);
    later(f, 3); assert.equal(ledger(f).length, 35);
  });

  test('selected source-CAS conflict remains deferred and only a later actual reading establishes an observation', t => {
    const f = fixture(t); seed(f); const base = driver(f.db, f.now);
    const result = f.run({ commit(updates, reason) {
      if (reason.endsWith('_finish')) sqliteExec(f.db, "UPDATE records SET external_version='2' WHERE id=1;");
      return base.commit(updates, reason);
    } });
    assert.equal(result.reason, 'observed'); assert.equal(result.observed, 1); assert.equal(result.deferred, 29);
    assert(!ledger(f).some(row => row.record_id === 1)); assert.equal(scan(f).history_after_id, 1);
    later(f, 3); const row = ledger(f).find(row => row.record_id === 1);
    assert.equal(row.first_observed_at_ms, NOW + 180000); assert.equal(row.source_epoch, 1);
    assert.equal(row.state, 'blocked'); assert.equal(row.first_ready_observed_at_ms, null);
    assert.equal(f.query('SELECT external_version FROM records WHERE id=1;')[0].external_version, '2');
  });
}
