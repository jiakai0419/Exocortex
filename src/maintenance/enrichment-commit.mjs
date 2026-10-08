import { randomUUID } from "node:crypto";
import { acquireMaintenanceLock, quoteSql, releaseMaintenanceLock, reviewFenceSql, sqliteQuery }
  from "../../dist/storage/sqlite/ingestion-store.js";
import { MaintenanceRequestError } from "./request-session.mjs";
import { publicDiagnosticError } from "../diagnostics/public-safe.mjs";

class EnrichmentContentionError extends Error {}

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
/** @param {{dryRun:boolean,reason:string,label:string,reviewFence?:any,reviewBeforeCommit?:()=>void}} options */
function commitEnrichmentUpdates(dbPath, updates, options) {
  const { dryRun, reason, label, reviewFence, reviewBeforeCommit } = options;
  if (dryRun || updates.length === 0 && reviewFence === undefined) return { updated: 0, skippedConflicts: 0 };
  const reviewSql = reviewFence === undefined ? "" : reviewFenceSql(reviewFence);
  const owner = `pid:${process.pid}:${reason}:${randomUUID()}`;
  const lock = acquireMaintenanceLock(dbPath, { owner, ttlSeconds: 60, reason });
  if (!lock.acquired) {
    if (lock.reason === "sync_locks_active") {
      throw new EnrichmentContentionError(`maintenance lock unavailable: ${lock.active_sync_locks || 0} active sync lock(s); retry shortly`);
    }
    throw new EnrichmentContentionError("maintenance lock unavailable: held by another maintenance command");
  }
  try {
    reviewBeforeCommit?.();
    const effects = sqliteQuery(dbPath, `
      BEGIN IMMEDIATE;
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
      COMMIT;`, label);
    const updated = Number(effects[0]?.updated || 0);
    return { updated, skippedConflicts: updates.length - updated };
  } finally {
    releaseMaintenanceLock(dbPath, owner);
  }
}

export { commitEnrichmentUpdates, publicEnrichmentError };
