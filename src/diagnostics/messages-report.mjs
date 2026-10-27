// @ts-check

import { readOnlySqliteJson } from "../storage/sqlite/readonly-query.mjs";
import { renderSystemProjection } from "../adapters/lark-im/system-content.mjs";
import { renderCardContent } from "../adapters/lark-im/card-content.mjs";
import { personName, senderIdentity, senderNameFromSource } from "../adapters/lark-im/sender-identity.mjs";
import { chatScopeId } from "../adapters/lark-im/core.mjs";
import { displayChatTitle } from "../adapters/lark-im/chat-title.mjs";
import { readChatNameEvidence } from "../adapters/lark-im/name-evidence.mjs";
import { displayP2pRecipient, readRecipientEvidence, recipientAccountKey, sentRecipientAccount } from "../adapters/lark-im/p2p-recipient.mjs";
import { patchTopLevelJsonMemberText, validateJsonObjectText } from "../../dist/core/json-text-patch.js";
import { projectionAccount, readSenderProjectionEvidence, senderProjection, messageProjectionEvidence } from "../adapters/lark-im/message-projection-evidence.mjs";
import { readMessageSnapshot } from "./message-read-snapshot.mjs";
import { readSavedSenderRouteEvidence } from "../adapters/lark-im/saved-sender-route-failures.mjs";
import { evaluateMessageCompleteness } from "../adapters/lark-im/message-completeness.mjs";
import { readLocalSenderProjectionEvidence } from "../adapters/lark-im/name-history.mjs";

// Ephemeral proof used only during this read. Never serialize it as canonical
// authority or accept a caller-supplied source label in its place.
const projectionEvidence = new WeakMap();

/**
 * @typedef {"all" | "sent" | "received"} MessageDirection
 *
 * @typedef {object} MessageOptions
 * @property {string} db
 * @property {MessageDirection} direction
 * @property {number} limit
 * @property {string} search
 * @property {number[]=} recordIds Internal bounded observer selection; never a public CLI flag.
 *
 * @typedef {Record<string, any>} Row
 *
 * @typedef {Row & {
 *   canonical: Row,
 *   raw: Row,
 *   scope_config: Row,
 *   readiness?: Row,
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
  const snapshot=readMessageSnapshot(dbPath,opts,deps), {rows}=snapshot;
  const scopeIds=new Map(rows.filter(row=>typeof row.container_id==='string' && row.container_id)
    .map(row=>[chatScopeId(row.container_id),row.container_id]));
  /** @type {Map<string, Row | null>} */
  const chats=new Map();
  for (const scope of snapshot.scopes) {
    const chatId=scopeIds.get(scope.id), config=parseMaybeJson(scope.config_json);
    if (!chatId || scope.source_id!=='lark.im' || config?.chat_id!==chatId) continue;
    try { validateJsonObjectText(scope.config_json); }
    catch { delete config.p2p_recipient; delete config.chat_name; }
    chats.set(chatId,chats.has(chatId)?null:config);
  }
  const rowAccounts=new Map(rows.map(row=>[row,sentRecipientAccount(row,
    parseMaybeJson(row.canonical_json)||{},parseMaybeJson(row.raw_json)||{})]));
  const pairs=new Map(rows.filter(row=>rowAccounts.get(row)).map(row=>{
    const account=rowAccounts.get(row),accountKey=recipientAccountKey(account);
    return [`${accountKey}:${row.container_id}`,{account,accountKey,chatId:row.container_id}];
  }));
  const recipients=new Map();
  for (const savedRow of snapshot.recipients) {
    const key=`${savedRow.account_key}:${savedRow.chat_id}`,pair=pairs.get(key);
    if (!pair || savedRow.source_id!=='lark.im' || savedRow.evidence_json==null) continue;
    let evidence=null;
    try {validateJsonObjectText(savedRow.evidence_json);evidence=JSON.parse(savedRow.evidence_json);} catch {}
    const config={chat_id:pair.chatId,p2p_recipient:evidence};
    const trusted=readRecipientEvidence(config,pair.account,{includeConflicted:true});
    recipients.set(key,recipients.has(key)?{chat_id:pair.chatId,p2p_recipient:null}
      :{...config,...(trusted?{chat_type:'p2p'}:{})});
  }
  const titlePairs=new Set(rows.flatMap(row=>{
    const owner=projectionAccount(row,parseMaybeJson(row.canonical_json)||{},parseMaybeJson(row.raw_json)||{});
    const key=owner.state==='verified'?owner.account_key:null;
    return key?[`${key}:${row.container_id}`]:[];
  }));
  const titles=new Map(),senderTasks=new Map();
  for (const value of snapshot.nameTasks) {
    if (value.source_id!=='lark.im') continue;
    if (value.kind==='chat') {
      const key=`${value.account_key}:${value.chat_id}`;
      if (!titlePairs.has(key)) continue;
      titles.set(key,titles.has(key)?null:readChatNameEvidence(value.evidence_json,value.chat_id,value.account_key));
    } else if (value.kind==='sender') {
      const key=JSON.stringify([value.account_key,value.chat_id,value.actor_id,value.namespace]);
      senderTasks.set(key,senderTasks.has(key)?null:value);
    }
  }
  const messages=rows.map(({type_scope_id,type_scope_source_id,external_version,content_hash,...row})=>{
    // Source-version proof inputs stay internal; the established public fields
    // do not acquire a second serialized source payload or hashing contract.
    Object.defineProperties(row,{external_version:{value:external_version},content_hash:{value:content_hash}});
    if (Object.hasOwn(parseMaybeJson(row.scope_config_json)||{},'p2p_recipient')) {
      try {row.scope_config_json=patchTopLevelJsonMemberText(row.scope_config_json,'p2p_recipient');} catch {}
    }
    const canonical=parseMaybeJson(row.canonical_json)||{},raw=parseMaybeJson(row.raw_json)||{};
    const account=sentRecipientAccount(row,canonical,raw);
    const owner=projectionAccount(row,canonical,raw),identity=senderIdentity(raw);
    const nameAccount=owner.state==='verified'?owner.account_key:null;
    const task=senderTasks.get(JSON.stringify([owner.account_key,row.container_id,row.actor_id,identity.type]));
    const saved=owner.state==='verified' ? (task && readSenderProjectionEvidence(task,row,owner.account_key||'')
      || readLocalSenderProjectionEvidence(row,canonical,raw,owner.account_key||'',snapshot.senderDonors)) : null;
    return enrichRow(row,chats.get(row.container_id),type_scope_source_id==='lark.im'
      && typeof row.container_id==='string' && type_scope_id===chatScopeId(row.container_id),
      account?recipients.get(`${recipientAccountKey(account)}:${row.container_id}`):undefined,
      nameAccount?titles.get(`${nameAccount}:${row.container_id}`):undefined,saved,true,
      readSavedSenderRouteEvidence(row,canonical,raw,owner,snapshot.nameRoutes));
  });
  messageReadMetadata.set(messages,{population:snapshot.population,as_of:snapshot.as_of,
    observations:snapshot.observations,
    available:snapshot.available,filter:{direction:opts.direction,has_search:Boolean(opts.search)},limit:opts.limit,
    source_records:snapshot.rows.map(row=>Object.fromEntries(['id','source_id','record_type','external_id',
      'external_version','content_hash','actor_id','container_id','direction','occurred_at','occurred_at_ms','raw_json']
      .map(key=>[key,row[key]])))});
  return messages;
}

