const HINT_STAGES = new Set(['state_read', 'source_policy_read', 'source_policy_decode', 'metadata_read', 'metadata_map']);
const FAILURE_STAGES = new Set(['batch_prepare', 'batch_select', 'batch_commit', 'single_target']);
const READ_KINDS = new Set(['dependency_unavailable', 'read_timeout', 'read_failed', 'invalid_response']);
const HINT_KINDS = new Set([...READ_KINDS, 'state_missing', 'state_invalid', 'invalid_policy', 'unknown']);
const TRANSPORT_KINDS = new Set(['success', 'network_timeout', 'network_error', 'rate_limited', 'service_unavailable',
    'internal_error', 'restricted_mode', 'bot_user_out_of_chat', 'permission_denied', 'command_unavailable', 'spawn_error', 'unknown']);
const LOCAL_REASONS = new Set(['clock_unavailable', 'shared_cooldown_unavailable', 'retry_wait_unavailable', 'lease_unavailable', 'invalid_json']);
const TRANSPORT_OPERATIONS = new Set(['message_history_bundle', 'message_search_bundle', 'chat_discovery_bundle',
    'self_profile', 'contact_search', 'chat_members', 'chat_bots', 'application_info', 'other']);
const HISTORY_FAILURE_OPERATIONS = new Set(['account_snapshot', 'opening_self', 'account_admission', 'target_select',
    'candidate_pool', 'write_admission', 'message_fetch', 'message_prepare', 'closing_self', 'admission_recheck',
    'binding_recheck', 'storage_commit', 'history_target_read', 'detail_basis', 'legacy_fetch', 'current_target_select']);
export function isHistoryFailureOperation(value) {
    return typeof value === 'string' && HISTORY_FAILURE_OPERATIONS.has(value);
}
const FAILURE_KINDS = new Set([...READ_KINDS, ...TRANSPORT_KINDS, ...LOCAL_REASONS,
    'cli_budget', 'self_budget', 'time_budget', 'sync_busy', 'rate_cooldown',
    'request_not_started', 'request_execution_unknown', 'request_invalid_json']);
FAILURE_KINDS.delete('success');
const SELECTION_STOPS = new Set(['no_target', 'outside_pool', 'already_consumed', 'source_changed']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Exact, closed public structures. Never copy arbitrary nested error fields. */
export function sanitizeHistoryDiagnostic(value, role) {
    const allowed = role === 'hint' ? ['version', 'stage', 'kind'] : ['version', 'stage', 'kind', 'operation', 'transport'];
    if (!object(value) || value.version !== 1 || Object.keys(value).some(key => !allowed.includes(key))
        || !['version', 'stage', 'kind'].every(key => Object.hasOwn(value, key))
        || typeof value.stage !== 'string' || !(role === 'hint' ? HINT_STAGES : FAILURE_STAGES).has(value.stage)
        || typeof value.kind !== 'string' || !(role === 'hint' ? HINT_KINDS : FAILURE_KINDS).has(value.kind))
        return null;
    const result = { version: 1, stage: value.stage, kind: value.kind };
    if (Object.hasOwn(value, 'operation')) {
        if (typeof value.operation !== 'string' || !HISTORY_FAILURE_OPERATIONS.has(value.operation))
            return null;
        result.operation = value.operation;
    }
    if (Object.hasOwn(value, 'transport')) {
        const t = value.transport;
        const fields = ['operation', 'execution', 'result_kind', 'result_code', 'remote_result', 'local_reason'];
        if (!object(t) || Object.keys(t).length !== fields.length || fields.some(key => !Object.hasOwn(t, key))
            || typeof t.operation !== 'string' || !TRANSPORT_OPERATIONS.has(t.operation)
            || typeof t.execution !== 'string' || !['not_started', 'started', 'unknown'].includes(t.execution)
            || t.result_kind !== null && (typeof t.result_kind !== 'string' || !TRANSPORT_KINDS.has(t.result_kind))
            || t.result_code !== null && (typeof t.result_code !== 'number' || !Number.isSafeInteger(t.result_code) || t.result_code < 0)
            || typeof t.remote_result !== 'boolean'
            || t.local_reason !== null && (typeof t.local_reason !== 'string' || !LOCAL_REASONS.has(t.local_reason))
            || t.execution !== 'started' && (t.result_kind !== null || t.result_code !== null || t.remote_result)
            || t.execution === 'started' && t.result_kind === null
            || t.result_code !== null && !t.remote_result
            || t.result_kind === 'success' && t.result_code !== null && t.result_code !== 0)
            return null;
        result.transport = { operation: t.operation, execution: t.execution, result_kind: t.result_kind,
            result_code: t.result_code, remote_result: t.remote_result, local_reason: t.local_reason };
    }
    return result;
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
