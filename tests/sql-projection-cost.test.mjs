import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureInitialized, quoteSql, sqliteExec, sqliteQuery, upsertRecordsSql, boundedReplayProjectionSql }
  from '../dist/storage/sqlite/ingestion-store.js';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { bindAcquiredMessageAccounts } from '../src/adapters/lark-im/message-account-evidence.mjs';

// Entirely authored synthetic input. These are structural regression limits,
// not elapsed-time SLOs. Count every compiled statement, including trigger
// subprograms, setup, identity/observation guards, effects and commit. A single
// ordinary upsert formerly compiled >4.2 million instructions; the phase repair
// is approximately 127,000. Calibration on SQLite 3.51.0, this exact fresh
// fixture, foreign keys enabled, and the same schema: 5631504 = 78,148;
// repair = 126,930. Its 231,000 total budget is below 3 * 78,148 (234,444), independently of
// the different external microbenchmark fixture. Batch/review get bounded linear input
// overhead; direct upsert intentionally contains one record DML per input.
const FIXED_BUDGET = 230_000;
const ROW_OVERHEAD = 1_000;
const STATEMENT_PREPARE_LIMIT = 500_000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const AT = Date.parse('2025-02-03T04:05:00.000Z');
const SCOPE = 'lark.im.sent_by_me';
const ROOM = 'oc_synthetic_cost_room';
const SELF = { open_id: 'ou_synthetic_cost_self' };
const hash = value => createHash('sha256').update(value).digest('hex');
const repo = fileURLToPath(new URL('..', import.meta.url));

// complete_statement understands quotes/comments/triggers; testing at every
// semicolon also handles multiple statements on the same line. There is no
// fetchall/list(EXPLAIN), JSON bytecode dump, SQL slicing or executescript.
// Passing requires all input consumed. Failure closes the connection before
// the over-budget statement is executed. Python 3.11+ can additionally bound
// VDBE allocation during prepare; older supported Python still streams rows.
const PROFILER = String.raw`
import json, sys, time
wall_start, cpu_start = time.perf_counter(), time.process_time()
trace_count = 0
def trace(phase, **fields):
    global trace_count
    # Bound diagnostics independently of SQL/result/opcode budgets. Never emit SQL.
    if trace_count >= 512:
        return
    trace_count += 1
    print(json.dumps(dict(phase=phase, wall_ms=round((time.perf_counter()-wall_start)*1000, 6),
                          cpu_ms=round((time.process_time()-cpu_start)*1000, 6), **fields),
                     separators=(',', ':')), file=sys.stderr, flush=True)
trace('startup')
trace('hashlib_import_start')
import hashlib
trace('hashlib_import_done')
trace('sqlite_import_start')
import sqlite3
trace('sqlite_import_done')
trace('path_import_start')
from pathlib import Path
trace('path_import_done')
class ObservedInput:
    def read(self, *args, **kwargs):
        trace('stdin_read_start')
        # Diagnostic-only, same bytes and EOF requirement. Do not emit input.
        if args or kwargs:
            raise RuntimeError('diagnostic reader expects the existing read-all call')
        chunks, total, index = [], 0, 0
        while True:
            chunk = sys.stdin.buffer.read1(65536)
            total += len(chunk)
            # First chunks, logarithmic milestones and EOF keep input tracing
            # bounded without consuming all 512 phase slots before SQL begins.
            if index < 8 or (index & (index-1)) == 0 or not chunk:
                trace('stdin_chunk', index=index, bytes=len(chunk), total_bytes=total, eof=not bool(chunk))
            index += 1
            if not chunk:
                break
            chunks.append(chunk)
        value = b''.join(chunks).decode('utf-8')
        trace('stdin_read_done', characters=len(value), bytes=total)
        return value
trace('json_load_start')
p = json.load(ObservedInput())
trace('json_load_done')
trace('input_read', sqlite_version=sqlite3.sqlite_version)
sql = p['sql']
report = {'complete': False, 'statements': [], 'opcodes': 0, 'rows': [],
          'sqlite_version': sqlite3.sqlite_version, 'sql_bytes': len(sql.encode()),
          'sql_sha256': hashlib.sha256(sql.encode()).hexdigest(), 'consumed_bytes': 0}
conn = None
try:
    uri = Path(p['db']).resolve().as_uri() + ('?mode=ro' if p.get('readonly') else '?mode=rw')
    trace('connect_start')
    conn = sqlite3.connect(uri, uri=True, isolation_level=None, cached_statements=0)
    trace('connect_done')
    report['sqlite_source_id'] = conn.execute('SELECT sqlite_source_id()').fetchone()[0]
    if p.get('readonly'):
        conn.execute('PRAGMA query_only=ON')
    if hasattr(conn, 'setlimit') and hasattr(sqlite3, 'SQLITE_LIMIT_VDBE_OP'):
        conn.setlimit(sqlite3.SQLITE_LIMIT_VDBE_OP, p['prepare_limit'])
        report['prepare_limit_applied'] = True
    else:
        report['prepare_limit_applied'] = False
    start = 0
    for end, char in enumerate(sql, 1):
        if char != ';' or not sqlite3.complete_statement(sql[start:end]):
            continue
        statement = sql[start:end]
        count = 0
        index = len(report['statements'])
        trace('prepare_start', statement=index, opcodes=report['opcodes'])
        explain = conn.execute('EXPLAIN ' + statement)
        trace('prepare_done', statement=index, opcodes=report['opcodes'])
        try:
            for unused in explain:
                count += 1
                report['opcodes'] += 1
                if report['opcodes'] > p['budget']:
                    raise RuntimeError('opcode_budget_exceeded')
        finally:
            explain.close()
        trace('explain_done', statement=index, statement_opcodes=count, opcodes=report['opcodes'])
        report['statements'].append({'opcodes': count, 'bytes': len(statement.encode()),
                                     'sha256': hashlib.sha256(statement.encode()).hexdigest()})
        trace('step_start', statement=index, opcodes=report['opcodes'])
        actual = conn.execute(statement)
        try:
            if actual.description:
                names = [column[0] for column in actual.description]
                for row in actual:
                    if len(report['rows']) >= 200:
                        raise RuntimeError('result_row_capacity_exceeded')
                    report['rows'].append(dict(zip(names, row)))
        finally:
            actual.close()
        trace('step_done', statement=index, opcodes=report['opcodes'])
        start = end
        report['consumed_bytes'] = len(sql[:end].encode())
    # Generated programs end in a semicolon. Reject any unmeasured remainder,
    # including a newly appended statement lacking its final semicolon.
    if sql[start:].strip():
        raise RuntimeError('unconsumed_sql_tail')
    report['consumed_bytes'] = len(sql.encode())
    report['complete'] = True
except Exception as error:
    # No SQL, fixture payload or huge EXPLAIN rows enter test diagnostics.
    trace('failure', kind=type(error).__name__, statement=len(report['statements']), opcodes=report['opcodes'])
    report['failure'] = type(error).__name__
    if str(error) in ('opcode_budget_exceeded', 'unconsumed_sql_tail', 'result_row_capacity_exceeded'):
        report['failure'] = str(error)
finally:
    if conn is not None:
        trace('close_start', opcodes=report['opcodes'])
        conn.close()
        trace('close_done', opcodes=report['opcodes'])
trace('exit', complete=report['complete'], statements=len(report['statements']), opcodes=report['opcodes'])
print(json.dumps(report, separators=(',', ':')))
`;

