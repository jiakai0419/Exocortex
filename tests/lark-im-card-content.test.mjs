import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { renderCardContent } from "../src/adapters/lark-im/card-content.mjs";

// Every card, URL, identity and name is composed from scratch for these tests.
const text = (content, tag = "plain_text") => ({ tag, content });
const card = (...elements) => ({ header: { title: text("Invented card title") }, elements });
const paragraph = (content) => ({ tag: "div", text: text(content) });

function complete(input, mentions = []) {
  const result = renderCardContent(input, mentions);
  assert.equal(result.status, "rendered", JSON.stringify(result));
  assert.equal(result.reason, null);
  assert.equal(result.version, 2);
  return result.text;
}

test("standard card titles, paragraphs, fields, columns and buttons retain their display order", () => {
  const input = card(paragraph("First paragraph\nSecond paragraph"), {
    tag: "div", fields: [ { is_short: true, text: text("Owner: Synthetic team") },
      { text: text("State: pending", "lark_md") } ],
  }, { tag: "column_set", columns: [
    { tag: "column", elements: [paragraph("Column one"), paragraph("Column one end")] },
    { tag: "column", elements: [paragraph("Column two")] },
  ] }, { tag: "action", actions: [
    { tag: "button", text: text("Review plan"), url: "https://example.invalid/plan" },
    { tag: "button", text: text("Local action"), value: { secret: "HIDDEN_BUTTON_VALUE" } },
  ] });
  const before = JSON.stringify(input);
  assert.equal(complete(input), "Invented card title\nFirst paragraph\nSecond paragraph\nOwner: Synthetic team\nState: pending\nColumn one\nColumn one end\nColumn two\nReview plan （链接：https://example.invalid/plan）\nLocal action");
  assert.equal(JSON.stringify(input), before);
});

test("native property and locale slots render without requiring an unobserved tag", () => {
  const inline = [{ type: "text", property: { content: "Assigned to " } },
    { type: "at", property: { userID: "ou_invented_exact" } },
    { type: "text", property: { content: "; review tomorrow." } }];
  const input = { header: { property: { title: { property: { i18nContent: {
    zh_cn: "合成标题", en_us: "DO_NOT_DUPLICATE_TRANSLATION",
  } } } } }, body: { elements: [{ property: {
    text: { property: { i18nElements: { zh_cn: inline } } },
    fields: [{ property: { elements: [text("Field "), text("one"), text(": ready")] } },
      { text: { property: { content: "Field two" } } }],
    actions: [{ property: { text: { property: { content: "Read synthetic plan" } } } },
      { type: "button", property: { text: { property: { i18nContent: { zh_cn: "继续" } } } } }],
  } }] } };
  assert.equal(complete(input, [{ id: { open_id: "ou_invented_exact" }, name: "准确姓名" }]),
    "合成标题\nAssigned to @准确姓名; review tomorrow.\nField one: ready\nField two\nRead synthetic plan\n继续");
});

test("outer JSON, object/string json_card wrappers and schema-2 body share one parser", () => {
  const source = { schema: "2.0", header: { title: text("Schema two") }, body: {
    elements: [{ tag: "markdown", content: "A synthetic body" }],
  } };
  for (const input of [source, JSON.stringify(source), { json_card: source },
    { json_card: JSON.stringify(source) }, JSON.stringify({ json_card: JSON.stringify(source) }),
    { json_card: JSON.stringify({ json_card: source }) }]) {
    assert.equal(complete(input), "Schema two\nA synthetic body");
  }
});

test("locale selection chooses one supported language deterministically", () => {
  assert.equal(complete({ header: { title: { property: { i18nContent: { en_us: "English title", ja_jp: "日本語" } } } },
    elements: [{ property: { text: { property: { i18nElements: { en_us: [text("English body")] } } } } }] }),
  "English title\nEnglish body");
  const unknown = renderCardContent({ elements: [{ property: { i18nContent: { xx_invalid: "HIDDEN_LOCALE_CONTENT" } } }] });
  assert.equal(unknown.status, "structured_fallback");
  assert.doesNotMatch(unknown.text, /HIDDEN_LOCALE_CONTENT/);
});

test("unknown nodes preserve readable siblings and never traverse arbitrary descendants", () => {
  const result = renderCardContent(card(paragraph("Before"), {
    tag: "invented_unknown_widget", text: text("HIDDEN_UNKNOWN_TEXT"),
    callback: { text: "HIDDEN_CALLBACK" }, value: "HIDDEN_VALUE",
  }, paragraph("After")));
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "unsupported_card_structure");
  assert.match(result.text, /Before\nAfter/);
  assert.doesNotMatch(result.text, /HIDDEN|invented_unknown_widget|callback|value/);
});

