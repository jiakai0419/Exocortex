import type { JsonObject, StoredRecord, SyncScope } from "./ingestion-types.js";
export type PendingDetailAcquisition = {
    task: JsonObject;
    attempt: string;
    startedAtMs: number;
    databaseKey: string;
    contextKey: string;
};
/** Context is based on the existing verified request admission, never on
 * display names, retry metadata or list generations. */
export declare function pendingDetailContextKey(databaseKey: string, scope: SyncScope): string;
/** All fields are local snapshots. Check before record insertion in the same
 * run-fenced transaction; a concurrent new record changes the observation owner. */
export declare function pendingDetailGuardSql(scope: SyncScope, runId: number, acquisition: PendingDetailAcquisition): string;
export declare function preparePendingDetailObservation(scope: SyncScope, incoming: StoredRecord, acquisition: PendingDetailAcquisition, root: {
    raw_json: string;
    fingerprint: string;
    external_version: string | null;
    occurred_at_ms: number;
}): {
    accepted: boolean;
    evidenceSql: string;
    failureReason?: string;
};
