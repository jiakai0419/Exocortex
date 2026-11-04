import { createHash } from 'node:crypto';

type SqlState = 'not_started' | 'started' | 'unknown';
type Cleanup = 'not_started' | 'complete' | 'failed' | 'unknown';
type ReplayState = {
  attempt_ref: string; target_ref: string; action_entered: boolean;
  sql: object; receipt_validated: boolean; audit_ref?: string;
  uncertain_commit?: boolean;
  storage_entered?: boolean;
  effects?: {inserted:number;updated:number;duplicate:number;conflicts:number};
  storage_cleanup: Cleanup; lease_cleanup: Cleanup;
};
const sqlEvidence = new WeakMap<object, SqlState>();
const replayEvidence = new WeakMap<object, ReplayState>();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const owned = (value: unknown): value is object => value !== null && typeof value === 'object';

export function createSqlExecutionEvidence(): object {
  const token = Object.freeze({}); sqlEvidence.set(token, 'not_started'); return token;
}
export function markSqlDispatch(token: unknown) {
  if (owned(token) && sqlEvidence.has(token)) sqlEvidence.set(token, 'unknown');
}
/** Only called with the actual synchronous process result, never an error chain. */
export function observeSqlProcess(token: unknown, result: {pid?: number; status?: number | null; error?: unknown}) {
  if (!owned(token) || !sqlEvidence.has(token)) return;
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const started = Number.isSafeInteger(result.pid) && Number(result.pid) > 0;
  const definiteLaunchFailure = !started && ['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC'].includes(String(code));
  sqlEvidence.set(token, definiteLaunchFailure ? 'not_started'
    : started || !result.error && Number.isSafeInteger(result.status) ? 'started' : 'unknown');
}
export function readSqlExecutionEvidence(token: unknown): SqlState | null {
  return owned(token) ? sqlEvidence.get(token) ?? null : null;
}
export function createReplayExecutionEvidence(attempt: string, fence: string): object {
  if (!attempt || !/^[a-f0-9]{64}$/.test(fence)) throw new TypeError('invalid replay evidence binding');
  const token = Object.freeze({});
  replayEvidence.set(token, {attempt_ref:digest(`attempt\0${attempt}`),target_ref:digest(`target\0${attempt}\0${fence}`),
    action_entered:false,sql:createSqlExecutionEvidence(),receipt_validated:false,
    storage_cleanup:'not_started',lease_cleanup:'not_started'});
  return token;
}
export function markReplayActionEntered(token: unknown) {
  const state = owned(token) ? replayEvidence.get(token) : null; if (state) state.action_entered = true;
}
export function markReplayStorageEntered(token: unknown) {
  const state=owned(token)?replayEvidence.get(token):null;
  if(state){state.action_entered=true;state.storage_entered=true;}
}
export function replaySqlEvidence(token: unknown): object | undefined {
  return owned(token) ? replayEvidence.get(token)?.sql : undefined;
}
export function markReplayUncertain(token: unknown) {
  const state=owned(token)?replayEvidence.get(token):null;if(state)state.uncertain_commit=true;
}
export function markReplayReceipt(token: unknown, audit: string, effects: {inserted:number;updated:number;duplicate:number;conflicts:number}) {
  const state = owned(token) ? replayEvidence.get(token) : null;
  if (state && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(audit)
    && Object.values(effects).every(value=>Number.isSafeInteger(value)&&value>=0)) {
    state.receipt_validated=true;state.audit_ref=digest(`audit\0${audit}`);state.effects={...effects};
  }
}
export function markReplayCleanup(token: unknown, owner: 'storage'|'lease', value: Cleanup) {
  const state = owned(token) ? replayEvidence.get(token) : null;
  if (state) state[owner === 'storage' ? 'storage_cleanup' : 'lease_cleanup'] = value;
}
export function readReplayExecutionEvidence(token: unknown) {
  const state = owned(token) ? replayEvidence.get(token) : null;
  if (!state) return null;
  const sql = state.action_entered && !state.storage_entered ? 'unknown' : readSqlExecutionEvidence(state.sql)!;
  const cleanups = [state.storage_cleanup,state.lease_cleanup];
  const cleanup = cleanups.includes('failed') ? 'failed' : cleanups.includes('unknown') ? 'unknown'
    : cleanups.includes('complete') ? 'complete' : 'not_started';
  return Object.freeze({version:1,attempt_ref:state.attempt_ref,target_ref:state.target_ref,
    action_entered:state.action_entered,sql_execution:sql,receipt_validated:state.receipt_validated,
    commit_state:state.receipt_validated ? 'committed' : sql === 'not_started' && !state.uncertain_commit ? 'not_started' : 'unknown',
    cleanup_state:cleanup,...(state.audit_ref ? {audit_ref:state.audit_ref,effects:{...state.effects!}} : {})});
}
