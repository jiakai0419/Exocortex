// @ts-check
import { chatScopeId } from '../adapters/lark-im/core.mjs';
import { createHash } from 'node:crypto';
import { parseEvidence } from '../../dist/core/lark-observation.js';

export const SAMPLE_POLICY = Object.freeze({ version: 1, intervalMs: 900000, ttlMs: 1800000,
  stableBufferMs: 600000, windowMs: 86400000, chats: 5, hot: 2, pages: 2, pageSize: 20,
  calls: 12, gapMs: 1000, deadlineMs: 55000, requestMs: 4000, observationTtlMs: 604800000, observations: 200, historyTargets: 3 });

export function jsonValue(value) { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } }
// A body match is positive evidence that can retire persistent debt. Do not
// manufacture it by rounding unknown numbers or collapsing duplicate JSON keys.
function bodyEvidence(value) { try { return typeof value === 'string' ? parseEvidence(value) : null; } catch { return null; } }
export function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function sampleScopeHash(binding, chatId) { return digest([binding.database_key, binding.account_key, chatId]); }
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
export function selectSampleChats(rows, rotation, now, limit = Number(SAMPLE_POLICY.chats), hotLimit = Number(SAMPLE_POLICY.hot)) {
  const eligible = rows.filter((r) => r.enabled === 1 && r.source_id === 'lark.im' && r.chat_id &&
    r.id === chatScopeId(r.chat_id) && !r.unsupported_reason);
  const byId = [...new Map(eligible.map((r) => [r.chat_id, r])).values()].sort((a,b) => a.chat_id.localeCompare(b.chat_id));
  const hot = byId.filter((r) => Number.isSafeInteger(r.hot_rank) && r.hot_rank >= 0 &&
    Number.isFinite(Date.parse(r.hot_seen_at)) && Date.parse(r.hot_seen_at) <= now && now - Date.parse(r.hot_seen_at) <= 86400000)
    .sort((a,b) => a.hot_rank - b.hot_rank || a.chat_id.localeCompare(b.chat_id)).slice(0, Math.min(SAMPLE_POLICY.hot, hotLimit, limit));
  const selected = [...hot]; const fairRotations = {};
  let traversed = 0;
  const start = byId.length ? rotation % byId.length : 0;
  while (selected.length < limit && traversed < byId.length) {
    const row = byId[(start + traversed) % byId.length];
    traversed++;
    if (!selected.some((r) => r.chat_id === row.chat_id)) {
      selected.push(row); fairRotations[row.chat_id] = (start + traversed) % byId.length;
    }
  }
  return { selected, rotation: byId.length ? (start + traversed) % byId.length : 0,
    eligible: byId.length, hot: hot.length, fair: selected.length - hot.length, traversed, fairRotations };
}

/** Only source-native static bodies have a comparable representation. */
export function compareSampleMessage(remote, local) { return inspectSampleMessage(remote, local).comparison; }

/** Overlapping list/mget acquisitions may have different transport metadata.
 * Accept a duplicate only when their message identity, version and body evidence
 * agree. This is deduplication, never an additional proof of a debt dimension. */
