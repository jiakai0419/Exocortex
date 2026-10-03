#!/usr/bin/env node
// @ts-check
import { pathToFileURL } from "node:url";
import { runSyncRepairCli } from "../src/cli/sync-repair-command.mjs";
export { executeSyncRepair, parseArgs, runSyncRepairCli, usage } from "../src/cli/sync-repair-command.mjs";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runSyncRepairCli(process.argv.slice(2));
}
