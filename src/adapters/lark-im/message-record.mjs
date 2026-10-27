// @ts-check

import { createHash } from "node:crypto";
import { renderSystemContent } from "./system-content.mjs";
import { personName, senderIdentity, senderLookupNamespace, senderNameFromSource } from "./sender-identity.mjs";
import { sanitizeSenderNameObservation } from './sender-name-observation.mjs';

/**
 * @typedef {"sent" | "received"} MessageDirection
 *
 * @typedef {object} LarkMessage
 * @property {string=} message_id
 * @property {string=} id
 * @property {string | number=} create_time
 * @property {string | number=} created_at
 * @property {string | number=} create_time_ms
 * @property {string | number=} update_time
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
 * @property {string=} source_api
 * @property {Record<string, any>=} raw_api
 * @property {Record<string, any>=} raw_api_expansions
 * @property {Record<string, any>=} content_rendering
 * @property {string=} root_id
 * @property {string=} parent_id
 *
 * @typedef {object} NameDetails
 * @property {string | null} name
 * @property {"cleared"=} state
 * @property {string} source
 * @property {string} confidence
 *
 * @typedef {string | NameDetails | Record<string, any>} NameValue
 *
 * @typedef {object} PeopleContext
 * @property {Map<string, Record<string, any>>=} sender_name_observations
 * @property {Map<string, NameValue>=} apps
 * @property {Map<string, NameValue>=} app_fallbacks
 * @property {Map<string, NameValue>=} chat_members
 * @property {Map<string, NameValue>=} contacts
 * @property {{open_id?: string, name?: string} | null=} self
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
 */

const SOURCE_ID = "lark.im";

/** @param {LarkMessage | null | undefined} message */
function senderId(message) {
  return senderIdentity(message).id;
}

/** @param {LarkMessage | null | undefined} message */
function senderName(message) {
  return senderNameFromSource(message);
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
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return NaN;
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (/^\d+$/.test(String(value))) {
    const parsed = Number(String(value));
    if (!Number.isSafeInteger(parsed)) return NaN;
    return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
  }
  const text = String(value);
  const simple = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (simple) {
    const [, year, month, day, hour, minute, second = "0"] = simple;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
    if (
      date.getFullYear() !== Number(year) ||
      date.getMonth() !== Number(month) - 1 ||
      date.getDate() !== Number(day) ||
      date.getHours() !== Number(hour) ||
      date.getMinutes() !== Number(minute) ||
      date.getSeconds() !== Number(second)
    ) {
      return NaN;
    }
    return date.getTime();
  }
  return Date.parse(text);
}

/**
 * Treat one malformed item as a malformed page. Silently dropping it would let
 * the caller advance the page/window cursor past a message that was never
 * stored.
 *
 * @param {unknown} value
 * @param {string} [label]
 * @returns {asserts value is LarkMessage}
 */
function assertValidLarkMessage(value, label = "lark message") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const message = /** @type {LarkMessage} */ (value);
  const id = messageId(message);
  if (typeof id !== "string" || !id.trim()) {
    throw new Error(`${label} is missing a valid message_id`);
  }
  const occurredAtMs = parseLarkTimeMs(message.create_time ?? message.created_at ?? message.create_time_ms);
  if (!Number.isFinite(occurredAtMs)) {
    throw new Error(`${label} has an invalid create_time`);
  }
  if (message.update_time !== null && message.update_time !== undefined && message.update_time !== "") {
    if (!Number.isFinite(parseLarkTimeMs(message.update_time))) {
      throw new Error(`${label} has an invalid update_time`);
    }
  }
}

