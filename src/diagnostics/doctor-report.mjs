// @ts-check

import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFindings,
  normalizeLiveResult,
  overallStatus,
} from "./doctor-core.mjs";
import { sanitizeLagReportForPublicOutput } from "./lark-im-lag-core.mjs";
import { sanitizeQualityReportForPublicOutput } from "./lark-im-quality-report.mjs";
import { publicCommandFailureReason } from "./public-safe.mjs";
import { sanitizeStatusReportForPublicOutput } from "./sync-status-report.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_DOCTOR_CHILD_TIMEOUT_MS = 180_000;

/**
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} DoctorReportOptions
 * @property {string} db
 * @property {boolean} live
 * @property {number} hotChats
 * @property {number} messagesPerChat
 * @property {number=} chatPages
 * @property {string=} start
 * @property {string=} end
 *
 * @typedef {object} DoctorReport
 * @property {boolean} ok
 * @property {string} overall
 * @property {string} checked_at
 * @property {JsonObject} status
 * @property {JsonObject} quality
 * @property {JsonObject | null} live
 * @property {string[]} findings
 *
 * @typedef {object} DoctorReportDeps
 * @property {(args: string[], okStatuses?: Set<number>) => JsonObject=} runJson
 * @property {(dbPath: string) => string=} resolvePath
 * @property {() => Date=} now
 *
 * @typedef {object} RunJsonDeps
 * @property {(cmd: string, args: string[], options: JsonObject) => JsonObject=} spawnSync
 * @property {string=} execPath
 * @property {string=} projectRoot
 * @property {number=} timeoutMs
 */

/**
 * @param {string[]} args
 * @param {Set<number>} [okStatuses]
 * @param {RunJsonDeps} [deps]
 * @returns {JsonObject}
 */
function runJson(args, okStatuses = new Set([0]), deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const projectRoot = deps.projectRoot || PROJECT_ROOT;
  const script = args[0];
  if (!script) throw new Error("diagnostic command is missing its script path");
  const scriptPath = isAbsolute(script) ? script : resolve(projectRoot, script);
  const timeoutMs = Number.isSafeInteger(deps.timeoutMs) && Number(deps.timeoutMs) > 0
    ? Number(deps.timeoutMs)
    : DEFAULT_DOCTOR_CHILD_TIMEOUT_MS;
  const result = run(deps.execPath || process.execPath, [scriptPath, ...args.slice(1)], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const status = result.status ?? 1;
  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  if (stdout) {
    try {
      const json = JSON.parse(stdout);
      if (!okStatuses.has(status)) json._command_status = status;
      return json;
    } catch {
      if (okStatuses.has(status)) {
        throw new Error("diagnostic command returned invalid JSON");
      }
    }
  }
  if (!okStatuses.has(status)) {
    return {
      ok: false,
      status: "command_failed",
      exit_status: status,
      reason: publicCommandFailureReason(
        `${result.error?.code || ""}\n${result.error?.message || ""}\n${stderr}\n${stdout}`,
      ),
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
  const resolvePath = deps.resolvePath || ((path) => isAbsolute(path) ? path : resolve(PROJECT_ROOT, path));
  const dbPath = resolvePath(opts.db);
  const readJson = deps.runJson || runJson;
  const now = deps.now || (() => new Date());
  const status = sanitizeStatusReportForPublicOutput(
    readJson(["scripts/sync-status.mjs", "--db", dbPath, "--format", "json"]),
  );
  const quality = sanitizeQualityReportForPublicOutput(
    readJson(
      ["scripts/lark-im-quality.mjs", "--db", dbPath, "--format", "json"],
      new Set([0, 2]),
    ),
  );
  const live = opts.live
    ? normalizeLiveResult(
        sanitizeLagReportForPublicOutput(
          readJson(
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
              ...(opts.chatPages !== undefined ? ["--chat-pages", String(opts.chatPages)] : []),
              ...(opts.start !== undefined ? ["--start", opts.start] : []),
              ...(opts.end !== undefined ? ["--end", opts.end] : []),
            ],
            new Set([0, 2]),
          ),
        ),
      )
    : null;
  if (live) {
    live.scope = "recent_hot_messages";
    live.auth_identity = "unknown";
  }

  const findings = buildFindings({ status, quality, live });
  const overall = overallStatus({ status, quality, live });

  return {
    ok: ["local_ready", "sampled", "syncing", "catching_up"].includes(overall),
    overall,
    checked_at: now().toISOString(),
    status,
    quality,
    live,
    findings,
  };
}

export {
  DEFAULT_DOCTOR_CHILD_TIMEOUT_MS,
  PROJECT_ROOT,
  buildReport,
  runJson,
};
