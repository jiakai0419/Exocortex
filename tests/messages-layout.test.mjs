import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { runCli } from "../bin/exocortex.mjs";
import { compact, plain, sanitizeTerminalText } from "../dist/terminal/index.js";
import { displayCard, enrichRow } from "../src/diagnostics/messages-report.mjs";
import { renderMessagesText } from "../src/terminal/messages-view.mjs";
import { textWidth } from "../src/terminal/text-layout.mjs";

// All names, IDs, messages and times are invented here. No DB or API is read.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DATE = "2048-04-08T06:07:00.000Z";
const node = (content) => ({ tag: "plain_text", content });
function message({ body = "合成包裹已到。", card, p2p = false, direction = "received", sender = "合成人员", chat = "合成观测站" } = {}) {
  const canonical = { msg_type: card === undefined ? "text" : "interactive", chat_type: p2p ? "p2p" : "group",
    sender_id: "ou_invented_layout_sender", sender_name: sender, sender_type: "user", chat_name: chat,
    ...(p2p ? { chat_partner: { name: "合成收件人", open_id: "ou_invented_layout_peer" } } : {}) };
  const raw = { msg_type: canonical.msg_type, body: { content: card === undefined ? JSON.stringify({ text: body })
    : typeof card === "string" ? card : JSON.stringify(card) } };
  return enrichRow({ id: 1, direction, record_type: "lark.im.message", occurred_at: DATE, occurred_at_ms: Date.parse(DATE),
    actor_id: canonical.sender_id, container_id: "oc_invented_layout_group", external_id: "om_invented_layout_message",
    body, canonical_json: JSON.stringify(canonical), raw_json: JSON.stringify(raw), scope_config_json: "{}" });
}
function writer(columns) {
  let text = "";
  const stream = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  stream.columns = columns;
  stream.isTTY = false;
  return { stream, text: () => text };
}
async function cli(messages, columns, format = "text") {
  const stdout = writer(columns), stderr = writer(columns);
  const before = JSON.stringify(messages);
  const code = await runCli(["messages", "--db", "/synthetic/layout-never-opened.sqlite", "--format", format], {
    stdout: stdout.stream, stderr: stderr.stream,
    messagesDeps: { resolvePath: () => "/synthetic/layout-never-opened.sqlite", existsSync: () => true,
      readLocalChatAppNames: () => null, loadMessages: () => messages },
  });
  assert.equal(code, 0);
  assert.equal(stderr.text(), "");
  assert.equal(JSON.stringify(messages), before);
  return stdout.text();
}
function cardLines(output) {
  const text = plain(output);
  const marker = "  消息\n";
  assert.ok(text.includes(marker));
  return text.slice(text.indexOf(marker) + marker.length).replace(/\n$/, "").split("\n");
}
function sourceCard(message) {
  return sanitizeTerminalText(displayCard(message.raw,
    { includePartialNotice: false, includeDecorativeSeparators: false }).text, { preserveNewlines: true });
}
// Verify exact source reconstruction independently of the wrapping helper.
function assertCardSource(output, source) {
  const physical = cardLines(output);
  let index = 0;
  for (const hardLine of source.split("\n")) {
    const indentation = hardLine.match(/^ */)[0];
    const prefix = `    ${indentation}`;
    const expected = hardLine.slice(indentation.length);
    let restored = "";
    do {
      assert.ok(index < physical.length, `missing source line ${JSON.stringify(hardLine)}`);
      assert.ok(physical[index].startsWith(prefix), `lost body/list indentation: ${physical[index]}`);
      restored += physical[index++].slice(prefix.length);
      assert.ok(expected.startsWith(restored), `source whitespace/order changed: ${JSON.stringify(restored)}`);
    } while (restored !== expected);
  }
  assert.equal(index, physical.length, "no extra body or blank lines");
}
function assertFits(output, columns) {
  for (const line of plain(output).split("\n")) assert.ok(textWidth(line) <= columns, `${textWidth(line)} cells: ${line}`);
}

