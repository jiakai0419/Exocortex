import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readOnlySqliteJsonLines, readSqliteReadDiagnostic, SqliteReadError } from '../src/storage/sqlite/readonly-query.mjs';

// Authored data only. The real cases use a private, newly created SQLite file.
const BEGIN = '__EXOCORTEX_JSON_LINES_BEGIN_V1__';
const END = '__EXOCORTEX_JSON_LINES_END_V1__';
const PRIVATE = 'SYNTHETIC_PRIVATE_WIRE_VALUE';
const frame = rows => `${BEGIN}\n${rows.map(row => JSON.stringify(row) + '\n').join('')}${END}\n`;
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const textSql = value => value === null ? 'NULL' : `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`;
function mocked(child, extra = {}) {
  const db = '/synthetic/wire name;$(must-not-run).sqlite';
  const sql = "SELECT json_object('authored','wire');";
  let calls = 0, ticks = 0;
  const value = () => readOnlySqliteJsonLines(db, sql, 'read message snapshot', {
    monotonicNowMs: () => ticks++ ? 23 : 6,
    spawnSync(command, args, options) {
      calls++;
      assert.equal(command, 'sqlite3');
      assert.deepEqual(args, ['-readonly', '-batch', '-init', '/dev/null', '-noheader', '-list', resolve(db)]);
      assert.notEqual(options.shell, true, 'SQL and path are never shell code');
      assert.equal(options.encoding, 'utf8');
      assert.equal(options.maxBuffer, 50 * 1024 * 1024);
      assert.equal(options.killSignal, 'SIGKILL');
      assert.equal(options.input, `.bail on\n.timeout 5000\nPRAGMA query_only=ON;\nBEGIN;\n.print ${BEGIN}\n${sql}\nCOMMIT;\n.print ${END}\n`);
      if (extra.expectedTimeout !== undefined) assert.equal(options.timeout, extra.expectedTimeout);
      if (typeof child === 'function') return child();
      return child;
    }, ...extra,
  });
  return { value, calls: () => calls };
}
function malformed(output) {
  const f = mocked({ status: 0, stdout: output });
  assert.throws(f.value, error => {
    assert(error instanceof SqliteReadError);
    assert.equal(error.reason, 'invalid_response');
    const diagnostic = readSqliteReadDiagnostic(error);
    assert.equal(diagnostic.stage, 'snapshot_query');
    assert(['invalid_json', 'invalid_shape'].includes(diagnostic.kind));
    assert.equal(diagnostic.status, 0);
    assert.equal(diagnostic.elapsed_ms, 17);
    return true;
  });
  assert.equal(f.calls(), 1, 'invalid wire is not retried');
}

test('JSONL preserves object order, empty frames, CRLF and escaped sentinel-like values', () => {
  const rows = [
    { ordinal: 1, body: `  ${BEGIN}\n${END}\r\n\0雪😀\t\\\"  `, nullable: null, empty: '' },
    { ordinal: 2, raw_json: ' { "id": 9007199254740993, "dup":1, "dup":2, "escape":"\\u0041" }\n' },
  ];
  for (const output of [frame(rows), frame(rows).replaceAll('\n', '\r\n'), frame(rows).slice(0, -1)]) {
    const f = mocked({ status: 0, stdout: output }, { expectedTimeout: 30000 });
    assert.deepEqual(f.value(), rows); assert.equal(f.calls(), 1);
  }
  for (const output of [frame([]), `${BEGIN}\r\n${END}\r\n`]) {
    assert.deepEqual(mocked({ status: 0, stdout: output }).value(), []);
  }
});

const invalidFrames = [
  ['empty stdout', ''], ['whitespace stdout', ' \n'], ['no frame', '{"authored":1}\n'],
  ['missing begin', `{\"authored\":1}\n${END}\n`],
  ['missing end', `${BEGIN}\n{"authored":1}\n`],
  ['truncated end', `${BEGIN}\n{}\n${END.slice(0, -1)}`],
  ['reversed markers', `${END}\n${BEGIN}\n`],
  ['duplicated frame', frame([]) + frame([])],
  ['duplicate begin', `${BEGIN}\n${BEGIN}\n{}\n${END}\n`],
  ['duplicate end', frame([{}]) + `${END}\n`],
  ['leading output', '{}' + '\n' + frame([{}])],
  ['trailing output', frame([{}]) + '{}\n'],
  ['leading blank', '\n' + frame([{}])],
  ['extra trailing blank', frame([{}]) + '\n'],
  ['blank data row', `${BEGIN}\n\n${END}\n`],
  ['whitespace data row', `${BEGIN}\n \n${END}\n`],
  ['partial JSON', `${BEGIN}\n{"unfinished":\n${END}\n`],
  ['two values on one line', `${BEGIN}\n{}{}\n${END}\n`],
  ['literal NUL', `${BEGIN}\n{"body":"a\0b"}\n${END}\n`],
  ['unquoted marker in row', `${BEGIN}\n${END}\n{}\n${END}\n`],
  ['null row', `${BEGIN}\nnull\n${END}\n`],
  ['array row', `${BEGIN}\n[]\n${END}\n`],
  ['string row', `${BEGIN}\n"authored"\n${END}\n`],
  ['number row', `${BEGIN}\n12\n${END}\n`],
  ['boolean row', `${BEGIN}\nfalse\n${END}\n`],
];
for (const [label, output] of invalidFrames) test(`JSONL rejects ${label}`, () => malformed(output));

