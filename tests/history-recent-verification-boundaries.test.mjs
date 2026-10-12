import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { quoteSql as q, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';
import { activityDatabaseKey } from '../src/diagnostics/lark-im-activity-evidence.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { digest, sampleScopeHash, SAMPLE_POLICY } from '../src/diagnostics/remote-sample-core.mjs';
import { loadPendingHistoryVerifications, selectHistoricalObservations, stableVerificationTarget } from '../src/diagnostics/remote-sample-history.mjs';
import { collectRemoteSample, createSampleApi } from '../src/diagnostics/remote-sample.mjs';
import { parseRemoteSampleCache, remoteSampleCache } from '../src/diagnostics/remote-sample-cache.mjs';
import { scopeObservationContext } from '../src/maintenance/scope-config-policy.mjs';
import { resolveRemoteSampleDue } from '../src/runtime/worker/remote-sample-wake.mjs';

const START = Date.parse('2038-02-08T12:00:37.777Z');
const stableEnd = now => Math.floor((now - SAMPLE_POLICY.stableBufferMs) / 60000) * 60000;
const END = stableEnd(START), WINDOW_START = END - SAMPLE_POLICY.windowMs;
const local = m => ({ external_id: m.message_id, container_id: m.chat_id, source_id: 'lark.im', record_type: 'lark.im.message',
  external_version: m.update_time, raw_json: JSON.stringify(m), canonical_json: '{"source_api":"im.v1.messages"}' });

// Only this authored temporary database is opened. Ticket validation and routing
// use the real read-only SQL. Account/coverage evidence and every remote call are
// synthetic; no credentials, shared lease directory, worker or service is used.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-recent-verification-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'fixture.sqlite');
  const sourceConfig = JSON.stringify({ initial_sync_start_ms: START - 10 * 86400000 });
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: chatScopeId(`oc_synthetic_recent_${i}`), chat_id: `oc_synthetic_recent_${i}`,
    source_id: 'lark.im', enabled: 1, hot_rank: i === 0 ? 0 : null, hot_seen_at: new Date(START).toISOString(),
    initial_sync_start_ms: START - 10 * 86400000 }));
  sqliteExec(db, `CREATE TABLE sources(id TEXT PRIMARY KEY,enabled INTEGER,config_json TEXT);
    CREATE TABLE sync_scopes(id TEXT PRIMARY KEY,source_id TEXT,enabled INTEGER,config_json TEXT);
    CREATE TABLE records(id INTEGER PRIMARY KEY,external_id TEXT,container_id TEXT,occurred_at_ms INTEGER,source_id TEXT,record_type TEXT,
      external_version TEXT,raw_json TEXT,canonical_json TEXT);
    CREATE INDEX idx_records_container_time ON records(source_id,record_type,container_id,occurred_at_ms);
    CREATE TABLE record_observation_state(record_id INTEGER PRIMARY KEY,generation INTEGER,candidate_json TEXT,history_error TEXT);
    CREATE TABLE lark_im_history_debt(record_id INTEGER PRIMARY KEY,finding_key TEXT,database_key TEXT,account_key TEXT,
      context_fingerprint TEXT,debt_fingerprint TEXT,scope_id TEXT,verification_generation INTEGER,verification_requested_at_ms INTEGER,status TEXT);
    INSERT INTO sources VALUES('lark.im',1,${q(sourceConfig)});
    ${rows.map(row => `INSERT INTO sync_scopes VALUES(${q(row.id)},'lark.im',1,${q(JSON.stringify({ chat_id: row.chat_id, chat_type: 'group' }))});`).join('\n')}`);
  const binding = { state: 'verified', evidence: 'single_sent_actor', database_key: activityDatabaseKey(db), account_key: 'b'.repeat(64) };
  const previous = {}, items = [];
  function add({ target = START - 3600000, ticket = true, chatIndex = 8, type = 'text', checked = START - 120000, debts } = {}) {
    const id = items.length + 1, chat = rows[chatIndex];
    const message = { message_id: `om_synthetic_recent_${id}`, chat_id: chat.chat_id, msg_type: type, deleted: false,
      create_time: String(target), update_time: String(Math.max(target, START - 1200000)), body: { content: '{"text":"synthetic body"}' } };
    const key = digest([binding.database_key, binding.account_key, chat.chat_id, message.message_id, target]);
    const observation = { kind: 'version', target, first_seen: checked - 1000, last_seen: checked, run_finished: 0, last_checked: checked,
      scope_hash: sampleScopeHash(binding, chat.chat_id), debts: debts || { version: Number(message.update_time) } };
    const scopeConfig = JSON.stringify({ chat_id: chat.chat_id, chat_type: 'group' });
    const context = digest({ source: sourceConfig, scope: chat.id, policy: scopeObservationContext(scopeConfig) });
    const debt = digest(Object.fromEntries(Object.entries(observation.debts).sort(([a], [b]) => a.localeCompare(b))));
    const record = local(message);
    sqliteExec(db, `INSERT INTO records VALUES(${id},${q(message.message_id)},${q(chat.chat_id)},${target},'lark.im','lark.im.message',
      ${q(record.external_version)},${q(record.raw_json)},${q(record.canonical_json)});
      INSERT INTO record_observation_state VALUES(${id},3,NULL,NULL);
      ${ticket ? `INSERT INTO lark_im_history_debt VALUES(${id},${q(key)},${q(binding.database_key)},${q(binding.account_key)},
        ${q(context)},${q(debt)},${q(chat.id)},3,${START - 30000},'awaiting_verification');` : ''}`);
    previous[key] = observation;
    const item = { id, key, message, observation, context, debt }; items.push(item); return item;
  }
  function select(observations = previous, now = START) {
    const end = stableEnd(now);
    return selectHistoricalObservations(db, observations, binding, rows, end - SAMPLE_POLICY.windowMs, now, {}, 5, end);
  }
  function wake(observations = previous, now = START, cooldowns = {}) {
    return resolveRemoteSampleDue({ db }, { kind: 'lark_im_remote_sample_schedule/v1', database_key: binding.database_key,
      account_key: binding.account_key, written_at: START - 60000, next_due: START + 900000, failures: 0, rotation: 0,
      observations, last_outcome: 'ok', cooldowns: {}, blocked_reason: null }, now, cooldowns);
  }
  function collect({ observations = previous, now = START, rotation = 0, latency = 1000, dynamicPages = 1,
    overlap = false, mutateBatch = values => values, rateLimitBatch = false } = {}) {
    let at = now; const calls = [], currentRecords = new Map(), cooldownWrites = [];
    const result = collectRemoteSample(db, { previousObservations: observations, accountKey: binding.account_key, rotation,
      maxApiCalls: 12, maxSelfCalls: 6, remoteSampleBudgetMs: 25000 }, {
      now: () => at, monotonicNow: () => at - now, sleep: ms => { at += ms; },
      context: () => ({ database_key: binding.database_key }), readBinding: () => binding, loadInventory: () => rows,
      tryAcquireLease: () => ({ state: 'acquired', release() {} }), readSharedCooldown: () => ({ state: 'ready' }),
      writeSharedCooldown: value => { assert.ok(rateLimitBatch, 'synthetic success must not write shared cooldown'); cooldownWrites.push(value); return true; },
      spawnSync: (_bin, args, options) => {
        const path = args[2], params = JSON.parse(args[args.indexOf('--params') + 1]);
        calls.push({ path, params, at, timeout: options.timeout }); at += latency;
        if (rateLimitBatch && path.endsWith('/mget')) return { status: 1,
          stderr: '{"code":99991400,"headers":{"x-ogw-ratelimit-reset":"1200"}}' };
        let data;
        if (path.includes('/authen/')) data = { open_id: 'ou_synthetic_recent', tenant_key: 'synthetic_tenant' };
        else if (path.endsWith('/mget')) data = { items: mutateBatch(items.filter(item => params.message_ids.includes(item.message.message_id)).map(item => structuredClone(item.message))) };
        else {
          const from = Number(params.start_time) * 1000, to = Number(params.end_time) * 1000;
          const exact = to - from === 3000;
          let messages = items.map(item => item.message).filter(m => m.chat_id === params.container_id && Number(m.create_time) >= from && Number(m.create_time) <= to);
          if (exact && dynamicPages === 2 && !params.page_token) messages = [];
          if (!exact) {
            const m = { message_id: `om_synthetic_current_${params.container_id}`, chat_id: params.container_id, msg_type: 'text', deleted: false,
              create_time: String(END - 60000), update_time: String(END - 60000), body: { content: '{"text":"synthetic current"}' } };
            currentRecords.set(m.message_id, local(m)); messages = [...(overlap ? messages : []), m];
          }
          const more = exact && dynamicPages === 2 && !params.page_token;
          data = { items: messages, has_more: more, page_token: more ? 'synthetic_next' : '' };
        }
        return { status: 0, stdout: JSON.stringify({ code: 0, data }) };
      },
      inspectSnapshot: (_db, targets, options) => {
        // This suite has no concurrent writer. The separate paired-process
        // suite checks the real atomic ticket fence; here assert its inputs.
        if (options.verification) {
          assert.deepEqual(options.verification.binding, binding);
          const pending = loadPendingHistoryVerifications(db, observations, binding, at);
          assert.ok(options.verification.requiredKeys.every(key => pending.includes(key)));
          for (const [key, acquired] of Object.entries(options.verification.acquisitions)) {
            assert.ok(observations[key]); assert.ok(acquired >= now && acquired <= at);
          }
        }
        return { records: new Map([...readOnlySqliteJson(db, 'SELECT * FROM records;', 'synthetic local records')
          .map(record => [record.external_id, record]), ...currentRecords]), coverage: Object.fromEntries(targets.map(target => [target.key,
          { covered: true, details_pending: false, latest_finished_ms: at - 1, reason: 'covered' }])),
          verification: { status: 'ready', blockedKeys: [] } };
      },
    });
    return { result, calls, cooldownWrites, elapsed: at - now };
  }
  return { db, binding, rows, previous, items, add, select, wake, collect, mutate: sql => sqliteExec(db, sql) };
}

