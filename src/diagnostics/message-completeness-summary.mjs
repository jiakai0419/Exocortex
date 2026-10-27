// @ts-check
import { MESSAGE_COMPLETENESS_REASONS } from '../adapters/lark-im/message-completeness.mjs';
import { READINESS_CONTRACT_VERSION, readinessSourceVersionKey } from './message-readiness-ledger.mjs';

export const MESSAGE_COMPLETENESS_SUMMARY_LIMIT = 1000;
export const MESSAGE_COMPLETENESS_SUMMARY_REASONS = Object.freeze([
  ...MESSAGE_COMPLETENESS_REASONS, 'readiness_unavailable',
]);
const STATES = ['captured', 'enriching', 'ready', 'blocked'];
const FIELDS = ['sender', 'recipient', 'conversation', 'content'];
const REQUIREMENT_STATES = ['satisfied', 'not_applicable', 'missing', 'conflict', 'blocked'];
const ACTIONS = new Set(['none', 'prepare', 'review_identity', 'review_permissions',
  'review_explicit_clear', 'review_content', ...FIELDS.map(field => `resolve_${field}`)]);
const REASONS = new Set(MESSAGE_COMPLETENESS_REASONS);
/** @param {unknown} value @returns {value is Record<string, any>} */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @returns {value is number} */
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const clock = value => count(value) && value <= 8_640_000_000_000_000;
export const MESSAGE_READINESS_OBSERVATION_FIELDS = Object.freeze([
  'source_id', 'record_id', 'observer_account_key', 'contract_version', 'source_version_key', 'source_epoch',
  'state', 'reasons_json', 'first_observed_at_ms', 'first_missing_observed_at_ms', 'first_ready_observed_at_ms',
  'last_observed_at_ms', 'observed_regression_count', 'generation',
]);

/** Validate historical observations against exact accepted source bytes. The
 * complete v1 candidate set must be supplied: uniqueness is checked BEFORE
 * validity/version filtering, so a second account cannot disappear as stale.
 * This grants no current readiness or ownership authority.
 * @param {unknown} sourceRecords @param {unknown} observations @param {number|null} readAt
 * @returns {Record<string,any>[]} */
