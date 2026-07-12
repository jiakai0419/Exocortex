import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchMessageWindowWithBisection,
  prepareRecords,
  readBoundedPages,
} from "../src/adapters/lark-im/core.mjs";
import { PaginationLimitError } from "../dist/core/sync.js";
import { readBoundedPages as shimReadBoundedPages } from "../scripts/lib/lark-im-core.mjs";

function message(id, occurredAtMs) {
  return {
    message_id: id,
    create_time: String(Math.floor(occurredAtMs / 1000)),
    msg_type: "text",
    sender: { id: "ou_sender", id_type: "open_id", sender_type: "user", name: "Sender" },
    chat_id: "oc_chat",
    chat_type: "group",
    chat_name: "Group",
    content: `body ${id}`,
  };
}

test("readBoundedPages reads every page before returning success", () => {
  const calls = [];
  const pages = {
    "": { messages: [message("om_1", 1000)], has_more: true, page_token: "p2" },
    p2: { messages: [message("om_2", 2000)], has_more: false, page_token: "" },
  };

  const result = readBoundedPages({
    maxPages: 5,
    missingPageTokenMessage: "missing token",
    maxPagesMessage: (maxPages) => `still has more after ${maxPages}`,
    fetchPage: (pageToken) => {
      calls.push(pageToken);
      return pages[pageToken];
    },
  });

  assert.deepEqual(calls, ["", "p2"]);
  assert.equal(result.pages, 2);
  assert.deepEqual(result.messages.map((item) => item.message_id), ["om_1", "om_2"]);
});

test("lark im core shim re-exports the src implementation", () => {
  assert.equal(shimReadBoundedPages, readBoundedPages);
});

test("readBoundedPages fails when a continuing page lacks a page token", () => {
  assert.throws(
    () =>
      readBoundedPages({
        maxPages: 5,
        missingPageTokenMessage: "missing token",
        maxPagesMessage: (maxPages) => `still has more after ${maxPages}`,
        fetchPage: () => ({ messages: [], has_more: true, page_token: "" }),
      }),
    /missing token/,
  );
});

test("readBoundedPages fails instead of checkpointing when max pages are exhausted", () => {
  assert.throws(
    () =>
      readBoundedPages({
        maxPages: 2,
        missingPageTokenMessage: "missing token",
        maxPagesMessage: (maxPages) => `still has more after ${maxPages}`,
        fetchPage: (pageToken) => ({
          messages: [message(`om_${pageToken || "first"}`, 1000)],
          has_more: true,
          page_token: pageToken ? `${pageToken}_next` : "p2",
        }),
      }),
    /still has more after 2/,
  );
});

test("prepareRecords sorts unordered fake adapter messages and applies cursor tie-breaker", () => {
  const base = 1700000000000;
  const records = prepareRecords(
    [
      message("om_c", base + 1000),
      message("om_a", base),
      message("om_b", base),
      message("om_old", base - 1000),
    ],
    "lark.im.received.chat.fake",
    "received",
    { created_at_ms: base, message_id: "om_a" },
    base - 10_000,
    base + 10_000,
  );

  assert.deepEqual(records.map((record) => record.external_id), ["om_b", "om_c"]);
});

test("prepareRecords fails the whole page on missing ids or invalid timestamps", () => {
  const base = 1700000000000;
  assert.throws(
    () => prepareRecords([{ ...message("om_valid", base), message_id: "" }], "scope", "sent", null, 0, base),
    /missing a valid message_id/,
  );
  assert.throws(
    () => prepareRecords([{ ...message("om_bad", base), create_time: "not-a-time" }], "scope", "sent", null, 0, base),
    /invalid create_time/,
  );
  assert.throws(
    () => prepareRecords([{ ...message("om_bad_version", base), update_time: "not-a-time" }], "scope", "sent", null, 0, base),
    /invalid update_time/,
  );
});

test("message update_time is normalized to a comparable millisecond version", () => {
  const base = 1700000000000;
  const [record] = prepareRecords(
    [{ ...message("om_versioned", base), update_time: "1700000001" }],
    "scope",
    "sent",
    null,
    0,
    base,
  );
  assert.equal(record.external_version, "1700000001000");
  assert.equal(JSON.parse(record.canonical_json).update_time_ms, 1700000001000);
});

test("message window bisection returns one complete prefix for this run", () => {
  const startMs = Date.parse("2026-06-20T00:00:00.000Z");
  const calls = [];
  const result = fetchMessageWindowWithBisection((windowStartMs, windowEndMs) => {
    calls.push([windowStartMs, windowEndMs]);
    if (windowEndMs - windowStartMs > 2 * 60_000) {
      throw new PaginationLimitError("too many pages", 2);
    }
    return { messages: [message("om_prefix", windowEndMs)], pages: 2 };
  }, startMs, startMs + 8 * 60_000);

  assert.deepEqual(calls, [
    [startMs, startMs + 8 * 60_000],
    [startMs, startMs + 4 * 60_000],
    [startMs, startMs + 2 * 60_000],
  ]);
  assert.equal(result.window_end_ms, startMs + 2 * 60_000);
  assert.equal(result.requested_window_end_ms, startMs + 8 * 60_000);
  assert.equal(result.window_bisections, 2);
});

test("message window bisection fails explicitly when one cursor unit is saturated", () => {
  const startMs = Date.parse("2026-06-20T00:00:00.000Z");
  assert.throws(
    () => fetchMessageWindowWithBisection(() => {
      throw new PaginationLimitError("too many pages", 2);
    }, startMs, startMs + 60_000),
    /one 60000ms message window still exceeds the page limit/,
  );
});
