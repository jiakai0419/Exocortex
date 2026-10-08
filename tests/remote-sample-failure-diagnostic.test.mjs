import test from 'node:test';
import assert from 'node:assert/strict';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { collectRemoteSample, createSampleApi } from '../src/diagnostics/remote-sample.mjs';
import { inspectRemoteSampleSnapshot } from '../src/diagnostics/remote-sample-coverage.mjs';
import { parseRemoteSampleCache, remoteSampleCache } from '../src/diagnostics/remote-sample-cache.mjs';

const started = Date.parse('2030-01-03T12:00:00Z');
const created = started - 3600000;
const binding = { state: 'verified', evidence: 'single_sent_actor',
  database_key: 'a'.repeat(64), account_key: 'b'.repeat(64) };
const database = '/synthetic/failure-diagnostic.db';
const inventory = Array.from({ length: 5 }, (_, i) => ({
  id: chatScopeId(`synthetic_diagnostic_chat_${i}`), chat_id: `synthetic_diagnostic_chat_${i}`,
  source_id: 'lark.im', enabled: 1, hot_rank: i, hot_seen_at: new Date(started).toISOString(),
}));
const privateText = 'synthetic diagnostic private payload';
const rotation = 17;
const previousObservations = Object.freeze({ ['c'.repeat(64)]: Object.freeze({
  kind: 'version', target: created, first_seen: started - 1800000,
  last_seen: started - 900000, run_finished: started - 1200000,
}) });

function snapshotProcessResult(failure, targets, at) {
  switch (failure) {
    case 'coverage_execution': return { status: 1, stdout: '', stderr: privateText };
    case 'coverage_timeout': return { status: null, error: { code: 'ETIMEDOUT', message: privateText } };
    case 'coverage_signal': return { status: null, signal: 'SIGKILL', stderr: privateText };
    case 'coverage_dependency': return { status: null, error: { code: 'ENOENT', message: privateText } };
    case 'coverage_json': return { status: 0, stdout: privateText };
    case 'coverage_schema': return { status: 0, stdout: JSON.stringify({ kind: 'lark_im_sample_snapshot/v1', records: privateText }) };
    case 'coverage_invariant':
      return { status: 0, stdout: JSON.stringify({ kind: 'lark_im_sample_snapshot/v1', checked_at_ms: at,
        coverage: Object.fromEntries(targets.map(target => [target.key, {
          covered: true, reason: 'covered', details_pending: false, latest_finished_ms: target.created_ms - 1,
        }])), records: [] }) };
    case 'coverage_budget':
    case 'coverage_read':
      return { status: 0, stdout: JSON.stringify({ kind: 'lark_im_sample_snapshot/v1',
        error: failure === 'coverage_budget' ? 'inspection_budget_exhausted' : 'readonly_inspection_failed' }), stderr: privateText };
    default: assert.fail(`unknown synthetic failure: ${failure}`);
  }
}

// Both paths use the actual request counter, pacing and lease cleanup. The fake
// executable returns only data created here; no process, API or database runs.
function collectAtFailure(failure) {
  let at = started; let leases = 0; let releases = 0; let identityCalls = 0;
  let messageCalls = 0; let snapshotCalls = 0;
  const requestedChats = new Set();
  const api = createSampleApi(database, {}, {
    now: () => at,
    sleep: ms => { at += ms; },
    tryAcquireLease: () => {
      leases++;
      return { state: 'acquired', release: () => { releases++; } };
    },
    spawnSync: (_binary, args) => {
      const path = args[2];
      let data;
      if (path === '/open-apis/authen/v1/user_info') {
        identityCalls++;
        data = { open_id: 'ou_synthetic_diagnostic_self', tenant_key: 'synthetic_diagnostic_tenant' };
      } else {
        assert.equal(path, '/open-apis/im/v1/messages');
        const params = JSON.parse(args[args.indexOf('--params') + 1]);
        requestedChats.add(params.container_id);
        messageCalls++;
        // Two valid, still-paginated pages truncate the first chat. Three more
        // chats have one page each. The last chat either ends on page six or
        // requests a seventh page whose native pagination schema is invalid.
        const failSeventhPage = ['native_page', 'message_shape'].includes(failure);
        const hasMore = messageCalls <= 2 || failSeventhPage && messageCalls === 6;
        data = { items: [{ message_id: `synthetic_diagnostic_message_${messageCalls}`,
          chat_id: params.container_id, msg_type: 'text', create_time: String(created),
          update_time: String(created), body: { content: JSON.stringify({ text: privateText }) } }],
        has_more: hasMore, page_token: hasMore ? `synthetic_diagnostic_token_${messageCalls}` : '' };
        if (failure === 'native_page' && messageCalls === 7) data.has_more = 'true';
        if (failure === 'message_shape' && messageCalls === 7) data.items[0].body.content = null;
      }
      return { status: 0, stdout: JSON.stringify({ code: 0, data }) };
    },
  });
  const result = collectRemoteSample(database, { rotation, previousObservations, accountKey: binding.account_key }, {
    now: () => at, api, context: () => ({ database_key: binding.database_key }),
    loadInventory: () => inventory,
    readBinding: () => binding,
    inspectSnapshot: (db, targets, options) => {
      snapshotCalls++;
      assert.equal(targets.length, 6);
      if (failure === 'comparison') {
        return { coverage: {}, records: { get: () => { throw new TypeError(privateText); } } };
      }
      // Exercise the real coverage wrapper's existing rejection, including its
      // validation of collector-generated targets, rather than inventing an Error.
      return inspectRemoteSampleSnapshot(db, targets, { ...options,
        spawnSync: () => snapshotProcessResult(failure, targets, at) });
    },
  });
  assert.equal(api.count(), 8);
  assert.equal(leases, 8);
  assert.equal(releases, 8);
  assert.equal(requestedChats.size, 5);
  assert.equal(result.rotation, rotation);
  assert.equal(result.observations, previousObservations);
  assert.equal(result.retryAtMs, 0);
  assert.deepEqual(result.cooldownsByOperation, {});
  return { result, identityCalls, messageCalls, snapshotCalls };
}

