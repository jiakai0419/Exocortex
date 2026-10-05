import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectRemoteSampleCoverage, inspectRemoteSampleSnapshot } from "../src/diagnostics/remote-sample-coverage.mjs";

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
