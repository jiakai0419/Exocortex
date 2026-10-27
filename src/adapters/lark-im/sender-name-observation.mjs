// @ts-check
import { createHash } from 'node:crypto';
import { classifyNameRouteFailure } from './name-route-state.mjs';

const OPERATIONS = {contact:'contact_search',chat_member:'chat_members',
  application_api:'application_info',chat_bot_app_id:'chat_bots'};
const KINDS = new Set(['network_timeout','network_error','rate_limited','service_unavailable','internal_error',
  'restricted_mode','bot_user_out_of_chat','permission_denied','command_unavailable','spawn_error','unknown','budget_exhausted']);
const STAGES = new Set(['not_requested','response_error','request_error','unknown']);
const FIELDS = ['version','operation','kind','code','stage'];
const HASH = /^[0-9a-f]{64}$/;
const ROUTE_FIELDS = ['version','attempt_key','target_key','account_key','routes'];
const ROUTE_ITEM_FIELDS = ['operation','status','failure'];
const routeTime = (value, nowMs) => typeof value === 'string' && Number.isSafeInteger(Date.parse(value))
  && Date.parse(value) >= 0 && Date.parse(value) <= nowMs && new Date(Date.parse(value)).toISOString() === value;
const APP_OPERATIONS = ['application_info','chat_bots'];
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

/** @param {unknown} failure @param {string} operation */
function validFailure(failure, operation) {
  return object(failure) && Object.keys(failure).length === FIELDS.length
    && FIELDS.every(key=>Object.hasOwn(failure,key)) && failure.version === 1 && failure.operation === operation
    && KINDS.has(failure.kind) && STAGES.has(failure.stage)
    && (failure.code === null || Number.isSafeInteger(failure.code) && failure.code >= 0)
    && (failure.stage === 'response_error') === (failure.code !== null)
    && (failure.kind !== 'budget_exhausted' || failure.stage === 'not_requested');
}

/** Opaque binding to the exact account, explicit app namespace, actor and chat.
 * This digest is not account evidence and cannot supply a name or authority.
 * @param {string} accountKey @param {string} actorId @param {string} chatId */
function senderNameRouteTargetKey(accountKey, actorId, chatId) {
  if (typeof accountKey !== 'string' || !HASH.test(accountKey)
    || typeof actorId !== 'string' || !actorId || actorId.includes('\0')
    || typeof chatId !== 'string' || !chatId || chatId.includes('\0')) return null;
  return createHash('sha256').update(JSON.stringify(['lark.im',accountKey,'app_id',actorId,chatId])).digest('hex');
}

/** V2 stores each route's actual observation/skip decision clock. V1 remains
 * an unchanged legacy cohort envelope; its top-level clock must never be
 * relabeled as a precise per-route response time.
 * Only two current-attempt route outcomes are supported. Missing/empty routes
 * never imply denial; arbitrary private error fields are rejected as a whole.
 * Binding is mandatory at the projection/record boundary, optional for callers
 * that only sanitize the finite shape before checking their own identity proof.
 * @param {Record<string,any>|null|undefined} observation
 * @param {{account_key:string,actor_id:string,namespace:string,chat_id:string}} [binding]
 * @param {number} [nowMs] */
function readSenderNameRouteFailures(observation, binding, nowMs = Date.now()) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !object(observation) || observation.status !== 'failed' || observation.cached !== false
    || !['application_api','chat_bot_app_id'].includes(observation.source)
    || typeof observation.account_key !== 'string' || !HASH.test(observation.account_key)
    || !validFailure(observation.failure, OPERATIONS[observation.source])) return null;
  const value = observation.route_failures;
  if (!object(value) || Object.keys(value).length !== ROUTE_FIELDS.length
    || ROUTE_FIELDS.some(key=>!Object.hasOwn(value,key)) || ![1,2].includes(value.version)
    || typeof value.attempt_key !== 'string' || !HASH.test(value.attempt_key)
    || typeof value.target_key !== 'string' || !HASH.test(value.target_key)
    || value.account_key !== observation.account_key || !Array.isArray(value.routes) || value.routes.length !== 2
    || binding && (binding.namespace !== 'app_id' || binding.account_key !== value.account_key
      || senderNameRouteTargetKey(binding.account_key,binding.actor_id,binding.chat_id) !== value.target_key)) return null;
  const routeFields = value.version === 2 ? [...ROUTE_ITEM_FIELDS,'observed_at'] : ROUTE_ITEM_FIELDS;
  for (const [index,route] of value.routes.entries()) {
    if (!object(route) || Object.keys(route).length !== routeFields.length
      || routeFields.some(key=>!Object.hasOwn(route,key)) || route.operation !== APP_OPERATIONS[index]
      || !['failed','unresolved','not_requested','unknown'].includes(route.status)
      || (route.failure !== null && (route.status !== 'failed' || !validFailure(route.failure,route.operation)))
      || value.version === 2 && (route.status === 'unknown' ? route.observed_at !== null : !routeTime(route.observed_at,nowMs))) return null;
  }
  const selected = value.routes.find(route=>route.operation === observation.failure.operation);
  if (!selected || selected.status !== 'failed' || !selected.failure
    || FIELDS.some(key=>selected.failure[key] !== observation.failure[key])
    || value.version === 2 && selected.observed_at !== observation.observed_at) return null;
  return {version:value.version,attempt_key:value.attempt_key,target_key:value.target_key,account_key:value.account_key,
    routes:value.routes.map(route=>({operation:route.operation,status:route.status,
      ...(value.version === 2 ? {observed_at:route.observed_at} : {}),failure:route.failure === null ? null : Object.fromEntries(FIELDS.map(key=>[key,route.failure[key]]))}))};
}

/** The optional diagnostic grants no name/account authority. Successful-task
 * schemas keep their established shape. An invalid companion envelope is
 * removed without erasing the independently valid primary-route failure.
 * @param {Record<string,any>|null|undefined} observation
 * @param {{account_key:string,actor_id:string,namespace:string,chat_id:string}} [binding]
 * @param {number} [nowMs] */
function sanitizeSenderNameObservation(observation, binding, nowMs = Date.now()) {
  if (!object(observation)) return null;
  if (!Object.hasOwn(observation,'failure') && !Object.hasOwn(observation,'route_failures')) return observation;
  const {failure,route_failures,...base}=observation;
  if (observation.status !== 'failed' || !Object.hasOwn(OPERATIONS,observation.source)
    || !validFailure(failure,OPERATIONS[observation.source])
    || failure.kind==='budget_exhausted' && observation.reason!=='budget_exhausted'
    || failure.kind!=='budget_exhausted' && observation.reason!=='request_failed') return base;
  const routes = readSenderNameRouteFailures(observation,binding,nowMs);
  return {...base,failure:Object.fromEntries(FIELDS.map(key=>[key,failure[key]])),...(routes ? {route_failures:routes} : {})};
}

export { nameLookupFailure, sanitizeSenderNameObservation, senderNameRouteTargetKey, readSenderNameRouteFailures };
