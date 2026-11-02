import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';
import { createSyncRunner } from '../src/adapters/lark-im/sync-runner.mjs';
import { compactIdleEvidence, idleAdmission } from '../src/runtime/worker/idle-admission.mjs';
import { REQUIRED_CYCLE_STEPS } from '../src/runtime/worker/step-vocabulary.mjs';
import { compactSummary, cycleHealthyWithoutHistory } from '../dist/runtime/worker/lark-im-worker-core.js';
import { runStep } from '../src/runtime/worker/worker.mjs';

const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const COUNTERS = ['calls','attempts','retries','rate_limits','timeouts','wait_ms',
  'max_retry_after_ms','cooldown_until_ms','exhausted','retry_after_unknown'];
function transport() {
  const counters = Object.fromEntries(COUNTERS.map(key => [key, 0]));
  return { ...counters, by_operation: {}, cooldowns_by_operation: {} };
}
function proofRun() {
  return { ok: false, list_complete: true, details_complete: false, incomplete: true,
    pending_details: 2,
    detail_retry: { ok: false, skipped: true, reason: 'details_not_due', detail_attempts: 0 },
    idle_detail_backoff: { version: 1, kind: 'saved_list_backoff', pending_details: 2, detail_attempts: 0 } };
}
function rawPartial(run = proofRun()) {
  return { ok: false, partial: true, incomplete: true, sent: run, received: [], transport: transport() };
}
function steps(summary = rawPartial()) {
  return REQUIRED_CYCLE_STEPS.map((name, index) => ({ name, ok: index !== 0,
    exit_code: index === 0 ? 2 : 0, stderr: '', ...(index === 0 ? { partial: true } : {}),
    summary: compactSummary(index === 0 ? summary : { ok: true, transport: transport() }) }));
}
function producer(overrides = {}) {
  const calls = [];
  const scope = { id: 'lark.im.sent_by_me', source_id: 'lark.im', enabled: 1,
    source_enabled: 1, config: {}, config_json: '{}', cursor: null };
  let clock = 0;
  const deps = {
    isMaintenanceLocked: () => false, readScope: () => ({ ...scope }),
    readLarkListProgress: () => null, acquireLock: () => true,
    createRun: () => 1, releaseLock: () => calls.push('release'), failRun: () => calls.push('fail'),
    nowMs: () => clock, nowIso: () => new Date(BASE).toISOString(),
    fetchSentMessageList: () => ({ messages: [], detailRoots: [], pages: 1 }),
    commitLarkListRun: () => ({ inserted: 0, updated: 0, duplicate: 0, pending_details: 2 }),
    readPendingLarkDetails: () => { calls.push('due'); return []; },
    readOnlySqliteJson: (_db, sql, _label, options) => {
      assert.equal(options.timeoutMs, 500);
      assert.match(sql, /attempt_count > 0/);
      assert.match(sql, /julianday\(retry_at\) > julianday/);
      assert.match(sql, /CAST\(config_json AS BLOB\)/);
      assert.doesNotMatch(sql, /raw_root_json/);
      calls.push('backoff'); return [{ pending: 2, backed_off: 2, source_current: 1 }];
    },
    fetchMessageDetails: () => { throw new Error('no detail request admitted by this fixture'); },
    ...overrides,
  };
  const opts = { startMs: BASE, endMs: BASE + 60_000, pageSize: 50, maxPages: 1,
    chatPageSize: 100, maxChatPages: 1, discoveryPagesPerRun: 1, receivedScopesPerRun: 1,
    discoveryMode: 'cursor', reconcileIntervalHours: 24, receivedMode: 'all', chatTypes: 'group,p2p',
    stableHorizonSeconds: 0, endExplicit: true, lockTtlSeconds: 600, retries: 0, retryDelayMs: 0,
    writeAdmission: { fence: { selfOpenId: 'ou_synthetic_self', accountKey: 'synthetic-account', sourceConfigJson: '{}' },
      assertCurrent: () => calls.push('admission') } };
  return { calls, opts, scope, setClock: value => { clock = value; },
    run: () => createSyncRunner(deps).syncSent('synthetic-unopened.sqlite', opts,
      { open_id: 'ou_synthetic_self', name: 'Synthetic Self' }) };
}

