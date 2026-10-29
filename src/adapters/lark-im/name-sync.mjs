import { randomUUID } from 'node:crypto';
import { quoteSql, REVIEW_RECORD_COLUMNS } from '../../../dist/storage/sqlite/ingestion-store.js';
import { validateJsonObjectText } from '../../../dist/core/json-text-patch.js';
import { captureLarkWriteAdmission } from '../../diagnostics/lark-write-admission.mjs';
import { commitEnrichmentUpdates } from '../../maintenance/enrichment-commit.mjs';
import { readOnlySqliteJson } from '../../storage/sqlite/readonly-query.mjs';
import { getLarkApiLeaseStdio } from '../../runtime/lark-api-lease.mjs';
import { createLarkImAdapter } from './adapter.mjs';
import { chatScopeId } from './core.mjs';
import { chatTitle, chatNameCleared, titleMessageMatches } from './chat-title.mjs';
import { nameTaskKey, senderNameTarget } from './name-evidence.mjs';
import { recipientAccountKey, sentRecipientAccount } from './p2p-recipient.mjs';
import { prepareRecipientWork } from './recipient-sync.mjs';
import { prepareSenderWork } from './sender-name-work.mjs';
import { senderNeedsAuthorityRepair } from './sender-authority-repair.mjs';
import { prepareChatWork } from './chat-name-work.mjs';
import { readNameRecordPage } from './name-projection-progress.mjs';
import { nameRecordFence, nameEffects, nameFence, nameStateKey, nameRowBytesSql, NAME_RETRY_MS, NAME_REFRESH_MS } from './name-work-common.mjs';
import { runLark, transportOperation } from './transport.mjs';
import { selectNameWork } from './name-work-policy.mjs';
import { nameRouteDescriptor, nextNameRouteState } from './name-route-state.mjs';
import { readLarkExecutionReceipt, validateLarkExecutionReceipt, formatLarkExecutionReceipt } from './transport-execution.mjs';

const PAGE = 40, MAX_CALLS = 4, BUDGET_MS = 10_000, INTERVAL_MS = 60_000;
class NameBudgetError extends Error {}
class NameRouteDeferredError extends Error {}

const PROGRESS_FIELDS = ['latest_record_id','after_record_id','projection_horizon_record_id','projection_deferred',
  'witness_after_record_id','witness_horizon_record_id'];
const progressFence = task => PROGRESS_FIELDS.map(field=>`${field} IS ${quoteSql(task[field]??0)}`).join(' AND ');
function validNameWitness(row, task, self, accountKey) {
  if (!row || row.source_id !== task.source_id || row.record_type !== 'lark.im.message'
    || row.container_id !== task.chat_id || task.kind === 'sender' && row.actor_id !== task.actor_id) return false;
  try {
    const canonical=JSON.parse(row.canonical_json),raw=JSON.parse(row.raw_json);
    if (!titleMessageMatches(row,canonical,raw)
      || row.direction==='sent' && sentRecipientAccount(row,canonical,raw)!==self.open_id
      || [canonical.chat_name_account_key,canonical.sender_name_account_key,canonical.sender_name_verification?.account_key]
        .some(value=>value!=null&&value!==accountKey)) return false;
    if (task.kind==='sender') return senderNameTarget(row)?.namespace===task.namespace;
    return !chatNameCleared(canonical,raw)
      && ![canonical,raw,raw.chat,raw.raw_api,raw.raw_api?.chat].some(value=>[value?.chat_type,value?.chat_mode].includes('p2p'));
  } catch { return false; }
}

/** One shared optional tail. Content coverage and public status are untouched.
 * New rows, a fixed historical horizon and due work each get bounded progress;
 * persisted priority and fair turns survive process restarts.
 * @param {string} db @param {Record<string,any>} self @param {Record<string,any>} [deps] */
