// @ts-check
import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, mkdirSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { publicTimestamp } from './public-safe.mjs';
import { SAMPLE_POLICY } from './remote-sample-core.mjs';
import { safeGuardianDiagnostic } from '../runtime/worker/remote-sample-process.mjs';

const COUNT_KEYS = ['present','missing','pending_sync','suspected_missing','confirmed_missing','stale_version','content_mismatch',
  'identity_conflict','local_newer','content_equal','content_unverified','unresolved_prior','expired_observations','observation_overflow'];
const PROBE_KEYS = ['hot_chats_requested','hot_chats_found','messages_per_chat','remote_messages_checked','unsupported_chats','probe_errors',
  'eligible_chats','hot_chats','fair_chats','chats_checked','pages','truncated_chats','api_calls'];
export const REMOTE_REASONS = ['not_due','state_invalid','cache_write_failed','database_unavailable','scheduler_unavailable','invalid_interval','shared_cooldown_unavailable','attempting','sample_process_failed','sample_failed','state_write_failed','no_eligible_chats','no_usable_remote_messages','account_mismatch','account_unverified','identity_unavailable',
  'confirmed_missing','source_difference','suspected_missing','sync_pending','unresolved_observations','partial_sample','request_budget',
  'time_budget','sync_busy','lease_unavailable','rate_cooldown','rate_limited','restricted_mode','request_timeout','keychain_unavailable',
  'api_unavailable','context_unavailable','inventory_budget','invalid_page','account_changed','database_changed','context_changed','invalid_evidence'];
const safeCount = (n) => Number.isSafeInteger(n) && n >= 0 ? n : 0;
const isoTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;

/** @returns {Record<string, any>} */
export function publicRemoteReport(input) {
  const hasDiagnostic = input != null && Object.hasOwn(input, 'guardian_diagnostic');
  const diagnostic = safeGuardianDiagnostic(input?.guardian_diagnostic);
  // Even a malformed diagnostic cannot be stripped into a positive report.
  const status = hasDiagnostic ? 'unavailable' : ['healthy','delayed','needs_attention','inconclusive','unavailable'].includes(input?.status) ? input.status : 'inconclusive';
  const probe = Object.fromEntries(PROBE_KEYS.map((k) => [k, safeCount(input?.probe?.[k])]));
  const findings = Object.fromEntries(COUNT_KEYS.map((k) => [k, safeCount(input?.findings?.[k])]));
  const binding = { state: ['verified','unverified','conflict','unavailable'].includes(input?.binding?.state) ? input.binding.state : 'unverified',
    evidence: ['single_sent_actor','initialized_empty_database'].includes(input?.binding?.evidence) ? input.binding.evidence : null,
    tenant_verified: false };
  return { schema_version: 3, ok: status === 'healthy' && input.ok === true && binding.state === 'verified' && probe.remote_messages_checked > 0 &&
    probe.probe_errors === 0 && probe.unsupported_chats === 0 && findings.missing === 0 && findings.confirmed_missing === 0 &&
    findings.stale_version === 0 && findings.content_mismatch === 0 && findings.identity_conflict === 0 && findings.unresolved_prior === 0,
    status, reason: hasDiagnostic ? 'sample_process_failed' : REMOTE_REASONS.includes(input?.reason) ? input.reason : null, checked_at: publicTimestamp(input?.checked_at),
    ...(diagnostic ? { guardian_diagnostic: diagnostic } : {}),
    scope: 'discovered_chats_rotating', window: { start: publicTimestamp(input?.window?.start), end: publicTimestamp(input?.window?.end) }, binding,
    probe: { mode: 'bounded_native_pages', comparison: 'identity_version_static_body', ...probe }, findings,
    missing_count: findings.missing, lag_ms: null,
    unverified: ['undiscovered_or_disabled_chats','outside_creation_window','thread_only_replies','merged_children','client_dynamic_cards'] };
}

export function remoteSampleCache(result) {
  const report = publicRemoteReport(result.report);
  const context = result.cacheContext;
  const checked = Date.parse(report.checked_at || '');
  const ttl = Math.min(3600000, Math.max(SAMPLE_POLICY.ttlMs, Number(result.cacheTtlMs) || SAMPLE_POLICY.ttlMs));
  return { kind: 'lark_im_live_probe_cache/v3', policy_version: SAMPLE_POLICY.version,
    context: { database_key: hash(context?.database_key), source_id: 'lark.im', account_key: hash(context?.account_key),
      auth_identity_verified: context?.auth_identity_verified === true },
    ...report, expires_at: Number.isFinite(checked) ? new Date(checked + ttl).toISOString() : null,
    // Most recent attempt is always explicit; a failed attempt cannot renew success.
    last_success_at: report.ok ? report.checked_at : null };
}

