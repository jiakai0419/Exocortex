import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chatScopeId, messageWindow } from '../src/adapters/lark-im/core.mjs';
import { collectRemoteSample } from '../src/diagnostics/remote-sample.mjs';
import { SAMPLE_POLICY, digest, evaluateSample, sampleScopeHash, selectSampleChats } from '../src/diagnostics/remote-sample-core.mjs';
import { loadLegacyObservationCandidates, selectHistoricalObservation } from '../src/diagnostics/remote-sample-history.mjs';
import { parseRemoteSampleCache, publicRemoteReport, remoteSampleCache, summarizeRemoteSample } from '../src/diagnostics/remote-sample-cache.mjs';
import { sanitizeRemoteObservations } from '../src/runtime/worker/remote-sample-scheduler.mjs';
import { collectCheckReport, liveReady } from '../src/diagnostics/check-report.mjs';
import { fixture as checkFixture, liveResult, options as checkOptions } from './helpers/check-fixture.mjs';

const now = Date.parse('2036-01-20T12:00:00Z');
const created = now - 3 * 86400000;
const binding = { state: 'verified', evidence: 'single_sent_actor', database_key: 'a'.repeat(64), account_key: 'b'.repeat(64) };
const row = i => ({ id: chatScopeId(`synthetic_chat_${i}`), chat_id: `synthetic_chat_${i}`, source_id: 'lark.im', enabled: 1,
  hot_rank: i, hot_seen_at: new Date(now).toISOString() });
const inventory = Array.from({ length: 12 }, (_, i) => row(i));
const old = { message_id: 'synthetic_old_message', chat_id: row(11).chat_id, msg_type: 'text',
  create_time: String(created), update_time: String(now - 3600000), body: { content: '{"text":"invented private body"}' } };
const keyFor = message => digest([binding.database_key, binding.account_key, message.chat_id, message.message_id, Number(message.create_time)]);
const key = keyFor(old);
const observation = (overrides = {}) => ({ kind: 'version', target: created, first_seen: now - 3600000, last_seen: now - 3600000,
  run_finished: created + 60000, scope_hash: sampleScopeHash(binding, old.chat_id), last_checked: now - 3600000, ...overrides });
const local = message => ({ source_id: 'lark.im', record_type: 'lark.im.message', external_id: message.message_id,
  container_id: message.chat_id, external_version: message.update_time, raw_json: JSON.stringify(message),
  canonical_json: JSON.stringify({ source_api: 'im.v1.messages' }) });

function sample({ repaired = false, previous = { [key]: observation() }, at = now, rows = inventory,
  historicalItems = [old], fullPages = false, previousOverflow = false, candidates = [], snapshotReason, accountKey = binding.account_key, historicalFailure = false } = {}) {
  let calls = 0;
  const requests = [];
  const records = new Map([[old.message_id, local(repaired ? old : { ...old, update_time: String(created) })]]);
  const result = collectRemoteSample('/synthetic/no-database.sqlite', { previousObservations: previous, previousOverflow, accountKey }, {
    now: () => at, context: () => ({ database_key: binding.database_key }), readBinding: () => binding,
    loadInventory: () => rows, sqliteJson: () => candidates,
    inspectSnapshot: (_db, targets) => {
      for (const target of targets) assert.equal(typeof target.expected_chat_id, 'string');
      return { records, coverage: Object.fromEntries(targets.map(target => [target.key, { covered: !snapshotReason,
        details_pending: false, latest_finished_ms: at - 1, reason: snapshotReason || 'covered' }])) };
    },
    api: { deadline: at + 55000, count: () => calls, call: (path, params) => {
      assert.ok(++calls <= SAMPLE_POLICY.calls, 'existing total call budget');
      if (path.includes('/authen/')) return { code: 0, data: { open_id: 'ou_synthetic_self', tenant_key: 'synthetic_tenant' } };
      requests.push(params);
      const history = Number(params.start_time) * 1000 < at - SAMPLE_POLICY.windowMs - SAMPLE_POLICY.stableBufferMs;
      if (history && historicalFailure) throw new Error('synthetic historical failure');
      let items;
      if (history) items = historicalItems;
      else {
        const item = { ...old, message_id: `synthetic_recent_${params.container_id}_${params.page_token || 'first'}`,
          chat_id: params.container_id, create_time: String(at - 3600000), update_time: String(at - 3600000) };
        items = [item]; records.set(item.message_id, local(item));
      }
      // Historical pagination returns its target only once, on page two.
      if (history && fullPages && !params.page_token) items = [];
      return { code: 0, data: { items, has_more: fullPages && !params.page_token, page_token: fullPages && !params.page_token ? 'synthetic_next' : '' } };
    } },
  });
  return { result, requests, calls };
}

