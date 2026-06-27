// @ts-check

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  basename,
  relative,
  resolve,
} from "node:path";
import {
  block,
  kv,
  renderError,
  section,
  statusBadge,
  subtitle,
  table,
  title,
} from "../../dist/terminal/index.js";

const DEFAULT_DB = "data/exocortex.sqlite";
const DEFAULT_BACKUP_DIR = "backups/private";
const DEFAULT_PRUNE_RUNS_RETENTION_DAYS = 14;
const TRACKED_TABLES = ["sources", "sync_scopes", "records", "sync_runs", "sync_locks"];

/**
 * @typedef {"check" | "backup" | "verify" | "prune-runs"} SqliteMaintenanceAction
 * @typedef {"text" | "json"} SqliteMaintenanceFormat
 *
 * @typedef {object} SqliteMaintenanceOptions
 * @property {SqliteMaintenanceAction} action
 * @property {string} db
 * @property {string} backupDir
 * @property {string | null} backup
 * @property {boolean} latest
 * @property {SqliteMaintenanceFormat} format
 * @property {boolean} dryRun
 * @property {boolean=} help
 *
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} SqliteMaintenanceDeps
 * @property {(path: string) => boolean=} existsSync
 * @property {(path: string, options?: {recursive?: boolean}) => void=} mkdirSync
 * @property {(path: string, options?: {withFileTypes?: boolean}) => any[]=} readdirSync
 * @property {(path: string) => {size?: number, mtimeMs?: number}=} statSync
 * @property {(cmd: string, args: string[], options: JsonObject) => {status: number | null, stdout?: string, stderr?: string}=} spawnSync
 * @property {() => Date=} now
 * @property {string=} cwd
 *
 * @typedef {object} CliIo
 * @property {{write: (text: string) => unknown}=} stdout
 * @property {{write: (text: string) => unknown}=} stderr
 * @property {SqliteMaintenanceDeps=} deps
 */

function usage() {
  return `Usage: node scripts/sqlite-maintenance.mjs <check|backup|verify|prune-runs> [options]

Options:
  --db <path>           SQLite database path. Default: ${DEFAULT_DB}
  --backup-dir <path>   Private backup directory. Default: ${DEFAULT_BACKUP_DIR}
  --backup <path>       Backup file to verify.
  --latest              Verify the newest backup in --backup-dir.
  --dry-run             For prune-runs: report only. This is the default.
  --apply               For prune-runs: actually delete eligible old no-op runs.
  --format <fmt>        text | json. Default: text
  --help                Show this help.
`;
}

/** @param {unknown} value */
function quoteSql(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** @param {string} value */
function normalizeAction(value) {
  if (["check", "backup", "verify", "prune-runs"].includes(value)) return /** @type {SqliteMaintenanceAction} */ (value);
  throw new Error("action must be check, backup, verify, or prune-runs");
}

/** @param {string[]} argv */
function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    /** @type {SqliteMaintenanceOptions} */
    const opts = {
      action: "check",
      db: DEFAULT_DB,
      backupDir: DEFAULT_BACKUP_DIR,
      backup: null,
      latest: false,
      format: "text",
      dryRun: true,
      help: true,
    };
    return opts;
  }

  /** @type {SqliteMaintenanceOptions} */
  const opts = {
    action: normalizeAction(argv[0]),
    db: DEFAULT_DB,
    backupDir: DEFAULT_BACKUP_DIR,
    backup: null,
    latest: false,
    format: "text",
    dryRun: true,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { ...opts, help: true };
    if (arg === "--latest") {
      opts.latest = true;
      continue;
    }
    if (arg === "--dry-run") {
      if (opts.action !== "prune-runs") throw new Error("--dry-run is only supported for prune-runs");
      opts.dryRun = true;
      continue;
    }
    if (arg === "--apply") {
      if (opts.action !== "prune-runs") throw new Error("--apply is only supported for prune-runs");
      opts.dryRun = false;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--backup-dir") opts.backupDir = next;
    else if (arg === "--backup") opts.backup = next;
    else if (arg === "--format") opts.format = /** @type {SqliteMaintenanceFormat} */ (next);
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }

  if (!["text", "json"].includes(opts.format)) throw new Error("--format must be text or json");
  if (opts.action === "verify" && opts.latest && opts.backup) {
    throw new Error("use either --latest or --backup, not both");
  }
  return opts;
}