/** @param {LarkMessage} message */
function externalVersion(message) {
  if (message.update_time === null || message.update_time === undefined || message.update_time === "") return null;
  return String(parseLarkTimeMs(message.update_time));
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
  if ((message?.msg_type || message?.message_type) === "system") {
    if (message?.source_api === "im.v1.messages" && message.content_rendering?.status === "structured_fallback") {
      return body;
    }
    return renderSystemContent(message?.content) ?? body;
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
    // Empty API fields and lookup failures are unknown. A caller with an
    // authoritative deletion must opt in explicitly; current remote lookups do
    // not infer deletion from absence or permission errors.
    if (objectValue.state === "cleared") {
      return { name: null, state: "cleared", source: objectValue.source || source,
        confidence: objectValue.confidence || confidence };
    }
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
 * @param {string[]} [identifiers]
 * @returns {NameDetails | null}
 */
function lookupDisplayNameDetails(context, id, chatIdValue, identifiers = id ? [id] : []) {
  if (!id) return null;
  const app = nameCandidate(context.apps?.get(id), "application_api", "high");
  if (app && (app.state === "cleared" || personName(app.name, identifiers))) return app;
  const appFallback = nameCandidate(context.app_fallbacks?.get(`${chatIdValue}:${id}`), "chat_bot_unique", "medium");
  // Reject legacy guessed contexts even when supplied by another caller.
  if (appFallback?.source === "chat_bot_app_id" && appFallback.confidence === "high"
    && (appFallback.state === "cleared" || personName(appFallback.name, identifiers))) return appFallback;
  const chatMember = nameCandidate(context.chat_members?.get(`${chatIdValue}:${id}`), "chat_member", "high");
  if (chatMember && (chatMember.state === "cleared" || personName(chatMember.name, identifiers))) return chatMember;
  const contact = nameCandidate(context.contacts?.get(id), "contact", "high");
  if (contact && (contact.state === "cleared" || personName(contact.name, identifiers))) return contact;
  if (context.self?.open_id === id) {
    const name = personName(context.self.name, identifiers);
    if (name) return { name, source: "self", confidence: "high" };
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

/** Preserve the source's identity declarations, including invalid/conflicting
 * ones: selecting one ID must not turn an ambiguous partner into a valid person.
 * Contact/member maps contain open IDs only; a source user/union ID or an untyped
 * ID with the same spelling cannot consume them.
 * @param {Record<string, any> | null} partner
 * @param {PeopleContext} context
 * @param {string} chatIdValue
 */
function projectChatPartner(partner, context, chatIdValue) {
  if (!partner) return null;
  const identity = senderIdentity({ sender: partner });
  const fields = Object.fromEntries(["id", "id_type", "open_id", "user_id", "union_id", "app_id", "sender_id"]
    .filter((field) => Object.hasOwn(partner, field)).map((field) => [field, partner[field]]));
  const directName = identity.conflict ? ""
    : personName(partner.name, identity.identifiers) || personName(partner.display_name, identity.identifiers);
  /** @type {NameDetails | null} */
  const details = partner.name_state === "cleared"
    ? { name: null, state: "cleared", source: "message_partner", confidence: "high" }
    : directName ? { name: directName, source: "message_partner", confidence: "high" }
      : identity.verified && identity.type === "open_id" && /^ou_[A-Za-z0-9_-]+$/.test(identity.id) && identity.id.length <= 512
        ? lookupDisplayNameDetails({ contacts: context.contacts, chat_members: context.chat_members, self: context.self },
          identity.id, chatIdValue, identity.identifiers)
        : null;
  return { ...fields, name: details?.state === "cleared" ? null : details?.name || null,
    ...(details?.state === "cleared" ? { name_state: "cleared" } : {}) };
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
  assertValidLarkMessage(message);
  const externalId = messageId(message);
  const occurredAtMs = parseLarkTimeMs(message?.create_time ?? message?.created_at ?? message?.create_time_ms);
  const version = externalVersion(message);
  const updatedAtMs = version === null ? null : Number(version);
  const identity = senderIdentity(message);
  const actorId = identity.id;
  const senderIdentityConflict = identity.conflict;
  const containerId = chatId(message) || scopeConfig.chat_id || "";
  const sender = message?.sender && typeof message.sender === "object" ? message.sender : {};
  const chatPartner =
    message?.chat_partner && typeof message.chat_partner === "object" && !Array.isArray(message.chat_partner) ? message.chat_partner : null;
  const chatType = message?.chat_type || message?.chat?.chat_type || scopeConfig.chat_type || null;
  const directChatName = message?.chat_name || message?.chat?.name || "";
  const chatName = directChatName || scopeConfig.chat_name || null;
  const senderDirectName = senderIdentityConflict ? "" : senderName(message);
  // Person lookup maps contain open IDs only. A user_id with the same spelling
  // cannot consume those names, even when it starts with a familiar prefix.
  const lookupNamespace = senderLookupNamespace(message);
  const senderContext = lookupNamespace === "open_id"
    ? { contacts: context.contacts, chat_members: context.chat_members, self: context.self }
    : lookupNamespace === "app_id"
      ? { apps: context.apps, app_fallbacks: context.app_fallbacks } : {};
  /** @type {NameDetails | null} */
  const senderNameDetails = senderDirectName
    ? { name: senderDirectName, source: "message_sender", confidence: "high" }
    : lookupDisplayNameDetails(senderContext, actorId, containerId, identity.identifiers);
  const senderDisplayName = senderNameDetails?.name || "";
  // Source names and supplied self profiles have no independent lookup time.
  // Do not invent one from normalization time or the message timestamp.
  const nameObservation = !senderDirectName && Boolean(lookupNamespace)
    ? sanitizeSenderNameObservation(context.sender_name_observations?.get(JSON.stringify([containerId, actorId, identity.type]))) : null;
  const canonical = {
    message_id: externalId,
    msg_type: message?.msg_type || message?.message_type || null,
    create_time: message?.create_time ?? null,
    create_time_ms: occurredAtMs,
    update_time: message?.update_time ?? null,
    update_time_ms: updatedAtMs,
    sender_id: actorId,
    sender_id_type: senderIdentityConflict ? "conflicting" : identity.type,
    sender_name: senderDisplayName || null,
    ...(senderNameDetails?.state === "cleared" ? { sender_name_state: "cleared" } : {}),
    sender_name_source: senderDisplayName || senderNameDetails?.state === "cleared" ? senderNameDetails?.source || null : null,
    sender_name_confidence: senderDisplayName || senderNameDetails?.state === "cleared" ? senderNameDetails?.confidence || null : null,
    ...(nameObservation ? { sender_name_verification: nameObservation } : {}),
    ...(nameObservation?.status === 'resolved' && nameObservation.name === senderDisplayName
      && nameObservation.source === senderNameDetails?.source
      ? { sender_name_observed_at: nameObservation.observed_at } : {}),
    sender_type: senderType(message),
    chat_id: containerId,
    chat_type: chatType,
    chat_name: chatName,
    // Scope configuration is cached discovery metadata, not a new naming event.
    ...(chatName ? { chat_name_source: directChatName ? "message" : "scope_config" } : {}),
    chat_partner: projectChatPartner(chatPartner, context, containerId),
    thread_id: message?.thread_id || null,
    deleted: typeof message?.deleted === "boolean" ? message.deleted : null,
    updated: typeof message?.updated === "boolean" ? message.updated : null,
    mentions: Array.isArray(message?.mentions) ? message.mentions : [],
    content: message?.content ?? null,
  };
  // Native API adapters retain their original message separately from derived
  // text. Keep hash(raw_json) as the source-content hash, independent of the
  // renderer version. Legacy CLI messages retain their existing serialization.
  const native = message.source_api === "im.v1.messages"
    && message.raw_api && typeof message.raw_api === "object" && !Array.isArray(message.raw_api);
  let sourceMessage = native ? message.raw_api : message;
  if (native) {
    Object.assign(canonical, {
      source_api: message.source_api,
      content_rendering: message.content_rendering || null,
      root_id: message.root_id || null,
      parent_id: message.parent_id || null,
    });
    if (message.raw_api_expansions) {
      sourceMessage = { ...message.raw_api, raw_api_expansions: message.raw_api_expansions };
    }
  }
  const rawJson = JSON.stringify(sourceMessage);
  const body = bodyFromMessage(message);
  return {
    source_id: SOURCE_ID,
    first_seen_scope_id: scopeId,
    external_id: externalId,
    external_version: version,
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

export {
  SOURCE_ID,
  assertValidLarkMessage,
  bodyFromContent,
  bodyFromMessage,
  chatId,
  hash,
  isInvalidRenderedContent,
  lookupDisplayName,
  messageId,
  occurredAtIso,
  externalVersion,
  parseLarkTimeMs,
  recordFromMessage,
  senderId,
  senderName,
  senderType,
  shortHash,
};
