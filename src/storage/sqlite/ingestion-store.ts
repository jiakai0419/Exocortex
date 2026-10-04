import { spawnSync } from "node:child_process";
import { mergeLarkNameProjectionSql } from "./lark-name-projection.js";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import {
  dirname,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, any>;

type SyncScope = {
  id: string;
  source_id: string;
  name?: string;
  enabled?: number;
  config_json?: string;
  cursor_json?: string | null;
  config?: JsonObject;
  cursor?: JsonObject | null;
};

type StoredRecord = {
  source_id: string;
  first_seen_scope_id: string;
  external_id: string;
  external_version: string | null;
  record_type: string;
  occurred_at: string | null;
  occurred_at_ms: number;
  actor_id: string | null;
  container_id: string | null;
  direction: string | null;
  title: string | null;
  body: string;
  content_hash: string;
  canonical_json: string;
  raw_json: string;
};

type WriteEffects = {
  inserted: number;
  updated: number;
  duplicate: number;
};

type BoundedReplayOptions = {
  scope: SyncScope;
  initialSyncStartMs: number;
  startMs: number;
  endMs: number;
  planId: string;
  attemptId: string;
  selfIdHash: string;
  pages: number;
  fetchedCount: number;
  records: StoredRecord[];
};

type MaintenanceLockOptions = {
  owner?: string;
  ttlSeconds?: number;
  reason?: string;
  now?: Date;
};

type MaintenanceLockResult = {
  acquired: boolean;
  reason?: "sync_locks_active" | "maintenance_locked";
  active_sync_locks?: number;
  lock_owner?: string | null;
};

type OwnerState = "alive" | "dead" | "unknown";

type RecoveryOptions = {
  scopeId?: string | null;
  now?: Date;
  ownerState?: (owner: string) => OwnerState;
  orphanRunSeconds?: number;
  hardLeaseSeconds?: number;
};

type SqliteRow = Record<string, any>;

type InitialSyncStartOptions = {
  explicit?: boolean;
  endMs?: number;
};

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_HARD_LEASE_SECONDS = 60 * 60;
const DEFAULT_IMPLICIT_RUN_LOCK_SECONDS = 10 * 60;
const PROCESS_STARTED_AT_MS = Math.max(0, Math.floor(Date.now() - process.uptime() * 1000));
const PROCESS_START_MATCH_TOLERANCE_MS = 5_000;
const DEFAULT_SYNC_LOCK_OWNER = `pid:${process.pid}:started:${PROCESS_STARTED_AT_MS}`;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const INITIALIZER_PATH = resolve(PROJECT_ROOT, "scripts/init-ingestion-core.mjs");
const RUN_FENCE_METADATA_KEY = "__run_fence";

function quoteSql(value: unknown) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value: unknown) {
  return quoteSql(JSON.stringify(value));
}

function chmodIfPresent(path: string, mode: number) {
  try {
    if (existsSync(path)) chmodSync(path, mode);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw error;
  }
}

function prepareWritableDatabasePaths(dbPath: string, protectExistingDirectory = false) {
  const resolvedDbPath = resolve(dbPath);
  const dbDir = dirname(resolvedDbPath);
  mkdirSync(dbDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  // Ordinary store writes may target a DB in a shared directory. Tightening
  // that existing directory is reserved for explicit initialization/security.
  if (protectExistingDirectory) chmodSync(dbDir, PRIVATE_DIRECTORY_MODE);
  for (const path of [resolvedDbPath, `${resolvedDbPath}-wal`, `${resolvedDbPath}-shm`, `${resolvedDbPath}-journal`]) {
    chmodIfPresent(path, PRIVATE_FILE_MODE);
  }
  return resolvedDbPath;
}

function secureDatabasePaths(dbPath: string) {
  return prepareWritableDatabasePaths(dbPath, true);
}

function withPrivateUmask<T>(work: () => T) {
  const previous = process.umask(0o077);
  try {
    return work();
  } finally {
    process.umask(previous);
  }
}

function sqliteFailure(result: ReturnType<typeof spawnSync>, label: string) {
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ENOENT") {
    return new Error(`${label} failed: sqlite3 executable not found (ENOENT); install SQLite and ensure sqlite3 is on PATH`);
  }
  const stderr = String(result.stderr || "").trim();
  const detail = stderr || error?.message || `sqlite3 exited with status ${String(result.status)}`;
  return new Error(`${label} failed: ${detail}`);
}

function sqliteExec(dbPath: string, sql: string, label: string) {
  const resolvedDbPath = prepareWritableDatabasePaths(dbPath);
  let result;
  try {
    result = withPrivateUmask(() =>
      spawnSync("sqlite3", [resolvedDbPath], {
        input: `.bail on\n.timeout 5000\nPRAGMA foreign_keys = ON;\n${sql}`,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      }),
    );
  } finally {
    prepareWritableDatabasePaths(resolvedDbPath);
  }
  if (result.status !== 0 || result.error) throw sqliteFailure(result, label);
  return String(result.stdout || "");
}

function sqliteQuery(dbPath: string, sql: string, label: string): SqliteRow[] {
  const resolvedDbPath = prepareWritableDatabasePaths(dbPath);
  let result;
  try {
    result = withPrivateUmask(() =>
      spawnSync("sqlite3", ["-json", resolvedDbPath], {
        input: `.bail on\n.timeout 5000\nPRAGMA foreign_keys = ON;\n${sql}`,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      }),
    );
  } finally {
    prepareWritableDatabasePaths(resolvedDbPath);
  }
  if (result.status !== 0 || result.error) throw sqliteFailure(result, label);
  const trimmed = String(result.stdout || "").trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

function ownerPid(owner: string) {
  const match = String(owner || "").match(/^pid:(\d+)(?::|$)/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function ownerStartedAtMs(owner: string) {
  const match = String(owner || "").match(/^pid:\d+:started:(\d+)(?::|$)/);
  if (!match) return null;
  const startedAtMs = Number(match[1]);
  return Number.isSafeInteger(startedAtMs) && startedAtMs > 0 ? startedAtMs : null;
}

function observedProcessStartedAtMs(pid: number) {
  if (pid === process.pid) return PROCESS_STARTED_AT_MS;
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 2_000,
    killSignal: "SIGKILL",
  });
  if (result.status !== 0 || result.error) return null;
  const startedAtMs = Date.parse(String(result.stdout || "").trim());
  return Number.isFinite(startedAtMs) ? startedAtMs : null;
}

function defaultOwnerState(owner: string): OwnerState {
  const pid = ownerPid(owner);
  if (!pid) return "unknown";
  try {
    process.kill(pid, 0);
    const expectedStartedAtMs = ownerStartedAtMs(owner);
    if (expectedStartedAtMs !== null) {
      const observedStartedAt = observedProcessStartedAtMs(pid);
      if (
        observedStartedAt !== null &&
        Math.abs(observedStartedAt - expectedStartedAtMs) > PROCESS_START_MATCH_TOLERANCE_MS
      ) {
        return "dead";
      }
    }
    return "alive";
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ESRCH") return "dead";
    if (err.code === "EPERM") return "alive";
    return "unknown";
  }
}

function normalizeOwnerState(value: unknown): OwnerState {
  const state = String(value);
  return state === "alive" || state === "dead" || state === "unknown" ? state : "unknown";
}

function recoverStaleSyncState(dbPath: string, options: RecoveryOptions = {}) {
  const {
    scopeId = null,
    now = new Date(),
    ownerState = defaultOwnerState,
    orphanRunSeconds = 600,
    hardLeaseSeconds = DEFAULT_HARD_LEASE_SECONDS,
  } = options;
  if (!Number.isFinite(hardLeaseSeconds) || hardLeaseSeconds <= 0) {
    throw new Error(`hardLeaseSeconds must be positive: ${String(hardLeaseSeconds)}`);
  }
  if (!Number.isFinite(orphanRunSeconds) || orphanRunSeconds <= 0) {
    throw new Error(`orphanRunSeconds must be positive: ${String(orphanRunSeconds)}`);
  }
  if (scopeId !== null && (typeof scopeId !== "string" || !scopeId.trim())) {
    throw new Error("scopeId must be a non-empty string or null");
  }
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const hardLeaseCutoffIso = new Date(nowMs - hardLeaseSeconds * 1000).toISOString();
  const orphanCutoffIso = new Date(nowMs - orphanRunSeconds * 1000).toISOString();
  const scopeWhere = scopeId === null ? "" : `WHERE l.scope_id = ${quoteSql(scopeId)}`;
  const locks = sqliteQuery(
    dbPath,
    `SELECT l.scope_id, s.source_id, l.locked_by, l.locked_at, l.expires_at
     FROM sync_locks l
     JOIN sync_scopes s ON s.id = l.scope_id
     ${scopeWhere}
     ORDER BY l.locked_at;`,
    "read sync locks for recovery",
  );

  // Process liveness is only a hint for the observed lease. Revalidate its full
  // identity under the write transaction before selecting any recovery target.
  const ownerStates = new Map<string, OwnerState>();
  const observations = locks.map((lock) => {
    const owner = String(lock.locked_by || "");
    if (!ownerStates.has(owner)) ownerStates.set(owner, normalizeOwnerState(ownerState(owner)));
    return `(${[lock.scope_id, lock.source_id, owner, lock.locked_at, lock.expires_at,
      ownerStates.get(owner) || "unknown"].map(quoteSql).join(", ")})`;
  });
  const orphanScopeWhere = scopeId === null ? "" : `AND r.scope_id = ${quoteSql(scopeId)}`;
  const rows = sqliteQuery(
    dbPath,
    `BEGIN IMMEDIATE;
CREATE TEMP TABLE __recovery_observations (
  scope_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, locked_by TEXT NOT NULL,
  locked_at TEXT NOT NULL, expires_at TEXT NOT NULL, owner_state TEXT NOT NULL
);
${observations.length ? `INSERT INTO __recovery_observations VALUES ${observations.join(",\n")};` : ""}
CREATE TEMP TABLE __recovery_current_locks AS
SELECT l.scope_id, s.source_id, l.locked_by, l.locked_at, l.expires_at,
       o.owner_state,
       CASE
         WHEN o.owner_state = 'dead' THEN 'owner_dead'
         WHEN julianday(l.locked_at) IS NULL
           OR julianday(l.locked_at) <= julianday(${quoteSql(hardLeaseCutoffIso)}) THEN 'hard_lease_exceeded'
         WHEN julianday(l.expires_at) <= julianday(${quoteSql(nowIso)})
           AND o.owner_state <> 'alive' THEN 'lock_expired'
       END AS reason
FROM sync_locks l
JOIN sync_scopes s ON s.id = l.scope_id
JOIN __recovery_observations o
  ON o.scope_id = l.scope_id AND o.source_id = s.source_id
 AND o.locked_by = l.locked_by AND o.locked_at = l.locked_at
 AND o.expires_at = l.expires_at;
CREATE TEMP TABLE __recovery_runs (
  id INTEGER PRIMARY KEY, error_type TEXT NOT NULL, error_message TEXT NOT NULL
);
INSERT INTO __recovery_runs
SELECT r.id, 'StaleLock', 'Recovered stale lock ' || l.locked_by || ': ' || l.reason
FROM sync_runs r
JOIN __recovery_current_locks l ON l.scope_id = r.scope_id AND l.source_id = r.source_id
WHERE r.status = 'running' AND l.reason IS NOT NULL
  AND json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.owner') = l.locked_by
  AND json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.locked_at') = l.locked_at;
-- Select orphans before deleting stale locks. Unfenced legacy runs must first
-- become genuinely lock-free and old enough; never guess their lock ownership.
INSERT INTO __recovery_runs
SELECT r.id, 'StaleRun', 'Recovered running run without an active lock'
FROM sync_runs r
JOIN sync_scopes s ON s.id = r.scope_id AND s.source_id = r.source_id
WHERE r.status = 'running'
  ${orphanScopeWhere}
  AND julianday(r.started_at) <= julianday(${quoteSql(orphanCutoffIso)})
  AND NOT EXISTS (SELECT 1 FROM sync_locks l WHERE l.scope_id = r.scope_id);
CREATE TEMP TABLE __recovery_counts (cancelled_runs INTEGER, recovered_locks INTEGER);
INSERT INTO __recovery_counts VALUES (0, 0);
UPDATE sync_runs
SET status = 'cancelled',
    finished_at = ${quoteSql(nowIso)},
    error_type = (SELECT error_type FROM __recovery_runs WHERE id = sync_runs.id),
    error_message = (SELECT error_message FROM __recovery_runs WHERE id = sync_runs.id)
WHERE id IN (SELECT id FROM __recovery_runs)
  AND status = 'running';
UPDATE __recovery_counts SET cancelled_runs = changes();
DELETE FROM sync_locks
WHERE EXISTS (
  SELECT 1 FROM __recovery_current_locks l
  WHERE l.reason IS NOT NULL AND l.scope_id = sync_locks.scope_id
    AND l.locked_by = sync_locks.locked_by AND l.locked_at = sync_locks.locked_at
    AND l.expires_at = sync_locks.expires_at
);
UPDATE __recovery_counts SET recovered_locks = changes();
SELECT recovered_locks, cancelled_runs,
       (SELECT COUNT(*) FROM __recovery_current_locks
        WHERE reason IS NULL AND owner_state = 'alive'
          AND julianday(expires_at) <= julianday(${quoteSql(nowIso)})) AS active_expired_locks
FROM __recovery_counts;
COMMIT;
`,
    "recover stale sync state",
  );

  return {
    recovered_locks: Number(rows[0]?.recovered_locks || 0),
    cancelled_runs: Number(rows[0]?.cancelled_runs || 0),
    active_expired_locks: Number(rows[0]?.active_expired_locks || 0),
  };
}

function ensureInitialized(dbPath: string) {
  const resolvedDbPath = secureDatabasePaths(dbPath);
  let result;
  try {
    result = withPrivateUmask(() =>
      spawnSync(process.execPath, [INITIALIZER_PATH, "--db", resolvedDbPath], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }),
    );
  } finally {
    secureDatabasePaths(resolvedDbPath);
  }
  const error = result.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ENOENT") {
    throw new Error(`failed to launch Node initializer (ENOENT): ${process.execPath}`);
  }
  if (result.status !== 0 || error) {
    throw new Error(String(result.stderr || "").trim() || error?.message || "failed to initialize ingestion core");
  }
}

