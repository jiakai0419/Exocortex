import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { plain } from "../dist/terminal/index.js";
import {
  executeSqliteMaintenance,
  parseArgs,
  pruneBackups,
  renderSqliteMaintenanceText,
  runSqliteMaintenanceCli,
} from "../src/cli/sqlite-maintenance-command.mjs";

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "exocortex-sqlite-maintenance-test-")));
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
     CREATE TABLE maintenance_locks (
       name TEXT PRIMARY KEY,
       owner TEXT NOT NULL,
       acquired_at TEXT NOT NULL,
       expires_at TEXT NOT NULL,
       reason TEXT NOT NULL DEFAULT ''
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
    backupKeepCount: 7,
    backupKeepDays: 30,
  });
  assert.equal(parseArgs(["prune-runs", "--apply"]).dryRun, false);
  assert.equal(parseArgs(["prune-runs", "--dry-run"]).dryRun, true);
  assert.deepEqual(parseArgs(["verify", "--latest", "--format", "json"]), {
    action: "verify",
    db: "data/exocortex.sqlite",
    backupDir: "backups/private",
    backup: null,
    latest: true,
    format: "json",
    dryRun: true,
    backupKeepCount: 7,
    backupKeepDays: 30,
  });
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["repair"]), /action must be check, backup, verify, prune-runs, or compact/);
  assert.throws(() => parseArgs(["check", "--apply"]), /--apply is only supported for prune-runs/);
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
  assert.equal(statSync(backupDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, backup.backup_path)).mode & 0o777, 0o600);
  assert.equal(statSync(`${join(dir, backup.backup_path)}.manifest.json`).mode & 0o777, 0o600);

  const verify = executeSqliteMaintenance(parseArgs(["verify", "--latest", "--db", dbPath, "--backup-dir", backupDir]), {
    cwd: dir,
  });
  assert.equal(verify.ok, true);
  assert.equal(verify.manifest.status, "verified");
});

test("sqlite maintenance verify is independent of source growth and detects same-count backup tampering", (t) => {
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

  assert.equal(verify.ok, true);
  assert.equal(verify.manifest.status, "verified");

  const backupPath = join(dir, backup.backup_path);
  sqliteExec(
    backupPath,
    "UPDATE sync_runs SET started_at = '2030-01-01T00:00:00.000Z' WHERE id = 1;",
    "tamper backup without changing counts",
  );
  const tampered = executeSqliteMaintenance(parseArgs(["verify", "--backup", backupPath]), { cwd: dir });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.manifest.status, "mismatch");
  assert.equal(tampered.manifest.checks.sha256, false);

  rmSync(`${backupPath}.manifest.json`);
  const missingManifest = executeSqliteMaintenance(parseArgs(["verify", "--backup", backupPath]), { cwd: dir });
  assert.equal(missingManifest.ok, false);
  assert.equal(missingManifest.manifest.status, "missing");
});