test('saved old backoff producer proof is emitted only after commit and release; partial health is unchanged', () => {
  const fixture = producer();
  const run = fixture.run();
  assert.deepEqual(run.idle_detail_backoff, proofRun().idle_detail_backoff);
  assert.equal(run.ok, false);
  assert.deepEqual(fixture.calls, ['release','due','backoff','admission']);
  const events = steps(rawPartial(run));
  assert.deepEqual(idleAdmission(events), { mode: 'known_records', why: 'saved_list_detail_backoff' });
  assert.equal(cycleHealthyWithoutHistory(events, true), false);
});

for (const [name, alter] of [
  ['scope release failure', () => producer({ releaseLock: () => { throw new Error('synthetic release failed'); } })],
  ['source conflict', () => producer({ commitLarkListRun: () => ({ pending_details: 2, conflicts: 1 }) })],
  ['fresh detail roots', () => producer({ fetchSentMessageList: () => ({ messages: [], detailRoots: [{}], pages: 1 }) })],
  ['due reader empty after generation race', () => producer({ readOnlySqliteJson: () => [{ pending: 2, backed_off: 1, source_current: 1 }] })],
  ['backoff count changed', () => producer({ readOnlySqliteJson: () => [{ pending: 3, backed_off: 3, source_current: 1 }] })],
  ['backoff metadata timeout', () => producer({ readOnlySqliteJson: () => { throw new Error('synthetic metadata timeout'); } })],
  ['malformed backoff metadata', () => producer({ readOnlySqliteJson: () => [{ pending: '2', backed_off: '2', source_current: 1 }] })],
  ['missing account admission', () => { const f = producer(); delete f.opts.writeAdmission; return f; }],
  ['missing source admission', () => { const f = producer(); delete f.opts.writeAdmission.fence.sourceConfigJson; return f; }],
  ['unknown current source', () => producer({ readOnlySqliteJson: () => [{ pending: 2, backed_off: 2 }] })],
  ['changed current source', () => producer({ readOnlySqliteJson: () => [{ pending: 2, backed_off: 2, source_current: 0 }] })],
  ['changed account', () => { const f = producer(); f.opts.writeAdmission.assertCurrent = () => { throw new Error('synthetic account changed'); }; return f; }],
  ['mismatched self', () => { const f = producer(); f.opts.writeAdmission.fence.selfOpenId = 'ou_synthetic_other'; return f; }],
  ['scope config changed', () => { let reads = 0; return producer({ readScope: () => ({ id: 'lark.im.sent_by_me', source_id: 'lark.im', enabled: 1,
    source_enabled: 1, config: {}, config_json: ++reads < 4 ? '{}' : '{"changed":true}', cursor: null }) }); }],
  ['detail budget exhausted', () => { let clock = 0; return producer({ nowMs: () => { clock += 40_000; return clock; } }); }],
  ['list failure and failure persistence failure', () => producer({ fetchSentMessageList: () => { throw new Error('synthetic list failed'); },
    failRun: () => { throw new Error('synthetic failRun failed'); } })],
]) test(`producer withholds idle proof: ${name}`, () => {
  assert.equal(alter().run().idle_detail_backoff, undefined);
});

test('actually attempted detail failure cannot earn the old-backoff proof', () => {
  const fixture = producer({ readPendingLarkDetails: () => [{ message_id: 'om_synthetic', fingerprint: 'synthetic', raw_root: {} }],
    finishLarkDetailRun: () => ({ pending_details: 2 }) });
  const run = fixture.run();
  assert.equal(run.detail_retry.detail_attempts, 1);
  assert.equal(run.idle_detail_backoff, undefined);
  assert.equal(idleAdmission(steps(rawPartial(run))).mode, 'none');
});

test('healthy forward preserves original three-lane policy without new legacy telemetry requirements', () => {
  const events = REQUIRED_CYCLE_STEPS.map(name => ({ name, ok: true, summary: {} }));
  assert.deepEqual(idleAdmission(events), { mode: 'all', why: 'healthy_forward' });
  assert.equal(cycleHealthyWithoutHistory(events, false), true);
});

