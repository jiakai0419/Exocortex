// @ts-check
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { quoteSql as q, sqliteQuery } from '../../dist/storage/sqlite/ingestion-store.js';
import { DEFAULT_SYNC_LOCK_OWNER, defaultOwnerState } from '../../dist/storage/sqlite/sync-locks.js';
import { createLarkImAdapter } from '../adapters/lark-im/adapter.mjs';
import { recipientAccountKey } from '../adapters/lark-im/p2p-recipient.mjs';
import { larkWriteAdmissionSql } from '../../dist/storage/sqlite/lark-write-admission.js';
import { readOnlySqliteJson } from '../storage/sqlite/readonly-query.mjs';
import { captureLarkWriteAdmission } from '../diagnostics/lark-write-admission.mjs';
import { projectionAccount } from '../adapters/lark-im/message-projection-evidence.mjs';
import { extractMessageResourceReferences, imageResourceCapability, mediaFromImageSlot } from '../adapters/lark-im/media-resource-references.mjs';
import { makeMediaResourceBindings, makeMediaPendingSourceFence, MEDIA_RESOURCE_SOURCE_FIELDS } from '../adapters/lark-im/media-resource-store.mjs';
import { readLarkExecutionReceipt } from '../adapters/lark-im/transport-execution.mjs';
import { transportOperation } from '../adapters/lark-im/transport.mjs';
import { tryAcquireLarkApiLease } from '../runtime/lark-api-lease.mjs';
import { createMaintenanceRequestSession } from './request-session.mjs';
import { enrichResources, normalizeResourceFailure, resourceFailureFromError } from './enrich-resources.mjs';
import { RESOURCE_CANDIDATE_INDEX, RESOURCE_CANDIDATE_WHERE } from './resource-candidates.mjs';

/** @typedef {Record<string,any>} Row */
const PROFILE='known_record_resources/v1', TABLE='lark_im_resource_work', SCAN='lark_im_resource_scan';
const PAGE=20, MAX_ROW_BYTES=128*1024, MAX_PAGE_BYTES=8*1024*1024, SCAN_INTERVAL=60000, CLAIM_MS=120000;
const STOP=new Set(['cli_budget','self_budget','time_budget','clock_unavailable','sync_busy','lease_unavailable','rate_cooldown','rate_limited','shared_cooldown_unavailable']);
const DENIAL=new Map([[210508,'permission_denied'],[231203,'restricted_mode'],[230002,'bot_user_out_of_chat']]);
const PERMANENT="('permission_denied','restricted_mode','bot_user_out_of_chat')";
const CAPABILITY=new Set(['resource_endpoint_unverified','resource_identity_conflict']);
const sha=value=>createHash('sha256').update(value).digest('hex');
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const sourceWhere=RESOURCE_CANDIDATE_WHERE;
const sourceFrom=`records INDEXED BY ${RESOURCE_CANDIDATE_INDEX}`;
const sourceBytes=MEDIA_RESOURCE_SOURCE_FIELDS.map(k=>`COALESCE(length(CAST(${k} AS BLOB)),0)`).join('+');
const pageColumns=`id,(${sourceBytes}) AS source_bytes`;
const keyWhere=t=>`source_id='lark.im' AND account_key=${q(t.account_key)} AND work_key=${q(t.work_key)}`;
const sourceSql=row=>`EXISTS(SELECT 1 FROM records r WHERE ${MEDIA_RESOURCE_SOURCE_FIELDS.map(k=>`r.${k} IS ${q(row[k])}`).join(' AND ')})`;
// A missing bounded payload is an observation, not authority to terminate work.
// Fence that exact absence/size fact too, so restoration cannot be blocked.
const observedSourceSql=(row,id)=>row?sourceSql(row):`NOT EXISTS(SELECT 1 FROM records WHERE id=${id} AND (${sourceBytes})<=${MAX_ROW_BYTES})`;
const stop=reason=>{throw Object.assign(new Error('resource work stopped'),{resourceStop:reason});};

/** Each bounded source fence occurs once, not once per expanded image slot.
 * The temporary relation preserves the old per-source skip-on-drift behavior.
 * @param {Row[]} targets @param {string} account @param {number} wall */
