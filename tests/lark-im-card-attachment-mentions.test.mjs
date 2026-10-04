import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { renderCardContent } from "../src/adapters/lark-im/card-content.mjs";

// All identities, names, URLs, prose, relationships and hostile inputs are
// invented here from field contracts; nothing is captured from a real card.
const moduleUrl = new URL("../src/adapters/lark-im/card-content.mjs", import.meta.url).href;
const text = (content) => ({ tag: "plain_text", content });
const at = (userID) => ({ tag: "at", property: { userID } });
const card = (...elements) => ({ elements });

test("empty navigation url does not suppress an explicit usable href", () => {
  const result = renderCardContent(card({ tag: "button", text: text("Synthetic reference"),
    url: "", href: "https://example.invalid/invented-reference" }));
  assert.equal(result.text, "Synthetic reference （链接：https://example.invalid/invented-reference）");
  assert.equal(result.status, "rendered");
  assert.equal(result.omitted_actions, undefined);
});

test("container fields and following elements keep separate slots while inline fragments stay joined", () => {
  const result = renderCardContent(card({ tag: "div", fields: [
    { text: { tag: "markdown", elements: [text("Field: "), text("invented value")] } },
  ], elements: [text("Meaningful "), text("tail")] }));
  assert.equal(result.text, "Field: invented value\nMeaningful tail");
  assert.equal(result.status, "rendered");
});

for (const tag of ["button", "a", "link", ""]) {
  for (const wrappedTarget of [false, true]) {
    for (const missing of [undefined, null, ""]) {
      test(`${tag || "untagged"} selects href for ${wrappedTarget ? "wrapped" : "direct"} ${String(missing)} target`, () => {
        const fixture = card({ tag, text: text("Synthetic reference"),
          url: wrappedTarget ? { url: missing } : missing,
          href: "https://synthetic-user:synthetic-password@example.invalid/reference?private=SYNTHETIC_QUERY#SYNTHETIC_FRAGMENT" });
        const before = JSON.stringify(fixture);
        const result = renderCardContent(fixture);
        assert.equal(result.text, "Synthetic reference （链接：https://example.invalid/reference [链接敏感部分已省略]）");
        assert.equal(result.status, "rendered");
        assert.equal(result.reason, null);
        assert.equal(result.omitted_actions, undefined);
        assert.equal(JSON.stringify(fixture), before);
      });
    }
  }
}

