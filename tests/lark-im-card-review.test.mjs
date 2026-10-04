import assert from "node:assert/strict";
import test from "node:test";
import { renderCardContent } from "../src/adapters/lark-im/card-content.mjs";

// These are newly composed schema and URL counterexamples, not captured cards.
const text = (content) => ({ tag: "plain_text", content });

test("subtitle and container extra use the normal bounded node parser", () => {
  const result = renderCardContent({
    header: { title: text("Invented folded map"), subtitle: text("Synthetic subtitle") },
    elements: [{ tag: "div", text: text("Synthetic main paragraph"),
      extra: { tag: "button", text: text("Synthetic side action"), url: "https://example.invalid/side" } }],
  });
  assert.equal(result.status, "rendered");
  assert.equal(result.text, "Invented folded map\nSynthetic subtitle\nSynthetic main paragraph\nSynthetic side action （链接：https://example.invalid/side）");
  const partial = renderCardContent({ header: { title: text("Known"), subtitle: { tag: "future_subtitle" } },
    elements: [{ tag: "div", text: text("Readable"), extra: { tag: "future_extra", value: "HIDDEN_EXTRA_VALUE" } }] });
  assert.equal(partial.status, "partial");
  assert.equal(partial.reason, "unsupported_card_structure");
  assert.match(partial.text, /Known\nReadable/);
  assert.doesNotMatch(partial.text, /HIDDEN_EXTRA_VALUE|future_extra/);
});

test("multi_url preserves direct and platform destinations with fixed labels and no callback traversal", () => {
  const result = renderCardContent({ elements: [{ tag: "button", text: text("Choose platform"),
    url: "https://example.invalid/direct?token=SYNTHETIC_DIRECT_SECRET",
    multi_url: { url: "https://example.invalid/default?token=SYNTHETIC_DEFAULT_SECRET",
      pc_url: "https://example.invalid/desktop", ios_url: "https://example.invalid/ios", android_url: "https://example.invalid/android" },
    value: { text: "HIDDEN_CALLBACK_TEXT" }, callback: "HIDDEN_CALLBACK_ACTION" }] });
  assert.equal(result.status, "rendered");
  for (const fragment of ["/direct", "默认链接：https://example.invalid/default", "桌面链接：https://example.invalid/desktop",
    "iOS链接：https://example.invalid/ios", "Android链接：https://example.invalid/android"]) assert.ok(result.text.includes(fragment), fragment);
  assert.doesNotMatch(result.text, /SYNTHETIC_.*SECRET|HIDDEN_CALLBACK/);
});

test("optional platform destinations can be absent while nonempty invalid slots stay partial", () => {
  const configured = { tag: "button", text: text("Read"), multi_url: {
    url: "https://example.invalid/default", pc_url: null, ios_url: "", android_url: undefined } };
  assert.equal(renderCardContent({ elements: [configured] }).status, "rendered");
  for (const invalid of [42, {}, "javascript:INVENTED_ACTION"]) {
    const result = renderCardContent({ elements: [{ ...configured, multi_url: { ...configured.multi_url, ios_url: invalid } }] });
    assert.equal(result.status, "partial");
    assert.ok(result.reason);
    assert.match(result.text, /https:\/\/example\.invalid\/default/);
    assert.doesNotMatch(result.text, /INVENTED_ACTION/);
  }
});

test("native untagged property actions do not lose available multi_url destinations", () => {
  const result = renderCardContent({ body: { elements: [{ property: { actions: [{ property: {
    text: { property: { content: "Native action" } }, multi_url: { pc_url: "https://example.invalid/native" },
  } }] } }] } });
  assert.equal(result.status, "rendered");
  assert.match(result.text, /Native action\n桌面链接：https:\/\/example\.invalid\/native/);
});

for (const [name, url] of [
  ["square bracket", "https://example.invalid/a?token=A]SYNTHETIC_SECRET#SYNTHETIC_FRAGMENT"],
  ["IPv6 literal", "https://[2001:db8::1]/a?token=A]SYNTHETIC_SECRET#SYNTHETIC_FRAGMENT"],
  ["IPv6 credentials", "https://invented:SYNTHETIC_PASSWORD@[2001:db8::2]/a?token=A]SYNTHETIC_SECRET#SYNTHETIC_FRAGMENT"],
  ["full-width punctuation", "https://example.invalid/a?token=A）SYNTHETIC_SECRET（TAIL#SYNTHETIC_FRAGMENT"],
  ["angle punctuation", "https://example.invalid/a?token=A>SYNTHETIC_SECRET<TAIL#SYNTHETIC_FRAGMENT"],
]) {
  test(`${name} is consumed before URL projection, including Markdown labels and destinations`, () => {
    const result = renderCardContent({ elements: [text(`Bare ${url}\n[Read](${url})\n[${url}](${url})`)] });
    assert.equal(result.status, "rendered");
    assert.match(result.text, /已省略/);
    assert.doesNotMatch(result.text, /SYNTHETIC_SECRET|SYNTHETIC_FRAGMENT|SYNTHETIC_PASSWORD|TAIL|token=/);
    if (name.startsWith("IPv6")) assert.match(result.text, /https:\/\/\[2001:db8::[12]\]\/a/);
    else assert.match(result.text, /https:\/\/example\.invalid\/a/);
  });
}
