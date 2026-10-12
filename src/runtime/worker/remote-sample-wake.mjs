// @ts-check
// Writer tickets schedule a fresh independent collector; they are not evidence.
import { createHash } from 'node:crypto';
import { activityDatabaseKey } from '../../diagnostics/lark-im-activity-evidence.mjs';
import { canonical, SAMPLE_POLICY } from '../../diagnostics/remote-sample-core.mjs';
import { loadPendingHistoryVerifications } from '../../diagnostics/remote-sample-history.mjs';

const HASH = /^[a-f0-9]{64}$/;
export const VERIFICATION_WAKE_GAP_MS = 60_000;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const STATE_FIELDS = ['kind', 'database_key', 'account_key', 'written_at', 'next_due', 'failures',
  'rotation', 'observations', 'last_outcome', 'cooldowns', 'blocked_reason'];

// Match the guardian's canonical domain. Full observation validation belongs
// to the existing schedule reader, before either caller invokes this helper.
function canonicalDomain(value) {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return /^[\x00-\x7f]*$/.test(value);
  if (typeof value === 'number') return Number.isSafeInteger(value);
  return object(value) && Object.entries(value).every(([key, item]) =>
    /^[\x00-\x7f]*$/.test(key) && canonicalDomain(item));
}

/** The caller has validated the private schedule state. This bounded local
 * read can only advance a healthy schedule, after the same fixed 60-second
 * floor for one or many tickets. It never changes saved state or authorizes
 * API/fact use. The child must call it again under the scheduler flock.
 * @param {{db:string}} opts
 * @param {Record<string,any>|null} state
 * @param {number} now
 * @param {Record<string,number>} cooldowns
 * @param {Record<string,any>} deps
 */
export function resolveRemoteSampleDue(opts, state, now, cooldowns = {}, deps = {}) {
  const original = state?.next_due ?? now;
  const unchanged = { next_due: original, wake: null };
  try {
    // Ordinary admission keeps its existing collector/cooldown handling.
    if (!state || original <= now) return unchanged;
    const fields = [...STATE_FIELDS, ...(Object.hasOwn(state, 'observation_overflow') ? ['observation_overflow'] : [])];
    if (!object(state) || Object.keys(state).sort().join(',') !== fields.sort().join(',') ||
        state.kind !== 'lark_im_remote_sample_schedule/v1' || !canonicalDomain(state) ||
        state.last_outcome !== 'ok' || state.failures !== 0 || state.blocked_reason !== null ||
        !HASH.test(state.database_key) || !HASH.test(state.account_key || '') ||
        !integer(state.written_at) || !integer(original) || !integer(now) ||
        !integer(state.rotation) || state.rotation > 1_000_000_000 ||
        Object.hasOwn(state, 'observation_overflow') && typeof state.observation_overflow !== 'boolean' ||
        !integer(state.written_at + VERIFICATION_WAKE_GAP_MS) || now < state.written_at + VERIFICATION_WAKE_GAP_MS ||
        !object(state.cooldowns) || !object(cooldowns) || !object(state.observations) ||
        !Object.keys(state.observations).length || Object.keys(state.observations).length > SAMPLE_POLICY.observations) return unchanged;
    const untils = [...Object.values(state.cooldowns), ...Object.values(cooldowns)];
    if (!untils.every(integer)) return unchanged;
    const cooldown = Math.max(0, ...untils);
    if (cooldown > now) return unchanged;
    const databaseKey = deps.databaseKey || activityDatabaseKey;
    if (databaseKey(opts.db) !== state.database_key) return unchanged;
    const start = Math.floor((now - SAMPLE_POLICY.stableBufferMs) / 60_000) * 60_000 - SAMPLE_POLICY.windowMs;
    // The existing query rechecks account/source/scope/context/debt identity,
    // record generation and whether this writer ticket was already attempted.
    const pending = (deps.pendingVerifications || loadPendingHistoryVerifications)(opts.db, state.observations,
      { database_key: state.database_key, account_key: state.account_key }, now, deps.ticketDeps || {});
    if (!Array.isArray(pending) || pending.length > SAMPLE_POLICY.observations ||
        new Set(pending).size !== pending.length || pending.some(key => typeof key !== 'string' || !HASH.test(key)) ||
        !pending.some(key => integer(state.observations[key]?.target) && state.observations[key].target + 2000 < start) ||
        databaseKey(opts.db) !== state.database_key) return unchanged;
    const next = Math.max(state.written_at + VERIFICATION_WAKE_GAP_MS, cooldown);
    if (next >= original) return unchanged;
    return { next_due: next, wake: {
      state_hash: createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex'), not_before: next,
    } };
  } catch { return unchanged; }
}
