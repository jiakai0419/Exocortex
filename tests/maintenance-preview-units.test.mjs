import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executePreviewUnits, PLAN_SCHEMA } from '../src/maintenance/preview-units.mjs';
import { executeEnrichment } from '../src/maintenance/enrich.mjs';
import { executeLarkImReplay, validateReplayOptions } from '../src/maintenance/replay.mjs';
import { MaintenanceRequestError } from '../src/maintenance/request-session.mjs';
import { tryAcquireLarkApiLease, readSharedLarkCooldown, writeSharedLarkCooldown, getLarkApiLeaseStdio } from '../src/runtime/lark-api-lease.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { prepareChatWindowRecords } from '../src/adapters/lark-im/sync-runner.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { ensureInitialized, INITIAL_ACCOUNT_KIND, quoteSql, sqliteExec, sqliteQuery, upsertRecordsSql } from '../dist/storage/sqlite/ingestion-store.js';
import { runCli } from '../bin/exocortex.mjs';

const SELF = { open_id: 'ou_synthetic_preview_self', name: 'Synthetic Preview Self' };
const CHAT = 'oc_synthetic_preview_chat', SCOPE = chatScopeId(CHAT);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ok = value => ({ status: 0, signal: null, stdout: JSON.stringify(value), stderr: '' });
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const sql = (f, value) => sqliteExec(f.db, value, 'authored preview fixture');
const rows = f => sqliteQuery(f.db, 'SELECT * FROM records ORDER BY id;', 'read authored fixture');
function fixture(t, count = 2, mode = 'names') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exocortex-preview-units-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = { root, db: join(root, 'synthetic.sqlite'), plan: join(root, 'plan.json'), progressDir: join(root, 'progress'),
    start: Date.now() - 86400000, state: { time: 0, held: false, requests: [], acquire: 0, pauses: [], rate: false } };
  f.end = f.start + 60000; mkdirSync(f.progressDir, { mode: 0o700 }); ensureInitialized(f.db);
  const confirmed = new Date(f.start).toISOString();
  sql(f, `UPDATE sources SET config_json=${quoteSql(JSON.stringify({ initial_sync_start_ms: f.start,
    initial_account_binding: { kind: INITIAL_ACCOUNT_KIND, account_key: sha(`lark.im\0${SELF.open_id}`), reserved_at: confirmed, confirmed_at: confirmed } }))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${quoteSql(SCOPE)},'lark.im','Synthetic preview scope',
      ${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`);
  f.messages = Array.from({ length: count }, (_, i) => normalizeApiMessage({ message_id: `om_synthetic_preview_${i}`,
    chat_id: CHAT, create_time: String(f.start + 1000 + i), update_time: String(f.start + 1000 + i), msg_type: 'text',
    sender: { id: `ou_synthetic_preview_peer_${i}`, id_type: 'open_id', sender_type: 'user' }, body: { content: JSON.stringify({ text: `Synthetic preview body ${i}` }) } }));
  sql(f, upsertRecordsSql(prepareChatWindowRecords(f.messages, SCOPE, null, f.start, f.end, SELF.open_id, { self: SELF }, { chat_id: CHAT, chat_type: 'group' })));
  f.ids = rows(f).map(row => row.id);
  f.units = f.ids.map((id, i) => mode === 'names'
    ? { mode, record_ids: [id], max_cli_attempts: 1, max_seconds: 10 }
    : { mode, scope_id: SCOPE, message_ids: [f.messages[i].message_id], start: new Date(f.start).toISOString(), end: new Date(f.end).toISOString(), max_cli_attempts: 3, max_seconds: 15 });
  write(f.plan, { schema: PLAN_SCHEMA, units: f.units });
  f.options = { db: f.db, plan: f.plan, progressDir: f.progressDir, maxCliAttempts: 10, maxSeconds: 60 };
  f.deps = { requestSessionDeps: {
    monotonicClock: () => f.state.time,
    sleep(ms) { assert.equal(f.state.held, false); f.state.pauses.push(ms); f.state.time += ms; },
    tryAcquireLease() { f.state.acquire++; f.state.held = true; return { state: 'acquired', release() { f.state.held = false; } }; },
    readSharedCooldown: () => ({ state: 'ready' }), writeSharedCooldown: () => true,
    spawnSync(_command, args, settings) {
      assert.equal(f.state.held, true); assert.ok(settings.timeout > 0);
      f.state.requests.push(args);
      if (args[0] === 'contact' && args[1] === '+get-user') return ok(SELF);
      if (args[0] === 'contact' && args[1] === '+search-user') return ok({ users: args[args.indexOf('--user-ids') + 1].split(',').map(open_id => ({ open_id, name: `Synthetic Reader ${open_id.slice(-1)}` })) });
      assert.equal(args[0], 'api');
      return ok({ code: 0, data: { items: f.messages.map(message => ({ ...message.raw_api, update_time: String(f.start + 20000), body: { content: '{"text":"Synthetic refreshed text"}' } })), has_more: false } });
    },
  } };
  return f;
}
function run(f, extra = {}) { return executePreviewUnits({ ...f.options, ...extra }, f.deps); }
function artifact(f, index = 1) { return join(f.progressDir, `unit-${String(index).padStart(3, '0')}.review.json`); }
function manifest(f) { return join(f.progressDir, 'manifest.json'); }
function noWrites(f, before) {
  assert.deepEqual(rows(f), before);
  for (const table of ['bounded_replay_runs', 'maintenance_locks']) assert.equal(sqliteQuery(f.db, `SELECT count(*) AS n FROM ${table};`)[0].n, 0);
}

