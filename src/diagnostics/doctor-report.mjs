// @ts-check

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  buildFindings,
  normalizeLiveResult,
  overallStatus,
} from "./doctor-core.mjs";

/**
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} DoctorReportOptions
 * @property {string} db
 * @property {boolean} live
 * @property {number} hotChats
 * @property {number} messagesPerChat
 *
 * @typedef {object} DoctorReport
 * @property {boolean} ok
 * @property {string} overall
 * @property {string} checked_at
 * @property {string} db_path
 * @property {JsonObject} status
 * @property {JsonObject} quality
 * @property {JsonObject | null} live
 * @property {string[]} findings
 *
 * @typedef {object} DoctorReportDeps
 * @property {(args: string[], okStatuses?: Set<number>) => JsonObject=} runJson
 * @property {(dbPath: string) => string=} resolvePath
 * @property {() => Date=} now
 */

/**
 * @param {string[]} args
 * @param {Set<number>} [okStatuses]
 * @returns {JsonObject}
 */
function runJson(args, okStatuses = new Set([0])) {
  const result = spawnSync("node", args, {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  const status = result.status ?? 1;
  const stdout = result.stdout.trim();
  if (stdout) {
    try {
      const json = JSON.parse(stdout);
      if (!okStatuses.has(status)) json._command_status = status;
      return json;
    } catch (error) {
      if (okStatuses.has(status)) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${args.join(" ")} returned non-JSON output: ${message}`);
      }
    }
  }
  if (!okStatuses.has(status)) {
    return {
      ok: false,
      status: "command_failed",
      command: ["node", ...args].join(" "),
      exit_status: status,
      stderr: result.stderr.trim(),
      stdout,
    };
  }
  return {};
}

/**
 * @param {DoctorReportOptions} opts
 * @param {DoctorReportDeps} [deps]
 * @returns {DoctorReport}
 */
function buildReport(opts, deps = {}) {
  const dbPath = (deps.resolvePath || resolve)(opts.db);
  const readJson = deps.runJson || runJson;
  const now = deps.now || (() => new Date());
  const status = readJson(["scripts/sync-status.mjs", "--db", dbPath, "--format", "json"]);
  const quality = readJson(["scripts/lark-im-quality.mjs", "--db", dbPath, "--format", "json"]);
  const live = opts.live
    ? normalizeLiveResult(readJson(
        [
          "scripts/lark-im-lag-check.mjs",
          "--db",
          dbPath,
          "--hot-chats",
          String(opts.hotChats),
          "--messages-per-chat",
          String(opts.messagesPerChat),
          "--format",
          "json",
        ],
        new Set([0, 2]),
      ))
    : null;

  const findings = buildFindings({ status, quality, live });
  const overall = overallStatus({ status, quality, live });

  return {
    ok: ["fresh", "syncing", "catching_up"].includes(overall),
    overall,
    checked_at: now().toISOString(),
    db_path: dbPath,
    status,
    quality,
    live,
    findings,
  };
}

export {
  buildReport,
  runJson,
};
