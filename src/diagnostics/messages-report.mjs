// @ts-check

import { readOnlySqliteJson } from "../storage/sqlite/readonly-query.mjs";
import { renderSystemProjection } from "../adapters/lark-im/system-content.mjs";
import { renderCardContent } from "../adapters/lark-im/card-content.mjs";
import { personName, senderIdentity, senderNameFromSource } from "../adapters/lark-im/sender-identity.mjs";

/**
 * @typedef {"all" | "sent" | "received"} MessageDirection
 *
 * @typedef {object} MessageOptions
 * @property {string} db
 * @property {MessageDirection} direction
 * @property {number} limit
 * @property {string} search
 *
 * @typedef {Record<string, any>} Row
 *
 * @typedef {Row & {
 *   canonical: Row,
 *   raw: Row,
 *   scope_config: Row,
 *   display: {
 *     external_id: string,
 *     scene: string,
 *     sender: string,
 *     sender_type: string,
 *     sender_name_source?: {kind: string, source_kind: string, recorded_at: string, evidence_refs: string[]},
 *     message_type: string,
 *     recipient: string | null,
 *     chat: string | null,
 *     body: unknown,
 *     card?: import("../adapters/lark-im/raw-message.mjs").RenderResult,
 *     system?: NonNullable<ReturnType<typeof renderSystemProjection>>
 *   }
 * }} EnrichedMessage
 *
 * @typedef {object} LoadMessageDeps
 * @property {(dbPath: string, sql: string, label: string) => Row[]=} sqliteJson
 */

/**
 * @param {string} dbPath
 * @param {string} sql
 * @param {string} label
 * @returns {Row[]}
 */
function sqliteJson(dbPath, sql, label) {
  return readOnlySqliteJson(dbPath, sql, label);
}

/** @param {unknown} value */
function quoteSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** @param {MessageOptions} opts */
function buildWhere(opts) {
  const clauses = ["r.source_id = 'lark.im'", "r.record_type = 'lark.im.message'"];
  if (opts.direction !== "all") clauses.push(`direction = ${quoteSql(opts.direction)}`);
  if (opts.search) clauses.push(`body LIKE ${quoteSql(`%${opts.search}%`)}`);
  return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
}

/**
 * @param {string} dbPath
 * @param {MessageOptions} opts
 * @param {LoadMessageDeps} [deps]
 * @returns {EnrichedMessage[]}
 */
function loadMessages(dbPath, opts, deps = {}) {
  const queryJson = deps.sqliteJson || sqliteJson;
  return queryJson(
    dbPath,
    `SELECT
       r.id,
       r.direction,
       r.record_type,
       r.occurred_at,
       r.occurred_at_ms,
       r.actor_id,
       r.container_id,
       r.external_id,
       r.body,
       r.canonical_json,
       r.raw_json,
       s.config_json AS scope_config_json
     FROM records r
     LEFT JOIN sync_scopes s ON s.id = r.first_seen_scope_id
     ${buildWhere(opts)}
     ORDER BY r.occurred_at_ms DESC, r.external_id DESC
     LIMIT ${Number(opts.limit)};`,
    "read messages",
  ).map((row) => enrichRow(row));
}

/** @param {unknown} value */
function parseMaybeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @param {number} [length]
 */
function shortId(value, length = 8) {
  return value ? `${String(value).slice(0, length)}...` : "unknown";
}

/**
 * @param {unknown} name
 * @param {unknown} id
 */
function nameOrId(name, id) {
  if (!name && String(id || "").startsWith("cli_")) return `应用 ${shortId(id, 8)}`;
  return name ? String(name) : shortId(id, 8);
}

/**
 * @param {unknown} name
 * @param {unknown} id
 * @param {unknown} senderType
 */
function senderLabel(name, id, senderType) {
  if (senderType === "system" && !name && !id) return "系统";
  const display = nameOrId(name, id);
  return senderType === "app" ? `应用：${display.replace(/^应用\s+/, "")}` : display;
}

/** @param {unknown} type */
function messageTypeLabel(type) {
  if (!type) return "unknown";
  /** @type {Record<string, string>} */
  const labels = {
    interactive: "卡片",
    post: "富文本",
    text: "文本",
    image: "图片",
    file: "文件",
    audio: "语音",
    video: "视频",
    system: "系统",
  };
  const key = String(type);
  return labels[key] || key;
}

