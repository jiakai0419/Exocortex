// @ts-check

const MAX_INPUT_CHARS = 256 * 1024;
const MAX_OUTPUT_CHARS = 16_000;
const MAX_NODES = 2048;
const MAX_DEPTH = 24;
const LOCALES = ["zh_cn", "en_us", "ja_jp"];
const ID_NAMESPACES = ["open_id", "user_id", "union_id", "app_id"];
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
};
const LOCAL_LIMIT_NOTICES = {
  card_input_limit: "[此处输入超过解析上限]",
  card_output_limit: "[正文在此达到展示上限]",
  card_node_limit: "[解析在此达到元素数量上限]",
  card_depth_limit: "[此处嵌套超过解析深度上限]",
  card_cycle: "[此处为循环结构，已停止展开]",
};

/** @typedef {Record<string, any>} JsonObject */
/** @typedef {{parent: Identity | null, ids: Map<string, string>, name: string | null, conflict: boolean}} Identity */
/** @typedef {keyof typeof EXPLANATIONS} Reason */
/** @typedef {{text: string, status: "rendered" | "partial" | "structured_fallback", reason: string | null, version: 3, omitted_actions?: number}} CardRenderResult */
/** @typedef {{includePartialNotice?: boolean, includeDecorativeSeparators?: boolean}} CardRenderOptions */
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
  function nativeBinding(id) {
    if (hasAttachment) return resolvedIdentity(nativeRefs.get(id));
    // Compatibility is exact and only available without attachment evidence.
    // The same bytes in multiple namespaces are ambiguous even if names match.
    /** @type {Identity | null} */
    let match = null;
    let matches = 0;
    for (const kind of [...ID_NAMESPACES, "literal"]) {
      const identity = identities.get(kind)?.get(id);
      if (identity) { matches += 1; match = resolvedIdentity(identity); }
    }
    if (mentionKeys.has(id)) { matches += 1; match = mentionBinding(id); }
    return matches === 1 ? match : null;
  }

  /** @param {unknown} value @param {number} depth */
  function attachment(value, depth) {
    if (value === undefined) return;
    hasAttachment = true;
    enter(value, depth, () => {
      const decoded = parse(value);
      if (!object(decoded)) { mark("unsupported_card_structure"); return; }
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
    const id = read(payload, "id");
    const declaredType = read(payload, "id_type");
    /** @type {Identity | null} */
    let match = null;
    let typed = false;
    let valid = true;
    /** @param {string} kind @param {unknown} value */
    function consume(kind, value) {
      typed = true;
      const exact = boundedId(value);
      const identity = exact ? resolvedIdentity(identities.get(kind)?.get(exact)) : null;
      if (!identity || match && match !== identity) valid = false;
      else match = identity;
    }
    if (declaredType !== undefined) {
      const kind = boundedId(declaredType);
      if (!kind || !ID_NAMESPACES.includes(kind)) { typed = true; valid = false; }
      else consume(kind, id);
    }
    for (const kind of ID_NAMESPACES) {
      const flat = read(payload, kind);
      const nested = read(id, kind);
      if (flat !== undefined) consume(kind, flat);
      if (nested !== undefined) consume(kind, nested);
    }
    if (typed) return valid ? match : null;
    const native = boundedId(read(payload, "userID"));
    return native ? nativeBinding(native) : null;
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

  /** @param {unknown} value @param {number} depth @param {(item: unknown, depth: number) => void} visit */
  function each(value, depth, visit) {
    if (!Array.isArray(value)) { mark("unsupported_card_structure"); return; }
    enter(value, depth, () => {
      for (let index = 0; index < value.length && !stopped; index += 1) visit(read(value, String(index)), depth + 1);
    });
  }

  /** Prefer one complete language projection. Null means a verified empty outer
   * dictionary; undefined retains invalid-language diagnostics. @param {unknown} value */
  function locale(value) {
    if (!consumeNodes()) return undefined;
    if (!object(value)) { mark("unsupported_card_structure"); return undefined; }
    for (const language of LOCALES) {
      const translated = read(value, language);
      if (typeof translated === "string" || Array.isArray(translated) || object(translated)) return translated;
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

  /** @param {unknown} value @param {number} depth */
  function inline(value, depth) {
    if (Array.isArray(value)) each(value, depth, inline);
    else node(value, depth, true);
  }

  /** @param {JsonObject} payload @param {number} depth @returns {boolean} */
  function textSlots(payload, depth) {
    for (const key of ["i18nElements", "i18nContent"]) {
      const mapping = read(payload, key);
      if (mapping === undefined) continue;
      const selected = locale(mapping);
      if (selected === null) continue;
      inline(selected, depth + 1);
      return true;
    }
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
    const start = output.length;
    // Presentation slots are separate blocks; fragments within an inline slot
    // remain adjacent. An empty slot must not split surrounding inline text.
    /** @param {string} key @param {(value: unknown, childDepth: number) => void} visit */
    function slot(key, visit) {
      const value = read(payload, key);
      if (value === undefined) return;
      const before = output.length;
      const emissions = contentEmissions;
      if (output.length > start) lineBreak();
      recognized = true;
      visit(value, depth + 1);
      // Hidden actions/empty lists contribute no separator. Explicit br nodes
      // are content emissions, so intentional line breaks remain unchanged.
      if (contentEmissions === emissions) output = output.slice(0, before);
    }
    slot("text", inline);
    slot("fields", (value, childDepth) => each(value, childDepth, block));
    slot("elements", (value, childDepth) => each(value, childDepth, columns ? block : inline));
    slot("actions", (value, childDepth) => each(value, childDepth, block));
    slot("columns", (value, childDepth) => each(value, childDepth, block));
    slot("extra", block);
    if (!recognized) mark("unsupported_card_structure");
  }

  /** Native Markdown lists contain typed items, whose elements remain inline.
   * Do not treat unknown item kinds or arbitrary children as presentation slots.
   * @param {JsonObject} payload @param {number} depth */
  function list(payload, depth) {
    each(read(payload, "items"), depth + 1, (value, itemDepth) => enter(value, itemDepth, () => {
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
      try { inline(elements, itemDepth + 1); }
      finally { currentListItem = parent; }
      // A deferred marker can itself reach the output limit before body text.
      // Preserve that limit notice instead of treating the item as hidden.
      if (contentEmissions === emissions && !stopped) output = output.slice(0, before);
      else lineBreak();
    }));
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

  /** @param {unknown} value @param {number} depth @param {boolean} inLine */
  function node(value, depth, inLine) {
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
      const tag = read(value, "tag") ?? read(value, "type") ?? read(payload, "tag") ?? read(payload, "type") ?? "";
      if (tag === "at") {
        emit(mention(nodeMention(payload)));
      } else if (tag === "at_all") {
        emit("@所有人");
      } else if (TEXT_TAGS.has(tag)) {
        if (!textSlots(payload, depth)) mark("unsupported_card_structure");
      } else if (tag === "list") {
        list(payload, depth);
      } else if (tag === "button" || tag === "a" || tag === "link") {
        const navigation = navigationLinks(payload, depth, tag === "button");
        if (tag === "button" && navigation.usable === 0) { omittedActions += 1; return; }
        if (!inLine) lineBreak();
        const label = textSlots(payload, depth);
        emitLinks(navigation, label);
      } else if (CONTAINER_TAGS.has(tag)) {
        lineBreak();
        container(payload, depth, tag === "column" || tag === "column_set");
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
          container(payload, depth);
        } else if (["url", "href", "multi_url"].some((key) => read(payload, key) !== undefined)) {
          emitLinks(navigationLinks(payload, depth), textSlots(payload, depth));
        } else if (!textSlots(payload, depth)) mark("unsupported_card_structure");
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
    const wrappers = new WeakSet();
    while (!stopped && object(card) && read(card, "json_card") !== undefined) {
      if (wrappers.has(card)) { mark("card_cycle"); card = null; break; }
      if (wrapperDepth >= MAX_DEPTH) { mark("card_depth_limit"); card = null; break; }
      wrappers.add(card);
      const wrapper = card;
      enter(wrapper, wrapperDepth, () => { attachment(read(wrapper, "json_attachment"), wrapperDepth + 1); });
      wrapperDepth += 1;
      card = parse(read(wrapper, "json_card"));
    }
    if (!object(card)) mark("invalid_card_json");
    else enter(card, wrapperDepth, () => {
      attachment(read(card, "json_attachment"), wrapperDepth + 1);
      const header = read(card, "header");
      if (header !== undefined) {
        const headerPayload = read(header, "property") ?? header;
        const title = read(headerPayload, "title");
        if (title !== undefined) block(title, wrapperDepth + 1);
        else mark("unsupported_card_structure");
        const subtitle = read(headerPayload, "subtitle");
        if (subtitle !== undefined) block(subtitle, wrapperDepth + 1);
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
  // Preserve only generated indentation on an initial list; ordinary source
  // whitespace keeps the established trim behavior.
  output = `${"  ".repeat(leadingListLevel)}${output.trim()}`;
  const omissions = omittedActions > 0 ? { omitted_actions: omittedActions } : {};
  if (!output && reasons.size === 0 && omittedActions > 0) {
    return { text: "[卡片仅含交互操作，文本视图已收起]", status: "rendered", reason: null, version: 3, ...omissions };
  }
  if (!output && reasons.size === 0) mark("card_no_visible_content");
  const reason = /** @type {Reason | undefined} */ (Object.keys(EXPLANATIONS).find((key) =>
    key !== "unresolved_card_mention" && reasons.has(/** @type {Reason} */ (key))))
    || (reasons.has("unresolved_card_mention") ? "unresolved_card_mention" : undefined);
  if (!reason) return { text: output, status: "rendered", reason: null, version: 3, ...omissions };
  if (reason === "unresolved_card_mention" && reasons.size === 1) {
    return { text: output, status: "partial", reason, version: 3, ...omissions };
  }
  const status = output ? "partial" : "structured_fallback";
  // Human message reading can omit a result-level partial notice without
  // stripping matching source text or weakening local missing-value markers.
  // Default projections (including stored and JSON content) stay unchanged.
  if (output && options.includePartialNotice === false) {
    return { text: output, status, reason, version: 3, ...omissions };
  }
  const marker = `[卡片${output ? "部分内容未展开" : "未展开"}：${EXPLANATIONS[reason]}]`;
  return { text: `${output.slice(0, Math.max(0, MAX_OUTPUT_CHARS - marker.length - 1))}${output ? "\n" : ""}${marker}`,
    status, reason, version: 3, ...omissions };
}

export { renderCardContent };