function resourceEnrollmentSql(targets,account,wall) {
  const rows=[...new Map(targets.map(t=>[t.record_id,t.row])).values()];
  const bindingChanged=`${TABLE}.binding_key<>excluded.binding_key`;
  const reopened=`${TABLE}.state='blocked' AND ${TABLE}.reason='source_changed'`;
  const exhausted=`${TABLE}.attempts>=8 OR ${TABLE}.failures>=3`;
  const denied=`${TABLE}.state='blocked' AND ${TABLE}.reason IN ${PERMANENT}`;
  const capabilityBlocked=`${TABLE}.state='blocked' AND ${TABLE}.reason IS NULL AND ${TABLE}.attempts=0 AND ${TABLE}.failures=0
    AND ${TABLE}.capability_evidence_json IS NOT NULL`;
  const capabilityReopened=`(${capabilityBlocked} AND excluded.state='pending')`;
  const capabilityStopped=`(${TABLE}.state IN ('pending','deferred') AND ${TABLE}.attempts=0 AND excluded.state='blocked')`;
  const changed=`(${bindingChanged} OR ${reopened} OR ${capabilityReopened} OR ${capabilityStopped})`;
  return `CREATE TEMP TABLE __resource_scan_source(record_id INTEGER PRIMARY KEY);
    ${rows.map(row=>`INSERT INTO __resource_scan_source SELECT ${row.id} WHERE ${sourceSql(row)};`).join('\n')}
    ${targets.map(t=>{const blocked=!t.request_eligible;return `INSERT INTO ${TABLE}(source_id,account_key,work_key,record_id,binding_key,source_fence,enqueued_at_ms,
        state,reason,capability_evidence_json)
      SELECT 'lark.im',${q(account)},${q(t.work_key)},${t.record_id},${q(t.binding_key)},${q(t.source_fence)},${wall},
        ${q(blocked?'blocked':'pending')},NULL,${q(blocked?JSON.stringify({version:1,reason:t.capability_reason,binding_key:t.binding_key,source_fence:t.source_fence}):null)}
      WHERE EXISTS(SELECT 1 FROM __resource_scan_source WHERE record_id=${t.record_id})
      ON CONFLICT(source_id,account_key,work_key) DO UPDATE SET record_id=excluded.record_id,binding_key=excluded.binding_key,source_fence=excluded.source_fence,
        state=CASE WHEN ${denied} THEN 'blocked' WHEN ${bindingChanged} THEN excluded.state WHEN ${reopened} THEN CASE WHEN ${exhausted} THEN 'exhausted' ELSE excluded.state END
          WHEN ${capabilityReopened} THEN 'pending' WHEN ${capabilityStopped} THEN 'blocked' ELSE ${TABLE}.state END,
        reason=CASE WHEN ${denied} THEN ${TABLE}.reason WHEN ${bindingChanged} THEN excluded.reason WHEN ${reopened} THEN CASE WHEN ${exhausted} THEN 'retry_exhausted' ELSE excluded.reason END
          WHEN ${capabilityReopened} THEN NULL WHEN ${capabilityStopped} THEN excluded.reason ELSE ${TABLE}.reason END,
        attempts=CASE WHEN ${bindingChanged} AND NOT(${denied}) THEN 0 ELSE ${TABLE}.attempts END,
        failures=CASE WHEN ${bindingChanged} AND NOT(${denied}) THEN 0 ELSE ${TABLE}.failures END,
        deferrals=CASE WHEN ${bindingChanged} AND NOT(${denied}) THEN 0 ELSE ${TABLE}.deferrals END,
        retry_at_ms=CASE WHEN ${changed} AND NOT(${denied}) THEN 0 ELSE ${TABLE}.retry_at_ms END,
        capability_evidence_json=CASE WHEN ${denied} THEN ${TABLE}.capability_evidence_json
          WHEN ${bindingChanged} THEN excluded.capability_evidence_json WHEN ${exhausted} THEN ${TABLE}.capability_evidence_json
          WHEN excluded.state='blocked' THEN excluded.capability_evidence_json WHEN ${capabilityReopened} THEN NULL ELSE ${TABLE}.capability_evidence_json END,
        generation=${TABLE}.generation+1
      WHERE ${TABLE}.state<>'running' AND (${TABLE}.source_fence<>excluded.source_fence OR ${changed});`;}).join('\n')}`;
}

/** Exact stable endpoint identity excludes source version and derived names.
 * @param {string} db @param {Row} row @returns {Row|null} */
export function resourceWorkIdentity(db,row) {
  const values=resourceWorkIdentities(db,row);return values.length===1?values[0]:null;
}

/** Plural exact endpoint identities; occurrences are not extra downloads.
 * `resourceCapability` is internal synthetic-test dependency injection only.
 * @param {string} db @param {Row} row @param {Row} [deps] @returns {Row[]} */
