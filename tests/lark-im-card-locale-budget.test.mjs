import assert from "node:assert/strict";
import test from "node:test";
import { renderCardContent } from "../src/adapters/lark-im/card-content.mjs";

// Every object, key and label below is invented. Direct references deliberately
// preserve identity: JSON round-tripping would remove the resource counterexample.
const text = (content) => ({ tag: "plain_text", content });
const localized = (mapping, content = "HIDDEN_DEFAULT") => ({ tag: "plain_text", i18nContent: mapping, content });
const card = (elements) => ({ header: { title: text("Synthetic budget anchor") }, elements });
const unknownMap = (width) => Object.fromEntries(Array.from({ length: width }, (_item, index) =>
  [`zz_invented_${index}`, "HIDDEN_UNKNOWN_LANGUAGE"]));

// Synchronous test-local instrumentation; other targets use the original native
// operation. Count returned keys as well as calls, and always restore Reflect.
function countOwnKeys(targets, run, maximumCalls = Infinity) {
  const original = Reflect.ownKeys;
  const watched = new Map(targets.map((target) => [target, { calls: 0, returnedKeys: 0 }]));
  let calls = 0;
  let returnedKeys = 0;
  let aborted = false;
  Reflect.ownKeys = function (target) {
    const counter = watched.get(target);
    if (!counter) return original(target);
    counter.calls += 1;
    calls += 1;
    if (calls > maximumCalls) {
      aborted = true;
      throw new Error("SYNTHETIC_ENUMERATION_SAFETY_STOP");
    }
    const keys = original(target);
    counter.returnedKeys += keys.length;
    returnedKeys += keys.length;
    return keys;
  };
  let result;
  try { result = run(); } finally { Reflect.ownKeys = original; }
  assert.equal(Reflect.ownKeys, original);
  return { result, calls, returnedKeys, aborted, perTarget: [...watched.values()] };
}

function budgetFailure(result) {
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "card_node_limit");
  assert.match(result.text, /^Synthetic budget anchor/);
  assert.doesNotMatch(result.text, /HIDDEN|SYNTHETIC_ENUMERATION_SAFETY_STOP/);
  assert.ok(result.text.length <= 16_000);
}

test("one wide plain locale map shared by 1800 nodes consumes the budget on its first enumeration", (t) => {
  const width = 50_000;
  const references = 1_800;
  const mapping = unknownMap(width);
  assert.equal(Object.getPrototypeOf(mapping), Object.prototype, "the main counterexample is a real plain object, not a Proxy");
  let laterNodeReads = 0;
  let laterMappingEnumerations = 0;
  const laterMapping = new Proxy({}, { ownKeys(target) {
    laterMappingEnumerations += 1;
    return Reflect.ownKeys(target);
  } });
  const laterNode = new Proxy(localized(laterMapping, "HIDDEN_LATER_NODE"), {
    getOwnPropertyDescriptor(target, key) {
      laterNodeReads += 1;
      return Object.getOwnPropertyDescriptor(target, key);
    },
  });
  const input = card([localized(mapping), laterNode,
    ...Array.from({ length: references - 1 }, () => localized(mapping))]);
  // At most four actual wide enumerations on a broken implementation. The fifth
  // attempt is counted and aborted, preserving a deterministic red counter.
  const measured = countOwnKeys([mapping], () => renderCardContent(input), 4);
  t.diagnostic(JSON.stringify({ width, references, calls: measured.calls, returnedKeys: measured.returnedKeys,
    aborted: measured.aborted, laterNodeReads, laterMappingEnumerations }));
  assert.deepEqual({ calls: measured.calls, returnedKeys: measured.returnedKeys, aborted: measured.aborted },
    { calls: 1, returnedKeys: width, aborted: false });
  assert.equal(laterNodeReads, 0, "the next node must not begin inspection after budget exhaustion");
  assert.equal(laterMappingEnumerations, 0, "a later map must not be enumerated after budget exhaustion");
  budgetFailure(measured.result);
});

for (const width of [1, 64]) {
  test(`a shared ${width}-key unknown map is enumerated once without charging its width again on every reference`, () => {
    const mapping = unknownMap(width);
    const input = card([...Array.from({ length: 400 }, () => localized(mapping)), text("Synthetic visible tail")]);
    const measured = countOwnKeys([mapping], () => renderCardContent(input));
    assert.equal(measured.calls, 1);
    assert.equal(measured.returnedKeys, width);
    assert.equal(measured.result.status, "partial");
    assert.equal(measured.result.reason, "unsupported_card_structure", "this bounded shared-map input must not falsely exhaust the budget");
    assert.match(measured.result.text, /Synthetic visible tail/);
    assert.doesNotMatch(measured.result.text, /HIDDEN/);
  });
}

