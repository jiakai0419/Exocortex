// @ts-check
// Finite command-boundary evidence only. No arguments, targets, error prose or
// returned payloads can enter this serializable representation.
const KINDS = new Set(['success','network_timeout','network_error','rate_limited','service_unavailable','internal_error',
  'restricted_mode','bot_user_out_of_chat','permission_denied','command_unavailable','spawn_error','unknown']);
const OPERATIONS = new Set(['message_history_bundle','message_search_bundle','chat_discovery_bundle','self_profile',
  'contact_search','chat_members','chat_bots','application_info','other']);
const FIELDS = ['version','launch_attempted','execution','result_at_ms','result_kind','result_code','remote_result'];
const TOKENS = ['receipt_v','launch_attempted','execution','result_at_ms','result_kind','result_code','remote_result'];
const REASONS = new Set(['clock_unavailable','shared_cooldown_unavailable','retry_wait_unavailable','lease_unavailable','invalid_json']);
/** @param {unknown} value @returns {value is Record<string,any>} */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
/** @param {unknown} value @returns {value is Record<string,any>} */
function validateLarkExecutionReceipt(value) {
  if (!object(value) || Object.keys(value).length !== FIELDS.length || FIELDS.some(key=>!Object.hasOwn(value,key))
    || value.version !== 1 || typeof value.launch_attempted !== 'boolean' || typeof value.remote_result !== 'boolean'
    || !['not_started','started','unknown'].includes(value.execution)
    || value.result_at_ms !== null && !integer(value.result_at_ms)
    || value.result_kind !== null && !KINDS.has(value.result_kind)
    || value.result_code !== null && !integer(value.result_code)) return false;
  if (value.execution !== 'started') return value.result_at_ms === null && value.result_kind === null
    && value.result_code === null && value.remote_result === false
    && (value.execution !== 'unknown' || value.launch_attempted === true);
  return value.launch_attempted === true && value.result_kind !== null
    && (value.result_code === null || value.remote_result === true)
    && (value.result_kind !== 'success' || value.result_code === null || value.result_code === 0);
}

/** All fields are serialized, including nulls. Parsing cannot fall through from
 * a present malformed receipt to an older classifier that guesses execution.
 * @param {unknown} value */
function formatLarkExecutionReceipt(value) {
  if (!validateLarkExecutionReceipt(value)) throw new Error('invalid_lark_execution_receipt');
  return `receipt_v=1 launch_attempted=${Number(value.launch_attempted)} execution=${value.execution}`
    + ` result_at_ms=${value.result_at_ms ?? 'none'} result_kind=${value.result_kind ?? 'none'}`
    + ` result_code=${value.result_code ?? 'none'} remote_result=${Number(value.remote_result)}`;
}

/** @param {unknown} error @param {string} [expectedOperation]
 * @returns {{status:'absent'|'invalid'|'valid',value?:Record<string,any>}} */
function readLarkExecutionReceipt(error, expectedOperation) {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!TOKENS.some(key=>new RegExp(`(?:^|\\s)${key}(?=[^A-Za-z0-9_]|$)`).test(text))) return {status:'absent'};
  const invalid = () => ({status:/** @type {'invalid'} */('invalid')});
  if (text.length > 2048 || !/^lark-cli failed: kind=[a-z_]+(?: [a-z_]+=[A-Za-z0-9_]+)*$/.test(text)) return invalid();
  /** @type {Record<string,string>} */
  const fields = {};
  for (const part of text.slice('lark-cli failed: '.length).split(' ')) {
    const [key,value] = part.split('=');
    if (Object.hasOwn(fields,key)) return invalid(); fields[key]=value;
    if (TOKENS.includes(key)) continue;
    if (key==='kind') {if (!KINDS.has(value) || value==='success') return invalid();}
    else if (key==='operation') {if (!OPERATIONS.has(value)) return invalid();}
    else if (['code','retry_after_ms','timeout_ms','retries'].includes(key)) {
      if (!/^\d+$/.test(value) || !integer(Number(value))) return invalid();
    } else if (key==='retry_after_source') {if (!['header','fallback','shared'].includes(value)) return invalid();}
    else if (key==='spawn_code') {if (!['ENOENT','EACCES'].includes(value)) return invalid();}
    else if (['retry_exhausted','exhausted'].includes(key)) {if (!['0','1'].includes(value)) return invalid();}
    else if (key==='reason') {if (!REASONS.has(value)) return invalid();}
    else return invalid();
  }
  if (!OPERATIONS.has(fields.operation) || expectedOperation !== undefined && fields.operation !== expectedOperation
    || TOKENS.some(key=>!Object.hasOwn(fields,key)) || fields.receipt_v!=='1'
    || !['0','1'].includes(fields.launch_attempted) || !['0','1'].includes(fields.remote_result)) return invalid();
  for (const key of ['result_at_ms','result_code']) if (fields[key]!=='none'
    && (!/^\d+$/.test(fields[key]) || !integer(Number(fields[key])))) return invalid();
  const value = {version:1,launch_attempted:fields.launch_attempted==='1',execution:fields.execution,
    result_at_ms:fields.result_at_ms==='none'?null:Number(fields.result_at_ms),
    result_kind:fields.result_kind==='none'?null:fields.result_kind,
    result_code:fields.result_code==='none'?null:Number(fields.result_code),remote_result:fields.remote_result==='1'};
  return validateLarkExecutionReceipt(value) ? {status:'valid',value} : invalid();
}

export { readLarkExecutionReceipt, validateLarkExecutionReceipt, formatLarkExecutionReceipt };
