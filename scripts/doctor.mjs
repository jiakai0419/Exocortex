#!/usr/bin/env node

// @ts-check

import { pathToFileURL } from "node:url";
import {
  buildReport,
  executeDoctor,
  parseArgs,
  renderDoctorText,
  runDoctorCli,
  runJson,
  usage,
} from "../src/cli/doctor-command.mjs";

export {
  buildReport,
  executeDoctor,
  parseArgs,
  renderDoctorText,
  runDoctorCli,
  runJson,
  usage,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = runDoctorCli(process.argv.slice(2));
  if (exitCode !== 0) process.exit(exitCode);
}
