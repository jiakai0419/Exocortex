import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { renderCardContent } from "../src/adapters/lark-im/card-content.mjs";

// Every URL and message in this file is invented. A URL's query/fragment can
// contain Markdown-shaped syntax, but that syntax is still part of the URL.
const moduleUrl = new URL("../src/adapters/lark-im/card-content.mjs", import.meta.url).href;
const card = (content, tag = "lark_md") => ({ elements: [{ tag, content }] });
const secret = /SYNTHETIC_(?:SECRET|PASSWORD|FRAGMENT|INNER_PATH)|token=|user:/;

const atoms = [
  { name: "IPv6 authority", text: "https://[2001:db8::1]/public?token=SYNTHETIC_SECRET#SYNTHETIC_FRAGMENT", originPath: "https://[2001:db8::1]/public" },
  { name: "opening bracket in query", text: "https://example.invalid/public?token=A[SYNTHETIC_SECRET", originPath: "https://example.invalid/public" },
  { name: "opening bracket in fragment", text: "https://example.invalid/public#A[SYNTHETIC_FRAGMENT", originPath: "https://example.invalid/public" },
  { name: "Markdown inside query", text: "https://example.invalid/public?token=A[inner](https://hidden.invalid/SYNTHETIC_INNER_PATH?token=SYNTHETIC_SECRET)#SYNTHETIC_FRAGMENT", originPath: "https://example.invalid/public" },
  { name: "nested Markdown inside query", text: "https://example.invalid/public?token=A[outer[inner](https://hidden.invalid/SYNTHETIC_INNER_PATH?token=SYNTHETIC_SECRET)](https://other.invalid/SYNTHETIC_INNER_PATH)#SYNTHETIC_FRAGMENT", originPath: "https://example.invalid/public" },
  { name: "credentials and bracket in query", text: "https://user:SYNTHETIC_PASSWORD@example.invalid/public?token=[SYNTHETIC_SECRET]#SYNTHETIC_FRAGMENT", originPath: "https://example.invalid/public" },
];

function assertSafe(result) {
  assert.equal(result.version, 2);
  assert.ok(["rendered", "partial"].includes(result.status), JSON.stringify(result));
  if (result.status === "partial") assert.equal(typeof result.reason, "string");
  assert.doesNotMatch(result.text, secret);
  assert.ok(result.text.length <= 16_000);
}

for (const atom of atoms) {
  test(`a bare URL stays atomic before separate Markdown: ${atom.name}`, () => {
    for (const tag of ["plain_text", "lark_md"]) {
      const result = renderCardContent(card(`Before ${atom.text} [Open](https://visible.invalid/read?token=SYNTHETIC_SECRET) After`, tag));
      assertSafe(result);
      for (const visible of ["Before", atom.originPath, "Open", "https://visible.invalid/read", "After"])
        assert.ok(result.text.includes(visible), `${tag}: missing ${visible} in ${result.text}`);
      assert.match(result.text, /已省略/);
    }
  });
}

test("composing atomic URLs and Markdown cannot make a later URL lose its scheme", () => {
  for (const left of atoms) {
    for (const right of atoms) {
      const leftText = left.text.replace("/public", "/left");
      const rightText = right.text.replace("/public", "/right");
      const leftPath = left.originPath.replace("/public", "/left");
      const rightPath = right.originPath.replace("/public", "/right");
      const result = renderCardContent(card(`Prefix ${leftText} between [Read](https://visible.invalid/read) between ${rightText} [Done](https://visible.invalid/done) Suffix`));
      assertSafe(result);
      for (const visible of ["Prefix", leftPath, "Read", rightPath, "Done", "Suffix"])
        assert.ok(result.text.includes(visible), `${left.name} + ${right.name}: missing ${visible}`);
    }
  }
});

