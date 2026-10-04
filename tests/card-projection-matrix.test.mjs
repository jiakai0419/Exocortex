import assert from "node:assert/strict";
import test from "node:test";
import { renderCardContent } from "../src/adapters/lark-im/card-content.mjs";

// Freshly invented scenarios exercise structures, never business-template dispatch.
const text = (content) => ({ tag: "plain_text", content });
const person = { tag: "at", property: { userID: "native_synthetic_fern" } };
const paragraph = (...elements) => ({ tag: "markdown", property: { elements } });
const action = { tag: "button", property: { text: text("Synthetic acknowledgement"),
  actionType: "request", actions: [{ type: "action_request", action: { opaque: "PRIVATE_SYNTHETIC_ACTION" } }] } };
const navigation = { tag: "button", property: { text: text("Synthetic reference"),
  actions: [{ type: "open_url", action: { url: "https://example.invalid/reference?private=SYNTHETIC_NAV_SECRET" } }] } };
const scenarios = [
  { name: "document permission", elements: [paragraph(text("Applicant: "), person),
    { tag: "action", actions: [action, navigation] }] },
  { name: "people reminder", elements: [paragraph(text("Recipient: "), person, { tag: "br" },
    text("Due: "), text("invented day")), action] },
  { name: "approval notice", elements: [{ tag: "div", fields: [
    { text: paragraph(text("Owner: "), person) }, { text: text("Stage: synthetic review") }] },
  { tag: "column_set", columns: [{ tag: "column", elements: [paragraph(text("First block"))] },
    { tag: "column", elements: [paragraph(text("Second block"))] }] }, navigation] },
  { name: "asset notification", elements: [paragraph(text("Custodian: "), person, { tag: "br" },
    text("Model: invented device"), { tag: "br" }, text("Configuration: invented specification"),
    { tag: "br" }, text("Inventory: invented identifier")), action,
  { tag: "note", elements: [text("Keep this meaningful return note.")] }] },
];

function source(elements, mentions) {
  const card = { header: { title: text("Entirely synthetic notification") }, elements };
  return { content: JSON.stringify({ json_card: JSON.stringify(card), json_attachment: {
    at_users: { native_synthetic_fern: { mention_key: "@_user_7", user_id: "internal_synthetic_fern",
      content: "UNTRUSTED_SYNTHETIC_ATTACHMENT_NAME" } },
  } }), mentions };
}
const named = [{ key: "@_user_7", id_type: "open_id", id: "ou_synthetic_matrix_fern", name: "Synthetic Fern" }];

for (const scenario of scenarios) {
  for (const variant of ["complete", "missing identity", "conflicting namespace", "missing body", "depth bound"]) {
    test(`projection matrix: ${scenario.name}, ${variant}`, () => {
      const elements = structuredClone(scenario.elements);
      let mentions = structuredClone(named);
      if (variant === "missing identity") mentions = [];
      if (variant === "conflicting namespace") mentions.push({ ...named[0], id_type: "user_id" });
      if (variant === "missing body") elements.push({ tag: "synthetic_unrecognized_chart", content: "NEVER_DUMP_CHART" });
      if (variant === "depth bound") {
        let nested = text("NEVER_REACH_DEPTH_PAYLOAD");
        for (let i = 0; i < 35; i += 1) nested = { tag: "div", elements: [nested] };
        elements.push(nested);
      }
      const fixture = source(elements, mentions);
      const before = JSON.stringify(fixture);
      const result = renderCardContent(fixture.content, fixture.mentions);
      assert.equal(JSON.stringify(fixture), before);
      assert.equal(result.version, 3);
      assert.doesNotMatch(result.text, /PRIVATE_SYNTHETIC_ACTION|UNTRUSTED_SYNTHETIC_ATTACHMENT_NAME|SYNTHETIC_NAV_SECRET|NEVER_DUMP_CHART|NEVER_REACH_DEPTH_PAYLOAD/);
      if (variant === "complete") {
        assert.equal(result.status, "rendered");
        assert.match(result.text, /@Synthetic Fern/);
        assert.doesNotMatch(result.text, /Synthetic acknowledgement|部分内容未展开/);
        if (scenario.name === "people reminder") assert.match(result.text, /Recipient: @Synthetic Fern\nDue: invented day/);
        if (scenario.name === "asset notification") assert.match(result.text,
          /Model: invented device\nConfiguration: invented specification\nInventory: invented identifier\nKeep this meaningful return note\./);
        if (scenario.name === "approval notice") assert.match(result.text, /Owner: @Synthetic Fern\nStage: synthetic review\nFirst block\nSecond block/);
      } else {
        assert.equal(result.status, "partial");
        if (variant === "missing identity" || variant === "conflicting namespace") {
          assert.equal(result.reason, "unresolved_card_mention");
          assert.match(result.text, /@未知用户/);
          assert.doesNotMatch(result.text, /@Synthetic Fern|部分内容未展开/);
        } else {
          assert.equal(result.reason, variant === "depth bound" ? "card_depth_limit" : "unsupported_card_structure");
          assert.match(result.text, /部分内容未展开/);
        }
      }
    });
  }
}

