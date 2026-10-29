import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import { prepareChatWindowRecords } from '../src/adapters/lark-im/sync-runner.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { activityDatabaseKey } from '../src/diagnostics/lark-im-activity-evidence.mjs';
import { digest, sampleScopeHash } from '../src/diagnostics/remote-sample-core.mjs';
import { writeRemoteSampleState, remoteSamplePaths } from '../src/runtime/worker/remote-sample-scheduler.mjs';
import { executeLarkImHistory } from '../src/maintenance/history.mjs';
import { collectRemoteSample } from '../src/diagnostics/remote-sample.mjs';
import { loadPendingHistoryVerifications } from '../src/diagnostics/remote-sample-history.mjs';
import { compactHistorySummary } from '../dist/runtime/worker/lark-im-worker-core.js';
import { readOnlySqliteJson, SqliteReadError } from '../src/storage/sqlite/readonly-query.mjs';

// Real SQLite writer transaction and final Python coverage/verification snapshot.
// Only remote responses and writer request-session transport are synthetic.
// The separate private paired benchmark exercises real children/guardians/leases.
const SELF = { open_id: 'ou_synthetic_recent_interleave_self', name: 'Synthetic observer' };
const CHAT = 'oc_synthetic_recent_interleave', SCOPE = chatScopeId(CHAT), q = store.quoteSql;
const sha = value => createHash('sha256').update(value).digest('hex');
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);

function fixture(t, ageHours, initialDeps = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'recent-verification-snapshot-')));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite');
  store.ensureInitialized(db);
  const created = Date.now() - ageHours * 3600000, sourceStart = created - 10000;
  const binding = { database_key: activityDatabaseKey(db), account_key: sha(`lark.im\0${SELF.open_id}`) };
  const scopeConfig = { chat_id: CHAT, chat_type: 'group' };
  const timestamp = new Date(sourceStart).toISOString();
  store.sqliteExec(db, `UPDATE sources SET config_json=${q(JSON.stringify({ initial_sync_start_ms: sourceStart,
    initial_account_binding: { kind: store.INITIAL_ACCOUNT_KIND, account_key: binding.account_key,
      reserved_at: timestamp, confirmed_at: timestamp } }))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(SCOPE)},'lark.im','Synthetic recent interleave',${q(JSON.stringify(scopeConfig))});`);
  const initial = { message_id: 'om_synthetic_recent_interleave', chat_id: CHAT, msg_type: 'text',
    create_time: String(created), update_time: String(created + 1000), deleted: false,
    sender: { id: 'ou_synthetic_recent_author', id_type: 'open_id', sender_type: 'user' },
    body: { content: '{"text":"Synthetic initial"}' } };
  const fresh = { ...initial, deleted: true, update_time: String(created + 2000), body: { content: '{"text":"Synthetic later acceptance"}' } };
  store.sqliteExec(db, store.upsertRecordsSql(prepareChatWindowRecords([normalizeApiMessage(initial)], SCOPE,
    null, created, created + 1000, SELF.open_id, { self: SELF }, scopeConfig)));
  const key = digest([binding.database_key, binding.account_key, CHAT, initial.message_id, created]);
  const observed = Date.now() - 5000;
  const observations = { [key]: { kind: 'version', target: created, first_seen: observed,
    last_seen: observed, run_finished: observed, last_checked: observed,
    scope_hash: sampleScopeHash(binding, CHAT), debts: { version: created + 2000, body: created + 2000, deleted: created + 2000 } } };
  writeRemoteSampleState(remoteSamplePaths(directory, binding.database_key).state,
    { kind: 'lark_im_remote_sample_schedule/v1', ...binding, written_at: observed, next_due: observed + 900000,
      failures: 0, rotation: 0, observations, last_outcome: 'ok', cooldowns: {}, blocked_reason: null }, observed);
  const query = sql => store.sqliteQuery(db, sql);
  const debt = () => query('SELECT * FROM lark_im_history_debt')[0];
  const runWriter = (remote, writerDeps = {}) => {
    let calls = 0;
    return executeLarkImHistory({ db, logDir: directory, maxRecords: 1, maxCliAttempts: 4, maxSeconds: 30 }, {
      createRequestSession: () => ({ runLark() { throw Error('unexpected synthetic transport'); }, assertReady() {},
        summary: () => ({ cli_attempts: calls, max_cli_attempts: 4, max_seconds: 30, elapsed_ms: 1, stop_reason: null }) }),
      getSelfProfile: () => { calls++; return SELF; },
      fetchChatMessageList: () => { calls++; return { messages: [normalizeApiMessage(remote)], pages: 1 }; },
      ...writerDeps,
    });
  };
  const initialWriter=runWriter(initial,initialDeps); // A legitimate equivalent acquisition creates the first bound ticket.
  return { db, directory, key, initial, fresh, observations, binding, query, debt, runWriter, initialWriter };
}

