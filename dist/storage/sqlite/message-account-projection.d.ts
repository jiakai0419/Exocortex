/** Preserve already-attested acquisition ownership on an exact no-proof replay,
 * or keep the entire old canonical when the sole new fact is a later acquisition
 * clock for the identical source/identity/projection. This is first retained
 * evidence, not an assertion of the message's true first acquisition. Other new
 * or explicitly null evidence wins. The reader separately hashes exact raw.
 * Alias/expression arguments are trusted SQL fragments supplied by the store. */
declare function messageAccountRetentionStages(existingAlias: string, incomingAlias: string, previousStage: string, prefix?: string): {
    stages: string[];
    resultStage: string;
};
/** Standalone expression for callers without an existing projection stage
 * chain. The store uses the flat-stage API to avoid wrapping its large name
 * merge expression in another deeply nested WITH/CASE expression. */
declare function retainMessageAccountEvidenceSql(existingAlias: string, incomingAlias: string, mergedCanonicalExpression: string): string;
export { messageAccountRetentionStages, retainMessageAccountEvidenceSql };
