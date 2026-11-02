// @ts-check
import { spawnSync } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLarkImAdapter } from '../adapters/lark-im/adapter.mjs';
import { projectionAccount } from '../adapters/lark-im/message-projection-evidence.mjs';
import { recipientAccountKey } from '../adapters/lark-im/p2p-recipient.mjs';
import { renderMediaProjection } from '../adapters/lark-im/media-content.mjs';
import { assessMediaImageBytes, makeMediaResourceBinding, MAX_MEDIA_RESOURCE_BYTES,
  publishMediaResource, readMediaResource, resourceStorePath, makeMediaPendingSourceFence,
  readPendingMediaResource, retainPendingMediaResource, discardPendingMediaResource, reclaimPendingMediaResources } from '../adapters/lark-im/media-resource-store.mjs';
import { classifyLarkFailure } from '../adapters/lark-im/transport.mjs';
import { readLarkExecutionReceipt } from '../adapters/lark-im/transport-execution.mjs';
import { readMessageSnapshot } from '../diagnostics/message-read-snapshot.mjs';
import { createMaintenanceRequestSession, MaintenanceRequestError } from './request-session.mjs';

/** @typedef {Record<string,any>} Row */
const GUARD = 'import os,resource,sys\nos.umask(0o077)\nresource.setrlimit(resource.RLIMIT_FSIZE,(16777216,16777216))\nos.execvp(sys.argv[1],sys.argv[1:])';
const unchangedFields = ['source_id','record_type','external_id','external_version','content_hash',
  'raw_json','canonical_json','actor_id','container_id','direction','occurred_at','occurred_at_ms','body'];
const same = (a,b) => ['dev','ino','size','mtimeNs','ctimeNs','mode','uid','nlink'].every(key => a[key]===b[key]);
const parse = value => { try {return JSON.parse(value);} catch {return {};} };
const localFailure = reason => Object.assign(new Error(reason),{resourceReason:reason});
const localReasons = new Set(['profile_unverified','account_mismatch','account_changed','source_changed',
  'download_response_invalid','download_file_invalid','download_image_invalid','resource_publish_failed',
  'resource_format_unsupported','resource_decoder_unavailable','resource_validation_limit','resource_pending_invalid','resource_pending_busy']);
const continuationCurrent=(evidence,time)=>Number.isSafeInteger(time)&&time>=evidence.read_observed_at_ms&&time>=evidence.created_at_ms&&time<evidence.expires_at_ms;
const resumableStops = new Set(['sync_busy','cli_budget','self_budget','time_budget']);
// Only these byte-content outcomes are independent of batch safety admission.
const itemContentFailures = new Set(['download_image_invalid','resource_format_unsupported']);
// Diagnostic vocabulary only. These fields never authorize a request, retry,
// permanent denial or publication. Stage is a local call site, not proof that
// the process/remote operation executed. Never retain error prose or payloads.
export const RESOURCE_FAILURE_STAGES=Object.freeze(['selection','opening_account','pending_recovery',
  'resource_request','download_validation','closing_account','publication','source_fence','unknown']);
export const RESOURCE_FAILURE_REASONS=Object.freeze(['unknown','request_failed','request_not_started','request_execution_unknown',
  'unverified_remote_failure','network_timeout','network_error','service_unavailable','internal_error','command_unavailable','spawn_error',
  'permission_denied','restricted_mode','bot_user_out_of_chat',
  'record_missing','content_not_supported','sticker_resource_unsupported','media_reference_missing','media_reference_invalid','account_unverified','source_binding_invalid',
  'profile_unverified','account_mismatch','account_changed','source_changed','download_response_invalid','download_file_invalid',
  'download_image_invalid','resource_publish_failed','resource_format_unsupported','resource_decoder_unavailable','resource_validation_limit',
  'resource_pending_invalid','resource_pending_busy','resource_pending_expired','resource_pending_capacity','resource_pending_conflict',
  'resource_pending_missing','resource_pending_account_unverified','resource_verification_failed','resource_image_invalid','resource_time_invalid',
  'resource_not_cached','publication_not_attempted','batch_stopped','sync_busy','lease_unavailable','cli_budget','self_budget','time_budget',
  'clock_unavailable','rate_cooldown','rate_limited','shared_cooldown_unavailable']);
