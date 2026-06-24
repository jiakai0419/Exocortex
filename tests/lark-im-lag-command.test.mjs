import assert from "node:assert/strict";
import test from "node:test";

import { plain } from "../dist/terminal/index.js";
import {
  parseArgs,
  runLagCheckCli,
  sanitizeLagReportForPublicOutput,
} from "../src/cli/lark-im-lag-command.mjs";
import { collectLagReport } from "../src/diagnostics/lark-im-lag-report.mjs";
import { renderLagText } from "../src/terminal/lark-im-lag-view.mjs";
import { HOT_CHATS, REMOTE_MESSAGES, SELF_OPEN_ID } from "./fixtures/lark-im-lag-shapes.mjs";

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

function opts(overrides = {}) {
  return {
    db: "data/exocortex.sqlite",
    chatPages: 2,
    hotChats: 2,
    messagesPerChat: 5,
    start: "2027-01-15T08:00:00+00:00",
    end: "2027-01-15T08:05:00+00:00",
    startMs: 1800000000000,
    endMs: 1800000300000,
    format: "text",
    ...overrides,
  };
}

function latestLocal(overrides = {}) {
  return {
    external_id: "om_shape_remote_card_002",
    occurred_at_ms: 1800000060000,
    occurred_at: new Date(1800000060000).toISOString(),
    chat_name: "Shape Group B",
    direction: "received",
    ...overrides,
  };
}

function healthyReport(overrides = {}) {
  return {
    ok: true,
    status: "healthy",
    checked_at: "2026-06-20T00:00:00.000Z",
    window: { start: "2027-01-15T08:00:00+00:00", end: "2027-01-15T08:05:00+00:00" },
    probe: {
      hot_chats_requested: 2,
      hot_chats_found: 2,
      messages_per_chat: 5,
      remote_messages_checked: 2,
      unsupported_chats: 0,
      probe_errors: 0,
    },
    latest_remote: {
      message_id: "om_shape_remote_card_002",
      created_at: new Date(1800000060000).toISOString(),
      chat_name: "Shape Group B",
      sender_name: "Shape App",
      body: "Private shape card title",
      exists_locally: true,
    },
    latest_local: {
      message_id: "om_shape_remote_card_002",
      created_at: new Date(1800000060000).toISOString(),
      chat_name: "Shape Group B",
      direction: "received",
    },
    lag_ms: 0,
    missing_count: 0,
    missing: [],
    unsupported_chats: [],
    probe_errors: [],
    ...overrides,
  };
}

test("lag command parseArgs keeps explicit time windows stable", () => {
  const parsed = parseArgs([
    "--db",
    "custom.sqlite",
    "--chat-pages",
    "3",
    "--hot-chats",
    "4",
    "--messages-per-chat",
    "2",
    "--start",
    "2027-01-15T08:00:00+00:00",
    "--end",
    "2027-01-15T08:05:00+00:00",
    "--format",
    "json",
  ]);

  assert.equal(parsed.db, "custom.sqlite");
  assert.equal(parsed.chatPages, 3);
  assert.equal(parsed.hotChats, 4);
  assert.equal(parsed.messagesPerChat, 2);
  assert.equal(parsed.startMs, 1800000000000);
  assert.equal(parsed.endMs, 1800000300000);
  assert.equal(parsed.format, "json");
  assert.equal(parsed.unsafeDetails, false);
  assert.equal(parseArgs(["--unsafe-details"]).unsafeDetails, true);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["--hot-chats", "0"]), /hot-chats must be positive/);
  assert.throws(() => parseArgs(["--format", "yaml"]), /--format must be text or json/);
});

test("lag report collects healthy anonymized remote messages through fake deps", () => {
  const report = collectLagReport("/abs/db.sqlite", opts(), {
    getSelfOpenId: () => SELF_OPEN_ID,
    fetchHotChats: () => HOT_CHATS,
    fetchRecentChatMessages: (chat) => (chat.chat_id === HOT_CHATS[0].chat_id ? REMOTE_MESSAGES : []),
    loadExistingRecords: () => new Set(["om_shape_remote_text_001", "om_shape_remote_card_002"]),
    localLatest: () => latestLocal(),
  });

  assert.equal(report.status, "healthy");
  assert.equal(report.ok, true);
  assert.equal(report.probe.hot_chats_found, 2);
  assert.equal(report.probe.remote_messages_checked, 2);
  assert.equal(report.latest_remote.message_id, "om_shape_remote_card_002");
  assert.equal(report.latest_remote.exists_locally, true);
});

test("lag report classifies missing remote messages as delayed", () => {
  const report = collectLagReport("/abs/db.sqlite", opts(), {
    getSelfOpenId: () => SELF_OPEN_ID,
    fetchHotChats: () => HOT_CHATS,
    fetchRecentChatMessages: (chat) => (chat.chat_id === HOT_CHATS[0].chat_id ? REMOTE_MESSAGES : []),
    loadExistingRecords: () => new Set(["om_shape_remote_text_001"]),
    localLatest: () => latestLocal({
      external_id: "om_shape_remote_text_001",
      occurred_at_ms: 1800000000000,
      occurred_at: new Date(1800000000000).toISOString(),
      chat_name: "Shape Group A",
    }),
  });

  assert.equal(report.status, "delayed");
  assert.equal(report.ok, false);
  assert.equal(report.missing_count, 1);
  assert.equal(report.missing[0].message_id, "om_shape_remote_card_002");
  assert.match(plain(renderLagText(report)), /Lark IM lag check DELAYED/);
  assert.match(plain(renderLagText(report)), /Missing/);
});

