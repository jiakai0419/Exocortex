import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// Every identity and timestamp is invented. The subprocess can call only this
// local fake CLI; no account, configuration, captured message or network input.
const START = Date.UTC(2044, 4, 6, 7, 8, 9);
const SELF = "ou_synthetic_cursor_self";
const OTHER = "ou_synthetic_cursor_other";

function probe(t, entries, self = SELF, api = "native") {
  const directory = mkdtempSync(join(tmpdir(), "exocortex-cursor-probe-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  mkdirSync(home);
  const cli = join(directory, "synthetic-lark-cli.mjs");
  const messages = entries.map(([offset, sender], index) => ({
    message_id: `om_synthetic_cursor_${index}`, chat_id: "oc_synthetic_cursor_room",
    sender: { id: sender }, create_time: String(START + offset), msg_type: "text",
    body: { content: "SYNTHETIC_BODY_MUST_NOT_APPEAR" },
  }));
  writeFileSync(cli, `#!/usr/bin/env node
const args = process.argv.slice(2);
let result;
if (args[0] === "--version") result = "1.2.3";
else if (args[0] === "contact" && args[1] === "+get-user") result = ${JSON.stringify(self ? { open_id: self } : {})};
else if (args[1] === "+chat-list") result = { chats: [{ chat_id: "oc_synthetic_cursor_room" }] };
else if (args[1] === "+chat-messages-list") result = { messages: ${JSON.stringify(messages)} };
else if (args[1] === "+messages-search") result = { messages: [] };
else if (args[0] === "api" && args[2] === "/open-apis/im/v1/messages") result = { code: 0, data: { items: ${JSON.stringify(messages)} } };
else if (args[0] === "api" && args[2] === "/open-apis/im/v1/messages/search") result = { code: 0, data: { items: [] } };
else process.exit(97);
process.stdout.write(JSON.stringify(result));
`);
  chmodSync(cli, 0o700);
  const output = join(directory, "report.json");
  const result = spawnSync(process.execPath, ["tools/probes/cursors.mjs",
    "--api", api, "--start", new Date(START).toISOString(), "--end", new Date(START + 60_000).toISOString(), "--output", output], {
    cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
    env: { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"), HOME: home,
      XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, TMPDIR: directory,
      TZ: "UTC", LANG: "C", LARK_CLI: cli },
  });
  assert.equal(result.status, 0, result.stderr);
  const reportText = readFileSync(output, "utf8");
  assert.doesNotMatch(reportText, /SYNTHETIC_BODY_MUST_NOT_APPEAR|ou_synthetic_cursor_|om_synthetic_cursor_/);
  const report = JSON.parse(reportText);
  const page = report.probes.received_from_unmuted_chats.chats[0];
  return { all: page.first_page, received: page.first_page_received_only };
}

test("received-only count, ordering and timestamp groups exclude sent messages", (t) => {
  const { all, received } = probe(t, [[10, OTHER], [0, SELF], [10, SELF], [20, OTHER]]);
  assert.equal(all.count, 4);
  assert.equal(all.order.monotonic_create_time_asc, false);
  assert.equal(all.order.same_timestamp_group_count, 1);
  assert.equal(received.count, 2);
  assert.deepEqual(received.messages.map(({ index }) => index), [0, 3], "retain source page positions");
  assert.deepEqual(received.order, {
    monotonic_create_time_asc: true, create_time_desc_violations: [],
    same_timestamp_group_count: 0, max_same_timestamp_group_size: 1,
  });
});

test("received-only ordering compares newly adjacent remaining messages", (t) => {
  const { all, received } = probe(t, [[30, OTHER], [40, SELF], [20, OTHER]]);
  assert.equal(all.order.create_time_desc_violations[0].previous_create_time_ms, START + 40);
  assert.equal(received.count, 2);
  assert.deepEqual(received.order.create_time_desc_violations, [{
    index: 1, previous_create_time_ms: START + 30, current_create_time_ms: START + 20,
  }]);
});

test("an all-sent page yields an empty received summary", (t) => {
  const { all, received } = probe(t, [[10, SELF], [10, SELF]]);
  assert.equal(all.count, 2);
  assert.equal(received.count, 0);
  assert.deepEqual(received.messages, []);
  assert.deepEqual(received.order, {
    monotonic_create_time_asc: true, create_time_desc_violations: [],
    same_timestamp_group_count: 0, max_same_timestamp_group_size: 0,
  });
});

test("unknown self identity preserves the complete summary", (t) => {
  const { all, received } = probe(t, [[20, OTHER], [10, OTHER]], null);
  assert.deepEqual(received, all);
});

// Explicit convenience comparison keeps the original response-family counterexample.
test("convenience comparison retains filtered ordering semantics", (t) => {
  const { received } = probe(t, [[30, OTHER], [40, SELF], [20, OTHER]], SELF, "convenience");
  assert.equal(received.count, 2);
  assert.equal(received.order.monotonic_create_time_asc, false);
});
