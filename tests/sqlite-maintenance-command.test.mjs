import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { plain } from "../dist/terminal/index.js";
import {
  executeSqliteMaintenance,
  parseArgs,
  renderSqliteMaintenanceText,
  runSqliteMaintenanceCli,
} from "../src/cli/sqlite-maintenance-command.mjs";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-sqlite-maintenance-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memoryWriter() {
  let text = "";
  return {
    stream: {
      write(chunk) {
        text += String(chunk);
      },
    },
    text: () => text,
  };
}

function sqliteExec(dbPath, sql, label) {
  const result = spawnSync("sqlite3", [dbPath], {
    input: `.timeout 5000\nPRAGMA foreign_keys = ON;\n${sql}`,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr.trim()}`);
}

function sqliteJson(dbPath, sql, label) {
  const result = spawnSync("sqlite3", ["-json", dbPath], {
    input: `.timeout 5000\nPRAGMA foreign_keys = ON;\n${sql}`,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr.trim()}`);
  const stdout = result.stdout.trim();
  return stdout ? JSON.parse(stdout) : [];
}

function installSchema(dbPath) {
  sqliteExec(
    dbPath,
    `CREATE TABLE sources (
       id TEXT PRIMARY KEY
     );
     CREATE TABLE sync_scopes (
       id TEXT PRIMARY KEY,
       source_id TEXT NOT NULL REFERENCES sources(id),
       last_success_run_id INTEGER
     );
     CREATE TABLE records (
       id INTEGER PRIMARY KEY,
       source_id TEXT NOT NULL REFERENCES sources(id),
       first_seen_scope_id TEXT NOT NULL REFERENCES sync_scopes(id)
     );
     CREATE TABLE sync_runs (
       id INTEGER PRIMARY KEY,
       source_id TEXT NOT NULL REFERENCES sources(id),
       scope_id TEXT NOT NULL REFERENCES sync_scopes(id),
       status TEXT NOT NULL DEFAULT 'succeeded',
       started_at TEXT NOT NULL DEFAULT '2027-01-15T08:00:00.000Z',
       scanned_count INTEGER NOT NULL DEFAULT 0,
       inserted_count INTEGER NOT NULL DEFAULT 0,
       updated_count INTEGER NOT NULL DEFAULT 0,
       duplicate_count INTEGER NOT NULL DEFAULT 0
     );
     CREATE TABLE sync_locks (
       scope_id TEXT PRIMARY KEY REFERENCES sync_scopes(id)
     );
     INSERT INTO sources (id) VALUES ('shape.source');
     INSERT INTO sync_scopes (id, source_id) VALUES ('shape.scope', 'shape.source');
     INSERT INTO records (source_id, first_seen_scope_id) VALUES ('shape.source', 'shape.scope');
     INSERT INTO sync_runs (source_id, scope_id) VALUES ('shape.source', 'shape.scope');`,
    "install schema",
  );
}

