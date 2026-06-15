// @ts-check

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} SyncScope
 * @property {string} id
 * @property {string} source_id
 * @property {string=} name
 * @property {number=} enabled
 * @property {string=} config_json
 * @property {string | null=} cursor_json
 * @property {JsonObject=} config
 * @property {JsonObject | null=} cursor
 *
 * @typedef {object} StoredRecord
 * @property {string} source_id
 * @property {string} first_seen_scope_id
 * @property {string} external_id
 * @property {string | null} external_version
 * @property {string} record_type
 * @property {string | null} occurred_at
 * @property {number} occurred_at_ms
 * @property {string | null} actor_id
 * @property {string | null} container_id
 * @property {string | null} direction
 * @property {string | null} title
 * @property {string} body
 * @property {string} content_hash
 * @property {string} canonical_json
 * @property {string} raw_json
 *
 * @typedef {object} WriteEffects
 * @property {number} inserted
 * @property {number} updated
 * @property {number} duplicate
 *
 * @typedef {"alive" | "dead" | "unknown"} OwnerState
 *
 * @typedef {object} RecoveryOptions
 * @property {string | null=} scopeId
 * @property {Date=} now
 * @property {((owner: string) => OwnerState)=} ownerState
 * @property {number=} orphanRunSeconds
 */