/**
 * @param {Date} date
 * @param {number} days
 */
function subtractDays(date, days) {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * @param {string} dbPath
 * @param {string} sql
 * @param {string} label
 * @param {SqliteMaintenanceDeps} [deps]
 * @returns {JsonObject[]}
 */
function sqliteJson(dbPath, sql, label, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const result = run("sqlite3", ["-json", dbPath], {
    input: `.timeout 5000\nPRAGMA foreign_keys = ON;\n${sql}`,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${label} failed: ${String(result.stderr || "").trim()}`);
  const stdout = String(result.stdout || "").trim();
  return stdout ? JSON.parse(stdout) : [];
}

/**
 * @param {string} dbPath
 * @param {string} sql
 * @param {string} label
 * @param {SqliteMaintenanceDeps} [deps]
 */
function sqliteExec(dbPath, sql, label, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const result = run("sqlite3", [dbPath], {
    input: `.timeout 5000\nPRAGMA foreign_keys = ON;\n${sql}`,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${label} failed: ${String(result.stderr || "").trim()}`);
}

/** @param {JsonObject[]} rows */
function firstCell(rows) {
  const row = rows[0] || {};
  return Object.values(row)[0];
}

/**
 * @param {string} cwd
 * @param {string} path
 */
function publicPath(cwd, path) {
  const resolvedCwd = resolve(cwd);
  const resolvedPath = resolve(path);
  const rel = relative(resolvedCwd, resolvedPath);
  if (!rel.startsWith("..") && rel !== "") return rel;
  return `<external-path>/${basename(path)}`;
}

/**
 * @param {string} dbPath
 * @param {SqliteMaintenanceDeps} [deps]
 */
function databaseCheck(dbPath, deps = {}) {
  const fileExists = deps.existsSync || existsSync;
  const fileStat = deps.statSync || statSync;
  if (!fileExists(dbPath)) throw new Error(`database not found: ${dbPath}`);

  const quickCheck = String(firstCell(sqliteJson(dbPath, "PRAGMA quick_check;", "quick check", deps)) || "");
  const foreignKeyIssues = sqliteJson(dbPath, "PRAGMA foreign_key_check;", "foreign key check", deps);
  const existingRows = sqliteJson(
    dbPath,
    `SELECT name FROM sqlite_master
     WHERE type = 'table'
       AND name IN (${TRACKED_TABLES.map((name) => quoteSql(name)).join(", ")})
     ORDER BY name;`,
    "table check",
    deps,
  );
  const existing = new Set(existingRows.map((row) => String(row.name)));
  const missingTables = TRACKED_TABLES.filter((name) => !existing.has(name));
  /** @type {Record<string, number>} */
  const counts = {};
  for (const name of TRACKED_TABLES) {
    if (!existing.has(name)) continue;
    counts[name] = Number(firstCell(sqliteJson(dbPath, `SELECT count(*) AS count FROM ${name};`, `count ${name}`, deps)));
  }
  const stat = fileStat(dbPath);
  const ok = quickCheck === "ok" && foreignKeyIssues.length === 0 && missingTables.length === 0;
  return {
    ok,
    quick_check: quickCheck,
    foreign_key_issues: foreignKeyIssues.length,
    missing_tables: missingTables,
    counts,
    size_bytes: Number(stat.size || 0),
  };
}

/**
 * Old no-op success runs are diagnostic noise, not durable memory. Keep failures,
 * running/cancelled runs, non-empty successes, and each scope's current success.
 * @param {string} dbPath
 * @param {string} cutoffAt
 * @param {boolean} dryRun
 * @param {SqliteMaintenanceDeps} [deps]
 */
function pruneNoopSuccessfulRuns(dbPath, cutoffAt, dryRun, deps = {}) {
  const eligibleWhere = `
    r.status = 'succeeded'
    AND r.started_at < ${quoteSql(cutoffAt)}
    AND r.scanned_count = 0
    AND r.inserted_count = 0
    AND r.updated_count = 0
    AND r.duplicate_count = 0
    AND NOT EXISTS (
      SELECT 1
      FROM sync_scopes s
      WHERE s.last_success_run_id = r.id
    )
  `;
  const rows = sqliteJson(
    dbPath,
    `SELECT COUNT(*) AS count
     FROM sync_runs r
     WHERE ${eligibleWhere};`,
    "count pruneable sync runs",
    deps,
  );
  const candidateCount = Number(firstCell(rows) || 0);
  if (!dryRun && candidateCount > 0) {
    sqliteExec(
      dbPath,
      `BEGIN IMMEDIATE;
       DELETE FROM sync_runs
       WHERE id IN (
         SELECT r.id
         FROM sync_runs r
         WHERE ${eligibleWhere}
       );
       COMMIT;`,
      "prune sync runs",
      deps,
    );
  }
  return {
    retention_days: DEFAULT_PRUNE_RUNS_RETENTION_DAYS,
    cutoff_at: cutoffAt,
    dry_run: dryRun,
    candidate_count: candidateCount,
    deleted_count: dryRun ? 0 : candidateCount,
  };
}

/** @param {Date} date */
function timestampForFile(date) {
  return date.toISOString().replace(/[-:TZ]/g, "").replace(".", "-").slice(0, 19);
}

/**
 * @param {string} dbPath
 * @param {string} backupPath
 * @param {SqliteMaintenanceDeps} [deps]
 */
function backupDatabase(dbPath, backupPath, deps = {}) {
  if ((deps.existsSync || existsSync)(backupPath)) throw new Error(`backup already exists: ${backupPath}`);
  sqliteExec(dbPath, `VACUUM main INTO ${quoteSql(backupPath)};`, "backup", deps);
}

/**
 * @param {string} backupDir
 * @param {SqliteMaintenanceDeps} [deps]
 */
function latestBackupPath(backupDir, deps = {}) {
  const fileExists = deps.existsSync || existsSync;
  const readDir = deps.readdirSync || readdirSync;
  const fileStat = deps.statSync || statSync;
  if (!fileExists(backupDir)) throw new Error(`backup directory not found: ${backupDir}`);
  const files = readDir(backupDir)
    .map((name) => resolve(backupDir, String(name)))
    .filter((path) => path.endsWith(".sqlite"))
    .map((path) => ({ path, mtimeMs: Number(fileStat(path).mtimeMs || 0) }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
  if (files.length === 0) throw new Error(`no .sqlite backups found in ${backupDir}`);
  return files[0].path;
}

/**
 * @param {Record<string, number>} left
 * @param {Record<string, number>} right
 */
function compareCounts(left, right) {
  return TRACKED_TABLES.every((name) => Number(left[name] || 0) === Number(right[name] || 0));
}

/**
 * @param {SqliteMaintenanceOptions} opts
 * @param {SqliteMaintenanceDeps} [deps]
 */
function executeSqliteMaintenance(opts, deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const now = deps.now || (() => new Date());
  const checkedAt = now().toISOString();
  const dbPath = resolve(opts.db);
  const backupDir = resolve(opts.backupDir);

  if (opts.action === "check") {
    const check = databaseCheck(dbPath, deps);
    return {
      ok: check.ok,
      status: check.ok ? "ok" : "failed",
      action: opts.action,
      checked_at: checkedAt,
      db_path: publicPath(cwd, dbPath),
      check,
    };
  }

  if (opts.action === "backup") {
    const makeDir = deps.mkdirSync || mkdirSync;
    const source = databaseCheck(dbPath, deps);
    if (!source.ok) {
      return {
        ok: false,
        status: "failed",
        action: opts.action,
        checked_at: checkedAt,
        db_path: publicPath(cwd, dbPath),
        source_check: source,
      };
    }
    makeDir(backupDir, { recursive: true });
    const backupPath = resolve(backupDir, `exocortex-${timestampForFile(now())}.sqlite`);
    backupDatabase(dbPath, backupPath, deps);
    const backupCheck = databaseCheck(backupPath, deps);
    const countsMatch = compareCounts(source.counts, backupCheck.counts);
    const ok = backupCheck.ok && countsMatch;
    return {
      ok,
      status: ok ? "ok" : "failed",
      action: opts.action,
      checked_at: checkedAt,
      db_path: publicPath(cwd, dbPath),
      backup_path: publicPath(cwd, backupPath),
      source_check: source,
      backup_check: backupCheck,
      counts_match: countsMatch,
    };
  }

  if (opts.action === "prune-runs") {
    const source = databaseCheck(dbPath, deps);
    if (!source.ok) {
      return {
        ok: false,
        status: "failed",
        action: opts.action,
        checked_at: checkedAt,
        db_path: publicPath(cwd, dbPath),
        source_check: source,
      };
    }
    const cutoffAt = subtractDays(now(), DEFAULT_PRUNE_RUNS_RETENTION_DAYS).toISOString();
    const prune = pruneNoopSuccessfulRuns(dbPath, cutoffAt, opts.dryRun, deps);
    const check = opts.dryRun ? source : databaseCheck(dbPath, deps);
    return {
      ok: check.ok,
      status: check.ok ? "ok" : "failed",
      action: opts.action,
      checked_at: checkedAt,
      db_path: publicPath(cwd, dbPath),
      check,
      prune,
    };
  }

  if (!opts.latest && !opts.backup) throw new Error("verify requires --latest or --backup <path>");
  const backupPath = resolve(opts.backup || latestBackupPath(backupDir, deps));
  const source = databaseCheck(dbPath, deps);
  const backupCheck = databaseCheck(backupPath, deps);
  const countsMatch = compareCounts(source.counts, backupCheck.counts);
  const ok = source.ok && backupCheck.ok && countsMatch;
  return {
    ok,
    status: ok ? "ok" : "failed",
    action: opts.action,
    checked_at: checkedAt,
    db_path: publicPath(cwd, dbPath),
    backup_path: publicPath(cwd, backupPath),
    source_check: source,
    backup_check: backupCheck,
    counts_match: countsMatch,
  };
}

/** @param {JsonObject} report */
function renderSqliteMaintenanceText(report) {
  const lines = [
    `${title("SQLite maintenance")} ${statusBadge(report.status)}`,
    subtitle(`Checked at ${new Date(report.checked_at).toLocaleString()}`),
    "",
    section("Summary"),
    kv([
      ["Action", report.action],
      ["Database", report.db_path],
      ["Backup", report.backup_path || ""],
      ["Counts match", report.counts_match === undefined ? "" : report.counts_match ? "yes" : "no"],
    ]),
  ];
  if (report.prune) {
    lines.push("");
    lines.push(section("Run retention"));
    lines.push(kv([
      ["Mode", report.prune.dry_run ? "dry-run" : "apply"],
      ["Rule", `delete succeeded no-op runs older than ${report.prune.retention_days} days`],
      ["Cutoff", report.prune.cutoff_at],
      ["Candidates", report.prune.candidate_count],
      ["Deleted", report.prune.deleted_count],
    ]));
  }
  const check = report.backup_check || report.check || report.source_check;
  if (check) {
    lines.push("");
    lines.push(section("Integrity"));
    lines.push(kv([
      ["quick_check", check.quick_check],
      ["foreign_key_issues", check.foreign_key_issues],
      ["missing_tables", check.missing_tables?.length || 0],
      ["size_bytes", check.size_bytes],
    ]));
  }
  if (check?.counts) {
    lines.push("");
    lines.push(section("Counts"));
    lines.push(table(Object.entries(check.counts).map(([name, count]) => ({ name, count })), [
      { header: "Table", key: "name" },
      { header: "Rows", key: "count" },
    ]));
  }
  return `${block(lines)}\n`;
}

/**
 * @param {string[]} argv
 * @param {CliIo} [io]
 */
function runSqliteMaintenanceCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      stdout.write(usage());
      return 0;
    }
    const report = executeSqliteMaintenance(opts, io.deps || {});
    if (opts.format === "json") stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else stdout.write(renderSqliteMaintenanceText(report));
    return report.ok ? 0 : 2;
  } catch (error) {
    stderr.write(renderError(error));
    return 1;
  }
}

/** @param {string[]} [argv] */
function main(argv = process.argv.slice(2)) {
  return runSqliteMaintenanceCli(argv);
}

export {
  DEFAULT_BACKUP_DIR,
  DEFAULT_DB,
  DEFAULT_PRUNE_RUNS_RETENTION_DAYS,
  TRACKED_TABLES,
  compareCounts,
  databaseCheck,
  executeSqliteMaintenance,
  latestBackupPath,
  main,
  parseArgs,
  pruneNoopSuccessfulRuns,
  publicPath,
  renderSqliteMaintenanceText,
  runSqliteMaintenanceCli,
  timestampForFile,
  usage,
};
