import assert from "node:assert/strict";
import test from "node:test";

import { createLarkImAdapter } from "../src/adapters/lark-im/adapter.mjs";
import { MessageDetailsIncompleteError, MessageWindowBudgetError } from "../src/adapters/lark-im/core.mjs";
import { recordFromMessage } from "../src/adapters/lark-im/message-record.mjs";
import { transportOperation } from "../src/adapters/lark-im/transport.mjs";
import { PaginationLimitError } from "../dist/core/sync.js";

// All requests and clocks are injected. No CLI, accounts, files, or databases.
const LIST = "/open-apis/im/v1/messages";
const SEARCH = `${LIST}/search`;
const MGET = `${LIST}/mget`;
const BASE_MS = 1_800_000_000_000;
const PRIVATE = "synthetic-private-payload-must-not-appear-in-errors";
const options = (overrides = {}) => ({ pageSize: 50, maxPages: 5,
  chatPageSize: 100, chatTypes: "group,p2p", retries: 0, retryDelayMs: 0, ...overrides });

function raw(id, overrides = {}) {
  return { message_id: id, msg_type: "text", chat_id: "oc_synthetic",
    create_time: String(BASE_MS), update_time: String(BASE_MS + 1_234),
    updated: true, deleted: false, sender: { id: "ou_other", id_type: "open_id", sender_type: "user" },
    body: { content: JSON.stringify({ text: `body ${id}` }) }, ...overrides };
}

const merge = (id, overrides = {}) => raw(id, { msg_type: "merge_forward",
  body: { content: "synthetic merged forward" }, ...overrides });
const page = (items, hasMore = false, token = "") => ({ ok: true, data: {
  items, has_more: hasMore, ...(token !== "" ? { page_token: token } : {}),
} });
const details = (items, fields = {}) => ({ ok: true, data: { items, ...fields } });
const hits = (ids, hasMore = false, token = "") => page(
  ids.map((id) => ({ meta_data: { message_id: id } })), hasMore, token);

function flag(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function request(args, runOptions) {
  assert.equal(args[0], "api", "native ingestion must not call an enriching shortcut");
  assert.equal(flag(args, "--as"), "user");
  assert.equal(flag(args, "--format"), "json");
  assert.equal(args.includes("--page-all"), false);
  assert.equal(args[2].includes("?"), false, "query must be passed through --params");
  assert.deepEqual(runOptions.redactedFlags, ["--params", "--data"]);
  return { method: args[1], path: args[2], params: JSON.parse(flag(args, "--params")),
    body: flag(args, "--data") === undefined ? undefined : JSON.parse(flag(args, "--data")),
    options: runOptions };
}

function harness(respond, clock = () => 0) {
  const calls = [];
  const adapter = createLarkImAdapter({ clock, run(args, runOptions) {
    const call = request(args, runOptions);
    calls.push(call);
    return respond(call, calls.length);
  } });
  return { adapter, calls,
    received: (opts = options()) => adapter.fetchChatMessages("oc_synthetic", BASE_MS, BASE_MS + 60_000, opts),
    sent: (opts = options()) => adapter.fetchSentMessages("ou_self", BASE_MS, BASE_MS + 60_000, opts) };
}

function rejectsSafely(work, pattern) {
  assert.throws(work, (error) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, new RegExp(PRIVATE));
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test("native received requests all thread messages with outward-rounded seconds and preserves nine raw records", () => {
  const items = [raw("om_root", { create_time: String(BASE_MS + 1_500) }),
    ...Array.from({ length: 8 }, (_, index) => raw(`om_reply_${index}`, {
    parent_id: "om_root", root_id: "om_root", thread_id: "omt_synthetic", create_time: String(BASE_MS + 1_501 + index),
  }))];
  const before = structuredClone(items);
  const h = harness(() => page(items));
  const result = h.adapter.fetchChatMessages("oc_synthetic", BASE_MS + 999, BASE_MS + 60_001,
    options({ pageSize: 100 }));
  assert.equal(result.pages, 1);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].params, { container_id_type: "chat", container_id: "oc_synthetic",
    only_thread_root_messages: false, sort_type: "ByCreateTimeAsc", page_size: 50,
    card_msg_content_type: "raw_card_content", start_time: String(BASE_MS / 1000),
    end_time: String(BASE_MS / 1000 + 61) });
  assert.equal(h.calls[0].method, "GET");
  assert.equal(h.calls[0].path, LIST);
  assert.deepEqual(result.messages.map((item) => item.message_id), before.map((item) => item.message_id));
  const records = result.messages.map((item) => recordFromMessage(item, "synthetic.received", "received"));
  assert.equal(records.length, 9);
  records.forEach((record, index) => {
    assert.equal(record.body, `body ${before[index].message_id}`);
    assert.equal(record.external_version, String(BASE_MS + 1_234));
    assert.equal(record.occurred_at_ms, Number(before[index].create_time));
    assert.deepEqual(JSON.parse(record.raw_json), before[index]);
  });
  assert.deepEqual(items, before, "normalization must not rewrite source evidence");
});

