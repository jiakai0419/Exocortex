import assert from "node:assert/strict";
import test from "node:test";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";
import { createLegacyCardFixture, snapshot, messages, assertOriginalContract }
  from "./helpers/card-projection-fixture.mjs";

// Freshly invented records represent persisted legacy projections.
const START = Date.parse("2026-02-03T04:05:00Z");
const SCOPE = "lark.im.received.chat.synthetic_cards";
const { row, database } = createLegacyCardFixture({ start: START, scope: SCOPE,
  chatId: "oc_synthetic_cards", tempPrefix: "exocortex-card-display-" });

test("old native card records render title, long multiline body, fields and buttons without rewriting JSON or SQLite", (t) => {
  const paragraphs = Array.from({ length: 7 }, (_item, index) =>
    `Synthetic paragraph ${index + 1}: invented progress detail remains readable past the old compact limit.`);
  const card = { header: { title: { tag: "plain_text", content: "Synthetic release review" } }, elements: [
    { tag: "div", text: { tag: "lark_md", content: paragraphs.join("\n") } },
    { tag: "div", fields: [{ is_short: true, text: { tag: "plain_text", content: "Owner: Synthetic Team" } },
      { is_short: true, text: { tag: "plain_text", content: "Status: Review pending" } }] },
    { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "Open synthetic review" },
      url: "https://example.invalid/synthetic-review" }] },
  ] };
  const original = row("complete", card);
  const fixture = database(t, [original]);
  const before = snapshot(fixture);
  const [json] = messages(fixture, "json");
  assertOriginalContract(json, original);
  assert.equal(json.display.card.version, 3);
  assert.equal(json.display.card.status, "rendered");
  assert.equal(json.display.card.reason, null);
  assert.ok(json.display.card.text.length > 240);
  const normalized = normalizeApiMessage(original.raw);
  assert.equal(normalized.content, json.display.card.text, "new native ingestion and old-record display use the same card projection");
  assert.deepEqual(normalized.content_rendering, { status: "rendered", reason: null, version: 3 });
  assert.deepEqual(normalized.raw_api, original.raw, "projection preserves native source evidence");
  const text = messages(fixture, "text");
  for (const visible of ["Synthetic release review", ...paragraphs, "Owner: Synthetic Team", "Status: Review pending",
    "Open synthetic review", "https://example.invalid/synthetic-review"]) assert.ok(text.includes(visible), visible);
  assert.ok(text.indexOf(paragraphs[0]) < text.indexOf(paragraphs[6]));
  assert.ok(text.slice(text.indexOf(paragraphs[0]), text.indexOf(paragraphs[6])).includes("\n"));
  assert.doesNotMatch(text, /OLD_STORED_BODY|LEGACY_DERIVED_CONTENT|"elements"/);
  assert.deepEqual(snapshot(fixture), before, "reading and projecting old cards must not mutate any stored bytes or schema");
});

test("nested json_card and schema-2 body envelopes remain readable from persisted legacy payloads", (t) => {
  const nested = { json_card: JSON.stringify({ json_card: {
    header: { title: { tag: "plain_text", content: "Nested synthetic title" } },
    elements: [{ tag: "div", text: { tag: "plain_text", content: "Nested synthetic body" } }],
  } }) };
  const legacy = row("legacy_nested", nested);
  delete legacy.raw.body;
  legacy.raw.content = nested;
  legacy.canonical.content = nested;
  const nativeV2 = row("native_v2", { schema: "2.0", header: { title: { tag: "plain_text", content: "Synthetic v2 title" } },
    body: { elements: [{ tag: "markdown", content: "Synthetic v2 body" },
      { tag: "button", text: { tag: "plain_text", content: "Synthetic v2 action" }, url: "https://example.invalid/v2" }] } });
  const propertyCard = row("native_properties", {
    header: { property: { title: { property: { i18nContent: { zh_cn: "Synthetic property title" } } } } },
    body: { elements: [{ property: {
      text: { property: { i18nElements: { zh_cn: [
        { type: "text", property: { content: "Synthetic property body " } },
        { type: "at", property: { userID: "ou_synthetic_property_person" } },
      ] } } },
      fields: [{ property: { text: { property: { content: "Synthetic property field" } } } }],
      actions: [{ property: { text: { property: { content: "Synthetic property button" } } } }],
    } }] },
  });
  propertyCard.raw.raw_api = structuredClone(propertyCard.raw);
  propertyCard.raw.raw_api.mentions = [{ id: { open_id: "ou_synthetic_property_person" }, name: "Synthetic Property Person" }];
  propertyCard.raw.body.content = "WRONG_COMPATIBILITY_BODY";
  const fixture = database(t, [legacy, nativeV2, propertyCard]);
  const before = snapshot(fixture);
  const json = messages(fixture, "json");
  for (const original of [legacy, nativeV2, propertyCard]) {
    const displayed = json.find((record) => record.external_id === original.raw.message_id);
    assertOriginalContract(displayed, original);
    assert.equal(displayed.display.card.status, "rendered");
    assert.equal(displayed.display.card.version, 3);
  }
  const text = messages(fixture, "text");
  for (const visible of ["Nested synthetic title", "Nested synthetic body", "Synthetic v2 title",
    "Synthetic v2 body", "Synthetic v2 action", "Synthetic property title", "Synthetic property body",
    "Synthetic Property Person", "Synthetic property field", "Synthetic property button"]) assert.ok(text.includes(visible), visible);
  assert.doesNotMatch(text, /json_card|OLD_STORED_BODY|LEGACY_DERIVED_CONTENT|WRONG_COMPATIBILITY_BODY/);
  assert.deepEqual(snapshot(fixture), before);
});

