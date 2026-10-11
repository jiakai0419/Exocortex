import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { activityDatabaseKey } from '../src/diagnostics/lark-im-activity-evidence.mjs';
import { collectRemoteSample } from '../src/diagnostics/remote-sample.mjs';
import { parseRemoteSampleCache } from '../src/diagnostics/remote-sample-cache.mjs';
import { digest, evaluateSample, SAMPLE_POLICY, sampleScopeHash } from '../src/diagnostics/remote-sample-core.mjs';
import { selectHistoricalObservation } from '../src/diagnostics/remote-sample-history.mjs';
import { createRemoteSamplePublication, REMOTE_SAMPLE_CACHE_GATE } from '../src/runtime/worker/remote-sample-cache-gate.mjs';
import { executeRemoteSampleAttempt, readRemoteSampleState, remoteSamplePaths, sanitizeRemoteObservations,
  writeRemoteSampleState } from '../src/runtime/worker/remote-sample-scheduler.mjs';

const NOW = Date.parse('2030-01-03T12:00:00Z');
const CREATED = NOW - 3_600_000;
const binding = { state: 'verified', evidence: 'single_sent_actor', database_key: 'a'.repeat(64), account_key: 'b'.repeat(64) };
const original = { message_id: 'om_invented_dimension', chat_id: 'oc_invented_dimension', msg_type: 'interactive',
  create_time: String(CREATED), update_time: String(CREATED), deleted: false, body: { content: '{"card":"invented"}' } };
const local = (message = original) => ({ source_id: 'lark.im', record_type: 'lark.im.message', external_id: message.message_id,
  container_id: message.chat_id, external_version: message.update_time, raw_json: JSON.stringify(message),
  canonical_json: '{"source_api":"im.v1.messages"}' });
const key = digest([binding.database_key, binding.account_key, original.chat_id, original.message_id, CREATED]);
const withoutDeleted = message => { const { deleted, ...rest } = message; return rest; };
const evaluate = (remote, record = local(), previous = {}, at = NOW, coverage = {}) => evaluateSample({
  messages: remote ? [remote] : [], records: new Map(record ? [[original.message_id, record]] : []),
  coverage, binding, previous, now: at, windowEnd: at - SAMPLE_POLICY.stableBufferMs,
});
const legacy = kind => ({ kind, target: CREATED, first_seen: NOW - 1000, last_seen: NOW - 1000, run_finished: 0 });

test('one target retains deletion and version debt through three observations, counting only its current primary finding', () => {
  const first = evaluate({ ...original, deleted: true });
  assert.deepEqual(first.observations[key].debts, { deleted: CREATED });
  const edited = { ...original, update_time: String(CREATED + 1000), deleted: true };
  const second = evaluate(edited, local(), first.observations, NOW + SAMPLE_POLICY.intervalMs);
  assert.deepEqual(second.observations[key].debts, { deleted: CREATED, version: CREATED + 1000 });
  assert.equal(second.observations[key].kind, 'version');
  assert.equal(second.counts.stale_version, 1);
  assert.equal(second.counts.content_mismatch, 0);
  assert.equal(second.counts.unresolved_prior, 0);
  const caughtUp = local({ ...original, update_time: edited.update_time });
  const third = evaluate(withoutDeleted(edited), caughtUp, second.observations, NOW + 2 * SAMPLE_POLICY.intervalMs);
  assert.deepEqual(third.observations[key].debts, { deleted: CREATED });
  assert.equal(third.observations[key].kind, 'content');
  assert.equal(third.counts.stale_version, 0);
  assert.equal(third.counts.content_mismatch, 0);
  assert.equal(third.counts.unresolved_prior, 1);
  assert.equal(third.counts.content_unverified, 1);
  assert.equal(third.observations[key].last_seen, second.observations[key].last_seen);
  assert.equal(third.observations[key].last_checked, NOW + 2 * SAMPLE_POLICY.intervalMs);
  const fourth = evaluate({ ...edited, deleted: false }, caughtUp, third.observations, NOW + 3 * SAMPLE_POLICY.intervalMs);
  assert.deepEqual(fourth.observations, {});
});

test('version-only debt resolves for an unverified dynamic body, but not against a regressed equal version', () => {
  const newer = { ...original, update_time: String(CREATED + 1000) };
  const first = evaluate(newer);
  const regressed = evaluate(original, local(), first.observations);
  assert.deepEqual(regressed.observations[key].debts, { version: CREATED + 1000 });
  assert.equal(regressed.counts.unresolved_prior, 1);
  const resolved = evaluate(withoutDeleted(newer), local(newer), first.observations);
  assert.deepEqual(resolved.observations, {});
  assert.equal(resolved.counts.content_unverified, 1);
});