test("native received and sent retain exact millisecond boundaries while rejecting malformed excluded items", () => {
  const items = [merge("om_before", { create_time: String(BASE_MS - 1) }),
    raw("om_start", { create_time: String(BASE_MS) }), raw("om_end", { create_time: String(BASE_MS + 60_000) }),
    merge("om_after", { create_time: String(BASE_MS + 60_001) })];
  for (const mode of ["received", "sent"]) {
    const build = (source) => harness((call) => {
      if (call.path === LIST) return page(source);
      if (call.path === SEARCH) return hits(source.map((item) => item.message_id));
      assert.equal(call.path, MGET, "out-of-window merges must not fetch details");
      assert.deepEqual(call.params.message_ids, source.map((item) => item.message_id),
        "mget closure is checked before applying exact local time bounds");
      return details(source);
    });
    const h = build(items);
    assert.deepEqual(h[mode]().messages.map((item) => item.message_id), ["om_start", "om_end"]);
    assert.equal(h.calls.length, mode === "received" ? 1 : 2);
    const invalid = build([raw(PRIVATE, { create_time: String(BASE_MS - 1), body: null }), ...items.slice(1)]);
    rejectsSafely(() => invalid[mode](), /invalid raw message/);
  }
});

test("native received follows only explicit continuation tokens and accepts both positive envelope forms", () => {
  const h = harness((call, number) => number === 1
    ? { code: 0, msg: "ok", data: { items: [raw("om_a")], has_more: true, page_token: "next" } }
    : page([raw("om_b")], false, "unused-final-token"));
  const result = h.received();
  assert.equal(result.pages, 2);
  assert.deepEqual(h.calls.map((call) => call.params.page_token), [undefined, "next"]);
  assert.deepEqual(result.messages.map((item) => item.message_id), ["om_a", "om_b"]);
});

test("native received rejects unsuccessful and malformed envelopes without echoing payloads", () => {
  const validData = { items: [raw(PRIVATE)], has_more: false };
  for (const response of [null, [], { data: validData }, { ok: false, data: validData },
    { ok: true, code: 429, data: validData }, { code: "0", data: validData },
    { ok: true, error: { message: PRIVATE }, data: validData }, { ok: true, data: [] },
    { ok: true }, { ok: true, data: { items: PRIVATE, has_more: false } },
    { ok: true, data: { items: [], has_more: "false" } }]) {
    const h = harness(() => response);
    rejectsSafely(() => h.received());
    assert.equal(h.calls.length, 1);
  }
});

test("native messages with incomplete source shapes fail before becoming empty successful records", () => {
  for (const item of [null, raw("", { body: { content: PRIVATE } }), raw(PRIVATE, { create_time: PRIVATE }),
    raw(PRIVATE, { update_time: PRIVATE }), raw(PRIVATE, { msg_type: "" }),
    raw(PRIVATE, { body: null }), raw(PRIVATE, { body: { content: { text: PRIVATE } } })]) {
    const h = harness(() => page([item]));
    rejectsSafely(() => h.received(), /message|create_time|update_time/);
  }
});

test("native received rejects missing, malformed, repeated and cyclic pagination tokens", () => {
  const sequences = [
    [page([], true)], [page([], true, " ")], [page([], true, 7)],
    [page([], true, "a"), page([], true, "a")],
    [page([], true, "a"), page([], true, "b"), page([], true, "a")],
    [page([], true, "a"), page([], false, "a")],
  ];
  for (const responses of sequences) {
    const h = harness((_call, number) => {
      assert.ok(number <= responses.length, "must not continue past a bad token");
      return responses[number - 1];
    });
    rejectsSafely(() => h.received(), /page_token/);
    assert.equal(h.calls.length, responses.length);
  }
});

