// @ts-check

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { renderError } from "../../dist/terminal/index.js";
import {
  collectQualityReport,
  sqliteJson,
} from "../diagnostics/lark-im-quality-report.mjs";
import { renderQualityText } from "../terminal/lark-im-quality-view.mjs";

const DEFAULT_DB = "data/exocortex.sqlite";

/**
 * @typedef {"text" | "json"} QualityFormat
 *
 * @typedef {object} QualityOptions
 * @property {string} db
 * @property {QualityFormat} format
 * @property {boolean=} help
 *
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} QualityCommandDeps
 * @property {(dbPath: string) => boolean=} existsSync
 * @property {(dbPath: string) => string=} resolvePath
 * @property {(dbPath: string) => JsonObject=} collect
 *
 * @typedef {object} CliIo
 * @property {{write: (text: string) => unknown}=} stdout
 * @property {{write: (text: string) => unknown}=} stderr
 * @property {QualityCommandDeps=} deps
 */

function usage() {
  return `Usage: node scripts/lark-im-quality.mjs [options]

Options:
  --db <path>       SQLite database path. Default: ${DEFAULT_DB}
  --format <fmt>    text | json. Default: text
  --help            Show this help.
`;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {QualityOptions} */
  const opts = { db: DEFAULT_DB, format: "text" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { ...opts, help: true };
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--format") opts.format = /** @type {QualityFormat} */ (next);
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  if (!["text", "json"].includes(opts.format)) throw new Error("--format must be text or json");
  return opts;
}

/**
 * @param {QualityOptions} opts
 * @param {QualityCommandDeps} [deps]
 */
function executeQuality(opts, deps = {}) {
  const resolvePath = deps.resolvePath || resolve;
  const fileExists = deps.existsSync || existsSync;
  const collect = deps.collect || collectQualityReport;
  const dbPath = resolvePath(opts.db);
  if (!fileExists(dbPath)) throw new Error(`database not found: ${dbPath}`);
  return collect(dbPath);
}

/**
 * @param {string[]} argv
 * @param {CliIo} [io]
 */
function runQualityCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      stdout.write(usage());
      return 0;
    }
    const report = executeQuality(opts, io.deps || {});
    if (opts.format === "json") stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else stdout.write(renderQualityText(report));
    return 0;
  } catch (error) {
    stderr.write(renderError(error));
    return 1;
  }
}

/** @param {string[]} [argv] */
function main(argv = process.argv.slice(2)) {
  return runQualityCli(argv);
}

export {
  DEFAULT_DB,
  collectQualityReport as collect,
  executeQuality,
  main,
  parseArgs,
  renderQualityText as render,
  runQualityCli,
  sqliteJson,
  usage,
};