// Intercept the actual storage executor only inside this disposable child.
// SQL is executed, not mocked: prepareObservationRecords reads and the complete
// succeedRecordRun transaction each go through EXPLAIN + actual sqlite3 steps.
// createRun is prerequisite fixture setup, outside the measured operation.
const RUN_DRIVER = String.raw`
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
const p = JSON.parse(readFileSync(0, 'utf8'));
const spawn = cp.spawnSync;
let measuring = false;
const reports = [];
cp.spawnSync = (command, args, options) => {
  if (!measuring || command !== 'sqlite3') return spawn(command, args, options);
  const prefix = '.bail on\n.timeout 5000\n';
  if (!options.input.startsWith(prefix)) throw new Error('unexpected sqlite executor prologue');
  const result = spawn('python3', [p.profiler], { input: JSON.stringify({
    db: args.at(-1), sql: options.input.slice(prefix.length),
    readonly: args.includes('-readonly'), prepare_limit: p.prepare_limit,
    budget: p.budget - reports.reduce((n, r) => n + r.opcodes, 0),
  }), encoding: 'utf8', maxBuffer: p.output_limit, timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error('cost profiler failed: ' + JSON.stringify({
    status: result.status, signal: result.signal, error_code: result.error?.code, stderr: result.stderr,
  }));
  const report = JSON.parse(result.stdout);
  reports.push(report);
  if (!report.complete) throw new Error('SQL structural budget or complete-consumption failure: ' + report.failure);
  return { status: 0, signal: null, error: undefined, stdout: JSON.stringify(report.rows), stderr: '' };
};
syncBuiltinESMExports();
try {
  const store = await import(p.store);
  const scope = store.readScope(p.db, p.scope);
  const run = store.createRun(p.db, scope, { synthetic_cost_gate: true });
  measuring = true;
  const effects = store.succeedRecordRun(p.db, scope, run, p.records, p.records.length,
    { kind: 'synthetic.cost.cursor/v1', occurred_at_ms: p.at }, {});
  process.stdout.write(JSON.stringify({ effects, reports }));
} catch (error) {
  process.stdout.write(JSON.stringify({ failure: error.message, reports }));
  process.exitCode = 1;
}
`;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'exocortex-sql-cost-synthetic-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite');
  ensureInitialized(db);
  const profiler = join(directory, 'explain-cost.py');
  writeFileSync(profiler, PROFILER);
  return { db, profiler };
}

function record(index, { revision = 1, proof = false } = {}) {
  const raw = { message_id: `om_synthetic_cost_${index}`, chat_id: ROOM, chat_type: 'group', msg_type: 'text',
    create_time: String(AT), update_time: String(AT + revision),
    sender: { id: SELF.open_id, id_type: 'open_id', sender_type: 'user', name: 'Invented Cost Author' },
    body: { content: JSON.stringify({ text: `Invented cost record ${index}; version ${revision}. 树` }) } };
  const value = recordFromMessage(normalizeApiMessage(raw), SCOPE, 'sent', {}, { chat_id: ROOM, chat_type: 'group' });
  return proof ? bindAcquiredMessageAccounts([value], SELF, { acquiredAt: '2025-02-03T04:06:00.123Z' })[0] : value;
}