for (const [name, alter] of [
  ['lookalike persisted error label', raw => { delete raw.sent.idle_detail_backoff; raw.sent.error_type = 'LarkDetailIncomplete'; }],
  ['wrong proof kind', raw => { raw.sent.idle_detail_backoff.kind = 'LarkDetailIncomplete'; }],
  ['unknown proof version', raw => { raw.sent.idle_detail_backoff.version = 2; }],
  ['unknown proof field', raw => { raw.sent.idle_detail_backoff.secret = 'synthetic-do-not-project'; }],
  ['proof count mismatch', raw => { raw.sent.idle_detail_backoff.pending_details = 1; }],
  ['fractional pending', raw => { raw.sent.pending_details = 0.5; }],
  ['attempted detail', raw => { raw.sent.detail_retry.detail_attempts = 1; }],
  ['unknown retry skip', raw => { raw.sent.detail_retry.reason = 'scope_locked'; }],
  ['nested release failure', raw => { raw.sent.detail_retry.lock_release_error = 'synthetic'; }],
  ['release error', raw => { raw.sent.lock_release_error = 'synthetic'; }],
  ['failure persistence error', raw => { raw.sent.fail_run_error = 'synthetic'; }],
  ['source conflict', raw => { raw.sent.conflicts = 1; }],
  ['mixed real failure', raw => { raw.received.push({ ok: false, error: 'synthetic' }); }],
  ['unknown skip beside proven failure', raw => { raw.received.push({ skipped: true, reason: 'scope_locked' }); }],
  ['details-only invocation', raw => { raw.details = [proofRun()]; }],
  ['forged precompacted marker', raw => { delete raw.sent.idle_detail_backoff; raw.idle_evidence = { version: 1, transport_clean: true, detail_backoff: { version: 1, failed_runs: 1, pending_details: 2 } }; }],
]) test(`raw proof negative: ${name}`, () => {
  const raw = rawPartial(); alter(raw);
  assert.equal(compactIdleEvidence(raw)?.detail_backoff, undefined);
  const compact = compactSummary(raw);
  assert.equal(JSON.stringify(compact).includes('synthetic-do-not-project'), false);
  assert.equal(idleAdmission(steps(raw)).mode, 'none');
});

for (const [name, alter] of [
  ['missing transport', raw => { delete raw.transport; }],
  ['missing retry counter', raw => { delete raw.transport.retries; }],
  ['non-numeric counter', raw => { raw.transport.timeouts = '0'; }],
  ['fractional counter', raw => { raw.transport.calls = 0.5; }],
  ['retry', raw => { raw.transport.retries = 1; }],
  ['timeout', raw => { raw.transport.timeouts = 1; }],
  ['rate limit', raw => { raw.transport.rate_limits = 1; }],
  ['exhaustion', raw => { raw.transport.exhausted = 1; }],
  ['unknown retry after', raw => { raw.transport.retry_after_unknown = 1; }],
  ['cooldown', raw => { raw.transport.cooldowns_by_operation.application_info = 1; }],
  ['unknown cooldown discarded by ordinary compaction', raw => { raw.transport.cooldowns_by_operation.synthetic_unknown_operation = 0; }],
  ['invalid cooldown discarded by ordinary compaction', raw => { raw.transport.cooldowns_by_operation.application_info = '0'; }],
  ['unknown operation discarded by ordinary compaction', raw => { raw.transport.by_operation.synthetic_unknown_operation = {}; }],
  ['per-operation pressure', raw => { raw.transport.by_operation.application_info = { ...transport(), timeouts: 1 }; }],
  ['unaccounted operation calls', raw => { raw.transport.calls = 1; raw.transport.attempts = 1; }],
]) test(`raw transport negative: ${name}`, () => {
  const raw = rawPartial(); alter(raw);
  assert.equal(compactIdleEvidence(raw), null);
  assert.equal(idleAdmission(steps(raw)).mode, 'none');
});

for (const [name, alter] of [
  ['incomplete forward set', events => { events.pop(); }],
  ['duplicate forward receipt', events => { events.push(events[1]); }],
  ['unknown optional step', events => { events.push({ name: 'unknown', ok: true }); }],
  ['wrong process exit', events => { events[0].exit_code = 1; }],
  ['missing process exit', events => { delete events[0].exit_code; }],
  ['unclassified stderr', events => { events[0].stderr = 'synthetic warning'; }],
  ['guardian failure', events => { events[0].guardian_diagnostic = { primary: { stage: 'deadline' } }; }],
  ['lost partial provenance', events => { delete events[0].partial; }],
  ['healthy neighbour lacks raw transport observation', events => { delete events[1].summary.idle_evidence; }],
  ['late transport override', events => { events[0].summary.transport.rate_limits = 1; }],
  ['failed retention', events => { events.push({ name: 'retention', ok: false, exit_code: 1 }); }],
]) test(`finished event negative: ${name}`, () => {
  const events = steps(); alter(events);
  assert.equal(idleAdmission(events).mode, 'none');
});