export function sameSampleMessageAcquisition(a, b) {
  const evidence = message => ({ id: message.message_id, chat: message.chat_id,
    created: epoch(message.create_time), version: epoch(message.update_time), type: message.msg_type,
    deleted: typeof message.deleted === 'boolean' ? message.deleted : null,
    body: bodyEvidence(message.body?.content) ?? message.body?.content ?? null });
  const left = evidence(a), right = evidence(b);
  return left.created !== null && left.version !== null &&
    JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Keep the public primary category separate from each independent proof. */
function inspectSampleMessage(remote, local) {
  const unverified = kind => ({ comparison: { kind, content: 'unverified' }, dimensions: null });
  if (!local) return unverified('missing');
  const raw = jsonValue(local.raw_json);
  const canonicalLocal = jsonValue(local.canonical_json);
  if (local.source_id !== 'lark.im' || local.record_type !== 'lark.im.message' ||
      local.container_id !== remote.chat_id || local.external_id !== remote.message_id) return unverified('identity_conflict');
  if (canonicalLocal?.source_api !== 'im.v1.messages') return unverified('incomparable');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unverified('identity_conflict');
  if (typeof raw.message_id !== 'string' || !raw.message_id.trim() || raw.message_id !== remote.message_id ||
      typeof raw.chat_id !== 'string' || !raw.chat_id.trim() || raw.chat_id !== remote.chat_id ||
      epoch(raw.create_time) !== null && epoch(raw.create_time) !== epoch(remote.create_time)) {
    return unverified('identity_conflict');
  }
  if (!raw.message_id || !raw.chat_id || !raw.msg_type || epoch(raw.create_time) === null) return unverified('incomparable');
  const remoteVersion = epoch(remote.update_time);
  const localVersion = epoch(local.external_version);
  if (!remoteVersion || !localVersion || epoch(raw.update_time) !== localVersion) return unverified('incomparable');
  if (remoteVersion < localVersion) return unverified('local_newer');
  const dimensions = { version: remoteVersion, different: /** @type {string[]} */ ([]), equal: ['missing'] };
  const newer = remoteVersion > localVersion;
  // Public precedence must not suppress contradictions in independent fields.
  // Positive content proof, however, requires the same source version on both
  // sides; an older local row cannot borrow the remote version's proof floor.
  const finish = comparison => ({ comparison: newer
    ? { kind: 'version', content: 'unverified', version: remoteVersion } : comparison, dimensions });
  (newer ? dimensions.different : dimensions.equal).push('version');
  const compareDimension = (dimension, different) => {
    if (different) dimensions.different.push(dimension);
    else if (!newer) dimensions.equal.push(dimension);
  };
  const differentType = raw.msg_type !== remote.msg_type;
  const differentDeletion = typeof remote.deleted === 'boolean' && typeof raw.deleted === 'boolean' && remote.deleted !== raw.deleted;
  compareDimension('type', differentType);
  if (typeof raw.deleted === 'boolean' && typeof remote.deleted === 'boolean') {
    compareDimension('deleted', differentDeletion);
  }
  if (differentType || differentDeletion) return finish({ kind: 'content', content: 'different', version: remoteVersion });
  if (!['text', 'post'].includes(remote.msg_type) || remote.deleted || raw.deleted) return finish({ kind: 'match', content: 'unverified' });
  const a = bodyEvidence(remote.body?.content); const b = bodyEvidence(raw.body?.content);
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return finish({ kind: 'incomparable', content: 'unverified' });
  if (JSON.stringify(canonical(a)) !== JSON.stringify(canonical(b))) {
    dimensions.different.push('body');
    return finish({ kind: 'content', content: 'different', version: remoteVersion });
  }
  compareDimension('body', false);
  // A kind-only content entry might have meant deletion, type or body. Its
  // origin is unknown, so all three positive proofs are required for closure.
  if (dimensions.equal.includes('deleted')) dimensions.equal.push('legacy_content');
  return finish({ kind: 'match', content: 'equal' });
}

/** Each value is a version floor, except missing (first observed time) and
 * legacy_content (0: the old cache did not retain the contradictory dimension).
 * No body, deletion value or raw identity is persisted. */
function observationDebts(observation) {
  if (!observation) return {};
  if (observation.debts) return { ...observation.debts };
  return observation.kind === 'missing' ? { missing: observation.first_seen } :
    observation.kind === 'version' ? { version: 0 } : { legacy_content: 0 };
}

function debtKind(debts) { return Object.hasOwn(debts, 'missing') ? 'missing' : Object.hasOwn(debts, 'version') ? 'version' : 'content'; }

/** No identifiers or content leave this reducer. Observations are salted hashes. */
export function evaluateSample({ messages, records, coverage, binding, previous = {}, previousOverflow = false, now, windowEnd }) {
  const counts = { present: 0, missing: 0, pending_sync: 0, suspected_missing: 0, confirmed_missing: 0,
    stale_version: 0, content_mismatch: 0, identity_conflict: 0, local_newer: 0,
    content_equal: 0, content_unverified: 0, unresolved_prior: 0, expired_observations: 0, observation_overflow: 0 };
  /** @type {Record<string, any>} */ const observations = {};
  for (const [key,value] of Object.entries(previous)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !value || !['missing','version','content'].includes(value.kind) ||
      !['first_seen','last_seen','run_finished','target'].every((k) => Number.isSafeInteger(value[k]) && value[k] >= 0 && value[k] <= now)) continue;
    observations[key] = { ...value, debts: observationDebts(value) };
  }
  const differences = new Set();
  for (const message of messages) {
    const created = epoch(message.create_time);
    const key = digest([binding.database_key, binding.account_key, message.chat_id, message.message_id, created]);
    const local = records.get(message.message_id);
    const { comparison, dimensions } = inspectSampleMessage(message, local);
    const old = observations[key];
    const debts = observationDebts(old);
    if (dimensions) {
      for (const dimension of dimensions.equal) {
        if (dimension === 'missing' || dimensions.version >= debts[dimension]) delete debts[dimension];
      }
      for (const dimension of dimensions.different) debts[dimension] = Math.max(debts[dimension] || 0, dimensions.version);
    }
    const proof = coverage[key] || {};
    if (comparison.content === 'equal') counts.content_equal++; else counts.content_unverified++;
    if (comparison.kind === 'missing') counts.missing++; else counts.present++;
    if (comparison.kind === 'identity_conflict') counts.identity_conflict++;
    if (comparison.kind === 'local_newer') counts.local_newer++;
    if (['missing','version','content'].includes(comparison.kind)) {
      differences.add(key);
      const validCoverage = proof.covered === true && proof.details_pending !== true &&
        Number.isSafeInteger(proof.latest_finished_ms) && proof.latest_finished_ms <= now;
      const confirmed = comparison.kind === 'missing' && Object.hasOwn(debts, 'missing') && old?.target === created &&
        now - debts.missing >= SAMPLE_POLICY.intervalMs && validCoverage && proof.latest_finished_ms > debts.missing;
      if (comparison.kind === 'missing') {
        if (!validCoverage) counts.pending_sync++;
        else if (confirmed) counts.confirmed_missing++;
        else counts.suspected_missing++;
      } else if ((comparison.version || 0) > windowEnd) counts.pending_sync++;
      else if (comparison.kind === 'version') counts.stale_version++;
      else counts.content_mismatch++;
      if (comparison.kind === 'missing' && !Object.hasOwn(debts, 'missing')) debts.missing = now;
      observations[key] = { kind: debtKind(debts), debts, target: created, first_seen: old?.first_seen ?? now,
        last_seen: now, run_finished: validCoverage ? proof.latest_finished_ms : 0,
        scope_hash: sampleScopeHash(binding, message.chat_id), last_checked: now };
    } else if (old) {
      if (Object.keys(debts).length) observations[key] = { ...old, kind: debtKind(debts), debts, last_checked: now };
      else delete observations[key];
    }
    // Only dimension-specific positive proof settles debt. In particular,
    // local-newer supplies none; an unreadable body can still have equal versions.
  }
  counts.unresolved_prior = Object.keys(observations).filter((k) => previous[k] && !differences.has(k)).length;
  const entries = Object.entries(observations).sort((a,b) => Number(Boolean(previous[b[0]])) - Number(Boolean(previous[a[0]])) || b[1].last_seen - a[1].last_seen);
  counts.observation_overflow = Math.max(0, entries.length - SAMPLE_POLICY.observations);
  const retained = entries.slice(0, SAMPLE_POLICY.observations);
  // Age is loss of freshness, never proof that a discrepancy was repaired.
  counts.expired_observations = retained.filter(([, value]) => now - value.last_seen > SAMPLE_POLICY.observationTtlMs).length;
  const observationOverflow = previousOverflow || counts.observation_overflow > 0;
  if (observationOverflow) counts.observation_overflow = Math.max(1, counts.observation_overflow);
  return { counts, observations: Object.fromEntries(retained), observationOverflow };
}
