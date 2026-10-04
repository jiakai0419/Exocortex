import assert from "node:assert/strict";
import test from "node:test";

import { createLarkImAdapter } from "../src/adapters/lark-im/adapter.mjs";
import { fetchMessageWindowWithBisection, MessageDetailsIncompleteError, MessageWindowBudgetError } from "../src/adapters/lark-im/core.mjs";

// Every identity, time, message and response below is invented for this test.
const START = Date.parse("2026-08-01T00:00:00Z");
const opts = (overrides = {}) => ({ pageSize: 50, maxPages: 5, chatPageSize: 100,
  chatTypes: "group", retries: 0, retryDelayMs: 0, ...overrides });
const raw = (id, overrides = {}) => ({ message_id: `om_synthetic_${id}`, chat_id: "oc_synthetic_details",
  create_time: String(START + 1000), update_time: String(START + 2000),
  msg_type: "text", body: { content: JSON.stringify({ text: `invented ${id}` }) },
  sender: { id: "ou_synthetic_sender", id_type: "open_id", sender_type: "user" }, ...overrides });
const merged = (overrides = {}) => raw("root", { msg_type: "merge_forward",
  body: { content: JSON.stringify({ create_message_ids: ["om_synthetic_child"] }) }, ...overrides });
const page = (items, has_more = false, page_token = "") => ({ ok: true, data: { items, has_more, page_token } });
const paramsOf = (args) => JSON.parse(args[args.indexOf("--params") + 1]);
const fetchList = (adapter, direction, fetchOpts = opts()) => direction === "sent"
  ? adapter.fetchSentMessageList("ou_synthetic_self", START, START + 60_000, fetchOpts)
  : adapter.fetchChatMessageList("oc_synthetic_details", START, START + 60_000, fetchOpts);
const strictList = (adapter, direction) => direction === "sent"
  ? adapter.fetchSentMessages("ou_synthetic_self", START, START + 60_000, opts())
  : adapter.fetchChatMessages("oc_synthetic_details", START, START + 60_000, opts());

for (const direction of ["received", "sent"]) {
  test(`${direction} list coverage returns all ordinary pages and raw detail tasks without any detail request`, () => {
    const root = merged();
    const ordinary = [raw("first"), raw("later")];
    const excluded = merged({ message_id: "om_synthetic_outside", create_time: String(START - 1) });
    const calls = [];
    const adapter = createLarkImAdapter({ run(args) {
      const path = args[2];
      const params = paramsOf(args);
      calls.push(path);
      if (path.endsWith("/mget")) return page(params.message_ids.map((id) => [root, excluded, ...ordinary].find((m) => m.message_id === id)));
      const items = params.page_token ? [ordinary[1]] : [root, ordinary[0], excluded];
      if (path.endsWith("/search")) return page(items.map((item) => ({ meta_data: { message_id: item.message_id } })), !params.page_token, params.page_token ? "" : "second");
      assert.equal(path, "/open-apis/im/v1/messages");
      return page(items, !params.page_token, params.page_token ? "" : "second");
    } });
    const result = fetchList(adapter, direction);
    assert.equal(result.pages, 2);
    assert.deepEqual(result.messages.map((m) => m.raw_api), ordinary);
    assert.deepEqual(result.detailRoots, [root]);
    assert.equal(calls.length, direction === "sent" ? 4 : 2);
    result.detailRoots[0].body.content = "mutated copy";
    assert.notEqual(root.body.content, "mutated copy");
  });

  test(`${direction} strict compatibility path still fails closed after a detail denial`, () => {
    const root = merged();
    const adapter = createLarkImAdapter({ run(args) {
      const path = args[2];
      const params = paramsOf(args);
      if (path.endsWith("/search")) return page([root, raw("ordinary")].map((m) => ({ meta_data: { message_id: m.message_id } })));
      if (path.endsWith("/mget")) return page(params.message_ids.map((id) => [root, raw("ordinary")].find((m) => m.message_id === id)));
      if (path === "/open-apis/im/v1/messages") return page([root, raw("ordinary")]);
      throw new Error("kind=permission_denied private invented content");
    } });
    assert.throws(() => strictList(adapter, direction), (error) => {
      assert.ok(error instanceof MessageDetailsIncompleteError);
      assert.equal(error.messages.length, 1);
      assert.equal(error.missingDetails[0].reason, "permission_denied");
      return true;
    });
  });

  test(`${direction} later list failure exposes neither partial ordinary rows nor queued roots`, () => {
    const root = merged();
    let returned;
    const adapter = createLarkImAdapter({ run(args) {
      const path = args[2];
      const params = paramsOf(args);
      if (path.endsWith("/mget")) return page([root, raw("ordinary")]);
      if (params.page_token) throw new Error("synthetic later list failure");
      const items = [root, raw("ordinary")];
      return page(path.endsWith("/search") ? items.map((m) => ({ meta_data: { message_id: m.message_id } })) : items, true, "second");
    } });
    assert.throws(() => { returned = fetchList(adapter, direction); }, /later list failure/);
    assert.equal(returned, undefined);
  });
}

