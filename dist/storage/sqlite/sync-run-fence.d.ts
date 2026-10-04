import type { JsonObject, SyncScope } from "./ingestion-types.js";
declare const DEFAULT_HARD_LEASE_SECONDS: number;
declare const RUN_FENCE_METADATA_KEY = "__run_fence";
declare function scopeCursorJson(scope: SyncScope): string | null;
declare function validateRecordCursor(cursor: JsonObject | null | undefined, label: string): void;
declare function cursorCanAdvanceSql(beforeSql: string, incomingSql: string): string;
declare function checkedRunId(runId: number): number;
/** Build a guard to execute inside the same write transaction as every effect.
 * Ordinary completion requires enabled source/scope; failRun may only close an
 * owned run after disable. extraPredicate is trusted source-specific SQL. */
declare function runFenceGuardSql(scope: SyncScope, runId: number, finishedAtIso: string, options?: {
    guardTable?: string;
    assert?: boolean;
    requireEnabled?: boolean;
    extraPredicate?: string;
}): string;
export { DEFAULT_HARD_LEASE_SECONDS, RUN_FENCE_METADATA_KEY, scopeCursorJson, validateRecordCursor, cursorCanAdvanceSql, checkedRunId, runFenceGuardSql };
