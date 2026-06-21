// @ts-check

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { renderError } from "../../dist/terminal/index.js";
import { loadMessages } from "../diagnostics/messages-report.mjs";
import { renderMessagesText } from "../terminal/messages-view.mjs";

const DEFAULT_DB = "data/exocortex.sqlite";

/**
 * @typedef {"all" | "sent" | "received"} MessageDirection
 * @typedef {"text" | "json"} MessageFormat
 *
 * @typedef {object} MessageOptions
 * @property {string} db
 * @property {MessageDirection} direction
 * @property {number} limit
 * @property {string} search
 * @property {MessageFormat} format
 * @property {boolean=} help
 *
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} MessagesCommandDeps
 * @property {(dbPath: string) => boolean=} existsSync
 * @property {(dbPath: string) => string=} resolvePath
 * @property {(dbPath: string, opts: MessageOptions) => JsonObject[]=} loadMessages
 *
 * @typedef {object} CliIo
 * @property {{write: (text: string) => unknown}=} stdout
 * @property {{write: (text: string) => unknown}=} stderr
 * @property {MessagesCommandDeps=} deps
 */

function usage() {
  return `Usage: node scripts/messages.mjs [options]

Options:
  --db <path>             SQLite database path. Default: ${DEFAULT_DB}
  --direction <value>     all | sent | received. Default: all
  --limit <n>             Number of messages. Default: 30
  --search <text>         Filter message body by keyword.
  --format <fmt>          text | json. Default: text
  --help                  Show this help.
`;
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

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {MessageOptions} */
  const opts = { db: DEFAULT_DB, direction: "all", limit: 30, search: "", format: "text" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { ...opts, help: true };
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--direction") opts.direction = /** @type {MessageDirection} */ (next);
    else if (arg === "--limit") opts.limit = parsePositiveInt(next, "limit");
    else if (arg === "--search") opts.search = next;
    else if (arg === "--format") opts.format = /** @type {MessageFormat} */ (next);
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  if (!["all", "sent", "received"].includes(opts.direction)) {
    throw new Error("--direction must be all, sent, or received");
  }
  if (!["text", "json"].includes(opts.format)) throw new Error("--format must be text or json");
  return opts;
}

/**
 * @param {MessageOptions} opts
 * @param {MessagesCommandDeps} [deps]
 */
function executeMessages(opts, deps = {}) {
  const resolvePath = deps.resolvePath || resolve;
  const fileExists = deps.existsSync || existsSync;
  const load = deps.loadMessages || loadMessages;
  const dbPath = resolvePath(opts.db);
  if (!fileExists(dbPath)) throw new Error(`database not found: ${dbPath}`);
  return load(dbPath, opts);
}

/**
 * @param {string[]} argv
 * @param {CliIo} [io]
 */
function runMessagesCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      stdout.write(usage());
      return 0;
    }
    const messages = executeMessages(opts, io.deps || {});
    if (opts.format === "json") stdout.write(`${JSON.stringify(messages, null, 2)}\n`);
    else stdout.write(renderMessagesText(/** @type {import("../diagnostics/messages-report.mjs").EnrichedMessage[]} */ (messages)));
    return 0;
  } catch (error) {
    stderr.write(renderError(error));
    return 1;
  }
}

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