test('an old edit is outside normal cursor discovery but retained observations receive one exact historical revisit', () => {
  assert.ok(messageWindow({ cursor: { created_at_ms: now - 60000 } }, { startMs: created, endMs: now, endExplicit: true }).startMs > created);
  const before = sample({ fullPages: true });
  assert.equal(before.result.report.findings.stale_version, 1);
  assert.equal(before.calls, 12);
  assert.equal(before.result.report.probe.hot_chats, 2);
  assert.equal(before.result.report.probe.fair_chats, 2);
  assert.equal(before.result.report.history.pages, 2);
  const historical = before.requests.filter(params => Number(params.start_time) * 1000 < created);
  assert.equal(historical.length, 2);
  assert.equal(Number(historical[0].end_time) - Number(historical[0].start_time), 3);
  assert.equal(historical[0].start_time, historical[1].start_time);
  const repaired = sample({ repaired: true, previous: before.result.observations });
  assert.equal(repaired.result.report.status, 'healthy');
  assert.equal(repaired.result.report.history.messages_checked, 1);
  assert.deepEqual(repaired.result.observations, {});
  const cache = remoteSampleCache(repaired.result);
  assert.ok(parseRemoteSampleCache(cache));
  assert.equal(summarizeRemoteSample(cache, now, { database_key: binding.database_key }).status, 'sampled');
  assert.doesNotMatch(JSON.stringify(cache), /synthetic|invented|scope_hash|last_checked/);
});

test('a missing remote target, expired evidence, and overflow debt cannot turn green on a later run', () => {
  const expired = observation({ first_seen: now - SAMPLE_POLICY.observationTtlMs - 1000, last_seen: now - SAMPLE_POLICY.observationTtlMs - 1000 });
  const first = sample({ previous: { [key]: expired }, historicalItems: [] });
  assert.equal(first.result.report.status, 'delayed');
  assert.equal(first.result.report.findings.expired_observations, 1);
  assert.equal(Object.keys(first.result.observations).length, 1);
  const second = sample({ previous: first.result.observations, historicalItems: [], at: now + SAMPLE_POLICY.intervalMs });
  assert.equal(second.result.report.status, 'delayed');
  assert.equal(Object.keys(second.result.observations).length, 1);
  assert.deepEqual(sanitizeRemoteObservations({ [key]: expired }, now), { [key]: expired });
  const overflow = sample({ previous: {}, previousOverflow: true });
  assert.equal(overflow.result.observationOverflow, true);
  assert.equal(overflow.result.report.findings.observation_overflow, 1);
  assert.equal(overflow.result.report.status, 'delayed');
});

test('legacy hash observations route only through one matching local identity; absent or ambiguous evidence stays unresolved', () => {
  const legacy = observation(); delete legacy.scope_hash; delete legacy.last_checked;
  const candidate = { external_id: old.message_id, container_id: old.chat_id, occurred_at_ms: created };
  const routed = sample({ previous: { [key]: legacy }, candidates: [candidate], repaired: true });
  assert.equal(routed.result.report.status, 'healthy');
  for (const candidates of [[], [candidate, candidate], [{ ...candidate, container_id: 'synthetic_other_chat' }],
    Array.from({ length: 1001 }, () => candidate)]) {
    const unavailable = sample({ previous: { [key]: legacy }, candidates, repaired: true });
    assert.equal(unavailable.result.report.history.unroutable, 1);
    assert.equal(unavailable.result.report.status, 'delayed');
    assert.equal(unavailable.result.report.probe.hot_chats_found, 5);
    assert.ok(unavailable.result.observations[key]);
  }
});

