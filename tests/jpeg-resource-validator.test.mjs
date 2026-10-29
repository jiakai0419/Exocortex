import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync, appendFileSync, chmodSync, constants, copyFileSync, existsSync,
  linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateJpegResource } from '../src/adapters/lark-im/jpeg-resource-validator.mjs';

// Authored pixels and installation copies only. No network, business data,
// production installation, decoder source modification, or image files.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installedHelper = process.env.EXOCORTEX_JPEG_VALIDATOR ?? join(repository, 'build/native/jpeg-validator');
const prefixes = process.env.EXOCORTEX_LIBJPEG_PREFIX ? [process.env.EXOCORTEX_LIBJPEG_PREFIX] : [
  '/opt/homebrew/opt/jpeg-turbo', '/usr/local/opt/jpeg-turbo', '/usr/local', '/usr',
];
const prefix = prefixes.find(path => existsSync(join(path, 'bin/cjpeg')));
const dimensions = { width: 13, height: 11 };
const unavailable = { reason: 'resource_decoder_unavailable' };
const imageResult = { image: { mime_type: 'image/jpeg', ...dimensions } };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function dependencies() {
  assert.ok(isAbsolute(installedHelper), 'EXOCORTEX_JPEG_VALIDATOR must be absolute.');
  assert.ok(existsSync(installedHelper) && existsSync(`${installedHelper}.json`),
    'Build the strict JPEG helper and receipt with npm run build:jpeg before this test; missing dependencies must not skip validation.');
  accessSync(installedHelper, constants.X_OK);
  assert.ok(prefix, 'Set EXOCORTEX_LIBJPEG_PREFIX to an installed libjpeg-turbo distribution containing bin/cjpeg.');
}

function syntheticJpeg() {
  const pixels = Buffer.from(Array.from({ length: dimensions.width * dimensions.height }, (_, index) => (index * 37 + 19) & 255));
  const input = Buffer.concat([Buffer.from(`P5\n${dimensions.width} ${dimensions.height}\n255\n`), pixels]);
  const encoded = spawnSync(join(prefix, 'bin/cjpeg'), ['-grayscale', '-quality', '83'], {
    input, timeout: 10000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL',
  });
  assert.ifError(encoded.error);
  assert.equal(encoded.signal, null);
  assert.equal(encoded.status, 0, 'Synthetic pixels must encode successfully.');
  assert.equal(encoded.stderr.length, 0);
  return encoded.stdout;
}

function installation(parent, name) {
  const directory = join(parent, name);
  mkdirSync(directory, { mode: 0o700 });
  const helper = join(directory, 'jpeg-validator');
  copyFileSync(installedHelper, helper);
  copyFileSync(`${installedHelper}.json`, `${helper}.json`);
  chmodSync(helper, 0o700); chmodSync(`${helper}.json`, 0o600);
  const receipt = JSON.parse(readFileSync(`${helper}.json`, 'utf8'));
  return { directory, helper, receipt, env: { EXOCORTEX_JPEG_VALIDATOR: helper, SYNTHETIC_SECRET: 'must-not-reach-child' } };
}

function validResponse(receipt, changes = {}) {
  return { version: 1, status: 'valid', ...dimensions, scans: 1, decoder: 'libjpeg-turbo', decoder_version: receipt.decoder_version, ...changes };
}

function processResult(response, changes = {}) {
  return { status: 0, signal: null, error: undefined, stdout: JSON.stringify(response), stderr: '', ...changes };
}

function rewriteReceipt(install, change) {
  const receipt = { ...install.receipt };
  change(receipt);
  writeFileSync(`${install.helper}.json`, JSON.stringify(receipt));
}