test("sqlite maintenance parseArgs keeps public maintenance commands explicit", () => {
  assert.equal(parseArgs(["check"]).action, "check");
  assert.equal(parseArgs(["backup", "--backup-dir", "private-backups"]).backupDir, "private-backups");
  assert.deepEqual(parseArgs(["prune-runs"]), {
    action: "prune-runs",
    db: "data/exocortex.sqlite",
    backupDir: "backups/private",
    backup: null,
    latest: false,
    format: "text",
    dryRun: true,
    allowRunningWorker: false,
  });
  assert.equal(parseArgs(["prune-runs", "--apply"]).dryRun, false);
  assert.equal(parseArgs(["prune-runs", "--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["prune-runs", "--apply", "--allow-running-worker"]).allowRunningWorker, true);
  assert.deepEqual(parseArgs(["verify", "--latest", "--format", "json"]), {
    action: "verify",
    db: "data/exocortex.sqlite",
    backupDir: "backups/private",
    backup: null,
    latest: true,
    format: "json",
    dryRun: true,
    allowRunningWorker: false,
  });
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["repair"]), /action must be check, backup, verify, or prune-runs/);
  assert.throws(() => parseArgs(["check", "--apply"]), /--apply is only supported for prune-runs/);
  assert.throws(() => parseArgs(["check", "--allow-running-worker"]), /--allow-running-worker is only supported for prune-runs/);
  assert.throws(() => parseArgs(["verify", "--latest", "--backup", "x.sqlite"]), /use either --latest or --backup/);
});

test("sqlite maintenance check reports integrity and public-safe counts", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "shape.sqlite");
  installSchema(dbPath);

  const report = executeSqliteMaintenance(parseArgs(["check", "--db", dbPath]), { cwd: dir });
  const rendered = plain(renderSqliteMaintenanceText(report));

  assert.equal(report.ok, true);
  assert.equal(report.check.quick_check, "ok");
  assert.equal(report.check.foreign_key_issues, 0);
  assert.equal(report.check.counts.records, 1);
  assert.match(rendered, /SQLite maintenance OK/);
  assert.match(rendered, /records/);
  assert.equal(JSON.stringify(report).includes(dbPath), false);
});

test("sqlite maintenance backup creates a verified private backup and verify latest passes", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "shape.sqlite");
  const backupDir = join(dir, "backups", "private");
  installSchema(dbPath);

  const backup = executeSqliteMaintenance(parseArgs(["backup", "--db", dbPath, "--backup-dir", backupDir]), {
    cwd: dir,
    now: () => new Date("2027-01-15T08:00:00.000Z"),
  });
  assert.equal(backup.ok, true);
  assert.equal(backup.counts_match, true);
  assert.match(backup.backup_path, /^backups\/private\/exocortex-/);

  const verify = executeSqliteMaintenance(parseArgs(["verify", "--latest", "--db", dbPath, "--backup-dir", backupDir]), {
    cwd: dir,
  });
  assert.equal(verify.ok, true);
  assert.equal(verify.counts_match, true);
});

test("sqlite maintenance verify fails when backup counts no longer match source", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "shape.sqlite");
  const backupDir = join(dir, "backups", "private");
  installSchema(dbPath);
  const backup = executeSqliteMaintenance(parseArgs(["backup", "--db", dbPath, "--backup-dir", backupDir]), {
    cwd: dir,
    now: () => new Date("2027-01-15T08:00:00.000Z"),
  });

  sqliteExec(
    dbPath,
    "INSERT INTO records (source_id, first_seen_scope_id) VALUES ('shape.source', 'shape.scope');",
    "mutate source",
  );
  const verify = executeSqliteMaintenance(parseArgs(["verify", "--db", dbPath, "--backup", join(dir, backup.backup_path)]), {
    cwd: dir,
  });

  assert.equal(verify.ok, false);
  assert.equal(verify.counts_match, false);
});

