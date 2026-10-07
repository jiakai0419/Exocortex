import assert from "node:assert/strict";
import test from "node:test";
import { chatScopeId } from "../src/adapters/lark-im/core.mjs";
import { SAMPLE_POLICY, digest, evaluateSample } from "../src/diagnostics/remote-sample-core.mjs";
import { collectRemoteSample, createSampleApi } from "../src/diagnostics/remote-sample.mjs";
import { publicRemoteReport } from "../src/diagnostics/remote-sample-cache.mjs";

// Migrated from the retired lag command/core/raw-sample suites. These fixtures
// are invented native responses; every API, lease, clock and database read is
// injected. There are no subprocesses, account reads or filesystem writes.
// Existing remote-sample.test.mjs retains the other former lag guarantees:
// - "empty sample, unknown binding, switch of account/database ...": no empty green;
// - "native static comparison ..." / "dynamic cards ...": source-aware comparison;
// - "missing needs target coverage ...": later successful target coverage;
// - "hot slots cannot starve ...": local inventory replaces remote chat discovery.
// Old ID-only health, self-message exclusion, raw_card_content and lag text
// rendering are deliberately not compatibility contracts for the v3 sampler.
const START = Date.parse("2034-02-03T04:05:00.123Z");
const END = START + 10_000;
const NOW = END + SAMPLE_POLICY.stableBufferMs + 60_000;
const CHAT = "oc_invented_sample_group";
const SELF = "ou_invented_sample_self";
const SECRET = "Invented private body and sender https://example.invalid/private";
const BINDING = { state: "verified", evidence: "single_sent_actor",
  database_key: "a".repeat(64), account_key: "b".repeat(64) };
const scope = (chat = CHAT, chatType = "group") => ({ id: chatScopeId(chat), chat_id: chat,
  source_id: "lark.im", enabled: 1, chat_type: chatType, hot_rank: 0, hot_seen_at: new Date(NOW).toISOString() });
const message = (id, at = START + 1, extra = {}) => ({ message_id: id, chat_id: CHAT,
  create_time: String(at), update_time: String(at), msg_type: "text",
  sender: { id: "ou_invented_sample_peer", id_type: "open_id", sender_type: "user", name: SECRET },
  body: { content: JSON.stringify({ text: SECRET }) }, ...extra });
const page = (items, extra = {}) => ({ code: 0, data: { items, has_more: false, page_token: "", ...extra } });
const local = (item) => ({ external_id: item.message_id, source_id: "lark.im", record_type: "lark.im.message",
  container_id: item.chat_id, external_version: item.update_time, raw_json: JSON.stringify(item),
  canonical_json: JSON.stringify({ source_api: "im.v1.messages" }) });
const recordsFor = (items) => new Map(items.map(item => [item.message_id, local(item)]));
const targetKey = (item) => digest([BINDING.database_key, BINDING.account_key, item.chat_id, item.message_id, Number(item.create_time)]);

function collect({ response = () => page([]), inventory = [scope()], inspectSnapshot = () => ({ coverage: {}, records: new Map() }), options = {} } = {}) {
  let at = NOW;
  let acquired = 0, released = 0;
  const calls = [], snapshots = [];
  const api = createSampleApi("/invented/not-opened.sqlite", {}, {
    now: () => at,
    sleep: ms => { assert.equal(acquired, released); at += ms; },
    tryAcquireLease: () => { acquired++; return { state: "acquired", release() { released++; } }; },
    readSharedCooldown: () => ({ state: "ready" }),
    writeSharedCooldown: () => assert.fail("this fixture must not publish cooldowns"),
    spawnSync: (_bin, args, options) => {
      assert.deepEqual(args.slice(0, 2), ["api", "GET"]);
      assert.ok(options.timeout > 0 && options.timeout <= SAMPLE_POLICY.requestMs);
      const path = args[2], params = JSON.parse(args[args.indexOf("--params") + 1]);
      calls.push({ path, params });
      if (path === "/open-apis/authen/v1/user_info") {
        return { status: 0, stdout: JSON.stringify({ code: 0, data: { open_id: SELF, tenant_key: "invented_tenant" } }) };
      }
      assert.equal(path, "/open-apis/im/v1/messages", "no shortcuts, detail expansion or thread-container requests");
      const value = response(params);
      return value?.processResult || { status: 0, stdout: JSON.stringify(value) };
    },
  });
  const result = collectRemoteSample("/invented/not-opened.sqlite", { startMs: START, endMs: END, ...options }, {
    api, now: () => at, context: () => ({ database_key: BINDING.database_key }),
    readBinding: () => BINDING, loadInventory: () => inventory,
    sqliteJson: () => assert.fail("no real database query"),
    inspectSnapshot: (_db, targets) => { snapshots.push(targets); return inspectSnapshot(targets); },
  });
  assert.equal(acquired, released, "all request paths release their lease");
  assert.equal(result.report.probe.api_calls, calls.length);
  return { ...result, calls, snapshots };
}

