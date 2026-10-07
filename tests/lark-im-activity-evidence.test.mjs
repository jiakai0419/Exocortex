import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, renameSync, symlinkSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityDatabaseKey, createActivityWriter, evaluateActivityEvent, inspectActivityProcesses,
  latestActivityEvents, observeLockOwners, validateActivityEventShape, compareActivityProcessStarts, collectWorkerParentIdentities } from "../src/diagnostics/lark-im-activity-evidence.mjs";
import { buildServiceOverview, buildServiceStatusReport, readRecentWorkerEvents } from "../src/diagnostics/lark-im-service-report.mjs";
import { runWorker, parseArgs } from "../src/runtime/worker/worker.mjs";

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
    clock: () => now, runCommand: () => ({ status: 0, stdout: "state = running\npid = 8200\n", stderr: "" }), buildStatus: () => ({ health: "ok", locks: [] }),
    readRecentWorkerEvents: () => ({ path: "synthetic", exists: true, events: [event] }),
    readLiveProbeCache: () => null, liveProbeContext: () => null, sqliteJson: () => [],
    inspectActivityProcesses: () => { now += 2000; return new Map([[8200, processState]]); },
  });
  assert.equal(report.overview.activity.state, "unknown");
  assert.doesNotMatch(JSON.stringify(report.worker), /instance_id|database_key|process_started_at_ms/);
});

