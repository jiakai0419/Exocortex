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
};
type SqliteRow = Record<string, any>;
declare function quoteSql(value: unknown): string;
declare function sqlJson(value: unknown): string;
declare function sqliteExec(dbPath: string, sql: string, label: string): string;
declare function sqliteQuery(dbPath: string, sql: string, label: string): SqliteRow[];
declare function recoverStaleSyncState(dbPath: string, options?: RecoveryOptions): {
    recovered_locks: number;
    cancelled_runs: number;
    active_expired_locks: number;
};
declare function ensureInitialized(dbPath: string): void;
declare function readScope(dbPath: string, scopeId: string): SyncScope;
declare function isMaintenanceLocked(dbPath: string, now?: Date): boolean;
declare function acquireMaintenanceLock(dbPath: string, options?: MaintenanceLockOptions): MaintenanceLockResult;
declare function releaseMaintenanceLock(dbPath: string, owner?: string): void;
declare function acquireLock(dbPath: string, scopeId: string, ttlSeconds: number, owner?: string): boolean;
declare function releaseLock(dbPath: string, scopeId: string, owner?: string): void;
declare function createRun(dbPath: string, scope: SyncScope, metadata?: JsonObject): any;
declare function failRun(dbPath: string, scope: SyncScope, runId: number, error: Error): void;
declare function existingRecordMap(dbPath: string, sourceId: string, records: StoredRecord[]): Map<any, any>;
declare function upsertRecordsSql(records: StoredRecord[]): string;
declare function countWriteEffects(dbPath: string, sourceId: string, records: StoredRecord[]): WriteEffects;
declare function succeedRecordRun(dbPath: string, scope: SyncScope, runId: number, records: StoredRecord[], scannedCount: number, cursor: JsonObject | null, metadata: JsonObject): WriteEffects;
declare const succeedMessageRun: typeof succeedRecordRun;
export { acquireLock, acquireMaintenanceLock, countWriteEffects, createRun, ensureInitialized, existingRecordMap, failRun, isMaintenanceLocked, recoverStaleSyncState, quoteSql, readScope, releaseLock, releaseMaintenanceLock, sqlJson, sqliteExec, sqliteQuery, succeedMessageRun, succeedRecordRun, upsertRecordsSql, };
