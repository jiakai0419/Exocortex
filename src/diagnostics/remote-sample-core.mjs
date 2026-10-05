// @ts-check
import { chatScopeId } from '../adapters/lark-im/core.mjs';
import { createHash } from 'node:crypto';

export const SAMPLE_POLICY = Object.freeze({ version: 1, intervalMs: 900000, ttlMs: 1800000,
  stableBufferMs: 600000, windowMs: 86400000, chats: 5, hot: 2, pages: 2, pageSize: 20,
  calls: 12, gapMs: 1000, deadlineMs: 55000, requestMs: 4000, observationTtlMs: 604800000, observations: 200 });

export function jsonValue(value) { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } }
export function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export function epoch(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 100000000000 && n <= 253402300799999 ? n : null;
}

/** Stable ordering gives fair capacity even when the same chats remain hot. */
export function selectSampleChats(rows, rotation, now, limit = Number(SAMPLE_POLICY.chats)) {
  const eligible = rows.filter((r) => r.enabled === 1 && r.source_id === 'lark.im' && r.chat_id &&
    r.id === chatScopeId(r.chat_id) && !r.unsupported_reason);
  const byId = [...new Map(eligible.map((r) => [r.chat_id, r])).values()].sort((a,b) => a.chat_id.localeCompare(b.chat_id));
  const hot = byId.filter((r) => Number.isSafeInteger(r.hot_rank) && r.hot_rank >= 0 &&
    Number.isFinite(Date.parse(r.hot_seen_at)) && Date.parse(r.hot_seen_at) <= now && now - Date.parse(r.hot_seen_at) <= 86400000)
    .sort((a,b) => a.hot_rank - b.hot_rank || a.chat_id.localeCompare(b.chat_id)).slice(0, Math.min(2, limit));
  const selected = [...hot];
  let traversed = 0;
  const start = byId.length ? rotation % byId.length : 0;
  while (selected.length < limit && traversed < byId.length) {
    const row = byId[(start + traversed) % byId.length];
    traversed++;
    if (!selected.some((r) => r.chat_id === row.chat_id)) selected.push(row);
  }
  return { selected, rotation: byId.length ? (start + traversed) % byId.length : 0,
    eligible: byId.length, hot: hot.length, fair: selected.length - hot.length, traversed };
}

/** Only source-native static bodies have a comparable representation. */
export function compareSampleMessage(remote, local) {
  if (!local) return { kind: 'missing', content: 'unverified' };
  const raw = jsonValue(local.raw_json);
  const canonicalLocal = jsonValue(local.canonical_json);
  if (local.source_id !== 'lark.im' || local.record_type !== 'lark.im.message' ||
      local.container_id !== remote.chat_id || local.external_id !== remote.message_id) return { kind: 'identity_conflict', content: 'unverified' };
  if (canonicalLocal?.source_api !== 'im.v1.messages') return { kind: 'incomparable', content: 'unverified' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'identity_conflict', content: 'unverified' };
  if (typeof raw.message_id !== 'string' || !raw.message_id.trim() || raw.message_id !== remote.message_id ||
      typeof raw.chat_id !== 'string' || !raw.chat_id.trim() || raw.chat_id !== remote.chat_id ||
      epoch(raw.create_time) !== null && epoch(raw.create_time) !== epoch(remote.create_time)) {
    return { kind: 'identity_conflict', content: 'unverified' };
  }
  if (!raw.message_id || !raw.chat_id || !raw.msg_type || epoch(raw.create_time) === null) return { kind: 'incomparable', content: 'unverified' };
  const remoteVersion = epoch(remote.update_time);
  const localVersion = epoch(local.external_version);
  if (!remoteVersion || !localVersion || epoch(raw.update_time) !== localVersion) return { kind: 'incomparable', content: 'unverified' };
  if (remoteVersion > localVersion) return { kind: 'version', content: 'unverified', version: remoteVersion };
  if (remoteVersion < localVersion) return { kind: 'local_newer', content: 'unverified' };
  if (raw.msg_type !== remote.msg_type || typeof remote.deleted === 'boolean' && typeof raw.deleted === 'boolean' && remote.deleted !== raw.deleted) return { kind: 'content', content: 'different', version: remoteVersion };
  if (!['text', 'post'].includes(remote.msg_type) || remote.deleted || raw.deleted) return { kind: 'match', content: 'unverified' };
  const a = jsonValue(remote.body?.content); const b = jsonValue(raw.body?.content);
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return { kind: 'incomparable', content: 'unverified' };
  if (JSON.stringify(canonical(a)) !== JSON.stringify(canonical(b))) return { kind: 'content', content: 'different', version: remoteVersion };
  return { kind: 'match', content: 'equal' };
}

