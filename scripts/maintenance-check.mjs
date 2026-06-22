#!/usr/bin/env node

// @ts-check

import { pathToFileURL } from "node:url";
import {
  DEFAULT_POLL_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  executeMaintenanceCheck,
  main,
  parseArgs,
  parsePositiveInt,
  renderMaintenanceText,
  runMaintenanceCheckCli,
  runStep,
  tailText,
  usage,
} from "../src/cli/maintenance-check-command.mjs";

export {
  DEFAULT_POLL_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  executeMaintenanceCheck,
  main,
  parseArgs,
  parsePositiveInt,
  renderMaintenanceText,
  runMaintenanceCheckCli,
  runStep,
  tailText,
  usage,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = runMaintenanceCheckCli(process.argv.slice(2));
  if (exitCode !== 0) process.exit(exitCode);
}
