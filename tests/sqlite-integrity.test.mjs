import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runCli } from "../bin/exocortex.mjs";
import { ensureInitialized } from "../dist/storage/sqlite/ingestion-store.js";
import { executeSqliteMaintenance, readDatabaseEvidence } from "../src/storage/sqlite/maintenance.mjs";
import { startOwnedProcess, waitUntil } from "./helpers/owned-process.mjs";

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "exocortex-integrity-")));
  const db = join(dir, 'invented ?#% "汉\n.sqlite');
  t.after(() => { chmodSync(dir, 0o700); if (existsSync(db)) chmodSync(db, 0o600); rmSync(dir, { recursive: true, force: true }); });
  ensureInitialized(db);
  return { dir, db };
}
function exec(db, sql) {
  const result = spawnSync("sqlite3", ["-batch", "-bail", db], { input: sql, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function options(f, action) {
  return { action, db: f.db, backupDir: join(f.dir, "backups"), backup: null, latest: false,
    format: "json", dryRun: true, backupKeepCount: 1, backupKeepDays: 1 };
}

for (const [name, sql] of [
  ["source enum", "UPDATE sources SET enabled=2 WHERE id='lark.im';"],
  ["JSON constraint", "UPDATE sources SET config_json='invented invalid JSON' WHERE id='lark.im';"],
  ["additional schema constraint", "CREATE TABLE invented_extra(value INTEGER CHECK(value > 0)); INSERT INTO invented_extra VALUES(-1);"],
]) test(`real ${name} violation fails read-only integrity without changing source`, t => {
  const f = fixture(t);
  assert.equal(readDatabaseEvidence(f.db).ok, true);
  exec(f.db, `PRAGMA ignore_check_constraints=ON; ${sql}`);
  assert.match(exec(f.db, "PRAGMA quick_check;"), /CHECK constraint failed/);
  chmodSync(f.db, 0o444); chmodSync(f.dir, 0o555);
  const before = readFileSync(f.db), files = readdirSync(f.dir).sort();
  const report = readDatabaseEvidence(f.db);
  assert.equal(report.ok, false); assert.equal(report.quick_check, "failed");
  assert.deepEqual(readFileSync(f.db), before);
  assert.deepEqual(readdirSync(f.dir).sort(), files);
  assert.equal(statSync(f.db).mode & 0o777, 0o444);
  assert.equal(statSync(f.dir).mode & 0o777, 0o555);
});

test("constraint failure blocks CLI database acceptance and preserves an existing verified backup", async t => {
  const f = fixture(t), opts = options(f, "backup");
  const good = executeSqliteMaintenance(opts, { cwd: f.dir });
  assert.equal(good.ok, true);
  const files = readdirSync(opts.backupDir).sort();
  const before = files.map(name => [name, readFileSync(join(opts.backupDir, name))]);
  exec(f.db, "PRAGMA ignore_check_constraints=ON; UPDATE sources SET enabled=2 WHERE id='lark.im';");
  const source = readFileSync(f.db);
  const result = executeSqliteMaintenance(opts, { cwd: f.dir,
    acquireMaintenanceLock() { assert.fail("failed preflight must precede any lock or backup write"); } });
  assert.equal(result.ok, false); assert.equal(result.source_check.quick_check, "failed");
  assert.deepEqual(readFileSync(f.db), source);
  assert.deepEqual(readdirSync(opts.backupDir).sort(), files);
  for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(opts.backupDir, name)), bytes);
  let stdout = "", stderr = "";
  const code = await runCli(["check", "--db", f.db, "--format", "json"], {
    cwd: f.dir, stdout: { write: x => { stdout += x; } }, stderr: { write: x => { stderr += x; } },
  });
  const check = JSON.parse(stdout);
  assert.equal(code, 2); assert.equal(stderr, "");
  assert.equal(check.checks.database.status, "incomplete");
  assert.equal(check.checks.database.evidence.quick_check, "failed");
});

test("a corrupt newly-created backup is discarded without pruning the previous recovery point", t => {
  const f = fixture(t), opts = options(f, "backup");
  assert.equal(executeSqliteMaintenance(opts, { cwd: f.dir }).ok, true);
  const files = readdirSync(opts.backupDir).sort();
  const before = files.map(name => [name, readFileSync(join(opts.backupDir, name))]);
  let injected = false;
  const report = executeSqliteMaintenance(opts, { cwd: f.dir, spawnSync(cmd, args, settings) {
    const input = String(settings.input || "");
    const result = spawnSync(cmd, args, settings);
    if (input.includes("DELETE FROM maintenance_locks;")) {
      const path = args.at(-1);
      assert.ok(path.startsWith(opts.backupDir));
      exec(path, "PRAGMA ignore_check_constraints=ON; UPDATE sources SET enabled=2 WHERE id='lark.im';");
      injected = true;
    }
    return result;
  } });
  assert.equal(injected, true); assert.equal(report.ok, false);
  assert.equal(report.backup_check.quick_check, "failed");
  assert.equal(report.backup_discarded, true);
  assert.equal(report.retention.skipped, "new_backup_failed_validation");
  assert.deepEqual(readdirSync(opts.backupDir).sort(), files);
  for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(opts.backupDir, name)), bytes);
});

