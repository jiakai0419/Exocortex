// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
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
import {
  acquireMaintenanceLock,
  releaseMaintenanceLock,
} from "../../dist/storage/sqlite/ingestion-store.js";
import { publicDiagnosticError } from "../diagnostics/public-safe.mjs";

const DEFAULT_DB = "data/exocortex.sqlite";
const DEFAULT_BACKUP_DIR = "backups/private";
const DEFAULT_PRUNE_RUNS_RETENTION_DAYS = 14;
const DEFAULT_BACKUP_KEEP_COUNT = 7;
const DEFAULT_BACKUP_KEEP_DAYS = 30;
const TRACKED_TABLES = ["sources", "sync_scopes", "records", "sync_runs", "sync_locks", "maintenance_locks"];
const DURABLE_BACKUP_TABLES = ["sources", "sync_scopes", "records", "sync_runs"];

/**
 * @typedef {"check" | "backup" | "verify" | "prune-runs" | "compact"} SqliteMaintenanceAction
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
 * @property {number} backupKeepCount
 * @property {number} backupKeepDays
 * @property {boolean=} help
 *
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} SqliteMaintenanceDeps
 * @property {(path: string) => boolean=} existsSync
 * @property {(path: string, options?: {recursive?: boolean}) => void=} mkdirSync
 * @property {(path: string, options?: {withFileTypes?: boolean}) => any[]=} readdirSync
 * @property {(path: string) => {size?: number, mtimeMs?: number}=} statSync
 * @property {(path: string, mode: number) => void=} chmodSync
 * @property {(path: string, encoding: BufferEncoding) => string=} readFileSync
 * @property {(path: string, data: string, options?: JsonObject) => void=} writeFileSync
 * @property {(path: string, options?: JsonObject) => void=} rmSync
 * @property {(cmd: string, args: string[], options: JsonObject) => {status: number | null, stdout?: string, stderr?: string, error?: NodeJS.ErrnoException}=} spawnSync
 * @property {() => Date=} now
 * @property {(dbPath: string, options: JsonObject) => {acquired: boolean, reason?: string, active_sync_locks?: number, lock_owner?: string | null}=} acquireMaintenanceLock
 * @property {(dbPath: string, owner: string) => void=} releaseMaintenanceLock
 * @property {string=} cwd
 *
 * @typedef {object} CliIo
 * @property {{write: (text: string) => unknown}=} stdout
 * @property {{write: (text: string) => unknown}=} stderr
 * @property {SqliteMaintenanceDeps=} deps
 */

function usage() {
  return `Usage: node scripts/sqlite-maintenance.mjs <check|backup|verify|prune-runs|compact> [options]

Options:
  --db <path>           SQLite database path. Default: ${DEFAULT_DB}
  --backup-dir <path>   Private backup directory. Default: ${DEFAULT_BACKUP_DIR}
  --backup <path>       Backup file to verify.
  --latest              Verify the newest backup in --backup-dir.
  --dry-run             For prune-runs: report only. This is the default.
  --apply               For prune-runs: actually delete eligible old no-op runs.
  --backup-keep-count <n>  Backups to retain after backup. Default: ${DEFAULT_BACKUP_KEEP_COUNT}
  --backup-keep-days <n>   Maximum backup age in days. Default: ${DEFAULT_BACKUP_KEEP_DAYS}
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
  if (["check", "backup", "verify", "prune-runs", "compact"].includes(value)) return /** @type {SqliteMaintenanceAction} */ (value);
  throw new Error("action must be check, backup, verify, prune-runs, or compact");
}

/** @param {unknown} value @param {string} name */
function parsePositiveInt(value, name) {
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${name} must be positive integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe positive integer`);
  return parsed;
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
      backupKeepCount: DEFAULT_BACKUP_KEEP_COUNT,
      backupKeepDays: DEFAULT_BACKUP_KEEP_DAYS,
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
    backupKeepCount: DEFAULT_BACKUP_KEEP_COUNT,
    backupKeepDays: DEFAULT_BACKUP_KEEP_DAYS,
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
    else if (arg === "--backup-keep-count")
      opts.backupKeepCount = parsePositiveInt(next, "backup-keep-count");
    else if (arg === "--backup-keep-days") opts.backupKeepDays = parsePositiveInt(next, "backup-keep-days");
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
 * @param {SqliteMaintenanceDeps} [deps]
 */
function acquireSqliteMaintenanceLock(dbPath, deps = {}, reason = "sqlite maintenance") {
  const owner = `pid:${process.pid}:sqlite-maintenance`;
  const acquire = deps.acquireMaintenanceLock || acquireMaintenanceLock;
  const result = acquire(dbPath, {
    owner,
    ttlSeconds: 1800,
    reason,
  });
  if (result.acquired) return owner;
  if (result.reason === "sync_locks_active") {
    throw new Error(
      `maintenance lock unavailable: ${result.active_sync_locks || 0} active sync lock(s); retry shortly or stop the worker`,
    );
  }
  throw new Error(
    "maintenance lock unavailable: held by another maintenance command",
  );
}

