// @ts-check
import { readOnlySqliteJson } from '../storage/sqlite/readonly-query.mjs';
import { chatScopeId } from '../adapters/lark-im/core.mjs';
import { digest, epoch, sampleScopeHash } from './remote-sample-core.mjs';
import { scopeObservationContext } from '../maintenance/scope-config-policy.mjs';

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
function historicalEntries(previous, startMs, now) {
  const entries = Object.entries(previous).filter(([key, value]) => HASH.test(key) && value &&
    ['missing', 'version', 'content'].includes(value.kind) && epoch(value.target) !== null && value.target + 2000 < startMs &&
    ['first_seen', 'last_seen', 'run_finished'].every(field => Number.isSafeInteger(value[field]) && value[field] >= 0 && value[field] <= now));
  entries.sort((a,b) => (a[1].last_checked || 0) - (b[1].last_checked || 0) || a[1].first_seen - b[1].first_seen || a[0].localeCompare(b[0]));
  return entries;
}

function routeObservation(db, key, observation, binding, rows, deps) {
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


/** Queue rows are scheduling hints only. Recompute identity, policy and debt
 * fingerprints from the current source and finding before giving any priority.
 * An unavailable/malformed queue simply retains the oldest-first schedule. */
export function loadPendingHistoryVerifications(db, previous, binding, now, deps = {}) {
  try {
    const rows = (deps.sqliteJson || readOnlySqliteJson)(db, `SELECT d.finding_key,d.database_key,d.account_key,d.context_fingerprint,d.debt_fingerprint,d.scope_id,
      d.verification_generation,d.verification_requested_at_ms,o.generation AS record_generation,
      r.external_id,r.container_id,r.occurred_at_ms,
      s.config_json AS scope_config,src.config_json AS source_config
      FROM lark_im_history_debt d JOIN records r ON r.id=d.record_id
      JOIN record_observation_state o ON o.record_id=r.id
      JOIN sync_scopes s ON s.id=d.scope_id AND s.source_id='lark.im' AND s.enabled=1
      JOIN sources src ON src.id='lark.im' AND src.enabled=1
      WHERE d.status='awaiting_verification' AND r.source_id='lark.im' AND r.record_type='lark.im.message'
      ORDER BY d.verification_requested_at_ms,d.record_id LIMIT 201;`, 'remote sample pending verification hints', { timeoutMs: 1000 });
    if (!Array.isArray(rows) || rows.length > 200) return [];
    const pending = [];
    for (const row of rows) {
      if (!HASH.test(row.finding_key) || !HASH.test(row.context_fingerprint) || !HASH.test(row.debt_fingerprint) ||
          !Number.isSafeInteger(row.verification_requested_at_ms) || row.verification_requested_at_ms < 0 || row.verification_requested_at_ms > now ||
          row.verification_generation !== null && (!Number.isSafeInteger(row.verification_generation) || row.verification_generation < 0)) return [];
      if (row.database_key !== binding.database_key || row.account_key !== binding.account_key) continue;
      const observation = previous[row.finding_key];
      if (!observation || row.verification_generation === null || row.verification_generation !== row.record_generation || row.verification_requested_at_ms <= (observation.last_checked || observation.last_seen)) continue;
      const scope = JSON.parse(row.scope_config); const source = JSON.parse(row.source_config);
      if (row.scope_id !== chatScopeId(row.container_id) || scope.chat_id !== row.container_id || scope.unsupported_reason ||
          epoch(source.initial_sync_start_ms) === null || row.occurred_at_ms < source.initial_sync_start_ms ||
          row.occurred_at_ms !== observation.target ||
          digest([binding.database_key,binding.account_key,row.container_id,row.external_id,row.occurred_at_ms]) !== row.finding_key ||
          observation.scope_hash && observation.scope_hash !== sampleScopeHash(binding,row.container_id) ||
          digest({ source: row.source_config, scope: row.scope_id, policy: scopeObservationContext(row.scope_config) }) !== row.context_fingerprint) continue;
      const debts = observation.debts || (observation.kind === 'version' ? { version: 0 } :
        observation.kind === 'missing' ? { missing: observation.first_seen } : { legacy_content: 0 });
      if (digest(Object.fromEntries(Object.entries(debts).sort(([a],[b]) => a.localeCompare(b)))) !== row.debt_fingerprint) continue;
      pending.push(row.finding_key);
    }
    return pending;
  } catch { return []; }
}

export function selectHistoricalObservations(db, previous, binding, rows, startMs, now, deps = {}, limit = 3) {
  const entries = historicalEntries(previous, startMs, now);
  if (!entries.length || limit < 1) return [];
  const priority = new Set((deps.pendingVerifications || loadPendingHistoryVerifications)(db, previous, binding, now, deps));
  // First route is always the oldest: bad or unmodified debt cannot starve
  // behind a continuing supply of successful writer attempts.
  const ordered = [entries[0], ...entries.slice(1).filter(([key]) => priority.has(key)),
    ...entries.slice(1).filter(([key]) => !priority.has(key))].slice(0, Math.min(3, limit));
  return ordered.map(([key, observation]) => routeObservation(db, key, observation, binding, rows, deps));
}

export function selectHistoricalObservation(db, previous, binding, rows, startMs, now, deps = {}) {
  const entry = historicalEntries(previous, startMs, now)[0];
  return entry ? routeObservation(db, entry[0], entry[1], binding, rows, deps) : null;
}