test("combined identity, folded action and invalid navigation keep the important missing-content diagnosis", () => {
  const fixture = source([paragraph(text("Owner: "), person), action,
    { tag: "button", text: text("Do not pretend this is usable"), url: "javascript:SYNTHETIC_PRIVATE_CODE" },
    paragraph(text("Meaningful tail remains."))], []);
  const result = renderCardContent(fixture.content, fixture.mentions);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "unsupported_card_link");
  assert.match(result.text, /@未知用户/);
  assert.match(result.text, /Meaningful tail remains\./);
  assert.match(result.text, /不支持的链接/);
  assert.doesNotMatch(result.text, /SYNTHETIC_PRIVATE_CODE|Synthetic acknowledgement/);
});

for (const form of ["div", "untagged", "native property", "nested"]) {
  for (const targetKind of ["undefined", "null", "empty", "wrapped empty", "invalid"]) {
    test(`slot/navigation matrix: ${form}, ${targetKind} primary with valid href`, () => {
      const url = { undefined, null: null, empty: "", "wrapped empty": { url: "" },
        invalid: "javascript:SYNTHETIC_INVALID_NAVIGATION" }[targetKind];
      const slots = {
        text: paragraph(text("Summary: "), text("invented summary")),
        fields: [{ text: paragraph(text("Field: "), text("invented value"), { tag: "br" }, text("Field detail")) }],
        elements: [text("Meaningful "), text("tail for "), person, { tag: "br" }, text("Due: "), text("invented day")],
        actions: [action, { tag: "button", text: text("Usable reference"), url,
          href: "https://example.invalid/reference?private=SYNTHETIC_MIXED_SECRET" }],
        extra: { tag: "note", elements: [text("Final "), text("meaningful note")] },
      };
      const mixed = form === "div" ? { tag: "div", ...slots } : form === "untagged" ? slots :
        form === "native property" ? { type: "div", property: slots } :
          { tag: "div", fields: [{ text: text("Outer field") }], elements: [{ ...slots }] };
      const fixture = source([mixed, paragraph(text("Independent tail"))], named);
      const before = JSON.stringify(fixture);
      const result = renderCardContent(fixture.content, fixture.mentions);
      assert.equal(JSON.stringify(fixture), before);
      assert.match(result.text, /Summary: invented summary\nField: invented value\nField detail\nMeaningful tail for @Synthetic Fern\nDue: invented day/);
      assert.match(result.text, /Final meaningful note\nIndependent tail(?:\n|$)/);
      assert.doesNotMatch(result.text, /SYNTHETIC_MIXED_SECRET|SYNTHETIC_INVALID_NAVIGATION|PRIVATE_SYNTHETIC_ACTION|Synthetic acknowledgement/);
      if (form === "nested") assert.match(result.text, /^Entirely synthetic notification\nOuter field\nSummary:/);
      if (targetKind === "invalid") {
        assert.equal(result.status, "partial");
        assert.equal(result.reason, "unsupported_card_link");
        assert.equal(result.omitted_actions, 2);
        assert.doesNotMatch(result.text, /Usable reference|example.invalid\/reference/);
      } else {
        assert.equal(result.status, "rendered");
        assert.equal(result.reason, null);
        assert.equal(result.omitted_actions, 1);
        assert.match(result.text, /Due: invented day\nUsable reference （链接：https:\/\/example.invalid\/reference \[链接敏感部分已省略\]）\nFinal meaningful note/);
      }
    });
  }
}
