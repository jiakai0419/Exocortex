import { randomUUID } from 'node:crypto';
import { quoteSql, REVIEW_RECORD_COLUMNS } from '../../../dist/storage/sqlite/ingestion-store.js';
import { validateJsonObjectText } from '../../../dist/core/json-text-patch.js';
import { captureLarkWriteAdmission } from '../../diagnostics/lark-write-admission.mjs';
import { commitEnrichmentUpdates } from '../../maintenance/enrichment-commit.mjs';
import { readOnlySqliteJson } from '../../storage/sqlite/readonly-query.mjs';
import { getLarkApiLeaseStdio } from '../../runtime/lark-api-lease.mjs';
import { createLarkImAdapter } from './adapter.mjs';
import { chatScopeId } from './core.mjs';
import { chatNameCleared, titleMessageMatches } from './chat-title.mjs';
import { nameTaskKey, senderNameTarget } from './name-evidence.mjs';
import { recipientAccountKey, sentRecipientAccount } from './p2p-recipient.mjs';
import { syncRecipients } from './recipient-sync.mjs';
import { prepareSenderWork } from './sender-name-work.mjs';
import { prepareChatWork } from './chat-name-work.mjs';
import { readNameRecordPage } from './name-projection-progress.mjs';
import { nameRecordFence, nameEffects, nameFence, nameStateKey, nameRowBytesSql, NAME_RETRY_MS, NAME_REFRESH_MS } from './name-work-common.mjs';
import { runLark } from './transport.mjs';

const PAGE = 40, MAX_CALLS = 4, BUDGET_MS = 10_000, INTERVAL_MS = 60_000;
class NameBudgetError extends Error {}

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
 * the persisted role rotates sender, chat, recipient across process restarts.
 * @param {string} db @param {Record<string,any>} self @param {Record<string,any>} [deps] */
