import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from '../bin/exocortex.mjs';
import { createCommandContext } from '../src/cli/context.mjs';
import { commandCatalog, parseRouteOptions } from '../src/cli/registry.mjs';

const ROOT = '/synthetic-resource-work/install';
const CWD = '/synthetic-resource-work/caller';
const PROFILE = 'known_record_resources/v1';
const writer = () => { let text = ''; return { write(value) { text += value; }, value: () => text }; };
const context = () => createCommandContext({ root: ROOT, cwd: CWD });
const report = (overrides = {}) => ({ ok: true, profile: PROFILE, outcome: 'idle', partial: false, ...overrides });

test('resource work catalog exposes only the bounded public-safe acquisition route', () => {
  const entry = commandCatalog({ route: 'maintenance.resources' }).commands[0];
  assert.equal(entry.privacy, 'public-safe');
  assert.deepEqual(entry.effects, ['local-read', 'remote-read', 'database-write', 'private-resource-write']);
  assert.deepEqual(entry.options.map(option => option.flag), ['--db', '--format', '--resource-dir',
    '--max-cli-attempts', '--max-self-attempts', '--max-seconds']);
  const options = parseRouteOptions(entry.id, ['--db', 'messages.sqlite'], { context: context() }).options;
  assert.equal(options.db, `${CWD}/messages.sqlite`);
  assert.equal(options.action, 'resources');
  assert.equal(options.maxCliAttempts, 3);
  assert.equal(options.maxSelfAttempts, 2);
  assert.equal(options.maxSeconds, 30);
  assert.equal(options.resourceDir, undefined);
  assert.equal(options.apply, undefined);
});

test('real CLI forwards the resource defaults and context without widening its arguments', async () => {
  const stdout = writer(), stderr = writer(), env = { SYNTHETIC_RESOURCE_WORK: 'only' }, now = () => 42;
  const requestSessionDeps = { synthetic: true }, expected = report();
  let calls = 0;
  const status = await runCli(['maintenance', 'resources', '--db', 'messages.sqlite', '--format', 'json'], {
    root: ROOT, cwd: CWD, stdout, stderr, env, now,
    deps: { requestSessionDeps, executeResourceWork(options, deps) {
      calls++;
      assert.deepEqual(options, { db: `${CWD}/messages.sqlite`, format: 'json', maxCliAttempts: 3,
        maxSelfAttempts: 2, maxSeconds: 30, action: 'resources' });
      assert.equal(deps.env, env);
      assert.equal(deps.now, now);
      assert.equal(deps.requestSessionDeps, requestSessionDeps);
      return expected;
    } },
  });
  assert.equal(status, 0, stdout.value() + stderr.value());
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(stdout.value()), expected);
  assert.equal(stderr.value(), '');
  assert(!stdout.value().includes(CWD));
});

test('real CLI resolves the explicit resource directory and preserves the reserved limits', async () => {
  for (const [maxCliAttempts, maxSeconds] of [[3, 1], [12, 30]]) {
    const stdout = writer(), stderr = writer();
    let calls = 0;
    const status = await runCli(['maintenance', 'resources', '--db', 'messages.sqlite',
      '--resource-dir', 'private-images', '--max-cli-attempts', String(maxCliAttempts),
      '--max-self-attempts', '2', '--max-seconds', String(maxSeconds), '--format', 'json'], {
      root: ROOT, cwd: CWD, stdout, stderr,
      deps: { executeResourceWork(options) {
        calls++;
        assert.equal(options.resourceDir, `${CWD}/private-images`);
        assert.equal(options.maxCliAttempts, maxCliAttempts);
        assert.equal(options.maxSelfAttempts, 2);
        assert.equal(options.maxSeconds, maxSeconds);
        assert.equal(options.recordIds, undefined);
        return report();
      } },
    });
    assert.equal(status, 0, stdout.value() + stderr.value());
    assert.equal(calls, 1);
    assert(!stdout.value().includes('private-images'));
    assert.equal(stderr.value(), '');
  }
});

test('real CLI rejects absent database, invalid budgets and unrelated maintenance options before loading work', async () => {
  const invalid = [[], ['--db', ''],
    ...[['--max-cli-attempts', '2'], ['--max-cli-attempts', '13'], ['--max-cli-attempts', '3.5'],
      ['--max-self-attempts', '0'], ['--max-self-attempts', '1'], ['--max-self-attempts', '3'],
      ['--max-seconds', '0'], ['--max-seconds', '31'], ['--max-seconds', '1.5'], ['--resource-dir', ''],
      ['--apply'], ['--record-id', '1'], ['--names-only'], ['--sender-only'], ['--probe-apps'],
      ['--unsafe-details'], ['--limit', '1'], ['--target', 'resources'], ['--review-out', 'review.json']]
      .map(args => ['--db', 'messages.sqlite', ...args])];
  for (const args of invalid) {
    const stdout = writer(), stderr = writer();
    const status = await runCli(['maintenance', 'resources', ...args, '--format', 'json'], {
      root: ROOT, cwd: CWD, stdout, stderr,
      loadCommand() { assert.fail('invalid resource invocation must not load domain work'); },
    });
    assert.equal(status, 1, JSON.stringify(args));
    assert.equal(JSON.parse(stdout.value()).error.code, 'invalid_arguments', stdout.value());
    assert.equal(stderr.value(), '');
  }
});

test('real CLI discovers resource work help without database or implementation loading', async () => {
  const stdout = writer(), stderr = writer();
  const status = await runCli(['maintenance', 'resources', '--help', '--format', 'json'], {
    root: ROOT, cwd: CWD, stdout, stderr,
    loadCommand() { assert.fail('help must not load domain work'); },
  });
  assert.equal(status, 0);
  const help = JSON.parse(stdout.value());
  assert.equal(help.commands[0].id, 'maintenance.resources');
  assert.equal(help.commands[0].privacy, 'public-safe');
  assert.equal(stderr.value(), '');
});

test('real CLI preserves safe resource outcomes and sanitizes thrown private diagnostics', async () => {
  for (const format of ['json', 'text']) {
    const stdout = writer(), stderr = writer(), partial = report({ ok: false, partial: true, outcome: 'deferred' });
    const status = await runCli(['maintenance', 'resources', '--db', 'messages.sqlite', '--format', format], {
      root: ROOT, cwd: CWD, stdout, stderr, deps: { executeResourceWork: () => partial },
    });
    assert.equal(status, 2);
    assert.deepEqual(JSON.parse(stdout.value()), partial);
    assert.equal(stderr.value(), '');

    const failedOut = writer(), failedErr = writer(), secret = 'synthetic-private-account-and-source';
    const failed = await runCli(['maintenance', 'resources', '--db', 'messages.sqlite', '--format', format], {
      root: ROOT, cwd: CWD, stdout: failedOut, stderr: failedErr,
      deps: { executeResourceWork() { throw new Error(`SELECT private_payload FROM ${secret} at ${CWD}`); } },
    });
    assert.equal(failed, 1);
    assert(!`${failedOut.value()}${failedErr.value()}`.includes(secret));
    assert(!`${failedOut.value()}${failedErr.value()}`.includes(CWD));
    if (format === 'json') assert.equal(JSON.parse(failedOut.value()).error.code, 'execution_failed');
  }
});
