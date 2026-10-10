/** A comparison of saved parsed-CLI evidence, never a client-state assertion. */
declare const OBSERVATION_POLICY = "lark_raw_observation/v1";
type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json;
};
declare function stable(value: Json): string;
/** Refuse duplicate keys and numbers whose original value cannot be represented
 * exactly. Failure removes a proof; it never discards or rewrites raw evidence. */
declare function parseEvidence(text: string): Json;
type SourceProof = {
    policy: string;
    outer: string | null;
    structural: string | null;
    references: string | null;
    native: boolean;
};
declare function sourceProof(rawJson: string): SourceProof;
type ObservationRecord = {
    source_id: string;
    external_id: string;
    external_version: string | null;
    record_type: string;
    occurred_at_ms: number;
    container_id: string | null;
    raw_json: string;
    body: string;
    canonical_json: string;
    title: string | null;
};
declare function isNativeRecord(record: ObservationRecord): boolean;
type SourceRelation = "exact" | "json_representation" | "reference_rename" | "different" | "unverified";
declare function sourceRelation(before: string, incoming: string): SourceRelation;
declare function compareObservation(before: ObservationRecord, incoming: ObservationRecord): {
    policy: string;
    identity: string;
    version: string;
    representation: SourceRelation;
    equivalent: boolean;
    projection: string;
};
/** Keep one representative of an equivalent source; name merge remains SQL's
 * responsibility. Do not let alias allocation churn canonical source fields. */
declare function retainSourceRepresentation<T extends ObservationRecord & {
    content_hash: string;
}>(before: T, incoming: T): T;
/** Approval proof binds every effective field and canonical dependency. Native
 * redundant mentions may be represented by the graph proof only when they equal
 * the actual raw definitions. Unknown canonical fields are always included. */
declare function recordProof(record: Record<string, any>): {
    policy: string;
    exact: string;
    structural: string | null;
    references: string | null;
};
export { recordProof, OBSERVATION_POLICY, parseEvidence, stable, sourceProof, sourceRelation, compareObservation, retainSourceRepresentation, isNativeRecord };
export type { ObservationRecord, SourceProof, SourceRelation };
