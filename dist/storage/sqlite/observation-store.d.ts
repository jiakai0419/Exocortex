import type { StoredRecord } from "./ingestion-types.js";
type Acquisition = {
    attempt: string;
    startedAtMs: number;
    basis?: Map<string, number>;
    confirm?: boolean;
    contextKey?: string;
};
type ObservationState = {
    generation: number;
    evidenceGeneration: number;
    candidate_json: string | null;
    candidate_generation: number | null;
    candidate_attempt: string | null;
    candidate_policy: string | null;
    candidate_context: string | null;
    candidate_observed_at_ms: number | null;
};
/** One source decision for accepted records and incomplete detail descriptors.
 * Callers own acquisition, bounded evidence storage and transaction/CAS guards.
 * In particular, this function never treats a descriptor as a stored record or
 * a repeated observation as proof of the latest remote state. */
declare function evaluateObservation(before: StoredRecord | null, incoming: StoredRecord, state: ObservationState | null, acquisition: Acquisition): {
    record: StoredRecord;
    action: "stale";
    reason: string;
    preserveCandidate: boolean;
} | {
    record: StoredRecord;
    action: "conflict" | "older" | "accept" | "equivalent";
    reason: string;
    preserveCandidate: boolean;
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
export { evaluateObservation, prepareObservationRecords, observationGuardSql, observationEvidenceSql, observationAllowsSql };
export type { Acquisition, ObservationState };
