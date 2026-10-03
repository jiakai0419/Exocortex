import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLagReport,
  exitCodeForReport,
  normalizeRemoteMessage,
} from "../src/diagnostics/lark-im-lag-core.mjs";
import { HOT_CHATS, REMOTE_MESSAGES, SELF_OPEN_ID } from "./fixtures/lark-im-lag-shapes.mjs";

const opts = {
  startMs: 1000000000000,
  endMs: 1000000300000,
  hotChats: 2,
  messagesPerChat: 5,
};

function normalizedRemoteMessages() {
  return REMOTE_MESSAGES.map((message) => normalizeRemoteMessage(message, HOT_CHATS[0], SELF_OPEN_ID)).filter(Boolean);
}

test("lag core normalizes synthetic lark message shapes and ignores self messages", () => {
  const messages = normalizedRemoteMessages();

  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map((message) => message.message_id),
    ["om_unit_lag_text", "om_unit_lag_card"],
  );
  assert.equal(messages[0].sender_name, "Synthetic Sender");
  assert.equal(messages[1].sender_name, "Synthetic App");
  assert.match(messages[1].body, /Unit test card/);
});

test("lag core reports healthy when synthetic remote messages already exist locally", () => {
  const remoteMessages = normalizedRemoteMessages();
  const existingRecords = new Set(remoteMessages.map((message) => message.message_id));
  const report = buildLagReport({
    opts,
    chats: HOT_CHATS,
    remoteMessages,
    existingRecords,
    latestLocal: {
      external_id: "om_unit_lag_card",
      occurred_at_ms: 1000000060000,
      occurred_at: new Date(1000000060000).toISOString(),
      chat_name: "Synthetic Room 2",
      direction: "received",
    },
    checkedAt: new Date("2026-06-16T00:00:00.000Z"),
  });

  assert.equal(report.status, "healthy");
  assert.equal(report.ok, true);
  assert.equal(report.missing_count, 0);
  assert.equal(report.latest_remote.message_id, "om_unit_lag_card");
  assert.equal(report.latest_remote.exists_locally, true);
  assert.equal(exitCodeForReport(report), 0);
});

test("lag core reports delayed when an synthetic remote message is missing locally", () => {
  const remoteMessages = normalizedRemoteMessages();
  const report = buildLagReport({
    opts,
    chats: HOT_CHATS,
    remoteMessages,
    existingRecords: new Set(["om_unit_lag_text"]),
    latestLocal: {
      external_id: "om_unit_lag_text",
      occurred_at_ms: 1000000000000,
      occurred_at: new Date(1000000000000).toISOString(),
      chat_name: "Synthetic Room 1",
      direction: "received",
    },
  });

  assert.equal(report.status, "delayed");
  assert.equal(report.ok, false);
  assert.equal(report.missing_count, 1);
  assert.equal(report.missing[0].message_id, "om_unit_lag_card");
  assert.equal(exitCodeForReport(report), 2);
});

test("lag core reports needs_attention when the live probe has remote API errors", () => {
  const report = buildLagReport({
    opts,
    chats: HOT_CHATS,
    remoteMessages: [],
    existingRecords: new Set(),
    latestLocal: null,
    probeErrors: [{ chat_id: "oc_unit_lag_alpha", chat_name: "Synthetic Room 1", error: "redacted API error" }],
  });

  assert.equal(report.status, "needs_attention");
  assert.equal(report.ok, false);
  assert.equal(report.probe.probe_errors, 1);
  assert.equal(exitCodeForReport(report), 2);
});

test("lag core treats empty chat and remote-message samples as inconclusive", () => {
  const noChats = buildLagReport({
    opts,
    chats: [],
    remoteMessages: [],
    existingRecords: new Set(),
  });
  const noMessages = buildLagReport({
    opts,
    chats: HOT_CHATS,
    remoteMessages: [],
    existingRecords: new Set(),
  });

  assert.equal(noChats.status, "inconclusive");
  assert.equal(noChats.reason, "no_hot_chats");
  assert.equal(noChats.ok, false);
  assert.equal(exitCodeForReport(noChats), 2);
  assert.equal(noMessages.status, "inconclusive");
  assert.equal(noMessages.reason, "no_usable_remote_messages");
  assert.equal(noMessages.ok, false);
  assert.equal(exitCodeForReport(noMessages), 2);
});
