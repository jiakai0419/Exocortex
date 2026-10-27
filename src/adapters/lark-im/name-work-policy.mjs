// @ts-check
// Pure selection only. The caller owns identity validation, durable CAS claims,
// the global API lease, existing request/time ceilings and actual execution.
const MAX_CANDIDATES = 128;
const OPERATIONS = new Set(['contact_search', 'chat_members', 'chat_bots',
  'application_info', 'chat_discovery_bundle', 'other', 'local_projection']);
// Accept the existing transport's complete cooldown receipt. Unrelated active
// operations must not invalidate an otherwise useful bounded queue plan.
const COOLDOWN_OPERATIONS = new Set(['message_history_bundle', 'message_search_bundle',
  'chat_discovery_bundle', 'self_profile', 'contact_search', 'chat_members',
  'chat_bots', 'application_info', 'other']);
const TIERS = ['fresh', 'continuation', 'history'];
const integer = n => Number.isSafeInteger(n) && n >= 0;
const text = s => typeof s === 'string' && s.length > 0 && s.length <= 256 && !s.includes('\0');
const check = condition => { if (!condition) throw new TypeError('invalid name work policy input'); };

/** @typedef {{schema:'name_work_selection/v1', sequence:number, slot:number}} SelectionState */
/** @typedef {{key:string, tier:'fresh'|'continuation'|'history', operation:string,
 * enqueuedSequence:number, lastServedSequence:number, dueAtMs:number,
 * claimedUntilMs:number, blocked:boolean, freshOrder?:number}} WorkCandidate */

/** Serialize this state with each successful claim, never after the API call.
 * New enrollment uses the current sequence for both service and enqueue age.
 * Persist state plus the returned candidate predecessor in the same CAS claim.
 * @returns {SelectionState} */
function initialNameWorkSelection() {
  return { schema: 'name_work_selection/v1', sequence: 0, slot: 0 };
}

/** Choose one bounded candidate. Every third choice takes the oldest service
 * age regardless of tier; the other two prefer fresh work then continuation.
 * Candidate retrieval must separately include the globally oldest eligible
 * service age, not just LIMIT newest rows, for the fairness bound to hold.
 * Local and remote queues have separate durable state and admission.
 * @param {WorkCandidate[]} candidates
 * @param {SelectionState} state
 * @param {{nowMs:number, resource:'local'|'remote', cooldowns?:Record<string,number>}} options
 */
function selectNameWork(candidates, state, { nowMs, resource, cooldowns = {} }) {
  check(integer(nowMs) && ['local', 'remote'].includes(resource));
  check(state?.schema === 'name_work_selection/v1' && integer(state.sequence)
    && state.sequence < Number.MAX_SAFE_INTEGER && [0, 1, 2].includes(state.slot));
  check(Array.isArray(candidates) && candidates.length <= MAX_CANDIDATES);
  check(cooldowns !== null && typeof cooldowns === 'object' && !Array.isArray(cooldowns)
    && Object.keys(cooldowns).length <= COOLDOWN_OPERATIONS.size
    && Object.entries(cooldowns).every(([op, until]) => COOLDOWN_OPERATIONS.has(op) && integer(until)));
  const keys = new Set();
  for (const candidate of candidates) {
    check(candidate && text(candidate.key) && !keys.has(candidate.key)
      && TIERS.includes(candidate.tier) && OPERATIONS.has(candidate.operation)
      && integer(candidate.enqueuedSequence) && integer(candidate.lastServedSequence)
      && candidate.enqueuedSequence <= candidate.lastServedSequence
      && candidate.lastServedSequence <= state.sequence
      && integer(candidate.dueAtMs) && integer(candidate.claimedUntilMs)
      && (candidate.freshOrder === undefined || integer(candidate.freshOrder))
      && typeof candidate.blocked === 'boolean');
    keys.add(candidate.key);
  }
  // Network name adoption requires the coordinator's matching final profile;
  // do not spend a lookup slot while that mandatory dependency is cooling down.
  if (resource === 'remote' && (cooldowns.self_profile || 0) > nowMs) return null;
  const eligible = candidates.filter(candidate => !candidate.blocked
    && candidate.dueAtMs <= nowMs && candidate.claimedUntilMs <= nowMs
    && (candidate.operation === 'local_projection') === (resource === 'local')
    && (cooldowns[candidate.operation] || 0) <= nowMs);
  const fair = state.slot === 2;
  const older = (a, b) => a.lastServedSequence - b.lastServedSequence
    || a.enqueuedSequence - b.enqueuedSequence || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  eligible.sort((a, b) => (fair ? 0 : TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier)
    || (a.tier === 'fresh' && b.tier === 'fresh' ? (b.freshOrder || 0) - (a.freshOrder || 0) : 0)) || older(a, b));
  const candidate = eligible[0];
  if (!candidate) return null;
  return {
    candidate,
    lane: fair ? 'fair' : 'priority',
    nextState: { ...state, sequence: state.sequence + 1, slot: (state.slot + 1) % 3 },
    nextLastServedSequence: state.sequence + 1,
  };
}