function readScope(dbPath: string, scopeId: string): SyncScope {
  const rows = sqliteQuery(
    dbPath,
    `SELECT id, source_id, name, enabled, config_json, cursor_json
     FROM sync_scopes
     WHERE id = ${quoteSql(scopeId)}
     LIMIT 1;`,
    `read scope ${scopeId}`,
  );
  if (!rows[0]) throw new Error(`sync scope not found: ${scopeId}`);
  const row = rows[0] as SyncScope;
  return {
    ...row,
    config: row.config_json ? JSON.parse(row.config_json) : {},
    cursor: row.cursor_json ? JSON.parse(row.cursor_json) : null,
  };
}

function validateInitialSyncStartMs(value: unknown): number {
  // This modern source baseline uses milliseconds, never seconds. Restrict the
  // range to unambiguous modern millisecond values and four-digit ISO years.
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 100_000_000_000 ||
    value > 253_402_300_799_999 ||
    !Number.isFinite(new Date(value).getTime())
  ) {
    throw new Error("initial_sync_start_ms must be a safe modern epoch-millisecond timestamp (100000000000..253402300799999), not seconds");
  }
  return value;
}

function ensureSourceInitialSyncStart(
  dbPath: string,
  sourceId: string,
  candidateStartMs: number,
  options: InitialSyncStartOptions = {},
): number {
  const candidate = validateInitialSyncStartMs(candidateStartMs);
  if (options.endMs !== undefined && (!Number.isSafeInteger(options.endMs) || !Number.isFinite(new Date(options.endMs).getTime()))) {
    throw new Error("initial sync end must be a valid epoch-millisecond timestamp");
  }
  const candidateFitsEnd = options.endMs === undefined || candidate <= options.endMs;
  const sourceSql = quoteSql(sourceId);
  const now = new Date().toISOString();
  const hasHistorySql = `(
    EXISTS (SELECT 1 FROM records WHERE source_id = ${sourceSql})
    OR EXISTS (SELECT 1 FROM sync_runs WHERE source_id = ${sourceSql})
    OR EXISTS (SELECT 1 FROM sync_scopes WHERE source_id = ${sourceSql} AND cursor_json IS NOT NULL)
  )`;
  const activeSyncSql = `EXISTS (
    SELECT 1 FROM sync_locks l JOIN sync_scopes s ON s.id = l.scope_id
    WHERE s.source_id = ${sourceSql}
  )`;
  const maintenanceSql = `EXISTS (
    SELECT 1 FROM maintenance_locks WHERE name = 'global' AND expires_at > ${quoteSql(now)}
  )`;
  const rows = sqliteQuery(
    dbPath,
    `BEGIN IMMEDIATE;
     UPDATE sources
     SET config_json = json_set(config_json, '$.initial_sync_start_ms', ${candidate}),
         updated_at = ${quoteSql(now)}
     WHERE id = ${sourceSql}
       AND enabled = 1
       AND json_type(config_json) = 'object'
       AND json_type(config_json, '$.initial_sync_start_ms') IS NULL
       AND ${candidateFitsEnd ? 1 : 0} = 1
       AND (${options.explicit === true ? 1 : 0} = 1 OR NOT ${hasHistorySql})
       AND NOT ${activeSyncSql}
       AND NOT ${maintenanceSql};
     SELECT config_json, enabled, ${hasHistorySql} AS has_history,
            ${activeSyncSql} AS active_sync, ${maintenanceSql} AS maintenance_locked
     FROM sources WHERE id = ${sourceSql};
     COMMIT;`,
    "resolve initial sync baseline",
  );
  const row = rows[0];
  if (!row) throw new Error(`source not found: ${sourceId}`);
  const config: unknown = JSON.parse(row.config_json);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("source config must be a JSON object for initial sync baseline");
  }
  if (!Object.prototype.hasOwnProperty.call(config, "initial_sync_start_ms")) {
    if (!candidateFitsEnd) throw new Error("--end must be after the initial sync baseline");
    if (!row.enabled) throw new Error("cannot initialize sync baseline for a disabled source");
    if (row.active_sync || row.maintenance_locked) throw new Error("cannot initialize sync baseline while sync or maintenance is active");
    throw new Error("source has existing sync history but no initial sync baseline; explicitly confirm it with --start <ISO with timezone>");
  }
  const baseline = validateInitialSyncStartMs((config as JsonObject).initial_sync_start_ms);
  if (options.explicit === true && candidate !== baseline) {
    throw new Error(`--start conflicts with persisted initial sync baseline ${new Date(baseline).toISOString()}`);
  }
  if (options.endMs !== undefined && options.endMs < baseline) {
    throw new Error("--end must be after the persisted initial sync baseline");
  }
  return baseline;
}

function maintenanceOwner(owner = `pid:${process.pid}`) {
  return owner;
}

function isMaintenanceLocked(dbPath: string, now = new Date()) {
  try {
    const rows = sqliteQuery(
      dbPath,
      `SELECT COUNT(*) AS count
       FROM maintenance_locks
       WHERE name = 'global'
         AND expires_at > ${quoteSql(now.toISOString())};`,
      "read maintenance lock",
    );
    return Number(rows[0]?.count || 0) > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table: maintenance_locks/.test(message)) return false;
    throw error;
  }
}