test("a failed new backup is discarded without pruning the last verified backup", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "shape.sqlite");
  const backupDir = join(dir, "backups", "private");
  installSchema(dbPath);

  const first = executeSqliteMaintenance(
    parseArgs(["backup", "--db", dbPath, "--backup-dir", backupDir, "--backup-keep-count", "1"]),
    { cwd: dir, now: () => new Date("2027-01-15T08:00:00.000Z") },
  );
  assert.equal(first.ok, true);
  const firstName = first.backup_path.split("/").at(-1);

  const failed = executeSqliteMaintenance(
    parseArgs(["backup", "--db", dbPath, "--backup-dir", backupDir, "--backup-keep-count", "1"]),
    {
      cwd: dir,
      now: () => new Date("2027-01-16T08:00:00.000Z"),
      spawnSync: (cmd, args, options) => {
        const candidatePath = String(args.at(-1) || "");
        if (
          args.includes("-json") &&
          candidatePath.startsWith(backupDir) &&
          String(options.input || "").includes("PRAGMA quick_check")
        ) {
          return { status: 0, stdout: '[{"quick_check":"corrupt"}]\n', stderr: "" };
        }
        return spawnSync(cmd, args, options);
      },
    },
  );

  assert.equal(failed.ok, false);
  assert.equal(failed.backup_discarded, true);
  assert.equal(failed.retention.skipped, "new_backup_failed_validation");
  assert.deepEqual(readdirSync(backupDir).filter((name) => name.endsWith(".sqlite")), [firstName]);
  assert.equal(existsSync(join(backupDir, `${firstName}.manifest.json`)), true);
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
  assert.equal(dryRun.prune.candidate_count, 2);
  assert.equal(dryRun.prune.deleted_count, 0);
  assert.equal(dryRun.check.counts.sync_runs, 7);
  assert.match(rendered, /Run retention/);
  assert.match(rendered, /dry-run/);

  const applied = executeSqliteMaintenance(parseArgs(["prune-runs", "--apply", "--db", dbPath]), {
    cwd: dir,
    now,
  });
  const remainingIds = sqliteJson(dbPath, "SELECT id FROM sync_runs ORDER BY id;", "read remaining run ids").map((row) => row.id);
  assert.equal(applied.ok, true);
  assert.equal(applied.maintenance_lock, "acquired");
  assert.equal(applied.prune.dry_run, false);
  assert.equal(applied.prune.candidate_count, 2);
  assert.equal(applied.prune.deleted_count, 2);
  assert.equal(applied.check.counts.sync_runs, 5);
  assert.deepEqual(remainingIds, [1, 3, 4, 6, 7]);
});

test("sqlite maintenance prune-runs apply uses the maintenance lock", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "shape.sqlite");
  installSchema(dbPath);

  const calls = [];
  const report = executeSqliteMaintenance(parseArgs(["prune-runs", "--apply", "--db", dbPath]), {
    cwd: dir,
    now: () => new Date("2027-01-15T08:00:00.000Z"),
    acquireMaintenanceLock: (_path, opts) => {
      calls.push(["acquire", opts.reason]);
      return { acquired: true };
    },
    releaseMaintenanceLock: (_path, owner) => calls.push(["release", owner]),
  });

  assert.equal(report.ok, true);
  assert.equal(report.maintenance_lock, "acquired");
  assert.deepEqual(calls, [
    ["acquire", "sqlite maintenance prune-runs"],
    ["release", `pid:${process.pid}:sqlite-maintenance`],
  ]);
});

test("sqlite maintenance prune-runs apply refuses active sync locks", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "shape.sqlite");
  installSchema(dbPath);

  assert.throws(
    () =>
      executeSqliteMaintenance(parseArgs(["prune-runs", "--apply", "--db", dbPath]), {
        cwd: dir,
        now: () => new Date("2027-01-15T08:00:00.000Z"),
        acquireMaintenanceLock: () => ({ acquired: false, reason: "sync_locks_active", active_sync_locks: 2 }),
      }),
    /maintenance lock unavailable: 2 active sync lock\(s\)/,
  );
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

  const privatePathError = memoryWriter();
  const privatePath = join(dir, "PRIVATE-SENTINEL", "missing.sqlite");
  assert.equal(runSqliteMaintenanceCli(["check", "--db", privatePath], {
    stderr: privatePathError.stream,
    deps: { cwd: dir },
  }), 1);
  assert.doesNotMatch(privatePathError.text(), /PRIVATE-SENTINEL|missing\.sqlite/);
  assert.match(plain(privatePathError.text()), /database not found/);
});

test("sqlite maintenance reports a readable missing sqlite3 error", () => {
  assert.throws(
    () =>
      executeSqliteMaintenance(parseArgs(["check", "--db", "missing.sqlite"]), {
        existsSync: () => true,
        statSync: () => ({ size: 0 }),
        spawnSync: () => {
          const error = new Error("spawn sqlite3 ENOENT");
          error.code = "ENOENT";
          return { status: null, error };
        },
      }),
    /sqlite3 executable not found \(ENOENT\)/,
  );
});

