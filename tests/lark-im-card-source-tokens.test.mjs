import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { renderCardContent } from "../src/adapters/lark-im/card-content.mjs";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";
import { recordFromMessage } from "../src/adapters/lark-im/message-record.mjs";

// Synthetic source tokens only. A mention inside an original URL is URL data;
// a name rendered outside that URL is final text, not new source grammar.
const card = (content) => ({ elements: [{ tag: "lark_md", content }] });
const confidential = /SYNTHETIC_(?:QUERY_TAIL|FRAGMENT_TAIL|PASSWORD|NAME_QUERY|OUTER_QUERY|HIDDEN_TAIL)/i;
const urlCases = [
  { name: "query", value: "https://example.invalid/public?token=@_user_1]SYNTHETIC_QUERY_TAIL" },
  { name: "fragment", value: "https://example.invalid/public#@_user_1]SYNTHETIC_FRAGMENT_TAIL" },
  { name: "userinfo", value: "https://@_user_1:SYNTHETIC_PASSWORD@example.invalid/public" },
];
const names = [
  { kind: "spaces", value: "Synthetic Person" },
  { kind: "Markdown closing syntax", value: "Synthetic ](https://name.invalid/profile?token=SYNTHETIC_NAME_QUERY) Person" },
  { kind: "a separate URL", value: "Synthetic https://name.invalid/profile?token=SYNTHETIC_NAME_QUERY Person" },
  { kind: "another literal mention key", value: "Literal @_user_2 Person" },
  { kind: "ordinary ANSI controls", value: "Synthetic \u001b[31mPerson\u001b[0m" },
  { kind: "a URL changed by OSC controls", value: "https://SYNTHETIC_NAME_QUERY\u009d@name.invalid/profile\u009c" },
];
const carriers = [
  { kind: "bare URL", wrap: (url) => url },
  { kind: "Markdown destination", wrap: (url) => `[Read](${url})` },
  { kind: "Markdown URL label", wrap: (url) => `[${url}](https://destination.invalid/read)` },
];

function mentions(name) {
  return [
    { key: "@_user_1", id: { open_id: "ou_synthetic_source_person" }, name },
    { key: "@_user_2", id: { open_id: "ou_synthetic_other_person" }, name: "DO_NOT_EXPAND_INSERTED_NAME" },
  ];
}

function expectedNameProjection(name) {
  const result = renderCardContent({ elements: [{ tag: "at", property: { userID: "ou_synthetic_source_person" } }] }, mentions(name));
  assert.doesNotMatch(result.text, /未知用户/);
  // A card-level diagnostic is appended by the caller, not part of the name.
  const projected = result.text.split("\n[卡片")[0];
  assert.ok(projected.length > 0);
  if (name === "Synthetic Person" || name === "Synthetic \u001b[31mPerson\u001b[0m")
    assert.equal(projected, "@Synthetic Person");
  if (name === "Literal @_user_2 Person") assert.equal(projected, "@Literal @_user_2 Person");
  return projected;
}

function assertSafe(result) {
  assert.equal(result.version, 2);
  assert.ok(["rendered", "partial"].includes(result.status), JSON.stringify(result));
  if (result.status === "partial") assert.equal(typeof result.reason, "string");
  assert.doesNotMatch(result.text, confidential);
  assert.doesNotMatch(result.text, /DO_NOT_EXPAND_INSERTED_NAME/);
  assert.doesNotMatch(result.text, /未知用户/);
  assert.doesNotMatch(result.text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e\u202e]/);
  assert.ok(result.text.length <= 16_000);
}

for (const url of urlCases) {
  for (const carrier of carriers) {
    for (const name of names) {
      test(`${carrier.kind} keeps its original ${url.name} token when a name contains ${name.kind}`, () => {
        const result = renderCardContent(card(`Lead ${carrier.wrap(url.value)} Separate @_user_1 Tail`), mentions(name.value));
        assertSafe(result);
        for (const visible of ["Lead", "https://example.invalid/public", "Separate", "Tail", expectedNameProjection(name.value)])
          assert.ok(result.text.includes(visible), `missing independently projected ${visible} in ${result.text}`);
        if (carrier.kind === "Markdown destination") assert.match(result.text, /Read/);
      });
    }
  }
}

