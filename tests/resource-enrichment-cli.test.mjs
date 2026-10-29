import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from '../bin/exocortex.mjs';
import { createCommandContext } from '../src/cli/context.mjs';
import { executeMessages } from '../src/cli/messages-command.mjs';
import { parseRouteOptions } from '../src/cli/registry.mjs';
import { executeEnrichment, EnrichmentInputError } from '../src/maintenance/enrich.mjs';

const context = () => createCommandContext({ root: '/synthetic/install', cwd: '/synthetic/caller' });
const base = { target: 'resources', db: '/synthetic/resources.sqlite', recordIds: [1, 2] };
const writer = () => { let value = ''; return { write(chunk) { value += chunk; }, value: () => value }; };

test('resource paths resolve from cwd while the omitted directory remains relative to the selected database', () => {
  for (const route of ['messages', 'maintenance.enrich']) {
    const required = route === 'maintenance.enrich' ? ['--target', 'resources', '--record-id', '1'] : [];
    const defaults = parseRouteOptions(route, required, { context: context() }).options;
    assert.equal(defaults.resourceDir, undefined);
    const explicit = parseRouteOptions(route, [...required, '--db', 'messages.sqlite', '--resource-dir', 'private/images'], { context: context() }).options;
    assert.equal(explicit.db, '/synthetic/caller/messages.sqlite');
    assert.equal(explicit.resourceDir, '/synthetic/caller/private/images');
    assert.throws(() => parseRouteOptions(route, [...required, '--resource-dir', ''], { context: context() }), /non-empty path/);
  }
});

test('resource enrichment rejects broad or mixed targets before any domain work', () => {
  const deps = { enrichResources() { assert.fail('invalid input must not reach resources'); },
    runLark() { assert.fail('invalid input must not call the remote'); } };
  const invalidIds = [undefined, [], '1', [1, 1], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], Array.from({ length: 21 }, (_, i) => i + 1)];
  for (const recordIds of invalidIds) {
    assert.throws(() => executeEnrichment({ ...base, recordIds }, deps), EnrichmentInputError);
  }
  for (const extra of [{ namesOnly: true }, { senderOnly: true }, { senderId: 'ou_synthetic' },
    { senderId: '' }, { probeApps: true }, { unsafeDetails: true }, { limit: 1 },
    { reviewOut: '/synthetic/review.json' }, { reviewIn: '/synthetic/review.json' },
    { reviewSha256: 'a'.repeat(64) }, { resourceDir: '' }, { resourceDir: 1 },
    { maxCliAttempts: 0 }, { maxCliAttempts: 1001 }, { maxSeconds: 181 }, { maxSeconds: 1.5 }]) {
    assert.throws(() => executeEnrichment({ ...base, ...extra }, deps), EnrichmentInputError);
  }
  for (const target of ['records', 'scopes', 'recipients']) {
    assert.throws(() => executeEnrichment({ ...base, target, resourceDir: '/synthetic/resources' }, deps), /--target resources/);
  }
});

test('resource dispatch preserves its own session and does not inherit name scanning or timeout rules', () => {
  const env = { SYNTHETIC: 'only' }, now = () => 42, requestSessionDeps = { synthetic: true };
  const calls = [];
  const deps = { env, now, requestSessionDeps,
    runLark() { assert.fail('the shared names transport must not execute'); },
    enrichResources(options, forwarded) {
      assert.equal(forwarded, deps);
      assert.equal(options.limit, undefined);
      calls.push(options);
      return { ok: true, target: 'resources', dry_run: options.dryRun, partial: true };
    } };
  assert.equal(executeEnrichment(base, deps).partial, true);
  executeEnrichment({ ...base, recordIds: Array.from({ length: 20 }, (_, i) => i + 1), apply: true,
    maxCliAttempts: 1000, maxSeconds: 180 }, deps);
  assert.deepEqual(calls.map(options => options.dryRun), [true, false]);
  assert.equal(calls[1].maxSeconds, 180);
});

test('real resource preview can report missing exact records without a request session or writes', () => {
  const report = executeEnrichment(base, {
    readSnapshot(db, selection) {
      assert.equal(db, base.db);
      assert.deepEqual(selection.recordIds, base.recordIds);
      return { rows: [] };
    },
    createRequestSession() { assert.fail('offline preview must not create a remote session'); },
    runLark() { assert.fail('offline preview must not invoke remote work'); },
    publishMediaResource() { assert.fail('offline preview must not publish files'); },
  });
  assert.equal(report.dry_run, true);
  assert.equal(report.target, 'resources');
  assert.equal(report.results.length, 2);
  assert.ok(report.results.every(result => result.reason === 'record_missing'));
});

test('real CLI forwards resource budgets, directory and context through the maintenance entrance', async () => {
  const stdout = writer(), stderr = writer(), env = { SYNTHETIC: 'only' }, now = () => 42;
  const requestSessionDeps = { synthetic: true };
  let calls = 0;
  const status = await runCli(['maintenance', 'enrich', '--target', 'resources', '--db', 'messages.sqlite',
    '--record-id', '1', '--record-id', '2', '--resource-dir', 'private/images', '--max-cli-attempts', '8',
    '--max-seconds', '25', '--apply', '--format', 'json'], {
    root: '/synthetic/install', cwd: '/synthetic/caller', stdout, stderr, env, now,
    deps: { requestSessionDeps, enrichResources(options, deps) {
      calls++;
      assert.equal(options.resourceDir, '/synthetic/caller/private/images');
      assert.equal(options.db, '/synthetic/caller/messages.sqlite');
      assert.deepEqual(options.recordIds, [1, 2]);
      assert.equal(options.dryRun, false);
      assert.equal(options.maxCliAttempts, 8);
      assert.equal(options.maxSeconds, 25);
      assert.equal(deps.env, env);
      assert.equal(deps.now, now);
      assert.equal(deps.requestSessionDeps, requestSessionDeps);
      return { ok: true, target: 'resources', dry_run: false };
    } },
  });
  assert.equal(status, 0, stdout.value() + stderr.value());
  assert.equal(calls, 1);
  assert.equal(JSON.parse(stdout.value()).target, 'resources');
  assert.equal(stderr.value(), '');
});

test('messages passes the selected local resource directory to its existing read path', () => {
  const options = parseRouteOptions('messages', ['--db', 'messages.sqlite', '--resource-dir', 'private/images'], { context: context() }).options;
  let reads = 0;
  const messages = executeMessages(options, {
    existsSync() { return true; }, readLocalChatAppNames() { return null; },
    loadMessages(db, forwarded) {
      reads++;
      assert.equal(db, options.db);
      assert.equal(forwarded, options);
      assert.equal(forwarded.resourceDir, '/synthetic/caller/private/images');
      return [];
    },
    applyLocalChatAppNames(rows) { return rows; },
  });
  assert.deepEqual(messages, []);
  assert.equal(reads, 1);
});
