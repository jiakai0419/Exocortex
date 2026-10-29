const HINT_STAGES = new Set(['state_read', 'source_policy_read', 'source_policy_decode', 'metadata_read', 'metadata_map']);
const FAILURE_STAGES = new Set(['batch_prepare', 'batch_select', 'batch_commit', 'single_target']);
const READ_KINDS = new Set(['dependency_unavailable', 'read_timeout', 'read_failed', 'invalid_response']);
const HINT_KINDS = new Set([...READ_KINDS, 'state_missing', 'state_invalid', 'invalid_policy', 'unknown']);
const FAILURE_KINDS = new Set([...READ_KINDS, 'unknown']);
const SELECTION_STOPS = new Set(['no_target', 'outside_pool', 'already_consumed', 'source_changed']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Exact, closed public structures. Never copy arbitrary nested error fields. */
export function sanitizeHistoryDiagnostic(value, role) {
    if (!object(value) || Object.keys(value).length !== 3 || value.version !== 1
        || !['version', 'stage', 'kind'].every(key => Object.hasOwn(value, key))
        || typeof value.stage !== 'string' || !(role === 'hint' ? HINT_STAGES : FAILURE_STAGES).has(value.stage)
        || typeof value.kind !== 'string' || !(role === 'hint' ? HINT_KINDS : FAILURE_KINDS).has(value.kind))
        return null;
    return { version: 1, stage: value.stage, kind: value.kind };
}
export function sanitizeHistorySelectionStops(value) {
    if (!object(value) || !Object.keys(value).length || Object.keys(value).some(key => !SELECTION_STOPS.has(key)))
        return null;
    const result = {};
    let total = 0;
    for (const [key, count] of Object.entries(value)) {
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 12)
            return null;
        result[key] = count;
        total += count;
    }
    return total > 12 ? null : result;
}
