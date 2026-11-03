import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateJpegResource } from '../src/adapters/lark-im/jpeg-resource-validator.mjs';
import { createHistoryCommandBudget, HistoryCommandBudgetError } from '../src/maintenance/history-command-budget.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installed = process.env.EXOCORTEX_JPEG_VALIDATOR || join(repository, 'build/native/jpeg-validator');
const prefix = process.env.EXOCORTEX_LIBJPEG_PREFIX;
const dimensions = { width: 3, height: 2 };
const available = { image: { mime_type: 'image/jpeg', ...dimensions } };

function clock() {
  const state = { time: 0, failure: null };
  const budget = createHistoryCommandBudget({ maxSeconds: 5 }, { monotonicClock() {
    if (state.failure === 'throw') throw new Error('AUTHORED_PRIVATE_CLOCK_TEXT');
    if (state.failure === 'nonfinite') return NaN;
    if (state.failure === 'reverse') return -1;
    return state.time;
  } });
  return { state, budget };
}

function response(receipt) {
  return { status: 0, signal: null, error: undefined, stderr: '', stdout: JSON.stringify({
    version: 1, status: 'valid', ...dimensions, scans: 1, decoder: 'libjpeg-turbo', decoder_version: receipt.decoder_version,
  }) };
}

function withFs(replacements, work) {
  const originals = Object.fromEntries(Object.keys(replacements).map(key => [key, fs[key]]));
  for (const [key, replacement] of Object.entries(replacements)) fs[key] = (...args) => replacement(originals[key], ...args);
  syncBuiltinESMExports();
  try { return work(); }
  finally { for (const [key, original] of Object.entries(originals)) fs[key] = original; syncBuiltinESMExports(); }
}

function budgetFailure(work, reason) {
  let caught;
  assert.throws(work, error => { caught = error; return error instanceof HistoryCommandBudgetError && error.reason === reason; });
  return caught;
}