test('unreadable static bodies do not invalidate independent version or explicit deletion equality', () => {
  const text = { ...original, msg_type: 'text', body: { content: '{"text":"Invented"}' } };
  const first = evaluate({ ...text, deleted: true }, local(text));
  const newer = { ...text, update_time: String(CREATED + 1000) };
  const second = evaluate(newer, local(text), first.observations);
  assert.deepEqual(second.observations[key].debts, { deleted: CREATED, version: CREATED + 1000 });
  const unreadable = { ...newer, body: { content: 'invented invalid JSON' } };
  const third = evaluate(unreadable, local(newer), second.observations);
  assert.deepEqual(third.observations, {});
  assert.equal(third.counts.content_unverified, 1);
  assert.equal(third.counts.content_equal, 0);
});

test('body, deletion and type proofs settle separately; type equality alone cannot clear an old body contradiction', () => {
  const text = { ...original, msg_type: 'text', body: { content: '{"text":"Invented A"}' } };
  const remote = { ...text, body: { content: '{"text":"Invented B"}' } };
  const first = evaluate(remote, local(text));
  assert.deepEqual(first.observations[key].debts, { body: CREATED });
  const typeDifference = evaluate({ ...remote, msg_type: 'interactive', deleted: true }, local(text), first.observations);
  assert.deepEqual(typeDifference.observations[key].debts, { body: CREATED, type: CREATED, deleted: CREATED });
  assert.equal(typeDifference.counts.content_mismatch, 1);
  const partial = evaluate({ ...remote, msg_type: 'interactive', deleted: true }, local({ ...remote, msg_type: 'interactive', deleted: true }), typeDifference.observations);
  assert.deepEqual(partial.observations[key].debts, { body: CREATED });
  assert.equal(partial.counts.unresolved_prior, 1);
  const resolved = evaluate(remote, local(remote), partial.observations);
  assert.deepEqual(resolved.observations, {});
  assert.equal(resolved.counts.content_equal, 1);
});

test('legacy kind-only caches migrate conservatively without clearing unverified content or inventing a version floor', () => {
  for (const kind of ['missing', 'version', 'content']) {
    const retained = evaluate(null, null, { [key]: legacy(kind) });
    assert.equal(retained.counts.unresolved_prior, 1);
    assert.deepEqual(retained.observations[key].debts,
      kind === 'missing' ? { missing: NOW - 1000 } : kind === 'version' ? { version: 0 } : { legacy_content: 0 });
  }
  assert.deepEqual(evaluate(withoutDeleted(original), local(), { [key]: legacy('version') }).observations, {});
  const unverified = evaluate(original, local(), { [key]: legacy('content') });
  assert.deepEqual(unverified.observations[key].debts, { legacy_content: 0 });
  const text = { ...original, msg_type: 'text', body: { content: '{"text":"Invented"}' } };
  assert.ok(evaluate(withoutDeleted(text), local(text), unverified.observations).observations[key]);
  assert.deepEqual(evaluate(text, local(text), unverified.observations).observations, {});
});

test('new missing debt starts its own confirmation clock and does not inherit older content evidence', () => {
  const first = evaluate({ ...original, deleted: true });
  const at = NOW + SAMPLE_POLICY.intervalMs;
  const proof = { [key]: { covered: true, latest_finished_ms: at - 1 } };
  const missing = evaluate(original, null, first.observations, at, proof);
  assert.equal(missing.counts.suspected_missing, 1);
  assert.equal(missing.counts.confirmed_missing, 0);
  assert.equal(missing.observations[key].debts.missing, at);
  assert.equal(missing.observations[key].debts.deleted, CREATED);
  assert.equal(evaluate(original, null, missing.observations, at + 1, proof).counts.confirmed_missing, 0);
  const later = at + SAMPLE_POLICY.intervalMs;
  const confirmed = evaluate(original, null, missing.observations, later, { [key]: { covered: true, latest_finished_ms: later - 1 } });
  assert.equal(confirmed.counts.confirmed_missing, 1);
  const found = evaluate(withoutDeleted(original), local(), confirmed.observations, later);
  assert.deepEqual(found.observations[key].debts, { deleted: CREATED });
});