test("bounded native pages retain in-window replies and self messages without expanding merged content", () => {
  const reply = message("om_invented_reply", START + 2, { root_id: "om_invented_root", parent_id: "om_invented_root", thread_id: "omt_invented" });
  const self = message("om_invented_self", START + 1, { sender: { id: SELF, id_type: "open_id", sender_type: "user" } });
  const merged = message("om_invented_merge", START, { msg_type: "merge_forward", body: { content: '{"message_ids":["om_invented_hidden_child"]}' } });
  const edge = message("om_invented_end", END);
  const kept = [edge, reply, self, merged];
  const result = collect({
    options: { messagesPerChat: 500 },
    response: params => !params.page_token
      ? page([message("om_invented_after", END + 1), edge, reply], { has_more: true, page_token: "invented-next" })
      : page([self, merged, message("om_invented_before", START - 1)], { has_more: true, page_token: "invented-beyond-budget" }),
    inspectSnapshot: () => ({ coverage: {}, records: recordsFor(kept) }),
  });
  const listCalls = result.calls.filter(call => call.path === "/open-apis/im/v1/messages");
  const params = { container_id_type: "chat", container_id: CHAT, sort_type: "ByCreateTimeDesc", page_size: 20,
    card_msg_content_type: "user_card_content", start_time: String(Math.floor(START / 1000)), end_time: String(Math.ceil(END / 1000)) };
  assert.deepEqual(listCalls.map(call => call.params), [params, { ...params, page_token: "invented-next" }]);
  assert.equal(result.calls.length, 4, "two identity reads plus exactly two list pages");
  assert.deepEqual(result.snapshots[0].map(target => target.message_id), kept.map(item => item.message_id));
  assert.equal(result.report.probe.truncated_chats, 1);
  assert.equal(result.report.probe.remote_messages_checked, 4);
  assert.equal(result.report.findings.present, 4);
  assert.equal(result.report.findings.content_equal, 3);
  assert.equal(result.report.findings.content_unverified, 1);
  const safe = publicRemoteReport(result.report);
  assert.equal(safe.ok, true, "positive evidence is only for these four sampled records");
  assert.equal(safe.probe.truncated_chats, 1);
  assert.ok(safe.unverified.includes("merged_children"));
  assert.ok(safe.unverified.includes("thread_only_replies"));
  for (const privateValue of [SECRET, CHAT, SELF, ...kept.map(item => item.message_id), "omt_invented", "invented_tenant"]) {
    assert.equal(JSON.stringify(safe).includes(privateValue), false);
  }
});

test("malformed native envelopes and message pages cannot publish healthy evidence", async t => {
  const cases = {
    null_envelope: null,
    empty_envelope: {},
    missing_success: { data: { items: [], has_more: false } },
    failed_success: { ok: false, data: { items: [], has_more: false } },
    contradictory_code: { ok: true, code: 123, data: { items: [], has_more: false } },
    missing_items: { code: 0, data: { has_more: false } },
    invalid_has_more: page([], { has_more: "false" }),
    missing_next_token: page([], { has_more: true }),
    invalid_next_token: page([], { has_more: true, page_token: 3 }),
    blank_message_id: page([message(" ")]),
    invalid_create_time: page([message("om_invented_bad_time", "invalid")]),
    invalid_update_time: page([message("om_invented_bad_version", START, { update_time: "invalid" })]),
    invalid_body: page([message("om_invented_bad_body", START, { body: null })]),
    wrong_chat: page([message("om_invented_wrong_chat", START, { chat_id: "oc_invented_other" })]),
    twenty_one_items: page(Array.from({ length: 21 }, (_, i) => message(`om_invented_overflow_${i}`))),
    duplicate_message: page([message("om_invented_duplicate"), message("om_invented_duplicate")]),
  };
  for (const [name, response] of Object.entries(cases)) await t.test(name, () => {
    const result = collect({ response: () => response });
    assert.equal(result.outcome, "failed");
    assert.equal(result.report.status, "unavailable");
    assert.equal(result.report.probe.probe_errors, 1);
    assert.equal(result.calls.length, 2);
    assert.equal(result.snapshots.length, 0, "invalid pages never reach local comparison");
    const safe = publicRemoteReport(result.report);
    assert.equal(safe.ok, false);
    assert.equal(JSON.stringify(safe).includes(SECRET), false);
  });
});

