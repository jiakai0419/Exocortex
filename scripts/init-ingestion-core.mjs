#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const DEFAULT_DB = "data/exocortex.sqlite";
const MIGRATIONS_DIR = "migrations";

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

function runSql(dbPath, sql, label) {
  const result = spawnSync("sqlite3", [dbPath], {
    input: `.timeout 5000\n${sql}`,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`${label} failed: ${stderr || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function listMigrations() {
  return readdirSync(resolve(MIGRATIONS_DIR))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = resolve(opts.db);
  mkdirSync(dirname(dbPath), { recursive: true });

  runSql(
    dbPath,
    `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
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
BEGIN;
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
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