for (const phase of [1, 2, 3]) test(`disk-full integrity failure at backup check ${phase} preserves the previous recovery point`, t => {
  const f = fixture(t), opts = options(f, "backup");
  assert.equal(executeSqliteMaintenance(opts, { cwd: f.dir }).ok, true);
  const files = readdirSync(opts.backupDir).sort();
  const before = files.map(name => [name, readFileSync(join(opts.backupDir, name))]);
  let checks = 0;
  assert.throws(() => executeSqliteMaintenance(opts, { cwd: f.dir, spawnSync(cmd, args, settings) {
    if (String(settings.input || "").includes("PRAGMA quick_check") && ++checks === phase) {
      return { status: 1, stderr: "database or disk is full" };
    }
    return spawnSync(cmd, args, settings);
  } }), /integrity snapshot check/);
  assert.equal(checks, phase);
  assert.deepEqual(readdirSync(opts.backupDir).sort(), files);
  for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(opts.backupDir, name)), bytes);
  assert.equal(exec(f.db, "SELECT COUNT(*) FROM maintenance_locks;").trim(), "0");
});

for (const response of [
  { status: 1, stdout: '[{"quick_check":"ok"}]' },
  { status: 0, stdout: '[{"quick_check":"ok"}]', signal: "SIGTERM" },
  { status: null, error: Object.assign(new Error("invented timeout"), { code: "ETIMEDOUT" }) },
  { status: 1, stderr: "database or disk is full" },
  { status: 0, stdout: "not JSON" }, { status: 0, stdout: "[]" },
  { status: 0, stdout: '[{"unexpected":"ok"}]' },
]) test(`unusable integrity evidence cannot authorize later checks: ${JSON.stringify(response)}`, () => {
  let calls = 0, destination;
  assert.throws(() => readDatabaseEvidence("/invented/not-opened.sqlite", {
    existsSync: () => true, spawnSync: (_cmd, args) => {
      calls++; destination = args.at(-1);
      assert.equal(statSync(destination).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(destination)).mode & 0o777, 0o700);
      return response;
    },
  }), /integrity snapshot check/);
  assert.equal(calls, 1);
  assert.equal(existsSync(dirname(destination)), false, "failure removes only its own private temporary directory");
});

test("missing source is never created by integrity restore", t => {
  const f = fixture(t), missing = join(f.dir, "absent.sqlite");
  // Bypass only the early exists check to exercise the source URI itself.
  assert.throws(() => readDatabaseEvidence(missing, { existsSync: () => true }), /integrity snapshot check/);
  assert.equal(existsSync(missing), false);
});

test("integrity snapshot sees committed WAL violations without checkpointing the source", async t => {
  const f = fixture(t);
  exec(f.db, "PRAGMA journal_mode=WAL;");
  const deadline = performance.now() + 15_000;
  const writer = startOwnedProcess(process.env.EXOCORTEX_SYNTHETIC_PYTHON || "python3", ["-u", "-c", `
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as connection:
    connection.execute('PRAGMA wal_autocheckpoint=0')
    connection.execute('PRAGMA ignore_check_constraints=ON')
    connection.execute("UPDATE sources SET enabled=2 WHERE id='lark.im'")
    connection.commit()
    print('invented-ready', flush=True)
    sys.stdin.read()
`, f.db], { deadline, cwd: f.dir, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  writer.child.stdout.on("data", chunk => { output += chunk; });
  let failure;
  try {
    await waitUntil(() => output.includes("invented-ready"), Math.min(deadline, performance.now() + 5000));
    const before = readFileSync(f.db), wal = readFileSync(`${f.db}-wal`);
    assert.ok(wal.length > 0);
    assert.equal(readDatabaseEvidence(f.db).quick_check, "failed");
    assert.deepEqual(readFileSync(f.db), before);
    assert.deepEqual(readFileSync(`${f.db}-wal`), wal);
  } catch (error) { failure = error; }
  writer.child.stdin.end();
  const closed = await writer.result;
  assert.equal(closed.code, 0, closed.stderr.toString());
  assert.equal(closed.signalAttempted, false); assert.equal(closed.failure, null);
  if (failure) throw failure;
});
