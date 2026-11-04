import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
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
trace('python_fingerprint', version=list(sys.version_info[:3]), executable_path_sha256=hashlib.sha256(sys.executable.encode()).hexdigest(),
      stdin_encoding=sys.stdin.encoding, stdin_errors=sys.stdin.errors, utf8_mode=sys.flags.utf8_mode)
trace('sqlite_import_start')
import sqlite3
trace('sqlite_import_done')
trace('path_import_start')
from pathlib import Path
trace('path_import_done')
class ObservedInput:
    def read(self, *args, **kwargs):
        trace('stdin_read_start')
        value = sys.stdin.read(*args, **kwargs)
        trace('stdin_read_done', characters=len(value))
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

// Explicit calibration only: structural primary tests keep the TextIO reader.
const CHUNK_INPUT = String.raw`
class ObservedInput:
    def read(self, *args, **kwargs):
        trace('stdin_read_start')
        # Explicit byte/EOF calibration; not the primary TextIO.read path.
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
`;
const PRIMARY_INPUT = PROFILER.slice(PROFILER.indexOf('class ObservedInput:'), PROFILER.indexOf("trace('json_load_start')"));
const CHUNK_PROFILER = PROFILER.replace(PRIMARY_INPUT, CHUNK_INPUT);

// Fixed authored fixture allowlist, never a recursive copy or consistent-backup claim.
// This function is embedded unchanged in the disposable nested driver too.
function captureSyntheticEvidence(f, input, command, entry = 'primary', inlineDriver = null) {
  if (f.control) return;
  try {
    if (!f.directory || !f.directory.startsWith(tmpdir()) || !f.directory.includes('exocortex-sql-cost-synthetic-') ||
        f.db !== join(f.directory, 'synthetic.sqlite') || f.profiler !== join(f.directory, 'explain-cost.py')) return;
    const directory = join(f.directory, 'profiler-evidence');
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { mode: 0o700 });
    const cap = 8 * 1024 * 1024, reserve = 64 * 1024;
    const metadata = { version: 1, entry, reader: f.reader, capture: 'pre-attempt files; consistency and replayability unverified',
      input_bytes: Buffer.byteLength(input), input_sha256: hash(input), command,
      argv_shape: entry === 'nested_driver_launch' ? ['--input-type=module', '-e', '<inline driver>'] : [f.profiler],
      inline_driver_sha256: typeof inlineDriver === 'string' ? hash(inlineDriver) : null,
      node: { version: process.version, platform: process.platform, arch: process.arch,
        executable_path_sha256: hash(process.execPath) }, environment: {}, files: [], omitted: [] };
    for (const key of ['NODE_OPTIONS', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONIOENCODING',
      'LANG', 'LC_ALL', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']) {
      const value = process.env[key];
      metadata.environment[key] = value === undefined ? { present: false } :
        { present: true, bytes: Buffer.byteLength(value), sha256: hash(value) };
    }
    let used = 0;
    const save = (name, bytes) => {
      if (used + bytes.length > cap - reserve) { metadata.omitted.push({ name, reason: 'capture_byte_cap', bytes: bytes.length }); return; }
      fs.writeFileSync(join(directory, name), bytes, { mode: 0o600, flag: 'wx' }); used += bytes.length;
      metadata.files.push({ name, bytes: bytes.length, sha256: hash(bytes) });
    };
    save('input.json', Buffer.from(input));
    for (const [name, source] of [['profiler.py', f.profiler], ['fixture.sqlite', f.db],
      ['fixture.sqlite-wal', f.db + '-wal'], ['fixture.sqlite-shm', f.db + '-shm']]) {
      let fd;
      try {
        fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const before = fs.fstatSync(fd);
        if (!before.isFile() || before.size > cap - reserve - used) {
          metadata.omitted.push({ name, reason: 'not_regular_or_over_cap' }); continue;
        }
        const bytes = Buffer.alloc(before.size); let offset = 0;
        while (offset < bytes.length) { const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!read) break; offset += read; }
        const after = fs.fstatSync(fd);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || offset !== before.size) {
          metadata.omitted.push({ name, reason: 'changed_during_capture' }); continue;
        }
        save(name, bytes);
      } catch (error) { metadata.omitted.push({ name, reason: error?.code === 'ENOENT' ? 'absent' : 'capture_unavailable' }); }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    fs.writeFileSync(join(directory, 'metadata.json'), JSON.stringify(metadata), { mode: 0o600, flag: 'wx' });
  } catch { /* Retention must not change primary execution or mask its original failure. */ }
}
function noteEvidenceFailure(f, kind, result) {
  if (f.control) return;
  f.failed = true;
  try {
    const directory = join(f.directory, 'profiler-evidence');
    const fingerprint = String(result?.stderr || '').split('\n').filter(line => line.startsWith('{"phase":'))
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .find(event => event?.phase === 'python_fingerprint') || null;
    const value = { kind, status: Number.isInteger(result?.status) ? result.status : null,
      signal: typeof result?.signal === 'string' ? result.signal : null,
      error_code: typeof result?.error?.code === 'string' ? result.error.code.slice(0, 80) : null,
      direct_child_termination: Number.isInteger(result?.status) ? 'exit_status_observed' : 'unknown',
      commit_state: 'not_inferred_from_transport', python: fingerprint };
    fs.writeFileSync(join(directory, 'failure.json'), JSON.stringify(value), { mode: 0o600 });
  } catch { /* Preserve the first execution/assertion error even if evidence cannot be saved. */ }
}
let retainedFixtures = 0, retainedRoot;

