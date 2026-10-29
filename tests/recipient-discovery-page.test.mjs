import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { REVIEW_RECORD_COLUMNS } from '../dist/storage/sqlite/ingestion-store.js';
import { nameRowBytesSql } from '../src/adapters/lark-im/name-work-common.mjs';
import { readRecipientWitnessPage } from '../src/adapters/lark-im/recipient-discovery-page.mjs';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';

const CAP = 2 * 1024 * 1024;
const q = value => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const options = { where: '', order: 'ASC', limit: 40, index: 'records_recipient_sent_id', batchBytes: CAP };
function fileHash(path) {
  const fd = openSync(path, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  try { for (;;) { const n = readSync(fd, buffer); if (!n) break; hash.update(buffer.subarray(0, n)); } }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
function fixture(t, inputs) {
  const dir = mkdtempSync(join(tmpdir(), 'recipient-page-synthetic-')), db = join(dir, 'synthetic.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const exec = sql => {
    const result = spawnSync('sqlite3', [db], { input: `.bail on\n${sql}`, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || 'synthetic SQLite write failed');
  };
  exec(`CREATE TABLE records(${REVIEW_RECORD_COLUMNS.map(column => column === 'id' ? 'id INTEGER PRIMARY KEY'
    : `${column} ${column === 'occurred_at_ms' ? 'INTEGER' : 'TEXT'}`).join(',')});
    CREATE INDEX records_recipient_sent_id ON records(source_id,id)
      WHERE direction='sent' AND record_type='lark.im.message';
    CREATE INDEX records_recipient_sent_container_id ON records(source_id,container_id,id)
      WHERE direction='sent' AND record_type='lark.im.message';
    ${inputs.map(input => {
      const id = input.id, row = { ...Object.fromEntries(REVIEW_RECORD_COLUMNS.map(column => [column, null])),
        id, source_id: 'lark.im', first_seen_scope_id: 'lark.im.sent_by_me', external_id: `om_invented_page_${id}`,
        external_version: '1', record_type: 'lark.im.message', occurred_at: '2030-01-01T00:00:00.000Z',
        occurred_at_ms: 1893456000000, received_at: '2030-01-01T00:00:01.000Z', actor_id: 'ou_invented_page_self',
        container_id: input.container || 'oc_invented_page_a', direction: input.direction || 'sent', body: input.body ?? 'Invented  body\n精确保留',
        content_hash: 'synthetic-hash', canonical_json: '{"invented":true,"decimal":0.50}',
        raw_json: '{"invented":true,"literal":"\\u0061"}', created_at: '2030-01-01T00:00:01.000Z', updated_at: '2030-01-01T00:00:01.000Z' };
      return `INSERT INTO records(${REVIEW_RECORD_COLUMNS.join(',')}) VALUES(${REVIEW_RECORD_COLUMNS.map(column => q(row[column])).join(',')});`
        + (input.bodyBytes ? `UPDATE records SET body=printf('%.*c',${input.bodyBytes},'x') WHERE id=${id};` : '');
    }).join('\n')}`);
  const calls = [];
  let beforePayload;
  const query = (sql, label) => {
    if (label === 'read bounded recipient witness payloads' && beforePayload) {
      const action = beforePayload; beforePayload = undefined; action();
    }
    return readOnlySqliteJson(db, sql, label, { timeoutMs: 10000, spawnSync(command, args, settings) {
      const result = spawnSync(command, args, settings);
      calls.push({ label, outputBytes: Buffer.byteLength(String(result.stdout || '')), status: result.status,
        rows: result.status === 0 ? JSON.parse(String(result.stdout || '[]')).length : 0 });
      return result;
    } });
  };
  const inspect = sql => readOnlySqliteJson(db, sql, 'inspect synthetic fixture');
  return { db, exec, query, calls, inspect, changeBeforePayload: action => { beforePayload = action; } };
}
const bytes = f => f.inspect(`SELECT id,(${nameRowBytesSql()}) AS bytes FROM records ORDER BY id;`);
const all = f => f.inspect(`SELECT ${REVIEW_RECORD_COLUMNS.join(',')} FROM records ORDER BY id;`);

test('real SQLite returns exact complete rows in both orders and never mutates the source', t => {
  const f = fixture(t, [{ id: 1 }, { id: 2, body: 'Keep "quotes", tabs\tand Unicode 雪.' }, { id: 3, direction: 'received' }]);
  const before = fileHash(f.db), expected = all(f).slice(0, 2);
  const asc = readRecipientWitnessPage(f.query, options);
  assert.deepEqual(asc.rows, expected); assert.equal(asc.afterRecordId, 2); assert.equal(asc.hasMore, false);
  assert.equal(asc.bytesRead, bytes(f).slice(0, 2).reduce((n, row) => n + row.bytes, 0));
  const desc = readRecipientWitnessPage(f.query, { ...options, order: 'DESC', limit: 1 });
  assert.deepEqual(desc.rows, expected.slice(1)); assert.equal(desc.afterRecordId, 2); assert.equal(desc.hasMore, true);
  const next = readRecipientWitnessPage(f.query, { ...options, order: 'DESC', after: desc.afterRecordId });
  assert.deepEqual(next.rows, expected.slice(0, 1)); assert.equal(next.afterRecordId, 1); assert.equal(next.hasMore, false);
  assert.equal(fileHash(f.db), before);
});

test('forty-one oversized sent rows cannot hide the normal tail or materialize their payloads', t => {
  const f = fixture(t, [...Array.from({ length: 41 }, (_, i) => ({ id: i + 1, bodyBytes: CAP + 1 })), { id: 42 }]);
  const before = fileHash(f.db);
  const first = readRecipientWitnessPage(f.query, options);
  assert.deepEqual(first, { rows: [], afterRecordId: 40, hasMore: true, capacityDeferred: 40, bytesRead: 0, exhaustedBudget: false });
  const second = readRecipientWitnessPage(f.query, { ...options, after: first.afterRecordId });
  assert.deepEqual(second.rows.map(row => row.id), [42]); assert.equal(second.capacityDeferred, 1);
  assert.equal(second.afterRecordId, 42); assert.equal(second.hasMore, false); assert.equal(second.exhaustedBudget, false);
  assert(f.calls.every(call => call.status === 0 && call.outputBytes < 32 * 1024), 'actual SQLite output excludes the >82 MiB payload population');
  assert(f.calls.filter(call => call.label.endsWith('headers')).every(call => call.rows <= 41));
  assert.equal(fileHash(f.db), before);
});

test('DESC skips oversized head and tail, retains the ordinary neighbour, and respects the container index', t => {
  const f = fixture(t, [{ id: 1, bodyBytes: CAP + 1 }, { id: 2 }, { id: 3, bodyBytes: CAP + 1 }, { id: 4, container: 'oc_invented_page_other' }]);
  const expected = all(f).find(row => row.id === 2), before = fileHash(f.db);
  const page = readRecipientWitnessPage(f.query, { ...options, where: `AND container_id=${q('oc_invented_page_a')}`,
    order: 'DESC', limit: 8, index: 'records_recipient_sent_container_id' });
  assert.deepEqual(page.rows, [expected]); assert.equal(page.capacityDeferred, 2); assert.equal(page.afterRecordId, 1);
  assert.equal(page.hasMore, false); assert.equal(page.exhaustedBudget, false); assert.equal(fileHash(f.db), before);
});

test('cumulative budget never advances over or leapfrogs the first ordinary row that does not fit', t => {
  const f = fixture(t, [{ id: 1, bodyBytes: 900 }, { id: 2, bodyBytes: 900 }, { id: 3, body: 'tiny' }]);
  const sizes = bytes(f), expected = all(f), before = fileHash(f.db), budget = sizes[0].bytes + sizes[1].bytes - 1;
  const first = readRecipientWitnessPage(f.query, { ...options, batchBytes: budget });
  assert.deepEqual(first.rows, expected.slice(0, 1)); assert.equal(first.bytesRead, sizes[0].bytes);
  assert.equal(first.afterRecordId, 1); assert.equal(first.hasMore, true); assert.equal(first.exhaustedBudget, true);
  const second = readRecipientWitnessPage(f.query, { ...options, after: first.afterRecordId });
  assert.deepEqual(second.rows, expected.slice(1)); assert.equal(second.afterRecordId, 3); assert.equal(second.exhaustedBudget, false);
  assert.equal(fileHash(f.db), before);
});

test('empty headers, zero budget, and an oversized-only page have distinct progress outcomes', t => {
  const f = fixture(t, [{ id: 1, bodyBytes: CAP + 1 }, { id: 2 }]);
  const blocked = readRecipientWitnessPage(f.query, { ...options, batchBytes: 0 });
  assert.deepEqual(blocked, { rows: [], afterRecordId: 1, hasMore: true, capacityDeferred: 1, bytesRead: 0, exhaustedBudget: true });
  const empty = readRecipientWitnessPage(f.query, { ...options, after: 2, batchBytes: 0 });
  assert.deepEqual(empty, { rows: [], afterRecordId: 2, hasMore: false, capacityDeferred: 0, bytesRead: 0, exhaustedBudget: false });
});

test('payload snapshot rechecks a formerly ordinary row that concurrently grows over the individual cap', t => {
  const f = fixture(t, [{ id: 1 }, { id: 2 }]), neighbour = all(f)[1];
  f.changeBeforePayload(() => f.exec(`UPDATE records SET body=printf('%.*c',${CAP + 1},'x') WHERE id=1;`));
  const page = readRecipientWitnessPage(f.query, options);
  assert.deepEqual(page.rows, [neighbour]); assert.equal(page.afterRecordId, 2); assert.equal(page.capacityDeferred, 1);
  assert.equal(page.hasMore, false); assert.equal(page.exhaustedBudget, false);
  assert(f.calls.every(call => call.outputBytes < 8192), 'concurrently enlarged payload never crosses the SQLite child boundary');
  assert.deepEqual(all(f)[1], neighbour);
});

test('concurrent growth within the per-row cap cannot skip a newly budget-blocked row', t => {
  const f = fixture(t, [{ id: 1, bodyBytes: 300 }, { id: 2, bodyBytes: 300 }, { id: 3, body: 'tiny' }]);
  const sizes = bytes(f), before = all(f), budget = sizes.reduce((n, row) => n + row.bytes, 0);
  f.changeBeforePayload(() => f.exec(`UPDATE records SET body=printf('%.*c',${budget},'y') WHERE id=2;`));
  const page = readRecipientWitnessPage(f.query, { ...options, batchBytes: budget });
  assert.deepEqual(page.rows, before.slice(0, 1)); assert.equal(page.afterRecordId, 1);
  assert.equal(page.exhaustedBudget, true); assert.equal(page.hasMore, true); assert.equal(page.capacityDeferred, 0);
  const next = readRecipientWitnessPage(f.query, { ...options, after: page.afterRecordId });
  assert.deepEqual(next.rows.map(row => row.id), [2, 3]); assert.deepEqual(next.rows[1], before[2]);
  assert.equal(next.exhaustedBudget, false); assert(next.bytesRead <= CAP);
});

test('deleted or no-longer-sent headers advance without inventing a payload or changing the surviving neighbour', t => {
  const f = fixture(t, [{ id: 1 }, { id: 2 }, { id: 3 }]), neighbour = all(f)[2];
  f.changeBeforePayload(() => f.exec("DELETE FROM records WHERE id=1; UPDATE records SET direction='received' WHERE id=2;"));
  const page = readRecipientWitnessPage(f.query, options);
  assert.deepEqual(page.rows, [neighbour]); assert.equal(page.afterRecordId, 3);
  assert.equal(page.capacityDeferred, 0); assert.equal(page.hasMore, false); assert.equal(page.exhaustedBudget, false);
  assert.equal(page.bytesRead, bytes(f).find(row => row.id === 3).bytes);
  assert.deepEqual(all(f).find(row => row.id === 3), neighbour);
});

test('the exact two-MiB source-byte boundary is inclusive and measured at payload acquisition', t => {
  const f = fixture(t, [{ id: 1, body: '' }]), overhead = bytes(f)[0].bytes;
  f.exec(`UPDATE records SET body=printf('%.*c',${CAP - overhead},'x') WHERE id=1;`);
  const page = readRecipientWitnessPage(f.query, options);
  assert.equal(page.rows.length, 1); assert.equal(page.bytesRead, CAP); assert.equal(page.capacityDeferred, 0);
  assert(f.calls.find(call => call.label.endsWith('payloads')).outputBytes < CAP + 4096);
  f.exec("UPDATE records SET body=body||'x' WHERE id=1;");
  const over = readRecipientWitnessPage(f.query, options);
  assert.deepEqual(over.rows, []); assert.equal(over.capacityDeferred, 1); assert.equal(over.bytesRead, 0);
});

test('invalid internal bounds are rejected before any query', () => {
  for (const patch of [{ batchBytes: CAP + 1 }, { batchBytes: -1 }, { after: -1 }, { order: 'sideways' }, { limit: 41 }, { index: 'arbitrary' }]) {
    assert.throws(() => readRecipientWitnessPage(() => { throw new Error('query must not run'); }, { ...options, ...patch }), /invalid recipient discovery page/);
  }
});
