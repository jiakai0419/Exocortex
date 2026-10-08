// @ts-check
import { SqliteReadError } from '../storage/sqlite/readonly-query.mjs';

const STAGES = new Set(['inventory', 'identity_before', 'binding_before', 'message_request',
  'message_page', 'message_shape', 'message_identity', 'identity_after', 'database_context',
  'snapshot', 'binding_after', 'comparison', 'final_context']);
const COMMON = new Set(['unexpected_error', 'type_error', 'range_error', 'syntax_error']);
const SNAPSHOT = new Set(['snapshot_invalid_targets', 'snapshot_invalid_budget',
  'snapshot_dependency_unavailable', 'snapshot_timeout', 'snapshot_process_signal', 'snapshot_execution_failed',
  'snapshot_invalid_json', 'snapshot_output_schema', 'snapshot_coverage_invariant',
  'snapshot_record_schema', 'snapshot_record_budget', 'snapshot_read_failed', 'snapshot_budget_exhausted']);
const SQLITE = new Set(['sqlite_dependency_unavailable', 'sqlite_read_timeout', 'sqlite_read_failed', 'sqlite_invalid_response']);

/** Internal typed failure. Its message stays private; only the fixed code is projected. */
export class SampleEvidenceError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) { super(message); this.code = code; }
}

/** Exact, finite failure contract. No exception strings, paths, identifiers or payloads.
 * @param {unknown} input
 * @returns {{version:1,stage:string,code:string}|null}
 */
export function safeCollectorDiagnostic(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = /** @type {Record<string, any>} */ (input);
  if (Object.keys(value).length !== 3 || !['version', 'stage', 'code'].every((key) => Object.hasOwn(value, key)) ||
      value.version !== 1 || !STAGES.has(value.stage) || typeof value.code !== 'string') return null;
  const allowed = COMMON.has(value.code) ||
    value.stage === 'snapshot' && SNAPSHOT.has(value.code) ||
    ['inventory', 'binding_before', 'binding_after'].includes(value.stage) && SQLITE.has(value.code) ||
    value.stage === 'message_page' && value.code === 'invalid_page_schema' ||
    value.stage === 'message_shape' && value.code === 'invalid_message_schema';
  return allowed ? { version: 1, stage: value.stage, code: value.code } : null;
}

/** Never inspect an arbitrary error's message, stack, cause, errno or output.
 * @param {string} stage @param {unknown} error
 */
export function collectorDiagnostic(stage, error) {
  let code = 'unexpected_error';
  if (error instanceof SampleEvidenceError) code = error.code;
  else if (error instanceof SqliteReadError) code = `sqlite_${error.reason}`;
  else if (error instanceof TypeError) code = 'type_error';
  else if (error instanceof RangeError) code = 'range_error';
  else if (error instanceof SyntaxError) code = 'syntax_error';
  else if (stage === 'message_page') code = 'invalid_page_schema';
  else if (stage === 'message_shape') code = 'invalid_message_schema';
  return safeCollectorDiagnostic({ version: 1, stage, code }) ||
    safeCollectorDiagnostic({ version: 1, stage, code: 'unexpected_error' });
}
