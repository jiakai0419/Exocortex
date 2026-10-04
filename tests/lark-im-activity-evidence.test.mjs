import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, renameSync, symlinkSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityDatabaseKey, createActivityWriter, evaluateActivityEvent, inspectActivityProcesses,
  latestActivityEvents, observeLockOwners } from "../src/diagnostics/lark-im-activity-evidence.mjs";
import { buildServiceOverview, buildServiceStatusReport, readRecentWorkerEvents } from "../src/diagnostics/lark-im-service-report.mjs";
import { runWorker, parseArgs } from "../src/cli/lark-im-worker-command.mjs";

const clock = Date.parse("2028-04-12T09:00:00.000Z");
const start = clock - 60000;
const key = "b".repeat(64);
const iso = (ms) => new Date(ms).toISOString();
const processState = { state: "alive", started_at_ms: start, ppid: 8100 };
const phase = (overrides = {}) => ({ type: "lark_im_worker_activity", version: 1, role: "worker",
  pid: 8200, instance_id: "invented-instance", parent_instance: null, database_key: key,
  process_started_at_ms: start, phase: "step", cycle: 4, step: "sent",
  updated_at: iso(clock - 1000), valid_until: iso(clock + 9000), ...overrides });
function overview(events = [phase()], options = {}) {
  return buildServiceOverview({ launchd: { loaded: true, pid: 8200, ...options.launchd },
    syncStatus: { health: "ok", locks: [], ...options.syncStatus }, workerSummary: {}, nowMs: options.nowMs ?? clock,
    activityEvidence: { events, database_key: key, processes: new Map(events.map((event) => [event.pid, processState])),
      observed_at: iso(clock), ...options.evidence },
  });
}

