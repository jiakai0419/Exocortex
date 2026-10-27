// @ts-check
import { createHash } from 'node:crypto';
import { classifyLarkFailure, TRANSPORT_OPERATIONS } from './transport.mjs';

/** @typedef {Record<string, any>} Row */
const KINDS = new Set(['network_timeout', 'network_error', 'rate_limited', 'service_unavailable',
  'internal_error', 'restricted_mode', 'bot_user_out_of_chat', 'permission_denied',
  'command_unavailable', 'spawn_error', 'unknown']);
const OPERATIONS = new Set(['contact_search', 'application_info', 'chat_members', 'chat_bots', 'other']);
const TERMINAL = new Set(['permission_denied', 'command_unavailable']);
const ROUTE_FIELDS = ['source_id', 'account_key', 'route_key', 'operation'];
const ROW_FIELDS = [...ROUTE_FIELDS, 'failure_kind', 'failure_code', 'failures',
  'last_attempt_at_ms', 'retry_at_ms', 'blocked', 'generation'];
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const check = condition => { if (!condition) throw new Error('invalid_name_route_state'); };
const unknown = () => ({ kind: 'unknown', code: null, retryAfterMs: null });
const addTime = (now, delay) => delay > Number.MAX_SAFE_INTEGER - now ? Number.MAX_SAFE_INTEGER : now + delay;

/** The task's typed identity has already been validated by its coordinator.
 * This function never obtains or infers identity evidence.
 * @param {Row} task @param {string} operation */
function nameRouteDescriptor(task, operation) {
  if (!object(task) || task.source_id !== 'lark.im' || !digest(task.account_key)
    || !text(task.chat_id) || !OPERATIONS.has(operation)) return null;
  let scope;
  if (task.kind === 'chat') {
    if (operation !== 'other' || task.actor_id !== '' || task.namespace !== '') return null;
    scope = ['chat', task.chat_id];
  } else if (task.kind === 'sender' && text(task.actor_id)) {
    const expected = ['contact_search', 'chat_members'].includes(operation) ? 'open_id'
      : ['application_info', 'chat_bots'].includes(operation) ? 'app_id' : null;
    if (!expected || task.namespace !== expected) return null;
    scope = ['contact_search', 'application_info'].includes(operation) ? ['account'] : ['chat', task.chat_id];
  } else return null;
  const key = createHash('sha256').update(JSON.stringify(['lark_name_route/v1', task.source_id, task.account_key,
    operation, task.kind, task.namespace, task.actor_id, ...scope])).digest('hex');
  return { source_id: task.source_id, account_key: task.account_key, route_key: key, operation };
}

/** Classify only the producer's complete safe descriptor; do not classify
 * arbitrary private messages or let a substring imply permission failure.
 * @param {unknown} error @param {string} [expectedOperation] */
function classifyNameRouteFailure(error, expectedOperation) {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : null;
  if (typeof message !== 'string' || message.length > 1024
    || !/^lark-cli failed: kind=[a-z_]+(?: [a-z_]+=[A-Za-z0-9_]+)*$/.test(message)
    || expectedOperation !== undefined && !OPERATIONS.has(expectedOperation)) return unknown();
  /** @type {Record<string,string>} */
  const fields = {};
  for (const token of message.slice('lark-cli failed: '.length).split(' ')) {
    const [key, value] = token.split('=');
    if (Object.hasOwn(fields, key)) return unknown();
    fields[key] = value;
    if (['code', 'retry_after_ms', 'timeout_ms', 'retries'].includes(key)) {
      if (!/^\d+$/.test(value) || !integer(Number(value))) return unknown();
    } else if (key === 'kind') { if (!KINDS.has(value)) return unknown(); }
    else if (key === 'operation') { if (!TRANSPORT_OPERATIONS.includes(/** @type {any} */ (value))) return unknown(); }
    else if (key === 'retry_after_source') { if (!['header', 'fallback', 'shared'].includes(value)) return unknown(); }
    else if (key === 'spawn_code') { if (value !== 'ENOENT') return unknown(); }
    else if (key === 'retry_exhausted' || key === 'exhausted') { if (!['0', '1'].includes(value)) return unknown(); }
    else if (key === 'reason') { if (!['clock_unavailable', 'shared_cooldown_unavailable'].includes(value)) return unknown(); }
    else return unknown();
  }
  if (expectedOperation !== undefined && fields.operation !== undefined && fields.operation !== expectedOperation) return unknown();
  const failure = classifyLarkFailure(message);
  if (!KINDS.has(failure.kind) || failure.code !== null && !integer(failure.code)
    || failure.retry_after_ms !== null && !integer(failure.retry_after_ms)) return unknown();
  return { kind: failure.kind, code: failure.code, retryAfterMs: failure.retry_after_ms };
}