const denialReasons=new Set(['permission_denied','restricted_mode','bot_user_out_of_chat']);
/** Bounded diagnostic projection; old nullable columns intentionally map to unknown.
 * This validates shape, not the authority of a remote denial.
 * @param {any} value */
export function normalizeResourceFailure(value) {
  return {stage:RESOURCE_FAILURE_STAGES.includes(value?.stage)?value.stage:'unknown',
    reason:RESOURCE_FAILURE_REASONS.includes(value?.reason)?value.reason:'unknown'};
}
/** A trusted local call site plus finite command-boundary receipt, never prose.
 * Exact endpoint/closing-account denial verification belongs to resource-work.
 * @param {any} error @param {string} stage */
export function resourceFailureFromError(error,stage) {
  if(error?.resourceFailure) {
    const diagnostic=normalizeResourceFailure(error.resourceFailure);
    return denialReasons.has(diagnostic.reason)?{...diagnostic,reason:'unverified_remote_failure'}:diagnostic;
  }
  if(error instanceof MaintenanceRequestError)return normalizeResourceFailure({stage,reason:error.reason});
  if(localReasons.has(error?.resourceReason))return normalizeResourceFailure({stage,reason:error.resourceReason});
  const operation=['opening_account','closing_account'].includes(stage)?'self_profile':'other';
  const receipt=readLarkExecutionReceipt(error,operation);
  let reason='unknown';
  if(receipt.status==='valid') {
    const value=receipt.value;
    reason=value?.execution==='not_started'?'request_not_started':value?.execution==='unknown'?'request_execution_unknown':
      denialReasons.has(value?.result_kind)?(value?.remote_result===true?'unverified_remote_failure':'unknown'):value?.result_kind==='success'?'request_failed':value?.result_kind;
  }
  return normalizeResourceFailure({stage,reason});
}

function failure(error) {
  if (error instanceof MaintenanceRequestError) return error.reason;
  if (localReasons.has(error?.resourceReason)) return error.resourceReason;
  return classifyLarkFailure(error instanceof Error ? error.message : error).kind;
}

/** A CLI saved_path is a claim, not a path we are allowed to follow. */
function readDownload(stage, filename, response) {
  const path=join(stage,filename);
  if (!response || typeof response.saved_path!=='string' || resolve(stage,response.saved_path)!==path
    || !Number.isSafeInteger(response.size_bytes) || response.size_bytes<1 || response.size_bytes>MAX_MEDIA_RESOURCE_BYTES
    || typeof response.content_type!=='string') throw localFailure('download_response_invalid');
  let fd;
  try {
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=fstatSync(fd,{bigint:true});
    if (!before.isFile() || before.nlink!==1n || before.uid!==BigInt(process.getuid?.() ?? -1)
      || (before.mode&0o077n)!==0n || before.size!==BigInt(response.size_bytes)) throw localFailure('download_file_invalid');
    const bytes=Buffer.alloc(response.size_bytes+1);let length=0;
    while(length<bytes.length) {const n=readSync(fd,bytes,length,bytes.length-length,length);if(!n)break;length+=n;}
    const after=fstatSync(fd,{bigint:true}), current=lstatSync(path,{bigint:true});
    if(length!==response.size_bytes||current.isSymbolicLink()||!current.isFile()||!same(before,after)||!same(after,current))
      throw localFailure('download_file_invalid');
    const result=bytes.subarray(0,length), assessment=assessMediaImageBytes(result), image=assessment.image;
    if(['resource_format_unsupported','resource_decoder_unavailable','resource_validation_limit'].includes(assessment.reason || ''))
      throw localFailure(assessment.reason);
    if (!image || response.content_type.split(';')[0].trim().toLowerCase()!==image.mime_type)
      throw localFailure('download_image_invalid');
    return result;
  } catch(error) {if(localReasons.has(/** @type {Row} */(error)?.resourceReason))throw error;throw localFailure('download_file_invalid');}
  finally {if(fd!==undefined)closeSync(fd);}
}