// Seed fixture facts without invoking the projection under measurement. Real
// schema constraints, indexes and observation triggers remain installed.
function seed(db, records) {
  if (!records.length) return;
  sqliteExec(db, `BEGIN; ${records.map(value => {
    const keys = Object.keys(value);
    return `INSERT INTO records(${keys.join(',')},updated_at) VALUES(${keys.map(key => quoteSql(value[key])).join(',')},'2025-02-03T04:07:00.000Z');`;
  }).join('\n')} COMMIT;`, 'seed entirely synthetic structural fixture');
}

// Overrides are only for authored boundary controls below; original callers use defaults.
function profile(f, sql, { budget = FIXED_BUDGET + ROW_OVERHEAD, readonly = false } = {},
  { run = spawnSync, command = 'python3', observe = event => process.stderr.write(JSON.stringify(event) + '\n') } = {}) {
  const serializationStart = performance.now();
  const input = JSON.stringify({ db: f.db, sql, budget, readonly, prepare_limit: STATEMENT_PREPARE_LIMIT });
  const serializationEnd = performance.now();
  const inputBytes = Buffer.byteLength(input), inputSha256 = hash(input);
  const beforeSpawnObservation = performance.now();
  observe({ profile: 'bounded_sql_parent_observation', phase: 'before_spawn',
    parent_monotonic_ms: beforeSpawnObservation, input_bytes: inputBytes, input_sha256: inputSha256,
    sql_bytes: Buffer.byteLength(sql), sql_sha256: hash(sql), timeout_ms: 30_000,
    max_buffer_bytes: OUTPUT_LIMIT });
  const spawnStart = performance.now();
  let result;
  try {
    result = run(command, [f.profiler], {
      input, encoding: 'utf8', maxBuffer: OUTPUT_LIMIT, timeout: 30_000,
    });
  } catch (error) {
    const spawnEnd = performance.now();
    try {
      observe({ profile: 'bounded_sql_parent_observation', phase: 'spawn_throw',
      spawn_start_monotonic_ms: spawnStart, spawn_return_monotonic_ms: spawnEnd,
      spawn_elapsed_ms: spawnEnd - spawnStart, observer_elapsed_ms: spawnEnd - serializationStart,
      serialization_ms: serializationEnd - serializationStart, parent_prepare_ms: spawnStart - serializationEnd,
      input_bytes: inputBytes, input_sha256: inputSha256, sql_bytes: Buffer.byteLength(sql),
      sql_sha256: hash(sql), timeout_ms: 30_000, max_buffer_bytes: OUTPUT_LIMIT,
      error_code: typeof error?.code === 'string' ? error.code : null,
      status: null, signal: null, stdout_bytes: null, stderr_bytes: null,
      execution_state: 'unknown' });
    } catch { /* An observation failure must not replace the original thrown value. */ }
    throw error;
  }
  const spawnEnd = performance.now();
  let observationFailed = false, observationError;
  try {
    observe({ profile: 'bounded_sql_parent_observation', phase: 'after_spawn',
    spawn_start_monotonic_ms: spawnStart, spawn_return_monotonic_ms: spawnEnd,
    serialization_ms: serializationEnd - serializationStart,
    parent_prepare_ms: spawnStart - serializationEnd,
    spawn_elapsed_ms: spawnEnd - spawnStart,
    observer_elapsed_ms: spawnEnd - serializationStart,
    input_bytes: inputBytes, input_sha256: inputSha256, sql_bytes: Buffer.byteLength(sql),
    sql_sha256: hash(sql), timeout_ms: 30_000, max_buffer_bytes: OUTPUT_LIMIT,
    status: result.status, signal: result.signal, error_code: result.error?.code,
    stdout_bytes: typeof result.stdout === 'string' ? Buffer.byteLength(result.stdout) : Buffer.isBuffer(result.stdout) ? result.stdout.length : null,
    stderr_bytes: typeof result.stderr === 'string' ? Buffer.byteLength(result.stderr) : Buffer.isBuffer(result.stderr) ? result.stderr.length : null,
    trace: result.stderr });
  } catch (error) { observationFailed = true; observationError = error; }
  assert.equal(result.error, undefined, 'the bounded profiler must not overflow stdout or fail to launch: ' + JSON.stringify({
    status: result.status, signal: result.signal, error_code: result.error?.code, stderr: result.stderr,
  }));
  assert.equal(result.status, 0, JSON.stringify({
    status: result.status, signal: result.signal, error_code: result.error?.code, stderr: result.stderr,
  }));
  const report = JSON.parse(result.stdout);
  if (observationFailed) throw observationError;
  return report;
}

function complete(report, label, budget) {
  assert.equal(report.complete, true, `${label}: ${report.failure || 'unconsumed SQL'}`);
  assert.equal(report.consumed_bytes, report.sql_bytes, `${label}: every input byte must be consumed`);
  assert.ok(report.statements.length > 0, `${label}: no stripped/empty program`);
  assert.equal(report.opcodes, report.statements.reduce((n, item) => n + item.opcodes, 0));
  assert.ok(report.opcodes <= budget, `${label}: ${report.opcodes} opcodes exceed ${budget}`);
}

function summary(t, label, reports) {
  t.diagnostic(JSON.stringify({ entry: label, sqlite: reports[0].sqlite_version,
    statements: reports.reduce((n, value) => n + value.statements.length, 0),
    opcodes: reports.reduce((n, value) => n + value.opcodes, 0),
    sql_bytes: reports.reduce((n, value) => n + value.sql_bytes, 0),
    sql_sha256: reports.map(value => value.sql_sha256) }));
}

