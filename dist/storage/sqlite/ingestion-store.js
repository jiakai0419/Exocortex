import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
function quoteSql(value) {
    if (value === null || value === undefined)
        return "NULL";
    return `'${String(value).replaceAll("'", "''")}'`;
}
function sqlJson(value) {
    return quoteSql(JSON.stringify(value));
}
function sqliteExec(dbPath, sql, label) {
    const result = spawnSync("sqlite3", [dbPath], {
        input: `.timeout 5000\nPRAGMA foreign_keys = ON;\n${sql}`,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
    });
    if (result.status !== 0) {
        throw new Error(`${label} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
    }
    return result.stdout;
}
function sqliteQuery(dbPath, sql, label) {
    const result = spawnSync("sqlite3", ["-json", dbPath], {
        input: `.timeout 5000\nPRAGMA foreign_keys = ON;\n${sql}`,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
    });
    if (result.status !== 0) {
        throw new Error(`${label} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
    }
    const trimmed = result.stdout.trim();
    return trimmed ? JSON.parse(trimmed) : [];
}
function ownerPid(owner) {
    const match = String(owner || "").match(/^pid:(\d+)$/);
    return match ? Number(match[1]) : null;
}
function defaultOwnerState(owner) {
    const pid = ownerPid(owner);
    if (!pid)
        return "unknown";
    try {
        process.kill(pid, 0);
        return "alive";
    }
    catch (error) {
        const err = error;
        if (err.code === "ESRCH")
            return "dead";
        if (err.code === "EPERM")
            return "alive";
        return "unknown";
    }
}
function normalizeOwnerState(value) {
    const state = String(value);
    return state === "alive" || state === "dead" || state === "unknown" ? state : "unknown";
}
function recoverStaleSyncState(dbPath, options = {}) {
    const { scopeId = null, now = new Date(), ownerState = defaultOwnerState, orphanRunSeconds = 600, } = options;
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    const scopeWhere = scopeId ? `WHERE scope_id = ${quoteSql(scopeId)}` : "";
    const locks = sqliteQuery(dbPath, `SELECT scope_id, locked_by, locked_at, expires_at
     FROM sync_locks
     ${scopeWhere}
     ORDER BY locked_at;`, "read sync locks for recovery");
    const staleLocks = [];
    const activeExpiredLocks = [];
    for (const lock of locks) {
        const state = normalizeOwnerState(ownerState(lock.locked_by));
        const expiresAtMs = Date.parse(lock.expires_at);
        const expired = Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
        if (state === "dead" || (expired && state !== "alive")) {
            staleLocks.push({
                ...lock,
                reason: state === "dead" ? "owner_dead" : "lock_expired",
            });
        }
        else if (expired && state === "alive") {
            activeExpiredLocks.push(lock);
        }
    }
    const orphanCutoffIso = new Date(nowMs - orphanRunSeconds * 1000).toISOString();
    const orphanScopeWhere = scopeId ? `AND r.scope_id = ${quoteSql(scopeId)}` : "";
    const orphanRuns = sqliteQuery(dbPath, `SELECT r.id, r.scope_id
     FROM sync_runs r
     WHERE r.status = 'running'
       ${orphanScopeWhere}
       AND r.started_at <= ${quoteSql(orphanCutoffIso)}
       AND NOT EXISTS (
         SELECT 1 FROM sync_locks l WHERE l.scope_id = r.scope_id
       )
     ORDER BY r.started_at;`, "read orphan running runs for recovery");
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
    const orphanSql = orphanIds.length > 0
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
    sqliteExec(dbPath, `
BEGIN;
${staleSql}
${orphanSql}
COMMIT;
`, "recover stale sync state");
    return {
        recovered_locks: staleLocks.length,
        cancelled_runs: staleLocks.length + orphanRuns.length,
        active_expired_locks: activeExpiredLocks.length,
    };
}
function ensureInitialized(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const result = spawnSync("node", ["scripts/init-ingestion-core.mjs", "--db", dbPath], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
    });
    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || "failed to initialize ingestion core");
    }
}
function readScope(dbPath, scopeId) {
    const rows = sqliteQuery(dbPath, `SELECT id, source_id, name, enabled, config_json, cursor_json
     FROM sync_scopes
     WHERE id = ${quoteSql(scopeId)}
     LIMIT 1;`, `read scope ${scopeId}`);
    if (!rows[0])
        throw new Error(`sync scope not found: ${scopeId}`);
    const row = rows[0];
    return {
        ...row,
        config: row.config_json ? JSON.parse(row.config_json) : {},
        cursor: row.cursor_json ? JSON.parse(row.cursor_json) : null,
    };
}
function maintenanceOwner(owner = `pid:${process.pid}`) {
    return owner;
}
function isMaintenanceLocked(dbPath, now = new Date()) {
    try {
        const rows = sqliteQuery(dbPath, `SELECT COUNT(*) AS count
       FROM maintenance_locks
       WHERE name = 'global'
         AND expires_at > ${quoteSql(now.toISOString())};`, "read maintenance lock");
        return Number(rows[0]?.count || 0) > 0;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/no such table: maintenance_locks/.test(message))
            return false;
        throw error;
    }
}
function acquireMaintenanceLock(dbPath, options = {}) {
    const now = options.now || new Date();
    const owner = maintenanceOwner(options.owner);
    const ttlSeconds = options.ttlSeconds ?? 1800;
    const reason = options.reason || "maintenance";
    const nowIso = now.toISOString();
    const expiresIso = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    const rows = sqliteQuery(dbPath, `
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
`, "acquire maintenance lock");
    const row = rows[0] || {};
    if (Number(row.changed || 0) > 0)
        return { acquired: true };
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
function releaseMaintenanceLock(dbPath, owner = `pid:${process.pid}`) {
    sqliteExec(dbPath, `DELETE FROM maintenance_locks
     WHERE name = 'global'
       AND owner = ${quoteSql(owner)};`, "release maintenance lock");
}
function acquireLock(dbPath, scopeId, ttlSeconds, owner = `pid:${process.pid}`) {
    const now = new Date();
    const expires = new Date(now.getTime() + ttlSeconds * 1000);
    recoverStaleSyncState(dbPath, { scopeId, now });
    try {
        const rows = sqliteQuery(dbPath, `
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
`, `acquire lock ${scopeId}`);
        return Number(rows[0]?.changed || 0) > 0;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/UNIQUE constraint failed: sync_locks\.scope_id/.test(message))
            return false;
        throw error;
    }
}
function releaseLock(dbPath, scopeId, owner = `pid:${process.pid}`) {
    sqliteExec(dbPath, `DELETE FROM sync_locks WHERE scope_id = ${quoteSql(scopeId)} AND locked_by = ${quoteSql(owner)};`, `release lock ${scopeId}`);
}
function createRun(dbPath, scope, metadata = { runner: "scripts/lark-im-sync.mjs" }) {
    const rows = sqliteQuery(dbPath, `INSERT INTO sync_runs (source_id, scope_id, status, cursor_before_json, metadata_json)
     VALUES (
       ${quoteSql(scope.source_id)},
       ${quoteSql(scope.id)},
       'running',
       ${scope.cursor ? sqlJson(scope.cursor) : "NULL"},
       ${sqlJson(metadata)}
     )
     RETURNING id;`, `create run ${scope.id}`);
    return rows[0].id;
}
function failRun(dbPath, scope, runId, error) {
    const now = new Date().toISOString();
    sqliteExec(dbPath, `
BEGIN;
UPDATE sync_runs
SET status = 'failed',
    finished_at = ${quoteSql(now)},
    error_type = ${quoteSql(error.name || "Error")},
    error_message = ${quoteSql(String(error.message || error).slice(0, 4000))}
WHERE id = ${Number(runId)};
UPDATE sync_scopes
SET last_error_run_id = ${Number(runId)},
    updated_at = ${quoteSql(now)}
WHERE id = ${quoteSql(scope.id)};
COMMIT;
`, `fail run ${runId}`);
}
function existingRecordMap(dbPath, sourceId, records) {
    if (records.length === 0)
        return new Map();
    const ids = records.map((record) => quoteSql(record.external_id)).join(", ");
    const rows = sqliteQuery(dbPath, `SELECT external_id, content_hash
     FROM records
     WHERE source_id = ${quoteSql(sourceId)}
       AND external_id IN (${ids});`, "read existing records");
    return new Map(rows.map((row) => [row.external_id, row.content_hash]));
}
function upsertRecordsSql(records) {
    return records
        .map((record) => `
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
  updated_at = excluded.updated_at;
`)
        .join("\n");
}
function countWriteEffects(dbPath, sourceId, records) {
    const existing = existingRecordMap(dbPath, sourceId, records);
    let inserted = 0;
    let updated = 0;
    let duplicate = 0;
    for (const record of records) {
        if (!existing.has(record.external_id))
            inserted += 1;
        else if (existing.get(record.external_id) !== record.content_hash)
            updated += 1;
        else
            duplicate += 1;
    }
    return { inserted, updated, duplicate };
}
function succeedRecordRun(dbPath, scope, runId, records, scannedCount, cursor, metadata) {
    const effects = countWriteEffects(dbPath, scope.source_id, records);
    const now = new Date().toISOString();
    sqliteExec(dbPath, `
BEGIN;
${upsertRecordsSql(records)}
UPDATE sync_runs
SET status = 'succeeded',
    cursor_after_json = ${sqlJson(cursor)},
    finished_at = ${quoteSql(now)},
    scanned_count = ${Number(scannedCount)},
    inserted_count = ${Number(effects.inserted)},
    updated_count = ${Number(effects.updated)},
    duplicate_count = ${Number(effects.duplicate)},
    metadata_json = ${sqlJson(metadata)}
WHERE id = ${Number(runId)};
UPDATE sync_scopes
SET cursor_json = ${sqlJson(cursor)},
    cursor_updated_at = ${quoteSql(now)},
    last_success_run_id = ${Number(runId)},
    updated_at = ${quoteSql(now)}
WHERE id = ${quoteSql(scope.id)};
COMMIT;
`, `succeed run ${runId}`);
    return effects;
}
const succeedMessageRun = succeedRecordRun;
export { acquireLock, acquireMaintenanceLock, countWriteEffects, createRun, ensureInitialized, existingRecordMap, failRun, isMaintenanceLocked, recoverStaleSyncState, quoteSql, readScope, releaseLock, releaseMaintenanceLock, sqlJson, sqliteExec, sqliteQuery, succeedMessageRun, succeedRecordRun, upsertRecordsSql, };