test('one retained target rotates fairly even when unroutable, while two hot and two fair current chats keep progressing', () => {
  const previous = Object.fromEntries(Array.from({ length: 200 }, (_, n) => [digest(['invented', n]), observation({ last_checked: 0 })]));
  const seen = new Set();
  for (let n = 0; n < 200; n++) {
    const selected = selectHistoricalObservation('unused', previous, binding, [], now - SAMPLE_POLICY.windowMs, now + n);
    assert.equal(selected.chat, null);
    assert.equal(seen.has(selected.key), false);
    seen.add(selected.key); previous[selected.key].last_checked = now + n;
  }
  let rotation = 0; const chats = new Set();
  for (let n = 0; n < 12; n++) {
    const selected = selectSampleChats(inventory, rotation, now, 4); rotation = selected.rotation;
    assert.equal(selected.hot, 2); assert.equal(selected.fair, 2);
    selected.selected.forEach(chat => chats.add(chat.chat_id));
  }
  assert.equal(chats.size, inventory.length);
});

test('disabled, changed and foreign scopes cannot route; atomic snapshot revocation invalidates the attempt', () => {
  for (const change of [{ enabled: 0 }, { source_id: 'synthetic.foreign' }, { chat_id: 'synthetic_replaced_chat' }, { unsupported_reason: 'restricted_mode' },
    { initial_sync_start_ms: created + 1 }]) {
    const result = sample({ rows: inventory.map(row => row.chat_id === old.chat_id ? { ...row, ...change } : row), repaired: true }).result;
    assert.equal(result.report.history.unroutable, 1); assert.ok(result.observations[key]);
  }
  for (const snapshotReason of ['source_unavailable', 'scope_unavailable']) {
    const result = sample({ repaired: true, snapshotReason }).result;
    assert.equal(result.outcome, 'failed'); assert.equal(result.report.reason, 'context_changed'); assert.ok(result.observations[key]);
  }
  const switched = sample({ previousOverflow: true, accountKey: 'c'.repeat(64) }).result;
  assert.equal(switched.report.history, undefined); assert.deepEqual(switched.observations, {}); assert.equal(switched.observationOverflow, false);
  const ordinaryBeforeBaseline = sample({ previous: {}, snapshotReason: 'before_sync_baseline' }).result;
  assert.equal(ordinaryBeforeBaseline.outcome, 'ok');
  const historicalBaselineChanged = sample({ snapshotReason: 'before_sync_baseline' }).result;
  assert.equal(historicalBaselineChanged.outcome, 'failed');
  assert.equal(historicalBaselineChanged.report.reason, 'context_changed');
});

test('only an actual historical request publishes attempt-order metadata on failure', () => {
  const failed = sample({ historicalFailure: true }).result;
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.historyAttempt, { key, checked_at: now, database_key: binding.database_key, source_id: 'lark.im' });
  assert.ok(failed.observations[key]);
  const unroutable = sample({ rows: inventory.filter(row => row.chat_id !== old.chat_id) }).result;
  assert.equal(unroutable.historyAttempt, null);
});

test('bounded overflow retains prior observations and a persistent debt marker after later matches', () => {
  const previous = Object.fromEntries(Array.from({ length: 200 }, (_, n) => [digest(['prior', n]), observation()]));
  const first = evaluateSample({ messages: [old], records: new Map(), coverage: {}, binding, previous, now, windowEnd: now });
  assert.equal(Object.keys(first.observations).length, 200);
  assert.equal(first.observationOverflow, true);
  assert.deepEqual(Object.keys(first.observations).sort(), Object.keys(previous).sort());
  const later = evaluateSample({ messages: [], records: new Map(), coverage: {}, binding, previous: {},
    previousOverflow: first.observationOverflow, now: now + SAMPLE_POLICY.observationTtlMs, windowEnd: now });
  assert.equal(later.counts.observation_overflow, 1);
});