for (const [kind, value, reason] of [
  ["scheme", "javascript:SYNTHETIC_SECRET", "unsupported_card_link"],
  ["whitespace", " ", "unsupported_card_link"],
  ["control", "https://synthetic-user\u001b[31m:SYNTHETIC_SECRET@example.invalid/private", "unsupported_card_link"],
  ["shape", { nested: "SYNTHETIC_SECRET" }, "unsupported_card_structure"],
  ["limit", "x".repeat(270_000), "card_input_limit"],
]) {
  for (const wrappedTarget of [false, true]) {
    test(`invalid nonempty ${kind} ${wrappedTarget ? "wrapped" : "direct"} target stays diagnostic and never falls back to href`, () => {
      const result = renderCardContent(card(text("Meaningful body"), {
        tag: "button", text: text("Hidden invalid navigation"),
        url: wrappedTarget ? { url: value } : value,
        href: "https://example.invalid/SHOULD_NOT_BORROW_HREF",
      }));
      assert.equal(result.status, "partial");
      assert.equal(result.reason, reason);
      assert.equal(result.omitted_actions, 1);
      assert.match(result.text, /Meaningful body\n\[卡片部分内容未展开/);
      assert.doesNotMatch(result.text, /SYNTHETIC_SECRET|Hidden invalid navigation|SHOULD_NOT_BORROW_HREF|\u001b/);
      assert.ok(result.text.length <= 16_000);
    });
  }
}

test("navigation precedence does not read ignored href, inherited wrapper data, or wrapper getters", () => {
  let calls = 0;
  const primary = { tag: "button", text: text("Primary"), url: { url: "https://example.invalid/primary" } };
  Object.defineProperty(primary, "href", { get() { calls += 1; throw new Error("unselected href"); } });
  assert.equal(renderCardContent(card(primary)).text, "Primary （链接：https://example.invalid/primary）");
  const getter = {};
  Object.defineProperty(getter, "url", { get() { calls += 1; return "https://example.invalid/getter"; } });
  for (const invalid of [Object.create({ url: "https://example.invalid/inherited" }), getter]) {
    const result = renderCardContent(card(text("Body"), { tag: "button", url: invalid,
      href: "https://example.invalid/SHOULD_NOT_BORROW_HREF" }));
    assert.equal(result.reason, "unsupported_card_structure");
    assert.doesNotMatch(result.text, /inherited|getter|SHOULD_NOT_BORROW_HREF/);
  }
  assert.equal(calls, 0);
});

test("empty URL wrappers share target semantics in platform and explicit action navigation", () => {
  const result = renderCardContent(card({ tag: "button", text: text("Platforms"), multi_url: {
    url: { url: "" }, pc_url: { url: null }, ios_url: { url: "https://example.invalid/mobile" },
  } }, { tag: "button", actions: [{ type: "open_url", action: { url: { url: "" } } }] }));
  assert.match(result.text, /Platforms\niOS链接：https:\/\/example.invalid\/mobile/);
  assert.equal(result.reason, "unsupported_card_structure", "an explicit open_url action still requires a target");
  assert.equal(result.omitted_actions, 1);
});

test("empty container slots do not create boundaries inside one surrounding inline run", () => {
  const result = renderCardContent(card({ tag: "markdown", elements: [text("A"),
    { fields: [], elements: [text("B"), text("C")] }, text("D"), { tag: "br" },
    text("E"), { tag: "br" }, { tag: "br" }, text("F")] }));
  assert.equal(result.text, "ABCD\nE\n\nF");
  assert.equal(result.status, "rendered");
});

test("trailing empty or folded slots do not add layout while explicit br still does", () => {
  for (const emptySlot of [{ fields: [] }, { actions: [{ tag: "button" }] }, { extra: { tag: "button" } }]) {
    const result = renderCardContent(card({ tag: "markdown", elements: [
      { text: "A", ...emptySlot }, text("B"), { ...emptySlot }, text("C"),
      { text: "D", elements: [{ tag: "br" }] }, text("E"),
    ] }));
    assert.equal(result.text, "ABCD\n\nE");
    assert.equal(result.status, "rendered");
  }
});

test("empty slot separators do not consume the output limit but real following content still does", () => {
  for (const empty of [{ fields: [] }, { actions: [{ tag: "button" }] }]) {
    const result = renderCardContent(card({ text: text("X".repeat(16_000)), ...empty }));
    assert.equal(result.status, "rendered");
    assert.equal(result.text.length, 16_000);
    assert.equal(result.reason, null);
  }
  for (const following of [text("Y"), { tag: "br" }]) {
    const result = renderCardContent(card({ text: text("X".repeat(16_000)), elements: [following] }));
    assert.equal(result.reason, "card_output_limit");
    assert.equal(result.status, "partial");
    assert.equal(result.text.length, 16_000);
  }
});

const sourceNames = [
  { key: "@_user_1", id: "ou_fixture_dial_maker", id_type: "open_id", name: "Dial Maker" },
  { key: "@_user_2", id: { open_id: "ou_fixture_dial_reader" }, name: "Dial Reader" },
];
function wrapped(elements, users, nested = false) {
  const content = { json_card: JSON.stringify(card(...elements)), json_attachment: { at_users: users } };
  return nested ? { json_card: JSON.stringify(content) } : content;
}
function rendered(input, mentions = sourceNames) {
  const output = renderCardContent(input, mentions);
  assert.equal(output.version, 3);
  return output;
}

for (const attachmentString of [false, true]) {
  test(`attachment ${attachmentString ? "string" : "object"} binds exact dictionary and user_id aliases through native keys`, () => {
    const aliases = { "731000000000000123": { mention_key: "@_user_2", user_id: "731000000000000456", content: "Do not use this name" },
      "maker@example.invalid": { mention_key: "@_user_1", user_id: "internal-maker" } };
    const input = wrapped([at("maker@example.invalid"), at("731000000000000456"), at("731000000000000123")], aliases);
    if (attachmentString) input.json_attachment = JSON.stringify(input.json_attachment);
    const before = JSON.stringify(input);
    const output = rendered(input);
    assert.equal(output.text, "@Dial Maker\n@Dial Reader\n@Dial Reader");
    assert.equal(output.status, "rendered");
    assert.equal(JSON.stringify(input), before);
    assert.equal(output.text.includes("Do not use"), false);
  });
}

test("every wrapper contributes its exact attachment bridge independent of source order", () => {
  const inner = wrapped([at("inner-ref"), at("outer-ref")], { "inner-ref": { mention_key: "@_user_1" } });
  const outer = { json_card: JSON.stringify(inner), json_attachment: JSON.stringify({ at_users: {
    "outer-ref": { mention_key: "@_user_2" },
  } }) };
  for (const names of [sourceNames, [...sourceNames].reverse()]) {
    assert.equal(rendered(outer, names).text, "@Dial Maker\n@Dial Reader");
  }
});

test("attachment presence forbids implicit nativeRef fallback to a global ID", () => {
  const result = rendered(wrapped([at("ou_fixture_dial_maker"), text("@_user_1")], {}));
  assert.equal(result.text, "@未知用户\n@Dial Maker");
  assert.equal(result.reason, "unresolved_card_mention");
  assert.equal(result.status, "partial");
  assert.equal(result.text.includes("部分内容未展开"), false);
});

test("mention-key tokens never resolve through typed IDs or attachment aliases of the same bytes", () => {
  const names = [{ id: "@_user_9", id_type: "open_id", name: "Typed impostor" },
    { key: "@_user_1", id: { open_id: "ou_fixture_exact" }, name: "Exact Key" }];
  const result = rendered(wrapped([text("@_user_9 / @_user_10 / @_user_1")], {
    "@_user_10": { mention_key: "@_user_1" },
  }), names);
  assert.equal(result.text, "@未知用户 / @未知用户 / @Exact Key");
  assert.equal(result.reason, "unresolved_card_mention");
});

test("explicit typed references cannot cross same-byte namespaces", () => {
  const names = [{ id: { open_id: "collision" }, name: "Open Person" },
    { id: { user_id: "collision" }, name: "User Person" }];
  const result = rendered(card(
    { tag: "at", property: { id: "collision", id_type: "open_id" } },
    { tag: "at", property: { user_id: "collision" } },
    { tag: "at", property: { union_id: "collision" } },
    at("collision"), text('<at id="collision"></at>'),
  ), names);
  assert.equal(result.text, "@Open Person\n@User Person\n@未知用户\n@未知用户\n@未知用户");
});

test("typed references and native attachment references consume separate evidence even for identical bytes", () => {
  const result = rendered(wrapped([
    at("collision"), { tag: "at", property: { open_id: "collision" } },
  ], { collision: { mention_key: "@_user_2" } }), [
    { key: "@_user_1", id: { open_id: "collision" }, name: "Open Target" },
    { key: "@_user_2", id: { user_id: "different" }, name: "Native Target" },
  ]);
  assert.equal(result.text, "@Native Target\n@Open Target");
});

test("legacy literal aliases resolve only one exact namespace and never accept control-normalized IDs", () => {
  const result = rendered(card(at("opaque-id"), at("ou_fixture_unique"), at("ou_fixture_unique\u202e")), [
    { id: "opaque-id", name: "Legacy Person" }, { id: { open_id: "ou_fixture_unique" }, name: "Exact Person" },
  ]);
  assert.equal(result.text, "@Legacy Person\n@Exact Person\n@未知用户");
  const ambiguous = rendered(card(at("shared")), [{ id: { open_id: "shared", user_id: "shared" }, name: "Same Person" }]);
  assert.equal(ambiguous.text, "@未知用户", "a common person does not make the nativeRef namespace explicit");
});

for (const reversed of [false, true]) {
  test(`compatible same-key typed identities merge without key/name union (${reversed ? "reverse" : "forward"})`, () => {
    const names = [
      { key: "@_user_1", id: { open_id: "ou_fixture_shared" }, name: "Shared Person" },
      { key: "@_user_1", id: { open_id: "ou_fixture_shared", user_id: "user-shared" }, name: "Shared Person" },
    ];
    if (reversed) names.reverse();
    const result = rendered(wrapped([at("native-shared"), text("@_user_1"),
      { tag: "at", property: { user_id: "user-shared" } }], { "native-shared": { mention_key: "@_user_1" } }), names);
    assert.equal(result.text, "@Shared Person\n@Shared Person\n@Shared Person");
    assert.equal(result.status, "rendered");
  });
}

for (const conflict of ["disjoint", "missing name", "different name", "same namespace contradiction"]) {
  test(`duplicate native key stays unknown for ${conflict}, in both orders`, () => {
    const first = { key: "@_user_1", id: { open_id: "ou_fixture_shared", user_id: "user-shared" }, name: "Shared Person" };
    const second = {
      disjoint: { key: "@_user_1", id: { open_id: "ou_fixture_other" }, name: "Shared Person" },
      "missing name": { key: "@_user_1", id: { open_id: "ou_fixture_shared" } },
      "different name": { key: "@_user_1", id: { open_id: "ou_fixture_shared" }, name: "Other Name" },
      "same namespace contradiction": { key: "@_user_1", id: { open_id: "ou_fixture_other", user_id: "user-shared" }, name: "Shared Person" },
    }[conflict];
    for (const names of [[first, second], [second, first]]) {
      const result = rendered(wrapped([at("native-ref"), text("@_user_1")], {
        "native-ref": { mention_key: "@_user_1" },
      }), names);
      assert.equal(result.text, "@未知用户\n@未知用户");
      assert.equal(result.reason, "unresolved_card_mention");
    }
  });
}

test("conflicting attachment aliases stay unknown across wrappers, including a later broken bridge", () => {
  for (const otherKey of ["@_user_2", "@_user_404"]) {
    for (const order of [["@_user_1", otherKey], [otherKey, "@_user_1"]]) {
      const inner = wrapped([at("shared-ref")], { inner: { mention_key: order[0], user_id: "shared-ref" } });
      const result = rendered({ json_card: inner, json_attachment: { at_users: {
        "shared-ref": { mention_key: order[1] },
      } } });
      assert.equal(result.text, "@未知用户");
    }
  }
});

test("attachment content, inherited aliases and getters never supply names or execute code", () => {
  let calls = 0;
  const users = Object.create({ inherited: { mention_key: "@_user_1" } });
  users.own = { mention_key: "@_user_2", content: "Wrong Name" };
  Object.defineProperty(users, "getter", { enumerable: true, get() { calls += 1; return { mention_key: "@_user_1" }; } });
  Object.defineProperty(users.own, "content", { get() { calls += 1; return "Wrong Name"; } });
  const result = rendered(wrapped([at("inherited"), at("getter"), at("own")], users));
  assert.match(result.text, /@未知用户\n@未知用户\n@Dial Reader/);
  assert.equal(result.reason, "unsupported_card_structure");
  assert.equal(calls, 0);
});

test("known request buttons are intentionally omitted without reading action payloads or label getters", () => {
  let calls = 0;
  const action = { type: "action_request" };
  Object.defineProperty(action, "action", { get() { calls += 1; throw new Error("hidden request payload"); } });
  const button = { tag: "button", actions: [action, { type: "request" }] };
  for (const key of ["text", "callback", "value"]) Object.defineProperty(button, key, { get() { calls += 1; throw new Error("hidden action field"); } });
  const result = rendered(card(button, { tag: "button", text: text("not displayed") }), []);
  assert.equal(result.text, "[卡片仅含交互操作，文本视图已收起]");
  assert.equal(result.status, "rendered");
  assert.equal(result.reason, null);
  assert.equal(result.omitted_actions, 2);
  assert.equal(calls, 0);
});

for (const action of [{ type: "future_action" }, {}, { type: "open_url", action: {} }, { type: "open_url", action: null }]) {
  test(`unclassified or incomplete button actions remain critical partial: ${JSON.stringify(action)}`, () => {
    const result = rendered(card(text("Keep this body"), { tag: "button", text: text("Do not execute"), actions: [action] }), []);
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "unsupported_card_structure");
    assert.match(result.text, /Keep this body/);
    assert.match(result.text, /部分结构尚未支持/);
    assert.doesNotMatch(result.text, /仅含交互操作|Do not execute/);
  });
}

