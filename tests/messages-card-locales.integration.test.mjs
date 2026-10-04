import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";
import { recordFromMessage } from "../src/adapters/lark-im/message-record.mjs";
import { enrichRow } from "../src/diagnostics/messages-report.mjs";
import { createLegacyCardFixture, snapshot, messages, assertOriginalContract } from "./helpers/card-projection-fixture.mjs";

// Fresh, short examples written for this contract; no captured or redacted cards.
const START = Date.UTC(2047, 6, 12, 9, 4, 0);
const SCOPE = "lark.im.received.chat.invented_locale_garden";
const { row, database } = createLegacyCardFixture({ start: START, scope: SCOPE,
  chatId: "oc_invented_locale_garden", tempPrefix: "exocortex-invented-card-locales-" });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const plain = (content, slots = {}) => ({ tag: "plain_text", ...slots, content });
const request = () => ({ tag: "button", text: plain("Send invented request"), actions: [
  { type: "action_request", action: { operation: "INVENTED_REQUEST_ONLY", url: "https://example.invalid/not-navigation" } },
] });
const cardWithSlots = (slots) => ({
  header: { title: plain("Amber note", slots) },
  elements: [
    { tag: "div", fields: [{ text: plain("Zone: ridge", slots) }] },
    { tag: "div", text: plain("Two tiny sails.", slots) },
    { tag: "button", ...slots, content: "Open map", url: "https://fictional:LOCALE_PASSWORD@example.invalid/map?token=LOCALE_QUERY#LOCALE_FRAGMENT" },
    request(),
  ],
});

function exercise(t, cases) {
  const originals = cases.map(({ name, card, mentions }) => {
    const original = row(name, card);
    original.raw.update_time = String(START + 701);
    if (mentions) original.raw.mentions = mentions;
    return original;
  });
  const fixture = database(t, originals);
  const before = snapshot(fixture);
  const json = messages(fixture, "json");
  const text = messages(fixture, "text");
  assert.equal(json.length, originals.length);
  for (const [index, original] of originals.entries()) {
    const sourceBefore = JSON.stringify(original.raw);
    const historical = json.find((item) => item.external_id === original.raw.message_id);
    assertOriginalContract(historical, original);
    const normalized = normalizeApiMessage(original.raw);
    const current = recordFromMessage(normalized, SCOPE, "received");
    const projected = enrichRow(current).display.card;
    assert.deepEqual(historical.display.card, projected, original.name);
    assert.deepEqual(projected, { text: normalized.content, ...normalized.content_rendering }, original.name);
    assert.equal(current.raw_json, sourceBefore);
    assert.equal(current.content_hash, hash(sourceBefore));
    assert.equal(current.external_version, original.raw.update_time);
    assert.equal(current.body, normalized.content);
    assert.equal(JSON.stringify(original.raw), sourceBefore);
    assert.deepEqual(normalized.raw_api, original.raw);
    assert.equal(JSON.parse(current.canonical_json).content_rendering.version, 3);
    const readableText = cases[index].readableText ?? projected.text;
    for (const line of readableText.split("\n").filter(Boolean)) assert.ok(text.includes(line), `${original.name}: real text CLI lost a readable source line`);
    cases[index].check(projected, text, historical);
  }
  // Includes DB bytes, timestamps/mode, every stored field (hash/version too),
  // schema, all business rows and directory entries. The helper also traps Lark.
  assert.deepEqual(snapshot(fixture), before);
}

for (const [name, slots] of [
  ["missing", {}], ["empty_content", { i18nContent: {} }],
  ["empty_elements", { i18nElements: {} }], ["both_empty", { i18nElements: {}, i18nContent: {} }],
]) {
  test(`historical and new cards recover default title, fields, body and safe navigation when language maps are ${name}`, (t) => {
    exercise(t, [{ name, card: cardWithSlots(slots), check(card, text) {
      assert.equal(card.status, "rendered");
      assert.equal(card.reason, null);
      assert.equal(card.omitted_actions, 1);
      assert.match(card.text, /^Amber note\nZone: ridge\nTwo tiny sails\.\nOpen map/);
      assert.match(card.text, /https:\/\/example\.invalid\/map/);
      for (const output of [card.text, text]) {
        assert.doesNotMatch(output, /LOCALE_PASSWORD|LOCALE_QUERY|LOCALE_FRAGMENT|fictional:|token=|Send invented request|INVENTED_REQUEST_ONLY|not-navigation/);
        assert.doesNotMatch(output, /已同意|已处理|已完成|待审批|部分内容未展开/);
      }
    } }]);
  });
}