for (const input of [null, [], true, 42, "{UNPARSEABLE_RAW_SENTINEL", { invisible: "HIDDEN_UNKNOWN_PAYLOAD" },
  { elements: [{ tag: "imaginary", payload: "HIDDEN_UNKNOWN_PAYLOAD" }] }]) {
  test(`unsupported card input ${typeof input} has a clear bounded placeholder without raw dump`, () => {
    const result = renderCardContent(input);
    assert.equal(result.status, "structured_fallback");
    assert.ok(result.reason);
    assert.match(result.text, /卡片未展开/);
    assert.doesNotMatch(result.text, /UNPARSEABLE|HIDDEN|invisible|imaginary/);
  });
}

test("exact native mention aliases resolve independently of ordering or sender guesses", () => {
  const mentions = [
    { key: "@_user_1", id: { open_id: "ou_invented_open", user_id: "user_invented", union_id: "on_invented_union" }, name: "Exact person" },
    { id: "literal_invented_id", name: "Literal person" },
    { open_id: "flat_invented_id", name: "Flat person" },
  ];
  const elements = ["on_invented_union", "literal_invented_id", "user_invented", "ou_invented_open", "flat_invented_id", "@_user_1"]
    .map((userID) => ({ tag: "at", property: { userID } }));
  assert.equal(complete({ elements }, mentions), "@Exact person\n@Literal person\n@Exact person\n@Exact person\n@Flat person\n@Exact person");
});

test("mention keys match completely and unknown or ambiguous IDs stay visibly unresolved", () => {
  const source = card(paragraph("Mention @_user_1 then @_user_10 and @_user_1_suffix"),
    { tag: "at", property: { userID: "ou_invented_unknown" } },
    { tag: "at", property: { userID: "ou_invented_known\u202E" } },
    { tag: "at", property: { userID: "ambiguous" } });
  const result = renderCardContent(source, [
    { key: "@_user_1", id: { open_id: "ou_invented_known" }, name: "Confirmed" },
    { id: "ambiguous", name: "First candidate" }, { id: "ambiguous", name: "Second candidate" },
  ]);
  assert.equal(result.status, "partial");
  assert.match(result.text, /Mention @Confirmed then @未知用户 and @_user_1_suffix/);
  assert.doesNotMatch(result.text, /Confirmed0|First candidate|Second candidate/);
  assert.equal(result.text.match(/@Confirmed/g).length, 1, "control removal must not create an ID match");
});

test("lark_md at tags use only explicit same-message mention evidence", () => {
  const result = renderCardContent(card({ tag: "markdown", content:
    '<at id="ou_invented_a">IMPOSTOR_NAME</at> / <at id="ou_invented_missing">UNTRUSTED_NAME</at>' }),
  [{ id: { open_id: "ou_invented_a" }, name: "Confirmed" }]);
  assert.match(result.text, /@Confirmed \/ @未知用户/);
  assert.doesNotMatch(result.text, /IMPOSTOR|UNTRUSTED/);
  assert.equal(result.reason, "unresolved_card_mention");
});

for (const tag of ["plain_text", "lark_md"]) {
  test(`${tag} bare and Markdown links use the same credential/query/fragment omission`, () => {
    const secretUrl = "https://invented_user:INVENTED_PASSWORD@example.invalid/path?q=INVENTED_QUERY#INVENTED_FRAGMENT";
    const source = card({ tag: "div", text: text(`Bare ${secretUrl}\n[Review](${secretUrl})\n[Nested](https://example.invalid/a(b)?q=INVENTED_NESTED(SECRET))`, tag) },
      { tag: "button", text: text("Button"), url: secretUrl });
    const output = complete(source);
    assert.match(output, /https:\/\/example\.invalid\/path/);
    assert.match(output, /Review（链接：https:\/\/example\.invalid\/path/);
    assert.match(output, /已省略/);
    assert.doesNotMatch(output, /invented_user|INVENTED_PASSWORD|INVENTED_QUERY|INVENTED_FRAGMENT|INVENTED_NESTED|SECRET/);
  });
}

test("unsafe protocols are explained without executable links or callback/value bodies", () => {
  const source = card(paragraph("[Bad](javascript:alert('INVENTED_SECRET')) and data:text/plain,INVENTED_SECRET and ftp://example.invalid/INVENTED_SECRET"),
    { tag: "button", text: text("Read"), url: "javascript:alert('INVENTED_SECRET')", callback: "INVENTED_CALLBACK", value: "INVENTED_VALUE" },
    { tag: "a", text: "Bad local file", href: "file:///INVENTED_FILE" });
  const result = renderCardContent(source);
  assert.equal(result.status, "partial");
  assert.match(result.text, /不支持的链接/);
  assert.doesNotMatch(result.text, /javascript:|data:|ftp:|file:|INVENTED_SECRET|INVENTED_CALLBACK|INVENTED_VALUE|INVENTED_FILE/);
});

