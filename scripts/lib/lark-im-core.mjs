// @ts-check

import { createHash } from "node:crypto";

/**
 * @typedef {"sent" | "received"} MessageDirection
 *
 * @typedef {object} MessageCursor
 * @property {string=} kind
 * @property {number=} created_at_ms
 * @property {string=} message_id
 * @property {string=} updated_at
 *
 * @typedef {object} LarkMessage
 * @property {string=} message_id
 * @property {string=} id
 * @property {string | number=} create_time
 * @property {string | number=} created_at
 * @property {string | number=} create_time_ms
 * @property {string=} update_time
 * @property {string=} msg_type
 * @property {string=} message_type
 * @property {Record<string, any>=} sender
 * @property {string=} chat_id
 * @property {Record<string, any>=} chat
 * @property {string=} chat_type
 * @property {string=} chat_name
 * @property {Record<string, any>=} chat_partner
 * @property {string=} thread_id
 * @property {boolean=} deleted
 * @property {boolean=} updated
 * @property {Array<Record<string, any>>=} mentions
 * @property {unknown=} content
 *
 * @typedef {object} NameDetails
 * @property {string} name
 * @property {string} source
 * @property {string} confidence
 *
 * @typedef {string | NameDetails | Record<string, any>} NameValue
 *
 * @typedef {object} PeopleContext
 * @property {Map<string, NameValue>=} apps
 * @property {Map<string, NameValue>=} app_fallbacks
 * @property {Map<string, NameValue>=} chat_members
 * @property {Map<string, NameValue>=} contacts
 * @property {{open_id?: string, name?: string}=} self
 *
 * @typedef {object} ScopeConfig
 * @property {string=} chat_id
 * @property {string=} chat_type
 * @property {string=} chat_name
 *
 * @typedef {object} LocalRecord
 * @property {string} source_id
 * @property {string} first_seen_scope_id
 * @property {string} external_id
 * @property {string | null} external_version
 * @property {string} record_type
 * @property {string | null} occurred_at
 * @property {number} occurred_at_ms
 * @property {string | null} actor_id
 * @property {string | null} container_id
 * @property {MessageDirection} direction
 * @property {string | null} title
 * @property {string} body
 * @property {string} content_hash
 * @property {string} canonical_json
 * @property {string} raw_json
 *
 * @typedef {object} MessageWindowOptions
 * @property {number} startMs
 * @property {number} endMs
 * @property {number=} stableHorizonMs
 * @property {boolean=} endExplicit
 *
 * @typedef {object} SyncScopeLike
 * @property {MessageCursor | null=} cursor
 *
 * @typedef {object} PageResult
 * @property {LarkMessage[]=} messages
 * @property {boolean=} has_more
 * @property {string=} page_token
 */

const SOURCE_ID = "lark.im";
const SENT_SCOPE_ID = "lark.im.sent_by_me";
const CHAT_DISCOVERY_SCOPE_ID = "lark.im.unmuted_chat_discovery";
const CHAT_HOT_DISCOVERY_SCOPE_ID = "lark.im.unmuted_chat_hot";
const CHAT_RECONCILE_SCOPE_ID = "lark.im.unmuted_chat_reconcile";