/** @param {unknown} value */
function quoteSql(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** @param {unknown} value */
function sqlJson(value) {
  return quoteSql(JSON.stringify(value));
}

/**
 * @param {string} dbPath
 * @param {string} sql
 * @param {string} label
 */
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

/**
 * @param {string} dbPath
 * @param {string} sql
 * @param {string} label
 * @returns {any[]}
 */
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

/** @param {string} owner */
function ownerPid(owner) {
  const match = String(owner || "").match(/^pid:(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * @param {string} owner
 * @returns {OwnerState}
 */
function defaultOwnerState(owner) {
  const pid = ownerPid(owner);
  if (!pid) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const err = /** @type {NodeJS.ErrnoException} */ (error);
    if (err.code === "ESRCH") return "dead";
    if (err.code === "EPERM") return "alive";
    return "unknown";
  }
}

/**
 * @param {unknown} value
 * @returns {OwnerState}
 */
function normalizeOwnerState(value) {
  const state = String(value);
  return state === "alive" || state === "dead" || state === "unknown" ? state : "unknown";
}

/**
 * @param {string} dbPath
 * @param {RecoveryOptions} [options]
 */
function recoverStaleSyncState(dbPath, options = {}) {
  const {
    scopeId = null,
    now = new Date(),
    ownerState = defaultOwnerState,
    orphanRunSeconds = 600,
  } = options;
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

/** @param {string} dbPath */
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

/**
 * @param {string} dbPath
 * @param {string} scopeId
 * @returns {SyncScope}
 */
function readScope(dbPath, scopeId) {
  const rows = sqliteQuery(
    dbPath,
    `SELECT id, source_id, name, enabled, config_json, cursor_json
     FROM sync_scopes
     WHERE id = ${quoteSql(scopeId)}
     LIMIT 1;`,
    `read scope ${scopeId}`,
  );
  if (!rows[0]) throw new Error(`sync scope not found: ${scopeId}`);
  return {
    ...rows[0],
    config: rows[0].config_json ? JSON.parse(rows[0].config_json) : {},
    cursor: rows[0].cursor_json ? JSON.parse(rows[0].cursor_json) : null,
  };
}

/**
 * @param {string} dbPath
 * @param {string} scopeId
 * @param {number} ttlSeconds
 * @param {string} [owner]
 */
function acquireLock(dbPath, scopeId, ttlSeconds, owner = `pid:${process.pid}`) {
  const now = new Date();
  const expires = new Date(now.getTime() + ttlSeconds * 1000);
  recoverStaleSyncState(dbPath, { scopeId, now });
  try {
    sqliteExec(
      dbPath,
      `
BEGIN IMMEDIATE;
INSERT INTO sync_locks (scope_id, locked_by, locked_at, expires_at)
VALUES (${quoteSql(scopeId)}, ${quoteSql(owner)}, ${quoteSql(now.toISOString())}, ${quoteSql(expires.toISOString())});
COMMIT;
`,
      `acquire lock ${scopeId}`,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed: sync_locks\.scope_id/.test(message)) return false;
    throw error;
  }
}

/**
 * @param {string} dbPath
 * @param {string} scopeId
 * @param {string} [owner]
 */
function releaseLock(dbPath, scopeId, owner = `pid:${process.pid}`) {
  sqliteExec(
    dbPath,
    `DELETE FROM sync_locks WHERE scope_id = ${quoteSql(scopeId)} AND locked_by = ${quoteSql(owner)};`,
    `release lock ${scopeId}`,
  );
}

/**
 * @param {string} dbPath
 * @param {SyncScope} scope
 * @param {JsonObject} [metadata]
 */
function createRun(dbPath, scope, metadata = { runner: "scripts/lark-im-sync.mjs" }) {
  const rows = sqliteQuery(
    dbPath,
    `INSERT INTO sync_runs (source_id, scope_id, status, cursor_before_json, metadata_json)
     VALUES (
       ${quoteSql(scope.source_id)},
       ${quoteSql(scope.id)},
       'running',
       ${scope.cursor ? sqlJson(scope.cursor) : "NULL"},
       ${sqlJson(metadata)}
     )
     RETURNING id;`,
    `create run ${scope.id}`,
  );
  return rows[0].id;
}

/**
 * @param {string} dbPath
 * @param {SyncScope} scope
 * @param {number} runId
 * @param {Error} error
 */
function failRun(dbPath, scope, runId, error) {
  const now = new Date().toISOString();
  sqliteExec(
    dbPath,
    `
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
`,
    `fail run ${runId}`,
  );
}

/**
 * @param {string} dbPath
 * @param {string} sourceId
 * @param {StoredRecord[]} records
 * @returns {Map<string, string>}
 */
function existingRecordMap(dbPath, sourceId, records) {
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

/** @param {StoredRecord[]} records */
function upsertRecordsSql(records) {
  return records
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
  updated_at = excluded.updated_at;
`,
    )
    .join("\n");
}

/**
 * @param {string} dbPath
 * @param {string} sourceId
 * @param {StoredRecord[]} records
 * @returns {WriteEffects}
 */
function countWriteEffects(dbPath, sourceId, records) {
  const existing = existingRecordMap(dbPath, sourceId, records);
  let inserted = 0;
  let updated = 0;
  let duplicate = 0;
  for (const record of records) {
    if (!existing.has(record.external_id)) inserted += 1;
    else if (existing.get(record.external_id) !== record.content_hash) updated += 1;
    else duplicate += 1;
  }
  return { inserted, updated, duplicate };
}

/**
 * @param {string} dbPath
 * @param {SyncScope} scope
 * @param {number} runId
 * @param {StoredRecord[]} records
 * @param {number} scannedCount
 * @param {JsonObject | null} cursor
 * @param {JsonObject} metadata
 * @returns {WriteEffects}
 */
function succeedRecordRun(dbPath, scope, runId, records, scannedCount, cursor, metadata) {
  const effects = countWriteEffects(dbPath, scope.source_id, records);
  const now = new Date().toISOString();
  sqliteExec(
    dbPath,
    `
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
`,
    `succeed run ${runId}`,
  );
  return effects;
}

const succeedMessageRun = succeedRecordRun;

export {
  acquireLock,
  countWriteEffects,
  createRun,
  ensureInitialized,
  existingRecordMap,
  failRun,
  recoverStaleSyncState,
  quoteSql,
  readScope,
  releaseLock,
  sqlJson,
  sqliteExec,
  sqliteQuery,
  succeedMessageRun,
  succeedRecordRun,
  upsertRecordsSql,
};