test('runStep preserves actual process failure despite otherwise eligible JSON', () => {
  const stdout = JSON.stringify(rawPartial());
  for (const failure of [{ signal: 'SIGTERM' }, { error: new Error('synthetic spawn failed') },
    { guardian_diagnostic: { primary: { stage: 'deadline' } } }]) {
    const event = runStep('sent', [], { runProcess: () => ({ status: 2, stdout, stderr: '', ...failure }) });
    const events = steps(); events[0] = event;
    assert.equal(event.partial, undefined);
    assert.equal(idleAdmission(events).mode, 'none');
  }
});

test('real runStep process envelope + producer proof reaches resources-only, never cycle success', () => {
  const stdout = JSON.stringify(rawPartial(producer().run()));
  const event = runStep('sent', [], { runProcess: () => ({ status: 2, stdout, stderr: '' }) });
  const events = steps(); events[0] = event;
  assert.deepEqual(idleAdmission(events), { mode: 'known_records', why: 'saved_list_detail_backoff' });
  assert.equal(cycleHealthyWithoutHistory(events, true), false);
});


test('backoff proof SQL distinguishes old future debt from due, fresh, invalid and changed debt', () => {
  const directory = mkdtempSync(join(tmpdir(), 'exocortex-idle-backoff-synthetic-'));
  const db = join(directory, 'authored.sqlite');
  const sql = input => {
    const result = spawnSync('sqlite3', [db], { input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    sql(`CREATE TABLE sources (id TEXT PRIMARY KEY, enabled INTEGER, config_json TEXT);
      INSERT INTO sources VALUES ('lark.im',1,'{}');
      CREATE TABLE lark_im_detail_tasks (scope_id TEXT, status TEXT, attempt_count INTEGER,
      descriptor_generation INTEGER, evidence_generation INTEGER, retry_at TEXT);
      INSERT INTO lark_im_detail_tasks VALUES
        ('lark.im.sent_by_me','pending',1,0,0,'2026-01-01T01:00:00.000Z'),
        ('lark.im.sent_by_me','pending',2,0,0,'2026-01-01T02:00:00.000Z');`);
    const fixture = producer({ readOnlySqliteJson: (_unused, statement, label, options) =>
      readOnlySqliteJson(db, statement, label, options) });
    assert.ok(fixture.run().idle_detail_backoff);
    for (const statement of [
      "UPDATE lark_im_detail_tasks SET attempt_count=0 WHERE rowid=1;",
      "UPDATE lark_im_detail_tasks SET attempt_count=1,retry_at='2025-12-31T23:59:59.000Z' WHERE rowid=1;",
      "UPDATE lark_im_detail_tasks SET retry_at='invalid' WHERE rowid=1;",
      "UPDATE lark_im_detail_tasks SET retry_at='2026-01-01T01:00:00.000Z',descriptor_generation=-1 WHERE rowid=1;",
      "UPDATE lark_im_detail_tasks SET descriptor_generation=0 WHERE rowid=1; DELETE FROM lark_im_detail_tasks WHERE rowid=2;",
    ]) {
      sql(statement);
      assert.equal(fixture.run().idle_detail_backoff, undefined);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('received aggregation retains one narrow failure among successful runs and full nonzero transport', () => {
  const raw = rawPartial();
  raw.sent = null;
  raw.received = [{ ok: true, pending_details: 0 }, proofRun()];
  const counters = Object.fromEntries(COUNTERS.map(key => [key, ['calls','attempts'].includes(key) ? 2 : 0]));
  raw.transport = { ...counters, cooldowns_by_operation: {}, by_operation: { message_history_bundle: { ...counters } } };
  const compact = compactSummary(raw);
  assert.deepEqual(compact.idle_evidence.detail_backoff, { version: 1, failed_runs: 1, pending_details: 2 });
  assert.equal(compact.received.failed, 1);
  assert.equal(compact.received.ok, false);
  assert.deepEqual(idleAdmission(steps(raw)), { mode: 'known_records', why: 'saved_list_detail_backoff' });
});

test('multiple proven partial forward steps remain resource-only and do not change any receipt', () => {
  const events = steps();
  events[2] = { ...events[0], name: 'received-hot' };
  const before = structuredClone(events);
  assert.deepEqual(idleAdmission(events), { mode: 'known_records', why: 'saved_list_detail_backoff' });
  assert.deepEqual(events, before);
  assert.equal(cycleHealthyWithoutHistory(events, true), false);
});
