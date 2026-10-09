// @ts-check
import { CliExecutionError, CliUsageError, writeCliError } from "./context.mjs";
import { initializeDatabase } from "../../dist/storage/sqlite/initialize.js";
import { executeSqliteMaintenance, publicPath, publicMaintenanceError } from "../storage/sqlite/maintenance.mjs";
import { executePreviewUnits, PreviewUnitsError } from '../maintenance/preview-units.mjs';
import { executeEnrichment, EnrichmentInputError } from "../maintenance/enrich.mjs";
import { executeSyncRepair } from "../maintenance/repair.mjs";
import { executeLarkImReplay, validateReplayOptions, safeReplayError, ReplayInputError } from "../maintenance/replay.mjs";
import { MaintenanceRequestError } from "../maintenance/request-session.mjs";
import { MaintenanceReviewError, reviewRequested } from '../maintenance/review-artifact.mjs';
import { publicEnrichmentError } from "../maintenance/enrichment-commit.mjs";
import { renderSqliteMaintenanceText } from "../terminal/sqlite-maintenance-view.mjs";

/** @param {Record<string, any>} options @param {Record<string, any>} context */
function runMaintenanceCommand(options, context) {
  const action = options.action || context.route.split(".").at(-1);
  const deps = context.deps || {};
  try {
    if ((reviewRequested(options) || action === 'preview') && (!context.provided.has('--max-cli-attempts') || !context.provided.has('--max-seconds'))) {
      throw new CliUsageError('maintenance review requires explicit --max-cli-attempts and --max-seconds');
    }
    let report;
    if (action === "init") {
      const result = (deps.initializeDatabase || initializeDatabase)(options.db);
      report = { ...result, action, db_path: publicPath(context.root, result.db_path) };
    } else if (["backup", "prune-runs", "compact"].includes(action)) {
      report = (deps.executeSqliteMaintenance || executeSqliteMaintenance)({ backupDir: context.resolvePath("backups/private", { explicit: false }),
        backupKeepCount: 7, backupKeepDays: 30, backup: null, latest: false, ...options,
        action, dryRun: options.apply !== true }, { ...deps, now: () => new Date(context.now()), cwd: context.root });
    } else if (action === 'preview') {
      report = (deps.executePreviewUnits || executePreviewUnits)(options, { ...deps, env: context.env, now: context.now });
    } else if (action === "enrich") {
      report = (deps.executeEnrichment || executeEnrichment)(options, { ...deps, env: context.env, now: context.now });
    } else if (action === "repair") {
      report = (deps.executeSyncRepair || executeSyncRepair)(options, deps);
    } else if (action === "replay") {
      if (!context.provided.has("--db")) throw new CliUsageError("replay requires an explicit --db");
      let parsed;
      try { parsed = validateReplayOptions(options); }
      catch (error) {
        if (error instanceof ReplayInputError) throw new CliUsageError(error.message);
        throw error;
      }
      report = (deps.executeLarkImReplay || executeLarkImReplay)(parsed, { ...deps, env: context.env, now: context.now });
    } else throw new Error("unknown maintenance action");
    if (options.format !== "json" && ["backup", "prune-runs", "compact"].includes(action)) context.stdout.write(renderSqliteMaintenanceText(report));
    else context.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (["backup", "prune-runs", "compact"].includes(action) && report.status === "failed") return 1;
    return report.ok === false || report.partial === true ? 2 : 0;
  } catch (error) {
    const safe = error instanceof CliUsageError || error instanceof CliExecutionError || error instanceof EnrichmentInputError || error instanceof MaintenanceReviewError || error instanceof PreviewUnitsError ? error.message : action === "enrich" ? publicEnrichmentError(error, options.target === "scopes" ? "scope enrichment failed" : "record enrichment failed").message
      : action === "replay" ? safeReplayError(error) : publicMaintenanceError(error).message;
    writeCliError({ stdout: context.stdout, stderr: context.stderr }, { format: options.format,
      code: error instanceof CliUsageError || error instanceof EnrichmentInputError ? "invalid_arguments" : "execution_failed", message: safe,
      ...(error instanceof MaintenanceRequestError ? { requestBudget: error.requestBudget } : {}) });
    return 1;
  }
}

export { runMaintenanceCommand };