// Preserve the executor's output mode after measuring its entire SQL program.
// Framing values come only from actual SELECT results: never inject markers,
// remove statements, or accept a parseable prefix after a profiler failure.
function profiledExecutorStdout(args, report, budget) {
  complete(report, 'profiled SQLite executor output', budget);
  assert.equal(report.failure, undefined, 'a profiler failure cannot become successful executor output');
  assert.ok(Array.isArray(report.rows), 'the complete profiler result must contain rows');
  if (!args.includes('-list')) return JSON.stringify(report.rows);
  assert.ok(args.includes('-noheader') && !args.includes('-json'), 'unsupported profiled SQLite output mode');
  return report.rows.map(row => {
    assert.ok(row && typeof row === 'object' && !Array.isArray(row), 'plain output requires an object row');
    const values = Object.values(row);
    assert.equal(values.length, 1, 'plain output requires exactly one result column');
    assert.equal(typeof values[0], 'string', 'plain output requires a TEXT result');
    return values[0] + '\n';
  }).join('');
}

// Intercept the actual storage executor only inside this disposable child.
// SQL is executed, not mocked: prepareObservationRecords reads and the complete
// succeedRecordRun transaction each go through EXPLAIN + actual sqlite3 steps.
// createRun is prerequisite fixture setup, outside the measured operation.
const RUN_DRIVER = String.raw`
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
${captureSyntheticEvidence.toString()}
${noteEvidenceFailure.toString()}
${complete.toString()}
${profiledExecutorStdout.toString()}
const p = JSON.parse(readFileSync(0, 'utf8'));
const spawn = cp.spawnSync;
let measuring = false;
const reports = [];
cp.spawnSync = (command, args, options) => {
  if (!measuring || command !== 'sqlite3') return spawn(command, args, options);
  const prefix = '.bail on\n.timeout 5000\n';
  if (!options.input.startsWith(prefix)) throw new Error('unexpected sqlite executor prologue');
  const input = JSON.stringify({
    db: args.at(-1), sql: options.input.slice(prefix.length),
    readonly: args.includes('-readonly'), prepare_limit: p.prepare_limit,
    budget: p.budget - reports.reduce((n, r) => n + r.opcodes, 0),
  });
  captureSyntheticEvidence(p, input, 'python3');
  let result;
  try { result = spawn('python3', [p.profiler], { input, encoding: 'utf8', maxBuffer: p.output_limit, timeout: 30_000 }); }
  catch (error) { noteEvidenceFailure(p, 'spawn_throw', null); throw error; }
  if (result.error || result.status !== 0) noteEvidenceFailure(p, 'transport_failure', result);
  if (result.error || result.status !== 0) throw new Error('cost profiler failed: ' + JSON.stringify({
    status: result.status, signal: result.signal, error_code: result.error?.code, stderr: result.stderr,
  }));
  let report;
  try { report = JSON.parse(result.stdout); }
  catch (error) { noteEvidenceFailure(p, 'parse_failure', result); throw error; }
  if (!report?.complete) noteEvidenceFailure(p, 'incomplete_report', result);
  reports.push(report);
  if (!report.complete) throw new Error('SQL structural budget or complete-consumption failure: ' + report.failure);
  assert.equal(report.sql_bytes, Buffer.byteLength(options.input.slice(prefix.length)), 'the entire executor SQL must be measured');
  assert.equal(report.sql_sha256, hash(options.input.slice(prefix.length)), 'no executor SQL may be stripped or replaced');
  const stdout = profiledExecutorStdout(args, report, p.budget);
  return { status: 0, signal: null, error: undefined, stdout, stderr: '' };
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

function fixture(t, { reader = 'primary', control = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'exocortex-sql-cost-synthetic-'));
  const f = { directory, reader, control };
  t.after(() => {
    try {
      if (f.failed && !f.control && retainedFixtures < 4 && fs.existsSync(join(directory, 'profiler-evidence'))) {
        retainedRoot ||= mkdtempSync(join(tmpdir(), 'exocortex-sql-cost-failures-'));
        const destination = join(retainedRoot, 'case-' + (++retainedFixtures));
        fs.renameSync(join(directory, 'profiler-evidence'), destination);
        t.diagnostic(JSON.stringify({ evidence: 'synthetic_primary_failure_retained', directory: destination,
          consistent_backup: false, max_bytes: 8 * 1024 * 1024, max_retained_fixtures: 4 }));
      } else if (f.failed && !f.control) t.diagnostic('synthetic primary evidence unavailable or retention count cap reached');
    } catch { t.diagnostic('synthetic primary evidence retention unavailable; original failure retained'); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  const db = join(directory, 'synthetic.sqlite');
  ensureInitialized(db);
  const profiler = join(directory, 'explain-cost.py');
  writeFileSync(profiler, reader === 'chunk' ? CHUNK_PROFILER : PROFILER);
  return Object.assign(f, { db, profiler });
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
  captureSyntheticEvidence(f, input, command);
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
    noteEvidenceFailure(f, 'spawn_throw', null);
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
  if (result.error || result.status !== 0) noteEvidenceFailure(f, 'transport_failure', result);
  assert.equal(result.error, undefined, 'the bounded profiler must not overflow stdout or fail to launch: ' + JSON.stringify({
    status: result.status, signal: result.signal, error_code: result.error?.code, stderr: result.stderr,
  }));
  assert.equal(result.status, 0, JSON.stringify({
    status: result.status, signal: result.signal, error_code: result.error?.code, stderr: result.stderr,
  }));
  let report;
  try { report = JSON.parse(result.stdout); }
  catch (error) { noteEvidenceFailure(f, 'parse_failure', result); throw error; }
  if (report?.complete !== true) noteEvidenceFailure(f, 'incomplete_report', result);
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
  const input = JSON.stringify({ ...f, records, budget, scope: SCOPE, at: AT,
    store: new URL('../dist/storage/sqlite/ingestion-store.js', import.meta.url).href,
    prepare_limit: STATEMENT_PREPARE_LIMIT, output_limit: OUTPUT_LIMIT });
  captureSyntheticEvidence(f, input, process.execPath, 'nested_driver_launch', RUN_DRIVER);
  let result;
  try { result = spawnSync(process.execPath, ['--input-type=module', '-e', RUN_DRIVER], {
    cwd: repo, input,
    encoding: 'utf8', maxBuffer: OUTPUT_LIMIT, timeout: 90_000,
  }); } catch (error) { noteEvidenceFailure(f, 'nested_driver_throw', null); throw error; }
  if (result.error || result.status !== 0) { f.failed = true; /* Nested exact input/status remain in its own capture. */ }
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

test('profiled executor frame adapter measures marker SELECTs and all transaction statements', t => {
  const f = fixture(t, { control: true });
  const begin = '__EXOCORTEX_OBSERVATION_OBJECTS_BEGIN_V1__';
  const end = '__EXOCORTEX_OBSERVATION_OBJECTS_END_V1__';
  const statements = [
    'PRAGMA query_only=ON;', 'BEGIN;', `SELECT '${begin}' AS object_frame;`,
    `SELECT json_object('synthetic','source','n',1) AS payload;`, 'COMMIT;',
    `SELECT '${end}' AS object_frame;`,
  ];
  const sql = statements.join(''), budget = 1000;
  const report = profile(f, sql, { budget, readonly: true });
  complete(report, 'complete marker program', budget);
  assert.equal(report.sql_sha256, hash(sql));
  assert.equal(report.sql_bytes, Buffer.byteLength(sql));
  assert.equal(report.statements.length, statements.length);
  for (const [index, statement] of statements.entries()) {
    assert.equal(report.statements[index].sha256, hash(statement));
    assert.equal(report.statements[index].bytes, Buffer.byteLength(statement));
    assert.ok(report.statements[index].opcodes > 0);
  }
  assert.equal(profiledExecutorStdout(['-list', '-noheader'], report, budget),
    `${begin}\n{"synthetic":"source","n":1}\n${end}\n`);

  // A CLI directive is NOT SQL. Keep this former failure visible rather than
  // teaching the adapter to strip it or silently fabricate its result frame.
  const invalid = `BEGIN;\n.print ${begin}\nSELECT 1;COMMIT;`;
  const failed = profile(f, invalid, { budget, readonly: true });
  assert.equal(failed.complete, false);
  assert.equal(failed.failure, 'OperationalError');
  assert.equal(failed.sql_sha256, hash(invalid));
  assert.equal(failed.sql_bytes, Buffer.byteLength(invalid));
  assert.ok(failed.consumed_bytes < failed.sql_bytes);
  assert.throws(() => profiledExecutorStdout(['-list', '-noheader'], failed, budget));
});

test('profiled executor frame adapter preserves JSON mode and never invents missing frame rows', () => {
  const make = rows => ({ complete: true, consumed_bytes: 1, sql_bytes: 1,
    statements: [{ bytes: 1, opcodes: 1 }], opcodes: 1, rows });
  const rows = [{ text: 'Synthetic\0雪', n: 2, nullable: null }];
  assert.equal(profiledExecutorStdout(['-json'], make(rows), 10), JSON.stringify(rows));
  assert.equal(profiledExecutorStdout([], make(rows), 10), JSON.stringify(rows));
  assert.equal(profiledExecutorStdout(['-list', '-noheader'], make([]), 10), '',
    'empty report rows cannot synthesize BEGIN/END');
  const prefix = [{ object_frame: '__EXOCORTEX_OBSERVATION_OBJECTS_BEGIN_V1__' }, { payload: '{"synthetic":1}' }];
  assert.equal(profiledExecutorStdout(['-list', '-noheader'], make(prefix), 10),
    '__EXOCORTEX_OBSERVATION_OBJECTS_BEGIN_V1__\n{"synthetic":1}\n',
    'a complete SQL program missing its end SELECT stays incomplete at the product frame parser');
});

test('profiled executor frame adapter rejects failures, unconsumed programs and unsupported plain rows', () => {
  const valid = { complete: true, consumed_bytes: 1, sql_bytes: 1,
    statements: [{ bytes: 1, opcodes: 1 }], opcodes: 1, rows: [{ payload: 'Synthetic text' }] };
  for (const patch of [{ complete: false }, { failure: 'OperationalError' }, { consumed_bytes: 0 },
    { statements: [] }, { opcodes: 2 }, { rows: null }]) {
    assert.throws(() => profiledExecutorStdout(['-list', '-noheader'], { ...valid, ...patch }, 10));
  }
  for (const row of [null, [], { a: 'one', b: 'two' }, { a: 1 }, { a: null }])
    assert.throws(() => profiledExecutorStdout(['-list', '-noheader'], { ...valid, rows: [row] }, 10));
  assert.throws(() => profiledExecutorStdout(['-list'], valid, 10));
  assert.throws(() => profiledExecutorStdout(['-list', '-noheader', '-json'], valid, 10));
  assert.throws(() => profiledExecutorStdout(['-list', '-noheader'], valid, 0));
});

test('structural harness consumes every statement and trigger subprogram, and fails closed at its budget/tail', t => {
  const f = fixture(t, { control: true });
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
function controlFixture(t, reader = 'primary') { return fixture(t, { reader, control: true }); }
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
  const f = controlFixture(t), before = hash(readFileSync(f.db));
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
  const f = controlFixture(t);
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

async function delayedEofControl(t, f, { endInput = child => child.stdin.end(), onClose = () => {} } = {}) {
  const before = hash(readFileSync(f.db)), input = controlInput(f);
  const start = performance.now();
  const child = spawn('python3', [f.profiler], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', release, endedAt, writeCallbackAt, payloadObservedAt, beforeEof;
  let overflow = false, sawReadStart = false, sawFullPayload = false, deadlineTriggered = false, firstError;
  const killOwned = () => { try { child.kill('SIGKILL'); } catch (error) { if (firstError === undefined) firstError = error; } };
  const failOwnedChild = error => { if (firstError === undefined) firstError = error; killOwned(); };
  const timeout = setTimeout(() => { deadlineTriggered = true; killOwned(); },
    Math.max(1, 30_000 - (performance.now() - start)));
  const capOutput = () => {
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > OUTPUT_LIMIT) { overflow = true; killOwned(); }
  };
  const releaseWhenObserved = () => {
    if (!release && sawReadStart && sawFullPayload && Number.isFinite(writeCallbackAt)) {
      release = setTimeout(() => {
        try { beforeEof = phases(stderr); endedAt = performance.now(); endInput(child); }
        catch (error) { failOwnedChild(error); }
      }, 250);
    }
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { try { stdout += value; capOutput(); } catch (error) { failOwnedChild(error); } });
  child.stderr.on('data', value => {
    try {
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
    } catch (error) { failOwnedChild(error); }
  });
  const closed = new Promise(resolve => {
    child.once('error', failOwnedChild);
    child.stdin.once('error', failOwnedChild);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  try {
    child.stdin.write(input, error => {
      try { if (error) failOwnedChild(error);
      else { writeCallbackAt = performance.now(); releaseWhenObserved(); } } catch (failure) { failOwnedChild(failure); }
    });
  } catch (error) { failOwnedChild(error); }
  let status;
  try { status = await closed; } // Wait for owned child and stdio close before fixture cleanup, even on errors.
  finally { clearTimeout(timeout); clearTimeout(release); }
  try { onClose(status); } catch (error) { if (firstError === undefined) firstError = error; }
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
}

test('chunk calibration waits for EOF even when a complete valid JSON value was written', async t => {
  await delayedEofControl(t, controlFixture(t, 'chunk'));
});

test('chunk calibration stderr decoding failure closes its owned child before rejecting', async t => {
  const f = controlFixture(t, 'chunk'); let closed;
  writeFileSync(f.profiler, "import sys,time\nsys.stderr.write('authored non-JSON warning\\n')\nsys.stderr.flush()\ntime.sleep(10)\n");
  await assert.rejects(delayedEofControl(t, f, { onClose: value => { closed = value; } }), SyntaxError);
  assert(closed); assert.notEqual(closed.code, 0);
});

test('chunk calibration EOF timer failure closes its owned child and retains the original error', async t => {
  const f = controlFixture(t, 'chunk'), sentinel = new Error('authored end-input failure'); let closed;
  await assert.rejects(delayedEofControl(t, f, { endInput() { throw sentinel; }, onClose(value) { closed = value; } }),
    error => error === sentinel);
  assert(closed); assert.notEqual(closed.code, 0);
});

test('profiler boundary records completed input read before rejecting malformed JSON', t => {
  const f = controlFixture(t), before = hash(readFileSync(f.db));
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
  const f = controlFixture(t, 'chunk'), before = hash(readFileSync(f.db));
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
  const f = controlFixture(t); writeFileSync(f.profiler, 'import sys\nsys.exit(7)\n');
  const { terminal } = observedProfile(f, options => {
    assert.throws(() => profile(f, controlSql, { readonly: true }, options), { code: 'ERR_ASSERTION' });
  });
  assert.equal(terminal.status, 7);
  assert.equal(terminal.stdout_bytes, 0);
  assert.equal(terminal.stderr_bytes, 0);
});

test('profiler boundary keeps unavailable output unknown when no executable exists', t => {
  const f = controlFixture(t);
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
  const f = controlFixture(t), sentinel = Object.assign(new Error('invented local spawn adapter failure'), { code: 'SYNTHETIC_THROW' });
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
  const f = controlFixture(t); writeFileSync(f.profiler, `import sys\nsys.stdout.write('x' * ${OUTPUT_LIMIT + 65_536})\nsys.stdout.flush()\n`);
  const { terminal } = observedProfile(f, options => {
    assert.throws(() => profile(f, controlSql, { readonly: true }, options), { code: 'ERR_ASSERTION' });
  });
  assert.equal(terminal.error_code, 'ENOBUFS');
  assert(terminal.stdout_bytes >= OUTPUT_LIMIT);
  assert.equal(terminal.max_buffer_bytes, OUTPUT_LIMIT);
});

test('profiler boundary rejects success JSON followed by a real thirty-second timeout', t => {
  const f = controlFixture(t), before = hash(readFileSync(f.db));
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
  const f = controlFixture(t); writeFileSync(f.profiler, 'import os,signal\nos.kill(os.getpid(),signal.SIGTERM)\n');
  const { terminal } = observedProfile(f, options => {
    assert.throws(() => profile(f, controlSql, { readonly: true }, options), { code: 'ERR_ASSERTION' });
  });
  assert.equal(terminal.error_code, undefined);
  assert.equal(terminal.status, null);
  assert.equal(terminal.signal, 'SIGTERM');
});

for (const [label, output] of [['empty', ''], ['malformed', '{']]) {
  test(`profiler boundary retains zero-exit ${label} stdout before JSON parsing rejects it`, t => {
    const f = controlFixture(t); writeFileSync(f.profiler, `import sys\nsys.stdout.write(${JSON.stringify(output)})\n`);
    const { terminal } = observedProfile(f, options => {
      assert.throws(() => profile(f, controlSql, { readonly: true }, options), SyntaxError);
    });
    assert.equal(terminal.status, 0);
    assert.equal(terminal.stdout_bytes, Buffer.byteLength(output));
  });
}

test('profiler boundary does not make a parsed null report satisfy the original complete-program gate', t => {
  const f = controlFixture(t); writeFileSync(f.profiler, "print('null')\n");
  const { result, terminal } = observedProfile(f, options => profile(f, controlSql, { readonly: true }, options));
  assert.equal(terminal.status, 0);
  assert.equal(result, null);
  assert.throws(() => complete(result, 'invalid report control', FIXED_BUDGET + ROW_OVERHEAD));
});

test('profiler boundary accepts bounded transport output just below the unchanged four MiB cap', t => {
  const f = controlFixture(t), size = OUTPUT_LIMIT - 1024;
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
  const f = controlFixture(t), original = new Error('invented original throw'), observer = new Error('invented observer failure');
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
  const f = controlFixture(t), observer = new Error('invented observer failure');
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

// Pure method/encoding controls: no pipe timing or historical-cause claim.
test('primary TextIO and explicit chunk calibration retain six distinct method and decoding contracts', t => {
  const script = String.raw`