test('completed unit survives total cap; explicit resume skips its API and exposes previous charges', t => {
  const f = fixture(t), before = rows(f); f.options.maxCliAttempts = 1;
  const first = run(f); assert.equal(first.stop_reason, 'cli_budget'); assert.equal(first.reviewed, 1);
  assert.equal(f.state.requests.length, 1); assert.ok(existsSync(artifact(f))); assert.equal(existsSync(artifact(f, 2)), false);
  const saved = readFileSync(artifact(f));
  const second = run(f, { resume: true }); assert.equal(second.ok, true); assert.equal(second.reused_local_reviews, 1);
  assert.equal(second.completed_this_invocation, 1); assert.equal(second.previous_invocations.cli_attempts_charged, 1);
  assert.equal(second.request_budget.cli_attempts, 1); assert.equal(f.state.requests.length, 2);
  assert.deepEqual(readFileSync(artifact(f)), saved);
  const third = run(f, { resume: true }); assert.equal(third.reused_local_reviews, 2); assert.equal(third.request_budget.cli_attempts, 0);
  assert.equal(third.previous_invocations.cli_attempts_charged, 2); noWrites(f, before);
  assert.doesNotMatch(JSON.stringify(second), /Synthetic Reader|oc_synthetic|ou_synthetic|om_synthetic|synthetic.sqlite/);
});

test('sync_busy before any API retries at 2s and 4s with no lease held, then stops finitely', t => {
  const f = fixture(t, 1), before = rows(f);
  f.deps.requestSessionDeps.tryAcquireLease = () => { f.state.acquire++; return { state: 'busy' }; };
  const report = run(f); assert.equal(report.stop_reason, 'sync_busy'); assert.equal(report.busy_retries, 2);
  assert.deepEqual(f.state.pauses, [2000, 4000]); assert.equal(f.state.acquire, 3);
  assert.equal(f.state.requests.length, 0); assert.equal(existsSync(artifact(f)), false); noWrites(f, before);
});

test('busy after replay self counts that request against the same unit across fresh-session retry', t => {
  const f = fixture(t, 1, 'replay'), before = rows(f);
  const acquire = f.deps.requestSessionDeps.tryAcquireLease;
  f.deps.requestSessionDeps.tryAcquireLease = () => f.state.acquire === 1
    ? (f.state.acquire++, { state: 'busy' }) : acquire();
  const report = run(f); assert.equal(report.ok, true); assert.equal(report.busy_retries, 1);
  assert.equal(report.request_budget.cli_attempts, 3); assert.equal(f.state.requests.length, 3);
  assert.deepEqual(f.state.requests.map(args => args[0]), ['contact', 'contact', 'api']);
  assert.equal(json(artifact(f)).constraints.max_cli_attempts, 3); noWrites(f, before);
});