/** Check original counters before public projection normalizes anything. Failed attempts
 * may have completed pages without reaching comparison; all structural bounds still apply. */
function validCounters(p, f) {
  if (!p || !f || !PROBE_KEYS.every((k) => Number.isSafeInteger(p[k]) && p[k] >= 0) ||
      !COUNT_KEYS.every((k) => Number.isSafeInteger(f[k]) && f[k] >= 0)) return false;
  const n = p.remote_messages_checked;
  if (p.hot_chats_requested > SAMPLE_POLICY.chats || p.hot_chats_found > p.hot_chats_requested ||
      p.hot_chats_found > p.eligible_chats || p.eligible_chats > 10000 ||
      p.hot_chats > SAMPLE_POLICY.hot || p.hot_chats + p.fair_chats !== p.hot_chats_found ||
      p.chats_checked > p.hot_chats_found || p.unsupported_chats > p.hot_chats_found ||
      p.probe_errors > 1 || p.messages_per_chat > SAMPLE_POLICY.pageSize ||
      p.pages < p.chats_checked || p.pages > p.chats_checked * SAMPLE_POLICY.pages ||
      p.truncated_chats > p.chats_checked || p.truncated_chats > p.pages - p.chats_checked ||
      p.api_calls > SAMPLE_POLICY.calls || p.api_calls < p.pages + p.unsupported_chats + (p.pages + p.unsupported_chats > 0 ? 1 : 0) ||
      p.pages > 0 && p.messages_per_chat === 0 ||
      n > SAMPLE_POLICY.chats * SAMPLE_POLICY.pages * SAMPLE_POLICY.pageSize || n > p.pages * p.messages_per_chat ||
      f.present + f.missing !== n || f.content_equal + f.content_unverified !== n || f.content_equal > f.present ||
      f.suspected_missing + f.confirmed_missing > f.missing ||
      f.missing - f.suspected_missing - f.confirmed_missing > f.pending_sync ||
      f.pending_sync + f.suspected_missing + f.confirmed_missing + f.stale_version + f.content_mismatch + f.identity_conflict + f.local_newer > f.content_unverified ||
      f.stale_version + f.content_mismatch + f.identity_conflict + f.local_newer + f.content_equal > f.present ||
      f.unresolved_prior > SAMPLE_POLICY.observations || f.expired_observations > SAMPLE_POLICY.observations ||
      f.observation_overflow > SAMPLE_POLICY.observations ||
      f.unresolved_prior + f.expired_observations > SAMPLE_POLICY.observations) return false;
  return true;
}

export function parseRemoteSampleCache(input) {
  if (input?.kind !== 'lark_im_live_probe_cache/v3' || input.policy_version !== SAMPLE_POLICY.version || input.schema_version !== 3 || input.context?.source_id !== 'lark.im') return null;
  if (Object.hasOwn(input, 'guardian_diagnostic') && (!safeGuardianDiagnostic(input.guardian_diagnostic) ||
      input.ok !== false || input.status !== 'unavailable' || input.reason !== 'sample_process_failed')) return null;
  if (!validCounters(input.probe, input.findings) ||
      ![input.checked_at, input.expires_at, input.window?.start, input.window?.end].every(isoTime) ||
      input.reason !== null && !REMOTE_REASONS.includes(input.reason) ||
      typeof input.ok !== 'boolean' || !['healthy','delayed','needs_attention','inconclusive','unavailable'].includes(input.status) ||
      input.scope !== 'discovered_chats_rotating' || input.probe.mode !== 'bounded_native_pages' ||
      input.probe.comparison !== 'identity_version_static_body' || input.binding?.tenant_verified !== false ||
      input.last_success_at !== (input.ok ? input.checked_at : null) || !['verified','unverified','conflict','unavailable'].includes(input.binding?.state) ||
      input.binding.state === 'verified' && !['single_sent_actor','initialized_empty_database'].includes(input.binding.evidence) ||
      input.missing_count !== input.findings.missing) return null;
  if (input.ok && (input.status !== 'healthy' || input.reason !== null || input.binding.state !== 'verified' || input.context?.auth_identity_verified !== true ||
      !hash(input.context?.account_key) || !hash(input.context?.database_key) || input.probe.remote_messages_checked === 0 || input.probe.chats_checked === 0 || input.probe.chats_checked !== input.probe.hot_chats_found || input.probe.messages_per_chat < 1 || input.probe.messages_per_chat > 20 ||
      input.probe.pages < input.probe.chats_checked || input.probe.pages > input.probe.chats_checked * 2 || input.probe.api_calls < input.probe.pages + 2 ||
      input.probe.remote_messages_checked > input.probe.pages * input.probe.messages_per_chat ||
      ['missing','pending_sync','suspected_missing','confirmed_missing','stale_version','content_mismatch','identity_conflict','local_newer','unresolved_prior','expired_observations','observation_overflow']
        .some((key) => input.findings[key] !== 0) || input.probe.probe_errors !== 0 || input.probe.unsupported_chats !== 0)) return null;
  const cache = remoteSampleCache({ report: input, cacheContext: input.context });
  return { ...cache, expires_at: publicTimestamp(input.expires_at), last_success_at: publicTimestamp(input.last_success_at) };
}

