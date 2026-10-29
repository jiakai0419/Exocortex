// @ts-check
import { SqliteReadError } from '../storage/sqlite/readonly-query.mjs';
import { sanitizeHistoryDiagnostic } from '../../dist/core/history-diagnostics.js';

/** Class identity admits only finite local SQLite categories. Other exceptions
 * never gain a category through their name, message, code or cause strings.
 * @param {unknown} error @param {string} stage @param {'hint'|'failure'} role */
export function historyFailureDiagnostic(error, stage, role) {
  const kind = error instanceof SqliteReadError ? error.reason
    : role === 'hint' && stage === 'source_policy_decode' && error instanceof SyntaxError ? 'invalid_policy' : 'unknown';
  return sanitizeHistoryDiagnostic({ version: 1, stage, kind }, role)
    || sanitizeHistoryDiagnostic({ version: 1, stage, kind: 'unknown' }, role);
}
