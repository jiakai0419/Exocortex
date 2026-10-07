import type { JsonObject, SyncScope, StoredRecord, WriteEffects, BoundedReplayOptions } from "./ingestion-types.js";
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
type LarkDetailOutcome = {
    message_id: string;
    fingerprint: string;
    record?: StoredRecord;
    error?: Error;
    retry_at?: string;
};
type PendingLarkDetail = JsonObject & {
    message_id: string;
    fingerprint: string;
    raw_root: JsonObject;
    raw: JsonObject;
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
}): PendingLarkDetail[];
/** Call only after the complete list window has passed pagination validation. */
declare function commitLarkListRun(dbPath: string, scope: SyncScope, runId: number, records: StoredRecord[], rawMergeRoots: JsonObject[], scannedCount: number, listCursor: JsonObject, metadata: JsonObject): LarkProgressEffects;
/** A complete detail response replaces content; failed attempts only reschedule debt. */
declare function finishLarkDetailRun(dbPath: string, scope: SyncScope, runId: number, outcomes: LarkDetailOutcome[], metadata?: JsonObject): LarkProgressEffects;
declare function larkRunMetadataEntriesSql(): string;
export { larkRunMetadataEntriesSql, commitBoundedReplayRecords, commitLarkListRun, finishLarkDetailRun, readLarkListProgress, readPendingLarkDetails };
