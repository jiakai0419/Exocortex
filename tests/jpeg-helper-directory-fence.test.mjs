import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateJpegResource } from '../src/adapters/lark-im/jpeg-resource-validator.mjs';

// Only authored pixels and synthetic installation copies. No API or real data.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helper = process.env.EXOCORTEX_JPEG_VALIDATOR ?? join(repository, 'build/native/jpeg-validator');
const prefixes = process.env.EXOCORTEX_LIBJPEG_PREFIX ? [process.env.EXOCORTEX_LIBJPEG_PREFIX] : [
  '/opt/homebrew/opt/jpeg-turbo', '/usr/local/opt/jpeg-turbo', '/usr/local', '/usr',
];
const prefix = prefixes.find(path => existsSync(join(path, 'bin/cjpeg')));
const unavailable = { reason: 'resource_decoder_unavailable' };
const dimensions = { width: 13, height: 11 };
const available = { image: { mime_type: 'image/jpeg', ...dimensions } };
const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink'].every(key => a[key] === b[key]);

function installation(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'jpeg-validator');
  copyFileSync(helper, path); copyFileSync(`${helper}.json`, `${path}.json`);
  chmodSync(path, 0o700); chmodSync(`${path}.json`, 0o600);
  return { directory, path, env: { EXOCORTEX_JPEG_VALIDATOR: path } };
}