test('a retry cannot reset a unit cap exhausted after a successful earlier self request', t => {
  const f = fixture(t, 1, 'replay'); f.units[0].max_cli_attempts = 2; write(f.plan, { schema: PLAN_SCHEMA, units: f.units });
  const acquire = f.deps.requestSessionDeps.tryAcquireLease;
  f.deps.requestSessionDeps.tryAcquireLease = () => f.state.acquire === 1
    ? (f.state.acquire++, { state: 'busy' }) : acquire();
  const report = run(f); assert.equal(report.stop_reason, 'cli_budget'); assert.equal(f.state.requests.length, 2);
  assert.equal(existsSync(artifact(f)), false);
});

test('cross-unit gap yields and total time reserves fixed unit constraints without shrinking them', t => {
  const f = fixture(t); f.options.maxSeconds = 10;
  const report = run(f); assert.equal(report.reviewed, 1); assert.equal(report.stop_reason, 'time_budget');
  assert.equal(f.state.requests.length, 1); assert.deepEqual(f.state.pauses, [1000]);
  assert.equal(json(artifact(f)).constraints.max_seconds, 10);
});

test('orphan complete review is adopted after interrupted manifest write with zero repeated API', t => {
  const f = fixture(t, 1); assert.equal(run(f).ok, true);
  const progress = json(manifest(f)); progress.units[0] = { state: 'pending', review_sha256: null, partial: false };
  progress.runs[0].status = 'running'; write(manifest(f), progress);
  const report = run(f, { resume: true }); assert.equal(report.reused_local_reviews, 1); assert.equal(report.request_budget.cli_attempts, 0);
  assert.equal(report.previous_invocations.interrupted_invocations, 1); assert.equal(f.state.requests.length, 1);
});

for (const mutation of ['schema', 'policy', 'ttl', 'targets', 'budget', 'snapshot', 'unknown_column', 'source', 'scope', 'account', 'external_id', 'self']) {
  test(`resume rejects ${mutation} evidence before any new API or overwrite`, t => {
    const f = fixture(t); f.options.maxCliAttempts = 1; run(f);
    if (['snapshot', 'unknown_column', 'source', 'scope', 'account'].includes(mutation)) {
      sql(f, ({ snapshot: 'UPDATE records SET updated_at=\'Synthetic changed baseline\' WHERE id=1;',
        unknown_column: 'ALTER TABLE records ADD COLUMN synthetic_future TEXT;',
        source: "UPDATE sources SET config_json=json_set(config_json,'$.unknown_policy',1);",
        scope: "UPDATE sync_scopes SET config_json=json_set(config_json,'$.unknown_policy',1);",
        account: "UPDATE sources SET config_json=json_set(config_json,'$.initial_account_binding.account_key','" + 'a'.repeat(64) + "');" })[mutation]);
    } else {
      const review = json(artifact(f));
      if (mutation === 'schema') review.schema = 'future';
      if (mutation === 'policy') review.binding.scope_config_policy = 'future';
      if (mutation === 'ttl') { review.created_at_ms -= 1900000; review.expires_at_ms -= 1900000; }
      if (mutation === 'targets') review.constraints.targets = [999];
      if (mutation === 'budget') review.constraints.max_cli_attempts++;
      if (mutation === 'external_id') review.records[0].external_id = 'om_synthetic_wrong';
      if (mutation === 'self') review.binding.verified_self_sha256 = 'f'.repeat(64);
      write(artifact(f), review);
      // Even an orphan without a retained hash must pass complete validation.
      const progress = json(manifest(f)); progress.units[0] = { state: 'pending', review_sha256: null, partial: false }; write(manifest(f), progress);
    }
    const old = readFileSync(artifact(f));
    assert.throws(() => run(f, { resume: true }), /review rejected|preview stopped/);
    assert.equal(f.state.requests.length, 1); assert.deepEqual(readFileSync(artifact(f)), old);
  });
}

test('resume validates every saved unit before attempting an earlier pending unit', t => {
  const f = fixture(t); run(f);
  rmSync(artifact(f));
  const progress = json(manifest(f)); progress.units[0] = { state: 'pending', review_sha256: null, partial: false }; write(manifest(f), progress);
  const review = json(artifact(f, 2)); review.schema = 'unknown'; write(artifact(f, 2), review);
  const calls = f.state.requests.length;
  assert.throws(() => run(f, { resume: true }), /review rejected/); assert.equal(f.state.requests.length, calls);
});

