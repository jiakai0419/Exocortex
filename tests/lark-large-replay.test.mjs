import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import { retainSourceRepresentation, OBSERVATION_POLICY } from '../dist/core/lark-observation.js';
import { evaluateObservation, observationEvidenceSql } from '../dist/storage/sqlite/observation-store.js';
import { mergeJsonObjectText } from '../dist/core/json-text-patch.js';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';
import { createSyncRunner } from '../src/adapters/lark-im/sync-runner.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { captureLarkWriteAdmission } from '../src/diagnostics/lark-write-admission.mjs';
import { activityDatabaseKey } from '../src/diagnostics/lark-im-activity-evidence.mjs';
import { digest, evaluateSample, sampleScopeHash } from '../src/diagnostics/remote-sample-core.mjs';
import { writeRemoteSampleState, remoteSamplePaths } from '../src/runtime/worker/remote-sample-scheduler.mjs';
import { executeLarkImHistory } from '../src/maintenance/history.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';

// Synthetic identities, local SQLite, real adapter/runner/storage boundaries.
// The injected transport rejects every route except the authored fixture routes.
const START = Date.parse('2026-01-01T00:00:00Z'), END = START + 60000;
const CHAT = 'oc_synthetic_large_replay', SCOPE = chatScopeId(CHAT);
const SELF = { open_id: 'ou_synthetic_large_replay_self', name: 'Synthetic observer' };
const q = store.quoteSql, MiB = 1024 * 1024;
const options = { startMs: START, endMs: END, endExplicit: true, stableHorizonSeconds: 30,
  stableHorizonMs: 30000, pageSize: 50, maxPages: 10, chatPageSize: 100, maxChatPages: 100,
  discoveryPagesPerRun: 1, receivedScopesPerRun: 0, discoveryMode: 'cursor', reconcileIntervalHours: 24,
  receivedMode: 'all', chatTypes: 'group', lockTtlSeconds: 600, retries: 0, retryDelayMs: 0,
  detailMaxPages: 50, detailMaxItems: 1000 };
