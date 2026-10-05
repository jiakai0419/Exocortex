import assert from "node:assert/strict";
import test from "node:test";
import { renderCardContent } from "../src/adapters/lark-im/card-content.mjs";

// Every schema combination, identity, name and phrase below is newly invented.
// These fixtures are neither captured nor sanitized from actual messages.
const text = (content) => ({ tag: "plain_text", content });
const all = () => ({ tag: "at_all" });
const card = (...elements) => ({ elements });
const inline = (...elements) => ({ tag: "markdown", elements });
const compact = { includePartialNotice: false, includeDecorativeSeparators: false };

function complete(input, expected, mentions = []) {
  const before = JSON.stringify(input);
  const result = renderCardContent(input, mentions);
  assert.deepEqual(result, { text: expected, status: "rendered", reason: null, version: 3 });
  assert.equal(JSON.stringify(input), before, "projection must leave its source unchanged");
  return result;
}

for (const [label, node] of [
  ["tag", { tag: "at_all" }],
  ["type", { type: "at_all" }],
  ["tag with property", { tag: "at_all", property: {} }],
  ["property tag", { property: { tag: "at_all" } }],
  ["property type", { property: { type: "at_all" } }],
]) {
  test(`explicit ${label} renders in its original inline position`, () => {
    complete(card(inline(text("Orbit audience: "), node, text("; continue the invented notes."))),
      "Orbit audience: @所有人; continue the invented notes.");
  });
}

test("standalone and repeated explicit mentions keep their sibling order and block boundaries", () => {
  complete(card(text("Synthetic opening"), all(), text("Synthetic middle"), all(), text("Synthetic ending")),
    "Synthetic opening\n@所有人\nSynthetic middle\n@所有人\nSynthetic ending");
  complete(card(all()), "@所有人");
});

test("nested property columns and field text retain explicit mention placement", () => {
  const input = card({ tag: "column_set", property: { columns: [{ tag: "column", property: {
    elements: [{ tag: "div", property: {
      fields: [{ text: inline(text("Nested audience "), all(), text(" at the paper observatory")) }],
      elements: [inline(text("Tail "), all(), text(" preserved"))],
    } }],
  } }] } });
  complete(input, "Nested audience @所有人 at the paper observatory\nTail @所有人 preserved");
});

test("json_card wrappers preserve an explicit node without needing attachment identity evidence", () => {
  const input = { json_card: JSON.stringify({ json_card: JSON.stringify(card(
    inline(text("Synthetic wrapped "), all(), text(" notice")))), json_attachment: { at_users: {} } }) };
  complete(input, "Synthetic wrapped @所有人 notice");
});

for (const slot of ["i18nElements", "i18nContent"]) {
  test(`${slot} uses an explicit mention in the selected fallback language only`, () => {
    const node = { tag: "markdown", property: { [slot]: {
      en_us: [text("Invented English audience "), all()],
      ja_jp: [text("HIDDEN_UNSELECTED_LANGUAGE"), all()],
    }, elements: [text("HIDDEN_DEFAULT")] } };
    complete(card(node), "Invented English audience @所有人");
  });

  test(`${slot} verified empty dictionary falls through to explicit mention elements`, () => {
    complete(card({ tag: "markdown", property: { [slot]: {}, elements: [text("Fallback "), all()] } }),
      "Fallback @所有人");
  });

  test(`${slot} malformed preferred language remains diagnostic alongside a usable explicit mention`, () => {
    const result = renderCardContent(card({ tag: "markdown", [slot]: {
      zh_cn: false, en_us: [text("Invented alternative "), all()],
    } }), [], compact);
    assert.deepEqual(result, { text: "Invented alternative @所有人", status: "partial",
      reason: "unsupported_card_structure", version: 3 });
  });

  test(`${slot} explicitly empty selected language cannot borrow an all mention from another language or default`, () => {
    complete(card(text("Synthetic anchor"), { tag: "markdown", [slot]: {
      zh_cn: [], en_us: [all()],
    }, elements: [all()] }), "Synthetic anchor");
  });
}