for (const name of ["cycle", "between_steps", "step"]) {
  test(`fresh matched worker ${name} is syncing without any lease`, () => {
    const value = overview([phase({ phase: name, step: name === "step" ? "sent" : null })]);
    assert.equal(value.activity.state, "syncing");
    assert.equal(value.activity.status, "syncing");
    assert.equal(value.activity.cycle, 4);
    assert.doesNotMatch(JSON.stringify(value), /8200|invented-instance|database_key|ppid/);
  });
}
test("fresh interval is waiting and preserves idle compatibility", () => {
  const value = overview([phase({ phase: "waiting", step: null })]);
  assert.equal(value.activity.state, "waiting"); assert.equal(value.activity.status, "idle");
});
for (const [label, event, proc] of [
  ["dead owner", phase(), { state: "dead" }],
  ["PID reused at a different time", phase(), { ...processState, started_at_ms: start + 1000 }],
  ["same-second PID reuse is ambiguous", phase({ updated_at: iso(start + 100), valid_until: iso(clock + 9000) }), processState],
  ["process inspection denied", phase(), { state: "unknown" }],
  ["expired phase", phase({ valid_until: iso(clock) }), processState],
  ["future phase", phase({ updated_at: iso(clock + 1) }), processState],
  ["inverted phase", phase({ valid_until: iso(clock - 1001) }), processState],
  ["unbounded phase", phase({ valid_until: iso(clock + 3600001) }), processState],
  ["missing start identity", phase({ process_started_at_ms: null }), processState],
  ["other database", phase({ database_key: "different" }), processState],
]) test(`${label} cannot establish current work`, () => {
  const value = overview([event], { evidence: { processes: new Map([[8200, proc]]) } });
  assert.equal(value.activity.state, "unknown");
});
test("worker restart cannot reuse prior cycle/instance phase", () => {
  assert.equal(overview([phase({ cycle: 999 })], { launchd: { pid: 8300 } }).activity.state, "unknown");
});
test("standalone foreground has five-second observation freshness even when launchd is stopped", () => {
  const event = phase({ role: "sync", phase: "sync", pid: 8300, updated_at: iso(clock - 1000), valid_until: iso(clock + 4000) });
  assert.equal(overview([event], { launchd: { loaded: false, pid: null } }).activity.state, "syncing");
  assert.equal(overview([event], { launchd: { loaded: false, pid: null }, nowMs: clock + 4000 }).activity.state, "unknown");
});
test("independent foreground can explain work while a worker waits", () => {
  assert.equal(overview([phase({ phase: "waiting" }), phase({ role: "sync", phase: "sync", pid: 8300, instance_id: "independent" })]).activity.state, "syncing");
});
for (const [label, parent] of [["bound child", "invented-instance"], ["missing binding", null], ["wrong binding", "other-instance"]]) {
  test(`waiting worker and ${label} stay unknown`, () => {
    const child = phase({ role: "sync", phase: "sync", pid: 8300, parent_instance: parent, instance_id: "child" });
    const value = overview([phase({ phase: "waiting" }), child], {
      evidence: { processes: new Map([[8200, processState], [8300, { ...processState, ppid: 8200 }]]) },
    });
    assert.equal(value.activity.state, "unknown");
  });
}
test("worker step and associated child agree; child's stale phase cannot extend worker deadline", () => {
  const child = phase({ role: "sync", phase: "sync", pid: 8300, parent_instance: "invented-instance", instance_id: "child" });
  const evidence = { processes: new Map([[8200, processState], [8300, { ...processState, ppid: 8200 }]]) };
  assert.equal(overview([phase(), child], { evidence }).activity.state, "syncing");
  assert.equal(overview([phase({ valid_until: iso(clock) }), child], { evidence }).activity.state, "unknown");
});
for (const state of [undefined, "alive", "unknown"]) test(`lease owner ${state} never proves activity or waiting`, () => {
  const lock = { locked_at: iso(start), expires_at: iso(clock - 1), owner_state: state, owner_observed_at: iso(clock) };
  assert.equal(overview([], { launchd: { loaded: false }, syncStatus: { locks: [lock] } }).activity.state, "unknown");
  assert.equal(overview([phase({ phase: "waiting" })], { syncStatus: { locks: [lock] } }).activity.state, "unknown");
});
test("stopped service plus freshly proven dead owners remains stopped despite historical work", () => {
  const value = overview([], { launchd: { loaded: false }, syncStatus: { health: "syncing", locks: [
    { locked_at: iso(start), expires_at: iso(clock + 10000), owner_state: "dead", owner_observed_at: iso(clock) },
  ] } });
  assert.equal(value.activity.state, "stopped"); assert.equal(value.activity.status, "idle");
});
test("phase selection uses file append order, including a backwards clock", () => {
  const first = phase(); const last = phase({ phase: "stopped", updated_at: iso(clock - 5000) });
  assert.deepEqual(latestActivityEvents([first, last], key, clock).events, []);
  assert.deepEqual(latestActivityEvents([first, phase({ updated_at: iso(clock - 5000) })]).events, [phase({ updated_at: iso(clock - 5000) })]);
  assert.equal(latestActivityEvents(Array.from({ length: 33 }, (_, n) => phase({ instance_id: `instance-${n}` }))).truncated, true);
});
test("damaged/partial tail never falls back to an older fresh phase", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-activity-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const tail of ['{"type":', 'not-json\n', 'null\n', '"invalid"\n', '{"type":"unknown_event"}\n']) {
    writeFileSync(join(dir, "worker.jsonl"), `${JSON.stringify(phase())}\n${tail}`);
    const log = readRecentWorkerEvents(dir);
    assert.equal(log.activity_integrity, false);
    assert.equal(overview(log.events, { evidence: { integrity: log.activity_integrity } }).activity.state, "unknown");
  }
});
test("strict batched OS observation distinguishes absent, denied, malformed and reused identity", () => {
  let calls = 0;
  const observed = inspectActivityProcesses([8200, 8300, 8200], (_command, args, opts) => {
    calls++; assert.deepEqual(args, ["-o", "pid=,ppid=,stat=,lstart=", "-p", "8200,8300"]); assert.equal(opts.timeout, 2000);
    return { status: 0, stdout: "8200 8100 S Wed Apr 12 08:59:00 2028\n", stderr: "" };
  });
  assert.equal(calls, 1); assert.equal(observed.get(8300).state, "dead");
  assert.equal(observed.get(8200).ppid, 8100);
  for (const response of [{ status: 1, stdout: "", stderr: "denied" }, { status: 0, stdout: "bad output", stderr: "" }, { status: null, error: new Error("timeout") }]) {
    assert.equal(inspectActivityProcesses([8200], () => response).get(8200).state, "unknown");
  }
  assert.equal(inspectActivityProcesses([8200], () => ({ status: 1, stdout: "", stderr: "" })).get(8200).state, "dead");
  const locks = observeLockOwners([{ locked_by: `pid:8200:started:${start}`, locked_at: iso(start + 2000) }],
    () => new Map([[8200, { ...processState, started_at_ms: start + 1000 }]]), () => clock);
  assert.equal(locks[0].owner_state, "dead");
});
test("worker writes actual cycle/interval/stop transitions; errors still write stop", () => {
  const events = [];
  const activity = createActivityWriter({ db: "invented-activity.sqlite", role: "worker", pid: 8200, now: () => clock,
    instanceId: "writer", inspect: () => new Map([[8200, processState]]), emit: (event) => events.push(event) });
  runWorker(parseArgs(["--max-cycles", "2"]), { activity, runCycle: () => true, sleepSeconds: () => {} });
  assert.deepEqual(events.map((event) => event.phase), ["cycle", "waiting", "cycle", "stopped"]);
  assert.throws(() => runWorker(parseArgs(["--once"]), { activity, runCycle: () => { throw Error("invented failure"); } }));
  assert.equal(events.at(-1).phase, "stopped");
  assert.doesNotThrow(() => createActivityWriter({ db: "x", role: "worker", inspect: () => new Map(), emit: () => { throw Error("full"); } }).update("cycle"));
});
test("status reevaluates phase deadline after all slow observations", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-activity-identity-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "new.sqlite"); writeFileSync(db, "synthetic database bytes");
  let now = clock;
  const event = phase({ database_key: activityDatabaseKey(db), valid_until: iso(clock + 1000) });
  const report = buildServiceStatusReport({ label: "synthetic", target: "test/synthetic", logDir: "unused", db }, {
    clock: () => now, runCommand: (cmd) => ({ status: 0, stdout: cmd === "launchctl" ? "state = running\npid = 8200\n" : JSON.stringify({ health: "ok", locks: [] }), stderr: "" }),
    readRecentWorkerEvents: () => ({ path: "synthetic", exists: true, events: [event] }),
    readLiveProbeCache: () => null, liveProbeContext: () => null, sqliteJson: () => [],
    inspectActivityProcesses: () => { now += 2000; return new Map([[8200, processState]]); },
  });
  assert.equal(report.overview.activity.state, "unknown");
  assert.doesNotMatch(JSON.stringify(report.worker), /instance_id|database_key|process_started_at_ms/);
});

