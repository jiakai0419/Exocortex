// @ts-check

import { renderSystemContent } from "./system-content.mjs";
import { renderCardContent } from "./card-content.mjs";
import { personName } from "./sender-identity.mjs";

const SOURCE_API = "im.v1.messages";
const RENDER_VERSION = 1;
const MENTION_ID_TYPES = ["open_id", "user_id", "union_id", "app_id"];

/** @typedef {Record<string, any>} JsonObject */
/** @typedef {{mergeItems?: JsonObject[]}} NormalizeOptions */
/** @typedef {{text: string, status: "rendered" | "partial" | "structured_fallback", reason: string | null, version: number}} RenderResult */
/** @typedef {{parent: MentionIdentity | null, ids: Map<string, string>, name: string | null, conflict: boolean}} MentionIdentity */
/** @typedef {{name: string | null, conflict: boolean, identifiers: string[]}} MentionBinding */
/** @typedef {{unresolved: boolean}} MentionState */

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

/** Message-local evidence only. Typed IDs may join when explicitly co-present;
 * equal keys or equal names cannot join otherwise disjoint identities.
 * @param {JsonObject} item */
function mentionBindings(item) {
  /** @type {Map<string, Map<string, MentionIdentity>>} */
  const identities = new Map([...MENTION_ID_TYPES, "literal", "mention_key"].map((kind) => [kind, new Map()]));
  /** @type {Map<string, {rows: MentionIdentity[], missing: boolean}>} */
  const keys = new Map();
  /** @param {MentionIdentity} identity @returns {MentionIdentity} */
  function root(identity) {
    let current = identity;
    while (current.parent) current = current.parent;
    while (identity.parent && identity.parent !== current) {
      const next = identity.parent;
      identity.parent = current;
      identity = next;
    }
    return current;
  }
  /** @param {MentionIdentity} left @param {MentionIdentity} right */
  function join(left, right) {
    left = root(left); right = root(right);
    if (left === right) return left;
    right.parent = left;
    left.conflict ||= right.conflict || Boolean(left.name && right.name && left.name !== right.name);
    left.name ||= right.name;
    for (const [kind, id] of right.ids) {
      if (left.ids.has(kind) && left.ids.get(kind) !== id) left.conflict = true;
      else left.ids.set(kind, id);
    }
    return left;
  }
  for (const mention of Array.isArray(item.mentions) ? item.mentions : []) {
    if (!isObject(mention)) continue;
    const key = typeof mention.key === "string" && mention.key ? mention.key : null;
    const name = typeof mention.name === "string" && mention.name.trim() ? mention.name : null;
    /** @type {MentionIdentity | null} */
    let identity = null;
    let invalid = false;
    /** @param {string} kind @param {unknown} value */
    function add(kind, value) {
      if (value === undefined || value === null || value === "") return;
      if (typeof value !== "string") { invalid = true; return; }
      const table = identities.get(kind);
      if (!table) { invalid = true; return; }
      let next = table.get(value);
      if (!next) {
        next = { parent: null, ids: new Map([[kind, value]]), name: null, conflict: false };
        table.set(value, next);
      }
      identity = identity ? join(identity, next) : root(next);
    }
    for (const kind of MENTION_ID_TYPES) {
      add(kind, mention[kind]);
      if (isObject(mention.id)) add(kind, mention.id[kind]);
    }
    if (typeof mention.id === "string") {
      if (mention.id_type === undefined) add("literal", mention.id);
      else if (MENTION_ID_TYPES.includes(mention.id_type)) add(mention.id_type, mention.id);
      else invalid = true;
    } else if (mention.id_type !== undefined || mention.id != null && !isObject(mention.id)) invalid = true;
    if (!identity && key && !invalid) add("mention_key", key);
    if (identity) {
      const current = root(identity);
      current.conflict ||= invalid || Boolean(current.name && name && current.name !== name);
      current.name ||= name;
    }
    if (key) {
      const binding = keys.get(key) || { rows: [], missing: false };
      if (identity) binding.rows.push(identity);
      binding.missing ||= !identity || !name || invalid;
      keys.set(key, binding);
    }
  }
  /** @param {MentionIdentity | undefined} identity @returns {MentionBinding} */
  function binding(identity) {
    const current = identity ? root(identity) : null;
    const identifiers = current ? [...current.ids.values()] : [];
    return { name: current && !current.conflict && personName(current.name, identifiers) ? current.name : null,
      conflict: current?.conflict || false, identifiers };
  }
  /** @type {Map<string, MentionBinding>} */
  const keyCache = new Map();
  /** Evaluate after all explicit alias bridges have been joined, once per key
   * across all original slots. This cache belongs only to the current message.
   * @param {string} key @returns {MentionBinding} */
  function keyBinding(key) {
    const cached = keyCache.get(key);
    if (cached) return cached;
    const entry = keys.get(key);
    const matched = binding(entry?.rows[0]);
    if (entry) {
      if (entry.rows.some((row) => root(row) !== root(entry.rows[0]))) matched.conflict = true;
      if (entry.missing || matched.conflict) matched.name = null;
    }
    keyCache.set(key, matched);
    return matched;
  }
  /** Native post user_id is historically a literal reference, including open
   * IDs. Exact aliases may share a root only through explicit source bridges.
   * @param {string} id @param {unknown} type @returns {MentionBinding} */
  function reference(id, type) {
    if (type !== undefined) return typeof type === "string" && MENTION_ID_TYPES.includes(type)
      ? binding(identities.get(type)?.get(id)) : { name: null, conflict: true, identifiers: [id] };
    /** @type {Set<MentionIdentity>} */
    const matchedRoots = new Set();
    for (const kind of [...MENTION_ID_TYPES, "literal"]) {
      const identity = identities.get(kind)?.get(id);
      if (identity) matchedRoots.add(root(identity));
    }
    if (keys.has(id)) {
      // Key-level missing/conflicting evidence cannot be replaced by a typed
      // alias's name or by an explicit node name, even within the same root.
      const matched = keyBinding(id);
      if (!matched.name || matched.conflict) return { ...matched, conflict: true };
      const identity = keys.get(id)?.rows[0];
      if (identity) matchedRoots.add(root(identity));
    }
    return matchedRoots.size === 1 ? binding(matchedRoots.values().next().value)
      : { name: null, conflict: matchedRoots.size > 1, identifiers: [id] };
  }
  return { key: keyBinding, reference };
}