function backupFor(dbPath, backupDir, cwd, extraArgs = [], deps = {}) {
  return executeSqliteMaintenance(parseArgs(["backup", "--db", dbPath, "--backup-dir", backupDir, ...extraArgs]), { cwd, ...deps });
}

function reportBackupPath(dir, report) { return join(dir, report.backup_path); }
function manifestAt(path) { return JSON.parse(readFileSync(`${path}.manifest.json`, "utf8")); }
function noStagingFiles(dir) { assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".exocortex-backup-")), []); }
function mode(path) { return statSync(path).mode & 0o777; }

test("retention and latest isolate source databases sharing a directory and never touch its source or foreign files", (t) => {
  const dir = tempDir(t);
  const shared = join(dir, "shared");
  mkdirSync(shared, { mode: 0o755 });
  const sourceA = join(shared, "source-a.sqlite");
  const sourceB = join(dir, "source-b.sqlite");
  const foreign = join(shared, "another-application.sqlite");
  installSchema(sourceA);
  installSchema(sourceB);
  writeFileSync(foreign, "foreign bytes", { mode: 0o644 });
  writeFileSync(`${foreign}.manifest.json`, "foreign manifest", { mode: 0o644 });
  const firstA = reportBackupPath(dir, backupFor(sourceA, shared, dir));
  const firstB = reportBackupPath(dir, backupFor(sourceB, shared, dir));
  utimesSync(firstA, new Date(0), new Date(0));
  const second = backupFor(sourceA, shared, dir, ["--backup-keep-count", "1"]);
  const secondA = reportBackupPath(dir, second);
  assert.deepEqual(second.retention.removed, [firstA.split("/").at(-1)]);
  assert.equal(existsSync(firstA), false);
  assert.equal(existsSync(firstB), true);
  assert.equal(existsSync(sourceA), true);
  assert.equal(sqliteJson(sourceA, "SELECT count(*) AS n FROM records;", "source preserved")[0].n, 1);
  assert.equal(readFileSync(foreign, "utf8"), "foreign bytes");
  assert.equal(readFileSync(`${foreign}.manifest.json`, "utf8"), "foreign manifest");
  assert.equal(mode(foreign), 0o644);
  assert.equal(mode(`${foreign}.manifest.json`), 0o644);
  assert.equal(mode(shared), 0o755);
  utimesSync(firstB, new Date(Date.now() + 10000), new Date(Date.now() + 10000));
  const latest = executeSqliteMaintenance(parseArgs(["verify", "--latest", "--db", sourceA, "--backup-dir", shared]), { cwd: dir });
  assert.equal(reportBackupPath(dir, latest), secondA);
  assert.equal(latest.ok, true);
  assert.notEqual(manifestAt(secondA).source_db_id, manifestAt(firstB).source_db_id);
  assert.match(manifestAt(secondA).source_db_id, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(manifestAt(secondA)), new RegExp(dir));
  noStagingFiles(shared);
});

test("backups at the same timestamp get distinct exclusive filenames", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "source.sqlite");
  const backupDir = join(dir, "backups");
  installSchema(dbPath);
  const fixed = new Date();
  const first = backupFor(dbPath, backupDir, dir, [], { now: () => fixed });
  const second = backupFor(dbPath, backupDir, dir, [], { now: () => fixed });
  assert.notEqual(first.backup_path, second.backup_path);
  for (const report of [first, second]) {
    assert.equal(existsSync(reportBackupPath(dir, report)), true);
    assert.equal(mode(reportBackupPath(dir, report)), 0o600);
    assert.equal(mode(`${reportBackupPath(dir, report)}.manifest.json`), 0o600);
  }
  noStagingFiles(backupDir);
});

