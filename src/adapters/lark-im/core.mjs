// @ts-check

import {
  compareRecordToCursor,
  floorToPrecisionMs,
  readPaginatedPages,
  stableWindowEndMs,
  timeCursorAfter,
  timeWindow,
  windowRecordsAfterCursor,
} from "../../../dist/core/sync.js";
import {
  SOURCE_ID,
  bodyFromContent,
  bodyFromMessage,
  chatId,
  hash,
  isInvalidRenderedContent,
  lookupDisplayName,
  messageId,
  occurredAtIso,
  parseLarkTimeMs,
  recordFromMessage,
  senderId,
  senderName,
  senderType,
  shortHash,
} from "./message-record.mjs";

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
 * @typedef {string | {name: string, source: string, confidence: string} | Record<string, any>} NameValue
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

const SENT_SCOPE_ID = "lark.im.sent_by_me";
const CHAT_DISCOVERY_SCOPE_ID = "lark.im.unmuted_chat_discovery";
const CHAT_HOT_DISCOVERY_SCOPE_ID = "lark.im.unmuted_chat_hot";
const CHAT_RECONCILE_SCOPE_ID = "lark.im.unmuted_chat_reconcile";
const LARK_MESSAGE_CURSOR_PRECISION_MS = 60_000;

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
  const records = messages
    .filter((message) => messageId(message))
    .map((message) => recordFromMessage(message, scopeId, direction, context, scopeConfig));
  return windowRecordsAfterCursor(records, cursor, startMs, endMs, filterFn);
}

/** @param {number} ms */
function floorToLarkMessageCursorMs(ms) {
  return floorToPrecisionMs(Number(ms), LARK_MESSAGE_CURSOR_PRECISION_MS);
}

/**
 * Lark IM message create_time currently has minute precision in the user APIs
 * we consume. Advancing a cursor to a second-level window end can skip messages
 * that become visible later but still render as the same minute.
 *
 * @param {number} endMs
 */
function cursorAfter(endMs) {
  return timeCursorAfter({
    kind: "time_message_cursor/v1",
    meaning: "scanned_until_inclusive",
    sourceTimePrecision: "minute",
    endMs,
    precisionMs: LARK_MESSAGE_CURSOR_PRECISION_MS,
  });
}

/**
 * @param {MessageWindowOptions} opts
 * @param {number} startMs
 */
function stableMessageEndMs(opts, startMs) {
  return stableWindowEndMs(opts, startMs);
}

/**
 * @param {SyncScopeLike} scope
 * @param {MessageWindowOptions} opts
 */
function messageWindow(scope, opts) {
  return timeWindow(scope, opts);
}

/**
 * @param {object} options
 * @param {(pageToken: string) => PageResult} options.fetchPage
 * @param {number} options.maxPages
 * @param {string} options.missingPageTokenMessage
 * @param {(maxPages: number) => string} options.maxPagesMessage
 */
function readBoundedPages({ fetchPage, maxPages, missingPageTokenMessage, maxPagesMessage }) {
  const result = readPaginatedPages({
    fetchPage,
    maxPages,
    missingPageTokenMessage,
    maxPagesMessage,
    getItems: (page) => page.messages || [],
    getHasMore: (page) => Boolean(page.has_more),
    getPageToken: (page) => page.page_token || "",
  });
  return { messages: result.items, pages: result.pages };
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
  floorToLarkMessageCursorMs,
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
