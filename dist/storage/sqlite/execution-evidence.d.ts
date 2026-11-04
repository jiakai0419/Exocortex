type SqlState = 'not_started' | 'started' | 'unknown';
type Cleanup = 'not_started' | 'complete' | 'failed' | 'unknown';
export declare function createSqlExecutionEvidence(): object;
export declare function markSqlDispatch(token: unknown): void;
/** Only called with the actual synchronous process result, never an error chain. */
export declare function observeSqlProcess(token: unknown, result: {
    pid?: number;
    status?: number | null;
    error?: unknown;
}): void;
export declare function readSqlExecutionEvidence(token: unknown): SqlState | null;
export declare function createReplayExecutionEvidence(attempt: string, fence: string): object;
export declare function markReplayActionEntered(token: unknown): void;
export declare function markReplayStorageEntered(token: unknown): void;
export declare function replaySqlEvidence(token: unknown): object | undefined;
export declare function markReplayUncertain(token: unknown): void;
export declare function markReplayReceipt(token: unknown, audit: string, effects: {
    inserted: number;
    updated: number;
    duplicate: number;
    conflicts: number;
}): void;
export declare function markReplayCleanup(token: unknown, owner: 'storage' | 'lease', value: Cleanup): void;
export declare function readReplayExecutionEvidence(token: unknown): Readonly<{
    audit_ref?: string | undefined;
    effects?: {
        inserted: number;
        updated: number;
        duplicate: number;
        conflicts: number;
    } | undefined;
    version: 1;
    attempt_ref: string;
    target_ref: string;
    action_entered: boolean;
    sql_execution: SqlState;
    receipt_validated: boolean;
    commit_state: "unknown" | "not_started" | "committed";
    cleanup_state: "unknown" | "not_started" | "complete" | "failed";
}> | null;
export {};