function acquireMaintenanceLock(dbPath: string, options: MaintenanceLockOptions = {}): MaintenanceLockResult {
  const now = options.now || new Date();
  const owner = maintenanceOwner(options.owner);
  const ttlSeconds = options.ttlSeconds ?? 1800;
  const reason = options.reason || "maintenance";
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const rows = sqliteQuery(
    dbPath,
    `
BEGIN IMMEDIATE;
DELETE FROM maintenance_locks
WHERE expires_at <= ${quoteSql(nowIso)};
INSERT OR IGNORE INTO maintenance_locks (name, owner, acquired_at, expires_at, reason)
SELECT 'global', ${quoteSql(owner)}, ${quoteSql(nowIso)}, ${quoteSql(expiresIso)}, ${quoteSql(reason)}
WHERE NOT EXISTS (SELECT 1 FROM sync_locks);
SELECT
  changes() AS changed,
  (SELECT COUNT(*) FROM sync_locks) AS active_sync_locks,
  (SELECT owner FROM maintenance_locks WHERE name = 'global') AS lock_owner;
COMMIT;
`,
    "acquire maintenance lock",
  );
  const row = rows[0] || {};
  if (Number(row.changed || 0) > 0) return { acquired: true };
  const activeSyncLocks = Number(row.active_sync_locks || 0);
  if (activeSyncLocks > 0) {
    return { acquired: false, reason: "sync_locks_active", active_sync_locks: activeSyncLocks };
  }
  return {
    acquired: false,
    reason: "maintenance_locked",
    active_sync_locks: 0,
    lock_owner: row.lock_owner || null,
  };
}

function releaseMaintenanceLock(dbPath: string, owner = `pid:${process.pid}`) {
  sqliteExec(
    dbPath,
    `DELETE FROM maintenance_locks
     WHERE name = 'global'
       AND owner = ${quoteSql(owner)};`,
    "release maintenance lock",
  );
}

function acquireLock(dbPath: string, scopeId: string, ttlSeconds: number, owner = DEFAULT_SYNC_LOCK_OWNER) {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`ttlSeconds must be positive: ${String(ttlSeconds)}`);
  }
  const now = new Date();
  const boundedTtlSeconds = Math.min(ttlSeconds, DEFAULT_HARD_LEASE_SECONDS);
  const expires = new Date(now.getTime() + boundedTtlSeconds * 1000);
  recoverStaleSyncState(dbPath, { scopeId, now });
  try {
    const rows = sqliteQuery(
      dbPath,
      `
BEGIN IMMEDIATE;
DELETE FROM maintenance_locks
WHERE expires_at <= ${quoteSql(now.toISOString())};
INSERT INTO sync_locks (scope_id, locked_by, locked_at, expires_at)
SELECT ${quoteSql(scopeId)}, ${quoteSql(owner)}, ${quoteSql(now.toISOString())}, ${quoteSql(expires.toISOString())}
WHERE NOT EXISTS (
  SELECT 1
  FROM maintenance_locks
  WHERE name = 'global'
    AND expires_at > ${quoteSql(now.toISOString())}
);
SELECT changes() AS changed;
COMMIT;
`,
      `acquire lock ${scopeId}`,
    );
    return Number(rows[0]?.changed || 0) > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed: sync_locks\.scope_id/.test(message)) return false;
    throw error;
  }
}

function releaseLock(dbPath: string, scopeId: string, owner = DEFAULT_SYNC_LOCK_OWNER) {
  sqliteExec(
    dbPath,
    `DELETE FROM sync_locks WHERE scope_id = ${quoteSql(scopeId)} AND locked_by = ${quoteSql(owner)};`,
    `release lock ${scopeId}`,
  );
}

function scopeCursorJson(scope: SyncScope) {
  if (scope.cursor_json !== undefined) return scope.cursor_json;
  return scope.cursor === null || scope.cursor === undefined ? null : JSON.stringify(scope.cursor);
}

function validateRecordCursor(cursor: JsonObject | null | undefined, label: string) {
  if (cursor === null || cursor === undefined) return;
  if (typeof cursor !== "object" || Array.isArray(cursor)) {
    throw new Error(`${label} must be a JSON object or null`);
  }
  if (Object.prototype.hasOwnProperty.call(cursor, "created_at_ms")) {
    if (typeof cursor.created_at_ms !== "number" || !Number.isFinite(cursor.created_at_ms)) {
      throw new Error(`${label}.created_at_ms must be a finite number`);
    }
  }
}

function cursorCanAdvanceSql(beforeSql: string, incomingSql: string) {
  const beforeRootType = `json_type(${beforeSql})`;
  const beforeTimeType = `json_type(${beforeSql}, '$.created_at_ms')`;
  const incomingRootType = `json_type(${incomingSql})`;
  const incomingTimeType = `json_type(${incomingSql}, '$.created_at_ms')`;
  return `(
    ${beforeSql} IS NULL
    OR ${beforeRootType} = 'null'
    OR (
      ${incomingRootType} = 'object'
      AND (
        (${beforeRootType} = 'object' AND ${beforeTimeType} IS NULL)
        OR (
          ${beforeTimeType} IN ('integer', 'real')
          AND ${incomingTimeType} IN ('integer', 'real')
          AND CAST(json_extract(${incomingSql}, '$.created_at_ms') AS REAL)
              >= CAST(json_extract(${beforeSql}, '$.created_at_ms') AS REAL)
        )
      )
    )
  )`;
}

function checkedRunId(runId: number) {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error(`invalid run id: ${String(runId)}`);
  return runId;
}

function createRun(
  dbPath: string,
  scope: SyncScope,
  metadata: JsonObject = { runner: "scripts/lark-im-sync.mjs" },
  owner = DEFAULT_SYNC_LOCK_OWNER,
) {
  const expectedCursorJson = scopeCursorJson(scope);
  const expectedCursor =
    scope.cursor !== undefined
      ? scope.cursor
      : expectedCursorJson === null
        ? null
        : JSON.parse(expectedCursorJson);
  validateRecordCursor(expectedCursor, "scope cursor");
  const now = new Date();
  const expires = new Date(now.getTime() + DEFAULT_IMPLICIT_RUN_LOCK_SECONDS * 1000);
  const hardLeaseCutoff = new Date(now.getTime() - DEFAULT_HARD_LEASE_SECONDS * 1000).toISOString();
  const rows = sqliteQuery(
    dbPath,
    `BEGIN IMMEDIATE;
     CREATE TEMP TABLE __create_run_state (had_lock INTEGER NOT NULL);
     INSERT INTO __create_run_state (had_lock)
     SELECT EXISTS (SELECT 1 FROM sync_locks WHERE scope_id = ${quoteSql(scope.id)});
     INSERT OR IGNORE INTO sync_locks (scope_id, locked_by, locked_at, expires_at)
     SELECT
       ${quoteSql(scope.id)},
       ${quoteSql(owner)},
       ${quoteSql(now.toISOString())},
       ${quoteSql(expires.toISOString())}
     FROM __create_run_state
     WHERE had_lock = 0
       AND NOT EXISTS (
         SELECT 1
         FROM maintenance_locks
         WHERE name = 'global'
           AND expires_at > ${quoteSql(now.toISOString())}
       );
     INSERT INTO sync_runs (source_id, scope_id, status, cursor_before_json, metadata_json)
     SELECT
       s.source_id,
       s.id,
       'running',
       s.cursor_json,
       json_set(
         ${sqlJson(metadata)},
         '$.${RUN_FENCE_METADATA_KEY}.owner', l.locked_by,
         '$.${RUN_FENCE_METADATA_KEY}.locked_at', l.locked_at,
         '$.${RUN_FENCE_METADATA_KEY}.implicit', (SELECT had_lock = 0 FROM __create_run_state),
         '$.${RUN_FENCE_METADATA_KEY}.list_generation', COALESCE((SELECT generation FROM lark_im_list_progress WHERE scope_id = s.id), 0),
         '$.${RUN_FENCE_METADATA_KEY}.scope_config', json_object('chat_id', json_extract(s.config_json, '$.chat_id'))
       )
     FROM sync_scopes s
     JOIN sync_locks l ON l.scope_id = s.id
     WHERE s.id = ${quoteSql(scope.id)}
       AND s.source_id = ${quoteSql(scope.source_id)}
       AND s.cursor_json IS ${quoteSql(expectedCursorJson)}
       AND l.locked_by = ${quoteSql(owner)}
       AND julianday(l.locked_at) IS NOT NULL
       AND l.locked_at > ${quoteSql(hardLeaseCutoff)}
     RETURNING id;
     COMMIT;`,
    `create run ${scope.id}`,
  );
  if (!rows[0]?.id) {
    throw new Error(`create run ${scope.id} rejected: scope changed or current scope lock is not held`);
  }
  return checkedRunId(Number(rows[0].id));
}

