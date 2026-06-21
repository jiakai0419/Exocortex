// @ts-check

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const DEFAULT_LIVE_PROBE_CACHE_PATH = "logs/lark-im/live-probe.json";

/**
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} LiveProbeCacheDeps
 * @property {(path: string) => boolean=} existsSync
 * @property {(path: string, options?: {recursive?: boolean}) => void=} mkdirSync
 * @property {(path: string, encoding: BufferEncoding) => string=} readFileSync
 * @property {(path: string, data: string) => void=} writeFileSync
 */

/** @param {unknown} value */
function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Keep the cache intentionally small and redacted. Do not persist message ids,
 * people, chats, links, stdout, stderr, or missing message samples.
 *
 * @param {JsonObject} report
 */
function liveProbeCacheFromReport(report) {
  const live = report.live;
  if (!live) return null;
  return {
    kind: "lark_im_live_probe_cache/v1",
    checked_at: report.checked_at || new Date().toISOString(),
    status: String(live.status || "unknown"),
    ok: live.ok === true,
    missing_count: finiteNumberOrNull(live.missing_count),
    lag_ms: finiteNumberOrNull(live.lag_ms),
    reason: live.reason || null,
  };
}

/**
 * @param {string} path
 * @param {JsonObject} report
 * @param {LiveProbeCacheDeps} [deps]
 */
function writeLiveProbeCache(path, report, deps = {}) {
  const cache = liveProbeCacheFromReport(report);
  if (!cache) return null;
  const makeDir = deps.mkdirSync || mkdirSync;
  const writeFile = deps.writeFileSync || writeFileSync;
  makeDir(dirname(path), { recursive: true });
  writeFile(path, `${JSON.stringify(cache, null, 2)}\n`);
  return cache;
}

/**
 * @param {string} path
 * @param {LiveProbeCacheDeps} [deps]
 */
function readLiveProbeCache(path, deps = {}) {
  const exists = deps.existsSync || existsSync;
  const readFile = deps.readFileSync || readFileSync;
  if (!exists(path)) return null;
  try {
    const parsed = JSON.parse(readFile(path, "utf8"));
    if (parsed?.kind !== "lark_im_live_probe_cache/v1") return null;
    return parsed;
  } catch {
    return null;
  }
}

export {
  DEFAULT_LIVE_PROBE_CACHE_PATH,
  liveProbeCacheFromReport,
  readLiveProbeCache,
  writeLiveProbeCache,
};