for (const [label, property] of [["null", null], ["array", []], ["number", 7], ["string", "at_all"]]) {
  test(`at_all with malformed ${label} property retains the structure error and readable siblings`, () => {
    const result = renderCardContent(card(text("Before"), { tag: "at_all", property }, text("After")), [], compact);
    assert.deepEqual(result, { text: "Before\nAfter", status: "partial", reason: "unsupported_card_structure", version: 3 });
  });
}

test("an unreadable property is not executed and its diagnostic survives an explicit tag", () => {
  let calls = 0;
  const node = all();
  Object.defineProperty(node, "property", { get() { calls += 1; throw new Error("SYNTHETIC_GETTER"); } });
  const result = renderCardContent(card(node), [], compact);
  assert.equal(calls, 0);
  assert.deepEqual(result, { text: "@所有人", status: "partial", reason: "unsupported_card_structure", version: 3 });
});

test("explicit mention does not inspect unrelated payload or spoofed identity fields", () => {
  let calls = 0;
  const property = { userID: "unrelated-native-ref", user_id: "unrelated-user", name: "Never choose this name" };
  for (const key of ["content", "elements", "value", "callback", "config"]) {
    Object.defineProperty(property, key, { get() { calls += 1; throw new Error("SYNTHETIC_HIDDEN_VALUE"); } });
  }
  const result = renderCardContent(card({ tag: "at_all", property }), [
    { id: "unrelated-user", id_type: "user_id", name: "Invented individual" },
  ]);
  assert.deepEqual(result, { text: "@所有人", status: "rendered", reason: null, version: 3 });
  assert.equal(calls, 0);
});

test("unknown siblings stay partial while an explicit mention and their other neighbors remain visible", () => {
  const input = card(inline(text("Before "), { tag: "invented_widget", value: "HIDDEN_FIRST_PAYLOAD" },
    all(), text(" after")), { tag: "invented_widget", elements: [all()], value: "HIDDEN_SECOND_PAYLOAD" });
  const ordinary = renderCardContent(input);
  assert.equal(ordinary.status, "partial");
  assert.equal(ordinary.reason, "unsupported_card_structure");
  assert.equal(ordinary.text, "Before @所有人 after\n[卡片部分内容未展开：部分结构尚未支持]");
  assert.doesNotMatch(ordinary.text, /HIDDEN/);
  assert.equal(renderCardContent(input, [], compact).text, "Before @所有人 after");
});

test("an explicit all mention never clears an unresolved individual mention", () => {
  for (const options of [{}, compact]) {
    const result = renderCardContent(card(inline(all(), text("; owner "),
      { tag: "at", property: { user_id: "invented-missing-owner" } }, text("; end"))), [], options);
    assert.deepEqual(result, { text: "@所有人; owner @未知用户; end", status: "partial",
      reason: "unresolved_card_mention", version: 3 });
  }
});

test("combined unknown-structure and unresolved-person evidence survive beside at_all", () => {
  const result = renderCardContent(card(inline(all(), text(" / "), { tag: "at", user_id: "invented-unresolved" },
    { tag: "invented_unknown" }, text(" / tail"))), [], compact);
  assert.deepEqual(result, { text: "@所有人 / @未知用户 / tail", status: "partial",
    reason: "unsupported_card_structure", version: 3 });
});

test("an explicit mention does not hide an unsupported-link diagnostic", () => {
  const input = card(all(), { tag: "link", text: text("Invented destination"), url: "javascript:SYNTHETIC_HIDDEN_TARGET" });
  for (const options of [{}, compact]) {
    const result = renderCardContent(input, [], options);
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "unsupported_card_link");
    assert.match(result.text, /^@所有人\nInvented destination .*\[不支持的链接\]/);
    assert.doesNotMatch(result.text, /javascript:|SYNTHETIC_HIDDEN_TARGET/);
  }
});

test("all strings and typed, native and XML identity values never become an implicit group mention", () => {
  const result = renderCardContent(card(inline(text("all | at_all | "),
    { tag: "at", property: { id: "all", id_type: "open_id" } }, text(" | "),
    { tag: "at", property: { user_id: "all" } }, text(" | "),
    { tag: "at", property: { userID: "all" } }, text(' | <at id="all"></at>'))));
  assert.deepEqual(result, { text: "all | at_all | @未知用户 | @未知用户 | @未知用户 | @未知用户",
    status: "partial", reason: "unresolved_card_mention", version: 3 });
  assert.doesNotMatch(result.text, /@所有人/);
});

