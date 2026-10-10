import type { StoredRecord } from "./ingestion-types.js";
type Acquisition = {
    attempt: string;
    startedAtMs: number;
    basis?: Map<string, number>;
    confirm?: boolean;
    contextKey?: string;
};
/** Read outside the transaction, then bind the complete local row and its ABA
 * generation inside it. The result is internal data, never approval input. */
declare function prepareObservationRecords(dbPath: string, records: StoredRecord[], acquisition?: Acquisition): StoredRecord[];
/** The preparation basis is checked even for a no-op, so preview and commit
 * cannot silently decide against different local facts. */
declare function observationGuardSql(records: StoredRecord[]): string;
/** Before the final record write, so SQLite changes() still refers to records.
 * All statements share the caller's fenced transaction. Current/previous/pending
 * are bounded slots, not an assertion that every historical edit is retained. */
declare function observationEvidenceSql(records: StoredRecord[], admission?: string): string;
declare function observationAllowsSql(record: StoredRecord): string | null;
export { prepareObservationRecords, observationGuardSql, observationEvidenceSql, observationAllowsSql };
export type { Acquisition };