test("hundreds of complete child instances and other databases do not exhaust current phase budget", () => {
  const history = Array.from({ length: 150 }, (_, n) => [phase({ role: "sync", instance_id: `child-${n}` }), phase({ role: "sync", instance_id: `child-${n}`, phase: "stopped" })]).flat();
  const other = Array.from({ length: 150 }, (_, n) => phase({ instance_id: `other-${n}`, database_key: "a".repeat(64) }));
  const selected = latestActivityEvents([...history, ...other, phase()], key, clock);
  assert.equal(selected.truncated, false); assert.deepEqual(selected.events, [phase()]);
  assert.equal(overview(selected.events).activity.state, "syncing");
  const malformedLatest = phase({ phase: "stopped", updated_at: "invalid" });
  assert.deepEqual(latestActivityEvents([phase(), malformedLatest]).events, [malformedLatest]);
});

test("zombies and suspended processes cannot supply live activity evidence", () => {
  for (const [stat, expected] of [["Z", "dead"], ["T", "unknown"]]) {
    const observed = inspectActivityProcesses([8200], () => ({ status: 0, stdout: `8200 8100 ${stat} Wed Apr 12 08:59:00 2028\n`, stderr: "" }));
    assert.equal(observed.get(8200).state, expected);
  }
});

test("sync CLI emits real stage observations without changing JSON stdout; help emits none", async () => {
  const { runLarkImSyncCli } = await import("../src/cli/lark-im-sync-command.mjs");
  const events = [];
  let stdout = "";
  let stderr = "";
  const io = { stdout: { write: (value) => { stdout += value; } }, stderr: { write: (value) => { stderr += value; } },
    deps: { activity: { instanceId: "synthetic", update: (name, fields) => events.push({ name, ...fields }) },
      resetTransportStats() {}, getTransportStats: () => ({ calls: 0 }), resolvePath: (path) => path,
      ensureInitialized() {}, ensureSourceInitialSyncStart: (_db, _source, value) => value,
      getSelfProfile: () => ({ open_id: "invented-self", name: "Invented Operator" }),
      syncRunner: { syncSent: () => ({ ok: true }), syncDiscovery: () => ({ ok: true }), syncReceived: () => [] },
    } };
  assert.equal(runLarkImSyncCli(["--scope", "all"], io), 0);
  assert.equal(JSON.parse(stdout).ok, true); assert.equal(stderr, "");
  assert.deepEqual(events.map((event) => [event.name, event.step || null]), [["sync", "all"], ["sync", "sent"], ["sync", "discover"], ["sync", "received"], ["stopped", null]]);
  assert.ok(events.slice(0, -1).every((event) => event.durationMs === 5000));
  events.length = 0;
  assert.equal(runLarkImSyncCli(["--help"], io), 0); assert.equal(events.length, 0);
  io.deps.syncRunner.syncSent = () => { throw Error("invented stage failure"); };
  assert.equal(runLarkImSyncCli(["--scope", "sent"], io), 1);
  assert.equal(events.at(-1).name, "stopped");
});

