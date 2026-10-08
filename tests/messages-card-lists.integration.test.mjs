import assert from "node:assert/strict";
import test from "node:test";
import { createLegacyCardFixture, snapshot, messages, assertOriginalContract } from "./helpers/card-projection-fixture.mjs";

// All prose, dates, identities and URLs were authored from scratch.
const START = Date.UTC(2064, 3, 6, 9, 20);
const { row, database } = createLegacyCardFixture({ start: START,
  scope: "lark.im.received.chat.invented_archive_lists", chatId: "oc_invented_archive_lists",
  tempPrefix: "exocortex-invented-archive-lists-" });
const text = (content) => ({ tag: "plain_text", property: { content } });
const item = (type, order, elements, level = 0) => ({ type, level, ...(order === undefined ? {} : { order }), elements });
const list = (...items) => ({ tag: "list", property: { items } });

// These two fixtures each contain one source paragraph; remove only display
// continuation indentation and require the complete projected source verbatim.
function singleParagraphBody(human) {
  const body = human.split("  消息\n")[1].replace(/\n$/, "");
  return body.split("\n").map((line) => {
    assert.ok(line.startsWith("    "));
    return line.slice(4);
  }).join("");
}

function seed(t, rows) {
  let fixture;
  let before;
  t.after(() => { if (before) assert.deepEqual(snapshot(fixture), before,
    "read-time list projection preserves DB bytes/schema/all records/hash/version/raw/canonical and directory entries"); });
  fixture = database(t, rows);
  before = snapshot(fixture);
  return fixture;
}

test("historical raw list content reprojects link labels and following dates without rewriting the record", (t) => {
  const original = row("archive_dates", { json_card: JSON.stringify({ elements: [
    { tag: "markdown", property: { i18nElements: {
      zh_cn: list(item("ol", 3, [{ tag: "link", property: { content: "Paper Comet Archive", url: "https://example.invalid/archive/comet" } },
        text(" opens on 2064-04-18; catalog closes 2064-05-02.") ])), en_us: [text("HIDDEN_ENGLISH_COPY")],
    } } },
  ] }) });
  const fixture = seed(t, [original]);
  const first = messages(fixture, "json");
  assert.equal(first.length, 1);
  assertOriginalContract(first[0], original);
  assert.deepEqual(first[0].display.card, { text: "3. Paper Comet Archive （链接：https://example.invalid/archive/comet） opens on 2064-04-18; catalog closes 2064-05-02.",
    status: "rendered", reason: null, version: 3 });
  assert.equal(first[0].raw.content_rendering.version, 1);
  assert.equal(first[0].canonical.content_rendering.version, 1);
  const human = messages(fixture, "text");
  assert.equal(singleParagraphBody(human), first[0].display.card.text);
  assert.doesNotMatch(human, /HIDDEN_ENGLISH_COPY|OLD_STORED_BODY_|LEGACY_DERIVED_CONTENT/);
  assert.deepEqual(messages(fixture, "json"), first);
});

test("message JSON keeps the complete legacy contract while display.card gains an explicit native list", (t) => {
  const original = row("archive_json_contract", { elements: [list(item("ul", undefined, [
    text("Exhibition visitors "), { tag: "at_all" }, text(" can browse the paper atlas on 2064-07-08."),
  ]))] });
  const fixture = seed(t, [original]);
  const [actual] = messages(fixture, "json");
  const { card: projectedCard, ...display } = actual.display;
  assert.deepEqual({ ...actual, display }, {
    id: 1, direction: "received", record_type: "lark.im.message",
    occurred_at: new Date(START).toISOString(), occurred_at_ms: START,
    actor_id: original.raw.sender.id, container_id: original.raw.chat_id, external_id: original.raw.message_id,
    body: original.body, canonical_json: JSON.stringify(original.canonical), raw_json: JSON.stringify(original.raw),
    scope_config_json: JSON.stringify({ chat_id: original.raw.chat_id, chat_type: "group" }),
    canonical: original.canonical, raw: original.raw,
    scope_config: { chat_id: original.raw.chat_id, chat_type: "group" },
    display: { external_id: `${original.raw.message_id.slice(0, 8)}...`, scene: "群聊", sender: "Synthetic Sender",
      sender_type: "user", message_type: "卡片", recipient: null, chat: "Synthetic Cards", body: original.body },
  });
  assert.deepEqual(projectedCard, { text: "- Exhibition visitors @所有人 can browse the paper atlas on 2064-07-08.",
    status: "rendered", reason: null, version: 3 });
  assert.match(messages(fixture, "text"), /- Exhibition visitors @所有人 can browse the paper atlas on 2064-07-08\./);
  assert.deepEqual(messages(fixture, "json"), [actual]);
});

