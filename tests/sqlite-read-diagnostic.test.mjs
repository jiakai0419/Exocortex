import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOnlySqliteJson, readSqliteReadDiagnostic, SqliteReadError } from '../src/storage/sqlite/readonly-query.mjs';
import { copySqliteReadDiagnostic, sqliteReadDiagnostic } from '../src/diagnostics/sqlite-read-diagnostic.mjs';
import { readMessageSnapshot } from '../src/diagnostics/message-read-snapshot.mjs';
import { runCli } from '../bin/exocortex.mjs';
import { CliExecutionError, writeCliError } from '../src/cli/context.mjs';

const PRIVATE = 'SYNTHETIC_PRIVATE_SQL_PATH_BODY_TOKEN';
const writer = () => { let value = ''; return { write(text) { value += text; }, value: () => value }; };
function observed(child, label = 'read message snapshot', extra = {}) {
  let error, calls = 0, ticks = 0;
  try {
    readOnlySqliteJson('/synthetic/' + PRIVATE, `SELECT '${PRIVATE}'`, label, {
      monotonicNowMs: () => ticks++ ? 21 : 4,
      spawnSync(command, args, options) {
        calls++;
        assert.equal(command, 'sqlite3'); assert.deepEqual(args.slice(0, 2), ['-readonly', '-json']);
        assert.equal(options.timeout, 30000); assert.equal(options.maxBuffer, 50 * 1024 * 1024);
        assert.equal(options.killSignal, 'SIGKILL'); assert(options.input.includes('PRAGMA query_only=ON;\nBEGIN;'));
        if (typeof child === 'function') return child();
        return child;
      }, ...extra,
    });
  } catch (caught) { error = caught; }
  assert(error instanceof SqliteReadError); assert.equal(calls, 1, 'Never retry a failed read.');
  const diagnostic = readSqliteReadDiagnostic(error);
  assert(diagnostic); assert(Object.isFrozen(diagnostic));
  assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(PRIVATE));
  return { error, diagnostic };
}

