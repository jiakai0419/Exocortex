// @ts-check

import { stripVTControlCharacters } from "node:util";

const MAX_INPUT_CHARS = 256 * 1024;
const MAX_OUTPUT_CHARS = 16_000;
const MAX_NODES = 2048;
const MAX_DEPTH = 24;
const LOCALES = ["zh_cn", "en_us", "ja_jp"];
const TEXT_TAGS = new Set(["text", "plain_text", "lark_md", "markdown", "md"]);
const CONTAINER_TAGS = new Set(["div", "note", "action", "column_set", "column"]);
const EXPLANATIONS = {
  card_input_limit: "输入超过解析上限",
  card_output_limit: "正文超过展示上限",
  card_node_limit: "元素数量超过解析上限",
  card_depth_limit: "嵌套超过解析上限",
  card_cycle: "存在循环结构",
  invalid_card_json: "卡片格式无效",
  unsupported_card_structure: "部分结构尚未支持",
  unresolved_card_mention: "部分提及未能匹配",
  unsupported_card_link: "不支持的链接已省略",
  card_no_visible_content: "没有可识别正文",
};

/** @typedef {Record<string, any>} JsonObject */
/** @typedef {keyof typeof EXPLANATIONS} Reason */
/** @typedef {{text: string, status: "rendered" | "partial" | "structured_fallback", reason: string | null, version: 2}} CardRenderResult */

/** @param {unknown} value @returns {value is JsonObject} */
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Remote text cannot supply terminal escapes or text-direction controls. @param {string} text */
function cleanText(text) {
  return stripVTControlCharacters(text
    .replace(/(?:\u001B\]|\u009D)[\s\S]*?(?:\u0007|\u001B\\|\u009C)/g, "")
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, ""))
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, " ");
}

/**
 * A bounded, read-only plain-text card projection. Only known presentation
 * slots are read; callback/value/config data is never traversed or displayed.
 * Raw source evidence belongs to the caller and is never changed or dumped.
 * @param {unknown} content
 * @param {unknown} [mentions]
 * @returns {CardRenderResult}
 */
