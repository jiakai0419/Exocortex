import { spawnSync } from "node:child_process";
import type { OwnerState, RecoveryOptions, MaintenanceLockOptions, MaintenanceLockResult } from "./ingestion-types.js";
import { sqliteExec, sqliteQuery, quoteSql } from "./sqlite-executor.js";
import { DEFAULT_HARD_LEASE_SECONDS, RUN_FENCE_METADATA_KEY } from "./sync-run-fence.js";
const PROCESS_STARTED_AT_MS = Math.max(0, Math.floor(Date.now() - process.uptime() * 1000));
const PROCESS_START_MATCH_TOLERANCE_MS = 5_000;
const DEFAULT_SYNC_LOCK_OWNER = `pid:${process.pid}:started:${PROCESS_STARTED_AT_MS}`;

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
WHERE EXISTS (SELECT 1 FROM sync_scopes s JOIN sources src ON src.id = s.source_id
  WHERE s.id = ${quoteSql(scopeId)} AND s.enabled = 1 AND src.enabled = 1)
AND NOT EXISTS (
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


export { DEFAULT_SYNC_LOCK_OWNER, ownerPid, ownerStartedAtMs, defaultOwnerState, recoverStaleSyncState, isMaintenanceLocked, acquireMaintenanceLock, releaseMaintenanceLock, acquireLock, releaseLock };