export function selectMessageReadinessObservations(sourceRecords, observations, readAt) {
  if (!Array.isArray(sourceRecords) || !Array.isArray(observations) || readAt === null || !clock(readAt)) return [];
  const sources = new Map(), duplicates = new Set(), candidates = new Map();
  for (const source of sourceRecords) {
    if (!object(source) || !count(source.id) || source.id < 1) continue;
    if (sources.has(source.id)) duplicates.add(source.id);
    sources.set(source.id, source);
  }
  for (const item of observations) {
    if (!object(item) || !sources.has(item.record_id) || item.source_id !== 'lark.im'
      || item.contract_version !== READINESS_CONTRACT_VERSION) continue;
    const entries = candidates.get(item.record_id) || [];
    entries.push(item); candidates.set(item.record_id, entries);
  }
  const accepted = [];
  for (const [id, entries] of candidates) {
    if (entries.length !== 1 || duplicates.has(id)) continue;
    const value = entries[0], source = sources.get(id);
    try {
      if (!object(source) || source.source_id !== 'lark.im' || source.record_type !== 'lark.im.message'
        || !Object.hasOwn(source, 'external_version') || !(source.external_version === null || typeof source.external_version === 'string')
        || typeof source.external_version === 'string' && source.external_version.includes('\0')
        || typeof source.raw_json !== 'string' || source.raw_json.includes('\0') || Buffer.byteLength(source.raw_json) > 2 * 1024 * 1024
        || Object.keys(value).length !== MESSAGE_READINESS_OBSERVATION_FIELDS.length
        || MESSAGE_READINESS_OBSERVATION_FIELDS.some(field => !Object.hasOwn(value, field))
        || !hash(value.observer_account_key) || !hash(value.source_version_key)
        || value.source_version_key !== readinessSourceVersionKey(source)
        || !count(value.source_epoch) || value.source_epoch < 1 || !count(value.generation) || value.generation < value.source_epoch
        || !count(value.observed_regression_count) || value.observed_regression_count >= value.generation
        || !STATES.includes(value.state) || typeof value.reasons_json !== 'string' || Buffer.byteLength(value.reasons_json) > 4096) continue;
      const reasons = JSON.parse(value.reasons_json);
      if (!Array.isArray(reasons) || reasons.length > REASONS.size || reasons.some(reason => !REASONS.has(reason))
        || new Set(reasons).size !== reasons.length || value.state === 'ready' && reasons.length !== 0
        || ['enriching', 'blocked'].includes(value.state) && reasons.length === 0) continue;
      const first = value.first_observed_at_ms, last = value.last_observed_at_ms;
      const missing = value.first_missing_observed_at_ms, ready = value.first_ready_observed_at_ms;
      if (!clock(first) || !clock(last) || first > last || last > readAt
        || [missing, ready].some(at => at !== null && (!clock(at) || at < first || at > last))
        || missing === null && ready === null || value.state === 'ready' && ready === null
        || value.state !== 'ready' && missing === null
        || Math.min(...[missing, ready].filter(at => at !== null)) !== first
        || value.observed_regression_count > 0 && (missing === null || ready === null)
        || missing !== null && ready !== null && (missing === ready
          || value.state === 'ready' && missing === last || value.state !== 'ready' && ready === last
          || (ready < missing || value.state !== 'ready') && value.observed_regression_count === 0)) continue;
      accepted.push(Object.fromEntries(MESSAGE_READINESS_OBSERVATION_FIELDS.map(field => [field,
        field === 'reasons_json' ? JSON.stringify(reasons) : value[field]])));
    } catch { /* Malformed history is unavailable, never a current reading failure. */ }
  }
  return accepted;
}

function observationTiming(page, metadata, readAt, metadataValid) {
  const proofs = Array.isArray(metadata.source_records) ? metadata.source_records : [];
  const selected = new Map(page.filter(object).map(row => [row.id, row]));
  const proofCounts = new Map();
  for (const proof of proofs) if (object(proof) && selected.has(proof.id)) {
    proofCounts.set(proof.id, (proofCounts.get(proof.id) || 0) + 1);
  }
  const exact = proofs.filter(proof => {
    if (!object(proof) || proofCounts.get(proof.id) !== 1) return false;
    const row = selected.get(proof.id);
    // Display/mapping spreads may omit hidden external_version, but never the
    // selected source bytes or identity. Only the snapshot proof carries it.
    return row && ['id', 'source_id', 'record_type', 'external_id', 'actor_id', 'container_id', 'direction',
      'occurred_at', 'occurred_at_ms', 'raw_json'].every(field => Object.hasOwn(row, field)
        && Object.hasOwn(proof, field) && row[field] === proof[field])
      && (!Object.hasOwn(row, 'external_version') || row.external_version === proof.external_version);
  });
  const observations = metadataValid ? selectMessageReadinessObservations(exact, metadata.observations, readAt) : [];
  const missing = observations.map(item => item.first_missing_observed_at_ms).filter(at => at !== null);
  const ready = observations.map(item => item.first_ready_observed_at_ms).filter(at => at !== null);
  const oldest = missing.length ? Math.min(...missing) : null, latest = ready.length ? Math.max(...ready) : null;
  let regressions = 0;
  for (const item of observations) {
    regressions += item.observed_regression_count;
    if (!Number.isSafeInteger(regressions)) { regressions = NaN; break; }
  }
  const regressionKnown = Number.isSafeInteger(regressions) ? observations.length : 0;
  return {
    first_missing_observed: { oldest_at: oldest === null ? null : new Date(oldest).toISOString(),
      oldest_age_ms: oldest === null ? null : readAt - oldest, known_count: missing.length, unknown_count: page.length - missing.length },
    first_ready_observed: { latest_at: latest === null ? null : new Date(latest).toISOString(),
      known_count: ready.length, unknown_count: page.length - ready.length },
    observed_regressions: { regression_count: regressionKnown ? regressions : null,
      known_count: regressionKnown, unknown_count: page.length - regressionKnown },
  };
}