test("sent list requires an exact complete mget closure before claiming list coverage", () => {
  const adapter = createLarkImAdapter({ run(args) {
    return args[2].endsWith("/search")
      ? page([merged(), raw("ordinary")].map((m) => ({ meta_data: { message_id: m.message_id } })))
      : page([raw("ordinary")]);
  } });
  assert.throws(() => fetchList(adapter, "sent"), /exactly match/);
});

test("list shared deadline still selects the smallest complete prefix without fetching details", () => {
  let now = 0;
  const windows = [];
  const adapter = createLarkImAdapter({ clock: () => now, run(args) {
    assert.equal(args[2], "/open-apis/im/v1/messages");
    const endMs = Number(paramsOf(args).end_time) * 1000;
    windows.push(endMs);
    if (endMs > START + 60_000) {
      now += 180_000;
      throw new Error("kind=network_timeout");
    }
    return page([merged(), raw("ordinary")]);
  } });
  const result = fetchMessageWindowWithBisection((start, end) =>
    adapter.fetchChatMessageList("oc_synthetic_details", start, end, opts()), START, START + 3_600_000);
  assert.deepEqual(windows, [START + 3_600_000, START + 60_000]);
  assert.equal(result.window_bisections, 1);
  assert.equal(result.detailRoots.length, 1);
  assert.equal(result.messages.length, 1);
});

test("detail retry hydrates an authoritative newer root across all pages without mutating queued evidence", () => {
  const queued = merged();
  const refreshed = merged({ update_time: String(START + 3000), body: { content: '{"edited":true}' } });
  const child = raw("child");
  const before = JSON.stringify(queued);
  let now = 100;
  const calls = [];
  const adapter = createLarkImAdapter({ clock: () => now, run(args, options) {
    calls.push({ args, options });
    now += 1000;
    return paramsOf(args).page_token ? page([child]) : page([refreshed], true, "children");
  } });
  const normalized = adapter.fetchMessageDetails(queued, opts());
  assert.deepEqual(normalized.raw_api, refreshed);
  assert.deepEqual(normalized.raw_api_expansions.merge_forward.items, [refreshed, child]);
  assert.equal(normalized.update_time, refreshed.update_time);
  assert.match(normalized.content, /invented child/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.retryBudgetMs, 30_000);
  assert.equal(calls[1].options.retryBudgetMs, 29_000);
  assert.equal(JSON.stringify(queued), before);
});

test("same-version refreshed payload uses structural equality rather than JSON object key order", () => {
  const root = merged();
  const reordered = Object.fromEntries(Object.entries(root).reverse());
  reordered.body = { ...root.body };
  const adapter = createLarkImAdapter({ run: () => page([reordered, raw("child")]) });
  assert.equal(adapter.fetchMessageDetails(root).message_id, root.message_id);
});

for (const [label, mutate, reason] of [
  ["chat identity", (root) => ({ ...root, chat_id: "oc_synthetic_other" }), "source_identity_changed"],
  ["creation identity", (root) => ({ ...root, create_time: String(START + 1001) }), "source_identity_changed"],
  ["older version", (root) => ({ ...root, update_time: String(START + 1999) }), "source_version_regressed"],
  ["missing known version", (root) => ({ ...root, update_time: undefined }), "source_version_regressed"],
  ["same-version body", (root) => ({ ...root, body: { content: '{"changed":true}' } }), "source_version_conflict"],
  ["same-version sender", (root) => ({ ...root, sender: { ...root.sender, id: "ou_synthetic_other" } }), "source_version_conflict"],
]) {
  test(`detail retry rejects ${label} changes without producing a partial record`, () => {
    const queued = merged();
    const adapter = createLarkImAdapter({ run: () => page([mutate(queued), raw("child")]) });
    assert.throws(() => adapter.fetchMessageDetails(queued), (error) => {
      assert.equal(error.name, "MessageDetailError");
      assert.equal(error.detailReason, reason);
      assert.doesNotMatch(error.message, /om_synthetic|oc_synthetic|ou_synthetic/);
      return true;
    });
  });
}

