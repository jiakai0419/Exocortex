// @ts-check
import { CliUsageError } from "./context.mjs";
import { initializeDatabase } from "../../dist/storage/sqlite/initialize.js";
import { executeSqliteMaintenance, publicPath, publicMaintenanceError } from "../storage/sqlite/maintenance.mjs";
import { executeEnrichment, EnrichmentInputError } from "../maintenance/enrich.mjs";
import { executeSyncRepair } from "../maintenance/repair.mjs";
import { executeLarkImReplay, validateReplayOptions, safeReplayError } from "../maintenance/replay.mjs";
import { publicEnrichmentError } from "../maintenance/enrichment-commit.mjs";
import { renderSqliteMaintenanceText } from "../terminal/sqlite-maintenance-view.mjs";

/** @param {Record<string, any>} options @param {Record<string, any>} context */
function runMaintenanceCommand(options, context) {
  const action = options.action || context.route.split(".").at(-1);
  const deps = context.deps || {};
  try {
    let report;
    if (action === "init") {
      const result = (deps.initializeDatabase || initializeDatabase)(options.db);
      report = { ...result, action, db_path: publicPath(context.root, result.db_path) };
    } else if (["backup", "prune-runs", "compact"].includes(action)) {
      report = (deps.executeSqliteMaintenance || executeSqliteMaintenance)({ backupDir: context.resolvePath("backups/private", { explicit: false }),
        backupKeepCount: 7, backupKeepDays: 30, backup: null, latest: false, ...options,
        action, dryRun: options.apply !== true }, { ...deps, now: () => new Date(context.now()), cwd: context.root });
    } else if (action === "enrich") {
      report = (deps.executeEnrichment || executeEnrichment)(options, { ...deps, env: context.env, now: context.now });
    } else if (action === "repair") {
      report = (deps.executeSyncRepair || executeSyncRepair)(options, deps);
    } else if (action === "replay") {
      if (!context.provided.has("--db")) throw new CliUsageError("replay requires an explicit --db");
      const parsed = validateReplayOptions(options);
      report = (deps.executeLarkImReplay || executeLarkImReplay)(parsed, { ...deps, now: context.now });
    } else throw new Error("unknown maintenance action");
    if (options.format !== "json" && ["backup", "prune-runs", "compact"].includes(action)) context.stdout.write(renderSqliteMaintenanceText(report));
    else context.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (["backup", "prune-runs", "compact"].includes(action) && report.status === "failed") return 1;
    return report.ok === false || report.partial === true ? 2 : 0;
  } catch (error) {
    const safe = error instanceof CliUsageError || error instanceof EnrichmentInputError ? error.message : action === "enrich" ? publicEnrichmentError(error, options.target === "scopes" ? "scope enrichment failed" : "record enrichment failed").message
      : action === "replay" ? safeReplayError(error) : publicMaintenanceError(error).message;
    context.stderr.write(`${safe}\n`);
    return 1;
  }
}

export { runMaintenanceCommand };