function failRun(dbPath: string, scope: SyncScope, runId: number, error: Error) {
  const id = checkedRunId(runId);
  const finishedAt = new Date();
  const now = finishedAt.toISOString();
  const hardLeaseCutoff = new Date(
    finishedAt.getTime() - DEFAULT_HARD_LEASE_SECONDS * 1000,
  ).toISOString();
  const rows = sqliteQuery(
    dbPath,
    `
    BEGIN IMMEDIATE;
    CREATE TEMP TABLE __run_fence_guard (
      allowed INTEGER PRIMARY KEY,
      lock_owner TEXT NOT NULL,
      lock_acquired_at TEXT NOT NULL,
      implicit INTEGER NOT NULL
    );
    INSERT INTO __run_fence_guard (allowed, lock_owner, lock_acquired_at, implicit)
    SELECT
      1,
      l.locked_by,
      l.locked_at,
      COALESCE(json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.implicit'), 0)
    FROM sync_runs r
    JOIN sync_scopes s ON s.id = r.scope_id AND s.source_id = r.source_id
    JOIN sync_locks l ON l.scope_id = r.scope_id
    WHERE r.id = ${id}
      AND r.status = 'running'
      AND r.scope_id = ${quoteSql(scope.id)}
      AND r.source_id = ${quoteSql(scope.source_id)}
      AND l.locked_by = json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.owner')
      AND l.locked_at = json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.locked_at')
      AND julianday(l.locked_at) IS NOT NULL
      AND l.locked_at > ${quoteSql(hardLeaseCutoff)}
      AND s.cursor_json IS r.cursor_before_json;
    UPDATE sync_runs
    SET status = 'failed',
        finished_at = ${quoteSql(now)},
        error_type = ${quoteSql(error.name || "Error")},
        error_message = ${quoteSql(String(error.message || error).slice(0, 4000))}
    WHERE id = ${id}
      AND EXISTS (SELECT 1 FROM __run_fence_guard);
    UPDATE sync_scopes
    SET last_error_run_id = ${id},
        updated_at = ${quoteSql(now)}
    WHERE id = ${quoteSql(scope.id)}
      AND EXISTS (SELECT 1 FROM __run_fence_guard);
    DELETE FROM sync_locks
    WHERE scope_id = ${quoteSql(scope.id)}
      AND locked_by = (SELECT lock_owner FROM __run_fence_guard)
      AND locked_at = (SELECT lock_acquired_at FROM __run_fence_guard)
      AND (SELECT implicit FROM __run_fence_guard) = 1;
    SELECT COUNT(*) AS fenced FROM __run_fence_guard;
    COMMIT;
    `,
    `fail run ${id}`,
  );
  return Number(rows[0]?.fenced || 0) === 1;
}

function existingRecordMap(dbPath: string, sourceId: string, records: StoredRecord[]) {
  if (records.length === 0) return new Map();
  const ids = records.map((record) => quoteSql(record.external_id)).join(", ");
  const rows = sqliteQuery(
    dbPath,
    `SELECT external_id, content_hash
     FROM records
     WHERE source_id = ${quoteSql(sourceId)}
       AND external_id IN (${ids});`,
    "read existing records",
  );
  return new Map(rows.map((row) => [row.external_id, row.content_hash]));
}

function normalizeExternalVersion(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return BigInt(text).toString();
  return text;
}

function preferIncomingRecord(current: StoredRecord, incoming: StoredRecord) {
  const currentVersion = normalizeExternalVersion(current.external_version);
  const incomingVersion = normalizeExternalVersion(incoming.external_version);
  if (currentVersion === null && incomingVersion !== null) return true;
  if (currentVersion !== null && incomingVersion === null) return false;
  if (currentVersion === null && incomingVersion === null) return true;
  if (/^\d+$/.test(String(currentVersion)) && /^\d+$/.test(String(incomingVersion))) {
    return BigInt(String(incomingVersion)) >= BigInt(String(currentVersion));
  }
  // Opaque versions have no safe ordering rule. Preserve legacy batch behavior
  // by letting the later candidate win; persisted opaque versions only replace
  // an exact match in versionCanReplaceSql below.
  return true;
}

function normalizeStoredRecords(records: StoredRecord[], sourceId?: string) {
  const deduped = new Map<string, StoredRecord>();
  for (const original of records) {
    if (sourceId && original.source_id !== sourceId) {
      throw new Error(
        `record ${original.external_id} belongs to ${original.source_id}, expected source ${sourceId}`,
      );
    }
    const record = {
      ...original,
      external_version: normalizeExternalVersion(original.external_version),
    };
    const key = `${record.source_id}\u0000${record.external_id}`;
    const current = deduped.get(key);
    if (!current || preferIncomingRecord(current, record)) deduped.set(key, record);
  }
  return [...deduped.values()];
}

/** A repair must not silently choose between unordered conflicting page items. */
function normalizeBoundedReplayRecords(records: StoredRecord[], sourceId: string) {
  const seen = new Map<string, StoredRecord>();
  for (const original of records) {
    const incoming = { ...original, external_version: normalizeExternalVersion(original.external_version) };
    const current = seen.get(incoming.external_id);
    if (current && (current.raw_json !== incoming.raw_json || current.content_hash !== incoming.content_hash)) {
      const a = current.external_version;
      const b = incoming.external_version;
      if (a === null || b === null || !/^\d+$/.test(a) || !/^\d+$/.test(b) || a === b) {
        throw new Error("bounded replay response contains ambiguous duplicate facts");
      }
    }
    if (!current || preferIncomingRecord(current, incoming)) seen.set(incoming.external_id, incoming);
  }
  return normalizeStoredRecords(records, sourceId);
}

function numericVersionSql(valueSql: string) {
  return `(${valueSql} IS NOT NULL AND ${valueSql} <> '' AND ${valueSql} NOT GLOB '*[^0-9]*')`;
}

function normalizedNumericVersionSql(valueSql: string) {
  return `(CASE WHEN ltrim(${valueSql}, '0') = '' THEN '0' ELSE ltrim(${valueSql}, '0') END)`;
}

function versionCanReplaceSql(existingAlias: string, incomingAlias: string) {
  const existing = `${existingAlias}.external_version`;
  const incoming = `${incomingAlias}.external_version`;
  const existingNumeric = normalizedNumericVersionSql(existing);
  const incomingNumeric = normalizedNumericVersionSql(incoming);
  return `(
    ${existing} IS NULL
    OR (
      ${incoming} IS NOT NULL
      AND (
        ${incoming} = ${existing}
        OR (
          ${numericVersionSql(existing)}
          AND ${numericVersionSql(incoming)}
          AND (
            length(${incomingNumeric}) > length(${existingNumeric})
            OR (
              length(${incomingNumeric}) = length(${existingNumeric})
              AND ${incomingNumeric} >= ${existingNumeric} COLLATE BINARY
            )
          )
        )
      )
    )
  )`;
}

const MUTABLE_RECORD_COLUMNS = [
  "external_version",
  "record_type",
  "occurred_at",
  "occurred_at_ms",
  "actor_id",
  "container_id",
  "direction",
  "title",
  "body",
  "content_hash",
  "canonical_json",
  "raw_json",
];

function mergedCanonicalSql(existingAlias: string, incomingAlias: string) {
  const existing = existingAlias;
  const incoming = incomingAlias;
  return `(CASE WHEN ${existing}.source_id = 'lark.im' AND ${incoming}.source_id = 'lark.im'
    AND ${existing}.record_type = 'lark.im.message' AND ${incoming}.record_type = 'lark.im.message'
    THEN ${mergeLarkNameProjectionSql(`${existing}.canonical_json`, `${incoming}.canonical_json`,
      `${existing}.actor_id`, `${incoming}.actor_id`, `${existing}.container_id`, `${incoming}.container_id`)}
    ELSE ${incoming}.canonical_json END)`;
}

function recordDiffSql(existingAlias: string, incomingAlias: string) {
  return `(${MUTABLE_RECORD_COLUMNS.map(
    (column) => `${existingAlias}.${column} IS NOT ${column === "canonical_json"
      ? mergedCanonicalSql(existingAlias, incomingAlias) : `${incomingAlias}.${column}`}`,
  ).join(" OR ")})`;
}

function strictlyNewerVersionSql(existingAlias: string, incomingAlias: string) {
  const existing = `${existingAlias}.external_version`;
  const incoming = `${incomingAlias}.external_version`;
  const oldNumeric = normalizedNumericVersionSql(existing);
  const newNumeric = normalizedNumericVersionSql(incoming);
  return `(${numericVersionSql(existing)} AND ${numericVersionSql(incoming)} AND (
      length(${newNumeric}) > length(${oldNumeric}) OR (
        length(${newNumeric}) = length(${oldNumeric}) AND ${newNumeric} > ${oldNumeric} COLLATE BINARY
      )
  ))`;
}

function upsertRecordsSql(records: StoredRecord[], options: { strictVersionIncrease?: boolean } = {}) {
  return normalizeStoredRecords(records)
    .map(
      (record) => `
INSERT INTO records (
  source_id,
  first_seen_scope_id,
  external_id,
  external_version,
  record_type,
  occurred_at,
  occurred_at_ms,
  actor_id,
  container_id,
  direction,
  title,
  body,
  content_hash,
  canonical_json,
  raw_json,
  updated_at
)
VALUES (
  ${quoteSql(record.source_id)},
  ${quoteSql(record.first_seen_scope_id)},
  ${quoteSql(record.external_id)},
  ${quoteSql(record.external_version)},
  ${quoteSql(record.record_type)},
  ${quoteSql(record.occurred_at)},
  ${Number(record.occurred_at_ms)},
  ${quoteSql(record.actor_id)},
  ${quoteSql(record.container_id)},
  ${quoteSql(record.direction)},
  ${quoteSql(record.title)},
  ${quoteSql(record.body)},
  ${quoteSql(record.content_hash)},
  ${quoteSql(record.canonical_json)},
  ${quoteSql(record.raw_json)},
  ${quoteSql(new Date().toISOString())}
)
ON CONFLICT(source_id, external_id) DO UPDATE SET
  external_version = excluded.external_version,
  record_type = excluded.record_type,
  occurred_at = excluded.occurred_at,
  occurred_at_ms = excluded.occurred_at_ms,
  actor_id = excluded.actor_id,
  container_id = excluded.container_id,
  direction = excluded.direction,
  title = excluded.title,
  body = excluded.body,
  content_hash = excluded.content_hash,
  canonical_json = ${mergedCanonicalSql("records", "excluded")},
  raw_json = excluded.raw_json,
  updated_at = excluded.updated_at
WHERE ${(options.strictVersionIncrease ? strictlyNewerVersionSql : versionCanReplaceSql)("records", "excluded")}
  AND ${recordDiffSql("records", "excluded")};
`,
    )
    .join("\n");
}

/** Commit one completely fetched, explicitly bounded repair without touching
 * normal runs, scope cursors, or freshness markers. Remote work belongs outside
 * this method; only this short transaction holds a maintenance lease. */