for (const name of names) {
  test(`a mention in a Markdown caption is final text when its name contains ${name.kind}`, () => {
    const source = "Lead [Label @_user_1 end](https://destination.invalid/read?token=SYNTHETIC_OUTER_QUERY) Tail";
    const result = renderCardContent(card(source), mentions(name.value));
    assertSafe(result);
    for (const visible of ["Lead", "Label", "end", expectedNameProjection(name.value), "https://destination.invalid/read", "Tail"])
      assert.ok(result.text.includes(visible), `source caption or destination changed: ${result.text}`);
  });
}

for (const carrier of carriers) {
  test(`an unknown mention inside a ${carrier.kind} needs no lookup and preserves an external mention`, () => {
    const url = "https://example.invalid/public?token=@_user_77]SYNTHETIC_QUERY_TAIL";
    const source = `Lead ${carrier.wrap(url)} Separate @_user_1 Tail`;
    const result = renderCardContent(card(source), mentions("Synthetic Person"));
    assertSafe(result);
    if (carrier.kind !== "Markdown URL label") {
      assert.equal(result.status, "rendered");
      assert.equal(result.reason, null);
    }
    assert.notEqual(result.reason, "unresolved_card_mention");
    assert.match(result.text, /https:\/\/example\.invalid\/public/);
    assert.match(result.text, /Separate @Synthetic Person Tail/);
  });
}

test("a mention-shaped URL path remains the original path in every URL carrier", () => {
  for (const carrier of carriers) {
    const url = "https://example.invalid/public/@_user_1?token=SYNTHETIC_QUERY_TAIL";
    const result = renderCardContent(card(`Lead ${carrier.wrap(url)} Separate @_user_1 Tail`), mentions("Synthetic Person"));
    assertSafe(result);
    assert.match(result.text, /https:\/\/example\.invalid\/public\/@_user_1/);
    assert.match(result.text, /Separate @Synthetic Person Tail/);
  }
});

for (const control of [
  { name: "C1 OSC", start: "\u009d", end: "\u009c" },
  { name: "ESC OSC", start: "\u001b]", end: "\u001b\\" },
]) {
  test(`${control.name} payload is opaque even when it contains known and unknown mention tokens`, () => {
    const source = `Visible ${control.start}@_user_1 @_user_77 SYNTHETIC_HIDDEN_TAIL${control.end}End`;
    const result = renderCardContent(card(source), mentions("Synthetic Person"));
    assert.equal(result.text, "Visible End");
    assert.equal(result.status, "rendered");
    assert.equal(result.reason, null);
  });
}

test("OSC starting inside an at token cannot reveal the hidden tail after its apparent closing tag", () => {
  for (const control of [
    { start: "\u009d", end: "\u009c" },
    { start: "\u001b]", end: "\u001b\\" },
  ]) {
    const source = `Visible <at id="ou_synthetic_source_person${control.start}"></at>SYNTHETIC_HIDDEN_TAIL${control.end} End`;
    const result = renderCardContent(card(source), mentions("Synthetic Person"));
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "unresolved_card_mention");
    assert.match(result.text, /Visible @未知用户 End/);
    assert.doesNotMatch(result.text, /SYNTHETIC_HIDDEN_TAIL|Synthetic Person/);
    assert.doesNotMatch(result.text, /[\u001b\u009c\u009d]/);
  }
});

test("OSC crossing a Markdown destination's apparent closing parenthesis cannot expose its payload", () => {
  const source = "Visible [Open](https://example.invalid/public?\u009dtoken=SYNTHETIC_QUERY_TAIL)SYNTHETIC_HIDDEN_TAIL\u009c) End";
  const result = renderCardContent({ elements: [
    { tag: "plain_text", content: "Separate lead" },
    { tag: "lark_md", content: source },
    { tag: "plain_text", content: "Separate tail" },
  ] }, mentions("Synthetic Person"));
  assertSafe(result);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "unsupported_card_link");
  assert.match(result.text, /Separate lead/);
  assert.match(result.text, /Separate tail/);
  assert.doesNotMatch(result.text, /Visible|Open| End|https:/);
});

