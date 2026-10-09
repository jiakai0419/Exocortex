// @ts-check
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, renameSync, unlinkSync, fsyncSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { readStableJsonFile } from '../diagnostics/private-json-file.mjs';
import { tryAcquireLarkApiLease } from '../runtime/lark-api-lease.mjs';
import { activityDatabaseKey } from '../diagnostics/lark-im-activity-evidence.mjs';
import { executeEnrichment } from './enrich.mjs';
import { executeLarkImReplay, validateReplayOptions } from './replay.mjs';
import { createMaintenanceRequestSession, MaintenanceRequestError } from './request-session.mjs';
import { publishReviewArtifact, reuseMaintenanceReview, MaintenanceReviewError, REVIEW_MAX_BYTES } from './review-artifact.mjs';

const PLAN_SCHEMA = 'exocortex_private_preview_plan/v1';
const PROGRESS_SCHEMA = 'exocortex_private_preview_progress/v1';
const MAX_RUNS = 100;
const BUSY_DELAYS = [2000, 4000];
const REASONS = new Set(['invalid_plan', 'invalid_progress', 'unsafe_path', 'progress_busy', 'progress_unavailable',
  'progress_write_failed', 'review_rejected', 'unit_failed', 'cli_budget', 'time_budget', 'clock_unavailable',
  'sync_busy', 'lease_unavailable', 'rate_cooldown', 'rate_limited', 'shared_cooldown_unavailable']);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const count = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
class PreviewUnitsError extends Error {
  constructor(reason) { super(`maintenance preview stopped: ${REASONS.has(reason) ? reason : 'unit_failed'}`); this.name = 'PreviewUnitsError'; this.reason = REASONS.has(reason) ? reason : 'unit_failed'; }
}
/** @returns {never} */
function fail(reason) { throw new PreviewUnitsError(reason); }
function safeReason(error) {
  return error instanceof PreviewUnitsError || error instanceof MaintenanceRequestError ? error.reason
    : error instanceof MaintenanceReviewError ? 'review_rejected' : 'unit_failed';
}
function privateDirectory(path) {
  try {
    const full = resolve(path), info = lstatSync(full);
    if (realpathSync(full) !== full || !info.isDirectory() || info.isSymbolicLink()
      || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) fail('unsafe_path');
    return full;
  } catch { fail('unsafe_path'); }
}
/** Separate coordination descriptor: never register it as an API lease or pass
 * it to lark-cli. Process death releases it without PID or stale-file recovery. */
