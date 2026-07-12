#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DB = "data/exocortex.sqlite";
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = resolve(PROJECT_ROOT, "migrations");
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const INIT_LOCK_WAIT_MS = 30_000;
const INIT_LOCK_STALE_MS = 5 * 60_000;

process.umask(0o077);

function usage() {
  return `Usage: node scripts/init-ingestion-core.mjs [options]

Options:
  --db <path>    SQLite database path. Default: ${DEFAULT_DB}
  --help         Show this help.
`;
}

function parseArgs(argv) {
  const opts = { db: DEFAULT_DB };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--db") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error("--db requires a value");
      opts.db = next;
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

function quoteSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function chmodIfPresent(path, mode) {
  try {
    if (existsSync(path)) chmodSync(path, mode);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function secureDatabasePaths(dbPath) {
  const dbDir = dirname(dbPath);
  mkdirSync(dbDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(dbDir, PRIVATE_DIRECTORY_MODE);
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
    chmodIfPresent(path, PRIVATE_FILE_MODE);
  }
}

function sqliteFailure(result, label) {
  if (result.error?.code === "ENOENT") {
    return new Error(`${label} failed: sqlite3 executable not found (ENOENT); install SQLite and ensure sqlite3 is on PATH`);
  }
  const detail =
    String(result.stderr || "").trim() ||
    result.error?.message ||
    `sqlite3 exited with status ${String(result.status)}`;
  return new Error(`${label} failed: ${detail}`);
}

function runSql(dbPath, sql, label) {
  secureDatabasePaths(dbPath);
  let result;
  try {
    result = spawnSync("sqlite3", [dbPath], {
      input: `.bail on\n.timeout 5000\n${sql}`,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
  } finally {
    secureDatabasePaths(dbPath);
  }
  if (result.status !== 0 || result.error) throw sqliteFailure(result, label);
  return String(result.stdout || "");
}

function listMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireInitLock(dbPath) {
  const lockPath = `${dbPath}.init.lock`;
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const startedAt = Date.now();
  while (true) {
    try {
      mkdirSync(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs >= INIT_LOCK_STALE_MS;
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (stale) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt >= INIT_LOCK_WAIT_MS) {
        throw new Error(`timed out waiting for initializer lock: ${lockPath}`);
      }
      sleepMs(25);
      continue;
    }
    try {
      writeFileSync(
        resolve(lockPath, "owner.json"),
        `${JSON.stringify({ token, pid: process.pid, acquired_at: new Date().toISOString() })}\n`,
        { mode: PRIVATE_FILE_MODE, flag: "wx" },
      );
      return { lockPath, token };
    } catch (error) {
      rmSync(lockPath, { recursive: true, force: true });
      throw error;
    }
  }
}

function releaseInitLock(lock) {
  try {
    const owner = JSON.parse(readFileSync(resolve(lock.lockPath, "owner.json"), "utf8"));
    if (owner?.token === lock.token) rmSync(lock.lockPath, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = resolve(opts.db);
  secureDatabasePaths(dbPath);
  const initLock = acquireInitLock(dbPath);
  try {
    runSql(
      dbPath,
      `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
COMMIT;
`,
      "initialize schema_migrations",
    );

    const applied = new Set(
      runSql(dbPath, "SELECT version FROM schema_migrations ORDER BY version;", "list migrations")
        .trim()
        .split("\n")
        .filter(Boolean),
    );

    const appliedNow = [];
    for (const fileName of listMigrations()) {
      const version = fileName.split("_", 1)[0];
      if (applied.has(version)) continue;

      const sql = readFileSync(resolve(MIGRATIONS_DIR, fileName), "utf8");
      runSql(
        dbPath,
        `
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
${sql}
INSERT INTO schema_migrations (version, name)
VALUES (${quoteSql(version)}, ${quoteSql(basename(fileName))});
COMMIT;
`,
        `apply ${fileName}`,
      );
      appliedNow.push(fileName);
    }

    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          db_path: dbPath,
          applied: appliedNow,
        },
        null,
        2,
      ),
    );
    process.stdout.write("\n");
  } finally {
    releaseInitLock(initLock);
    secureDatabasePaths(dbPath);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