test("terminal controls, OSC, bidi and mention-name controls cannot enter output", () => {
  const bad = "visible\u001b[31m-red\u001b[0m\u001b]52;c;HIDDEN_OSC\u0007\u009b31m\u202E-end\u0000";
  const output = complete(card(paragraph(`First\n${bad}\nLast`), { tag: "at", user_id: "invented_person" }),
    [{ id: "invented_person", name: `Name${bad}` }]);
  assert.match(output, /First\nvisible-red-end \nLast/);
  assert.doesNotMatch(output, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/);
  assert.doesNotMatch(output, /HIDDEN_OSC/);
});

test("cyclic cards and wrapper cycles terminate while preserving already-known text", () => {
  const recursive = { tag: "column", elements: [] };
  recursive.elements.push(recursive);
  const result = renderCardContent(card(paragraph("Known prefix"), recursive, paragraph("Known suffix")));
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "card_cycle");
  assert.match(result.text, /Known prefix\nKnown suffix/);
  const wrapper = {};
  wrapper.json_card = wrapper;
  assert.equal(renderCardContent(wrapper).reason, "card_cycle");
});

test("deep parsed JSON respects the same traversal limit as direct objects", () => {
  let value = paragraph("HIDDEN_TOO_DEEP");
  for (let index = 0; index < 30; index += 1) value = { tag: "column", elements: [value] };
  for (const input of [card(paragraph("Before deep content"), value), JSON.stringify(card(paragraph("Before deep content"), value))]) {
    const result = renderCardContent(input);
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "card_depth_limit");
    assert.match(result.text, /Before deep content/);
    assert.doesNotMatch(result.text, /HIDDEN_TOO_DEEP/);
  }
});

test("node and output caps remain global across all blocks", () => {
  const repeated = renderCardContent(card(...Array.from({ length: 3000 }, () => paragraph("x"))));
  assert.equal(repeated.status, "partial");
  assert.equal(repeated.reason, "card_node_limit");
  assert.ok(repeated.text.length <= 16_000);
  const long = renderCardContent(card(paragraph("v".repeat(20_000)), paragraph("HIDDEN_AFTER_OUTPUT_CAP")));
  assert.equal(long.status, "partial");
  assert.equal(long.reason, "card_output_limit");
  assert.ok(long.text.length <= 16_000);
  assert.match(long.text, /正文超过展示上限/);
  assert.doesNotMatch(long.text, /HIDDEN_AFTER_OUTPUT_CAP/);
});

test("oversized serialized input and cumulative nested parsing fail without dumping input", () => {
  const oversized = JSON.stringify(card(paragraph("INVENTED_LARGE_RAW".repeat(20_000))));
  const result = renderCardContent(oversized);
  assert.equal(result.status, "structured_fallback");
  assert.equal(result.reason, "card_input_limit");
  assert.doesNotMatch(result.text, /INVENTED_LARGE_RAW/);
  const inner = JSON.stringify(card(paragraph("v".repeat(140_000))));
  assert.equal(renderCardContent(JSON.stringify({ json_card: inner })).reason, "card_input_limit");
});

test("hidden object fields are ignored and accessor text is not invoked", () => {
  let calls = 0;
  const source = card(paragraph("Visible"));
  Object.defineProperty(source, "callback", { get() { calls += 1; throw new Error("do not invoke"); } });
  source.value = "HIDDEN_VALUE".repeat(100_000);
  assert.equal(complete(source), "Invented card title\nVisible");
  const getterNode = { tag: "plain_text" };
  Object.defineProperty(getterNode, "content", { get() { calls += 1; return "HIDDEN_GETTER"; } });
  const result = renderCardContent(card(getterNode));
  assert.equal(result.status, "partial");
  assert.equal(calls, 0);
  assert.doesNotMatch(result.text, /HIDDEN_GETTER|HIDDEN_VALUE/);
});


test("literal parentheses cannot expose the remainder of a URL query or fragment", () => {
  for (const url of [
    "https://example.invalid/a(b)?token=INVENTED_SECRET#INVENTED_FRAGMENT",
    "https://example.invalid/a(b(c))?token=INVENTED_SECRET#INVENTED_FRAGMENT",
    "https://example.invalid/a?token=INVENTED_SECRET(inner)TAIL#INVENTED_FRAGMENT",
  ]) {
    const output = complete(card(paragraph(`[Open](${url})\nBare ${url}`)));
    assert.match(output, /Open（链接：https:\/\/example\.invalid/);
    assert.doesNotMatch(output, /INVENTED_SECRET|INVENTED_FRAGMENT|TAIL|token=/);
  }
});

