// @ts-check

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { renderError } from "../../dist/terminal/index.js";
import { localIsoFromMs, parseLarkTimeMs } from "../adapters/lark-im/core.mjs";
import {
  collectLagReport,
  envelope,
  fetchHotChats,
  fetchRecentChatMessages,
  firstArray,
  getSelfOpenId,
  isRestrictedModeError,
  loadExistingRecords,
  localLatest,
  quoteSql,
  runLark,
  sqliteJson,
} from "../diagnostics/lark-im-lag-report.mjs";
import { exitCodeForReport } from "../diagnostics/lark-im-lag-core.mjs";
import { renderLagText } from "../terminal/lark-im-lag-view.mjs";

const DEFAULT_DB = "data/exocortex.sqlite";
const DEFAULT_CHAT_PAGES = 5;
const DEFAULT_HOT_CHATS = 20;
const DEFAULT_MESSAGES_PER_CHAT = 5;

/**
 * @typedef {"text" | "json"} LagFormat
 *
 * @typedef {object} LagOptions
 * @property {string} db
 * @property {number} chatPages
 * @property {number} hotChats
 * @property {number} messagesPerChat
 * @property {string} start
 * @property {string} end
 * @property {number} startMs
 * @property {number} endMs
 * @property {LagFormat} format
 * @property {boolean=} help
 *
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} LagCommandDeps
 * @property {(dbPath: string) => boolean=} existsSync
 * @property {(dbPath: string) => string=} resolvePath
 * @property {(dbPath: string, opts: LagOptions) => JsonObject=} collect
 * @property {() => number=} nowMs
 *
 * @typedef {object} CliIo
 * @property {{write: (text: string) => unknown}=} stdout
 * @property {{write: (text: string) => unknown}=} stderr
 * @property {LagCommandDeps=} deps
 */

function usage() {
  return `Usage: node scripts/lark-im-lag-check.mjs [options]

Options:
  --db <path>                SQLite database path. Default: ${DEFAULT_DB}
  --chat-pages <n>           Hot chat-list pages to probe. Default: ${DEFAULT_CHAT_PAGES}
  --hot-chats <n>            Max non-muted hot chats to inspect. Default: ${DEFAULT_HOT_CHATS}
  --messages-per-chat <n>    Recent messages per hot chat. Default: ${DEFAULT_MESSAGES_PER_CHAT}
  --start <iso>              Probe start time. Default: today 00:00 local time.
  --end <iso>                Probe end time. Default: now.
  --format <fmt>             text | json. Default: text
  --help                     Show this help.
`;
}

/** @param {number} n */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/** @param {Date} date */
function localOffset(date) {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** @param {number} [nowMs] */
function defaultStartIso(nowMs = Date.now()) {
  const now = new Date(nowMs);
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T00:00:00${localOffset(now)}`;
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

/**
 * @param {string[]} argv
 * @param {{nowMs?: () => number}} [deps]
 */
function parseArgs(argv, deps = {}) {
  const nowMs = deps.nowMs ? deps.nowMs() : Date.now();
  /** @type {LagOptions} */
  const opts = {
    db: DEFAULT_DB,
    chatPages: DEFAULT_CHAT_PAGES,
    hotChats: DEFAULT_HOT_CHATS,
    messagesPerChat: DEFAULT_MESSAGES_PER_CHAT,
    start: defaultStartIso(nowMs),
    end: localIsoFromMs(nowMs),
    startMs: 0,
    endMs: 0,
    format: "text",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { ...opts, help: true };
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--chat-pages") opts.chatPages = parsePositiveInt(next, "chat-pages");
    else if (arg === "--hot-chats") opts.hotChats = parsePositiveInt(next, "hot-chats");
    else if (arg === "--messages-per-chat") opts.messagesPerChat = parsePositiveInt(next, "messages-per-chat");
    else if (arg === "--start") opts.start = next;
    else if (arg === "--end") opts.end = next;
    else if (arg === "--format") opts.format = /** @type {LagFormat} */ (next);
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  if (!["text", "json"].includes(opts.format)) throw new Error("--format must be text or json");
  opts.startMs = parseLarkTimeMs(opts.start);
  opts.endMs = parseLarkTimeMs(opts.end);
  if (!Number.isFinite(opts.startMs)) throw new Error(`invalid --start: ${opts.start}`);
  if (!Number.isFinite(opts.endMs)) throw new Error(`invalid --end: ${opts.end}`);
  return opts;
}

/**
 * @param {LagOptions} opts
 * @param {LagCommandDeps} [deps]
 */
function executeLagCheck(opts, deps = {}) {
  const resolvePath = deps.resolvePath || resolve;
  const fileExists = deps.existsSync || existsSync;
  const collect = deps.collect || collectLagReport;
  const dbPath = resolvePath(opts.db);
  if (!fileExists(dbPath)) throw new Error(`database not found: ${dbPath}`);
  return collect(dbPath, opts);
}

/**
 * @param {string[]} argv
 * @param {CliIo} [io]
 */
function runLagCheckCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const opts = parseArgs(argv, { nowMs: io.deps?.nowMs });
    if (opts.help) {
      stdout.write(usage());
      return 0;
    }
    const report = executeLagCheck(opts, io.deps || {});
    if (opts.format === "json") stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else stdout.write(renderLagText(report));
    return exitCodeForReport(report);
  } catch (error) {
    stderr.write(renderError(error));
    return 1;
  }
}

/** @param {string[]} [argv] */
function main(argv = process.argv.slice(2)) {
  return runLagCheckCli(argv);
}

export {
  DEFAULT_CHAT_PAGES,
  DEFAULT_DB,
  DEFAULT_HOT_CHATS,
  DEFAULT_MESSAGES_PER_CHAT,
  collectLagReport as collect,
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
  renderLagText as render,
  runLagCheckCli,
  runLark,
  sqliteJson,
  usage,
};
