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
  test(`${label} message results do not receive the card snapshot notice`, (t) => {
    const fixture = seed(t, makeRows());
    for (const args of [[], ["--format", "text"]]) {
      const output = messages(fixture, args);
      assert.equal(occurrences(output, NOTICE), 0);
      if (label === "empty") assert.equal(output, "No messages.\n");
      else assert.match(output, /PLAIN_SELECTION invented/);
    }
  });
}

for (const mode of ["no-color", "force-color", "pipe"]) {
  for (const format of ["default", "text"]) {
    test(`multiple cards receive one snapshot notice with ${format} format and ${mode} output`, (t) => {
      const fixture = seed(t);
      const raw = messages(fixture, format === "default" ? [] : ["--format", "text"], mode);
      const output = stripVTControlCharacters(raw);
      assert.equal(occurrences(output, NOTICE), 1, "one result-level notice, not one warning per card");
      assert.equal(output.split("\n").filter((line) => line.trim() === NOTICE).length, 1);
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

for (const [label, args, selected] of [
  ["search excludes cards", ["--search", "PLAIN_SELECTION"], [3, 2]],
  ["search includes cards", ["--search", "CARD_SELECTION"], [1, 0]],
  ["search returns no rows", ["--search", "INVENTED_NO_MATCH"], []],
  ["sent direction excludes cards", ["--direction", "sent"], [2]],
  ["received direction includes cards", ["--direction", "received"], [3, 1, 0]],
  ["limit excludes older cards", ["--limit", "2"], [3, 2]],
  ["limit retains one older card", ["--limit", "3"], [3, 2, 1]],
]) {
  test(`snapshot notice follows the selected result when ${label}`, (t) => {
    const fixture = seed(t);
    const json = JSON.parse(messages(fixture, [...args, "--format", "json"]));
    assert.deepEqual(json, selected.map((index) => expectedJson(fixture.rows[index], index)));
    const output = messages(fixture, args);
    assert.equal(occurrences(output, NOTICE), selected.some((index) => index < 2) ? 1 : 0);
    assert.equal(output.includes("Paper orchard request"), selected.includes(0));
    assert.equal(output.includes("Copper kite report"), selected.includes(1));
  });
}

test("partial, empty and action-only cards receive one notice without fabricating a business outcome", (t) => {
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
  const output = messages(fixture);
  assert.equal(occurrences(output, NOTICE), 1);
  assert.match(output, /Invented decision remains unknown\./);
  assert.match(output, /卡片仅含交互操作，文本视图已收起/);
  assert.match(output, /部分内容未展开/);
  assert.doesNotMatch(output, /INVENTED_HIDDEN_PAYLOAD|INVENTED_SUCCESS_PAYLOAD|Send invented request|已完成|已同意/);
});

test("an identical notice in source text stays intact alongside the single program notice", (t) => {
  const original = row("snapshot_notice_in_source", { elements: [textNode(NOTICE)] });
  const fixture = seed(t, [original]);
  const [json] = JSON.parse(messages(fixture, ["--format", "json"]));
  assertOriginalContract(json, original);
  assert.deepEqual(json.display.card, { text: NOTICE, status: "rendered", reason: null, version: 3 });
  const output = messages(fixture);
  assert.equal(occurrences(output, NOTICE), 2, "do not deduplicate source text against program metadata");
  assert.equal(output.split("\n").filter((line) => line === `    ${NOTICE}`).length, 1);
});

test("card and pending keywords in an ordinary message never trigger the snapshot notice", (t) => {
  const ordinary = inventedRows()[2];
  ordinary.body = "Invented text says 卡片 interactive 申请中 and pending without being a card.";
  ordinary.raw.body.content = JSON.stringify({ text: ordinary.body });
  const fixture = seed(t, [ordinary]);
  const output = messages(fixture);
  assert.equal(occurrences(output, NOTICE), 0);
  assert.ok(output.includes(ordinary.body));
});

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
  test(`${label} explains captured card snapshots and exposes only supported formats`, (t) => {
    const fixture = seed(t, []);
    const output = invoke(fixture, args);
    if (json) {
      const catalog = JSON.parse(output);
      const command = catalog.commands.find((entry) => entry.id === "messages");
      assert.ok(command.summary.includes(HELP_NOTICE));
      assert.equal(command.privacy, "private");
      assert.deepEqual(command.effects, ["local-read"]);
      const format = command.options.find((option) => option.flag === "--format");
      if (args.includes("--all")) assert.deepEqual(format.choices, ["text", "json"]);
      else assert.deepEqual(format, { flag: "--format", key: "format", type: "enum" });
    } else {
      assert.ok(output.includes(HELP_NOTICE));
      assert.match(output, /--format <text\|json>/);
    }
  });
}
