import { initializeDatabase } from "./initialize.js";
import type { JsonObject, SyncScope, StoredRecord, WriteEffects, InitialSyncStartOptions } from "./ingestion-types.js";
import { quoteSql, sqlJson, sqliteExec, sqliteQuery, secureDatabasePaths } from "./sqlite-executor.js";
import { DEFAULT_HARD_LEASE_SECONDS, RUN_FENCE_METADATA_KEY, scopeCursorJson, validateRecordCursor, cursorCanAdvanceSql, checkedRunId, runFenceGuardSql } from "./sync-run-fence.js";
import { DEFAULT_SYNC_LOCK_OWNER, acquireLock, acquireMaintenanceLock, releaseLock, releaseMaintenanceLock, isMaintenanceLocked, recoverStaleSyncState, ownerPid, ownerStartedAtMs, defaultOwnerState } from "./sync-locks.js";
import { encodeSourceVersion, normalizeStoredRecords, normalizeBoundedReplayRecords, normalizeExternalVersion, recordWritesSql, existingRecordMap, countWriteEffects, upsertRecordsSql } from "./record-storage.js";
import { larkRunMetadataEntriesSql, commitBoundedReplayRecords, commitLarkListRun, finishLarkDetailRun, readLarkListProgress, readPendingLarkDetails } from "./lark-ingestion.js";
const DEFAULT_IMPLICIT_RUN_LOCK_SECONDS = 10 * 60;

const ensureInitialized = initializeDatabase;

function readScope(dbPath: string, scopeId: string): SyncScope {
  const rows = sqliteQuery(
    dbPath,
    `SELECT s.id, s.source_id, s.name, s.enabled, s.config_json, s.cursor_json, src.enabled AS source_enabled
     FROM sync_scopes s JOIN sources src ON src.id = s.source_id
     WHERE s.id = ${quoteSql(scopeId)}
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
  if (row.enabled !== 1) throw new Error("cannot sync a disabled source");
  const config: unknown = JSON.parse(row.config_json);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("source config must be a JSON object for initial sync baseline");
  }
  if (!Object.prototype.hasOwnProperty.call(config, "initial_sync_start_ms")) {
    if (!candidateFitsEnd) throw new Error("--end must be after the initial sync baseline");
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

function createRun(
  dbPath: string,
  scope: SyncScope,
  metadata: JsonObject = { runner: "bin/exocortex.mjs sync" },
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
       AND EXISTS (SELECT 1 FROM sync_scopes s JOIN sources src ON src.id=s.source_id
         WHERE s.id=${quoteSql(scope.id)} AND s.source_id=${quoteSql(scope.source_id)}
           AND s.enabled=1 AND src.enabled=1 AND s.cursor_json IS ${quoteSql(expectedCursorJson)})
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
         ${scope.source_id === "lark.im" ? larkRunMetadataEntriesSql() : ""}
       )
     FROM sync_scopes s
     JOIN sync_locks l ON l.scope_id = s.id
     JOIN sources src ON src.id = s.source_id
     WHERE s.enabled = 1 AND src.enabled = 1
       AND s.id = ${quoteSql(scope.id)}
       AND s.source_id = ${quoteSql(scope.source_id)}
       AND s.cursor_json IS ${quoteSql(expectedCursorJson)}
       AND l.locked_by = ${quoteSql(owner)}
       AND julianday(l.locked_at) > julianday('now') - ${DEFAULT_HARD_LEASE_SECONDS} / 86400.0
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
  const rows = sqliteQuery(
    dbPath,
    `
    BEGIN IMMEDIATE;
    ${runFenceGuardSql(scope, id, now, { requireEnabled: false })}
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
  const rows = sqliteQuery(
    dbPath,
    `
    BEGIN IMMEDIATE;
    ${runFenceGuardSql(scope, id, now, { extraPredicate: error ? "1" : cursorCanAdvanceSql("r.cursor_before_json", cursorJsonSql) })}
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
  encodeSourceVersion,
  normalizeExternalVersion,
  normalizeStoredRecords,
  ownerPid,
  ownerStartedAtMs,
  defaultOwnerState,
  recoverStaleSyncState,
  runFenceGuardSql,
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