import io, json, sys, types
sources = json.load(sys.stdin)
class Binary:
    def __init__(self, raw, split, forbid):
        self.inner, self.split, self.forbid, self.calls = io.BytesIO(raw), split, forbid, 0
    def read1(self, size):
        self.calls += 1
        if self.forbid: raise RuntimeError('primary_must_not_dispatch_read1')
        return self.inner.read(min(size, self.split))
class Text:
    def __init__(self, raw, encoding, errors, split, mode, fail):
        self.inner = io.TextIOWrapper(io.BytesIO(raw), encoding=encoding, errors=errors, newline=None)
        self.buffer, self.calls, self.mode, self.fail = Binary(raw, split, mode == 'primary'), 0, mode, fail
    def read(self, *args, **kwargs):
        self.calls += 1
        if self.fail or self.mode == 'chunk': raise RuntimeError('authored_original_text_read_failure')
        return self.inner.read(*args, **kwargs)
cases = [
 ('utf8', '{"value":"树é"}'.encode(), 'utf-8', 'strict', 65536, False),
 ('original_read_failure', b'{"value":1}', 'utf-8', 'strict', 65536, True),
 ('latin1', '{"value":"é"}'.encode('latin1'), 'latin1', 'strict', 65536, False),
 ('surrogateescape', b'{"value":"\xff"}', 'utf-8', 'surrogateescape', 65536, False),
 ('crlf', b'{\r\n"value":1\r\n}\r\n', 'utf-8', 'strict', 65536, False),
 ('split_utf8', '{"value":"树é"}'.encode(), 'utf-8', 'strict', 2, False),
]
results = []
for label, raw, encoding, errors, split, fail in cases:
    row = {'case': label}
    for mode, source in sources.items():
        stream = Text(raw, encoding, errors, split, mode, fail)
        scope = {'sys': types.SimpleNamespace(stdin=stream), 'trace': lambda *args, **kwargs: None}
        exec(source, scope)
        try:
            value = scope['ObservedInput']().read()
            result = {'value': json.loads(value), 'text': value}
        except Exception as error:
            result = {'error': type(error).__name__, 'message': str(error)}
        result.update(text_read_calls=stream.calls, chunk_read_calls=stream.buffer.calls)
        row[mode] = result
    results.append(row)