function acquireProgressLease(directory, deadline, monotonicClock) {
  const path = join(directory, 'coordinator.lock');
  let fd;
  try {
    fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) fail('progress_unavailable');
    const until = Math.min(deadline, monotonicClock() + 2000), timeout = Math.floor(until - monotonicClock());
    if (timeout < 1) fail('time_budget');
    const result = spawnSync('python3', ['-B', fileURLToPath(new URL('../runtime/lark-api-flock.py', import.meta.url))],
      { stdio: ['ignore', 'ignore', 'ignore', fd], timeout, killSignal: 'SIGKILL' });
    if (result.error || result.signal || monotonicClock() >= until) fail('progress_unavailable');
    if (result.status !== 0) fail(result.status === 75 ? 'progress_busy' : 'progress_unavailable');
    const current = lstatSync(path);
    if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) fail('progress_unavailable');
    const held = fd;
    return () => closeSync(held);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error instanceof PreviewUnitsError) throw error;
    fail('progress_unavailable');
  }
}
function readPlan(path) {
  privateDirectory(dirname(resolve(path)));
  const loaded = readStableJsonFile(resolve(path), { maxBytes: 256 * 1024 });
  const plan = loaded.value;
  if (loaded.status !== 'ready' || !exact(plan, ['schema', 'units']) || plan.schema !== PLAN_SCHEMA
    || !Array.isArray(plan.units) || !positive(plan.units.length, 100)) fail('invalid_plan');
  const selections = new Set();
  for (const unit of plan.units) {
    const names = unit?.mode === 'names';
    if (!exact(unit, names ? ['mode', 'record_ids', 'max_cli_attempts', 'max_seconds']
      : ['mode', 'scope_id', 'message_ids', 'start', 'end', 'max_cli_attempts', 'max_seconds'])
      || !['names', 'replay'].includes(unit.mode) || !positive(unit.max_cli_attempts, 1000) || !positive(unit.max_seconds, 180)) fail('invalid_plan');
    const ids = names ? unit.record_ids : unit.message_ids;
    if (!Array.isArray(ids) || !positive(ids.length, 100) || new Set(ids).size !== ids.length
      || ids.some(id => names ? !positive(id, Number.MAX_SAFE_INTEGER)
        : typeof id !== 'string' || !id || id !== id.trim() || id.length > 512 || id.includes('\0'))) fail('invalid_plan');
    if (!names && (typeof unit.scope_id !== 'string' || !unit.scope_id || unit.scope_id.length > 512 || unit.scope_id.includes('\0')
      || typeof unit.start !== 'string' || typeof unit.end !== 'string')) fail('invalid_plan');
    // Repeating a target in one mode would make "completed means no new API"
    // ambiguous. Names and replay are separate repair operations.
    for (const id of ids) {
      const key = `${unit.mode}:${id}`;
      if (selections.has(key)) fail('invalid_plan');
      selections.add(key);
    }
  }
  return { plan, sha256: loaded.sha256 };
}
function unitOptions(unit, db, reviewOut) {
  const common = { db, apply: false, reviewOut, maxCliAttempts: unit.max_cli_attempts, maxSeconds: unit.max_seconds };
  if (unit.mode === 'names') return { ...common, target: 'records', namesOnly: true, recordIds: unit.record_ids };
  try { return validateReplayOptions({ ...common, scopeIds: [unit.scope_id], messageIds: unit.message_ids, start: unit.start, end: unit.end }); }
  catch { fail('invalid_plan'); }
}
function validateProgress(value, identity, units) {
  if (!exact(value, ['schema', 'plan_sha256', 'database_key', 'limits', 'units', 'runs']) || value.schema !== PROGRESS_SCHEMA
    || value.plan_sha256 !== identity.plan_sha256 || value.database_key !== identity.database_key
    || !exact(value.limits, ['max_cli_attempts', 'max_seconds'])
    || value.limits.max_cli_attempts !== identity.limits.max_cli_attempts || value.limits.max_seconds !== identity.limits.max_seconds
    || !Array.isArray(value.units) || value.units.length !== units || !Array.isArray(value.runs) || value.runs.length > MAX_RUNS) fail('invalid_progress');
  for (const unit of value.units) if (!exact(unit, ['state', 'review_sha256', 'partial'])
    || !['pending', 'reviewed'].includes(unit.state) || typeof unit.partial !== 'boolean'
    || (unit.state === 'reviewed' ? !hash(unit.review_sha256) : unit.review_sha256 !== null || unit.partial)) fail('invalid_progress');
  const ids = new Set();
  for (const run of value.runs) {
    if (!exact(run, ['id', 'cli_attempts_charged', 'elapsed_ms', 'status', 'stop_reason'])
      || typeof run.id !== 'string' || !/^[a-f0-9-]{36}$/.test(run.id) || ids.has(run.id)
      || !count(run.cli_attempts_charged) || run.cli_attempts_charged > value.limits.max_cli_attempts
      || !count(run.elapsed_ms) || !['running', 'completed', 'stopped', 'interrupted'].includes(run.status)
      || !(run.stop_reason === null || REASONS.has(run.stop_reason))) fail('invalid_progress');
    ids.add(run.id);
  }
}
/** Explicit independent preview units; this manifest is never an approval and
 * never contains raw proposed values. An explicit resume receives a new command
 * budget; previous charged attempts and elapsed lower bounds remain visible.
 * @param {Record<string,any>} options @param {Record<string,any>} [deps] */
