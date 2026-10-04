type JsonObject = Record<string, any>;
type SyncScope = {
    id: string;
    source_id: string;
    name?: string;
    enabled?: number;
    source_enabled?: number;
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
declare const DEFAULT_HARD_LEASE_SECONDS: number;
declare function quoteSql(value: unknown): string;
declare function sqlJson(value: unknown): string;
declare function secureDatabasePaths(dbPath: string): string;
declare function sqliteExec(dbPath: string, sql: string, label: string): string;
declare function sqliteQuery(dbPath: string, sql: string, label: string): SqliteRow[];
declare function ownerPid(owner: string): number | null;
declare function ownerStartedAtMs(owner: string): number | null;
declare function defaultOwnerState(owner: string): OwnerState;
declare function recoverStaleSyncState(dbPath: string, options?: RecoveryOptions): {
    recovered_locks: number;
    cancelled_runs: number;
    active_expired_locks: number;
};
declare function ensureInitialized(dbPath: string): void;
declare function readScope(dbPath: string, scopeId: string): SyncScope;
declare function validateInitialSyncStartMs(value: unknown): number;
declare function ensureSourceInitialSyncStart(dbPath: string, sourceId: string, candidateStartMs: number, options?: InitialSyncStartOptions): number;
declare function isMaintenanceLocked(dbPath: string, now?: Date): boolean;
declare function acquireMaintenanceLock(dbPath: string, options?: MaintenanceLockOptions): MaintenanceLockResult;
declare function releaseMaintenanceLock(dbPath: string, owner?: string): void;
declare function acquireLock(dbPath: string, scopeId: string, ttlSeconds: number, owner?: string): boolean;
declare function releaseLock(dbPath: string, scopeId: string, owner?: string): void;
/** Build a guard to execute inside the same write transaction as every effect.
 * Ordinary completion requires enabled source/scope; failRun may only close an
 * owned run after disable. extraPredicate is trusted source-specific SQL. */
declare function runFenceGuardSql(scope: SyncScope, runId: number, finishedAtIso: string, options?: {
    guardTable?: string;
    assert?: boolean;
    requireEnabled?: boolean;
    extraPredicate?: string;
}): string;
declare function createRun(dbPath: string, scope: SyncScope, metadata?: JsonObject, owner?: string): number;
declare function failRun(dbPath: string, scope: SyncScope, runId: number, error: Error): boolean;
declare function existingRecordMap(dbPath: string, sourceId: string, records: StoredRecord[]): Map<any, any>;
declare function normalizeExternalVersion(value: unknown): string | null;
declare function normalizeStoredRecords(records: StoredRecord[], sourceId?: string): StoredRecord[];
/** A repair must not silently choose between unordered conflicting page items. */
declare function normalizeBoundedReplayRecords(records: StoredRecord[], sourceId: string): StoredRecord[];
declare function upsertRecordsSql(records: StoredRecord[], options?: {
    strictVersionIncrease?: boolean;
}): string;
/** Commit one completely fetched, explicitly bounded repair without touching
 * normal runs, scope cursors, or freshness markers. Remote work belongs outside
 * this method; only this short transaction holds a maintenance lease. */
declare function commitBoundedReplayRecords(dbPath: string, options: BoundedReplayOptions): {
    audit_id: string;
    inserted: number;
    updated: number;
    duplicate: number;
    conflicts: number;
};
declare function countWriteEffects(dbPath: string, sourceId: string, records: StoredRecord[]): WriteEffects;
declare function succeedRecordRun(dbPath: string, scope: SyncScope, runId: number, records: StoredRecord[], scannedCount: number, cursor: JsonObject | null, metadata: JsonObject): WriteEffects;
/** Save validated records from an incomplete window without claiming coverage. */
declare function failRecordRun(dbPath: string, scope: SyncScope, runId: number, records: StoredRecord[], scannedCount: number, error: Error, metadata: JsonObject): WriteEffects;
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
declare function readLarkListProgress(dbPath: string, scope: SyncScope): {
    cursor: any;
    anchor_cursor: any;
} | null;
/** Only due debt is returned; completed descriptors are durable replay receipts. */
declare function readPendingLarkDetails(dbPath: string, scope: SyncScope, { limit, now }?: {
    limit?: number;
    now?: Date | string;
}): {
    raw_root: any;
    raw: any;
}[];
/** Call only after the complete list window has passed pagination validation. */
declare function commitLarkListRun(dbPath: string, scope: SyncScope, runId: number, records: StoredRecord[], rawMergeRoots: JsonObject[], scannedCount: number, listCursor: JsonObject, metadata: JsonObject): LarkProgressEffects;
/** A complete detail response replaces content; failed attempts only reschedule debt. */
declare function finishLarkDetailRun(dbPath: string, scope: SyncScope, runId: number, outcomes: LarkDetailOutcome[], metadata?: JsonObject): LarkProgressEffects;
declare const succeedMessageRun: typeof succeedRecordRun;
export { DEFAULT_HARD_LEASE_SECONDS, acquireLock, acquireMaintenanceLock, countWriteEffects, commitBoundedReplayRecords, commitLarkListRun, finishLarkDetailRun, readLarkListProgress, readPendingLarkDetails, normalizeBoundedReplayRecords, createRun, ensureInitialized, ensureSourceInitialSyncStart, existingRecordMap, failRun, failRecordRun, isMaintenanceLocked, normalizeExternalVersion, normalizeStoredRecords, ownerPid, ownerStartedAtMs, defaultOwnerState, recoverStaleSyncState, runFenceGuardSql, quoteSql, readScope, releaseLock, releaseMaintenanceLock, secureDatabasePaths, sqlJson, sqliteExec, sqliteQuery, succeedMessageRun, succeedRecordRun, upsertRecordsSql, validateInitialSyncStartMs, };
