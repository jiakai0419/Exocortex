type TransportDiagnostic = { operation: string; execution: string; result_kind: string | null;
  result_code: number | null; remote_result: boolean; local_reason: string | null };
type Diagnostic = { version: 1; stage: string; kind: string; operation?: string; transport?: TransportDiagnostic; lease?: Record<string,unknown> };
const HINT_STAGES = new Set(['state_read', 'source_policy_read', 'source_policy_decode', 'metadata_read', 'metadata_map']);
const FAILURE_STAGES = new Set(['batch_prepare', 'batch_select', 'batch_commit', 'single_target']);
const READ_KINDS = new Set(['dependency_unavailable', 'read_timeout', 'read_failed', 'invalid_response']);
const HINT_KINDS = new Set([...READ_KINDS, 'state_missing', 'state_invalid', 'invalid_policy', 'unknown']);
const TRANSPORT_KINDS = new Set(['success','network_timeout','network_error','rate_limited','service_unavailable',
  'internal_error','restricted_mode','bot_user_out_of_chat','permission_denied','command_unavailable','spawn_error','unknown']);
const LOCAL_REASONS = new Set(['clock_unavailable','shared_cooldown_unavailable','retry_wait_unavailable','lease_unavailable','invalid_json']);
const TRANSPORT_OPERATIONS = new Set(['message_history_bundle','message_search_bundle','chat_discovery_bundle',
  'self_profile','contact_search','chat_members','chat_bots','application_info','other']);
const HISTORY_FAILURE_OPERATIONS = new Set(['account_snapshot','opening_self','account_admission','target_select',
  'candidate_pool','write_admission','message_fetch','message_prepare','closing_self','admission_recheck',
  'binding_recheck','storage_commit','history_target_read','detail_basis','legacy_fetch','current_target_select']);
export function isHistoryFailureOperation(value: unknown): value is string {
  return typeof value === 'string' && HISTORY_FAILURE_OPERATIONS.has(value);
}
const FAILURE_KINDS = new Set([...READ_KINDS, ...TRANSPORT_KINDS, ...LOCAL_REASONS,
  'cli_budget','self_budget','time_budget','sync_busy','rate_cooldown',
  'request_not_started','request_execution_unknown','request_invalid_json']);
FAILURE_KINDS.delete('success');
const SELECTION_STOPS = new Set(['no_target', 'outside_pool', 'already_consumed', 'source_changed']);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Exact, closed public structures. Never copy arbitrary nested error fields. */
export function sanitizeHistoryDiagnostic(value: unknown, role: 'hint' | 'failure'): Diagnostic | null {
  const allowed = role === 'hint' ? ['version','stage','kind'] : ['version','stage','kind','operation','transport','lease'];
  if (!object(value) || value.version !== 1 || Object.keys(value).some(key => !allowed.includes(key))
    || !['version', 'stage', 'kind'].every(key => Object.hasOwn(value, key))
    || typeof value.stage !== 'string' || !(role === 'hint' ? HINT_STAGES : FAILURE_STAGES).has(value.stage)
    || typeof value.kind !== 'string' || !(role === 'hint' ? HINT_KINDS : FAILURE_KINDS).has(value.kind)) return null;
  const result: Diagnostic = { version: 1, stage: value.stage, kind: value.kind };
  if(Object.hasOwn(value,'lease')) {
    const lease=value.lease, keys=['version','phase','stage','state','reason','grant_ms','elapsed_ms'];
    if(!object(lease)||Object.keys(lease).length!==keys.length||keys.some(key=>!Object.hasOwn(lease,key))
      ||lease.version!==1||!['request','commit'].includes(String(lease.phase))
      ||!['preflight','intent','api','post_acquire'].includes(String(lease.stage))
      ||!['busy','unavailable'].includes(String(lease.state))
      ||!['lark_api_busy','lease_deadline','lease_helper_unavailable','lease_evidence_unavailable','lease_platform_unavailable'].includes(String(lease.reason))
      ||(lease.state==='busy')!==(lease.reason==='lark_api_busy')
      ||lease.grant_ms!==null&&(!Number.isSafeInteger(lease.grant_ms)||Number(lease.grant_ms)<0||Number(lease.grant_ms)>2000)
      ||lease.elapsed_ms!==null&&(!Number.isSafeInteger(lease.elapsed_ms)||Number(lease.elapsed_ms)<0||Number(lease.elapsed_ms)>180000))return null;
    result.lease={...lease};
  }
  if (Object.hasOwn(value,'operation')) {
    if (typeof value.operation !== 'string' || !HISTORY_FAILURE_OPERATIONS.has(value.operation)) return null;
    result.operation = value.operation;
  }
  if (Object.hasOwn(value,'transport')) {
    const t = value.transport;
    const fields = ['operation','execution','result_kind','result_code','remote_result','local_reason'];
    if (!object(t) || Object.keys(t).length !== fields.length || fields.some(key=>!Object.hasOwn(t,key))
      || typeof t.operation !== 'string' || !TRANSPORT_OPERATIONS.has(t.operation)
      || typeof t.execution !== 'string' || !['not_started','started','unknown'].includes(t.execution)
      || t.result_kind !== null && (typeof t.result_kind !== 'string' || !TRANSPORT_KINDS.has(t.result_kind))
      || t.result_code !== null && (typeof t.result_code !== 'number' || !Number.isSafeInteger(t.result_code) || t.result_code < 0)
      || typeof t.remote_result !== 'boolean'
      || t.local_reason !== null && (typeof t.local_reason !== 'string' || !LOCAL_REASONS.has(t.local_reason))
      || t.execution !== 'started' && (t.result_kind !== null || t.result_code !== null || t.remote_result)
      || t.execution === 'started' && t.result_kind === null
      || t.result_code !== null && !t.remote_result
      || t.result_kind === 'success' && t.result_code !== null && t.result_code !== 0) return null;
    result.transport = {operation:t.operation, execution:t.execution, result_kind:t.result_kind as string | null,
      result_code:t.result_code as number | null, remote_result:t.remote_result, local_reason:t.local_reason as string | null};
  }
  return result;
}