for (const ageHours of [1, 72]) for (const equalResponse of [false, true]) test(`${ageHours}h target, ${equalResponse ? 'positive-equal' : 'older'} response: acquisition before a new ticket cannot retire any debt in the real final snapshot`, t => {
  const f = fixture(t, ageHours);
  assert.equal(f.debt()?.status, 'awaiting_verification', JSON.stringify(compactHistorySummary(f.initialWriter)));
  const firstTicket = f.debt().verification_requested_at_ms;
  let calls = 0, identities = 0, acquiredAt, acceptedAt, latestTicket;
  const started = Date.now(), callsSeen = [];
  const result = collectRemoteSample(f.db, { previousObservations: f.observations,
    accountKey: f.binding.account_key, maxApiCalls: 12, maxSelfCalls: 6, remoteSampleBudgetMs: 25000 }, {
    api: { maxCalls: 12, maxSelfCalls: 6, deadline: started + 25000, count: () => calls,
      selfCount: () => identities, remainingMs: () => started + 25000 - Date.now(),
      call(path) {
        calls++; callsSeen.push(path);
        if (path.includes('/authen/')) {
          identities++;
          if (identities === 2) {
            assert.ok(acquiredAt, 'independent source response must already have been acquired');
            pause();
            const committed = f.runWriter(f.fresh);
            assert.equal(committed.updated, 1);
            latestTicket = f.debt().verification_requested_at_ms;
            acceptedAt = Date.now();
            assert.ok(latestTicket > firstTicket);
            pause(); // Force comparison to finish later than the writer's SQL clock.
          }
          return { code: 0, data: { open_id: SELF.open_id, tenant_key: 'synthetic_recent_tenant' } };
        }
        acquiredAt ??= Date.now();
        return { code: 0, data: { items: [structuredClone(equalResponse ? f.fresh : f.initial)], has_more: false, page_token: '' } };
      } },
    // No inspectSnapshot injection: the real Python reader must observe both
    // the newer committed record and its ticket in the same read transaction.
  });
  assert.equal(identities, 2);
  assert.ok(callsSeen.some(path => path.endsWith('/mget')), 'recent ticket needs a real targeted collector path');
  assert.ok(acceptedAt > acquiredAt);
  assert.equal(result.outcome, 'ok', JSON.stringify(result.report));
  if (equalResponse) assert.deepEqual(JSON.parse(f.query('SELECT raw_json FROM records')[0].raw_json), f.fresh,
    'positive-equal case has identical independently acquired source and final local record');
  assert.equal(result.report.ok, false, 'processed/accepted does not mean independently verified');
  assert.deepEqual(result.observations[f.key].debts, f.observations[f.key].debts);
  assert.ok(result.observations[f.key].last_checked < latestTicket,
    'comparison finish time cannot replace source-acquisition time and consume a later writer ticket');
  assert.ok(loadPendingHistoryVerifications(f.db, result.observations, f.binding, Date.now()).includes(f.key));
  assert.equal(result.pendingVerification, true);
  assert.equal(f.query('SELECT external_version FROM records')[0].external_version, f.fresh.update_time);
});