test("native received page ceilings fail closed without issuing an extra request", () => {
  const h = harness((_call, number) => page([raw(`om_${number}`)], true, `p${number}`));
  assert.throws(() => h.received(options({ maxPages: 2 })), PaginationLimitError);
  assert.equal(h.calls.length, 2);
});

test("native invalid millisecond bounds and page limits are rejected before any request", () => {
  const h = harness(() => assert.fail("invalid options must not call the runner"));
  for (const [start, end, opts] of [[-1, 1, options()], [2, 1, options()], [NaN, 2, options()],
    [0, Infinity, options()], [0.5, 2, options()], [0, Number.MAX_SAFE_INTEGER, options()],
    [0, 1, options({ pageSize: 0 })], [0, 1, options({ maxPages: 0 })],
    [0, 1, options({ maxPages: 1.5 })]]) {
    assert.throws(() => h.adapter.fetchChatMessages("oc_synthetic", start, end, opts), /bounds|page limits/);
    assert.throws(() => h.adapter.fetchSentMessages("ou_self", start, end, opts), /bounds|page limits/);
  }
  assert.equal(h.calls.length, 0);
});

test("native sent preserves search filters, closes each page with mget, and restores search order", () => {
  const h = harness((call) => {
    if (call.path === SEARCH) return call.params.page_token === "next"
      ? hits(["om_c"]) : hits(["om_a", "om_b"], true, "next");
    assert.equal(call.path, MGET);
    assert.equal(call.method, "GET");
    assert.equal(call.params.card_msg_content_type, "raw_card_content");
    return details(call.params.message_ids.toReversed().map((id) => raw(id)));
  });
  const result = h.sent(options({ pageSize: 50 }));
  assert.deepEqual(h.calls.map((call) => call.path), [SEARCH, MGET, SEARCH, MGET]);
  assert.equal(h.calls[0].method, "POST");
  assert.deepEqual(h.calls[0].params, { page_size: 30 });
  assert.deepEqual(h.calls[0].body, { query: "", filter: { from_ids: ["ou_self"],
    time_range: { start_time: new Date(BASE_MS).toISOString().replace(".000Z", "Z"),
      end_time: new Date(BASE_MS + 60_000).toISOString().replace(".000Z", "Z") } } });
  assert.deepEqual(h.calls[1].params.message_ids, ["om_a", "om_b"]);
  assert.deepEqual(h.calls[2].params, { page_size: 30, page_token: "next" });
  assert.equal(result.pages, 2);
  assert.deepEqual(result.messages.map((item) => item.message_id), ["om_a", "om_b", "om_c"]);
});

test("native sent empty search pages do not trigger mget", () => {
  const h = harness((_call, number) => number === 1 ? hits([], true, "next") : hits([]));
  assert.deepEqual(h.sent(), { messages: [], pages: 2 });
  assert.deepEqual(h.calls.map((call) => call.path), [SEARCH, SEARCH]);
});

test("native search time_range obeys the official second-only ISO8601 regex and clips fractional bounds locally", () => {
  // Public search API field validation explicitly excludes fractional seconds.
  const isoSeconds = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(Z|([+-](?:[01]\d|2[0-3]):?[0-5]\d))$/;
  const start = BASE_MS + 123;
  const end = BASE_MS + 60_789;
  const items = [raw("om_before", { create_time: String(start - 1) }),
    raw("om_start", { create_time: String(start) }), raw("om_end", { create_time: String(end) }),
    raw("om_after", { create_time: String(end + 1) })];
  const h = harness((call) => {
    if (call.path === SEARCH) {
      const range = call.body.filter.time_range;
      assert.match(range.start_time, isoSeconds);
      assert.match(range.end_time, isoSeconds);
      assert.equal(Date.parse(range.start_time), BASE_MS);
      assert.equal(Date.parse(range.end_time), BASE_MS + 61_000);
      return hits(items.map((item) => item.message_id));
    }
    assert.equal(call.path, MGET);
    return details(items);
  });
  assert.deepEqual(h.adapter.fetchSentMessages("ou_self", start, end, options()).messages.map((item) => item.message_id),
    ["om_start", "om_end"]);
});

