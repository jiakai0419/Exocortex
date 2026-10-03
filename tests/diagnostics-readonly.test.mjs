import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureInitialized } from "../dist/storage/sqlite/ingestion-store.js";
import { readOnlySqliteJson } from "../src/storage/sqlite/readonly-query.mjs";
import { buildStatus } from "../src/diagnostics/sync-status-report.mjs";
import { collectQualityReport } from "../src/diagnostics/lark-im-quality-report.mjs";
import { loadMessages } from "../src/diagnostics/messages-report.mjs";
import { collectLagReport } from "../src/diagnostics/lark-im-lag-report.mjs";
import { buildServiceStatusReport } from "../src/diagnostics/lark-im-service-report.mjs";
import { executeDoctor } from "../src/cli/doctor-command.mjs";
import { executeSyncRepair, parseArgs as parseRepairArgs } from "../src/cli/sync-repair-command.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-readonly-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "test.sqlite");
  ensureInitialized(db);
  return { dir, db };
}

function snapshot(dir, db) {
  return { bytes: readFileSync(db), dbMode: statSync(db).mode & 0o777, dirMode: statSync(dir).mode & 0o777, files: readdirSync(dir).sort() };
}

test("default diagnostics preserve database contents, stale state and file permissions", (t) => {
  const { dir, db } = fixture(t);
  const seed = spawnSync("sqlite3", [db], { encoding: "utf8", input: `
    INSERT INTO sync_runs(scope_id, source_id, status, started_at, metadata_json)
      VALUES('lark.im.sent_by_me', 'lark.im', 'running', '2000-01-01T00:00:00.000Z', '{}');
    INSERT INTO sync_locks(scope_id, locked_by, locked_at, expires_at)
      VALUES('lark.im.sent_by_me', 'synthetic-dead-owner', '2000-01-01T00:00:00.000Z', '2000-01-01T00:01:00.000Z');
  ` });
  assert.equal(seed.status, 0, seed.stderr);
  chmodSync(dir, 0o755);
  chmodSync(db, 0o644);
  const before = snapshot(dir, db);
  assert.equal(buildStatus(db).health, "syncing");
  collectQualityReport(db);
  assert.deepEqual(loadMessages(db, { db, direction: "all", limit: 2, search: "" }), []);
  const lag = collectLagReport(db, { startMs: 0, endMs: 1000, hotChats: 1, messagesPerChat: 1 }, {
    getSelfOpenId: () => "synthetic-self", fetchHotChats: () => [],
    fetchRecentChatMessages: () => { throw new Error("must not be called"); },
  });
  assert.equal(lag.status, "inconclusive");
  const report = executeDoctor({ db, live: false, hotChats: 1, messagesPerChat: 1, format: "json" });
  assert.equal(report.overall, "syncing");
  buildServiceStatusReport({ db, label: "test", target: "test", logDir: dir }, {
    runCommand: (_cmd, args) => {
      if (args[0] === "print") return { status: 1, stdout: "", stderr: "", pid: 0, output: [], signal: null };
      assert.deepEqual(args, ["scripts/sync-status.mjs", "--db", db, "--format", "json"]);
      return { status: 0, stdout: JSON.stringify(buildStatus(db)), stderr: "", pid: 0, output: [], signal: null };
    },
  });
  assert.equal(executeSyncRepair({ db, apply: false }).preview.expired_locks, 1);
  assert.deepEqual(snapshot(dir, db), before);
});

test("missing databases and missing tables remain untouched; SQLite rejects DML and DDL", (t) => {
  const { dir, db } = fixture(t);
  const missing = join(dir, "absent", "missing.sqlite");
  assert.throws(() => readOnlySqliteJson(missing, "SELECT 1;", "test"), /failed/);
  assert.throws(() => executeSyncRepair({ db: missing, apply: false }), /failed/);
  assert.equal(existsSync(join(dir, "absent")), false);
  const empty = join(dir, "empty.sqlite");
  writeFileSync(empty, "");
  assert.throws(() => buildStatus(empty), /failed/);
  assert.equal(statSync(empty).size, 0);
  const before = snapshot(dir, db);
  assert.throws(() => readOnlySqliteJson(db, "CREATE TABLE forbidden(value TEXT);", "test"), /failed/);
  assert.throws(() => readOnlySqliteJson(db, "DELETE FROM sync_scopes;", "test"), /failed/);
  assert.deepEqual(snapshot(dir, db), before);
});

test("repair only calls recovery after an explicit apply flag", () => {
  const deps = {
    sqliteJson: () => [{ locks: 2, expired_locks: 1, running_runs: 2 }],
    recoverStaleSyncState: () => { throw new Error("mutation forbidden"); },
  };
  assert.equal(parseRepairArgs([]).apply, false);
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