/** @param {unknown} value */
function isInvalidRenderedContent(value) {
  return /^\[Invalid .+ JSON\]$/.test(String(value || "").trim());
}

/**
 * @param {unknown} body
 * @param {Row} canonical
 * @param {Row} raw
 */
function displayBody(body, canonical, raw) {
  if ((canonical.deleted === true || raw.deleted === true) && isInvalidRenderedContent(body)) {
    return "[已撤回/已删除：飞书未返回原始富文本内容]";
  }
  if ((canonical.msg_type || raw.msg_type || raw.message_type) === "system") {
    if (canonical.content_rendering?.status === "structured_fallback" || raw.content_rendering?.status === "structured_fallback") {
      return body;
    }
    return displaySystem(body, canonical, raw)?.text || body;
  }
  return body;
}

/** Normalize group metadata without treating visibility (public/private) as a
 * conversation mode. A contradictory private-chat declaration fails closed.
 * @param {unknown} type @param {unknown} [mode] */
function groupType(type, mode) {
  if (type === "p2p") return null;
  const kind = mode ?? type;
  return kind === "group" || kind === "topic" ? kind : null;
}

/** Bind both contexts to this native message, but keep their time meanings
 * separate. A scope title is the current local value, not an event parameter.
 * Scope update/hot-seen timestamps do not attest when that title was observed.
 * @param {Row} row @param {Row} canonical @param {Row} raw @param {Row} config */
function systemContext(row, canonical, raw, config) {
  const native = raw.raw_api && typeof raw.raw_api === "object" && !Array.isArray(raw.raw_api) ? raw.raw_api : raw;
  if (canonical.source_api !== "im.v1.messages" || native.message_id !== row.external_id
    || typeof native.chat_id !== "string" || !native.chat_id || native.chat_id !== row.container_id
    || canonical.chat_id !== native.chat_id) return undefined;
  const time = native.create_time;
  if (!(typeof time === "string" && /^\d{1,15}$/.test(time) || typeof time === "number" && Number.isSafeInteger(time) && time >= 0)) return undefined;
  const n = BigInt(time), at = n < 10000000000n ? n * 1000n : n;
  if (!Number.isSafeInteger(row.occurred_at_ms) || at !== BigInt(row.occurred_at_ms)) return undefined;
  if (native.chat?.chat_id !== undefined && native.chat.chat_id !== native.chat_id
    || native.chat?.id !== undefined && native.chat.id !== native.chat_id) return undefined;

  /** @type {Row} */
  const context = { chat_id: native.chat_id };
  const currentType = groupType(config.chat_type, config.chat_mode);
  const declaredTypes = [
    [canonical.chat_type, canonical.chat_mode],
    [native.chat_type, native.chat_mode],
    [native.chat?.chat_type, native.chat?.chat_mode],
  ];
  if (config.chat_id === native.chat_id && currentType
    && typeof config.chat_name === "string" && config.chat_name.trim()
    && canonical.chat_name_state !== "cleared"
    && declaredTypes.every(([type, mode]) => type == null && mode == null || groupType(type, mode) === currentType)) {
    context.current_group = { chat_id: native.chat_id, chat_type: currentType,
      name: config.chat_name.trim(), source: "scope_config", time_basis: "current_local", observed_at: null };
  }
  const type = native.chat_type ?? native.chat?.chat_type, name = native.chat_name ?? native.chat?.name;
  if (["group", "topic"].includes(type) && typeof name === "string" && name.trim()
    && (native.chat?.chat_type === undefined || native.chat.chat_type === type)
    && (native.chat?.name === undefined || native.chat.name === name)
    && (canonical.chat_type == null || canonical.chat_type === type)) {
    context.group = { chat_id: native.chat_id, name, chat_type: type,
      source: "message", time_basis: "message_snapshot" };
  }
  return context.current_group || context.group ? context : undefined;
}

/** @param {unknown} body @param {Row} canonical @param {Row} raw @param {unknown} [context] */
function displaySystem(body, canonical, raw, context) {
  if (canonical.content_rendering?.status === "structured_fallback" || raw.content_rendering?.status === "structured_fallback") return null;
  const native = raw.raw_api && typeof raw.raw_api === "object" && !Array.isArray(raw.raw_api) ? raw.raw_api : raw;
  return renderSystemProjection(native.body?.content ?? canonical.content ?? raw.content ?? body, context);
}