function validRoute(route) {
  return only(route, ROUTE_FIELDS) && route.source_id === 'lark.im' && digest(route.account_key)
    && digest(route.route_key) && OPERATIONS.has(route.operation);
}
function validRow(row, route) {
  return only(row, ROW_FIELDS) && ROUTE_FIELDS.every(key => row[key] === route[key])
    && integer(row.failures) && row.failures <= 3 && integer(row.generation)
    && integer(row.last_attempt_at_ms) && integer(row.retry_at_ms) && [0, 1].includes(row.blocked)
    && (row.failure_code === null || integer(row.failure_code))
    && (row.failures === 0 ? row.failure_kind === null && row.failure_code === null && row.blocked === 0
      : KINDS.has(row.failure_kind) && Boolean(row.blocked) === TERMINAL.has(row.failure_kind));
}
function terminal(row) {
  return row?.blocked ? { state: 'blocked', reason: row.failure_kind }
    : row?.failures >= 3 ? { state: 'exhausted', reason: 'failure_limit' } : null;
}

/** Pure ordinary-request admission. Reading a terminal row is not recovery,
 * and malformed metadata is unavailable rather than a fabricated denial.
 * @param {Row|null} route @param {Row|null} row @param {number} nowMs */
function nameRouteAdmission(route, row, nowMs) {
  if (!validRoute(route) || !integer(nowMs) || row !== null && (!validRow(row, route)
    || row.last_attempt_at_ms > nowMs)) return { allowed: false, state: 'unavailable' };
  const stopped = terminal(row);
  if (stopped) return { allowed: false, state: stopped.state };
  if (row && row.retry_at_ms > nowMs) return { allowed: false, state: 'retry' };
  return { allowed: true, state: 'ready' };
}

/** A state transition receipt is not request admission or response validation.
 * The caller alone performs generation CAS and actual request accounting.
 * @param {Row} route @param {Row|null} previous
 * @param {{type:'success'|'failure'|'deferred'|'recover',error?:unknown}} event
 * @param {{nowMs:number,cooldownUntilMs?:number}} options */
function nextNameRouteState(route, previous, event, { nowMs, cooldownUntilMs = 0 }) {
  check(validRoute(route) && (previous === null || validRow(previous, route))
    && only(event, ['type', 'error']) && ['success', 'failure', 'deferred', 'recover'].includes(event.type)
    && integer(nowMs) && integer(cooldownUntilMs)
    && (previous === null || nowMs >= previous.last_attempt_at_ms));
  const priorTerminal = terminal(previous);
  if (event.type !== 'recover' && priorTerminal) return { changed: false, ...priorTerminal, row: previous };
  if (event.type === 'deferred') return { changed: false, state: 'deferred', reason: 'admission_deferred', row: previous };
  if (event.type === 'recover' && previous === null) return { changed: false, state: 'ready', reason: 'recovered', row: null };
  check((previous?.generation || 0) < Number.MAX_SAFE_INTEGER);
  const row = { ...route, failure_kind: null, failure_code: null, failures: 0,
    last_attempt_at_ms: event.type === 'recover' ? previous?.last_attempt_at_ms ?? 0 : nowMs,
    retry_at_ms: event.type === 'recover' ? Math.max(nowMs, cooldownUntilMs) : 0,
    blocked: 0, generation: (previous?.generation || 0) + 1 };
  if (event.type === 'success' || event.type === 'recover')
    return { changed: true, state: 'ready', reason: event.type === 'success' ? 'successful_lookup' : 'recovered', row };
  const failure = classifyNameRouteFailure(event.error, route.operation);
  const failures = Math.min(3, (previous?.failures || 0) + 1);
  const blocked = TERMINAL.has(failure.kind) ? 1 : 0;
  const next = { ...row, failure_kind: failure.kind, failure_code: failure.code, failures, blocked,
    retry_at_ms: blocked || failures >= 3 ? 0 : Math.max(cooldownUntilMs,
      addTime(nowMs, Math.max(failures === 1 ? 5000 : 30000, failure.retryAfterMs || 0))) };
  return { changed: true, ...(terminal(next) || { state: 'retry', reason: failure.kind }), row: next };
}

export { nameRouteDescriptor, nameRouteAdmission, classifyNameRouteFailure, nextNameRouteState };
