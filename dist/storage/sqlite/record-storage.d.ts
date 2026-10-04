import type { StoredRecord, WriteEffects } from "./ingestion-types.js";
declare function existingRecordMap(dbPath: string, sourceId: string, records: StoredRecord[]): Map<any, any>;
/** Encode adapter evidence without inferring ordering from a token's spelling.
 * Decimal revisions are ordered; opaque tokens retain exact string identity. */
declare function encodeSourceVersion(value: {
    revision: string | number | bigint;
    token?: never;
} | {
    token: string;
    revision?: never;
}): string;
declare function normalizeExternalVersion(value: unknown): string | null;
declare function normalizeStoredRecords(records: StoredRecord[], sourceId?: string): StoredRecord[];
/** A repair must not silently choose between unordered conflicting page items. */
declare function normalizeBoundedReplayRecords(records: StoredRecord[], sourceId: string): StoredRecord[];
declare function numericVersionSql(valueSql: string): string;
declare function versionCanReplaceSql(existingAlias: string, incomingAlias: string, expectedVersionSql?: string): string;
declare function upsertRecordsSql(records: StoredRecord[], options?: {
    strictVersionIncrease?: boolean;
}): string;
declare function countWriteEffects(dbPath: string, sourceId: string, records: StoredRecord[]): WriteEffects;
declare function recordWritesSql(normalizedRecords: StoredRecord[], now: string): string;
export { encodeSourceVersion, existingRecordMap, normalizeExternalVersion, normalizeStoredRecords, normalizeBoundedReplayRecords, numericVersionSql, versionCanReplaceSql, upsertRecordsSql, recordWritesSql, countWriteEffects };
