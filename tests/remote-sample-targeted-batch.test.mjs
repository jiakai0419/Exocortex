import assert from 'node:assert/strict';
import test from 'node:test';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { collectRemoteSample, createSampleApi } from '../src/diagnostics/remote-sample.mjs';
import { digest, sampleScopeHash } from '../src/diagnostics/remote-sample-core.mjs';
import { routeTargetedHistory } from '../src/diagnostics/remote-sample-history.mjs';
import { parseRemoteSampleCache, publicRemoteReport, remoteSampleCache } from '../src/diagnostics/remote-sample-cache.mjs';

const START = Date.parse('2038-02-08T12:00:00Z');
const binding = { state: 'verified', evidence: 'single_sent_actor', database_key: 'a'.repeat(64), account_key: 'b'.repeat(64) };
const row = n => ({ id: chatScopeId(`synthetic_batch_chat_${n}`), chat_id: `synthetic_batch_chat_${n}`, enabled: 1,
  source_id: 'lark.im', hot_rank: n, hot_seen_at: new Date(START).toISOString(), initial_sync_start_ms: START - 10 * 86400000 });
const inventory = Array.from({ length: 10 }, (_, n) => row(n));
const old = n => ({ message_id: `synthetic_batch_message_${n}`, chat_id: row(n + 2).chat_id, msg_type: 'text', deleted: false,
  create_time: String(START - 3 * 86400000 + n * 10000), update_time: String(START - 3600000), body: { content: '{"text":"synthetic private body"}' } });
const key = m => digest([binding.database_key,binding.account_key,m.chat_id,m.message_id,Number(m.create_time)]);
const local = m => ({ external_id: m.message_id, container_id: m.chat_id, source_id: 'lark.im', record_type: 'lark.im.message',
  external_version: m.update_time, raw_json: JSON.stringify(m), canonical_json: '{"source_api":"im.v1.messages"}' });
const metadata = m => ({ external_id: m.message_id, container_id: m.chat_id, occurred_at_ms: Number(m.create_time),
  native_id: m.message_id, native_chat: m.chat_id, native_created: m.create_time, msg_type: m.msg_type, source_api: 'im.v1.messages' });

function fixture({ editMessages = ms => ms, mutateBatch = ms => ms, rotation = 0, maxApiCalls = 12, maxSelfCalls = 6,
  latency = 1000, budget = 25000, switched = false, limited = false, snapshotReason = 'covered', editRecords = records => records } = {}) {
  let at = START; const calls = []; let identities = 0; let cooldown;
  const messages = editMessages(Array.from({ length: 5 }, (_, n) => old(n)));
  const previous = Object.fromEntries(messages.map((m,n) => [key(m), { kind: 'version', debts: { version: Number(m.update_time) },
    target: Number(m.create_time), first_seen: START - 7200000 + n, last_seen: START - 3600000, run_finished: START - 7200000,
    last_checked: START - 3600000 + n, scope_hash: sampleScopeHash(binding,m.chat_id) }]));
  const records = new Map(messages.map(m => [m.message_id,local(m)]));
  const result = collectRemoteSample('/synthetic/no-database.sqlite', { previousObservations: previous, accountKey: binding.account_key,
    rotation, maxApiCalls, maxSelfCalls, remoteSampleBudgetMs: budget }, {
    now: () => at, sleep: ms => { at += ms; }, context: () => ({ database_key: binding.database_key }), readBinding: () => binding,
    loadInventory: () => inventory, pendingVerifications: () => [],
    sqliteJson: (_db,_sql,label) => label === 'remote sample targeted routing' ? messages.map(metadata) : [],
    tryAcquireLease: () => ({ state: 'acquired', release() {} }),
    readSharedCooldown: () => ({ state: 'ready' }), writeSharedCooldown: value => { cooldown=value;return true; },
    spawnSync: (_bin,args,options) => {
      const path = args[2]; const params = JSON.parse(args[6]); calls.push({ path,params,timeout: options.timeout }); at += latency;
      if (limited && path.endsWith('/mget')) return { status:1,stderr:'{"code":99991400,"headers":{"x-ogw-ratelimit-reset":"1200"}}' };
      let data;
      if (path.includes('/authen/')) data = { open_id: switched && identities++ ? 'ou_changed' : 'ou_synthetic', tenant_key: 'synthetic_tenant' };
      else if (path.endsWith('/mget')) data = { items: mutateBatch(messages.filter(m => params.message_ids.includes(m.message_id))) };
      else if (Number(params.start_time) * 1000 < START - 2 * 86400000) data = { items: messages.filter(m => m.chat_id === params.container_id), has_more: false };
      else {
        const message = { ...old(9), message_id: `synthetic_current_${params.container_id}`, chat_id: params.container_id,
          create_time: String(START - 3600000) };
        records.set(message.message_id,local(message)); data = { items: [message], has_more: false };
      }
      return { status: 0, stdout: JSON.stringify({ code: 0,data }) };
    },
    inspectSnapshot: (_db,targets) => ({ records: editRecords(records), coverage: Object.fromEntries(targets.map(target => [target.key,
      { covered: snapshotReason === 'covered', reason: snapshotReason, latest_finished_ms: at - 1, details_pending: false }])) }),
  });
  return { result,calls,previous,messages,cooldown,elapsed: at - START };
}

