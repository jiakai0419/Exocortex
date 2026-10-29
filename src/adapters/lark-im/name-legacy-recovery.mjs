// @ts-check
import { nameRouteAdmission, nameRouteDescriptor } from './name-route-state.mjs';

export const LEGACY_NAME_RECOVERY_MS = 300_000;
const integer = value => Number.isSafeInteger(value) && value >= 0;

/** A derived opportunity, not a rewritten task history or proof of permission.
 * @param {Record<string,any>} task @param {number} nowMs
 * @param {Record<string,any>|null} review */
export function legacyNameRecoveryDue(task, nowMs, review) {
  if (!integer(nowMs) || !integer(task.reviewed_retry_at_ms ?? 0) || !review || !review.canAccelerate(task, nowMs)) return null;
  if (integer(task.reviewed_retry_at_ms) && task.reviewed_retry_at_ms > nowMs)
    return task.kind === 'sender' && task.namespace === 'app_id' && task.blocked_reason === null
      && integer(task.retry_at_ms) && task.retry_at_ms <= nowMs
      && integer(task.last_attempt_at_ms) && task.last_attempt_at_ms > 0 && task.last_attempt_at_ms <= nowMs ? task.retry_at_ms : null;
  if (task.kind !== 'sender' || task.namespace !== 'app_id'
    || !['failed','unresolved'].includes(task.outcome) || task.blocked_reason !== null
    || task.attempt_token !== null || !integer(task.failures) || task.failures < 1
    || task.schedule_failures !== 0 || !integer(task.retry_at_ms)
    || !integer(task.last_attempt_at_ms) || task.last_attempt_at_ms < 1
    || task.last_attempt_at_ms > nowMs
    || task.last_attempt_at_ms > Number.MAX_SAFE_INTEGER - LEGACY_NAME_RECOVERY_MS) return null;
  return Math.min(task.retry_at_ms, task.last_attempt_at_ms + LEGACY_NAME_RECOVERY_MS);
}

/** Every applicable route must be nonterminal and structurally valid. A primary
 * denial cannot authorize an earlier request on a sibling route.
 * @param {Record<string,any>} task @param {Record<string,any>[]} rows @param {number} nowMs */
export function legacyNameRoutesAdmit(task, rows, nowMs) {
  return ['application_info','chat_bots'].every(operation => {
    const descriptor = nameRouteDescriptor(task, operation);
    if (!descriptor) return false;
    const matches = rows.filter(row => row.route_key === descriptor.route_key);
    if (matches.length > 1) return false;
    return nameRouteAdmission(descriptor, matches[0] || null, nowMs).allowed;
  });
}
