import assert from "node:assert/strict";
import test from "node:test";
import { renderCardContent } from "../src/adapters/lark-im/card-content.mjs";

// Invented astronomy/archive fixtures only; no captured or redacted messages.
const text = (content) => ({ tag: "plain_text", property: { content } });
const link = (content, url = "https://example.invalid/exhibits/atlas") => ({ tag: "link", property: { content, url } });
const item = (type, order, elements, level = 0) => ({ type, level, ...(order === undefined ? {} : { order }), elements });
const list = (...items) => ({ tag: "list", property: { items } });
const card = (...elements) => ({ elements });
const compact = { includePartialNotice: false, includeDecorativeSeparators: false };

function complete(input, expected) {
  const before = JSON.stringify(input);
  const result = renderCardContent(input);
  assert.deepEqual(result, { text: expected, status: "rendered", reason: null, version: 3 });
  assert.equal(JSON.stringify(input), before);
}

test("localized native ordered items retain explicit numbering and consecutive link/date prose", () => {
  complete(card({ tag: "markdown", property: { i18nElements: {
    zh_cn: list(item("ol", 4, [link("纸星图展"), text(" 将于 2064-04-18 开幕。")]),
      item("ol", 9, [text("星盘归档截止日：2064-05-02。")])) ,
    en_us: [text("HIDDEN_UNSELECTED_LANGUAGE")],
  } } }), "4. 纸星图展 （链接：https://example.invalid/exhibits/atlas） 将于 2064-04-18 开幕。\n9. 星盘归档截止日：2064-05-02。");
});

test("unordered and flat-level list entries keep their original source order", () => {
  complete(card(list(item("ul", undefined, [text("Invented observatory")]),
    item("ul", undefined, [text("Paper telescope")], 1), item("ol", 7, [text("Archive drawer")], 2),
    item("ul", undefined, [text("Closing exhibit")]))),
  "- Invented observatory\n  - Paper telescope\n    7. Archive drawer\n- Closing exhibit");
});

test("missing ordered index is explicit and partial while keeping readable item text", () => {
  const result = renderCardContent(card(list(item("ol", undefined, [text("Synthetic index absent")]))), [], compact);
  assert.deepEqual(result, { text: "[序号未知] Synthetic index absent", status: "partial", reason: "unsupported_card_structure", version: 3 });
});

test("nested lists add their own depth and preserve a parent's trailing text", () => {
  complete(card(list(item("ol", 2, [text("Outer gallery"),
    list(item("ul", undefined, [text("Nested orbit")]), item("ol", 8, [text("Nested drawer")], 1)),
    text("Outer closing note")]))),
  "2. Outer gallery\n  - Nested orbit\n    8. Nested drawer\nOuter closing note");
});

test("a parent containing only a nested list retains its own explicit index", () => {
  complete(card(list(item("ol", 6, [list(item("ul", undefined, [text("Inner sky map")]))]))),
    "6.\n  - Inner sky map");
});

test("inline and sibling lists keep block boundaries without changing internal link spacing", () => {
  complete(card({ tag: "markdown", elements: [text("Opening caption"),
    list(item("ol", 5, [text("Read "), link("archive label"), text(" before 2065-01-12.")])),
    text("Middle caption"), list(item("ul", undefined, [text("Closing entry")])), text("Closing caption")] }),
  "Opening caption\n5. Read archive label （链接：https://example.invalid/exhibits/atlas） before 2065-01-12.\nMiddle caption\n- Closing entry\nClosing caption");
});

test("explicit br within an item remains a line boundary before following list items", () => {
  const result = renderCardContent(card(list(item("ol", 1, [text("First line"), { tag: "br" }, text("Second line")]),
    item("ol", 2, [text("Next entry")]))));
  assert.equal(result.status, "rendered");
  assert.match(result.text, /^1\. First line\n\s*Second line\n2\. Next entry$/);
});

test("lists outside and inside a column retain preceding and following content", () => {
  complete(card(text("Archive opens"), { tag: "column", property: { elements: [
    list(item("ul", undefined, [text("Synthetic star atlas")])), text("Drawer note"),
  ] } }, text("Archive closes")), "Archive opens\n- Synthetic star atlas\nDrawer note\nArchive closes");
});

test("locale fallback renders only one complete list including its suffix dates", () => {
  complete(card({ tag: "markdown", property: { i18nElements: {
    en_us: [list(item("ol", 12, [link("Invented lens collection"), text(" due 2066-09-21.")]))],
    ja_jp: [text("HIDDEN_UNUSED_LANGUAGE")],
  }, elements: [text("HIDDEN_DEFAULT_LIST")] } }),
  "12. Invented lens collection （链接：https://example.invalid/exhibits/atlas） due 2066-09-21.");
});