for (const [kind, make] of [["plain", () => ({})], ["null-prototype", () => Object.create(null)]]) {
  test(`shared empty ${kind} maps use constant work per reference while every fallback stays visible`, () => {
    const mapping = make();
    const nodes = Array.from({ length: 200 }, () => ({ tag: "plain_text", i18nElements: mapping,
      i18nContent: mapping, content: "Synthetic fallback" }));
    const measured = countOwnKeys([mapping], () => renderCardContent(card(nodes)));
    assert.ok(measured.calls >= 1 && measured.calls <= nodes.length * 2);
    assert.equal(measured.returnedKeys, 0);
    assert.equal(measured.result.status, "rendered");
    assert.equal(measured.result.reason, null);
    assert.equal(measured.result.text.split("Synthetic fallback").length - 1, nodes.length);
  });
}

test("empty mapping checks also consume the shared work allowance before later nodes", (t) => {
  const mapping = {};
  let laterNodeReads = 0;
  const laterNode = new Proxy(text("HIDDEN_AFTER_EMPTY_CHECKS"), {
    getOwnPropertyDescriptor(target, key) {
      laterNodeReads += 1;
      return Object.getOwnPropertyDescriptor(target, key);
    },
  });
  const nodes = Array.from({ length: 600 }, () => ({ tag: "plain_text", i18nElements: mapping,
    i18nContent: mapping, content: "" }));
  const measured = countOwnKeys([mapping], () => renderCardContent(card([...nodes, laterNode])));
  t.diagnostic(JSON.stringify({ referenceCount: nodes.length * 2, calls: measured.calls,
    returnedKeys: measured.returnedKeys, laterNodeReads }));
  assert.ok(measured.calls > 0 && measured.calls <= 2048);
  assert.equal(measured.returnedKeys, 0);
  assert.equal(laterNodeReads, 0, "empty-map checks must exhaust the same allowance before the trailing node begins");
  budgetFailure(measured.result);
});

test("distinct moderate maps share the same finite node budget and stop before a later node is inspected", (t) => {
  const width = 64;
  const maps = Array.from({ length: 200 }, () => unknownMap(width));
  let laterNodeReads = 0;
  const laterNode = new Proxy(text("HIDDEN_AFTER_DISTINCT_MAPS"), {
    getOwnPropertyDescriptor(target, key) {
      laterNodeReads += 1;
      return Object.getOwnPropertyDescriptor(target, key);
    },
  });
  const measured = countOwnKeys(maps, () => renderCardContent(card([...maps.map((mapping) => localized(mapping)), laterNode])));
  t.diagnostic(JSON.stringify({ mapCount: maps.length, width, calls: measured.calls,
    returnedKeys: measured.returnedKeys, laterNodeReads }));
  assert.ok(measured.returnedKeys > 0);
  // Native ownKeys is indivisible; allow one final mapping to cross the shared
  // 2048-unit boundary, without fixing structural-node overhead or visit count.
  assert.ok(measured.returnedKeys <= 2048 + width, `enumerated ${measured.returnedKeys} keys beyond the bounded allowance`);
  assert.ok(measured.calls < maps.length);
  assert.ok(measured.perTarget.every((counter) => counter.calls <= 1));
  assert.equal(laterNodeReads, 0);
  budgetFailure(measured.result);
});

test("nonempty caching is local to one render and observes mutations between independent renders", () => {
  const mapping = {};
  const input = card(Array.from({ length: 16 }, () => localized(mapping, "Synthetic fallback")));
  const measured = countOwnKeys([mapping], () => {
    const emptyBefore = renderCardContent(input);
    mapping.zz_invented = "HIDDEN_UNKNOWN_LANGUAGE";
    const nonempty = renderCardContent(input);
    delete mapping.zz_invented;
    const emptyAfter = renderCardContent(input);
    return { emptyBefore, nonempty, emptyAfter };
  });
  assert.ok(measured.calls >= 3 && measured.calls <= 33,
    "each empty check is constant, the nonempty map is enumerated once, and each independent render rechecks");
  assert.equal(measured.returnedKeys, 1);
  assert.deepEqual(measured.result.emptyBefore, measured.result.emptyAfter);
  assert.equal(measured.result.emptyBefore.status, "rendered");
  assert.equal(measured.result.emptyBefore.text.split("Synthetic fallback").length - 1, 16);
  assert.equal(measured.result.nonempty.reason, "unsupported_card_structure");
  assert.doesNotMatch(measured.result.nonempty.text, /Synthetic fallback|HIDDEN/);
});