/** Validate only the shared protocol and its partition invariants. This never
 * evaluates names, identity, body or evidence again. Unknown readiness cannot
 * become a ready message merely because a caller supplied a nonempty label.
 * @param {unknown} value */
function validReadiness(value) {
  if (!object(value) || value.version !== 1 || !STATES.includes(value.state)
    || !ACTIONS.has(value.next_action) || !Array.isArray(value.requirements)
    || value.requirements.length !== FIELDS.length || !Array.isArray(value.reasons)
    || value.reasons.length > MESSAGE_COMPLETENESS_REASONS.length
    || value.reasons.some(reason => !REASONS.has(reason))) return false;
  const fields = new Set(), reasons = new Set();
  let missing = false, blocked = false;
  for (const item of value.requirements) {
    if (!object(item) || !FIELDS.includes(item.field) || fields.has(item.field)
      || !REQUIREMENT_STATES.includes(item.state)) return false;
    fields.add(item.field);
    if (['satisfied', 'not_applicable'].includes(item.state)) {
      if (item.reason !== null) return false;
    } else {
      if (!REASONS.has(item.reason)) return false;
      reasons.add(item.reason);
      missing ||= item.state === 'missing';
      blocked ||= ['conflict', 'blocked'].includes(item.state);
    }
  }
  const provided = new Set(value.reasons);
  if (provided.size !== reasons.size || [...reasons].some(reason => !provided.has(reason))) return false;
  if (value.state === 'ready') return !missing && !blocked && value.next_action === 'none';
  if (value.state === 'blocked') return blocked && value.next_action !== 'none';
  if (value.state === 'enriching') return missing && !blocked && value.next_action !== 'none';
  return !blocked && value.next_action === 'prepare';
}

/** @param {unknown} value @returns {number|null} */
function isoTime(value) {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return count(at) && at <= 8_640_000_000_000_000 && new Date(at).toISOString() === value ? at : null;
}

/** Public-safe reduction of an already evaluated, stable latest-message page.
 * All clocks/population evidence are supplied by the caller's snapshot. There
 * is no DB/API/current-time access. Source bytes are only hashed to match the
 * historical observation epoch; they never reinterpret current readiness.
 *
 * @param {unknown} messages
 * @param {{population?:Record<string,any>,as_of?:Record<string,any>,filter?:Record<string,any>,source_records?:Record<string,any>[],observations?:Record<string,any>[]}} [metadata]
 */
