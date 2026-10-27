// @ts-check
import { validateJsonObjectText } from '../../dist/core/json-text-patch.js';

/** @typedef {Record<string, any>} ObjectValue */
/** @typedef {{status:string,reason:string,minimumMs:number|null,maximumMs:number|null}} Metric */
const IDENTITY_BINDING = ['recordKey', 'sourceVersion', 'identityGeneration', 'contractVersion'];
const SOURCE_BINDING = IDENTITY_BINDING.slice(0, 2);
const MAX_TIME = Number.MAX_SAFE_INTEGER - 86_400_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('\0');
const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME;
const monotonic = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIME;

/** @param {string} status @param {string} reason
 * @param {number|null} [minimumMs] @param {number|null} [maximumMs] @returns {Metric} */
function metric(status, reason, minimumMs = null, maximumMs = minimumMs) {
  return { status, reason, minimumMs, maximumMs };
}
function validBinding(value, complete) {
  const fields = complete ? IDENTITY_BINDING : SOURCE_BINDING;
  return only(value, fields) && fields.every(key => key === 'identityGeneration' ? integer(value[key]) : text(value[key]));
}
function stage(value, current, kind) {
  if (value == null) return { status: 'missing_evidence', value: null };
  const complete = kind === 'identityReady' || kind === 'published';
  const fields = kind === 'source' ? ['binding', 'atMs', 'precisionMs', 'clockEpoch', 'clockDiscontinuity']
    : ['binding', 'atMs', 'processKey', 'monotonicMs', 'clockEpoch', 'clockDiscontinuity', ...(complete ? ['complete'] : [])];
  if (!only(value, fields) || !validBinding(value.binding, complete) || !integer(value.atMs)
    || value.clockEpoch !== undefined && !text(value.clockEpoch)
    || value.clockDiscontinuity !== undefined && typeof value.clockDiscontinuity !== 'boolean'
    || complete && typeof value.complete !== 'boolean'
    || kind === 'source' && (!Number.isSafeInteger(value.precisionMs) || value.precisionMs < 1 || value.precisionMs > 86_400_000)
    || kind !== 'source' && ((value.processKey !== undefined || value.monotonicMs !== undefined)
      && (!text(value.processKey) || !monotonic(value.monotonicMs)))) return { status: 'invalid_evidence', value: null };
  const keys = complete ? IDENTITY_BINDING : SOURCE_BINDING;
  if (keys.some(key => value.binding[key] !== current[key])) return { status: 'stale_evidence', value: null };
  if (complete && value.complete !== true) return { status: 'incomplete', value: null };
  return { status: 'valid', value };
}

/** @returns {Metric} */
function interval(start, end, tolerance) {
  if (!start.value || !end.value) return metric('unknown', !start.value ? start.status : end.status);
  const a = start.value, b = end.value;
  if (a.clockDiscontinuity || b.clockDiscontinuity) return metric('clock_anomaly', 'clock_discontinuity');
  const maximum = b.atMs - a.atMs, minimum = maximum - ((a.precisionMs || 1) - 1);
  if (maximum < 0) return metric('clock_anomaly', 'negative_wall_interval');
  if (a.processKey && a.processKey === b.processKey) {
    const elapsed = b.monotonicMs - a.monotonicMs;
    if (!Number.isFinite(elapsed) || elapsed < 0) return metric('clock_anomaly', 'negative_monotonic_interval');
    if (Math.abs(maximum - elapsed) > tolerance) return metric('clock_anomaly', 'wall_monotonic_disagreement');
    return metric('measured', 'monotonic', elapsed);
  }
  if (!a.clockEpoch || a.clockEpoch !== b.clockEpoch) return metric('unverified', 'clock_epoch_unverified', minimum, maximum);
  if (minimum < 0) return metric('uncertain', 'source_precision_overlap', minimum, maximum);
  return metric('measured', a.precisionMs > 1 ? 'source_precision_interval' : 'verified_wall', minimum, maximum);
}

/** Do not replace verified local elapsed time with a shorter wall interval.
 * Tolerance admits a clock comparison, not deletion of measured duration.
 * @param {Metric} sourceToCollection @param {Metric} collectionToIdentity
 * @param {Metric} identityToPublication @returns {Metric} */