/** @param {unknown} error */
function publicMaintenanceError(error) {
  const message = String(error instanceof Error ? error.message : error || "");
  const safeMessages = [
    /^verify requires --latest or --backup <path>$/,
    /^use either --latest or --backup, not both$/,
    /^--(?:dry-run|apply) is only supported for prune-runs$/,
    /^--format must be text or json$/,
    /^action must be check, backup, verify, prune-runs, or compact$/,
    /^(?:backup-keep-count|backup-keep-days) must be (?:a safe )?positive integer$/,
    /^maintenance lock unavailable: \d+ active sync lock\(s\); retry shortly or stop the worker$/,
    /^maintenance lock unavailable: held by another maintenance command$/,
  ];
  if (safeMessages.some((pattern) => pattern.test(message))) return new Error(message);
  return publicDiagnosticError(error, "SQLite maintenance failed");
}

/**
 * @param {string} dbPath
 * @param {string | null} owner
 * @param {SqliteMaintenanceDeps} [deps]
 */
function releaseSqliteMaintenanceLock(dbPath, owner, deps = {}) {
  if (!owner) return;
  const release = deps.releaseMaintenanceLock || releaseMaintenanceLock;
  release(dbPath, owner);
}

/**
 * @param {{status: number | null, stderr?: unknown, error?: NodeJS.ErrnoException}} result
 * @param {string} label
 */
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
    input: `.bail on\n.timeout 5000\nPRAGMA foreign_keys = ON;\n${sql}`,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw sqliteFailure(result, label);
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
    input: `.bail on\n.timeout 5000\nPRAGMA foreign_keys = ON;\n${sql}`,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw sqliteFailure(result, label);
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
  if (!fileExists(dbPath)) throw new Error("database not found");

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
  const pageSize = Number(firstCell(sqliteJson(dbPath, "PRAGMA page_size;", "page size", deps)) || 0);
  const pageCount = Number(firstCell(sqliteJson(dbPath, "PRAGMA page_count;", "page count", deps)) || 0);
  const freelistCount = Number(firstCell(sqliteJson(dbPath, "PRAGMA freelist_count;", "freelist count", deps)) || 0);
  const ok = quickCheck === "ok" && foreignKeyIssues.length === 0 && missingTables.length === 0;
  return {
    ok,
    quick_check: quickCheck,
    foreign_key_issues: foreignKeyIssues.length,
    missing_tables: missingTables,
    counts,
    size_bytes: Number(stat.size || 0),
    page_size: pageSize,
    page_count: pageCount,
    freelist_count: freelistCount,
    reclaimable_bytes: pageSize * freelistCount,
  };
}

/**
 * Old success runs that changed no durable record are diagnostic noise, not
 * durable memory. Keep failures, running/cancelled runs, mutating successes,
 * and each scope's current success.
 * @param {string} dbPath
 * @param {string} cutoffAt
 * @param {boolean} dryRun
 * @param {SqliteMaintenanceDeps} [deps]
 */