test("sqlite maintenance prune-runs only removes old succeeded no-op runs when applied", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "shape.sqlite");
  installSchema(dbPath);
  sqliteExec(
    dbPath,
    `INSERT INTO sync_scopes (id, source_id, last_success_run_id)
       VALUES ('current.scope', 'shape.source', 3);
     INSERT INTO sync_runs (id, source_id, scope_id, status, started_at, scanned_count, inserted_count, updated_count, duplicate_count)
       VALUES
       (2, 'shape.source', 'shape.scope', 'succeeded', '2026-12-20T00:00:00.000Z', 0, 0, 0, 0),
       (3, 'shape.source', 'current.scope', 'succeeded', '2026-12-20T00:00:00.000Z', 0, 0, 0, 0),
       (4, 'shape.source', 'shape.scope', 'failed', '2026-12-20T00:00:00.000Z', 0, 0, 0, 0),
       (5, 'shape.source', 'shape.scope', 'succeeded', '2026-12-20T00:00:00.000Z', 1, 0, 0, 0),
       (6, 'shape.source', 'shape.scope', 'succeeded', '2027-01-10T00:00:00.000Z', 0, 0, 0, 0),
       (7, 'shape.source', 'shape.scope', 'cancelled', '2026-12-20T00:00:00.000Z', 0, 0, 0, 0);`,
    "seed prune runs",
  );

  const now = () => new Date("2027-01-15T08:00:00.000Z");
  const dryRun = executeSqliteMaintenance(parseArgs(["prune-runs", "--db", dbPath]), { cwd: dir, now });
  const rendered = plain(renderSqliteMaintenanceText(dryRun));
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.prune.dry_run, true);
  assert.equal(dryRun.prune.candidate_count, 1);
  assert.equal(dryRun.prune.deleted_count, 0);
  assert.equal(dryRun.check.counts.sync_runs, 7);
  assert.match(rendered, /Run retention/);
  assert.match(rendered, /dry-run/);

  const applied = executeSqliteMaintenance(parseArgs(["prune-runs", "--apply", "--db", dbPath]), {
    cwd: dir,
    now,
    isLarkImWorkerLoaded: () => false,
  });
  const remainingIds = sqliteJson(dbPath, "SELECT id FROM sync_runs ORDER BY id;", "read remaining run ids").map((row) => row.id);
  assert.equal(applied.ok, true);
  assert.equal(applied.prune.dry_run, false);
  assert.equal(applied.prune.candidate_count, 1);
  assert.equal(applied.prune.deleted_count, 1);
  assert.equal(applied.check.counts.sync_runs, 6);
  assert.deepEqual(remainingIds, [1, 3, 4, 5, 6, 7]);
});

test("sqlite maintenance prune-runs apply refuses while worker is running by default", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "shape.sqlite");
  installSchema(dbPath);

  assert.throws(
    () =>
      executeSqliteMaintenance(parseArgs(["prune-runs", "--apply", "--db", dbPath]), {
        cwd: dir,
        now: () => new Date("2027-01-15T08:00:00.000Z"),
        isLarkImWorkerLoaded: () => true,
      }),
    /refusing to prune sync runs while the Lark IM worker is running/,
  );

  const report = executeSqliteMaintenance(
    parseArgs(["prune-runs", "--apply", "--allow-running-worker", "--db", dbPath]),
    {
      cwd: dir,
      now: () => new Date("2027-01-15T08:00:00.000Z"),
      isLarkImWorkerLoaded: () => true,
    },
  );
  assert.equal(report.ok, true);
  assert.equal(report.prune.deleted_count, 0);
});

test("sqlite maintenance CLI renders text, json, help, and errors", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "shape.sqlite");
  installSchema(dbPath);

  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const exitText = runSqliteMaintenanceCli(["check", "--db", dbPath], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    deps: { cwd: dir },
  });
  assert.equal(exitText, 0);
  assert.equal(stderr.text(), "");
  assert.match(plain(stdout.text()), /SQLite maintenance OK/);

  const jsonOut = memoryWriter();
  assert.equal(runSqliteMaintenanceCli(["check", "--db", dbPath, "--format", "json"], {
    stdout: jsonOut.stream,
    deps: { cwd: dir },
  }), 0);
  assert.equal(JSON.parse(jsonOut.text()).check.counts.records, 1);

  const helpOut = memoryWriter();
  assert.equal(runSqliteMaintenanceCli(["--help"], { stdout: helpOut.stream }), 0);
  assert.match(helpOut.text(), /Usage: node scripts\/sqlite-maintenance\.mjs/);

  const err = memoryWriter();
  assert.equal(runSqliteMaintenanceCli(["verify", "--db", dbPath], {
    stderr: err.stream,
    deps: { cwd: dir },
  }), 1);
  assert.match(plain(err.text()), /verify requires --latest or --backup/);
});