const failures = [
  ['nonzero after valid frame', { status: 7, stdout: frame([{}]), stderr: PRIVATE }, 'read_failed', 'process_exit'],
  ['signal after valid frame', { status: 0, signal: 'SIGKILL', stdout: frame([{}]) }, 'read_failed', 'process_signal'],
  ['timeout with valid prefix', { status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' }, stdout: `${BEGIN}\n{}\n` }, 'read_timeout', 'timeout'],
  ['buffer overflow with full frame', { status: null, signal: 'SIGKILL', error: { code: 'ENOBUFS' }, stdout: frame([{}]) }, 'read_failed', 'output_limit'],
  ['missing executable', { status: null, error: { code: 'ENOENT', message: PRIVATE } }, 'dependency_unavailable', 'dependency_unavailable'],
  ['spawn denied', { status: null, error: { code: 'EPERM', message: PRIVATE } }, 'read_failed', 'spawn_error'],
  ['thrown spawn', () => { throw Object.assign(Error(PRIVATE), { code: 'EIO' }); }, 'read_failed', 'spawn_error'],
  ['missing child result', null, 'read_failed', 'unknown'],
];
for (const [label, child, reason, kind] of failures) test(`JSONL preserves ${label} as an execution failure`, () => {
  const f = mocked(child);
  assert.throws(f.value, error => {
    assert(error instanceof SqliteReadError); assert.equal(error.reason, reason);
    const diagnostic = readSqliteReadDiagnostic(error);
    assert.equal(diagnostic.kind, kind); assert.equal(diagnostic.stage, 'snapshot_query');
    assert.equal(diagnostic.elapsed_ms, 17); assert.equal(diagnostic.timeout_ms, 30000);
    assert.equal(diagnostic.max_buffer_bytes, 50 * 1024 * 1024);
    assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(PRIVATE));
    assert.doesNotMatch(error.message, new RegExp(PRIVATE));
    return true;
  });
  assert.equal(f.calls(), 1);
});

test('JSONL keeps the existing bounded timeout contract', () => {
  for (const [timeoutMs, expectedTimeout] of [[1, 1], [9000, 9000], [31000, 30000], [0, 30000], [NaN, 30000], [1.5, 30000]]) {
    assert.deepEqual(mocked({ status: 0, stdout: frame([]) }, { timeoutMs, expectedTimeout }).value(), []);
  }
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-json-lines-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'authored "quote";$(no-shell).sqlite');
  const source = [
    { body: `  first\n${BEGIN}\r\n${END}\0 雪 😀 \t \\ \"  `,
      raw: '{"id":18446744073709551617,"fraction":0.123456789012345678901,"dup":1,"dup":2}',
      canonical: ' { "overflow":1e400, "escape":"\\u0041", "nested":"{\\\"key\\\":1}" }\n', note: null },
    { body: '', raw: 'not JSON\n"\\\0', canonical: '{partial', note: 'authored' },
    { body: null, raw: '', canonical: null, note: '' },
  ];
  const sql = `CREATE TABLE authored(id INTEGER PRIMARY KEY,body TEXT,raw_json TEXT,canonical_json TEXT,note TEXT);\n`
    + source.map((row, index) => `INSERT INTO authored VALUES(${index + 1},${[row.body, row.raw, row.canonical, row.note].map(textSql).join(',')});`).join('\n');
  const created = spawnSync('sqlite3', ['-batch', '-init', '/dev/null', db], { input: sql, encoding: 'utf8', timeout: 5000 });
  assert.ifError(created.error); assert.equal(created.status, 0, created.stderr); assert.equal(created.stderr, '');
  return { dir, db, source };
}

test('actual SQLite JSONL preserves exact source TEXT, NULL and nested wire payload without shell interpretation', t => {
  const f = fixture(t), before = hash(f.db);
  const rows = readOnlySqliteJsonLines(f.db, `SELECT json_object('kind','row','position',id,
    'payload',json_object('body',body,'raw_json',raw_json,'canonical_json',canonical_json,'note',note) || '')
    FROM authored ORDER BY id;`, 'read message snapshot', { timeoutMs: 5000 });
  assert.equal(rows.length, f.source.length);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.kind, 'row'); assert.equal(row.position, index + 1); assert.equal(typeof row.payload, 'string');
    const decoded = JSON.parse(row.payload), expected = f.source[index];
    assert.deepEqual(decoded, { body: expected.body, raw_json: expected.raw, canonical_json: expected.canonical, note: expected.note });
    for (const [key, original] of Object.entries(decoded)) if (original !== null) {
      const source = { body: expected.body, raw_json: expected.raw, canonical_json: expected.canonical, note: expected.note }[key];
      assert.deepEqual(Buffer.from(original, 'utf8'), Buffer.from(source, 'utf8'), `${key} original UTF-8 bytes`);
    }
  }
  assert.equal(hash(f.db), before, 'successful read must leave source DB bytes unchanged');
  assert(!existsSync(join(f.dir, 'no-shell')), 'path punctuation is never interpreted as a command');
});