test("native URL wrappers and explicit open_url actions retain safe navigation and opaque request data", () => {
  const result = rendered(card({ tag: "div", text: { tag: "markdown", elements: [
    text("Read "), { type: "link", property: { text: text("manual"), url: { url: "https://user:SECRET@example.invalid/manual?token=SECRET#SECRET" } } },
    { tag: "br" }, text("Then decide."),
  ] } }, { tag: "button", text: text("Open detail"), actions: [
    { type: "action_request", action: { url: "https://hidden.invalid/SECRET" } },
    { type: "open_url", action: { url: "https://example.invalid/detail?token=SECRET" } },
  ] }), []);
  assert.equal(result.status, "rendered");
  assert.match(result.text, /Read manual （链接：https:\/\/example.invalid\/manual \[链接敏感部分已省略\]）\nThen decide\./);
  assert.match(result.text, /Open detail （链接：https:\/\/example.invalid\/detail/);
  assert.doesNotMatch(result.text, /SECRET|hidden.invalid|user:/);
});

test("unknown mentions do not mask invalid links or missing body diagnostics", () => {
  const result = rendered(card(text("Missing @_user_404"), { tag: "button", text: text("Unsafe"), url: "javascript:SECRET" }), []);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "unsupported_card_link");
  assert.match(result.text, /@未知用户/);
  assert.match(result.text, /不支持的链接已省略/);
  assert.doesNotMatch(result.text, /SECRET|Unsafe|部分提及未能匹配/);
  const body = rendered(card(text("Missing @_user_404"), { tag: "unrecognized_body", text: text("HIDDEN") }), []);
  assert.equal(body.reason, "unsupported_card_structure");
  assert.match(body.text, /部分结构尚未支持/);
});