function publicationInterval(sourceToCollection, collectionToIdentity, identityToPublication, collected, published, tolerance) {
  if (identityToPublication.status !== 'measured' || sourceToCollection.status === 'clock_anomaly')
    return metric('unknown', 'publication_order_unverified');
  if (!['measured', 'uncertain'].includes(sourceToCollection.status))
    return metric(sourceToCollection.status, sourceToCollection.reason);
  const whole = interval(collected, published, tolerance);
  if (whole.status !== 'measured') return whole;
  const sum = /** @type {number} */ (collectionToIdentity.minimumMs) + /** @type {number} */ (identityToPublication.minimumMs);
  if (Math.abs(published.value.atMs - collected.value.atMs - sum) > tolerance)
    return metric('clock_anomaly', 'chain_wall_monotonic_disagreement');
  // With a whole-process monotonic witness, mixed-clock leg evidence must not
  // contradict its elapsed time even when both wall comparisons are tolerated.
  if (whole.reason === 'monotonic' && Math.abs(/** @type {number} */ (whole.minimumMs) - sum) > 0.000001)
    return metric('clock_anomaly', 'chain_interval_disagreement');
  const local = whole.reason === 'monotonic' ? /** @type {number} */ (whole.minimumMs) : sum;
  const minimum = /** @type {number} */ (sourceToCollection.minimumMs) + local;
  const maximum = /** @type {number} */ (sourceToCollection.maximumMs) + local;
  if (!Number.isFinite(minimum) || !monotonic(maximum)) return metric('unknown', 'duration_capacity');
  if (minimum < 0) return metric('uncertain', 'source_precision_overlap', minimum, maximum);
  const reason = [whole, collectionToIdentity, identityToPublication].some(item => item.reason === 'monotonic')
    ? 'composed_monotonic' : minimum === maximum ? 'verified_wall' : 'source_precision_interval';
  return metric('measured', reason, minimum, maximum);
}

/** Pure, bounded evidence projection. Strings are never echoed to output.
 * @param {unknown} input */
function measureMessageLatency(input) {
  const unavailable = reason => ({
    schema: 'message_latency/v1', evidence: 'invalid', delayCause: 'unclassified',
    sourceToCollection: metric('unknown', reason), collectionToIdentity: metric('unknown', reason),
    identityToPublication: metric('unknown', reason), sourceToPublication: metric('unknown', reason),
  });
  if (typeof input !== 'string' || input.length > 8192 || Buffer.byteLength(input) > 16384) return unavailable('invalid_input');
  /** @type {ObjectValue} */
  let value;
  try { validateJsonObjectText(input); value = JSON.parse(input); }
  catch { return unavailable('invalid_input'); }
  if (!only(value, ['current', 'source', 'collected', 'identityReady', 'published', 'clockToleranceMs'])
    || !validBinding(value.current, true)) return unavailable('invalid_input');
  const tolerance = value.clockToleranceMs === undefined ? 1000 : value.clockToleranceMs;
  if (!Number.isSafeInteger(tolerance) || tolerance < 0 || tolerance > 60_000) return unavailable('invalid_input');
  const source = stage(value.source, value.current, 'source');
  const collected = stage(value.collected, value.current, 'collected');
  const ready = stage(value.identityReady, value.current, 'identityReady');
  const published = stage(value.published, value.current, 'published');
  const sourceToCollection = interval(source, collected, tolerance);
  const collectionToIdentity = interval(collected, ready, tolerance);
  const identityToPublication = collectionToIdentity.status === 'measured'
    ? interval(ready, published, tolerance) : metric('unknown', 'readiness_order_unverified');
  const sourceToPublication = publicationInterval(sourceToCollection, collectionToIdentity,
    identityToPublication, collected, published, tolerance);
  return { schema: 'message_latency/v1',
    evidence: [source, collected, ready, published].some(item => item.status === 'invalid_evidence') ? 'invalid' : 'accepted',
    delayCause: 'unclassified', sourceToCollection, collectionToIdentity, identityToPublication, sourceToPublication };
}

/** @param {Metric} value @param {number} thresholdMs */
function classifyLatency(value, thresholdMs) {
  if (!integer(thresholdMs) || value?.status !== 'measured'
    || !monotonic(value.minimumMs) || !monotonic(value.maximumMs)
    || /** @type {number} */ (value.minimumMs) > /** @type {number} */ (value.maximumMs)) return 'unknown';
  if (/** @type {number} */ (value.maximumMs) <= thresholdMs) return 'within';
  if (/** @type {number} */ (value.minimumMs) > thresholdMs) return 'exceeded';
  return 'straddles';
}

/** @param {number} startMs @param {number} endMs @param {number} limitMs */
function measureMonotonicBudget(startMs, endMs, limitMs) {
  if (!monotonic(startMs) || !monotonic(endMs) || !integer(limitMs) || endMs < startMs)
    return { status: 'invalid', elapsedMs: null, remainingMs: null };
  const elapsedMs = endMs - startMs;
  return { status: elapsedMs >= limitMs ? 'exhausted' : 'within', elapsedMs,
    remainingMs: Math.max(0, limitMs - elapsedMs) };
}

export { measureMessageLatency, classifyLatency, measureMonotonicBudget };