const messageReadMetadata=new WeakMap();
/** @param {EnrichedMessage[]} messages */
function readMessagesMetadata(messages) { return messageReadMetadata.get(messages) || null; }
/** @param {EnrichedMessage[]} from @param {EnrichedMessage[]} to */
function retainMessagesMetadata(from,to) {
  const value=messageReadMetadata.get(from);
  if (value) messageReadMetadata.set(to,value);
  return to;
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
  return senderType === "app" ? `应用：${display}` : display;
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

/** Resolve only explicit, identity-bound conversation modes. Visibility is
 * not a mode, and a private/group contradiction is not resolved by priority.
 * Preserve the old group/topic preference; this is not a topic reclassification.
 * @param {Row} row @param {Row} canonical @param {Row} raw @param {Row} config
 * @param {Row | null | undefined} currentChat
 * @param {Row | undefined} recipientConfig
 */
function conversationType(row, canonical, raw, config, currentChat, recipientConfig, currentName) {
  if (currentChat === null) return "unknown";
  const native = raw.raw_api && typeof raw.raw_api === "object" && !Array.isArray(raw.raw_api) ? raw.raw_api : {};
  const messages = [canonical, raw, native];
  for (const message of messages) {
    if (message.message_id != null && message.message_id !== row.external_id) return "unknown";
    for (const id of [message.chat_id, message.chat?.chat_id, message.chat?.id]) {
      if (id != null && (typeof id !== "string" || !id || id !== row.container_id)) return "unknown";
    }
  }
  if ([raw, native].some((message) => message.id != null && message.id !== row.external_id)) return "unknown";
  const existing = [canonical, raw, raw.chat, config.chat_id === row.container_id ? config : null];
  const declaredCurrentName=currentName?.chat_id===row.container_id
    && ['group','topic'].includes(currentName.chat_type) ? currentName : null;
  const declarations = [...existing, native, native.chat, currentChat, recipientConfig, declaredCurrentName];
  const modes = [...existing.map((entry) => entry?.chat_type),
    ...declarations.flatMap((entry) => [entry?.chat_type, entry?.chat_mode])]
    .filter((mode) => mode === "p2p" || mode === "group" || mode === "topic");
  if (modes.includes("p2p") && modes.some((mode) => mode !== "p2p")) return "unknown";
  return modes[0] || "unknown";
}

/**
 * @param {Row} row
 * @param {Row | null} [currentChat]
 * @param {boolean} [scopeSourceMatches]
 * @param {Row} [recipientConfig]
 * @param {Row | null} [currentName]
 * @param {Row | null} [savedSender]
 * @param {boolean} [includeReadiness]
 * @param {{blockers:Row[],supersedes_inline:boolean}} [routeEvidence]
 * @returns {EnrichedMessage}
 */
function enrichRow(row, currentChat, scopeSourceMatches = true, recipientConfig, currentName, savedSender = null, includeReadiness = false, routeEvidence = {blockers:[],supersedes_inline:false}) {
  const canonical = parseMaybeJson(row.canonical_json) || {};
  const raw = parseMaybeJson(row.raw_json) || {};
  const config = parseMaybeJson(row.scope_config_json) || {};
  const chatType = conversationType(row, canonical, raw, scopeSourceMatches ? config : {}, currentChat, recipientConfig, currentName);
  const chatName = displayChatTitle(row, canonical, raw, config, currentChat, scopeSourceMatches, currentName);
  const chatId = canonical.chat_id || row.container_id || config.chat_id || raw.chat_id || null;
  const { id: senderId, name: senderName } = includeReadiness || savedSender
    ? senderProjection(row,canonical,raw,savedSender) : displaySender(row, canonical, raw);
  const messageType = canonical.msg_type || raw.msg_type || raw.message_type || null;
  const identity = senderIdentity(raw);
  const senderType = canonical.sender_type
    || (identity.verified && identity.type === 'app_id' ? 'app'
      : identity.verified && ['open_id','user_id','union_id'].includes(identity.type || '') ? 'user' : null)
    || (messageType === "system" ? "system" : null);
  const isP2p = chatType === "p2p";
  const isGroupLike = !isP2p;
  const system = messageType === "system" ? displaySystem(row.body, canonical, raw, systemContext(row, canonical, raw, config)) : null;
  /** @type {EnrichedMessage} */
  const result = {
    ...row,
    canonical,
    raw,
    scope_config: config,
    display: {
      external_id: shortId(row.external_id, 8),
      scene: isP2p ? "私聊" : chatType === "topic" ? "话题群" : chatType === "group" ? "群聊" : "会话类型未知",
      sender: senderLabel(senderName, senderId, senderType),
      sender_type: senderType || "unknown",
      message_type: messageTypeLabel(messageType),
      recipient:
        isP2p
          ? displayP2pRecipient(row, canonical, raw, recipientConfig ?? currentChat)
          : null,
      chat: isGroupLike ? nameOrId(chatName, chatId) : null,
      body: system?.text || displayBody(row.body, canonical, raw),
      ...(system ? { system } : {}),
      ...(messageType === "interactive" ? { card: displayCard(raw) } : {}),
    },
  };
  if (includeReadiness) {
    const evidence=messageProjectionEvidence(row,canonical,raw,result.display,{
      chatType,chatName,titleSource:currentName?.name===chatName?'im.chats.get'
        :canonical.chat_name===chatName?'canonical':'scope_config',
      recipientConfig:recipientConfig??currentChat,senderEvidence:savedSender,routeEvidence });
    result.readiness=evaluateMessageCompleteness({row,canonical,raw,display:result.display,evidence});
    projectionEvidence.set(result,evidence);
  }
  return result;
}

/** Called only after the local mapping reader has verified its file/database
 * binding and exact tenant/chat/app entry. It cannot promote a canonical label.
 * @param {EnrichedMessage} message @param {Row} sender */
function applyVerifiedSenderMapping(message,sender) {
  const result={...message,display:{...message.display,sender:senderLabel(sender.name,sender.id,'app')}};
  const previous=projectionEvidence.get(message);
  if (previous) {
    const evidence={...previous,sender};
    result.readiness=evaluateMessageCompleteness({row:message,canonical:message.canonical,
      raw:message.raw,display:result.display,evidence});
    projectionEvidence.set(result,evidence);
  }
  return result;
}

export {
  applyVerifiedSenderMapping,
  buildWhere,
  displayBody,
  displayCard,
  enrichRow,
  isInvalidRenderedContent,
  loadMessages,
  readMessagesMetadata,
  retainMessagesMetadata,
  messageTypeLabel,
  nameOrId,
  parseMaybeJson,
  quoteSql,
  senderLabel,
  shortId,
  sqliteJson,
};