test("native sent refuses missing or duplicate search IDs before asking for details", () => {
  for (const items of [[null], [{}], [{ meta_data: { message_id: 3, private: PRIVATE } }],
    [{ meta_data: { message_id: " " } }],
    [{ meta_data: { message_id: PRIVATE } }, { meta_data: { message_id: PRIVATE } }]]) {
    const h = harness(() => page(items));
    rejectsSafely(() => h.sent(), /invalid or duplicate message IDs/);
    assert.equal(h.calls.length, 1);
  }
});

test("native mget must contain exactly the requested unique IDs", () => {
  for (const returned of [[raw("om_a")], [raw("om_a"), raw(PRIVATE)],
    [raw("om_a"), raw("om_b"), raw(PRIVATE)], [raw("om_a"), raw("om_a")]]) {
    const h = harness((call) => call.path === SEARCH ? hits(["om_a", "om_b"]) : details(returned));
    rejectsSafely(() => h.sent(), /exactly match/);
    assert.deepEqual(h.calls.map((call) => call.path), [SEARCH, MGET]);
  }
});

test("native mget malformed or failed responses abort before fetching the next search page", () => {
  for (const response of [{ ok: false, error: { message: PRIVATE }, data: { items: [raw("om_a")] } },
    { ok: true, data: {} }, { ok: true, data: { items: null } }, details([raw("om_a", { body: null })])]) {
    const h = harness((call) => call.path === SEARCH ? hits(["om_a"], true, "next") : response);
    rejectsSafely(() => h.sent());
    assert.deepEqual(h.calls.map((call) => call.path), [SEARCH, MGET]);
  }
  for (const fields of [{ has_more: true }, { has_more: "false" }, { page_token: PRIVATE }]) {
    const h = harness((call) => call.path === SEARCH ? hits(["om_a"], true, "next")
      : details([raw("om_a")], fields));
    rejectsSafely(() => h.sent(), /unexpected pagination/);
    assert.deepEqual(h.calls.map((call) => call.path), [SEARCH, MGET]);
  }
});

test("native transport errors propagate without returning a partial successful window", () => {
  const failure = new Error("lark-cli failed: kind=rate_limited operation=message_history_bundle retry_exhausted=1");
  const h = harness((_call, number) => {
    if (number === 1) return page([raw("om_before")], true, "next");
    throw failure;
  });
  assert.throws(() => h.received(), (error) => error === failure);
  assert.equal(h.calls.length, 2);
});

test("native merge details use one serial raw request per root and cache repeated roots within the window", () => {
  const root = merge("om_root/with?reserved");
  const children = [raw("om_child", { upper_message_id: root.message_id })];
  const before = structuredClone(children);
  const h = harness((call, number) => {
    if (call.path === LIST) return number === 1 ? page([root], true, "next") : page([root]);
    assert.equal(call.path, `${LIST}/${encodeURIComponent(root.message_id)}`);
    assert.deepEqual(call.params, { user_id_type: "open_id", card_msg_content_type: "raw_card_content" });
    return details([root, ...children]);
  });
  const result = h.received();
  assert.deepEqual(h.calls.map((call) => call.path), [LIST, `${LIST}/${encodeURIComponent(root.message_id)}`, LIST]);
  assert.ok(result.messages.length > 0);
  assert.equal(result.messages.every((item) => item.message_id === root.message_id), true,
    "detail children are embedded, never extra top-level records");
  for (const item of result.messages) {
    assert.match(item.content, /body om_child/);
    assert.deepEqual(item.raw_api_expansions.merge_forward.items, [root, ...before]);
  }
  assert.deepEqual(children, before);
});

test("native merge explicit pagination collects the complete flat tree without recursive network expansion", () => {
  const root = merge("om_root");
  const nested = merge("om_nested", { upper_message_id: root.message_id });
  const child = raw("om_nested_child", { upper_message_id: nested.message_id,
    create_time: String(BASE_MS - 600_000) });
  const h = harness((call) => {
    if (call.path === LIST) return page([root]);
    assert.equal(call.path, `${LIST}/${root.message_id}`, "nested containers must not trigger extra GETs");
    return call.params.page_token === "details-next" ? details([child], { has_more: false })
      : details([root, nested], { has_more: true, page_token: "details-next" });
  });
  const result = h.received();
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls.slice(1).map((call) => call.params.page_token), [undefined, "details-next"]);
  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0].content, /body om_nested_child/);
  assert.deepEqual(result.messages[0].raw_api_expansions.merge_forward.items, [root, nested, child]);
});