test('historical metadata cannot smuggle identities or contradictory counters into public cache', () => {
  const valid = remoteSampleCache(sample({ repaired: true }).result);
  for (const mutate of [history => { history.message_id = 'synthetic_secret'; }, history => { history.pages = 3; },
    history => { history.messages_checked = 2; }, history => { history.unroutable = 1; }, history => { history.window.end = new Date(now).toISOString(); }]) {
    const cache = structuredClone(valid); mutate(cache.history);
    assert.equal(parseRemoteSampleCache(cache), null);
  }
  const oldCache = remoteSampleCache(sample({ previous: {}, repaired: true }).result);
  assert.equal(Object.hasOwn(oldCache, 'history'), false); assert.ok(parseRemoteSampleCache(oldCache));
  for (const history of [{ ...valid.history, messages_checked: 0 }, { ...valid.history, unsupported_chats: 1 },
    { ...valid.history, messages_checked: 0, pages: 0, chats_checked: 0, unroutable: 1, window: null }]) {
    assert.equal(publicRemoteReport({ ...valid, history }).ok, false);
  }
});

test('manual and one-shot checks share historical projection validity before claiming a pass', async () => {
  const report = sample({ repaired: true }).result.report;
  assert.equal(liveReady(report), true);
  for (const history of [{ ...report.history, body: 'synthetic_secret' }, { ...report.history, messages_checked: 0 },
    { ...report.history, window: { start: new Date(now).toISOString(), end: new Date(now + 3000).toISOString() } }]) {
    const invalid = { ...report, history };
    assert.equal(liveReady(invalid), false);
    for (const writeLiveCache of [true, false]) {
      const f = checkFixture();
      f.deps.collectRemoteSample = () => liveResult(invalid);
      f.deps.runManualRemoteSample = () => liveResult(invalid);
      const checked = await collectCheckReport(checkOptions({ live: true, writeLiveCache }), f.context, f.deps);
      assert.notEqual(checked.exit_code, 0);
      assert.notEqual(checked.checks.live.status, 'passed');
      assert.equal(checked.checks.live.evidence.ok, false);
      assert.doesNotMatch(JSON.stringify(checked), /synthetic_secret/);
    }
  }
  for (const edit of [value => { value.history.pages = 2; }, value => {
    value.probe.hot_chats_found = 5; value.probe.fair_chats = 3; value.probe.chats_checked = 5;
    value.probe.pages = 5; value.probe.api_calls = 8;
  }, value => { value.reason = 'partial_sample'; }, value => { value.binding.evidence = 'synthetic_unknown'; }, value => {
    Object.assign(value.probe, { hot_chats_found: 0, hot_chats: 0, fair_chats: 0, chats_checked: 0, pages: 0, remote_messages_checked: 1, api_calls: 3 });
    Object.assign(value.findings, { present: 1, content_equal: 1, content_unverified: 0 });
  }]) {
    const invalid = structuredClone(report); edit(invalid);
    assert.equal(publicRemoteReport(invalid).ok, false);
    assert.equal(liveReady(invalid), false);
  }
});

test('legacy lookup uses the existing exact container/time index and a hard one-second bound', () => {
  let sql;
  loadLegacyObservationCandidates('unused', created, [row(11)], { sqliteJson: (_db, query, _label, options) => {
    sql = query; assert.equal(options.timeoutMs, 1000); return [];
  } });
  const result = spawnSync('python3', ['-B', '-c', `
import json,sqlite3,sys
c=sqlite3.connect(':memory:')
c.executescript('CREATE TABLE records(source_id TEXT,record_type TEXT,container_id TEXT,occurred_at_ms INTEGER,external_id TEXT); CREATE INDEX idx_records_container_time ON records(source_id,container_id,occurred_at_ms);')
c.executemany('INSERT INTO records VALUES(?,?,?,?,?)',[('lark.im','lark.im.message','synthetic_unrelated',${created},str(n)) for n in range(20000)])
c.execute('INSERT INTO records VALUES(?,?,?,?,?)',('lark.im','lark.im.message','synthetic_chat_11',${created},'synthetic_target'))
c.set_progress_handler(lambda: 1,1000)
rows=c.execute(sys.stdin.read()).fetchall()
assert len(rows)==1 and rows[0][0]=='synthetic_target'
print(json.dumps({'bounded_exact_lookup':True}))
`], { input: sql, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
});
