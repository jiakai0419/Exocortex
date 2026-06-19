#!/usr/bin/env node

// @ts-check

import { pathToFileURL } from "node:url";
import {
  parseArgs,
  runLarkImSyncCli,
} from "../src/cli/lark-im-sync-command.mjs";
import {
  createRun,
  ensureInitialized,
  failRun,
  readScope,
  sqliteExec,
  sqliteQuery,
  succeedMessageRun,
} from "../dist/storage/sqlite/ingestion-store.js";
import {
  createSyncRunner,
  prepareChatWindowRecords,
  shouldSkipCompletedDiscovery,
  shouldSkipReconcile,
  succeedUnsupportedRun,
} from "../src/adapters/lark-im/sync-runner.mjs";
import {
  bodyFromMessage,
  compareRecordToCursor,
  cursorAfter,
  messageWindow,
  parseLarkTimeMs,
  prepareRecords,
  recordFromMessage,
  stableMessageEndMs,
} from "./lib/lark-im-core.mjs";

export {
  bodyFromMessage,
  compareRecordToCursor,
  createRun,
  createSyncRunner,
  cursorAfter,
  ensureInitialized,
  failRun,
  messageWindow,
  parseArgs,
  parseLarkTimeMs,
  prepareChatWindowRecords,
  prepareRecords,
  readScope,
  recordFromMessage,
  shouldSkipCompletedDiscovery,
  shouldSkipReconcile,
  sqliteExec,
  sqliteQuery,
  stableMessageEndMs,
  succeedMessageRun,
  succeedUnsupportedRun,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = runLarkImSyncCli(process.argv.slice(2));
  if (exitCode !== 0) process.exit(exitCode);
}