test('unvisited, incomparable, identity-conflicting and local-newer samples preserve debt; expiration never resolves it', () => {
  const first = evaluate({ ...original, deleted: true });
  for (const [remote, record] of [[null, null], [original, { ...local(), canonical_json: '{}' }],
    [original, { ...local(), container_id: 'oc_invented_other' }],
    [original, local({ ...original, update_time: String(CREATED + 1000) })]]) {
    const result = evaluate(remote, record, first.observations, NOW + SAMPLE_POLICY.observationTtlMs + 1);
    assert.deepEqual(result.observations[key].debts, { deleted: CREATED });
    assert.equal(result.counts.unresolved_prior, 1);
    assert.equal(result.counts.expired_observations, 1);
  }
});

test('dimension state rejects private payloads and malformed debt while keeping legacy state readable', () => {
  const base = evaluate({ ...original, deleted: true }).observations[key];
  assert.deepEqual(sanitizeRemoteObservations({ [key]: legacy('content') }, NOW), { [key]: legacy('content') });
  for (const debts of [{}, { deleted: true }, { body: 'invented private body' }, { identity: CREATED },
    { deleted: -1 }, { deleted: 0 }, { deleted: 1 }, { legacy_content: CREATED }, { missing: NOW + 1 }]) {
    assert.equal(sanitizeRemoteObservations({ [key]: { ...base, debts } }, NOW), null);
  }
  assert.equal(sanitizeRemoteObservations({ [key]: { ...base, kind: 'version' } }, NOW), null);
  assert.deepEqual(sanitizeRemoteObservations({ [key]: base }, NOW), { [key]: base });
});

function publishWithRealGate(publication) {
  // Synthetic files only. Invoke the actual publication helper under its lock,
  // after the actual scheduler persisted state and prepared its private stage.
  const python = spawnSync('python3', ['-B', '-c', `${REMOTE_SAMPLE_CACHE_GATE}
import fcntl
value=sample_cache_contract()
fd=os.open(value['lockPath'],os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
held=fcntl.fcntl(fd,fcntl.F_DUPFD,200)
os.close(fd)
os.environ['EXOCORTEX_REMOTE_SAMPLE_LOCK_FD']=str(held)
publish_remote_sample_cache()
os._exit(0)
`], { env: { ...process.env, EXOCORTEX_REMOTE_SAMPLE_PUBLICATION: JSON.stringify(publication) }, encoding: 'utf8', timeout: 5000 });
  assert.equal(python.error, undefined);
  assert.equal(python.status, 0, python.stderr);
}

function publicationFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exo-synthetic-debts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'invented.sqlite'); writeFileSync(db, 'synthetic identity', { mode: 0o600 });
  const database = activityDatabaseKey(db); const paths = remoteSamplePaths(dir, database);
  let now = NOW; let account = binding.account_key; let injectedCalls = 0;
  const observedKey = digest([database, account, original.chat_id, original.message_id, CREATED]);
  const state = () => readRemoteSampleState(paths.state, database, now).state;
  return { dir, database, paths, observedKey, state, setAccount(value) { account = value; },
    async round(remote, record = local(), { fail = false, cacheFail = false } = {}) {
      const publication = createRemoteSamplePublication(dir, database);
      const result = await executeRemoteSampleAttempt({ db, logDir: dir, publication }, {
        nowMs: () => now,
        collect: (_db, options) => {
          let calls = 0;
          return collectRemoteSample(db, options, {
            now: () => now, context: () => ({ database_key: database }),
            readBinding: () => ({ ...binding, database_key: database, account_key: account }),
            loadInventory: () => [{ id: chatScopeId(original.chat_id), chat_id: original.chat_id, source_id: 'lark.im', enabled: 1 }],
            inspectSnapshot: () => ({ coverage: {}, records: new Map(record ? [[original.message_id, record]] : []) }),
            api: { deadline: now + 55000, count: () => calls, call(path) {
              calls++; injectedCalls++;
              if (path === '/open-apis/authen/v1/user_info') return { code: 0, data: { open_id: 'ou_invented_self', tenant_key: 'invented_tenant' } };
              assert.equal(path, '/open-apis/im/v1/messages');
              if (fail) throw new Error('synthetic request failure');
              return { code: 0, data: { items: remote ? [remote] : [], has_more: false, page_token: '' } };
            } },
          });
        },
        ...(cacheFail ? { writeCache: () => false } : {}),
      });
      if (result.cachePrepared) publishWithRealGate(publication);
      const cache = parseRemoteSampleCache(JSON.parse(readFileSync(paths.cache, 'utf8')));
      const loaded = readRemoteSampleState(paths.state, database, now);
      assert.equal(loaded.status, 'ready');
      const persisted = loaded.state;
      now = persisted.next_due;
      return { result, cache, persisted, injectedCalls };
    },
  };
}