const labels = [
  { name: "literal URL", text: "https://user:SYNTHETIC_PASSWORD@example.invalid/label?token=SYNTHETIC_SECRET#SYNTHETIC_FRAGMENT" },
  { name: "literal IPv6 URL", text: "https://[2001:db8::2]/label?token=SYNTHETIC_SECRET#SYNTHETIC_FRAGMENT" },
  { name: "literal query containing brackets", text: "https://example.invalid/label?token=[SYNTHETIC_SECRET]#SYNTHETIC_FRAGMENT" },
  { name: "nested label", text: "Outer [Inner](https://user:SYNTHETIC_PASSWORD@example.invalid/label?token=SYNTHETIC_SECRET#SYNTHETIC_FRAGMENT) tail" },
  { name: "nested IPv6 label", text: "Outer [https://[2001:db8::2]/label?token=SYNTHETIC_SECRET](https://example.invalid/nested?token=SYNTHETIC_SECRET) tail" },
];

for (const label of labels) {
  test(`a Markdown label cannot expose an embedded URL: ${label.name}`, () => {
    const result = renderCardContent(card(`Before [${label.text}](https://destination.invalid/read?token=SYNTHETIC_SECRET#SYNTHETIC_FRAGMENT) After`));
    assertSafe(result);
    assert.match(result.text, /Before/);
    assert.match(result.text, /After/);
    // Nested Markdown may be explicitly unsupported; secrecy and readable
    // surrounding prose do not depend on implementing the whole grammar.
  });
}

test("nested link-shaped query data is not promoted to an independent visible link", () => {
  const result = renderCardContent(card("Before https://example.invalid/read?data=[Inner](javascript:SYNTHETIC_SECRET)[Next](https://hidden.invalid/SYNTHETIC_INNER_PATH) After"));
  assertSafe(result);
  assert.match(result.text, /Before https:\/\/example\.invalid\/read/);
  assert.match(result.text, /After/);
  assert.doesNotMatch(result.text, /javascript:|Inner|Next|hidden\.invalid/);
});

test("the same native mention has one identical URL projection in a node or inline tag", () => {
  const mentions = [{ id: { open_id: "ou_synthetic_url_person" },
    name: "Synthetic https://[2001:db8::3]/person?token=SYNTHETIC_SECRET [Profile](https://example.invalid/profile?token=SYNTHETIC_SECRET#SYNTHETIC_FRAGMENT)" }];
  const standalone = renderCardContent({ elements: [{ tag: "at", property: { userID: "ou_synthetic_url_person" } }] }, mentions);
  const inline = renderCardContent(card('<at id="ou_synthetic_url_person"></at>'), mentions);
  assertSafe(standalone);
  assertSafe(inline);
  assert.equal(inline.text, standalone.text, "generated URL omission markers must not be reinterpreted as source Markdown");
  for (const visible of ["@Synthetic", "https://[2001:db8::3]/person", "Profile", "https://example.invalid/profile"])
    assert.ok(inline.text.includes(visible), `missing ${visible} in ${inline.text}`);
});

function assertNoUserinfoDisclosure(result) {
  assert.equal(result.version, 2);
  assert.ok(["rendered", "partial", "structured_fallback"].includes(result.status));
  if (result.status !== "rendered") assert.equal(typeof result.reason, "string");
  // A truncated userinfo prefix can become a hostname, which URL() lowercases.
  assert.doesNotMatch(result.text, /synthetic_secret/i);
  assert.ok(result.text.length <= 16_000);
}

const usernameUrl = (repetitions) => `https://${"SYNTHETIC_SECRET".repeat(repetitions)}@example.invalid/public`;
const plain = (content) => ({ tag: "plain_text", content });
const at = (userID) => ({ tag: "at", property: { userID } });
const withSurroundingText = (node) => ({ elements: [plain("Before"), node, plain("After")] });

