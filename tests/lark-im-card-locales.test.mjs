import assert from "node:assert/strict";
import test from "node:test";
import { renderCardContent } from "../src/adapters/lark-im/card-content.mjs";

// Invented minimal schema combinations; no captured or sanitized card fixtures.
const text = (content) => ({ tag: "plain_text", content });
const render = (payload) => renderCardContent({ header: { title: text("Synthetic anchor") },
  elements: [{ tag: "markdown", property: payload }] });
function complete(payload, expected) {
  const result = render(payload);
  assert.equal(result.status, "rendered", JSON.stringify(result));
  assert.equal(result.reason, null);
  assert.equal(result.version, 3);
  assert.equal(result.text, `Synthetic anchor${expected ? `\n${expected}` : ""}`);
  return result;
}

for (const slot of ["i18nElements", "i18nContent"]) {
  for (const [kind, empty] of [["plain", () => ({})], ["null prototype", () => Object.create(null)]]) {
    for (const target of ["content", "text", "elements"]) {
      test(`${slot} with empty ${kind} dictionary falls through to ${target}`, () => {
        const value = target === "elements" ? [text("Synthetic default")] : "Synthetic default";
        complete({ [slot]: empty(), [target]: value }, "Synthetic default");
      });
    }
  }

  for (const [name, selected] of [["string", ""], ["array", []], ["object", {}]]) {
    test(`${slot} preserves the explicitly selected empty ${name}`, () => {
      const result = render({ [slot]: { zh_cn: selected, en_us: "HIDDEN_SECOND_LANGUAGE" }, content: "HIDDEN_DEFAULT" });
      assert.equal(result.status, name === "object" ? "partial" : "rendered");
      assert.equal(result.reason, name === "object" ? "unsupported_card_structure" : null);
      assert.doesNotMatch(result.text, /HIDDEN/);
    });
  }

  for (const [name, value] of [["string", ""], ["null", null], ["array", []], ["boolean", false], ["number", 7]]) {
    test(`${slot} with invalid outer ${name} cannot borrow default text`, () => {
      const result = render({ [slot]: value, content: "HIDDEN_DEFAULT" });
      assert.equal(result.status, "partial");
      assert.equal(result.reason, "unsupported_card_structure");
      assert.doesNotMatch(result.text, /HIDDEN/);
    });
  }

  test(`${slot} retains unknown-language evidence without reading its content`, () => {
    let calls = 0;
    const mapping = {};
    Object.defineProperty(mapping, "zz_invented", { enumerable: true,
      get() { calls++; throw new Error("HIDDEN_LANGUAGE_GETTER"); } });
    const result = render({ [slot]: mapping, content: "HIDDEN_DEFAULT" });
    assert.equal(calls, 0);
    assert.equal(result.reason, "unsupported_card_structure");
    assert.doesNotMatch(result.text, /HIDDEN/);
  });

  test(`${slot} keeps an invalid preferred language partial while reading a valid later one`, () => {
    const result = render({ [slot]: { zh_cn: null, en_us: "Synthetic alternative", ja_jp: "HIDDEN_THIRD" }, content: "HIDDEN_DEFAULT" });
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "unsupported_card_structure");
    assert.match(result.text, /Synthetic alternative/);
    assert.doesNotMatch(result.text, /HIDDEN/);
  });
}

test("empty language slots preserve both slot and language priority", () => {
  complete({ i18nElements: {}, i18nContent: { ja_jp: "HIDDEN_THIRD", en_us: "HIDDEN_SECOND", zh_cn: "Synthetic first" },
    content: "HIDDEN_DEFAULT" }, "Synthetic first");
  complete({ i18nElements: { en_us: [text("Synthetic inline")] }, i18nContent: { zh_cn: "HIDDEN_OTHER_SLOT" },
    content: "HIDDEN_DEFAULT" }, "Synthetic inline");
  complete({ i18nElements: {}, i18nContent: {}, content: "Synthetic content", text: "HIDDEN_TEXT", elements: [text("HIDDEN_ELEMENTS")] }, "Synthetic content");
  complete({ i18nElements: {}, i18nContent: {}, text: "Synthetic text", elements: [text("HIDDEN_ELEMENTS")] }, "Synthetic text");
});

test("an empty map without any presentation slot remains unsupported", () => {
  assert.equal(render({ i18nElements: {}, i18nContent: {} }).reason, "unsupported_card_structure");
});

test("explicit empty defaults do not borrow lower slots", () => {
  complete({ i18nElements: {}, i18nContent: {}, content: "", text: "HIDDEN_TEXT", elements: [text("HIDDEN_ELEMENTS")] }, "");
  complete({ i18nContent: {}, elements: [] }, "");
  const result = renderCardContent({ elements: [{ tag: "plain_text", i18nContent: {}, content: "" }] });
  assert.equal(result.reason, "card_no_visible_content");
});

const nonDictionaries = [
  ["inherited language", () => Object.create({ zh_cn: "HIDDEN_INHERITED" })],
  ["custom empty prototype", () => Object.create({})],
  ["date", () => new Date(0)],
  ["map", () => new Map()],
  ["class", () => new (class SyntheticLocale {})()],
  ["non-enumerable unknown key", () => Object.defineProperty({}, "zz_invented", { value: "HIDDEN_NON_ENUMERABLE" })],
  ["symbol key", () => ({ [Symbol("synthetic-locale")]: "HIDDEN_SYMBOL" })],
];
for (const [name, make] of nonDictionaries) {
  test(`${name} is not a verified empty language dictionary`, () => {
    const result = render({ i18nContent: make(), content: "HIDDEN_DEFAULT" });
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "unsupported_card_structure");
    assert.doesNotMatch(result.text, /HIDDEN/);
  });
}

