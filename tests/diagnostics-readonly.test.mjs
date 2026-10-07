import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { ensureInitialized } from "../dist/storage/sqlite/ingestion-store.js";
import { readOnlySqliteJson } from "../src/storage/sqlite/readonly-query.mjs";
import { buildStatus } from "../src/diagnostics/sync-status-report.mjs";
import { collectQualityReport } from "../src/diagnostics/lark-im-quality-report.mjs";
import { loadMessages } from "../src/diagnostics/messages-report.mjs";
import { collectRemoteSample } from "../src/diagnostics/remote-sample.mjs";
import { buildServiceStatusReport } from "../src/diagnostics/lark-im-service-report.mjs";
import { collectCheckReport } from "../src/diagnostics/check-report.mjs";
import { createCommandContext } from "../src/cli/context.mjs";
import { executeSyncRepair } from "../src/maintenance/repair.mjs";
import { parseRouteOptions } from "../src/cli/registry.mjs";
import { startOwnedProcess, waitUntil } from "./helpers/owned-process.mjs";

function fixture(t, journalMode = "DELETE", evidence = {}) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-readonly-"));
  t.after(() => { if (!evidence.preserve) rmSync(dir, { recursive: true, force: true }); });
  const db = join(dir, "test.sqlite");
  ensureInitialized(db);
  const journal = spawnSync("sqlite3", [db, `PRAGMA journal_mode=${journalMode};`], { encoding: "utf8" });
  assert.equal(journal.status, 0, journal.stderr);
  assert.equal(journal.stdout.trim(), journalMode.toLowerCase());
  return { dir, db };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sidecar(path, hashBytes) {
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  assert.equal(info.isFile(), true, `${basename(path)} must be a regular file`);
  return { mode: info.mode & 0o777, size: info.size,
    ...(hashBytes ? { sha256: sha256(readFileSync(path)) } : {}) };
}

function snapshot(dir, db) {
  return { sha256: sha256(readFileSync(db)), dbMode: statSync(db).mode & 0o777,
    dirMode: statSync(dir).mode & 0o777, files: readdirSync(dir).sort(),
    wal: sidecar(`${db}-wal`, true), shm: sidecar(`${db}-shm`, false) };
}