test('real private global API lease excludes requests while coordinator descriptor never enters API registry', t => {
  const f = fixture(t, 1), directory = join(f.root, 'api-state');
  const sync = tryAcquireLarkApiLease({ role: 'sync' }, { directory }); assert.equal(sync.state, 'acquired');
  t.after(() => sync.release());
  const inherited = getLarkApiLeaseStdio();
  f.deps.requestSessionDeps.tryAcquireLease = request => {
    assert.deepEqual(getLarkApiLeaseStdio(), inherited);
    return tryAcquireLarkApiLease(request, { directory, monotonicClock: () => f.state.time });
  };
  const report = run(f); assert.equal(report.stop_reason, 'sync_busy'); assert.equal(f.state.requests.length, 0);
  sync.release(); assert.equal(getLarkApiLeaseStdio(), undefined);
});

test('rate limit publishes under real API lease and never retries across a new unit', t => {
  const f = fixture(t), directory = join(f.root, 'api-state');
  f.deps.requestSessionDeps.tryAcquireLease = request => tryAcquireLarkApiLease(request, { directory, monotonicClock: () => f.state.time });
  f.deps.requestSessionDeps.readSharedCooldown = request => readSharedLarkCooldown(request, { directory });
  f.deps.requestSessionDeps.writeSharedCooldown = request => {
    assert.ok(getLarkApiLeaseStdio()); return writeSharedLarkCooldown(request, { directory });
  };
  f.deps.requestSessionDeps.spawnSync = () => { f.state.requests.push('rate'); return { ...ok({ error: { type: 'api', code: 99991400, detail: { headers: { 'x-ogw-ratelimit-reset': '60' } } } }), status: 1 }; };
  const first = run(f); assert.equal(first.stop_reason, 'rate_limited'); assert.equal(first.busy_retries, 0);
  const next = run(f, { resume: true }); assert.equal(next.stop_reason, 'rate_cooldown'); assert.equal(f.state.requests.length, 1);
});

test('unsafe plan/progress and plan drift reject before requests; no apply option exists', async t => {
  const f = fixture(t, 1); chmodSync(f.plan, 0o644); assert.throws(() => run(f), /invalid_plan/); chmodSync(f.plan, 0o600);
  run(f); const plan = json(f.plan); plan.units[0].max_cli_attempts++; write(f.plan, plan);
  assert.throws(() => run(f, { resume: true }), /invalid_progress/); assert.equal(f.state.requests.length, 1);
  let stdout = ''; const code = await runCli(['maintenance', 'preview', '--db', f.db, '--plan', f.plan, '--progress-dir', f.progressDir, '--apply', '--format', 'json'], { stdout: { write: text => stdout += text } });
  assert.equal(code, 1); assert.match(stdout, /invalid_arguments/);
});

test('real public route requires explicit budgets and dispatches only preview behavior', async t => {
  const f = fixture(t, 1); let output = '';
  const args = ['maintenance', 'preview', '--db', f.db, '--plan', f.plan, '--progress-dir', f.progressDir, '--format', 'json'];
  const context = { deps: f.deps, stdout: { write: text => output += text } };
  assert.equal(await runCli(args, context), 1); assert.match(output, /explicit/); assert.equal(f.state.requests.length, 0);
  output = '';
  assert.equal(await runCli([...args, '--max-cli-attempts', '5', '--max-seconds', '60'], context), 0);
  assert.equal(JSON.parse(output).reviewed, 1);
});

