// @ts-check

/**
 * @typedef {Record<string, any>} Row
 *
 * @typedef {object} ScopeCounts
 * @property {number | string=} received_without_cursor
 *
 * @typedef {object} HealthStateInput
 * @property {{has_more?: boolean} | null | undefined} discoveryCursor
 * @property {ScopeCounts} scopeCounts
 * @property {Row[]} locks
 * @property {Row[]} runCounts
 *
 * @typedef {"syncing" | "catching_up" | "ok_with_history" | "ok"} HealthState
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
function summarizeHealth({ discoveryCursor, scopeCounts, locks, runCounts }) {
  const running = Number(countBy(runCounts, "status", "count").running || 0);
  const failed = Number(countBy(runCounts, "status", "count").failed || 0);
  const receivedWithoutCursor = Number(scopeCounts.received_without_cursor || 0);
  if (locks.length > 0 || running > 0) return "syncing";
  if (receivedWithoutCursor > 0 || discoveryCursor?.has_more === true) return "catching_up";
  if (failed > 0) return "ok_with_history";
  return "ok";
}

/** @param {HealthStateInput} input */
function healthDetail({ discoveryCursor, scopeCounts, locks, runCounts }) {
  const running = Number(countBy(runCounts, "status", "count").running || 0);
  const receivedWithoutCursor = Number(scopeCounts.received_without_cursor || 0);
  if (locks.length > 0 || running > 0) return "worker is currently syncing";
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