test("a URL mention longer than the display limit is projected before any display truncation", () => {
  const name = usernameUrl(1200);
  assert.ok(name.length > 16_000 && name.length < 256 * 1024);
  const mentions = [{ id: "synthetic_long_name", name }];
  for (const node of [at("synthetic_long_name"), plain('<at id="synthetic_long_name"></at>')]) {
    const result = renderCardContent(withSurroundingText(node), mentions);
    assertNoUserinfoDisclosure(result);
    assert.match(result.text, /Before/);
    assert.match(result.text, /After/);
  }
});

test("remaining inline expansion budget cannot truncate a shorter URL mention into a hostname", () => {
  const name = usernameUrl(500);
  const fillerName = `https://example.invalid/filler?padding=${"x".repeat(8000)}`;
  assert.ok(name.length < 16_000);
  const mentions = [
    { key: "@_user_1", name: fillerName },
    { key: "@_user_2", name },
  ];
  // One filler crossed the old 16k budget. Thirty-two complete filler names
  // leave less than this target needs under the 256 Ki-character budget.
  assert.ok(32 * (fillerName.length + 1) < 256 * 1024);
  assert.ok(32 * (fillerName.length + 1) + name.length + 1 > 256 * 1024);
  for (const count of [1, 32]) {
    const source = `Before ${"@_user_1 ".repeat(count)}@_user_2 After`;
    const result = renderCardContent(card(source), mentions);
    assertNoUserinfoDisclosure(result);
    assert.match(result.text, /Before/);
    assert.match(result.text, /After/);
    assert.match(result.text, /https:\/\/example\.invalid\/filler/);
    if (count === 32) assert.notEqual(result.status, "rendered", "a skipped whole mention must be explicit");
  }
});

test("URL-internal mention syntax never enters the expansion budget or loses its userinfo separator", () => {
  const name = `https://${"A".repeat(100_000)}@example.invalid/public`;
  const mentions = [{ key: "@_user_1", name }];
  const source = "@_user_1 @_user_1 https://SYNTHETIC_SECRET@_user_1";
  const result = renderCardContent(card(source), mentions);
  assertNoUserinfoDisclosure(result);
  assert.equal(result.status, "rendered");
  assert.match(result.text, /https:\/\/example\.invalid\/public/);
  // Only the two external mentions expand. The third occurrence is raw URL
  // data and retains its separator without entering the expansion budget.
  assert.match(result.text, /https:\/\/_user_1\//);
});

test("an oversized direct-object text value is rejected whole before its userinfo becomes a host", () => {
  const url = usernameUrl(18_000);
  assert.ok(url.indexOf("@example.invalid") > 256 * 1024);
  const result = renderCardContent(withSurroundingText(plain(url)));
  assertNoUserinfoDisclosure(result);
  assert.notEqual(result.status, "rendered");
  assert.match(result.text, /Before/);
  assert.doesNotMatch(result.text, /After/, "the rejected value exhausts the remaining input budget");
});

for (const kind of ["body", "button URL"]) {
  test(`the cumulative text budget rejects a whole ${kind} without splitting userinfo`, () => {
    const url = usernameUrl(100);
    const reserved = "\u202e".repeat(256 * 1024 - 1024);
    assert.ok(url.length > 1024);
    const node = kind === "body" ? plain(url) : { tag: "button", text: { tag: "plain_text", content: "Open" }, url };
    const result = renderCardContent({ elements: [plain("Before"), plain(reserved), node, plain("After")] });
    assertNoUserinfoDisclosure(result);
    assert.notEqual(result.status, "rendered");
    assert.match(result.text, /Before/);
    assert.doesNotMatch(result.text, /After/, "the rejected value exhausts the remaining input budget");
    if (kind === "button URL") assert.match(result.text, /Open/);
  });
}

test("the cumulative native-name budget cannot retain a partial userinfo name", () => {
  const mentions = [
    { id: "f", name: `Filler${"\u202e".repeat(256 * 1024 - 1024)}` },
    { id: "t", name: usernameUrl(100) },
  ];
  for (const node of [at("t"), plain('<at id="t"></at>')]) {
    const result = renderCardContent(withSurroundingText(node), mentions);
    assertNoUserinfoDisclosure(result);
    assert.notEqual(result.status, "rendered");
    // Native names are admitted before body slots; this oversized second name
    // exhausts the shared budget, so even the short body text has no remainder.
    assert.doesNotMatch(result.text, /Before|After/);
  }
});

test("a URL atom consuming a label delimiter leaves an explicit partial result at a later delimiter", () => {
  const result = renderCardContent(card("Before [https://example.invalid/label?token=SYNTHETIC_SECRET](https://first.invalid/read) continuation ](https://second.invalid/read) After"));
  assertSafe(result);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "unsupported_card_link");
  assert.match(result.text, /Before/);
  assert.match(result.text, /After/);
});

