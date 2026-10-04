import assert from "node:assert/strict";
import test from "node:test";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";
import { createLegacyCardFixture, snapshot, messages, assertOriginalContract }
  from "./helpers/card-projection-fixture.mjs";

// Freshly invented records represent persisted legacy projections.
const START = Date.parse("2026-01-02T03:04:00Z");
const SCOPE = "lark.im.received.chat.synthetic_card_review";
const { row, database } = createLegacyCardFixture({ start: START, scope: SCOPE,
  chatId: "oc_synthetic_card_review", tempPrefix: "exocortex-card-review-" });


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
      ...(displayed.display.card.omitted_actions ? { omitted_actions: displayed.display.card.omitted_actions } : {}),
    });
    assert.deepEqual(normalized.raw_api, original.raw);
  }
  verify(json, text);
  assert.deepEqual(snapshot(fixture), before, "card reading must preserve database bytes, schema, rows and permissions");
}

const plain = (content) => ({ tag: "plain_text", content });
const button = (content, rest = {}) => ({ tag: "button", text: plain(content), ...rest });

test("ordinary and property card headers retain visible subtitles", (t) => {
  const originals = [
    row("header_standard", { header: { title: plain("Synthetic direct title"), subtitle: plain("Synthetic direct subtitle") },
      elements: [{ tag: "div", text: plain("Synthetic direct body") }] }),
    row("header_property", { header: { property: {
      title: { property: { content: "Synthetic property title" } },
      subtitle: { property: { content: "Synthetic property subtitle" } },
    } }, body: { elements: [{ tag: "div", property: { text: plain("Synthetic property body") } }] } }),
  ];
  verifyReadOnlyProjection(t, originals, (json, text) => {
    for (const displayed of json) assert.equal(displayed.display.card.status, "rendered");
    for (const visible of ["Synthetic direct title", "Synthetic direct subtitle", "Synthetic direct body",
      "Synthetic property title", "Synthetic property subtitle", "Synthetic property body"]) assert.ok(text.includes(visible), visible);
  });
});

test("ordinary div.extra and native div.property.extra buttons are projected as visible blocks", (t) => {
  const originals = [
    row("extra_standard", { elements: [{ tag: "div", text: plain("Synthetic direct main text"),
      extra: button("Synthetic direct extra button", { url: "https://example.invalid/direct-extra" }) }] }),
    row("extra_property", { body: { elements: [{ tag: "div", property: {
      text: plain("Synthetic property main text"),
      extra: { type: "button", property: { text: plain("Synthetic property extra button"), url: "https://example.invalid/property-extra" } },
    } }] } }),
  ];
  verifyReadOnlyProjection(t, originals, (json, text) => {
    for (const displayed of json) assert.equal(displayed.display.card.status, "rendered");
    for (const visible of ["Synthetic direct main text", "Synthetic direct extra button", "/direct-extra",
      "Synthetic property main text", "Synthetic property extra button", "/property-extra"]) assert.ok(text.includes(visible), visible);
  });
});

test("multi_url button destinations retain platform meaning and omit credentials, query and fragment", (t) => {
  const multi = Object.fromEntries([["url", "default"], ["pc_url", "desktop"], ["ios_url", "ios"], ["android_url", "android"]]
    .map(([key, path]) => [key, `https://synthetic_user:SYNTHETIC_PASSWORD@example.invalid/${path}?token=SYNTHETIC_TOKEN#SYNTHETIC_FRAGMENT`]));
  const inert = { callback: { url: "https://example.invalid/NEVER_RENDER_CALLBACK" },
    value: { private_action_data: "NEVER_RENDER_VALUE" } };
  const originals = [row("multi_standard", { elements: [button("Synthetic platform button", { multi_url: multi, ...inert })] }),
    row("multi_property", { body: { elements: [{ type: "button", property: {
      text: plain("Synthetic property platform button"), multi_url: multi, ...inert,
    } }] } })];
  verifyReadOnlyProjection(t, originals, (json, text) => {
    for (const displayed of json) {
      assert.equal(displayed.display.card.status, "rendered");
      for (const path of ["default", "desktop", "ios", "android"]) {
        assert.ok(displayed.display.card.text.includes(`https://example.invalid/${path}`), path);
      }
      assert.match(displayed.display.card.text, /PC|pc|桌面|电脑/);
      assert.match(displayed.display.card.text, /iOS|ios/);
      assert.match(displayed.display.card.text, /Android|android|安卓/);
    }
    assert.doesNotMatch(text, /SYNTHETIC_PASSWORD|SYNTHETIC_TOKEN|SYNTHETIC_FRAGMENT|synthetic_user|NEVER_RENDER_CALLBACK|NEVER_RENDER_VALUE/);
    assert.ok(JSON.stringify(json).includes("SYNTHETIC_PASSWORD"), "raw evidence remains complete in JSON");
    assert.ok(JSON.stringify(json).includes("NEVER_RENDER_VALUE"));
  });
});

