import assert from "node:assert/strict";
import test from "node:test";

import { plain } from "../dist/terminal/index.js";
import {
  parseArgs,
  runMessagesCli,
} from "../src/cli/messages-command.mjs";
import {
  enrichRow,
  loadMessages,
} from "../src/diagnostics/messages-report.mjs";
import { renderMessagesText } from "../src/terminal/messages-view.mjs";

function memoryWriter() {
  let text = "";
  return {
    stream: {
      write(chunk) {
        text += String(chunk);
      },
    },
    text: () => text,
  };
}

function row(overrides = {}) {
  return {
    id: 1,
    direction: "received",
    record_type: "lark.im.message",
    occurred_at: "2026-06-20T00:00:00.000Z",
    occurred_at_ms: Date.parse("2026-06-20T00:00:00.000Z"),
    actor_id: "ou_sender",
    container_id: "oc_chat",
    external_id: "om_synthetic_message",
    body: "Synthetic body",
    canonical_json: "{}",
    raw_json: "{}",
    scope_config_json: "{}",
    ...overrides,
  };
}

test("messages command parseArgs keeps the public CLI stable", () => {
  assert.deepEqual(parseArgs([]), {
    db: "data/exocortex.sqlite",
    direction: "all",
    limit: 30,
    search: "",
    format: "text",
  });
  assert.deepEqual(parseArgs(["--direction", "sent", "--limit", "5", "--search", "needle", "--format", "json"]), {
    db: "data/exocortex.sqlite",
    direction: "sent",
    limit: 5,
    search: "needle",
    format: "json",
  });
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["--limit", "0"]), /limit must be positive/);
  assert.throws(() => parseArgs(["--direction", "mine"]), /--direction must be all, sent, or received/);
});

test("messages report enriches p2p recipients and senderless system messages", () => {
  const sent = enrichRow(row({
    direction: "sent",
    actor_id: "ou_self",
    body: "[Sticker]",
    canonical_json: JSON.stringify({
      chat_type: "p2p",
      msg_type: "sticker",
      sender_id: "ou_self",
      sender_name: "Self User",
      sender_type: "user",
      chat_partner: { open_id: "ou_peer", name: "Peer User" },
    }),
  }));
  const system = enrichRow(row({
    actor_id: null,
    container_id: "oc_topic",
    body: "Synthetic system event",
    canonical_json: JSON.stringify({
      chat_type: "topic",
      chat_id: "oc_topic",
      chat_name: "Shape Topic",
      msg_type: "system",
    }),
  }));

  assert.equal(sent.display.scene, "私聊");
  assert.equal(sent.display.sender, "Self User");
  assert.equal(sent.display.recipient, "Peer User");
  assert.equal(sent.display.sender_type, "user");
  assert.equal(sent.display.message_type, "sticker");
  assert.equal(sent.display.body, "[Sticker]");
  assert.equal(system.display.scene, "话题群");
  assert.equal(system.display.sender, "系统");
  assert.equal(system.display.sender_type, "system");
  assert.equal(system.display.message_type, "系统");
  assert.equal(system.display.chat, "Shape Topic");
});

test("loadMessages builds stable direction and search SQL", () => {
  const calls = [];
  const messages = loadMessages("/abs/db.sqlite", {
    db: "data/exocortex.sqlite",
    direction: "received",
    limit: 7,
    search: "O'Hara",
  }, {
    sqliteJson: (dbPath, sql, label) => {
      calls.push({ dbPath, sql, label });
      return [row()];
    },
  });

  assert.equal(messages.length, 1);
  assert.equal(calls[0].dbPath, "/abs/db.sqlite");
  assert.equal(calls[0].label, "read messages");
  assert.match(calls[0].sql, /direction = 'received'/);
  assert.match(calls[0].sql, /body LIKE '%O''Hara%'/);
  assert.match(calls[0].sql, /LIMIT 7/);
});

test("messages view renders system sender without unknown", () => {
  const message = enrichRow(row({
    actor_id: null,
    canonical_json: JSON.stringify({
      chat_type: "group",
      chat_name: "Shape Group",
      msg_type: "system",
    }),
  }));
  const output = plain(renderMessagesText([message]));

  assert.match(output, /Messages \(1\)/);
  assert.match(output, /发送人\s+系统/);
  assert.match(output, /类型\s+system \/ 系统/);
  assert.doesNotMatch(output, /发送人\s+unknown/);
});

test("messages CLI renders text, json, help, and dependency errors", () => {
  const message = enrichRow(row({
    canonical_json: JSON.stringify({
      chat_type: "group",
      chat_name: "Shape Group",
      msg_type: "text",
      sender_id: "ou_sender",
      sender_name: "Sender User",
      sender_type: "user",
    }),
  }));
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const exitText = runMessagesCli(["--limit", "1"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    deps: {
      resolvePath: (dbPath) => `/abs/${dbPath}`,
      existsSync: () => true,
      loadMessages: () => [message],
    },
  });

  assert.equal(exitText, 0);
  assert.equal(stderr.text(), "");
  assert.match(plain(stdout.text()), /Sender User/);

  const jsonOut = memoryWriter();
  const exitJson = runMessagesCli(["--format", "json"], {
    stdout: jsonOut.stream,
    deps: {
      resolvePath: (dbPath) => `/abs/${dbPath}`,
      existsSync: () => true,
      loadMessages: () => [message],
    },
  });
  assert.equal(exitJson, 0);
  assert.equal(JSON.parse(jsonOut.text())[0].display.sender, "Sender User");

  const helpOut = memoryWriter();
  assert.equal(runMessagesCli(["--help"], { stdout: helpOut.stream }), 0);
  assert.match(helpOut.text(), /Usage: node scripts\/messages\.mjs/);

  const errorOut = memoryWriter();
  const exitError = runMessagesCli(["--db", "missing.sqlite"], {
    stderr: errorOut.stream,
    deps: {
      resolvePath: (dbPath) => `/abs/${dbPath}`,
      existsSync: () => false,
    },
  });
  assert.equal(exitError, 1);
  assert.match(plain(errorOut.text()), /database not found/);
});