test("native merge missing items, empty details, and unsafe continuation states fail closed", () => {
  const root = merge("om_root");
  const child = raw("om_child");
  for (const responses of [
    [{ ok: true, data: {} }], [details([])], [details([root, child], { page_token: PRIVATE })],
    [details([root, child], { has_more: true })], [details([root, child], { has_more: "false" })],
    [details([root, child], { has_more: true, page_token: "same" }), details([raw("om_next")], { has_more: true, page_token: "same" })],
  ]) {
    let detailCalls = 0;
    const h = harness((call) => {
      if (call.path === LIST) return page([root]);
      assert.ok(detailCalls < responses.length, "bad detail pagination must stop");
      return responses[detailCalls++];
    });
    rejectsSafely(() => h.received(), /message-details/);
    assert.equal(detailCalls, responses.length);
  }
});

test("native merge rejects duplicate, orphan, cyclic, invalid-parent and overdeep trees", () => {
  const root = merge("om_root");
  const longChain = Array.from({ length: 66 }, (_, index) => raw(`om_depth_${index}`, {
    upper_message_id: index === 65 ? root.message_id : `om_depth_${index + 1}`,
  }));
  for (const items of [[raw("om_child")], [root, raw(PRIVATE), raw(PRIVATE)],
    [root, raw("om_child", { upper_message_id: PRIVATE })],
    [root, raw("om_a", { upper_message_id: "om_b" }), raw("om_b", { upper_message_id: "om_a" })],
    [root, raw("om_child", { upper_message_id: {} })],
    [merge(root.message_id, { upper_message_id: PRIVATE })], [root, ...longChain]]) {
    const h = harness((call) => call.path === LIST ? page([root]) : details(items));
    rejectsSafely(() => h.received(), /merge-forward/);
    assert.equal(h.calls.length, 2);
  }
  for (const changedRoot of [merge(root.message_id, { update_time: String(BASE_MS + 9_999) }),
    merge(root.message_id, { body: { content: PRIVATE } })]) {
    const h = harness((call) => call.path === LIST ? page([root]) : details([changedRoot, raw("om_child")]));
    assert.throws(() => h.received(), (error) => {
      assert.ok(error instanceof MessageDetailsIncompleteError);
      assert.deepEqual(error.messages, []);
      assert.equal(error.missingDetails[0].reason, "source_changed");
      assert.doesNotMatch(error.message, new RegExp(PRIVATE));
      return true;
    });
    assert.equal(h.calls.length, 2);
  }
});

test("native merge page and item caps are shared across roots and fail without truncation", () => {
  for (const [maxPages, rootCount, permittedDetails] of [[1, 2, 1], [100, 51, 50]]) {
    const roots = Array.from({ length: rootCount }, (_, index) => merge(`om_root_${index}`));
    const h = harness((call, number) => call.path === LIST
      ? call.params.page_token === "roots-next" ? page(roots.slice(50))
        : page(roots.slice(0, 50), rootCount > 50, rootCount > 50 ? "roots-next" : "")
      : details([roots.find((root) => call.path === `${LIST}/${root.message_id}`), raw(`om_child_${number}`)]));
    assert.throws(() => h.received(options({ maxPages })), PaginationLimitError);
    assert.equal(h.calls.length, (rootCount > 50 ? 2 : 1) + permittedDetails);
  }
  const roots = [merge("om_first"), merge("om_second")];
  const h = harness((call) => call.path === LIST ? page(roots)
    : details([roots.find((root) => call.path === `${LIST}/${root.message_id}`),
      ...Array.from({ length: call.path.endsWith("om_first") ? 599 : 400 }, (_, index) =>
        raw(`om_child_${call.path.endsWith("om_first") ? "first" : "second"}_${index}`))]));
  assert.throws(() => h.received(), PaginationLimitError);
  assert.equal(h.calls.length, 3);
});

