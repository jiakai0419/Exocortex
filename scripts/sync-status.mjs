#!/usr/bin/env node

// @ts-check

import { pathToFileURL } from "node:url";
import {
  buildStatus,
  executeSyncStatus,
  parseArgs,
  renderText,
  runSyncStatusCli,
  sqliteJson,
  usage,
} from "../src/cli/sync-status-command.mjs";

export {
  buildStatus,
  executeSyncStatus,
  parseArgs,
  renderText,
  runSyncStatusCli,
  sqliteJson,
  usage,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = runSyncStatusCli(process.argv.slice(2));
  if (exitCode !== 0) process.exit(exitCode);
}