function commitBoundedReplayRecords(dbPath: string, options: BoundedReplayOptions) {
  const { scope, initialSyncStartMs, startMs, endMs, planId, attemptId, selfIdHash, pages, fetchedCount } = options;
  validateInitialSyncStartMs(initialSyncStartMs);
  validateInitialSyncStartMs(startMs);
  validateInitialSyncStartMs(endMs);
  if (startMs < initialSyncStartMs || endMs <= startMs) throw new Error("invalid bounded replay window");
  if (scope.source_id !== "lark.im" || !scope.id.startsWith("lark.im.received.chat.") || scope.enabled !== 1) {
    throw new Error("bounded replay requires an enabled Lark received scope");
  }
  const config = JSON.parse(scope.config_json || "{}");
  if (!config || typeof config.chat_id !== "string" || !config.chat_id) throw new Error("bounded replay scope has no chat identity");
  if (!/^[a-f0-9]{64}$/.test(planId) || !/^[a-f0-9]{64}$/.test(selfIdHash) || !attemptId) {
    throw new Error("invalid bounded replay audit identity");
  }
  if (!Number.isSafeInteger(pages) || pages < 1 || !Number.isSafeInteger(fetchedCount) || fetchedCount < 0) {
    throw new Error("invalid bounded replay fetch evidence");
  }
  const records = normalizeBoundedReplayRecords(options.records, scope.source_id);
  if (records.length > 10_000 || records.length > fetchedCount) throw new Error("bounded replay candidate limit exceeded");
  for (const record of records) {
    if (record.record_type !== "lark.im.message" || record.first_seen_scope_id !== scope.id ||
        record.container_id !== config.chat_id || !Number.isSafeInteger(record.occurred_at_ms) ||
        record.occurred_at_ms < startMs || record.occurred_at_ms > endMs) {
      throw new Error("bounded replay candidate is outside the selected scope or window");
    }
  }
  // Never create or migrate a missing database as a side effect of a repair.
  const preflight = spawnSync("sqlite3", ["-readonly", resolve(dbPath)], {
    input: ".bail on\nPRAGMA query_only=ON;\nSELECT id FROM bounded_replay_runs LIMIT 0;\n",
    encoding: "utf8", timeout: 5000,
  });
  if (preflight.status !== 0 || preflight.error) throw new Error("bounded replay audit schema unavailable; migrate the existing database first");
  const auditId = randomUUID();
  const owner = `pid:${process.pid}:bounded-replay:${auditId}`;
  const lock = acquireMaintenanceLock(dbPath, { owner, ttlSeconds: 60, reason: "bounded Lark replay commit" });
  if (!lock.acquired) throw new Error("bounded replay commit blocked by active locks");
  try {
    const statements = records.map((record) => `
      DELETE FROM __replay_before;
      INSERT INTO __replay_before (existed, same_fact)
      SELECT EXISTS (SELECT 1 FROM records WHERE source_id=${quoteSql(record.source_id)} AND external_id=${quoteSql(record.external_id)}),
             EXISTS (SELECT 1 FROM records WHERE source_id=${quoteSql(record.source_id)} AND external_id=${quoteSql(record.external_id)}
               AND external_version IS ${quoteSql(record.external_version)}
               AND content_hash IS ${quoteSql(record.content_hash)} AND raw_json IS ${quoteSql(record.raw_json)});
      ${upsertRecordsSql([record], { strictVersionIncrease: true })}
      INSERT INTO __replay_effects (changed, existed, same_fact)
      SELECT changes(), existed, same_fact FROM __replay_before;
    `).join("\n");
    const rows = sqliteQuery(dbPath, `
      BEGIN IMMEDIATE;
      CREATE TEMP TABLE __replay_guard (allowed INTEGER NOT NULL CHECK (allowed=1));
      INSERT INTO __replay_guard SELECT CASE WHEN EXISTS (
        SELECT 1 FROM maintenance_locks WHERE name='global' AND owner=${quoteSql(owner)}
          AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      ) AND NOT EXISTS (SELECT 1 FROM sync_locks) AND EXISTS (
        SELECT 1 FROM sync_scopes s JOIN sources src ON src.id=s.source_id
        WHERE s.id=${quoteSql(scope.id)} AND s.source_id=${quoteSql(scope.source_id)}
          AND s.enabled=1 AND src.enabled=1 AND s.config_json IS ${quoteSql(scope.config_json)}
          AND json_extract(src.config_json,'$.initial_sync_start_ms') IS ${initialSyncStartMs}
      ) THEN 1 ELSE 0 END;
      CREATE TEMP TABLE __replay_before (existed INTEGER NOT NULL, same_fact INTEGER NOT NULL);
      CREATE TEMP TABLE __replay_effects (changed INTEGER NOT NULL, existed INTEGER NOT NULL, same_fact INTEGER NOT NULL);
      ${statements}
      INSERT INTO bounded_replay_runs (
        id,plan_id,attempt_id,source_id,scope_id,initial_sync_start_ms,window_start_ms,window_end_ms,self_id_hash,
        page_count,fetched_count,candidate_count,inserted_count,updated_count,duplicate_count,conflict_count,finished_at
      ) SELECT ${quoteSql(auditId)},${quoteSql(planId)},${quoteSql(attemptId)},${quoteSql(scope.source_id)},${quoteSql(scope.id)},
        ${initialSyncStartMs},${startMs},${endMs},${quoteSql(selfIdHash)},${pages},${fetchedCount},${records.length},
        COALESCE(SUM(changed=1 AND existed=0),0), COALESCE(SUM(changed=1 AND existed=1),0),
        COALESCE(SUM(changed=0 AND same_fact=1),0), COALESCE(SUM(changed=0 AND same_fact=0),0),
        strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM __replay_effects;
      SELECT id AS audit_id,inserted_count AS inserted,updated_count AS updated,
        duplicate_count AS duplicate,conflict_count AS conflicts FROM bounded_replay_runs WHERE id=${quoteSql(auditId)};
      COMMIT;
    `, "commit bounded replay");
    if (!rows[0]) throw new Error("bounded replay commit returned no evidence");
    return { audit_id: String(rows[0].audit_id), inserted: Number(rows[0].inserted), updated: Number(rows[0].updated),
      duplicate: Number(rows[0].duplicate), conflicts: Number(rows[0].conflicts) };
  } finally {
    releaseMaintenanceLock(dbPath, owner);
  }
}

function countWriteEffects(dbPath: string, sourceId: string, records: StoredRecord[]): WriteEffects {
  const normalized = normalizeStoredRecords(records, sourceId);
  const existing = existingRecordMap(dbPath, sourceId, normalized);
  let inserted = 0;
  let updated = 0;
  let duplicate = 0;
  for (const record of normalized) {
    if (!existing.has(record.external_id)) inserted += 1;
    else if (existing.get(record.external_id) !== record.content_hash) updated += 1;
    else duplicate += 1;
  }
  return { inserted, updated, duplicate };
}

function incomingRecordsSql(records: StoredRecord[]) {
  const inserts = records
    .map(
      (record) => `INSERT INTO __incoming_records (
  source_id, first_seen_scope_id, external_id, external_version, record_type,
  occurred_at, occurred_at_ms, actor_id, container_id, direction, title, body,
  content_hash, canonical_json, raw_json
) VALUES (
  ${quoteSql(record.source_id)},
  ${quoteSql(record.first_seen_scope_id)},
  ${quoteSql(record.external_id)},
  ${quoteSql(record.external_version)},
  ${quoteSql(record.record_type)},
  ${quoteSql(record.occurred_at)},
  ${Number(record.occurred_at_ms)},
  ${quoteSql(record.actor_id)},
  ${quoteSql(record.container_id)},
  ${quoteSql(record.direction)},
  ${quoteSql(record.title)},
  ${quoteSql(record.body)},
  ${quoteSql(record.content_hash)},
  ${quoteSql(record.canonical_json)},
  ${quoteSql(record.raw_json)}
);`,
    )
    .join("\n");
  return `
CREATE TEMP TABLE __incoming_records (
  source_id TEXT NOT NULL,
  first_seen_scope_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_version TEXT,
  record_type TEXT NOT NULL,
  occurred_at TEXT,
  occurred_at_ms INTEGER,
  actor_id TEXT,
  container_id TEXT,
  direction TEXT,
  title TEXT,
  body TEXT,
  content_hash TEXT,
  canonical_json TEXT,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (source_id, external_id)
);
${inserts}
`;
}

function recordWritesSql(normalizedRecords: StoredRecord[], now: string) {
  const canReplace = versionCanReplaceSql("r", "i");
  const differs = recordDiffSql("r", "i");
  return `
${incomingRecordsSql(normalizedRecords)}
    CREATE TEMP TABLE __write_effects (
      inserted INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      duplicate INTEGER NOT NULL
    );
    INSERT INTO __write_effects (inserted, updated, duplicate)
    SELECT
      COALESCE(SUM(CASE WHEN r.id IS NULL THEN 1 ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN r.id IS NOT NULL AND ${canReplace} AND ${differs} THEN 1 ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN r.id IS NOT NULL AND NOT (${canReplace} AND ${differs}) THEN 1 ELSE 0 END), 0)
    FROM __incoming_records i
    LEFT JOIN records r
      ON r.source_id = i.source_id
     AND r.external_id = i.external_id
    WHERE EXISTS (SELECT 1 FROM __run_fence_guard);
    INSERT INTO records (
      source_id, first_seen_scope_id, external_id, external_version, record_type,
      occurred_at, occurred_at_ms, actor_id, container_id, direction, title, body,
      content_hash, canonical_json, raw_json, updated_at
    )
    SELECT
      i.source_id, i.first_seen_scope_id, i.external_id, i.external_version, i.record_type,
      i.occurred_at, i.occurred_at_ms, i.actor_id, i.container_id, i.direction, i.title, i.body,
      i.content_hash, i.canonical_json, i.raw_json, ${quoteSql(now)}
    FROM __incoming_records i
    WHERE EXISTS (SELECT 1 FROM __run_fence_guard)
    ON CONFLICT(source_id, external_id) DO UPDATE SET
      external_version = excluded.external_version,
      record_type = excluded.record_type,
      occurred_at = excluded.occurred_at,
      occurred_at_ms = excluded.occurred_at_ms,
      actor_id = excluded.actor_id,
      container_id = excluded.container_id,
      direction = excluded.direction,
      title = excluded.title,
      body = excluded.body,
      content_hash = excluded.content_hash,
      canonical_json = ${mergedCanonicalSql("records", "excluded")},
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
    WHERE ${versionCanReplaceSql("records", "excluded")}
      AND ${recordDiffSql("records", "excluded")};
`;
}

