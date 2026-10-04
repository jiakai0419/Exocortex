import assert from "node:assert/strict";
import test from "node:test";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";
import { createLegacyCardFixture, snapshot, messages, assertOriginalContract }
  from "./helpers/card-projection-fixture.mjs";

// Freshly invented records represent persisted legacy projections.
const START = Date.parse("2026-01-01T02:03:00Z");
const SCOPE = "lark.im.received.chat.synthetic_card_url_atoms";
const { row, database } = createLegacyCardFixture({ start: START, scope: SCOPE,
  chatId: "oc_synthetic_card_url_atoms", tempPrefix: "exocortex-card-url-atoms-" });


function verifyReadOnlyProjection(t, originals, verify) {
  const fixture = database(t, originals);
  const before = snapshot(fixture);
  const json = messages(fixture, "json");
  const text = messages(fixture, "text");
  for (const original of originals) {
    const displayed = json.find((record) => record.external_id === original.raw.message_id);
    assertOriginalContract(displayed, original);
    const normalized = normalizeApiMessage(original.raw);
    assert.equal(normalized.content, displayed.display.card.text);
    assert.deepEqual(normalized.content_rendering, {
      status: displayed.display.card.status, reason: displayed.display.card.reason, version: 3,
    });
    assert.deepEqual(normalized.raw_api, original.raw);
  }
  verify(json, text);
  assert.deepEqual(snapshot(fixture), before, "card reading must preserve database bytes, schema, rows and permissions");
}


const CASES = [
  {
    name: "ipv6_then_markdown",
    input: "Before https://[::1]/a?token=SYNTHETIC_QUERY [open](https://example.invalid/public) After",
    visible: ["Before", "https://[::1]/a", "open", "https://example.invalid/public", "After"],
    forbidden: /SYNTHETIC_QUERY|token=/,
  },
  {
    name: "query_bracket_then_markdown",
    input: "Before https://example.invalid/a?token=A[SYNTHETIC_QUERY [open](https://example.invalid/public) After",
    visible: ["Before", "https://example.invalid/a", "open", "https://example.invalid/public", "After"],
    forbidden: /SYNTHETIC_QUERY|token=/,
  },
  {
    name: "markdown_inside_url_query",
    input: "Prefix https://example.invalid/a?token=A[inner](https://hidden.invalid/SYNTHETIC_INNER_PATH?x=SYNTHETIC_QUERY)#SYNTHETIC_FRAGMENT [open](https://example.invalid/public) Suffix",
    visible: ["Prefix", "https://example.invalid/a", "open", "https://example.invalid/public", "Suffix"],
    forbidden: /SYNTHETIC_INNER_PATH|SYNTHETIC_QUERY|SYNTHETIC_FRAGMENT|hidden\.invalid|\binner\b|token=/,
  },
  {
    name: "multiple_links_and_lines",
    input: "Start https://example.invalid/one?token=SYNTHETIC_ONE Middle [two](https://example.invalid/two?token=SYNTHETIC_TWO)\nThird https://[2001:db8::2]/three?token=SYNTHETIC_THREE End",
    visible: ["Start", "https://example.invalid/one", "Middle", "two", "https://example.invalid/two", "Third", "https://[2001:db8::2]/three", "End"],
    forbidden: /SYNTHETIC_ONE|SYNTHETIC_TWO|SYNTHETIC_THREE|token=/,
    multiline: true,
  },
  {
    name: "url_inside_markdown_label",
    input: "Before [label https://[::1]/label?token=SYNTHETIC_LABEL](https://example.invalid/destination?token=SYNTHETIC_DESTINATION) After",
    visible: ["Before", "label", "After"],
    forbidden: /SYNTHETIC_LABEL|SYNTHETIC_DESTINATION|token=/,
    mayBePartial: true,
  },
  {
    name: "nested_and_escaped_markdown",
    input: "Before [outer [inner](https://example.invalid/inner?token=SYNTHETIC_INNER)](https://example.invalid/outer?token=SYNTHETIC_OUTER) Middle [escaped](https://example.invalid/path\\(part\\)?token=SYNTHETIC_ESCAPED) After",
    visible: ["Before", "outer", "inner", "Middle", "escaped", "After"],
    forbidden: /SYNTHETIC_INNER|SYNTHETIC_OUTER|SYNTHETIC_ESCAPED|token=/,
    mayBePartial: true,
  },
];

for (const scenario of CASES) {
  test(`URL atoms: ${scenario.name} keeps surrounding text and cannot expose query fragments`, (t) => {
    const original = row(scenario.name, { elements: [{ tag: "div", text: { tag: "lark_md", content: scenario.input } }] });
    verifyReadOnlyProjection(t, [original], (json, text) => {
      const projection = json[0].display.card;
      assert.ok((scenario.mayBePartial ? ["rendered", "partial"] : ["rendered"]).includes(projection.status), projection.status);
      assert.doesNotMatch(projection.text, scenario.forbidden);
      assert.doesNotMatch(text, scenario.forbidden);
      for (const visible of scenario.visible) {
        assert.ok(projection.text.includes(visible), `${scenario.name}: projection lost ${visible}`);
        assert.ok(text.includes(visible), `${scenario.name}: CLI lost ${visible}`);
      }
      assert.doesNotMatch(text, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
      assert.equal(JSON.parse(json[0].raw.body.content).elements[0].text.content, scenario.input);
      if (scenario.multiline) {
        assert.ok(projection.text.includes("\n"));
        assert.ok(text.slice(text.indexOf("Middle"), text.indexOf("Third")).includes("\n"));
      }
    });
  });
}