test('JPEG resource wrapper validates its installation, bounded process and finite protocol', async t => {
  dependencies();
  const temporary = mkdtempSync(join(tmpdir(), 'synthetic-jpeg-wrapper-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const bytes = syntheticJpeg(), originalBytes = Buffer.from(bytes);
  const baseline = installation(temporary, 'baseline');

  await t.test('real current helper accepts authored pixels and creates no image files', () => {
    assert.equal(baseline.receipt.binary_sha256, sha(readFileSync(baseline.helper)));
    assert.equal(baseline.receipt.source_sha256, sha(readFileSync(join(repository, 'src/native/jpeg-validator.c'))),
      'C source changed after build: rebuild the helper before testing.');
    assert.equal(baseline.receipt.archive_sha256, sha(readFileSync(join(prefix, 'lib/libjpeg.a'))),
      'Build and test must use the same installed libjpeg-turbo prefix.');
    const headers = ['jpeglib.h', 'jconfig.h', 'jmorecfg.h', 'jerror.h'].map(name => readFileSync(join(prefix, 'include', name)));
    assert.equal(baseline.receipt.headers_sha256, sha(Buffer.concat(headers)),
      'The receipt must record all four compilation headers, including jerror.h.');
    const names = readdirSync(baseline.directory).sort();
    assert.deepEqual(validateJpegResource(bytes, dimensions, { env: baseline.env }), imageResult);
    assert.deepEqual(validateJpegResource(bytes, undefined, { env: baseline.env }), imageResult);
    assert.deepEqual(validateJpegResource(Buffer.from('ffd8ffd9', 'hex'), dimensions, { env: baseline.env }), { reason: 'resource_image_invalid' });
    assert.deepEqual(readdirSync(baseline.directory).sort(), names);
    assert.deepEqual(bytes, originalBytes);
  });

  await t.test('only stdin carries bytes; invocation has fixed budgets and a minimal environment', () => {
    let calls = 0;
    const names = readdirSync(baseline.directory).sort();
    const result = validateJpegResource(bytes, dimensions, { env: baseline.env, spawnSync(command, args, options) {
      calls++;
      assert.equal(command, realpathSync(baseline.helper)); assert.deepEqual(args, []);
      assert.equal(options.input, bytes);
      assert.deepEqual(options, { input: bytes, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 8192,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' } });
      return processResult(validResponse(baseline.receipt));
    } });
    assert.deepEqual(result, imageResult); assert.equal(calls, 1);
    assert.deepEqual(readdirSync(baseline.directory).sort(), names);
    assert.deepEqual(bytes, originalBytes);
  });

  await t.test('missing, stale, malformed or unsafe installations fail before any spawn', async t => {
    const cases = [
      ['missing-helper', i => rmSync(i.helper)],
      ['missing-receipt', i => rmSync(`${i.helper}.json`)],
      ['directory-helper', i => { rmSync(i.helper); mkdirSync(i.helper); }],
      ['empty-helper', i => writeFileSync(i.helper, '')],
      ['changed-binary', i => appendFileSync(i.helper, Buffer.from([0]))],
      ['bad-binary-hash', i => rewriteReceipt(i, r => { r.binary_sha256 = '0'.repeat(64); })],
      ['stale-source-hash', i => rewriteReceipt(i, r => { r.source_sha256 = '0'.repeat(64); })],
      ['bad-archive-hash', i => rewriteReceipt(i, r => { r.archive_sha256 = 'not-a-hash'; })],
      ['bad-headers-hash', i => rewriteReceipt(i, r => { r.headers_sha256 = 'f'.repeat(63); })],
      ['wrong-platform', i => rewriteReceipt(i, r => { r.platform = 'synthetic-other-platform'; })],
      ['wrong-arch', i => rewriteReceipt(i, r => { r.arch = 'synthetic-other-arch'; })],
      ['wrong-version', i => rewriteReceipt(i, r => { r.version = 2; })],
      ['wrong-protocol', i => rewriteReceipt(i, r => { r.protocol = 'unknown/v1'; })],
      ['wrong-decoder', i => rewriteReceipt(i, r => { r.decoder = 'tolerant-converter'; })],
      ['wrong-decoder-version', i => rewriteReceipt(i, r => { r.decoder_version = '3.1'; })],
      ['extra-receipt-key', i => rewriteReceipt(i, r => { r.extra = true; })],
      ['missing-receipt-key', i => rewriteReceipt(i, r => { delete r.archive_sha256; })],
      ['duplicate-receipt-key', i => writeFileSync(`${i.helper}.json`, JSON.stringify(i.receipt).replace('{', '{"version":1,'))],
      ['invalid-receipt-json', i => writeFileSync(`${i.helper}.json`, '{')],
      ['empty-receipt', i => writeFileSync(`${i.helper}.json`, '')],
      ['oversized-receipt', i => writeFileSync(`${i.helper}.json`, JSON.stringify(i.receipt) + ' '.repeat(8193))],
      ['helper-group-writable', i => chmodSync(i.helper, 0o720)],
      ['helper-world-writable', i => chmodSync(i.helper, 0o702)],
      ['helper-not-executable', i => chmodSync(i.helper, 0o600)],
      ['receipt-group-writable', i => chmodSync(`${i.helper}.json`, 0o620)],
      ['receipt-world-writable', i => chmodSync(`${i.helper}.json`, 0o602)],
      ['helper-hardlink', i => linkSync(i.helper, join(i.directory, 'linked-helper'))],
      ['receipt-hardlink', i => linkSync(`${i.helper}.json`, join(i.directory, 'linked-receipt'))],
      ['receipt-symlink', i => {
        const target = join(i.directory, 'receipt-target'); copyFileSync(`${i.helper}.json`, target);
        rmSync(`${i.helper}.json`); symlinkSync(target, `${i.helper}.json`);
      }],
    ];
    for (const [name, change] of cases) await t.test(name, () => {
      const install = installation(temporary, name); change(install);
      let calls = 0;
      assert.deepEqual(validateJpegResource(bytes, dimensions, { env: install.env, spawnSync() { calls++; return processResult(validResponse(install.receipt)); } }), unavailable);
      assert.equal(calls, 0);
    });
    for (const path of ['relative/helper', '', '/synthetic/does-not-exist/jpeg-validator', '/tmp/bad\nhelper', '/' + 'a'.repeat(8193)]) {
      let calls = 0;
      assert.deepEqual(validateJpegResource(bytes, dimensions, { env: { EXOCORTEX_JPEG_VALIDATOR: path }, spawnSync() { calls++; } }), unavailable);
      assert.equal(calls, 0);
    }
  });

  await t.test('helper and receipt must still be unchanged after execution', async t => {
    for (const [name, mutate] of [
      ['mutated-helper', i => appendFileSync(i.helper, Buffer.from([0]))],
      ['mutated-receipt', i => appendFileSync(`${i.helper}.json`, '\n')],
      ['removed-helper', i => rmSync(i.helper)],
      ['removed-receipt', i => rmSync(`${i.helper}.json`)],
      ['writable-after-spawn', i => chmodSync(i.helper, 0o722)],
    ]) await t.test(name, () => {
      const install = installation(temporary, name);
      assert.deepEqual(validateJpegResource(bytes, dimensions, { env: install.env, spawnSync() {
        mutate(install); return processResult(validResponse(install.receipt));
      } }), unavailable);
    });
  });

  await t.test('protocol rejects malformed, duplicate, extra, mismatched and unbounded claims', async t => {
    const valid = validResponse(baseline.receipt);
    const responses = [
      ['invalid-json', '{'], ['multiple-json-values', JSON.stringify(valid) + '{}'],
      ['trailing-diagnostics', JSON.stringify(valid) + '\nSYNTHETIC-PRIVATE-CONTENT'],
      ['array', JSON.stringify([valid])], ['null', 'null'], ['empty-output', ''],
      ['duplicate-status', JSON.stringify(valid).replace('{', '{"status":"invalid",')],
      ['unknown-status', JSON.stringify({ version: 1, status: 'unknown' })],
      ['wrong-version', JSON.stringify({ ...valid, version: 2 })],
      ['string-version', JSON.stringify({ ...valid, version: '1' })],
      ['extra-key', JSON.stringify({ ...valid, source: 'SYNTHETIC-PRIVATE-CONTENT' })],
      ['missing-key', JSON.stringify(Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'scans')))],
      ['wrong-width', JSON.stringify({ ...valid, width: dimensions.width + 1 })],
      ['wrong-height', JSON.stringify({ ...valid, height: dimensions.height + 1 })],
      ['string-width', JSON.stringify({ ...valid, width: String(dimensions.width) })],
      ['no-scans', JSON.stringify({ ...valid, scans: 0 })],
      ['too-many-scans', JSON.stringify({ ...valid, scans: 101 })],
      ['fractional-scans', JSON.stringify({ ...valid, scans: 1.5 })],
      ['wrong-decoder', JSON.stringify({ ...valid, decoder: 'other' })],
      ['wrong-decoder-version', JSON.stringify({ ...valid, decoder_version: '0.0.0' })],
    ];
    for (const [name, stdout] of responses) await t.test(name, () => {
      assert.deepEqual(validateJpegResource(bytes, dimensions, { env: baseline.env,
        spawnSync: () => processResult(valid, { stdout }) }), unavailable);
    });
    for (const response of [
      { ...valid, width: 0 }, { ...valid, height: -1 }, { ...valid, width: 1.5 },
      { ...valid, height: '11' }, { ...valid, width: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, width: 4096, height: 4097 }, { ...valid, width: null },
      { ...valid, width: 65536, height: 1 }, { ...valid, width: 1, height: 65536 },
    ]) {
      assert.deepEqual(validateJpegResource(bytes, undefined, { env: baseline.env,
        spawnSync: () => processResult(response) }), unavailable);
    }
  });

  await t.test('finite error classifications require the exact matching exit code and schema', () => {
    const failures = [
      ['invalid', 10, 'resource_image_invalid'], ['unsupported', 11, 'resource_format_unsupported'],
      ['limit', 12, 'resource_validation_limit'], ['internal', 13, 'resource_decoder_unavailable'],
    ];
    for (const [status, exit, reason] of failures) {
      const response = { version: 1, status };
      const run = (changes = {}, body = response) => validateJpegResource(bytes, dimensions, { env: baseline.env,
        spawnSync: () => processResult(body, { status: exit, ...changes }) });
      assert.deepEqual(run(), { reason });
      for (const wrong of [0, 1, 9, 14, null, ...failures.map(item => item[1]).filter(code => code !== exit)]) {
        assert.deepEqual(run({ status: wrong }), unavailable);
      }
      assert.deepEqual(run({}, { ...response, detail: 'SYNTHETIC-PRIVATE-CONTENT' }), unavailable);
    }
    for (const status of [1, 10, 11, 12, 13, null]) {
      assert.deepEqual(validateJpegResource(bytes, dimensions, { env: baseline.env,
        spawnSync: () => processResult(validResponse(baseline.receipt), { status }) }), unavailable);
    }
  });

  await t.test('timeout, signal, stderr and spawn errors never expose raw diagnostics', () => {
    const cases = [
      [{ error: Object.assign(new Error('SYNTHETIC-PRIVATE-CONTENT'), { code: 'ETIMEDOUT' }), status: null }, 'resource_validation_limit'],
      [{ signal: 'SIGKILL', status: null }, 'resource_decoder_unavailable'],
      [{ error: Object.assign(new Error('SYNTHETIC-PRIVATE-CONTENT'), { code: 'ETIMEDOUT' }), signal: 'SIGKILL', status: null }, 'resource_validation_limit'],
      [{ signal: 'SIGXCPU', status: null }, 'resource_validation_limit'],
      [{ signal: 'SIGSEGV', status: null }, 'resource_decoder_unavailable'],
      [{ signal: 'SIGTERM', status: null }, 'resource_decoder_unavailable'],
      ...['ENOENT', 'EACCES', 'ENOBUFS'].map(code => [{ error: Object.assign(new Error('SYNTHETIC-PRIVATE-CONTENT'), { code }), status: null }, 'resource_decoder_unavailable']),
      [{ stderr: 'SYNTHETIC-PRIVATE-CONTENT' }, 'resource_decoder_unavailable'],
      [{ stderr: '\n' }, 'resource_decoder_unavailable'],
    ];
    for (const [changes, reason] of cases) {
      assert.deepEqual(validateJpegResource(bytes, dimensions, { env: baseline.env,
        spawnSync: () => processResult(validResponse(baseline.receipt), changes) }), { reason });
    }
    assert.deepEqual(validateJpegResource(bytes, dimensions, { env: baseline.env,
      spawnSync() { throw new Error('SYNTHETIC-PRIVATE-CONTENT'); } }), unavailable);
  });

  await t.test('input and expected-dimension budgets reject before launching a decoder', () => {
    let calls = 0;
    const deps = { env: baseline.env, spawnSync() { calls++; return processResult(validResponse(baseline.receipt)); } };
    for (const input of [null, 'JPEG', new Uint8Array(4), Buffer.alloc(3), Buffer.alloc(16 * 1024 * 1024 + 1)]) {
      assert.deepEqual(validateJpegResource(input, dimensions, deps), { reason: 'resource_image_invalid' });
    }
    for (const expected of [
      { width: 0, height: 1 }, { width: 1, height: -1 }, { width: 1.5, height: 1 },
      { width: '1', height: 1 }, { width: NaN, height: 1 }, { width: Infinity, height: 1 },
      { width: Number.MAX_SAFE_INTEGER + 1, height: 1 }, { width: 4096, height: 4097 },
      { width: 65536, height: 1 }, { width: 1, height: 65536 },
    ]) assert.deepEqual(validateJpegResource(bytes, expected, deps), { reason: 'resource_validation_limit' });
    assert.equal(calls, 0);
  });
});