test("an explicitly empty preferred locale does not borrow a list from another locale", () => {
  complete(card(text("Anchor"), { tag: "markdown", property: { i18nElements: {
    zh_cn: [], en_us: [list(item("ol", 1, [text("HIDDEN_OTHER_LOCALE")]))],
  }, elements: [list(item("ol", 2, [text("HIDDEN_DEFAULT")]))] } }), "Anchor");
});

test("malformed preferred locale keeps diagnostics while a valid fallback list remains readable", () => {
  const result = renderCardContent(card({ tag: "markdown", property: { i18nElements: {
    zh_cn: false, en_us: [list(item("ul", undefined, [text("Fallback catalogue")]))],
  } } }), [], compact);
  assert.deepEqual(result, { text: "- Fallback catalogue", status: "partial", reason: "unsupported_card_structure", version: 3 });
});

for (const order of [0, -1, 1.5, "2", null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid ordered index ${String(order)} never renumbers or drops its item prose`, () => {
    const result = renderCardContent(card(list(item("ol", order, [text("Readable invented index entry")]),
      item("ol", 15, [text("Following explicit index")]))), [], compact);
    assert.deepEqual(result, { text: "[序号未知] Readable invented index entry\n15. Following explicit index",
      status: "partial", reason: "unsupported_card_structure", version: 3 });
  });
}

for (const level of [-1, 0.5, "1", null, Infinity, 25, Number.MAX_SAFE_INTEGER]) {
  test(`invalid level ${String(level)} returns to current layer with an explicit diagnostic`, () => {
    const result = renderCardContent(card(list(item("ol", 3, [text("Readable invented layer entry")], level))), [], compact);
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "unsupported_card_structure");
    assert.match(result.text, /\[层级未知\]/);
    assert.match(result.text, /3\. Readable invented layer entry/);
    assert.equal(result.text.startsWith("  "), false);
    assert.ok(result.text.length < 120);
  });
}

test("missing level defaults to zero; unordered metadata never implies a numeric marker", () => {
  complete(card(list({ type: "ol", order: 18, elements: [text("Default level archive")] },
    { type: "ul", order: "not-an-order", elements: [text("Unordered caption")] })),
  "18. Default level archive\n- Unordered caption");
});

test("largest valid index and level are preserved without allocating unbounded indentation", () => {
  complete(card(text("Anchor"), list(item("ol", Number.MAX_SAFE_INTEGER, [text("Boundary exhibit")], 24))),
    `Anchor\n${"  ".repeat(24)}${Number.MAX_SAFE_INTEGER}. Boundary exhibit`);
});

test("a first visible list item retains only its generated indentation", () => {
  complete(card(list(item("ol", 5, [text("Standalone nested-level exhibit")], 2))),
    "    5. Standalone nested-level exhibit");
  complete(card(text("  Ordinary source whitespace  ")), "Ordinary source whitespace");
});

test("inherited order is unknown and inherited level does not determine indentation", () => {
  const inherited = Object.assign(Object.create({ order: 71, level: 19 }), {
    type: "ol", elements: [text("Own body only")],
  });
  const result = renderCardContent(card(text("Anchor"), list(inherited)), [], compact);
  assert.deepEqual(result, { text: "Anchor\n[序号未知] Own body only", status: "partial", reason: "unsupported_card_structure", version: 3 });
});

test("nested level overflow keeps readable text with the unknown-layer marker", () => {
  const result = renderCardContent(card(list(item("ol", 1, [text("Outer"),
    list(item("ul", undefined, [text("Readable overflow child")], 24))], 1))), [], compact);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "unsupported_card_structure");
  assert.match(result.text, /\[层级未知\]/);
  assert.match(result.text, /Readable overflow child/);
  assert.ok(result.text.length < 150);
});

test("native links in a list preserve labels and adjacent dates while sanitizing sensitive URL components", () => {
  const result = renderCardContent(card(list(item("ol", 2, [
    link("Invented telescope catalogue", "https://reader:SYNTHETIC_PASSWORD@example.invalid/catalogue?access=SYNTHETIC_QUERY#SYNTHETIC_FRAGMENT"),
    text(" — opens 2067-02-03 and closes 2067-02-17."),
  ]))));
  assert.deepEqual(result, { text: "2. Invented telescope catalogue （链接：https://example.invalid/catalogue [链接敏感部分已省略]） — opens 2067-02-03 and closes 2067-02-17.",
    status: "rendered", reason: null, version: 3 });
  assert.doesNotMatch(result.text, /SYNTHETIC_PASSWORD|SYNTHETIC_QUERY|SYNTHETIC_FRAGMENT|reader:/);
});

test("unsupported link diagnostics survive beside readable ordered-list text", () => {
  const result = renderCardContent(card(list(item("ol", 1, [link("Safe label", "javascript:SYNTHETIC_HIDDEN_CODE"), text(" remains visible")]))), [], compact);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "unsupported_card_link");
  assert.match(result.text, /^1\. Safe label .* remains visible$/);
  assert.doesNotMatch(result.text, /javascript|SYNTHETIC_HIDDEN_CODE/);
});

test("empty and pure-action items create neither markers nor blank lines; navigation remains visible", () => {
  const action = { tag: "button", property: { content: "HIDDEN_ACTION_LABEL", value: "HIDDEN_ACTION_VALUE",
    actions: [{ type: "request", action: { callback: "HIDDEN_CALLBACK" } }] } };
  const navigation = { tag: "button", property: { content: "Browse archive", url: "https://example.invalid/browse" } };
  const result = renderCardContent(card(text("Before"), list(item("ol", 2, []), item("ol", 4, [action]),
    item("ol", 8, [navigation, text(" by 2068-06-11.")])), text("After")), [], compact);
  assert.deepEqual(result, { text: "Before\n8. Browse archive （链接：https://example.invalid/browse） by 2068-06-11.\nAfter",
    status: "rendered", reason: null, version: 3, omitted_actions: 1 });
  assert.doesNotMatch(result.text, /HIDDEN|2\.|4\.|\n\n/);
});

test("unknown item types are not traversed even when their payload has familiar presentation keys", () => {
  let reads = 0;
  const unknown = { type: "invented_archive_event" };
  for (const key of ["elements", "children", "content", "value", "callback", "items", "order", "level"]) {
    Object.defineProperty(unknown, key, { get() { reads += 1; throw new Error("HIDDEN_SYNTHETIC_UNKNOWN_PAYLOAD"); } });
  }
  const result = renderCardContent(card(list(unknown, item("ol", 5, [text("Visible next entry")]))), [], compact);
  assert.deepEqual(result, { text: "5. Visible next entry", status: "partial", reason: "unsupported_card_structure", version: 3 });
  assert.equal(reads, 0);
});

test("known items ignore unrelated callbacks, values and arbitrary children", () => {
  let reads = 0;
  const known = item("ul", undefined, [text("Visible documented element")]);
  for (const key of ["children", "value", "callback", "config", "actions"]) {
    Object.defineProperty(known, key, { get() { reads += 1; throw new Error("HIDDEN_UNRELATED_PAYLOAD"); } });
  }
  assert.deepEqual(renderCardContent(card(list(known))), { text: "- Visible documented element", status: "rendered", reason: null, version: 3 });
  assert.equal(reads, 0);
});

test("unordered items do not read an order accessor", () => {
  let calls = 0;
  const known = item("ul", undefined, [text("Unordered exhibit")]);
  Object.defineProperty(known, "order", { get() { calls += 1; throw new Error("HIDDEN_ORDER_GETTER"); } });
  assert.deepEqual(renderCardContent(card(list(known))), { text: "- Unordered exhibit", status: "rendered", reason: null, version: 3 });
  assert.equal(calls, 0);
});

for (const slot of ["type", "order", "level", "elements"]) {
  test(`list-item ${slot} accessors are never evaluated`, () => {
    let calls = 0;
    const guarded = item("ol", 2, [text("Guarded body")]);
    Object.defineProperty(guarded, slot, { get() { calls += 1; throw new Error("HIDDEN_ITEM_GETTER"); } });
    const result = renderCardContent(card(text("Before"), list(guarded), text("After")), [], compact);
    assert.equal(calls, 0);
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "unsupported_card_structure");
    assert.match(result.text, /^Before\n/);
    assert.match(result.text, /\nAfter$/);
    assert.doesNotMatch(result.text, /HIDDEN_ITEM_GETTER/);
  });
}

test("items and array-slot accessors are not evaluated or borrowed from prototypes", () => {
  let calls = 0;
  const property = {};
  Object.defineProperty(property, "items", { get() { calls += 1; throw new Error("HIDDEN_ITEMS_GETTER"); } });
  const items = [item("ol", 1, [text("HIDDEN_ARRAY_ITEM")]), item("ol", 2, [text("Visible item")])];
  Object.defineProperty(items, "0", { get() { calls += 1; throw new Error("HIDDEN_INDEX_GETTER"); } });
  const inheritedItem = Object.create(item("ol", 99, [text("HIDDEN_INHERITED_ITEM")]));
  const inheritedProperty = Object.create({ items: [item("ol", 98, [text("HIDDEN_INHERITED_ITEMS")])] });
  const result = renderCardContent(card(text("Anchor"), { tag: "list", property }, { tag: "list", property: { items } },
    list(inheritedItem), { tag: "list", property: inheritedProperty }), [], compact);
  assert.equal(calls, 0);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "unsupported_card_structure");
  assert.match(result.text, /2\. Visible item/);
  assert.doesNotMatch(result.text, /HIDDEN|99\.|98\./);
});

test("a list item without documented elements does not mine arbitrary children for body text", () => {
  const result = renderCardContent(card(text("Anchor"), list({ type: "ol", order: 1,
    children: [text("HIDDEN_CHILDREN")], value: { elements: [text("HIDDEN_VALUE")] } })), [], compact);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "unsupported_card_structure");
  assert.equal(result.text, "Anchor");
});

for (const malformed of [null, "synthetic item", 7, [], { type: "ol", order: 1, elements: {} }]) {
  test(`malformed list item ${JSON.stringify(malformed)} leaves the following valid item readable`, () => {
    const result = renderCardContent(card(list(malformed, item("ul", undefined, [text("Valid next item")]))), [], compact);
    assert.deepEqual(result, { text: "- Valid next item", status: "partial", reason: "unsupported_card_structure", version: 3 });
  });
}

test("cyclic list presentation stops only the cycle and keeps readable siblings", () => {
  const cyclic = list(item("ol", 1, [text("Readable loop prefix")]));
  cyclic.property.items[0].elements.push(cyclic);
  const result = renderCardContent(card(text("Before"), cyclic, text("After")), [], compact);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "card_cycle");
  assert.match(result.text, /Readable loop prefix/);
  assert.match(result.text, /\[此处为循环结构，已停止展开\]/);
  assert.match(result.text, /After$/);
  assert.ok(result.text.length < 250);
});

test("a cyclic first elements array emits its list index before the local resource notice", () => {
  const elements = [];
  elements.push(elements, text("Tail"));
  const result = renderCardContent(card(list(item("ol", 3, elements))), [], compact);
  assert.deepEqual(result, { text: "3. [此处为循环结构，已停止展开]Tail", status: "partial", reason: "card_cycle", version: 3 });
});

test("an overdeep first elements array emits its list index before the local resource notice", () => {
  let deep = text("HIDDEN_DEPTH_LEAF");
  for (let depth = 0; depth < 30; depth += 1) deep = [deep];
  const result = renderCardContent(card(list(item("ol", 3, [deep, text("Tail")]))), [], compact);
  assert.deepEqual(result, { text: "3. [此处嵌套超过解析深度上限]Tail", status: "partial", reason: "card_depth_limit", version: 3 });
});

test("nested list recursion shares the depth cap and preserves shallow readable siblings", () => {
  let deep = text("HIDDEN_BEYOND_DEPTH");
  for (let index = 0; index < 30; index += 1) deep = list(item("ol", 1, [deep]));
  const result = renderCardContent(card(text("Before"), deep, text("After")), [], compact);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "card_depth_limit");
  assert.match(result.text, /Before/);
  assert.match(result.text, /After$/);
  assert.doesNotMatch(result.text, /HIDDEN_BEYOND_DEPTH/);
  assert.ok(result.text.length <= 16_000);
});

test("list items consume the shared node budget and never inspect later items", () => {
  let laterReads = 0;
  const later = new Proxy(item("ol", 8000, [text("HIDDEN_AFTER_NODE_CAP")]), {
    getOwnPropertyDescriptor(target, key) { laterReads += 1; return Object.getOwnPropertyDescriptor(target, key); },
  });
  const result = renderCardContent(card(list(...Array.from({ length: 3000 }, (_, index) => item("ol", index + 1, [text("x")])), later)), [], compact);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "card_node_limit");
  assert.match(result.text, /^1\. x\n2\. x/);
  assert.equal(laterReads, 0);
  assert.ok(result.text.length <= 16_000);
  assert.doesNotMatch(result.text, /HIDDEN_AFTER_NODE_CAP/);
});

test("list prefixes and body text remain inside the shared output budget", () => {
  const result = renderCardContent(card(list(item("ol", 1, [text("x".repeat(16_100))]),
    item("ol", 2, [text("HIDDEN_AFTER_OUTPUT_CAP")]))), [], compact);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "card_output_limit");
  assert.equal(result.text.length, 16_000);
  assert.ok(result.text.startsWith("1. "));
  assert.ok(result.text.endsWith("[正文在此达到展示上限]"));
  assert.doesNotMatch(result.text, /HIDDEN_AFTER_OUTPUT_CAP/);
});

test("an item prefix reaching the output cap is not rolled back as an empty container", () => {
  const result = renderCardContent(card(text("x".repeat(15_997)), { tag: "column", elements: [
    list(item("ol", 23, [text("HIDDEN_BODY_AFTER_PREFIX_CAP")]))] }), [], compact);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "card_output_limit");
  assert.equal(result.text.length, 16_000);
  assert.ok(result.text.endsWith("[正文在此达到展示上限]"));
  assert.doesNotMatch(result.text, /HIDDEN_BODY_AFTER_PREFIX_CAP/);
});

for (const [label, wrap] of [
  ["direct list", (value) => value],
  ["div elements", (value) => ({ tag: "div", elements: [value] })],
  ["div text", (value) => ({ tag: "div", text: value })],
]) {
  test(`an indented prefix output limit keeps its complete marker through ${label}`, () => {
    const result = renderCardContent(card(text("p".repeat(15_952)),
      wrap(list(item("ul", undefined, [text("HIDDEN_BODY_BEYOND_GENERATED_PREFIX")], 24)))), [], compact);
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "card_output_limit");
    assert.equal(result.text.length, 16_000);
    assert.ok(result.text.endsWith("[正文在此达到展示上限]"));
    assert.doesNotMatch(result.text, /HIDDEN_BODY_BEYOND_GENERATED_PREFIX/);
  });
}

test("a multi-digit ordered prefix reaching the cap cannot cut off its local limit notice", () => {
  const result = renderCardContent(card(text("p".repeat(15_996)),
    list(item("ol", 123, [text("HIDDEN_BODY_BEYOND_ORDER_PREFIX")]))), [], compact);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "card_output_limit");
  assert.equal(result.text.length, 16_000);
  assert.ok(result.text.endsWith("[正文在此达到展示上限]"));
  assert.doesNotMatch(result.text, /HIDDEN_BODY_BEYOND_ORDER_PREFIX/);
});

test("input budget accumulates across list items without admitting part of a sensitive URL", () => {
  const hidden = "\u202e".repeat(256 * 1024 - 1024);
  const url = `https://${"SYNTHETIC_SECRET".repeat(200)}@example.invalid/limited`;
  const result = renderCardContent(card(text("Before"), list(item("ol", 1, [text(hidden)]),
    item("ol", 2, [text(url)]))), [], compact);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "card_input_limit");
  assert.match(result.text, /Before/);
  assert.doesNotMatch(result.text, /SYNTHETIC_SECRET|https:/i);
  assert.ok(result.text.length <= 16_000);
});