function finishRecordRun(
  dbPath: string,
  scope: SyncScope,
  runId: number,
  records: StoredRecord[],
  scannedCount: number,
  cursor: JsonObject | null,
  metadata: JsonObject,
  error: Error | null = null,
): WriteEffects {
  const id = checkedRunId(runId);
  validateRecordCursor(cursor, "record cursor");
  const cursorJsonSql = sqlJson(cursor);
  const normalizedRecords = normalizeStoredRecords(records, scope.source_id);
  const safeMetadata = { ...metadata };
  delete safeMetadata[RUN_FENCE_METADATA_KEY];
  const finishedAt = new Date();
  const now = finishedAt.toISOString();
  const hardLeaseCutoff = new Date(
    finishedAt.getTime() - DEFAULT_HARD_LEASE_SECONDS * 1000,
  ).toISOString();
  const rows = sqliteQuery(
    dbPath,
    `
    BEGIN IMMEDIATE;
    CREATE TEMP TABLE __run_fence_guard (
      allowed INTEGER PRIMARY KEY,
      lock_owner TEXT NOT NULL,
      lock_acquired_at TEXT NOT NULL,
      implicit INTEGER NOT NULL
    );
    INSERT INTO __run_fence_guard (allowed, lock_owner, lock_acquired_at, implicit)
    SELECT
      1,
      l.locked_by,
      l.locked_at,
      COALESCE(json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.implicit'), 0)
    FROM sync_runs r
    JOIN sync_scopes s ON s.id = r.scope_id AND s.source_id = r.source_id
    JOIN sync_locks l ON l.scope_id = r.scope_id
    WHERE r.id = ${id}
      AND r.status = 'running'
      AND r.scope_id = ${quoteSql(scope.id)}
      AND r.source_id = ${quoteSql(scope.source_id)}
      AND l.locked_by = json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.owner')
      AND l.locked_at = json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.locked_at')
      AND julianday(l.locked_at) IS NOT NULL
      AND l.locked_at > ${quoteSql(hardLeaseCutoff)}
      AND s.cursor_json IS r.cursor_before_json
      AND ${error ? "1" : cursorCanAdvanceSql("r.cursor_before_json", cursorJsonSql)};
${recordWritesSql(normalizedRecords, now)}
    UPDATE sync_runs
    SET status = ${quoteSql(error ? "failed" : "succeeded")},
        cursor_after_json = ${error ? "cursor_after_json" : cursorJsonSql},
        error_type = ${quoteSql(error ? error.name || "Error" : null)},
        error_message = ${quoteSql(error ? String(error.message || error).slice(0, 4000) : null)},
        finished_at = ${quoteSql(now)},
        scanned_count = ${Number(scannedCount)},
        inserted_count = (SELECT inserted FROM __write_effects),
        updated_count = (SELECT updated FROM __write_effects),
        duplicate_count = (SELECT duplicate FROM __write_effects),
        metadata_json = json_patch(COALESCE(metadata_json, '{}'), ${sqlJson(safeMetadata)})
    WHERE id = ${id}
      AND EXISTS (SELECT 1 FROM __run_fence_guard);
    UPDATE sync_scopes
    SET ${error ? `last_error_run_id = ${id}` : `cursor_json = ${cursorJsonSql},
        cursor_updated_at = ${quoteSql(now)},
        last_success_run_id = ${id}`},
        updated_at = ${quoteSql(now)}
    WHERE id = ${quoteSql(scope.id)}
      AND EXISTS (SELECT 1 FROM __run_fence_guard);
    DELETE FROM sync_locks
    WHERE scope_id = ${quoteSql(scope.id)}
      AND locked_by = (SELECT lock_owner FROM __run_fence_guard)
      AND locked_at = (SELECT lock_acquired_at FROM __run_fence_guard)
      AND (SELECT implicit FROM __run_fence_guard) = 1;
    SELECT
      (SELECT COUNT(*) FROM __run_fence_guard) AS fenced,
      COALESCE((SELECT inserted FROM __write_effects), 0) AS inserted,
      COALESCE((SELECT updated FROM __write_effects), 0) AS updated,
      COALESCE((SELECT duplicate FROM __write_effects), 0) AS duplicate;
    COMMIT;
    `,
    `${error ? "fail" : "succeed"} record run ${id}`,
  );
  if (Number(rows[0]?.fenced || 0) !== 1) {
    throw new Error(`${error ? "fail" : "succeed"} run ${id} rejected: stale, cancelled, mismatched, or unfenced run`);
  }
  return {
    inserted: Number(rows[0]?.inserted || 0),
    updated: Number(rows[0]?.updated || 0),
    duplicate: Number(rows[0]?.duplicate || 0),
  };
}

function succeedRecordRun(
  dbPath: string, scope: SyncScope, runId: number, records: StoredRecord[],
  scannedCount: number, cursor: JsonObject | null, metadata: JsonObject,
): WriteEffects {
  return finishRecordRun(dbPath, scope, runId, records, scannedCount, cursor, metadata);
}

/** Save validated records from an incomplete window without claiming coverage. */
function failRecordRun(
  dbPath: string, scope: SyncScope, runId: number, records: StoredRecord[],
  scannedCount: number, error: Error, metadata: JsonObject,
): WriteEffects {
  return finishRecordRun(dbPath, scope, runId, records, scannedCount, null, metadata, error);
}

type LarkDetailOutcome = {
  message_id: string;
  fingerprint: string;
  record?: StoredRecord;
  error?: Error;
  retry_at?: string;
};

type LarkProgressEffects = WriteEffects & {
  pending_details: number;
  full_cursor_promoted: boolean;
  list_cursor: JsonObject;
};

function requireLarkScope(scope: SyncScope) {
  if (scope.source_id !== "lark.im") throw new Error("Lark detail progress requires a Lark scope");
}

function larkScopeIdentity(scope: SyncScope) {
  const config = scope.config_json ? JSON.parse(scope.config_json) : scope.config || {};
  return JSON.stringify({ chat_id: config.chat_id ?? null });
}

function readLarkListProgress(dbPath: string, scope: SyncScope) {
  requireLarkScope(scope);
  const row = sqliteQuery(dbPath,
    `SELECT * FROM lark_im_list_progress WHERE scope_id = ${quoteSql(scope.id)};`,
    "read Lark list progress")[0];
  if (!row) return null;
  if (row.anchor_cursor_json !== scopeCursorJson(scope) || row.scope_config_json !== larkScopeIdentity(scope)) {
    throw new Error("Lark list progress anchor or scope configuration changed; reconciliation is required");
  }
  return { ...row, cursor: JSON.parse(row.cursor_json),
    anchor_cursor: row.anchor_cursor_json === null ? null : JSON.parse(row.anchor_cursor_json) };
}

/** Only due debt is returned; completed descriptors are durable replay receipts. */
function readPendingLarkDetails(dbPath: string, scope: SyncScope,
  { limit = 8, now = new Date() }: { limit?: number; now?: Date | string } = {}) {
  requireLarkScope(scope);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("detail retry limit must be between 1 and 100");
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid detail retry clock");
  return sqliteQuery(dbPath,
    `SELECT * FROM lark_im_detail_tasks WHERE scope_id = ${quoteSql(scope.id)}
       AND status = 'pending' AND retry_at <= ${quoteSql(date.toISOString())}
     ORDER BY retry_at, occurred_at_ms, message_id LIMIT ${limit};`, "read pending Lark details")
    .map((row) => ({ ...row, raw_root: JSON.parse(row.raw_root_json), raw: JSON.parse(row.raw_root_json) }));
}

function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function larkRootTime(value: unknown) {
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  const time = typeof numeric === "number" ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(time) || time < 0) throw new Error("detail root has an invalid source timestamp");
  return time;
}

function larkDetailRoot(raw: JsonObject, requireMerge = true) {
  // Queue source descriptors, never rendered text or expansion wrappers. A
  // completed receipt may describe an authoritative root whose type changed.
  const root = JSON.parse(JSON.stringify(raw));
  if (!root || typeof root.message_id !== "string" || !root.message_id.trim() ||
      (requireMerge && (root.msg_type || root.message_type) !== "merge_forward")) throw new Error("invalid Lark merge-forward root");
  delete root.raw_api_expansions;
  const occurredAtMs = larkRootTime(root.create_time);
  const externalVersion = root.update_time == null || root.update_time === "" ? null : String(larkRootTime(root.update_time));
  // Native list/detail endpoints may use equivalent timestamp representations
  // and omit versus emit empty root-parent metadata. These are the same source.
  const source = { ...root, create_time: occurredAtMs, update_time: externalVersion };
  if (source.upper_message_id === undefined || source.upper_message_id === null || source.upper_message_id === "") {
    delete source.upper_message_id;
  }
  return { message_id: root.message_id, raw_json: stableJson(root),
    fingerprint: createHash("sha256").update(stableJson(source)).digest("hex"),
    occurred_at_ms: occurredAtMs, external_version: externalVersion };
}