const controlChangedLinks = [
  { name: "OSC removes the userinfo separator", text: "https://SYNTHETIC_SECRET\u009d@example.invalid/public\u009c" },
  { name: "bidi removal creates the scheme", text: "h\u200ettps://example.invalid/public?token=SYNTHETIC_QUERY" },
  { name: "OSC removes the scheme leaving bare userinfo", text: "\u009dhttps://\u009cSYNTHETIC_SECRET@example.invalid/public" },
  { name: "OSC removes the scheme and query key leaving its bare value", text: "\u009dhttps://example.invalid/public?token=\u009cSYNTHETIC_QUERY" },
];

function assertControlledLinkRejected(result) {
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "unsupported_card_link");
  assert.doesNotMatch(result.text, /synthetic_(?:secret|query)|token=/i);
  assert.doesNotMatch(result.text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e\u202e]/);
  assert.doesNotMatch(result.text, /https?:\/\/example\.invalid/);
  assert.match(result.text, /不支持的链接/);
}

for (const entry of controlChangedLinks) {
  test(`body links changed by controls are rejected: ${entry.name}`, () => {
    const result = renderCardContent({ elements: [plain("Separate lead"), plain(`Before ${entry.text} After`), plain("Separate tail")] });
    assertControlledLinkRejected(result);
    assert.doesNotMatch(result.text, /Before|After/, "the ambiguous text value is rejected whole");
    assert.match(result.text, /Separate lead/);
    assert.match(result.text, /Separate tail/);
  });

  test(`standalone and inline names preserve control-taint evidence: ${entry.name}`, () => {
    const mentions = [{ id: "synthetic_controlled_person", name: `Person ${entry.text} Visible` }];
    const standalone = renderCardContent({ elements: [at("synthetic_controlled_person")] }, mentions);
    const inline = renderCardContent(card('<at id="synthetic_controlled_person"></at>'), mentions);
    assertControlledLinkRejected(standalone);
    assertControlledLinkRejected(inline);
    assert.equal(inline.text, standalone.text);
    assert.doesNotMatch(inline.text, /Person|Visible/, "the ambiguous name value is rejected whole");
  });

  test(`explicit button URL slots reject controlled values whole: ${entry.name}`, () => {
    for (const slot of ["url", "href"]) {
      const result = renderCardContent(withSurroundingText({ tag: "button", text: plain("Open"), [slot]: entry.text }));
      assertControlledLinkRejected(result);
      for (const visible of ["Before", "Open", "After"]) assert.ok(result.text.includes(visible));
    }
  });

  test(`all platform URL slots reject controls without tainting a separate clean slot: ${entry.name}`, () => {
    const multi_url = Object.fromEntries(["url", "pc_url", "ios_url", "android_url"].map((slot) => [slot, entry.text]));
    const result = renderCardContent({ elements: [
      { tag: "button", text: plain("Platforms"), multi_url },
      { tag: "button", text: plain("Clean"), url: "https://clear.invalid/public?token=SYNTHETIC_QUERY" },
    ] });
    assertControlledLinkRejected(result);
    for (const visible of ["Platforms", "默认", "桌面", "iOS", "Android", "Clean", "https://clear.invalid/public"])
      assert.ok(result.text.includes(visible));
  });
}