test("unsupported subtitle, extra and multi_url shapes cannot silently claim a complete card", (t) => {
  const originals = [
    row("unsupported_subtitle", { header: { title: plain("Visible unsupported subtitle title"),
      subtitle: { tag: "synthetic_future_text", private_value: "NEVER_RENDER_SUBTITLE_RAW" } }, elements: [] }),
    row("unsupported_extra", { elements: [{ tag: "div", text: plain("Visible unsupported extra body"),
      extra: { tag: "synthetic_future_widget", private_value: "NEVER_RENDER_EXTRA_RAW" } }] }),
    row("unsupported_multi", { elements: [button("Visible unsupported platform button", {
      multi_url: { synthetic_console_url: "https://example.invalid/NEVER_RENDER_UNSUPPORTED_PLATFORM" },
    })] }),
    row("invalid_multi_value", { elements: [button("Visible malformed platform button", { multi_url: { pc_url: { hidden: "NEVER_RENDER_OBJECT_URL" } } })] }),
  ];
  verifyReadOnlyProjection(t, originals, (json, text) => {
    for (const displayed of json) {
      assert.equal(displayed.display.card.status, displayed.display.card.omitted_actions ? "structured_fallback" : "partial", displayed.external_id);
      assert.equal(displayed.display.card.reason, "unsupported_card_structure");
      assert.match(displayed.display.card.text, /卡片.*未展开/);
    }
    for (const visible of ["Visible unsupported subtitle title", "Visible unsupported extra body"]) assert.ok(text.includes(visible));
    assert.doesNotMatch(text, /Visible unsupported platform button|Visible malformed platform button/);
    assert.doesNotMatch(text, /NEVER_RENDER_|synthetic_future_|synthetic_console_url|"hidden"/);
  });
});

for (const [name, url, safeOrigin] of [
  ["bracket_query", "https://example.invalid/a?token=A]SYNTHETIC_SECRET", "https://example.invalid/a"],
  ["ipv6_bracket_query", "https://[2001:db8::1]/a?token=A]SYNTHETIC_SECRET#TAIL", "https://[2001:db8::1]/a"],
]) {
  test(`bare ${name} links cannot leak a query suffix after a closing bracket`, (t) => {
    const original = row(name, { elements: [{ tag: "div", text: { tag: "lark_md", content: `Synthetic link ${url}\nSynthetic next line` } }] });
    verifyReadOnlyProjection(t, [original], (json, text) => {
      const rendered = json[0].display.card;
      assert.equal(rendered.status, "rendered", "valid IPv6 and bracket-bearing query URLs remain supported");
      assert.ok(rendered.text.includes(safeOrigin));
      assert.doesNotMatch(rendered.text, /SYNTHETIC_SECRET|TAIL|token=A/);
      assert.doesNotMatch(text, /SYNTHETIC_SECRET|TAIL|token=A/);
      assert.match(text, /Synthetic next line/);
      assert.ok(json[0].raw.body.content.includes("SYNTHETIC_SECRET"));
    });
  });
}