function pruneNoopSuccessfulRuns(dbPath, cutoffAt, dryRun, deps = {}) {
  const eligibleWhere = `
    r.status = 'succeeded'
    AND r.started_at < ${quoteSql(cutoffAt)}
    AND r.inserted_count = 0
    AND r.updated_count = 0
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
  sqliteExec(
    backupPath,
    "BEGIN IMMEDIATE; DELETE FROM sync_locks; DELETE FROM maintenance_locks; COMMIT;",
    "remove ephemeral locks from backup",
    deps,
  );
  const chmod = deps.chmodSync || chmodSync;
  chmod(backupPath, 0o600);
}

/** @param {string} path */
function sha256File(path) {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, "r");
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) digest.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(fd);
  }
  return digest.digest("hex");
}

/** @param {string} backupPath */
function backupManifestPath(backupPath) {
  return `${backupPath}.manifest.json`;
}

/**
 * @param {string} backupPath
 * @param {JsonObject} backupCheck
 * @param {string} createdAt
 * @param {SqliteMaintenanceDeps} [deps]
 */
function writeBackupManifest(backupPath, backupCheck, createdAt, deps = {}) {
  const fileStat = deps.statSync || statSync;
  const writeFile = deps.writeFileSync || writeFileSync;
  const chmod = deps.chmodSync || chmodSync;
  const manifest = {
    kind: "exocortex.sqlite-backup-manifest/v1",
    created_at: createdAt,
    backup_file: basename(backupPath),
    sha256: sha256File(backupPath),
    size_bytes: Number(fileStat(backupPath).size || 0),
    counts: backupCheck.counts,
  };
  const path = backupManifestPath(backupPath);
  writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmod(path, 0o600);
  return manifest;
}

/**
 * @param {string} backupPath
 * @param {JsonObject} backupCheck
 * @param {SqliteMaintenanceDeps} [deps]
 */
function verifyBackupManifest(backupPath, backupCheck, deps = {}) {
  const fileExists = deps.existsSync || existsSync;
  const readFile = deps.readFileSync || readFileSync;
  const fileStat = deps.statSync || statSync;
  const path = backupManifestPath(backupPath);
  if (!fileExists(path)) {
    return { ok: false, status: "missing", path: basename(path) };
  }
  try {
    const manifest = JSON.parse(String(readFile(path, "utf8")));
    const actualSha256 = sha256File(backupPath);
    const actualSize = Number(fileStat(backupPath).size || 0);
    const checks = {
      kind: manifest.kind === "exocortex.sqlite-backup-manifest/v1",
      backup_file: manifest.backup_file === basename(backupPath),
      sha256: manifest.sha256 === actualSha256,
      size: Number(manifest.size_bytes) === actualSize,
      counts: compareCounts(manifest.counts || {}, backupCheck.counts || {}),
    };
    return {
      ok: Object.values(checks).every(Boolean),
      status: Object.values(checks).every(Boolean) ? "verified" : "mismatch",
      checks,
      path: basename(path),
    };
  } catch (error) {
    return {
      ok: false,
      status: "invalid",
      path: basename(path),
      error: "manifest could not be verified",
    };
  }
}

/** @param {string} backupPath @param {SqliteMaintenanceDeps} [deps] */
function discardBackup(backupPath, deps = {}) {
  const remove = deps.rmSync || rmSync;
  remove(backupPath, { force: true });
  remove(backupManifestPath(backupPath), { force: true });
}

/**
 * @param {string} backupDir
 * @param {number} keepCount
 * @param {number} keepDays
 * @param {Date} now
 * @param {SqliteMaintenanceDeps} [deps]
 * @param {string} [protectedPath]
 */
function pruneBackups(backupDir, keepCount, keepDays, now, deps = {}, protectedPath = "") {
  const readDir = deps.readdirSync || readdirSync;
  const fileStat = deps.statSync || statSync;
  const remove = deps.rmSync || rmSync;
  const chmod = deps.chmodSync || chmodSync;
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  const backups = readDir(backupDir)
    .map((name) => resolve(backupDir, String(name)))
    .filter((path) => path.endsWith(".sqlite"))
    .map((path) => ({ path, mtimeMs: Number(fileStat(path).mtimeMs || 0) }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
  const removed = [];
  for (const [index, backup] of backups.entries()) {
    chmod(backup.path, 0o600);
    if ((deps.existsSync || existsSync)(backupManifestPath(backup.path))) {
      chmod(backupManifestPath(backup.path), 0o600);
    }
    if (protectedPath && resolve(backup.path) === resolve(protectedPath)) continue;
    if (index < keepCount && backup.mtimeMs >= cutoff) continue;
    remove(backup.path, { force: true });
    remove(backupManifestPath(backup.path), { force: true });
    removed.push(basename(backup.path));
  }
  return { keep_count: keepCount, keep_days: keepDays, removed_count: removed.length, removed };
}

/**
 * @param {string} backupDir
 * @param {SqliteMaintenanceDeps} [deps]
 */
function latestBackupPath(backupDir, deps = {}) {
  const fileExists = deps.existsSync || existsSync;
  const readDir = deps.readdirSync || readdirSync;
  const fileStat = deps.statSync || statSync;
  if (!fileExists(backupDir)) throw new Error("backup directory not found");
  const files = readDir(backupDir)
    .map((name) => resolve(backupDir, String(name)))
    .filter((path) => path.endsWith(".sqlite"))
    .map((path) => ({ path, mtimeMs: Number(fileStat(path).mtimeMs || 0) }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
  if (files.length === 0) throw new Error("no SQLite backups found");
  return files[0].path;
}

/**
 * @param {Record<string, number>} left
 * @param {Record<string, number>} right
 */
function compareCounts(left, right, tables = TRACKED_TABLES) {
  return tables.every((name) => Number(left[name] || 0) === Number(right[name] || 0));
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
    const chmod = deps.chmodSync || chmodSync;
    let lockOwner = null;
    /** @type {string | null} */
    let pendingBackupPath = null;
    let verifiedBackup = false;
    try {
      lockOwner = acquireSqliteMaintenanceLock(dbPath, deps, "sqlite maintenance backup");
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
      makeDir(backupDir, { recursive: true, mode: 0o700 });
      chmod(backupDir, 0o700);
      const createdAt = now();
      const backupPath = resolve(backupDir, `exocortex-${timestampForFile(createdAt)}.sqlite`);
      pendingBackupPath = backupPath;
      backupDatabase(dbPath, backupPath, deps);
      const backupCheck = databaseCheck(backupPath, deps);
      const countsMatch = compareCounts(source.counts, backupCheck.counts, DURABLE_BACKUP_TABLES);
      const manifest = writeBackupManifest(backupPath, backupCheck, createdAt.toISOString(), deps);
      const manifestVerification = verifyBackupManifest(backupPath, backupCheck, deps);
      const ok = backupCheck.ok && countsMatch && manifestVerification.ok;
      verifiedBackup = ok;
      const retention = ok
        ? pruneBackups(
            backupDir,
            opts.backupKeepCount,
            opts.backupKeepDays,
            createdAt,
            deps,
            backupPath,
          )
        : {
            keep_count: opts.backupKeepCount,
            keep_days: opts.backupKeepDays,
            removed_count: 0,
            removed: [],
            skipped: "new_backup_failed_validation",
          };
      if (!ok) discardBackup(backupPath, deps);
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
        manifest: { ...manifestVerification, sha256: manifest.sha256 },
        retention,
        backup_discarded: !ok,
      };
    } catch (error) {
      if (pendingBackupPath && !verifiedBackup) discardBackup(pendingBackupPath, deps);
      throw error;
    } finally {
      releaseSqliteMaintenanceLock(dbPath, lockOwner, deps);
    }
  }

  if (opts.action === "prune-runs") {
    let lockOwner = null;
    try {
      if (!opts.dryRun) lockOwner = acquireSqliteMaintenanceLock(dbPath, deps, "sqlite maintenance prune-runs");
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
        maintenance_lock: lockOwner ? "acquired" : "not_required",
      };
    } finally {
      releaseSqliteMaintenanceLock(dbPath, lockOwner, deps);
    }
  }

  if (opts.action === "compact") {
    let lockOwner = null;
    try {
      lockOwner = acquireSqliteMaintenanceLock(dbPath, deps, "sqlite maintenance compact");
      const before = databaseCheck(dbPath, deps);
      if (!before.ok) {
        return { ok: false, status: "failed", action: opts.action, checked_at: checkedAt, db_path: publicPath(cwd, dbPath), before };
      }
      sqliteExec(dbPath, "PRAGMA optimize; VACUUM;", "compact database", deps);
      const after = databaseCheck(dbPath, deps);
      return {
        ok: after.ok,
        status: after.ok ? "ok" : "failed",
        action: opts.action,
        checked_at: checkedAt,
        db_path: publicPath(cwd, dbPath),
        before,
        after,
        reclaimed_bytes: Math.max(0, Number(before.size_bytes || 0) - Number(after.size_bytes || 0)),
      };
    } finally {
      releaseSqliteMaintenanceLock(dbPath, lockOwner, deps);
    }
  }

  if (!opts.latest && !opts.backup) throw new Error("verify requires --latest or --backup <path>");
  const backupPath = resolve(opts.backup || latestBackupPath(backupDir, deps));
  const backupCheck = databaseCheck(backupPath, deps);
  const manifest = verifyBackupManifest(backupPath, backupCheck, deps);
  const ok = backupCheck.ok && manifest.ok;
  return {
    ok,
    status: ok ? "ok" : "failed",
    action: opts.action,
    checked_at: checkedAt,
    db_path: publicPath(cwd, dbPath),
    backup_path: publicPath(cwd, backupPath),
    backup_check: backupCheck,
    manifest,
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
      ["Manifest", report.manifest?.status || ""],
      ["Reclaimed", report.reclaimed_bytes === undefined ? "" : `${report.reclaimed_bytes} bytes`],
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
  if (report.retention) {
    lines.push("");
    lines.push(section("Backup retention"));
    lines.push(kv([
      ["Policy", `${report.retention.keep_count} files / ${report.retention.keep_days} days`],
      ["Removed", report.retention.removed_count],
    ]));
  }
  const check = report.after || report.backup_check || report.check || report.source_check || report.before;
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
    stderr.write(renderError(publicMaintenanceError(error)));
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
  DEFAULT_BACKUP_KEEP_COUNT,
  DEFAULT_BACKUP_KEEP_DAYS,
  DEFAULT_PRUNE_RUNS_RETENTION_DAYS,
  TRACKED_TABLES,
  acquireSqliteMaintenanceLock,
  compareCounts,
  backupManifestPath,
  databaseCheck,
  executeSqliteMaintenance,
  latestBackupPath,
  main,
  parseArgs,
  parsePositiveInt,
  pruneBackups,
  pruneNoopSuccessfulRuns,
  publicPath,
  releaseSqliteMaintenanceLock,
  renderSqliteMaintenanceText,
  runSqliteMaintenanceCli,
  timestampForFile,
  verifyBackupManifest,
  writeBackupManifest,
  usage,
};
