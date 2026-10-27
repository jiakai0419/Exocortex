// @ts-check
import { readMessageAccountEvidence } from './message-account-evidence.mjs';
import { senderIdentity } from './sender-identity.mjs';
import { nameRouteDescriptor, nameRouteAdmission } from './name-route-state.mjs';
import { readSenderNameRouteFailures } from './sender-name-observation.mjs';

/** @typedef {Record<string, any>} Row */
/** @typedef {{at:number,denied:boolean}} RouteEvent */
/** @param {unknown} value @returns {value is Row} */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const operations = ['application_info', 'chat_bots'];
const observationFields = new Set(['observed_at','cached','account_key','status','reason','source','failure','name','route_failures']);
const denied = route => route?.status === 'failed' && route.failure?.kind === 'permission_denied'
  && route.failure?.code === 210508 && route.failure?.stage === 'response_error';
function observationTime(value, nowMs) {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isSafeInteger(at) && at >= 0 && at <= nowMs && new Date(at).toISOString() === value ? at : null;
}

/** A malformed companion cannot strengthen an older denial. A valid envelope
 * supplies independent operation candidates, never a whole-pair veto. Version
 * 1 only recorded a cohort clock; v2 retains each result/decision's own clock.
 * @param {Row} canonical
 * @param {{account_key:string,actor_id:string,namespace:string,chat_id:string}} task
 * @param {number} nowMs */
function inlineEvents(canonical, task, nowMs) {
  const observation = canonical.sender_name_verification;
  const empty = () => ({ invalid: false, events: /** @type {Map<string,RouteEvent>} */ (new Map()) });
  if (!object(observation) || !Object.hasOwn(observation, 'route_failures')) return empty();
  const envelope = readSenderNameRouteFailures(observation, task, nowMs);
  const at = observationTime(observation.observed_at, nowMs);
  if (!envelope || at === null || Object.keys(observation).some(key => !observationFields.has(key))
    || observation.name != null || observation.status !== 'failed' || observation.cached !== false
    || observation.account_key !== task.account_key
    || observation.reason !== (observation.failure?.kind === 'budget_exhausted' ? 'budget_exhausted' : 'request_failed'))
    return { ...empty(), invalid: true };
  const events = new Map();
  for (const route of envelope.routes) {
    // Admission and lack of an observation are diagnostics, not new request
    // outcomes. A skip caused by a stored denial cannot erase that same denial.
    if (['not_requested','unknown'].includes(route.status) || route.failure?.stage === 'not_requested') continue;
    const routeAt = envelope.version === 1 ? at : observationTime(route.observed_at, nowMs);
    if (routeAt !== null) events.set(route.operation, { at: routeAt, denied: denied(route) });
  }
  return { invalid: false, events };
}

/** Only complete indexed account candidates enter this reduction. Individual
 * missing/bad routes supply no event for themselves; they cannot invalidate a
 * valid response from another operation. Recovery admission is not a response.
 * @param {Row|null|undefined} saved @param {Row} task @param {number} nowMs */
function savedEvents(saved, task, nowMs) {
  /** @type {Map<string,RouteEvent>} */
  const events = new Map();
  if (!object(saved) || saved.available !== true || !Array.isArray(saved.accounts) || saved.accounts.length > 32) return events;
  const groups = saved.accounts.filter(value => object(value) && value.account_key === task.account_key);
  if (groups.length !== 1 || groups[0].complete !== true || !Array.isArray(groups[0].rows)
    || groups[0].rows.length > 1024) return events;
  for (const operation of operations) {
    const descriptor = nameRouteDescriptor(task, operation);
    if (!descriptor) continue;
    const matches = groups[0].rows.filter(value => object(value) && value.route_key === descriptor.route_key);
    if (matches.length !== 1) continue;
    const route = matches[0], admission = nameRouteAdmission(descriptor, route, nowMs);
    if (admission.state === 'unavailable' || route.generation < 1 || route.last_attempt_at_ms < 1
      || route.failure_kind === 'command_unavailable'
      || route.failures === 0 && route.retry_at_ms !== 0) continue;
    events.set(operation, { at: route.last_attempt_at_ms,
      denied: route.blocked === 1 && route.failure_kind === 'permission_denied'
        && route.failure_code === 210508 && route.failures >= 1 });
  }
  return events;
}

/** Latest evidence is selected per operation. Equal clocks cannot establish
 * recovery after an explicit denial, so denial wins a tie regardless of store.
 * @param {RouteEvent|undefined} first @param {RouteEvent|undefined} second */
function latestRouteEvent(first, second) {
  if (!first) return second;
  if (!second) return first;
  if (first.at !== second.at) return first.at > second.at ? first : second;
  return first.denied ? first : second;
}

/** One reducer for inline and saved failures. These hashes never supply account
 * ownership, a name, a new observation clock or a successful lookup.
 * @param {Row} row @param {Row} canonical @param {Row} raw @param {Row} account
 * @param {Row|null|undefined} saved @param {number} [nowMs] */
export function readSavedSenderRouteEvidence(row, canonical, raw, account, saved, nowMs = Date.now()) {
  const unknown = () => ({ blockers: /** @type {Row[]} */ ([]) });
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return unknown();
  const proof = readMessageAccountEvidence(row, canonical, raw, nowMs), identity = senderIdentity(raw);
  if (!proof || account.state !== 'verified' || account.account_key !== proof.account_key
    || !identity.verified || identity.conflict || identity.type !== 'app_id'
    || identity.id !== row.actor_id || canonical.sender_id !== identity.id || canonical.sender_id_type !== 'app_id') return unknown();
  const task = { source_id: row.source_id, account_key: proof.account_key, kind: 'sender',
    actor_id: identity.id, namespace: identity.type, chat_id: row.container_id };
  const inline = inlineEvents(canonical, task, nowMs);
  if (inline.invalid) return unknown();
  const stored = savedEvents(saved, task, nowMs);
  if (!operations.every(operation => latestRouteEvent(inline.events.get(operation), stored.get(operation))?.denied)) return unknown();
  return { blockers: operations.map(operation => ({ field: 'sender', source_id: row.source_id, account_key: proof.account_key,
    chat_id: row.container_id, id: identity.id, id_type: identity.type,
    authority: operation === 'application_info' ? 'application_api' : 'chat_bot_app_id',
    reason: 'permission_denied', code: 210508 })) };
}

/** @param {Row} row @param {Row} canonical @param {Row} raw @param {Row} account
 * @param {Row|null|undefined} saved @param {number} [nowMs] */
export function readSavedSenderRouteBlockers(row, canonical, raw, account, saved, nowMs = Date.now()) {
  return readSavedSenderRouteEvidence(row, canonical, raw, account, saved, nowMs).blockers;
}
