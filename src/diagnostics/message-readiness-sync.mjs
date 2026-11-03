// @ts-check
import { recipientAccountKey } from '../adapters/lark-im/p2p-recipient.mjs';
import { executeMessages } from '../cli/messages-command.mjs';
import { commitEnrichmentUpdates } from '../maintenance/enrichment-commit.mjs';
import { createHistoryCommandBudget } from '../maintenance/history-command-budget.mjs';
import { getLarkApiLeaseStdio } from '../runtime/lark-api-lease.mjs';
import { readOnlySqliteJson } from '../storage/sqlite/readonly-query.mjs';
import { captureLarkWriteAdmission } from './lark-write-admission.mjs';
import { observeMessageReadiness } from './message-readiness-ledger.mjs';
import { loadMessages, readMessagesMetadata } from './messages-report.mjs';
import { failedReadinessObservation, normalizeReadinessObservation, readinessFailure } from './readiness-observer-result.mjs';

const BUDGET_MS = 5_000;
const skipped = reason => ({ reason, scanned: 0, observed: 0, deferred: 0 });

/** Optional, entirely local post-sync observation. The existing CLI lease and
 * short maintenance transaction protect account admission; no new API calls
 * or default writer escape those fences. This does not affect sync coverage.
 * @param {string} db
 * @param {{open_id:string}} self
 * @param {{now?:()=>number,monotonicNow?:()=>number}} [deps]
 */
export function syncReadiness(db, self, deps = {}) {
  let budget, result, stage = 'admission';
  try {
    budget = createHistoryCommandBudget({ maxSeconds: BUDGET_MS / 1000 }, { monotonicClock: deps.monotonicNow });
    budget.assertReady();
    const accountKey = recipientAccountKey(self?.open_id);
    if (!getLarkApiLeaseStdio()) result = skipped('lease_unavailable');
    else if (!accountKey) result = skipped('account_unavailable');
    else {
      let admissionQueryFailure;
      const boundedQuery = (path, sql, label) => {
        try { return readOnlySqliteJson(path, sql, label, { timeoutMs: budget.timeoutMs() }); }
        catch (error) { admissionQueryFailure = error; throw error; }
      };
      // Account inspection intentionally maps unavailable optional evidence to
      // null. This bounded owner must retain a failed required query instead
      // of replacing its deadline/reader receipt with a generic admission error.
      const readAdmission = action => {
        admissionQueryFailure = undefined;
        try {
          const value = action();
          if (admissionQueryFailure !== undefined) throw admissionQueryFailure;
          return value;
        } catch (error) { throw admissionQueryFailure ?? error; }
        finally { admissionQueryFailure = undefined; }
      };
      const admission = readAdmission(() => captureLarkWriteAdmission(db,
        { selfOpenId: self.open_id, requireVerified: true }, { query: boundedQuery }));
      result = observeMessageReadiness(db, {
        observerAccountKey: accountKey, nowMs: (deps.now || Date.now)(),
        query: (sql, label) => {
          stage = label === 'read prior readiness observations' ? 'plan' : 'select';
          return boundedQuery(db, sql, label);
        },
        readRows: (path, ids) => {
          stage = 'read';
          budget.assertReady();
          const messages = executeMessages({ db: path, direction: 'all', limit: 40, search: '', recordIds: ids }, {
            // Carry the budget independently of the reader override: production
            // must retain the ordinary framed wire, not the legacy JSON path.
            loadMessages: (selectedDb, options) => loadMessages(selectedDb, options, {
              sqliteReadOptions: () => ({ timeoutMs: budget.timeoutMs() }),
            }),
          });
          return { messages, metadata: readMessagesMetadata(messages) };
        },
        commit: (updates, reason) => {
          stage = reason === 'readiness_observation_claim' ? 'claim' : 'finish';
          if (!getLarkApiLeaseStdio()) throw new Error('readiness lease unavailable');
          return commitEnrichmentUpdates(db, updates, { dryRun: false, reason,
            label: 'commit historical readiness observation', writeAdmission: admission.fence,
            executionBudget: budget,
            admissionBeforeCommit: () => {
              budget.assertReady();
              if (!getLarkApiLeaseStdio()) throw new Error('readiness lease unavailable');
              readAdmission(() => admission.assertCurrent());
            },
          });
        },
      });
    }
  } catch (error) { result = failedReadinessObservation(stage, error); }
  // Budget expiry cannot erase a confirmed finish or overwrite a more specific
  // read/commit failure. Publication has its own reservation within the 5s.
  try { budget?.assertOutputReady(); }
  catch (error) {
    if (!result.diagnostic) result = { ...result,
      ...(result.reason === 'observed' ? { reason: 'observation_failed' } : {}), diagnostic: readinessFailure(stage, error) };
  }
  const commandBudget = budget?.summary() || { version: 1, max_ms: BUDGET_MS, elapsed_ms: null,
    stop_reason: 'clock_unavailable', complete: false };
  return normalizeReadinessObservation({ claim_state: 'not_started', finish_state: 'not_started',
    cleanup_state: 'not_required', ...result, command_budget: commandBudget })
    || { ...failedReadinessObservation('dispatch', null),
      diagnostic: { version: 1, stage: 'dispatch', kind: 'invalid_response', read: null }, command_budget: commandBudget };
}
