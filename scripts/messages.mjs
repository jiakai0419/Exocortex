#!/usr/bin/env node

// @ts-check

import { pathToFileURL } from "node:url";
import {
  DEFAULT_DB,
  executeMessages,
  loadMessages,
  parseArgs,
  parsePositiveInt,
  renderMessagesText,
  runMessagesCli,
  usage,
} from "../src/cli/messages-command.mjs";

export {
  DEFAULT_DB,
  executeMessages,
  loadMessages,
  parseArgs,
  parsePositiveInt,
  renderMessagesText,
  runMessagesCli,
  usage,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = runMessagesCli(process.argv.slice(2));
  if (exitCode !== 0) process.exit(exitCode);
}