test("process inspection has one bounded call and omitted candidates remain unknown", () => {
  let count = 0;
  const locks = Array.from({ length: 50 }, (_, index) => ({ locked_by: `pid:${8200 + index}:started:${start}`, locked_at: iso(start + 2000) }));
  const rows = observeLockOwners(locks, (pids) => inspectActivityProcesses(pids, (_cmd, args, options) => {
    count++; assert.equal(args.at(-1).split(",").length, 32); assert.equal(options.timeout, 2000);
    return { status: 1, stdout: "", stderr: "" };
  }), () => clock);
  assert.equal(count, 1); assert.equal(rows[31].owner_state, "dead"); assert.equal(rows[32].owner_state, "unknown");
});

test("public lock projection exposes only safe optional process evidence", async () => {
  const { sanitizeStatusReportForPublicOutput } = await import("../src/diagnostics/sync-status-report.mjs");
  const report = sanitizeStatusReportForPublicOutput({ locks: [{ locked_at: iso(start), expires_at: iso(clock),
    locked_by: "pid:8200:started:invented", owner_state: "dead", owner_observed_at: iso(clock), private_path: "/invented/private" }] });
  assert.deepEqual(report.locks, [{ locked_at: iso(start), expires_at: iso(clock), owner_state: "dead", owner_observed_at: iso(clock) }]);
  assert.deepEqual(sanitizeStatusReportForPublicOutput(report).locks, report.locks);
});

test("running history, dead owners and expired reservations stay unverified across status, doctor and service", async () => {
  const { summarizeHealth } = await import("../src/diagnostics/sync-status-core.mjs");
  const { sanitizeStatusReportForPublicOutput } = await import("../src/diagnostics/sync-status-report.mjs");
  const { buildReport } = await import("../src/diagnostics/doctor-report.mjs");
  for (const locks of [[], [{ locked_at: iso(start), expires_at: iso(clock - 1), owner_state: "dead", owner_observed_at: iso(clock) }],
    [{ locked_at: iso(start), expires_at: iso(clock + 10000), owner_state: "alive", owner_observed_at: iso(clock) }]]) {
    const health = summarizeHealth({ discoveryCursor: { has_more: false }, scopeCounts: { message_enabled: 2 }, locks,
      runCounts: [{ status: "running", count: 1 }, { status: "succeeded", count: 2 }] });
    const status = sanitizeStatusReportForPublicOutput({ health, locks, scopes: { message_enabled: 2, message_without_success: 0 },
      discovery: { cursor: { has_more: false } }, runs: { by_status: { running: 1, succeeded: 2 } } });
    assert.equal(status.health, "unknown");
    assert.deepEqual(status.current_activity, { state: "unknown", evidence: "database_only", reason: "unverified_sync_history" });
    const doctor = buildReport({ db: "invented.sqlite", live: false }, { resolvePath: (path) => path,
      now: () => new Date(clock), runJson: (args) => args[0].includes("sync-status") ? status : { quality: {} } });
    assert.equal(doctor.overall, "unknown"); assert.equal(doctor.ok, false);
    assert.doesNotMatch(doctor.findings.join(" "), /currently syncing/);
    const unavailable = overview([], { syncStatus: status });
    assert.equal(unavailable.activity.state, "unknown"); assert.equal(unavailable.health.status, "problem");
    const observed = overview([phase()], { syncStatus: status });
    assert.equal(observed.activity.state, "syncing"); assert.equal(observed.health.status, "ok");
  }
});

test("a verified phase never hides missing successful scopes or failed-only history", () => {
  for (const [runs, scopes, detail] of [
    [{ succeeded: 1, running: 1 }, { message_enabled: 0 }, /successful message-scope/],
    [{ failed: 1, running: 1 }, { message_enabled: 2 }, /failures but no successful run/],
    [{ succeeded: 1, running: 1 }, { message_enabled: 2, message_without_success: 1 }, /successful message-scope/],
  ]) {
    const value = overview([phase()], { syncStatus: { health: "unknown", current_activity: { evidence: "database_only", reason: "unverified_sync_history" },
      runs: { by_status: runs }, scopes, discovery: { cursor: { has_more: false } } } });
    assert.equal(value.activity.state, "syncing"); assert.equal(value.health.status, "problem"); assert.match(value.health.detail, detail);
  }
});

