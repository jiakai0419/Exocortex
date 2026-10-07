// @ts-check

import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { readStableJsonFile } from "./private-json-file.mjs";
import { parseRemoteSampleCache } from "./remote-sample-cache.mjs";
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
 * @property {(path: string, encoding: BufferEncoding) => string=} readFileSync
 */

/** @param {unknown} value */
function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** @param {string} path @param {LiveProbeCacheDeps} [deps] */
function readLiveProbeCache(path, deps = {}) {
  const exists = deps.existsSync || existsSync;
  const readFile = deps.readFileSync || readFileSync;
  if (!exists(path)) return null;
  try {
    const stable = deps.readFileSync ? null : readStableJsonFile(path, { maxBytes: 65536, requirePrivate: false });
    if (stable && stable.status !== "ready") return null;
    const parsed = stable ? stable.value : JSON.parse(readFile(path, "utf8"));
    if (parsed?.kind === "lark_im_live_probe_cache/v3") return stable?.private ? parseRemoteSampleCache(parsed) : null;
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
  readLiveProbeCache,
};
