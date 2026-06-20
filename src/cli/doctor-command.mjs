// @ts-check

import { renderError } from "../../dist/terminal/index.js";
import {
  buildReport,
  runJson,
} from "../diagnostics/doctor-report.mjs";
import { renderDoctorText } from "../terminal/doctor-view.mjs";

const DEFAULT_DB = "data/exocortex.sqlite";

/**
 * @typedef {"text" | "json"} DoctorFormat
 *
 * @typedef {object} DoctorOptions
 * @property {string} db
 * @property {boolean} live
 * @property {number} hotChats
 * @property {number} messagesPerChat
 * @property {DoctorFormat} format
 * @property {boolean=} help
 *
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} DoctorCommandDeps
 * @property {(args: string[], okStatuses?: Set<number>) => JsonObject=} runJson
 * @property {(dbPath: string) => string=} resolvePath
 * @property {() => Date=} now
 *
 * @typedef {object} CliIo
 * @property {{write: (text: string) => unknown}=} stdout
 * @property {{write: (text: string) => unknown}=} stderr
 * @property {DoctorCommandDeps=} deps
 */

function usage() {
  return `Usage: node scripts/doctor.mjs [options]

Options:
  --db <path>                SQLite database path. Default: ${DEFAULT_DB}
  --live                     Also probe recent remote Lark messages. Requires lark-cli auth/keychain access.
  --hot-chats <n>            Hot chats for --live. Default: 5
  --messages-per-chat <n>    Recent messages per hot chat for --live. Default: 3
  --format <fmt>             text | json. Default: text
  --help                     Show this help.
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
  /** @type {DoctorOptions} */
  const opts = {
    db: DEFAULT_DB,
    live: false,
    hotChats: 5,
    messagesPerChat: 3,
    format: "text",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { ...opts, help: true };
    if (arg === "--live") {
      opts.live = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--hot-chats") opts.hotChats = parsePositiveInt(next, "hot-chats");
    else if (arg === "--messages-per-chat")
      opts.messagesPerChat = parsePositiveInt(next, "messages-per-chat");
    else if (arg === "--format") opts.format = /** @type {DoctorFormat} */ (next);
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }

  if (!["text", "json"].includes(opts.format)) throw new Error("--format must be text or json");
  return opts;
}

/**
 * @param {DoctorOptions} opts
 * @param {DoctorCommandDeps} [deps]
 */
function executeDoctor(opts, deps = {}) {
  return buildReport(opts, deps);
}

/**
 * @param {string[]} argv
 * @param {CliIo} [io]
 */
function runDoctorCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      stdout.write(usage());
      return 0;
    }
    const report = executeDoctor(opts, io.deps || {});
    if (opts.format === "json") stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else stdout.write(renderDoctorText(report));
    return report.ok ? 0 : 2;
  } catch (error) {
    stderr.write(renderError(error));
    return 1;
  }
}

export {
  buildReport,
  executeDoctor,
  parseArgs,
  renderDoctorText,
  runDoctorCli,
  runJson,
  usage,
};
