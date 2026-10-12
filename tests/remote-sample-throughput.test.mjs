import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { collectRemoteSample } from '../src/diagnostics/remote-sample.mjs';
import { digest, sampleScopeHash, selectSampleChats } from '../src/diagnostics/remote-sample-core.mjs';
import { selectHistoricalObservations, loadPendingHistoryVerifications } from '../src/diagnostics/remote-sample-history.mjs';
import { scopeObservationContext } from '../src/maintenance/scope-config-policy.mjs';
import { remoteSampleCache, parseRemoteSampleCache, publicRemoteReport } from '../src/diagnostics/remote-sample-cache.mjs';
import { activityDatabaseKey } from '../src/diagnostics/lark-im-activity-evidence.mjs';
import { createRemoteSamplePublication } from '../src/runtime/worker/remote-sample-cache-gate.mjs';
import { executeRemoteSampleAttempt, nextRemoteSampleDue, startScheduledRemoteSample, remoteSamplePaths, readRemoteSampleState, writeRemoteSampleState } from '../src/runtime/worker/remote-sample-scheduler.mjs';

const START = Date.parse('2036-04-20T12:00:00Z');
const binding = { state: 'verified', evidence: 'single_sent_actor', database_key: 'a'.repeat(64), account_key: 'b'.repeat(64) };
const created = START - 3 * 86400000;
const rows = Array.from({ length: 9 }, (_, index) => ({ id: chatScopeId(`synthetic_chat_${index}`), chat_id: `synthetic_chat_${index}`,
  source_id: 'lark.im', enabled: 1, hot_rank: index < 2 ? index : null, hot_seen_at: new Date(START).toISOString() }));
const message = (index, sameWindow = false) => ({ message_id: `synthetic_history_${index}`, chat_id: rows[8].chat_id, msg_type: 'text',
  create_time: String(created + (sameWindow ? 0 : index * 10000)), update_time: String(START - 3600000), body: { content: '{"text":"synthetic"}' } });
const keyFor = item => digest([binding.database_key, binding.account_key, item.chat_id, item.message_id, Number(item.create_time)]);
const local = item => ({ source_id: 'lark.im', record_type: 'lark.im.message', external_id: item.message_id, container_id: item.chat_id,
  external_version: item.update_time, raw_json: JSON.stringify(item), canonical_json: JSON.stringify({ source_api: 'im.v1.messages' }) });
const observation = (item, index) => ({ kind: 'version', target: Number(item.create_time), first_seen: START - 600000 + index,
  last_seen: START - 600000 + index, run_finished: START - 700000, last_checked: START - 600000 + index,
  scope_hash: sampleScopeHash(binding, item.chat_id), debts: { version: Number(item.update_time) } });
