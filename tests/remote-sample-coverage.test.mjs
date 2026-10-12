import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectRemoteSampleCoverage, inspectRemoteSampleSnapshot } from "../src/diagnostics/remote-sample-coverage.mjs";
import { chatScopeId } from "../src/adapters/lark-im/core.mjs";
import { digest, evaluateSample, sampleScopeHash } from "../src/diagnostics/remote-sample-core.mjs";
import { scopeObservationContext } from "../src/maintenance/scope-config-policy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOW = 1_609_459_200_000 + 3_600_000;
const KEY = "a".repeat(64);
const target = { key: KEY, scope_id: "lark.im.received.chat.synthetic_scope", message_id: "synthetic_private_message", created_ms: NOW - 120_000 };
const evidence = { covered: true, latest_finished_ms: NOW - 60_000, details_pending: false, reason: "covered" };
const response = (item = evidence, changes = {}) => ({ status: 0, stdout: JSON.stringify({
  kind: "lark_im_sample_snapshot/v1", checked_at_ms: NOW, coverage: { [KEY]: item }, records: [], ...changes,
}) });

test("sample coverage Python regression suite uses only generated fixtures", () => {
  const result = spawnSync("python3", ["-B", "tests/remote_sample_coverage_test.py"], {
    cwd: ROOT, encoding: "utf8", timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("bridge passes bounded targets through stdin with a five-second hard deadline", () => {
  let calls = 0;
  const result = inspectRemoteSampleCoverage("/synthetic/private.sqlite", [target], {
    now: () => NOW,
    spawnSync: (binary, args, opts) => {
      calls++;
      assert.equal(binary, "python3");
      assert.equal(opts.timeout, 5000);
      assert.equal(opts.maxBuffer, 16 * 1024 * 1024);
      assert.equal(opts.killSignal, "SIGKILL");
      assert.ok(args.includes("--sample-targets"));
      assert.ok(!args.join(" ").includes(target.scope_id));
      assert.ok(!args.join(" ").includes(target.message_id));
      assert.deepEqual(JSON.parse(opts.input), { targets: [target] });
      return response();
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { [KEY]: evidence });
  assert.deepEqual(inspectRemoteSampleCoverage("unused", [], { spawnSync: () => assert.fail("no input means no subprocess") }), {});
  assert.deepEqual(inspectRemoteSampleSnapshot("unused", [], { spawnSync: () => assert.fail("no input means no subprocess") }),
    { coverage: {}, records: new Map() });
});

test("bridge rejects invalid, repeated and future targets before a subprocess", () => {
  const bad = [{ ...target, key: "private-id" }, { ...target, scope_id: "lark.im.sent_by_me" },
    { ...target, message_id: "" }, { ...target, message_id: undefined },
    { ...target, created_ms: NOW + 1 }, { ...target, observed_after_ms: NOW + 1 },
    { ...target, raw: "synthetic_private_body" }];
  for (const item of bad) assert.throws(() => inspectRemoteSampleCoverage("unused", [item], {
    now: () => NOW, spawnSync: () => assert.fail("must reject before execution"),
  }), /remote_sample_coverage_invalid_targets/);
  assert.throws(() => inspectRemoteSampleCoverage("unused", [target, target], { now: () => NOW }), /invalid_targets/);
  assert.throws(() => inspectRemoteSampleCoverage("unused", [target], { now: () => NOW, timeoutMs: 5001 }), /invalid_budget/);
});

test("bridge refuses inconsistent covering evidence and does not expose subprocess text", () => {
  const broken = [
    response({ ...evidence, latest_finished_ms: NOW + 1 }),
    response({ ...evidence, details_pending: true }),
    response({ ...evidence, covered: false }),
    response({ ...evidence, reason: "synthetic_private_error" }),
    response(evidence, { coverage: { private_id: evidence } }),
    response(evidence, { error: "readonly_inspection_failed" }),
    { status: 0, stdout: "synthetic_private_payload" },
    { status: 2, stdout: "synthetic_private_payload", stderr: "synthetic_private_error" },
    { status: 0, signal: "SIGKILL", stdout: "synthetic_private_payload" },
  ];
  for (const result of broken) assert.throws(() => inspectRemoteSampleCoverage("unused", [target], {
    now: () => NOW, spawnSync: () => result,
  }), (error) => /^remote_sample_coverage_(invalid_output|execution_failed)$/.test(error.message));
  assert.throws(() => inspectRemoteSampleCoverage("unused", [{ ...target, observed_after_ms: NOW - 60_000 }], {
    now: () => NOW, spawnSync: () => response(),
  }), /invalid_output/);
  const budget = { covered: false, latest_finished_ms: null, details_pending: false, reason: "inspection_budget_exhausted" };
  assert.deepEqual(inspectRemoteSampleCoverage("unused", [target], { now: () => NOW, spawnSync: () => response(budget) }), { [KEY]: budget });
});

test("real bridge reads a synthetic completed window without modifying its SQLite file", () => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-sample-bridge-"));
  try {
    const db = join(dir, "synthetic.sqlite");
    const seed = spawnSync("python3", ["-B", "-c", `
import json,sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.executescript('''
CREATE TABLE sources(id TEXT,enabled INTEGER,config_json TEXT);
CREATE TABLE sync_scopes(id TEXT,source_id TEXT,enabled INTEGER,config_json TEXT);
CREATE TABLE sync_runs(id INTEGER,source_id TEXT,scope_id TEXT,status TEXT,metadata_json TEXT,cursor_before_json TEXT,cursor_after_json TEXT,started_at TEXT,finished_at TEXT);
CREATE TABLE lark_im_list_progress(scope_id TEXT);
CREATE TABLE lark_im_detail_tasks(scope_id TEXT,status TEXT);
CREATE TABLE records(external_id TEXT,source_id TEXT,record_type TEXT,container_id TEXT,external_version TEXT,raw_json TEXT,canonical_json TEXT,UNIQUE(source_id,external_id));
''')
c.execute('INSERT INTO sources VALUES(?,?,?)',('lark.im',1,json.dumps({'initial_sync_start_ms':1609459200000})))
scope='lark.im.received.chat.synthetic_scope'
c.execute('INSERT INTO sync_scopes VALUES(?,?,?,?)',(scope,'lark.im',1,json.dumps({'chat_id':'synthetic_chat'})))
meta={'window_start':'2021-01-01T00:00:00Z','window_end':'2021-01-01T01:00:00Z'}
cursor=lambda t:json.dumps({'kind':'time_message_cursor/v1','created_at_ms':t})
c.execute('INSERT INTO sync_runs VALUES(?,?,?,?,?,?,?,?,?)',(1,'lark.im',scope,'succeeded',json.dumps(meta),cursor(1609459200000),cursor(1609462800000),'2021-01-01T00:00:00Z','2021-01-01T01:00:01Z'))
c.execute('INSERT INTO records VALUES(?,?,?,?,?,?,?)',('synthetic_private_message','lark.im','lark.im.message','synthetic_chat','1609462680000',json.dumps({'body':'synthetic private body'}),json.dumps({'source_api':'im.v1.messages'})))
c.commit()
`, db], { encoding: "utf8", timeout: 5000 });
    assert.equal(seed.status, 0, seed.stderr);
    const before = readFileSync(db);
    const first = inspectRemoteSampleCoverage(db, [target]);
    assert.equal(first[KEY].covered, true);
    const snapshot = inspectRemoteSampleSnapshot(db, [target]);
    assert.deepEqual(snapshot.coverage, first);
    assert.equal(snapshot.records.size, 1);
    assert.ok(snapshot.records.get(target.message_id).raw_json.includes("synthetic private body"));
    const repeated = inspectRemoteSampleCoverage(db, [{ ...target, observed_after_ms: 1_609_462_801_000 }]);
    assert.equal(repeated[KEY].covered, false);
    assert.deepEqual(readFileSync(db), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("snapshot exposes only requested bounded private comparison records", () => {
  const record = { external_id: target.message_id, source_id: "lark.im", record_type: "lark.im.message",
    container_id: "synthetic_chat", external_version: String(target.created_ms),
    raw_json: JSON.stringify({ body: "synthetic private payload" }), canonical_json: null };
  const good = inspectRemoteSampleSnapshot("unused", [target], { now: () => NOW,
    spawnSync: () => response(evidence, { records: [record] }) });
  assert.deepEqual(good.coverage, { [KEY]: evidence });
  assert.deepEqual(good.records, new Map([[target.message_id, record]]));
  assert.ok(!JSON.stringify(good.coverage).includes("synthetic private payload"));
  for (const records of [[{ ...record, external_id: "not_requested" }], [{ ...record, source_id: "synthetic.foreign" }],
    [{ ...record, extra: "private" }], [{ ...record, raw_json: null }], [record, record],
    [{ ...record, raw_json: "x".repeat(2 * 1024 * 1024) }]]) {
    assert.throws(() => inspectRemoteSampleSnapshot("unused", [target], { now: () => NOW,
      spawnSync: () => response(evidence, { records }) }), /^Error: remote_sample_coverage_invalid_output$/);
  }
});

function ticketFixture() {
  const binding = { database_key: 'a'.repeat(64), account_key: 'b'.repeat(64) };
  const chat = 'synthetic_chat'; const created = NOW - 120_000;
  const key = digest([binding.database_key, binding.account_key, chat, target.message_id, created]);
  const scope = { id: chatScopeId(chat), source_id: 'lark.im', enabled: 1,
    config_json: JSON.stringify({ chat_id: chat, hot_rank: 1 }) };
  const source = { id: 'lark.im', enabled: 1, config_json: JSON.stringify({ initial_sync_start_ms: NOW - 86400000 }) };
  const observation = { kind: 'version', target: created, first_seen: NOW - 90000, last_seen: NOW - 90000,
    run_finished: NOW - 90000, scope_hash: sampleScopeHash(binding, chat), debts: { version: created, body: created, deleted: created } };
  const item = { ...target, key, scope_id: scope.id, expected_chat_id: chat };
  const record = { id: 1, external_id: item.message_id, source_id: 'lark.im', record_type: 'lark.im.message',
    container_id: chat, occurred_at_ms: created, generation: 4, candidate_present: 0, history_error_present: 0 };
  const ticket = { record_id: 1, finding_key: key, database_key: binding.database_key, account_key: binding.account_key,
    scope_id: scope.id, context_fingerprint: digest({ source: source.config_json, scope: scope.id,
      policy: scopeObservationContext(scope.config_json) }),
    debt_fingerprint: digest(Object.fromEntries(Object.entries(observation.debts).sort(([a], [b]) => a.localeCompare(b)))),
    verification_generation: 4, verification_requested_at_ms: NOW - 10000, status: 'awaiting_verification' };
  const verification = { binding, observations: { [key]: observation }, acquisitions: { [key]: NOW - 5000 }, requiredKeys: [key] };
  const metadata = { status: 'ready', source, rows: [{ key, record, scope, ticket }] };
  return { key, item, verification, metadata };
}

function inspectTicket(f) {
  return inspectRemoteSampleSnapshot('synthetic-unused', [f.item], { now: () => NOW, verification: f.verification,
    spawnSync: (_exe, _args, options) => {
      assert.deepEqual(JSON.parse(options.input), { targets: [f.item], verification_keys: [f.key] });
      return response(evidence, { coverage: { [f.key]: evidence }, verification: f.metadata });
    } }).verification;
}

test('same-snapshot acceptance fence admits exact bound generation acquired after ticket', () => {
  const f = ticketFixture();
  assert.deepEqual(inspectTicket(f), { status: 'ready', blockedKeys: [] });
  // Hot-only inventory changes use the same actual runtime projection.
  f.metadata.rows[0].scope.config_json = JSON.stringify({ chat_id: 'synthetic_chat', hot_rank: 2 });
  assert.deepEqual(inspectTicket(f).blockedKeys, []);
});

test('pre-acceptance acquisitions cannot clear any floor, including ordinary known targets', () => {
  for (const required of [true, false]) {
    const f = ticketFixture();
    f.verification.requiredKeys = required ? [f.key] : [];
    f.verification.acquisitions[f.key] = f.metadata.rows[0].ticket.verification_requested_at_ms - 1;
    const fence = inspectTicket(f);
    assert.deepEqual(fence.blockedKeys, [f.key]);
    // The collector removes the whole key before the reducer, not one
    // dimension; an equal response is never allowed to consume later floors.
    const previous = structuredClone(f.verification.observations);
    const reduced = evaluateSample({ messages: [], records: new Map(), coverage: {}, binding: f.verification.binding,
      previous, now: NOW, windowEnd: NOW });
    assert.deepEqual(reduced.observations[f.key].debts, previous[f.key].debts);
  }
});

test('ticket identity, context, complete debt, generation, candidate and error drift fail closed', () => {
  const mutations = [
    f => f.metadata.rows[0].record.candidate_present = 1,
    f => f.metadata.rows[0].record.history_error_present = 1,
    f => f.metadata.rows[0].record.generation++,
    f => f.metadata.rows[0].record.generation = null,
    f => f.metadata.rows[0].ticket.verification_generation = null,
    f => f.metadata.rows[0].ticket.database_key = 'c'.repeat(64),
    f => f.metadata.rows[0].ticket.account_key = 'c'.repeat(64),
    f => f.metadata.rows[0].ticket.finding_key = 'c'.repeat(64),
    f => f.metadata.rows[0].ticket.record_id++,
    f => f.metadata.rows[0].ticket.context_fingerprint = 'c'.repeat(64),
    f => f.metadata.rows[0].ticket.debt_fingerprint = 'c'.repeat(64),
    f => f.metadata.rows[0].ticket.status = 'ready',
    f => f.metadata.rows[0].ticket.verification_requested_at_ms = NOW + 1,
    f => f.metadata.rows[0].scope.enabled = 0,
    f => f.metadata.source.enabled = 0,
    f => f.metadata.rows[0].scope.config_json = JSON.stringify({ chat_id: 'synthetic_other' }),
    f => f.metadata.source.config_json = JSON.stringify({ initial_sync_start_ms: NOW }),
    f => f.verification.observations[f.key].debts.deleted++,
  ];
  for (const mutate of mutations) {
    const f = ticketFixture(); mutate(f);
    assert.deepEqual(inspectTicket(f).blockedKeys, [f.key]);
  }
});

test('missing queue schema or required ticket is never positive acceptance evidence', () => {
  const f = ticketFixture();
  f.metadata.rows[0].ticket = null;
  assert.deepEqual(inspectTicket(f).blockedKeys, [f.key]);
  f.verification.requiredKeys = [];
  assert.deepEqual(inspectTicket(f).blockedKeys, []);
  f.metadata = { status: 'unavailable', rows: [] };
  assert.deepEqual(inspectTicket(f).blockedKeys, [f.key]);
  for (const metadata of [undefined, { status: 'ready', rows: [] }, { status: 'unavailable', rows: [{}] }]) {
    f.metadata = metadata;
    assert.throws(() => inspectTicket(f), /remote_sample_coverage_invalid_output/);
  }
});

test('verification keys and acquisition clocks are bounded before subprocess', () => {
  const f = ticketFixture();
  f.verification.acquisitions[f.key] = NOW + 1;
  assert.throws(() => inspectRemoteSampleSnapshot('unused', [f.item], { now: () => NOW, verification: f.verification,
    spawnSync: () => assert.fail('invalid request') }), /remote_sample_coverage_invalid_targets/);
  f.verification.acquisitions[f.key] = NOW - 1;
  assert.deepEqual(inspectRemoteSampleSnapshot('unused', [], { now: () => NOW, verification: f.verification,
    spawnSync: () => assert.fail('no targets') }).verification, { status: 'ready', blockedKeys: [f.key] });
});

test('real SQLite ready queue without an accepted ticket preserves ordinary positive closure only when fully bound', () => {
  const f = ticketFixture();
  f.verification.requiredKeys = [];
  Object.assign(f.metadata.rows[0].ticket, { status: 'ready', verification_generation: null, verification_requested_at_ms: 0 });
  const remote = { message_id: f.item.message_id, chat_id: f.item.expected_chat_id,
    create_time: String(f.item.created_ms), update_time: String(f.item.created_ms), msg_type: 'text',
    deleted: false, body: { content: '{"text":"synthetic equal body"}' } };
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-snapshot-ready-'));
  try {
    const db = join(dir, 'synthetic.sqlite');
    const seed = spawnSync('python3', ['-B', '-c', `
import json,sqlite3,sys
f=json.load(sys.stdin); m=f['metadata']; row=m['rows'][0]; r=row['record']; scope=row['scope']; ticket=row['ticket']
c=sqlite3.connect(sys.argv[1])
c.executescript('''
CREATE TABLE sources(id TEXT PRIMARY KEY,enabled INTEGER,config_json TEXT);
CREATE TABLE sync_scopes(id TEXT PRIMARY KEY,source_id TEXT,enabled INTEGER,config_json TEXT);
CREATE TABLE sync_runs(id INTEGER,source_id TEXT,scope_id TEXT,status TEXT,metadata_json TEXT,cursor_before_json TEXT,cursor_after_json TEXT,started_at TEXT,finished_at TEXT);
CREATE TABLE lark_im_list_progress(scope_id TEXT);
CREATE TABLE lark_im_detail_tasks(scope_id TEXT,status TEXT);
CREATE TABLE records(id INTEGER PRIMARY KEY,external_id TEXT,source_id TEXT,record_type TEXT,container_id TEXT,external_version TEXT,raw_json TEXT,canonical_json TEXT,occurred_at_ms INTEGER,UNIQUE(source_id,external_id));
CREATE TABLE record_observation_state(record_id INTEGER PRIMARY KEY,generation INTEGER,candidate_json TEXT,history_error TEXT);
CREATE TABLE lark_im_history_debt(record_id INTEGER PRIMARY KEY,finding_key TEXT UNIQUE,database_key TEXT,account_key TEXT,scope_id TEXT,context_fingerprint TEXT,debt_fingerprint TEXT,verification_generation INTEGER,verification_requested_at_ms INTEGER,status TEXT);
''')
c.execute('INSERT INTO sources VALUES(?,?,?)',tuple(m['source'][k] for k in ('id','enabled','config_json')))
c.execute('INSERT INTO sync_scopes VALUES(?,?,?,?)',tuple(scope[k] for k in ('id','source_id','enabled','config_json')))
c.execute('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?)',(r['id'],r['external_id'],r['source_id'],r['record_type'],r['container_id'],f['remote']['update_time'],json.dumps(f['remote']),json.dumps({'source_api':'im.v1.messages'}),r['occurred_at_ms']))
c.execute('INSERT INTO record_observation_state VALUES(?,?,NULL,NULL)',(r['id'],r['generation']))
c.execute('INSERT INTO lark_im_history_debt VALUES(?,?,?,?,?,?,?,?,?,?)',tuple(ticket[k] for k in ('record_id','finding_key','database_key','account_key','scope_id','context_fingerprint','debt_fingerprint','verification_generation','verification_requested_at_ms','status')))
c.commit()
`, db], { encoding: 'utf8', input: JSON.stringify({ metadata: f.metadata, remote }), timeout: 5000 });
    assert.equal(seed.status, 0, seed.stderr);
    const inspect = () => inspectRemoteSampleSnapshot(db, [f.item], { verification: f.verification });
    const reduce = snapshot => evaluateSample({ messages: snapshot.verification.blockedKeys.includes(f.key) ? [] : [remote],
      records: snapshot.records, coverage: snapshot.coverage, binding: f.verification.binding,
      previous: f.verification.observations, now: NOW, windowEnd: NOW });
    let snapshot = inspect();
    assert.deepEqual(snapshot.verification.blockedKeys, []);
    assert.equal(reduce(snapshot).observations[f.key], undefined);
    f.verification.requiredKeys = [f.key];
    assert.deepEqual(inspect().verification.blockedKeys, [f.key], 'ready never admits recent fast verification');
    f.verification.requiredKeys = [];
    const corrupt = spawnSync('python3', ['-B', '-c',
      "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"UPDATE lark_im_history_debt SET context_fingerprint='invalid'\"); c.commit()", db],
      { encoding: 'utf8', timeout: 5000 });
    assert.equal(corrupt.status, 0, corrupt.stderr);
    snapshot = inspect();
    assert.deepEqual(snapshot.verification.blockedKeys, [f.key]);
    assert.deepEqual(reduce(snapshot).observations[f.key].debts, f.verification.observations[f.key].debts);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