/**
 * Rebuild only the display projection. Stored body/raw/canonical and the JSON
 * display.body contract remain unchanged; missing evidence never reinterprets
 * an old human-readable fallback as native card JSON.
 * @param {Row} raw
 * @param {import("../adapters/lark-im/card-content.mjs").CardRenderOptions} [options]
 */
function displayCard(raw, options) {
  const native = raw.raw_api && typeof raw.raw_api === "object" && !Array.isArray(raw.raw_api)
    ? raw.raw_api : raw;
  const content = native.body && typeof native.body === "object" && !Array.isArray(native.body)
    ? native.body.content : native.content;
  return renderCardContent(content, native.mentions, options);
}

/** Read-only sender projection. Raw evidence may fill an old missing name only
 * for the same stored actor and namespace; it cannot undo rejection or clear.
 * @param {Row} row
 * @param {Row} canonical
 * @param {Row} raw
 */
function displaySender(row, canonical, raw) {
  const identity = senderIdentity(raw);
  const id = canonical.sender_id || row.actor_id || identity.id || null;
  const unnamed = { id, name: "" };
  if (canonical.sender_name_state === "cleared" || canonical.sender_id_type === "conflicting") return unnamed;
  const known = personName(canonical.sender_name, [id, row.actor_id, ...identity.identifiers]);
  if (known) return { id, name: known };
  if (identity.conflict
    || [canonical.sender_id, row.actor_id].some((stored) => stored != null && stored !== "" && stored !== identity.id)
    || canonical.sender_id_type != null && typeof canonical.sender_id_type !== "string"
    || canonical.sender_id_type && identity.type && canonical.sender_id_type !== identity.type) return unnamed;
  return { id, name: senderNameFromSource(raw) };
}

/**
 * @param {Row} row
 * @returns {EnrichedMessage}
 */
function enrichRow(row) {
  const canonical = parseMaybeJson(row.canonical_json) || {};
  const raw = parseMaybeJson(row.raw_json) || {};
  const config = parseMaybeJson(row.scope_config_json) || {};
  const chatPartner =
    canonical.chat_partner || (raw.chat_partner && typeof raw.chat_partner === "object" ? raw.chat_partner : null);
  const chatType =
    canonical.chat_type ||
    raw.chat_type ||
    raw.chat?.chat_type ||
    config.chat_type ||
    (config.chat_id ? "group" : "unknown");
  const chatName = canonical.chat_name || raw.chat_name || raw.chat?.name || config.chat_name || null;
  const chatId = canonical.chat_id || row.container_id || config.chat_id || raw.chat_id || null;
  const { id: senderId, name: senderName } = displaySender(row, canonical, raw);
  const messageType = canonical.msg_type || raw.msg_type || raw.message_type || null;
  const senderType =
    canonical.sender_type ||
    (String(senderId || "").startsWith("cli_") ? "app" : null) ||
    (messageType === "system" ? "system" : null);
  const partnerId = chatPartner?.open_id || chatPartner?.id || chatPartner?.user_id || null;
  const partnerName = chatPartner?.name || chatPartner?.display_name || null;
  const p2pPartnerName = partnerName || chatName;
  const p2pPartnerId = partnerId || chatId;
  const isP2p = chatType === "p2p";
  const isGroupLike = !isP2p;
  const system = messageType === "system" ? displaySystem(row.body, canonical, raw, systemContext(row, canonical, raw, config)) : null;
  return {
    ...row,
    canonical,
    raw,
    scope_config: config,
    display: {
      external_id: shortId(row.external_id, 8),
      scene: isP2p ? "私聊" : chatType === "topic" ? "话题群" : "群聊",
      sender: senderLabel(senderName, senderId, senderType),
      sender_type: senderType || "unknown",
      message_type: messageTypeLabel(messageType),
      recipient:
        isP2p
          ? row.direction === "sent"
            ? nameOrId(p2pPartnerName, p2pPartnerId)
            : "我"
          : null,
      chat: isGroupLike ? nameOrId(chatName, chatId) : null,
      body: system?.text || displayBody(row.body, canonical, raw),
      ...(system ? { system } : {}),
      ...(messageType === "interactive" ? { card: displayCard(raw) } : {}),
    },
  };
}

export {
  buildWhere,
  displayBody,
  displayCard,
  enrichRow,
  isInvalidRenderedContent,
  loadMessages,
  messageTypeLabel,
  nameOrId,
  parseMaybeJson,
  quoteSql,
  senderLabel,
  shortId,
  sqliteJson,
};
