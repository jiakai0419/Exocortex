import { copySqliteReadDiagnostic } from "../diagnostics/sqlite-read-diagnostic.mjs";

const REASONS = new Set(['observed', 'invalid_dependencies', 'invalid_scan', 'cadence', 'contended',
  'invalid_observation', 'capacity_deferred', 'observation_failed', 'commit_unconfirmed',
  'lease_unavailable', 'account_unavailable']);
const STAGES = new Set(['admission', 'claim', 'select', 'read', 'plan', 'finish', 'release', 'dispatch']);
const KINDS = new Set(['sqlite_read', 'time_budget', 'clock_unavailable', 'invalid_response', 'unknown', 'cleanup_failed']);
const STATES = new Set(['not_started', 'confirmed', 'unknown']);
const CLEANUP = new Set(['not_required', 'succeeded', 'failed', 'unknown']);
const REQUIRED = ['reason', 'scanned', 'observed', 'deferred'];
const OPTIONAL = ['diagnostic', 'cleanup_diagnostic', 'claim_state', 'finish_state', 'cleanup_state', 'command_budget'];
const nonnegative = (value: any) => Number.isSafeInteger(value) && value >= 0;

// Do not execute accessors or copy arbitrary data from a local error or a child
// JSON result. All diagnostic strings come from fixed vocabularies.
function fields(value: unknown, required: string[], optional: string[] = []): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) return null;
    const keys = Object.keys(descriptors);
    if (required.some(key => !Object.hasOwn(descriptors, key)) || keys.some(key =>
      typeof key !== 'string' || !required.includes(key) && !optional.includes(key)
      || !Object.hasOwn(descriptors[key], 'value'))) return null;
    return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
  } catch { return null; }
}

function diagnostic(value: unknown) {
  const v = fields(value, ['version', 'stage', 'kind', 'read']);
  if (!v || v.version !== 1 || !STAGES.has(v.stage) || !KINDS.has(v.kind)) return null;
  const read = v.read === null ? null : copySqliteReadDiagnostic(v.read);
  if (v.read !== null && !read || (v.kind === 'sqlite_read') !== Boolean(read)) return null;
  return { version: 1, stage: v.stage, kind: v.kind, read };
}

function budget(value: unknown) {
  const v = fields(value, ['version', 'max_ms', 'elapsed_ms', 'stop_reason', 'complete']);
  if (!v || v.version !== 1 || v.max_ms !== 5000 || v.elapsed_ms !== null && !nonnegative(v.elapsed_ms)
    || ![null, 'time_budget', 'clock_unavailable'].includes(v.stop_reason) || typeof v.complete !== 'boolean') return null;
  return v;
}

/** Shared by the sync producer and worker consumer. Invalid child receipts are
 * omitted/replaced by their caller, never spread into a public log.
 * @param {unknown} value @returns {Record<string,any>|null} */
export function normalizeReadinessObservation(value: unknown): Record<string, any> | null {
  const v = fields(value, REQUIRED, OPTIONAL);
  if (!v || !REASONS.has(v.reason) || ['scanned', 'observed', 'deferred'].some(key =>
    !nonnegative(v[key]) || v[key] > 40) || v.observed + v.deferred !== v.scanned) return null;
  const result = Object.fromEntries(REQUIRED.map(key => [key, v[key]]));
  for (const key of ['diagnostic', 'cleanup_diagnostic']) if (Object.hasOwn(v, key)) {
    const safe = diagnostic(v[key]);
    if (!safe) return null;
    result[key] = safe;
  }
  for (const key of ['claim_state', 'finish_state']) if (Object.hasOwn(v, key)) {
    if (!STATES.has(v[key])) return null;
    result[key] = v[key];
  }
  if (Object.hasOwn(v, 'cleanup_state')) {
    if (!CLEANUP.has(v.cleanup_state)) return null;
    result.cleanup_state = v.cleanup_state;
  }
  if (Object.hasOwn(v, 'command_budget')) {
    const safe = budget(v.command_budget);
    if (!safe) return null;
    result.command_budget = safe;
  }
  // Missing states remain readable for older receipts. Explicit uncertainty
  // can never accompany a claimed successful observation or confirmed finish.
  if (v.finish_state !== undefined && v.finish_state !== 'confirmed'
      && (v.observed > 0 || v.reason === 'observed')
    || v.claim_state !== undefined && v.claim_state !== 'confirmed'
      && (v.observed > 0 || v.finish_state === 'confirmed')
    || v.reason === 'commit_unconfirmed' && v.finish_state === 'confirmed') return null;
  return result;
}