test("repeated pagination tokens and duplicate IDs across pages invalidate the partial sample", async t => {
  for (const fault of ["repeated_token", "duplicate_id"]) await t.test(fault, () => {
    const result = collect({ response: params => !params.page_token
      ? page([message("om_invented_first")], { has_more: true, page_token: "invented-next" })
      : page([message(fault === "duplicate_id" ? "om_invented_first" : "om_invented_second")],
        { has_more: true, page_token: fault === "repeated_token" ? "invented-next" : "invented-later" }) });
    assert.equal(result.outcome, "failed");
    assert.equal(result.calls.length, 3);
    assert.equal(result.snapshots.length, 0);
    assert.equal(publicRemoteReport(result.report).ok, false);
  });
});

test("restricted chats stay distinct from API failures without exposing private error details", () => {
  const otherChat = "oc_invented_sample_p2p";
  const existing = message("om_invented_existing");
  const restricted = collect({ inventory: [scope(), scope(otherChat, "p2p")],
    response: params => params.container_id === CHAT ? page([existing])
      : { processResult: { status: 1, stdout: JSON.stringify({ code: 231203, msg: `Restricted Mode ${SECRET}` }) } },
    inspectSnapshot: () => ({ coverage: {}, records: recordsFor([existing]) }),
  });
  assert.equal(restricted.outcome, "ok");
  assert.equal(restricted.report.status, "inconclusive");
  assert.equal(restricted.report.reason, "partial_sample");
  assert.equal(restricted.report.probe.unsupported_chats, 1);
  assert.equal(restricted.report.probe.probe_errors, 0);
  assert.equal(restricted.report.findings.present, 1);
  const failed = collect({ response: () => ({ processResult: { status: 1, stderr: SECRET } }) });
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.report.reason, "api_unavailable");
  assert.equal(failed.report.probe.unsupported_chats, 0);
  assert.equal(failed.report.probe.probe_errors, 1);
  for (const result of [restricted, failed]) {
    const safe = publicRemoteReport(result.report);
    assert.equal(safe.ok, false);
    assert.equal(JSON.stringify(safe).includes(SECRET), false);
    assert.equal(JSON.stringify(safe).includes(otherChat), false);
  }
});

test("clipped-empty samples remain inconclusive and inverted windows call no API", () => {
  const empty = collect({ response: () => page([message("om_invented_before", START - 1), message("om_invented_after", END + 1)]) });
  assert.equal(empty.outcome, "ok");
  assert.equal(empty.report.reason, "no_usable_remote_messages");
  assert.deepEqual(empty.snapshots, [[]]);
  assert.equal(empty.report.probe.remote_messages_checked, 0);
  assert.equal(publicRemoteReport(empty.report).ok, false);
  const invalid = collect({ options: { startMs: END, endMs: START } });
  assert.equal(invalid.outcome, "failed");
  assert.equal(invalid.report.reason, "context_unavailable");
  assert.equal(invalid.calls.length, 0);
});

test("a sampled missing reply stays pending until coverage evidence supports suspicion and confirmation", () => {
  const root = message("om_invented_root");
  const reply = message("om_invented_reply", START + 2, { root_id: root.message_id, parent_id: root.message_id, thread_id: "omt_invented" });
  const records = recordsFor([root]);
  const first = collect({ response: () => page([reply, root]), inspectSnapshot: () => ({ coverage: {}, records }) });
  assert.equal(first.report.status, "delayed");
  assert.equal(first.report.reason, "sync_pending");
  assert.equal(first.report.findings.present, 1);
  assert.equal(first.report.findings.missing, 1);
  assert.equal(first.report.findings.pending_sync, 1);
  assert.equal(first.report.findings.confirmed_missing, 0);
  const key = targetKey(reply);
  const observedAt = first.observations[key].first_seen;
  const evaluate = (proof, at) => evaluateSample({ messages: [reply, root], records, coverage: { [key]: proof },
    binding: BINDING, previous: first.observations, now: at, windowEnd: END });
  const staleProof = evaluate({ covered: true, latest_finished_ms: observedAt - 1 }, observedAt + SAMPLE_POLICY.intervalMs);
  assert.equal(staleProof.counts.suspected_missing, 1);
  assert.equal(staleProof.counts.confirmed_missing, 0);
  const laterProof = { covered: true, latest_finished_ms: observedAt + SAMPLE_POLICY.intervalMs - 1 };
  const confirmed = evaluate(laterProof, observedAt + SAMPLE_POLICY.intervalMs);
  assert.equal(confirmed.counts.confirmed_missing, 1);
  assert.equal(evaluate({ ...laterProof, details_pending: true }, observedAt + SAMPLE_POLICY.intervalMs).counts.confirmed_missing, 0);
  const serialized = JSON.stringify({ report: publicRemoteReport(first.report), observations: confirmed.observations });
  for (const value of [reply.message_id, root.message_id, CHAT, SECRET]) assert.equal(serialized.includes(value), false);
});
