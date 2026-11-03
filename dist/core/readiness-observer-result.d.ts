/** Shared by the sync producer and worker consumer. Invalid child receipts are
 * omitted/replaced by their caller, never spread into a public log.
 * @param {unknown} value @returns {Record<string,any>|null} */
export declare function normalizeReadinessObservation(value: unknown): Record<string, any> | null;
