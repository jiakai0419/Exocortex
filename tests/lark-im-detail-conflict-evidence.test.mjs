import assert from "node:assert/strict";
import test from "node:test";

import { createLarkImAdapter } from "../src/adapters/lark-im/adapter.mjs";
import { MessageDetailsIncompleteError } from "../src/adapters/lark-im/core.mjs";

// Entirely invented identities, messages, timestamps and responses.
const START = Date.parse("2026-06-01T00:00:00Z");
const raw = (id, overrides = {}) => ({ message_id: `om_synthetic_capture_${id}`,
  chat_id: "oc_synthetic_capture", create_time: String(START), update_time: String(START + 1000),
  msg_type: "text", body: { content: JSON.stringify({ text: `invented ${id}` }) },
  sender: { id: "ou_synthetic_capture", id_type: "open_id", sender_type: "user" }, ...overrides });
const root = (overrides = {}) => raw("root", { msg_type: "merge_forward",
  body: { content: '{"snapshot":1}' }, ...overrides });
const changed = (overrides = {}) => root({ body: { content: '{"snapshot":2}' }, ...overrides });
const child = () => raw("child", { upper_message_id: root().message_id });
const page = (items, has_more = false, page_token = "") => ({ ok: true, data: { items, has_more, page_token } });
const capture = { captureSameVersionConflict: true, retries: 0 };
const reason = expected => error => {
  assert.equal(error.name, "MessageDetailError");
  assert.equal(error.detailReason, expected);
  assert.doesNotMatch(error.message, /synthetic|snapshot/);
  return true;
};

test("explicit conflict capture returns the complete same-version snapshot and preserves queued evidence", () => {
  const queued = root();
  const before = JSON.stringify(queued);
  const authoritative = changed();
  const calls = [];
  let now = 0;
  const adapter = createLarkImAdapter({ clock: () => now, run(args, opts) {
    calls.push({ args, opts });
    now += 10;
    return calls.length === 1 ? page([authoritative], true, "children") : page([child()]);
  } });
  const result = adapter.fetchMessageDetails(queued, capture);
  assert.deepEqual(result.raw_api, authoritative);
  assert.deepEqual(result.raw_api_expansions.merge_forward.items, [authoritative, child()]);
  assert.equal(JSON.stringify(queued), before);
  assert.deepEqual(calls.map(call => call.opts.retryBudgetMs), [30_000, 29_990]);
  assert.equal(JSON.parse(calls[1].args[calls[1].args.indexOf("--params") + 1]).page_token, "children");
});

test("conflict capture can collect a complete same-version ordinary replacement without stale expansion", () => {
  const replacement = raw("root");
  const adapter = createLarkImAdapter({ run: () => page([replacement]) });
  const result = adapter.fetchMessageDetails(root(), capture);
  assert.deepEqual(result.raw_api, replacement);
  assert.equal(result.raw_api_expansions, undefined);
  assert.equal(result.content, "invented root");
});

test("default detail reads and explicit false keep rejecting the same-version conflict", () => {
  const adapter = createLarkImAdapter({ run: () => page([changed(), child()]) });
  assert.throws(() => adapter.fetchMessageDetails(root()), reason("source_version_conflict"));
  assert.throws(() => adapter.fetchMessageDetails(root(), { captureSameVersionConflict: false }),
    reason("source_version_conflict"));
});

test("the strict list route does not inherit the conflict capture option", () => {
  const adapter = createLarkImAdapter({ run(args) {
    return args[2] === "/open-apis/im/v1/messages" ? page([root()]) : page([changed(), child()]);
  } });
  assert.throws(() => adapter.fetchChatMessages(root().chat_id, START, START + 1000,
    { ...capture, pageSize: 50, maxPages: 5, chatPageSize: 100, chatTypes: "group" }), error => {
    assert.ok(error instanceof MessageDetailsIncompleteError);
    assert.equal(error.missingDetails[0].reason, "source_version_conflict");
    assert.equal(error.messages.length, 0);
    return true;
  });
});

test("conflict capture does not admit identity changes, regressed versions or missing version evidence", () => {
  for (const [queued, refreshed, failure] of [
    [root(), changed({ chat_id: "oc_synthetic_capture_other" }), "source_identity_changed"],
    [root(), changed({ create_time: String(START + 1) }), "source_identity_changed"],
    [root(), changed({ update_time: String(START + 999) }), "source_version_regressed"],
    [root(), changed({ update_time: undefined }), "source_version_regressed"],
    [root({ update_time: undefined }), changed({ update_time: undefined }), "source_version_conflict"],
    [root({ update_time: "" }), changed({ update_time: null }), "source_version_conflict"],
  ]) {
    const adapter = createLarkImAdapter({ run: () => page([refreshed, child()]) });
    assert.throws(() => adapter.fetchMessageDetails(queued, capture), reason(failure));
  }
});

test("conflict capture requires an exact root and a complete valid tree", () => {
  for (const [items, failure] of [
    [[changed({ message_id: "om_synthetic_capture_wrong" }), child()], "invalid_or_unavailable_details"],
    [[changed()], "details_not_expanded"],
    [[changed(), child(), child()], "invalid_or_unavailable_details"],
    [[changed(), { ...child(), upper_message_id: "om_synthetic_capture_absent" }], "invalid_or_unavailable_details"],
    [[changed(), { ...child(), upper_message_id: child().message_id }], "invalid_or_unavailable_details"],
    [[raw("root"), child()], "invalid_or_unavailable_details"],
  ]) {
    const adapter = createLarkImAdapter({ run: () => page(items) });
    assert.throws(() => adapter.fetchMessageDetails(root(), capture), reason(failure));
  }
});

test("conflict capture exposes no snapshot when a later page fails", () => {
  let calls = 0;
  const adapter = createLarkImAdapter({ run() {
    if (++calls === 1) return page([changed()], true, "children");
    throw new Error("kind=network_error synthetic private response");
  } });
  let returned;
  assert.throws(() => { returned = adapter.fetchMessageDetails(root(), capture); }, reason("network_error"));
  assert.equal(returned, undefined);
  assert.equal(calls, 2);
});

test("conflict capture retains deadline, page and item bounds", () => {
  for (const [opts, response, failure] of [
    [{ detailMaxPages: 1 }, page([changed()], true, "children"), "detail_page_limit"],
    [{ detailMaxItems: 1 }, page([changed(), child()]), "detail_item_limit"],
  ]) {
    let calls = 0;
    const adapter = createLarkImAdapter({ run() { calls += 1; return response; } });
    assert.throws(() => adapter.fetchMessageDetails(root(), { ...capture, ...opts }), reason(failure));
    assert.equal(calls, 1);
  }
  let now = 0;
  const adapter = createLarkImAdapter({ clock: () => now, run(_args, opts) {
    assert.equal(opts.retryBudgetMs, 30_000);
    now = 30_000;
    return page([changed(), child()]);
  } });
  assert.throws(() => adapter.fetchMessageDetails(root(), { ...capture, detailBudgetMs: 300_000 }),
    reason("detail_budget_exhausted"));
});

test("a malformed conflict capture option fails before acquisition", () => {
  const adapter = createLarkImAdapter({ run: () => assert.fail("must not acquire") });
  for (const value of ["true", 1, null, {}, []]) {
    assert.throws(() => adapter.fetchMessageDetails(root(), { captureSameVersionConflict: value }),
      reason("invalid_detail_options"));
  }
});
