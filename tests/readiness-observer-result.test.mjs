import assert from 'node:assert/strict';
import test from 'node:test';
import { executeMessages } from '../src/cli/messages-command.mjs';
import { SqliteReadError } from '../src/storage/sqlite/readonly-query.mjs';
import { sqliteReadDiagnostic } from '../src/diagnostics/sqlite-read-diagnostic.mjs';
import { createHistoryCommandBudget } from '../src/maintenance/history-command-budget.mjs';
import { readinessFailure, failedReadinessObservation, normalizeReadinessObservation }
  from '../src/diagnostics/readiness-observer-result.mjs';
import { compactSummary } from '../dist/runtime/worker/lark-im-worker-core.js';
import { runStep } from '../src/runtime/worker/worker.mjs';

const secret = 'FICTIONAL_PRIVATE_SQL_TEXT_AND_ID';
const counts = { reason: 'observed', scanned: 2, observed: 1, deferred: 1 };
const read = sqliteReadDiagnostic({ stage: 'snapshot_query', kind: 'timeout',
  elapsedMs: 12, timeoutMs: 11, maxBufferBytes: 50 * 1024 * 1024,
  result: { status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' }, stdout: '', stderr: secret } });

test('actual messages exception wrapping preserves the finite original read receipt', () => {
  let failure;
  try {
    executeMessages({ db: '/synthetic/never-opened.sqlite', direction: 'all', limit: 1, search: '' }, {
      existsSync: () => true, readLocalChatAppNames: () => null,
      loadMessages() { throw new SqliteReadError('read_timeout', secret, read); },
    });
  } catch (error) { failure = readinessFailure('read', error); }
  assert.equal(failure.kind, 'sqlite_read'); assert.deepEqual(failure.read, read);
  assert(!JSON.stringify(failure).includes(secret));
});

test('lookalike error evidence and arbitrary messages are not trusted', () => {
  const failure = readinessFailure('read', Object.assign(new Error(secret), { readDiagnostic: read, reason: 'read_timeout' }));
  assert.equal(failure.kind, 'unknown'); assert.equal(failure.read, null);
  assert(!JSON.stringify(failure).includes(secret));
});

test('the actual budget exception survives without copying its message', () => {
  let time = 0;
  const b = createHistoryCommandBudget({ maxSeconds: 5 }, { monotonicClock: () => time });
  time = 5000;
  let failure;
  try { b.assertReady(); } catch (error) { failure = failedReadinessObservation('finish', error); }
  assert.equal(failure.diagnostic.kind, 'time_budget');
  assert.deepEqual(normalizeReadinessObservation({ ...failure, command_budget: b.summary() }).command_budget, b.summary());
});

test('worker process envelope keeps collection success and observer failure distinct', () => {
  const receipt = { reason: 'observation_failed', scanned: 2, observed: 0, deferred: 2,
    diagnostic: { version: 1, stage: 'read', kind: 'sqlite_read', read },
    claim_state: 'confirmed', finish_state: 'not_started', cleanup_state: 'succeeded' };
  const summary = { ok: true, sent: { ok: true, scanned: 0, list_complete: true }, readiness: receipt };
  const step = runStep('sent', [], { runProcess: () => ({ status: 0, stdout: JSON.stringify(summary), stderr: '' }) });
  assert.equal(step.ok, true); assert.equal(step.summary.ok, true);
  assert.deepEqual(step.summary.readiness, receipt);
  assert(!JSON.stringify(step).includes(secret));
});

test('confirmed finish counts are retained alongside a separate cleanup failure', () => {
  const receipt = { ...counts, claim_state: 'confirmed', finish_state: 'confirmed', cleanup_state: 'failed',
    cleanup_diagnostic: { version: 1, stage: 'release', kind: 'cleanup_failed', read: null } };
  assert.deepEqual(compactSummary({ ok: true, readiness: receipt }).readiness, receipt);
});

for (const [name, value] of [
  ['extra private data', { ...counts, raw: secret }],
  ['invalid reason', { ...counts, reason: secret }],
  ['inconsistent denominator', { ...counts, scanned: 3 }],
  ['excess capacity', { ...counts, scanned: 41, observed: 40, deferred: 1 }],
  ['negative count', { ...counts, observed: -1, deferred: 3 }],
  ['invented phase', { ...counts, diagnostic: { version: 1, stage: secret, kind: 'unknown', read: null } }],
  ['unbounded diagnostic', { ...counts, diagnostic: { version: 1, stage: 'read', kind: 'unknown', read: null, message: secret } }],
  ['pretend larger budget', { ...counts, command_budget: { version: 1, max_ms: 30000, elapsed_ms: 2, stop_reason: null, complete: true } }],
  ['invalid commit state', { ...counts, finish_state: secret }],
  ['unknown finish claiming observations', { ...counts, finish_state: 'unknown' }],
  ['unstarted finish claiming observations', { ...counts, finish_state: 'not_started' }],
  ['unknown claim with confirmed finish', { ...counts, claim_state: 'unknown', finish_state: 'confirmed' }],
  ['conflicting commit result', { ...counts, reason: 'commit_unconfirmed', finish_state: 'confirmed' }],
]) test(`closed observer receipt rejects ${name}`, () => {
  assert.equal(normalizeReadinessObservation(value), null);
  const compact = compactSummary({ ok: true, readiness: value });
  assert.equal(compact.ok, true);
  assert.equal(compact.readiness.reason, 'observation_failed');
  assert.equal(compact.readiness.diagnostic.kind, 'invalid_response');
  assert(!JSON.stringify(compact).includes(secret));
});

test('receipt accessors are rejected without evaluation', () => {
  let reads = 0;
  const value = { ...counts, get diagnostic() { reads++; throw new Error(secret); } };
  assert.equal(normalizeReadinessObservation(value), null); assert.equal(reads, 0);
});
