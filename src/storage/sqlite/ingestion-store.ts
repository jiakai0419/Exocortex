import { spawnSync } from "node:child_process";
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

function secureDatabasePaths(dbPath: string) {
  const resolvedDbPath = resolve(dbPath);
  const dbDir = dirname(resolvedDbPath);
  mkdirSync(dbDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(dbDir, PRIVATE_DIRECTORY_MODE);
  for (const path of [resolvedDbPath, `${resolvedDbPath}-wal`, `${resolvedDbPath}-shm`, `${resolvedDbPath}-journal`]) {
    chmodIfPresent(path, PRIVATE_FILE_MODE);
  }
  return resolvedDbPath;
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
  const resolvedDbPath = secureDatabasePaths(dbPath);
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
    secureDatabasePaths(resolvedDbPath);
  }
  if (result.status !== 0 || result.error) throw sqliteFailure(result, label);
  return String(result.stdout || "");
}

function sqliteQuery(dbPath: string, sql: string, label: string): SqliteRow[] {
  const resolvedDbPath = secureDatabasePaths(dbPath);
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
    secureDatabasePaths(resolvedDbPath);
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
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const scopeWhere = scopeId ? `WHERE scope_id = ${quoteSql(scopeId)}` : "";
  const locks = sqliteQuery(
    dbPath,
    `SELECT scope_id, locked_by, locked_at, expires_at
     FROM sync_locks
     ${scopeWhere}
     ORDER BY locked_at;`,
    "read sync locks for recovery",
  );

  const staleLocks: Array<SqliteRow & { reason: string }> = [];
  const activeExpiredLocks: SqliteRow[] = [];
  const ownerStates = new Map<string, OwnerState>();
  for (const lock of locks) {
    const owner = String(lock.locked_by || "");
    if (!ownerStates.has(owner)) ownerStates.set(owner, normalizeOwnerState(ownerState(owner)));
    const state = ownerStates.get(owner) || "unknown";
    const expiresAtMs = Date.parse(lock.expires_at);
    const lockedAtMs = Date.parse(lock.locked_at);
    const expired = Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
    const hardLeaseExceeded =
      !Number.isFinite(lockedAtMs) || lockedAtMs + hardLeaseSeconds * 1000 <= nowMs;
    if (state === "dead" || hardLeaseExceeded || (expired && state !== "alive")) {
      staleLocks.push({
        ...lock,
        reason:
          state === "dead"
            ? "owner_dead"
            : hardLeaseExceeded
              ? "hard_lease_exceeded"
              : "lock_expired",
      });
    } else if (expired && state === "alive") {
      activeExpiredLocks.push(lock);
    }
  }

  const orphanCutoffIso = new Date(nowMs - orphanRunSeconds * 1000).toISOString();
  const orphanScopeWhere = scopeId ? `AND r.scope_id = ${quoteSql(scopeId)}` : "";
  const orphanRuns = sqliteQuery(
    dbPath,
    `SELECT r.id, r.scope_id
     FROM sync_runs r
     WHERE r.status = 'running'
       ${orphanScopeWhere}
       AND r.started_at <= ${quoteSql(orphanCutoffIso)}
       AND NOT EXISTS (
         SELECT 1 FROM sync_locks l WHERE l.scope_id = r.scope_id
       )
     ORDER BY r.started_at;`,
    "read orphan running runs for recovery",
  );

  if (staleLocks.length === 0 && orphanRuns.length === 0) {
    return {
      recovered_locks: 0,
      cancelled_runs: 0,
      active_expired_locks: activeExpiredLocks.length,
    };
  }

  const staleSql = staleLocks
    .map((lock) => {
      const message = `Recovered stale lock ${lock.locked_by}: ${lock.reason}`;
      return `
UPDATE sync_runs
SET status = 'cancelled',
    finished_at = ${quoteSql(nowIso)},
    error_type = 'StaleLock',
    error_message = ${quoteSql(message)}
WHERE status = 'running'
  AND scope_id = ${quoteSql(lock.scope_id)};
DELETE FROM sync_locks
WHERE scope_id = ${quoteSql(lock.scope_id)}
  AND locked_by = ${quoteSql(lock.locked_by)};
`;
    })
    .join("\n");
  const orphanIds = orphanRuns.map((run) => Number(run.id)).filter(Number.isFinite);
  const orphanSql =
    orphanIds.length > 0
      ? `
UPDATE sync_runs
SET status = 'cancelled',
    finished_at = ${quoteSql(nowIso)},
    error_type = 'StaleRun',
    error_message = 'Recovered running run without an active lock'
WHERE id IN (${orphanIds.join(", ")})
  AND status = 'running';
`
      : "";

  sqliteExec(
    dbPath,
    `
BEGIN;
${staleSql}
${orphanSql}
COMMIT;
`,
    "recover stale sync state",
  );

  return {
    recovered_locks: staleLocks.length,
    cancelled_runs: staleLocks.length + orphanRuns.length,
    active_expired_locks: activeExpiredLocks.length,
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
         '$.${RUN_FENCE_METADATA_KEY}.implicit', (SELECT had_lock = 0 FROM __create_run_state)
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

function recordDiffSql(existingAlias: string, incomingAlias: string) {
  return `(${MUTABLE_RECORD_COLUMNS.map(
    (column) => `${existingAlias}.${column} IS NOT ${incomingAlias}.${column}`,
  ).join(" OR ")})`;
}

function upsertRecordsSql(records: StoredRecord[]) {
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
  canonical_json = excluded.canonical_json,
  raw_json = excluded.raw_json,
  updated_at = excluded.updated_at
WHERE ${versionCanReplaceSql("records", "excluded")}
  AND ${recordDiffSql("records", "excluded")};
`,
    )
    .join("\n");
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

function succeedRecordRun(
  dbPath: string,
  scope: SyncScope,
  runId: number,
  records: StoredRecord[],
  scannedCount: number,
  cursor: JsonObject | null,
  metadata: JsonObject,
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
  const canReplace = versionCanReplaceSql("r", "i");
  const differs = recordDiffSql("r", "i");
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
      AND ${cursorCanAdvanceSql("r.cursor_before_json", cursorJsonSql)};
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
      canonical_json = excluded.canonical_json,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
    WHERE ${versionCanReplaceSql("records", "excluded")}
      AND ${recordDiffSql("records", "excluded")};
    UPDATE sync_runs
    SET status = 'succeeded',
        cursor_after_json = ${cursorJsonSql},
        finished_at = ${quoteSql(now)},
        scanned_count = ${Number(scannedCount)},
        inserted_count = (SELECT inserted FROM __write_effects),
        updated_count = (SELECT updated FROM __write_effects),
        duplicate_count = (SELECT duplicate FROM __write_effects),
        metadata_json = json_patch(COALESCE(metadata_json, '{}'), ${sqlJson(safeMetadata)})
    WHERE id = ${id}
      AND EXISTS (SELECT 1 FROM __run_fence_guard);
    UPDATE sync_scopes
    SET cursor_json = ${cursorJsonSql},
        cursor_updated_at = ${quoteSql(now)},
        last_success_run_id = ${id},
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
    `succeed run ${id}`,
  );
  if (Number(rows[0]?.fenced || 0) !== 1) {
    throw new Error(`succeed run ${id} rejected: stale, cancelled, mismatched, or unfenced run`);
  }
  return {
    inserted: Number(rows[0]?.inserted || 0),
    updated: Number(rows[0]?.updated || 0),
    duplicate: Number(rows[0]?.duplicate || 0),
  };
}

const succeedMessageRun = succeedRecordRun;

export {
  DEFAULT_HARD_LEASE_SECONDS,
  acquireLock,
  acquireMaintenanceLock,
  countWriteEffects,
  createRun,
  ensureInitialized,
  existingRecordMap,
  failRun,
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
};