test("unknown list items remain diagnostic while following item prose and unknown-index markers survive", (t) => {
  const original = row("archive_partial", { elements: [text("Archive opening note"), list(
    { type: "invented_side_effect", elements: [text("HIDDEN_UNSUPPORTED_ITEM_BODY")],
      children: [text("HIDDEN_ARBITRARY_CHILD")], callback: "HIDDEN_CALLBACK", value: { content: "HIDDEN_VALUE" } },
    item("ol", undefined, [text("Readable catalogue entry on 2069-08-14.")]),
    item("ol", 11, [text("Following known item.")]),
  ), text("Archive closing note")] });
  const fixture = seed(t, [original]);
  const [actual] = messages(fixture, "json");
  assertOriginalContract(actual, original);
  assert.deepEqual(actual.display.card, {
    text: "Archive opening note\n[序号未知] Readable catalogue entry on 2069-08-14.\n11. Following known item.\nArchive closing note\n[卡片部分内容未展开：部分结构尚未支持]",
    status: "partial", reason: "unsupported_card_structure", version: 3,
  });
  const human = messages(fixture, "text");
  assert.match(human, /\[序号未知\] Readable catalogue entry on 2069-08-14\./);
  assert.match(human, /11\. Following known item\./);
  assert.doesNotMatch(human, /HIDDEN_|卡片部分内容未展开/);
  assert.deepEqual(messages(fixture, "json"), [actual]);
});

test("list projection hides request buttons, keeps navigation and dates, and sanitizes links only in display", (t) => {
  const original = row("archive_links", { elements: [list(
    item("ol", 4, [{ tag: "button", property: { content: "HIDDEN_ACTION_CAPTION",
      actions: [{ type: "request", action: { value: "HIDDEN_ACTION_VALUE" } }] } }]),
    item("ol", 6, [{ tag: "button", property: { content: "Paper Observatory Catalogue",
      url: "https://archive:SYNTHETIC_PASSWORD@example.invalid/catalogue?token=SYNTHETIC_QUERY#SYNTHETIC_FRAGMENT" } },
    text(" is available until 2070-11-12.")]),
  )] });
  const fixture = seed(t, [original]);
  const [actual] = messages(fixture, "json");
  assertOriginalContract(actual, original);
  assert.deepEqual(actual.display.card, { text: "6. Paper Observatory Catalogue （链接：https://example.invalid/catalogue [链接敏感部分已省略]） is available until 2070-11-12.",
    status: "rendered", reason: null, version: 3, omitted_actions: 1 });
  const human = messages(fixture, "text");
  assert.equal(singleParagraphBody(human), actual.display.card.text);
  assert.doesNotMatch(human, /HIDDEN_|SYNTHETIC_PASSWORD|SYNTHETIC_QUERY|SYNTHETIC_FRAGMENT|archive:/);
  assert.deepEqual(messages(fixture, "json"), [actual]);
});

test("historical whitespace-only list items do not manufacture numbered entries in JSON or human display", (t) => {
  const original = row("archive_whitespace", { elements: [text("Exhibit opens"), list(
    item("ol", 3, [text("   ")]), item("ol", 4, [text("\t")]), item("ol", 5, [text("\n")]),
    item("ol", 8, [text("  "), text("Paper sky catalogue on 2071-03-09.")]),
  ), text("Exhibit closes")] });
  const fixture = seed(t, [original]);
  const [actual] = messages(fixture, "json");
  assertOriginalContract(actual, original);
  assert.deepEqual(actual.display.card, { text: "Exhibit opens\n8.   Paper sky catalogue on 2071-03-09.\nExhibit closes",
    status: "rendered", reason: null, version: 3 });
  const human = messages(fixture, "text");
  assert.match(human, /8\.   Paper sky catalogue on 2071-03-09\./);
  assert.doesNotMatch(human, /\n\s*[345]\.\s*(?:\n|$)/);
  assert.deepEqual(messages(fixture, "json"), [actual]);
});
