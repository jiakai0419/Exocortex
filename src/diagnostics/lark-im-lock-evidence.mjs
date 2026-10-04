// @ts-check

import { DEFAULT_HARD_LEASE_SECONDS } from "../../dist/storage/sqlite/ingestion-store.js";

/**
 * @typedef {"invalid_timestamp" | "invalid_interval" | "future_start" | "hard_limit_exceeded" | "expired"} LeaseIssue
 * @typedef {object} LockEvidence
 * @property {"available" | "unavailable"} evidence
 * @property {string | null} observed_at
 * @property {number | null} total
 * @property {number | null} occupied_count
 * @property {number | null} abnormal_count
 * @property {{reason: LeaseIssue, count: number}[]} reasons
 */

/** @param {unknown} value */
function timestampMs(value) {
  return typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
}

/**
 * Classify only the reservation evidenced by public lease timestamps. An
 * occupied lease does not establish whether its owner process is alive. Use
 * one explicit observation clock for every row; callers own sample timing.
 * No identity, owner, raw value, or unrecognized field reaches this output.
 *
 * @param {unknown} locks
 * @param {number} nowMs
 * @returns {LockEvidence}
 */
function summarizeLockEvidence(locks, nowMs) {
  const validClock = typeof nowMs === "number" && Number.isFinite(nowMs)
    && Number.isFinite(new Date(nowMs).getTime());
  const observedAt = validClock ? new Date(nowMs).toISOString() : null;
  if (!Array.isArray(locks) || !validClock) {
    return { evidence: "unavailable", observed_at: observedAt, total: null,
      occupied_count: null, abnormal_count: null, reasons: [] };
  }

  /** @type {Map<LeaseIssue, number>} */
  const reasons = new Map();
  let occupied = 0;
  for (const lock of locks) {
    const lockedAt = timestampMs(lock?.locked_at);
    const expiresAt = timestampMs(lock?.expires_at);
    /** @type {LeaseIssue | null} */
    let reason = null;
    if (!Number.isFinite(lockedAt) || !Number.isFinite(expiresAt)) reason = "invalid_timestamp";
    else if (expiresAt <= lockedAt) reason = "invalid_interval";
    else if (lockedAt > nowMs) reason = "future_start";
    else if (nowMs >= lockedAt + DEFAULT_HARD_LEASE_SECONDS * 1000) reason = "hard_limit_exceeded";
    else if (nowMs >= expiresAt) reason = "expired";
    if (reason) reasons.set(reason, (reasons.get(reason) || 0) + 1);
    else occupied += 1;
  }
  return {
    evidence: "available",
    observed_at: observedAt,
    total: locks.length,
    occupied_count: occupied,
    abnormal_count: locks.length - occupied,
    reasons: [...reasons].map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
  };
}

export { summarizeLockEvidence };
