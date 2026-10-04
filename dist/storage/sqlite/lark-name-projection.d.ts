/** SQL-side name merge shared by ingestion and enrichment. A missing/empty name
 * is unknown, including failed lookups. Only name_state='cleared' is a clear.
 * Keep name provenance together, and never carry it across different identities.
 * Ingestion evaluates this inside its write transaction; enrichment evaluates
 * a snapshot and commits only if that exact snapshot still matches. */
declare function mergeLarkNameProjectionSql(existingJson: string, incomingJson: string, existingActor: string, incomingActor: string, existingContainer: string, incomingContainer: string): string;
export { mergeLarkNameProjectionSql };
