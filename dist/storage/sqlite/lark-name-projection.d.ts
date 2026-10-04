/** Empty values and every explicit source ID echo are unknown. This predicate
 * does not override the separate authoritative-clear rules in the merge. */
declare function larkSenderNameIsUnknownSql(canonical: string, raw: string, actor: string): string;
/** Resolve source namespaces before comparing names. Legacy prefixes are only
 * an inheritance compatibility rule, never permission to perform a lookup.
 * Explicit raw evidence wins over a missing canonical type; contradictory
 * explicit evidence cannot inherit a name, even when the ID bytes match. */
declare function larkSenderNamespaceSql(canonical: string, raw: string, actor: string, allowLegacy?: boolean): string;
/** SQL-side name merge shared by ingestion and enrichment. A missing/empty name
 * is unknown, including failed lookups. Only name_state='cleared' is a clear.
 * Historical chat names may fill unknown fields, but cannot undo an explicit
 * clear or replace a known name. A fresh message name may do either.
 * Keep name provenance together, and never carry it across different identities.
 * Ingestion evaluates this inside its write transaction; enrichment evaluates
 * a snapshot and commits only if that exact snapshot still matches. */
declare function mergeLarkNameProjectionSql(existingJson: string, incomingJson: string, existingActor: string, incomingActor: string, existingContainer: string, incomingContainer: string, existingRaw?: string, incomingRaw?: string): string;
export { larkSenderNameIsUnknownSql, larkSenderNamespaceSql, mergeLarkNameProjectionSql };
