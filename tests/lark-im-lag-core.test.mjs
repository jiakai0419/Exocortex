import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLagReport,
  exitCodeForReport,
  normalizeRemoteMessage,
} from "../src/diagnostics/lark-im-lag-core.mjs";
import { HOT_CHATS, REMOTE_MESSAGES, SELF_OPEN_ID } from "./fixtures/lark-im-lag-shapes.mjs";

const opts = {
  startMs: 1800000000000,
  endMs: 1800000300000,
  hotChats: 2,
  messagesPerChat: 5,
};

function normalizedRemoteMessages() {
  return REMOTE_MESSAGES.map((message) => normalizeRemoteMessage(message, HOT_CHATS[0], SELF_OPEN_ID)).filter(Boolean);
}

test("lag core normalizes anonymized lark message shapes and ignores self messages", () => {
  const messages = normalizedRemoteMessages();

  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map((message) => message.message_id),
    ["om_shape_remote_text_001", "om_shape_remote_card_002"],
  );
  assert.equal(messages[0].sender_name, "Shape Person A");
  assert.equal(messages[1].sender_name, "Shape App");
  assert.match(messages[1].body, /redacted card title/);
});

test("lag core reports healthy when anonymized remote messages already exist locally", () => {
  const remoteMessages = normalizedRemoteMessages();
  const existingRecords = new Set(remoteMessages.map((message) => message.message_id));
  const report = buildLagReport({
    opts,
    chats: HOT_CHATS,
    remoteMessages,
    existingRecords,
    latestLocal: {
      external_id: "om_shape_remote_card_002",
      occurred_at_ms: 1800000060000,
      occurred_at: new Date(1800000060000).toISOString(),
      chat_name: "Shape Group B",
      direction: "received",
    },
    checkedAt: new Date("2026-06-16T00:00:00.000Z"),
  });

  assert.equal(report.status, "healthy");
  assert.equal(report.ok, true);
  assert.equal(report.missing_count, 0);
  assert.equal(report.latest_remote.message_id, "om_shape_remote_card_002");
  assert.equal(report.latest_remote.exists_locally, true);
  assert.equal(exitCodeForReport(report), 0);
});

test("lag core reports delayed when an anonymized remote message is missing locally", () => {
  const remoteMessages = normalizedRemoteMessages();
  const report = buildLagReport({
    opts,
    chats: HOT_CHATS,
    remoteMessages,
    existingRecords: new Set(["om_shape_remote_text_001"]),
    latestLocal: {
      external_id: "om_shape_remote_text_001",
      occurred_at_ms: 1800000000000,
      occurred_at: new Date(1800000000000).toISOString(),
      chat_name: "Shape Group A",
      direction: "received",
    },
  });

  assert.equal(report.status, "delayed");
  assert.equal(report.ok, false);
  assert.equal(report.missing_count, 1);
  assert.equal(report.missing[0].message_id, "om_shape_remote_card_002");
  assert.equal(exitCodeForReport(report), 2);
});

test("lag core reports needs_attention when the live probe has remote API errors", () => {
  const report = buildLagReport({
    opts,
    chats: HOT_CHATS,
    remoteMessages: [],
    existingRecords: new Set(),
    latestLocal: null,
    probeErrors: [{ chat_id: "oc_shape_hot_group_001", chat_name: "Shape Group A", error: "redacted API error" }],
  });

  assert.equal(report.status, "needs_attention");
  assert.equal(report.ok, false);
  assert.equal(report.probe.probe_errors, 1);
  assert.equal(exitCodeForReport(report), 2);
});