function measuredRun(f, records, budget) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', RUN_DRIVER], {
    cwd: repo, input: JSON.stringify({ ...f, records, budget, scope: SCOPE, at: AT,
      store: new URL('../dist/storage/sqlite/ingestion-store.js', import.meta.url).href,
      prepare_limit: STATEMENT_PREPARE_LIMIT, output_limit: OUTPUT_LIMIT }),
    encoding: 'utf8', maxBuffer: OUTPUT_LIMIT, timeout: 90_000,
  });
  assert.equal(result.error, undefined, 'the profiler cannot silently overflow or skip: ' + JSON.stringify({
    status: result.status, signal: result.signal, error_code: result.error?.code, stderr: result.stderr,
  }));
  const value = result.stdout ? JSON.parse(result.stdout) : {};
  assert.equal(result.status, 0, JSON.stringify({ failure: value.failure || result.stderr,
    reports: value.reports?.map(report => ({ complete: report.complete, failure: report.failure, opcodes: report.opcodes })) }));
  assert.ok(value.reports.length >= 1);
  for (const report of value.reports) complete(report, 'succeedRecordRun complete SQL', budget);
  assert.ok(value.reports.reduce((n, report) => n + report.opcodes, 0) <= budget);
  return value;
}

test('structural harness consumes every statement and trigger subprogram, and fails closed at its budget/tail', t => {
  const f = fixture(t);
  const sql = `BEGIN; CREATE TEMP TABLE cost_guard(value TEXT); CREATE TEMP TABLE cost_audit(value TEXT);
    CREATE TEMP TRIGGER cost_trigger AFTER INSERT ON cost_guard BEGIN
      INSERT INTO cost_audit VALUES('embedded; delimiter'); UPDATE cost_audit SET value=value||';suffix'; END;
    INSERT INTO cost_guard VALUES('a;''quoted'); SELECT COUNT(*) AS n FROM cost_audit; COMMIT;`;
  const measured = profile(f, sql, { budget: 1000 });
  complete(measured, 'harness control', 1000);
  assert.equal(measured.statements.length, 7);
  assert.deepEqual(measured.rows, [{ n: 1 }]);
  assert.ok(measured.statements[4].opcodes > 20, 'the trigger program is included in the INSERT bytecode');
  const failed = profile(f, sql, { budget: 20 });
  assert.equal(failed.complete, false);
  assert.equal(failed.failure, 'opcode_budget_exceeded');
  assert.equal(failed.opcodes, 21, 'enumeration stops immediately after the first over-budget opcode');
  assert.ok(failed.consumed_bytes < failed.sql_bytes);
  const tail = profile(f, 'SELECT 1 AS n; SELECT 2 AS n', { budget: 100 });
  assert.equal(tail.complete, false);
  assert.equal(tail.failure, 'unconsumed_sql_tail');
  assert.deepEqual(tail.rows, [{ n: 1 }]);
});

for (const scenario of ['fresh', 'no-op', 'newer', 'missing-proof']) {
  test(`complete direct upsert has bounded compiled cost: ${scenario}`, t => {
    const f = fixture(t), old = record(0, { proof: scenario === 'missing-proof' });
    if (scenario !== 'fresh') seed(f.db, [old]);
    const incoming = scenario === 'newer' ? record(0, { revision: 2 }) : record(0);
    const before = sqliteQuery(f.db, 'SELECT * FROM records;');
    const sql = `PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; ${upsertRecordsSql([incoming], { dbPath: f.db })} SELECT changes() AS n; COMMIT;`;
    const report = profile(f, sql);
    complete(report, scenario, FIXED_BUDGET + ROW_OVERHEAD);
    assert.deepEqual(report.rows, [{ n: ['fresh', 'newer'].includes(scenario) ? 1 : 0 }]);
    const after = sqliteQuery(f.db, 'SELECT * FROM records;');
    assert.equal(after.length, 1);
    if (['no-op', 'missing-proof'].includes(scenario)) assert.deepEqual(after, before);
    else assert.equal(after[0].canonical_json, incoming.canonical_json);
    summary(t, `upsert:${scenario}`, [report]);
  });
}

test('complete direct two-record operation counts both DML programs', t => {
  const f = fixture(t), records = [record(0), record(1)];
  const budget = 2 * (FIXED_BUDGET + ROW_OVERHEAD);
  const report = profile(f, `PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; ${upsertRecordsSql(records)} COMMIT;`, { budget });
  complete(report, 'two direct upserts', budget);
  assert.equal(sqliteQuery(f.db, 'SELECT COUNT(*) AS n FROM records;')[0].n, 2);
  assert.ok(report.statements.length >= 5, 'both identity guards and the complete record operation are measured');
  summary(t, 'upsert:2', [report]);
});

