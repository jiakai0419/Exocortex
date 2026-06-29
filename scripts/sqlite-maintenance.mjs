#!/usr/bin/env node

// @ts-check

import { pathToFileURL } from "node:url";
import {
  DEFAULT_BACKUP_DIR,
  DEFAULT_DB,
  DEFAULT_PRUNE_RUNS_RETENTION_DAYS,
  TRACKED_TABLES,
  assertWorkerStoppedForWrite,
  compareCounts,
  databaseCheck,
  executeSqliteMaintenance,
  isLarkImWorkerLoaded,
  latestBackupPath,
  main,
  parseArgs,
  pruneNoopSuccessfulRuns,
  publicPath,
  renderSqliteMaintenanceText,
  runSqliteMaintenanceCli,
  timestampForFile,
  usage,
} from "../src/cli/sqlite-maintenance-command.mjs";

export {
  DEFAULT_BACKUP_DIR,
  DEFAULT_DB,
  DEFAULT_PRUNE_RUNS_RETENTION_DAYS,
  TRACKED_TABLES,
  assertWorkerStoppedForWrite,
  compareCounts,
  databaseCheck,
  executeSqliteMaintenance,
  isLarkImWorkerLoaded,
  latestBackupPath,
  main,
  parseArgs,
  pruneNoopSuccessfulRuns,
  publicPath,
  renderSqliteMaintenanceText,
  runSqliteMaintenanceCli,
  timestampForFile,
  usage,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = runSqliteMaintenanceCli(process.argv.slice(2));
  if (exitCode !== 0) process.exit(exitCode);
}