function pixels() {
  assert.ok(prefix, 'Build and configure the installed strict JPEG tools; do not skip missing dependencies.');
  assert.ok(existsSync(helper) && existsSync(`${helper}.json`), 'Build the strict helper before these tests.');
  const input = Buffer.concat([Buffer.from('P5\n13 11\n255\n'),
    Buffer.from(Array.from({ length: 143 }, (_, i) => (i * 37 + 19) & 255))]);
  const result = spawnSync(join(prefix, 'bin/cjpeg'), ['-grayscale', '-quality', '83'], {
    input, timeout: 10000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error); assert.equal(result.status, 0); assert.equal(result.stderr.length, 0);
  return result.stdout;
}

test('JPEG claims retain a bounded installation-directory identity fence', async t => {
  const bytes = pixels(), root = mkdtempSync('/tmp/synthetic-jpeg-fence-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = installation(join(root, 'stable', 'install'));

  await t.test('normal real helper and /tmp canonical alias retain full JPEG validation', () => {
    assert.deepEqual(validateJpegResource(bytes, dimensions, { env: original.env }), available);
    assert.deepEqual(validateJpegResource(bytes, dimensions, { env: {
      EXOCORTEX_JPEG_VALIDATOR: realpathSync(original.path),
    } }), available);
    assert.deepEqual(validateJpegResource(Buffer.from('ffd8ffd9', 'hex'), dimensions,
      { env: original.env }), { reason: 'resource_image_invalid' });
  });

  for (const level of ['parent', 'grandparent', 'first-mutable']) await t.test(`${level} directory swap cannot authorize a forged result`, () => {
    // For first-mutable, the whole immediate child of /tmp is replaced. Its
    // protected parent's ctime is ignored, so the moved directory must detect it.
    const base = mkdtempSync('/tmp/synthetic-jpeg-aba-');
    const replacement = `${base}-replacement`, held = `${base}-held`;
    const install = installation(join(base, 'ancestor', 'install'));
    const victim = level === 'parent' ? install.directory : level === 'grandparent' ? dirname(install.directory) : base;
    const fakeRoot = level === 'first-mutable' ? replacement : join(base, 'replacement');
    const relative = level === 'parent' ? [] : level === 'grandparent' ? ['install'] : ['ancestor', 'install'];
    const fakeDirectory = join(fakeRoot, ...relative);
    mkdirSync(fakeDirectory, { recursive: true, mode: 0o700 });
    const receipt = JSON.parse(readFileSync(`${install.path}.json`, 'utf8'));
    const response = { version: 1, status: 'valid', ...dimensions, scans: 1, decoder: 'libjpeg-turbo', decoder_version: receipt.decoder_version };
    writeFileSync(join(fakeDirectory, 'jpeg-validator'), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(response)}'\n`, { mode: 0o700 });
    const before = lstatSync(install.path, { bigint: true });
    let calls = 0, exit;
    try {
      const result = validateJpegResource(Buffer.from('ffd8ffd9', 'hex'), dimensions, {
        env: install.env, spawnSync(command, args, options) {
          renameSync(victim, held); renameSync(fakeRoot, victim);
          try { const actual = spawnSync(command, args, options); calls++; exit = actual.status; return actual; }
          finally { renameSync(victim, fakeRoot); renameSync(held, victim); }
        },
      });
      assert.equal(calls, 1); assert.equal(exit, 0, 'The fake really executed; the fence must reject its output.');
      assert.equal(sameFile(before, lstatSync(install.path, { bigint: true })), true);
      assert.equal(result.image, undefined); assert.deepEqual(result, unavailable);
    } finally {
      for (const path of [base, replacement, held]) rmSync(path, { recursive: true, force: true });
    }
  });

  await t.test('unrelated /tmp activity does not reject a stable code installation', () => {
    const marker = `/tmp/synthetic-jpeg-unrelated-${process.pid}`;
    try {
      assert.deepEqual(validateJpegResource(bytes, dimensions, { env: original.env, spawnSync(command, args, options) {
        writeFileSync(marker, 'authored control'); rmSync(marker);
        return spawnSync(command, args, options);
      } }), available);
    } finally { rmSync(marker, { force: true }); }
  });

  await t.test('unrelated changes within a mutable ancestor conservatively reject the claim', () => {
    const marker = join(root, 'authored-unrelated-file');
    assert.deepEqual(validateJpegResource(bytes, dimensions, { env: original.env, spawnSync(command, args, options) {
      writeFileSync(marker, 'synthetic'); rmSync(marker);
      return spawnSync(command, args, options);
    } }), unavailable);
  });

  await t.test('the mutable user temporary directory is not silently promoted to a trusted anchor', () => {
    // If TMPDIR is the system /tmp (common on Linux), its parent protects the
    // directory entry; exercise the equivalent mutable private child instead.
    const parent = realpathSync(tmpdir()) === realpathSync('/tmp')
      ? mkdtempSync('/tmp/synthetic-jpeg-user-temp-') : realpathSync(tmpdir());
    const isolated = mkdtempSync(join(parent, 'synthetic-jpeg-fence-'));
    const install = installation(join(isolated, 'install'));
    const marker = join(parent, `synthetic-jpeg-marker-${process.pid}`);
    try {
      assert.deepEqual(validateJpegResource(bytes, dimensions, { env: install.env, spawnSync(command, args, options) {
        writeFileSync(marker, 'synthetic'); rmSync(marker);
        return spawnSync(command, args, options);
      } }), unavailable);
    } finally {
      rmSync(marker, { force: true }); rmSync(isolated, { recursive: true, force: true });
      if (realpathSync(tmpdir()) === realpathSync('/tmp')) rmSync(parent, { recursive: true, force: true });
    }
  });

  await t.test('at most 64 directories are opened and excessive depth never spawns', () => {
    const deep = installation(join(root, ...Array.from({ length: 65 }, (_, i) => `d${i}`)));
    let calls = 0;
    assert.deepEqual(validateJpegResource(bytes, dimensions, { env: deep.env, spawnSync() { calls++; } }), unavailable);
    assert.equal(calls, 0);
  });

  await t.test('success, malformed receipt, thrown spawn, and process errors retain no directory descriptors', () => {
    const broken = installation(join(root, 'broken'));
    writeFileSync(`${broken.path}.json`, '{');
    const before = readdirSync('/dev/fd').sort();
    for (let n = 0; n < 12; n++) {
      assert.deepEqual(validateJpegResource(bytes, dimensions, { env: original.env }), available);
      assert.deepEqual(validateJpegResource(bytes, dimensions, { env: broken.env }), unavailable);
      assert.deepEqual(validateJpegResource(bytes, dimensions, { env: original.env, spawnSync() { throw Error('synthetic'); } }), unavailable);
      assert.deepEqual(validateJpegResource(bytes, dimensions, { env: original.env, spawnSync() {
        return { error: Object.assign(Error('synthetic'), { code: 'ENOENT' }), status: null, signal: null, stdout: '', stderr: '' };
      } }), unavailable);
    }
    assert.deepEqual(readdirSync('/dev/fd').sort(), before);
  });

  for (const failAt of [1, 2, 4]) await t.test(`directory open failure ${failAt} closes all earlier descriptors`, () => {
    const script = `
      import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import assert from 'node:assert/strict';
      const open=fs.openSync,close=fs.closeSync,stat=fs.fstatSync,tracked=[]; let count=0,calls=0;
      fs.openSync=function(path,flags,...args){
        if(typeof flags==='number'&&(flags&fs.constants.O_DIRECTORY)!==0){
          if(++count===${failAt})throw Object.assign(Error('synthetic directory error'),{code:'EIO'});
          const fd=open.call(fs,path,flags,...args);tracked.push(fd);return fd;
        }return open.call(fs,path,flags,...args);
      };
      syncBuiltinESMExports();
      const {validateJpegResource}=await import(${JSON.stringify(new URL('../src/adapters/lark-im/jpeg-resource-validator.mjs', import.meta.url).href)});
      const result=validateJpegResource(Buffer.from('ffd8ffd9','hex'),undefined,{env:{EXOCORTEX_JPEG_VALIDATOR:${JSON.stringify(original.path)}},spawnSync(){calls++;}});
      assert.deepEqual(result,{reason:'resource_decoder_unavailable'});assert.equal(calls,0);assert.equal(count,${failAt});
      assert.equal(tracked.length,${failAt - 1});for(const fd of tracked)assert.throws(()=>stat(fd),{code:'EBADF'});
      fs.openSync=open;fs.closeSync=close;syncBuiltinESMExports();
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 10000, maxBuffer: 8192 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  });
});