test("all identity bytes still resolve only their existing exact namespace and native bridge", () => {
  const names = [
    { key: "@_user_1", id: { open_id: "all" }, name: "Invented Open Person" },
    { key: "@_user_2", id: { user_id: "all" }, name: "Invented User Person" },
  ];
  const input = { json_card: card(
    { tag: "at", property: { open_id: "all" } },
    { tag: "at", property: { user_id: "all" } },
    { tag: "at", property: { userID: "all" } }, text('<at id="all"></at>'), all()),
  json_attachment: { at_users: { all: { mention_key: "@_user_2" } } } };
  const result = renderCardContent(input, names);
  assert.equal(result.text, "@Invented Open Person\n@Invented User Person\n@Invented User Person\n@Invented User Person\n@所有人");
  assert.equal(result.status, "rendered");
  assert.equal(result.reason, null);
});

test("nearby spellings and an inherited tag are not explicit at_all source evidence", () => {
  for (const node of [{ tag: "AT_ALL" }, { tag: "at_all " }, { tag: "at", property: { type: "at_all" } },
    Object.create({ tag: "at_all" })]) {
    const result = renderCardContent(card(text("Synthetic anchor"), node), [], compact);
    assert.equal(result.status, "partial");
    assert.doesNotMatch(result.text, /@所有人/);
  }
});

test("a mention that crosses the output boundary uses the existing output limit", () => {
  for (const options of [{}, compact]) {
    const result = renderCardContent(card(inline(text("x".repeat(15_999)), all(), text("HIDDEN_AFTER_LIMIT"))), [], options);
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "card_output_limit");
    assert.equal(result.text.length, 16_000);
    assert.doesNotMatch(result.text, /@所有人|HIDDEN_AFTER_LIMIT/);
    if (options === compact) assert.ok(result.text.endsWith("[正文在此达到展示上限]"));
  }
});

test("many explicit mentions remain within the shared node budget", () => {
  let laterReads = 0;
  const later = new Proxy(all(), { getOwnPropertyDescriptor(target, key) {
    laterReads += 1;
    return Object.getOwnPropertyDescriptor(target, key);
  } });
  const result = renderCardContent(card(inline(...Array.from({ length: 3_000 }, all), later)), [], compact);
  assert.equal(result.reason, "card_node_limit");
  assert.equal(result.status, "partial");
  assert.ok(result.text.startsWith("@所有人@所有人"));
  assert.ok(result.text.endsWith("[解析在此达到元素数量上限]"));
  assert.ok(result.text.length <= 16_000);
  assert.equal(laterReads, 0);
});

test("an explicit mention beyond the depth limit is not pulled out while a shallow sibling remains readable", () => {
  let deep = all();
  for (let index = 0; index < 30; index += 1) deep = { tag: "column", elements: [deep] };
  const result = renderCardContent(card(text("Before"), deep, text("After")), [], compact);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "card_depth_limit");
  assert.equal(result.text, "Before\n[此处嵌套超过解析深度上限]\nAfter");
  assert.doesNotMatch(result.text, /@所有人/);
});

test("an oversized source remains an input error even after a readable explicit mention", () => {
  const result = renderCardContent(card(all(), text("x".repeat(256 * 1024 + 1))), [], compact);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "card_input_limit");
  assert.equal(result.text, "@所有人\n[此处输入超过解析上限]");
  assert.ok(result.text.length <= 16_000);
});

test("cyclic presentation structure remains diagnostic after an explicit mention", () => {
  const cycle = { tag: "markdown", elements: [] };
  cycle.elements.push(all(), cycle);
  const result = renderCardContent(card(cycle), [], compact);
  assert.deepEqual(result, { text: "@所有人[此处为循环结构，已停止展开]", status: "partial",
    reason: "card_cycle", version: 3 });
});
