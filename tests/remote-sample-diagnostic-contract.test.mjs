import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteReadError } from '../src/storage/sqlite/readonly-query.mjs';
import { SampleEvidenceError, collectorDiagnostic, safeCollectorDiagnostic } from '../src/diagnostics/remote-sample-diagnostic.mjs';
import { inspectRemoteSampleSnapshot } from '../src/diagnostics/remote-sample-coverage.mjs';
import { runReadOnlyRemoteSample } from '../src/diagnostics/remote-sample.mjs';

const privateText = 'synthetic_private_exception_path_body';
const now = Date.parse('2030-01-01T01:00:00.000Z');
const key = 'c'.repeat(64);
const target = { key, scope_id: 'lark.im.received.chat.synthetic_contract', message_id: 'synthetic_contract_message', created_ms: now - 60000 };
const good = { kind: 'lark_im_sample_snapshot/v1', checked_at_ms: now,
  coverage: { [key]: { covered: false, latest_finished_ms: null, details_pending: false, reason: 'no_covering_run' } }, records: [] };

test('failure diagnostic validates exact stage/code contracts without exposing arbitrary errors', () => {
  const valid = { version: 1, stage: 'snapshot', code: 'snapshot_budget_exhausted' };
  assert.deepEqual(safeCollectorDiagnostic(valid), valid);
  for (const invalid of [null, [], { ...valid, extra: privateText }, { ...valid, version: '1' },
    { ...valid, stage: privateText }, { ...valid, stage: 'comparison' }, { ...valid, code: privateText },
    { stage: 'snapshot', code: 'snapshot_budget_exhausted' }]) assert.equal(safeCollectorDiagnostic(invalid), null);
  const thrown = { get message() { assert.fail('must not read raw exception message'); },
    get stack() { assert.fail('must not read stack'); }, code: privateText };
  assert.deepEqual(collectorDiagnostic('comparison', thrown), { version: 1, stage: 'comparison', code: 'unexpected_error' });
  for (const [error, code] of [[new Error(privateText), 'unexpected_error'], [new TypeError(privateText), 'type_error'],
    [new RangeError(privateText), 'range_error'], [new SyntaxError(privateText), 'syntax_error']]) {
    const diagnostic = collectorDiagnostic('comparison', error);
    assert.equal(diagnostic.code, code);
    assert.equal(JSON.stringify(diagnostic).includes(privateText), false);
  }
  for (const reason of ['dependency_unavailable', 'read_timeout', 'read_failed', 'invalid_response']) {
    assert.equal(collectorDiagnostic('inventory', new SqliteReadError(reason, privateText)).code, `sqlite_${reason}`);
  }
  assert.equal(collectorDiagnostic('comparison', new SampleEvidenceError(privateText, 'snapshot_invalid_targets')).code, 'unexpected_error');
});

const failures = [
  ['snapshot_dependency_unavailable', { error: { code: 'ENOENT', message: privateText }, status: null }],
  ['snapshot_timeout', { error: { code: 'ETIMEDOUT', message: privateText }, signal: 'SIGKILL', status: null }],
  ['snapshot_process_signal', { signal: 'SIGSEGV', status: null }],
  ['snapshot_execution_failed', { status: 2, stderr: privateText }],
  ['snapshot_invalid_json', { status: 0, stdout: privateText }],
  ['snapshot_output_schema', { status: 0, stdout: JSON.stringify({ ...good, checked_at_ms: now + 1 }) }],
  ['snapshot_coverage_invariant', { status: 0, stdout: JSON.stringify({ ...good, coverage: { [key]: { ...good.coverage[key], covered: true } } }) }],
  ['snapshot_record_schema', { status: 0, stdout: JSON.stringify({ ...good, records: [{ external_id: privateText }] }) }],
  ['snapshot_budget_exhausted', { status: 0, stdout: JSON.stringify({ ...good, error: 'inspection_budget_exhausted' }) }],
  ['snapshot_read_failed', { status: 0, stdout: JSON.stringify({ ...good, error: 'readonly_inspection_failed' }) }],
];
for (const [code, result] of failures) test(`snapshot rejection retains fixed category ${code}`, () => {
  assert.throws(() => inspectRemoteSampleSnapshot('/synthetic/private.db', [target], { now: () => now,
    spawnSync: () => result }), error => {
      assert.ok(error instanceof SampleEvidenceError);
      assert.equal(collectorDiagnostic('snapshot', error).code, code);
      assert.equal(JSON.stringify(collectorDiagnostic('snapshot', error)).includes(privateText), false);
      return true;
    });
});


test('guarded one-shot entry retains collector failure and rejects contradictory healthy child output', () => {
  const diagnostic = { version: 1, stage: 'snapshot', code: 'snapshot_budget_exhausted' };
  for (const value of [diagnostic, null, { ...diagnostic, error: privateText }]) {
    const report = { schema_version: 3, ok: true, status: 'healthy', reason: null,
      binding: { state: 'verified', evidence: 'single_sent_actor' }, probe: { remote_messages_checked: 1 },
      collector_diagnostic: value };
    let calls = 0;
    const result = runReadOnlyRemoteSample('/synthetic/readonly.db', {}, { now: () => now,
      spawnSync: () => { calls++; return { status: 0, stdout: JSON.stringify({ outcome: 'ok', report }) }; } });
    assert.equal(calls, 1);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.report.ok, false);
    assert.equal(result.report.status, 'unavailable');
    assert.equal(result.report.reason, 'invalid_evidence');
    assert.equal(JSON.stringify(result).includes(privateText), false);
    if (value === diagnostic) assert.deepEqual(result.report.collector_diagnostic, diagnostic);
    else assert.equal(Object.hasOwn(result.report, 'collector_diagnostic'), false);
  }
});