test("detail retry accepts a newer authoritative ordinary replacement without retaining stale expansion", () => {
  const queued = merged();
  const replacement = raw("root", { update_time: String(START + 3000) });
  const adapter = createLarkImAdapter({ run: () => page([replacement]) });
  const result = adapter.fetchMessageDetails(queued);
  assert.deepEqual(result.raw_api, replacement);
  assert.equal(result.content, "invented root");
  assert.equal(result.raw_api_expansions, undefined);
});

for (const kind of ["permission_denied", "restricted_mode", "bot_user_out_of_chat", "network_timeout", "network_error", "rate_limited", "service_unavailable", "internal_error"]) {
  test(`detail ${kind} stays sanitized and task local`, () => {
    const adapter = createLarkImAdapter({ run() { throw new Error(`kind=${kind} secret invented detail om_synthetic_private`); } });
    assert.throws(() => adapter.fetchMessageDetails(merged()), (error) => {
      assert.equal(error.detailReason, kind);
      assert.equal(error.message, `message-details unavailable: kind=${kind}`);
      assert.equal(error instanceof MessageWindowBudgetError, false);
      return true;
    });
  });
}

for (const code of [2200, 1663]) {
  test(`internal API error ${code} has the same detail reason in strict and queued paths`, () => {
    const error = new Error(JSON.stringify({ error: { type: "api", code, message: "Internal Error invented private payload" } }));
    const root = merged();
    const adapter = createLarkImAdapter({ run(args) {
      if (args[2] === "/open-apis/im/v1/messages") return page([root, raw("ordinary")]);
      throw error;
    } });
    assert.throws(() => strictList(adapter, "received"), (failure) => {
      assert.ok(failure instanceof MessageDetailsIncompleteError);
      assert.equal(failure.messages.length, 1);
      assert.equal(failure.missingDetails[0].reason, "internal_error");
      assert.doesNotMatch(failure.message, /invented|private/);
      return true;
    });
    assert.throws(() => adapter.fetchMessageDetails(root), (failure) => {
      assert.equal(failure.detailReason, "internal_error");
      assert.equal(failure instanceof MessageWindowBudgetError, false);
      return true;
    });
  });
}

for (const kind of ["internal_error", "rate_limited", "permission_denied", "network_error"]) {
  test(`exhausted window time does not reinterpret ${kind} as a bisectable timeout`, () => {
    let now = 0;
    let calls = 0;
    const adapter = createLarkImAdapter({ clock: () => now, run() {
      calls += 1;
      now += 180_000;
      throw new Error(`lark-cli failed: kind=${kind} operation=message_history_bundle retry_exhausted=1`);
    } });
    assert.throws(() => fetchMessageWindowWithBisection((start, end) =>
      adapter.fetchChatMessageList("oc_synthetic_details", start, end, opts()), START, START + 3_600_000),
    (error) => error.message.includes(`kind=${kind}`) && !(error instanceof MessageWindowBudgetError));
    assert.equal(calls, 1);
  });
}

test("detail shared deadline is capped independently and cannot trigger list bisection", () => {
  let now = 0;
  let calls = 0;
  const adapter = createLarkImAdapter({ clock: () => now, run(_args, options) {
    calls += 1;
    assert.equal(options.timeoutMs, 30_000);
    assert.equal(options.retryBudgetMs, 30_000);
    now = 30_000;
    return page([merged(), raw("child")]);
  } });
  assert.throws(() => fetchMessageWindowWithBisection(() => adapter.fetchMessageDetails(merged(), {
    detailBudgetMs: 300_000,
  }), START, START + 3_600_000), (error) => error.detailReason === "detail_budget_exhausted");
  assert.equal(calls, 1);
});

test("detail deadline is shared across pages and respects a smaller caller budget", () => {
  let now = 0;
  const budgets = [];
  const adapter = createLarkImAdapter({ clock: () => now, run(args, options) {
    budgets.push(options.retryBudgetMs);
    now += 300;
    return paramsOf(args).page_token ? page([raw("child")]) : page([merged()], true, "second");
  } });
  assert.equal(adapter.fetchMessageDetails(merged(), { detailBudgetMs: 1000 }).message_id, merged().message_id);
  assert.deepEqual(budgets, [1000, 700]);
});