print(json.dumps(results))
`;
  const result = spawnSync('python3', ['-c', script], { input: JSON.stringify({ primary: PRIMARY_INPUT, chunk: CHUNK_INPUT }),
    encoding: 'utf8', timeout: 30_000, maxBuffer: OUTPUT_LIMIT });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout); assert.equal(rows.length, 6);
  for (const row of rows) {
    assert.equal(row.primary.text_read_calls, 1); assert.equal(row.primary.chunk_read_calls, 0);
    assert.equal(row.chunk.text_read_calls, 0); assert(row.chunk.chunk_read_calls > 0);
  }
  const find = label => rows.find(row => row.case === label);
  for (const label of ['utf8', 'split_utf8']) {
    assert.deepEqual(find(label).primary.value, { value: '树é' });
    assert.deepEqual(find(label).chunk.value, find(label).primary.value);
  }
  assert.equal(find('original_read_failure').primary.error, 'RuntimeError');
  assert.deepEqual(find('original_read_failure').chunk.value, { value: 1 });
  assert.deepEqual(find('latin1').primary.value, { value: 'é' });
  assert.equal(find('latin1').chunk.error, 'UnicodeDecodeError');
  assert.deepEqual(find('surrogateescape').primary.value, { value: '\udcff' });
  assert.equal(find('surrogateescape').chunk.error, 'UnicodeDecodeError');
  assert.equal(find('crlf').primary.text, '{\n"value":1\n}\n');
  assert.equal(find('crlf').chunk.text, '{\r\n"value":1\r\n}\r\n');
  assert.deepEqual(find('crlf').primary.value, find('crlf').chunk.value);
  t.diagnostic(JSON.stringify({ control: 'primary_vs_chunk_method_matrix', cases: rows.map(row => row.case), passed: 6,
    historical_stall_reproduced: false }));
});

test('an original TextIO.read exception rejects direct and nested primary gates before SQLite', t => {
  const f = controlFixture(t);
  writeFileSync(f.profiler, PROFILER.replace("trace('json_load_start')", String.raw`