test("native list, detail and search requests share a 180-second window budget", () => {
  let ms = 1_000;
  const h = harness((call, number) => {
    if (number === 1) { ms += 90_000; return page([merge("om_first")], true, "next"); }
    if (number === 2) { ms += 60_000; return details([merge("om_first"), raw("om_child")]); }
    assert.equal(call.path, LIST);
    ms += 30_000;
    return page([merge("om_second")]);
  }, () => ms);
  assert.throws(() => h.received(), /kind=network_timeout.*operation=message_history_bundle.*retry_exhausted=1/);
  assert.deepEqual(h.calls.map((call) => call.options.retryBudgetMs), [180_000, 90_000, 30_000]);
  assert.deepEqual(h.calls.map((call) => call.options.timeoutMs), [120_000, 90_000, 30_000]);
  assert.equal(h.calls.length, 3, "no fresh detail budget after the window is exhausted");

  ms = 0;
  const sent = harness(() => { ms = 180_000; return hits(["om_a"]); }, () => ms);
  assert.throws(() => sent.sent(), /kind=network_timeout.*operation=message_search_bundle.*retry_exhausted=1/);
  assert.deepEqual(sent.calls.map((call) => call.path), [SEARCH], "mget cannot reset the search deadline");

  ms = 0;
  const rollback = harness((_call, number) => {
    ms = number === 1 ? 90_000 : 1_000;
    return page([], number < 3, number < 3 ? `next-${number}` : "");
  }, () => ms);
  assert.equal(rollback.received().pages, 3);
  assert.deepEqual(rollback.calls.map((call) => call.options.retryBudgetMs), [180_000, 90_000, 90_000],
    "clock rollback cannot increase remaining budget");
});

test("native endpoint routing preserves operation cooldown buckets without private names", () => {
  assert.equal(transportOperation(["api", "GET", LIST]), "message_history_bundle");
  assert.equal(transportOperation(["api", "POST", SEARCH]), "message_search_bundle");
  assert.equal(transportOperation(["api", "GET", MGET]), "message_search_bundle");
  assert.equal(transportOperation(["api", "GET", `${LIST}/om_synthetic`]), "message_history_bundle");
  assert.equal(transportOperation(["api", "GET", `${LIST}/om_synthetic/resources/file_synthetic`]), "other");
});

test("merge detail permissions preserve validated ordinary messages across complete list pagination", () => {
  for (const kind of ["restricted_mode", "bot_user_out_of_chat", "permission_denied"]) {
    const root = merge("om_denied_root");
    const h = harness((call) => {
      if (call.path !== LIST) throw new Error(`lark-cli failed: kind=${kind}; ${PRIVATE}`);
      return call.params.page_token ? page([root, raw("om_after")])
        : page([raw("om_before"), root], true, "next");
    });
    assert.throws(() => h.received(), (error) => {
      assert.ok(error instanceof MessageDetailsIncompleteError);
      assert.deepEqual(error.messages.map((item) => item.message_id), ["om_before", "om_after"]);
      assert.equal(error.pages, 2);
      assert.deepEqual(error.missingDetails, [{ message_id: root.message_id, reason: kind }]);
      assert.doesNotMatch(error.message, /synthetic-private|om_denied_root|kind=/);
      return true;
    });
    assert.deepEqual(h.calls.map((call) => call.path), [LIST, `${LIST}/${root.message_id}`, LIST]);
  }
});

test("a list failure following missing details still rejects all incomplete pagination", () => {
  const root = merge("om_denied_root");
  const failure = new Error("lark-cli failed: kind=network_error retry_exhausted=1");
  const h = harness((call) => {
    if (call.path !== LIST) throw new Error("kind=restricted_mode");
    if (call.params.page_token) throw failure;
    return page([raw("om_validated"), root], true, "next");
  });
  assert.throws(() => h.received(), (error) => error === failure);
});

test("only a request timeout consuming the shared deadline becomes a window-budget signal", () => {
  for (const [elapsed, kind, expectedBudget] of [[120_000, "network_timeout", false],
    [180_000, "network_timeout", true], [180_000, "rate_limited", false],
    [180_000, "restricted_mode", false]]) {
    let ms = 0;
    const failure = new Error(`lark-cli failed: kind=${kind} retry_exhausted=1`);
    const h = harness(() => { ms += elapsed; throw failure; }, () => ms);
    assert.throws(() => h.received(), (error) => expectedBudget
      ? error instanceof MessageWindowBudgetError && error.cause === failure : error === failure);
    assert.equal(h.calls.length, 1);
  }
});
