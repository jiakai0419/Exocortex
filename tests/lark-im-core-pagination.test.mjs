import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchMessageWindowWithBisection,
  MessageWindowBudgetError,
  MessageDetailsIncompleteError,
  prepareRecords,
  readBoundedPages,
} from "../src/adapters/lark-im/core.mjs";
import { PaginationLimitError } from "../dist/core/sync.js";

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

test("a shared native deadline shrinks a month window directly to one aligned cursor unit", () => {
  const startMs = Date.parse("2026-07-01T00:00:30.125Z");
  const target = startMs + 33 * 86_400_000;
  const minimum = Date.parse("2026-07-01T00:01:00.000Z");
  const calls = [];
  const result = fetchMessageWindowWithBisection((start, end) => {
    calls.push([start, end]);
    if (end !== minimum) throw new MessageWindowBudgetError("message_history_bundle");
    return { messages: [], pages: 1 };
  }, startMs, target);
  assert.deepEqual(calls, [[startMs, target], [startMs, minimum]]);
  assert.equal(result.window_end_ms, minimum);
  assert.equal(result.window_bisections, 1);
});

test("an exhausted smallest prefix stops after one timeout retry without fabricating progress", () => {
  const startMs = Date.parse("2026-07-01T00:00:00Z");
  for (const width of [0, 30_000, 60_000, 33 * 86_400_000]) {
    let calls = 0;
    assert.throws(() => fetchMessageWindowWithBisection(() => {
      calls += 1;
      throw new MessageWindowBudgetError("message_search_bundle");
    }, startMs, startMs + width), (error) => {
      assert.equal(error.name, "MessageWindowBudgetSaturatedError");
      assert.match(error.message, /shared time budget/);
      return true;
    });
    assert.equal(calls, width > 60_000 ? 2 : 1);
  }
});

test("ordinary transport timeouts and rate limits never trigger window bisection", () => {
  for (const kind of ["network_timeout", "rate_limited", "permission_denied", "network_error"]) {
    const error = new Error(`lark-cli failed: kind=${kind} retry_exhausted=1`);
    let calls = 0;
    assert.throws(() => fetchMessageWindowWithBisection(() => {
      calls += 1;
      throw error;
    }, 0, 33 * 86_400_000), (actual) => actual === error);
    assert.equal(calls, 1);
  }
});

test("incomplete detail evidence retains the actual smaller attempted window and never returns success", () => {
  const failure = new MessageDetailsIncompleteError([], 1, [{ message_id: "synthetic-root", reason: "restricted_mode" }]);
  let calls = 0;
  assert.throws(() => fetchMessageWindowWithBisection(() => {
    calls += 1;
    if (calls === 1) throw new MessageWindowBudgetError("message_history_bundle");
    throw failure;
  }, 0, 10 * 60_000), (error) => error === failure);
  assert.equal(failure.windowEndMs, 60_000);
  assert.equal(failure.windowBisections, 1);
  assert.equal(calls, 2);
});

test("a page cap followed by a shared deadline permits only the remaining minimum-prefix attempt", () => {
  const ends = [];
  const result = fetchMessageWindowWithBisection((_start, end) => {
    ends.push(end);
    if (ends.length === 1) throw new PaginationLimitError("synthetic page cap", 2);
    if (ends.length === 2) throw new MessageWindowBudgetError("message_history_bundle");
    return { messages: [], pages: 1 };
  }, 0, 8 * 60_000);
  assert.deepEqual(ends, [8 * 60_000, 4 * 60_000, 60_000]);
  assert.equal(result.window_end_ms, 60_000);
  assert.equal(result.window_bisections, 2);
});
