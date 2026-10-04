import { randomUUID } from "node:crypto";
import { acquireMaintenanceLock, quoteSql, releaseMaintenanceLock, sqliteQuery }
  from "../../dist/storage/sqlite/ingestion-store.js";
import { publicDiagnosticError } from "../../src/diagnostics/public-safe.mjs";

class EnrichmentContentionError extends Error {}

function publicEnrichmentError(error, label) {
  // These local contention messages contain only counts and fixed text. All
  // other storage, JSON and transport failures cross the diagnostic boundary.
  const safe = error instanceof EnrichmentContentionError
    ? error.message : publicDiagnosticError(error, label).message;
  return new Error(safe, { cause: error });
}

// Both enrichment commands finish remote lookups before entering this short
// local commit. Each update carries its original-snapshot CAS and records one
// changes() value in __enrichment_effects. The lease check must stay inside the
// same BEGIN IMMEDIATE transaction as those updates.
function commitEnrichmentUpdates(dbPath, updates, { dryRun, reason, label }) {
  if (updates.length === 0 || dryRun) return { updated: 0, skippedConflicts: 0 };
  const owner = `pid:${process.pid}:${reason}:${randomUUID()}`;
  const lock = acquireMaintenanceLock(dbPath, { owner, ttlSeconds: 60, reason });
  if (!lock.acquired) {
    if (lock.reason === "sync_locks_active") {
      throw new EnrichmentContentionError(`maintenance lock unavailable: ${lock.active_sync_locks || 0} active sync lock(s); retry shortly`);
    }
    throw new EnrichmentContentionError("maintenance lock unavailable: held by another maintenance command");
  }
  try {
    const effects = sqliteQuery(dbPath, `
      BEGIN IMMEDIATE;
      CREATE TEMP TABLE __enrichment_fence (allowed INTEGER NOT NULL CHECK (allowed = 1));
      INSERT INTO __enrichment_fence (allowed)
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM maintenance_locks
        WHERE name = 'global' AND owner = ${quoteSql(owner)}
          AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ) AND NOT EXISTS (SELECT 1 FROM sync_locks) THEN 1 ELSE 0 END;
      CREATE TEMP TABLE __enrichment_effects (updated INTEGER NOT NULL);
      ${updates.join("\n")}
      SELECT COALESCE(SUM(updated), 0) AS updated FROM __enrichment_effects;
      COMMIT;`, label);
    const updated = Number(effects[0]?.updated || 0);
    return { updated, skippedConflicts: updates.length - updated };
  } finally {
    releaseMaintenanceLock(dbPath, owner);
  }
}

export { commitEnrichmentUpdates, publicEnrichmentError };