test("malformed or future terminal phases remain unknown instead of hiding the instance", () => {
  for (const change of [{ updated_at: iso(clock + 1) }, { process_started_at_ms: null }, { valid_until: iso(clock - 2000) },
    { valid_until: iso(clock + 3600001) }, { updated_at: iso(start - 1) }]) {
    const bad = phase({ phase: "stopped", ...change });
    const selected = latestActivityEvents([phase(), bad], key, clock);
    assert.deepEqual(selected.events, [bad]);
    assert.equal(overview(selected.events, { launchd: { loaded: false } }).activity.state, "unknown");
  }
});

test("database identity distinguishes same-path replacement and normalizes symlinks without following mtime", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-activity-file-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "invented.sqlite"); const alias = join(dir, "alias.sqlite");
  writeFileSync(db, "synthetic generation one"); symlinkSync(db, alias);
  const original = activityDatabaseKey(db); const originalInode = statSync(db).ino;
  assert.match(original, /^[a-f0-9]{64}$/); assert.equal(activityDatabaseKey(alias), original);
  appendFileSync(db, "\nsynthetic ordinary write"); assert.equal(activityDatabaseKey(db), original);
  renameSync(db, join(dir, "old.sqlite")); writeFileSync(db, "synthetic generation two");
  assert.notEqual(statSync(db).ino, originalInode); assert.notEqual(activityDatabaseKey(db), original);
  assert.equal(activityDatabaseKey(alias), activityDatabaseKey(db));
  const oldPhase = phase({ database_key: original });
  assert.equal(overview([oldPhase], { evidence: { database_key: activityDatabaseKey(db) } }).activity.state, "unknown");
});

test("writers refresh file identity at actual phase transitions after initialization or replacement", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-activity-init-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "later.sqlite"); const events = [];
  const writer = createActivityWriter({ db, role: "worker", pid: 8200, now: () => clock, instanceId: "initializing",
    inspect: () => new Map([[8200, processState]]), emit: (event) => events.push(event) });
  assert.equal(activityDatabaseKey(db), null); assert.equal(activityDatabaseKey(dir), null);
  writer.update("cycle", { cycle: 1 }); assert.equal(events[0].database_key, null);
  assert.equal(evaluateActivityEvent(events[0], processState, null, clock).state, "unknown");
  writeFileSync(db, "synthetic initialized file"); writer.update("step", { cycle: 1, step: "sent" });
  const established = events.at(-1).database_key; assert.equal(established, activityDatabaseKey(db));
  assert.equal(evaluateActivityEvent(events.at(-1), processState, established, clock).state, "syncing");
  renameSync(db, join(dir, "previous.sqlite")); writeFileSync(db, "synthetic replacement");
  writer.update("between_steps", { cycle: 1 }); assert.notEqual(events.at(-1).database_key, established);
  rmSync(db); writer.update("step", { cycle: 1, step: "received-fair" }); assert.equal(events.at(-1).database_key, null);
});

for (const during of ["database query", "OS observation"]) test(`database replaced during ${during} makes the entire activity observation unknown`, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-activity-sampling-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "replace.sqlite"); writeFileSync(db, "synthetic first generation");
  const replace = () => { renameSync(db, join(dir, "previous.sqlite")); writeFileSync(db, "synthetic next generation"); };
  const report = buildServiceStatusReport({ label: "synthetic", target: "test/synthetic", logDir: dir, db }, {
    nowMs: clock, runCommand: (cmd) => {
      if (cmd === "launchctl") return { status: 0, stdout: "state = running\npid = 8200\n", stderr: "" };
      if (during === "database query") replace();
      return { status: 0, stdout: JSON.stringify({ health: "ok", locks: [] }), stderr: "" };
    },
    readRecentWorkerEvents: () => ({ path: "synthetic", exists: true, events: [phase({ database_key: activityDatabaseKey(db) })] }),
    readLiveProbeCache: () => null, liveProbeContext: () => null, sqliteJson: () => [],
    inspectActivityProcesses: () => { if (during === "OS observation") replace(); return new Map([[8200, processState]]); },
  });
  assert.equal(report.overview.activity.state, "unknown"); assert.match(report.overview.activity.detail, /file identity changed/);
});