test("a whole oversized item text is refused by the input budget without leaking a URL userinfo prefix", () => {
  const url = `https://${"SYNTHETIC_SECRET".repeat(20_000)}@example.invalid/archive`;
  const result = renderCardContent(card(text("Before"), list(item("ol", 1, [text(url)]))), [], compact);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "card_input_limit");
  assert.match(result.text, /Before/);
  assert.doesNotMatch(result.text, /SYNTHETIC_SECRET|https:/i);
  assert.ok(result.text.length <= 16_000);
});

test("an oversized serialized list card is rejected before decoding list data", () => {
  const source = JSON.stringify(card(list(item("ol", 1, [text("x".repeat(256 * 1024 + 1))]))));
  const result = renderCardContent(source, [], compact);
  assert.equal(result.reason, "card_input_limit");
  assert.notEqual(result.status, "rendered");
  assert.ok(result.text.length <= 16_000);
});

for (const whitespace of ["   ", "\t", "\n"]) {
  test(`ordinary whitespace-only list item ${JSON.stringify(whitespace)} creates no false marker`, () => {
    for (const type of ["ol", "ul"]) {
      complete(card(text("Before"), list(item(type, 3, [text(whitespace)])), text("After")), "Before\nAfter");
    }
  });
}

test("pending leading whitespace is preserved after the marker when readable body follows", () => {
  complete(card(list(item("ol", 3, [text("  "), text("\t"), text("\n"), text("Visible archive entry")]))),
    "3.    \nVisible archive entry");
});