test('recent ticket admission uses the entire exact three-second route at the rounded stable edge', t => {
  const f = fixture(t);
  for (const [target, admitted] of [[END - 2000, true], [END - 1001, true], [END - 1000, false],
    [END - 1, false], [END, false], [START - 600000 - 2000, false]]) {
    const item = f.add({ target }), previous = { [item.key]: item.observation };
    const bytes = readFileSync(f.db), saved = JSON.stringify(previous);
    assert.equal(stableVerificationTarget(item.observation, END), admitted, `target ${target - END} ms from stable end`);
    const selected = f.select(previous);
    assert.deepEqual(selected.map(value => value.key), admitted ? [item.key] : []);
    if (admitted) assert.ok(selected[0].end <= END);
    assert.equal(Boolean(f.wake(previous).wake), admitted);
    const c = f.collect({ observations: previous });
    assert.equal(c.result.outcome, 'ok', JSON.stringify(c.result.report));
    assert.equal(c.result.historyAttempts.length, admitted ? 1 : 0);
    assert.equal(Boolean(c.result.report.history), admitted);
    assert.equal(c.result.pendingVerification, false);
    assert.equal(Boolean(c.result.observations[item.key]), !admitted);
    assert.deepEqual(readFileSync(f.db), bytes); assert.equal(JSON.stringify(previous), saved);
  }
});

