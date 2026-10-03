// @ts-check

import { renderError } from "../../dist/terminal/index.js";
import { isAbsolute, resolve } from "node:path";
import {
  buildReport,
  runJson,
  PROJECT_ROOT,
} from "../diagnostics/doctor-report.mjs";
import {
  DEFAULT_LIVE_PROBE_CACHE_PATH,
  liveProbeContext,
  writeLiveProbeCache,
} from "../diagnostics/live-probe-cache.mjs";
import { publicDiagnosticError } from "../diagnostics/public-safe.mjs";
import { renderDoctorText } from "../terminal/doctor-view.mjs";

const DEFAULT_DB = "data/exocortex.sqlite";

/**
 * @typedef {"text" | "json"} DoctorFormat
 *
 * @typedef {object} DoctorOptions
 * @property {string} db
 * @property {boolean} live
 * @property {boolean=} writeLiveCache
 * @property {number} hotChats
 * @property {number} messagesPerChat
 * @property {number=} chatPages
 * @property {string=} start
 * @property {string=} end
 * @property {DoctorFormat} format
 * @property {boolean=} help
 *
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} DoctorCommandDeps
 * @property {(args: string[], okStatuses?: Set<number>) => JsonObject=} runJson
 * @property {(dbPath: string) => string=} resolvePath
 * @property {() => Date=} now
 * @property {string=} liveProbeCachePath
 * @property {(path: string, report: JsonObject) => JsonObject | null=} writeLiveProbeCache
 * @property {(dbPath: string) => JsonObject | null=} liveProbeContext
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
  --write-live-cache         Explicitly persist the live result; requires --live. Default: no local writes.
  --hot-chats <n>            Hot chats for --live. Default: 5
  --messages-per-chat <n>    Recent messages per hot chat for --live. Default: 3
  --chat-pages <n>           Bound live hot-chat discovery pages (lag-check default: 5).
  --start <iso>              Explicit live window start (default: today 00:00).
  --end <iso>                Explicit live window end (default: now).
  --format <fmt>             text | json. Default: text
  --help                     Show this help.
`;
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parsePositiveInt(value, name) {
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a positive integer`);
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
    if (arg === "--write-live-cache") {
      opts.writeLiveCache = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--hot-chats") opts.hotChats = parsePositiveInt(next, "hot-chats");
    else if (arg === "--messages-per-chat")
      opts.messagesPerChat = parsePositiveInt(next, "messages-per-chat");
    else if (arg === "--chat-pages") opts.chatPages = parsePositiveInt(next, "chat-pages");
    else if (arg === "--start") opts.start = next;
    else if (arg === "--end") opts.end = next;
    else if (arg === "--format") opts.format = /** @type {DoctorFormat} */ (next);
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }

  if (!["text", "json"].includes(opts.format)) throw new Error("--format must be text or json");
  if (opts.writeLiveCache && !opts.live) throw new Error("--write-live-cache requires --live");
  for (const key of ["start", "end"]) {
    if (opts[key] !== undefined && !Number.isFinite(Date.parse(opts[key]))) throw new Error(`--${key} must be a valid timestamp`);
  }
  if (opts.start && opts.end && Date.parse(opts.start) >= Date.parse(opts.end)) throw new Error("--end must be after --start");
  return opts;
}

/**
 * @param {DoctorOptions} opts
 * @param {DoctorCommandDeps} [deps]
 */
function executeDoctor(opts, deps = {}) {
  const dbPath = (deps.resolvePath || ((path) => isAbsolute(path) ? path : resolve(PROJECT_ROOT, path)))(opts.db);
  const contextFor = deps.liveProbeContext || liveProbeContext;
  const contextBefore = opts.live && opts.writeLiveCache ? contextFor(dbPath) : null;
  const report = buildReport(opts, deps);
  if (opts.live && opts.writeLiveCache) {
    try {
      const writeCache = deps.writeLiveProbeCache || writeLiveProbeCache;
      const contextAfter = contextFor(dbPath);
      const context = contextBefore?.database_key === contextAfter?.database_key ? contextAfter : null;
      writeCache(deps.liveProbeCachePath || resolve(PROJECT_ROOT, DEFAULT_LIVE_PROBE_CACHE_PATH), { ...report, cache_context: context });
    } catch {
      // Freshness cache is best-effort; doctor health must continue to reflect the probe itself.
    }
  }
  return report;
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
    stderr.write(renderError(publicDiagnosticError(error, "doctor check failed")));
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