test("messages real CLI keeps the 80-column short screen and hangs the 40-column header at segment boundaries", async () => {
  const messages = [message()];
  const time = new Date(DATE).toLocaleString();
  const metadata = "  发送人  合成人员\n  群      合成观测站\n  类型    user / 文本\n  消息    合成包裹已到。\n";
  assert.equal(plain(await cli(messages, 80)), `Messages (1)\n\nRECEIVED ${time}  om_inven...  群聊\n${metadata}`);
  const narrow = plain(await cli(messages, 40));
  assert.equal(narrow, `Messages (1)\n\nRECEIVED ${time}\n  om_inven...  群聊\n${metadata}`);
  assertFits(narrow, 40);
  assert.deepEqual(JSON.parse(await cli(messages, 40, "json")), messages);
  assert.equal(await cli(messages, 40, "json"), await cli(messages, 80, "json"));
});

test("messages hangs every metadata value and ordinary compact body without dropping fields or changing its budget", async () => {
  const sender = "Synthetic Northern Observatory Coordination Team";
  const chat = "Synthetic Northern Observatory / Paper Constellation Review";
  const body = "The synthetic paper constellation is ready for the next observation. ".repeat(6);
  const messages = [message({ sender, chat, body })];
  for (const columns of [40, 80]) {
    const output = plain(await cli(messages, columns));
    assertFits(output, columns);
    for (const [label, expected] of [["发送人", sender], ["群", chat], ["消息", compact(body)]]) {
      const lines = output.split("\n");
      const start = lines.findIndex((line) => line.startsWith(`  ${label} `));
      let restored = lines[start].replace(/^  (?:发送人|群|消息) +/, "");
      for (let n = start + 1; n < lines.length && lines[n].startsWith("          "); n++) restored += lines[n].slice(10);
      assert.equal(restored, expected);
    }
    assert.match(output, /类型    user \/ 文本/);
    assert.equal(compact(body).length, 240);
    assert.ok(output.endsWith("...\n"));
  }
  const privateMessage = [message({ p2p: true, direction: "sent" })];
  const p2p = plain(await cli(privateMessage, 40));
  assert.match(p2p, /SENT /);
  assert.match(p2p, /接收人  合成收件人/);
  assert.doesNotMatch(p2p, /  群 /);
  assert.deepEqual(JSON.parse(await cli(messages, 40, "json")), messages);
});

test("messages preserves hard lines, source spaces, Markdown and list relations across 40/80-column soft wrapping", async () => {
  const messages = [message({ card: { elements: [node("Synthetic opening\n\n  Indented  synthetic  paragraph with repeated spaces and a deliberately long final observation.  \n---\n```text\n  literal  spacing  preserved\n```"),
    { tag: "br" }, { tag: "list", items: [{ type: "ol", order: 7, level: 2, elements: [node("Synthetic nested observation with a long description that requires several display lines.")] }] },
    node("Synthetic ending") ] } })];
  const source = sourceCard(messages[0]);
  for (const columns of [40, 80]) {
    const output = await cli(messages, columns);
    assertFits(output, columns);
    assertCardSource(output, source);
    assert.match(plain(output), /    ---\n    ```text\n/);
    assert.match(plain(output), /      literal  spacing  preserved\n    ```/);
  }
});

test("messages keeps CJK, combining marks and ZWJ emoji intact at soft boundaries", async () => {
  const clusters = ["合成观测", "e\u0301", "👩🏽‍🔬", "👨‍👩‍👧‍👦", "🇨🇳"];
  const messages = [message({ card: { elements: [node(clusters.join("").repeat(15))] } })];
  const source = sourceCard(messages[0]);
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const expected = [...segmenter.segment(source)].map(({ segment }) => segment);
  for (const columns of [40, 80]) {
    const output = await cli(messages, columns);
    assertFits(output, columns);
    assertCardSource(output, source);
    const actual = cardLines(output).flatMap((line) => [...segmenter.segment(line.slice(4))].map(({ segment }) => segment));
    assert.deepEqual(actual, expected, "soft lines must never split a source grapheme");
  }
});

test("messages makes long URLs and unusably deep source indentation explicit width exceptions", async () => {
  const url = `https://example.invalid/${"synthetic-observatory-".repeat(5)}ledger`;
  const messages = [message({ card: { elements: [node("Synthetic link follows"),
    { tag: "button", text: node("Open synthetic ledger"), url },
    { tag: "list", items: [{ type: "ul", level: 18, elements: [node("Deep synthetic observation")] }] },
    node("Synthetic ending") ] } })];
  const source = sourceCard(messages[0]);
  for (const columns of [40, 80]) {
    const output = await cli(messages, columns);
    assertCardSource(output, source);
    assert.ok(output.includes(url), "the entire URL remains contiguous and copyable");
    const overflow = plain(output).split("\n").filter((line) => textWidth(line) > columns);
    assert.ok(overflow.some((line) => line.includes(url)));
    assert.ok(overflow.every((line) => line.includes(url) || columns === 40 && line === `${" ".repeat(40)}- Deep synthetic observation`));
  }
});

