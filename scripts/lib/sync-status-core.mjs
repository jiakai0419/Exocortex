function countBy(rows, keyName, valueName) {
  const result = {};
  for (const row of rows) result[row[keyName] || "unknown"] = Number(row[valueName] || 0);
  return result;
}

function summarizeHealth({ discoveryCursor, scopeCounts, locks, runCounts }) {
  const running = Number(countBy(runCounts, "status", "count").running || 0);
  const failed = Number(countBy(runCounts, "status", "count").failed || 0);
  const receivedWithoutCursor = Number(scopeCounts.received_without_cursor || 0);
  if (locks.length > 0 || running > 0) return "syncing";
  if (receivedWithoutCursor > 0 || discoveryCursor?.has_more === true) return "catching_up";
  if (failed > 0) return "ok_with_history";
  return "ok";
}

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