test('SQLite failure evidence retains the same child result and fixed query stage', async t => {
  const cases = [
    ['missing', { status: null, error: { code: 'ENOENT', message: PRIVATE } }, 'dependency_unavailable', 'dependency_unavailable', 'ENOENT', null],
    ['denied', { status: null, error: { code: 'EPERM', message: PRIVATE } }, 'read_failed', 'spawn_error', 'EPERM', null],
    ['access', { status: null, error: { code: 'EACCES', message: PRIVATE } }, 'read_failed', 'spawn_error', 'EACCES', null],
    ['timeout', { status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT', message: PRIVATE } }, 'read_timeout', 'timeout', 'ETIMEDOUT', 'SIGKILL'],
    ['buffer', { status: null, signal: 'SIGKILL', error: { code: 'ENOBUFS', message: PRIVATE } }, 'read_failed', 'output_limit', 'ENOBUFS', 'SIGKILL'],
    ['kill', { status: null, signal: 'SIGKILL' }, 'read_failed', 'process_signal', null, 'SIGKILL'],
    ['terminate', { status: null, signal: 'SIGTERM' }, 'read_failed', 'process_signal', null, 'SIGTERM'],
    ['unknown-code', { status: null, error: { code: PRIVATE, path: PRIVATE } }, 'read_failed', 'spawn_error', null, null],
    ['process', { status: 7, stderr: PRIVATE }, 'read_failed', 'process_exit', null, null],
    ['json', { status: 0, stdout: '{' + PRIVATE }, 'invalid_response', 'invalid_json', null, null],
    ['shape', { status: 0, stdout: JSON.stringify({ [PRIVATE]: PRIVATE }) }, 'invalid_response', 'invalid_shape', null, null],
    ['throw', () => { throw Object.assign(Error(PRIVATE), { code: 'EIO', stack: PRIVATE }); }, 'read_failed', 'spawn_error', 'EIO', null],
    ['missing-result', null, 'read_failed', 'unknown', null, null],
  ];
  for (const [name, child, reason, kind, code, signal] of cases) await t.test(name, () => {
    const { error, diagnostic } = observed(child);
    assert.equal(error.reason, reason); assert.equal(diagnostic.kind, kind); assert.equal(diagnostic.spawn_code, code);
    assert.equal(diagnostic.signal, signal); assert.equal(diagnostic.stage, 'snapshot_query');
    assert.equal(diagnostic.elapsed_ms, 17); assert.equal(diagnostic.timeout_ms, 30000);
    assert.equal(diagnostic.max_buffer_bytes, 52428800);
  });
  assert.equal(observed({ status: 1 }, 'read message snapshot schema').diagnostic.stage, 'schema_query');
  assert.equal(observed({ status: 1 }).diagnostic.stdout_bytes, null);
  assert.equal(observed({ status: 1, stdout: '', stderr: Buffer.alloc(0) }).diagnostic.stdout_bytes, 0);
  assert.equal(observed({ status: 1, stdout: '', stderr: Buffer.alloc(0) }).diagnostic.stderr_bytes, 0);
  assert.equal(observed({ status: 1 }, PRIVATE).diagnostic.stage, 'sqlite_query');
  assert.equal(observed({ status: 1 }, 'read message snapshot', { monotonicNowMs: () => NaN }).diagnostic.elapsed_ms, null);
  let clock = 2;
  assert.equal(observed({ status: 1 }, 'read message snapshot', { monotonicNowMs: () => clock-- }).diagnostic.elapsed_ms, null);
  assert.equal(observed({ status: 1 }, 'read message snapshot', { monotonicNowMs() { throw Error(PRIVATE); } }).diagnostic.elapsed_ms, null);
});

test('fixed SQLite classes never forward paths, SQL or arbitrary diagnostic text', () => {
  const cases = [
    ['Runtime error near line 5: database is locked (5)', 'busy'],
    ['Runtime error near line 5: database is locked (517)', 'busy'],
    ['Runtime error near line 5: database is locked (19)', 'unknown'],
    ['Runtime error near line 5: database disk image is malformed (5)', 'unknown'],
    ['Runtime error near line 5: database is locked (0)', 'unknown'],
    ['Runtime error near line 5: database is locked (999999999999999999)', 'unknown'],
    ['Runtime error near line 9: database table is locked (6)', 'locked'],
    [`Parse error near line 5: no such table: ${PRIVATE}`, 'schema_missing'],
    [`Parse error near line 5: no such column: ${PRIVATE}`, 'schema_missing'],
    ['Error: in prepare, database schema has changed (17)', 'schema_changed'],
    [`Parse error near line 5: near "${PRIVATE}": syntax error`, 'syntax'],
    ['Runtime error near line 5: database disk image is malformed (11)', 'corrupt'],
    ['Error: file is not a database (26)', 'not_database'],
    [`Error: unable to open database "/${PRIVATE}": unable to open database file`, 'open_failed'],
    ['Runtime error near line 5: disk I/O error (10)', 'io'],
    ['Runtime error near line 5: database or disk is full (13)', 'full'],
    ['Runtime error near line 5: attempt to write a readonly database (8)', 'readonly'],
    ['Runtime error near line 5: interrupted (9)', 'interrupted'],
    ['Error: out of memory (7)', 'memory'],
    ['Runtime error near line 5: string or blob too big (18)', 'size_limit'],
    [`${PRIVATE} database is locked`, 'unknown'],
    [`${PRIVATE}\nRuntime error near line 5: database is locked (5)`, 'unknown'],
    [`Runtime error near line 5: ${PRIVATE}`, 'unknown'],
    [`${'x'.repeat(2048)}Runtime error near line 5: database is locked (5)`, 'unknown'],
  ];
  for (const [stderr, expected] of cases) {
    const { diagnostic } = observed({ status: 1, stdout: PRIVATE + '雪', stderr });
    assert.equal(diagnostic.sqlite_kind, expected); assert.equal(diagnostic.stdout_bytes, Buffer.byteLength(PRIVATE + '雪'));
    assert.equal(diagnostic.stderr_bytes, Buffer.byteLength(stderr));
  }
  assert.equal(observed({ status: null, error: { code: 'EPERM' }, stderr: cases[0][0] }).diagnostic.sqlite_kind, 'unknown');
  for (const status of [undefined, null, '1', -1, 256, 1.5]) {
    const diagnostic = observed({ status, stderr: cases[0][0] }).diagnostic;
    assert.equal(diagnostic.sqlite_kind, 'unknown'); assert.equal(diagnostic.kind, 'unknown');
  }
  const prefix = 'Runtime error: database is locked (';
  const longLine = prefix + '5'.repeat(2048 - prefix.length - 1) + ')' + ' extra text';
  assert.equal(observed({ status: 1, stderr: longLine }).diagnostic.sqlite_kind, 'unknown');
});

test('snapshot validation is distinguished from a failed SQLite child', () => {
  assert.throws(() => readMessageSnapshot('/synthetic/unused', {}, { sqliteJson: () => [{ name: PRIVATE }] }), error => {
    const diagnostic = readSqliteReadDiagnostic(error);
    assert.equal(diagnostic.stage, 'snapshot_validate'); assert.equal(diagnostic.kind, 'invalid_shape');
    for (const key of ['status', 'signal', 'spawn_code', 'elapsed_ms', 'timeout_ms', 'stdout_bytes', 'stderr_bytes']) assert.equal(diagnostic[key], null);
    return true;
  });
  assert.equal(readSqliteReadDiagnostic({ name: 'SqliteReadError', reason: 'read_failed', readDiagnostic: PRIVATE }), null);
  assert.equal(readSqliteReadDiagnostic(new SqliteReadError('read_failed', PRIVATE)), null);
});

test('CLI boundaries preserve finite evidence without allowing forged or extended structures', async () => {
  const { error, diagnostic } = observed({ status: 1, stderr: `Parse error near line 5: no such table: ${PRIVATE}` });
  for (const format of ['json', 'text']) {
    const stdout = writer(), stderr = writer();
    assert.equal(await runCli(['messages', '--db', '/synthetic/' + PRIVATE, '--format', format], { stdout, stderr,
      deps: { existsSync: () => true, readLocalChatAppNames: () => null, loadMessages() { throw error; } } }), 1);
    assert.doesNotMatch(stdout.value() + stderr.value(), new RegExp(`${PRIVATE}|SELECT|Parse error|synthetic/`));
    if (format === 'json') assert.deepEqual(JSON.parse(stdout.value()).error.read_diagnostic, diagnostic);
    else assert.match(stderr.value(), /Read diagnostic: stage=snapshot_query kind=process_exit/);
  }
  for (const value of [
    { ...diagnostic, detail: PRIVATE }, { ...diagnostic, stage: PRIVATE }, { ...diagnostic, signal: PRIVATE },
    { ...diagnostic, spawn_code: PRIVATE }, { ...diagnostic, status: 999 }, { ...diagnostic, elapsed_ms: NaN },
    { ...diagnostic, stderr_bytes: -1 }, Object.defineProperty({ ...diagnostic }, 'kind', { get() { throw Error(PRIVATE); } }),
  ]) {
    assert.equal(copySqliteReadDiagnostic(value), null);
    const stdout = writer(), stderr = writer();
    writeCliError({ stdout, stderr }, { code: 'execution_failed', message: 'Fixed message', format: 'json', reason: 'read_failed', readDiagnostic: value });
    assert.equal(JSON.parse(stdout.value()).error.read_diagnostic, undefined); assert.doesNotMatch(stdout.value(), new RegExp(PRIVATE));
  }
  assert.equal(new CliExecutionError('Fixed message', 'not-public', diagnostic).readDiagnostic, null);
});

test('actual messages bin reports schema and data failures while preserving source bytes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-read-diagnostic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'invented.sqlite'), sqlite = join(dir, 'sqlite3');
  writeFileSync(db, '', { mode: 0o600 });
  for (const stage of ['schema_query', 'snapshot_query']) {
    writeFileSync(sqlite, `#!${process.execPath}\nimport{readFileSync}from'node:fs';import{spawnSync}from'node:child_process';
const sql=readFileSync(0,'utf8'),args=process.argv.slice(2);if(args[0]!=='-readonly'||args[1]!=='-json')process.exit(9);
if(${JSON.stringify(stage)}==='snapshot_query'&&sql.includes('SELECT name FROM sqlite_schema')){const r=spawnSync('/usr/bin/sqlite3',args,{input:sql,encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??9);}
process.stderr.write('Runtime error near line 5: database is locked (5)\\n${PRIVATE}');process.exit(5);\n`);
    chmodSync(sqlite, 0o700);
    for (const format of ['json', 'text']) {
      const result = spawnSync(process.execPath, ['bin/exocortex.mjs', 'messages', '--db', db, '--limit', '100', '--format', format], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, env: { ...process.env, PATH: dir },
      });
      assert.ifError(result.error); assert.equal(result.status, 1);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(PRIVATE));
      assert(!(result.stdout + result.stderr).includes(dir));
      if (format === 'json') {
        const report = JSON.parse(result.stdout); assert.equal(report.error.reason, 'read_failed');
        assert.equal(report.error.read_diagnostic.stage, stage); assert.equal(report.error.read_diagnostic.kind, 'process_exit');
        assert.equal(report.error.read_diagnostic.status, 5); assert.equal(report.error.read_diagnostic.sqlite_kind, 'busy');
        assert.equal(report.error.read_diagnostic.timeout_ms, 30000); assert.equal(report.error.read_diagnostic.max_buffer_bytes, 52428800);
      } else assert(result.stderr.includes('stage=' + stage));
      assert.equal(readFileSync(db).length, 0);
    }
  }
});
