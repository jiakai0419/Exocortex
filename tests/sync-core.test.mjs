import assert from "node:assert/strict";
import test from "node:test";

import {
  compareRecordToCursor,
  readPaginatedPages,
  stableWindowEndMs,
  timeCursorAfter,
  timeWindow,
  windowRecordsAfterCursor,
} from "../dist/core/sync.js";

function record(id, occurredAtMs) {
  return {
    external_id: id,
    occurred_at_ms: occurredAtMs,
    body: `body ${id}`,
  };
}

test("generic cursor comparison uses time plus external id tie-breaker", () => {
  const base = 1700000000000;
  assert.equal(compareRecordToCursor(record("b", base), { created_at_ms: base, message_id: "a" }, base), 1);
  assert.equal(compareRecordToCursor(record("a", base), { created_at_ms: base, message_id: "b" }, base), -1);
  assert.equal(compareRecordToCursor(record("a", base), null, base), 1);
});

test("windowRecordsAfterCursor filters by cursor and stable end, then sorts", () => {
  const base = 1700000000000;
  const records = windowRecordsAfterCursor(
    [
      record("c", base + 1000),
      record("future", base + 3000),
      record("a", base),
      record("old", base - 1000),
      record("b", base),
    ],
    { created_at_ms: base, message_id: "a" },
    base - 10_000,
    base + 1000,
    (item) => item.external_id !== "old",
  );

  assert.deepEqual(records.map((item) => item.external_id), ["b", "c"]);
});

test("timeCursorAfter makes source time precision explicit", () => {
  const cursor = timeCursorAfter({
    endMs: Date.parse("2026-06-16T08:30:45.000Z"),
    precisionMs: 60_000,
    sourceTimePrecision: "minute",
    kind: "time_message_cursor/v1",
    now: () => new Date("2026-06-16T08:31:00.000Z"),
  });

  assert.deepEqual(cursor, {
    kind: "time_message_cursor/v1",
    meaning: "scanned_until_inclusive",
    source_time_precision: "minute",
    created_at_ms: Date.parse("2026-06-16T08:30:00.000Z"),
    message_id: "",
    updated_at: "2026-06-16T08:31:00.000Z",
  });
});

test("timeWindow applies stable horizon unless the end is explicit", () => {
  assert.deepEqual(
    timeWindow({ cursor: null }, { startMs: 1000, endMs: 100000, stableHorizonMs: 30000 }),
    { startMs: 1000, endMs: 70000 },
  );
  assert.deepEqual(
    timeWindow(
      { cursor: { created_at_ms: 90000 } },
      { startMs: 1000, endMs: 100000, stableHorizonMs: 30000 },
    ),
    { startMs: 90000, endMs: 90000 },
  );
  assert.equal(
    stableWindowEndMs({ startMs: 1000, endMs: 100000, stableHorizonMs: 30000, endExplicit: true }, 1000),
    100000,
  );
});

test("readPaginatedPages requires complete pagination before success", () => {
  const calls = [];
  const pages = {
    "": { items: ["first"], has_more: true, page_token: "p2" },
    p2: { items: ["second"], has_more: false, page_token: "" },
  };

  const result = readPaginatedPages({
    maxPages: 5,
    missingPageTokenMessage: "missing token",
    maxPagesMessage: (maxPages) => `still has more after ${maxPages}`,
    fetchPage: (pageToken) => {
      calls.push(pageToken);
      return pages[pageToken];
    },
    getItems: (page) => page.items,
    getHasMore: (page) => page.has_more,
    getPageToken: (page) => page.page_token,
  });

  assert.deepEqual(calls, ["", "p2"]);
  assert.deepEqual(result, { items: ["first", "second"], pages: 2 });
});

test("readPaginatedPages fails on unsafe pagination boundaries", () => {
  assert.throws(
    () =>
      readPaginatedPages({
        maxPages: 5,
        missingPageTokenMessage: "missing token",
        maxPagesMessage: (maxPages) => `still has more after ${maxPages}`,
        fetchPage: () => ({ items: [], has_more: true, page_token: "" }),
        getItems: (page) => page.items,
        getHasMore: (page) => page.has_more,
        getPageToken: (page) => page.page_token,
      }),
    /missing token/,
  );

  assert.throws(
    () =>
      readPaginatedPages({
        maxPages: 2,
        missingPageTokenMessage: "missing token",
        maxPagesMessage: (maxPages) => `still has more after ${maxPages}`,
        fetchPage: (pageToken) => ({ items: [pageToken || "first"], has_more: true, page_token: "next" }),
        getItems: (page) => page.items,
        getHasMore: (page) => page.has_more,
        getPageToken: (page) => page.page_token,
      }),
    /still has more after 2/,
  );
});