test("ANSI styling near a complete URL rejects that entire text value and preserves separate values", () => {
  const result = renderCardContent({ elements: [
    plain("Separate lead"),
    plain("Before \u001b[31mred\u001b[0m https://example.invalid/public?token=SYNTHETIC_QUERY After"),
    plain("Separate tail"),
  ] });
  assertControlledLinkRejected(result);
  assert.doesNotMatch(result.text, /Before|red|After/);
  assert.match(result.text, /Separate lead/);
  assert.match(result.text, /Separate tail/);
});

test("ANSI styling and bidi without any raw or cleaned URL still preserve ordinary text", () => {
  const result = renderCardContent(card("Before \u001b[31mred\u001b[0m text \u202eAfter"));
  assert.equal(result.status, "rendered");
  assert.equal(result.reason, null);
  assert.equal(result.text, "Before red text After");
});

test("ordinary carriage returns, newlines and tabs do not taint complete links", () => {
  const result = renderCardContent(card("Before\t https://example.invalid/public?token=SYNTHETIC_QUERY\r\nAfter\rLast"));
  assert.equal(result.status, "rendered");
  assert.equal(result.reason, null);
  assert.match(result.text, /Before  https:\/\/example\.invalid\/public/);
  assert.match(result.text, /\nAfter\nLast/);
  assert.doesNotMatch(result.text, /SYNTHETIC_QUERY|token=|不支持的链接/);
});

function boundedChild(program) {
  const child = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", `
    import {renderCardContent} from ${JSON.stringify(moduleUrl)};
    const started = performance.now();
    ${program}
    const source = JSON.stringify({elements:[{tag:'lark_md',content}]});
    if (source.length >= 256 * 1024) throw new Error('fixture exceeded the input limit');
    const result = renderCardContent(source);
    if (/SYNTHETIC_SECRET|token=/.test(result.text)) throw new Error('query escaped projection');
    process.stdout.write(JSON.stringify({
      inputChars:source.length, outputChars:result.text.length,
      status:result.status, reason:result.reason,
      elapsedMs:performance.now()-started, heapUsed:process.memoryUsage().heapUsed,
      maxRssKb:process.resourceUsage().maxRSS,
    }));
  `], { encoding: "utf8", timeout: 4000, maxBuffer: 16_384 });
  assert.equal(child.error, undefined, String(child.error));
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  const evidence = JSON.parse(child.stdout);
  assert.ok(evidence.inputChars >= 245_000, JSON.stringify(evidence));
  assert.ok(evidence.inputChars < 256 * 1024, JSON.stringify(evidence));
  assert.ok(evidence.outputChars <= 16_000, JSON.stringify(evidence));
  assert.ok(evidence.heapUsed < 64 * 1024 * 1024, JSON.stringify(evidence));
  assert.ok(evidence.maxRssKb < 128 * 1024, JSON.stringify(evidence));
  return evidence;
}

test("245000 unmatched brackets finish within four seconds under a 64 MiB child heap", (t) => {
  const evidence = boundedChild(`const content = '['.repeat(245000);`);
  assert.equal(evidence.status, "partial");
  assert.equal(evidence.reason, "card_output_limit");
  t.diagnostic(JSON.stringify(evidence));
});

test("49000 nested link-shaped fragments finish within four seconds under a 64 MiB child heap", (t) => {
  const evidence = boundedChild(`
    const content = 'Before ' + '[x]('.repeat(49000) +
      'https://example.invalid/read?token=SYNTHETIC_SECRET' + ')'.repeat(49000) + ' After';
  `);
  assert.equal(evidence.status, "partial");
  assert.equal(typeof evidence.reason, "string");
  t.diagnostic(JSON.stringify(evidence));
});
