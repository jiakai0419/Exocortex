// @ts-check
import { CARD_ID_NAMESPACES as ID_NAMESPACES, resolveCardMention, resolveNativeCardReference } from "../../../dist/core/lark-card-reference.js";
import { MAX_IMAGE_SLOTS, createImageSlot, imageSlotDisplay } from "./media-image-slot.mjs";

const MAX_INPUT_CHARS = 256 * 1024;
const MAX_OUTPUT_CHARS = 16_000;
const MAX_NODES = 2048;
const MAX_DEPTH = 24;
const LOCALES = ["zh_cn", "en_us", "ja_jp"];
const TEXT_TAGS = new Set(["text", "plain_text", "lark_md", "markdown", "md"]);
const CONTAINER_TAGS = new Set(["div", "note", "action", "column_set", "column"]);
// These controls can erase or join URL syntax when terminal text is cleaned.
// Tab and line separators keep their whitespace boundary and are excluded.
const LINK_SYNTAX_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const LINK_SCHEME = /\b(?:[a-z][a-z0-9+.-]{1,31}:\/\/|(?:javascript|vbscript|data|file|mailto|tel):)/i;
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
  media_slot_limit: "图片数量超过解析上限",
  media_reference_missing: "图片资源引用缺失",
  media_reference_invalid: "图片资源引用无效或冲突",
  media_resource_unavailable: "图片资源尚未验证",
};
const LOCAL_LIMIT_NOTICES = {
  card_input_limit: "[此处输入超过解析上限]",
  card_output_limit: "[正文在此达到展示上限]",
  card_node_limit: "[解析在此达到元素数量上限]",
  card_depth_limit: "[此处嵌套超过解析深度上限]",
  card_cycle: "[此处为循环结构，已停止展开]",
  media_slot_limit: "[此处图片数量超过解析上限]",
};

/** @typedef {Record<string, any>} JsonObject */
/** @typedef {{parent: Identity | null, ids: Map<string, string>, name: string | null, conflict: boolean}} Identity */
/** @typedef {keyof typeof EXPLANATIONS} Reason */
/** @typedef {{text: string, status: "rendered" | "partial" | "structured_fallback", reason: string | null, version: 3 | 4, omitted_actions?: number, media_slots?: Record<string,any>[]}} CardRenderResult */
/** @typedef {{includePartialNotice?: boolean, includeDecorativeSeparators?: boolean, imageContext?:unknown, resolveImage?:(slot:Record<string,any>)=>unknown}} CardRenderOptions */
/** @typedef {{prefix: string, pending: boolean, leading: string[], level: number, parent: ListItem | null}} ListItem */

/** @param {unknown} value @returns {value is JsonObject} */
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Consume one complete terminal sequence without inspecting its payload as
 * URL, Markdown or mention syntax. Every caller advances past the whole span.
 * @param {string} text @param {number} index
 */
function controlEnd(text, index) {
  const first = text.charCodeAt(index);
  let state = first === 0x1b ? "escape" : first === 0x9d ? "osc" : first === 0x9b ? "csi" :
    first === 0x90 || first === 0x98 || first === 0x9e || first === 0x9f ? "string" : null;
  if (state === null) return index;
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    const code = text.charCodeAt(cursor);
    if (state === "osc" || state === "string") {
      if (code === 0x9c || state === "osc" && code === 0x07) return cursor + 1;
      if (code === 0x1b && text[cursor + 1] === "\\") return cursor + 2;
    } else if (state === "csi") {
      if (code === 0x1b) state = "escape";
      else if (code === 0x9d) state = "osc";
      else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) state = "string";
      else if (code >= 0x40 && code <= 0x7e) return cursor + 1;
    } else {
      if (code === 0x5d) state = "osc";
      else if (code === 0x5b) state = "csi";
      else if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) state = "string";
      else if (code >= 0x30 && code <= 0x7e) return cursor + 1;
    }
  }
  return text.length;
}

/** Remote text cannot supply terminal escapes or text-direction controls.
 * This shares the lexer's opaque control spans instead of resetting state at
 * a mention inside a hidden payload. @param {string} text
 */
function cleanText(text) {
  const parts = [];
  for (let index = 0; index < text.length; index += 1) {
    const end = controlEnd(text, index);
    if (end > index) { index = end - 1; continue; }
    const code = text.charCodeAt(index);
    if (code === 0x061c || code === 0x200e || code === 0x200f ||
        code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069) continue;
    if (code === 0x0d) {
      parts.push("\n");
      if (text[index + 1] === "\n") index += 1;
    } else if (code === 0x0a || code === 0x2028 || code === 0x2029) parts.push("\n");
    else if (code < 0x20 || code >= 0x7f && code <= 0x9f) parts.push(" ");
    else parts.push(text[index]);
  }
  return parts.join("");
}

/**
 * A bounded, read-only plain-text card projection. Only known presentation
 * slots are read; callback/value/config data is never traversed or displayed.
 * Raw source evidence belongs to the caller and is never changed or dumped.
 * @param {unknown} content
 * @param {unknown} [mentions]
 * @param {CardRenderOptions} [options]
 * @returns {CardRenderResult}
 */
