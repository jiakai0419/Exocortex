// @ts-check
import { readMessageAccountEvidence } from './message-account-evidence.mjs';
import { senderIdentity } from './sender-identity.mjs';
import { nameRouteDescriptor, nameRouteAdmission } from './name-route-state.mjs';
import { readSenderNameRouteFailures } from './sender-name-observation.mjs';

/** @typedef {Record<string, any>} Row */
/** @param {unknown} value @returns {value is Row} */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const operations = ['application_info', 'chat_bots'];
const denied = route => route?.status === 'failed' && route.failure?.kind === 'permission_denied'
  && route.failure?.code === 210508 && route.failure?.stage === 'response_error';

/** Read only a complete, bounded route candidate group from the same message
 * snapshot. Hashed route keys are reconstructed from current proved identity;
 * they never supply account ownership, a name, or a renewed observation clock.
 * @param {Row} row @param {Row} canonical @param {Row} raw @param {Row} account
 * @param {Row|null|undefined} saved @param {number} [nowMs] */
export function readSavedSenderRouteEvidence(row, canonical, raw, account, saved, nowMs = Date.now()) {
  const unknown = () => ({ blockers: /** @type {Row[]} */ ([]), supersedes_inline: false });
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !object(saved) || saved.available !== true
    || !Array.isArray(saved.accounts) || saved.accounts.length > 32) return unknown();
  const proof = readMessageAccountEvidence(row, canonical, raw, nowMs), identity = senderIdentity(raw);
  if (!proof || account.state !== 'verified' || account.account_key !== proof.account_key
    || !identity.verified || identity.conflict || identity.type !== 'app_id'
    || identity.id !== row.actor_id || canonical.sender_id !== identity.id || canonical.sender_id_type !== 'app_id') return unknown();
  const groups = saved.accounts.filter(value => object(value) && value.account_key === proof.account_key);
  if (groups.length !== 1 || groups[0].complete !== true || !Array.isArray(groups[0].rows)
    || groups[0].rows.length > 1024) return unknown();
  const task = { source_id: row.source_id, account_key: proof.account_key, kind: 'sender',
    actor_id: identity.id, namespace: identity.type, chat_id: row.container_id };
  const routes = [];
  for (const operation of operations) {
    const descriptor = nameRouteDescriptor(task, operation);
    if (!descriptor) return unknown();
    const matches = groups[0].rows.filter(value => object(value) && value.route_key === descriptor.route_key);
    if (matches.length !== 1) return unknown();
    const route = matches[0], admission = nameRouteAdmission(descriptor, route, nowMs);
    if (admission.state === 'unavailable' || route.generation < 1 || route.last_attempt_at_ms < 1) return unknown();
    routes.push(route);
  }
  // A newer, exactly bound producer observation can show that a fallback is
  // recoverable or unattempted. Old table denials cannot override that result.
  const observation = canonical.sender_name_verification;
  if (object(observation) && Object.hasOwn(observation, 'route_failures')) {
    const latest = readSenderNameRouteFailures(observation, task), at = Date.parse(observation.observed_at);
    if (!latest || !Number.isSafeInteger(at) || at < 0 || at > nowMs
      || new Date(at).toISOString() !== observation.observed_at) return unknown();
    // Recovery alone preserves last_attempt_at_ms. Only a strictly later real
    // success or nonblocked failed attempt can invalidate older paired denial;
    // a missing row, retry clock, generation bump or equal clock cannot do so.
    if (latest.routes.every(denied) && routes.some(route => route.last_attempt_at_ms > at && route.blocked === 0
      && (route.failures > 0 || route.retry_at_ms === 0)))
      return { blockers: [], supersedes_inline: true };
    if (routes.some(route => at >= route.last_attempt_at_ms) && !latest.routes.every(denied)) return unknown();
  }
  if (!routes.every(route => route.blocked === 1 && route.failure_kind === 'permission_denied'
    && route.failure_code === 210508 && route.failures >= 1)) return unknown();
  return { blockers: routes.map(route => ({ field: 'sender', source_id: row.source_id, account_key: proof.account_key,
    chat_id: row.container_id, id: identity.id, id_type: identity.type,
    authority: route.operation === 'application_info' ? 'application_api' : 'chat_bot_app_id',
    reason: 'permission_denied', code: 210508 })), supersedes_inline: false };
}

/** @param {Row} row @param {Row} canonical @param {Row} raw @param {Row} account
 * @param {Row|null|undefined} saved @param {number} [nowMs] */
export function readSavedSenderRouteBlockers(row, canonical, raw, account, saved, nowMs = Date.now()) {
  return readSavedSenderRouteEvidence(row, canonical, raw, account, saved, nowMs).blockers;
}
