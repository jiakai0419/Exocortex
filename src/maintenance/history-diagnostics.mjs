// @ts-check
import { SqliteReadError } from '../storage/sqlite/readonly-query.mjs';
import { readLarkExecutionFailure } from '../adapters/lark-im/transport.mjs';
import { sanitizeHistoryDiagnostic, isHistoryFailureOperation } from '../../dist/core/history-diagnostics.js';
import { readLarkApiLeaseFailure } from '../runtime/lark-api-lease.mjs';
import { readReplayExecutionEvidence } from '../../dist/storage/sqlite/execution-evidence.js';

// These maps contain only evidence observed by our synchronous boundaries.
// Never traverse a caller's .cause, .errors, message, name, code or payload.
const failures = new WeakMap();
const localAdmissions = new WeakSet();
const commits = new WeakMap();
export function registerHistoryCommitEvidence(error, token) {
  if (object(error) && readReplayExecutionEvidence(token)) commits.set(error,token);
}
export function readHistoryCommitEvidence(error) {
  return object(error) ? readReplayExecutionEvidence(commits.get(error)) : null;
}
export function registerHistoryLeaseFailure(error, result, phase) {
  const lease=readLarkApiLeaseFailure(result);
  if (object(error) && lease && ['request','commit'].includes(phase)) {
    const previous=failures.get(error);
    if (previous && !previous.lease) failures.set(error,{...previous,lease:{...lease,phase}});
  }
}
const LOCAL_KINDS = new Set(['cli_budget','self_budget','time_budget','clock_unavailable','sync_busy',
  'lease_unavailable','rate_cooldown','rate_limited','shared_cooldown_unavailable']);
/** @param {unknown} value @returns {value is object} */
const object = value => value !== null && typeof value === 'object';
/** @param {unknown} error @param {Record<string,any>} evidence @param {boolean} [localAdmission] */
function remember(error, evidence, localAdmission = false) {
  if (object(error) && !failures.has(error)) {
    failures.set(error, evidence);
    if (localAdmission) localAdmissions.add(error);
  }
}

/** Presence alone invalidates the constructor's pure-admission premise. Do not
 * read values/getters or infer anything from an arbitrary nested error chain. */
function hasUnknownErrorChain(error) {
  try { return 'cause' in error || 'errors' in error; }
  catch { return true; }
}

function failureEvidence(error) {
  const recorded = object(error) ? failures.get(error) : null;
  if (recorded) {
    if (localAdmissions.has(error) && hasUnknownErrorChain(error)) {
      const unknown = {kind:'unknown', ...(recorded.operation ? {operation:recorded.operation} : {})};
      // Once observed, deleting an unknown chain must not restore a previously
      // optimistic constructor-only classification. Explicit wrapper evidence
      // has separate provenance and is not subject to this constructor premise.
      failures.set(error, unknown);
      return unknown;
    }
    return recorded;
  }
  if (error instanceof SqliteReadError) return {kind:error.reason};
  const known = readLarkExecutionFailure(error);
  if (!known) return {kind:'unknown'};
  const {receipt, local_reason} = known;
  const transport = {operation:known.operation, execution:receipt.execution,
    result_kind:receipt.result_kind, result_code:receipt.result_code,
    remote_result:receipt.remote_result, local_reason};
  // Permission-like prose cannot establish a remote rejection. Actual process
  // timeout/network outcomes remain distinct from remote business responses.
  const remoteOnly = new Set(['permission_denied','restricted_mode','bot_user_out_of_chat','command_unavailable']);
  let kind = receipt.execution === 'not_started' ? 'request_not_started'
    : receipt.execution === 'unknown' ? 'request_execution_unknown'
    : receipt.result_kind === 'success' ? 'unknown'
    : remoteOnly.has(receipt.result_kind) && !receipt.remote_result ? 'unknown' : receipt.result_kind;
  if (kind === 'unknown' && local_reason) kind = local_reason === 'invalid_json' ? 'request_invalid_json' : local_reason;
  return {kind, transport};
}

/** Register a local admission error at its constructor, never by inspecting
 * arbitrary error fields. This observation does not change exception identity.
 * @template {object} T
 * @param {T} error
 * @param {string} kind
 * @returns {T} */
export function registerHistoryLocalFailure(error, kind) {
  if (LOCAL_KINDS.has(kind)) remember(error, {kind}, true);
  return error;
}

/** Only explicit local wrapping sites call this. A copied .cause or matching
 * error message cannot recover or invent trusted evidence.
 * @template {object} T
 * @param {T} wrapper
 * @param {unknown} cause
 * @returns {T} */
export function preserveHistoryFailure(wrapper, cause) {
  remember(wrapper, failureEvidence(cause));
  if(object(wrapper) && object(cause) && commits.has(cause))commits.set(/** @type {object} */(wrapper),commits.get(cause));
  return wrapper;
}

/** Observe the deepest known operation while rethrowing the exact error.
 * The callback is synchronous like the history command itself.
 * @template T @param {string} operation @param {()=>T} work @returns {T} */
export function historyOperation(operation, work) {
  if (!isHistoryFailureOperation(operation)) throw new TypeError('invalid history failure operation');
  try { return work(); }
  catch (error) {
    if (object(error)) {
      const evidence = failureEvidence(error);
      if (!evidence.operation) failures.set(error, {...evidence, operation});
    }
    throw error;
  }
}

/** Only classes, constructor registration and genuine runner provenance can
 * supply finite categories. No arbitrary error property is serialized.
 * @param {unknown} error @param {string} stage @param {'hint'|'failure'} role */
export function historyFailureDiagnostic(error, stage, role) {
  const evidence = role === 'failure' ? failureEvidence(error)
    : {kind:error instanceof SqliteReadError ? error.reason
      : stage === 'source_policy_decode' && error instanceof SyntaxError ? 'invalid_policy' : 'unknown'};
  return sanitizeHistoryDiagnostic({version:1, stage, ...evidence}, role)
    || sanitizeHistoryDiagnostic({version:1, stage, kind:'unknown'}, role);
}
