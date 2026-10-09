// @ts-check
import { readOnlySqliteJson } from '../storage/sqlite/readonly-query.mjs';
import { chatScopeId } from '../adapters/lark-im/core.mjs';
import { digest, epoch, sampleScopeHash } from './remote-sample-core.mjs';

const HASH = /^[a-f0-9]{64}$/;
const MAX_LEGACY_CANDIDATES = 1000;
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

/** Only exact creation timestamps in enabled discovered chats are inspected.
 * The existing compound index bounds this to at most 10,000 index seeks and
 * 1,001 metadata rows; the local read has its own one-second process bound.
 * No bodies, full historical scan, or persisted raw routing identifiers.
 */
export function loadLegacyObservationCandidates(db, target, chats, deps = {}) {
  if (!chats.length || chats.length > 10000 || epoch(target) === null) return [];
  return (deps.sqliteJson || readOnlySqliteJson)(db, `SELECT external_id,container_id,occurred_at_ms
    FROM records INDEXED BY idx_records_container_time
    WHERE source_id='lark.im' AND record_type='lark.im.message'
      AND container_id IN (${chats.map(chat => quote(chat.chat_id)).join(',')})
      AND occurred_at_ms=${target} LIMIT ${MAX_LEGACY_CANDIDATES + 1};`,
  'remote sample historical routing', { timeoutMs: Math.min(1000, deps.timeoutMs || 1000) });
}

/** One oldest-attempted retained observation gets a bounded revisit slot.
 * A failed/unroutable target rotates too; it remains unresolved in the reducer.
 * Routing is re-derived from this account and the current enabled inventory.
 */
export function selectHistoricalObservation(db, previous, binding, rows, startMs, now, deps = {}) {
  const entries = Object.entries(previous).filter(([key, value]) => HASH.test(key) && value &&
    ['missing', 'version', 'content'].includes(value.kind) && epoch(value.target) !== null && value.target + 2000 < startMs &&
    ['first_seen', 'last_seen', 'run_finished'].every(field => Number.isSafeInteger(value[field]) && value[field] >= 0 && value[field] <= now));
  entries.sort((a,b) => (a[1].last_checked || 0) - (b[1].last_checked || 0) || a[1].first_seen - b[1].first_seen || a[0].localeCompare(b[0]));
  if (!entries.length) return null;
  const [key, observation] = entries[0];
  const chats = rows.filter(row => row.enabled === 1 && row.source_id === 'lark.im' &&
    typeof row.chat_id === 'string' && row.chat_id.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(row.chat_id) &&
    row.id === chatScopeId(row.chat_id) && !row.unsupported_reason);
  let chat = null;
  if (Object.hasOwn(observation, 'scope_hash')) {
    if (HASH.test(observation.scope_hash)) {
      const matching = chats.filter(row => sampleScopeHash(binding, row.chat_id) === observation.scope_hash);
      if (matching.length === 1) chat = matching[0];
    }
  } else {
    // Legacy observations lack a scope route. Resolve from bounded local
    // identity metadata, then verify the full salted message hash in memory.
    try {
      const candidates = (deps.loadCandidates || loadLegacyObservationCandidates)(db, observation.target, chats, deps);
      if (Array.isArray(candidates) && candidates.length <= MAX_LEGACY_CANDIDATES) {
        const matching = candidates.filter(row => typeof row.external_id === 'string' && row.external_id.length <= 512 &&
          row.occurred_at_ms === observation.target &&
          digest([binding.database_key, binding.account_key, row.container_id, row.external_id, row.occurred_at_ms]) === key);
        if (matching.length === 1) chat = chats.find(row => row.chat_id === matching[0].container_id) || null;
      }
    } catch { /* No route is evidence of unresolved debt, not a cleared finding. */ }
  }
  if (chat && Object.hasOwn(chat, 'initial_sync_start_ms') &&
      (epoch(chat.initial_sync_start_ms) === null || observation.target < chat.initial_sync_start_ms)) chat = null;
  const start = Math.floor(observation.target / 1000) * 1000 - 1000;
  return { key, observation, chat, start, end: start + 3000 };
}