function businessSnapshot(db) {
  // The dump includes schema and every synthetic business row, including stale
  // locks/runs. Hash it so assertion failures never expand an entire database.
  const result = spawnSync("sqlite3", ["-readonly", db, ".dump"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return sha256(result.stdout);
}

function assertWalUnchanged(before, after, db) {
  const coordinationNames = new Set([`${basename(db)}-wal`, `${basename(db)}-shm`]);
  assert.deepEqual(after.files.filter((name) => !coordinationNames.has(name)),
    before.files.filter((name) => !coordinationNames.has(name)), "unexpected directory change");
  for (const field of ["sha256", "dbMode", "dirMode"]) assert.equal(after[field], before[field], field);
  // Existing WAL contains committed evidence; a reader must not alter it.
  if (before.wal) assert.deepEqual(after.wal, before.wal);
  else if (after.wal) assert.equal(after.wal.size, 0, "a reader-created WAL must contain no frames");
  if (before.shm) {
    assert.ok(after.shm, "an active writer's SHM must remain available");
    assert.equal(after.shm.mode, before.shm.mode);
  }
  if (after.shm) {
    assert.ok(after.shm.size > 0 && after.shm.size % 32768 === 0,
      "SHM must contain complete SQLite WAL-index pages");
  }
  // SHM bytes are reader coordination, not business data. New coordination
  // files may exist on some SQLite builds, but cannot widen database access.
  for (const value of [after.wal, after.shm].filter(Boolean)) {
    assert.equal(value.mode & ~before.dbMode, 0, "sidecar permissions exceed database permissions");
  }
}

function seedStaleState(db) {
  const seed = spawnSync("sqlite3", [db], { encoding: "utf8", input: `
    INSERT INTO sync_runs(scope_id, source_id, status, started_at, metadata_json)
      VALUES('lark.im.sent_by_me', 'lark.im', 'running', '2000-01-01T00:00:00.000Z', '{}');
    INSERT INTO sync_locks(scope_id, locked_by, locked_at, expires_at)
      VALUES('lark.im.sent_by_me', 'synthetic-dead-owner', '2000-01-01T00:00:00.000Z', '2000-01-01T00:01:00.000Z');
  ` });
  assert.equal(seed.status, 0, seed.stderr);
}

async function exerciseDiagnostics(dir, db) {
  const status = buildStatus(db);
  assert.equal(status.health, "unknown");
  assert.equal(status.current_activity.reason, "unverified_sync_history");
  collectQualityReport(db);
  assert.deepEqual(loadMessages(db, { db, direction: "all", limit: 2, search: "" }), []);
  const at = Date.parse("2030-01-03T12:00:00Z");
  const sample = collectRemoteSample(db, {}, { now: () => at,
    api: { deadline: at + 55000, count: () => 0, call: () => assert.fail("empty inventory must not call remote API") },
  });
  assert.equal(sample.report.status, "inconclusive");
  assert.equal(sample.report.reason, "no_eligible_chats");
  const report = await collectCheckReport({ db, live: false, logDir: dir }, createCommandContext({
    root: dir, cwd: dir, now: () => Date.parse("2030-01-03T12:00:00Z"),
  }), {
    collectRemoteSample: () => { throw new Error("default check must not read remote data"); },
    collectStatusEvidence: () => { throw new Error("default check must not inspect or change service state"); },
    runManualRemoteSample: () => { throw new Error("default check must not write a cache"); },
  });
  assert.equal(report.checks.sync.status, "incomplete");
  assert.equal(report.checks.sync.evidence.health, "unknown");
  assert.equal(report.checks.database.status, "passed");
  assert.equal(report.checks.quality.status, "passed");
  assert.equal(report.exit_code, 2);
  assert.equal(report.ok, false);
  buildServiceStatusReport({ db, label: "test", target: "test", logDir: dir }, {
    runCommand: (cmd, args) => {
      assert.equal(cmd, "launchctl");
      assert.deepEqual(args, ["print", "test"]);
      return { status: 1, stdout: "", stderr: "", signal: null };
    },
  });
  assert.equal(executeSyncRepair({ db, apply: false }).preview.expired_locks, 1);
}

function assertWritesRejected(db) {
  assert.throws(() => readOnlySqliteJson(db, "CREATE TABLE forbidden(value TEXT);", "test"), /failed/);
  assert.throws(() => readOnlySqliteJson(db, "DELETE FROM sync_scopes;", "test"), /failed/);
}

test("rollback-journal diagnostics preserve business data, database bytes, permissions and exact file layout", async (t) => {
  const { dir, db } = fixture(t);
  seedStaleState(db);
  chmodSync(dir, 0o755);
  chmodSync(db, 0o644);
  const businessBefore = businessSnapshot(db);
  const before = snapshot(dir, db);
  await exerciseDiagnostics(dir, db);
  assert.equal(businessSnapshot(db), businessBefore);
  assert.deepEqual(snapshot(dir, db), before);
});

test("missing databases and missing tables remain untouched; SQLite rejects DML and DDL", async (t) => {
  const { dir, db } = fixture(t);
  const missing = join(dir, "absent", "missing.sqlite");
  assert.throws(() => readOnlySqliteJson(missing, "SELECT 1;", "test"), /failed/);
  assert.throws(() => executeSyncRepair({ db: missing, apply: false }), /failed/);
  const missingReport = await collectCheckReport({ db: missing }, createCommandContext({ root: dir, cwd: dir }));
  assert.equal(missingReport.exit_code, 1);
  for (const key of ["database", "sync", "quality"]) assert.equal(missingReport.checks[key].status, "unavailable");
  assert.equal(existsSync(join(dir, "absent")), false);
  const empty = join(dir, "empty.sqlite");
  writeFileSync(empty, "");
  assert.throws(() => buildStatus(empty), /failed/);
  const emptyReport = await collectCheckReport({ db: empty }, createCommandContext({ root: dir, cwd: dir }));
  assert.equal(emptyReport.exit_code, 1);
  assert.equal(emptyReport.checks.sync.status, "unavailable");
  assert.equal(statSync(empty).size, 0);
  const businessBefore = businessSnapshot(db);
  const before = snapshot(dir, db);
  assertWritesRejected(db);
  assert.equal(businessSnapshot(db), businessBefore);
  assert.deepEqual(snapshot(dir, db), before);
});

test("WAL-header diagnostics stay read-only with missing coordination files", async (t) => {
  const { dir, db } = fixture(t);
  seedStaleState(db);
  const businessBefore = businessSnapshot(db);
  // Build all rows in rollback mode, then set the WAL header without writing
  // any WAL frames. The observed read-only phase starts without sidecars.
  const journal = spawnSync("sqlite3", [db, "PRAGMA journal_mode=WAL;"], { encoding: "utf8" });
  assert.equal(journal.status, 0, journal.stderr);
  assert.equal(journal.stdout.trim(), "wal");
  // Every setup connection has closed. Some SQLite builds retain empty
  // coordination files; remove only these synthetic files, never WAL frames.
  if (existsSync(`${db}-wal`)) assert.equal(statSync(`${db}-wal`).size, 0);
  rmSync(`${db}-wal`, { force: true });
  rmSync(`${db}-shm`, { force: true });
  chmodSync(dir, 0o755);
  chmodSync(db, 0o644);
  const before = snapshot(dir, db);
  assert.deepEqual(before.files, [basename(db)]);
  try {
    await exerciseDiagnostics(dir, db);
  } catch (error) {
    // Some SQLite builds cannot open WAL databases read-only without existing
    // sidecars. Confirm that exact engine limitation independently, and require
    // the application to fail closed without changing any files in that case.
    assert.equal(error.message, "read detail progress schema failed");
    const probe = spawnSync("sqlite3", ["-readonly", db, "SELECT COUNT(*) FROM sqlite_schema;"], { encoding: "utf8" });
    assert.equal(probe.error, undefined);
    assert.equal(probe.signal, null);
    assert.notEqual(probe.status, 0);
    assert.match(probe.stderr, /unable to open database file \(14\)/);
    assertWritesRejected(db);
    assert.deepEqual(snapshot(dir, db), before);
    t.diagnostic("SQLite cannot open WAL without sidecars read-only; verified fail-closed behavior");
    return;
  }
  assertWritesRejected(db);
  assert.equal(businessSnapshot(db), businessBefore);
  assertWalUnchanged(before, snapshot(dir, db), db);
});

test("WAL diagnostics see committed frames and preserve existing WAL and business evidence", { timeout: 30_000 }, async (t) => {
  const deadline = performance.now() + 25_000;
  const evidence = { preserve: true };
  const { dir, db } = fixture(t, "WAL", evidence);
  seedStaleState(db);
  chmodSync(dir, 0o755);
  chmodSync(db, 0o644);
  const markerQuery = "SELECT json_extract(config_json, '$.synthetic_wal_evidence') AS value FROM sources WHERE id='lark.im';";
  assert.deepEqual(readOnlySqliteJson(db, markerQuery, "read initial synthetic marker"), [{ value: null }]);
  const mainBeforeWriter = sha256(readFileSync(db));
  const readyPath = join(dir, "writer-ready"), releasePath = join(dir, "writer-release");
  const owner = startOwnedProcess("python3", ["-u", "-c", `
import os, sqlite3, sys, time
con = sqlite3.connect(sys.argv[1])
con.execute('PRAGMA wal_autocheckpoint=0')
con.execute("UPDATE sources SET config_json=json_set(config_json, '$.synthetic_wal_evidence', 1) WHERE id='lark.im'")
con.commit()
with open(sys.argv[2], 'x') as marker: marker.write('ready')
# This synthetic fallback is later than the entire acceptance deadline.
# The only signal owner is the Node helper; the fixture never self-signals.
fallback = time.monotonic() + 35
while not os.path.exists(sys.argv[3]):
    if time.monotonic() >= fallback:
        con.close()
        sys.exit(98)
    time.sleep(0.01)
con.close()
`, db, readyPath, releasePath], { deadline, cwd: dir });
  let failure = null;
  try {
    await waitUntil(() => existsSync(readyPath), Math.min(deadline, performance.now() + 10_000), "synthetic_wal_writer_ready");
    const before = snapshot(dir, db);
    assert.ok(before.wal?.size > 0, "fixture must have committed WAL frames");
    assert.equal(before.sha256, mainBeforeWriter, "synthetic marker must exist only in uncheckpointed WAL frames");
    const businessBefore = businessSnapshot(db);
    assert.deepEqual(readOnlySqliteJson(db, markerQuery, "read synthetic WAL marker"), [{ value: 1 }]);
    await exerciseDiagnostics(dir, db);
    assertWritesRejected(db);
    assert.equal(businessSnapshot(db), businessBefore);
    assertWalUnchanged(before, snapshot(dir, db), db);
  } catch (error) { failure = error; }
  try { writeFileSync(releasePath, "release", { mode: 0o600, flag: "wx" }); }
  catch (error) { failure ||= error; }
  if (failure) owner.stop("synthetic_wal_diagnostics_failed");
  const result = await owner.result;
  try {
    assert.equal(result.failure, null, `synthetic writer failed: ${result.failure}`);
    assert.equal(result.signalError, null, "signal refusal must fail without retry");
    assert.equal(result.signalAttempted, false, "successful diagnostics require natural writer closure");
    assert.equal(result.signal, null);
    assert.equal(result.code, 0, result.stderr.toString());
    assert.ok(performance.now() < deadline, "fallback closure cannot make the test pass");
  } catch (error) { failure ||= error; }
  if (failure) {
    t.diagnostic(`Synthetic WAL evidence retained: ${dir}; no signal retry or alternate target was used.`);
    throw failure;
  }
  evidence.preserve = false;
});

test("repair only calls recovery after an explicit apply flag", () => {
  const deps = {
    sqliteJson: () => [{ locks: 2, expired_locks: 1, running_runs: 2 }],
    recoverStaleSyncState: () => { throw new Error("mutation forbidden"); },
  };
  assert.equal(parseRouteOptions("maintenance.repair", []).options.apply, false);
  const preview = executeSyncRepair({ db: "synthetic.sqlite", apply: false }, deps);
  assert.equal(preview.applied, false);
  assert.match(preview.note, /owner liveness.*not evaluated/);
  let calls = 0;
  const applied = executeSyncRepair({ db: "synthetic.sqlite", apply: true }, {
    ...deps,
    recoverStaleSyncState: () => { calls += 1; return { recovered_locks: 1, cancelled_runs: 1, active_expired_locks: 0 }; },
  });
  assert.equal(calls, 1);
  assert.deepEqual(applied.recovery, { recovered_locks: 1, cancelled_runs: 1, active_expired_locks: 0 });
});