test('one independent mget verifies five exact historical targets beside hot and fair lists using five CLI calls and two self calls', () => {
  const f = fixture();
  assert.equal(f.result.outcome,'ok'); assert.equal(f.result.report.ok,true); assert.deepEqual(f.result.observations,{});
  assert.equal(f.calls.length,5); assert.equal(f.result.report.probe.self_calls,2); assert.equal(f.elapsed,9000);
  assert.equal(f.result.report.probe.hot_chats,1); assert.equal(f.result.report.probe.fair_chats,1);
  assert.equal(f.result.report.probe.chats_checked,2); assert.equal(f.result.report.history.chats_checked,0);
  assert.equal(f.result.report.history.pages,0); assert.equal(f.result.report.history.messages_checked,5);
  assert.deepEqual(f.result.report.history.targeted,{ requested: 5,batches: 1,targets_checked: 5,omitted: 0,unsupported: 0 });
  assert.equal(f.result.historyAttempts.length,5); assert.match(f.calls[0].path,/authen/); assert.match(f.calls.at(-1).path,/authen/);
  const batch = f.calls.find(call => call.path.endsWith('/mget'));
  assert.equal(batch.params.card_msg_content_type,'raw_card_content'); assert.equal(batch.params.message_ids.length,5);
  const cache = remoteSampleCache(f.result); assert.ok(parseRemoteSampleCache(cache));
  assert.equal(cache.probe.mode,'bounded_native_pages_and_targeted_ids');
  assert.doesNotMatch(JSON.stringify(cache),/synthetic|message_ids|generation|ticket|private body/);
});

test('mget omission remains unresolved and never supplies deletion or complete-window evidence', () => {
  const f = fixture({ mutateBatch: messages => messages.slice(1) });
  assert.equal(f.result.outcome,'ok'); assert.equal(f.result.report.ok,false);
  assert.equal(f.result.report.history.targeted.omitted,1); assert.equal(f.result.report.history.messages_checked,4);
  assert.equal(Object.keys(f.result.observations).length,1); assert.ok(f.result.observations[key(f.messages[0])]);
  assert.ok(parseRemoteSampleCache(remoteSampleCache(f.result)));
});

test('foreign IDs, duplicate IDs, altered chat/create identity and malformed raw messages fail closed', () => {
  for (const mutateBatch of [ms => [...ms,ms[0]], ms => [{...ms[0],message_id:'synthetic_foreign'},...ms.slice(1)],
    ms => [{...ms[0],chat_id:row(9).chat_id},...ms.slice(1)], ms => [{...ms[0],create_time:String(START - 86400000)},...ms.slice(1)],
    ms => [{...ms[0],body:null},...ms.slice(1)]]) {
    const f = fixture({ mutateBatch }); assert.equal(f.result.outcome,'failed'); assert.equal(f.result.report.ok,false);
    assert.equal(Object.keys(f.result.observations).length,5); assert.equal(f.result.report.probe.self_calls,1);
    assert.equal(f.result.report.probe.api_calls,f.calls.length);
  }
});