for (const collisionMember of ["database", "manifest", "manifest-symlink"]) {
  test(`publication collision preserves pre-existing ${collisionMember} and the last verified backup`, (t) => {
    const dir = tempDir(t);
    const dbPath = join(dir, "source.sqlite");
    const backupDir = join(dir, "backups");
    installSchema(dbPath);
    const first = reportBackupPath(dir, backupFor(dbPath, backupDir, dir));
    const target = join(dir, "private-target.txt");
    writeFileSync(target, "foreign target", { mode: 0o644 });
    let collided = "";
    let publishedDatabase = "";
    assert.throws(() => backupFor(dbPath, backupDir, dir, ["--backup-keep-count", "1"], {
      linkSync(from, to) {
        const manifest = to.endsWith(".manifest.json");
        if ((collisionMember === "database" && !manifest) || (collisionMember !== "database" && manifest)) {
          collided = to;
          if (collisionMember === "manifest-symlink") symlinkSync(target, to);
          else writeFileSync(to, "pre-existing object", { mode: 0o640 });
        } else if (!manifest) publishedDatabase = to;
        linkSync(from, to);
      },
    }), /EEXIST/);
    assert.ok(collided);
    assert.equal(readFileSync(collided, "utf8"), collisionMember === "manifest-symlink" ? "foreign target" : "pre-existing object");
    assert.equal(readFileSync(target, "utf8"), "foreign target");
    assert.equal(mode(target), 0o644);
    if (collisionMember !== "manifest-symlink") assert.equal(mode(collided), 0o640);
    if (publishedDatabase) assert.equal(existsSync(publishedDatabase), false);
    assert.equal(existsSync(first), true);
    assert.equal(existsSync(`${first}.manifest.json`), true);
    noStagingFiles(backupDir);
  });
}

test("backup directory symlinks and writable shared directories fail before taking a maintenance lock", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "source.sqlite");
  installSchema(dbPath);
  const target = join(dir, "real-backups");
  const alias = join(dir, "alias-backups");
  mkdirSync(target, { mode: 0o755 });
  symlinkSync(target, alias);
  let locks = 0;
  const deps = { acquireMaintenanceLock() { locks += 1; return { acquired: true }; } };
  assert.throws(() => backupFor(dbPath, alias, dir, [], deps), /real directory, not a symbolic link/);
  assert.equal(mode(target), 0o755);
  chmodSync(target, 0o777);
  assert.throws(() => backupFor(dbPath, target, dir, [], deps), /must not be group or world writable/);
  assert.equal(mode(target), 0o777);
  assert.equal(locks, 0);
  assert.deepEqual(readdirSync(target), []);
  chmodSync(target, 0o755);
});

test("retention skips symlinks, hard links, corrupt manifests and unowned SQLite files without chmod", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "source.sqlite");
  const backupDir = join(dir, "backups");
  installSchema(dbPath);
  const valid = reportBackupPath(dir, backupFor(dbPath, backupDir, dir));
  const original = manifestAt(valid);
  const fake = (suffix) => join(backupDir, `exocortex-${original.source_db_id}-20000101000000-000-${suffix}.sqlite`);
  const sourceLink = fake("aaaa");
  linkSync(dbPath, sourceLink);
  const symbolic = fake("bbbb");
  symlinkSync(dbPath, symbolic);
  const corruptManifest = fake("cccc");
  copyFileSync(valid, corruptManifest);
  chmodSync(corruptManifest, 0o644);
  const manifestLink = fake("dddd");
  copyFileSync(valid, manifestLink);
  chmodSync(manifestLink, 0o644);
  const foreignManifest = join(dir, "foreign-manifest.json");
  writeFileSync(foreignManifest, "foreign manifest", { mode: 0o644 });
  for (const path of [sourceLink, symbolic, corruptManifest]) {
    const manifest = { ...original, backup_file: path.split("/").at(-1), sha256: "0".repeat(64) };
    writeFileSync(`${path}.manifest.json`, JSON.stringify(manifest), { mode: 0o644 });
  }
  symlinkSync(foreignManifest, `${manifestLink}.manifest.json`);
  const result = pruneBackups(backupDir, 1, 1, new Date(Date.now() + 10 * 86400000), {}, valid, dbPath);
  assert.equal(result.removed_count, 0);
  for (const path of [sourceLink, symbolic, corruptManifest, manifestLink]) assert.equal(existsSync(path), true);
  assert.equal(mode(corruptManifest), 0o644);
  assert.equal(mode(`${corruptManifest}.manifest.json`), 0o644);
  assert.equal(mode(manifestLink), 0o644);
  assert.equal(mode(foreignManifest), 0o644);
  assert.equal(readFileSync(foreignManifest, "utf8"), "foreign manifest");
  assert.equal(sqliteJson(dbPath, "SELECT count(*) AS n FROM records;", "source alias protected")[0].n, 1);
  assert.throws(() => executeSqliteMaintenance(parseArgs(["verify", "--db", dbPath, "--backup", symbolic]), { cwd: dir }), /not a symbolic link/);
  assert.throws(() => executeSqliteMaintenance(parseArgs(["verify", "--db", dbPath, "--backup", sourceLink]), { cwd: dir }), /must not alias the source database/);
  const verifyManifestLink = executeSqliteMaintenance(parseArgs(["verify", "--db", dbPath, "--backup", manifestLink]), { cwd: dir });
  assert.equal(verifyManifestLink.manifest.status, "invalid");
});