function syncNames(db, self, deps = {}) {
  const report = { attempted: 0, updated: 0, calls: 0, reason: 'idle' };
  if (!deps.runLark && !getLarkApiLeaseStdio()) return { ...report, reason: 'lease_unavailable' };
  const now = deps.now || Date.now, monotonic = deps.monotonicNow || (() => performance.now());
  const started = monotonic(), nowMs = now(), accountKey = recipientAccountKey(self?.open_id);
  if (!accountKey || !Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isFinite(started)) return report;
  let lastClock = started, calls = 0, activeTask = null;
  const routeReads = new Map(), routeWrites = new Map();
  let routeDeferred = false, recoveryProbe = false;
  const remaining = () => {
    const value = monotonic();
    if (!Number.isFinite(value) || value < lastClock) throw new NameBudgetError('name clock unavailable');
    lastClock = value;
    const left = Math.floor(BUDGET_MS - (value - started));
    if (left <= 0) throw new NameBudgetError('name budget exhausted');
    return left;
  };
  const query = (sql, label) => (deps.readOnlyQuery || readOnlySqliteJson)(db,sql,label,{timeoutMs: remaining()});
  const routeKeySql = route => `source_id='lark.im' AND account_key=${quoteSql(route.account_key)} AND route_key=${quoteSql(route.route_key)}`;
  const routeFor = (operation, forRequest=false) => {
    const route = activeTask && nameRouteDescriptor(activeTask, operation);
    if (!route) return null;
    if (!routeReads.has(route.route_key)) routeReads.set(route.route_key,
      query(`SELECT * FROM lark_im_name_routes WHERE ${routeKeySql(route)};`, 'read exact name route')[0] || null);
    let row=routeWrites.get(route.route_key)||routeReads.get(route.route_key);
    if(recoveryProbe&&forRequest&&row&&(row.blocked||row.failures>=3)&&row.retry_at_ms<=nowMs) {
      const recovered=nextNameRouteState(route,row,{type:'recover'},{nowMs});
      row=recovered.row; // Only an actual request outcome may publish this recovery.
    }
    return { route, row };
  };
  const recordRoute = (entry, event) => {
    if (!entry) return;
    const observedNow = now();
    if (!Number.isSafeInteger(observedNow) || observedNow < nowMs) { routeDeferred = true; return; }
    const next = nextNameRouteState(entry.route, entry.row, event, { nowMs: observedNow });
    if (next.state === 'deferred') routeDeferred = true;
    if (next.changed) {
      const row=next.row;
      if(row&&(row.blocked||row.failures>=3)) row.retry_at_ms=nowMs+(row.blocked?NAME_REFRESH_MS:NAME_RETRY_MS);
      routeWrites.set(entry.route.route_key,row);
    }
  };
  const boundedRun = (args, options = {}, reserve = 0) => {
    remaining();
    const entry = routeFor(transportOperation(args),true);
    if (entry?.row && (entry.row.blocked || entry.row.failures >= 3 || entry.row.retry_at_ms > nowMs)) {
      routeDeferred = true;
      throw new NameRouteDeferredError('exact name route deferred');
    }
    if (calls >= MAX_CALLS - reserve) throw new NameBudgetError('name request limit reached');
    const left = remaining(); // Route reads consume the same monotonic budget.
    calls += 1;
    let receiptSeen = false, executionReceipt = null;
    try {
      const result = (deps.runLark || runLark)(args,{...options,retries:0,timeoutMs:Math.min(5000,left),retryBudgetMs:left,maxBufferBytes:2*1024*1024,
        onExecutionReceipt(value) {
          receiptSeen = true;
          executionReceipt = validateLarkExecutionReceipt(value) ? { ...value } : null;
          try { options.onExecutionReceipt?.(value); } catch { /* Optional observation cannot affect transport. */ }
        }});
      if (result && (result.error != null || result.ok === false || result.success === false || result.code !== undefined && result.code !== 0)) {
        const code = Number.isSafeInteger(result.code) && result.code >= 0 ? ` code=${result.code}` : '';
        const receipt = !receiptSeen ? '' : executionReceipt ? ` ${formatLarkExecutionReceipt(executionReceipt)}` : ' receipt_v=invalid';
        throw new Error(`lark-cli failed: kind=unknown${code} operation=${transportOperation(args)}${receipt}`);
      }
      recordRoute(entry, { type: 'success', ...(receiptSeen ? { execution: executionReceipt } : {}) });
      return result;
    } catch (error) {
      const safe = error instanceof Error ? error.message : '';
      const execution = readLarkExecutionReceipt(error, transportOperation(args));
      if (execution.status === 'invalid' || execution.status === 'valid' && execution.value?.execution !== 'started') routeDeferred = true;
      else if (execution.status === 'absent' && /^lark-cli failed: /.test(safe)
        && /(?:retry_after_source=shared|reason=sync_busy|reason=shared_cooldown_unavailable)(?:\s|$)/.test(safe)) routeDeferred = true;
      else recordRoute(entry, { type: 'failure', error });
      throw error;
    }
  };
  try {
    const admission = captureLarkWriteAdmission(db,{selfOpenId:self.open_id,requireVerified:true});
    const commit = (updates, reason) => {
      remaining();
      return commitEnrichmentUpdates(db,updates,{dryRun:false,reason,label:'commit bounded name work',
        writeAdmission:admission.fence,admissionBeforeCommit:admission.assertCurrent,withCommit: action => action()});
    };
    let scan = query(`SELECT * FROM lark_im_name_scan WHERE account_key=${quoteSql(accountKey)};`,'read name scan cursor')[0];
    if(Number(scan?.next_attempt_at_ms||0)>nowMs) return {...report,reason:'cadence'};
    const top = query("SELECT MAX(id) AS id FROM records INDEXED BY records_name_scan WHERE source_id='lark.im' AND record_type='lark.im.message';",'read name scan horizon')[0]?.id || 0;
    let horizon = Number(scan?.horizon_record_id || top), after = Number(scan?.after_record_id || 0);
    if (after >= horizon) { after = 0; horizon = top; }
    // Bound both row count and materialized bytes. Oversized witnesses remain
    // content records; they are never silently submitted as partial identities.
    const readPage = (where, order) => query(`WITH page AS MATERIALIZED (
      SELECT id,(${nameRowBytesSql()}) AS bytes
      FROM records INDEXED BY records_name_scan WHERE source_id='lark.im' AND record_type='lark.im.message'
      ${where} ORDER BY id ${order} LIMIT ${PAGE}), bounded AS (
      SELECT id,bytes,SUM(CASE WHEN bytes<=2097152 THEN bytes ELSE 0 END) OVER(ORDER BY id ${order}) AS total FROM page)
      SELECT ${REVIEW_RECORD_COLUMNS.map(column => ['raw_json','canonical_json','body'].includes(column)
        ? `CASE WHEN b.bytes<=2097152 AND b.total<=8388608 THEN r.${column} ELSE NULL END AS ${column}` : `r.${column}`).join(',')}
      FROM bounded b JOIN records r ON r.id=b.id WHERE b.total<=8388608 ORDER BY r.id ${order};`,'read bounded name witnesses');
    const newest = readPage('','DESC'), historical = readPage(`AND id>${after} AND id<=${horizon}`,'ASC');
    const nextAfter = historical.length ? historical[historical.length-1].id : horizon;
    const witnesses = [...new Map([...newest,...historical].map(row => [row.id,row])).values()];
    const scopeIds = [...new Set(witnesses.filter(row=>typeof row.container_id==='string').map(row=>chatScopeId(row.container_id)))];
    const scopes = scopeIds.length ? query(`SELECT id,source_id,config_json FROM sync_scopes WHERE id IN (${scopeIds.map(quoteSql).join(',')});`,'read name scope constraints') : [];
    const enrollment = new Map();
    for (const row of witnesses) {
      if (!Number.isSafeInteger(row.id) || !row.raw_json || !row.canonical_json || !row.container_id) continue;
      let canonical,raw;
      try { canonical=JSON.parse(row.canonical_json); raw=JSON.parse(row.raw_json); } catch { continue; }
      if (!titleMessageMatches(row,canonical,raw) || row.direction==='sent' && sentRecipientAccount(row,canonical,raw)!==self.open_id
        || canonical.sender_name_account_key && canonical.sender_name_account_key!==accountKey
        || canonical.sender_name_verification?.account_key && canonical.sender_name_verification.account_key!==accountKey
        || canonical.chat_name_account_key && canonical.chat_name_account_key!==accountKey) continue;
      const scope = scopes.find(value=>value.id===chatScopeId(row.container_id));
      let config = {};
      if (scope) {
        try { validateJsonObjectText(scope.config_json); config=JSON.parse(scope.config_json); } catch { continue; }
        if (scope.source_id!=='lark.im' || config.chat_id!==row.container_id) continue;
      }
      const sender = senderNameTarget(row);
      const kinds = [];
      if (sender && senderNeedsAuthorityRepair(sender,accountKey)) kinds.push({kind:'sender',actor:row.actor_id,namespace:sender.namespace,urgent:true});
      const declarations=[canonical,raw,raw.chat,raw.raw_api,raw.raw_api?.chat,config];
      if (!chatNameCleared(canonical,raw) && !declarations.some(value=>value?.chat_type==='p2p'||value?.chat_mode==='p2p'||value?.chat_name_state==='cleared'))
        kinds.push({kind:'chat',actor:'',namespace:'',urgent:!chatTitle(canonical.chat_name,row.container_id)&&!chatTitle(raw.chat_name,row.container_id)&&!chatTitle(config.chat_name,row.container_id)});
      for (const item of kinds) {
        const key=nameTaskKey(item.kind,row.container_id,item.actor,item.namespace);
        if (!enrollment.has(key) || enrollment.get(key).row.id<row.id) enrollment.set(key,{...item,key,row});
      }
    }
    const scanPredicate = scan ? `EXISTS(SELECT 1 FROM lark_im_name_scan WHERE account_key=${quoteSql(accountKey)} AND generation=${scan.generation})`
      : `NOT EXISTS(SELECT 1 FROM lark_im_name_scan WHERE account_key=${quoteSql(accountKey)})`;
    const updates = [nameEffects(`${nameFence(scanPredicate)} INSERT INTO lark_im_name_scan(account_key,after_record_id,horizon_record_id,next_role,generation)
      VALUES(${quoteSql(accountKey)},${nextAfter},${horizon},${Number(scan?.next_role||0)},${Number(scan?.generation||0)+1})
      ON CONFLICT(account_key) DO UPDATE SET after_record_id=excluded.after_record_id,horizon_record_id=excluded.horizon_record_id,generation=excluded.generation`)];
    for (const {kind,actor,namespace,key,row,urgent} of enrollment.values()) updates.push(nameEffects(`${nameFence(nameRecordFence(row))}
      INSERT INTO lark_im_name_tasks(source_id,account_key,task_key,kind,chat_id,actor_id,namespace,latest_record_id,retry_at_ms,enqueued_at_ms,enqueued_sequence,last_served_sequence,fresh_required_record_id)
      VALUES('lark.im',${quoteSql(accountKey)},${quoteSql(key)},${quoteSql(kind)},${quoteSql(row.container_id)},${quoteSql(actor)},${quoteSql(namespace)},${row.id},${nowMs},${nowMs},${Number(scan?.schedule_sequence||0)},${Number(scan?.schedule_sequence||0)},${urgent?row.id:0})
      ON CONFLICT(source_id,account_key,task_key) DO UPDATE SET latest_record_id=MAX(latest_record_id,excluded.latest_record_id),
        fresh_required_record_id=MAX(fresh_required_record_id,excluded.fresh_required_record_id),
        outcome=CASE WHEN kind='chat' AND evidence_json IS NOT NULL AND latest_record_id<excluded.latest_record_id AND attempt_token IS NULL THEN 'applying' ELSE outcome END,
        retry_at_ms=CASE WHEN latest_record_id<excluded.latest_record_id AND attempt_token IS NULL AND blocked_reason IS NULL AND schedule_failures=0 AND failures=0 THEN MIN(retry_at_ms,${nowMs}) ELSE retry_at_ms END`));
    commit(updates,'name-work-scan');
    // Fetch independent priority and global-oldest lanes. A failed sender
    // population cannot hide chat work; no empty recipient role consumes a turn.
    const dueWhere=`source_id='lark.im' AND account_key=${quoteSql(accountKey)} AND blocked_reason IS NULL AND retry_at_ms<=${nowMs}`;
    const fairDue=query(`SELECT * FROM lark_im_name_tasks INDEXED BY lark_im_name_tasks_fair WHERE ${dueWhere}
      ORDER BY last_served_sequence,enqueued_sequence,task_key LIMIT 64;`,'read fair name work');
    const freshDue=query(`SELECT * FROM lark_im_name_tasks INDEXED BY lark_im_name_tasks_fresh WHERE ${dueWhere}
      AND latest_record_id>serviced_record_id ORDER BY fresh_required_record_id DESC,last_served_sequence,task_key LIMIT 32;`,'read fresh name work');
    const blockedDue=query(`SELECT * FROM lark_im_name_tasks INDEXED BY lark_im_name_tasks_blocked_due WHERE source_id='lark.im'
      AND account_key=${quoteSql(accountKey)} AND blocked_reason IS NOT NULL AND retry_at_ms<=${nowMs}
      ORDER BY last_served_sequence,enqueued_sequence,task_key LIMIT 16;`,'read quarantined recovery probes');
    const due=[...new Map([...freshDue,...fairDue,...blockedDue].map(task=>[task.task_key,task])).values()];
    // Local recipient discovery cannot depend on winning a remote role or on
    // the mixed-direction name page. Preserve its own bounded sent cursor and
    // enqueue exact unresolved relationships before choosing remote work.
    const recipientWork = prepareRecipientWork(db,self,{runLark:boundedRun,now,monotonicNow:monotonic,
      budgetMs:remaining(),readOnlyQuery:deps.readOnlyQuery});
    const recipientDue = 'pending' in recipientWork && recipientWork.pending;
    const recipientFreshOrder = 'freshOrder' in recipientWork ? recipientWork.freshOrder : 0;
    const recipientFresh = recipientFreshOrder > 0;
    const state=/** @type {import('./name-work-policy.mjs').SelectionState} */ ({schema:'name_work_selection/v1',sequence:Number(scan?.schedule_sequence||0),slot:Number(scan?.schedule_slot||0)});
    const candidates=/** @type {import('./name-work-policy.mjs').WorkCandidate[]} */ (due.map(task=>({key:task.task_key,
      tier:task.blocked_reason?'history':task.fresh_required_record_id>task.serviced_record_id?'fresh':['pending','applying','page_limit'].includes(task.outcome)?'continuation':'history',
      operation:task.kind==='chat'?'other':task.namespace==='app_id'?'application_info':'contact_search',
      enqueuedSequence:task.enqueued_sequence,lastServedSequence:task.last_served_sequence,dueAtMs:task.retry_at_ms,
      claimedUntilMs:task.attempt_token?task.retry_at_ms:0,blocked:false,freshOrder:task.fresh_required_record_id})));
    if(recipientDue)candidates.push({key:'recipient',tier:recipientFresh?'fresh':'history',operation:'other',
      enqueuedSequence:0,lastServedSequence:Number(scan?.recipient_last_served_sequence||0),dueAtMs:0,claimedUntilMs:0,blocked:false,freshOrder:recipientFreshOrder});
    const choice=selectNameWork(candidates,state,{nowMs,resource:'remote'});
    if(!choice)return report;
    // Reserve the shared opportunity only when there is selected work. An idle
    // discovery must not block a later fresh message, while a real claim and
    // its cadence remain one CAS so separate commands cannot add budgets.
    const rotate=`${nameFence(`EXISTS(SELECT 1 FROM lark_im_name_scan WHERE account_key=${quoteSql(accountKey)}
      AND generation=${Number(scan?.generation||0)+1} AND schedule_sequence=${state.sequence} AND schedule_slot=${state.slot}
      AND next_attempt_at_ms<=${nowMs})`)}
      UPDATE lark_im_name_scan SET schedule_sequence=${choice.nextState.sequence},schedule_slot=${choice.nextState.slot},
      recipient_last_served_sequence=${choice.candidate.key==='recipient'?choice.nextState.sequence:Number(scan?.recipient_last_served_sequence||0)},
      next_attempt_at_ms=${nowMs+INTERVAL_MS},generation=generation+1
      WHERE account_key=${quoteSql(accountKey)} AND generation=${Number(scan?.generation||0)+1} AND next_attempt_at_ms<=${nowMs};`;
    if(choice.candidate.key==='recipient') {
      commit([nameEffects(rotate)],'name-work-recipient-turn');
      const recipient=deps.syncRecipients ? deps.syncRecipients(db,self,{runLark:boundedRun,now,monotonicNow:monotonic,budgetMs:remaining()})
        : 'run' in recipientWork ? recipientWork.run() : recipientWork;
      return {...report,attempted:recipient.attempted||0,updated:recipient.updated||0,calls,reason:recipient.reason};
    }
    const task=due.find(value=>value.task_key===choice.candidate.key);
    if(!task)return report;
    const selectedPredicate=`${nameStateKey(accountKey,task.task_key)} AND generation=${task.generation} AND ${progressFence(task)}
      AND evidence_json IS ${quoteSql(task.evidence_json)} AND attempt_token IS ${quoteSql(task.attempt_token)}
      AND last_served_sequence=${task.last_served_sequence} AND schedule_failures=${task.schedule_failures} AND blocked_reason IS ${quoteSql(task.blocked_reason)}`;
    const deferInvalid=reason=>{
      commit([nameEffects(`${rotate} ${nameFence(`EXISTS(SELECT 1 FROM lark_im_name_tasks WHERE ${selectedPredicate})`)} UPDATE lark_im_name_tasks SET outcome='conflict',retry_at_ms=${nowMs+NAME_RETRY_MS},attempt_token=NULL,generation=generation+1,
        last_served_sequence=${choice.nextState.sequence} WHERE ${selectedPredicate}`)],'name-work-conflict');
      return {...report,reason};
    };
    if(task.source_id!=='lark.im'||task.account_key!==accountKey
      ||task.task_key!==nameTaskKey(task.kind,task.chat_id,task.actor_id,task.namespace)) return deferInvalid('invalid_task');
    const witnessPredicate=`source_id='lark.im' AND record_type='lark.im.message' AND container_id=${quoteSql(task.chat_id)}
      ${task.kind==='sender'?`AND actor_id=${quoteSql(task.actor_id)}`:''}`;
    const witnessBytes=task.kind==='sender'?1048576:2097152;
    // The persisted target takes priority over unrelated newer oversized rows.
    // If it changed or vanished, a separate fixed-horizon cursor searches a
    // bounded historical page; an empty page is not proof of invalid identity.
    const exact=query(`SELECT ${REVIEW_RECORD_COLUMNS.join(',')} FROM records WHERE id=${task.latest_record_id}
      AND ${witnessPredicate} AND (${nameRowBytesSql()})<=${witnessBytes};`,'read exact name witness')[0];
    let witness=validNameWitness(exact,task,self,accountKey)?exact:null;
    if(!witness) {
      let after=Number(task.witness_after_record_id||0),horizon=Number(task.witness_horizon_record_id||task.latest_record_id);
      if(after>=horizon){after=0;horizon=task.latest_record_id;}
      const page=readNameRecordPage(query,{after,horizon,predicate:witnessPredicate,
        index:task.kind==='sender'?'records_name_sender':'records_name_chat',recordBytes:witnessBytes,label:'fallback name witnesses'});
      witness=page.rows.find(row=>validNameWitness(row,task,self,accountKey));
      if(!witness) {
        const failures=page.more?Number(task.failures||0):Math.min(16,Number(task.failures||0)+1);
        const delay=page.more?0:Math.min(NAME_REFRESH_MS,NAME_RETRY_MS*2**Math.max(0,failures-1));
        commit([nameEffects(`${rotate} ${nameFence(`EXISTS(SELECT 1 FROM lark_im_name_tasks WHERE ${selectedPredicate})`)} UPDATE lark_im_name_tasks SET outcome='witness_unavailable',retry_at_ms=${nowMs+delay},
          witness_after_record_id=${page.after},witness_horizon_record_id=${page.horizon},failures=${failures},
          attempt_token=NULL,generation=generation+1,last_served_sequence=${choice.nextState.sequence}
          WHERE ${selectedPredicate}`)],'name-work-missing');
        return {...report,reason:'witness_unavailable'};
      }
    }
    const exactScope=query(`SELECT id,source_id,enabled,config_json,updated_at FROM sync_scopes WHERE id=${quoteSql(chatScopeId(task.chat_id))};`,'read exact name scope')[0];
    if(exactScope) {
      let config;
      try {validateJsonObjectText(exactScope.config_json);config=JSON.parse(exactScope.config_json);} catch {return deferInvalid('scope_conflict');}
      if(exactScope.source_id!=='lark.im'||config.chat_id!==task.chat_id
        || task.kind==='chat' && ([config.chat_type,config.chat_mode].includes('p2p')||config.chat_name_state==='cleared')) {
        return deferInvalid('scope_conflict');
      }
      admission.bindScopes([exactScope.id]);
      const captured=admission.fence.scopes[0];
      if(!captured||['id','source_id','enabled','config_json'].some(key=>captured[key]!==exactScope[key])) return deferInvalid('scope_conflict');
    }
    const scopeAbsent=exactScope?`EXISTS(SELECT 1 FROM sync_scopes WHERE ${['id','source_id','enabled','config_json','updated_at'].map(key=>`${key} IS ${quoteSql(exactScope[key])}`).join(' AND ')})`
      :`NOT EXISTS(SELECT 1 FROM sync_scopes WHERE id=${quoteSql(chatScopeId(task.chat_id))})`;
    const token=randomUUID(), key=nameStateKey(accountKey,task.task_key);
    const taskPredicate=`${key} AND generation=${task.generation} AND ${progressFence(task)}
      AND evidence_json IS ${quoteSql(task.evidence_json)} AND attempt_token IS ${quoteSql(task.attempt_token)}
      AND last_served_sequence=${task.last_served_sequence} AND schedule_failures=${task.schedule_failures} AND blocked_reason IS ${quoteSql(task.blocked_reason)}`;
    commit([nameEffects(`${rotate} ${nameFence(`${nameRecordFence(witness)} AND ${scopeAbsent} AND EXISTS(SELECT 1 FROM lark_im_name_tasks WHERE ${taskPredicate})`)}
      UPDATE lark_im_name_tasks SET attempt_token=${quoteSql(token)},generation=generation+1,
      retry_at_ms=${nowMs+NAME_RETRY_MS},last_attempt_at_ms=${nowMs},last_served_sequence=${choice.nextState.sequence} WHERE ${taskPredicate}`)],'name-work-claim');
    activeTask=task; recoveryProbe=task.blocked_reason!==null&&task.retry_at_ms<=nowMs;
    let result;
    try {
      result=(task.kind==='sender' ? deps.prepareSenderWork||prepareSenderWork : deps.prepareChatWork||prepareChatWork)(task,
        {db,self,accountKey,nowMs,query,witness,runLark:(args,options)=>boundedRun(args,options,1)});
    } catch (error) {
      result={outcome:error instanceof NameBudgetError?'deferred':'failed',updates:[]};
    }
    // The command's self observation precedes the work. Every actual network
    // result additionally requires a fresh matching profile before adoption.
    if(calls) {
      const afterSelf=createLarkImAdapter({run:(args,options)=>{
        const value=boundedRun(args,options);
        if(!value||value.error!=null||value.ok===false||value.code!==undefined&&value.code!==0) throw new Error('name profile unavailable');
        return value;
      }}).getSelfProfile({retries:0});
      if(afterSelf.open_id!==self.open_id) return {...report,calls,reason:'account_conflict'};
    }
    const outcome=['resolved','applying','pending','unresolved','failed','deferred','conflict','page_limit','invalid_target','capacity_deferred'].includes(result.outcome)?result.outcome:'unresolved';
    const complete=outcome==='resolved', progress=['applying','page_limit','pending'].includes(outcome);
    const failures=complete?0:Math.min(16,Number(task.failures||0)+(progress||outcome==='deferred'||routeDeferred?0:1));
    const scheduleFailures=complete||progress?0:Math.min(3,task.schedule_failures+(outcome==='deferred'||routeDeferred?0:1));
    const witnessTarget=task.kind==='sender'?senderNameTarget(witness):null;
    const native=witnessTarget?.raw?.raw_api||witnessTarget?.raw;
    const privateHuman=task.namespace==='open_id'&&[witnessTarget?.canonical?.chat_type,witnessTarget?.raw?.chat_type,
      native?.chat_type,native?.chat?.chat_type].includes('p2p');
    const operations=task.kind==='chat'?['other']:task.namespace==='app_id'?['application_info','chat_bots']
      :privateHuman?['contact_search']:['contact_search','chat_members'];
    const routes=operations.map(operation=>routeFor(operation)).filter(Boolean);
    const terminal=routes.length>0&&routes.every(entry=>entry?.row&&(entry.row.blocked||entry.row.failures>=3));
    const reasons=new Set(routes.map(entry=>entry?.row?.failure_kind));
    const blockedReason=complete||progress?null:terminal?(reasons.size===1&&['permission_denied','command_unavailable'].includes([...reasons][0])?[...reasons][0]:'routes_blocked')
      :scheduleFailures>=3?'retry_exhausted':null;
    const requestedDelay=Number.isSafeInteger(result.retryDelayMs)&&result.retryDelayMs>=0?result.retryDelayMs:0;
    const delay=Math.min(NAME_REFRESH_MS,complete||progress?requestedDelay
      :Math.max(requestedDelay,NAME_RETRY_MS*2**Math.max(0,failures-1)));
    const terminalDue=routes.filter(entry=>entry?.row&&(entry.row.blocked||entry.row.failures>=3)).map(entry=>entry?.row.retry_at_ms).filter(value=>value>nowMs);
    const nextRetry=blockedReason?(terminal&&terminalDue.length?Math.min(...terminalDue):nowMs+NAME_RETRY_MS):nowMs+delay;
    const guard=`EXISTS(SELECT 1 FROM lark_im_name_tasks WHERE ${key} AND generation=${task.generation+1} AND attempt_token=${quoteSql(token)}
      AND evidence_json IS ${quoteSql(task.evidence_json)} AND ${progressFence(task)} AND last_served_sequence=${choice.nextState.sequence}
      AND schedule_failures=${task.schedule_failures} AND blocked_reason IS ${quoteSql(task.blocked_reason)})`;
    const finalUpdates=[nameEffects(`${nameFence(`${guard} AND ${nameRecordFence(witness)} AND ${scopeAbsent}`)} UPDATE lark_im_name_tasks SET outcome=${quoteSql(outcome)},
      evidence_json=${quoteSql(result.evidenceJson===undefined?task.evidence_json:result.evidenceJson)},after_record_id=${Number(result.afterRecordId??task.after_record_id)},
      projection_horizon_record_id=${Number(result.horizonRecordId??task.projection_horizon_record_id??0)},
      projection_deferred=${Number(result.projectionDeferred??task.projection_deferred??0)},
      retry_at_ms=${nextRetry},failures=${failures},schedule_failures=${scheduleFailures},blocked_reason=${quoteSql(blockedReason)},
      serviced_record_id=MAX(serviced_record_id,${task.latest_record_id}),attempt_token=NULL WHERE ${key} AND generation=${task.generation+1} AND attempt_token=${quoteSql(token)}`),
      ...(result.updates||[]).map(sql=>`${sql}; ${nameFence('changes()=1')} INSERT INTO __enrichment_effects(updated) VALUES(1);`)];
    // Terminal eligibility also depends on routes that were read but skipped.
    // Fence those observations so concurrent recovery cannot publish stale debt.
    for(const [routeKey,previous] of routeReads) {
      if(routeWrites.has(routeKey))continue;
      const route={account_key:accountKey,route_key:routeKey};
      const predecessor=previous?`EXISTS(SELECT 1 FROM lark_im_name_routes WHERE ${routeKeySql(route)} AND ${Object.keys(previous).map(column=>`${column} IS ${quoteSql(previous[column])}`).join(' AND ')})`
        :`NOT EXISTS(SELECT 1 FROM lark_im_name_routes WHERE ${routeKeySql(route)})`;
      finalUpdates.push(nameFence(predecessor));
    }
    for(const row of routeWrites.values()) {
      const previous=routeReads.get(row.route_key), columns=Object.keys(row);
      const predecessor=previous?`EXISTS(SELECT 1 FROM lark_im_name_routes WHERE ${routeKeySql(row)} AND ${Object.keys(previous).map(column=>`${column} IS ${quoteSql(previous[column])}`).join(' AND ')})`
        :`NOT EXISTS(SELECT 1 FROM lark_im_name_routes WHERE ${routeKeySql(row)})`;
      finalUpdates.push(nameEffects(`${nameFence(predecessor)} INSERT INTO lark_im_name_routes(${columns.join(',')})
        VALUES(${columns.map(column=>quoteSql(row[column])).join(',')}) ON CONFLICT(source_id,account_key,route_key) DO UPDATE SET
        ${columns.filter(column=>!['source_id','account_key','route_key'].includes(column)).map(column=>`${column}=excluded.${column}`).join(',')}`));
    }
    const committed=commit(finalUpdates,'name-work-result');
    return {...report,attempted:1,updated:Math.max(0,committed.updated-1-routeWrites.size),calls,reason:outcome};
  } catch(error) {
    return {...report,calls,reason:error instanceof NameBudgetError?'budget':'unavailable'};
  }
}
export { syncNames };