test('actual succeedRecordRun measures preparation and the complete fenced transaction with bounded batch growth', t => {
  const costs = [];
  for (const n of [1, 12, 100]) {
    const f = fixture(t), records = Array.from({ length: n }, (_, index) => record(index));
    const budget = FIXED_BUDGET + ROW_OVERHEAD * n;
    const value = measuredRun(f, records, budget);
    assert.deepEqual(value.effects, { inserted: n, updated: 0, duplicate: 0 });
    const run = sqliteQuery(f.db, 'SELECT status,inserted_count FROM sync_runs;')[0];
    assert.deepEqual(run, { status: 'succeeded', inserted_count: n });
    assert.equal(sqliteQuery(f.db, 'SELECT COUNT(*) AS n FROM records;')[0].n, n);
    assert.equal(sqliteQuery(f.db, 'SELECT COUNT(*) AS n FROM sync_locks;')[0].n, 0);
    const opcodes = value.reports.reduce((sum, report) => sum + report.opcodes, 0);
    costs.push(opcodes);
    summary(t, `succeedRecordRun:${n}`, value.reports);
  }
  assert.ok(costs[1] <= costs[0] + ROW_OVERHEAD * 11, '12 inputs cannot replicate the fixed projection graph');
  assert.ok(costs[2] <= costs[1] + ROW_OVERHEAD * 88, '100 inputs keep bounded per-row structure');
});

test('actual succeedRecordRun no-op retains proof bytes and counts effects at bounded cost', t => {
  const f = fixture(t), old = record(0, { proof: true });
  seed(f.db, [old]);
  const before = sqliteQuery(f.db, 'SELECT * FROM records;');
  const value = measuredRun(f, [record(0)], FIXED_BUDGET + ROW_OVERHEAD);
  assert.deepEqual(value.effects, { inserted: 0, updated: 0, duplicate: 1 });
  assert.deepEqual(sqliteQuery(f.db, 'SELECT * FROM records;'), before);
  summary(t, 'succeedRecordRun:proof-noop', value.reports);
});

test('read-only bounded replay measures its complete program and preserves the database through 100 targets', t => {
  const costs = [];
  for (const n of [1, 12, 100]) {
    const f = fixture(t), records = Array.from({ length: n }, (_, index) => record(index));
    seed(f.db, records);
    const before = hash(readFileSync(f.db));
    const budget = FIXED_BUDGET + ROW_OVERHEAD * n;
    const report = profile(f, `PRAGMA query_only=ON; BEGIN; ${boundedReplayProjectionSql(records, { dbPath: f.db })} COMMIT;`,
      { budget, readonly: true });
    complete(report, `readonly replay:${n}`, budget);
    assert.equal(report.rows.length, n);
    assert.ok(report.rows.every(row => row.outcome === 'duplicate'));
    assert.equal(hash(readFileSync(f.db)), before, 'readonly EXPLAIN and execution cannot alter fixture bytes');
    costs.push(report.opcodes);
    summary(t, `boundedReplayProjectionSql:${n}`, [report]);
  }
  assert.ok(costs[1] <= costs[0] + ROW_OVERHEAD * 11);
  assert.ok(costs[2] <= costs[1] + ROW_OVERHEAD * 88);
});

// These controls use newly authored inputs. They verify evidence and rejection,
// not the cause of the earlier full-suite startup-only timeout.
const controlSql = 'BEGIN; SELECT 1 AS invented; COMMIT;';
const controlInput = f => JSON.stringify({ db: f.db, sql: controlSql, budget: FIXED_BUDGET + ROW_OVERHEAD,
  readonly: true, prepare_limit: STATEMENT_PREPARE_LIMIT });
function phases(stderr) {
  return String(stderr ?? '').split('\n').filter(line => line.startsWith('{"phase":')).map(line => JSON.parse(line));
}
function phase(log, name) {
  const item = log.find(value => value.phase === name);
  assert(item, `missing observed boundary ${name}`);
  return item;
}
function observedProfile(f, invoke) {
  const events = [];
  const options = { observe: value => events.push(value) };
  const result = invoke(options, events);
  assert.equal(events[0].phase, 'before_spawn');
  assert.equal(events.length, 2, 'exactly one before and one terminal parent observation');
  for (const event of events) {
    assert.equal(event.timeout_ms, 30_000);
    assert.equal(event.max_buffer_bytes, OUTPUT_LIMIT);
  }
  return { result, events, terminal: events.at(-1) };
}

test('profiler boundary preserves complete SQL and captures full parent and child intervals', t => {
  const f = fixture(t), before = hash(readFileSync(f.db));
  const observed = observedProfile(f, options => profile(f, controlSql, { readonly: true }, options));
  complete(observed.result, 'observed control program', FIXED_BUDGET + ROW_OVERHEAD);
  assert.deepEqual(observed.result.rows, [{ invented: 1 }]);
  assert.equal(hash(readFileSync(f.db)), before);
  const { terminal, events } = observed, log = phases(terminal.trace);
  assert.equal(terminal.phase, 'after_spawn');
  assert.equal(terminal.status, 0);
  assert.equal(terminal.input_bytes, Buffer.byteLength(controlInput(f)));
  assert.equal(terminal.input_sha256, hash(controlInput(f)));
  assert.equal(events[0].input_sha256, terminal.input_sha256);
  assert.equal(terminal.sql_sha256, hash(controlSql));
  assert.equal(terminal.sql_bytes, Buffer.byteLength(controlSql));
  assert.equal(terminal.spawn_elapsed_ms, terminal.spawn_return_monotonic_ms - terminal.spawn_start_monotonic_ms);
  assert(terminal.observer_elapsed_ms >= terminal.spawn_elapsed_ms);
  assert(terminal.stdout_bytes > 0 && terminal.stderr_bytes > 0);
  const ordered = ['startup', 'hashlib_import_start', 'hashlib_import_done', 'sqlite_import_start',
    'sqlite_import_done', 'path_import_start', 'path_import_done', 'json_load_start', 'stdin_read_start',
    'stdin_read_done', 'json_load_done', 'input_read', 'connect_start', 'connect_done', 'prepare_start', 'exit'];
  let previous = -1;
  for (const name of ordered) {
    const index = log.findIndex(item => item.phase === name);
    assert(index > previous, `${name} must follow the preceding observed stage`); previous = index;
  }
  assert(log.length <= 512);
  assert(log.every(item => !Object.hasOwn(item, 'sql')));
  t.diagnostic(JSON.stringify({ control: 'normal_parent_child_boundaries', spawn_ms: terminal.spawn_elapsed_ms,
    child_trace_ms: phase(log, 'exit').wall_ms, input_bytes: terminal.input_bytes }));
});