function renderCardContent(content, mentions = []) {
  /** @type {Set<Reason>} */
  const reasons = new Set();
  const active = new WeakSet();
  /** @type {Map<string, string | null>} */
  const names = new Map();
  let parseChars = 0;
  let textChars = 0;
  let nodes = 0;
  let output = "";
  let stopped = false;
  /** @param {Reason} reason */
  const mark = (reason) => { reasons.add(reason); };

  /** Read data properties only: inherited or accessor content is not source text.
   * @param {unknown} value @param {string} key @returns {any}
   */
  function read(value, key) {
    if (value === null || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !("value" in descriptor)) { mark("unsupported_card_structure"); return undefined; }
    return descriptor?.value;
  }

  /** @param {string} value */
  function boundedRawText(value) {
    const available = Math.max(0, MAX_INPUT_CHARS - textChars);
    textChars += Math.min(value.length, available);
    if (value.length > available) mark("card_input_limit");
    return value.slice(0, available);
  }

  /** @param {string} value */
  function boundedText(value) { return cleanText(boundedRawText(value)); }

  /** @param {unknown} value @returns {unknown} */
  function parse(value) {
    if (typeof value !== "string") return value;
    if (parseChars + value.length > MAX_INPUT_CHARS) { mark("card_input_limit"); return null; }
    parseChars += value.length;
    try { return JSON.parse(value); } catch { mark("invalid_card_json"); return null; }
  }

  /** All known schema recursion shares these limits, including inline arrays.
   * @param {unknown} value @param {number} depth @param {() => void} visit
   */
  function enter(value, depth, visit) {
    if (stopped) return;
    nodes += 1;
    if (nodes > MAX_NODES) { mark("card_node_limit"); stopped = true; return; }
    if (depth > MAX_DEPTH) { mark("card_depth_limit"); return; }
    if (value !== null && typeof value === "object") {
      if (active.has(value)) { mark("card_cycle"); return; }
      active.add(value);
      try { visit(); } finally { active.delete(value); }
    } else visit();
  }

  /** @param {string} text */
  function emit(text) {
    if (!text || stopped) return;
    const remaining = MAX_OUTPUT_CHARS - output.length;
    output += text.slice(0, Math.max(remaining, 0));
    if (text.length > remaining) { mark("card_output_limit"); stopped = true; }
  }
  function lineBreak() { if (output && !output.endsWith("\n")) emit("\n"); }

  /** URL output intentionally contains origin/path only. Path may still be private.
   * @param {string} value
   */
  function safeUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
      const omitted = Boolean(url.username || url.password || url.search || url.hash);
      return `${url.origin}${url.pathname}${omitted ? " [链接敏感部分已省略]" : ""}`;
    } catch {
      mark("unsupported_card_link");
      return "[不支持的链接]";
    }
  }

  /** @param {string} id */
  function mention(id) {
    const name = names.get(id);
    if (name) return `@${safeLinks(name)}`;
    mark("unresolved_card_mention");
    return "@未知用户";
  }

  /** The same URL rules apply to bare URLs and Markdown destinations.
   * @param {string} value
   */
  function visibleText(value) {
    let text = boundedRawText(value);
    text = text.replace(/<at\s+id=["']([^"'<>]*)["']\s*>[^<]*<\/at>|@_user_\d+\b/gi,
      (matched, id) => mention(id ?? matched));
    return safeLinks(cleanText(text));
  }

  /** A single forward scan prevents unmatched brackets from causing regex
   * backtracking and keeps complete parenthesized URL queries inside the link.
   * @param {string} text
   */
  function markdownLinks(text) {
    const parts = [];
    let copiedUntil = 0;
    let labelStart = -1;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\n") labelStart = -1;
      else if (text[index] === "[") labelStart = index;
      else if (text[index] === "]" && labelStart >= 0 && text[index + 1] === "(") {
        let nesting = 1;
        let excessive = false;
        let end = index + 2;
        for (; end < text.length && text[end] !== "\n"; end += 1) {
          if (text[end] === "\\" && end + 1 < text.length && text[end + 1] !== "\n") {
            end += 1;
            continue;
          }
          if (text[end] === "(") nesting += 1;
          if (nesting > MAX_DEPTH) excessive = true;
          if (text[end] === ")" && --nesting === 0) break;
        }
        const label = text.slice(labelStart + 1, index);
        const start = labelStart > copiedUntil && text[labelStart - 1] === "!" ? labelStart - 1 : labelStart;
        parts.push(text.slice(copiedUntil, start));
        if (nesting !== 0 || excessive) {
          mark("unsupported_card_link");
          parts.push(`${label}（[不支持的链接]）`);
        } else {
          const url = text.slice(index + 2, end).trim().replace(/^<([^>]*)>$/, "$1")
            .replace(/\s+["'][^"']*["']$/, "").replace(/\\([\\()[\]])/g, "$1");
          parts.push(`${label}（链接：${safeUrl(url)}）`);
        }
        copiedUntil = nesting === 0 ? end + 1 : end;
        index = copiedUntil - 1;
        labelStart = -1;
      }
    }
    parts.push(text.slice(copiedUntil));
    return parts.join("");
  }

  /** @param {string} text */
  function safeLinks(text) {
    return markdownLinks(text).replace(/\b(?:[a-z][a-z0-9+.-]{1,31}:\/\/|(?:javascript|vbscript|data|file|mailto|tel):)[^\s<>\uFF08\uFF09\]]+/gi,
      (url) => safeUrl(url));
  }

  /** @param {unknown} value @param {number} depth @param {(item: unknown, depth: number) => void} visit */
  function each(value, depth, visit) {
    if (!Array.isArray(value)) { mark("unsupported_card_structure"); return; }
    enter(value, depth, () => {
      for (let index = 0; index < value.length && !stopped; index += 1) visit(read(value, String(index)), depth + 1);
    });
  }

  /** Prefer one complete language projection, never combine translated copies. @param {unknown} value */
  function locale(value) {
    if (!object(value)) { mark("unsupported_card_structure"); return undefined; }
    for (const language of LOCALES) {
      const translated = read(value, language);
      if (typeof translated === "string" || Array.isArray(translated) || object(translated)) return translated;
      if (translated !== undefined) mark("unsupported_card_structure");
    }
    mark("unsupported_card_structure");
    return undefined;
  }

  /** @param {unknown} value @param {number} depth */
  function inline(value, depth) {
    if (Array.isArray(value)) each(value, depth, inline);
    else node(value, depth, true);
  }

  /** @param {JsonObject} payload @param {number} depth @returns {boolean} */
  function textSlots(payload, depth) {
    const elements = read(payload, "i18nElements");
    if (elements !== undefined) { inline(locale(elements), depth + 1); return true; }
    const translated = read(payload, "i18nContent");
    if (translated !== undefined) { inline(locale(translated), depth + 1); return true; }
    const contentText = read(payload, "content");
    if (contentText !== undefined) { inline(contentText, depth + 1); return true; }
    const text = read(payload, "text");
    if (text !== undefined) { inline(text, depth + 1); return true; }
    const parts = read(payload, "elements");
    if (parts !== undefined) { inline(parts, depth + 1); return true; }
    return false;
  }

  /** @param {unknown} value @param {number} depth */
  function block(value, depth) { lineBreak(); node(value, depth, false); }

  /** @param {JsonObject} payload @param {number} depth @param {boolean} columns */
  function container(payload, depth, columns = false) {
    let recognized = false;
    const text = read(payload, "text");
    if (text !== undefined) { inline(text, depth + 1); recognized = true; }
    const fields = read(payload, "fields");
    if (fields !== undefined) { each(fields, depth + 1, block); recognized = true; }
    const elements = read(payload, "elements");
    if (elements !== undefined) { each(elements, depth + 1, columns ? block : inline); recognized = true; }
    const actions = read(payload, "actions");
    if (actions !== undefined) { each(actions, depth + 1, block); recognized = true; }
    const childColumns = read(payload, "columns");
    if (childColumns !== undefined) { each(childColumns, depth + 1, block); recognized = true; }
    if (!recognized) mark("unsupported_card_structure");
  }

  /** @param {unknown} value @param {number} depth @param {boolean} inLine */
  function node(value, depth, inLine) {
    enter(value, depth, () => {
      if (typeof value === "string") { emit(visibleText(value)); return; }
      if (!object(value)) { mark("unsupported_card_structure"); return; }
      const property = read(value, "property");
      const payload = property === undefined ? value : property;
      if (!object(payload)) { mark("unsupported_card_structure"); return; }
      const tag = read(value, "tag") ?? read(value, "type") ?? read(payload, "tag") ?? read(payload, "type") ?? "";
      if (tag === "at") {
        const id = read(payload, "userID") ?? read(payload, "user_id");
        if (typeof id === "string") boundedText(id);
        emit(typeof id === "string" ? mention(id) : mention(""));
      } else if (TEXT_TAGS.has(tag)) {
        if (!textSlots(payload, depth)) mark("unsupported_card_structure");
      } else if (tag === "button" || tag === "a" || tag === "link") {
        if (!inLine) lineBreak();
        const label = textSlots(payload, depth);
        const url = read(payload, "url") ?? read(payload, "href");
        if (typeof url === "string") emit(`${label ? " " : ""}（链接：${safeUrl(boundedText(url))}）`);
        else if (url !== undefined || !label) mark("unsupported_card_structure");
      } else if (CONTAINER_TAGS.has(tag)) {
        container(payload, depth, tag === "column" || tag === "column_set");
      } else if (tag === "hr") {
        lineBreak(); emit("---"); lineBreak();
      } else if (tag === "") {
        // Untagged native property nodes and common field wrappers have only
        // these presentation slots; never search arbitrary descendants.
        if (["elements", "fields", "actions", "columns"].some((key) => read(payload, key) !== undefined)) {
          container(payload, depth);
        } else if (!textSlots(payload, depth)) mark("unsupported_card_structure");
      } else mark("unsupported_card_structure");
    });
  }

  try {
    // Mention identifiers and names come only from this message's native list.
    if (Array.isArray(mentions)) each(mentions, 0, (entry, depth) => enter(entry, depth, () => {
      if (!object(entry)) return;
      const name = read(entry, "name");
      if (typeof name !== "string" || !name.trim()) return;
      const safeName = boundedText(name);
      const id = read(entry, "id");
      const keys = [read(entry, "key"), typeof id === "string" ? id : undefined,
        ...["open_id", "user_id", "union_id"].flatMap((key) => [read(entry, key), read(id, key)])];
      for (const key of keys) {
        if (typeof key !== "string" || !key) continue;
        boundedText(key);
        if (key.length > MAX_INPUT_CHARS) continue;
        const previous = names.get(key);
        names.set(key, names.has(key) && previous !== safeName ? null : safeName);
      }
    }));
    let card = parse(content);
    let wrapperDepth = 0;
    const wrappers = new WeakSet();
    while (object(card) && read(card, "json_card") !== undefined) {
      if (wrappers.has(card)) { mark("card_cycle"); card = null; break; }
      if (wrapperDepth >= MAX_DEPTH) { mark("card_depth_limit"); card = null; break; }
      wrappers.add(card);
      wrapperDepth += 1;
      card = parse(read(card, "json_card"));
    }
    if (!object(card)) mark("invalid_card_json");
    else enter(card, wrapperDepth, () => {
      const header = read(card, "header");
      if (header !== undefined) {
        const headerPayload = read(header, "property") ?? header;
        const title = read(headerPayload, "title");
        if (title !== undefined) block(title, wrapperDepth + 1);
        else mark("unsupported_card_structure");
      }
      const body = read(card, "body");
      const bodyPayload = read(body, "property") ?? body;
      const elements = body === undefined ? read(card, "elements") : read(bodyPayload, "elements");
      if (elements !== undefined) each(elements, wrapperDepth + 1, block);
      else if (body !== undefined || header === undefined) mark("unsupported_card_structure");
      if (read(card, "i18n_elements") !== undefined || read(card, "i18nElements") !== undefined) {
        mark("unsupported_card_structure");
      }
    });
  } catch {
    // Malformed non-JSON objects (including access traps) are never dumped.
    mark("unsupported_card_structure");
  }
  output = output.trim();
  if (!output && reasons.size === 0) mark("card_no_visible_content");
  const reason = /** @type {Reason | undefined} */ (Object.keys(EXPLANATIONS).find((key) => reasons.has(/** @type {Reason} */ (key))));
  if (!reason) return { text: output, status: "rendered", reason: null, version: 2 };
  const status = output ? "partial" : "structured_fallback";
  const marker = `[卡片${output ? "部分内容未展开" : "未展开"}：${EXPLANATIONS[reason]}]`;
  return { text: `${output.slice(0, Math.max(0, MAX_OUTPUT_CHARS - marker.length - 1))}${output ? "\n" : ""}${marker}`,
    status, reason, version: 2 };
}

export { renderCardContent };