const raw = (id, type = 'text', text = 'Synthetic body', at = START + 1000) => ({
  message_id: id, chat_id: CHAT, msg_type: type, create_time: String(at), update_time: String(at + 1),
  sender: { id: SELF.open_id, id_type: 'open_id', sender_type: 'user' }, body: { content: JSON.stringify({ text }) },
});
function fixture(t) {
  const parent = new URL('../../tmp/', import.meta.url).pathname;
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'large-replay-fixture-'));
  let preserveFixture = false;
  t.after(() => { if (!preserveFixture) rmSync(directory, { recursive: true, force: true }); });
  const f = { directory, db: join(directory, 'synthetic.sqlite'), sent: [], received: [], details: new Map(), calls: [],
    preserveFixture: () => { preserveFixture = true; },
    project: records => records };
  store.ensureInitialized(f.db);
  store.ensureSourceInitialSyncStart(f.db, 'lark.im', START, { explicit: true });
  store.sqliteExec(f.db, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(SCOPE)},'lark.im',
    'Synthetic replay scope',${q(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`);
  store.reserveInitialLarkAccount(f.db, createHash('sha256').update(`lark.im\0${SELF.open_id}`).digest('hex'), new Date().toISOString());
  restart(f); return f;
}
function restart(f) {
  f.runner = createSyncRunner({ ...createLarkImAdapter({ run(args) {
    const path = args[2], params = JSON.parse(args[args.indexOf('--params') + 1]);
    f.calls.push({ path, params });
    let items;
    if (path.endsWith('/search')) items = f.sent.map(item => ({ meta_data: { message_id: item.message_id } }));
    else if (path.endsWith('/mget')) items = f.sent;
    else if (path === '/open-apis/im/v1/messages') items = f.received.filter(item =>
      Number(item.create_time) >= Number(params.start_time) * 1000 && Number(item.create_time) <= Number(params.end_time) * 1000);
    else if (path.startsWith('/open-apis/im/v1/messages/')) {
      items = f.details.get(path.slice('/open-apis/im/v1/messages/'.length));
      assert.ok(items, 'detail target must be synthetic');
      if (items.length > 31) return { ok: true, data: { items: params.page_token ? items.slice(31) : items.slice(0, 31),
        has_more: !params.page_token, page_token: params.page_token ? '' : 'synthetic_page_2' } };
    } else assert.fail(`Unexpected fixture route ${path}`);
    return { ok: true, data: { items, has_more: false, page_token: '' } };
  } }), buildPeopleContext: () => ({ self: SELF }),
    // Arbitrary future canonical fields belong at the storage boundary. The
    // local-name interface intentionally admits only verified name projection.
    commitLarkListRun: (db, scope, runId, records, ...rest) =>
      store.commitLarkListRun(db, scope, runId, f.project(records), ...rest),
    finishLarkDetailRun: (db, scope, runId, outcomes, ...rest) =>
      store.finishLarkDetailRun(db, scope, runId, outcomes.map(outcome => outcome.record
        ? { ...outcome, record: f.project([outcome.record])[0] } : outcome), ...rest),
  });
}
const admitted = (f, extra = {}) => ({ ...options, ...extra, writeAdmission: captureLarkWriteAdmission(f.db, { selfOpenId: SELF.open_id }) });
const sent = f => f.runner.syncSent(f.db, admitted(f), SELF);
const received = (f, extra = {}) => f.runner.syncReceivedScope(f.db, admitted(f, extra), store.readScope(f.db, SCOPE), SELF);
const retry = f => f.runner.retryDetails(f.db, admitted(f, { detailScope: SCOPE }), SELF);
const record = (f, id) => store.sqliteQuery(f.db, `SELECT * FROM records WHERE external_id=${q(id)};`)[0];
const state = (f, id) => store.sqliteQuery(f.db, `SELECT s.* FROM record_observation_state s JOIN records r ON r.id=s.record_id WHERE r.external_id=${q(id)};`)[0];
const task = (f, id) => store.sqliteQuery(f.db, `SELECT * FROM lark_im_detail_tasks WHERE scope_id=${q(SCOPE)} AND message_id=${q(id)};`)[0];
function merge(f, children = 60, bytes = 20 * 1024) {
  const root = raw('om_synthetic_large_root', 'merge_forward', 'Synthetic root');
  const items = [root, ...Array.from({ length: children }, (_, i) => ({
    ...raw(`om_synthetic_child_${i}`, 'text', 'x'.repeat(bytes)), upper_message_id: root.message_id,
  }))];
  f.sent = [root]; f.details.set(root.message_id, items);
  return { root, items };
}
function sibling(f) {
  const root = raw('om_synthetic_healthy_root', 'merge_forward', 'Healthy root');
  f.details.set(root.message_id, [root, { ...raw('om_synthetic_healthy_child'), upper_message_id: root.message_id }]);
  return root;
}
function qualifyCandidate(f, id) {
  const before = record(f, id);
  const candidate = { ...before, raw_json: JSON.stringify(raw(id, 'text', 'Synthetic inert candidate')) };
  store.sqliteExec(f.db, `UPDATE record_observation_state SET candidate_json=${q(JSON.stringify(candidate))},
    candidate_generation=generation,candidate_attempt='synthetic-earlier',candidate_policy=${q(OBSERVATION_POLICY)},
    candidate_context='synthetic-context',candidate_observed_at_ms=1 WHERE record_id=${before.id};`);
  return state(f, id);
}

for (const children of [30, 60]) test(`unchanged ${children}-child merge survives sent/received restart and healthy sibling`, t => {
  const f = fixture(t), { root } = merge(f, children), healthy = sibling(f);
  assert.equal(sent(f).ok, true);
  const before = record(f, root.message_id);
  assert.equal(Buffer.byteLength(before.canonical_json) > MiB, children === 60);
  f.received = [root, healthy]; restart(f);
  const result = received(f);
  if (!result.ok) {
    f.preserveFixture();
    assert.equal(result.ok, true, JSON.stringify({ result, syntheticDatabase: f.db,
      rootTask: task(f, root.message_id), siblingTask: task(f, healthy.message_id) }));
  }
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.inserted, 1);
  assert.equal(record(f, root.message_id).raw_json, before.raw_json);
  assert.equal(record(f, root.message_id).content_hash, before.content_hash);
  assert.equal(task(f, root.message_id).status, 'complete');
  assert.equal(task(f, healthy.message_id).status, 'complete');
  assert.equal(task(f, root.message_id).attempt_count, 1);
  assert.equal(store.readScope(f.db, SCOPE).cursor.created_at_ms, END);
  if (children === 60) {
    assert.equal(state(f, root.message_id).reason, 'equivalent_projection_capacity_deferred');
    assert.ok(state(f, root.message_id).last_observed_json);
  }
  const calls = f.calls.length; restart(f); retry(f);
  assert.equal(f.calls.length, calls, 'completed receipts survive restart without reacquisition');
});

test('1.5 MiB ordinary inclusive replay admits sibling and clears oversized duplicate candidate qualification', t => {
  const f = fixture(t), large = raw('om_synthetic_large_ordinary', 'text', 'x'.repeat(1500 * 1024), END);
  const healthy = raw('om_synthetic_ordinary_sibling', 'text', 'Healthy ordinary sibling', END + 1000);
  f.received = [large, healthy];
  assert.equal(received(f).inserted, 1);
  const before = record(f, large.message_id), initial = qualifyCandidate(f, large.message_id);
  restart(f); const result = received(f, { endMs: END + 60000 });
  assert.equal(result.ok, true); assert.equal(result.inserted, 1); assert.equal(result.duplicate, 1);
  assert.deepEqual(record(f, large.message_id), before);
  assert.ok(record(f, healthy.message_id));
  const after = state(f, large.message_id);
  assert.equal(after.evidence_generation, initial.evidence_generation + 1);
  assert.equal(after.reason, 'equivalent_evidence_capacity_deferred'); assert.equal(after.last_observed_json, null);
  for (const key of ['candidate_json', 'candidate_generation', 'candidate_attempt', 'candidate_policy', 'candidate_context', 'candidate_observed_at_ms']) assert.equal(after[key], null, key);
  assert.equal(store.readScope(f.db, SCOPE).cursor.created_at_ms, END + 60000);
});

test('deferred large projection preserves old numeric bytes and recoverable incoming-only/changed unknown fields', t => {
  const f = fixture(t), { root } = merge(f), healthy = sibling(f);
  assert.equal(sent(f).ok, true);
  const original = record(f, root.message_id);
  const retained = original.canonical_json.slice(0, -1) + ',"old_only":18446744073709551617,"future_changed":9007199254740993}';
  store.sqliteExec(f.db, `UPDATE records SET canonical_json=${q(retained)},body='Synthetic old projection' WHERE id=${original.id};`);
  const before = record(f, root.message_id); qualifyCandidate(f, root.message_id);
  let incomingCanonical;
  f.project = records => records.map(value => {
    if (value.external_id !== root.message_id) return value;
    incomingCanonical = value.canonical_json.slice(0, -1) + ',"incoming_only":1e400,"future_changed":9007199254740995}';
    return { ...value, canonical_json: incomingCanonical };
  });
  f.received = [root, healthy]; restart(f);
  assert.equal(received(f).ok, true);
  assert.deepEqual(record(f, root.message_id), before);
  const receipt = state(f, root.message_id);
  assert.equal(receipt.reason, 'equivalent_projection_capacity_deferred');
  assert.equal(JSON.parse(receipt.last_observed_json).canonical_json, incomingCanonical);
  assert.match(receipt.last_observed_json, /incoming_only/); assert.equal(receipt.candidate_json, null);
  assert.ok(record(f, healthy.message_id));
});

test('unrecordable changed source backs off only its root, invalidates candidate and keeps cursor honest through restart', t => {
  const f = fixture(t), { root, items } = merge(f, 2), healthy = sibling(f);
  assert.equal(sent(f).ok, true);
  const before = record(f, root.message_id), qualified = qualifyCandidate(f, root.message_id);
  const changed = { ...root, update_time: String(Number(root.update_time) + 1), body: { content: '{"text":"Synthetic changed root"}' } };
  f.details.set(root.message_id, [changed, ...Array.from({ length: 90 }, (_, i) => ({
    ...raw(`om_synthetic_changed_child_${i}`, 'text', 'z'.repeat(20 * 1024)), upper_message_id: root.message_id,
  }))]);
  f.received = [changed, healthy]; restart(f);
  const result = received(f), failed = task(f, root.message_id);
  assert.equal(result.ok, false); assert.equal(result.inserted, 1); assert.equal(result.pending_details, 1);
  assert.equal(failed.status, 'pending'); assert.equal(failed.attempt_count, 1);
  assert.equal(failed.last_error_type, 'LarkDetailEvidenceLimit'); assert.equal(failed.last_error_message, 'detail_evidence_capacity_exceeded');
  assert.ok(Date.parse(failed.retry_at) > Date.now());
  assert.deepEqual(record(f, root.message_id), before); assert.ok(record(f, healthy.message_id));
  assert.equal(store.readScope(f.db, SCOPE).cursor, null);
  const rejected = state(f, root.message_id);
  assert.equal(rejected.candidate_json, qualified.candidate_json); assert.equal(rejected.candidate_generation, null);
  assert.equal(rejected.evidence_generation, qualified.evidence_generation + 1);
  const calls = f.calls.length; restart(f); retry(f); assert.equal(f.calls.length, calls, 'backoff survives restart');
  // A later complete bounded response remains recoverable and finishes debt.
  f.details.set(root.message_id, [changed, ...items.slice(1)]);
  store.sqliteExec(f.db, `UPDATE lark_im_detail_tasks SET retry_at='2000-01-01T00:00:00.000Z' WHERE scope_id=${q(SCOPE)} AND message_id=${q(root.message_id)};`);
  restart(f); const recovered = retry(f);
  assert.equal(recovered[0].ok, true); assert.equal(task(f, root.message_id).attempt_count, 2);
  assert.equal(task(f, root.message_id).status, 'complete');
  assert.equal(JSON.parse(record(f, root.message_id).raw_json).update_time, changed.update_time);
  assert.equal(store.readScope(f.db, SCOPE).cursor.created_at_ms, END);
});

test('oversized deferred new canonical evidence remains debt rather than silently completing', t => {
  const f = fixture(t), { root } = merge(f, 90), healthy = sibling(f);
  assert.equal(sent(f).ok, true); const before = record(f, root.message_id);
  f.project = records => records.map(value => value.external_id === root.message_id ? {
    ...value, canonical_json: value.canonical_json.slice(0, -1) + ',"incoming_only":18446744073709551617}',
  } : value);
  f.received = [root, healthy]; restart(f);
  const result = received(f);
  assert.equal(result.ok, false); assert.equal(result.inserted, 1);
  assert.deepEqual(record(f, root.message_id), before);
  assert.equal(task(f, root.message_id).status, 'pending'); assert.equal(task(f, root.message_id).attempt_count, 1);
  assert.equal(task(f, healthy.message_id).status, 'complete'); assert.equal(store.readScope(f.db, SCOPE).cursor, null);
});

test('canonical patch bounds remain strict at 1 MiB while accepted identical text needs no editing', () => {
  // Derive exact lengths rather than rely on an encoded character count.
  const base = '{"source_api":"im.v1.messages","padding":""}';
  const canonical = bytes => base.replace('"padding":""', '"padding":"' + 'x'.repeat(bytes - Buffer.byteLength(base)) + '"');
  for (const bytes of [MiB - 1, MiB, MiB + 1]) {
    const text = canonical(bytes); assert.equal(Buffer.byteLength(text), bytes);
    const before = { canonical_json: text, raw_json: 'accepted source', content_hash: 'accepted hash' };
    assert.equal(retainSourceRepresentation(before, before).canonical_json, text);
    if (bytes <= MiB) assert.equal(mergeJsonObjectText(text, text, { retain: [], deleteMissing: [] }), text);
    else assert.throws(() => mergeJsonObjectText(text, text, { retain: [], deleteMissing: [] }), /^Error: json_patch_limit$/);
  }
  const before = { source_id: 'lark.im', external_id: 'synthetic', external_version: '1', record_type: 'lark.im.message',
    occurred_at_ms: 1, container_id: CHAT, raw_json: '{"message_id":"synthetic","msg_type":"text"}',
    body: 'old', title: null, canonical_json: '{"source_api":"im.v1.messages"}', content_hash: 'hash' };
  assert.throws(() => evaluateObservation(before, { ...before, canonical_json: '{"a":1,"a":2}' }, null,
    { attempt: 'synthetic', startedAtMs: 1 }), /json_patch_duplicate_key/, 'invalid JSON is not capacity debt');
});

test('deferred projection issues only a source-verification ticket; history cannot close a remote finding', t => {
  const f = fixture(t), remote = raw('om_synthetic_projection_ticket');
  f.received = [remote]; assert.equal(received(f).ok, true);
  const original = record(f, remote.message_id);
  const oldCanonical = original.canonical_json.slice(0, -1) + ',"old_only":18446744073709551617,"padding":"' + 'x'.repeat(MiB) + '"}';
  store.sqliteExec(f.db, `UPDATE records SET body='Synthetic obsolete projection',canonical_json=${q(oldCanonical)} WHERE id=${original.id};`);
  const before = record(f, remote.message_id), now = Date.now();
  const binding = { database_key: activityDatabaseKey(f.db), account_key: createHash('sha256').update(`lark.im\0${SELF.open_id}`).digest('hex') };
  const key = digest([binding.database_key, binding.account_key, CHAT, remote.message_id, Number(remote.create_time)]);
  const observations = { [key]: { kind: 'version', target: Number(remote.create_time), first_seen: now,
    last_seen: now, run_finished: now, last_checked: now, scope_hash: sampleScopeHash(binding, CHAT),
    debts: { version: Number(remote.update_time) } } };
  const path = remoteSamplePaths(f.directory, binding.database_key).state;
  writeRemoteSampleState(path, { kind: 'lark_im_remote_sample_schedule/v1', ...binding, written_at: now,
    next_due: now + 900000, failures: 0, rotation: 0, observations, last_outcome: 'ok', cooldowns: {}, blocked_reason: null }, now);
  const sampleBytes = readFileSync(path);
  const history = () => executeLarkImHistory({ db: f.db, logDir: f.directory, maxRecords: 1, maxCliAttempts: 4, maxSeconds: 30 }, {
    createRequestSession: () => ({ runLark() { assert.fail('Unexpected transport'); }, assertReady() {},
      summary: () => ({ cli_attempts: 2, max_cli_attempts: 4, max_seconds: 30, elapsed_ms: 1, stop_reason: null }) }),
    getSelfProfile: () => SELF, fetchChatMessageList: () => ({ messages: [normalizeApiMessage(remote)], pages: 1 }),
  });
  const first = history(); assert.equal(first.outcome, 'processed'); assert.equal(first.conflicts, 0); assert.equal(first.updated, 0);
  assert.deepEqual(record(f, remote.message_id), before);
  assert.equal(state(f, remote.message_id).reason, 'equivalent_projection_capacity_deferred');
  const ticket = store.sqliteQuery(f.db, 'SELECT * FROM lark_im_history_debt;')[0];
  assert.equal(ticket.status, 'awaiting_verification'); assert.ok(ticket.verification_requested_at_ms > 0);
  history();
  assert.equal(store.sqliteQuery(f.db, 'SELECT * FROM lark_im_history_debt;')[0].verification_requested_at_ms,
    ticket.verification_requested_at_ms, 'equivalent replay cannot create a fresh independent ticket');
  assert.deepEqual(readFileSync(path), sampleBytes, 'history never edits the independent remote finding');
  const sampled = evaluateSample({ messages: [remote], records: new Map([[remote.message_id, record(f, remote.message_id)]]),
    coverage: {}, binding, previous: observations, now: Date.now(), windowEnd: Date.now() });
  assert.deepEqual(sampled.observations, {}, 'only an independent source comparison supplies closure proof');
  assert.equal(record(f, remote.message_id).canonical_json, oldCanonical, 'source closure makes no claim of projection refresh');
});

test('evidence envelope bound is exact; only source-equivalent applied projection can omit oversized bytes', () => {
  const limit = 4 * MiB;
  for (const bytes of [limit - 1, limit, limit + 1]) {
    const incoming = { padding: 'x'.repeat(bytes - Buffer.byteLength('{"padding":""}')) };
    assert.equal(Buffer.byteLength(JSON.stringify(incoming)), bytes);
    const record = { observation: { action: 'equivalent', reason: 'exact', before: { id: 1 }, generation: 0,
      incoming, attempt: 'synthetic', observedAtMs: 1, contextKey: null } };
    const sql = observationEvidenceSql([record]);
    assert.equal(sql.includes('last_observed_json=NULL'), bytes > limit);
    record.observation.reason = 'equivalent_projection_capacity_deferred';
    if (bytes > limit) assert.throws(() => observationEvidenceSql([record]), /observation evidence capacity exceeded/);
    else assert.ok(observationEvidenceSql([record]).includes('equivalent_projection_capacity_deferred'));
    record.observation.action = 'accept';
    if (bytes > limit) assert.throws(() => observationEvidenceSql([record]), /observation evidence capacity exceeded/);
  }
});
