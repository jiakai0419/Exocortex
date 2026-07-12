import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
} from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INITIALIZER = resolve(PROJECT_ROOT, "scripts/init-ingestion-core.mjs");

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-init-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sqliteJson(dbPath, sql) {
  const result = spawnSync("sqlite3", ["-json", dbPath], {
    input: `.bail on\n${sql}`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : [];
}

function runInitializer(dbPath, cwd, env = process.env) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [INITIALIZER, "--db", dbPath], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolveResult({ status: null, stdout, stderr, error }));
    child.on("close", (status) => resolveResult({ status, stdout, stderr, error: null }));
  });
}

test("concurrent initializers serialize, all succeed, and apply every migration once", { timeout: 30_000 }, async (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "nested", "concurrent.sqlite");

  const results = await Promise.all(
    Array.from({ length: 8 }, () => runInitializer(dbPath, dir)),
  );
  for (const result of results) {
    assert.equal(result.error, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  }

  const migrations = sqliteJson(
    dbPath,
    "SELECT version, COUNT(*) AS count FROM schema_migrations GROUP BY version ORDER BY version;",
  );
  assert.deepEqual(migrations, [
    { version: "001", count: 1 },
    { version: "002", count: 1 },
    { version: "003", count: 1 },
    { version: "004", count: 1 },
    { version: "005", count: 1 },
    { version: "006", count: 1 },
    { version: "007", count: 1 },
  ]);

  const indexes = sqliteJson(
    dbPath,
    `SELECT name FROM sqlite_master
     WHERE type = 'index'
       AND name IN ('idx_sync_runs_succeeded_noop_retention', 'idx_sync_scopes_last_success_run')
     ORDER BY name;`,
  );
  assert.deepEqual(indexes, [
    { name: "idx_sync_runs_succeeded_noop_retention" },
    { name: "idx_sync_scopes_last_success_run" },
  ]);
  const retentionIndex = sqliteJson(
    dbPath,
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_sync_runs_succeeded_noop_retention';",
  )[0]?.sql || "";
  assert.match(retentionIndex, /inserted_count = 0/);
  assert.match(retentionIndex, /updated_count = 0/);
  assert.doesNotMatch(retentionIndex, /scanned_count|duplicate_count/);
  assert.equal(statSync(dirname(dbPath)).mode & 0o777, 0o700);
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);
});

test("initializer reports a readable sqlite3 ENOENT and removes its serialization lock", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "missing-sqlite.sqlite");
  const result = spawnSync(process.execPath, [INITIALIZER, "--db", dbPath], {
    cwd: dir,
    env: { ...process.env, PATH: "" },
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /sqlite3 executable not found \(ENOENT\)/);
  assert.doesNotMatch(result.stderr, /Cannot read properties/);
  assert.equal(existsSync(`${dbPath}.init.lock`), false);
});