test("a Markdown destination escape cannot split an immediately following ESC OSC span", () => {
  const source = "Visible [Label](\\\u001b]HIDDEN ) @_user_1 HIDDEN_TAIL\u0007) End";
  const result = renderCardContent(card(source), mentions("Synthetic Person"));
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "unsupported_card_link");
  assert.match(result.text, /^Visible Label/);
  assert.match(result.text, / End/);
  assert.doesNotMatch(result.text, /HIDDEN|Synthetic Person|@_user_1|未知用户/);
  assert.doesNotMatch(result.text, /[\u0007\u001b]/);
});

test("a Markdown destination escape cannot split an immediately following C1 OSC span", () => {
  const source = "Visible [Label](\\\u009dHIDDEN ) @_user_1 HIDDEN_TAIL\u009c) End";
  const result = renderCardContent(card(source), mentions("Synthetic Person"));
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "unsupported_card_link");
  assert.match(result.text, /^Visible Label/);
  assert.match(result.text, / End/);
  assert.doesNotMatch(result.text, /HIDDEN|Synthetic Person|@_user_1|未知用户/);
  assert.doesNotMatch(result.text, /[\u009c\u009d]/);
});

test("bidi and ANSI contamination cannot turn a different original at identity into a known one", () => {
  const ids = ["ou_synthetic_source_person", "ou_synthetic_source_person\u202e", "ou_synthetic_source_person\u001b[0m"];
  const inputs = [
    card(ids.map((id) => `<at id="${id}"></at>`).join(" / ")),
    { elements: ids.map((id) => ({ tag: "at", property: { userID: id } })) },
  ];
  for (const input of inputs) {
    const result = renderCardContent(input, mentions("Synthetic Person"));
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "unresolved_card_mention");
    assert.equal(result.text.match(/@Synthetic Person/g)?.length, 1);
    assert.equal(result.text.match(/@未知用户/g)?.length, 2);
    assert.doesNotMatch(result.text, /[\u001b\u202e]/);
  }
});

test("native projection preserves raw evidence, source hash and version while keeping URL tokens private", () => {
  const payload = card("Lead https://example.invalid/public?token=@_user_1]SYNTHETIC_QUERY_TAIL Separate @_user_1 Tail");
  const instant = Date.UTC(2049, 3, 17, 10, 11, 12);
  const raw = {
    message_id: "om_synthetic_source_tokens",
    chat_id: "oc_synthetic_source_tokens",
    msg_type: "interactive",
    create_time: String(instant),
    update_time: String(instant + 1000),
    sender: { id: "ou_synthetic_source_sender", sender_type: "user" },
    mentions: mentions("Synthetic Person"),
    body: { content: JSON.stringify(payload) },
    synthetic_extra_evidence: { untouched: ["opaque", 17] },
  };
  const before = JSON.stringify(raw);
  const expected = renderCardContent(raw.body.content, raw.mentions);
  assertSafe(expected);
  const normalized = normalizeApiMessage(raw);
  const record = recordFromMessage(normalized, "lark.im.sent_by_me", "sent");
  assert.equal(normalized.content, expected.text);
  assert.deepEqual(normalized.content_rendering, { status: expected.status, reason: expected.reason, version: 2 });
  assert.deepEqual(normalized.raw_api, raw);
  assert.equal(record.raw_json, before);
  assert.equal(record.content_hash, createHash("sha256").update(before).digest("hex"));
  assert.equal(record.external_version, raw.update_time);
  assert.equal(record.body, expected.text);
  assert.doesNotMatch(record.body, confidential);
  assert.equal(JSON.stringify(raw), before);
  assert.match(JSON.parse(record.raw_json).body.content, /SYNTHETIC_QUERY_TAIL/, "raw evidence retains the complete original value");
});
