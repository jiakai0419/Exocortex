import type { OwnerState, RecoveryOptions, MaintenanceLockOptions, MaintenanceLockResult } from "./ingestion-types.js";
declare const DEFAULT_SYNC_LOCK_OWNER: string;
declare function ownerPid(owner: string): number | null;
declare function ownerStartedAtMs(owner: string): number | null;
declare function defaultOwnerState(owner: string): OwnerState;
declare function recoverStaleSyncState(dbPath: string, options?: RecoveryOptions): {
    recovered_locks: number;
    cancelled_runs: number;
    active_expired_locks: number;
};
declare function isMaintenanceLocked(dbPath: string, now?: Date): boolean;
declare function acquireMaintenanceLock(dbPath: string, options?: MaintenanceLockOptions): MaintenanceLockResult;
declare function releaseMaintenanceLock(dbPath: string, owner?: string): void;
declare function acquireLock(dbPath: string, scopeId: string, ttlSeconds: number, owner?: string): boolean;
declare function releaseLock(dbPath: string, scopeId: string, owner?: string): void;
export { DEFAULT_SYNC_LOCK_OWNER, ownerPid, ownerStartedAtMs, defaultOwnerState, recoverStaleSyncState, isMaintenanceLocked, acquireMaintenanceLock, releaseMaintenanceLock, acquireLock, releaseLock };