export function resourceWorkIdentities(db,row,deps={}) {
  try {
    if(!integer(row.id)||row.id<1||Buffer.byteLength(row.raw_json||'')>MAX_ROW_BYTES||Buffer.byteLength(row.canonical_json||'')>MAX_ROW_BYTES)return [];
    const raw=JSON.parse(row.raw_json),canonical=JSON.parse(row.canonical_json||'{}');
    const extracted=extractMessageResourceReferences(row,canonical,raw),account=projectionAccount(row,canonical,raw);
    if(account.state!=='verified')return [];
    const medias=extracted.slots.map(mediaFromImageSlot),bindings=makeMediaResourceBindings(db,row,account.account_key,medias),fence=makeMediaPendingSourceFence(row);
    if(!fence)return [];
    const targets=new Map();
    for(const [index,slot] of extracted.slots.entries()) {
      const binding=bindings[index];if(!binding)continue;
      const work_key=sha(JSON.stringify(['resource_download/v1','lark.im',account.account_key,row.external_id,'image',slot.key,'user']));
      const target={source_id:'lark.im',account_key:account.account_key,record_id:row.id,work_key,
        binding_key:sha(JSON.stringify(binding)),source_fence:fence,resource_key:slot.key,reference_kind:slot.reference_kind,
        request_eligible:imageResourceCapability(slot,deps.resourceCapability)==='message_image',capability_reason:'resource_endpoint_unverified',row};
      const previous=targets.get(work_key);
      if(previous&&previous.binding_key!==target.binding_key) {
        previous.request_eligible=false;previous.capability_reason='resource_identity_conflict';
      } else if(!previous)targets.set(work_key,target);
    }
    return [...targets.values()];
  } catch {return [];}
}

/** Retained finite attempt diagnosis, never authority to request, retry or deny.
 * The caller supplies a freshly admitted current identity; a queue snapshot alone
 * is not a fresh source observation. Old 022 rows have unknown associations.
 * @param {Row} task @param {Row|null} [currentIdentity] */
export function resourceWorkFailureEvidence(task,currentIdentity=null) {
  if(task.failure_stage==null&&task.failure_reason==null)return null;
  const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const binding=hash(task.failure_binding_key)?task.failure_binding_key:null;
  const fence=hash(task.failure_source_fence)?task.failure_source_fence:null;
  let applicability='unknown';
  if(binding&&fence&&currentIdentity&&hash(currentIdentity.binding_key)&&hash(currentIdentity.source_fence)&&
    task.source_id==='lark.im'&&hash(task.account_key)&&hash(task.work_key)&&
    currentIdentity.source_id==='lark.im'&&hash(currentIdentity.account_key)&&hash(currentIdentity.work_key)) {
    applicability=task.account_key!==currentIdentity.account_key||task.work_key!==currentIdentity.work_key||binding!==currentIdentity.binding_key
      ?'different_binding':fence===currentIdentity.source_fence?'exact_source':'same_binding';
  }
  return {...normalizeResourceFailure({stage:task.failure_stage,reason:task.failure_reason}),
    association:{binding_key:binding,source_fence:fence},applicability};
}

/** Separate source-qualified eligibility diagnosis, never request authority or
 * a substitute for the previous real attempt's failure evidence.
 * @param {Row} task @param {Row|null} [currentIdentity] */
export function resourceWorkCapabilityEvidence(task,currentIdentity=null) {
  try {
    if(typeof task.capability_evidence_json!=='string'||Buffer.byteLength(task.capability_evidence_json)>512)return null;
    const value=JSON.parse(task.capability_evidence_json),hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==4||value.version!==1
      ||!CAPABILITY.has(value.reason)||!hash(value.binding_key)||!hash(value.source_fence))return null;
    let applicability='unknown';
    if(currentIdentity&&hash(currentIdentity.binding_key)&&hash(currentIdentity.source_fence)&&task.source_id==='lark.im'
      &&currentIdentity.source_id==='lark.im'&&hash(task.account_key)&&hash(task.work_key)
      &&hash(currentIdentity.account_key)&&hash(currentIdentity.work_key))
      applicability=task.account_key!==currentIdentity.account_key||task.work_key!==currentIdentity.work_key||value.binding_key!==currentIdentity.binding_key
        ?'different_binding':value.source_fence===currentIdentity.source_fence?'exact_source':'same_binding';
    return {reason:value.reason,association:{binding_key:value.binding_key,source_fence:value.source_fence},applicability};
  } catch {return null;}
}

/** Cheap, bounded, read-only scheduling hint, not authority or guaranteed work.
 * No migration, permission repair, cache read, API or claim occurs here.
 * @param {string} db @param {Row} [deps] */
