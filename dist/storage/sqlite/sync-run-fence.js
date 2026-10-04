import { quoteSql } from "./sqlite-executor.js";
const DEFAULT_HARD_LEASE_SECONDS = 20 * 60;
const RUN_FENCE_METADATA_KEY = "__run_fence";
function scopeCursorJson(scope) {
    if (scope.cursor_json !== undefined)
        return scope.cursor_json;
    return scope.cursor === null || scope.cursor === undefined ? null : JSON.stringify(scope.cursor);
}
function validateRecordCursor(cursor, label) {
    if (cursor === null || cursor === undefined)
        return;
    if (typeof cursor !== "object" || Array.isArray(cursor)) {
        throw new Error(`${label} must be a JSON object or null`);
    }
    if (Object.prototype.hasOwnProperty.call(cursor, "created_at_ms")) {
        if (typeof cursor.created_at_ms !== "number" || !Number.isFinite(cursor.created_at_ms)) {
            throw new Error(`${label}.created_at_ms must be a finite number`);
        }
    }
}
function cursorCanAdvanceSql(beforeSql, incomingSql) {
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
function checkedRunId(runId) {
    if (!Number.isSafeInteger(runId) || runId <= 0)
        throw new Error(`invalid run id: ${String(runId)}`);
    return runId;
}
/** Build a guard to execute inside the same write transaction as every effect.
 * Ordinary completion requires enabled source/scope; failRun may only close an
 * owned run after disable. extraPredicate is trusted source-specific SQL. */
function runFenceGuardSql(scope, runId, finishedAtIso, options = {}) {
    const id = checkedRunId(runId);
    if (!Number.isFinite(Date.parse(finishedAtIso)))
        throw new Error("invalid run finish time");
    const table = options.guardTable || "__run_fence_guard";
    if (!/^__[a-z_]+$/.test(table))
        throw new Error("invalid run fence table");
    return `
    CREATE TEMP TABLE ${table} (
      allowed INTEGER PRIMARY KEY CHECK (allowed = 1), lock_owner TEXT NOT NULL,
      lock_acquired_at TEXT NOT NULL, implicit INTEGER NOT NULL
    );
    INSERT INTO ${table}
    SELECT 1, l.locked_by, l.locked_at,
      COALESCE(json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.implicit'), 0)
    FROM sync_runs r
    JOIN sync_scopes s ON s.id = r.scope_id AND s.source_id = r.source_id
    JOIN sources src ON src.id = s.source_id
    JOIN sync_locks l ON l.scope_id = r.scope_id
    WHERE r.id = ${id} AND r.status = 'running'
      AND r.scope_id = ${quoteSql(scope.id)} AND r.source_id = ${quoteSql(scope.source_id)}
      AND l.locked_by = json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.owner')
      AND l.locked_at = json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.locked_at')
      AND julianday(l.locked_at) > julianday('now') - ${DEFAULT_HARD_LEASE_SECONDS} / 86400.0
      AND s.cursor_json IS r.cursor_before_json
      ${options.requireEnabled === false ? "" : "AND s.enabled = 1 AND src.enabled = 1"}
      AND (${options.extraPredicate || "1"});
    ${options.assert ? `CREATE TEMP TABLE ${table}_assert (allowed INTEGER NOT NULL CHECK (allowed = 1));
    INSERT INTO ${table}_assert SELECT CASE WHEN EXISTS (SELECT 1 FROM ${table}) THEN 1 ELSE 0 END;` : ""}
  `;
}
export { DEFAULT_HARD_LEASE_SECONDS, RUN_FENCE_METADATA_KEY, scopeCursorJson, validateRecordCursor, cursorCanAdvanceSql, checkedRunId, runFenceGuardSql };