for (const mode of ['names', 'replay']) test(`${mode} final readiness rejects before publishing and success has no readiness check after publication`, t => {
  const f = fixture(t, 1, mode), path = artifact(f); let checks = 0;
  const base = { db: f.db, reviewOut: path, maxCliAttempts: 3, maxSeconds: 15 };
  const before = rows(f);
  if (mode === 'names') {
    const opts = { ...base, target: 'records', namesOnly: true, recordIds: f.ids };
    const runner = args => ({ users: [{ open_id: 'ou_synthetic_preview_peer_0', name: 'Synthetic Reader' }] });
    assert.throws(() => executeEnrichment(opts, { runLark: runner, assertReady: () => { if (++checks === 2) throw new MaintenanceRequestError('time_budget'); } }), /time_budget/);
    assert.equal(existsSync(path), false);
    checks = 0;
    const report = executeEnrichment(opts, { runLark: runner, assertReady: () => { checks++; assert.equal(existsSync(path), false); } });
    assert.equal(report.ok, true); assert.equal(checks, 2);
  } else {
    const opts = validateReplayOptions({ ...base, scopeIds: [SCOPE], messageIds: [f.messages[0].message_id], start: new Date(f.start).toISOString(), end: new Date(f.end).toISOString() });
    const deps = { getSelfProfile: () => SELF, fetchChatMessages: () => ({ messages: f.messages, pages: 1 }),
      createRequestSession: () => ({ runLark() { assert.fail('no remote'); }, summary: () => ({}), assertReady() { if (++checks === 3) throw new MaintenanceRequestError('time_budget'); } }) };
    assert.equal(executeLarkImReplay(opts, deps).ok, false); assert.equal(existsSync(path), false);
    checks = 0; deps.createRequestSession = () => ({ runLark() {}, summary: () => ({}), assertReady() { checks++; assert.equal(existsSync(path), false); } });
    assert.equal(executeLarkImReplay(opts, deps).ok, true); assert.equal(checks, 3);
  }
  assert.ok(existsSync(path)); noWrites(f, before);
});


test('interruption at the actual post-publication manifest boundary preserves an adoptable complete file', t => {
  const f = fixture(t, 1), originalClock = f.deps.requestSessionDeps.monotonicClock;
  let interrupted = false;
  f.deps.requestSessionDeps.monotonicClock = () => {
    if (existsSync(artifact(f)) && !interrupted) { interrupted = true; throw new Error('Synthetic process interruption'); }
    return originalClock();
  };
  // The outer command can persist a stopped run after a catchable interruption;
  // the same existing artifact is then locally adopted instead of requested again.
  const result = run(f); assert.equal(result.ok, false); assert.ok(existsSync(artifact(f)));
  f.deps.requestSessionDeps.monotonicClock = originalClock;
  const resumed = run(f, { resume: true }); assert.equal(resumed.ok, true);
  assert.equal(resumed.request_budget.cli_attempts, 0); assert.equal(f.state.requests.length, 1);
});

test('reentrant coordinator is excluded by its own real flock without a second API request', t => {
  const f = fixture(t, 1), spawn = f.deps.requestSessionDeps.spawnSync;
  f.deps.requestSessionDeps.spawnSync = (...args) => {
    assert.throws(() => run(f, { resume: true }), /progress_busy/);
    assert.equal(getLarkApiLeaseStdio(), undefined, 'coordination lock never masquerades as a global API descriptor');
    return spawn(...args);
  };
  assert.equal(run(f).ok, true); assert.equal(f.state.requests.length, 1);
});

test('global budget includes all-reused local validation and does not claim success after expiry', t => {
  const f = fixture(t, 1); run(f); const manifestBefore = readFileSync(manifest(f));
  let reads = 0;
  const clock = f.deps.requestSessionDeps.monotonicClock;
  f.deps.requestSessionDeps.monotonicClock = () => {
    // Lease admission consumes four clock reads; the later reads bracket local
    // evidence validation. Expire only after coordinator admission succeeds.
    if (++reads >= 6) f.state.time = 61000;
    return clock();
  };
  assert.throws(() => run(f, { resume: true }), /time_budget/);
  assert.equal(f.state.requests.length, 1); assert.deepEqual(readFileSync(manifest(f)), manifestBefore);
});

test('allowed v3 hot scheduling drift still reuses exact complete local evidence', t => {
  const f = fixture(t, 1); run(f);
  sql(f, "UPDATE sync_scopes SET config_json=json_set(config_json,'$.hot_rank',2,'$.hot_seen_at','Synthetic later hot snapshot','$.last_hot_snapshot_id','Synthetic rotation');");
  const result = run(f, { resume: true }); assert.equal(result.ok, true); assert.equal(result.request_budget.cli_attempts, 0);
});

test('replay resume rejects missing verified self even when orphan hash is not recorded', t => {
  const f = fixture(t, 1, 'replay'); assert.equal(run(f).ok, true);
  const review = json(artifact(f)); review.binding.verified_self_sha256 = null; write(artifact(f), review);
  const progress = json(manifest(f)); progress.units[0] = { state: 'pending', review_sha256: null, partial: false }; write(manifest(f), progress);
  const calls = f.state.requests.length;
  assert.throws(() => run(f, { resume: true }), /review rejected/); assert.equal(f.state.requests.length, calls);
});

