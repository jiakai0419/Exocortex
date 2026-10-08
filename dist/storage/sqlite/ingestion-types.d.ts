export type JsonObject = Record<string, any>;
export type SyncScope = {
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
export type StoredRecord = {
    source_id: string;
    first_seen_scope_id: string;
    external_id: string;
    external_version: string | null;
    /** Explicit observed predecessor for an authoritative unordered-token refresh. Never persisted. */
    expected_external_version?: string | null;
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
export type WriteEffects = {
    inserted: number;
    updated: number;
    duplicate: number;
};
export type BoundedReplayOptions = {
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
    /** Optional existing-record identity fence for explicitly selected repairs. */
    exactTargets?: Array<{
        id: number;
        external_id: string;
        container_id: string;
        occurred_at_ms: number;
        external_version: string;
    }>;
};
export type MaintenanceLockOptions = {
    owner?: string;
    ttlSeconds?: number;
    reason?: string;
    now?: Date;
};
export type MaintenanceLockResult = {
    acquired: boolean;
    reason?: "sync_locks_active" | "maintenance_locked";
    active_sync_locks?: number;
    lock_owner?: string | null;
};
export type OwnerState = "alive" | "dead" | "unknown";
export type RecoveryOptions = {
    scopeId?: string | null;
    now?: Date;
    ownerState?: (owner: string) => OwnerState;
    orphanRunSeconds?: number;
    hardLeaseSeconds?: number;
};
export type SqliteRow = Record<string, any>;
export type InitialSyncStartOptions = {
    explicit?: boolean;
    endMs?: number;
};