test('profiler boundary distinguishes pre-clock startup and an injected import-stage wait', t => {
  const f = fixture(t);
  writeFileSync(f.profiler, PROFILER.replace('wall_start, cpu_start =',
    'time.sleep(0.25)\nwall_start, cpu_start =').replace("trace('sqlite_import_start')",
    "trace('sqlite_import_start')\ntime.sleep(0.25)"));
  const { result, terminal } = observedProfile(f, options => profile(f, controlSql, { readonly: true }, options));
  complete(result, 'delayed import control', FIXED_BUDGET + ROW_OVERHEAD);
  const log = phases(terminal.trace), start = phase(log, 'sqlite_import_start'), end = phase(log, 'sqlite_import_done');
  assert(end.wall_ms - start.wall_ms >= 200, 'the declared import-stage wait is visible');
  assert(terminal.spawn_elapsed_ms - phase(log, 'exit').wall_ms >= 200,
    'time before the internal clock remains inside the parent spawn interval');
  t.diagnostic(JSON.stringify({ control: 'injected_waits_not_original_cause', spawn_ms: terminal.spawn_elapsed_ms,
    import_interval_ms: end.wall_ms - start.wall_ms, child_trace_ms: phase(log, 'exit').wall_ms }));
});

test('profiler boundary waits for EOF even when a complete valid JSON value was written', async t => {
  const f = fixture(t), before = hash(readFileSync(f.db)), input = controlInput(f);
  const start = performance.now();
  const child = spawn('python3', [f.profiler], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', release, endedAt, writeCallbackAt, payloadObservedAt, beforeEof;
  let overflow = false, sawReadStart = false, sawFullPayload = false, deadlineTriggered = false, firstError;
  const timeout = setTimeout(() => { deadlineTriggered = true; child.kill('SIGKILL'); },
    Math.max(1, 30_000 - (performance.now() - start)));
  const capOutput = () => {
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > OUTPUT_LIMIT) { overflow = true; child.kill('SIGKILL'); }
  };
  const releaseWhenObserved = () => {
    if (!release && sawReadStart && sawFullPayload && Number.isFinite(writeCallbackAt)) {
      release = setTimeout(() => {
        beforeEof = phases(stderr);
        endedAt = performance.now(); child.stdin.end();
      }, 250);
    }
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; capOutput(); });
  child.stderr.on('data', value => {
    stderr += value; capOutput();
    if (stderr.includes('"phase":"stdin_read_start"')) sawReadStart = true;
    const lines = stderr.split('\n').slice(0, -1);
    for (const line of lines) {
      const event = JSON.parse(line);
      if (!sawFullPayload && event.phase === 'stdin_chunk' && event.total_bytes === Buffer.byteLength(input) && event.eof === false) {
        sawFullPayload = true; payloadObservedAt = performance.now();
      }
    }
    releaseWhenObserved();
  });
  const failOwnedChild = error => { if (firstError === undefined) firstError = error; child.kill('SIGKILL'); };
  const closed = new Promise(resolve => {
    child.once('error', failOwnedChild);
    child.stdin.once('error', failOwnedChild);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  try {
    child.stdin.write(input, error => {
      if (error) failOwnedChild(error);
      else { writeCallbackAt = performance.now(); releaseWhenObserved(); }
    });
  } catch (error) { failOwnedChild(error); }
  let status;
  try { status = await closed; } // Wait for owned child and stdio close before fixture cleanup, even on errors.
  finally { clearTimeout(timeout); clearTimeout(release); }
  if (firstError !== undefined) throw firstError;
  assert.equal(deadlineTriggered, false, 'a triggered watchdog is failure even if close delivery races with it');
  assert.equal(overflow, false, 'delayed-EOF control also retains the four MiB output bound');
  assert.deepEqual(status, { code: 0, signal: null }, stderr);
  assert(Number.isFinite(writeCallbackAt) && Number.isFinite(endedAt) && Number.isFinite(payloadObservedAt));
  assert(endedAt - payloadObservedAt >= 200, 'all payload bytes are observed before the deliberately withheld EOF');
  assert(beforeEof.some(event => event.phase === 'stdin_chunk' && event.total_bytes === Buffer.byteLength(input) && event.eof === false));
  assert(!beforeEof.some(event => event.phase === 'stdin_read_done' || event.phase === 'json_load_done' || event.phase === 'connect_start'),
    'a complete JSON payload without EOF must not be parsed or sent to SQLite');
  assert(endedAt - writeCallbackAt >= 200, 'write completion is not EOF or child parse completion');
  const log = phases(stderr), readStart = phase(log, 'stdin_read_start'), readDone = phase(log, 'stdin_read_done');
  const eof = log.filter(event => event.phase === 'stdin_chunk' && event.eof === true);
  assert.equal(eof.length, 1); assert.equal(eof[0].bytes, 0); assert.equal(eof[0].total_bytes, Buffer.byteLength(input));
  assert(readDone.wall_ms >= eof[0].wall_ms);
  assert(readDone.wall_ms - readStart.wall_ms >= 200);
  assert(phase(log, 'json_load_done').wall_ms >= readDone.wall_ms);
  complete(JSON.parse(stdout), 'delayed EOF control', FIXED_BUDGET + ROW_OVERHEAD);
  assert.equal(hash(readFileSync(f.db)), before);
  t.diagnostic(JSON.stringify({ control: 'declared_delayed_EOF', parent_ms: performance.now() - start,
    child_read_ms: readDone.wall_ms - readStart.wall_ms }));
});

test('profiler boundary records completed input read before rejecting malformed JSON', t => {
  const f = fixture(t), before = hash(readFileSync(f.db));
  const result = spawnSync('python3', [f.profiler], { input: '{', encoding: 'utf8', timeout: 30_000, maxBuffer: OUTPUT_LIMIT });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  const log = phases(result.stderr);
  phase(log, 'stdin_read_done');
  assert(!log.some(item => ['json_load_done', 'connect_start', 'prepare_start'].includes(item.phase)));
  assert.equal(result.stdout, '');
  assert.equal(hash(readFileSync(f.db)), before);
});

for (const [label, input] of [
  ['truncated JSON', Buffer.from('{"sql":"SELECT 1;"')],
  ['invalid UTF-8', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])],
  ['invalid JSON', Buffer.from('{"sql":NaN missing}')],
]) test(`chunk observations retain EOF but reject ${label} before SQLite`, t => {
  const f = fixture(t), before = hash(readFileSync(f.db));
  const result = spawnSync('python3', [f.profiler], { input, encoding: 'utf8', timeout: 30_000, maxBuffer: OUTPUT_LIMIT });
  assert.equal(result.error, undefined); assert.equal(result.status, 1); assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  const log = phases(result.stderr), chunks = log.filter(event => event.phase === 'stdin_chunk');
  assert(chunks.length > 0); assert.equal(chunks.at(-1).bytes, 0); assert.equal(chunks.at(-1).eof, true);
  assert.equal(chunks.at(-1).total_bytes, input.length);
  assert(log.length <= 512);
  assert(!log.some(event => ['json_load_done', 'input_read', 'connect_start', 'prepare_start'].includes(event.phase)));
  if (label !== 'invalid UTF-8') assert.equal(phase(log, 'stdin_read_done').bytes, input.length);
  assert.equal(hash(readFileSync(f.db)), before);
});