test('direct JPEG helper shares the existing execution budget without weakening its default contract', async t => {
  assert(prefix, 'Set EXOCORTEX_LIBJPEG_PREFIX to the prepared official test SDK.');
  const root = fs.mkdtempSync('/tmp/authored-jpeg-budget-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const helper = join(root, 'jpeg-validator');
  fs.copyFileSync(installed, helper); fs.copyFileSync(`${installed}.json`, `${helper}.json`);
  fs.chmodSync(helper, 0o700); fs.chmodSync(`${helper}.json`, 0o600);
  const receipt = JSON.parse(fs.readFileSync(`${helper}.json`, 'utf8'));
  const encoded = spawnSync(join(prefix, 'bin/cjpeg'), ['-grayscale', '-quality', '83'], {
    input: Buffer.concat([Buffer.from('P5\n3 2\n255\n'), Buffer.from([11, 77, 134, 198, 225, 43])]),
    timeout: 10000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL',
  });
  assert.ifError(encoded.error); assert.equal(encoded.status, 0); assert.equal(encoded.stderr.length, 0);
  const bytes = encoded.stdout;
  const env = { EXOCORTEX_JPEG_VALIDATOR: helper };

  await t.test('no budget retains the exact original5000ms child options and real decoder behavior', () => {
    let calls = 0;
    const result = validateJpegResource(bytes, dimensions, { env, spawnSync(command, args, options) {
      calls++; assert.equal(command, fs.realpathSync(helper)); assert.deepEqual(args, []);
      assert.deepEqual(options, { input: bytes, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 8192,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' } });
      return spawnSync(command, args, options);
    } });
    assert.deepEqual(result, available); assert.equal(calls, 1);
  });

  await t.test('no-budget hook exceptions retain the original decoder-unavailable behavior', () => {
    assert.deepEqual(validateJpegResource(bytes, dimensions, { env,
      spawnSync() { throw new HistoryCommandBudgetError('time_budget'); } }), { reason: 'resource_decoder_unavailable' });
  });

  for (const value of [null, false, {}, { timeoutMs() { return 5000; } }]) {
    await t.test(`unbranded budget is rejected before any file/child operation: ${JSON.stringify(value)}`, () => {
      let files = 0, children = 0;
      withFs({ openSync(run, ...args) { files++; return run(...args); } }, () => {
        assert.throws(() => validateJpegResource(bytes, dimensions, { env, executionBudget: value,
          spawnSync() { children++; return response(receipt); } }), TypeError);
      });
      assert.equal(files, 0); assert.equal(children, 0);
    });
  }

  await t.test('an expired work grant rejects before opening files or launching a child', () => {
    const c = clock(); c.state.time = 4000; let files = 0, children = 0;
    withFs({ openSync(run, ...args) { files++; return run(...args); } }, () => budgetFailure(() =>
      validateJpegResource(bytes, dimensions, { env, executionBudget: c.budget,
        spawnSync() { children++; return response(receipt); } }), 'time_budget'));
    assert.equal(files, 0); assert.equal(children, 0);
  });

  await t.test('remaining shared grant determines the helper timeout', () => {
    const c = clock(); c.state.time = 2500; let timeout;
    const result = validateJpegResource(bytes, dimensions, { env, executionBudget: c.budget,
      spawnSync(command, args, options) { timeout = options.timeout; return response(receipt); } });
    assert.deepEqual(result, available); assert.equal(timeout, 1500);
    assert.equal(c.budget.summary().max_ms, 5000);
  });

  await t.test('a larger enclosing grant does not raise the original helper5000ms cap', () => {
    const budget = createHistoryCommandBudget({ maxSeconds: 30 }, { monotonicClock: () => 0 });
    let timeout;
    assert.deepEqual(validateJpegResource(bytes, dimensions, { env, executionBudget: budget,
      spawnSync(command, args, options) { timeout = options.timeout; return response(receipt); } }), available);
    assert.equal(timeout, 5000);
  });

  await t.test('time spent verifying the installation shrinks the actual dispatch grant afresh', () => {
    const c = clock(); c.state.time = 500; let reads = 0, timeout;
    const result = withFs({ readSync(run, ...args) { const n = run(...args); if (++reads === 1) c.state.time = 3000; return n; } }, () =>
      validateJpegResource(bytes, dimensions, { env, executionBudget: c.budget,
        spawnSync(command, args, options) { timeout = options.timeout; return response(receipt); } }));
    assert.deepEqual(result, available); assert.equal(timeout, 1000); assert(reads > 0);
  });

  await t.test('expiry during stable installation reads closes every descriptor and prevents dispatch', () => {
    const c = clock(), opened = new Set(); let children = 0, reads = 0;
    withFs({
      openSync(run, ...args) { const fd = run(...args); opened.add(fd); return fd; },
      closeSync(run, fd) { const result = run(fd); opened.delete(fd); return result; },
      readSync(run, ...args) { const n = run(...args); if (++reads === 1) c.state.time = 4000; return n; },
    }, () => budgetFailure(() => validateJpegResource(bytes, dimensions, { env, executionBudget: c.budget,
      spawnSync() { children++; return response(receipt); } }), 'time_budget'));
    assert.equal(opened.size, 0); assert.equal(children, 0);
  });

  for (const failure of ['throw', 'nonfinite', 'reverse']) await t.test(`clock ${failure} aborts before I/O`, () => {
    const c = clock(); c.state.failure = failure; let files = 0, children = 0;
    withFs({ openSync(run, ...args) { files++; return run(...args); } }, () => budgetFailure(() =>
      validateJpegResource(bytes, dimensions, { env, executionBudget: c.budget,
        spawnSync() { children++; return response(receipt); } }), 'clock_unavailable'));
    assert.equal(files, 0); assert.equal(children, 0);
  });

  await t.test('child timeout reaching the shared work deadline propagates budget abort', () => {
    const c = clock(); c.state.time = 2300; let children = 0;
    budgetFailure(() => validateJpegResource(bytes, dimensions, { env, executionBudget: c.budget,
      spawnSync(command, args, options) {
        children++; assert.equal(options.timeout, 1700); c.state.time = 4000;
        return { status: null, signal: 'SIGKILL', error: Object.assign(new Error('AUTHORED_TIMEOUT'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' };
      } }), 'time_budget');
    assert.equal(children, 1);
  });

  await t.test('ETIMEDOUT without measured shared expiry keeps the existing media limit reason', () => {
    const c = clock(); c.state.time = 1000;
    assert.deepEqual(validateJpegResource(bytes, dimensions, { env, executionBudget: c.budget,
      spawnSync() { return { status: null, signal: 'SIGKILL', error: Object.assign(new Error('AUTHORED_TIMEOUT'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' }; } }),
    { reason: 'resource_validation_limit' });
    assert.equal(c.budget.summary().stop_reason, null);
  });

  await t.test('a real invalid JPEG within the shared budget retains its original reason', () => {
    const c = clock(); c.state.time = 1000;
    assert.deepEqual(validateJpegResource(Buffer.from('ffd8ffd9', 'hex'), dimensions, { env, executionBudget: c.budget }),
      { reason: 'resource_image_invalid' });
    assert.equal(c.budget.summary().stop_reason, null);
  });

  await t.test('post-child clock failure is an observer abort rather than bad bytes', () => {
    const c = clock(); let children = 0;
    budgetFailure(() => validateJpegResource(bytes, dimensions, { env, executionBudget: c.budget,
      spawnSync() { children++; c.state.failure = 'throw'; return response(receipt); } }), 'clock_unavailable');
    assert.equal(children, 1);
  });

  await t.test('return-time checkpoint catches expiry while parsing the child response', () => {
    const c = clock();
    budgetFailure(() => validateJpegResource(bytes, dimensions, { env, executionBudget: c.budget,
      spawnSync() { const value = response(receipt); return { ...value, get stdout() { c.state.time = 4000; return value.stdout; } }; } }), 'time_budget');
  });

  await t.test('cleanup failure cannot replace an established budget error and all descriptors are closed', () => {
    const c = clock(), opened = new Set(); let cleanupFaults = 0;
    const primary = new HistoryCommandBudgetError('time_budget');
    let caught;
    withFs({
      openSync(run, ...args) { const fd = run(...args); opened.add(fd); return fd; },
      closeSync(run, fd) { const value = run(fd); opened.delete(fd); if (c.state.time === 4000) { cleanupFaults++; throw new Error('AUTHORED_CLOSE_FAILURE'); } return value; },
    }, () => { caught = budgetFailure(() => validateJpegResource(bytes, dimensions, { env, executionBudget: c.budget,
      spawnSync() { c.state.time = 4000; throw primary; } }), 'time_budget'); });
    assert.equal(caught, primary); assert(cleanupFaults > 0); assert.equal(opened.size, 0);
  });

  await t.test('stable-file cleanup cannot overwrite expiry detected immediately after a read', () => {
    const c = clock(), opened = new Set(); let reads = 0, closesAfterExpiry = 0, children = 0;
    withFs({
      openSync(run, ...args) { const fd = run(...args); opened.add(fd); return fd; },
      readSync(run, ...args) { const n = run(...args); if (++reads === 1) c.state.time = 4000; return n; },
      closeSync(run, fd) { const value = run(fd); opened.delete(fd); if (c.state.time === 4000) {
        closesAfterExpiry++; throw new Error('AUTHORED_FILE_CLOSE_FAILURE');
      } return value; },
    }, () => budgetFailure(() => validateJpegResource(bytes, dimensions, { env, executionBudget: c.budget,
      spawnSync() { children++; return response(receipt); } }), 'time_budget'));
    assert(closesAfterExpiry > 1); assert.equal(opened.size, 0); assert.equal(children, 0);
  });

  await t.test('expiry during descriptor cleanup is retained at the final checkpoint', () => {
    const c = clock(), opened = new Set(); let childDone = false;
    withFs({
      openSync(run, ...args) { const fd = run(...args); opened.add(fd); return fd; },
      closeSync(run, fd) { const value = run(fd); opened.delete(fd); if (childDone) c.state.time = 4000; return value; },
    }, () => budgetFailure(() => validateJpegResource(bytes, dimensions, { env, executionBudget: c.budget,
      spawnSync() { childDone = true; return response(receipt); } }), 'time_budget'));
    assert.equal(opened.size, 0);
  });
});
