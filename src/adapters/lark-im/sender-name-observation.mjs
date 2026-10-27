// @ts-check
import { classifyNameRouteFailure } from './name-route-state.mjs';

const OPERATIONS = {contact:'contact_search',chat_member:'chat_members',
  application_api:'application_info',chat_bot_app_id:'chat_bots'};
const KINDS = new Set(['network_timeout','network_error','rate_limited','service_unavailable','internal_error',
  'restricted_mode','bot_user_out_of_chat','permission_denied','command_unavailable','spawn_error','unknown','budget_exhausted']);
const STAGES = new Set(['not_requested','response_error','request_error','unknown']);
const FIELDS = ['version','operation','kind','code','stage'];
/** @param {unknown} value @returns {value is Record<string,any>} */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Persist only the transport's complete finite public descriptor. Arbitrary
 * exception text (including paths, targets and API payloads) is never parsed or
 * stored. "request_error" attests a failed runner result, not an HTTP response.
 * @param {unknown} error @param {string} operation @param {boolean} [notRequested] */
function nameLookupFailure(error, operation, notRequested = false) {
  if (notRequested) return {version:1,operation,kind:'budget_exhausted',code:null,stage:'not_requested'};
  const classified = classifyNameRouteFailure(error, operation);
  const descriptor = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const sharedBeforeRequest = classified.kind === 'rate_limited' && classified.code === null
    && /(?:^| )retry_after_source=shared(?: |$)/.test(descriptor);
  return {version:1,operation,kind:classified.kind,code:classified.code,
    stage:classified.code !== null ? 'response_error'
      : sharedBeforeRequest || classified.kind === 'command_unavailable' ? 'not_requested'
        : ['network_timeout','network_error','service_unavailable','internal_error','restricted_mode',
          'bot_user_out_of_chat','permission_denied','spawn_error'].includes(classified.kind) ? 'request_error' : 'unknown'};
}

/** The new optional diagnostic has an exact whitelist; it grants no name or
 * account authority. Existing observation envelopes and successful-task schemas
 * retain their established fields and compatibility.
 * @param {Record<string,any>|null|undefined} observation */
function sanitizeSenderNameObservation(observation) {
  if (!object(observation)) return null;
  if (!Object.hasOwn(observation,'failure')) return observation;
  const {failure,...base}=observation;
  if (observation.status !== 'failed' || !object(failure) || Object.keys(failure).length !== FIELDS.length
    || FIELDS.some(key=>!Object.hasOwn(failure,key)) || failure.version !== 1
    || !Object.hasOwn(OPERATIONS,observation.source) || failure.operation !== OPERATIONS[observation.source]
    || !KINDS.has(failure.kind) || !STAGES.has(failure.stage)
    || failure.code !== null && (!Number.isSafeInteger(failure.code) || failure.code < 0)
    || (failure.stage==='response_error') !== (failure.code!==null)
    || failure.kind==='budget_exhausted' && (observation.reason!=='budget_exhausted' || failure.stage!=='not_requested')
    || failure.kind!=='budget_exhausted' && observation.reason!=='request_failed') return base;
  return {...base,failure:Object.fromEntries(FIELDS.map(key=>[key,failure[key]]))};
}

export { nameLookupFailure, sanitizeSenderNameObservation };