test("body blocks, inline fields, explicit breaks and tails survive hidden controls", () => {
  const result = rendered(card({ tag: "div", elements: [text("First "), text("line"), { tag: "br" }, text("Second line")] },
    { tag: "div", fields: [{ elements: [text("Owner: "), text("Synthetic Team")] }, { text: text("Status: waiting") }] },
    { tag: "action", actions: [{ tag: "button", text: text("Agree") }, { tag: "button", text: text("Reject") }] },
    { tag: "note", elements: [text("Tail remains. "), text("Ordinary Agree or Reject prose.")] }), []);
  assert.equal(result.text, "First line\nSecond line\nOwner: Synthetic Team\nStatus: waiting\nTail remains. Ordinary Agree or Reject prose.");
  assert.equal(result.status, "rendered");
  assert.equal(result.omitted_actions, 2);
});

function boundedChild(program) {
  const result = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    import { renderCardContent } from ${JSON.stringify(moduleUrl)};
    ${program}
    assert.ok(result.text.length <= 16000);
    process.stdout.write(JSON.stringify({ status: result.status, reason: result.reason, heap: process.memoryUsage().heapUsed }));
  `], { encoding: "utf8", timeout: 4_000, maxBuffer: 16_384 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const shape of ["nested", "flat", "typed literal"]) {
  test(`direct-object ${shape} huge typed IDs are rejected before copying or serializing`, () => {
    const evidence = boundedChild(`
      const huge = 'h'.repeat(24 * 1024 * 1024);
      const entry = ${shape === "nested" ? "{id:{open_id:huge,user_id:huge}}" : shape === "flat" ? "{open_id:huge,union_id:huge}" : "{id:huge,id_type:'open_id'}"};
      entry.key = '@_user_1'; entry.name = 'Small Synthetic Name';
      const result = renderCardContent({ elements: [{tag:'plain_text',content:'Visible'}] }, [entry]);
      assert.equal(entry.${shape === "nested" ? "id.open_id" : shape === "flat" ? "open_id" : "id"}, huge);
    `);
    assert.equal(evidence.reason, "card_input_limit");
    assert.ok(evidence.heap < 64 * 1024 * 1024);
  });
}

test("attachment entries and nested wrappers share global node, depth and text budgets", () => {
  const aliases = Object.fromEntries(Array.from({ length: 3000 }, (_, index) => [`ref-${index}`, { mention_key: "@_user_1" }]));
  assert.equal(rendered(wrapped([at("ref-0")], aliases)).reason, "card_node_limit");
  const hugeAlias = "r".repeat(270_000);
  assert.equal(rendered(wrapped([at("safe")], { [hugeAlias]: { mention_key: "@_user_1" } })).reason, "card_input_limit");
  let deep = wrapped([at("deep")], { deep: { mention_key: "@_user_1" } });
  for (let index = 0; index < 30; index += 1) deep = { json_card: deep, json_attachment: { at_users: {} } };
  assert.equal(rendered(deep).reason, "card_depth_limit");
});

test("attachment parsing preserves the original URL/control priority and opaque substituted names", () => {
  const rawName = "Literal @_user_2 https://user:SECRET@example.invalid/name?token=SECRET";
  const result = rendered(wrapped([text('https://example.invalid/<at-id="native"></at>?token=SECRET / <at id="native"></at>\u001b]52;c;@_user_2\u0007')], {
    native: { mention_key: "@_user_1" },
  }), [{ key: "@_user_1", id: { open_id: "ou_fixture_source" }, name: rawName }, { key: "@_user_2", name: "MUST_NOT_EXPAND" }]);
  assert.doesNotMatch(result.text, /SECRET|MUST_NOT_EXPAND|\u001b/);
  // A mixed control/URL value is intentionally rejected whole by the original
  // lexer. Attachment support must not weaken this conservative boundary.
  assert.equal(result.reason, "unsupported_card_link");
});