export function summarizeMessageCompleteness(messages, metadata = {}) {
  metadata = object(metadata) ? metadata : {};
  const input = Array.isArray(messages) ? messages : [];
  const page = input.slice(0, MESSAGE_COMPLETENESS_SUMMARY_LIMIT);
  const population = object(metadata.population) ? metadata.population : {};
  const snapshot = object(metadata.as_of) ? metadata.as_of : {};
  const filter = object(metadata.filter) ? metadata.filter : {};
  const readAt = isoTime(snapshot.read_at);
  const maximum = count(snapshot.source_max_record_id) ? snapshot.source_max_record_id : null;
  const direction = ['all', 'sent', 'received'].includes(filter.direction) ? filter.direction : 'unknown';
  const filterValid = direction !== 'unknown' && typeof filter.search === 'string';
  const populationValid = Array.isArray(messages) && count(population.total)
    && count(population.evaluated) && count(population.not_evaluated)
    && population.evaluated === input.length && population.total >= population.evaluated
    && population.total - population.evaluated === population.not_evaluated;
  // Check only observable page/snapshot contradictions, without re-reading
  // content to reinterpret search or duplicating the evaluator's quality rules.
  const ids = new Set();
  let pageMetadataValid = true;
  for (const item of page) {
    if (!object(item)) continue;
    if (Object.hasOwn(item, 'id')) {
      if (!count(item.id) || item.id === 0 || maximum === null || item.id > maximum || ids.has(item.id)) pageMetadataValid = false;
      ids.add(item.id);
    }
    if (item.direction != null && (!['sent', 'received'].includes(item.direction)
      || direction !== 'all' && direction !== 'unknown' && item.direction !== direction)) pageMetadataValid = false;
    if (item.source_id != null && item.source_id !== 'lark.im'
      || item.record_type != null && item.record_type !== 'lark.im.message') pageMetadataValid = false;
  }
  const metadataValid = populationValid && readAt !== null && maximum !== null && filterValid
    && pageMetadataValid && (population.total === 0 || maximum > 0);
  /** @type {Record<string, number>} */
  const counts = { captured: 0, enriching: 0, ready: 0, blocked: 0 };
  /** @type {Record<string, number>} */
  const reasons = Object.fromEntries(MESSAGE_COMPLETENESS_SUMMARY_REASONS.map(reason => [reason, 0]));
  let invalidReadiness = 0, sourceUnknown = 0, ageUnknown = 0;
  /** @type {number|null} */
  let oldest = null;
  for (const item of page) {
    const row = object(item) ? item : {};
    const valid = validReadiness(row.readiness);
    const state = valid ? row.readiness.state : 'captured';
    counts[state] += 1;
    if (valid) {
      for (const reason of new Set(row.readiness.reasons)) reasons[/** @type {string} */ (reason)] += 1;
    } else {
      invalidReadiness += 1;
      reasons.readiness_unavailable += 1;
    }
    if (state === 'ready') continue;
    const at = row.occurred_at_ms;
    if (!count(at) || at > 8_640_000_000_000_000) {
      sourceUnknown += 1;
      ageUnknown += 1;
      continue;
    }
    oldest = oldest === null ? at : Math.min(oldest, at);
    if (readAt === null || at > readAt) ageUnknown += 1;
  }
  const evaluated = page.length, incomplete = evaluated - counts.ready;
  const notEvaluated = populationValid ? population.total - evaluated : null;
  const invalid = !metadataValid || invalidReadiness > 0;
  const complete = !invalid && notEvaluated === 0;
  return {
    version: 1,
    scope: 'stored_lark_im_messages',
    filter: { direction, has_search: typeof filter.search === 'string' && filter.search.length > 0 },
    limit: MESSAGE_COMPLETENESS_SUMMARY_LIMIT,
    as_of: { read_at: readAt === null ? null : new Date(readAt).toISOString(), source_max_record_id: maximum },
    population: { total: populationValid ? population.total : null, evaluated, not_evaluated: notEvaluated },
    counts,
    incomplete,
    reasons,
    evaluation: { mode: 'bounded_latest', status: invalid ? 'invalid' : complete ? 'complete' : 'bounded',
      complete, input_truncated: input.length > MESSAGE_COMPLETENESS_SUMMARY_LIMIT,
      invalid_readiness_count: invalidReadiness, metadata_valid: metadataValid },
    timing: {
      basis: 'source_occurrence_not_first_missing',
      oldest_source_at: oldest === null ? null : new Date(oldest).toISOString(),
      oldest_source_age_ms: oldest === null || readAt === null || oldest > readAt ? null : readAt - oldest,
      source_time_unknown_count: sourceUnknown,
      source_age_unknown_count: ageUnknown,
      // Observed transitions below are not the true first missing/completion
      // instant. updated_at and task retry/enqueue times never supply either.
      first_missing: { oldest_at: null, oldest_age_ms: null, unknown_count: incomplete },
      completion: { latest_at: null, latency_ms: null, unknown_count: counts.ready },
      ...observationTiming(page, metadata, readAt, metadataValid),
    },
  };
}