test('minute rollover admits a fully stable route once without bypassing the ten-minute buffer', t => {
  const f = fixture(t), item = f.add({ target: END - 1000 });
  const rollover = Math.floor(START / 60000) * 60000 + 60000;
  assert.equal(stableEnd(rollover - 1), END); assert.equal(stableEnd(rollover), END + 60000);
  assert.deepEqual(f.select(f.previous, rollover - 1), []); assert.equal(f.wake(f.previous, rollover - 1).wake, null);
  assert.deepEqual(f.select(f.previous, rollover).map(value => value.key), [item.key]); assert.ok(f.wake(f.previous, rollover).wake);
  const c = f.collect({ now: rollover });
  assert.equal(c.result.outcome, 'ok'); assert.equal(c.result.historyAttempts.length, 1);
  assert.deepEqual(c.result.observations, {}); assert.ok(parseRemoteSampleCache(remoteSampleCache(c.result)));
});

test('accepted tickets have no one-millisecond blind gap across the 24-hour start or old two-second guard', t => {
  const f = fixture(t);
  for (const target of [WINDOW_START - 2001, WINDOW_START - 2000, WINDOW_START - 1999, WINDOW_START - 1,
    WINDOW_START, WINDOW_START + 1, START - 86400000 - 1, START - 86400000 + 1]) {
    const item = f.add({ target }), previous = { [item.key]: item.observation };
    assert.deepEqual(f.select(previous).map(value => value.key), [item.key], `24h delta ${target - WINDOW_START}`);
    assert.ok(f.wake(previous).wake);
    const c = f.collect({ observations: previous });
    assert.equal(c.result.outcome, 'ok'); assert.deepEqual(c.result.observations, {});
    assert.equal(c.result.report.history.scope, target + 2000 >= WINDOW_START ? 'known_verification' : undefined);
    assert.ok(parseRemoteSampleCache(remoteSampleCache(c.result)));
  }
});