test('unexpected card representation cannot settle a static-body debt through raw mget', () => {
  const f = fixture({ mutateBatch: ms => [{...ms[0],msg_type:'interactive'},...ms.slice(1)] });
  assert.equal(f.result.outcome,'ok'); assert.equal(f.result.report.history.targeted.unsupported,1);
  assert.ok(f.result.observations[key(f.messages[0])]); assert.equal(f.result.report.ok,false);
});

test('oldest dynamic target keeps its original user-card list route ahead of the optional batch', () => {
  const f = fixture({ rotation:1, editMessages: ms => [{...ms[0],msg_type:'interactive'},...ms.slice(1)], budget:55000 });
  const messageCalls = f.calls.filter(call => !call.path.includes('/authen/'));
  assert.equal(messageCalls[0].path,'/open-apis/im/v1/messages');
  assert.equal(messageCalls[0].params.container_id,f.messages[0].chat_id);
  assert.equal(messageCalls[0].params.card_msg_content_type,'user_card_content');
  assert.equal(f.result.report.history.chats_checked,1); assert.equal(f.result.report.history.targeted.requested,4);
  assert.deepEqual(f.result.observations,{}); assert.ok(parseRemoteSampleCache(remoteSampleCache(f.result)));
});

test('changed account, revoked source and changed local snapshot cannot borrow prior writer evidence', () => {
  for (const options of [{ switched:true },{ snapshotReason:'source_unavailable' },{ snapshotReason:'before_sync_baseline' }]) {
    const f = fixture(options); assert.equal(f.result.outcome,'failed'); assert.equal(Object.keys(f.result.observations).length,5);
  }
  const f = fixture({ editRecords: records => new Map([...records].map(([id,record]) => [id,{...record,external_version:'1'}])) });
  assert.equal(f.result.report.ok,false); assert.equal(Object.keys(f.result.observations).length,5);
});

test('targeted public evidence rejects fabricated page counts, leaked fields and mode confusion', () => {
  const cache = remoteSampleCache(fixture().result);
  for (const mutate of [c => { c.history.targeted.secret = 'synthetic'; },c => { c.history.targeted.targets_checked = 6; },
    c => { c.history.pages = 1; },c => { c.probe.mode = 'bounded_native_pages'; },c => { c.probe.self_calls = 7; },
    c => { c.history.targeted.batches = 0; },c => { c.history.targeted.omitted = 1; },c => { delete c.probe.self_calls; },
    c => { c.probe.self_calls = 1; }]) {
    const invalid = structuredClone(cache); mutate(invalid); assert.equal(parseRemoteSampleCache(invalid),null); assert.equal(publicRemoteReport(invalid).ok,false);
  }
});

test('four-second requests preserve both current domains and five historical targets across all four phases', () => {
  for (let rotation=0;rotation<4;rotation++) {
    const f = fixture({latency:4000,rotation});
    assert.equal(f.result.outcome,'ok'); assert.equal(f.result.report.ok,true); assert.equal(f.elapsed,24000);
    assert.equal(f.result.report.probe.chats_checked,2); assert.equal(f.result.report.history.messages_checked,5);
    assert.equal(f.result.report.probe.self_calls,2); assert.ok(parseRemoteSampleCache(remoteSampleCache(f.result)));
  }
  const short = fixture({latency:4000,budget:23000});
  assert.equal(short.result.outcome,'ok'); assert.equal(short.result.report.ok,false); assert.ok(short.elapsed <= 23000);
  assert.equal(short.result.report.history.messages_checked,5); assert.equal(short.result.report.probe.chats_checked,1);
});

