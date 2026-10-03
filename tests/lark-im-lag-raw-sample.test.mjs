import assert from "node:assert/strict";
import test from "node:test";
import { collectLagReport, fetchRecentChatMessages } from "../src/diagnostics/lark-im-lag-report.mjs";
import { sanitizeLagReportForPublicOutput } from "../src/diagnostics/lark-im-lag-core.mjs";

const chat = { chat_id: "oc_synthetic", chat_type: "group" };
const startMs = 1800000000123;
const endMs = startMs + 10000;
const opts = { startMs, endMs, hotChats: 1, messagesPerChat: 5, chatPages: 1 };
const message = (id, at = startMs + 1, extra = {}) => ({
  message_id: id, msg_type: "text", chat_id: chat.chat_id, create_time: String(at),
  sender: { id: "ou_synthetic_peer", id_type: "open_id", sender_type: "user" },
  body: { content: JSON.stringify({ text: "Synthetic content" }) }, ...extra,
});
const page = (items, extra = {}) => ({ ok: true, identity: "user", data: { items, has_more: false, ...extra } });

test("live sample uses one explicit raw descending list, includes replies and clips millisecond bounds", () => {
  const calls = [];
  const items = [message("after", endMs + 1), message("end", endMs), message("reply", startMs + 1, { root_id: "root", parent_id: "root", thread_id: "thread" }), message("start", startMs), message("before", startMs - 1)];
  const sampled = fetchRecentChatMessages(chat, opts, {
    runLark: (args) => { calls.push(args); return page(items, { has_more: true, page_token: "synthetic-next" }); },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 5), ["api", "GET", "/open-apis/im/v1/messages", "--as", "user"]);
  assert.deepEqual(JSON.parse(calls[0][calls[0].indexOf("--params") + 1]), {
    container_id_type: "chat", container_id: chat.chat_id, only_thread_root_messages: false,
    sort_type: "ByCreateTimeDesc", page_size: 5, card_msg_content_type: "raw_card_content",
    start_time: String(Math.floor(startMs / 1000)), end_time: String(Math.ceil(endMs / 1000)),
  });
  assert.deepEqual(sampled.map((item) => item.message_id), ["end", "reply", "start"]);
  assert.equal(sampled[1].thread_id, "thread");
  assert.equal(sampled[1].content, sampled[1].body.content);
});

test("first-page sampling clamps requests to 50 and does not expand merged messages", () => {
  const calls = [];
  const merged = message("merged", startMs + 1, { msg_type: "merge_forward", body: { content: JSON.stringify({ message_ids: ["hidden-child"] }) } });
  const result = fetchRecentChatMessages(chat, { ...opts, messagesPerChat: 500 }, {
    runLark: (args) => { calls.push(args); return { code: 0, data: { items: [merged], has_more: false } }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0][6]).page_size, 50);
  assert.deepEqual(result.map((item) => item.message_id), ["merged"]);
});

test("malformed or unsuccessful raw pages fail closed before a healthy sample can be reported", () => {
  const badPages = [
    null, {}, { data: { items: [], has_more: false } },
    { ok: false, data: { items: [], has_more: false } },
    { ok: true, code: 123, data: { items: [], has_more: false } },
    { code: 0, data: { has_more: false } },
    page([], { has_more: "false" }), page([], { has_more: true }),
    page([message("", startMs + 1)]), page([message("bad-time", "invalid")]),
    page([message("bad-body", startMs + 1, { body: null })]),
    page([message("wrong-chat", startMs + 1, { chat_id: "oc_other" })]),
    page(Array.from({ length: 6 }, (_, i) => message(`overflow-${i}`))),
  ];
  for (const response of badPages) {
    assert.throws(() => fetchRecentChatMessages(chat, opts, { runLark: () => response }));
    const report = collectLagReport("synthetic.sqlite", opts, {
      getSelfOpenId: () => "ou_synthetic_self", fetchHotChats: () => [chat],
      runLark: () => response, loadExistingRecords: () => new Set(), localLatest: () => null,
    });
    assert.equal(report.status, "needs_attention");
    assert.equal(report.probe.probe_errors, 1);
  }
});

test("received replies participate in ID-presence checks without claiming body reconciliation", () => {
  const root = message("root");
  const reply = message("reply", startMs + 2, { root_id: "root", parent_id: "root", thread_id: "thread" });
  const report = collectLagReport("synthetic.sqlite", opts, {
    getSelfOpenId: () => "ou_synthetic_self", fetchHotChats: () => [chat],
    runLark: () => page([reply, root]), loadExistingRecords: () => new Set(["root"]), localLatest: () => null,
  });
  assert.equal(report.status, "delayed");
  assert.equal(report.probe.remote_messages_checked, 2);
  assert.equal(report.missing[0].message_id, "reply");
  const safe = sanitizeLagReportForPublicOutput(report);
  assert.equal(safe.probe.mode, "raw_first_page_including_replies");
  assert.equal(safe.probe.comparison, "message_id_presence");
  assert.equal(safe.missing[0].body, "<redacted>");
});

test("invalid request bounds make no API call and empty clipped samples remain inconclusive", () => {
  for (const invalid of [{ messagesPerChat: 0 }, { startMs: -1 }, { endMs: startMs }]) {
    assert.throws(() => fetchRecentChatMessages(chat, { ...opts, ...invalid }, {
      runLark: () => { assert.fail("invalid input must not spawn"); },
    }));
  }
  const report = collectLagReport("synthetic.sqlite", opts, {
    getSelfOpenId: () => "ou_synthetic_self", fetchHotChats: () => [chat],
    runLark: () => page([message("outside", endMs + 1)]), loadExistingRecords: () => new Set(), localLatest: () => null,
  });
  assert.equal(report.status, "inconclusive");
  assert.equal(report.probe.remote_messages_checked, 0);
});