export function resourceWorkAvailable(db,deps={}) {
  try {
    const now=(deps.now||Date.now)(); if(!integer(now))return false;
    const rows=(deps.sqliteJson||readOnlySqliteJson)(db,`SELECT CASE WHEN EXISTS(SELECT 1 FROM sources WHERE id='lark.im' AND enabled=1) AND (
      EXISTS(SELECT 1 FROM ${TABLE} WHERE state IN ('pending','deferred') AND retry_at_ms<=${now}) OR
      EXISTS(SELECT 1 FROM ${TABLE} WHERE state='running' AND claim_until_ms<=${now}) OR
      EXISTS(SELECT 1 FROM ${SCAN} WHERE source_id='lark.im' AND next_scan_at_ms<=${now}) OR
      (SELECT COALESCE(MAX(id),0) FROM ${sourceFrom} WHERE ${sourceWhere})>(SELECT last_head_id FROM ${SCAN} WHERE source_id='lark.im'))
      THEN 1 ELSE 0 END AS available;`,'resource work availability',{timeoutMs:1000});
    return rows.length===1&&rows[0].available===1;
  } catch {return false;}
}

/** @param {Row} options @param {Row} [deps] */
export function executeResourceWork(options,deps={}) {
  const maxCli=options.maxCliAttempts??3,maxSelf=options.maxSelfAttempts??2,maxSeconds=options.maxSeconds??30;
  if(typeof options.db!=='string'||!options.db||!Number.isSafeInteger(maxCli)||maxCli<3||maxCli>12||maxSelf!==2||
    !Number.isSafeInteger(maxSeconds)||maxSeconds<1||maxSeconds>30)throw new RangeError('invalid resource work budget');
  const now=deps.now||Date.now,mono=deps.monotonicClock||(()=>performance.now()),began=mono(),wall=now(),deadline=began+maxSeconds*1000;
  let previous=began,producerStarted=false,receiptInvalid=false;
  /** @type {Row|null} */let producerBudget=null,producerSession=null;
  /** @type {Row|null} */let claimed=null,denial=null;
  /** @type {Row} */ const report={ok:true,profile:PROFILE,outcome:'no_eligible_known_resource',processed:0,available:0,deferred:0,blocked:0,failure:null};
  const elapsed=()=>{const n=mono();if(!Number.isFinite(began)||!Number.isFinite(n)||n<previous)stop('clock_unavailable');previous=n;return n-began;};
  const ready=()=>{if(!integer(wall)||!integer(now())||now()<wall)stop('clock_unavailable');if(elapsed()>=maxSeconds*1000)stop('time_budget');};
  // The executor receives the original command clock, not a fresh write grant.
  // SQL construction and admission reads must finish before dispatch is allowed.
  const executionBudget=Object.freeze({assertReady:ready,
    timeoutMs(capMs=30000){
      if(!Number.isFinite(capMs)||capMs<=0)throw new RangeError('invalid resource operation timeout');
      ready();const left=Math.floor(Math.min(capMs,maxSeconds*1000-elapsed()));
      if(left<1)stop('time_budget');return left;
    },
    runCleanup(work){ready();return work();}});
  const query=(sql,label)=>{
    const timeoutMs=executionBudget.timeoutMs(2000);
    const result=(deps.sqliteJson||readOnlySqliteJson)(options.db,sql,label,{timeoutMs});
    ready();return result;
  };
  const snapshot=(ids)=>deps.readSnapshot?deps.readSnapshot(options.db,{direction:'all',limit:ids.length,recordIds:ids}).rows:
    query(`SELECT ${MEDIA_RESOURCE_SOURCE_FIELDS.join(',')} FROM records WHERE id IN (${ids.join(',')})
      AND (${sourceBytes})<=${MAX_ROW_BYTES} ORDER BY id;`,'read bounded resource source rows');
  const acquire=deps.tryAcquireLease||deps.requestSessionDeps?.tryAcquireLease||tryAcquireLarkApiLease;
  const local=action=>{
    ready();let lease;
    try {lease=acquire({db:options.db,role:'probe',monotonicDeadlineMs:Math.min(deadline,mono()+2000)});} catch {stop('lease_unavailable');}
    if(lease?.state!=='acquired')stop(lease?.state==='busy'?'sync_busy':'lease_unavailable');
    try {ready();return action();} finally {lease.release();}
  };
  /** @param {string|null} [reason] */
  const finish=(reason=null)=>{
    let spent;try {
      spent=Math.max(0,Math.floor(elapsed()));
      if(spent>=maxSeconds*1000){reason='time_budget';report.ok=false;
        if(report.outcome==='no_eligible_known_resource')report.outcome='batch_deferred';}
    }catch{spent=null;reason='clock_unavailable';
      if(report.ok)report.outcome='clock_unavailable';report.ok=false;}
    let cli=0,self=0,complete=spent!==null;
    if(producerStarted) {
      const b=producerBudget;
      complete=Boolean(spent!==null&&!receiptInvalid&&b&&b.max_cli_attempts===maxCli&&b.max_self_attempts===2&&integer(b.max_seconds)&&b.max_seconds>=1&&b.max_seconds<=maxSeconds&&
        integer(b.cli_attempts)&&b.cli_attempts<=maxCli&&integer(b.self_attempts)&&b.self_attempts<=2&&b.self_attempts<=b.cli_attempts&&integer(b.elapsed_ms)&&
        (b.stop_reason===null||STOP.has(b.stop_reason)));
      cli=complete?b?.cli_attempts:null;self=complete?b?.self_attempts:null;
    }
    return {...report,request_budget:{complete:Boolean(complete),max_cli_attempts:maxCli,cli_attempts:cli,max_self_attempts:2,self_attempts:self,
      max_seconds:maxSeconds,min_interval_ms:1000,elapsed_ms:spent,stop_reason:reason&&STOP.has(reason)?reason:null}};
  };
  try {
    ready();
    const admission=(deps.captureWriteAdmission||captureLarkWriteAdmission)(options.db,{}, {query:(_db,sql,label)=>query(sql,label)});
    const account=admission.fence.accountKey;
    if(!/^[a-f0-9]{64}$/.test(account||'')){report.ok=false;report.outcome='blocked';report.blocked=1;return finish();}
    const write=(sql)=>{
      ready();admission.assertCurrent();
      const transaction=`BEGIN IMMEDIATE;
      ${larkWriteAdmissionSql(admission.fence)}
      CREATE TEMP TABLE __resource_fence(allowed INTEGER NOT NULL CHECK(allowed=1));
      ${sql}\nCOMMIT;`;
      executionBudget.assertReady();
      // Do not turn a dispatched failure into a proved rollback. A normal late
      // return still represents a confirmed effect; finish reports deadline loss.
      return (deps.sqliteWrite||sqliteQuery)(options.db,transaction,'commit resource work',executionBudget);
    };
    let scan=query(`SELECT * FROM ${SCAN} WHERE source_id='lark.im';`,'read resource scan')[0];
    if(!scan||!integer(scan.generation)||!integer(scan.after_id)||!integer(scan.horizon_id)||!/^([a-f0-9]{64})?$/.test(scan.recovery_after_work_key??'invalid'))throw new Error('resource schema unavailable');
    const head=query(`SELECT COALESCE(MAX(id),0) AS id FROM ${sourceFrom} WHERE ${sourceWhere};`,'read resource head')[0].id;
    if(scan.next_scan_at_ms<=wall||head>scan.last_head_id) {
      const horizon=scan.horizon_id>scan.after_id?scan.horizon_id:head,after=scan.horizon_id>scan.after_id?scan.after_id:0;
      // Measure before fetching bodies. The maintained conservative type index
      // skips unrelated text without moving any source/queue authority. Every
      // inspected candidate advances, including oversized/invalid images.
      const latest=query(`SELECT ${pageColumns} FROM ${sourceFrom} WHERE ${sourceWhere} ORDER BY id DESC LIMIT ${PAGE};`,'read newest resource page');
      const history=query(`SELECT ${pageColumns} FROM ${sourceFrom} WHERE ${sourceWhere} AND id>${after} AND id<=${horizon} ORDER BY id LIMIT ${PAGE};`,'read historical resource page');
      const ids=[...new Set([...latest,...history].filter(x=>integer(x.source_bytes)&&x.source_bytes<=MAX_ROW_BYTES).map(x=>x.id))];
      const rows=ids.length?snapshot(ids):[];
      if(rows.reduce((n,r)=>n+Buffer.byteLength(r.raw_json||'')+Buffer.byteLength(r.canonical_json||''),0)>MAX_PAGE_BYTES)throw new Error('resource page limit');
      const targets=rows.flatMap(row=>resourceWorkIdentities(options.db,row,deps)).filter(t=>t.account_key===account);
      const next=history.length?history.at(-1).id:horizon;
      local(()=>write(`INSERT INTO __resource_fence SELECT CASE WHEN EXISTS(SELECT 1 FROM ${SCAN} WHERE source_id='lark.im' AND generation=${scan.generation}) THEN 1 ELSE 0 END;
        ${resourceEnrollmentSql(targets,account,wall)}
        UPDATE ${SCAN} SET after_id=${next},horizon_id=${horizon},last_head_id=${head},next_scan_at_ms=${wall+SCAN_INTERVAL},generation=generation+1 WHERE source_id='lark.im';`));
      scan=query(`SELECT * FROM ${SCAN} WHERE source_id='lark.im';`,'reread resource scan')[0];
    }
    // Inspect at most two owners, resuming even past live/unknown claims. The
    // cursor and dead-owner transitions are one admitted transaction; no claim
    // is renewed or weakened merely to obtain fair recovery progress.
    const expired=`source_id='lark.im' AND account_key=${q(account)} AND state='running' AND claim_until_ms<=${wall}`;
    const stale=query(`SELECT * FROM ${TABLE} WHERE ${expired} AND work_key>${q(scan.recovery_after_work_key)} ORDER BY work_key LIMIT 2;`,'read expired resource claims');
    if(stale.length<2&&scan.recovery_after_work_key)stale.push(...query(`SELECT * FROM ${TABLE} WHERE ${expired} AND work_key<=${q(scan.recovery_after_work_key)} ORDER BY work_key LIMIT ${2-stale.length};`,'wrap expired resource claims'));
    if(stale.length) {
      const dead=stale.filter(task=>(deps.ownerState||defaultOwnerState)(task.claim_owner)==='dead');
      local(()=>write(`INSERT INTO __resource_fence SELECT CASE WHEN EXISTS(SELECT 1 FROM ${SCAN} WHERE source_id='lark.im' AND generation=${scan.generation}) THEN 1 ELSE 0 END;
        ${dead.map(task=>`UPDATE ${TABLE} SET state=CASE WHEN attempts>=8 THEN 'exhausted' ELSE 'deferred' END,
          reason=CASE WHEN attempts>=8 THEN 'retry_exhausted' ELSE 'lease_unavailable' END,attempt_token=NULL,claim_owner=NULL,claim_until_ms=0,generation=generation+1,retry_at_ms=${wall}
          WHERE ${keyWhere(task)} AND generation=${task.generation} AND attempt_token=${q(task.attempt_token)} AND claim_owner=${q(task.claim_owner)} AND claim_until_ms=${task.claim_until_ms} AND state='running';`).join('\n')}
        UPDATE ${SCAN} SET recovery_after_work_key=${q(stale.at(-1).work_key)},generation=generation+1 WHERE source_id='lark.im';`));
      scan=query(`SELECT * FROM ${SCAN} WHERE source_id='lark.im';`,'reread resource recovery cursor')[0];
    }
    const lane=scan.priority_streak>=2?'fair':'fresh';
    const task=query(`SELECT * FROM ${TABLE} WHERE source_id='lark.im' AND account_key=${q(account)} AND state IN ('pending','deferred') AND retry_at_ms<=${wall} AND attempts<8
      ORDER BY ${lane==='fair'?'enqueued_at_ms,record_id':'record_id DESC,enqueued_at_ms'},work_key LIMIT 1;`,'select resource work')[0];
    if(!task)return finish();
    const row=snapshot([task.record_id])[0],identity=row&&resourceWorkIdentities(options.db,row,deps).find(value=>value.work_key===task.work_key);
    if(!identity||identity.account_key!==task.account_key||identity.work_key!==task.work_key||identity.binding_key!==task.binding_key||identity.source_fence!==task.source_fence) {
      // A proved obsolete selection consumes the same fair turn as a claim.
      // Couple both changes to the observed scan/task/source so churn cannot
      // keep selecting the fresh lane, and a failed CAS advances neither.
      local(()=>write(`INSERT INTO __resource_fence SELECT CASE WHEN ${observedSourceSql(row,task.record_id)} AND EXISTS(SELECT 1 FROM ${TABLE} WHERE ${keyWhere(task)} AND generation=${task.generation} AND state=${q(task.state)})
        AND EXISTS(SELECT 1 FROM ${SCAN} WHERE source_id='lark.im' AND generation=${scan.generation}) THEN 1 ELSE 0 END;
        UPDATE ${TABLE} SET state='blocked',reason='source_changed',generation=generation+1,retry_at_ms=0
        WHERE ${keyWhere(task)} AND generation=${task.generation} AND state=${q(task.state)};
        UPDATE ${SCAN} SET priority_streak=${lane==='fair'?0:Math.min(2,scan.priority_streak+1)},generation=generation+1 WHERE source_id='lark.im';`));
      report.ok=false;report.outcome='source_changed';report.deferred=1;report.failure={stage:'source_fence',reason:'source_changed',persisted:false};return finish();
    }
    if(!identity.request_eligible) {
      // Missing endpoint authority is not a failed download and must not claim
      // or erase a prior real attempt. Consume only this local fair turn.
      const capability=JSON.stringify({version:1,reason:identity.capability_reason,
        binding_key:identity.binding_key,source_fence:identity.source_fence});
      local(()=>write(`INSERT INTO __resource_fence SELECT CASE WHEN ${sourceSql(row)} AND EXISTS(SELECT 1 FROM ${TABLE} WHERE ${keyWhere(task)} AND generation=${task.generation} AND state=${q(task.state)})
        AND EXISTS(SELECT 1 FROM ${SCAN} WHERE source_id='lark.im' AND generation=${scan.generation}) THEN 1 ELSE 0 END;
        UPDATE ${TABLE} SET state='blocked',reason=NULL,capability_evidence_json=${q(capability)},generation=generation+1,retry_at_ms=0
        WHERE ${keyWhere(task)} AND generation=${task.generation} AND state=${q(task.state)};
        UPDATE ${SCAN} SET priority_streak=${lane==='fair'?0:Math.min(2,scan.priority_streak+1)},generation=generation+1 WHERE source_id='lark.im';`));
      report.ok=false;report.outcome='blocked';report.blocked=1;return finish();
    }
    const token=randomUUID();
    if(Math.floor((maxSeconds*1000-elapsed())/1000)<3)stop('time_budget');
    local(()=>write(`INSERT INTO __resource_fence SELECT CASE WHEN ${sourceSql(row)} AND EXISTS(SELECT 1 FROM ${TABLE} WHERE ${keyWhere(task)} AND generation=${task.generation} AND state=${q(task.state)})
      AND EXISTS(SELECT 1 FROM ${SCAN} WHERE source_id='lark.im' AND generation=${scan.generation}) THEN 1 ELSE 0 END;
      UPDATE ${TABLE} SET state='running',attempt_token=${q(token)},capability_evidence_json=NULL,failure_stage=NULL,failure_reason=NULL,failure_binding_key=NULL,failure_source_fence=NULL,claim_owner=${q(DEFAULT_SYNC_LOCK_OWNER)},claim_until_ms=${wall+CLAIM_MS},last_attempt_at_ms=${wall},attempts=attempts+1,generation=generation+1 WHERE ${keyWhere(task)};
      UPDATE ${SCAN} SET priority_streak=${lane==='fair'?0:Math.min(2,scan.priority_streak+1)},generation=generation+1 WHERE source_id='lark.im';`));
    claimed={...task,attempts:task.attempts+1,generation:task.generation+1,attempt_token:token,row};
    ready();
    const seconds=Math.floor((maxSeconds*1000-elapsed())/1000);if(seconds<3)stop('time_budget');
    /** @type {string|null} */let openingSelf=null;
    const factory=(settings,sessionDeps)=>{
      producerSession=(deps.createRequestSession||createMaintenanceRequestSession)(settings,sessionDeps);
      producerStarted=true;
      const session=producerSession;
      return {...session,runLark(args,settings){try{
        const value=session.runLark(args,settings);
        if(transportOperation(args)==='self_profile'&&openingSelf===null)openingSelf=createLarkImAdapter({run:()=>value}).getSelfProfile({retries:0}).open_id;
        return value;
      }catch(error){
        if(args[0]==='api'&&args[1]==='GET'&&args[2]===`/open-apis/im/v1/messages/${encodeURIComponent(row.external_id)}/resources/${encodeURIComponent(identity.resource_key)}`) {
          const receipt=readLarkExecutionReceipt(error,transportOperation(args));
          if(receipt.status==='valid'&&receipt.value?.execution==='started'&&receipt.value.remote_result===true&&DENIAL.get(receipt.value.result_code)===receipt.value.result_kind) {
            // The original 3 CLI / 2 self grant has one closing observation
            // left. Denial belongs to this account only if that bracket closes.
            try {
              const closing=createLarkImAdapter({run:session.runLark}).getSelfProfile({retries:0,retryDelayMs:0}).open_id;
              if(!openingSelf||closing!==openingSelf||recipientAccountKey(closing)!==task.account_key)throw Object.assign(new Error('resource account changed'),{resourceReason:'account_changed'});
              denial=receipt.value;
            } catch(closingError) {
              // This self call happens in the queue wrapper, outside the
              // producer's resource_request site; preserve its actual stage.
              if(closingError instanceof Error)Object.assign(closingError,{resourceFailure:resourceFailureFromError(closingError,'closing_account')});
              throw closingError;
            }
          }
        }
        throw error;
      }}};
    };
    const result=(deps.enrichResources||enrichResources)({db:options.db,resourceDir:options.resourceDir,recordIds:[task.record_id],
      resourceTargets:[{record_id:task.record_id,resource_key:identity.resource_key,reference_kind:identity.reference_kind}],apply:true,
      maxCliAttempts:maxCli,maxSelfAttempts:2,maxSeconds:seconds},{...deps,createRequestSession:factory});
    producerBudget=result.request_budget;
    if(producerStarted&&(!producerBudget||producerBudget.max_cli_attempts!==maxCli||producerBudget.max_self_attempts!==2||producerBudget.max_seconds!==seconds))receiptInvalid=true;
    if(receiptInvalid)throw new Error('resource receipt unavailable');
    const item=result.results?.length===1&&result.results[0].record_id===task.record_id
      &&(result.results[0].resource_key===undefined||result.results[0].resource_key===identity.resource_key)
      &&(result.results[0].reference_kind===undefined||result.results[0].reference_kind===identity.reference_kind)?result.results[0]:null;
    if(!item) {receiptInvalid=true;throw new Error('resource result unavailable');}
    if(!producerStarted&&!(result.request_budget===null&&['available','blocked'].includes(item.state))) {receiptInvalid=true;producerStarted=true;throw new Error('resource zero receipt unavailable');}
    const stopped=STOP.has(result.request_budget?.stop_reason)?result.request_budget.stop_reason:null;
    let state='deferred',reason=stopped||'transient_failure',failures=task.failures,deferrals=task.deferrals;
    const confirmedDenial=/** @type {Row|null} */(denial);
    const capability=CAPABILITY.has(item.reason)?item.reason:null;
    let diagnostic=item.state==='available'||capability?null:normalizeResourceFailure(item.failure);
    if(diagnostic&&[...DENIAL.values()].includes(diagnostic.reason))diagnostic={...diagnostic,reason:'unverified_remote_failure'};
    if(item.state==='available'){state='available';reason=null;}
    else if(confirmedDenial&&item.state==='failed'&&item.reason===confirmedDenial.result_kind){state='blocked';reason=confirmedDenial.result_kind;diagnostic={stage:'resource_request',reason};}
    else if(!producerStarted&&item.state==='blocked'){state='blocked';reason=capability?null:'resource_invalid';}
    else {if(stopped)deferrals=Math.min(8,deferrals+1);else failures=Math.min(3,failures+1);
      state=failures>=3||task.attempts+1>=8?'exhausted':'deferred';reason=state==='exhausted'?'retry_exhausted':reason;
      report.ok=false;report.outcome=state==='exhausted'?'exhausted':'batch_deferred';report.deferred=1;}
    report.failure=diagnostic?{...diagnostic,persisted:false}:null;
    // A stopped request session cannot be bypassed by a later metadata lease.
    if(stopped)return finish(stopped);
    ready();
    const current=snapshot([task.record_id])[0];
    if(!current||makeMediaPendingSourceFence(current)!==identity.source_fence){
      local(()=>write(`INSERT INTO __resource_fence SELECT CASE WHEN ${observedSourceSql(current,task.record_id)} AND EXISTS(SELECT 1 FROM ${TABLE} WHERE ${keyWhere(task)} AND generation=${task.generation+1} AND attempt_token=${q(token)} AND state='running') THEN 1 ELSE 0 END;
        UPDATE ${TABLE} SET state='blocked',reason='source_changed',failure_stage='source_fence',failure_reason='source_changed',failure_binding_key=${q(identity.binding_key)},failure_source_fence=${q(identity.source_fence)},attempt_token=NULL,claim_owner=NULL,claim_until_ms=0,generation=generation+1
        WHERE ${keyWhere(task)} AND generation=${task.generation+1} AND attempt_token=${q(token)} AND state='running';`));
      report.ok=false;report.outcome='source_changed';report.deferred=1;report.failure={stage:'source_fence',reason:'source_changed',persisted:true};return finish();}
    local(()=>write(`INSERT INTO __resource_fence SELECT CASE WHEN ${sourceSql(row)} AND EXISTS(SELECT 1 FROM ${TABLE} WHERE ${keyWhere(task)} AND generation=${task.generation+1} AND attempt_token=${q(token)} AND state='running') THEN 1 ELSE 0 END;
      UPDATE ${TABLE} SET state=${q(state)},reason=${q(reason)},capability_evidence_json=${q(capability?JSON.stringify({version:1,reason:capability,binding_key:identity.binding_key,source_fence:identity.source_fence}):null)},failure_stage=${q(diagnostic?.stage??null)},failure_reason=${q(diagnostic?.reason??null)},failure_binding_key=${q(diagnostic?identity.binding_key:null)},failure_source_fence=${q(diagnostic?identity.source_fence:null)},failures=${failures},deferrals=${deferrals},retry_at_ms=${state==='deferred'?now()+Math.min(3600000,60000*2**Math.min(5,failures+deferrals)):0},
      attempt_token=NULL,claim_owner=NULL,claim_until_ms=0,generation=generation+1 WHERE ${keyWhere(task)};`));
    if(diagnostic)report.failure={...diagnostic,persisted:true};
    if(state==='available'){report.outcome='processed';report.processed=1;report.available=1;}
    else if(state==='blocked'){report.ok=false;report.outcome='blocked';report.blocked=1;}
    return finish();
  } catch(error) {
    const ended=/** @type {Row|null} */(producerSession);
    if(ended&&!producerBudget)try{producerBudget=ended.summary();}catch{receiptInvalid=true;}
    const reason=STOP.has(/** @type {Row} */(error)?.resourceStop)?/** @type {Row} */(error).resourceStop:null;
    report.ok=false;report.outcome=reason==='clock_unavailable'?'clock_unavailable':reason?'batch_deferred':'execution_failed';report.deferred=1;
    return finish(reason);
  }
}
