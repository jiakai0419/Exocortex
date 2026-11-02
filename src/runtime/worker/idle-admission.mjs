// @ts-check
import { REQUIRED_CYCLE_STEPS } from './step-vocabulary.mjs';

const OPERATIONS = new Set(['message_history_bundle', 'message_search_bundle', 'chat_discovery_bundle',
  'self_profile', 'contact_search', 'chat_members', 'chat_bots', 'application_info', 'other']);
const COUNTERS = ['calls', 'attempts', 'retries', 'rate_limits', 'timeouts', 'wait_ms',
  'max_retry_after_ms', 'cooldown_until_ms', 'exhausted', 'retry_after_unknown'];
const PRESSURE = COUNTERS.filter(key => key !== 'calls' && key !== 'attempts');
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const count = value => Number.isSafeInteger(value) && value >= 0;
const keysExactly = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));

/** Inspect raw transport BEFORE compaction can discard an unknown operation or
 * malformed cooldown. This is intentionally stricter than healthy-cycle policy. */
function cleanTransport(value) {
  if (!object(value) || !COUNTERS.every(key => count(value[key])) ||
      !PRESSURE.every(key => value[key] === 0) || value.attempts !== value.calls ||
      !object(value.cooldowns_by_operation) || Object.keys(value.cooldowns_by_operation).length ||
      !object(value.by_operation)) return false;
  let calls = 0, attempts = 0;
  for (const [operation, counters] of Object.entries(value.by_operation)) {
    if (!OPERATIONS.has(operation) || !object(counters) || !COUNTERS.every(key => count(counters[key])) ||
        !PRESSURE.every(key => counters[key] === 0) || counters.attempts !== counters.calls) return false;
    calls += counters.calls; attempts += counters.attempts;
  }
  return Number.isSafeInteger(calls) && calls === value.calls && attempts === value.attempts;
}

function provedBackoff(run) {
  const proof = run?.idle_detail_backoff;
  return object(run) && run.ok === false && run.incomplete === true && run.list_complete === true &&
    run.details_complete === false && count(run.pending_details) && run.pending_details > 0 &&
    !run.skipped && !run.fail_run_error && !run.lock_release_error &&
    (run.conflicts === undefined || run.conflicts === 0) &&
    keysExactly(proof, ['version', 'kind', 'pending_details', 'detail_attempts']) && proof.version === 1 &&
    proof.kind === 'saved_list_backoff' && proof.pending_details === run.pending_details && proof.detail_attempts === 0 &&
    keysExactly(run.detail_retry, ['ok', 'skipped', 'reason', 'detail_attempts']) &&
    run.detail_retry.ok === false && run.detail_retry.skipped === true &&
    run.detail_retry.reason === 'details_not_due' && run.detail_retry.detail_attempts === 0;
}

/** Derive a finite observation from trusted CLI producer fields, not error text.
 * Call on the original summary, never on the lossy compact received aggregate. */
export function compactIdleEvidence(summary) {
  if (!object(summary) || !cleanTransport(summary.transport)) return null;
  const evidence = { version: 1, transport_clean: true };
  if (summary.ok !== false || summary.partial !== true || summary.incomplete !== true ||
      (summary.details !== undefined && (!Array.isArray(summary.details) || summary.details.length > 0)) ||
      (summary.received !== undefined && !Array.isArray(summary.received))) return evidence;
  const runs = [summary.sent, summary.discovery, ...(summary.received || [])].filter(run => run != null);
  let pending = 0, failed = 0;
  for (const run of runs) {
    if (!object(run) || run.skipped || run.fail_run_error || run.lock_release_error ||
        (run.conflicts !== undefined && run.conflicts !== 0)) return evidence;
    if (run.ok === true && run.incomplete !== true && (!run.pending_details || run.pending_details === 0)) continue;
    if (!provedBackoff(run)) return evidence;
    failed += 1; pending += run.pending_details;
  }
  if (!failed || !count(pending) || pending === 0) return evidence;
  return { ...evidence, detail_backoff: { version: 1, failed_runs: failed, pending_details: pending } };
}

function healthy(step) {
  return step?.ok === true && step.summary?.received?.ok !== false &&
    step.summary?.sent?.ok !== false && step.summary?.discovery?.ok !== false;
}

/** Optional-work admission never changes forward health or grants a new budget.
 * Worker owns process provenance and applies the returned lane allowlist. */
export function idleAdmission(steps) {
  if (!Array.isArray(steps) || !REQUIRED_CYCLE_STEPS.every(name => steps.filter(step => step?.name === name).length === 1) ||
      steps.some(step => !REQUIRED_CYCLE_STEPS.includes(step?.name) && step?.name !== 'retention')) {
    return { mode: 'none', why: 'missing_forward_receipts' };
  }
  if (steps.every(healthy)) return { mode: 'all', why: 'healthy_forward' };
  for (const step of steps) {
    const expectedExit = healthy(step) ? 0 : 2;
    if (!object(step) || step.exit_code !== expectedExit || step.guardian_diagnostic || step.stderr ||
        (!healthy(step) && (step.ok !== false || step.partial !== true || step.summary?.ok !== false ||
          step.summary?.partial !== true || step.summary?.incomplete !== true))) {
      return { mode: 'none', why: 'untrusted_forward_failure' };
    }
    // Retention is local, but must have finished normally before optional work.
    if (step.name === 'retention') {
      if (!healthy(step)) return { mode: 'none', why: 'untrusted_forward_failure' };
      continue;
    }
    const evidence = step.summary?.idle_evidence;
    if (!object(evidence) || evidence.version !== 1 || evidence.transport_clean !== true ||
        Object.keys(evidence).some(key => !['version', 'transport_clean', 'detail_backoff'].includes(key)) ||
        !cleanTransport(step.summary?.transport)) return { mode: 'none', why: 'transport_not_clean' };
    if (!healthy(step)) {
      const proof = evidence.detail_backoff;
      if (!keysExactly(proof, ['version', 'failed_runs', 'pending_details']) || proof.version !== 1 ||
          !count(proof.failed_runs) || proof.failed_runs < 1 || !count(proof.pending_details) || proof.pending_details < 1) {
        return { mode: 'none', why: 'untrusted_forward_failure' };
      }
    }
  }
  return { mode: 'known_records', why: 'saved_list_detail_backoff' };
}