test("legacy backup explicit verify and read-only maintenance leave file and directory modes unchanged", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "source.sqlite");
  const backupDir = join(dir, "backups");
  installSchema(dbPath);
  const valid = reportBackupPath(dir, backupFor(dbPath, backupDir, dir));
  const legacy = join(backupDir, "exocortex-legacy.sqlite");
  copyFileSync(valid, legacy);
  const oldManifest = { ...manifestAt(valid), kind: "exocortex.sqlite-backup-manifest/v1", backup_file: "exocortex-legacy.sqlite" };
  delete oldManifest.source_db_id;
  writeFileSync(`${legacy}.manifest.json`, JSON.stringify(oldManifest));
  chmodSync(dir, 0o755);
  chmodSync(backupDir, 0o755);
  for (const path of [dbPath, legacy, `${legacy}.manifest.json`]) chmodSync(path, 0o644);
  const before = new Map([dbPath, legacy, `${legacy}.manifest.json`].map((path) => [path, readFileSync(path)]));
  const commands = [
    ["check", "--db", dbPath], ["prune-runs", "--db", dbPath],
    ["verify", "--db", dbPath, "--backup", legacy],
  ];
  for (const args of commands) {
    const spawned = [];
    const report = executeSqliteMaintenance(parseArgs(args), {
      cwd: dir,
      chmodSync() { assert.fail("read-only maintenance must not chmod"); },
      spawnSync(cmd, cliArgs, opts) { spawned.push(cliArgs); return spawnSync(cmd, cliArgs, opts); },
    });
    assert.equal(report.ok, true);
    assert.ok(spawned.length);
    assert.ok(spawned.every((args) => args.includes("-readonly")));
  }
  for (const [path, bytes] of before) {
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(mode(path), 0o644);
  }
  assert.equal(mode(dir), 0o755);
  assert.equal(mode(backupDir), 0o755);
  const result = pruneBackups(backupDir, 1, 1, new Date(Date.now() + 10 * 86400000), {}, valid, dbPath);
  assert.equal(result.removed_count, 0);
  assert.equal(existsSync(legacy), true);
  rmSync(valid);
  rmSync(`${valid}.manifest.json`);
  assert.throws(() => executeSqliteMaintenance(parseArgs(["verify", "--latest", "--db", dbPath, "--backup-dir", backupDir]), { cwd: dir }), /no owned SQLite backups found; use --backup for legacy/);
});

test("source ownership survives inode replacement and resolves symbolic source aliases", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "source.sqlite");
  const backupDir = join(dir, "backups");
  installSchema(dbPath);
  const first = reportBackupPath(dir, backupFor(dbPath, backupDir, dir));
  const firstId = manifestAt(first).source_db_id;
  const firstInode = statSync(dbPath).ino;
  renameSync(dbPath, join(dir, "old-source.sqlite"));
  installSchema(dbPath);
  assert.notEqual(statSync(dbPath).ino, firstInode);
  const alias = join(dir, "source-alias.sqlite");
  symlinkSync(dbPath, alias);
  const second = reportBackupPath(dir, backupFor(alias, backupDir, dir));
  assert.equal(manifestAt(second).source_db_id, firstId);
  const latest = executeSqliteMaintenance(parseArgs(["verify", "--latest", "--db", dbPath, "--backup-dir", backupDir]), { cwd: dir });
  assert.equal(reportBackupPath(dir, latest), second);
  assert.equal(latest.ok, true);
});

