#!/usr/bin/env node

// @ts-check

import { pathToFileURL } from "node:url";
import {
  domain,
  evaluateWaitOkState,
  formatLogLine,
  install,
  isLaunchdLoaded,
  isReadyHealth,
  main,
  parseArgs,
  parsePositiveInt,
  plistPath,
  plistXml,
  run,
  runLarkImServiceCli,
  runServiceCommand,
  start,
  status,
  stop,
  tail,
  target,
  uid,
  uninstall,
  usage,
  waitOk,
} from "../src/cli/lark-im-service-command.mjs";

export {
  domain,
  evaluateWaitOkState,
  formatLogLine,
  install,
  isLaunchdLoaded,
  isReadyHealth,
  main,
  parseArgs,
  parsePositiveInt,
  plistPath,
  plistXml,
  run,
  runLarkImServiceCli,
  runServiceCommand,
  start,
  status,
  stop,
  tail,
  target,
  uid,
  uninstall,
  usage,
  waitOk,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = runLarkImServiceCli(process.argv.slice(2));
  if (exitCode !== 0) process.exit(exitCode);
}