for (const [name, expression] of [
  ["unmatched markdown brackets", `({elements:[{tag:'plain_text',content:'['.repeat(250000)}]})`],
  ["unclosed mention tags", `({elements:[{tag:'plain_text',content:'<at id="invented">'.repeat(14000)}]})`],
  ["deep huge sparse array", `(() => { const value={tag:'div',text:{tag:'column',elements:[]}};
    let current=value.text; for(let index=0;index<10;index++) {
      current.elements=[{tag:'column',elements:[]}]; current=current.elements[0];
    }
    current.elements=new Array(2**32-1); return {elements:[value]}; })()`],
]) {
  test(`${name} finishes under a real child-process deadline`, () => {
    const moduleUrl = new URL("../src/adapters/lark-im/card-content.mjs", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import {renderCardContent} from ${JSON.stringify(moduleUrl)};
const value=${expression};
const result=renderCardContent(value);
if(result.text.length>16000)process.exit(2);
process.stdout.write(JSON.stringify({status:result.status,reason:result.reason}));`],
    { encoding: "utf8", timeout: 2000, maxBuffer: 10000 });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
    assert.ok(["partial", "structured_fallback"].includes(JSON.parse(result.stdout).status));
  });
}


test("an unsupported declared body cannot become complete merely because its title renders", () => {
  for (const extra of [{ body: { future_elements: [{ content: "HIDDEN_BODY" }] } },
    { i18n_elements: { zh_cn: [{ tag: "plain_text", content: "HIDDEN_BODY" }] } }]) {
    const result = renderCardContent({ header: { title: text("Visible title") }, ...extra });
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "unsupported_card_structure");
    assert.match(result.text, /Visible title/);
    assert.doesNotMatch(result.text, /HIDDEN_BODY/);
  }
});

test("resolved names remain opaque when they contain literal mention keys", () => {
  const input = card(paragraph('<at id="invented_x"></at> / @_user_1'));
  const output = complete(input, [
    { id: "invented_x", key: "@_user_1", name: "Synthetic @_user_2 literal" },
    { id: "invented_y", key: "@_user_2", name: "DO_NOT_SUBSTITUTE_AGAIN" },
  ]);
  assert.equal(output, "Invented card title\n@Synthetic @_user_2 literal / @Synthetic @_user_2 literal");
  assert.doesNotMatch(output, /DO_NOT_SUBSTITUTE_AGAIN/);
});

test("an invalid preferred locale can preserve a usable alternative with an explicit partial status", () => {
  const result = renderCardContent({ elements: [{ property: {
    i18nContent: { zh_cn: null, en_us: "Readable alternative" },
  } }] });
  assert.equal(result.status, "partial");
  assert.match(result.text, /Readable alternative/);
  assert.equal(result.reason, "unsupported_card_structure");
});


test("escaped Markdown parentheses remain within the complete URL before sensitive parts are omitted", () => {
  for (const url of [
    String.raw`https://example.invalid/a\)?token=INVENTED_ESCAPED_SECRET#INVENTED_ESCAPED_FRAGMENT`,
    String.raw`https://example.invalid/a\(b\)?token=INVENTED_ESCAPED_SECRET#INVENTED_ESCAPED_FRAGMENT`,
  ]) {
    const output = complete(card(paragraph(`[Open](${url})`)));
    assert.match(output, /Open（链接：https:\/\/example\.invalid/);
    assert.match(output, /已省略/);
    assert.doesNotMatch(output, /INVENTED_ESCAPED_SECRET|INVENTED_ESCAPED_FRAGMENT|token=/);
  }
});


test("Markdown mention identity is matched before bidi or terminal controls are removed", () => {
  const result = renderCardContent(card(paragraph(
    '<at id="ou_invented_exact"></at> / <at id="ou_invented_exact\u202e"></at> / <at id="ou_invented_exact\u001b[0m"></at> / @_user_1')),
  [{ id: { open_id: "ou_invented_exact" }, key: "@_user_1", name: "Exact @_user_2 literal" },
    { key: "@_user_2", name: "DO_NOT_REPLACE_LITERAL" }]);
  assert.equal(result.status, "partial");
  assert.match(result.text, /@Exact @_user_2 literal \/ @未知用户 \/ @未知用户 \/ @Exact @_user_2 literal/);
  assert.doesNotMatch(result.text, /DO_NOT_REPLACE_LITERAL|[\u001b\u202e]/);
  assert.equal(result.text.match(/@Exact/g).length, 2);
});