/** @param {string} text @param {ReturnType<typeof mentionBindings>} bindings @param {MentionState} state */
function resolveTextMentions(text, bindings, state) {
  // Replace only complete API mention keys. In particular @_user_1 must not
  // replace the prefix of an unresolved @_user_10. Inserted names are terminal.
  return text.replace(/@_user_\d+\b/g, (key) => {
    const { name } = bindings.key(key);
    if (name) return `@${name}`;
    state.unresolved = true;
    return key;
  });
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

/** @param {unknown} value @param {ReturnType<typeof mentionBindings>} bindings @param {MentionState} state @returns {string | null} */
function postElement(value, bindings, state) {
  if (!isObject(value)) return null;
  // Only original text slots are parsed. Neither generated at labels nor href
  // destinations are ever sent through mention replacement after concatenation.
  const text = typeof value.text === "string" ? value.text : null;
  switch (value.tag) {
    case "text":
    case "md": return text === null ? null : resolveTextMentions(text, bindings, state);
    case "a": {
      const href = typeof value.href === "string" ? value.href : "";
      const label = text === null ? null : resolveTextMentions(text, bindings, state);
      return label && href ? `${label} (${href})` : label ?? (href || null);
    }
    case "at": {
      const id = typeof value.user_id === "string" ? value.user_id : "";
      if (value.id_type === undefined && (id === "all" || id === "@_all")) return "@所有人";
      const matched = bindings.reference(id, value.id_type);
      const name = matched.conflict ? null : personName(value.user_name, [id, ...matched.identifiers])
        ? value.user_name : matched.name;
      if (name) return `@${name}`;
      state.unresolved = true;
      return id ? (id.startsWith("@") ? id : `@${id}`) : "@未知用户";
    }
    case "emotion": return typeof value.emoji_type === "string" ? `:${value.emoji_type}:` : null;
    case "hr": return "\n---\n";
    case "code_block": return text === null ? null : `\n${resolveTextMentions(text, bindings, state)}\n`;
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
  const bindings = mentionBindings(item);
  const state = { unresolved: false };
  const lines = typeof body.title === "string" && body.title ? [resolveTextMentions(body.title, bindings, state)] : [];
  let incomplete = false;
  for (const block of blocks) {
    if (!Array.isArray(block)) { incomplete = true; continue; }
    const parts = block.map((element) => postElement(element, bindings, state));
    if (parts.some((part) => part === null)) incomplete = true;
    lines.push(parts.filter((part) => part !== null).join(""));
  }
  const text = lines.join("\n");
  if (incomplete) {
    const preserved = fallback(item, "unsupported_post_element", "富文本未完整渲染，以下为完整原始内容");
    return result(text ? `${text}\n${preserved.text}` : preserved.text, "partial", preserved.reason);
  }
  return result(text, state.unresolved ? "partial" : "rendered", state.unresolved ? "unresolved_message_mention" : null);
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
  // Cards keep the same raw evidence/hash contract as every native message.
  // The shared bounded projection is also used by read-only historical views.
  if (type === "interactive") return renderCardContent(content, item.mentions);
  const payload = parseContent(content);
  if (type === "text" && isObject(payload) && typeof payload.text === "string") {
    const state = { unresolved: false };
    const text = resolveTextMentions(payload.text, mentionBindings(item), state);
    return result(text, state.unresolved ? "partial" : "rendered", state.unresolved ? "unresolved_message_mention" : null);
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
