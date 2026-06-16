// @ts-check

import {
  bodyFromContent,
  localIsoFromMs,
  messageId,
  parseLarkTimeMs,
  senderId,
} from "../adapters/lark-im/core.mjs";

/**
 * @typedef {object} HotChatShape
 * @property {string=} chat_id
 * @property {string=} chat_name
 * @property {string=} chat_type
 *
 * @typedef {object} RemoteMessageShape
 * @property {string=} message_id
 * @property {string=} id
 * @property {string | number=} create_time
 * @property {string | number=} created_at
 * @property {string | number=} create_time_ms
 * @property {string=} chat_id
 * @property {string=} chat_name
 * @property {string=} chat_type
 * @property {string=} msg_type
 * @property {string=} message_type
 * @property {Record<string, any>=} sender
 * @property {unknown=} content
 *
 * @typedef {object} NormalizedRemoteMessage
 * @property {string} message_id
 * @property {string} chat_id
 * @property {string} chat_name
 * @property {string} chat_type
 * @property {string} sender_id
 * @property {string} sender_name
 * @property {string} msg_type
 * @property {string} create_time
 * @property {number} created_at_ms
 * @property {string} body
 *
 * @typedef {object} LocalLatestRecord
 * @property {string=} external_id
 * @property {string=} direction
 * @property {number=} occurred_at_ms
 * @property {string=} occurred_at
 * @property {string=} chat_name
 *
 * @typedef {object} LagOptions
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} hotChats
 * @property {number} messagesPerChat
 *
 * @typedef {object} ProbeIssue
 * @property {string=} chat_id
 * @property {string=} chat_name
 * @property {string=} reason
 * @property {string=} error
 *
 * @typedef {object} BuildLagReportInput
 * @property {LagOptions} opts
 * @property {HotChatShape[]} chats
 * @property {NormalizedRemoteMessage[]} remoteMessages
 * @property {Map<string, unknown> | Set<string>} existingRecords
 * @property {LocalLatestRecord | null=} latestLocal
 * @property {ProbeIssue[]=} probeErrors
 * @property {ProbeIssue[]=} unsupportedChats
 * @property {Date=} checkedAt
 */

/** @param {unknown} value */
function compact(value, limit = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

/** @param {RemoteMessageShape | null | undefined} message */
function fallbackSenderName(message) {
  const sender = message?.sender && typeof message.sender === "object" ? message.sender : {};
  if (sender.name || sender.display_name) return sender.name || sender.display_name;
  const id = String(sender.id || sender.open_id || "");
  if (id.startsWith("cli_")) return `应用 ${id.slice(0, 8)}...`;
  return id ? `${id.slice(0, 8)}...` : "unknown";
}

/**
 * Convert one lark-cli message shape into the redaction-safe structure used by
 * lag classification. Returns null for invalid messages and self-authored
 * messages, because the lag probe checks received hot-chat messages.
 *
 * @param {RemoteMessageShape} message
 * @param {HotChatShape} chat
 * @param {string} selfOpenId
 * @returns {NormalizedRemoteMessage | null}
 */
function normalizeRemoteMessage(message, chat, selfOpenId) {
  const id = messageId(message);
  const createdMs = parseLarkTimeMs(message?.create_time ?? message?.created_at ?? message?.create_time_ms);
  const senderOpenId = senderId(message);
  if (!id || !Number.isFinite(createdMs)) return null;
  if (senderOpenId && senderOpenId === selfOpenId) return null;
  return {
    message_id: id,
    chat_id: message.chat_id || chat.chat_id || "",
    chat_name: message.chat_name || chat.chat_name || "",
    chat_type: message.chat_type || chat.chat_type || "",
    sender_id: senderOpenId,
    sender_name: fallbackSenderName(message),
    msg_type: message.msg_type || message.message_type || "unknown",
    create_time: String(message.create_time || new Date(createdMs).toISOString()),
    created_at_ms: createdMs,
    body: bodyFromContent(message.content),
  };
}

/**
 * @param {Map<string, unknown> | Set<string>} existingRecords
 * @param {string} id
 */
function hasExistingRecord(existingRecords, id) {
  return existingRecords instanceof Map || existingRecords instanceof Set ? existingRecords.has(id) : false;
}

/** @param {BuildLagReportInput} input */
function buildLagReport({
  opts,
  chats,
  remoteMessages,
  existingRecords,
  latestLocal = null,
  probeErrors = [],
  unsupportedChats = [],
  checkedAt = new Date(),
}) {
  const sortedRemote = [...remoteMessages].sort(
    (a, b) => b.created_at_ms - a.created_at_ms || b.message_id.localeCompare(a.message_id),
  );
  const missing = sortedRemote.filter((message) => !hasExistingRecord(existingRecords, message.message_id));
  const latestRemote = sortedRemote[0] || null;
  const latestRemoteIsLocal = latestRemote ? hasExistingRecord(existingRecords, latestRemote.message_id) : null;
  const lagMs =
    latestRemote && latestLocal?.occurred_at_ms
      ? Math.max(0, Number(latestRemote.created_at_ms) - Number(latestLocal.occurred_at_ms))
      : null;

  let status = "healthy";
  if (probeErrors.length > 0) status = "needs_attention";
  else if (missing.length > 0) status = "delayed";
  else if (latestRemoteIsLocal === false) status = "delayed";

  return {
    ok: status === "healthy",
    status,
    checked_at: checkedAt.toISOString(),
    window: {
      start: localIsoFromMs(opts.startMs),
      end: localIsoFromMs(opts.endMs),
    },
    probe: {
      hot_chats_requested: opts.hotChats,
      hot_chats_found: chats.length,
      messages_per_chat: opts.messagesPerChat,
      remote_messages_checked: sortedRemote.length,
      unsupported_chats: unsupportedChats.length,
      probe_errors: probeErrors.length,
    },
    latest_remote: latestRemote
      ? {
          message_id: latestRemote.message_id,
          created_at: new Date(latestRemote.created_at_ms).toISOString(),
          chat_name: latestRemote.chat_name,
          sender_name: latestRemote.sender_name,
          body: compact(latestRemote.body),
          exists_locally: hasExistingRecord(existingRecords, latestRemote.message_id),
        }
      : null,
    latest_local: latestLocal
      ? {
          message_id: latestLocal.external_id,
          created_at: latestLocal.occurred_at,
          chat_name: latestLocal.chat_name,
          direction: latestLocal.direction,
        }
      : null,
    lag_ms: lagMs,
    missing_count: missing.length,
    missing: missing.slice(0, 10).map((message) => ({
      message_id: message.message_id,
      created_at: new Date(message.created_at_ms).toISOString(),
      chat_name: message.chat_name,
      sender_name: message.sender_name,
      body: compact(message.body),
    })),
    unsupported_chats: unsupportedChats.slice(0, 10),
    probe_errors: probeErrors.slice(0, 10),
  };
}

/** @param {{ok?: boolean}} report */
function exitCodeForReport(report) {
  return report.ok ? 0 : 2;
}

export {
  buildLagReport,
  exitCodeForReport,
  normalizeRemoteMessage,
};
