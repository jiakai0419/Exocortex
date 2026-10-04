import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { quoteSql, sqliteExec } from "../dist/storage/sqlite/ingestion-store.js";
import { createLegacyCardFixture, snapshot, assertOriginalContract } from "./helpers/card-projection-fixture.mjs";

// All messages, names, clocks and business descriptions are newly invented.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const START = Date.UTC(2048, 3, 8, 6, 7);
const SCOPE = "lark.im.received.chat.invented_snapshot_reading";
const CHAT = "oc_invented_snapshot_reading";
const NOTICE = "卡片来自已采集的 API 快照，可能与客户端当前状态不同。";
const ORDER_NOTICE = "Latest synced messages first.";
const PARTIAL_NOTICE = "[卡片部分内容未展开：部分结构尚未支持]";
const HELP_ORDER = "newest message time first";
const HELP_NOTICE = "Cards are captured API snapshots and may differ from the current client state.";
const { row, database } = createLegacyCardFixture({ start: START, scope: SCOPE,
  chatId: CHAT, tempPrefix: "exocortex-invented-snapshot-reading-" });
const textNode = (content) => ({ tag: "plain_text", content });
const occurrences = (text, value) => text.split(value).length - 1;

function inventedRows() {
  const pending = row("snapshot_pending", {
    header: { title: textNode("Paper orchard request") },
    elements: [{ tag: "div", text: textNode("Reservation pending; awaiting a response.") }],
  }, { body: "CARD_SELECTION pending historical projection" });
  pending.expectedCard = { text: "Paper orchard request\nReservation pending; awaiting a response.",
    status: "rendered", reason: null, version: 3 };
  const completed = row("snapshot_completed", {
    header: { title: textNode("Copper kite report") },
    elements: [{ tag: "div", text: textNode("Delivery completed for the invented parcel.") }],
  }, { body: "CARD_SELECTION completed historical projection" });
  completed.expectedCard = { text: "Copper kite report\nDelivery completed for the invented parcel.",
    status: "rendered", reason: null, version: 3 };
  const ordinary = (name, body, direction) => {
    const entry = row(name, { text: body }, { body, direction });
    entry.raw.msg_type = "text";
    entry.canonical.msg_type = "text";
    return entry;
  };
  return [pending, completed,
    ordinary("snapshot_sent_text", "PLAIN_SELECTION invented outgoing note", "sent"),
    ordinary("snapshot_received_text", "PLAIN_SELECTION invented incoming note", "received")];
}

function seed(t, rows = inventedRows()) {
  let fixture;
  let before;
  // Register the read-only assertion before the helper's cleanup hook.
  t.after(() => { if (before) assert.deepEqual(snapshot(fixture), before,
    "reading must preserve SQLite bytes, all rows, schema and directory entries"); });
  fixture = database(t, rows);
  for (const entry of rows.filter((item) => item.direction === "sent")) {
    sqliteExec(fixture.dbPath, `UPDATE records SET direction='sent' WHERE external_id=${quoteSql(entry.raw.message_id)};`);
  }
  before = snapshot(fixture);
  return fixture;
}

