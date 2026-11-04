import { createHash } from 'node:crypto';
const sqlEvidence = new WeakMap();
const replayEvidence = new WeakMap();
const digest = (value) => createHash('sha256').update(value).digest('hex');
const owned = (value) => value !== null && typeof value === 'object';
export function createSqlExecutionEvidence() {
    const token = Object.freeze({});
    sqlEvidence.set(token, 'not_started');
    return token;
}
export function markSqlDispatch(token) {
    if (owned(token) && sqlEvidence.has(token))
        sqlEvidence.set(token, 'unknown');
}
/** Only called with the actual synchronous process result, never an error chain. */
export function observeSqlProcess(token, result) {
    if (!owned(token) || !sqlEvidence.has(token))
        return;
    const code = result.error?.code;
    const started = Number.isSafeInteger(result.pid) && Number(result.pid) > 0;
    const definiteLaunchFailure = !started && ['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC'].includes(String(code));
    sqlEvidence.set(token, definiteLaunchFailure ? 'not_started'
        : started || !result.error && Number.isSafeInteger(result.status) ? 'started' : 'unknown');
}
export function readSqlExecutionEvidence(token) {
    return owned(token) ? sqlEvidence.get(token) ?? null : null;
}
export function createReplayExecutionEvidence(attempt, fence) {
    if (!attempt || !/^[a-f0-9]{64}$/.test(fence))
        throw new TypeError('invalid replay evidence binding');
    const token = Object.freeze({});
    replayEvidence.set(token, { attempt_ref: digest(`attempt\0${attempt}`), target_ref: digest(`target\0${attempt}\0${fence}`),
        action_entered: false, sql: createSqlExecutionEvidence(), receipt_validated: false,
        storage_cleanup: 'not_started', lease_cleanup: 'not_started' });
    return token;
}
export function markReplayActionEntered(token) {
    const state = owned(token) ? replayEvidence.get(token) : null;
    if (state)
        state.action_entered = true;
}
export function markReplayStorageEntered(token) {
    const state = owned(token) ? replayEvidence.get(token) : null;
    if (state) {
        state.action_entered = true;
        state.storage_entered = true;
    }
}
export function replaySqlEvidence(token) {
    return owned(token) ? replayEvidence.get(token)?.sql : undefined;
}
export function markReplayUncertain(token) {
    const state = owned(token) ? replayEvidence.get(token) : null;
    if (state)
        state.uncertain_commit = true;
}
export function markReplayReceipt(token, audit, effects) {
    const state = owned(token) ? replayEvidence.get(token) : null;
    if (state && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(audit)
        && Object.values(effects).every(value => Number.isSafeInteger(value) && value >= 0)) {
        state.receipt_validated = true;
        state.audit_ref = digest(`audit\0${audit}`);
        state.effects = { ...effects };
    }
}
export function markReplayCleanup(token, owner, value) {
    const state = owned(token) ? replayEvidence.get(token) : null;
    if (state)
        state[owner === 'storage' ? 'storage_cleanup' : 'lease_cleanup'] = value;
}
export function readReplayExecutionEvidence(token) {
    const state = owned(token) ? replayEvidence.get(token) : null;
    if (!state)
        return null;
    const sql = state.action_entered && !state.storage_entered ? 'unknown' : readSqlExecutionEvidence(state.sql);
    const cleanups = [state.storage_cleanup, state.lease_cleanup];
    const cleanup = cleanups.includes('failed') ? 'failed' : cleanups.includes('unknown') ? 'unknown'
        : cleanups.includes('complete') ? 'complete' : 'not_started';
    return Object.freeze({ version: 1, attempt_ref: state.attempt_ref, target_ref: state.target_ref,
        action_entered: state.action_entered, sql_execution: sql, receipt_validated: state.receipt_validated,
        commit_state: state.receipt_validated ? 'committed' : sql === 'not_started' && !state.uncertain_commit ? 'not_started' : 'unknown',
        cleanup_state: cleanup, ...(state.audit_ref ? { audit_ref: state.audit_ref, effects: { ...state.effects } } : {}) });
}
