#!/usr/bin/env node

// @ts-check

import { pathToFileURL } from "node:url";
import {
  collect,
  DEFAULT_CHAT_PAGES,
  DEFAULT_DB,
  DEFAULT_HOT_CHATS,
  DEFAULT_MESSAGES_PER_CHAT,
  defaultStartIso,
  envelope,
  executeLagCheck,
  fetchHotChats,
  fetchRecentChatMessages,
  firstArray,
  getSelfOpenId,
  isRestrictedModeError,
  loadExistingRecords,
  localLatest,
  localOffset,
  main,
  pad2,
  parseArgs,
  parsePositiveInt,
  quoteSql,
  render,
  runLagCheckCli,
  runLark,
  sqliteJson,
  usage,
} from "../src/cli/lark-im-lag-command.mjs";

export {
  collect,
  DEFAULT_CHAT_PAGES,
  DEFAULT_DB,
  DEFAULT_HOT_CHATS,
  DEFAULT_MESSAGES_PER_CHAT,
  defaultStartIso,
  envelope,
  executeLagCheck,
  fetchHotChats,
  fetchRecentChatMessages,
  firstArray,
  getSelfOpenId,
  isRestrictedModeError,
  loadExistingRecords,
  localLatest,
  localOffset,
  main,
  pad2,
  parseArgs,
  parsePositiveInt,
  quoteSql,
  render,
  runLagCheckCli,
  runLark,
  sqliteJson,
  usage,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = runLagCheckCli(process.argv.slice(2));
  if (exitCode !== 0) process.exit(exitCode);
}
