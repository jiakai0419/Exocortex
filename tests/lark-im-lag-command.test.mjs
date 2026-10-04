import assert from "node:assert/strict";
import test from "node:test";

import { plain } from "../dist/terminal/index.js";
import { sanitizeLagReportForPublicOutput } from "../src/diagnostics/lark-im-lag-core.mjs";
import {
  collectLagReport,
  fetchHotChats,
} from "../src/diagnostics/lark-im-lag-report.mjs";
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
    start: "2001-09-09T01:46:40+00:00",
    end: "2001-09-09T01:51:40+00:00",
    startMs: 1000000000000,
    endMs: 1000000300000,
    format: "text",
    ...overrides,
  };
}

function latestLocal(overrides = {}) {
  return {
    external_id: "om_unit_lag_card",
    occurred_at_ms: 1000000060000,
    occurred_at: new Date(1000000060000).toISOString(),
    chat_name: "Synthetic Room 2",
    direction: "received",
    ...overrides,
  };
}

function healthyReport(overrides = {}) {
  return {
    ok: true,
    status: "healthy",
    checked_at: "2026-06-20T00:00:00.000Z",
    window: { start: "2001-09-09T01:46:40+00:00", end: "2001-09-09T01:51:40+00:00" },
    probe: {
      hot_chats_requested: 2,
      hot_chats_found: 2,
      messages_per_chat: 5,
      remote_messages_checked: 2,
      unsupported_chats: 0,
      probe_errors: 0,
    },
    latest_remote: {
      message_id: "om_unit_lag_card",
      created_at: new Date(1000000060000).toISOString(),
      chat_name: "Synthetic Room 2",
      sender_name: "Synthetic App",
      body: "Unit test card",
      exists_locally: true,
    },
    latest_local: {
      message_id: "om_unit_lag_card",
      created_at: new Date(1000000060000).toISOString(),
      chat_name: "Synthetic Room 2",
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

test("lag hot-chat probe covers group and p2p chats", () => {
  const calls = [];
  const chats = fetchHotChats(opts(), {
    runLark: (args) => {
      calls.push(args);
      return { chats: [], has_more: false };
    },
  });

  assert.deepEqual(chats, []);
  const typeIndex = calls[0].indexOf("--types");
  assert.equal(calls[0][typeIndex + 1], "group,p2p");
});

test("lag report collects healthy synthetic remote messages through fake deps", () => {
  const report = collectLagReport("/abs/db.sqlite", opts(), {
    getSelfOpenId: () => SELF_OPEN_ID,
    fetchHotChats: () => HOT_CHATS,
    fetchRecentChatMessages: (chat) => (chat.chat_id === HOT_CHATS[0].chat_id ? REMOTE_MESSAGES : []),
    loadExistingRecords: () => new Set(["om_unit_lag_text", "om_unit_lag_card"]),
    localLatest: () => latestLocal(),
  });

  assert.equal(report.status, "healthy");
  assert.equal(report.ok, true);
  assert.equal(report.probe.hot_chats_found, 2);
  assert.equal(report.probe.remote_messages_checked, 2);
  assert.equal(report.latest_remote.message_id, "om_unit_lag_card");
  assert.equal(report.latest_remote.exists_locally, true);
});

test("lag report classifies missing remote messages as delayed", () => {
  const report = collectLagReport("/abs/db.sqlite", opts(), {
    getSelfOpenId: () => SELF_OPEN_ID,
    fetchHotChats: () => HOT_CHATS,
    fetchRecentChatMessages: (chat) => (chat.chat_id === HOT_CHATS[0].chat_id ? REMOTE_MESSAGES : []),
    loadExistingRecords: () => new Set(["om_unit_lag_text"]),
    localLatest: () => latestLocal({
      external_id: "om_unit_lag_text",
      occurred_at_ms: 1000000000000,
      occurred_at: new Date(1000000000000).toISOString(),
      chat_name: "Synthetic Room 1",
    }),
  });

  assert.equal(report.status, "delayed");
  assert.equal(report.ok, false);
  assert.equal(report.missing_count, 1);
  assert.equal(report.missing[0].message_id, "om_unit_lag_card");
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

  assert.equal(restricted.status, "inconclusive");
  assert.equal(restricted.reason, "no_usable_remote_messages");
  assert.equal(restricted.ok, false);
  assert.equal(restricted.probe.unsupported_chats, 2);
  assert.equal(restricted.unsupported_chats[0].reason, "restricted_mode");
  assert.equal(failed.status, "needs_attention");
  assert.equal(failed.probe.probe_errors, 2);
  assert.match(plain(renderLagText(failed)), /Probe errors/);
});

test("lag public sanitizer removes local metadata and message excerpts", () => {
  const report = sanitizeLagReportForPublicOutput(healthyReport({
    missing: [
      {
        message_id: "om_private",
        created_at: new Date(1000000060000).toISOString(),
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
  assert.equal(report.missing[0].created_at, new Date(1000000060000).toISOString());
  assert.equal(report.unsupported_chats[0].reason, "restricted_mode");
});