test("unknown and invalid card nodes expose explicit incompleteness without dumping raw JSON to terminal", (t) => {
  const partial = row("partial", { header: { title: { tag: "plain_text", content: "Known synthetic title" } }, elements: [
    { tag: "div", text: { tag: "plain_text", content: "Known synthetic paragraph" } },
    { tag: "synthetic_unknown_widget", hidden_internal: "SYNTHETIC_UNKNOWN_RAW_SENTINEL" },
  ] });
  const unknown = row("unknown", { elements: [{ tag: "synthetic_unknown_widget", secret: "SYNTHETIC_ALL_UNKNOWN_SENTINEL" }] });
  const malformed = row("invalid", "{SYNTHETIC_MALFORMED_RAW_SENTINEL");
  const fixture = database(t, [partial, unknown, malformed]);
  const before = snapshot(fixture);
  const json = messages(fixture, "json");
  for (const original of fixture.rows) {
    const displayed = json.find((record) => record.external_id === original.raw.message_id);
    assertOriginalContract(displayed, original);
    assert.equal(displayed.display.card.status, original === partial ? "partial" : "structured_fallback");
    assert.ok(displayed.display.card.reason);
    assert.ok(displayed.display.card.text.trim(), "failed or empty projections need a visible placeholder");
  }
  const text = messages(fixture, "text");
  assert.match(text, /Known synthetic title/);
  assert.match(text, /Known synthetic paragraph/);
  assert.doesNotMatch(text, /SYNTHETIC_UNKNOWN_RAW_SENTINEL|SYNTHETIC_ALL_UNKNOWN_SENTINEL|SYNTHETIC_MALFORMED_RAW_SENTINEL|synthetic_unknown_widget|hidden_internal/);
  assert.doesNotMatch(text, /OLD_STORED_BODY|LEGACY_DERIVED_CONTENT/);
  assert.deepEqual(snapshot(fixture), before);
});

test("card mentions resolve only exact provided evidence and do not guess the sender or key prefixes", (t) => {
  const original = row("mentions", { elements: [
    { tag: "div", text: { tag: "lark_md", content: "Matched @_user_1; unmatched @_user_10" } },
    { tag: "at", user_id: "ou_synthetic_unmatched_person" },
    { tag: "at", user_id: "ou_synthetic_matched_person" },
  ] });
  original.raw.mentions = [{ key: "@_user_1", id: { open_id: "ou_synthetic_matched_person" }, name: "Exact Synthetic Person" }];
  original.canonical.sender_name = "UNRELATED_SENDER_NAME";
  original.raw.sender.name = "UNRELATED_SENDER_NAME";
  const fixture = database(t, [original]);
  const before = snapshot(fixture);
  const [displayed] = messages(fixture, "json");
  assertOriginalContract(displayed, original);
  assert.match(displayed.display.card.text, /Exact Synthetic Person/);
  assert.doesNotMatch(displayed.display.card.text, /Exact Synthetic Person0|UNRELATED_SENDER_NAME/);
  assert.ok(displayed.display.card.text.includes("@_user_10") || /未知|unknown/i.test(displayed.display.card.text));
  const text = messages(fixture, "text");
  assert.match(text, /Exact Synthetic Person/);
  assert.deepEqual(snapshot(fixture), before);
});

test("card display removes terminal controls and unsafe URL secrets while preserving raw stored evidence", (t) => {
  const hostile = "safe\u001b[31m-red\u001b[0m\u001b]52;c;c3ludGhldGlj\u0007\u202E-end\u0000";
  const original = row("controls", { header: { title: { tag: "plain_text", content: hostile } }, elements: [
    { tag: "div", text: { tag: "plain_text", content: `First line\n${hostile}\nLast line` } },
    { tag: "button", text: { tag: "plain_text", content: `Button ${hostile}` },
      url: "https://synthetic_user:SYNTHETIC_PASSWORD@example.invalid/safe-path?token=SYNTHETIC_TOKEN#SYNTHETIC_FRAGMENT" },
  ] });
  const fixture = database(t, [original]);
  const before = snapshot(fixture);
  const [json] = messages(fixture, "json");
  assertOriginalContract(json, original);
  assert.ok(JSON.stringify(json.raw).includes("SYNTHETIC_PASSWORD"));
  const text = messages(fixture, "text");
  assert.match(text, /safe-red-end/);
  assert.match(text, /First line/);
  assert.match(text, /Last line/);
  assert.doesNotMatch(text, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/);
  assert.doesNotMatch(text, /c3ludGhldGlj|SYNTHETIC_PASSWORD|SYNTHETIC_TOKEN|SYNTHETIC_FRAGMENT|synthetic_user/);
  assert.deepEqual(snapshot(fixture), before);
});

test("non-card messages preserve their existing body and display JSON without receiving a card projection", (t) => {
  const original = row("ordinary", { header: { title: { tag: "plain_text", content: "DO_NOT_RENDER_AS_CARD" } } });
  original.raw.msg_type = "text";
  original.canonical.msg_type = "text";
  original.body = "Unchanged synthetic ordinary message";
  const fixture = database(t, [original]);
  const before = snapshot(fixture);
  const [json] = messages(fixture, "json");
  assertOriginalContract(json, original);
  assert.equal(Object.hasOwn(json.display, "card"), false);
  const text = messages(fixture, "text");
  assert.match(text, /Unchanged synthetic ordinary message/);
  assert.doesNotMatch(text, /DO_NOT_RENDER_AS_CARD/);
  assert.deepEqual(snapshot(fixture), before);
});
