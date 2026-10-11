/** Accept only explicit, real calendar timestamps; never coerce epoch numbers.
 * Shared by worker wait acceptance and retained runtime statistics.
 * @param {unknown} value @returns {number | null} */
export function parseWorkerEventTimestamp(value: unknown): number | null;
