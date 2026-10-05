import assert from "node:assert/strict";
import test from "node:test";
import { createLegacyCardFixture, snapshot, messages, assertOriginalContract } from "./helpers/card-projection-fixture.mjs";

// Newly authored fictional clocks, scope, identities and card prose only.
const START = Date.UTC(2049, 5, 11, 9, 14);
const { row, database } = createLegacyCardFixture({ start: START,
  scope: "lark.im.received.chat.invented_all_audience", chatId: "oc_invented_all_audience",
  tempPrefix: "exocortex-invented-all-audience-" });
const text = (content) => ({ tag: "plain_text", content });

function seed(t, rows) {
  let fixture;
  let before;
  // Register before the helper's cleanup: compare physical DB bytes and the
  // complete stored record rows, including hash, version, raw and canonical.
  t.after(() => { if (before) assert.deepEqual(snapshot(fixture), before,
    "historical projection must preserve DB bytes, schema, every row and directory entries"); });
  fixture = database(t, rows);
  before = snapshot(fixture);
  return fixture;
}

function withoutProjectedCard(record) {
  const { card: _card, ...display } = record.display;
  return { ...record, display };
}

test("historical card raw reprojects explicit at_all without rewriting source or stored body", (t) => {
  const original = row("audience_history", { json_card: JSON.stringify({ elements: [
    { tag: "markdown", property: { i18nElements: {}, elements: [
      text("Invented workshop audience: "), { tag: "at_all" }, text("; bring the paper compass."),
    ] } },
  ] }) });
  const fixture = seed(t, [original]);
  const first = messages(fixture, "json");
  assert.equal(first.length, 1);
  assertOriginalContract(first[0], original);
  assert.deepEqual(first[0].display.card, { text: "Invented workshop audience: @所有人; bring the paper compass.",
    status: "rendered", reason: null, version: 3 });
  assert.equal(first[0].raw.content_rendering.version, 1, "historical derived metadata must not be rewritten");
  assert.equal(first[0].canonical.content_rendering.version, 1);
  const human = messages(fixture, "text");
  assert.match(human, /    Invented workshop audience: @所有人; bring the paper compass\./);
  assert.doesNotMatch(human, /OLD_STORED_BODY_|LEGACY_DERIVED_CONTENT|部分内容未展开/);
  assert.deepEqual(messages(fixture, "json"), first, "text reading must leave every JSON value stable");
});

test("message JSON keeps exact legacy fields while only display.card gains explicit all semantics", (t) => {
  const original = row("audience_json_contract", { elements: [
    { tag: "markdown", elements: [text("Synthetic audience "), { tag: "at_all" }, text(" / owner "),
      { tag: "at", property: { user_id: "invented-missing-reader" } }] },
  ] });
  const fixture = seed(t, [original]);
  const [actual] = messages(fixture, "json");
  assertOriginalContract(actual, original);
  const expectedWithoutCard = {
    id: 1, direction: "received", record_type: "lark.im.message",
    occurred_at: new Date(START).toISOString(), occurred_at_ms: START,
    actor_id: original.raw.sender.id, container_id: original.raw.chat_id, external_id: original.raw.message_id,
    body: original.body, canonical_json: JSON.stringify(original.canonical), raw_json: JSON.stringify(original.raw),
    scope_config_json: JSON.stringify({ chat_id: original.raw.chat_id, chat_type: "group" }),
    canonical: original.canonical, raw: original.raw,
    scope_config: { chat_id: original.raw.chat_id, chat_type: "group" },
    display: { external_id: `${original.raw.message_id.slice(0, 8)}...`, scene: "群聊", sender: "Synthetic Sender",
      sender_type: "user", message_type: "卡片", recipient: null, chat: "Synthetic Cards", body: original.body },
  };
  assert.deepEqual(withoutProjectedCard(actual), expectedWithoutCard);
  assert.deepEqual(actual.display.card, { text: "Synthetic audience @所有人 / owner @未知用户",
    status: "partial", reason: "unresolved_card_mention", version: 3 });
  const human = messages(fixture, "text");
  assert.match(human, /Synthetic audience @所有人 \/ owner @未知用户/);
  assert.deepEqual(messages(fixture, "json"), [actual]);
});

test("historical unknown siblings keep machine diagnostics and human source order around explicit mentions", (t) => {
  const original = row("audience_unknown", { elements: [
    text("Synthetic opening"), { tag: "at_all" },
    { tag: "invented_unsupported_tile", value: "HIDDEN_SYNTHETIC_PAYLOAD" }, text("Synthetic closing"),
  ] });
  const fixture = seed(t, [original]);
  const [actual] = messages(fixture, "json");
  assertOriginalContract(actual, original);
  assert.deepEqual(actual.display.card, { text: "Synthetic opening\n@所有人\nSynthetic closing\n[卡片部分内容未展开：部分结构尚未支持]",
    status: "partial", reason: "unsupported_card_structure", version: 3 });
  const human = messages(fixture, "text");
  assert.match(human, /    Synthetic opening\n    @所有人\n    Synthetic closing/);
  assert.doesNotMatch(human, /HIDDEN_SYNTHETIC_PAYLOAD|部分内容未展开/);
  assert.deepEqual(messages(fixture, "json"), [actual]);
});
