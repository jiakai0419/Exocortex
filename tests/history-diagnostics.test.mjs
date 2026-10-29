import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeHistoryDiagnostic, sanitizeHistorySelectionStops } from '../dist/core/history-diagnostics.js';
import { compactHistorySummary } from '../dist/runtime/worker/lark-im-worker-core.js';
import { historyFailureDiagnostic } from '../src/maintenance/history-diagnostics.mjs';
import { SqliteReadError } from '../src/storage/sqlite/readonly-query.mjs';

test('finite diagnostics retain real local categories without serializing errors or trusting lookalikes',()=>{
  const secret='INVENTED_PRIVATE_ERROR_BODY_SQL_PATH';
  for(const kind of ['dependency_unavailable','read_timeout','read_failed','invalid_response']) {
    const error=Object.assign(new SqliteReadError(kind,secret),{sql:secret,path:secret,record_id:983});
    assert.deepEqual(historyFailureDiagnostic(error,'batch_select','failure'),{version:1,stage:'batch_select',kind});
    assert.deepEqual(historyFailureDiagnostic(error,'metadata_read','hint'),{version:1,stage:'metadata_read',kind});
  }
  for(const error of [new Error(secret),secret,null,{name:'SqliteReadError',reason:'read_timeout',message:secret}])
    assert.deepEqual(historyFailureDiagnostic(error,'batch_commit','failure'),{version:1,stage:'batch_commit',kind:'unknown'});
  assert.deepEqual(historyFailureDiagnostic(new SyntaxError(secret),'source_policy_decode','hint'),
    {version:1,stage:'source_policy_decode',kind:'invalid_policy'});
});

test('worker accepts only exact diagnostic structures and bounded selection counters',()=>{
  const failure={version:1,stage:'batch_commit',kind:'unknown'};
  const hint={version:1,stage:'metadata_read',kind:'read_timeout'};
  const input={ok:false,outcome:'batch_interrupted',processed:3,
    failure_diagnostic:failure,priority_hint_diagnostic:hint,
    selection_stop_counts:{outside_pool:2,source_changed:1},request_budget:{cli_attempts:3,stop_reason:null}};
  const result=compactHistorySummary(input);
  assert.deepEqual(result.failure_diagnostic,failure);assert.deepEqual(result.priority_hint_diagnostic,hint);
  assert.deepEqual(result.selection_stop_counts,input.selection_stop_counts);
  for(const bad of [null,[],{}, {...failure,version:2},{...failure,stage:'INVENTED_PRIVATE_STAGE'},
    {...failure,kind:'INVENTED_PRIVATE_KIND'},{...failure,sql:'INVENTED_PRIVATE_SQL'},
    {version:1,stage:'batch_commit'},Object.assign(Object.create(failure),{a:1,b:2,c:3})]) {
    assert.equal(sanitizeHistoryDiagnostic(bad,'failure'),null);
    assert.equal(compactHistorySummary({...input,failure_diagnostic:bad}).failure_diagnostic,undefined);
  }
  assert.equal(sanitizeHistoryDiagnostic(hint,'failure'),null);
  assert.equal(sanitizeHistoryDiagnostic(failure,'hint'),null);
  for(const bad of [null,[],{}, {unknown:1},{outside_pool:-1},{outside_pool:1.5},{outside_pool:'1'},
    {outside_pool:13},{outside_pool:12,source_changed:1},{source_changed:Infinity}]) {
    assert.equal(sanitizeHistorySelectionStops(bad),null);
    assert.equal(compactHistorySummary({...input,selection_stop_counts:bad}).selection_stop_counts,undefined);
  }
  assert.deepEqual(sanitizeHistorySelectionStops({outside_pool:12}),{outside_pool:12});
});
