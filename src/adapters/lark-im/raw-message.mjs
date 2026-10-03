// @ts-check

import { renderSystemContent } from "./system-content.mjs";

const SOURCE_API = "im.v1.messages";
const RENDER_VERSION = 1;

/** @typedef {Record<string, any>} JsonObject */
/** @typedef {{mergeItems?: JsonObject[]}} NormalizeOptions */
/** @typedef {{text: string, status: "rendered" | "partial" | "structured_fallback", reason: string | null, version: number}} RenderResult */

/** @param {unknown} value @returns {value is JsonObject} */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @template T @param {T} value @returns {T} */
function copyJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** @param {string} text @param {RenderResult["status"]} [status] @param {string | null} [reason] @returns {RenderResult} */
function result(text, status = "rendered", reason = null) {
  return { text, status, reason, version: RENDER_VERSION };
}

/** @param {JsonObject} item */
function sourceContent(item) {
  return isObject(item.body) ? item.body.content : undefined;
}

/** @param {unknown} value */
function parseContent(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

/** @param {JsonObject} item @param {string} reason @param {string} label */
function fallback(item, reason, label) {
  const content = sourceContent(item);
  // Keep the original JSON string, including fields we do not understand.
  // Missing body content falls back to the full native message, never an empty
  // successful-looking body. The complete native item is also kept in raw_api.
  const original = typeof content === "string" ? content
    : JSON.stringify(content === undefined ? item : content);
  return result(`[${label}]\n${original}`, "structured_fallback", reason);
}

/** @param {JsonObject} item */
function mentionNames(item) {
  const names = new Map();
  for (const mention of Array.isArray(item.mentions) ? item.mentions : []) {
    if (!isObject(mention) || typeof mention.name !== "string" || !mention.name.trim()) continue;
    for (const key of [mention.key, typeof mention.id === "string" ? mention.id : mention.id?.open_id]) {
      if (typeof key === "string" && key) names.set(key, mention.name);
    }
  }
  return names;
}

/** @param {string} text @param {JsonObject} item */
function resolveTextMentions(text, item) {
  const names = mentionNames(item);
  // Replace only complete API mention keys. In particular @_user_1 must not
  // replace the prefix of an unresolved @_user_10.
  return text.replace(/@_user_\d+\b/g, (key) => names.has(key) ? `@${names.get(key)}` : key);
}

/** @param {JsonObject} payload @returns {JsonObject | null} */
function postBody(payload) {
  if (["title", "content", "content_v2"].some((key) => Object.hasOwn(payload, key))) return payload;
  const locales = [...new Set(["zh_cn", "en_us", "ja_jp", ...Object.keys(payload).sort()])];
  for (const locale of locales) {
    const body = payload[locale];
    if (isObject(body) && ["title", "content", "content_v2"].some((key) => Object.hasOwn(body, key))) return body;
  }
  return null;
}

/** @param {unknown} value @param {Map<string, string>} names @returns {string | null} */
function postElement(value, names) {
  if (!isObject(value)) return null;
  const text = typeof value.text === "string" ? value.text : null;
  switch (value.tag) {
    case "text":
    case "md": return text;
    case "a": {
      const href = typeof value.href === "string" ? value.href : "";
      return text && href ? `${text} (${href})` : text ?? (href || null);
    }
    case "at": {
      const id = typeof value.user_id === "string" ? value.user_id : "";
      if (id === "all" || id === "@_all") return "@所有人";
      const name = typeof value.user_name === "string" && value.user_name.trim()
        ? value.user_name : names.get(id);
      return name ? `@${name}` : id ? (id.startsWith("@") ? id : `@${id}`) : null;
    }
    case "emotion": return typeof value.emoji_type === "string" ? `:${value.emoji_type}:` : null;
    case "hr": return "\n---\n";
    case "code_block": return text === null ? null : `\n${text}\n`;
    // Media and unknown elements remain in the complete structural fallback;
    // a resource key is not a downloaded image or a rendered video.
    default: return null;
  }
}

/** @param {JsonObject} item @param {JsonObject} payload */
function renderPost(item, payload) {
  const body = postBody(payload);
  if (!body) return fallback(item, "unsupported_post_structure", "富文本未完整渲染，以下为原始内容");
  const blocks = Array.isArray(body.content_v2) && body.content_v2.length > 0 ? body.content_v2 : body.content;
  if ((body.title !== undefined && typeof body.title !== "string") || !Array.isArray(blocks)) {
    return fallback(item, "unsupported_post_structure", "富文本未完整渲染，以下为原始内容");
  }
  const lines = typeof body.title === "string" && body.title ? [body.title] : [];
  const names = mentionNames(item);
  let incomplete = false;
  for (const block of blocks) {
    if (!Array.isArray(block)) { incomplete = true; continue; }
    const parts = block.map((element) => postElement(element, names));
    if (parts.some((part) => part === null)) incomplete = true;
    lines.push(parts.filter((part) => part !== null).join(""));
  }
  const text = resolveTextMentions(lines.join("\n"), item);
  if (incomplete) {
    const preserved = fallback(item, "unsupported_post_element", "富文本未完整渲染，以下为完整原始内容");
    return result(text ? `${text}\n${preserved.text}` : preserved.text, "partial", preserved.reason);
  }
  return result(text);
}

/** @param {JsonObject} item @param {JsonObject[]} mergeItems */
function renderMerge(item, mergeItems) {
  const seen = new Set();
  const children = [];
  for (const child of mergeItems) {
    if (!isObject(child) || typeof child.message_id !== "string" || !child.message_id.trim()
        || seen.has(child.message_id)) throw new Error("invalid or duplicate merge-forward detail item");
    seen.add(child.message_id);
    if (child.message_id === item.message_id) {
      if (child.update_time !== item.update_time || JSON.stringify(child.body) !== JSON.stringify(item.body)) {
        throw new Error("merge-forward source changed during detail retrieval");
      }
      continue;
    }
    children.push(child);
  }
  if (children.length === 0) {
    return fallback(item, "merge_forward_not_expanded", "未展开转发合并内容，以下为原始内容");
  }
  // The API list can include upper_message_id trees. Present every child once
  // in API order, without following parent links or recursively fetching more.
  // Cyclic/dangling parent links cannot drop items or cause infinite traversal.
  let incomplete = false;
  const texts = children.map((child, index) => {
    const rendered = renderApiMessageContent(child);
    if (rendered.status !== "rendered") incomplete = true;
    const sender = isObject(child.sender) ? child.sender : {};
    const label = typeof sender.name === "string" && sender.name ? sender.name
      : typeof sender.id === "string" && sender.id ? sender.id : "未知发送者";
    return `[转发消息 ${index + 1} · ${label}]\n${rendered.text}`;
  });
  return result(`[转发合并内容，按 API 顺序列出 ${children.length} 条]\n${texts.join("\n\n")}`,
    incomplete ? "partial" : "rendered", "merge_forward_flat_projection");
}

/**
 * A deterministic plain-text projection, not a complete client UI renderer.
 * It performs no I/O, contact lookup, pagination or recursive API expansion.
 * @param {JsonObject} item
 * @param {NormalizeOptions} [options]
 * @returns {RenderResult}
 */
function renderApiMessageContent(item, options = {}) {
  if (!isObject(item)) throw new Error("native API message must be an object");
  const type = item.msg_type || item.message_type;
  if (type === "merge_forward") {
    if (options.mergeItems !== undefined) {
      if (!Array.isArray(options.mergeItems)) throw new Error("merge-forward details must be an array");
      return renderMerge(item, options.mergeItems);
    }
    return fallback(item, "merge_forward_not_expanded", "未展开转发合并内容，以下为原始内容");
  }
  const content = sourceContent(item);
  const payload = parseContent(content);
  if (type === "text" && isObject(payload) && typeof payload.text === "string") {
    return result(resolveTextMentions(payload.text, item));
  }
  if (type === "post" && isObject(payload)) return renderPost(item, payload);
  if (type === "system" && isObject(payload) && typeof payload.template === "string") {
    const text = renderSystemContent(payload);
    if (text !== null) {
      const unresolved = text === "未知操作者置顶了一个话题" || text.includes("[未知参数：");
      return result(text, unresolved ? "partial" : "rendered", unresolved ? "system_parameters_missing" : null);
    }
  }
  return fallback(item, "unsupported_message_content", "消息未完整渲染，以下为原始内容");
}

/**
 * Adapt a native message for the existing record pipeline without overwriting
 * its source evidence. content is a derived compatibility field; raw_api is the
 * complete original native item. API envelope pagination remains adapter-owned.
 * @param {JsonObject} item
 * @param {NormalizeOptions} [options]
 * @returns {JsonObject}
 */
function normalizeApiMessage(item, options = {}) {
  if (!isObject(item) || typeof item.message_id !== "string" || !item.message_id.trim()) {
    throw new Error("native API message is missing a valid message_id");
  }
  const raw = copyJson(item);
  const rendered = renderApiMessageContent(raw, options);
  const { text, ...rendering } = rendered;
  const type = raw.msg_type || raw.message_type;
  const systemPayload = parseContent(sourceContent(raw));
  /** @type {JsonObject} */
  const normalized = {
    ...copyJson(raw),
    // System templates must be rendered once by bodyFromMessage/displayBody;
    // re-rendering an already substituted name could alter literal {braces}.
    content: type === "system" && isObject(systemPayload) && typeof systemPayload.template === "string"
      ? sourceContent(raw) : text,
    source_api: SOURCE_API,
    raw_api: raw,
    content_rendering: rendering,
  };
  if (type === "merge_forward" && options.mergeItems !== undefined) {
    normalized.raw_api_expansions = {
      merge_forward: { source_api: "im.v1.messages.get", items: copyJson(options.mergeItems) },
    };
  }
  return normalized;
}

export { normalizeApiMessage, renderApiMessageContent };