test('actual SQLite JSONL accepts zero query rows and rejects a scalar or multiple columns', t => {
  const f = fixture(t), before = hash(f.db);
  assert.deepEqual(readOnlySqliteJsonLines(f.db, "SELECT json_object('id',id) FROM authored WHERE 0;", 'read message snapshot'), []);
  for (const sql of ["SELECT '1';", "SELECT json_object('id',1),json_object('id',2);"]) {
    assert.throws(() => readOnlySqliteJsonLines(f.db, sql, 'read message snapshot'),
      error => error instanceof SqliteReadError && error.reason === 'invalid_response');
  }
  assert.equal(hash(f.db), before);
});

test('actual SQLite JSONL refuses writes and missing databases without initializing or repairing paths', t => {
  const f = fixture(t), before = hash(f.db);
  assert.throws(() => readOnlySqliteJsonLines(f.db, "UPDATE authored SET body='not committed'; SELECT json_object('id',1);", 'read message snapshot'), error => {
    assert(error instanceof SqliteReadError); assert.equal(error.reason, 'read_failed');
    assert.equal(readSqliteReadDiagnostic(error).kind, 'process_exit');
    return true;
  });
  assert.equal(hash(f.db), before);
  const missing = join(f.dir, 'not-created', 'missing.sqlite');
  assert.throws(() => readOnlySqliteJsonLines(missing, "SELECT json_object('id',1);", 'read message snapshot'),
    error => error instanceof SqliteReadError && error.reason === 'read_failed');
  assert(!existsSync(join(f.dir, 'not-created'))); assert(!existsSync(missing));
});


test('actual SQLite JSONL bypasses a private hostile sqliterc without changing the process HOME', t => {
  const f = fixture(t), before = hash(f.db), originalHome = process.env.HOME;
  const syntheticHome = join(f.dir, 'authored-home'), marker = 'SYNTHETIC_SQLITERC_EXECUTED';
  const sideEffect = join(syntheticHome, 'rc-executed.log');
  mkdirSync(syntheticHome, {mode:0o700});
  writeFileSync(join(syntheticHome, '.sqliterc'), `.log ${JSON.stringify(sideEffect)}\n.print ${marker}\n`, {mode:0o600});
  const env = {...process.env, HOME:syntheticHome};
  const sql = "SELECT json_object('authored','private rc isolation');";
  // Explicit-init control proves the authored rc is executable. Some SQLite
  // builds skip default rc loading in batch mode, so do not assume that behavior.
  // This opens only a fixture log; there is no .shell or external API.
  const control = spawnSync('sqlite3', ['-readonly','-batch','-init',join(syntheticHome,'.sqliterc'),f.db], {input:sql,encoding:'utf8',timeout:5000,env});
  assert.ifError(control.error); assert.equal(control.status,0,control.stderr);
  assert(control.stdout.includes(marker)); assert(existsSync(sideEffect));
  rmSync(sideEffect);
  let calls=0;
  const rows=readOnlySqliteJsonLines(f.db,sql,'read message snapshot',{timeoutMs:5000,
    spawnSync(command,args,options){calls++;return spawnSync(command,args,{...options,env});}});
  assert.equal(calls,1);assert.deepEqual(rows,[{authored:'private rc isolation'}]);
  assert(!existsSync(sideEffect),'explicit empty init prevents the rc side effect');
  assert.equal(process.env.HOME,originalHome,'only the subprocess receives a synthetic HOME');
  assert.equal(hash(f.db),before);
});