test('unit timeout after a remote result cannot publish a partial review or continue another unit', t => {
  const f = fixture(t), before = rows(f), spawn = f.deps.requestSessionDeps.spawnSync;
  f.deps.requestSessionDeps.spawnSync = (...args) => { const result = spawn(...args); f.state.time += 10001; return result; };
  const result = run(f); assert.equal(result.stop_reason, 'time_budget'); assert.equal(f.state.requests.length, 1);
  assert.equal(existsSync(artifact(f)), false); assert.equal(existsSync(artifact(f, 2)), false); noWrites(f, before);
});


test('a freshly reviewed replay conflict is partial immediately and remains so on zero-API reuse', t => {
  const f = fixture(t, 1, 'replay'), spawn = f.deps.requestSessionDeps.spawnSync;
  f.deps.requestSessionDeps.spawnSync = (command, args, settings) => {
    if (args[0] !== 'api') return spawn(command, args, settings);
    f.state.requests.push(args);
    return ok({ code: 0, data: { items: f.messages.map(message => ({ ...message.raw_api,
      body: { content: '{"text":"Synthetic different text at same version"}' } })), has_more: false } });
  };
  const fresh = run(f); assert.equal(json(artifact(f)).records[0].outcome, 'conflict');
  assert.equal(fresh.partial, true); assert.equal(json(manifest(f)).units[0].partial, true);
  const reused = run(f, { resume: true }); assert.equal(reused.partial, true); assert.equal(reused.request_budget.cli_attempts, 0);
});

test('a complete multi-record names unit applies through the original fresh-fetch atomic review route', t => {
  const f = fixture(t, 2), before = rows(f);
  f.units = [{ mode: 'names', record_ids: f.ids, max_cli_attempts: 1, max_seconds: 10 }];
  write(f.plan, { schema: PLAN_SCHEMA, units: f.units });
  assert.equal(run(f).ok, true); assert.equal(f.state.requests.length, 1); noWrites(f, before);
  const result = executeEnrichment({ db: f.db, target: 'records', namesOnly: true, recordIds: f.ids,
    apply: true, reviewIn: artifact(f), reviewSha256: json(manifest(f)).units[0].review_sha256,
    maxCliAttempts: 1, maxSeconds: 10 }, f.deps);
  assert.equal(result.updated, 2); assert.equal(f.state.requests.length, 2, 'apply performs its own fresh lookup');
  assert.throws(() => run(f, { resume: true }), /snapshot_changed/, 'applied data no longer matches the old complete before');
});

for (const resume of [false, true]) test(`names review preserves a disabled first-seen scope through ${resume ? 'resume and ' : ''}fresh-fetch apply`, t => {
  const f = fixture(t, 2), before = rows(f);
  sql(f, `UPDATE sync_scopes SET enabled=0 WHERE id=${quoteSql(SCOPE)};`);
  f.units = [{ mode: 'names', record_ids: f.ids, max_cli_attempts: 1, max_seconds: 10 }];
  write(f.plan, { schema: PLAN_SCHEMA, units: f.units });
  assert.equal(run(f).ok, true);
  assert.equal(json(artifact(f)).binding.scopes[0].enabled, 0); noWrites(f, before);
  if (resume) {
    const reused = run(f, { resume: true });
    assert.equal(reused.ok, true); assert.equal(reused.request_budget.cli_attempts, 0);
    assert.equal(f.state.requests.length, 1); noWrites(f, before);
  }
  const applied = executeEnrichment({ db: f.db, target: 'records', namesOnly: true, recordIds: f.ids,
    apply: true, reviewIn: artifact(f), reviewSha256: json(manifest(f)).units[0].review_sha256,
    maxCliAttempts: 1, maxSeconds: 10 }, f.deps);
  assert.equal(applied.updated, 2); assert.equal(f.state.requests.length, 2);
  assert.equal(sqliteQuery(f.db, `SELECT enabled FROM sync_scopes WHERE id=${quoteSql(SCOPE)};`)[0].enabled, 0);
  const after = rows(f);
  for (let i = 0; i < before.length; i++) {
    assert.equal(JSON.parse(after[i].canonical_json).sender_name, `Synthetic Reader ${i}`);
    for (const column of ['raw_json', 'body', 'content_hash', 'external_version', 'first_seen_scope_id']) assert.equal(after[i][column], before[i][column]);
  }
});