// The shared messages helper always adds --format and NO_COLOR. This local
// wrapper exercises the real CLI's default format and each actual pipe/color
// mode without weakening its no-network or read-only guarantees.
function invoke(fixture, args, mode = "no-color") {
  const env = { ...process.env, TZ: "UTC", TERM: "xterm-256color", LARK_CLI: fixture.noNetworkCli,
    SYNTHETIC_NETWORK_MARKER: fixture.networkMarker };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  delete env.NODE_DISABLE_COLORS;
  if (mode === "no-color") env.NO_COLOR = "1";
  if (mode === "force-color") env.FORCE_COLOR = "1";
  const result = spawnSync(process.execPath, [join(ROOT, "bin/exocortex.mjs"), ...args], {
    cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, maxBuffer: 5 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(existsSync(fixture.networkMarker), false, "message reading and help must never invoke Lark");
  return result.stdout;
}

function messages(fixture, args = [], mode) {
  return invoke(fixture, ["messages", "--db", fixture.dbPath, ...args], mode);
}

function expectedJson(entry, index) {
  const card = entry.expectedCard;
  const config = { chat_id: CHAT, chat_type: "group" };
  return {
    id: index + 1, direction: entry.direction || "received", record_type: "lark.im.message",
    occurred_at: new Date(START + index * 1000).toISOString(), occurred_at_ms: START + index * 1000,
    actor_id: entry.raw.sender.id, container_id: CHAT, external_id: entry.raw.message_id,
    body: entry.body, canonical_json: JSON.stringify(entry.canonical), raw_json: JSON.stringify(entry.raw),
    scope_config_json: JSON.stringify(config), canonical: entry.canonical, raw: entry.raw, scope_config: config,
    display: { external_id: `${entry.raw.message_id.slice(0, 8)}...`, scene: "群聊", sender: "Synthetic Sender",
      sender_type: "user", message_type: card ? "卡片" : "文本", recipient: null, chat: "Synthetic Cards",
      body: entry.body, ...(card ? { card } : {}) },
  };
}

for (const [label, makeRows] of [["empty", () => []], ["ordinary-only", () => inventedRows().slice(2)]]) {
  test(`${label} message results do not receive a reading preamble`, (t) => {
    const fixture = seed(t, makeRows());
    for (const args of [[], ["--format", "text"]]) {
      const output = messages(fixture, args);
      assert.equal(occurrences(output, NOTICE), 0);
      assert.equal(occurrences(output, ORDER_NOTICE), 0);
      if (label === "empty") assert.equal(output, "No messages.\n");
      else assert.match(output, /PLAIN_SELECTION invented/);
    }
  });
}

for (const mode of ["no-color", "force-color", "pipe"]) {
  for (const format of ["default", "text"]) {
    test(`multiple cards render directly without a preamble with ${format} format and ${mode} output`, (t) => {
      const fixture = seed(t);
      const raw = messages(fixture, format === "default" ? [] : ["--format", "text"], mode);
      const output = stripVTControlCharacters(raw);
      assert.equal(occurrences(output, NOTICE), 0);
      assert.equal(occurrences(output, ORDER_NOTICE), 0);
      assert.match(output, /^Messages \(4\)\n\nRECEIVED\b/, "title leads directly to the first message");
      assert.match(output, /Paper orchard request\n/);
      assert.match(output, /Reservation pending; awaiting a response\./);
      assert.match(output, /Copper kite report\n/);
      assert.match(output, /Delivery completed for the invented parcel\./);
      assert.match(output, /PLAIN_SELECTION invented outgoing note/);
      assert.match(output, /PLAIN_SELECTION invented incoming note/);
      assert.doesNotMatch(output, /CARD_SELECTION|已批准|已同意|审批已完成/);
      if (mode === "force-color") assert.match(raw, /\u001b\[/, "FORCE_COLOR must exercise styled output even through a pipe");
      else assert.doesNotMatch(raw, /\u001b/, "NO_COLOR and the unforced non-TTY pipe must remain plain");
    });
  }
}

test("messages --limit 5 starts with the five-message heading and then the newest message", (t) => {
  const fifth = row("snapshot_fifth", { elements: [textNode("Invented fifth note.")] });
  const fixture = seed(t, [...inventedRows(), fifth]);
  const output = messages(fixture, ["--limit", "5"]);
  assert.match(output, /^Messages \(5\)\n\nRECEIVED\b/);
  assert.equal(occurrences(output, NOTICE), 0);
  assert.equal(occurrences(output, ORDER_NOTICE), 0);
  assert.ok(output.indexOf("Invented fifth note.") < output.indexOf("PLAIN_SELECTION invented incoming note"));
});

for (const [label, args, selected] of [
  ["search excludes cards", ["--search", "PLAIN_SELECTION"], [3, 2]],
  ["search includes cards", ["--search", "CARD_SELECTION"], [1, 0]],
  ["search returns no rows", ["--search", "INVENTED_NO_MATCH"], []],
  ["sent direction excludes cards", ["--direction", "sent"], [2]],
  ["received direction includes cards", ["--direction", "received"], [3, 1, 0]],
  ["limit excludes older cards", ["--limit", "2"], [3, 2]],
  ["limit retains one older card", ["--limit", "3"], [3, 2, 1]],
]) {
  test(`filters preserve selected messages without adding a preamble when ${label}`, (t) => {
    const fixture = seed(t);
    const json = JSON.parse(messages(fixture, [...args, "--format", "json"]));
    assert.deepEqual(json, selected.map((index) => expectedJson(fixture.rows[index], index)));
    const output = messages(fixture, args);
    assert.equal(occurrences(output, NOTICE), 0);
    assert.equal(occurrences(output, ORDER_NOTICE), 0);
    assert.equal(output.includes("Paper orchard request"), selected.includes(0));
    assert.equal(output.includes("Copper kite report"), selected.includes(1));
  });
}

test("partial, empty and action-only cards keep content and machine diagnostics without generic partial notes", (t) => {
  const partial = row("snapshot_partial", { elements: [textNode("Invented decision remains unknown."),
    { tag: "invented_unsupported_tile", private_value: "INVENTED_HIDDEN_PAYLOAD" }] });
  const actions = row("snapshot_actions", { elements: [{ tag: "button", text: textNode("Send invented request"),
    actions: [{ type: "action_request", action: { desired_result: "INVENTED_SUCCESS_PAYLOAD" } }] }] });
  const empty = row("snapshot_empty", { elements: [] });
  const fixture = seed(t, [partial, actions, empty]);
  const json = JSON.parse(messages(fixture, ["--format", "json"]));
  assert.equal(json[0].display.card.status, "structured_fallback");
  assert.equal(json[0].display.card.reason, "card_no_visible_content");
  assert.equal(json[1].display.card.status, "rendered");
  assert.equal(json[1].display.card.omitted_actions, 1);
  assert.equal(json[2].display.card.status, "partial");
  assert.equal(json[2].display.card.reason, "unsupported_card_structure");
  assert.equal(json[2].display.card.text, `Invented decision remains unknown.\n${PARTIAL_NOTICE}`);
  const output = messages(fixture);
  assert.equal(occurrences(output, NOTICE), 0);
  assert.equal(occurrences(output, ORDER_NOTICE), 0);
  assert.match(output, /Invented decision remains unknown\./);
  assert.match(output, /卡片仅含交互操作，文本视图已收起/);
  assert.match(output, /卡片未展开：没有可识别正文/);
  assert.doesNotMatch(output, /部分内容未展开/);
  assert.doesNotMatch(output, /INVENTED_HIDDEN_PAYLOAD|INVENTED_SUCCESS_PAYLOAD|Send invented request|已完成|已同意/);
});

test("an identical notice in source text stays intact without adding a program notice", (t) => {
  const original = row("snapshot_notice_in_source", { elements: [textNode(NOTICE)] });
  const fixture = seed(t, [original]);
  const [json] = JSON.parse(messages(fixture, ["--format", "json"]));
  assertOriginalContract(json, original);
  assert.deepEqual(json.display.card, { text: NOTICE, status: "rendered", reason: null, version: 3 });
  const output = messages(fixture);
  assert.equal(occurrences(output, NOTICE), 1, "source text must never be removed because it resembles metadata");
  assert.equal(output.split("\n").filter((line) => line === `    ${NOTICE}`).length, 1);
});

test("card and pending keywords in an ordinary message never trigger a reading notice", (t) => {
  const ordinary = inventedRows()[2];
  ordinary.body = "Invented text says 卡片 interactive 申请中 and pending without being a card.";
  ordinary.raw.body.content = JSON.stringify({ text: ordinary.body });
  const fixture = seed(t, [ordinary]);
  const output = messages(fixture);
  assert.equal(occurrences(output, NOTICE), 0);
  assert.ok(output.includes(ordinary.body));
});

test("partial card projection preserves all source prose even when it matches omitted notices", (t) => {
  const prose = ["Invented opening.", ORDER_NOTICE, NOTICE, PARTIAL_NOTICE, "Invented closing."].join("\n");
  const original = row("snapshot_matching_source_notices", {
    elements: [textNode(prose), { tag: "invented_unsupported_widget", private_payload: "INVENTED_DO_NOT_DUMP" }],
  });
  const fixture = seed(t, [original]);
  const before = messages(fixture, ["--format", "json"]);
  const [json] = JSON.parse(before);
  assertOriginalContract(json, original);
  assert.deepEqual(json.display.card, { text: `${prose}\n${PARTIAL_NOTICE}`, status: "partial",
    reason: "unsupported_card_structure", version: 3 });
  for (const mode of ["no-color", "force-color", "pipe"]) {
    const output = stripVTControlCharacters(messages(fixture, ["--limit", "5"], mode));
    for (const line of prose.split("\n")) assert.ok(output.includes(`    ${line}\n`), line);
    assert.equal(occurrences(output, ORDER_NOTICE), 1);
    assert.equal(occurrences(output, NOTICE), 1);
    assert.equal(occurrences(output, PARTIAL_NOTICE), 1, "only the source-authored text remains");
    assert.doesNotMatch(output, /INVENTED_DO_NOT_DUMP/);
  }
  assert.equal(messages(fixture, ["--format", "json"]), before, "reading text must not mutate any JSON projection");
});

test("partial cards retain unknown values at their actual position and leave original JSON intact", (t) => {
  const original = row("snapshot_missing_position", { elements: [
    textNode("Invented owner: "), { tag: "at", user_id: "ou_invented_unresolved_owner" },
    textNode("Known final paragraph."),
    textNode("Invented destination: javascript:INVENTED_HIDDEN_LINK"),
  ] });
  const fixture = seed(t, [original]);
  const [json] = JSON.parse(messages(fixture, ["--format", "json"]));
  assertOriginalContract(json, original);
  assert.equal(json.display.card.status, "partial");
  assert.equal(json.display.card.reason, "unsupported_card_link");
  assert.match(json.display.card.text, /部分内容未展开/);
  const output = messages(fixture);
  assert.match(output, /Invented owner:/);
  assert.match(output, /@未知用户/);
  assert.match(output, /Known final paragraph\./);
  assert.match(output, /\[不支持的链接\]/);
  assert.doesNotMatch(output, /部分内容未展开|INVENTED_HIDDEN_LINK/);
});

test("structural card separators become whitespace while literal prose, Markdown and code stay intact", (t) => {
  const literalMarkdown = "Invented Markdown\n---\n```text\n---\n```\nEnd Markdown";
  const original = row("snapshot_structural_separator", { elements: [
    textNode("Invented opening"), { tag: "hr" }, textNode("Invented second paragraph"),
    { type: "hr", property: {} }, textNode("---"),
    { tag: "lark_md", content: literalMarkdown }, { tag: "hr" }, textNode("Invented ending"),
  ] });
  const fixture = seed(t, [original]);
  const before = messages(fixture, ["--format", "json"]);
  const [json] = JSON.parse(before);
  assertOriginalContract(json, original);
  assert.deepEqual(json.display.card, { text: `Invented opening\n---\nInvented second paragraph\n---\n---\n${literalMarkdown}\n---\nInvented ending`,
    status: "rendered", reason: null, version: 3 });
  for (const mode of ["no-color", "force-color", "pipe"]) {
    const output = stripVTControlCharacters(messages(fixture, ["--limit", "5"], mode));
    assert.match(output, /    Invented opening\n    \n    Invented second paragraph\n    \n    ---\n/);
    assert.ok(output.includes(literalMarkdown.split("\n").map((line) => `    ${line}`).join("\n")));
    assert.match(output, /    End Markdown\n    \n    Invented ending\n/);
    assert.equal(output.split("\n").filter((line) => line === "    ---").length, 3, "preserve only the three source-authored literal separators");
  }
  assert.equal(messages(fixture, ["--format", "json"]), before);
});

for (const limit of ["output", "node", "depth", "input"]) {
  test(`real messages text marks ${limit} truncation at its source boundary without changing JSON`, (t) => {
    let deep = textNode("INVENTED_HIDDEN_DEEP");
    for (let index = 0; index < 30; index += 1) deep = { tag: "column", elements: [deep] };
    const sources = {
      output: { elements: [textNode("x".repeat(16_010)), textNode("INVENTED_HIDDEN_FINAL_INSTRUCTION")] },
      node: { elements: [textNode("Invented opening"), ...Array.from({ length: 3000 }, () => ({ tag: "hr" }))] },
      depth: { elements: [textNode("Invented opening"), deep, textNode("Invented readable sibling")] },
      input: { elements: [textNode("INVENTED_HIDDEN_LARGE_INPUT".repeat(12_000))] },
    };
    const markers = {
      output: "[正文在此达到展示上限]", node: "[解析在此达到元素数量上限]",
      depth: "[此处嵌套超过解析深度上限]", input: "[此处输入超过解析上限]",
    };
    const original = row(`snapshot_${limit}_limit`, sources[limit]);
    const fixture = seed(t, [original]);
    const before = messages(fixture, ["--format", "json"]);
    const [json] = JSON.parse(before);
    assertOriginalContract(json, original);
    assert.equal(json.display.card.reason, `card_${limit}_limit`);
    assert.doesNotMatch(json.display.card.text, /在此达到|此处输入|此处嵌套/);
    for (const mode of ["no-color", "force-color", "pipe"]) {
      const output = stripVTControlCharacters(messages(fixture, [], mode));
      assert.ok(output.includes(markers[limit]));
      assert.doesNotMatch(output, /部分内容未展开|INVENTED_HIDDEN_/);
      if (limit === "output") {
        const body = output.split("\n").find((line) => line.startsWith("    x"));
        assert.equal(body.length - 4, 16_000, "indentation is outside the unchanged card budget");
        assert.ok(body.endsWith(markers.output));
      }
      if (limit === "depth") assert.ok(output.includes(`    Invented opening\n    ${markers.depth}\n    Invented readable sibling`));
      if (limit === "node") assert.doesNotMatch(output, /正文在此|    ---/);
    }
    assert.equal(messages(fixture, ["--format", "json"]), before);
  });
}

test("message JSON retains its exact array shape, values and rendering semantics in all color modes", (t) => {
  const fixture = seed(t);
  const expected = fixture.rows.map(expectedJson).reverse();
  let firstOutput;
  for (const mode of ["no-color", "force-color", "pipe"]) {
    const output = messages(fixture, ["--format", "json"], mode);
    assert.equal(occurrences(output, NOTICE), 0, "human notice must not contaminate private JSON or card.text");
    assert.doesNotMatch(output, /\u001b/);
    const actual = JSON.parse(output);
    assert.ok(Array.isArray(actual));
    assert.deepEqual(actual, expected);
    for (const original of fixture.rows) assertOriginalContract(actual.find((item) => item.external_id === original.raw.message_id), original);
    if (firstOutput !== undefined) assert.equal(output, firstOutput);
    firstOutput = output;
  }
});

for (const [label, args, json] of [
  ["leaf default help", ["messages", "--help"], false],
  ["leaf explicit text help", ["messages", "--help", "--format", "text"], false],
  ["all-route text help", ["--help", "--all"], false],
  ["leaf machine help", ["messages", "--help", "--format", "json"], true],
  ["all-route machine help", ["--help", "--all", "--format", "json"], true],
]) {
  test(`${label} explains ordering and captured card snapshots and exposes only supported formats`, (t) => {
    const fixture = seed(t, []);
    const output = invoke(fixture, args);
    if (json) {
      const catalog = JSON.parse(output);
      const command = catalog.commands.find((entry) => entry.id === "messages");
      assert.ok(command.summary.includes(HELP_NOTICE));
      assert.ok(command.summary.includes(HELP_ORDER));
      assert.ok(command.summary.includes("JSON retains card rendering status and diagnostics."));
      assert.equal(command.privacy, "private");
      assert.deepEqual(command.effects, ["local-read"]);
      const format = command.options.find((option) => option.flag === "--format");
      if (args.includes("--all")) assert.deepEqual(format.choices, ["text", "json"]);
      else assert.deepEqual(format, { flag: "--format", key: "format", type: "enum" });
    } else {
      assert.ok(output.includes(HELP_NOTICE));
      assert.ok(output.includes(HELP_ORDER));
      assert.match(output, /--format <text\|json>/);
    }
  });
}
