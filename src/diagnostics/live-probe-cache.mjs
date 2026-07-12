// @ts-check

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { publicTimestamp } from "./public-safe.mjs";

const DEFAULT_LIVE_PROBE_CACHE_PATH = "logs/lark-im/live-probe.json";

/**
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} LiveProbeCacheDeps
 * @property {(path: string) => boolean=} existsSync
 * @property {(path: string, mode: number) => void=} chmodSync
 * @property {(path: string, options?: {recursive?: boolean, mode?: number}) => void=} mkdirSync
 * @property {(path: string, encoding: BufferEncoding) => string=} readFileSync
 * @property {(path: string, data: string, options?: {mode?: number}) => void=} writeFileSync
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
  const status = ["healthy", "delayed", "needs_attention", "inconclusive", "unavailable"].includes(
    String(live.status),
  )
    ? String(live.status)
    : "unknown";
  const safeReasons = new Set([
    "keychain_unavailable",
    "no_hot_chats",
    "no_usable_remote_messages",
    "remote_missing",
  ]);
  return {
    kind: "lark_im_live_probe_cache/v1",
    checked_at: publicTimestamp(report.checked_at) || new Date().toISOString(),
    status,
    ok: live.ok === true,
    missing_count: finiteNumberOrNull(live.missing_count),
    lag_ms: finiteNumberOrNull(live.lag_ms),
    reason: safeReasons.has(String(live.reason)) ? String(live.reason) : null,
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
  const changeMode = deps.chmodSync || (!deps.mkdirSync && !deps.writeFileSync ? chmodSync : null);
  const parent = dirname(path);
  makeDir(parent, { recursive: true, mode: 0o700 });
  if (changeMode && parent !== ".") changeMode(parent, 0o700);
  writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  if (changeMode) changeMode(path, 0o600);
  return cache;
}

/**
 * @param {string} path
 * @param {LiveProbeCacheDeps} [deps]
 */
function readLiveProbeCache(path, deps = {}) {
  const exists = deps.existsSync || existsSync;
  const readFile = deps.readFileSync || readFileSync;
  const changeMode = deps.chmodSync || (!deps.existsSync && !deps.readFileSync ? chmodSync : null);
  if (!exists(path)) return null;
  try {
    const parent = dirname(path);
    if (changeMode && parent !== ".") changeMode(parent, 0o700);
    if (changeMode) changeMode(path, 0o600);
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
