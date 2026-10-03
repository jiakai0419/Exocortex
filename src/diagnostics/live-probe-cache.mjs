// @ts-check

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { publicTimestamp } from "./public-safe.mjs";

const DEFAULT_LIVE_PROBE_CACHE_PATH = "logs/lark-im/live-probe.json";
const DEFAULT_LIVE_PROBE_TTL_MS = 5 * 60 * 1000;

/** Bind evidence to a local file/source without requesting account credentials.
 * @param {string} dbPath
 */
function liveProbeContext(dbPath) {
  try {
    const canonicalPath = realpathSync(dbPath);
    const info = statSync(canonicalPath);
    if (!info.isFile()) return null;
    return {
      database_key: createHash("sha256").update(JSON.stringify([canonicalPath, info.dev, info.ino])).digest("hex"),
      source_id: "lark.im",
      auth_identity_verified: false,
    };
  } catch { return null; }
}

/** @param {unknown} input */
function publicProbeContext(input) {
  if (!input || typeof input !== "object") return null;
  const context = /** @type {JsonObject} */ (input);
  if (!/^[a-f0-9]{64}$/.test(String(context.database_key || "")) || context.source_id !== "lark.im") return null;
  return { database_key: context.database_key, source_id: "lark.im", auth_identity_verified: false };
}

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
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
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
  let status = ["healthy", "delayed", "needs_attention", "inconclusive", "unavailable"].includes(
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
  const checkedAt = publicTimestamp(report.checked_at) || new Date().toISOString();
  const sampleCount = finiteNumberOrNull(live.probe?.remote_messages_checked) || 0;
  if (status === "healthy" && sampleCount === 0) status = "inconclusive";
  return {
    kind: "lark_im_live_probe_cache/v2",
    context: publicProbeContext(report.cache_context),
    scope: "recent_hot_messages",
    checked_at: checkedAt,
    expires_at: new Date(Date.parse(checkedAt) + DEFAULT_LIVE_PROBE_TTL_MS).toISOString(),
    window: { start: publicTimestamp(live.window?.start), end: publicTimestamp(live.window?.end) },
    sample: {
      hot_chats_requested: finiteNumberOrNull(live.probe?.hot_chats_requested),
      hot_chats_found: finiteNumberOrNull(live.probe?.hot_chats_found),
      messages_per_chat: finiteNumberOrNull(live.probe?.messages_per_chat),
      remote_messages_checked: sampleCount,
      unsupported_chats: finiteNumberOrNull(live.probe?.unsupported_chats) || 0,
      probe_errors: finiteNumberOrNull(live.probe?.probe_errors) || 0,
    },
    status,
    ok: status === "healthy" && live.ok === true && sampleCount > 0,
    missing_count: finiteNumberOrNull(live.missing_count),
    lag_ms: finiteNumberOrNull(live.lag_ms),
    reason: status === "inconclusive" && sampleCount === 0 ? "no_usable_remote_messages"
      : safeReasons.has(String(live.reason)) ? String(live.reason) : null,
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
  if (!exists(path)) return null;
  try {
    const parsed = JSON.parse(readFile(path, "utf8"));
    if (!["lark_im_live_probe_cache/v1", "lark_im_live_probe_cache/v2"].includes(parsed?.kind)) return null;
    const base = {
      kind: parsed.kind,
      checked_at: publicTimestamp(parsed.checked_at),
      status: ["healthy", "delayed", "needs_attention", "inconclusive", "unavailable"].includes(parsed.status) ? parsed.status : "unknown",
      ok: parsed.ok === true,
      missing_count: finiteNumberOrNull(parsed.missing_count), lag_ms: finiteNumberOrNull(parsed.lag_ms),
      reason: ["keychain_unavailable", "no_hot_chats", "no_usable_remote_messages", "remote_missing"].includes(parsed.reason) ? parsed.reason : null,
    };
    if (parsed.kind === "lark_im_live_probe_cache/v1") return base;
    return { ...base, context: publicProbeContext(parsed.context),
      scope: parsed.scope === "recent_hot_messages" ? parsed.scope : "unknown",
      expires_at: publicTimestamp(parsed.expires_at),
      window: { start: publicTimestamp(parsed.window?.start), end: publicTimestamp(parsed.window?.end) },
      sample: {
        hot_chats_requested: finiteNumberOrNull(parsed.sample?.hot_chats_requested),
        hot_chats_found: finiteNumberOrNull(parsed.sample?.hot_chats_found),
        messages_per_chat: finiteNumberOrNull(parsed.sample?.messages_per_chat),
        remote_messages_checked: finiteNumberOrNull(parsed.sample?.remote_messages_checked),
        unsupported_chats: finiteNumberOrNull(parsed.sample?.unsupported_chats),
        probe_errors: finiteNumberOrNull(parsed.sample?.probe_errors),
      },
    };
  } catch {
    return null;
  }
}

export {
  DEFAULT_LIVE_PROBE_CACHE_PATH,
  DEFAULT_LIVE_PROBE_TTL_MS,
  liveProbeContext,
  liveProbeCacheFromReport,
  readLiveProbeCache,
  writeLiveProbeCache,
};
