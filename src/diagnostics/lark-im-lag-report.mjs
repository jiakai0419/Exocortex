// @ts-check

import { spawnSync } from "node:child_process";
import { localIsoFromMs } from "../adapters/lark-im/core.mjs";
import {
  buildLagReport,
  normalizeRemoteMessage,
} from "./lark-im-lag-core.mjs";

/**
 * @typedef {Record<string, any>} JsonObject
 * @typedef {import("./lark-im-lag-core.mjs").LagOptions & {chatPages?: number}} LagProbeOptions
 *
 * @typedef {object} LagReportDeps
 * @property {(args: string[]) => JsonObject | null=} runLark
 * @property {(dbPath: string, sql: string, label: string) => JsonObject[]=} sqliteJson
 * @property {() => string=} getSelfOpenId
 * @property {(opts: LagProbeOptions) => JsonObject[]=} fetchHotChats
 * @property {(chat: JsonObject, opts: LagProbeOptions) => JsonObject[]=} fetchRecentChatMessages
 * @property {(dbPath: string, messageIds: string[]) => Map<string, unknown> | Set<string>=} loadExistingRecords
 * @property {(dbPath: string) => JsonObject | null=} localLatest
 */

/** @param {unknown} value */
function quoteSql(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * @param {string} dbPath
 * @param {string} sql
 * @param {string} label
 * @returns {JsonObject[]}
 */
function sqliteJson(dbPath, sql, label) {
  const result = spawnSync("sqlite3", ["-json", dbPath], {
    input: `.timeout 5000\n${sql}`,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr.trim()}`);
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

/** @param {string[]} args */
function runLark(args) {
  const bin = process.env.LARK_CLI || "lark-cli";
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
  if (result.status !== 0) {
    const error = new Error(result.stderr.trim() || `${bin} ${args.join(" ")} failed`);
    // @ts-expect-error dynamic compatibility field for callers that inspect process status.
    error.exitCode = result.status;
    throw error;
  }
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

/** @param {unknown[]} values */
function firstArray(...values) {
  return values.find((value) => Array.isArray(value)) || [];
}

/**
 * @param {unknown} json
 * @param {string} collectionName
 */
function envelope(json, collectionName) {
  const root = json && typeof json === "object" ? /** @type {JsonObject} */ (json) : {};
  const data = root.data && typeof root.data === "object" ? root.data : {};
  return {
    items: firstArray(root[collectionName], data[collectionName], root.items, data.items, root.results, data.results),
    has_more: Boolean(root.has_more ?? data.has_more),
    page_token: root.page_token || data.page_token || "",
  };
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "");
}

/** @param {unknown} error */
function isRestrictedModeError(error) {
  const message = errorMessage(error);
  return /"code"\s*:\s*231203|Restricted Mode|don't allow copying or forwarding messages/i.test(message);
}

/** @param {LagReportDeps} [deps] */
function getSelfOpenId(deps = {}) {
  const callLark = deps.runLark || runLark;
  const json = callLark(["contact", "+get-user", "--as", "user", "--format", "json"]);
  return (
    json?.open_id ||
    json?.user?.open_id ||
    json?.data?.open_id ||
    json?.data?.user?.open_id ||
    json?.data?.user_id?.open_id ||
    ""
  );
}

/**
 * @param {LagProbeOptions} opts
 * @param {LagReportDeps} [deps]
 */
function fetchHotChats(opts, deps = {}) {
  const callLark = deps.runLark || runLark;
  const chats = [];
  const seen = new Set();
  let pageToken = "";
  const chatPages = opts.chatPages || 0;
  for (let page = 0; page < chatPages && chats.length < opts.hotChats; page += 1) {
    const args = [
      "im",
      "+chat-list",
      "--as",
      "user",
      "--exclude-muted",
      "--types",
      "group",
      "--sort",
      "active_time",
      "--page-size",
      "100",
      "--format",
      "json",
    ];
    if (pageToken) args.push("--page-token", pageToken);
    const json = callLark(args);
    const pageData = envelope(json, "chats");
    for (const chat of pageData.items) {
      if (!chat?.chat_id || seen.has(chat.chat_id)) continue;
      seen.add(chat.chat_id);
      chats.push({
        chat_id: chat.chat_id,
        chat_name: chat.name || chat.i18n_names?.zh_cn || chat.i18n_names?.en_us || chat.chat_id,
        chat_type: chat.chat_mode || "group",
      });
      if (chats.length >= opts.hotChats) break;
    }
    pageToken = pageData.page_token;
    if (!pageData.has_more || !pageToken) break;
  }
  return chats;
}

/**
 * @param {JsonObject} chat
 * @param {LagProbeOptions} opts
 * @param {LagReportDeps} [deps]
 */
function fetchRecentChatMessages(chat, opts, deps = {}) {
  const callLark = deps.runLark || runLark;
  const args = [
    "im",
    "+chat-messages-list",
    "--as",
    "user",
    "--chat-id",
    chat.chat_id,
    "--start",
    localIsoFromMs(opts.startMs),
    "--end",
    localIsoFromMs(opts.endMs),
    "--order",
    "desc",
    "--page-size",
    String(Math.min(50, opts.messagesPerChat)),
    "--no-reactions",
    "--format",
    "json",
  ];
  const json = callLark(args);
  return envelope(json, "messages").items;
}

/**
 * @param {string} dbPath
 * @param {string[]} messageIds
 * @param {LagReportDeps} [deps]
 */
function loadExistingRecords(dbPath, messageIds, deps = {}) {
  if (messageIds.length === 0) return new Map();
  const queryJson = deps.sqliteJson || sqliteJson;
  const rows = queryJson(
    dbPath,
    `SELECT external_id, occurred_at_ms
     FROM records
     WHERE source_id = 'lark.im'
       AND external_id IN (${messageIds.map((id) => quoteSql(id)).join(", ")});`,
    "load existing records",
  );
  return new Map(rows.map((row) => [row.external_id, row]));
}

/**
 * @param {string} dbPath
 * @param {LagReportDeps} [deps]
 */
function localLatest(dbPath, deps = {}) {
  const queryJson = deps.sqliteJson || sqliteJson;
  const rows = queryJson(
    dbPath,
    `SELECT external_id, direction, occurred_at_ms, occurred_at, json_extract(canonical_json, '$.chat_name') AS chat_name
     FROM records
     WHERE source_id = 'lark.im'
       AND record_type = 'lark.im.message'
     ORDER BY occurred_at_ms DESC, external_id DESC
     LIMIT 1;`,
    "local latest",
  );
  return rows[0] || null;
}

/**
 * @param {string} dbPath
 * @param {LagProbeOptions} opts
 * @param {LagReportDeps} [deps]
 */
function collectLagReport(dbPath, opts, deps = {}) {
  const selfOpenId = deps.getSelfOpenId ? deps.getSelfOpenId() : getSelfOpenId(deps);
  if (!selfOpenId) throw new Error("could not resolve current Lark user open_id");

  const chats = deps.fetchHotChats ? deps.fetchHotChats(opts) : fetchHotChats(opts, deps);
  const remoteMessages = [];
  const probeErrors = [];
  const unsupportedChats = [];
  const fetchMessages = deps.fetchRecentChatMessages || ((chat, options) => fetchRecentChatMessages(chat, options, deps));

  for (const chat of chats) {
    try {
      const messages = fetchMessages(chat, opts);
      for (const message of messages) {
        const normalized = normalizeRemoteMessage(message, chat, selfOpenId);
        if (normalized) remoteMessages.push(normalized);
      }
    } catch (error) {
      if (isRestrictedModeError(error)) {
        unsupportedChats.push({ chat_id: chat.chat_id, chat_name: chat.chat_name, reason: "restricted_mode" });
      } else {
        probeErrors.push({
          chat_id: chat.chat_id,
          chat_name: chat.chat_name,
          error: errorMessage(error).slice(0, 500),
        });
      }
    }
  }

  const messageIds = [...new Set(remoteMessages.map((message) => message.message_id))];
  const existing = deps.loadExistingRecords
    ? deps.loadExistingRecords(dbPath, messageIds)
    : loadExistingRecords(dbPath, messageIds, deps);
  const latestLocal = deps.localLatest ? deps.localLatest(dbPath) : localLatest(dbPath, deps);
  return buildLagReport({
    opts,
    chats,
    remoteMessages,
    existingRecords: existing,
    latestLocal,
    probeErrors,
    unsupportedChats,
  });
}

export {
  collectLagReport,
  envelope,
  fetchHotChats,
  fetchRecentChatMessages,
  firstArray,
  getSelfOpenId,
  isRestrictedModeError,
  loadExistingRecords,
  localLatest,
  quoteSql,
  runLark,
  sqliteJson,
};
