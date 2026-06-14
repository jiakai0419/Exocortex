import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareRecords,
  readBoundedPages,
} from "../scripts/lib/lark-im-core.mjs";

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