test('recent findings without a current accepted ticket cannot enter the verification lane or wake early', t => {
  const f = fixture(t), item = f.add();
  const changes = [
    ["UPDATE lark_im_history_debt SET status='ready'", "UPDATE lark_im_history_debt SET status='awaiting_verification'"],
    ['UPDATE lark_im_history_debt SET verification_generation=NULL', 'UPDATE lark_im_history_debt SET verification_generation=3'],
    ['UPDATE record_observation_state SET generation=4', 'UPDATE record_observation_state SET generation=3'],
    ["UPDATE record_observation_state SET candidate_json='{}'", 'UPDATE record_observation_state SET candidate_json=NULL'],
    ["UPDATE record_observation_state SET history_error='synthetic error'", 'UPDATE record_observation_state SET history_error=NULL'],
    [`UPDATE lark_im_history_debt SET verification_requested_at_ms=${item.observation.last_checked}`, `UPDATE lark_im_history_debt SET verification_requested_at_ms=${START - 30000}`],
    [`UPDATE lark_im_history_debt SET verification_requested_at_ms=${START + 1}`, `UPDATE lark_im_history_debt SET verification_requested_at_ms=${START - 30000}`],
    [`UPDATE lark_im_history_debt SET account_key=${q('c'.repeat(64))}`, `UPDATE lark_im_history_debt SET account_key=${q(f.binding.account_key)}`],
    [`UPDATE lark_im_history_debt SET database_key=${q('c'.repeat(64))}`, `UPDATE lark_im_history_debt SET database_key=${q(f.binding.database_key)}`],
    [`UPDATE lark_im_history_debt SET context_fingerprint=${q('c'.repeat(64))}`, `UPDATE lark_im_history_debt SET context_fingerprint=${q(item.context)}`],
    [`UPDATE lark_im_history_debt SET debt_fingerprint=${q('c'.repeat(64))}`, `UPDATE lark_im_history_debt SET debt_fingerprint=${q(item.debt)}`],
    ['UPDATE sources SET enabled=0', 'UPDATE sources SET enabled=1'],
    ['UPDATE sync_scopes SET enabled=0', 'UPDATE sync_scopes SET enabled=1'],
  ];
  for (const [change, restore] of changes) {
    assert.deepEqual(loadPendingHistoryVerifications(f.db, f.previous, f.binding, START), [item.key]);
    f.mutate(change); assert.deepEqual(f.select(), []); assert.equal(f.wake().wake, null);
    f.mutate(restore);
  }
  f.mutate('DELETE FROM lark_im_history_debt;');
  const c = f.collect(); assert.equal(c.result.outcome, 'ok'); assert.equal(c.result.report.history, undefined);
  assert.equal(c.result.historyAttempts.length, 0); assert.equal(c.result.pendingVerification, false); assert.ok(c.result.observations[item.key]);
  assert.deepEqual(f.select(), []); assert.equal(f.wake().wake, null);
});

test('oldest unmodified debt keeps a slot beside at most four of many recent accepted tickets', t => {
  const f = fixture(t), oldest = f.add({ target: START - 3 * 86400000, ticket: false, checked: START - 500000 });
  f.add({ target: START - 2 * 86400000, ticket: false, checked: START - 400000 });
  const recent = Array.from({ length: 7 }, (_, i) => f.add({ target: START - 3600000 + i, checked: START - 120000 + i }));
  const selected = f.select(); assert.equal(selected.length, 5); assert.equal(selected[0].key, oldest.key);
  assert.deepEqual(selected.slice(1).map(value => value.key), recent.slice(0, 4).map(item => item.key));
});