function collect({ count = 3, latency = 1, sameWindow = false, pages = 2, previous, priority = [], apiFailure = null, budget, rotation = 0, busyAt = 0, overheadMs = 0 } = {}) {
  const old = Array.from({ length: count }, (_, index) => message(index, sameWindow));
  const observations = previous || Object.fromEntries(old.map((item, index) => [keyFor(item), observation(item, index)]));
  const records = new Map(old.map(item => [item.message_id, local(item)]));
  let time = START; let acquisitions = 0; const calls = [];
  const result = collectRemoteSample('/synthetic/unopened.sqlite', { previousObservations: observations, accountKey: binding.account_key, remoteSampleBudgetMs: budget, rotation }, {
    now: () => time, sleep: ms => { time += ms; }, context: () => ({ database_key: binding.database_key }), readBinding: () => { time += overheadMs; return binding; },
    loadInventory: () => rows, pendingVerifications: (_db, remaining) => priority.filter(key => remaining[key] && remaining[key].last_checked < START - 1),
    tryAcquireLease: () => { time += overheadMs; return { state: ++acquisitions === busyAt ? 'busy' : 'acquired', release() {} }; },
    inspectSnapshot: (_db, targets) => ({ verification: { status: 'ready', blockedKeys: [] }, records, coverage: Object.fromEntries(targets.map(target => [target.key,
      { covered: true, details_pending: false, latest_finished_ms: START - 1, reason: 'covered' }])) }),
    spawnSync: (_command, args) => {
      const path = args[2]; const params = JSON.parse(args[args.indexOf('--params') + 1]);
      calls.push({ path, params, at: time }); time += latency;
      if (path.includes('/authen/')) return { status: 0, stdout: JSON.stringify({ code: 0, data: { open_id: 'ou_synthetic_self', tenant_key: 'synthetic_tenant' } }) };
      if (apiFailure && apiFailure(params)) return { status: 1, stdout: JSON.stringify({ code: 99991400, msg: 'Too Many Requests' }), stderr: 'HTTP 429' };
      const historical = Number(params.start_time) * 1000 < START - 2 * 86400000;
      let items = historical ? old.filter(item => Number(item.create_time) >= Number(params.start_time) * 1000 && Number(item.create_time) <= Number(params.end_time) * 1000) : [];
      if (!historical) {
        const item = { ...message(99), message_id: `synthetic_recent_${params.container_id}_${params.page_token || 'first'}`, chat_id: params.container_id,
          create_time: String(START - 3600000), update_time: String(START - 3600000) };
        items = [item]; records.set(item.message_id, local(item));
      }
      if (historical && pages === 2 && !params.page_token) items = [];
      return { status: 0, stdout: JSON.stringify({ code: 0, data: { items, has_more: pages === 2 && !params.page_token,
        page_token: pages === 2 && !params.page_token ? 'synthetic_next' : '' } }) };
    },
  });
  return { result, calls, observations, old, time };
}

test('three independent historical routes close three debts within the unchanged twelve-call budget', () => {
  const f = collect();
  assert.equal(f.result.outcome, 'ok'); assert.equal(f.result.report.ok, true);
  assert.equal(f.calls.length, 12); assert.equal(f.result.report.history.requested, 3);
  assert.equal(f.result.report.history.attempts, 3); assert.equal(f.result.report.history.pages, 6);
  assert.equal(f.result.report.history.messages_checked, 3); assert.equal(f.result.historyAttempts.length, 3);
  assert.equal(f.result.report.probe.hot_chats, 1); assert.equal(f.result.report.probe.fair_chats, 1);
  assert.deepEqual(f.result.observations, {});
  assert.ok(f.calls.slice(1).every((call, index) => call.at - f.calls[index].at >= 1001));
  const cache = remoteSampleCache(f.result); assert.ok(parseRemoteSampleCache(cache));
  assert.doesNotMatch(JSON.stringify(cache), /synthetic|finding_key|scope_hash|account_key.*synthetic/);
  for (const mutate of [value => { value.history.attempts = 4; }, value => { value.history.windows[0].secret = 'synthetic'; },
    value => { value.history.messages_checked = 4; }, value => { value.history.windows[0].end = new Date(START).toISOString(); }]) {
    const invalid = structuredClone(cache); mutate(invalid); assert.equal(parseRemoteSampleCache(invalid), null);
    assert.equal(publicRemoteReport(invalid).ok, false);
  }
});

test('overlapping exact windows in the same chat do not mistake another route for duplicate-page evidence', () => {
  const f = collect({ sameWindow: true });
  assert.equal(f.result.outcome, 'ok'); assert.equal(f.result.report.history.messages_checked, 3);
  assert.deepEqual(f.result.observations, {});
});

test('slow calls reserve final identity and retain unattempted debt rather than manufacturing three completed routes', () => {
  const f = collect({ latency: 4000 });
  assert.equal(f.result.outcome, 'ok'); assert.ok(f.time - START <= 55000);
  assert.equal(f.result.report.history.requested, 3); assert.equal(f.result.report.history.attempts, 2);
  assert.equal(f.result.report.history.messages_checked, 2); assert.equal(f.result.historyAttempts.length, 2);
  assert.equal(Object.keys(f.result.observations).length, 1); assert.equal(f.result.report.ok, false);
  assert.match(f.calls.at(-1).path, /authen/); assert.ok(parseRemoteSampleCache(remoteSampleCache(f.result)));
  const retained = Object.values(f.result.observations)[0]; assert.ok(retained.last_checked < START);
});

