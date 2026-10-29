// @ts-check
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import { liveProbeContext } from '../../diagnostics/live-probe-cache.mjs';
import { validateJsonObjectText } from '../../../dist/core/json-text-patch.js';

const MAX_BYTES = 64 * 1024, MAX_ENTRIES = 128, ALLOW_MS = 24 * 60 * 60_000;
/** @param {unknown} value @returns {value is Record<string, any>} */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @param {string[]} keys @returns {value is Record<string, any>} */
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const clock = value => Number.isSafeInteger(value) && value >= 0;
const actor = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && value.trim() === value && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
const sameFile = (a, b) => ['dev','ino','mode','uid','nlink','size','mtimeNs','ctimeNs']
  .every(key => a[key] === b[key]);

/** Messages contain only finite local failure categories, never paths or entries. */
class NameRecoveryReviewError extends Error {
  constructor(reason) {
    super(`name recovery review: ${reason.replaceAll('_', ' ')}`);
    this.name = 'NameRecoveryReviewError';
    this.code = `name_recovery_review_${reason}`;
  }
}
/** @param {string} reason @returns {never} */
function fail(reason) { throw new NameRecoveryReviewError(reason); }
function safeFile(file) {
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1n || typeof process.getuid !== 'function'
    || file.uid !== BigInt(process.getuid()) || (file.mode & 0o7777n) !== 0o600n) fail('unsafe_file');
  if (file.size < 0n || file.size > BigInt(MAX_BYTES)) fail('invalid');
}

/** Local review policy only: no API response, permission proof or name authority.
 * @param {unknown} value @param {string} databaseKey @param {string} accountKey @param {number} nowMs
 */
function validateNameRecoveryReview(value, databaseKey, accountKey, nowMs) {
  if (!clock(nowMs) || !digest(databaseKey) || !digest(accountKey)) fail('invalid_context');
  if (!exact(value, ['kind','context','review_kind','reviewed_at','entries'])
    || value.kind !== 'lark_name_recovery_review/v1' || value.review_kind !== 'local_evidence_review'
    || !exact(value.context, ['source_id','database_key','account_key'])
    || value.context.source_id !== 'lark.im' || !digest(value.context.database_key)
    || !digest(value.context.account_key) || !Array.isArray(value.entries)
    || value.entries.length > MAX_ENTRIES) fail('invalid');
  if (value.context.database_key !== databaseKey) fail('database_mismatch');
  if (value.context.account_key !== accountKey) fail('account_mismatch');
  const reviewedAt = typeof value.reviewed_at === 'string' ? Date.parse(value.reviewed_at) : NaN;
  if (!clock(reviewedAt) || reviewedAt > nowMs || new Date(reviewedAt).toISOString() !== value.reviewed_at) fail('invalid_clock');
  const entries = new Map();
  for (const entry of value.entries) {
    if (!exact(entry, ['namespace','actor_id','decision']) || entry.namespace !== 'app_id'
      || !actor(entry.actor_id) || !['hold','retry_unknown'].includes(entry.decision)
      || entries.has(entry.actor_id)) fail('invalid');
    entries.set(entry.actor_id, entry.decision);
  }
  return { reviewedAt, entries };
}

/** Missing means no acceleration permission. Invalid means no request may use
 * this review. The caller retains account admission, route holds, budgets and
 * claim CAS. External replacement requires writer quiescence: filesystem checks
 * are not atomic with a database transaction or the following network request.
 * @param {string} db @param {string} accountKey @param {number} [nowMs]
 */
function readNameRecoveryReview(db, accountKey, nowMs = Date.now()) {
  if (!digest(accountKey) || !clock(nowMs)) fail('invalid_context');
  let path;
  try { path = realpathSync(db); } catch { return fail('database_mismatch'); }
  const databaseKey = liveProbeContext(path)?.database_key;
  if (!databaseKey || liveProbeContext(db)?.database_key !== databaseKey) fail('database_mismatch');
  const sidecar = `${path}.name-recovery-review.json`;
  let before;
  try { before = lstatSync(sidecar, { bigint: true }); }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return null;
    return fail('unreadable');
  }
  safeFile(before);
  let fd, policy;
  try {
    fd = openSync(sidecar, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd, { bigint: true });
    safeFile(opened);
    if (!sameFile(before, opened)) fail('changed');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > MAX_BYTES || BigInt(length) !== opened.size
      || !sameFile(opened, fstatSync(fd, { bigint: true }))
      || !sameFile(opened, lstatSync(sidecar, { bigint: true }))) fail('changed');
    let value;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
      validateJsonObjectText(text);
      value = JSON.parse(text);
    } catch { return fail('invalid'); }
    policy = validateNameRecoveryReview(value, databaseKey, accountKey, nowMs);
    before = opened;
  } catch (error) {
    if (error instanceof NameRecoveryReviewError) throw error;
    return fail('unreadable');
  } finally { if (fd !== undefined) closeSync(fd); }
  let lastNow = nowMs;
  const assertCurrent = (atMs = Date.now()) => {
    if (!clock(atMs) || atMs < lastNow) fail('invalid_clock');
    if (liveProbeContext(db)?.database_key !== databaseKey || liveProbeContext(path)?.database_key !== databaseKey)
      fail('database_mismatch');
    let current;
    try { current = lstatSync(sidecar, { bigint: true }); } catch { return fail('changed'); }
    safeFile(current);
    if (!sameFile(before, current)) fail('changed');
    lastNow = atMs;
  };
  const decision = task => object(task) && task.source_id === 'lark.im' && task.account_key === accountKey
    && task.kind === 'sender' && task.namespace === 'app_id' && actor(task.actor_id)
    ? policy.entries.get(task.actor_id) : undefined;
  // These bounded SQL candidate lists are not request grants. Callers still
  // check the current snapshot and positive expiry immediately before use.
  const retryUnknownActors = Object.freeze([...policy.entries].filter(([, value]) => value === 'retry_unknown').map(([id]) => id));
  const heldActors = Object.freeze([...policy.entries].filter(([, value]) => value === 'hold').map(([id]) => id));
  assertCurrent(nowMs);
  return Object.freeze({
    get retryUnknownActors() { return retryUnknownActors; },
    get heldActors() { return heldActors; },
    assertCurrent,
    canAccelerate(task, atMs = Date.now()) {
      assertCurrent(atMs);
      return atMs - policy.reviewedAt < ALLOW_MS && decision(task) === 'retry_unknown';
    },
    isHeld(task, atMs = Date.now()) {
      assertCurrent(atMs);
      return decision(task) === 'hold';
    },
  });
}

export { readNameRecoveryReview, validateNameRecoveryReview, NameRecoveryReviewError };
