// @ts-check
import { readSqliteReadDiagnostic } from '../storage/sqlite/readonly-query.mjs';
import { copySqliteReadDiagnostic } from './sqlite-read-diagnostic.mjs';
import { HistoryCommandBudgetError } from '../maintenance/history-command-budget.mjs';
import { CliExecutionError } from '../cli/context.mjs';

export { normalizeReadinessObservation } from '../../dist/core/readiness-observer-result.js';

const STAGES = new Set(['admission', 'claim', 'select', 'read', 'plan', 'finish', 'release', 'dispatch']);

/** Safe evidence comes only from the SQLite reader's private receipt or our
 * internal budget error. An arbitrary error.message/reason is never copied.
 * @param {string} stage @param {unknown} error */
export function readinessFailure(stage, error) {
  // executeMessages wraps its reader exception in the existing typed CLI
  // boundary. Only that class and its validated finite receipt are accepted;
  // arbitrary lookalike errors and accessors cannot supply read evidence.
  const wrapped = error instanceof CliExecutionError
    ? Object.getOwnPropertyDescriptor(error, 'readDiagnostic')?.value : null;
  const read = readSqliteReadDiagnostic(error) || copySqliteReadDiagnostic(wrapped);
  const budgetReason = error instanceof HistoryCommandBudgetError
    ? Object.getOwnPropertyDescriptor(error, 'reason')?.value : null;
  const kind = read ? 'sqlite_read' : ['time_budget', 'clock_unavailable'].includes(budgetReason) ? budgetReason : 'unknown';
  return { version: 1, stage: STAGES.has(stage) ? stage : 'dispatch', kind, read };
}

/** @param {string} stage @param {unknown} error */
export function failedReadinessObservation(stage, error) {
  return { reason: 'observation_failed', scanned: 0, observed: 0, deferred: 0,
    diagnostic: readinessFailure(stage, error) };
}