test('oldest historical debt and one current fair chat keep rotating under continuing verification priority', () => {
  const items = Array.from({ length: 8 }, (_, index) => message(index));
  const previous = Object.fromEntries(items.map((item,index) => [keyFor(item), observation(item,index)]));
  const priority = items.slice(4).map(keyFor);
  const selected = selectHistoricalObservations('/synthetic', previous, binding, rows, START - 86400000, START,
    { pendingVerifications: () => priority });
  assert.deepEqual(selected.map(item => item.key), [keyFor(items[0]), keyFor(items[4]), keyFor(items[5])]);
  let rotation = 0; const visited = new Set();
  for (let index = 0; index < rows.length * 2; index++) {
    const current = selectSampleChats(rows, rotation, START, 2, 1); rotation = current.rotation;
    assert.equal(current.hot, 1); assert.equal(current.fair, 1); visited.add(current.selected[1].chat_id);
  }
  assert.equal(visited.size, rows.length - 1);
});

test('verification hints require current identity, policy and debt fingerprints and consume one attempt', () => {
  const item = message(0), key = keyFor(item), observed = observation(item,0);
  const sourceConfig = JSON.stringify({ initial_sync_start_ms: created - 86400000 });
  const scopeConfig = JSON.stringify({ chat_id: item.chat_id });
  const row = { finding_key: key, database_key: binding.database_key, account_key: binding.account_key,
    record_id: 1, scope_id: chatScopeId(item.chat_id), external_id: item.message_id, container_id: item.chat_id,
    occurred_at_ms: Number(item.create_time), source_config: sourceConfig, scope_config: scopeConfig,
    verification_requested_at_ms: START - 1, verification_generation: 1, record_generation: 1, context_fingerprint: digest({ source: sourceConfig, scope: chatScopeId(item.chat_id), policy: scopeObservationContext(scopeConfig) }),
    debt_fingerprint: digest(observed.debts) };
  const hints = (candidate = row, obs = observed) => loadPendingHistoryVerifications('/synthetic', { [key]: obs }, binding, START, { sqliteJson: () => [candidate] });
  assert.deepEqual(hints(), [key]);
  assert.deepEqual(hints(row, { ...observed, last_checked: START }), []);
  for (const patch of [{ account_key: 'c'.repeat(64) }, { database_key: 'c'.repeat(64) }, { context_fingerprint: 'c'.repeat(64) },
    { debt_fingerprint: 'c'.repeat(64) }, { external_id: 'synthetic_wrong' }, { verification_requested_at_ms: START + 1 }, { verification_generation: null }, { verification_generation: -1 }, { record_generation: 2 },
    { scope_config: JSON.stringify({ chat_id: 'synthetic_wrong' }) }]) assert.deepEqual(hints({ ...row, ...patch }), []);
  assert.deepEqual(loadPendingHistoryVerifications('/synthetic', { [key]: observed }, binding, START, { sqliteJson: () => Array(201).fill(row) }), []);
});

function scheduleFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-throughput-schedule-')); t.after(() => rmSync(dir,{ recursive: true,force: true }));
  const db = join(dir,'synthetic.sqlite'); writeFileSync(db,'synthetic',{ mode: 0o600 });
  const key = activityDatabaseKey(db), paths = remoteSamplePaths(dir,key); let now = START;
  const opts = { db, logDir: dir, publication: createRemoteSamplePublication(dir,key), remoteSampleIntervalSeconds: 900 };
  return { opts, key, paths, setNow: value => { now = value; }, now: () => now,
    state: () => readRemoteSampleState(paths.state,key,now).state };
}