original_input = sys.stdin
class FailingOriginalRead:
    def read(self, *args, **kwargs):
        raise RuntimeError('authored_original_text_read_failure')
    def __getattr__(self, name):
        return getattr(original_input, name)
sys.stdin = FailingOriginalRead()
trace('json_load_start')`));
  const { terminal } = observedProfile(f, options => {
    assert.throws(() => profile(f, controlSql, { readonly: true }, options), error =>
      error.code === 'ERR_ASSERTION' && String(error.message).includes('authored_original_text_read_failure'));
  });
  const trace = phases(terminal.trace); phase(trace, 'stdin_read_start');
  assert(!trace.some(event => ['stdin_read_done', 'json_load_done', 'connect_start'].includes(event.phase)));
  f.control = false;
  try {
    assert.throws(() => measuredRun(f, [record(0)], FIXED_BUDGET + ROW_OVERHEAD), error =>
      error.code === 'ERR_ASSERTION' && String(error.message).includes('authored_original_text_read_failure'));
    const directory = join(f.directory, 'profiler-evidence');
    const input = readFileSync(join(directory, 'input.json'), 'utf8'), payload = JSON.parse(input);
    const metadata = JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8'));
    assert.equal(metadata.entry, 'primary'); assert.equal(metadata.command, 'python3');
    assert.deepEqual(metadata.argv_shape, [f.profiler]); assert.equal(metadata.inline_driver_sha256, null);
    assert.equal(metadata.input_sha256, hash(input)); assert.equal(metadata.input_bytes, Buffer.byteLength(input));
    assert.equal(payload.db, f.db); assert.equal(typeof payload.sql, 'string'); assert(payload.sql.length > 0);
    assert.equal(Object.hasOwn(payload, 'records'), false); // Actual inner SQL, not the outer driver's records payload.
    assert.equal(readFileSync(join(directory, 'profiler.py'), 'utf8'), readFileSync(f.profiler, 'utf8'));
    assert.equal(hash(readFileSync(join(directory, 'fixture.sqlite'))), hash(readFileSync(f.db)));
    const failure = JSON.parse(readFileSync(join(directory, 'failure.json'), 'utf8'));
    assert.equal(failure.kind, 'transport_failure'); assert.notEqual(failure.status, 0);
    assert.equal(failure.python.phase, 'python_fingerprint');
  } finally { f.control = true; }
  assert.equal(sqliteQuery(f.db, 'SELECT COUNT(*) AS n FROM records;')[0].n, 0);
});

test('unexpected primary evidence keeps exact authored input and bounded pre-attempt files without masking a failure', t => {
  const f = fixture(t), sentinel = new Error('authored retention control failure'), before = hash(readFileSync(f.db));
  try {
    captureSyntheticEvidence(f, controlInput(f), process.execPath, 'nested_driver_launch', RUN_DRIVER);
    const launch = JSON.parse(readFileSync(join(f.directory, 'profiler-evidence', 'metadata.json'), 'utf8'));
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.argv_shape, ['--input-type=module', '-e', '<inline driver>']);
    assert.equal(launch.inline_driver_sha256, hash(RUN_DRIVER));
    assert.throws(() => profile(f, controlSql, { readonly: true }, { run() { throw sentinel; }, observe() {} }),
      error => error === sentinel);
    const directory = join(f.directory, 'profiler-evidence');
    assert.equal(readFileSync(join(directory, 'input.json'), 'utf8'), controlInput(f));
    assert.equal(hash(readFileSync(join(directory, 'fixture.sqlite'))), before);
    assert.equal(readFileSync(join(directory, 'profiler.py'), 'utf8'), PROFILER);
    const metadata = JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8'));
    assert.match(metadata.capture, /consistency and replayability unverified/);
    for (const [key, fingerprint] of Object.entries(metadata.environment)) {
      assert(!Object.hasOwn(fingerprint, 'value'));
      assert.equal(fingerprint.present, process.env[key] !== undefined);
      if (fingerprint.present) assert.equal(fingerprint.sha256, hash(process.env[key]));
    }
    const failure = JSON.parse(readFileSync(join(directory, 'failure.json'), 'utf8'));
    assert.equal(failure.direct_child_termination, 'unknown');
    assert.equal(failure.commit_state, 'not_inferred_from_transport');
    assert(fs.readdirSync(directory).length <= 7);
  } finally { f.control = true; } // An expected negative must not consume unexpected-failure retention capacity.
});

test('synthetic evidence omits oversized input and symlink files instead of truncating or following them', t => {
  const f = fixture(t);
  fs.renameSync(f.profiler, f.profiler + '.held'); fs.symlinkSync(f.profiler + '.held', f.profiler);
  captureSyntheticEvidence(f, 'x'.repeat(8 * 1024 * 1024), 'python3');
  const directory = join(f.directory, 'profiler-evidence');
  const metadata = JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8'));
  assert(metadata.omitted.some(row => row.name === 'input.json' && row.reason === 'capture_byte_cap'));
  assert(metadata.omitted.some(row => row.name === 'profiler.py' && row.reason === 'capture_unavailable'));
  assert.equal(fs.existsSync(join(directory, 'input.json')), false);
  assert.equal(fs.existsSync(join(directory, 'profiler.py')), false);
  const files = fs.readdirSync(directory); assert(files.length <= 7);
  assert(files.reduce((sum, name) => sum + fs.statSync(join(directory, name)).size, 0) <= 8 * 1024 * 1024);
});