/** No identifiers or content leave this reducer. Observations are salted hashes. */
export function evaluateSample({ messages, records, coverage, binding, previous = {}, now, windowEnd }) {
  const counts = { present: 0, missing: 0, pending_sync: 0, suspected_missing: 0, confirmed_missing: 0,
    stale_version: 0, content_mismatch: 0, identity_conflict: 0, local_newer: 0,
    content_equal: 0, content_unverified: 0, unresolved_prior: 0, expired_observations: 0, observation_overflow: 0 };
  /** @type {Record<string, any>} */ const observations = {};
  for (const [key,value] of Object.entries(previous)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !value || !['missing','version','content'].includes(value.kind) ||
      !['first_seen','last_seen','run_finished','target'].every((k) => Number.isSafeInteger(value[k]) && value[k] >= 0 && value[k] <= now)) continue;
    if (now - value.last_seen > SAMPLE_POLICY.observationTtlMs) { counts.expired_observations++; continue; }
    observations[key] = value;
  }
  const touched = new Set(); const differences = new Set();
  for (const message of messages) {
    const created = epoch(message.create_time);
    const key = digest([binding.database_key, binding.account_key, message.chat_id, message.message_id, created]);
    touched.add(key);
    const comparison = compareSampleMessage(message, records.get(message.message_id));
    const proof = coverage[key] || {};
    if (comparison.content === 'equal') counts.content_equal++; else counts.content_unverified++;
    if (comparison.kind === 'missing') counts.missing++; else counts.present++;
    if (comparison.kind === 'identity_conflict') counts.identity_conflict++;
    if (comparison.kind === 'local_newer') counts.local_newer++;
    if (['missing','version','content'].includes(comparison.kind)) {
      differences.add(key);
      const old = observations[key];
      const validCoverage = proof.covered === true && proof.details_pending !== true &&
        Number.isSafeInteger(proof.latest_finished_ms) && proof.latest_finished_ms <= now;
      const confirmed = comparison.kind === 'missing' && old?.kind === 'missing' && old.target === created &&
        now - old.first_seen >= SAMPLE_POLICY.intervalMs && validCoverage && proof.latest_finished_ms > old.first_seen;
      if (comparison.kind === 'missing') {
        if (!validCoverage) counts.pending_sync++;
        else if (confirmed) counts.confirmed_missing++;
        else counts.suspected_missing++;
      } else if ((comparison.version || 0) > windowEnd) counts.pending_sync++;
      else if (comparison.kind === 'version') counts.stale_version++;
      else counts.content_mismatch++;
      observations[key] = { kind: comparison.kind, target: created, first_seen: old?.kind === comparison.kind ? old.first_seen : now,
        last_seen: now, run_finished: validCoverage ? proof.latest_finished_ms : 0 };
    } else if (comparison.kind === 'match') delete observations[key];
    // Incomparable/local-newer do not erase previously observed discrepancies.
  }
  counts.unresolved_prior = Object.keys(observations).filter((k) => previous[k] && !differences.has(k)).length;
  const entries = Object.entries(observations).sort((a,b) => b[1].last_seen - a[1].last_seen);
  counts.observation_overflow = Math.max(0, entries.length - SAMPLE_POLICY.observations);
  return { counts, observations: Object.fromEntries(entries.slice(0, SAMPLE_POLICY.observations)) };
}