const PRIVATE_SENTINEL='INVENTED_PRIVATE_HISTORY_PATH_SQL_TOKEN';
const hintFaults = [
  { label:'missing state', reason:'state_missing', stage:'state_read', kind:'state_missing',
    deps:{readState:()=>({status:'missing'})} },
  { label:'invalid state', reason:'state_invalid', stage:'state_read', kind:'state_invalid',
    deps:{readState:()=>({status:'invalid'})} },
  { label:'unexpected state-reader exception', reason:'mapping_unavailable', stage:'state_read', kind:'unknown',
    deps:{readState:()=>{throw new Error(PRIVATE_SENTINEL);}} },
  { label:'invalid policy JSON', reason:'mapping_unavailable', stage:'source_policy_decode', kind:'invalid_policy',
    deps:{sqliteJson:(_db,_sql,label)=>{assert.equal(label,'read history debt policy');return [{enabled:1,config_json:PRIVATE_SENTINEL}];}} },
  { label:'malformed mapped metadata', reason:'mapping_unavailable', stage:'metadata_map', kind:'unknown',
    deps:{sqliteJson:(db,sql,label,options)=>label==='map history debt metadata'?[null]:readOnlySqliteJson(db,sql,label,options)} },
  { label:'forged error category remains unknown', reason:'mapping_unavailable', stage:'source_policy_read', kind:'unknown',
    deps:{sqliteJson:()=>{throw Object.assign(new Error(PRIVATE_SENTINEL),{name:'SqliteReadError',reason:'read_timeout'});}} },
  ...['source_policy_read','metadata_read'].flatMap(stage=>
    ['read_timeout','read_failed','invalid_response','dependency_unavailable'].map(kind=>({
      label:`${stage} ${kind}`,reason:'mapping_unavailable',stage,kind,
      deps:{sqliteJson:(db,sql,label,options)=>{
        if(label===(stage==='source_policy_read'?'read history debt policy':'map history debt metadata')) {
          assert.equal(options.timeoutMs,1000,'the original one-second read budget remains');
          throw new SqliteReadError(kind,PRIVATE_SENTINEL);
        }
        return readOnlySqliteJson(db,sql,label,options);
      }},
    }))),
];

for(const fault of hintFaults)test(`initial writer ${fault.label} preserves fair work and explains the missing priority ticket`,t=>{
  const f=fixture(t,1,{debtDeps:fault.deps}),result=f.initialWriter;
  assert.equal(result.ok,true);assert.equal(result.lane,'fair');assert.equal(result.priority_hint_reason,fault.reason);
  assert.deepEqual(result.priority_hint_diagnostic,{version:1,stage:fault.stage,kind:fault.kind});
  assert.equal(result.request_budget.cli_attempts,2);assert.equal(result.request_budget.stop_reason,null);
  assert.equal(f.debt(),undefined,'no priority ticket may be invented without valid hints');
  assert.deepEqual(JSON.parse(f.query('SELECT raw_json FROM records')[0].raw_json),f.initial);
  assert.equal(f.query('SELECT generation FROM lark_im_history_scheduler')[0].generation,1);
  const progress=f.query('SELECT after_id,completed_sweeps FROM lark_im_history_progress')[0];
  assert.deepEqual(progress,{after_id:1,completed_sweeps:1});
  const safe=compactHistorySummary(result);
  assert.deepEqual(safe.priority_hint_diagnostic,result.priority_hint_diagnostic);
  assert.doesNotMatch(JSON.stringify(safe),/INVENTED_PRIVATE|SELECT|record_id|scope_id|stack|message/);
});

test('healthy initial writer still creates the priority ticket without failure diagnostics',t=>{
  const f=fixture(t,1),result=f.initialWriter;
  assert.equal(result.ok,true);assert.equal(result.lane,'priority');assert.equal(result.priority_hint_reason,'ready');
  assert.equal(result.priority_hint_diagnostic,undefined);assert.equal(result.failure_diagnostic,undefined);
  assert.equal(f.debt()?.status,'awaiting_verification',JSON.stringify(compactHistorySummary(result)));
  assert.equal(result.request_budget.cli_attempts,2);assert.equal(result.request_budget.stop_reason,null);
});
