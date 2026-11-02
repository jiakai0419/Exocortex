// @ts-check
import { SqliteReadError } from '../storage/sqlite/readonly-query.mjs';
import { readLarkExecutionFailure } from '../adapters/lark-im/transport.mjs';
import { sanitizeHistoryDiagnostic, isHistoryFailureOperation } from '../../dist/core/history-diagnostics.js';

// These maps contain only evidence observed by our synchronous boundaries.
// Never traverse a caller's .cause, .errors, message, name, code or payload.
const failures = new WeakMap();
const LOCAL_KINDS = new Set(['cli_budget','self_budget','time_budget','clock_unavailable','sync_busy',
  'lease_unavailable','rate_cooldown','rate_limited','shared_cooldown_unavailable']);
/** @param {unknown} value @returns {value is object} */
const object = value => value !== null && typeof value === 'object';
/** @param {unknown} error @param {Record<string,any>} evidence */
function remember(error, evidence) {
  if (object(error) && !failures.has(error)) failures.set(error, evidence);
}

function failureEvidence(error) {
  const recorded = object(error) ? failures.get(error) : null;
  if (recorded) return recorded;
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
  if (LOCAL_KINDS.has(kind)) remember(error, {kind});
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
