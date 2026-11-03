import { larkWriteAdmissionSql } from "../../dist/storage/sqlite/lark-write-admission.js";
import { randomUUID } from "node:crypto";
import { acquireMaintenanceLock, quoteSql, releaseMaintenanceLock, reviewFenceSql, sqliteQuery }
  from "../../dist/storage/sqlite/ingestion-store.js";
import { MaintenanceRequestError } from "./request-session.mjs";
import { publicDiagnosticError } from "../diagnostics/public-safe.mjs";
import { HistoryCommandBudgetError, isHistoryCommandBudget } from "./history-command-budget.mjs";

class EnrichmentContentionError extends Error {}
const commitOutcomes = new WeakMap();

/** Only outcomes produced by this module may describe a bounded commit. Raw
 * errors are internal; callers must project cleanup_error through their own
 * safe diagnostic boundary, never serialize this object directly. */
function getEnrichmentCommitOutcome(value) {
  const outcome = value && typeof value === "object" ? commitOutcomes.get(value) : null;
  return outcome ? { ...outcome } : null;
}

function publicEnrichmentError(error, label) {
  // These local contention messages contain only counts and fixed text. All
  // other storage, JSON and transport failures cross the diagnostic boundary.
  const safe = error instanceof EnrichmentContentionError || error instanceof MaintenanceRequestError
    ? error.message : publicDiagnosticError(error, label).message;
  return new Error(safe, { cause: error });
}

// Both enrichment commands finish remote lookups before entering this short
// local commit. Each update carries its original-snapshot CAS and records one
// changes() value in __enrichment_effects. The lease check must stay inside the
// same BEGIN IMMEDIATE transaction as those updates.
/** @param {{dryRun:boolean,reason:string,label:string,reviewFence?:any,reviewBeforeCommit?:()=>void,writeAdmission?:any,admissionBeforeCommit?:()=>void,withCommit?:(action:()=>any)=>any,executionBudget?:any}} options */
function commitEnrichmentUpdates(dbPath, updates, options) {
  const { dryRun, reviewFence } = options;
  if (dryRun || updates.length === 0 && reviewFence === undefined) return { updated: 0, skippedConflicts: 0 };
  const commit = () => commitWithLock(dbPath, updates, options);
  return options.withCommit ? options.withCommit(commit) : commit();
}

function commitWithLock(dbPath, updates, options) {
  const { reason, label, reviewFence, reviewBeforeCommit, writeAdmission, admissionBeforeCommit, executionBudget } = options;
  if (executionBudget && !isHistoryCommandBudget(executionBudget)) throw new TypeError("invalid internal enrichment execution budget");
  const reviewSql = reviewFence === undefined ? "" : reviewFenceSql(reviewFence);
  const owner = `pid:${process.pid}:${reason}:${randomUUID()}`;
  const contention = lock => {
    if (lock.reason === "sync_locks_active") {
      throw new EnrichmentContentionError(`maintenance lock unavailable: ${lock.active_sync_locks || 0} active sync lock(s); retry shortly`);
    }
    throw new EnrichmentContentionError("maintenance lock unavailable: held by another maintenance command");
  };
  const acquire = () => acquireMaintenanceLock(dbPath, { owner, ttlSeconds: 60, reason, ...(executionBudget ? { executionBudget } : {}) });
  if (!executionBudget) {
    const lock = acquire();
    if (!lock.acquired) contention(lock);
  }
  let acquisitionAttempted = false, failed = false, primaryError, result;
  const outcome = { commit_state: "not_started", cleanup_state: "not_required" };
  try {
    if (executionBudget) {
      executionBudget.assertReady();
      acquisitionAttempted = true;
      const lock = acquire();
      if (!lock.acquired) {
        acquisitionAttempted = false;
        contention(lock);
      }
    }
    executionBudget?.assertReady();
    reviewBeforeCommit?.();
    admissionBeforeCommit?.();
    executionBudget?.assertReady();
    // From this boundary an exception may follow an actual COMMIT. Only a
    // validated returned receipt can replace unknown with confirmed.
    if (executionBudget) outcome.commit_state = "unknown";
    const effects = sqliteQuery(dbPath, `
      BEGIN IMMEDIATE;
      ${writeAdmission ? larkWriteAdmissionSql(writeAdmission) : ""}
      ${reviewSql}
      CREATE TEMP TABLE __enrichment_fence (allowed INTEGER NOT NULL CHECK (allowed = 1));
      INSERT INTO __enrichment_fence (allowed)
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM maintenance_locks
        WHERE name = 'global' AND owner = ${quoteSql(owner)}
          AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ) AND NOT EXISTS (SELECT 1 FROM sync_locks) THEN 1 ELSE 0 END;
      CREATE TEMP TABLE __enrichment_effects (updated INTEGER NOT NULL);
      ${updates.join("\n")}
      ${reviewFence === undefined ? "" : `INSERT INTO __maintenance_review_fence SELECT CASE WHEN
        (SELECT COUNT(*) FROM __enrichment_effects) = ${updates.length}
        AND (SELECT COALESCE(SUM(updated), 0) FROM __enrichment_effects) = ${updates.length}
        THEN 1 ELSE 0 END;`}
      SELECT COALESCE(SUM(updated), 0) AS updated FROM __enrichment_effects;
      COMMIT;`, label, executionBudget);
    if (executionBudget && (effects.length !== 1 || !Number.isSafeInteger(effects[0]?.updated)
      || effects[0].updated < 0 || effects[0].updated > updates.length)) {
      throw new Error("enrichment commit returned invalid evidence");
    }
    const updated = Number(effects[0]?.updated || 0);
    result = { updated, skippedConflicts: updates.length - updated };
    if (executionBudget) Object.assign(outcome, { commit_state: "confirmed", ...result });
  } catch (error) {
    failed = true;
    primaryError = error;
    // This budget is consulted only before SQLite is spawned, never after
    // its successful receipt; that specific rejection proves no transaction
    // was dispatched. Other failures remain conservatively unknown.
    if (executionBudget && error instanceof HistoryCommandBudgetError && outcome.commit_state === "unknown") outcome.commit_state = "not_started";
  } finally {
    if (!executionBudget) releaseMaintenanceLock(dbPath, owner);
    else if (acquisitionAttempted) {
      let releaseAttempted = false;
      try {
        executionBudget.runCleanup(() => {
          releaseAttempted = true;
          releaseMaintenanceLock(dbPath, owner, executionBudget);
        });
        outcome.cleanup_state = "succeeded";
      } catch (error) {
        outcome.cleanup_state = releaseAttempted && !(error instanceof HistoryCommandBudgetError) ? "unknown" : "failed";
        outcome.cleanup_error = error;
      }
    }
  }
  if (failed) {
    if (!executionBudget) throw primaryError;
    // Normal storage/budget paths throw Errors. A non-object thrown by a hook
    // is wrapped without exposing its text; the original remains its cause.
    const failure = primaryError && typeof primaryError === "object" ? primaryError
      : new Error("enrichment commit failed", { cause: primaryError });
    if (executionBudget) commitOutcomes.set(failure, Object.freeze({ ...outcome }));
    throw failure;
  }
  if (executionBudget && result) commitOutcomes.set(result, Object.freeze({ ...outcome }));
  return result;
}

export { commitEnrichmentUpdates, publicEnrichmentError, getEnrichmentCommitOutcome };