function larkRunFenceSql(scope: SyncScope, runId: number, now: string) {
  const cutoff = new Date(Date.parse(now) - DEFAULT_HARD_LEASE_SECONDS * 1000).toISOString();
  return `
    CREATE TEMP TABLE __run_fence_guard (
      allowed INTEGER PRIMARY KEY CHECK (allowed = 1), lock_owner TEXT NOT NULL,
      lock_acquired_at TEXT NOT NULL, implicit INTEGER NOT NULL
    );
    INSERT INTO __run_fence_guard
    SELECT 1, l.locked_by, l.locked_at,
      COALESCE(json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.implicit'), 0)
    FROM sync_runs r JOIN sync_scopes s ON s.id = r.scope_id AND s.source_id = r.source_id
    JOIN sync_locks l ON l.scope_id = r.scope_id
    WHERE r.id = ${checkedRunId(runId)} AND r.status = 'running'
      AND r.scope_id = ${quoteSql(scope.id)} AND r.source_id = ${quoteSql(scope.source_id)}
      AND l.locked_by = json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.owner')
      AND l.locked_at = json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.locked_at')
      AND julianday(l.locked_at) IS NOT NULL AND l.locked_at > ${quoteSql(cutoff)}
      AND s.cursor_json IS r.cursor_before_json AND s.cursor_json IS ${quoteSql(scopeCursorJson(scope))}
      AND json_object('chat_id', json_extract(s.config_json, '$.chat_id')) IS json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.scope_config')
      AND json_object('chat_id', json_extract(s.config_json, '$.chat_id')) IS ${quoteSql(larkScopeIdentity(scope))}
      AND COALESCE((SELECT generation FROM lark_im_list_progress WHERE scope_id = s.id), 0)
        = json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.list_generation')
      AND NOT EXISTS (SELECT 1 FROM lark_im_list_progress p WHERE p.scope_id = s.id
        AND (p.anchor_cursor_json IS NOT s.cursor_json OR p.scope_config_json IS NOT json_object('chat_id', json_extract(s.config_json, '$.chat_id'))));
    CREATE TEMP TABLE __lark_guard (allowed INTEGER NOT NULL CHECK (allowed = 1));
    INSERT INTO __lark_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM __run_fence_guard) THEN 1 ELSE 0 END;
  `;
}

/** Finish list or detail work using only durable coverage and debt as evidence. */
function commitLarkProgress(dbPath: string, scope: SyncScope, runId: number, records: StoredRecord[],
  scannedCount: number, metadata: JsonObject, mutationSql: string): LarkProgressEffects {
  requireLarkScope(scope);
  if (!Number.isSafeInteger(scannedCount) || scannedCount < 0) throw new Error("invalid Lark scanned count");
  const normalized = normalizeStoredRecords(records, scope.source_id);
  if (normalized.some((record) => record.first_seen_scope_id !== scope.id || record.record_type !== "lark.im.message")) {
    throw new Error("detail progress record does not belong to this Lark scope");
  }
  const safeMetadata = { ...metadata };
  for (const key of Object.keys(safeMetadata)) {
    if (key === RUN_FENCE_METADATA_KEY || key.startsWith("window_") ||
        ["coverage_mode", "details_complete", "list_complete", "pending_detail_count"].includes(key)) delete safeMetadata[key];
  }
  const now = new Date().toISOString();
  const rows = sqliteQuery(dbPath, `
    BEGIN IMMEDIATE;
    ${larkRunFenceSql(scope, runId, now)}
    ${mutationSql}
    ${recordWritesSql(normalized, now)}
    CREATE TEMP TABLE __lark_finish AS
      SELECT p.cursor_json, p.coverage_start_ms,
        CAST(json_extract(p.cursor_json, '$.created_at_ms') AS INTEGER) AS end_ms,
        (SELECT COUNT(*) FROM lark_im_detail_tasks d WHERE d.scope_id = p.scope_id AND d.status = 'pending') AS pending
      FROM lark_im_list_progress p WHERE p.scope_id = ${quoteSql(scope.id)};
    INSERT INTO __lark_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM __lark_finish)
      AND ${cursorCanAdvanceSql(quoteSql(scopeCursorJson(scope)), "(SELECT cursor_json FROM __lark_finish)")}
      THEN 1 ELSE 0 END;
    UPDATE sync_runs SET
      status = CASE WHEN (SELECT pending FROM __lark_finish) = 0 THEN 'succeeded' ELSE 'failed' END,
      cursor_after_json = CASE WHEN (SELECT pending FROM __lark_finish) = 0 THEN (SELECT cursor_json FROM __lark_finish) ELSE NULL END,
      error_type = CASE WHEN (SELECT pending FROM __lark_finish) > 0 THEN 'LarkDetailIncomplete' ELSE NULL END,
      error_message = CASE WHEN (SELECT pending FROM __lark_finish) > 0 THEN 'List coverage saved; merge-forward details remain pending' ELSE NULL END,
      finished_at = ${quoteSql(now)}, scanned_count = ${scannedCount},
      inserted_count = (SELECT inserted FROM __write_effects), updated_count = (SELECT updated FROM __write_effects),
      duplicate_count = (SELECT duplicate FROM __write_effects),
      metadata_json = json_patch(
        json_remove(COALESCE(metadata_json, '{}'), '$.window_start', '$.window_end', '$.window_start_ms', '$.window_end_ms',
          '$.coverage_mode', '$.window_complete', '$.details_complete', '$.list_complete', '$.pending_detail_count'),
        json_patch(${sqlJson(safeMetadata)}, json_patch(
          json_object('list_complete', json('true'), 'details_complete', json(CASE WHEN (SELECT pending FROM __lark_finish) = 0 THEN 'true' ELSE 'false' END),
            'window_complete', json(CASE WHEN (SELECT pending FROM __lark_finish) = 0 THEN 'true' ELSE 'false' END),
            'pending_detail_count', (SELECT pending FROM __lark_finish)),
          CASE WHEN (SELECT pending FROM __lark_finish) = 0 THEN json_object(
            'coverage_mode', 'list_checkpoint_and_details', 'window_start_ms', (SELECT coverage_start_ms FROM __lark_finish),
            'window_end_ms', (SELECT end_ms FROM __lark_finish),
            'window_start', strftime('%Y-%m-%dT%H:%M:%fZ', (SELECT coverage_start_ms FROM __lark_finish) / 1000.0, 'unixepoch'),
            'window_end', strftime('%Y-%m-%dT%H:%M:%fZ', (SELECT end_ms FROM __lark_finish) / 1000.0, 'unixepoch')) ELSE '{}' END)))
      WHERE id = ${checkedRunId(runId)};
    UPDATE sync_scopes SET
      cursor_json = CASE WHEN (SELECT pending FROM __lark_finish) = 0 THEN (SELECT cursor_json FROM __lark_finish) ELSE cursor_json END,
      cursor_updated_at = CASE WHEN (SELECT pending FROM __lark_finish) = 0 THEN ${quoteSql(now)} ELSE cursor_updated_at END,
      last_success_run_id = CASE WHEN (SELECT pending FROM __lark_finish) = 0 THEN ${runId} ELSE last_success_run_id END,
      last_error_run_id = CASE WHEN (SELECT pending FROM __lark_finish) > 0 THEN ${runId} ELSE last_error_run_id END,
      updated_at = ${quoteSql(now)} WHERE id = ${quoteSql(scope.id)};
    UPDATE lark_im_list_progress SET
      anchor_cursor_json = (SELECT cursor_json FROM sync_scopes WHERE id = ${quoteSql(scope.id)}),
      coverage_start_ms = CASE WHEN (SELECT pending FROM __lark_finish) = 0 THEN (SELECT end_ms FROM __lark_finish) ELSE coverage_start_ms END
      WHERE scope_id = ${quoteSql(scope.id)};
    DELETE FROM sync_locks WHERE scope_id = ${quoteSql(scope.id)}
      AND locked_by = (SELECT lock_owner FROM __run_fence_guard)
      AND locked_at = (SELECT lock_acquired_at FROM __run_fence_guard)
      AND (SELECT implicit FROM __run_fence_guard) = 1;
    SELECT e.*, f.pending AS pending_details, (f.pending = 0) AS full_cursor_promoted, f.cursor_json
      FROM __write_effects e CROSS JOIN __lark_finish f;
    COMMIT;
  `, `commit Lark progress run ${runId} (stale, unfenced, or discontinuous state is rejected)`);
  const row = rows[0];
  if (!row) throw new Error("Lark progress commit returned no evidence");
  return { inserted: Number(row.inserted), updated: Number(row.updated), duplicate: Number(row.duplicate),
    pending_details: Number(row.pending_details), full_cursor_promoted: row.full_cursor_promoted === 1,
    list_cursor: JSON.parse(row.cursor_json) };
}