test("empty earlier locale maps reveal the next locale slot and preserve supported language precedence", (t) => {
  exercise(t, [
    { name: "locale_chain", card: { elements: [plain("DEFAULT_MUST_STAY_HIDDEN", {
      i18nElements: {}, i18nContent: { zh_cn: "Chosen cedar", en_us: "EN_MUST_STAY_HIDDEN", ja_jp: "JA_MUST_STAY_HIDDEN" },
    })] }, check(card) { assert.equal(card.text, "Chosen cedar"); assert.equal(card.status, "rendered"); } },
    { name: "elements_precedence", card: { elements: [plain("DEFAULT_MUST_STAY_HIDDEN", {
      i18nElements: { en_us: [plain("Chosen pebble")], ja_jp: [plain("JA_MUST_STAY_HIDDEN")] },
      i18nContent: { zh_cn: "LOWER_SLOT_MUST_STAY_HIDDEN" },
    })] }, check(card) { assert.equal(card.text, "Chosen pebble"); assert.equal(card.status, "rendered"); } },
    { name: "object_locale", card: { elements: [plain("DEFAULT_MUST_STAY_HIDDEN", {
      i18nContent: { zh_cn: plain("Chosen willow"), en_us: "EN_MUST_STAY_HIDDEN" },
    })] }, check(card) { assert.equal(card.text, "Chosen willow"); assert.equal(card.status, "rendered"); } },
  ]);
});

test("an explicitly chosen empty string or array does not borrow lower languages or default content", (t) => {
  exercise(t, ["", []].map((empty, index) => ({ name: `chosen_empty_${index}`,
    card: { header: { title: plain("Visible anchor") }, elements: [plain("DEFAULT_MUST_STAY_HIDDEN", {
      i18nElements: { zh_cn: empty, en_us: "LOWER_LANGUAGE_MUST_STAY_HIDDEN" }, i18nContent: { zh_cn: "LOWER_SLOT_MUST_STAY_HIDDEN" },
    })] }, check(card, text) {
      assert.equal(card.text, "Visible anchor");
      assert.equal(card.status, "rendered");
      assert.equal(card.reason, null);
      assert.doesNotMatch(text, /MUST_STAY_HIDDEN/);
    } })));
});

test("malformed outer maps and unknown languages stay partial without hiding their evidence behind fallback", (t) => {
  exercise(t, [null, "", [], { zz_invented: "UNKNOWN_LANGUAGE_MUST_STAY_HIDDEN" }, { zh_cn: {} }].map((value, index) => ({
    name: `malformed_${index}`, card: { header: { title: plain("Readable anchor") }, elements: [plain("DEFAULT_MUST_STAY_HIDDEN", { i18nContent: value })] },
    readableText: "Readable anchor",
    check(card, text) {
      assert.equal(card.status, "partial");
      assert.equal(card.reason, "unsupported_card_structure");
      assert.match(card.text, /^Readable anchor\n/);
      assert.match(card.text, /部分内容未展开/);
      assert.doesNotMatch(text, /MUST_STAY_HIDDEN|部分内容未展开/);
    },
  })));
});

test("a malformed preferred language may expose a valid alternative but remains partial", (t) => {
  exercise(t, [{ name: "invalid_then_readable", card: { elements: [plain("DEFAULT_MUST_STAY_HIDDEN", {
    i18nContent: { zh_cn: 42, en_us: "Readable alternative", ja_jp: "LOWER_LANGUAGE_MUST_STAY_HIDDEN" },
  })] }, readableText: "Readable alternative", check(card, text) {
    assert.equal(card.status, "partial");
    assert.equal(card.reason, "unsupported_card_structure");
    assert.match(card.text, /^Readable alternative\n/);
    assert.match(card.text, /部分内容未展开/);
    assert.doesNotMatch(text, /MUST_STAY_HIDDEN|部分内容未展开/);
  } }]);
});

test("a pure action request remains neutrally omitted and its raw payload is untouched", (t) => {
  const action = request();
  action.i18nElements = {};
  action.i18nContent = {};
  exercise(t, [{ name: "request_only", card: { elements: [action] }, check(card, text, historical) {
    assert.equal(card.text, "[卡片仅含交互操作，文本视图已收起]");
    assert.equal(card.status, "rendered");
    assert.equal(card.reason, null);
    assert.equal(card.omitted_actions, 1);
    assert.doesNotMatch(text, /已同意|已处理|已完成|待审批|Send invented request|INVENTED_REQUEST_ONLY|not-navigation/);
    assert.deepEqual(JSON.parse(historical.raw.body.content).elements, [action]);
  } }]);
});