test("ordinary interior whitespace keeps its source meaning after the marker is active", () => {
  complete(card(list(item("ol", 3, [text("Visible"), text("  "), text("\t"), text("\n"), text("archive entry")]))),
    "3. Visible   \narchive entry");
});

test("whitespace around a hidden action never activates an otherwise empty item", () => {
  const hidden = { tag: "button", property: { content: "HIDDEN_ARCHIVE_ACTION", value: "HIDDEN_REQUEST" } };
  assert.deepEqual(renderCardContent(card(text("Before"), list(item("ol", 3, [text("  "), hidden, text("\n")])),
    text("After")), [], compact), { text: "Before\nAfter", status: "rendered", reason: null, version: 3, omitted_actions: 1 });
});

test("whitespace and unsupported descendants retain their diagnostic without manufacturing an item", () => {
  const result = renderCardContent(card(text("Before"), list(item("ol", 3, [text("  "),
    { tag: "invented_nonpresentation_widget", value: "HIDDEN_UNKNOWN_DATA" }, text("\n")])), text("After")), [], compact);
  assert.deepEqual(result, { text: "Before\nAfter", status: "partial", reason: "unsupported_card_structure", version: 3 });
});

test("a nested whitespace-only child does not consume the parent's pending whitespace before its tail", () => {
  complete(card(list(item("ol", 3, [text("  "), list(item("ul", undefined, [text("\t")])), text("Parent tail")]))),
    "3.   Parent tail");
});