test("lag report separates restricted chats from remote probe errors", () => {
  const restricted = collectLagReport("/abs/db.sqlite", opts(), {
    getSelfOpenId: () => SELF_OPEN_ID,
    fetchHotChats: () => HOT_CHATS,
    fetchRecentChatMessages: () => {
      throw new Error('{"code":231203,"msg":"Restricted Mode"}');
    },
    loadExistingRecords: () => new Set(),
    localLatest: () => null,
  });
  const failed = collectLagReport("/abs/db.sqlite", opts(), {
    getSelfOpenId: () => SELF_OPEN_ID,
    fetchHotChats: () => HOT_CHATS,
    fetchRecentChatMessages: () => {
      throw new Error("redacted remote API error");
    },
    loadExistingRecords: () => new Set(),
    localLatest: () => null,
  });

  assert.equal(restricted.status, "healthy");
  assert.equal(restricted.probe.unsupported_chats, 2);
  assert.equal(restricted.unsupported_chats[0].reason, "restricted_mode");
  assert.equal(failed.status, "needs_attention");
  assert.equal(failed.probe.probe_errors, 2);
  assert.match(plain(renderLagText(failed)), /Probe errors/);
});

test("lag check CLI renders text, json, help, and dependency errors", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const exitText = runLagCheckCli(["--start", opts().start, "--end", opts().end], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    deps: {
      resolvePath: (dbPath) => `/abs/${dbPath}`,
      existsSync: () => true,
      collect: () => healthyReport(),
    },
  });

  assert.equal(exitText, 0);
  assert.equal(stderr.text(), "");
  assert.match(plain(stdout.text()), /Lark IM lag check OK/);
  assert.doesNotMatch(plain(stdout.text()), /Shape Group B/);
  assert.doesNotMatch(plain(stdout.text()), /Shape App/);
  assert.doesNotMatch(plain(stdout.text()), /Private shape card title/);

  const unsafeOut = memoryWriter();
  const exitUnsafe = runLagCheckCli(["--start", opts().start, "--end", opts().end, "--unsafe-details"], {
    stdout: unsafeOut.stream,
    deps: {
      resolvePath: (dbPath) => `/abs/${dbPath}`,
      existsSync: () => true,
      collect: () => healthyReport(),
    },
  });
  assert.equal(exitUnsafe, 0);
  assert.match(plain(unsafeOut.text()), /Shape Group B/);
  assert.match(plain(unsafeOut.text()), /Shape App/);
  assert.match(plain(unsafeOut.text()), /Private shape card title/);

  const delayed = healthyReport({ ok: false, status: "delayed", missing_count: 1 });
  const jsonOut = memoryWriter();
  const exitJson = runLagCheckCli(["--start", opts().start, "--end", opts().end, "--format", "json"], {
    stdout: jsonOut.stream,
    deps: {
      resolvePath: (dbPath) => `/abs/${dbPath}`,
      existsSync: () => true,
      collect: () => delayed,
    },
  });
  assert.equal(exitJson, 2);
  const jsonReport = JSON.parse(jsonOut.text());
  assert.equal(jsonReport.status, "delayed");
  assert.equal(jsonReport.latest_remote.chat_name, "<redacted>");
  assert.equal(jsonReport.latest_remote.sender_name, "<redacted>");
  assert.equal(jsonReport.latest_remote.body, "<redacted>");
  assert.equal(jsonOut.text().includes("Shape Group B"), false);

  const helpOut = memoryWriter();
  assert.equal(runLagCheckCli(["--help"], { stdout: helpOut.stream }), 0);
  assert.match(helpOut.text(), /Usage: node scripts\/lark-im-lag-check\.mjs/);

  const missingDb = memoryWriter();
  assert.equal(runLagCheckCli(["--db", "missing.sqlite"], {
    stderr: missingDb.stream,
    deps: {
      resolvePath: (dbPath) => `/abs/${dbPath}`,
      existsSync: () => false,
    },
  }), 1);
  assert.match(plain(missingDb.text()), /database not found/);

  const keychain = memoryWriter();
  assert.equal(runLagCheckCli(["--start", opts().start, "--end", opts().end], {
    stderr: keychain.stream,
    deps: {
      resolvePath: (dbPath) => `/abs/${dbPath}`,
      existsSync: () => true,
      collect: () => {
        throw new Error("keychain Get failed: keychain not initialized");
      },
    },
  }), 1);
  assert.match(plain(keychain.text()), /keychain Get failed/);
});

test("lag public sanitizer removes local metadata and message excerpts", () => {
  const report = sanitizeLagReportForPublicOutput(healthyReport({
    missing: [
      {
        message_id: "om_private",
        created_at: new Date(1800000060000).toISOString(),
        chat_name: "Private Group",
        sender_name: "Private Sender",
        body: "Private missing body",
      },
    ],
    unsupported_chats: [{ chat_id: "oc_private", chat_name: "Private Group", reason: "restricted_mode" }],
    probe_errors: [{ chat_id: "oc_private", chat_name: "Private Group", error: "private API detail" }],
  }));

  const text = JSON.stringify(report);
  assert.equal(text.includes("om_private"), false);
  assert.equal(text.includes("oc_private"), false);
  assert.equal(text.includes("Private Group"), false);
  assert.equal(text.includes("Private Sender"), false);
  assert.equal(text.includes("Private missing body"), false);
  assert.equal(text.includes("private API detail"), false);
  assert.equal(report.missing[0].created_at, new Date(1800000060000).toISOString());
  assert.equal(report.unsupported_chats[0].reason, "restricted_mode");
});