test("a mutable Proxy that was empty cannot borrow a default after becoming unknown within the same render", () => {
  const target = {};
  let localeVisits = 0;
  const mapping = new Proxy(target, {
    getOwnPropertyDescriptor(value, key) {
      if (key === "zh_cn" && ++localeVisits === 2) value.zz_invented = "HIDDEN_UNKNOWN_LANGUAGE";
      return Object.getOwnPropertyDescriptor(value, key);
    },
  });
  const measured = countOwnKeys([mapping], () => renderCardContent(card([
    localized(mapping, "Synthetic first fallback"), localized(mapping, "HIDDEN_SECOND_FALLBACK"),
  ])));
  assert.equal(localeVisits, 2);
  assert.equal(measured.calls, 2, "empty absence must be checked again after the mapping changes");
  assert.equal(measured.returnedKeys, 1);
  assert.equal(measured.result.status, "partial");
  assert.equal(measured.result.reason, "unsupported_card_structure");
  assert.match(measured.result.text, /Synthetic first fallback/);
  assert.doesNotMatch(measured.result.text, /HIDDEN/);
});

test("a selected supported language never enumerates or charges its unvisited wide unknown-language branches", () => {
  const mapping = unknownMap(50_000);
  mapping.zh_cn = "Synthetic selected language";
  let getterCalls = 0;
  Object.defineProperty(mapping, "zz_invented_accessor", { enumerable: true,
    get() { getterCalls += 1; throw new Error("HIDDEN_LANGUAGE_GETTER"); } });
  const measured = countOwnKeys([mapping], () => renderCardContent(card([localized(mapping)])));
  assert.equal(measured.calls, 0);
  assert.equal(measured.returnedKeys, 0);
  assert.equal(getterCalls, 0);
  assert.deepEqual(measured.result, { text: "Synthetic budget anchor\nSynthetic selected language",
    status: "rendered", reason: null, version: 3 });
});

test("unknown language getters remain opaque when their enumerated keys exhaust the budget", () => {
  let getterCalls = 0;
  const mapping = {};
  for (let index = 0; index < 3000; index += 1) Object.defineProperty(mapping, `zz_invented_${index}`, {
    enumerable: true, get() { getterCalls += 1; throw new Error("HIDDEN_UNKNOWN_GETTER"); },
  });
  const measured = countOwnKeys([mapping], () => renderCardContent(card([localized(mapping), text("HIDDEN_AFTER_GETTERS")])));
  assert.equal(measured.calls, 1);
  assert.equal(measured.returnedKeys, 3000);
  assert.equal(getterCalls, 0);
  budgetFailure(measured.result);
});

for (const [kind, selected] of [["string", ""], ["array", []], ["object", {}]]) {
  test(`selected empty ${kind} stays explicit and never borrows the default through the emptiness cache`, () => {
    const mapping = { zh_cn: selected, en_us: "HIDDEN_SECOND_LANGUAGE" };
    const measured = countOwnKeys([mapping], () => renderCardContent(card([localized(mapping)])));
    assert.equal(measured.calls, 0);
    assert.equal(measured.result.status, kind === "object" ? "partial" : "rendered");
    assert.equal(measured.result.reason, kind === "object" ? "unsupported_card_structure" : null);
    assert.match(measured.result.text, /^Synthetic budget anchor/);
    assert.doesNotMatch(measured.result.text, /HIDDEN/);
  });
}

test("supported locale accessors remain unexecuted and keep the valid later language partial", () => {
  let getterCalls = 0;
  const mapping = { en_us: "Synthetic later language" };
  Object.defineProperty(mapping, "zh_cn", { get() { getterCalls += 1; return "HIDDEN_GETTER"; } });
  const measured = countOwnKeys([mapping], () => renderCardContent(card([localized(mapping)])));
  assert.equal(getterCalls, 0);
  assert.equal(measured.calls, 0);
  assert.equal(measured.result.reason, "unsupported_card_structure");
  assert.match(measured.result.text, /Synthetic later language/);
  assert.doesNotMatch(measured.result.text, /HIDDEN/);
});

test("cyclic selected locale content preserves the existing cycle diagnostic without unknown-key enumeration", () => {
  const mapping = {};
  const cyclic = localized(mapping);
  mapping.zh_cn = cyclic;
  const measured = countOwnKeys([mapping], () => renderCardContent(card([cyclic])));
  assert.equal(measured.calls, 0);
  assert.equal(measured.result.status, "partial");
  assert.equal(measured.result.reason, "card_cycle");
  assert.doesNotMatch(measured.result.text, /HIDDEN/);
});
