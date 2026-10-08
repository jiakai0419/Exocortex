// @ts-check
import { databaseActivityEvidence } from "./lark-im-activity-evidence.mjs";

/**
 * @typedef {Record<string, any>} Row
 *
 * @typedef {object} ScopeCounts
 * @property {number | string=} received_without_cursor
 * @property {number | string=} message_enabled
 * @property {number | string=} message_without_success
 *
 * @typedef {object} HealthStateInput
 * @property {{has_more?: boolean} | null | undefined} discoveryCursor
 * @property {ScopeCounts} scopeCounts
 * @property {Row[]} locks
 * @property {Row[]} runCounts
 * @property {{evidence?: string, pending_count?: number | null}=} details
 * @property {number=} actionableFailedRuns
 *
 * @typedef {"unknown" | "syncing" | "catching_up" | "not_ready" | "needs_attention" | "ok_with_history" | "ok"} HealthState
 */

/**
 * @param {Row[]} rows
 * @param {string} keyName
 * @param {string} valueName
 * @returns {Record<string, number>}
 */
function countBy(rows, keyName, valueName) {
  /** @type {Record<string, number>} */
  const result = {};
  for (const row of rows) result[row[keyName] || "unknown"] = Number(row[valueName] || 0);
  return result;
}

/**
 * @param {HealthStateInput} input
 * @returns {HealthState}
 */
function summarizeHealth({ discoveryCursor, scopeCounts, locks, runCounts, details, actionableFailedRuns }) {
  const running = Number(countBy(runCounts, "status", "count").running || 0);
  const failed = typeof actionableFailedRuns === "number" && Number.isSafeInteger(actionableFailedRuns) && actionableFailedRuns >= 0
    ? actionableFailedRuns : Number(countBy(runCounts, "status", "count").failed || 0);
  const succeeded = Number(countBy(runCounts, "status", "count").succeeded || 0);
  const receivedWithoutCursor = Number(scopeCounts.received_without_cursor || 0);
  if (details?.evidence === "unavailable") return "needs_attention";
  if (Number(details?.pending_count || 0) > 0) return "catching_up";
  if (databaseActivityEvidence(locks, running).reason === "unverified_sync_history") return "unknown";
  if (succeeded === 0 && failed > 0) return "needs_attention";
  if (succeeded === 0 || Number(scopeCounts.message_enabled || 0) === 0) return "not_ready";
  if (receivedWithoutCursor > 0 || discoveryCursor?.has_more === true) return "catching_up";
  if (discoveryCursor?.has_more !== false || Number(scopeCounts.message_without_success || 0) > 0) return "not_ready";
  if (failed > 0) return "ok_with_history";
  return "ok";
}

/** @param {HealthStateInput} input */
function healthDetail({ discoveryCursor, scopeCounts, locks, runCounts, details, actionableFailedRuns }) {
  const health = summarizeHealth({ discoveryCursor, scopeCounts, locks, runCounts, details, actionableFailedRuns });
  if (details?.evidence === "unavailable") return "message detail evidence is unavailable";
  if (Number(details?.pending_count || 0) > 0) return `${details?.pending_count} message details await retry; list progress does not prove full content`;
  if (health === "not_ready") return "initial discovery or successful message-scope evidence is missing";
  if (health === "needs_attention") return "sync history contains failures but no successful run";
  const running = Number(countBy(runCounts, "status", "count").running || 0);
  const receivedWithoutCursor = Number(scopeCounts.received_without_cursor || 0);
  if (databaseActivityEvidence(locks, running).reason === "unverified_sync_history") return "unfinished sync history requires current process and phase evidence";
  if (discoveryCursor?.has_more === true && receivedWithoutCursor > 0) {
    return `initial catch-up: discovery still has more pages, ${receivedWithoutCursor} chat scopes need cursors`;
  }
  if (discoveryCursor?.has_more === true) return "initial catch-up: discovery still has more pages";
  if (receivedWithoutCursor > 0) {
    return `initial catch-up: ${receivedWithoutCursor} chat scopes need cursors`;
  }
  return "all known enabled scopes have cursors";
}

export {
  countBy,
  healthDetail,
  summarizeHealth,
};