function executePreviewUnits(options, deps = {}) {
  if (!options.db || !options.plan || !options.progressDir || options.apply
    || !positive(options.maxCliAttempts, 1000) || !positive(options.maxSeconds, 180)) fail('invalid_plan');
  const monotonicClock = deps.requestSessionDeps?.monotonicClock || (() => performance.now());
  const sleep = deps.requestSessionDeps?.sleep || (ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const now = deps.now || Date.now, started = monotonicClock(), deadline = started + options.maxSeconds * 1000;
  let stop = null;
  function elapsed() {
    const current = monotonicClock();
    if (!Number.isFinite(started) || !Number.isFinite(current) || current < started) fail('clock_unavailable');
    return current;
  }
  const assertInvocationReady = () => { if (elapsed() >= deadline) fail('time_budget'); };
  const directory = privateDirectory(options.progressDir), db = resolve(options.db);
  const { plan, sha256 } = readPlan(options.plan);
  const configured = plan.units.map((unit, index) => unitOptions(unit, db, join(directory, `unit-${String(index + 1).padStart(3, '0')}.review.json`)));
  const databaseKey = activityDatabaseKey(db);
  if (!databaseKey) fail('invalid_plan');
  const identity = { plan_sha256: sha256, database_key: databaseKey, limits: { max_cli_attempts: options.maxCliAttempts, max_seconds: options.maxSeconds } };
  const release = acquireProgressLease(directory, deadline, monotonicClock);
  try {
    const manifestPath = join(directory, 'manifest.json');
    const loaded = readStableJsonFile(manifestPath, { maxBytes: REVIEW_MAX_BYTES });
    let manifestHash = loaded.sha256;
    if (options.resume ? loaded.status !== 'ready' : loaded.status !== 'missing') fail('invalid_progress');
    const manifest = options.resume ? loaded.value : { schema: PROGRESS_SCHEMA, ...identity,
      units: plan.units.map(() => ({ state: 'pending', review_sha256: null, partial: false })), runs: [] };
    validateProgress(manifest, identity, plan.units.length);
    if (manifest.runs.length >= MAX_RUNS) fail('invalid_progress');
    const previous = { invocations: manifest.runs.length,
      cli_attempts_charged: manifest.runs.reduce((n, run) => n + run.cli_attempts_charged, 0),
      elapsed_ms_lower_bound: manifest.runs.reduce((n, run) => n + run.elapsed_ms, 0),
      interrupted_invocations: manifest.runs.filter(run => ['running', 'interrupted'].includes(run.status)).length };
    for (const run of manifest.runs) if (run.status === 'running') run.status = 'interrupted';
    const current = { id: randomUUID(), cli_attempts_charged: 0, elapsed_ms: 0, status: 'running', stop_reason: /** @type {string|null} */ (null) };
    const save = () => {
      current.elapsed_ms = Math.max(current.elapsed_ms, Math.floor(elapsed() - started));
      const existing = readStableJsonFile(manifestPath, { maxBytes: REVIEW_MAX_BYTES });
      if (manifestHash ? existing.status !== 'ready' || existing.sha256 !== manifestHash : existing.status !== 'missing') fail('invalid_progress');
      const staging = join(directory, `.progress-${randomUUID()}.json`);
      try {
        const nextHash = publishReviewArtifact(staging, manifest);
        renameSync(staging, manifestPath);
        const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { fsyncSync(fd); } finally { closeSync(fd); }
        manifestHash = nextHash;
      } catch { fail('progress_write_failed'); }
      finally { try { unlinkSync(staging); } catch { /* Only our own staging path. */ } }
    };
    let reused = 0;
    // All persisted results are validated before the first remote request,
    // including orphans published just before an interrupted manifest update.
    for (const [index, opts] of configured.entries()) {
      assertInvocationReady();
      const artifact = readStableJsonFile(opts.reviewOut, { maxBytes: REVIEW_MAX_BYTES });
      if (artifact.status === 'missing' && manifest.units[index].state === 'pending') continue;
      if (!options.resume || artifact.status !== 'ready') fail('invalid_progress');
      const review = reuseMaintenanceReview(opts, { db, mode: plan.units[index].mode, now,
        expectedSha256: manifest.units[index].review_sha256 || artifact.sha256 });
      assertInvocationReady();
      manifest.units[index] = { state: 'reviewed', review_sha256: review.sha256, partial: review.partial };
      reused++;
    }
    assertInvocationReady();
    manifest.runs.push(current);
    save();
    let actualAttempts = 0, completed = 0, busyRetries = 0, lastFinished = -Infinity;
    const assertBudget = (unitDeadline = deadline) => {
      if (stop) fail(stop);
      if (elapsed() >= Math.min(deadline, unitDeadline)) { stop = 'time_budget'; fail(stop); }
    };
    const pause = (ms, unitDeadline = deadline) => {
      assertBudget(unitDeadline);
      if (elapsed() + ms >= Math.min(deadline, unitDeadline)) { stop = 'time_budget'; fail(stop); }
      const before = elapsed(); sleep(ms); assertBudget(unitDeadline);
      if (elapsed() <= before) { stop = 'clock_unavailable'; fail(stop); }
    };
    try {
      for (const [index, opts] of configured.entries()) {
        if (manifest.units[index].state === 'reviewed') continue;
        assertBudget();
        const gap = Math.max(0, lastFinished + 1000 - elapsed());
        if (gap) pause(gap);
        // Fixed review constraints never shrink to fit a remaining command.
        if (options.maxCliAttempts - actualAttempts < opts.maxCliAttempts) fail('cli_budget');
        if (deadline - elapsed() < opts.maxSeconds * 1000) fail('time_budget');
        const unitDeadline = elapsed() + opts.maxSeconds * 1000;
        let unitAttempts = 0;
        for (let attempt = 0; ; attempt++) {
          assertBudget(unitDeadline);
          if (unitAttempts >= opts.maxCliAttempts) fail('cli_budget');
          const requestDeps = deps.requestSessionDeps || {};
          const session = createMaintenanceRequestSession({ db, maxCliAttempts: opts.maxCliAttempts - unitAttempts,
            maxSeconds: Math.max(1, Math.ceil((unitDeadline - elapsed()) / 1000)) }, {
            ...requestDeps, env: deps.env || requestDeps.env, now, monotonicClock,
            sleep: ms => pause(ms, unitDeadline),
            tryAcquireLease: request => (requestDeps.tryAcquireLease || tryAcquireLarkApiLease)({ ...request,
              monotonicDeadlineMs: Math.min(request.monotonicDeadlineMs, unitDeadline, deadline) }),
            spawnSync(command, args, settings) {
              try {
                assertBudget(unitDeadline);
                if (actualAttempts >= options.maxCliAttempts || unitAttempts >= opts.maxCliAttempts) fail('cli_budget');
                // Charge durably before spawn. A crash in between may overcount
                // one attempt; it can never conceal already admitted API work.
                current.cli_attempts_charged++; save(); assertBudget(unitDeadline);
                const remaining = Math.floor(Math.min(deadline, unitDeadline) - elapsed());
                if (remaining < 1) fail('time_budget');
                actualAttempts++; unitAttempts++;
                return (requestDeps.spawnSync || spawnSync)(command, args, { ...settings, timeout: Math.min(settings.timeout, remaining) });
              } catch (error) {
                if (error instanceof PreviewUnitsError) stop ||= error.reason;
                throw error;
              }
            },
          });
          if (attempt > 0) busyRetries++;
          const ready = () => { session.assertReady(); assertBudget(unitDeadline); };
          // The native session remains the sole API/cooldown/lease owner.
          const bounded = { runLark(args, settings) {
            const before = actualAttempts;
            try { return session.runLark(args, settings); }
            finally { if (actualAttempts !== before) lastFinished = elapsed(); }
          }, assertReady: ready, summary: session.summary };
          let report, failure;
          try {
            report = plan.units[index].mode === 'names'
              ? executeEnrichment(opts, { runLark: bounded.runLark, assertReady: bounded.assertReady, now })
              : executeLarkImReplay(opts, { createRequestSession: () => bounded, now });
            if (report.ok === false || !report.review) failure = stop || session.summary().stop_reason || 'unit_failed';
          } catch (error) { failure = stop || session.summary().stop_reason || safeReason(error); }
          if (!failure) {
            manifest.units[index] = { state: 'reviewed', review_sha256: report.review.sha256, partial: Boolean(report.partial || report.review.partial) };
            completed++; save(); break;
          }
          save();
          if (failure !== 'sync_busy' || attempt >= BUSY_DELAYS.length) fail(failure);
          pause(BUSY_DELAYS[attempt], unitDeadline);
        }
      }
      if (completed === 0) assertBudget();
    } catch (error) { stop ||= safeReason(error); }
    current.status = stop ? 'stopped' : 'completed'; current.stop_reason = stop;
    save();
    const reviewed = manifest.units.filter(unit => unit.state === 'reviewed').length;
    const partial = reviewed !== plan.units.length || manifest.units.some(unit => unit.partial);
    return { ok: !stop, dry_run: true, partial, units: plan.units.length, reviewed, completed_this_invocation: completed,
      reused_local_reviews: reused, reuse_policy: 'unexpired_local_review_evidence_not_remote_revalidation',
      stop_reason: stop, busy_retries: busyRetries, previous_invocations: previous,
      request_budget: { max_cli_attempts: options.maxCliAttempts, cli_attempts: actualAttempts,
        cli_attempts_charged: current.cli_attempts_charged, max_seconds: options.maxSeconds, elapsed_ms: current.elapsed_ms,
        scope: 'this_explicit_invocation', stop_reason: stop } };
  } finally { release(); }
}

export { executePreviewUnits, PreviewUnitsError, PLAN_SCHEMA, PROGRESS_SCHEMA };
