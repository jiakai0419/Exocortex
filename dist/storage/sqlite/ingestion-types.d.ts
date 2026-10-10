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
    /** Internal, freshly computed local comparison. Never read from an approval. */
    observation?: {
        action: "accept" | "equivalent" | "conflict" | "older" | "stale";
        reason: string;
        before: Record<string, any> | null;
        generation: number | null;
        evidenceGeneration: number | null;
        incoming: Record<string, any>;
        attempt: string;
        observedAtMs: number;
        contextKey: string | null;
    };
};
export type WriteEffects = {
    inserted: number;
    updated: number;
    duplicate: number;
    conflicts?: number;
};
/** Trusted local snapshots rechecked inside an approved maintenance commit.
 * Artifact values never become SQL: workflows first read and validate the live
 * rows, then pass those complete rows through this additional transaction fence. */
export type MaintenanceReviewFence = {
    mode?: "names" | "replay";
    createdAtMs: number;
    expiresAtMs: number;
    sourceConfigJson: string;
    sentActor: string | null;
    records: Array<Record<string, unknown>>;
    scopes?: Array<{
        id: string;
        source_id: string;
        enabled: number;
        config_json: string;
    }>;
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
    observationAcquisition?: {
        attempt: string;
        startedAtMs: number;
        basis: Map<string, number>;
        confirm: boolean;
        contextKey: string;
    };
    /** Legacy approvals are an additional authorization gate, not source policy. */
    legacyApprovalGate?: boolean;
    history?: {
        generation: number;
        afterId: number;
        sweepMaxId: number;
        completedSweeps: number;
        selectedId: number;
        nextSweepMaxId: number;
        startedAtMs: number;
        error: string | null;
        requestBudget: Record<string, number | string | null>;
    };
    reviewFence?: MaintenanceReviewFence;
    /** Recheck local file/account binding after acquiring the maintenance lease. */
    reviewBeforeCommit?: () => void;
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