test("locale and slot accessors are never executed and their diagnostics survive", () => {
  let calls = 0;
  const mapping = { en_us: "Synthetic alternative" };
  Object.defineProperty(mapping, "zh_cn", { get() { calls++; return "HIDDEN_GETTER"; } });
  const localeResult = render({ i18nContent: mapping, content: "HIDDEN_DEFAULT" });
  assert.match(localeResult.text, /Synthetic alternative/);
  assert.equal(localeResult.reason, "unsupported_card_structure");
  const payload = { content: "Synthetic default after unreadable slot" };
  Object.defineProperty(payload, "i18nElements", { get() { calls++; return {}; } });
  assert.equal(render(payload).reason, "unsupported_card_structure");
  assert.equal(calls, 0);
});

test("exceptional property inspection cannot turn a damaged mapping into absence", () => {
  for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"]) {
    const mapping = new Proxy({}, { [trap]() { throw new Error("HIDDEN_OBJECT_TRAP"); } });
    const result = render({ i18nContent: mapping, content: "HIDDEN_DEFAULT" });
    assert.equal(result.reason, "unsupported_card_structure");
    assert.doesNotMatch(result.text, /HIDDEN/);
  }
});

test("fallback restores independently composed title, field, inline and navigation slots without changing actions or input", () => {
  const input = { header: { title: { tag: "plain_text", i18nContent: {}, content: "Synthetic orbit" } },
    elements: [{ tag: "column", elements: [{ tag: "div", fields: [{ text: { tag: "markdown", i18nElements: {},
      elements: [text("Synthetic label: "), text("Synthetic value")] } }],
      extra: { tag: "button", text: { tag: "plain_text", i18nContent: {}, content: "Synthetic navigation" }, url: "https://example.invalid/orbit" } }] },
    { tag: "button", text: { tag: "plain_text", i18nContent: {}, content: "HIDDEN_ACTION_LABEL" },
      actions: [{ type: "action_request", action: { value: "HIDDEN_REQUEST_VALUE" } }] }] };
  const before = JSON.stringify(input);
  const result = renderCardContent(input);
  assert.equal(result.status, "rendered");
  assert.equal(result.reason, null);
  assert.equal(result.omitted_actions, 1);
  assert.equal(result.text, "Synthetic orbit\nSynthetic label: Synthetic value\nSynthetic navigation （链接：https://example.invalid/orbit）");
  assert.equal(JSON.stringify(input), before);
  assert.doesNotMatch(result.text, /HIDDEN/);
});

test("restored defaults still report unsupported nodes, links and unresolved mentions", () => {
  for (const [node, reason] of [[{ tag: "invented_unknown" }, "unsupported_card_structure"],
    [{ tag: "link", text: "Synthetic link", url: "file:///invented/private" }, "unsupported_card_link"],
    [{ tag: "at", user_id: "invented_missing_person" }, "unresolved_card_mention"]]) {
    const result = render({ i18nElements: {}, elements: [text("Synthetic prefix"), node] });
    assert.equal(result.status, "partial");
    assert.equal(result.reason, reason);
    assert.match(result.text, /Synthetic prefix/);
  }
});

test("restored defaults share the existing input and output limits", () => {
  for (const [size, reason] of [[256 * 1024 + 1, "card_input_limit"], [20_000, "card_output_limit"]]) {
    const result = render({ i18nContent: {}, content: "x".repeat(size) });
    assert.equal(result.reason, reason);
    assert.ok(result.text.length <= 16_000);
  }
});

test("restored default elements retain node, depth and cycle limits", () => {
  const many = render({ i18nElements: {}, elements: Array.from({ length: 3000 }, () => text("x")) });
  assert.equal(many.reason, "card_node_limit");
  let nested = text("HIDDEN_DEEP");
  for (let i = 0; i < 30; i++) nested = { tag: "column", elements: [nested] };
  const deep = render({ i18nElements: {}, elements: [nested] });
  assert.equal(deep.reason, "card_depth_limit");
  assert.doesNotMatch(deep.text, /HIDDEN_DEEP/);
  const cyclic = { tag: "div", elements: [] };
  cyclic.elements.push(cyclic);
  assert.equal(render({ i18nElements: {}, elements: [cyclic] }).reason, "card_cycle");
});

test("repeated wide unknown-language maps remain opaque and obey the shared node budget", () => {
  let reads = 0;
  const mapping = {};
  for (let i = 0; i < 4096; i++) Object.defineProperty(mapping, `zz_synthetic_${i}`, {
    enumerable: true, get() { reads++; throw new Error("HIDDEN_UNKNOWN_LANGUAGE_VALUE"); },
  });
  const input = { header: { title: text("Synthetic anchor") }, elements: Array.from({ length: 3000 }, () =>
    ({ tag: "plain_text", i18nContent: mapping, content: "HIDDEN_DEFAULT" })) };
  const result = renderCardContent(input);
  assert.equal(result.reason, "card_node_limit");
  assert.equal(reads, 0);
  assert.ok(result.text.length <= 16_000);
  assert.doesNotMatch(result.text, /HIDDEN/);
});