test('quick successful follow-up is durable; failed publication, cooldown and failed collector preserve backoff', async t => {
  const f = scheduleFixture(t);
  const sampled = { outcome: 'ok', rotation: 1, observations: {}, report: { status: 'delayed' }, pendingVerification: true,
    cacheContext: { account_key: binding.account_key, auth_identity_verified: true }, cooldownsByOperation: {} };
  const deps = { nowMs: f.now, invalidateCache: () => true, collect: () => sampled, writeCache: () => true };
  const result = await executeRemoteSampleAttempt(f.opts,deps);
  assert.equal(result.next_due,START + 60000); assert.equal(f.state().next_due,result.next_due);
  assert.equal((await executeRemoteSampleAttempt(f.opts,{ ...deps, collect: () => { assert.fail('not due'); } })).outcome,'not_due');
  f.setNow(result.next_due);
  const failed = await executeRemoteSampleAttempt(f.opts,{ ...deps, writeCache: () => false });
  assert.equal(failed.outcome,'failed'); assert.equal(failed.next_due,f.now() + 900000);
  assert.equal(nextRemoteSampleDue({ finished: START, ok: false, busy: false, interval: 900000, backoff: 1800000,
    pendingVerification: true, verified: true, cooldowns: {} }),START + 1800000);
  assert.equal(nextRemoteSampleDue({ finished: START, ok: true, busy: false, interval: 900000, backoff: 900000,
    pendingVerification: true, verified: true, cooldowns: { message_history_bundle: START + 3600000 } }),START + 3600000);
  assert.equal(nextRemoteSampleDue({ finished: START, ok: true, busy: false, interval: 900000, backoff: 900000,
    pendingVerification: false, verified: true, cooldowns: {} }),START + 900000);
});

test('failed multi-route acquisitions advance only guarded attempt metadata and keep every finding', async t => {
  const f = scheduleFixture(t); const old = Array.from({ length: 3 },(_, index) => message(index));
  const observations = Object.fromEntries(old.map((item,index) => [keyFor(item),observation(item,index)]));
  const state = { kind: 'lark_im_remote_sample_schedule/v1', database_key: f.key, account_key: binding.account_key,
    written_at: START - 1, next_due: START, failures: 0, rotation: 0, observations, last_outcome: 'ok', cooldowns: {}, blocked_reason: null };
  writeRemoteSampleState(f.paths.state,state,START);
  const attempts = old.map(item => ({ key: keyFor(item), checked_at: START, database_key: f.key, source_id: 'lark.im' }));
  const sampled = { outcome: 'failed', historyAttempts: attempts, report: { reason: 'api_unavailable' },
    cacheContext: { account_key: binding.account_key, auth_identity_verified: true } };
  const deps = { nowMs: f.now, invalidateCache: () => true, collect: () => sampled, writeCache: () => true };
  await executeRemoteSampleAttempt(f.opts,deps);
  assert.deepEqual(Object.keys(f.state().observations),Object.keys(observations));
  for (const value of Object.values(f.state().observations)) assert.equal(value.last_checked,START);
  writeRemoteSampleState(f.paths.state,state,START);
  await executeRemoteSampleAttempt(f.opts,{ ...deps, collect: () => ({ ...sampled,report: { reason: 'account_changed' } }) });
  assert.deepEqual(f.state().observations,observations);
});


test('a 25-second idle budget closes one historical debt at four-second latency and alternates current hot/fair first', () => {
  const first = collect({count:4,latency:4000,budget:25000});
  assert.equal(first.result.outcome,'ok'); assert.equal(first.time - START,24000);
  assert.equal(first.result.report.history.messages_checked,1); assert.equal(first.result.report.history.attempts,1);
  assert.equal(first.result.report.probe.max_pages_per_chat,1); assert.equal(first.result.report.probe.truncated_chats,1);
  assert.equal(first.result.report.ok,false); assert.equal(first.result.report.probe.chats_checked,1);
  assert.ok(parseRemoteSampleCache(remoteSampleCache(first.result)));
  const second = collect({count:4,latency:4000,budget:25000,previous:first.result.observations,rotation:2});
  assert.equal(second.result.outcome,'ok'); assert.equal(second.time - START,24000);
  assert.equal(second.result.report.history.messages_checked,1); assert.equal(Object.keys(second.result.observations).length,2);
  const firstCurrent = first.calls.find(call => call.path.includes('/im/')).params.container_id;
  const secondCurrent = second.calls.find(call => call.path.includes('/im/')).params.container_id;
  assert.equal(firstCurrent,rows[0].chat_id); assert.notEqual(secondCurrent,firstCurrent);
  assert.match(second.calls.at(-1).path,/authen/); assert.ok(parseRemoteSampleCache(remoteSampleCache(second.result)));
});