test('five recent targets share one batch while hot and fair lists and the original budgets remain', t => {
  const f = fixture(t); for (let i = 0; i < 5; i++) f.add({ target: START - 3600000 + i, chatIndex: i + 2 });
  for (let rotation = 0; rotation < 4; rotation++) {
    const c = f.collect({ rotation, latency: 4000 });
    assert.equal(c.result.outcome, 'ok'); assert.equal(c.result.report.ok, true); assert.deepEqual(c.result.observations, {});
    assert.equal(c.result.report.history.requested, 5); assert.equal(c.result.report.history.messages_checked, 5);
    assert.equal(c.result.report.history.scope, 'known_verification'); assert.equal(c.result.report.history.targeted.batches, 1);
    assert.equal(c.calls.length, 5); assert.equal(c.result.report.probe.self_calls, 2); assert.equal(c.elapsed, 24000);
    assert.equal(c.result.report.probe.hot_chats, 1); assert.equal(c.result.report.probe.fair_chats, 1);
    assert.equal(c.result.report.probe.chats_checked, 2); assert.ok(parseRemoteSampleCache(remoteSampleCache(c.result)));
    assert.ok(c.calls.slice(1).every((call, i) => call.at - (c.calls[i].at + 4000) >= 1000));
  }
});

test('a slow two-page oldest list and recent batch both progress across four phases without added capacity', t => {
  const f = fixture(t), oldest = f.add({ target: START - 3 * 86400000, type: 'interactive', ticket: false, checked: START - 500000 });
  const recent = Array.from({ length: 4 }, (_, i) => f.add({ target: START - 3600000 + i, chatIndex: i + 2 }));
  let oldProgress = 0, recentProgress = 0; const currentVisited = new Set();
  for (let rotation = 0; rotation < 4; rotation++) {
    const c = f.collect({ rotation, latency: 4000, dynamicPages: 2 });
    assert.equal(c.result.outcome, 'ok'); assert.equal(c.result.report.history.requested, 5);
    assert.ok(c.elapsed <= 25000); assert.ok(c.calls.length <= 12); assert.ok(c.result.report.probe.self_calls <= 6);
    assert.match(c.calls.at(-1).path, /authen/); assert.equal(c.result.report.probe.hot_chats, 1); assert.equal(c.result.report.probe.fair_chats, 1);
    if (!c.result.observations[oldest.key]) oldProgress++;
    recentProgress += recent.filter(item => !c.result.observations[item.key]).length;
    for (const call of c.calls.filter(call => call.params.container_id && Number(call.params.end_time) - Number(call.params.start_time) > 3)) currentVisited.add(call.params.container_id);
    const firstHistory = c.calls.find(call => call.path.endsWith('/mget') || Number(call.params.end_time) - Number(call.params.start_time) === 3);
    assert.equal(firstHistory.path.endsWith('/mget'), rotation >= 2);
    assert.ok(parseRemoteSampleCache(remoteSampleCache(c.result)));
  }
  assert.ok(oldProgress > 0); assert.ok(recentProgress > 0); assert.ok(currentVisited.has(f.rows[0].chat_id)); assert.ok(currentVisited.size >= 2);
});

test('matching versions cannot settle absent deletion or unreadable body evidence on recent tickets', t => {
  const f = fixture(t), version = START - 1200000;
  const item = f.add({ debts: { version, deleted: version, body: version } });
  const c = f.collect({ mutateBatch: messages => messages.map(({ deleted, ...message }) => ({ ...message, body: { content: 'unreadable-json' } })) });
  assert.equal(c.result.outcome, 'ok'); assert.equal(c.result.report.ok, false); assert.equal(c.result.report.history.messages_checked, 1);
  assert.deepEqual(c.result.observations[item.key].debts, { deleted: version, body: version });
  assert.equal(c.result.pendingVerification, false); assert.ok(parseRemoteSampleCache(remoteSampleCache(c.result)));
});