/** Exact, opt-in acquisition. No DB writes, source rewriting, retry or identity fallback.
 * @param {Row} options @param {Row} [deps] */
export function enrichResources(options,deps={}) {
  const snapshot=deps.readSnapshot || readMessageSnapshot, now=deps.now || Date.now;
  const selection={direction:'all',search:'',limit:options.recordIds.length,recordIds:options.recordIds};
  const rows=snapshot(options.db,selection).rows, byId=new Map(rows.map(row=>[row.id,row]));
  const cache=resourceStorePath(options.db,options.resourceDir);
  /** @type {Row[]} */ const candidates=[];
  const results=options.recordIds.map(id=>{
    const row=byId.get(id), entry={record_id:id,state:'blocked',reason:'record_missing'};
    if(!row)return entry;
    const canonical=parse(row.canonical_json),raw=parse(row.raw_json),media=renderMediaProjection(row,canonical,raw);
    if(!media)return {...entry,reason:'content_not_supported'};
    if(media.type==='sticker')return {...entry,reason:'sticker_resource_unsupported'};
    if(media.resource.state!=='reference_only')return {...entry,reason:media.reason};
    const account=projectionAccount(row,canonical,raw);
    if(account.state!=='verified')return {...entry,reason:'account_unverified'};
    const binding=makeMediaResourceBinding(options.db,row,account.account_key,media);
    if(!binding)return {...entry,reason:'source_binding_invalid'};
    const cached=readMediaResource(cache,binding);
    if(cached.status==='available')return {...entry,state:'available',reason:null};
    if(cached.status==='invalid')return {...entry,reason:cached.reason};
    const planned={...entry,state:'planned',reason:null};
    const sourceFence=makeMediaPendingSourceFence(row);
    if(!sourceFence)return {...entry,reason:'source_binding_invalid'};
    candidates.push({row,account,media,binding,sourceFence,entry:planned});return planned;
  });
  /** @type {Row} */ const report={target:'resources',dry_run:options.apply!==true,
    selected:results.length,results,request_budget:null,partial:false};
  const finish=()=>{
    for(const entry of results) {
      if(['blocked','failed'].includes(entry.state))entry.failure=normalizeResourceFailure(entry.failure??{stage:'selection',reason:entry.reason});
      else entry.failure=null;
    }
    report.available=results.filter(item=>item.state==='available').length;
    report.planned=results.filter(item=>item.state==='planned').length;
    report.failed=results.filter(item=>['blocked','failed'].includes(item.state)).length;
    report.partial=report.failed>0 || options.apply===true && report.planned>0;
    report.ok=!report.partial;return report;
  };
  if(options.apply!==true || !candidates.length)return finish();
  // Staging stays outside the source DB/store until all remote and local fences
  // pass. The private directory is removed even after a timeout/denial.
  const stage=mkdtempSync(join(realpathSync(deps.tmpdir || tmpdir()),'exocortex-media-'));
  let session;
  /** @type {Row|null} */ let activeCandidate=null;
  let activeAttempts=0;
  let openingAtMs=null,originalClosingAtMs=null;
  let failureStage='opening_account';
  /** @type {Row|null} */ let failureOwner=null;
  try {
    const sessionDeps={env:deps.env,now:deps.now,...deps.requestSessionDeps};
    const executor=sessionDeps.spawnSync || spawnSync;
    sessionDeps.spawnSync=(command,args,settings)=>executor(deps.pythonPath || 'python3',
      ['-B','-c',GUARD,command,...args],{...settings,cwd:stage});
    session=(deps.createRequestSession || createMaintenanceRequestSession)({...options,maxSelfAttempts:Math.min(2,options.maxCliAttempts??candidates.length+2),
      maxCliAttempts:options.maxCliAttempts??candidates.length+2,maxSeconds:options.maxSeconds??30},sessionDeps);
    const runLark=(args,settings={})=>session.runLark(args,{...settings,retries:0,retryDelayMs:0,
      timeoutMs:8000,retryBudgetMs:8000,maxBufferBytes:1024*1024});
    const adapter=createLarkImAdapter({run:runLark});
    const verifySelf=()=>{const self=adapter.getSelfProfile({retries:0});
      if(!/^ou_[A-Za-z0-9_-]+$/.test(self.open_id)||self.open_id.length>512)throw localFailure('profile_unverified');
      return recipientAccountKey(self.open_id);};
    const account=verifySelf();
    if(candidates.some(candidate=>candidate.account.account_key!==account))throw localFailure('account_mismatch');
    openingAtMs=now();
    failureStage='pending_recovery';
    const prepared=reclaimPendingMediaResources(cache,{nowMs:now()});
    if(prepared.status!=='ready')throw localFailure(prepared.reason);
    for(const [index,candidate] of candidates.entries()) {
      failureOwner=candidate;
      failureStage='pending_recovery';
      const pending=readPendingMediaResource(cache,candidate.binding,candidate.sourceFence,{nowMs:now()});
      if(pending.status==='invalid')throw localFailure('resource_pending_invalid');
      if(pending.status==='pending') {
        candidate.bytes=pending.bytes;candidate.continuation=pending;
        candidate.entry.state='verified_download';candidate.entry.pending_state='reused';continue;
      }
      // A previous download without its original closing account observation is
      // quarantined, never promoted by today's self profile. A fresh operation
      // must download again; success may remove that exact obsolete generation.
      if(pending.status==='quarantined')candidate.quarantine=pending;
      failureStage='resource_request';
      session.assertReady();
      const filename=`resource-${index}.bin`;
      activeCandidate=candidate;activeAttempts=session.summary().cli_attempts;
      candidate.entry.state='fetching';
      const response=runLark(['api','GET',`/open-apis/im/v1/messages/${encodeURIComponent(candidate.row.external_id)}/resources/${encodeURIComponent(candidate.media.resource.key)}`,
        '--as','user','--params','{"type":"image"}','--output',filename,'--format','json']);
      failureStage='download_validation';
      try {
        candidate.bytes=readDownload(stage,filename,response);candidate.entry.state='verified_download';
      } catch(error) {
        const reason=/** @type {Row} */(error)?.resourceReason;
        if(!itemContentFailures.has(reason))throw error;
        candidate.entry.state='blocked';candidate.entry.reason=reason;
        candidate.entry.failure=resourceFailureFromError(error,failureStage);
      }
      activeCandidate=null;
    }
    const downloaded=candidates.filter(candidate=>candidate.entry.state==='verified_download');
    if(!downloaded.length)return finish();
    failureOwner=null;
    failureStage='closing_account';
    if(verifySelf()!==account)throw localFailure('account_changed');
    originalClosingAtMs=now();
    failureStage='source_fence';
    session.withCommit(()=>{
      const current=snapshot(options.db,selection).rows;
      for(const candidate of downloaded) {
        failureOwner=candidate;
        failureStage='source_fence';
        const publicationAtMs=now();
        if(candidate.continuation && !continuationCurrent(candidate.continuation,publicationAtMs)) {
          candidate.entry.state='blocked';candidate.entry.reason='resource_pending_expired';candidate.entry.failure={stage:'pending_recovery',reason:'resource_pending_expired'};continue;
        }
        const row=current.find(row=>row.id===candidate.row.id);
        if(!row||unchangedFields.some(key=>row[key]!==candidate.row[key])) {
          candidate.entry.state='blocked';candidate.entry.reason='source_changed';candidate.entry.failure={stage:'source_fence',reason:'source_changed'};continue;
        }
        failureStage='publication';
        const saved=publishMediaResource(cache,candidate.binding,candidate.bytes,{nowMs:publicationAtMs});
        candidate.entry.state=saved.status==='available'?'available':'blocked';
        candidate.entry.reason=saved.status==='available'?null:saved.reason;
        if(saved.status!=='available')candidate.entry.failure=normalizeResourceFailure({stage:'publication',reason:saved.reason});
        if(saved.status!=='available')throw localFailure('resource_publish_failed');
        const receipt=candidate.continuation?.receipt??candidate.quarantine?.receipt;
        if(receipt) {
          const cleaned=discardPendingMediaResource(cache,receipt);
          if(cleaned.status!=='removed')candidate.entry.pending_cleanup_reason=cleaned.reason;
        }
      }
    });
  } catch(error) {
    const reason=failure(error);report.stop_reason=reason;
    const diagnostic=resourceFailureFromError(error,failureStage);
    if(resumableStops.has(reason)&&openingAtMs!==null) {
      // Local retention never publishes available evidence or obtains an API
      // lease. Recheck the exact row before preserving this original operation.
      try {
        const current=snapshot(options.db,selection).rows;
        for(const candidate of candidates.filter(item=>item.entry.state==='verified_download')) {
          const retentionAtMs=now();
          if(candidate.continuation && !continuationCurrent(candidate.continuation,retentionAtMs)) {
            candidate.entry.pending_state='not_retained';candidate.entry.pending_reason='resource_pending_expired';continue;
          }
          const row=current.find(row=>row.id===candidate.row.id);
          if(!row||makeMediaPendingSourceFence(row)!==candidate.sourceFence) {
            candidate.entry.state='blocked';candidate.entry.reason='source_changed';candidate.entry.failure={stage:'source_fence',reason:'source_changed'};continue;
          }
          const retained=retainPendingMediaResource(cache,candidate.binding,candidate.sourceFence,candidate.bytes,{nowMs:retentionAtMs,
            openingAtMs:candidate.continuation?.opening_at_ms??openingAtMs,
            originalClosingAtMs:candidate.continuation?.original_closing_at_ms??originalClosingAtMs,stopReason:reason,
            freshDownload:!candidate.continuation});
          candidate.entry.pending_state=retained.status==='pending'?'retained':retained.status==='quarantined'?'quarantined':'not_retained';
          if(!['pending','quarantined'].includes(retained.status))candidate.entry.pending_reason=retained.reason;
        }
      }catch {report.pending_reason='resource_pending_invalid';}
    }
    // A failed request is evidence about one resource, never its neighbors.
    // Pre-execution admission failures have no resource response to attribute.
    if(activeCandidate?.entry.state==='fetching' && (session?.summary().cli_attempts || 0)>activeAttempts) {
      activeCandidate.entry.state='failed';activeCandidate.entry.reason=reason;activeCandidate.entry.failure=diagnostic;
    }
    for(const candidate of candidates) {
      if(candidate.entry.state==='verified_download') {
        candidate.entry.state='blocked';candidate.entry.reason='publication_not_attempted';
        candidate.entry.failure=!failureOwner||failureOwner===candidate?diagnostic:{stage:'publication',reason:'publication_not_attempted'};
      } else if(['planned','fetching'].includes(candidate.entry.state)) {
        candidate.entry.state='blocked';candidate.entry.reason='batch_stopped';
        // A not-yet-requested neighbor cannot borrow another resource's result.
        candidate.entry.failure=failureOwner&&candidate!==failureOwner?{stage:'selection',reason:'batch_stopped'}:diagnostic;
      }
    }
  } finally {
    report.request_budget=session?.summary() || null;
    rmSync(stage,{recursive:true,force:true});
  }
  return finish();
}