test('lease refusal before a historical CLI acquisition cannot consume its verification ticket', () => {
  const f = collect({busyAt:4});
  assert.equal(f.result.outcome,'busy'); assert.equal(f.calls.length,3);
  assert.equal(f.result.historyAttempts.length,0); assert.equal(f.result.report.history.attempts,0);
  assert.deepEqual(f.result.observations,f.observations);
});

test('an invalid internal time budget starts no API request', () => {
  for (const budget of [0,999,55001,Infinity,1000.5]) {
    const f = collect({budget}); assert.equal(f.result.outcome,'failed'); assert.equal(f.calls.length,0);
  }
});


test('short budgets with real phase overhead alternate domains and do not advance an unvisited fair cursor', () => {
  let previous, rotation = 0; const currentSeen = new Set(); let historyProgress = 0;
  for (let round = 0; round < 32; round++) {
    const f = collect({count:20,latency:4000,budget:25000,overheadMs:300,previous,rotation});
    assert.equal(f.result.outcome,'ok'); assert.ok(f.time - START <= 25000);
    previous = f.result.observations; rotation = f.result.rotation;
    const current = f.calls.filter(call => call.path.includes('/im/') && Number(call.params.start_time) * 1000 > START - 2 * 86400000);
    current.forEach(call => currentSeen.add(call.params.container_id));
    if (round % 2) assert.equal(f.result.report.history.messages_checked,1,'historical-first phase makes progress despite overhead');
    else assert.equal(current.length,1,'current-first phase makes progress despite overhead');
    historyProgress += f.result.report.history.messages_checked;
    assert.match(f.calls.at(-1).path,/authen/);
    assert.ok(parseRemoteSampleCache(remoteSampleCache(f.result)));
  }
  assert.equal(historyProgress,16); assert.equal(currentSeen.size,rows.length);
  assert.equal(Object.keys(previous).length,4);
});


test('only validated recent-window tickets enter the bounded known-target route', () => {
  const item = {...message(0),create_time:String(START - 3600000)}; const key = keyFor(item);
  const previous = {[key]:{...observation(item,0),target:Number(item.create_time)}};
  const f = collect({previous,priority:[key]});
  assert.equal(f.result.outcome,'ok'); assert.ok(f.result.observations[key]);
  assert.equal(f.result.report.history.scope,'known_verification'); assert.equal(f.result.pendingVerification,false);
  assert.equal(f.result.historyAttempts.length,1);
  const unapproved = collect({previous});
  assert.equal(unapproved.result.report.history,undefined);
  assert.equal(unapproved.result.pendingVerification,false);
});

test('the worker idle budget survives background launch and the actual scheduled collector boundary', async t => {
  const f = scheduleFixture(t); const opts = {...f.opts,remoteSampleBudgetMs:25000}; let input;
  const launched = startScheduledRemoteSample(opts,{nowMs:f.now,spawn:(_command,_args,options) => {
    input=JSON.parse(options.env.EXOCORTEX_REMOTE_SAMPLE_INPUT); return {pid:12345,once(){},unref(){},kill(){}};
  }});
  assert.equal(launched.outcome,'started'); assert.equal(input.collectorOptions.remoteSampleBudgetMs,25000);
  await executeRemoteSampleAttempt(opts,{nowMs:f.now,invalidateCache:()=>true,writeCache:()=>true,collect:(_db,options)=> {
    assert.equal(options.remoteSampleBudgetMs,25000); assert.equal(options.maxApiCalls,12); assert.equal(options.minApiGapMs,1000);
    return {outcome:'ok',rotation:0,observations:{},report:{status:'inconclusive'},cacheContext:{account_key:binding.account_key,auth_identity_verified:true}};
  }});
});
