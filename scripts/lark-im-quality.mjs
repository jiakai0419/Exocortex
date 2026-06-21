#!/usr/bin/env node

// @ts-check

import { pathToFileURL } from "node:url";
import {
  collect,
  DEFAULT_DB,
  executeQuality,
  main,
  parseArgs,
  render,
  runQualityCli,
  sqliteJson,
  usage,
} from "../src/cli/lark-im-quality-command.mjs";
import { one } from "../src/diagnostics/lark-im-quality-report.mjs";

export {
  collect,
  DEFAULT_DB,
  executeQuality,
  main,
  one,
  parseArgs,
  render,
  runQualityCli,
  sqliteJson,
  usage,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = runQualityCli(process.argv.slice(2));
  if (exitCode !== 0) process.exit(exitCode);
}