/** Call only after the complete list window has passed pagination validation. */
function commitLarkListRun(dbPath: string, scope: SyncScope, runId: number, records: StoredRecord[],
  rawMergeRoots: JsonObject[], scannedCount: number, listCursor: JsonObject, metadata: JsonObject): LarkProgressEffects {
  validateRecordCursor(listCursor, "Lark list cursor");
  const start = metadata.list_window_start_ms;
  const end = metadata.list_window_end_ms;
  const frontier = listCursor.created_at_ms;
  if (![start, end, frontier].every(Number.isSafeInteger) || end < start || frontier < start || frontier > end) {
    throw new Error("invalid Lark list coverage bounds");
  }
  if (records.some((record) => {
    const raw = JSON.parse(record.raw_json);
    return (raw.msg_type || raw.message_type) === "merge_forward";
  })) throw new Error("Lark list writes must not contain merge-forward placeholders");
  const rootById = new Map<string, ReturnType<typeof larkDetailRoot>>();
  for (const rawRoot of rawMergeRoots) {
    const root = larkDetailRoot(rawRoot);
    const previous = rootById.get(root.message_id);
    if (previous && previous.fingerprint !== root.fingerprint) throw new Error("conflicting duplicate Lark detail root descriptors");
    rootById.set(root.message_id, root);
  }
  const roots = [...rootById.values()];
  if (roots.some((root) => root.occurred_at_ms < start || root.occurred_at_ms > end)) throw new Error("Lark detail root outside list window");
  const fullCursorMs = scope.cursor?.created_at_ms ?? (scopeCursorJson(scope) ? JSON.parse(scopeCursorJson(scope)!)?.created_at_ms : null);
  const initialStart = fullCursorMs ?? metadata.initial_sync_start_ms;
  if (!Number.isSafeInteger(initialStart)) throw new Error("Lark list coverage requires an initial sync start");
  const now = new Date().toISOString();
  const mutationSql = `
    ${fullCursorMs == null ? `INSERT INTO __lark_guard SELECT CASE WHEN EXISTS (
      SELECT 1 FROM sources WHERE id = ${quoteSql(scope.source_id)}
        AND json_extract(config_json, '$.initial_sync_start_ms') = ${initialStart}) THEN 1 ELSE 0 END;` : ""}
    INSERT INTO __lark_guard SELECT CASE WHEN ${start} = COALESCE(
      (SELECT CAST(json_extract(cursor_json, '$.created_at_ms') AS INTEGER) FROM lark_im_list_progress WHERE scope_id = ${quoteSql(scope.id)}),
      ${initialStart}) THEN 1 ELSE 0 END;
    INSERT INTO lark_im_list_progress (scope_id, anchor_cursor_json, cursor_json, coverage_start_ms, generation, scope_config_json, updated_at)
      VALUES (${quoteSql(scope.id)}, ${quoteSql(scopeCursorJson(scope))}, ${sqlJson(listCursor)}, ${start}, 1,
        ${quoteSql(larkScopeIdentity(scope))}, ${quoteSql(now)})
      ON CONFLICT(scope_id) DO UPDATE SET cursor_json = excluded.cursor_json,
        generation = lark_im_list_progress.generation + 1, updated_at = excluded.updated_at;
    ${roots.map((root) => `
      INSERT INTO lark_im_detail_tasks (scope_id, message_id, raw_root_json, fingerprint, external_version, occurred_at_ms,
        status, attempt_count, retry_at, created_at, updated_at)
      VALUES (${quoteSql(scope.id)}, ${quoteSql(root.message_id)}, ${quoteSql(root.raw_json)}, ${quoteSql(root.fingerprint)},
        ${quoteSql(root.external_version)}, ${root.occurred_at_ms}, 'pending', 0, ${quoteSql(now)}, ${quoteSql(now)}, ${quoteSql(now)})
      ON CONFLICT(scope_id, message_id) DO UPDATE SET raw_root_json = excluded.raw_root_json,
        fingerprint = excluded.fingerprint, external_version = excluded.external_version, occurred_at_ms = excluded.occurred_at_ms,
        status = 'pending', attempt_count = 0, retry_at = excluded.retry_at, last_error_type = NULL, last_error_message = NULL,
        updated_at = excluded.updated_at, completed_at = NULL
      WHERE lark_im_detail_tasks.fingerprint <> excluded.fingerprint
        AND NOT (${numericVersionSql("lark_im_detail_tasks.external_version")}
          AND ${numericVersionSql("excluded.external_version")}
          AND NOT ${versionCanReplaceSql("lark_im_detail_tasks", "excluded")});
    `).join("\n")}
  `;
  return commitLarkProgress(dbPath, scope, runId, records, scannedCount, metadata, mutationSql);
}

/** A complete detail response replaces content; failed attempts only reschedule debt. */
function finishLarkDetailRun(dbPath: string, scope: SyncScope, runId: number, outcomes: LarkDetailOutcome[],
  metadata: JsonObject = {}): LarkProgressEffects {
  if (outcomes.length < 1 || outcomes.length > 100) throw new Error("detail outcome count must be between 1 and 100");
  if (new Set(outcomes.map((outcome) => outcome.message_id)).size !== outcomes.length) throw new Error("duplicate detail outcomes");
  const now = new Date().toISOString();
  const records: StoredRecord[] = [];
  const statements = outcomes.map((outcome) => {
    if (!outcome.message_id || !/^[a-f0-9]{64}$/.test(outcome.fingerprint) || Boolean(outcome.record) === Boolean(outcome.error)) {
      throw new Error("detail outcome needs exactly one complete record or error");
    }
    if (outcome.record && outcome.record.external_id !== outcome.message_id) throw new Error("detail outcome record identity mismatch");
    if (outcome.retry_at && !Number.isFinite(Date.parse(outcome.retry_at))) throw new Error("invalid detail retry timestamp");
    let resolvedRoot: ReturnType<typeof larkDetailRoot> | null = null;
    if (outcome.record) {
      const raw = JSON.parse(outcome.record.raw_json);
      if (raw.message_id !== outcome.message_id ||
          ((raw.msg_type || raw.message_type) === "merge_forward" &&
            (!Array.isArray(raw.raw_api_expansions?.merge_forward?.items) ||
             !raw.raw_api_expansions.merge_forward.items.some((item: JsonObject) => item.message_id === outcome.message_id)))) {
        throw new Error("detail outcome lacks complete source evidence");
      }
      resolvedRoot = larkDetailRoot(raw, false);
      records.push(outcome.record);
    }
    const recordVersion = normalizeExternalVersion(outcome.record?.external_version);
    const taskCondition = `scope_id = ${quoteSql(scope.id)} AND message_id = ${quoteSql(outcome.message_id)}
      AND fingerprint = ${quoteSql(outcome.fingerprint)} AND status = 'pending'`;
    // A response rejected by stored-version protection is not evidence of
    // completeness. Keep and back off its debt while healthy siblings finish.
    const completeSql = outcome.record ? `NOT EXISTS (
      SELECT 1 FROM records existing CROSS JOIN (SELECT ${quoteSql(recordVersion)} AS external_version) incoming
      WHERE existing.source_id = ${quoteSql(scope.source_id)} AND existing.external_id = ${quoteSql(outcome.message_id)}
        AND NOT ${versionCanReplaceSql("existing", "incoming")}
    )` : "0";
    return `
      INSERT INTO __lark_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM lark_im_detail_tasks WHERE ${taskCondition}) THEN 1 ELSE 0 END;
      ${outcome.record ? `INSERT INTO __lark_guard SELECT CASE WHEN EXISTS (
        SELECT 1 FROM lark_im_detail_tasks t CROSS JOIN (SELECT ${quoteSql(recordVersion)} AS external_version) incoming
        WHERE ${taskCondition} AND ${versionCanReplaceSql("t", "incoming")}) THEN 1 ELSE 0 END;` : ""}
      UPDATE lark_im_detail_tasks SET status = CASE WHEN ${completeSql} THEN 'complete' ELSE 'pending' END, attempt_count = attempt_count + 1,
        raw_root_json = CASE WHEN ${completeSql} THEN ${quoteSql(resolvedRoot?.raw_json)} ELSE raw_root_json END,
        fingerprint = CASE WHEN ${completeSql} THEN ${quoteSql(resolvedRoot?.fingerprint)} ELSE fingerprint END,
        external_version = CASE WHEN ${completeSql} THEN ${quoteSql(resolvedRoot?.external_version)} ELSE external_version END,
        occurred_at_ms = CASE WHEN ${completeSql} THEN ${resolvedRoot?.occurred_at_ms ?? "NULL"} ELSE occurred_at_ms END,
        retry_at = ${outcome.retry_at ? quoteSql(new Date(outcome.retry_at).toISOString())
          : `strftime('%Y-%m-%dT%H:%M:%fZ', ${quoteSql(now)}, '+' || min(86400, 60 * (1 << min(attempt_count, 11))) || ' seconds')`},
        last_error_type = CASE WHEN ${completeSql} THEN NULL ELSE ${quoteSql(outcome.error?.name || (outcome.error ? "Error" : "LarkDetailVersionConflict"))} END,
        last_error_message = CASE WHEN ${completeSql} THEN NULL ELSE ${quoteSql(outcome.error
          ? String(outcome.error.message).slice(0, 4000) : "Detail response cannot replace the stored source version")} END,
        updated_at = ${quoteSql(now)}, completed_at = CASE WHEN ${completeSql} THEN ${quoteSql(now)} ELSE NULL END WHERE ${taskCondition};
    `;
  });
  // Generation also advances on retries, so an older list run cannot overwrite
  // new retry state even when the full-content watermark has not moved.
  const mutationSql = `${statements.join("\n")}
    UPDATE lark_im_list_progress SET generation = generation + 1, updated_at = ${quoteSql(now)}
      WHERE scope_id = ${quoteSql(scope.id)};`;
  return commitLarkProgress(dbPath, scope, runId, records, outcomes.length,
    { ...metadata, detail_retry: true }, mutationSql);
}

const succeedMessageRun = succeedRecordRun;

export {
  DEFAULT_HARD_LEASE_SECONDS,
  acquireLock,
  acquireMaintenanceLock,
  countWriteEffects,
  commitBoundedReplayRecords,
  commitLarkListRun,
  finishLarkDetailRun,
  readLarkListProgress,
  readPendingLarkDetails,
  normalizeBoundedReplayRecords,
  createRun,
  ensureInitialized,
  ensureSourceInitialSyncStart,
  existingRecordMap,
  failRun,
  failRecordRun,
  isMaintenanceLocked,
  normalizeExternalVersion,
  normalizeStoredRecords,
  ownerPid,
  ownerStartedAtMs,
  defaultOwnerState,
  recoverStaleSyncState,
  quoteSql,
  readScope,
  releaseLock,
  releaseMaintenanceLock,
  secureDatabasePaths,
  sqlJson,
  sqliteExec,
  sqliteQuery,
  succeedMessageRun,
  succeedRecordRun,
  upsertRecordsSql,
  validateInitialSyncStartMs,
};