test("failed VACUUM or manifest write only removes this operation's staging outputs", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "source.sqlite");
  const backupDir = join(dir, "backups");
  installSchema(dbPath);
  const first = reportBackupPath(dir, backupFor(dbPath, backupDir, dir));
  const firstBytes = readFileSync(first);
  assert.throws(() => backupFor(dbPath, backupDir, dir, [], {
    spawnSync(cmd, args, opts) {
      const sql = String(opts.input || "");
      if (sql.includes("VACUUM main INTO")) {
        const target = sql.match(/VACUUM main INTO '([^']+)';/)?.[1];
        assert.ok(target?.includes("/.exocortex-backup-"));
        writeFileSync(target, "synthetic partial backup", { mode: 0o600 });
        return { status: 1, stdout: "", stderr: "synthetic failure" };
      }
      return spawnSync(cmd, args, opts);
    },
  }), /synthetic failure/);
  noStagingFiles(backupDir);
  assert.throws(() => backupFor(dbPath, backupDir, dir, [], {
    writeFileSync(path, data, opts) {
      writeFileSync(path, data.slice(0, 10), opts);
      throw new Error("synthetic manifest failure");
    },
  }), /synthetic manifest failure/);
  noStagingFiles(backupDir);
  assert.deepEqual(readFileSync(first), firstBytes);
  assert.equal(existsSync(`${first}.manifest.json`), true);
  assert.deepEqual(readdirSync(backupDir).filter((name) => name.endsWith(".sqlite")), [first.split("/").at(-1)]);
});

test("cleanup never deletes a replacement at a claimed publication path", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "source.sqlite");
  const backupDir = join(dir, "backups");
  installSchema(dbPath);
  let replacement = "";
  assert.throws(() => backupFor(dbPath, backupDir, dir, [], {
    linkSync(from, to) {
      linkSync(from, to);
      replacement = to;
      rmSync(to);
      writeFileSync(to, "replacement owned by someone else", { mode: 0o644 });
    },
  }), /backup file identity changed/);
  assert.equal(readFileSync(replacement, "utf8"), "replacement owned by someone else");
  assert.equal(mode(replacement), 0o644);
  noStagingFiles(backupDir);
});

test("mutating maintenance rejects missing or invalid sources before writable locks or directory creation", (t) => {
  const dir = tempDir(t);
  const missingParent = join(dir, "missing-parent");
  const missingSource = join(missingParent, "source.sqlite");
  const backupDir = join(dir, "backups");
  let locks = 0;
  const deps = { cwd: dir, acquireMaintenanceLock() { locks += 1; return { acquired: true }; } };
  for (const action of [["backup"], ["compact"], ["prune-runs", "--apply"]]) {
    assert.throws(() => executeSqliteMaintenance(parseArgs([...action, "--db", missingSource, "--backup-dir", backupDir]), deps), /database not found/);
    assert.equal(existsSync(missingSource), false);
    assert.equal(existsSync(missingParent), false);
    assert.equal(existsSync(backupDir), false);
  }
  const invalidSource = join(dir, "incomplete.sqlite");
  sqliteExec(invalidSource, "CREATE TABLE foreign_data (n INTEGER);", "unrelated schema");
  const bytes = readFileSync(invalidSource);
  for (const action of [["backup"], ["compact"], ["prune-runs", "--apply"]]) {
    const report = executeSqliteMaintenance(parseArgs([...action, "--db", invalidSource, "--backup-dir", backupDir]), deps);
    assert.equal(report.ok, false);
    assert.ok(report.source_check.missing_tables.length);
    assert.deepEqual(readFileSync(invalidSource), bytes);
    assert.equal(existsSync(backupDir), false);
  }
  assert.equal(locks, 0);
});