test("hundreds of complete child instances and other databases do not exhaust current phase budget", () => {
  const history = Array.from({ length: 150 }, (_, n) => [phase({ role: "sync", phase: "sync", instance_id: `child-${n}` }), phase({ role: "sync", instance_id: `child-${n}`, phase: "stopped" })]).flat();
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
  const { runLarkImSyncCli } = await import("./helpers/sync-command.mjs");
  const events = [];
  let stdout = "";
  let stderr = "";
  const io = { stdout: { write: (value) => { stdout += value; } }, stderr: { write: (value) => { stderr += value; } },
    deps: { activity: { instanceId: "synthetic", update: (name, fields) => events.push({ name, ...fields }) },
      resetTransportStats() {}, getTransportStats: () => ({ calls: 0 }), resolvePath: (path) => path,
      ensureInitialized() {}, ensureSourceInitialSyncStart: (_db, _source, value) => value,
      readRemoteAccountBinding: () => ({ state: "unverified", reason: "account_database_unbound" }),
      reserveSyncAccountBinding: () => false,
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
  const { isLocalReady } = await import("../src/diagnostics/service-wait-state.mjs");
  for (const locks of [[], [{ locked_at: iso(start), expires_at: iso(clock - 1), owner_state: "dead", owner_observed_at: iso(clock) }],
    [{ locked_at: iso(start), expires_at: iso(clock + 10000), owner_state: "alive", owner_observed_at: iso(clock) }]]) {
    const health = summarizeHealth({ discoveryCursor: { has_more: false }, scopeCounts: { message_enabled: 2 }, locks,
      runCounts: [{ status: "running", count: 1 }, { status: "succeeded", count: 2 }] });
    const status = sanitizeStatusReportForPublicOutput({ health, locks, scopes: { message_enabled: 2, message_without_success: 0 },
      discovery: { cursor: { has_more: false } }, runs: { by_status: { running: 1, succeeded: 2 } } });
    assert.equal(status.health, "unknown");
    assert.deepEqual(status.current_activity, { state: "unknown", evidence: "database_only", reason: "unverified_sync_history" });
    assert.equal(isLocalReady(status), false);
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
    nowMs: clock, runCommand: () => ({ status: 0, stdout: "state = running\npid = 8200\n", stderr: "" }),
    buildStatus: () => { if (during === "database query") replace(); return { health: "ok", locks: [] }; },
    readRecentWorkerEvents: () => ({ path: "synthetic", exists: true, events: [phase({ database_key: activityDatabaseKey(db) })] }),
    readLiveProbeCache: () => null, liveProbeContext: () => null, sqliteJson: () => [],
    inspectActivityProcesses: () => { if (during === "OS observation") replace(); return new Map([[8200, processState]]); },
  });
  assert.equal(report.overview.activity.state, "unknown"); assert.match(report.overview.activity.detail, /file identity changed/);
});

function logBackedActivity(t, inputEvents, processes, launchdPid = 8200) {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-activity-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "invented.sqlite"); writeFileSync(db, "synthetic database identity only");
  const events = inputEvents.map((event) => event.database_key === key
    ? { ...event, database_key: activityDatabaseKey(db) } : event);
  writeFileSync(join(dir, "worker.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const deps = { nowMs: clock,
    runCommand: () => ({ status: 0, stdout: launchdPid === null ? "state = waiting\n" : `state = running\npid = ${launchdPid}\n`, stderr: "" }),
    buildStatus: () => ({ health: "ok", locks: [] }),
    readLiveProbeCache: () => null, liveProbeContext: () => null, sqliteJson: () => [],
    inspectActivityProcesses: () => processes,
  };
  return { dir, db, deps, report: () => buildServiceStatusReport({ label: "synthetic", target: "test/synthetic", logDir: dir, db }, deps) };
}

test("review regression: a syntactically valid but incomplete activity tail cannot fall back to an older phase", (t) => {
  const fixture = logBackedActivity(t, [phase(), { type: "lark_im_worker_activity", pid: 8200 }], new Map([[8200, processState]]));
  assert.equal(readRecentWorkerEvents(fixture.dir).activity_integrity, false);
  assert.equal(fixture.report().overview.activity.state, "unknown");
});

test("review regression: an unrelated orphan cannot suppress verified independent foreground activity through service CLI", async (t) => {
  const { runStatusCommand } = await import("../src/cli/status-command.mjs");
  const { plain } = await import("../dist/terminal/index.js");
  const fixture = logBackedActivity(t, [
    phase({ phase: "waiting" }),
    phase({ pid: 8300, instance_id: "old-worker" }),
    phase({ role: "sync", phase: "sync", pid: 8301, instance_id: "orphan", parent_instance: "old-worker" }),
    phase({ role: "sync", phase: "sync", pid: 8400, instance_id: "independent", parent_instance: null }),
  ], new Map([[8200, processState], [8300, { state: "dead" }], [8301, { ...processState, ppid: 1 }], [8400, { ...processState, ppid: 8100 }]]));
  assert.equal(fixture.report().overview.activity.state, "syncing");
  let output = "";
  assert.equal(await runStatusCommand({ db: fixture.db, logDir: fixture.dir }, { now: () => clock, provided: new Set(), root: fixture.dir, cwd: fixture.dir, env: {}, stdout: { write: (text) => { output += text; } } }, {
    readInstalledServiceConfig: () => ({ status: "missing" }),
    uid: () => 999, stdout: { write: (text) => { output += text; } },
    buildServiceStatusReport: (opts) => buildServiceStatusReport(opts, fixture.deps),
  }), 0);
  assert.match(plain(output), /Current work\s+Syncing · foreground command/);
});

test("all activity consumers reject missing required fields and malformed types without old-phase fallback", async (t) => {
  const { runStatusCommand } = await import("../src/cli/status-command.mjs");
  const { plain } = await import("../dist/terminal/index.js");
  const malformed = Object.keys(phase()).map((field) => {
    const event = phase(); delete event[field]; return [field, event];
  });
  malformed.push(...Object.entries({ version: "1", role: "unexpected", instance_id: 12, parent_instance: {}, pid: "8200",
    process_started_at_ms: "1839142740000", database_key: false, phase: "unexpected", cycle: "4", step: [], updated_at: 1,
    valid_until: null }).map(([field, value]) => [field, phase({ [field]: value })]));
  malformed.push(["role/phase", phase({ role: "sync", phase: "waiting" })]);
  for (const [label, bad] of malformed) {
    assert.equal(validateActivityEventShape(bad), false, label);
    assert.equal(evaluateActivityEvent(bad, processState, key, clock).state, "unknown", label);
    const fixture = logBackedActivity(t, [phase(), bad], new Map([[8200, processState]]));
    assert.equal(readRecentWorkerEvents(fixture.dir).activity_integrity, false, label);
    assert.equal(fixture.report().overview.activity.state, "unknown", label);
    if (bad.type === "lark_im_worker_activity") assert.equal(latestActivityEvents([phase(), bad], key, clock).integrity, false, label);
  }
  const fixture = logBackedActivity(t, [phase(), { type: "lark_im_worker_activity", pid: 8200 }], new Map([[8200, processState]]));
  let output = "";
  await runStatusCommand({ db: fixture.db, logDir: fixture.dir }, { now: () => clock, provided: new Set(), root: fixture.dir, cwd: fixture.dir, env: {}, stdout: { write: (text) => { output += text; } } }, {
    readInstalledServiceConfig: () => ({ status: "missing" }),
    uid: () => 999, stdout: { write: (text) => { output += text; } },
    buildServiceStatusReport: (opts) => buildServiceStatusReport(opts, fixture.deps),
  });
  assert.match(plain(output), /Current work\s+Unconfirmed · current activity records are incomplete/);
});

test("explicit unknown identity is valid schema, blocks its old phase, and does not poison later real evidence", (t) => {
  for (const field of ["process_started_at_ms", "database_key"]) {
    const unavailable = phase({ [field]: null });
    assert.equal(validateActivityEventShape(unavailable), true);
    const before = logBackedActivity(t, [phase(), unavailable], new Map([[8200, processState]]));
    // Keep explicit null database evidence; the fixture binds only string keys below.
    assert.equal(readRecentWorkerEvents(before.dir).activity_integrity, true);
    assert.equal(before.report().overview.activity.state, "unknown");
    const after = logBackedActivity(t, [unavailable, phase()], new Map([[8200, processState]]));
    assert.equal(readRecentWorkerEvents(after.dir).activity_integrity, true);
    assert.equal(after.report().overview.activity.state, "syncing");
  }
});

for (const expiredOrphan of [false, true]) {
  for (const reversed of [false, true]) test(`independent foreground wins over ${expiredOrphan ? "expired" : "fresh"} orphan in ${reversed ? "reverse" : "forward"} append order`, (t) => {
    const orphan = phase({ role: "sync", phase: "sync", pid: 8301, instance_id: "orphan", parent_instance: "old-worker",
      ...(expiredOrphan ? { valid_until: iso(clock) } : {}) });
    const independent = phase({ role: "sync", phase: "sync", pid: 8400, instance_id: "independent", parent_instance: null });
    const events = [phase({ phase: "waiting" }), phase({ pid: 8300, instance_id: "old-worker" }),
      ...(reversed ? [independent, orphan] : [orphan, independent])];
    const processes = new Map([[8200, processState], [8300, { state: "dead" }], [8301, { ...processState, ppid: 1 }], [8400, { ...processState, ppid: 8100 }]]);
    assert.equal(logBackedActivity(t, events, processes).report().overview.activity.state, "syncing");
    assert.equal(logBackedActivity(t, events.filter((event) => event !== independent), processes).report().overview.activity.state, "unknown");
  });
}

for (const parent of ["invented-instance", "different-instance", null]) test(`independent foreground proves activity despite current worker child binding ${String(parent)}`, (t) => {
  const child = phase({ role: "sync", phase: "sync", pid: 8301, instance_id: "child", parent_instance: parent });
  const independent = phase({ role: "sync", phase: "sync", pid: 8400, instance_id: "independent", parent_instance: null });
  const processes = new Map([[8200, processState], [8301, { ...processState, ppid: 8200 }], [8400, { ...processState, ppid: 8100 }]]);
  assert.equal(logBackedActivity(t, [phase({ phase: "waiting" }), child, independent], processes).report().overview.activity.state, "syncing");
  assert.equal(logBackedActivity(t, [phase({ phase: "waiting" }), child], processes).report().overview.activity.state, "unknown");
});

test("a reused historical worker PID is not a current parent classification", (t) => {
  const worker = phase({ pid: 8300, instance_id: "old-worker" });
  const independent = phase({ role: "sync", phase: "sync", pid: 8400, instance_id: "independent", parent_instance: null });
  const processes = new Map([[8200, processState], [8300, { ...processState, started_at_ms: start + 1000 }], [8400, { ...processState, ppid: 8300 }]]);
  assert.equal(logBackedActivity(t, [phase({ phase: "waiting" }), worker, independent], processes).report().overview.activity.state, "syncing");
  const declaredChild = { ...independent, parent_instance: "old-worker" };
  assert.equal(logBackedActivity(t, [phase({ phase: "waiting" }), worker, declaredChild], processes).report().overview.activity.state, "unknown");
});

test("missing worker phase cannot turn a process with the current worker PPID into independent foreground", (t) => {
  const child = phase({ role: "sync", phase: "sync", pid: 8301, instance_id: "child", parent_instance: null });
  const processes = new Map([[8200, processState], [8301, { ...processState, ppid: 8200 }]]);
  assert.equal(logBackedActivity(t, [child], processes).report().overview.activity.state, "unknown");
});


test("stopped service with an old dead worker and living orphan still admits independent foreground evidence", (t) => {
  const orphan = phase({ role: "sync", phase: "sync", pid: 8501, instance_id: "invented-orphan", parent_instance: "invented-dead-worker" });
  const foreground = phase({ role: "sync", phase: "sync", pid: 8600, instance_id: "invented-foreground", parent_instance: null });
  const events = [phase({ pid: 8500, instance_id: "invented-dead-worker" }), orphan, foreground];
  const processes = new Map([[8500, { state: "dead" }], [8501, { ...processState, ppid: 1 }], [8600, { ...processState, ppid: 8100 }]]);
  const report = logBackedActivity(t, events, processes, null).report();
  assert.equal(report.overview.service.status, "stopped");
  assert.equal(report.overview.activity.state, "syncing");
  assert.equal(report.overview.activity.evidence, "recent_foreground_phase");
  assert.equal(logBackedActivity(t, events.filter((event) => event !== foreground), processes, null).report().overview.activity.state, "unknown");
});

test("4531143 regression: a suspended parent with matching start cannot turn its unbound child into independent foreground", async (t) => {
  const processes = inspectActivityProcesses([8500, 8501], () => ({ status: 0, stderr: "",
    stdout: `8500 8100 T ${new Date(start).toString()}\n8501 8500 S ${new Date(start).toString()}\n` }));
  assert.equal(processes.get(8500).state, "unknown"); assert.equal(processes.get(8500).started_at_ms, start);
  const events = [phase({ pid: 8500, instance_id: "suspended-worker" }),
    phase({ role: "sync", phase: "sync", pid: 8501, instance_id: "unbound-child", parent_instance: null })];
  const fixture = logBackedActivity(t, events, processes, null);
  assert.equal(fixture.report().overview.activity.state, "unknown");
  const { runStatusCommand } = await import("../src/cli/status-command.mjs");
  const { plain } = await import("../dist/terminal/index.js");
  let output = "";
  await runStatusCommand({ db: fixture.db, logDir: fixture.dir }, { now: () => clock, provided: new Set(), root: fixture.dir, cwd: fixture.dir, env: {}, stdout: { write: (text) => { output += text; } } }, {
    readInstalledServiceConfig: () => ({ status: "missing" }),
    uid: () => 999, stdout: { write: (text) => { output += text; } },
    buildServiceStatusReport: (opts) => buildServiceStatusReport(opts, fixture.deps),
  });
  assert.match(plain(output), /Current work\s+Unconfirmed/); assert.doesNotMatch(plain(output), /foreground sync observed/);
});

test("parent identity and liveness stay separate across 81 log/report/CLI combinations", async (t) => {
  const { runStatusCommand } = await import("../src/cli/status-command.mjs");
  const { plain } = await import("../dist/terminal/index.js");
  let checked = 0;
  for (const liveness of ["alive", "unknown", "dead"]) {
    for (const [identity, observedStart] of [["same", start], ["different", start + 1000], ["missing", null]]) {
      for (const parent of [null, "matrix-worker", "different-worker"]) {
        for (const service of ["running", "stopped", "unknown"]) {
          const label = [liveness, identity, String(parent), service].join(" / ");
          const events = [phase({ pid: 8500, instance_id: "matrix-worker", phase: "waiting" }),
            phase({ role: "sync", phase: "sync", pid: 8501, instance_id: "matrix-child", parent_instance: parent })];
          const processes = new Map([[8500, { state: liveness, started_at_ms: observedStart, ppid: 8100 }], [8501, { ...processState, ppid: 8500 }]]);
          const fixture = logBackedActivity(t, events, processes, service === "stopped" ? null : 8200);
          if (service === "unknown") {
            const original = fixture.deps.runCommand;
            fixture.deps.runCommand = (cmd) => cmd === "launchctl" ? { status: 1, stdout: "", stderr: "synthetic inspection unavailable" } : original(cmd);
          }
          const expected = parent === null && identity === "different" ? "syncing" : "unknown";
          assert.equal(readRecentWorkerEvents(fixture.dir).activity_integrity, true, label);
          const report = fixture.report();
          assert.equal(report.overview.service.status, service, label);
          assert.equal(report.overview.activity.state, expected, label);
          assert.equal(report.overview.activity.evidence === "recent_foreground_phase", expected === "syncing", label);
          let output = "";
          await runStatusCommand({ db: fixture.db, logDir: fixture.dir }, { now: () => clock, provided: new Set(), root: fixture.dir, cwd: fixture.dir, env: {}, stdout: { write: (text) => { output += text; } } }, {
    readInstalledServiceConfig: () => ({ status: "missing" }),
            uid: () => 999, stdout: { write: (text) => { output += text; } },
            buildServiceStatusReport: (opts) => buildServiceStatusReport(opts, fixture.deps),
          });
          assert.match(plain(output), new RegExp(`Current work\\s+${expected === "unknown" ? "Unconfirmed" : expected === "syncing" ? "Syncing" : expected === "waiting" ? "Waiting" : "Stopped"}`), label);
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 81);
});

test("phase evaluation never turns unavailable start identity into proof of a dead or reused process", () => {
  for (const liveness of ["alive", "unknown", "dead"]) {
    for (const observedStart of [start, start + 1000, null]) {
      const identity = compareActivityProcessStarts(start, observedStart);
      assert.equal(identity, observedStart === null ? "unknown" : observedStart === start ? "same" : "different");
      const evaluated = evaluateActivityEvent(phase(), { state: liveness, started_at_ms: observedStart }, key, clock);
      const expected = liveness === "dead" || identity === "different" ? "dead"
        : liveness === "alive" && identity === "same" ? "syncing" : "unknown";
      assert.equal(evaluated.state, expected, `${liveness}/${identity}`);
    }
    assert.equal(compareActivityProcessStarts(null, start), "unknown");
    assert.equal(evaluateActivityEvent(phase({ process_started_at_ms: null }), { state: liveness, started_at_ms: start }, key, clock).state,
      liveness === "dead" ? "dead" : "unknown");
  }
  for (const invalid of [undefined, "123", 0, NaN]) assert.equal(compareActivityProcessStarts(start, invalid), "unknown");
});

test("stopped parent identity survives selection without consuming active-process budget", (t) => {
  for (const observedStart of [start, start + 1000, null]) {
    for (const liveness of ["alive", "unknown", "dead"]) {
      const events = [phase({ pid: 8500, instance_id: "terminal-worker", phase: "stopped" }),
        phase({ role: "sync", phase: "sync", pid: 8501, instance_id: "terminal-child", parent_instance: null })];
      const processes = new Map([[8500, { state: liveness, started_at_ms: observedStart }], [8501, { ...processState, ppid: 8500 }]]);
      assert.equal(latestActivityEvents(events, key, clock).events.length, 1);
      assert.equal(logBackedActivity(t, events, processes, null).report().overview.activity.state, observedStart === start + 1000 ? "syncing" : "unknown");
    }
  }
  const history = Array.from({ length: 150 }, (_, n) => phase({ pid: 9000 + n, instance_id: `complete-worker-${n}`, phase: "stopped" }));
  const events = [...history, phase({ pid: 8500, instance_id: "relevant-terminal", phase: "stopped" }),
    phase({ role: "sync", phase: "sync", pid: 8501, instance_id: "terminal-child", parent_instance: null })];
  const fixture = logBackedActivity(t, events, new Map(), null);
  let calls = 0;
  fixture.deps.inspectActivityProcesses = (pids) => {
    calls++; assert.deepEqual(pids, [8501]);
    return new Map([[8501, { ...processState, ppid: 8500 }]]);
  };
  assert.equal(fixture.report().overview.activity.state, "unknown"); assert.equal(calls, 1);
  const parentRoles = collectWorkerParentIdentities(events, [8500]);
  assert.deepEqual([...parentRoles], [[8500, new Set([start])]]);
});

test("unobserved or unavailable parents cannot lose association because their phase is old, future, or bound elsewhere", (t) => {
  for (const changes of [
    { phase: "stopped", database_key: "c".repeat(64) }, { database_key: "c".repeat(64) },
    { valid_until: iso(clock) }, { updated_at: iso(clock + 1) },
    { updated_at: iso(start + 100) }, { process_started_at_ms: null },
  ]) {
    const events = [phase({ pid: 8500, instance_id: "uncertain-parent", ...changes }),
      phase({ role: "sync", phase: "sync", pid: 8501, instance_id: "uncertain-child", parent_instance: null })];
    const fixture = logBackedActivity(t, events, new Map([[8501, { ...processState, ppid: 8500 }]]), null);
    assert.equal(fixture.report().overview.activity.state, "unknown");
    const realForeground = phase({ role: "sync", phase: "sync", pid: 8600, instance_id: "independent", parent_instance: null });
    const independent = logBackedActivity(t, [...events, realForeground], new Map([[8501, { ...processState, ppid: 8500 }], [8600, processState]]), null);
    assert.equal(independent.report().overview.activity.state, "syncing");
    assert.equal(independent.report().overview.activity.evidence, "recent_foreground_phase");
  }
});

test("matching PPID aggregation keeps every unrefuted instance and only replaces older evidence within that instance", (t) => {
  const same = phase({ pid: 8500, instance_id: "same-parent", phase: "stopped" });
  const different = phase({ pid: 8500, instance_id: "different-parent", phase: "stopped", process_started_at_ms: start - 1000 });
  const unavailable = phase({ pid: 8500, instance_id: "unknown-parent", phase: "stopped", process_started_at_ms: null });
  const child = phase({ role: "sync", phase: "sync", pid: 8501, instance_id: "child", parent_instance: null });
  const processes = new Map([[8500, processState], [8501, { ...processState, ppid: 8500 }]]);
  const anotherDifferent = { ...different, instance_id: "another-different", process_started_at_ms: start - 2000 };
  const updatedSameInstance = { ...different, instance_id: same.instance_id };
  for (const [parents, expected] of [
    [[same, different], "unknown"], [[different, same], "unknown"], [[unavailable, different], "unknown"],
    [[different, unavailable], "unknown"], [[different, anotherDifferent], "syncing"],
    [[same, updatedSameInstance], "syncing"],
  ]) {
    assert.equal(logBackedActivity(t, [...parents, child], processes, null).report().overview.activity.state, expected);
    assert.equal(logBackedActivity(t, [...parents, { ...child, parent_instance: "explicit-parent" }], processes, null).report().overview.activity.state, "unknown");
  }
});
