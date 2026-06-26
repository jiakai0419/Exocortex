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

function installSchema(dbPath) {
  sqliteExec(
    dbPath,
    `CREATE TABLE sources (
       id TEXT PRIMARY KEY
     );
     CREATE TABLE sync_scopes (
       id TEXT PRIMARY KEY,
       source_id TEXT NOT NULL REFERENCES sources(id)
     );
     CREATE TABLE records (
       id INTEGER PRIMARY KEY,
       source_id TEXT NOT NULL REFERENCES sources(id),
       first_seen_scope_id TEXT NOT NULL REFERENCES sync_scopes(id)
     );
     CREATE TABLE sync_runs (
       id INTEGER PRIMARY KEY,
       source_id TEXT NOT NULL REFERENCES sources(id),
       scope_id TEXT NOT NULL REFERENCES sync_scopes(id)
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
  assert.deepEqual(parseArgs(["verify", "--latest", "--format", "json"]), {
    action: "verify",
    db: "data/exocortex.sqlite",
    backupDir: "backups/private",
    backup: null,
    latest: true,
    format: "json",
  });
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["repair"]), /action must be check, backup, or verify/);
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
