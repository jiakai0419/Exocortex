// @ts-check

import { readOnlySqliteJson } from "../storage/sqlite/readonly-query.mjs";

import { spawnSync } from "node:child_process";
import { parseLarkTimeMs } from "../adapters/lark-im/core.mjs";
import { nativePage, assertRawMessagePage } from "../adapters/lark-im/adapter.mjs";
import {
  buildLagReport,
  normalizeRemoteMessage,
} from "./lark-im-lag-core.mjs";
import {
  diagnosticSubprocessError,
  publicCommandFailureReason,
} from "./public-safe.mjs";

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
  return readOnlySqliteJson(dbPath, sql, label);
}

/** @param {string[]} args */
function runLark(args) {
  const bin = process.env.LARK_CLI || "lark-cli";
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
  if (result.status !== 0 || result.error) {
    const stderr = String(result.stderr || "");
    const spawnError = /** @type {NodeJS.ErrnoException | undefined} */ (result.error);
    if (/"code"\s*:\s*231203|Restricted Mode|don't allow copying or forwarding messages/i.test(stderr)) {
      throw new Error("reason=restricted_mode code=231203");
    }
    if (publicCommandFailureReason(`${spawnError?.code || ""}\n${stderr}`) === "keychain_unavailable") {
      throw new Error("keychain not initialized");
    }
    throw diagnosticSubprocessError(result, "lark-cli live probe");
  }
  const trimmed = String(result.stdout || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error("lark-cli live probe returned invalid JSON");
  }
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
  return /"code"\s*:\s*231203|\bcode=231203\b|reason=restricted_mode|Restricted Mode|don't allow copying or forwarding messages/i.test(message);
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
      "group,p2p",
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
        chat_type: chat.chat_mode || chat.chat_type || "unknown",
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
  if (typeof chat.chat_id !== "string" || !chat.chat_id.trim() ||
      !Number.isSafeInteger(opts.startMs) || !Number.isSafeInteger(opts.endMs) ||
      opts.startMs < 0 || opts.endMs <= opts.startMs || !Number.isFinite(new Date(opts.endMs).getTime()) ||
      !Number.isSafeInteger(opts.messagesPerChat) || opts.messagesPerChat < 1) {
    throw new Error("live message sample requires a chat, valid window and positive page size");
  }
  const callLark = deps.runLark || runLark;
  const pageSize = Math.min(50, opts.messagesPerChat);
  const args = [
    "api",
    "GET",
    "/open-apis/im/v1/messages",
    "--as",
    "user",
    "--params",
    JSON.stringify({
      container_id_type: "chat", container_id: chat.chat_id,
      only_thread_root_messages: false, sort_type: "ByCreateTimeDesc",
      page_size: pageSize, card_msg_content_type: "raw_card_content",
      start_time: String(Math.floor(opts.startMs / 1000)),
      end_time: String(Math.ceil(opts.endMs / 1000)),
    }),
    "--format",
    "json",
  ];
  const json = callLark(args);
  const page = nativePage(json, "live message sample", new Set());
  assertRawMessagePage(page.items, "live message sample");
  if (page.items.length > pageSize) throw new Error("live message sample exceeded its page size");
  if (page.items.some((message) => message.chat_id !== undefined && message.chat_id !== chat.chat_id)) {
    throw new Error("live message sample contains a different chat");
  }
  // Deliberately one list page: no cursor continuation, thread requests,
  // merged-message expansion or metadata enrichment. Compare ID presence only.
  return page.items.filter((message) => {
    const createdMs = parseLarkTimeMs(message.create_time ?? message.created_at ?? message.create_time_ms);
    return createdMs >= opts.startMs && createdMs <= opts.endMs;
  }).map((message) => ({ ...message, content: message.body.content }));
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
       AND record_type = 'lark.im.message'
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