/** A route-local failure decision, not a task-wide negative identity cache.
 * Permission/unsupported/conflict blocks survive fresh messages. Only an
 * independently authorized capability/identity generation change may reopen
 * them; this helper never performs that change. Shared cooldown wins over all
 * local backoff and must still be checked again immediately before a request.
 * failureCount counts failed lookups in this failure episode, including this
 * failure. Successful member pages do not increment it. Actual CLI attempts
 * retain their separate existing request ceiling; this is not that budget.
 * @param {{kind:string, failureCount:number, nowMs:number, retryAfterMs?:number,
 * cooldownUntilMs?:number}} failure
 */
function planNameWorkRetry({ kind, failureCount, nowMs, retryAfterMs = 0, cooldownUntilMs = 0 }) {
  check(integer(nowMs) && integer(failureCount) && failureCount <= 1000 && text(kind)
    && integer(retryAfterMs) && integer(cooldownUntilMs));
  check(nowMs <= Number.MAX_SAFE_INTEGER - Math.max(retryAfterMs, 120_000));
  if (['permission_denied', 'command_unavailable', 'invalid_target', 'conflict'].includes(kind)) {
    return { state: 'blocked', reason: kind, retryAtMs: null };
  }
  if (['budget', 'lease_busy', 'cancelled'].includes(kind)) {
    // These are admission interruptions, not a failed upstream lookup. Do not
    // reset a cursor or failure counter and do not invent an immediate request.
    return { state: 'deferred', reason: kind, retryAtMs: Math.max(nowMs, cooldownUntilMs) };
  }
  check(failureCount > 0);
  if (failureCount >= 3) return { state: 'exhausted', reason: 'failure_limit', retryAtMs: null };
  if (!['network_timeout', 'network_error', 'service_unavailable', 'rate_limited', 'unresolved'].includes(kind)) {
    return { state: 'blocked', reason: 'unclassified_failure', retryAtMs: null };
  }
  const backoff = failureCount === 1 ? 5_000 : 30_000;
  return { state: 'retry', reason: kind,
    retryAtMs: Math.max(nowMs + Math.max(backoff, retryAfterMs), cooldownUntilMs) };
}

/** A conditional service bound, not an end-to-end SLO. populationLimit covers
 * ALL enrolled tasks, including old delayed/claimed/blocked tasks that can
 * become eligible, not merely the current eligible pool or retrieved page.
 * The target must remain eligible, every fair turn sees the globally oldest
 * eligible task, new entries use current sequence, and every target selection
 * commits at least minPagesPerTurn pages (or finishes the target). A maximum
 * of two pages per call does NOT establish a minimum of two. If the caller
 * cannot guarantee positive progress, use no completion bound at all.
 * No bound applies to unavailable names, failures or clock stalls.
 * @param {{populationLimit:number, remainingPages:number, minPagesPerTurn:number,
 * maxAdmissionGapMs?:number}} options
 */
function nameWorkServiceBound({ populationLimit, remainingPages, minPagesPerTurn, maxAdmissionGapMs }) {
  check(integer(populationLimit) && populationLimit > 0 && populationLimit <= 1_000_000
    && integer(remainingPages) && remainingPages <= 256 && integer(minPagesPerTurn) && minPagesPerTurn > 0
    && (maxAdmissionGapMs === undefined || integer(maxAdmissionGapMs) && maxAdmissionGapMs > 0));
  const admittedTurns = 3 * populationLimit * Math.ceil(remainingPages / minPagesPerTurn);
  const wallMs = maxAdmissionGapMs === undefined ? null : admittedTurns * maxAdmissionGapMs;
  check(wallMs === null || Number.isSafeInteger(wallMs));
  return { admittedTurns, wallMs };
}

export { initialNameWorkSelection, selectNameWork, planNameWorkRetry, nameWorkServiceBound };