test('profiler boundary retains child failure before the original status assertion rejects it', t => {
  const f = fixture(t); writeFileSync(f.profiler, 'import sys\nsys.exit(7)\n');
  const { terminal } = observedProfile(f, options => {
    assert.throws(() => profile(f, controlSql, { readonly: true }, options), { code: 'ERR_ASSERTION' });
  });
  assert.equal(terminal.status, 7);
  assert.equal(terminal.stdout_bytes, 0);
  assert.equal(terminal.stderr_bytes, 0);
});

test('profiler boundary keeps unavailable output unknown when no executable exists', t => {
  const f = fixture(t);
  const { terminal } = observedProfile(f, options => {
    assert.throws(() => profile(f, controlSql, { readonly: true }, {
      ...options, command: f.profiler + '.invented-nonexistent-python',
    }), { code: 'ERR_ASSERTION' });
  });
  assert.equal(terminal.error_code, 'ENOENT');
  assert.equal(terminal.status, null);
  assert.equal(terminal.stdout_bytes, null);
  assert.equal(terminal.stderr_bytes, null);
});

test('profiler boundary reports a synchronous throw without inventing an execution result', t => {
  const f = fixture(t), sentinel = Object.assign(new Error('invented local spawn adapter failure'), { code: 'SYNTHETIC_THROW' });
  let calls = 0;
  const { terminal } = observedProfile(f, options => {
    assert.throws(() => profile(f, controlSql, { readonly: true }, { ...options,
      run: (command, args, settings) => {
        calls++; assert.equal(command, 'python3'); assert.deepEqual(args, [f.profiler]);
        assert.equal(settings.timeout, 30_000); assert.equal(settings.maxBuffer, OUTPUT_LIMIT); throw sentinel;
      },
    }), error => error === sentinel);
  });
  assert.equal(calls, 1);
  assert.equal(terminal.phase, 'spawn_throw');
  assert.equal(terminal.execution_state, 'unknown');
  assert.equal(terminal.stdout_bytes, null);
  assert.equal(terminal.stderr_bytes, null);
  assert.equal(terminal.status, null);
  assert.equal(terminal.error_code, 'SYNTHETIC_THROW');
});

test('profiler boundary rejects real output overflow at the unchanged four MiB cap', t => {
  const f = fixture(t); writeFileSync(f.profiler, `import sys\nsys.stdout.write('x' * ${OUTPUT_LIMIT + 65_536})\nsys.stdout.flush()\n`);
  const { terminal } = observedProfile(f, options => {
    assert.throws(() => profile(f, controlSql, { readonly: true }, options), { code: 'ERR_ASSERTION' });
  });
  assert.equal(terminal.error_code, 'ENOBUFS');
  assert(terminal.stdout_bytes >= OUTPUT_LIMIT);
  assert.equal(terminal.max_buffer_bytes, OUTPUT_LIMIT);
});