/** Atomic private publication; don't follow pre-existing symlinks. */
export function writeRemoteSampleCache(path, result) {
  const cache = remoteSampleCache(result);
  const parent = dirname(path); mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw new Error('sample_cache_directory_invalid');
  try { if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('sample_cache_file_invalid'); }
  catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e; }
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd;
  try { fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, `${JSON.stringify(cache)}\n`); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, path);
    const directoryFd = openSync(parent, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  }
  finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch { /* Already published. */ } }
  return cache;
}

/** @returns {{status:"unknown"|"sampled"|"behind",detail:string,[key:string]:any}} */
export function summarizeRemoteSample(cache, now, expectedContext) {
  const validated = parseRemoteSampleCache(cache);
  if (!validated) return { status: 'unknown', reason: 'invalid_evidence', detail: 'sample evidence is invalid', auth_identity: 'unknown' };
  cache = validated;
  const report = publicRemoteReport(cache);
  const base = { scope: report.scope, sample_count: report.probe.remote_messages_checked, chat_count: report.probe.chats_checked,
    checked_at: report.checked_at, expires_at: cache.expires_at, window: report.window, result: report.status,
    binding: report.binding, findings: report.findings, sample: report.probe, auth_identity: 'verified_at_check',
    last_success_at: cache.last_success_at, reason: report.reason, detail: '' };
  const unknown = (reason, detail) => ({ ...base, status: /** @type {const} */ ('unknown'), reason, detail });
  if (!expectedContext || !hash(cache.context?.database_key) || cache.context.database_key !== expectedContext.database_key || cache.context.source_id !== 'lark.im') {
    return { status: 'unknown', reason: 'context_mismatch', detail: 'sample belongs to a different database', auth_identity: 'unknown' };
  }
  const checked = Date.parse(report.checked_at || ''); const expiry = Date.parse(cache.expires_at || '');
  const start = Date.parse(report.window.start || ''); const end = Date.parse(report.window.end || '');
  if (!Number.isFinite(checked) || checked > now || !(expiry > checked) || expiry - checked > 3600000 ||
      !(start < end) || end - start > SAMPLE_POLICY.windowMs || end > checked - SAMPLE_POLICY.stableBufferMs) return unknown('invalid_timestamp','sample time is invalid');
  if (now >= expiry) return unknown('expired','last sample expired');
  if (!hash(cache.context.account_key) || !cache.context.auth_identity_verified || report.binding.state !== 'verified') {
    return { ...unknown(report.reason || 'account_unverified','account association not verified'), auth_identity: 'unknown' };
  }
  if (report.ok) return { ...base, status: 'sampled', detail: `${base.sample_count} messages sampled in ${base.chat_count} discovered chats` };
  if (['delayed','needs_attention'].includes(report.status)) return { ...base, status: 'behind', detail: report.reason || 'sample differences observed' };
  return unknown(report.reason || 'inconclusive','sample not verified');
}

/** Publish a bounded failure marker before any new attempt or after child failure. */
export function invalidateRemoteSampleCache(path, { context, nowMs = Date.now(), reason = 'attempting' }) {
  const end = Math.floor((nowMs - SAMPLE_POLICY.stableBufferMs) / 60000) * 60000;
  return writeRemoteSampleCache(path, { cacheContext: context,
    report: { status: 'unavailable', ok: false, reason, checked_at: new Date(nowMs).toISOString(),
      window: { start: new Date(end - SAMPLE_POLICY.windowMs).toISOString(), end: new Date(end).toISOString() },
      probe: {}, findings: {}, binding: { state: 'unverified' } } });
}