for (const change of ['enable', 'disable', 'scope_source', 'scope_config', 'source_disabled', 'account', 'record']) {
  for (const route of ['resume', 'apply']) test(`names ${route} rejects ${change} drift with no new API or record writes`, t => {
    const f = fixture(t, 1);
    if (change !== 'disable') sql(f, `UPDATE sync_scopes SET enabled=0 WHERE id=${quoteSql(SCOPE)};`);
    assert.equal(run(f).ok, true);
    sql(f, ({ enable: `UPDATE sync_scopes SET enabled=1 WHERE id=${quoteSql(SCOPE)};`,
      disable: `UPDATE sync_scopes SET enabled=0 WHERE id=${quoteSql(SCOPE)};`,
      scope_source: `INSERT INTO sources(id,display_name,kind) VALUES('synthetic.other','Synthetic Other','synthetic'); UPDATE sync_scopes SET source_id='synthetic.other' WHERE id=${quoteSql(SCOPE)};`,
      scope_config: `UPDATE sync_scopes SET config_json=json_set(config_json,'$.unknown_policy',true) WHERE id=${quoteSql(SCOPE)};`,
      source_disabled: "UPDATE sources SET enabled=0 WHERE id='lark.im';",
      account: "UPDATE sources SET config_json=json_set(config_json,'$.initial_account_binding.account_key','" + 'a'.repeat(64) + "') WHERE id='lark.im';",
      record: `UPDATE records SET body='Synthetic changed body' WHERE id=${f.ids[0]};`,
    })[change]);
    const before = rows(f), saved = readFileSync(artifact(f)), progress = readFileSync(manifest(f));
    assert.throws(() => route === 'resume' ? run(f, { resume: true }) : executeEnrichment({ db: f.db,
      target: 'records', namesOnly: true, recordIds: f.ids, apply: true, reviewIn: artifact(f),
      reviewSha256: json(manifest(f)).units[0].review_sha256, maxCliAttempts: 1, maxSeconds: 10 }, f.deps), /review rejected/);
    assert.equal(f.state.requests.length, 1); noWrites(f, before);
    assert.deepEqual(readFileSync(artifact(f)), saved); assert.deepEqual(readFileSync(manifest(f)), progress);
  });
}

test('disabled replay scope rejects first preview and post-preview resume before new API', t => {
  const f = fixture(t, 1, 'replay');
  assert.equal(run(f).ok, true); const requests = f.state.requests.length;
  sql(f, `UPDATE sync_scopes SET enabled=0 WHERE id=${quoteSql(SCOPE)};`);
  assert.throws(() => run(f, { resume: true }), /binding_changed/);
  const otherProgress = join(f.root, 'disabled-replay'); mkdirSync(otherProgress, { mode: 0o700 });
  const disabled = run(f, { progressDir: otherProgress });
  assert.equal(disabled.ok, false); assert.equal(disabled.stop_reason, 'unit_failed');
  assert.equal(disabled.reviewed, 0); assert.equal(disabled.request_budget.cli_attempts, 0);
  assert.equal(f.state.requests.length, requests);
});

test('resolver catches cannot erase a failed monotonic wait before publication', t => {
  const f = fixture(t, 1, 'replay');
  f.deps.requestSessionDeps.sleep = () => {};
  const result = run(f); assert.equal(result.stop_reason, 'clock_unavailable');
  assert.equal(f.state.requests.length, 1); assert.equal(existsSync(artifact(f)), false);
});


test('busy retry count includes only additional sessions actually begun within the unit deadline', t => {
  const f = fixture(t, 1); f.units[0].max_seconds = 3; write(f.plan, { schema: PLAN_SCHEMA, units: f.units });
  f.deps.requestSessionDeps.tryAcquireLease = () => { f.state.acquire++; return { state: 'busy' }; };
  const result = run(f); assert.equal(result.stop_reason, 'time_budget'); assert.equal(result.busy_retries, 1);
  assert.equal(f.state.acquire, 2); assert.deepEqual(f.state.pauses, [2000]); assert.equal(f.state.requests.length, 0);
});