test("messages retains empty and anomalous evidence without generic partial notices or raw payloads", async () => {
  assert.equal(await cli([], 40), "No messages.\n");
  for (const [card, marker] of [[{ elements: [] }, "[卡片未展开：没有可识别正文]"],
    ["{SYNTHETIC_PRIVATE_INVALID_CARD", "[卡片未展开：卡片格式无效]"],
    [{ elements: [{ tag: "at", user_id: "ou_invented_missing_layout_person" }] }, "@未知用户"],
    [{ elements: [{ tag: "button", text: node("Send synthetic request"), actions: [{ type: "action_request" }] }] }, "卡片仅含交互操作"]]) {
    const messages = [message({ card })];
    for (const columns of [40, 80]) {
      const output = plain(await cli(messages, columns));
      assertCardSource(output, sourceCard(messages[0]));
      assert.ok(cardLines(output).map((line) => line.slice(4)).join("").includes(marker));
      assert.doesNotMatch(output, /卡片部分内容未展开|SYNTHETIC_PRIVATE_INVALID_CARD/);
      assert.deepEqual(JSON.parse(await cli(messages, columns, "json")), messages);
    }
  }
});

test("messages retains the full pre-layout card output budget and the concrete truncation marker", async () => {
  const messages = [message({ card: { elements: [node("x".repeat(16_010))] } })];
  const source = sourceCard(messages[0]);
  assert.equal(source.length, 16_000);
  assert.ok(source.endsWith("[正文在此达到展示上限]"));
  for (const columns of [40, 80]) {
    const output = await cli(messages, columns);
    assertFits(output, columns);
    assertCardSource(output, source);
    assert.deepEqual(JSON.parse(await cli(messages, columns, "json")), messages);
  }
});

test("messages stream columns control real CLI layout in pipe, NO_COLOR and FORCE_COLOR modes", () => {
  const messages = [message({ card: { elements: [node("Synthetic ordinary paragraph with enough words to require wrapping in a narrow terminal.\nSynthetic second hard line.")] } })];
  const code = `import { runCli } from './bin/exocortex.mjs';
    import { Writable } from 'node:stream';
    const messages = ${JSON.stringify(messages)};
    const results = [];
    for (const columns of [40, 80]) {
      let output = '';
      const stdout = new Writable({ write(chunk, _, done) { output += chunk; done(); } });
      stdout.columns = columns;
      const exit = await runCli(['messages'], { stdout, messagesDeps: {
        resolvePath: () => '/synthetic/never-opened.sqlite', existsSync: () => true,
        readLocalChatAppNames: () => null, loadMessages: () => messages } });
      results.push({ columns, exit, output });
    }
    process.stdout.write(JSON.stringify(results));`;
  let reference;
  for (const mode of ["pipe", "NO_COLOR", "FORCE_COLOR"]) {
    const env = { ...process.env, TZ: "UTC", TERM: "xterm-256color" };
    delete env.NO_COLOR; delete env.FORCE_COLOR; delete env.NODE_DISABLE_COLORS;
    if (mode !== "pipe") env[mode] = "1";
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    const screens = JSON.parse(result.stdout);
    for (const { columns, exit, output } of screens) {
      assert.equal(exit, 0);
      assertFits(output, columns);
      assertCardSource(output, sourceCard(messages[0]));
      if (mode === "FORCE_COLOR") assert.match(output, /\u001b\[/);
      else assert.doesNotMatch(output, /\u001b/);
    }
    const clean = screens.map(({ output }) => stripVTControlCharacters(output));
    assert.notEqual(clean[0], clean[1]);
    if (reference) assert.deepEqual(clean, reference);
    else reference = clean;
  }
});

test("messages defaults non-terminal output to 80 columns and accepts an explicit renderer width", async () => {
  const messages = [message({ body: "Synthetic observation with enough detail to cross the shorter terminal boundary." })];
  assert.equal(plain(await cli(messages, undefined)), plain(await cli(messages, 80)));
  assert.equal(plain(renderMessagesText(messages, { columns: 40 })), plain(await cli(messages, 40)));
});
