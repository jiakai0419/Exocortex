// @ts-check

/** @typedef {Record<string, any>} JsonObject */

/** A database snapshot proves readiness, never process liveness.
 * @param {JsonObject | null} sync
 */
function isLocalReady(sync) {
  return Boolean(sync && ["ok", "ok_with_history"].includes(sync.health) &&
    sync.details?.evidence === "available" && sync.details.pending_count === 0 &&
    sync.list_progress?.evidence === "available" && sync.list_progress.invalid_cursor_scopes === 0);
}

/** One acceptance predicate shared by polling and the final check. A cycle
 * completed before invocation cannot satisfy an explicit wait.
 * @param {number} startedAt @param {JsonObject | null} syncStatus
 * @param {JsonObject} workerSummary @param {JsonObject} service
 */
function evaluateWaitState(startedAt, syncStatus, workerSummary, service) {
  const cycle = workerSummary.last_cycle;
  const at = Date.parse(String(cycle?.at || ""));
  const began = Date.parse(String(cycle?.started_at || ""));
  const newOkCycle = cycle?.ok === true && cycle?.complete === true && Number.isFinite(at) && at > startedAt && Number.isFinite(began) && began >= startedAt;
  const healthReady = isLocalReady(syncStatus);
  const running = service.status === "running" && service.target_match === "matched";
  const ready = running && newOkCycle && healthReady && !workerSummary.in_progress && !workerSummary.unfinished_cycle;
  return { ready: Boolean(ready), newOkCycle, healthReady, running,
    reason: !running ? "service_not_running_or_target_unverified" : !newOkCycle ? "new_complete_cycle_required"
      : workerSummary.in_progress || workerSummary.unfinished_cycle ? "unfinished_cycle" : !healthReady ? "local_not_ready" : "ready" };
}

export { evaluateWaitState, isLocalReady };