export function sanitizeHistoryCommitEvidence(value: unknown): Record<string,any> | null {
  const keys=['version','attempt_ref','target_ref','action_entered','sql_execution','receipt_validated','commit_state','cleanup_state'];
  if(!object(value)||value.version!==1||Object.keys(value).some(key=>![...keys,'audit_ref','effects'].includes(key))
    ||keys.some(key=>!Object.hasOwn(value,key))||![value.attempt_ref,value.target_ref].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))
    ||typeof value.action_entered!=='boolean'||typeof value.receipt_validated!=='boolean'
    ||!['not_started','started','unknown'].includes(String(value.sql_execution))
    ||!['not_started','committed','unknown'].includes(String(value.commit_state))
    ||!['not_started','complete','failed','unknown'].includes(String(value.cleanup_state)))return null;
  if(!value.action_entered&&(value.sql_execution!=='not_started'||value.receipt_validated))return null;
  if(value.receipt_validated ? value.commit_state!=='committed'
    : value.commit_state==='committed'||value.sql_execution!=='not_started'&&value.commit_state!=='unknown'
      ||!value.action_entered&&value.commit_state!=='not_started')return null;
  if(value.receipt_validated) {
    if(typeof value.audit_ref!=='string'||!/^[a-f0-9]{64}$/.test(value.audit_ref)||!object(value.effects))return null;
    const effects=value.effects, fields=['inserted','updated','duplicate','conflicts'];
    if(Object.keys(effects).length!==4||fields.some(key=>!Number.isSafeInteger(effects[key])||Number(effects[key])<0)
      ||fields.reduce((n,key)=>n+Number(effects[key]),0)>1)return null;
  } else if(Object.hasOwn(value,'audit_ref')||Object.hasOwn(value,'effects'))return null;
  return {...value,...(value.effects?{effects:{...value.effects as Record<string,number>}}:{})};
}

export function sanitizeHistorySelectionStops(value: unknown): Record<string, number> | null {
  if (!object(value) || !Object.keys(value).length || Object.keys(value).some(key => !SELECTION_STOPS.has(key))) return null;
  const result: Record<string, number> = {};
  let total = 0;
  for (const [key, count] of Object.entries(value)) {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 12) return null;
    result[key] = count; total += count;
  }
  return total > 12 ? null : result;
}