test('a batch 429 preserves all debt and publishes the existing shared cooldown with actual acquisition counts', () => {
  const f = fixture({limited:true});
  assert.equal(f.result.outcome,'failed'); assert.equal(f.result.report.reason,'rate_limited');
  assert.equal(f.result.report.probe.api_calls,3); assert.equal(f.result.report.probe.self_calls,1);
  assert.equal(f.result.historyAttempts.length,5); assert.equal(Object.keys(f.result.observations).length,5);
  assert.equal(f.cooldown.operation,'message_search_bundle'); assert.equal(f.result.cooldownsByOperation.message_search_bundle,f.cooldown.untilMs);
  assert.ok(f.cooldown.untilMs >= START + 1200000); assert.ok(parseRemoteSampleCache(remoteSampleCache(f.result)));
});

test('metadata routing is bounded and ambiguous, dynamic, malformed or absent identities retain list routes', () => {
  const message = old(0); const revisit = { key:key(message),chat:row(2),observation:{target:Number(message.create_time)} };
  let sql;
  const route = candidates => routeTargetedHistory('/synthetic',[revisit],binding,{ sqliteJson: (_db,query,_label,options) => {
    sql = query; assert.equal(options.timeoutMs,1000); return candidates;
  } });
  assert.equal(route([metadata(message)])[0].messageId,message.message_id);
  assert.match(sql,/idx_records_container_time/); assert.match(sql,/LIMIT 1001/); assert.doesNotMatch(sql,/SELECT[^;]*\bbody\b/);
  for (const candidates of [[],[metadata(message),metadata(message)],[{...metadata(message),msg_type:'merge_forward'}],
    [{...metadata(message),native_created:'0'}],[{...metadata(message),source_api:'unknown'}]]) assert.equal(route(candidates)[0].messageId,undefined);
});

test('collector admits only remaining shared CLI and self budgets and reports real attempted counts', () => {
  const full = fixture({ maxApiCalls:5,maxSelfCalls:2 }); assert.equal(full.result.report.ok,true); assert.equal(full.calls.length,5);
  const stopped = fixture({ maxSelfCalls:1 }); assert.equal(stopped.calls.length,0); assert.equal(stopped.result.report.reason,'request_budget');
  let at = START;
  const api = createSampleApi('/synthetic',{maxApiCalls:2,maxSelfCalls:1},{ now:()=>at,sleep:ms=>{at+=ms;},
    tryAcquireLease:()=>({state:'acquired',release(){}}),spawnSync:()=>({status:1,stderr:'synthetic failure'}) });
  assert.throws(()=>api.call('/open-apis/authen/v1/user_info'),/api_unavailable/); assert.equal(api.selfCount(),1);
  assert.throws(()=>api.call('/open-apis/authen/v1/user_info'),/request_budget/); assert.equal(api.count(),1);
});

test('mget shares the existing search cooldown bucket and monotonic budget ignores a backwards wall clock', () => {
  let operation; let wall = START; let mono = 0; let spawns = 0;
  const api = createSampleApi('/synthetic',{remoteSampleBudgetMs:1000},{ now:()=>wall,monotonicNow:()=>mono,
    tryAcquireLease:()=>({state:'acquired',release(){}}),readSharedCooldown: input => { operation=input.operation; return {state:'ready'}; },
    spawnSync:()=>{spawns++;wall-=100000;mono+=1001;return {status:0,stdout:'{"code":0,"data":{}}'};} });
  assert.throws(()=>api.call('/open-apis/im/v1/messages/mget'),/time_budget/); assert.equal(operation,'message_search_bundle');
  assert.throws(()=>api.call('/open-apis/authen/v1/user_info'),/time_budget/); assert.equal(spawns,1);
  const cooled = createSampleApi('/synthetic',{cooldownsByOperation:{message_search_bundle:START+10000}},
    {now:()=>START,tryAcquireLease:()=>assert.fail('cooldown must precede lease')});
  assert.throws(()=>cooled.call('/open-apis/im/v1/messages/mget'),error=>error.operation==='message_search_bundle' && error.reason==='rate_cooldown');
});