test('collector → durable schedule → real publication → reload preserves mixed debt across successive samples', async t => {
  const f = publicationFixture(t);
  const first = await f.round({ ...original, deleted: true });
  assert.equal(first.result.outcome, 'ok'); assert.equal(first.cache.status, 'needs_attention');
  assert.deepEqual(first.persisted.observations[f.observedKey].debts, { deleted: CREATED });
  const edited = { ...original, update_time: String(CREATED + 1000), deleted: true };
  const second = await f.round(edited);
  assert.equal(second.cache.findings.stale_version, 1); assert.equal(second.cache.findings.content_mismatch, 0);
  assert.equal(second.cache.findings.unresolved_prior, 0);
  const caughtUp = local({ ...original, update_time: edited.update_time });
  const third = await f.round(withoutDeleted(edited), caughtUp);
  assert.equal(third.cache.status, 'delayed'); assert.equal(third.cache.ok, false);
  assert.equal(third.cache.findings.unresolved_prior, 1);
  assert.deepEqual(third.persisted.observations[f.observedKey].debts, { deleted: CREATED });
  const fourth = await f.round({ ...edited, deleted: false }, caughtUp);
  assert.deepEqual(fourth.persisted.observations, {});
  assert.equal(fourth.cache.status, 'healthy'); assert.equal(fourth.cache.ok, true);
  assert.equal(fourth.injectedCalls, 12, 'unchanged two identity checks and one native page per synthetic round');
  assert.equal(statSync(f.paths.state).mode & 0o777, 0o600);
  for (const path of [f.paths.state, f.paths.cache]) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /om_invented|oc_invented|ou_invented|invented_tenant|"card"/);
  }
});

test('publication failure and a failed request keep all prior dimensions; verified account change starts a separate namespace', async t => {
  const f = publicationFixture(t);
  const first = await f.round({ ...original, deleted: true });
  const before = first.persisted.observations;
  const failed = await f.round(original, local(), { fail: true });
  assert.equal(failed.result.outcome, 'failed'); assert.deepEqual(failed.persisted.observations, before);
  const unpublished = await f.round(original, local(), { cacheFail: true });
  assert.equal(unpublished.result.reason, 'cache_write_failed'); assert.deepEqual(unpublished.persisted.observations, before);
  f.setAccount('c'.repeat(64));
  const switched = await f.round(original);
  assert.equal(switched.result.outcome, 'ok'); assert.deepEqual(switched.persisted.observations, {});
  assert.equal(switched.persisted.account_key, 'c'.repeat(64));
});

test('the full 200-target six-dimension state fits the existing byte cap and remains eligible for fair revisits', t => {
  const f = publicationFixture(t);
  const n = 253402300799999;
  const item = { kind: 'missing', target: CREATED, first_seen: n - 2, last_seen: n - 1, run_finished: n - 1,
    last_checked: 0, scope_hash: sampleScopeHash(binding, original.chat_id),
    debts: { missing: n - 2, version: n, deleted: n, type: n, body: n, legacy_content: 0 } };
  const observations = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [digest(['invented-capacity', i]), { ...item }]));
  const state = { kind: 'lark_im_remote_sample_schedule/v1', database_key: f.database, account_key: binding.account_key,
    written_at: n, next_due: n + SAMPLE_POLICY.intervalMs, failures: 0, rotation: 0, observations, observation_overflow: true,
    last_outcome: 'ok', cooldowns: {}, blocked_reason: null };
  writeRemoteSampleState(f.paths.state, state, n);
  assert.ok(statSync(f.paths.state).size < 96 * 1024);
  const reloaded = readRemoteSampleState(f.paths.state, f.database, n).state;
  assert.deepEqual(reloaded.observations, observations);
  const visited = new Set();
  for (let i = 0; i < 200; i++) {
    const selected = selectHistoricalObservation('unused', reloaded.observations, binding, [], n - SAMPLE_POLICY.windowMs, n + i);
    assert.equal(visited.has(selected.key), false); visited.add(selected.key);
    reloaded.observations[selected.key].last_checked = n + i;
  }
  const overflow = evaluateSample({ messages: [original], records: new Map(), coverage: {}, binding,
    previous: observations, previousOverflow: true, now: n, windowEnd: n });
  assert.equal(Object.keys(overflow.observations).length, 200);
  assert.equal(overflow.observationOverflow, true);
  assert.equal(overflow.counts.observation_overflow, 1);
});