function renderCardContent(content, mentions = [], options = {}) {
  /** @type {Set<Reason>} */
  const reasons = new Set();
  const active = new WeakSet();
  // Reuse only nonempty-map evidence within this render. Empty maps are cheap
  // to recheck and must not become stale permission to borrow default text.
  const nonemptyLocaleMaps = new WeakSet();
  // Consumption domains stay separate. A native attachment alias never turns
  // into a global user ID, and a mention token never reads a typed-ID table.
  /** @type {Map<string, Map<string, Identity>>} */
  const identities = new Map([...ID_NAMESPACES, "literal", "mention_key"].map((kind) => [kind, new Map()]));
  /** @type {Map<string, {rows: Identity[], missing: boolean}>} */
  const mentionKeys = new Map();
  /** @type {Map<string, Identity | null>} */
  const nativeRefs = new Map();
  let hasAttachment = false;
  /** Cache terminal name projections across aliases; never reparse them in a parent.
   * @type {Map<string, string>} */
  const formattedNames = new Map();
  let parseChars = 0;
  let textChars = 0;
  let nodes = 0;
  let output = "";
  let contentEmissions = 0;
  let stopped = false;
  let omittedActions = 0;
  let finiteSemantics = false;
  let formDepth = 0;
  /** The nearest declared attachment scope; absence inherits the wrapper,
   * while an invalid declaration shadows it instead of borrowing an alias.
   * @type {JsonObject | null} */
  let imageAttachment = null;
  /** @type {Record<string,any>[]} */
  const mediaSlots = [];
  let representation = "card";
  let resolverFailed = false;
  /** @type {unknown} */
  let resolverError;
  /** List markers are deferred until visible content; hidden actions leave no empty item.
   * @type {ListItem | null} */
  let currentListItem = null;
  let firstListPrefix = true;
  let leadingListLevel = 0;
  /** @param {Reason} reason */
  const mark = (reason) => {
    reasons.add(reason);
    // The output cap is handled by emit at the exact display boundary, and
    // mention expansion has its own inline placeholder. Other traversal caps
    // mark the omitted branch immediately, before any readable sibling.
    if (reason !== "card_output_limit" && options.includePartialNotice === false &&
        Object.hasOwn(LOCAL_LIMIT_NOTICES, reason) && !stopped) {
      flushListPrefixes();
      if (stopped) return;
      const marker = LOCAL_LIMIT_NOTICES[/** @type {keyof typeof LOCAL_LIMIT_NOTICES} */ (reason)];
      contentEmissions += 1;
      if (output.length + marker.length <= MAX_OUTPUT_CHARS) output += marker;
      else {
        const suffix = `${marker}${LOCAL_LIMIT_NOTICES.card_output_limit}`;
        output = `${output.slice(0, MAX_OUTPUT_CHARS - suffix.length)}${suffix}`;
        reasons.add("card_output_limit");
        stopped = true;
      }
    }
  };

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
    // Never parse a prefix as a complete value: truncating before a URL's @
    // could turn credentials into an apparently harmless hostname.
    if (value.length > available) { mark("card_input_limit"); return ""; }
    return value;
  }

  /** @param {unknown} value @returns {unknown} */
  function parse(value) {
    if (typeof value !== "string") return value;
    if (parseChars + value.length > MAX_INPUT_CHARS) { mark("card_input_limit"); return null; }
    parseChars += value.length;
    try { return JSON.parse(value); } catch { mark("invalid_card_json"); return null; }
  }

  /** Node visits and locale-map inspection share one work allowance. */
  function consumeNodes(count = 1) {
    if (stopped) return false;
    nodes += count;
    if (nodes > MAX_NODES) { mark("card_node_limit"); stopped = true; return false; }
    return true;
  }

  /** All known schema recursion shares these limits, including inline arrays.
   * @param {unknown} value @param {number} depth @param {() => void} visit
   */
  function enter(value, depth, visit) {
    if (!consumeNodes()) return;
    if (depth > MAX_DEPTH) { mark("card_depth_limit"); return; }
    if (value !== null && typeof value === "object") {
      if (active.has(value)) { mark("card_cycle"); return; }
      active.add(value);
      try { visit(); } finally { active.delete(value); }
    } else visit();
  }

  /** Visible resource notices belong to their list item just like body text. */
  function flushListPrefixes() {
    if (!currentListItem?.pending) return;
    const pending = [];
    /** @type {ListItem | null} */
    let item = currentListItem;
    while (item?.pending) { pending.push(item); item = item.parent; }
    for (const item of pending.reverse()) {
      item.pending = false;
      if (firstListPrefix) {
        firstListPrefix = false;
        if (!output.trim()) leadingListLevel = item.level;
      }
      emit(item === currentListItem || item.leading.length ? item.prefix : item.prefix.trimEnd(), true);
      for (const text of item.leading) emit(text, true);
      item.leading = [];
      if (stopped) {
        // An output-limit notice is meaningful even when only a generated
        // prefix fit. Ancestor slots must not roll it back as an empty item.
        contentEmissions += 1;
        return;
      }
      if (item !== currentListItem) lineBreak();
    }
  }

  /** @param {string} text @param {boolean} boundary */
  function emit(text, boundary = false) {
    if (!text || stopped) return;
    if (!boundary) flushListPrefixes();
    if (stopped) return;
    if (!boundary) contentEmissions += 1;
    const remaining = MAX_OUTPUT_CHARS - output.length;
    // A pending separator alone is not missing content. A subsequent text or
    // explicit br emission still records overflow against the same limit.
    if (boundary && remaining === 0) return;
    output += text.slice(0, Math.max(remaining, 0));
    if (text.length > remaining) {
      mark("card_output_limit");
      if (options.includePartialNotice === false) {
        const marker = LOCAL_LIMIT_NOTICES.card_output_limit;
        output = `${output.slice(0, MAX_OUTPUT_CHARS - marker.length)}${marker}`;
      }
      stopped = true;
    }
  }
  function lineBreak() { if (output && !output.endsWith("\n")) emit("\n", true); }

  /** URL output intentionally contains origin/path only. Path may still be private.
   * @param {string} value
   */
  function safeUrl(value) {
    try {
      if (LINK_SYNTAX_CONTROLS.test(value)) throw new Error("ambiguous control in URL");
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
      const omitted = Boolean(url.username || url.password || url.search || url.hash);
      return `${url.origin}${url.pathname}${omitted ? " [链接敏感部分已省略]" : ""}`;
    } catch {
      mark("unsupported_card_link");
      return "[不支持的链接]";
    }
  }

  /** Validate and debit every ID before storing, combining, or comparing it.
   * IDs are matched in original bytes, never cleaned or prefix-converted.
   * @param {unknown} value @returns {string | null} */
  function boundedId(value) {
    return typeof value === "string" && value && boundedRawText(value) === value ? value : null;
  }

  /** @param {Identity} value @returns {Identity} */
  function identityRoot(value) {
    let root = value;
    while (root.parent) root = root.parent;
    while (value.parent && value.parent !== root) {
      const next = value.parent;
      value.parent = root;
      value = next;
    }
    return root;
  }

  /** @param {string} kind @param {string} id @returns {Identity} */
  function identityFor(kind, id) {
    const table = identities.get(kind);
    if (!table) throw new Error("unsupported identity namespace");
    let identity = table.get(id);
    if (!identity) {
      identity = { parent: null, ids: new Map([[kind, id]]), name: null, conflict: false };
      table.set(id, identity);
    }
    return identityRoot(identity);
  }

  /** Only IDs explicitly co-present in one source entry may join identities.
   * Shared IDs allow compatible additional namespaces; key/name equality does
   * not join disjoint identities. Contradictions remain permanent.
   * @param {Identity} left @param {Identity} right @returns {Identity} */
  function joinIdentity(left, right) {
    left = identityRoot(left);
    right = identityRoot(right);
    if (left === right) return left;
    right.parent = left;
    left.conflict ||= right.conflict;
    for (const [kind, id] of right.ids) {
      if (left.ids.has(kind) && left.ids.get(kind) !== id) left.conflict = true;
      else left.ids.set(kind, id);
    }
    if (left.name && right.name && left.name !== right.name) left.conflict = true;
    left.name ||= right.name;
    return left;
  }

  /** @param {Identity | null | undefined} identity @returns {Identity | null} */
  function resolvedIdentity(identity) {
    if (!identity) return null;
    const root = identityRoot(identity);
    return root.conflict || !root.name ? null : root;
  }

  /** @param {string} key @returns {Identity | null} */
  function mentionBinding(key) {
    const binding = mentionKeys.get(key);
    if (!binding || binding.missing || binding.rows.length === 0) return null;
    const root = resolvedIdentity(binding.rows[0]);
    return root && binding.rows.every((row) => identityRoot(row) === root) ? root : null;
  }

  /** @param {string} alias @param {Identity | null} identity */
  function bindNative(alias, identity) {
    if (!nativeRefs.has(alias)) nativeRefs.set(alias, identity);
    else if (nativeRefs.get(alias) !== identity) nativeRefs.set(alias, null);
  }

  /** @param {string} id @returns {Identity | null} */
  function nativeBinding(id) { return resolveNativeCardReference(id, cardReferenceBindings()); }

  /** @param {unknown} value @param {number} depth */
  function attachment(value, depth) {
    if (value === undefined) return;
    hasAttachment = true;
    imageAttachment = null;
    enter(value, depth, () => {
      const decoded = parse(value);
      if (!object(decoded)) { mark("unsupported_card_structure"); return; }
      imageAttachment = decoded;
      const users = read(decoded, "at_users");
      if (users === undefined) return;
      enter(users, depth + 1, () => {
        if (!object(users)) { mark("unsupported_card_structure"); return; }
        for (const rawAlias in users) {
          if (stopped) break;
          // Even skipped inherited keys consume visits; no prototype entry is
          // read or allowed to manufacture a native bridge.
          enter(rawAlias, depth + 2, () => {
            if (!Object.hasOwn(users, rawAlias)) return;
            const alias = boundedId(rawAlias);
            if (!alias) return;
            const entry = read(users, alias);
            enter(entry, depth + 3, () => {
              if (!object(entry)) { bindNative(alias, null); return; }
              const key = boundedId(read(entry, "mention_key"));
              const identity = key ? mentionBinding(key) : null;
              bindNative(alias, identity);
              const userId = boundedId(read(entry, "user_id"));
              if (userId) bindNative(userId, identity);
            });
          });
        }
      });
    });
  }

  /** A typed node reads only its declared namespace; native references use the
   * attachment bridge or the narrowly defined legacy fallback.
   * @param {JsonObject} payload @returns {Identity | null} */
  function nodeMention(payload) {
    return resolveCardMention(payload, cardReferenceBindings());
  }

  /** @returns {import("../../../dist/core/lark-card-reference.js").CardReferenceBindings<Identity>} */
  function cardReferenceBindings() {
    return {
      read, id: boundedId, hasAttachment,
      typed: (kind, id) => {
        const identity = identities.get(kind)?.get(id);
        return identity ? resolvedIdentity(identity) : undefined;
      },
      mention: key => mentionKeys.has(key) ? mentionBinding(key) : undefined,
      native: alias => resolvedIdentity(nativeRefs.get(alias)),
    };
  }

  /** A name is an independent source value, projected once without resolving
   * any mention-like text inside it. The caller only appends terminal output.
   * @param {Identity | null} identity
   */
  function mention(identity) {
    const name = resolvedIdentity(identity)?.name;
    if (name) {
      let formatted = formattedNames.get(name);
      if (formatted === undefined) {
        formatted = projectText(`@${name}`, false).slice(0, MAX_OUTPUT_CHARS + 1);
        formattedNames.set(name, formatted);
      }
      return formatted;
    }
    mark("unresolved_card_mention");
    return "@未知用户";
  }

  /** @param {string} value */
  function visibleText(value) { return projectText(boundedRawText(value), true); }

  /**
   * URL atoms take priority over Markdown at every source offset, including
   * inside labels. A consumed atom is projected once and its brackets never
   * become syntax. Markdown destinations have a separate bounded delimiter
   * scan; success and failure both advance past all inspected input. Generated
   * fragments are final output, never fed back through the lexer.
   * Only original source offsets are tokenized. URL/control atoms and whole
   * Markdown destinations are consumed before external mention resolution.
   * @param {string} text @param {boolean} resolveMentions
   */
  function projectText(text, resolveMentions) {
    // Cleaning can remove @host, erase a scheme, or create one from separated
    // letters. Its leftover prose might itself be credential/query text. With
    // no unambiguous original boundary, reject the whole affected text value.
    // Control-only prose still follows the ordinary terminal cleanup rules.
    const uncertainLinks = LINK_SYNTAX_CONTROLS.test(text);
    if (uncertainLinks && (LINK_SCHEME.test(text) || LINK_SCHEME.test(cleanText(text)))) {
      mark("unsupported_card_link");
      return "[不支持的链接]";
    }
    const parts = [];
    /** @type {string[] | null} */
    let label = null;
    let labelDepth = 0;
    let labelPrefix = "[";
    let labelHasUrl = false;
    let plainStart = 0;
    let index = 0;
    // Sticky matching examines at most 32 scheme characters on the original
    // string. It never slices the remaining input at each candidate position.
    const scheme = new RegExp(LINK_SCHEME.source, "iy");
    const mentionToken = /<at\s+id=["']([^"'<>]*)["']\s*>[^<]*<\/at>|@_user_\d+\b/iy;
    let remainingExpansion = Math.max(0, MAX_INPUT_CHARS - text.length);
    /** @param {number} end */
    function flush(end) {
      if (end > plainStart) (label ?? parts).push(cleanText(text.slice(plainStart, end)));
      plainStart = end;
    }
    function literalLabel() {
      if (label === null) return;
      parts.push(labelPrefix, label.join(""));
      // An atom may own what looks like a closing Markdown delimiter. Do not
      // recover it by splitting/reinterpreting the URL; declare the ambiguity.
      if (labelHasUrl) mark("unsupported_card_link");
      label = null;
      labelDepth = 0;
      labelHasUrl = false;
    }
    while (index < text.length) {
      const hiddenEnd = controlEnd(text, index);
      if (hiddenEnd > index) {
        flush(index);
        index = hiddenEnd;
        plainStart = index;
        continue;
      }
      scheme.lastIndex = index;
      const urlStart = scheme.exec(text);
      if (urlStart) {
        let end = scheme.lastIndex;
        while (end < text.length && !/\s/u.test(text[end])) end += 1;
        flush(index);
        const atom = text.slice(index, end);
        (label ?? parts).push(safeUrl(atom));
        if (label !== null) {
          labelHasUrl = true;
          if (atom.includes("](")) mark("unsupported_card_link");
        }
        index = end;
        plainStart = end;
        continue;
      }
      if (resolveMentions && (text[index] === "@" || text[index] === "<")) {
        mentionToken.lastIndex = index;
        const token = mentionToken.exec(text);
        if (token) {
          flush(index);
          let tokenEnd = mentionToken.lastIndex;
          let crossedControl = false;
          // Match identities against original bytes. If a hidden sequence
          // outlives this token, also consume its tail rather than exposing it
          // after substituting the tag. Complete in-tag controls stay in IDs.
          for (let cursor = index; cursor < tokenEnd; cursor += 1) {
            const hiddenEnd = controlEnd(text, cursor);
            if (hiddenEnd > tokenEnd) { tokenEnd = hiddenEnd; crossedControl = true; break; }
            if (hiddenEnd > cursor) cursor = hiddenEnd - 1;
          }
          const identity = crossedControl ? null : token[1] !== undefined
            ? nativeBinding(token[1]) : mentionBinding(token[0]);
          const cost = (identity?.name?.length ?? 5) + 1;
          let projected;
          if (cost > remainingExpansion) {
            mark("card_output_limit");
            projected = options.includePartialNotice === false ? "@提及未展开[提及在此达到展开上限]" : "@提及未展开";
          } else {
            remainingExpansion -= cost;
            projected = mention(identity);
          }
          (label ?? parts).push(projected);
          index = tokenEnd;
          plainStart = index;
          continue;
        }
      }
      const char = text[index];
      if (/[\r\n\u2028\u2029]/.test(char) && label !== null) {
        flush(index);
        literalLabel();
      } else if (char === "[") {
        if (label === null) {
          const image = index > plainStart && text[index - 1] === "!";
          flush(image ? index - 1 : index);
          label = [];
          labelPrefix = image ? "![" : "[";
          labelHasUrl = false;
          labelDepth = 1;
          plainStart = index + 1;
        } else {
          labelDepth += 1;
          if (labelDepth > MAX_DEPTH) mark("unsupported_card_link");
        }
      } else if (char === "]" && label !== null) {
        if (labelDepth > 1) {
          labelDepth -= 1;
          if (text[index + 1] === "(") mark("unsupported_card_link");
        } else if (text[index + 1] === "(") {
          flush(index);
          let nesting = 1;
          let excessive = false;
          let end = index + 2;
          for (; end < text.length && !/[\r\n\u2028\u2029]/.test(text[end]); end += 1) {
            const hiddenEnd = controlEnd(text, end);
            if (hiddenEnd > end) { end = hiddenEnd - 1; continue; }
            if (text[end] === "\\" && end + 1 < text.length && !/[\r\n\u2028\u2029]/.test(text[end + 1])) {
              // A Markdown escape never hides a terminal-sequence opener
              // from this scan; control payloads remain one opaque span.
              const escapedEnd = controlEnd(text, end + 1);
              end = escapedEnd > end + 1 ? escapedEnd - 1 : end + 1;
              continue;
            }
            if (text[end] === "(") nesting += 1;
            if (nesting > MAX_DEPTH) excessive = true;
            if (text[end] === ")" && --nesting === 0) break;
          }
          const caption = label.join("");
          if (nesting !== 0 || excessive) {
            mark("unsupported_card_link");
            parts.push(`${caption}（[不支持的链接]）`);
          } else {
            let url = text.slice(index + 2, end).trim();
            const quote = url.at(-1);
            if (quote === '\"' || quote === "'") {
              const opening = url.lastIndexOf(quote, url.length - 2);
              if (opening > 0 && /\s/u.test(url[opening - 1])) url = url.slice(0, opening).trimEnd();
            }
            if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1);
            url = url.replace(/\\([\\()[\]])/g, "$1");
            parts.push(`${caption}（链接：${safeUrl(url)}）`);
          }
          label = null;
          labelDepth = 0;
          labelHasUrl = false;
          index = nesting === 0 ? end + 1 : end;
          plainStart = index;
          continue;
        } else {
          flush(index + 1);
          // A closed bracket with no destination is literal text.
          parts.push(labelPrefix, label.join(""));
          label = null;
          labelDepth = 0;
          labelHasUrl = false;
        }
      }
      index += 1;
    }
    flush(text.length);
    literalLabel();
    return parts.join("");
  }

  /** JSON pointers describe the selected source, including decoded JSON wrappers.
   * They are not filesystem paths. @param {string} path @param {string | number} key */
  function pointer(path, key) { return `${path}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`; }

  /** @param {unknown} value @param {number} depth @param {(item: unknown, depth: number, path: string) => void} visit @param {string} [path] */
  function each(value, depth, visit, path = "") {
    if (!Array.isArray(value)) { mark("unsupported_card_structure"); return; }
    enter(value, depth, () => {
      for (let index = 0; index < value.length && !stopped; index += 1) visit(read(value, String(index)), depth + 1, pointer(path, index));
    });
  }

  /** Prefer one complete language projection. Null means a verified empty outer
   * dictionary; undefined retains invalid-language diagnostics. @param {unknown} value */
  function locale(value) {
    if (!consumeNodes()) return undefined;
    if (!object(value)) { mark("unsupported_card_structure"); return undefined; }
    for (const language of LOCALES) {
      const translated = read(value, language);
      if (typeof translated === "string" || Array.isArray(translated) || object(translated)) return { value: translated, key: language };
      if (translated !== undefined) mark("unsupported_card_structure");
    }
    if (!nonemptyLocaleMaps.has(value)) {
      const prototype = Object.getPrototypeOf(value);
      if (prototype === Object.prototype || prototype === null) {
        // Native ownKeys is eager. Debit its complete result once, never read
        // unknown values, and stop before any later map if it exceeds budget.
        const keys = Reflect.ownKeys(value);
        if (!consumeNodes(keys.length)) return undefined;
        if (keys.length === 0) return null;
        nonemptyLocaleMaps.add(value);
      }
    }
    mark("unsupported_card_structure");
    return undefined;
  }

  /** @param {unknown} value @param {number} depth @param {string} [path] */
  function inline(value, depth, path = "") {
    if (Array.isArray(value)) each(value, depth, inline, path);
    else node(value, depth, true, path);
  }

  /** @param {JsonObject} payload @param {number} depth @param {string} [path] @returns {boolean} */
  function textSlots(payload, depth, path = "") {
    for (const key of ["i18nElements", "i18nContent"]) {
      const mapping = read(payload, key);
      if (mapping === undefined) continue;
      const selected = locale(mapping);
      if (selected === null) continue;
      inline(selected?.value, depth + 1, pointer(pointer(path, key), selected?.key ?? ""));
      return true;
    }
    const contentText = read(payload, "content");
    if (contentText !== undefined) { inline(contentText, depth + 1, pointer(path, "content")); return true; }
    const text = read(payload, "text");
    if (text !== undefined) { inline(text, depth + 1, pointer(path, "text")); return true; }
    const parts = read(payload, "elements");
    if (parts !== undefined) { inline(parts, depth + 1, pointer(path, "elements")); return true; }
    return false;
  }

  /** @param {unknown} value @param {number} depth @param {string} [path] */
  function block(value, depth, path = "") { lineBreak(); node(value, depth, false, path); }

  /** @param {JsonObject} payload @param {number} depth @param {boolean} columns @param {string} [path] */
  function container(payload, depth, columns = false, path = "") {
    let recognized = false;
    const start = output.length;
    // Presentation slots are separate blocks; fragments within an inline slot
    // remain adjacent. An empty slot must not split surrounding inline text.
    /** @param {string} key @param {(value: unknown, childDepth: number, path: string) => void} visit */
    function slot(key, visit) {
      const value = read(payload, key);
      if (value === undefined) return;
      const before = output.length;
      const emissions = contentEmissions;
      if (output.length > start) lineBreak();
      recognized = true;
      visit(value, depth + 1, pointer(path, key));
      // Hidden actions/empty lists contribute no separator. Explicit br nodes
      // are content emissions, so intentional line breaks remain unchanged.
      if (contentEmissions === emissions) output = output.slice(0, before);
    }
    slot("text", inline);
    slot("fields", (value, childDepth, childPath) => each(value, childDepth, block, childPath));
    slot("elements", (value, childDepth, childPath) => each(value, childDepth, columns ? block : inline, childPath));
    slot("actions", (value, childDepth, childPath) => each(value, childDepth, block, childPath));
    slot("columns", (value, childDepth, childPath) => each(value, childDepth, block, childPath));
    slot("extra", block);
    if (!recognized) mark("unsupported_card_structure");
  }

  /** Native Markdown lists contain typed items, whose elements remain inline.
   * Do not treat unknown item kinds or arbitrary children as presentation slots.
   * @param {JsonObject} payload @param {number} depth @param {string} [path] */
  function list(payload, depth, path = "") {
    each(read(payload, "items"), depth + 1, (value, itemDepth, itemPath) => enter(value, itemDepth, () => {
      if (!object(value)) { mark("unsupported_card_structure"); return; }
      const type = read(value, "type");
      if (type !== "ol" && type !== "ul") { mark("unsupported_card_structure"); return; }
      const elements = read(value, "elements");
      if (!Array.isArray(elements)) { mark("unsupported_card_structure"); return; }
      const parent = currentListItem;
      const base = parent ? parent.level + 1 : 0;
      const observedLevel = read(value, "level");
      const level = observedLevel === undefined ? 0 : observedLevel;
      const knownLevel = Number.isSafeInteger(level) && level >= 0 && base + level <= MAX_DEPTH;
      if (!knownLevel) mark("unsupported_card_structure");
      let marker = "- ";
      if (type === "ol") {
        const order = read(value, "order");
        const knownOrder = Number.isSafeInteger(order) && order > 0;
        if (!knownOrder) mark("unsupported_card_structure");
        marker = knownOrder ? `${order}. ` : "[序号未知] ";
      }
      const indent = knownLevel ? base + level : Math.min(base, MAX_DEPTH);
      const before = output.length;
      const emissions = contentEmissions;
      lineBreak();
      currentListItem = { prefix: `${"  ".repeat(indent)}${knownLevel ? "" : "[层级未知] "}${marker}`, pending: true, leading: [], level: indent, parent };
      try { inline(elements, itemDepth + 1, pointer(itemPath, "elements")); }
      finally { currentListItem = parent; }
      // A deferred marker can itself reach the output limit before body text.
      // Preserve that limit notice instead of treating the item as hidden.
      if (contentEmissions === emissions && !stopped) output = output.slice(0, before);
      else lineBreak();
    }), pointer(path, "items"));
  }

  /** Inspect only documented navigation slots; action requests remain opaque.
   * @param {JsonObject} payload @param {number} depth @param {boolean} actionLinks */
  function navigationLinks(payload, depth, actionLinks = false) {
    /** @type {Array<{label: string | null, text: string}>} */
    const links = [];
    let usable = 0;
    /** Project a target once before choosing a fallback. Null means absent;
     * undefined means invalid. Invalid nonempty targets never borrow href.
     * @param {unknown} value @returns {string | null | undefined} */
    function target(value) {
      /** @type {unknown} */
      let destination = value;
      if (object(destination)) {
        const wrapper = destination;
        let readable = false;
        enter(wrapper, depth + 1, () => {
          const descriptor = Object.getOwnPropertyDescriptor(wrapper, "url");
          if (!descriptor || !("value" in descriptor)) { mark("unsupported_card_structure"); return; }
          destination = read(wrapper, "url");
          readable = true;
        });
        if (!readable) return undefined;
      }
      if (destination === undefined || destination === null || destination === "") return null;
      if (typeof destination !== "string") { mark("unsupported_card_structure"); return undefined; }
      return safeUrl(boundedRawText(destination));
    }
    /** @param {string | null | undefined} projected @param {string | null} label */
    function add(projected, label = null) {
      if (projected === undefined || projected === null) return;
      if (projected !== "[不支持的链接]") usable += 1;
      links.push({ label, text: projected });
    }
    const primary = target(read(payload, "url"));
    add(primary === null ? target(read(payload, "href")) : primary);
    const multi = read(payload, "multi_url");
    if (multi !== undefined) enter(multi, depth + 1, () => {
      if (!object(multi)) { mark("unsupported_card_structure"); return; }
      let recognized = false;
      for (const [slot, platform] of [["url", "默认"], ["pc_url", "桌面"], ["ios_url", "iOS"], ["android_url", "Android"]]) {
        const destination = target(read(multi, slot));
        if (destination === null) continue;
        recognized = true;
        add(destination, platform);
      }
      if (!recognized) mark("unsupported_card_structure");
    });
    if (actionLinks) {
      const actions = read(payload, "actions");
      if (actions !== undefined) each(actions, depth + 1, (entry, entryDepth) => enter(entry, entryDepth, () => {
        if (!object(entry)) { mark("unsupported_card_structure"); return; }
        const actionType = read(entry, "type");
        if (actionType === "request" || actionType === "action_request") return;
        if (actionType !== "open_url") { mark("unsupported_card_structure"); return; }
        const action = read(entry, "action");
        enter(action, entryDepth + 1, () => {
          if (!object(action)) { mark("unsupported_card_structure"); return; }
          const url = target(read(action, "url"));
          if (url === null) mark("unsupported_card_structure");
          else add(url);
        });
      }));
    }
    return { links, usable };
  }

  /** @param {ReturnType<typeof navigationLinks>} navigation @param {boolean} label */
  function emitLinks(navigation, label) {
    for (const [index, link] of navigation.links.entries()) {
      if (link.label || index > 0) lineBreak();
      emit(link.label ? `${link.label}链接：${link.text}` : `${label && index === 0 ? " " : ""}（链接：${link.text}）`);
    }
    if (!label && navigation.links.length === 0) mark("unsupported_card_structure");
  }

  /** New controls expose presentation only, never their opaque names or action
   * payloads. An unfilled input is a complete control, not a missing answer.
   * @param {JsonObject} payload */
  function controlFlags(payload) {
    for (const [key, yes, no] of [["required", "必填", "可选"], ["disabled", "禁用", "可用"]]) {
      const flag = read(payload, key);
      if (flag === undefined) continue;
      if (typeof flag !== "boolean") mark("unsupported_card_structure");
      else emit(` [${flag ? yes : no}]`);
    }
  }

  /** @param {JsonObject} payload @param {number} depth @param {string} path @param {string} label */
  function controlLabel(payload, depth, path, label) {
    lineBreak();
    emit(`${label}：`);
    const source = read(payload, "label");
    if (source !== undefined) inline(source, depth + 1, pointer(path, "label"));
    controlFlags(payload);
    lineBreak();
  }

  /** @param {JsonObject} payload @param {number} depth @param {string} path */
  function inputControl(payload, depth, path) {
    controlLabel(payload, depth, path, "输入框");
    const kind = read(payload, "inputType");
    if (kind !== undefined && kind !== "text" && kind !== "multiline_text") {
      mark("unsupported_card_structure"); return;
    }
    const hint = read(payload, "placeholder");
    if (hint !== undefined) { emit("提示："); inline(hint, depth + 1, pointer(path, "placeholder")); lineBreak(); }
    // These explicit input slots are not the generic callback `value` of a
    // button. Reject disagreement rather than choosing an arbitrary alias.
    const keys = ["value", "default_value", "defaultValue", "initialValue", "initial_value"];
    const values = keys.map(key => read(payload, key)).filter(value => value !== undefined);
    if (values.some(value => typeof value !== "string") || values.some(value => value !== values[0])) {
      mark("unsupported_card_structure"); emit("[输入值声明不一致]"); return;
    }
    if (values.length) emit(`源输入值：${visibleText(values[0])}`);
    else emit("[源未提供输入值]");
    lineBreak();
    controlActions(payload, depth);
  }

  /** Non-navigation control callbacks stay opaque. Unknown action kinds still
   * prevent readiness. @param {JsonObject} payload @param {number} depth */
  function controlActions(payload, depth) {
    const actions = read(payload, "actions");
    if (actions === undefined) return;
    each(actions, depth + 1, (action, actionDepth) => enter(action, actionDepth, () => {
      if (!object(action) || !["request", "action_request"].includes(read(action, "type"))) {
        mark("unsupported_card_structure"); return;
      }
      omittedActions += 1;
    }));
  }

  /** @param {JsonObject} payload @param {number} depth @param {string} path */
  function selectControl(payload, depth, path) {
    controlLabel(payload, depth, path, "选择框");
    /** @type {Array<{value: string | null, path: string, text: unknown, disabled: unknown}>} */
    const choices = [];
    each(read(payload, "options"), depth + 1, (option, optionDepth, optionPath) => enter(option, optionDepth, () => {
      if (!object(option)) { mark("unsupported_card_structure"); return; }
      const value = boundedId(read(option, "value"));
      const label = read(option, "text");
      if (value === null || label === undefined) mark("unsupported_card_structure");
      choices.push({ value, path: optionPath, text: label, disabled: read(option, "disabled") });
      controlActions(option, optionDepth);
    }), pointer(path, "options"));
    if (!choices.length) mark("unsupported_card_structure");
    const initial = [read(payload, "initialOption"), read(payload, "initial_option")].filter(value => value !== undefined);
    const index = read(payload, "initialIndex");
    let selected = -1;
    let uncertain = false;
    if (initial.length) {
      if (initial.some(value => typeof value !== "string" || !value || boundedRawText(value) !== value)
          || initial.some(value => value !== initial[0])) uncertain = true;
      else {
        const matches = choices.flatMap((choice, position) => choice.value === initial[0] ? [position] : []);
        if (matches.length !== 1) uncertain = true;
        else selected = matches[0];
      }
    }
    if (index !== undefined) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= choices.length
          || initial.length > 0 && selected !== index) uncertain = true;
      else selected = index;
    }
    if (uncertain) { selected = -1; mark("unsupported_card_structure"); }
    for (const [position, choice] of choices.entries()) {
      if (stopped) break;
      emit(position === selected ? "[源初选] " : "- ");
      inline(choice.text, depth + 2, pointer(choice.path, "text"));
      if (choice.disabled !== undefined) {
        if (typeof choice.disabled !== "boolean") mark("unsupported_card_structure");
        else emit(choice.disabled ? " [禁用]" : " [可用]");
      }
      lineBreak();
    }
    if (uncertain) emit("[初选声明无法确认]");
    else if (selected < 0) emit("[源未提供初选]");
    lineBreak();
    controlActions(payload, depth);
  }

  /** @param {JsonObject} payload @param {number} depth @param {string} path */
  function panel(payload, depth, path) {
    const expanded = read(payload, "expanded");
    if (expanded !== undefined && typeof expanded !== "boolean") mark("unsupported_card_structure");
    const header = read(payload, "header");
    if (header !== undefined) {
      const property = read(header, "property");
      const headerPayload = property === undefined ? header : property;
      const headerPath = property === undefined ? pointer(path, "header") : pointer(pointer(path, "header"), "property");
      if (read(headerPayload, "title") !== undefined) {
        block(read(headerPayload, "title"), depth + 1, pointer(headerPath, "title"));
        const subtitle = read(headerPayload, "subtitle");
        if (subtitle !== undefined) block(subtitle, depth + 1, pointer(headerPath, "subtitle"));
      } else block(header, depth + 1, pointer(path, "header"));
    }
    each(read(payload, "elements"), depth + 1, block, pointer(path, "elements"));
    lineBreak();
  }

  /** One selected occurrence creates one slot. Neither aliases nor resource
   * keys are rendered, and no lookup traverses unrelated attachment entries.
   * @param {JsonObject} payload @param {number} depth @param {string} path */
  function imageNode(payload, depth, path) {
    finiteSemantics = true;
    if (mediaSlots.length >= MAX_IMAGE_SLOTS) { mark("media_slot_limit"); return; }
    const direct = [read(payload, "image_key"), read(payload, "img_key")].filter(value => value !== undefined);
    const alias = read(payload, "imageID");
    /** @type {unknown} */
    let key = direct[0];
    /** @type {string | undefined} */
    let state;
    const kind = alias !== undefined ? "attachment_origin_key" : "image_key";
    if (direct.some(value => value !== direct[0]) || direct.length > 0 && alias !== undefined) state = "conflicting_reference";
    if (alias !== undefined && state === undefined) {
      key = null;
      if (typeof alias !== "string" || !alias || boundedRawText(alias) !== alias) state = "invalid_reference";
      else if (imageAttachment !== null) enter(imageAttachment, depth + 1, () => {
        const images = read(imageAttachment, "images");
        if (images === undefined) return;
        enter(images, depth + 2, () => {
          if (!object(images)) { state = "invalid_reference"; return; }
          const image = read(images, alias);
          if (image === undefined) return;
          enter(image, depth + 3, () => {
            if (!object(image)) { state = "invalid_reference"; return; }
            key = read(image, "origin_key");
          });
        });
      });
    }
    if (typeof key === "string" && boundedRawText(key) !== key) state = "invalid_reference";
    const slot = createImageSlot({ slot_id: path, order: mediaSlots.length,
      message_type: "interactive", representation, reference_kind: kind,
      reference_state: state, key, alias }, { imageContext: options.imageContext });
    if (!slot) { mark("unsupported_card_structure"); emit("[图片] 资源引用无效"); return; }
    mediaSlots.push(slot);
    let resolution;
    if (options.resolveImage) {
      try { resolution = options.resolveImage(slot); }
      catch (error) { resolverFailed = true; resolverError = error; throw error; }
    }
    const display = imageSlotDisplay(slot, resolution);
    emit(display.text);
    if (display.reason !== null) mark(/** @type {Reason} */ (display.reason));
  }

  /** @param {unknown} value @param {number} depth @param {boolean} inLine @param {string} [path] */
  function node(value, depth, inLine, path = "") {
    enter(value, depth, () => {
      if (typeof value === "string") {
        const text = visibleText(value);
        // Blank source fragments cannot make a list marker into visible body.
        // Keep their order if content follows; boundedRawText and node visits
        // already bound this buffer. Explicit br and resource notices still
        // activate their item through the ordinary emission paths.
        if (currentListItem?.pending && text && !text.trim()) currentListItem.leading.push(text);
        else emit(text);
        return;
      }
      if (!object(value)) { mark("unsupported_card_structure"); return; }
      const property = read(value, "property");
      const payload = property === undefined ? value : property;
      if (!object(payload)) { mark("unsupported_card_structure"); return; }
      const payloadPath = property === undefined ? path : pointer(path, "property");
      const tag = read(value, "tag") ?? read(value, "type") ?? read(payload, "tag") ?? read(payload, "type") ?? "";
      if (tag === "at") {
        emit(mention(nodeMention(payload)));
      } else if (tag === "at_all") {
        emit("@所有人");
      } else if (TEXT_TAGS.has(tag)) {
        if (!textSlots(payload, depth, payloadPath)) mark("unsupported_card_structure");
      } else if (tag === "list") {
        list(payload, depth, payloadPath);
      } else if (tag === "collapsible_panel") {
        finiteSemantics = true;
        panel(payload, depth, payloadPath);
      } else if (tag === "form") {
        finiteSemantics = true;
        if (formDepth > 0) mark("unsupported_card_structure");
        formDepth += 1;
        try { each(read(payload, "elements"), depth + 1, block, pointer(payloadPath, "elements")); }
        finally { formDepth -= 1; }
      } else if (tag === "input" || tag === "select_static") {
        finiteSemantics = true;
        if (!formDepth) { mark("unsupported_card_structure"); return; }
        if (tag === "input") inputControl(payload, depth, payloadPath);
        else selectControl(payload, depth, payloadPath);
      } else if (tag === "markdown_v1") {
        finiteSemantics = true;
        const previous = representation;
        representation = "markdown_v1";
        try {
          const elements = read(payload, "elements");
          if (elements !== undefined) each(elements, depth + 1, inline, pointer(payloadPath, "elements"));
          else if (property === undefined && read(value, "fallback") !== undefined) {
            node(read(value, "fallback"), depth + 1, inLine, pointer(path, "fallback"));
          } else mark("unsupported_card_structure");
        } finally { representation = previous; }
      } else if (tag === "img") {
        imageNode(payload, depth, path);
      } else if (tag === "button" || tag === "a" || tag === "link") {
        const navigation = navigationLinks(payload, depth, tag === "button");
        const formActionType = formDepth && tag === "button" ? read(payload, "actionType") : undefined;
        if (formActionType !== undefined && formActionType !== "form_submit") mark("unsupported_card_structure");
        if (tag === "button" && navigation.usable === 0) {
          omittedActions += 1;
          if (formDepth) {
            lineBreak();
            emit(formActionType === "form_submit" ? "提交操作：" : "交互操作：");
            if (!textSlots(payload, depth, payloadPath)) mark("unsupported_card_structure");
            controlFlags(payload);
            emit(" [未在文本视图执行]");
            lineBreak();
          }
          return;
        }
        if (!inLine) lineBreak();
        const label = textSlots(payload, depth, payloadPath);
        emitLinks(navigation, label);
      } else if (CONTAINER_TAGS.has(tag)) {
        lineBreak();
        container(payload, depth, tag === "column" || tag === "column_set", payloadPath);
        lineBreak();
      } else if (tag === "br") {
        emit("\n");
      } else if (tag === "hr") {
        lineBreak();
        if (options.includeDecorativeSeparators === false) {
          if (output && !output.endsWith("\n\n")) emit("\n", true);
        } else {
          emit("---"); lineBreak();
        }
      } else if (tag === "") {
        // Untagged native property nodes and common field wrappers have only
        // these presentation slots; never search arbitrary descendants.
        if (["elements", "fields", "actions", "columns", "extra"].some((key) => read(payload, key) !== undefined)) {
          container(payload, depth, false, payloadPath);
        } else if (["url", "href", "multi_url"].some((key) => read(payload, key) !== undefined)) {
          emitLinks(navigationLinks(payload, depth), textSlots(payload, depth, payloadPath));
        } else if (!textSlots(payload, depth, payloadPath)) mark("unsupported_card_structure");
      } else mark("unsupported_card_structure");
    });
  }

  try {
    // First establish typed evidence from all rows. Evaluate key bindings only
    // after shared identity components have absorbed compatible extra IDs.
    if (Array.isArray(mentions)) each(mentions, 0, (entry, depth) => enter(entry, depth, () => {
      if (!object(entry)) return;
      const key = boundedId(read(entry, "key"));
      const rawName = read(entry, "name");
      const checkedName = typeof rawName === "string" ? boundedRawText(rawName) : "";
      const name = checkedName.trim() ? checkedName : null;
      const id = read(entry, "id");
      const idType = read(entry, "id_type");
      /** @type {Identity | null} */
      let identity = null;
      let invalid = false;
      /** @param {string} kind @param {unknown} value */
      function add(kind, value) {
        if (value === undefined || value === null || value === "") return;
        const exact = boundedId(value);
        if (!exact) { invalid = true; return; }
        const candidate = identityFor(kind, exact);
        identity = identity ? joinIdentity(identity, candidate) : candidate;
      }
      for (const kind of ID_NAMESPACES) {
        add(kind, read(entry, kind));
        add(kind, read(id, kind));
      }
      if (typeof id === "string") {
        if (idType === undefined) add("literal", id);
        else {
          const kind = boundedId(idType);
          if (kind && ID_NAMESPACES.includes(kind)) add(kind, id);
          else invalid = true;
        }
      } else if (idType !== undefined) invalid = true;
      if (!identity && key && !invalid) identity = identityFor("mention_key", key);
      if (identity) {
        const root = identityRoot(identity);
        if (invalid || root.name && name && root.name !== name) root.conflict = true;
        root.name ||= name;
      }
      if (key) {
        const binding = mentionKeys.get(key) || { rows: [], missing: false };
        if (identity) binding.rows.push(identity);
        if (!name || !identity || invalid) binding.missing = true;
        mentionKeys.set(key, binding);
      }
    }));
    let card = parse(content);
    let wrapperDepth = 0;
    let cardPath = "";
    const wrappers = new WeakSet();
    while (!stopped && object(card) && read(card, "json_card") !== undefined) {
      if (wrappers.has(card)) { mark("card_cycle"); card = null; break; }
      if (wrapperDepth >= MAX_DEPTH) { mark("card_depth_limit"); card = null; break; }
      wrappers.add(card);
      const wrapper = card;
      enter(wrapper, wrapperDepth, () => { attachment(read(wrapper, "json_attachment"), wrapperDepth + 1); });
      wrapperDepth += 1;
      card = parse(read(wrapper, "json_card"));
      cardPath = pointer(cardPath, "json_card");
    }
    if (!object(card)) mark("invalid_card_json");
    else enter(card, wrapperDepth, () => {
      attachment(read(card, "json_attachment"), wrapperDepth + 1);
      const header = read(card, "header");
      if (header !== undefined) {
        const headerPayload = read(header, "property") ?? header;
        const headerPath = read(header, "property") === undefined ? pointer(cardPath, "header") : pointer(pointer(cardPath, "header"), "property");
        const title = read(headerPayload, "title");
        if (title !== undefined) block(title, wrapperDepth + 1, pointer(headerPath, "title"));
        else mark("unsupported_card_structure");
        const subtitle = read(headerPayload, "subtitle");
        if (subtitle !== undefined) block(subtitle, wrapperDepth + 1, pointer(headerPath, "subtitle"));
      }
      const body = read(card, "body");
      const bodyPayload = read(body, "property") ?? body;
      const elements = body === undefined ? read(card, "elements") : read(bodyPayload, "elements");
      const bodyPath = body === undefined ? cardPath : read(body, "property") === undefined
        ? pointer(cardPath, "body") : pointer(pointer(cardPath, "body"), "property");
      if (elements !== undefined) each(elements, wrapperDepth + 1, block, pointer(bodyPath, "elements"));
      else if (body !== undefined || header === undefined) mark("unsupported_card_structure");
      if (read(card, "i18n_elements") !== undefined || read(card, "i18nElements") !== undefined) {
        mark("unsupported_card_structure");
      }
    });
  } catch {
    if (resolverFailed) throw resolverError;
    // Malformed non-JSON objects (including access traps) are never dumped.
    mark("unsupported_card_structure");
  }
  // Preserve only generated indentation on an initial list; ordinary source
  // whitespace keeps the established trim behavior.
  output = `${"  ".repeat(leadingListLevel)}${output.trim()}`;
  const version = finiteSemantics ? 4 : 3;
  const omissions = { ...(omittedActions > 0 ? { omitted_actions: omittedActions } : {}),
    ...(mediaSlots.length > 0 ? { media_slots: mediaSlots } : {}) };
  if (!output && reasons.size === 0 && omittedActions > 0) {
    return { text: "[卡片仅含交互操作，文本视图已收起]", status: "rendered", reason: null, version, ...omissions };
  }
  if (!output && reasons.size === 0) mark("card_no_visible_content");
  const reason = /** @type {Reason | undefined} */ (Object.keys(EXPLANATIONS).find((key) =>
    key !== "unresolved_card_mention" && reasons.has(/** @type {Reason} */ (key))))
    || (reasons.has("unresolved_card_mention") ? "unresolved_card_mention" : undefined);
  if (!reason) return { text: output, status: "rendered", reason: null, version, ...omissions };
  if (reason === "unresolved_card_mention" && reasons.size === 1) {
    return { text: output, status: "partial", reason, version, ...omissions };
  }
  const status = output ? "partial" : "structured_fallback";
  // Human message reading can omit a result-level partial notice without
  // stripping matching source text or weakening local missing-value markers.
  // Default projections (including stored and JSON content) stay unchanged.
  if (output && options.includePartialNotice === false) {
    return { text: output, status, reason, version, ...omissions };
  }
  const marker = `[卡片${output ? "部分内容未展开" : "未展开"}：${EXPLANATIONS[reason]}]`;
  return { text: `${output.slice(0, Math.max(0, MAX_OUTPUT_CHARS - marker.length - 1))}${output ? "\n" : ""}${marker}`,
    status, reason, version, ...omissions };
}

export { renderCardContent };