test("nested parent and child leading whitespace stay in place when visible child and tail follow", () => {
  complete(card(list(item("ol", 3, [text("  "), list(item("ul", undefined, [text("  "), text("Child archive")])), text("Parent tail")]))),
    "3.   \n  -   Child archive\nParent tail");
});

test("nested whitespace-only parent and child leave no generated marker or blank line", () => {
  complete(card(text("Before"), list(item("ol", 3, [text("  "), list(item("ul", undefined, [text("\n")])), text("\t")])),
    text("After")), "Before\nAfter");
});

test("explicit br still activates an item and preserves prior ordinary whitespace", () => {
  complete(card(list(item("ol", 3, [text("  "), { tag: "br" }, text("Archive tail")]))), "3.   \nArchive tail");
  complete(card(list(item("ol", 4, [{ tag: "br" }, text("Another tail")]))), "4. \nAnother tail");
});

test("a whitespace-only item can exceed display length without producing an output-limit error", () => {
  complete(card(text("Before"), list(item("ol", 3, [text(" ".repeat(20_000))])), text("After")), "Before\nAfter");
});

test("pending whitespace is bounded and consumes output budget once readable text activates it", () => {
  const result = renderCardContent(card(list(item("ol", 3, [text(" ".repeat(20_000)), text("HIDDEN_BODY_AFTER_PENDING_LIMIT")]))), [], compact);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "card_output_limit");
  assert.equal(result.text.length, 16_000);
  assert.ok(result.text.startsWith("3. "));
  assert.ok(result.text.endsWith("[正文在此达到展示上限]"));
  assert.doesNotMatch(result.text, /HIDDEN_BODY_AFTER_PENDING_LIMIT/);
});

test("pending whitespace remains before a local cycle notice and following visible text", () => {
  const cyclic = [];
  cyclic.push(cyclic);
  const result = renderCardContent(card(list(item("ol", 3, [text("  "), cyclic, text("Tail")]))), [], compact);
  assert.deepEqual(result, { text: "3.   [此处为循环结构，已停止展开]Tail", status: "partial", reason: "card_cycle", version: 3 });
});

test("pending whitespace crossing the output cap keeps the complete resource marker through an ancestor", () => {
  const cyclic = [];
  cyclic.push(cyclic);
  const result = renderCardContent(card({ tag: "div", text: list(item("ol", 3, [
    text(" ".repeat(20_000)), cyclic, text("HIDDEN_TAIL_AFTER_PENDING_RESOURCE_CAP"),
  ])) }), [], compact);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "card_output_limit");
  assert.equal(result.text.length, 16_000);
  assert.ok(result.text.endsWith("[正文在此达到展示上限]"));
  assert.doesNotMatch(result.text, /HIDDEN_TAIL_AFTER_PENDING_RESOURCE_CAP/);
});