/** @param {number} n */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/** @param {Date} date */
function localOffset(date) {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** @param {Date} date */
function localDay(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** @param {number} ms */
function localIsoFromMs(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${localOffset(date)}`;
}

/** @param {LarkMessage | null | undefined} message */
function senderId(message) {
  const sender = message?.sender;
  if (!sender || typeof sender !== "object") return "";
  return (
    sender.id ||
    sender.open_id ||
    sender.sender_id?.open_id ||
    sender.sender_id?.user_id ||
    sender.sender_id ||
    ""
  );
}

/** @param {LarkMessage | null | undefined} message */
function senderName(message) {
  const sender = message?.sender;
  if (!sender || typeof sender !== "object") return "";
  return sender.name || sender.display_name || "";
}

/** @param {LarkMessage | null | undefined} message */
function senderType(message) {
  const sender = message?.sender;
  if (!sender || typeof sender !== "object") return null;
  if (sender.sender_type || sender.type) return sender.sender_type || sender.type;
  if (sender.id_type === "app_id" || String(sender.id || "").startsWith("cli_")) return "app";
  if (sender.id_type === "open_id" || String(sender.id || "").startsWith("ou_")) return "user";
  return null;
}

/** @param {LarkMessage | null | undefined} message */
function chatId(message) {
  return message?.chat_id || message?.chat?.chat_id || message?.chat?.id || "";
}

/** @param {LarkMessage | null | undefined} message */
function messageId(message) {
  return message?.message_id || message?.id || "";
}

/** @param {unknown} value */
function parseLarkTimeMs(value) {
  if (value === null || value === undefined || value === "") return NaN;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const parsed = Number.parseInt(String(value), 10);
    return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
  }
  const text = String(value);
  const simple = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (simple) {
    const [, year, month, day, hour, minute, second = "0"] = simple;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ).getTime();
  }
  return Date.parse(text);
}

/** @param {number} ms */
function occurredAtIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** @param {unknown} content */
function bodyFromContent(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (typeof content === "object") {
    const objectContent = /** @type {Record<string, any>} */ (content);
    if (typeof objectContent.text === "string") return objectContent.text;
    if (typeof objectContent.content === "string") return objectContent.content;
    return JSON.stringify(objectContent);
  }
  return String(content);
}

/** @param {unknown} value */
function isInvalidRenderedContent(value) {
  return /^\[Invalid .+ JSON\]$/.test(String(value || "").trim());
}

/** @param {LarkMessage | null | undefined} message */
function bodyFromMessage(message) {
  const body = bodyFromContent(message?.content);
  if (message?.deleted === true && isInvalidRenderedContent(body)) {
    return "[已撤回/已删除：飞书未返回原始富文本内容]";
  }
  return body;
}

/** @param {unknown} value */
function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

/** @param {unknown} value */
function shortHash(value) {
  return hash(value).slice(0, 16);
}

/**
 * @param {NameValue | null | undefined} value
 * @param {string} source
 * @param {string} confidence
 * @returns {NameDetails | null}
 */
function nameCandidate(value, source, confidence) {
  if (!value) return null;
  if (typeof value === "string") return { name: value, source, confidence };
  if (typeof value === "object") {
    const objectValue = /** @type {Record<string, any>} */ (value);
    const name = objectValue.name || objectValue.display_name || objectValue.bot_name || "";
    if (!name) return null;
    return {
      name,
      source: objectValue.source || source,
      confidence: objectValue.confidence || confidence,
    };
  }
  return null;
}

/**
 * @param {PeopleContext} context
 * @param {string | null | undefined} id
 * @param {string} chatIdValue
 * @returns {NameDetails | null}
 */
function lookupDisplayNameDetails(context, id, chatIdValue) {
  if (!id) return null;
  const app = nameCandidate(context.apps?.get(id), "application_api", "high");
  if (app) return app;
  const appFallback = nameCandidate(context.app_fallbacks?.get(`${chatIdValue}:${id}`), "chat_bot_unique", "medium");
  if (appFallback) return appFallback;
  const chatMember = nameCandidate(context.chat_members?.get(`${chatIdValue}:${id}`), "chat_member", "high");
  if (chatMember) return chatMember;
  const contact = nameCandidate(context.contacts?.get(id), "contact", "high");
  if (contact) return contact;
  if (context.self?.open_id === id) {
    return { name: context.self.name || context.self.open_id, source: "self", confidence: "high" };
  }
  return null;
}

/**
 * @param {PeopleContext} context
 * @param {string | null | undefined} id
 * @param {string} chatIdValue
 */
function lookupDisplayName(context, id, chatIdValue) {
  return lookupDisplayNameDetails(context, id, chatIdValue)?.name || "";
}

/**
 * @param {LarkMessage} message
 * @param {string} scopeId
 * @param {MessageDirection} direction
 * @param {PeopleContext} [context]
 * @param {ScopeConfig} [scopeConfig]
 * @returns {LocalRecord}
 */
function recordFromMessage(message, scopeId, direction, context = {}, scopeConfig = {}) {
  const externalId = messageId(message);
  const occurredAtMs = parseLarkTimeMs(message?.create_time ?? message?.created_at ?? message?.create_time_ms);
  const actorId = senderId(message);
  const containerId = chatId(message) || scopeConfig.chat_id || "";
  const sender = message?.sender && typeof message.sender === "object" ? message.sender : {};
  const chatPartner =
    message?.chat_partner && typeof message.chat_partner === "object" ? message.chat_partner : null;
  const chatType = message?.chat_type || message?.chat?.chat_type || scopeConfig.chat_type || null;
  const partnerId = chatPartner?.open_id || chatPartner?.id || chatPartner?.user_id || null;
  const senderDirectName = sender.name || sender.display_name || "";
  const senderNameDetails = senderDirectName
    ? { name: senderDirectName, source: "message_sender", confidence: "high" }
    : lookupDisplayNameDetails(context, actorId, containerId);
  const senderDisplayName = senderNameDetails?.name || "";
  const partnerDisplayName =
    chatPartner?.name || chatPartner?.display_name || lookupDisplayName(context, partnerId, containerId);
  const canonical = {
    message_id: externalId,
    msg_type: message?.msg_type || message?.message_type || null,
    create_time: message?.create_time ?? null,
    create_time_ms: occurredAtMs,
    sender_id: actorId,
    sender_name: senderDisplayName || null,
    sender_name_source: senderDisplayName ? senderNameDetails?.source || null : null,
    sender_name_confidence: senderDisplayName ? senderNameDetails?.confidence || null : null,
    sender_type: senderType(message),
    chat_id: containerId,
    chat_type: chatType,
    chat_name: message?.chat_name || message?.chat?.name || scopeConfig.chat_name || null,
    chat_partner: chatPartner
      ? {
          open_id: partnerId,
          name: partnerDisplayName || null,
        }
      : null,
    thread_id: message?.thread_id || null,
    deleted: typeof message?.deleted === "boolean" ? message.deleted : null,
    updated: typeof message?.updated === "boolean" ? message.updated : null,
    mentions: Array.isArray(message?.mentions) ? message.mentions : [],
    content: message?.content ?? null,
  };
  const rawJson = JSON.stringify(message);
  const body = bodyFromMessage(message);
  return {
    source_id: SOURCE_ID,
    first_seen_scope_id: scopeId,
    external_id: externalId,
    external_version: message?.update_time ? String(message.update_time) : null,
    record_type: "lark.im.message",
    occurred_at: occurredAtIso(occurredAtMs),
    occurred_at_ms: occurredAtMs,
    actor_id: actorId || null,
    container_id: containerId || null,
    direction,
    title: null,
    body,
    content_hash: hash(rawJson),
    canonical_json: JSON.stringify(canonical),
    raw_json: rawJson,
  };
}

/**
 * @param {LocalRecord} record
 * @param {MessageCursor | null | undefined} cursor
 * @param {number} fallbackStartMs
 */
function compareRecordToCursor(record, cursor, fallbackStartMs) {
  const hasCursor = cursor?.created_at_ms !== undefined && cursor?.created_at_ms !== null;
  const cursorMs = Number(hasCursor ? cursor.created_at_ms : fallbackStartMs - 1);
  const cursorId = String(cursor?.message_id ?? "");
  if (record.occurred_at_ms > cursorMs) return 1;
  if (record.occurred_at_ms < cursorMs) return -1;
  return String(record.external_id).localeCompare(cursorId);
}

/**
 * @param {LarkMessage[]} messages
 * @param {string} scopeId
 * @param {MessageDirection} direction
 * @param {MessageCursor | null | undefined} cursor
 * @param {number} startMs
 * @param {number} endMs
 * @param {((record: LocalRecord) => boolean) | null} [filterFn]
 * @param {PeopleContext} [context]
 * @param {ScopeConfig} [scopeConfig]
 * @returns {LocalRecord[]}
 */
function prepareRecords(messages, scopeId, direction, cursor, startMs, endMs, filterFn = null, context = {}, scopeConfig = {}) {
  return messages
    .filter((message) => messageId(message))
    .map((message) => recordFromMessage(message, scopeId, direction, context, scopeConfig))
    .filter((record) => Number.isFinite(record.occurred_at_ms))
    .filter((record) => record.occurred_at_ms <= endMs)
    .filter((record) => compareRecordToCursor(record, cursor, startMs) > 0)
    .filter((record) => (filterFn ? filterFn(record) : true))
    .sort((a, b) => a.occurred_at_ms - b.occurred_at_ms || a.external_id.localeCompare(b.external_id));
}

/** @param {number} endMs */
function cursorAfter(endMs) {
  return {
    kind: "time_message_cursor/v1",
    meaning: "scanned_until_inclusive",
    created_at_ms: endMs,
    message_id: "",
    updated_at: new Date().toISOString(),
  };
}

/**
 * @param {MessageWindowOptions} opts
 * @param {number} startMs
 */
function stableMessageEndMs(opts, startMs) {
  const guardMs = opts.endExplicit ? 0 : Number(opts.stableHorizonMs || 0);
  return Math.max(startMs, opts.endMs - guardMs);
}

/**
 * @param {SyncScopeLike} scope
 * @param {MessageWindowOptions} opts
 */
function messageWindow(scope, opts) {
  const startMs = Number(scope.cursor?.created_at_ms ?? opts.startMs);
  return {
    startMs,
    endMs: stableMessageEndMs(opts, startMs),
  };
}

/**
 * @param {object} options
 * @param {(pageToken: string) => PageResult} options.fetchPage
 * @param {number} options.maxPages
 * @param {string} options.missingPageTokenMessage
 * @param {(maxPages: number) => string} options.maxPagesMessage
 */
function readBoundedPages({ fetchPage, maxPages, missingPageTokenMessage, maxPagesMessage }) {
  const messages = [];
  let pageToken = "";
  let hasMore = false;
  let pages = 0;
  do {
    pages += 1;
    const page = fetchPage(pageToken);
    messages.push(...(page.messages || []));
    hasMore = Boolean(page.has_more);
    pageToken = page.page_token || "";
    if (hasMore && !pageToken) throw new Error(missingPageTokenMessage);
    if (hasMore && pages >= maxPages) throw new Error(maxPagesMessage(maxPages));
  } while (hasMore);
  return { messages, pages };
}

/** @param {string} chatIdValue */
function chatScopeId(chatIdValue) {
  return `lark.im.received.chat.${shortHash(chatIdValue)}`;
}

export {
  CHAT_DISCOVERY_SCOPE_ID,
  CHAT_HOT_DISCOVERY_SCOPE_ID,
  CHAT_RECONCILE_SCOPE_ID,
  SENT_SCOPE_ID,
  SOURCE_ID,
  bodyFromContent,
  bodyFromMessage,
  chatId,
  chatScopeId,
  compareRecordToCursor,
  cursorAfter,
  hash,
  isInvalidRenderedContent,
  localDay,
  localIsoFromMs,
  localOffset,
  lookupDisplayName,
  messageId,
  messageWindow,
  occurredAtIso,
  parseLarkTimeMs,
  prepareRecords,
  readBoundedPages,
  recordFromMessage,
  senderId,
  senderName,
  senderType,
  shortHash,
  stableMessageEndMs,
};