test('profiler boundary rejects success JSON followed by a real thirty-second timeout', t => {
  const f = fixture(t), before = hash(readFileSync(f.db));
  writeFileSync(f.profiler, PROFILER + '\nsys.stdout.flush()\ntime.sleep(35)\n');
  let actualChild;
  const { terminal } = observedProfile(f, options => {
    assert.throws(() => profile(f, controlSql, { readonly: true }, { ...options,
      run: (...args) => { actualChild = spawnSync(...args); return actualChild; },
    }), { code: 'ERR_ASSERTION' });
  });
  complete(JSON.parse(actualChild.stdout), 'success report still rejected after deadline', FIXED_BUDGET + ROW_OVERHEAD);
  assert.equal(terminal.error_code, 'ETIMEDOUT');
  assert.equal(terminal.status, null);
  assert.equal(terminal.signal, 'SIGTERM');
  assert(terminal.stdout_bytes > 0, 'the child emitted its complete successful report before the tail');
  assert.equal(phase(phases(terminal.trace), 'exit').complete, true);
  assert(terminal.spawn_elapsed_ms >= 29_000, 'this is the real original thirty-second budget, not a shortened surrogate');
  assert.equal(terminal.timeout_ms, 30_000);
  assert.equal(hash(readFileSync(f.db)), before);
  t.diagnostic(JSON.stringify({ control: 'real_original_timeout_after_success_report',
    spawn_ms: terminal.spawn_elapsed_ms, timeout_ms: terminal.timeout_ms, rejected: true }));
});

test('profiler boundary rejects a real signal-only child result', t => {
  const f = fixture(t); writeFileSync(f.profiler, 'import os,signal\nos.kill(os.getpid(),signal.SIGTERM)\n');
  const { terminal } = observedProfile(f, options => {
    assert.throws(() => profile(f, controlSql, { readonly: true }, options), { code: 'ERR_ASSERTION' });
  });
  assert.equal(terminal.error_code, undefined);
  assert.equal(terminal.status, null);
  assert.equal(terminal.signal, 'SIGTERM');
});

for (const [label, output] of [['empty', ''], ['malformed', '{']]) {
  test(`profiler boundary retains zero-exit ${label} stdout before JSON parsing rejects it`, t => {
    const f = fixture(t); writeFileSync(f.profiler, `import sys\nsys.stdout.write(${JSON.stringify(output)})\n`);
    const { terminal } = observedProfile(f, options => {
      assert.throws(() => profile(f, controlSql, { readonly: true }, options), SyntaxError);
    });
    assert.equal(terminal.status, 0);
    assert.equal(terminal.stdout_bytes, Buffer.byteLength(output));
  });
}

test('profiler boundary does not make a parsed null report satisfy the original complete-program gate', t => {
  const f = fixture(t); writeFileSync(f.profiler, "print('null')\n");
  const { result, terminal } = observedProfile(f, options => profile(f, controlSql, { readonly: true }, options));
  assert.equal(terminal.status, 0);
  assert.equal(result, null);
  assert.throws(() => complete(result, 'invalid report control', FIXED_BUDGET + ROW_OVERHEAD));
});

test('profiler boundary accepts bounded transport output just below the unchanged four MiB cap', t => {
  const f = fixture(t), size = OUTPUT_LIMIT - 1024;
  // This is only a transport/parser fixture, not an asserted SQL report.
  writeFileSync(f.profiler, `import json\nprint(json.dumps({'invented_marker':'bounded-output','padding':'x'*${size}}))\n`);
  const { result, terminal } = observedProfile(f, options => profile(f, controlSql, { readonly: true }, options));
  assert.equal(terminal.status, 0);
  assert.equal(result.invented_marker, 'bounded-output');
  assert.equal(result.padding.length, size);
  assert(terminal.stdout_bytes >= size && terminal.stdout_bytes < OUTPUT_LIMIT);
  assert.equal(terminal.max_buffer_bytes, OUTPUT_LIMIT);
});

test('profiler boundary observer failure cannot replace the original thrown value', t => {
  const f = fixture(t), original = new Error('invented original throw'), observer = new Error('invented observer failure');
  for (const error of [original, Object.defineProperty(new Error('invented getter control'), 'code', {
    get() { throw observer; },
  })]) {
    assert.throws(() => profile(f, controlSql, { readonly: true }, {
      run: () => { throw error; },
      observe: event => { if (event.phase !== 'before_spawn') throw observer; },
    }), value => value === error);
  }
});

test('profiler boundary observer failure preserves primary returned failures and fails closed on successful transport', t => {
  const f = fixture(t), observer = new Error('invented observer failure');
  const missing = Object.assign(new Error('invented returned spawn failure'), { code: 'ENOENT' });
  const harness = result => ({ run: () => result,
    observe: event => { if (event.phase !== 'before_spawn') throw observer; } });
  assert.throws(() => profile(f, controlSql, {}, harness({ error: missing, status: null })),
    error => error.code === 'ERR_ASSERTION' && error.actual === missing);
  assert.throws(() => profile(f, controlSql, {}, harness({ status: 7, stdout: '' })),
    error => error.code === 'ERR_ASSERTION' && error.actual === 7);
  assert.throws(() => profile(f, controlSql, {}, harness({ status: 0, stdout: '{' })), SyntaxError);
  assert.throws(() => profile(f, controlSql, {}, harness({ status: 0, stdout: '{}' })), error => error === observer);
});