test('overlapping recent mget and current lists accept equal evidence in either order and reject contradictions', t => {
  const f = fixture(t), item = f.add({ chatIndex: 0 });
  for (let rotation = 0; rotation < 4; rotation++) {
    const c = f.collect({ rotation, overlap: true });
    assert.equal(c.result.outcome, 'ok'); assert.equal(c.result.report.ok, true); assert.deepEqual(c.result.observations, {});
    assert.equal(c.result.report.history.messages_checked, 1); assert.equal(c.result.report.probe.remote_messages_checked, 3);
    assert.ok(parseRemoteSampleCache(remoteSampleCache(c.result)));
  }
  for (const rotation of [0, 1]) for (const change of [message => ({ ...message, deleted: true }),
    message => ({ ...message, update_time: String(Number(message.update_time) + 1) }),
    message => ({ ...message, msg_type: 'interactive' }),
    message => ({ ...message, body: { content: '{"text":"contradictory synthetic body"}' } })]) {
    const c = f.collect({ rotation, overlap: true, mutateBatch: messages => messages.map(change) });
    assert.equal(c.result.outcome, 'failed'); assert.equal(c.result.report.reason, 'invalid_page');
    assert.ok(c.result.observations[item.key]); assert.equal(c.result.report.ok, false);
    assert.deepEqual(c.result.observations[item.key].debts, item.observation.debts);
  }
});

test('a recent batch 429 keeps all debt, publishes shared cooldown and a new ticket cannot bypass it', t => {
  const f = fixture(t), version = START - 1200000;
  const items = Array.from({ length: 5 }, (_, i) => f.add({ target: START - 3600000 + i,
    debts: { version, deleted: version, body: version } }));
  const c = f.collect({ rotation: 1, rateLimitBatch: true });
  assert.equal(c.result.outcome, 'failed'); assert.equal(c.result.report.reason, 'rate_limited');
  assert.equal(c.calls.length, 2); assert.match(c.calls[0].path, /authen/); assert.match(c.calls[1].path, /mget$/);
  assert.equal(c.result.report.probe.api_calls, 2); assert.equal(c.result.report.probe.self_calls, 1);
  assert.equal(c.result.report.history.targeted.batches, 1); assert.equal(c.result.historyAttempts.length, 5);
  assert.equal(c.result.report.history.messages_checked, 0); assert.equal(Object.keys(c.result.observations).length, 5);
  for (const item of items) assert.deepEqual(c.result.observations[item.key].debts, item.observation.debts);
  assert.equal(c.cooldownWrites.length, 1); const shared = c.cooldownWrites[0];
  assert.equal(shared.operation, 'message_search_bundle'); assert.ok(shared.untilMs >= START + 1200000);
  assert.equal(c.result.cooldownsByOperation.message_search_bundle, shared.untilMs);
  assert.ok(parseRemoteSampleCache(remoteSampleCache(c.result)));

  // A synthetic later accepted generation makes the queue hint valid again;
  // it does not remove the shared cooldown or create an acquisition allowance.
  f.mutate(`UPDATE record_observation_state SET generation=4;
    UPDATE lark_im_history_debt SET verification_generation=4,verification_requested_at_ms=${START + 5000};`);
  const followupAt = START + 60000;
  assert.equal(loadPendingHistoryVerifications(f.db, c.result.observations, f.binding, followupAt).length, 5);
  assert.ok(f.wake(c.result.observations, followupAt).wake, 'ticket is independently eligible without cooldown');
  assert.equal(f.wake(c.result.observations, followupAt, c.result.cooldownsByOperation).wake, null);
  const api = createSampleApi(f.db, { maxApiCalls: 12, maxSelfCalls: 6, remoteSampleBudgetMs: 25000,
    cooldownsByOperation: c.result.cooldownsByOperation }, {
    now: () => followupAt, monotonicNow: () => 0,
    tryAcquireLease: () => assert.fail('known cooldown precedes lease acquisition'),
    spawnSync: () => assert.fail('known cooldown must not issue another API request'),
  });
  assert.equal(api.maxCalls, 12); assert.equal(api.maxSelfCalls, 6);
  assert.throws(() => api.call('/open-apis/im/v1/messages/mget', { message_ids: items.map(item => item.message.message_id) }),
    error => error.reason === 'rate_cooldown' && error.operation === 'message_search_bundle' && error.retryAtMs === shared.untilMs);
  assert.equal(api.count(), 0); assert.equal(api.selfCount(), 0);
});