function syncNames(db, self, deps = {}) {
  const report = { attempted: 0, updated: 0, calls: 0, reason: 'idle' };
  if (!deps.runLark && !getLarkApiLeaseStdio()) return { ...report, reason: 'lease_unavailable' };
  const now = deps.now || Date.now, monotonic = deps.monotonicNow || (() => performance.now());
  const started = monotonic(), nowMs = now(), accountKey = recipientAccountKey(self?.open_id);
  if (!accountKey || !Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isFinite(started)) return report;
  let lastClock = started, calls = 0;
  const remaining = () => {
    const value = monotonic();
    if (!Number.isFinite(value) || value < lastClock) throw new NameBudgetError('name clock unavailable');
    lastClock = value;
    const left = Math.floor(BUDGET_MS - (value - started));
    if (left <= 0) throw new NameBudgetError('name budget exhausted');
    return left;
  };
  const query = (sql, label) => (deps.readOnlyQuery || readOnlySqliteJson)(db,sql,label,{timeoutMs: remaining()});
  const boundedRun = (args, options = {}, reserve = 0) => {
    const left = remaining();
    if (calls >= MAX_CALLS - reserve) throw new NameBudgetError('name request limit reached');
    calls += 1;
    return (deps.runLark || runLark)(args,{...options,retries:0,timeoutMs:Math.min(5000,left),retryBudgetMs:left,maxBufferBytes:2*1024*1024});
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
    // A worker cycle contains several separate sync processes. Persist the
    // admission before scanning so their optional budgets cannot accumulate.
    commit([nameEffects(`${nameFence(scan?`EXISTS(SELECT 1 FROM lark_im_name_scan WHERE account_key=${quoteSql(accountKey)} AND generation=${scan.generation}
      AND next_attempt_at_ms<=${nowMs})`:`NOT EXISTS(SELECT 1 FROM lark_im_name_scan WHERE account_key=${quoteSql(accountKey)})`)}
      INSERT INTO lark_im_name_scan(account_key,next_attempt_at_ms,generation) VALUES(${quoteSql(accountKey)},${nowMs+INTERVAL_MS},1)
      ON CONFLICT(account_key) DO UPDATE SET next_attempt_at_ms=excluded.next_attempt_at_ms,generation=generation+1`)],'name-work-cadence');
    scan=query(`SELECT * FROM lark_im_name_scan WHERE account_key=${quoteSql(accountKey)};`,'read admitted name scan')[0];
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
      if (sender?.unknown || sender?.needsVerification) kinds.push({kind:'sender',actor:row.actor_id,namespace:sender.namespace});
      const declarations=[canonical,raw,raw.chat,raw.raw_api,raw.raw_api?.chat,config];
      if (!chatNameCleared(canonical,raw) && !declarations.some(value=>value?.chat_type==='p2p'||value?.chat_mode==='p2p'||value?.chat_name_state==='cleared'))
        kinds.push({kind:'chat',actor:'',namespace:''});
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
    for (const {kind,actor,namespace,key,row} of enrollment.values()) updates.push(nameEffects(`${nameFence(nameRecordFence(row))}
      INSERT INTO lark_im_name_tasks(source_id,account_key,task_key,kind,chat_id,actor_id,namespace,latest_record_id,retry_at_ms)
      VALUES('lark.im',${quoteSql(accountKey)},${quoteSql(key)},${quoteSql(kind)},${quoteSql(row.container_id)},${quoteSql(actor)},${quoteSql(namespace)},${row.id},${nowMs})
      ON CONFLICT(source_id,account_key,task_key) DO UPDATE SET latest_record_id=MAX(latest_record_id,excluded.latest_record_id),
        outcome=CASE WHEN kind='chat' AND evidence_json IS NOT NULL AND latest_record_id<excluded.latest_record_id AND attempt_token IS NULL THEN 'applying' ELSE outcome END,
        retry_at_ms=CASE WHEN latest_record_id<excluded.latest_record_id AND attempt_token IS NULL THEN MIN(retry_at_ms,${nowMs}) ELSE retry_at_ms END`));
    commit(updates,'name-work-scan');
    const due = ['sender','chat'].flatMap(kind=>query(`SELECT * FROM lark_im_name_tasks INDEXED BY lark_im_name_tasks_due WHERE source_id='lark.im'
      AND account_key=${quoteSql(accountKey)} AND kind=${quoteSql(kind)} AND retry_at_ms<=${nowMs}
      ORDER BY retry_at_ms,last_attempt_at_ms,task_key LIMIT 1;`,'read due name tasks'));
    let role=Number(scan?.next_role||0), task;
    for(let offset=0;offset<3;offset+=1) {
      role=(Number(scan?.next_role||0)+offset)%3;
      task=due.find(value=>value.kind===(role===0?'sender':'chat'));
      if(role===2||task) break;
    }
    commit([nameEffects(`UPDATE lark_im_name_scan SET next_role=${(role+1)%3},generation=generation+1
      WHERE account_key=${quoteSql(accountKey)} AND generation=${Number(scan?.generation||0)+1}`)],'name-work-rotate');
    if(role===2) {
      const recipient=(deps.syncRecipients||syncRecipients)(db,self,{runLark:boundedRun,now,monotonicNow:monotonic,budgetMs:remaining()});
      return {...report,attempted:recipient.attempted||0,updated:recipient.updated||0,calls,reason:recipient.reason};
    }
    if(!task) return report;
    const deferInvalid=reason=>{
      commit([nameEffects(`UPDATE lark_im_name_tasks SET outcome='conflict',retry_at_ms=${nowMs+NAME_RETRY_MS},attempt_token=NULL,generation=generation+1
        WHERE ${nameStateKey(accountKey,task.task_key)} AND generation=${task.generation}`)],'name-work-conflict');
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
        commit([nameEffects(`UPDATE lark_im_name_tasks SET outcome='witness_unavailable',retry_at_ms=${nowMs+delay},
          witness_after_record_id=${page.after},witness_horizon_record_id=${page.horizon},failures=${failures},
          attempt_token=NULL,generation=generation+1
          WHERE ${nameStateKey(accountKey,task.task_key)} AND generation=${task.generation} AND ${progressFence(task)}
            AND evidence_json IS ${quoteSql(task.evidence_json)} AND attempt_token IS ${quoteSql(task.attempt_token)}`)],'name-work-missing');
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
      AND evidence_json IS ${quoteSql(task.evidence_json)} AND attempt_token IS ${quoteSql(task.attempt_token)}`;
    commit([nameEffects(`${nameFence(`${nameRecordFence(witness)} AND ${scopeAbsent} AND EXISTS(SELECT 1 FROM lark_im_name_tasks WHERE ${taskPredicate})`)}
      UPDATE lark_im_name_tasks SET attempt_token=${quoteSql(token)},generation=generation+1,
      retry_at_ms=${nowMs+NAME_RETRY_MS},last_attempt_at_ms=${nowMs} WHERE ${taskPredicate}`)],'name-work-claim');
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
    const failures=complete?0:Math.min(16,Number(task.failures||0)+(progress||outcome==='deferred'?0:1));
    const requestedDelay=Number.isSafeInteger(result.retryDelayMs)&&result.retryDelayMs>=0?result.retryDelayMs:0;
    const delay=Math.min(NAME_REFRESH_MS,complete||progress?requestedDelay
      :Math.max(requestedDelay,NAME_RETRY_MS*2**Math.max(0,failures-1)));
    const guard=`EXISTS(SELECT 1 FROM lark_im_name_tasks WHERE ${key} AND generation=${task.generation+1} AND attempt_token=${quoteSql(token)}
      AND evidence_json IS ${quoteSql(task.evidence_json)} AND ${progressFence(task)})`;
    const finalUpdates=[nameEffects(`${nameFence(`${guard} AND ${nameRecordFence(witness)} AND ${scopeAbsent}`)} UPDATE lark_im_name_tasks SET outcome=${quoteSql(outcome)},
      evidence_json=${quoteSql(result.evidenceJson===undefined?task.evidence_json:result.evidenceJson)},after_record_id=${Number(result.afterRecordId??task.after_record_id)},
      projection_horizon_record_id=${Number(result.horizonRecordId??task.projection_horizon_record_id??0)},
      projection_deferred=${Number(result.projectionDeferred??task.projection_deferred??0)},
      retry_at_ms=${nowMs+delay},failures=${failures},attempt_token=NULL WHERE ${key} AND generation=${task.generation+1} AND attempt_token=${quoteSql(token)}`),
      ...(result.updates||[]).map(sql=>`${sql}; ${nameFence('changes()=1')} INSERT INTO __enrichment_effects(updated) VALUES(1);`)];
    const committed=commit(finalUpdates,'name-work-result');
    return {...report,attempted:1,updated:Math.max(0,committed.updated-1),calls,reason:outcome};
  } catch(error) {
    return {...report,calls,reason:error instanceof NameBudgetError?'budget':'unavailable'};
  }
}
export { syncNames };