test("detail page/item bounds and malformed trees fail only their root", () => {
  const cases = [
    { options: { detailMaxPages: 1 }, data: page([merged()], true, "second"), reason: "detail_page_limit" },
    { options: { detailMaxItems: 1 }, data: page([merged(), raw("child")]), reason: "detail_item_limit" },
    { options: {}, data: page([raw("wrong_root")]), reason: "invalid_or_unavailable_details" },
    { options: {}, data: page([merged(), raw("child"), raw("child")]), reason: "invalid_or_unavailable_details" },
    { options: {}, data: page([merged(), raw("child", { upper_message_id: "om_synthetic_missing" })]), reason: "invalid_or_unavailable_details" },
    { options: {}, data: page([merged(), raw("child", { upper_message_id: "om_synthetic_child" })]), reason: "invalid_or_unavailable_details" },
    { options: {}, data: page([merged()], true, ""), reason: "invalid_or_unavailable_details" },
  ];
  for (const { options, data, reason } of cases) {
    let calls = 0;
    const adapter = createLarkImAdapter({ run() { calls += 1; return data; } });
    assert.throws(() => adapter.fetchMessageDetails(merged(), options), (error) => error.detailReason === reason);
    assert.equal(calls, 1);
  }
});

test("detail pagination never discards a failed later page or returns an incomplete expansion", () => {
  let calls = 0;
  const adapter = createLarkImAdapter({ run() {
    calls += 1;
    if (calls === 2) throw new Error("kind=network_error synthetic later detail failure");
    return page([merged()], true, "children");
  } });
  let returned;
  assert.throws(() => { returned = adapter.fetchMessageDetails(merged()); }, (error) => error.detailReason === "network_error");
  assert.equal(returned, undefined);
  assert.equal(calls, 2);
});

for (const options of [{ detailBudgetMs: NaN }, { detailMaxItems: 0 }, { detailMaxPages: -1 }]) {
  test(`invalid detail bounds ${Object.keys(options)[0]} fail before any request`, () => {
    const adapter = createLarkImAdapter({ run() { assert.fail("no request expected"); } });
    assert.throws(() => adapter.fetchMessageDetails(merged(), options), (error) => error.detailReason === "invalid_detail_options");
  });
}


test("root-only merge detail stays unresolved instead of returning an unexpanded successful replacement", () => {
  const adapter = createLarkImAdapter({ run: () => page([merged()]) });
  assert.throws(() => adapter.fetchMessageDetails(merged()), (error) => error.detailReason === "details_not_expanded");
});

test("detail hard page/item ceilings remain bounded even when callers request larger limits", () => {
  let pageCalls = 0;
  const paged = createLarkImAdapter({ run() {
    pageCalls += 1;
    return page(pageCalls === 1 ? [merged()] : [raw(`child_${pageCalls}`)], true, `page_${pageCalls}`);
  } });
  assert.throws(() => paged.fetchMessageDetails(merged(), { detailMaxPages: 500 }),
    (error) => error.detailReason === "detail_page_limit");
  assert.equal(pageCalls, 50);
  let itemCalls = 0;
  const large = createLarkImAdapter({ run() {
    itemCalls += 1;
    return page([merged(), ...Array.from({ length: 1000 }, (_, index) => raw(`child_${index}`))]);
  } });
  assert.throws(() => large.fetchMessageDetails(merged(), { detailMaxItems: 10_000 }),
    (error) => error.detailReason === "detail_item_limit");
  assert.equal(itemCalls, 1);
});

test("a backwards wall clock cannot replenish a detail retry deadline", () => {
  let now = 1000;
  const budgets = [];
  const adapter = createLarkImAdapter({ clock: () => now, run(args, options) {
    budgets.push(options.retryBudgetMs);
    if (!paramsOf(args).page_token) {
      now = -100_000;
      return page([merged()], true, "second");
    }
    return page([raw("child")]);
  } });
  assert.equal(adapter.fetchMessageDetails(merged(), { detailBudgetMs: 1000 }).message_id, merged().message_id);
  assert.deepEqual(budgets, [1000, 1000]);
});

test("detail trees accept depth 64 and reject depth 65 without truncating descendants", () => {
  for (const depth of [64, 65]) {
    const items = [merged(), ...Array.from({ length: depth }, (_, index) => raw(`depth_${index + 1}`, {
      upper_message_id: index === 0 ? merged().message_id : `om_synthetic_depth_${index}`,
    }))];
    const adapter = createLarkImAdapter({ run: () => page(items) });
    if (depth === 64) assert.equal(adapter.fetchMessageDetails(merged()).raw_api_expansions.merge_forward.items.length, 65);
    else assert.throws(() => adapter.fetchMessageDetails(merged()),
      (error) => error.detailReason === "invalid_or_unavailable_details");
  }
});