function assertDiagnosedFailedCache(result, stage, code) {
  assert.equal(result.outcome, 'failed');
  assert.equal(result.report.status, 'unavailable');
  assert.equal(result.report.reason, 'invalid_evidence');
  const { api_calls, pages, chats_checked, truncated_chats, remote_messages_checked, probe_errors } = result.report.probe;
  assert.deepEqual({ api_calls, pages, chats_checked, truncated_chats, remote_messages_checked, probe_errors },
    { api_calls: 8, pages: 6, chats_checked: 5, truncated_chats: 1, remote_messages_checked: 0, probe_errors: 1 });
  const diagnostic = { version: 1, stage, code };
  assert.deepEqual(result.report.collector_diagnostic, diagnostic);
  const cache = remoteSampleCache(result);
  assert.ok(parseRemoteSampleCache(cache));
  assert.deepEqual(cache.collector_diagnostic, diagnostic);
  const serialized = JSON.stringify(cache);
  for (const token of [privateText, 'synthetic_diagnostic_chat_', 'synthetic_diagnostic_message_',
    'synthetic_diagnostic_token_', 'ou_synthetic_diagnostic_self', 'synthetic_diagnostic_tenant']) {
    assert.equal(serialized.includes(token), false);
  }
}

test('same bounded failure counts can come from a rejected seventh native message page', () => {
  const { result, identityCalls, messageCalls, snapshotCalls } = collectAtFailure('native_page');
  assert.equal(identityCalls, 1);
  assert.equal(messageCalls, 7);
  assert.equal(snapshotCalls, 0);
  assertDiagnosedFailedCache(result, 'message_page', 'invalid_page_schema');
});

test('same bounded failure counts can come from coverage execution after both identity checks', () => {
  const { result, identityCalls, messageCalls, snapshotCalls } = collectAtFailure('coverage_execution');
  assert.equal(identityCalls, 2);
  assert.equal(messageCalls, 6);
  assert.equal(snapshotCalls, 1);
  assertDiagnosedFailedCache(result, 'snapshot', 'snapshot_execution_failed');
});

for (const [failure, code] of [
  ['coverage_budget', 'snapshot_budget_exhausted'],
  ['coverage_read', 'snapshot_read_failed'],
  ['coverage_timeout', 'snapshot_timeout'],
  ['coverage_signal', 'snapshot_process_signal'],
  ['coverage_dependency', 'snapshot_dependency_unavailable'],
  ['coverage_json', 'snapshot_invalid_json'],
  ['coverage_schema', 'snapshot_output_schema'],
  ['coverage_invariant', 'snapshot_coverage_invariant'],
]) {
  test(`coverage rejection ${failure} keeps its fixed diagnostic and retained observations`, () => {
    const { result, identityCalls, messageCalls, snapshotCalls } = collectAtFailure(failure);
    assert.equal(identityCalls, 2);
    assert.equal(messageCalls, 6);
    assert.equal(snapshotCalls, 1);
    assertDiagnosedFailedCache(result, 'snapshot', code);
  });
}

test('message shape rejection is distinguished from native pagination rejection', () => {
  const { result, identityCalls, messageCalls, snapshotCalls } = collectAtFailure('message_shape');
  assert.equal(identityCalls, 1);
  assert.equal(messageCalls, 7);
  assert.equal(snapshotCalls, 0);
  assertDiagnosedFailedCache(result, 'message_shape', 'invalid_message_schema');
});

test('a comparison TypeError preserves prior evidence without disclosing its message', () => {
  const { result, identityCalls, messageCalls, snapshotCalls } = collectAtFailure('comparison');
  assert.equal(identityCalls, 2);
  assert.equal(messageCalls, 6);
  assert.equal(snapshotCalls, 1);
  assertDiagnosedFailedCache(result, 'comparison', 'type_error');
});
