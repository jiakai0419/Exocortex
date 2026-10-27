// @ts-check
import { recipientAccountKey } from '../adapters/lark-im/p2p-recipient.mjs';
import { executeMessages } from '../cli/messages-command.mjs';
import { commitEnrichmentUpdates } from '../maintenance/enrichment-commit.mjs';
import { getLarkApiLeaseStdio } from '../runtime/lark-api-lease.mjs';
import { readOnlySqliteJson } from '../storage/sqlite/readonly-query.mjs';
import { captureLarkWriteAdmission } from './lark-write-admission.mjs';
import { observeMessageReadiness } from './message-readiness-ledger.mjs';
import { loadMessages, readMessagesMetadata } from './messages-report.mjs';

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
  if (!getLarkApiLeaseStdio()) return skipped('lease_unavailable');
  const accountKey = recipientAccountKey(self?.open_id);
  if (!accountKey) return skipped('account_unavailable');
  const clock = deps.monotonicNow || (() => performance.now()), started = clock();
  let previous = started;
  const remaining = () => {
    const value = clock();
    if (!Number.isFinite(value) || !Number.isFinite(started) || value < previous) throw new Error('readiness clock unavailable');
    previous = value;
    const left = Math.floor(BUDGET_MS - (value - started));
    if (left <= 0) throw new Error('readiness observation budget exhausted');
    return left;
  };
  try {
    const admission = captureLarkWriteAdmission(db, { selfOpenId: self.open_id, requireVerified: true });
    const boundedQuery = (path, sql, label) => readOnlySqliteJson(path, sql, label, { timeoutMs: remaining() });
    return observeMessageReadiness(db, {
      observerAccountKey: accountKey, nowMs: (deps.now || Date.now)(),
      query: (sql, label) => boundedQuery(db, sql, label),
      readRows: (path, ids) => {
        remaining();
        const messages = executeMessages({ db: path, direction: 'all', limit: 40, search: '', recordIds: ids }, {
          loadMessages: (selectedDb, options) => loadMessages(selectedDb, options, { sqliteJson: boundedQuery }),
        });
        return { messages, metadata: readMessagesMetadata(messages) };
      },
      commit: (updates, reason) => {
        remaining();
        if (!getLarkApiLeaseStdio()) throw new Error('readiness lease unavailable');
        return commitEnrichmentUpdates(db, updates, { dryRun: false, reason,
          label: 'commit historical readiness observation', writeAdmission: admission.fence,
          admissionBeforeCommit: () => {
            if (!getLarkApiLeaseStdio()) throw new Error('readiness lease unavailable');
            admission.assertCurrent();
          },
        });
      },
    });
  } catch { return skipped('observation_failed'); }
}