test("nested schema-2 native properties preserve named people, fields, inline and block prose, and safe navigation together", (t) => {
  const nativeText = (content, slots = {}) => ({ type: "text", property: { i18nElements: {}, i18nContent: {}, content, ...slots } });
  const card = { schema: "2.0", header: { property: { title: nativeText("Cedar route sketch") } },
    body: { property: { elements: [
      { type: "div", property: { fields: [
        { text: nativeText("Object: paper sail") }, { text: nativeText("Target: amber shelf") },
      ] } },
      { type: "markdown", property: { i18nElements: {}, i18nContent: {}, elements: [
        nativeText("Guide: "), { type: "at", property: { id: "ou_invented_locale_guide", id_type: "open_id" } },
        nativeText(" carries "), nativeText("the paper sail."), { type: "br" }, nativeText("A second line stays here."),
      ] } },
      { type: "div", property: { text: nativeText("Separate folded-map note.") } },
      nativeText("DEFAULT_NOTE_MUST_STAY_HIDDEN", { i18nContent: { zh_cn: "Chosen route note", en_us: "LOWER_LANGUAGE_MUST_STAY_HIDDEN" } }),
      { type: "link", property: { i18nElements: {}, i18nContent: {}, content: "Read route",
        url: { url: "https://fictional:NATIVE_MAP_PASSWORD@example.invalid/route?token=NATIVE_MAP_QUERY#NATIVE_MAP_FRAGMENT" } } },
    ] } } };
  exercise(t, [{ name: "nested_native_semantics", card: { json_card: JSON.stringify({ json_card: card }) },
    mentions: [{ key: "@_user_3", id: "ou_invented_locale_guide", id_type: "open_id", name: "Elin Vale" }],
    check(projected, text) {
      assert.equal(projected.status, "rendered");
      assert.equal(projected.reason, null);
      assert.equal(projected.omitted_actions || 0, 0);
      assert.match(projected.text, /^Cedar route sketch\nObject: paper sail\nTarget: amber shelf\nGuide: @Elin Vale carries the paper sail\.\nA second line stays here\.\nSeparate folded-map note\.\nChosen route note\nRead route/);
      assert.match(projected.text, /https:\/\/example\.invalid\/route/);
      for (const output of [projected.text, text]) assert.doesNotMatch(output, /NATIVE_MAP_|fictional:|token=|MUST_STAY_HIDDEN|ou_invented_locale_guide|未知用户|部分内容未展开|carries\nthe/);
    },
  }]);
});

test("an explicit source result retains the result, its object and its target without reading action payloads", (t) => {
  const slots = { i18nElements: {}, i18nContent: {} };
  const card = { header: { title: plain("Lumen workshop report", slots) }, elements: [
    { tag: "div", text: plain("Transfer succeeded.", slots) },
    { tag: "div", fields: [{ text: plain("Object: ceramic moon", slots) }, { text: plain("Target: copper drawer", slots) }] },
    request(),
  ] };
  exercise(t, [{ name: "source_explicit_result", card, check(projected, text, historical) {
    assert.equal(projected.status, "rendered");
    assert.equal(projected.reason, null);
    assert.equal(projected.omitted_actions, 1);
    assert.equal(projected.text, "Lumen workshop report\nTransfer succeeded.\nObject: ceramic moon\nTarget: copper drawer");
    assert.match(text, /Transfer succeeded\./);
    assert.match(text, /Object: ceramic moon/);
    assert.match(text, /Target: copper drawer/);
    assert.deepEqual(JSON.parse(historical.raw.body.content), card);
    assert.doesNotMatch(text, /INVENTED_REQUEST_ONLY|not-navigation|Send invented request/);
  } }]);
});

test("an unresolved source description and request button cannot become a completed result", (t) => {
  const slots = { i18nElements: {}, i18nContent: {} };
  const action = { tag: "button", text: plain("Request a slot", slots), actions: [
    { type: "action_request", action: { operation: "INVENTED_REQUEST_TRANSFER", desired_outcome: "INVENTED_SUCCESS_PAYLOAD" } },
  ] };
  const card = { header: { title: plain("Hollow reed dispatch", slots) }, elements: [
    { tag: "div", text: plain("Transfer not started; waiting for a slot.", slots) },
    { tag: "div", fields: [{ text: plain("Object: paper flag", slots) }, { text: plain("Target: violet tray", slots) }] }, action,
  ] };
  exercise(t, [{ name: "source_unresolved_request", card, check(projected, text, historical) {
    assert.equal(projected.status, "rendered");
    assert.equal(projected.reason, null);
    assert.equal(projected.omitted_actions, 1);
    assert.equal(projected.text, "Hollow reed dispatch\nTransfer not started; waiting for a slot.\nObject: paper flag\nTarget: violet tray");
    assert.match(text, /Transfer not started; waiting for a slot\./);
    assert.doesNotMatch(text, /succeeded|completed|finished|已完成|已处理|INVENTED_SUCCESS_PAYLOAD|INVENTED_REQUEST_TRANSFER|Request a slot/i);
    assert.deepEqual(JSON.parse(historical.raw.body.content), card);
  } }]);
});
