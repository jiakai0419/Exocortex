// @ts-check
import { CliExecutionError, CliUsageError, writeCliError } from "./context.mjs";
import { initializeDatabase } from "../../dist/storage/sqlite/initialize.js";
import { executeSqliteMaintenance, publicPath, publicMaintenanceError } from "../storage/sqlite/maintenance.mjs";
import { executePreviewUnits, PreviewUnitsError } from '../maintenance/preview-units.mjs';
import { executeEnrichment, EnrichmentInputError } from "../maintenance/enrich.mjs";
import { executeSyncRepair } from "../maintenance/repair.mjs";
import { executeLarkImReplay, validateReplayOptions, safeReplayError, ReplayInputError } from "../maintenance/replay.mjs";
import { executeLarkImHistory } from "../maintenance/history.mjs";
import { createHistoryCommandBudget } from "../maintenance/history-command-budget.mjs";
import { executeResourceWork } from "../maintenance/resource-work.mjs";
import { MaintenanceRequestError } from "../maintenance/request-session.mjs";
import { MaintenanceReviewError, reviewRequested } from '../maintenance/review-artifact.mjs';
import { publicEnrichmentError } from "../maintenance/enrichment-commit.mjs";
import { renderSqliteMaintenanceText } from "../terminal/sqlite-maintenance-view.mjs";

/** @param {Record<string, any>} options @param {Record<string, any>} context */
function runMaintenanceCommand(options, context) {
  const action = options.action || context.route.split(".").at(-1);
  const deps = context.deps || {};
  let historyBudget, outputWritten = false;
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
    } else if (action === "history") {
      const maxSeconds = options.maxSeconds ?? ((options.maxRecords ?? 1) === 1 ? 30 : 25);
      historyBudget = createHistoryCommandBudget({ maxSeconds }, {
        monotonicClock: context.monotonicNow,
        startedMonotonicMs: context.startedMonotonicMs,
        remainingTimeMs: () => maxSeconds * 1000 - (context.monotonicNow() - context.startedMonotonicMs),
      });
      report = (deps.executeLarkImHistory || executeLarkImHistory)(options, {
        ...deps, env: context.env, now: context.now, historyCommandBudget: historyBudget,
      });
    } else if (action === "resources") {
      if (!context.provided.has("--db")) throw new CliUsageError("resources requires an explicit --db");
      report = (deps.executeResourceWork || executeResourceWork)(options, { ...deps, env: context.env, now: context.now });
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
    historyBudget?.assertOutputReady();
    const output = options.format !== "json" && ["backup", "prune-runs", "compact"].includes(action)
      ? renderSqliteMaintenanceText(report) : `${JSON.stringify(report, null, 2)}\n`;
    historyBudget?.assertOutputReady();
    context.stdout.write(output);
    outputWritten = true;
    historyBudget?.assertOutputReady();
    if (["backup", "prune-runs", "compact"].includes(action) && report.status === "failed") return 1;
    return report.ok === false || report.partial === true ? 2 : 0;
  } catch (error) {
    // A late write cannot be retracted. Keep its one JSON document intact, but
    // fail the process so the worker cannot accept it as a successful receipt.
    if (outputWritten) {
      context.stderr.write("History output exceeded its command deadline.\n");
      return 1;
    }
    const safe = error instanceof CliUsageError || error instanceof CliExecutionError || error instanceof EnrichmentInputError || error instanceof MaintenanceReviewError || error instanceof PreviewUnitsError ? error.message : action === "enrich" ? publicEnrichmentError(error, options.target === "scopes" ? "scope enrichment failed" : "record enrichment failed").message
      : action === "replay" ? safeReplayError(error) : publicMaintenanceError(error).message;
    writeCliError({ stdout: context.stdout, stderr: context.stderr }, { format: options.format,
      code: error instanceof CliUsageError || error instanceof EnrichmentInputError ? "invalid_arguments" : "execution_failed", message: safe,
      ...(error instanceof MaintenanceRequestError ? { requestBudget: error.requestBudget } : {}) });
    return 1;
  }
}

export { runMaintenanceCommand };
