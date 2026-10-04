import assert from "node:assert/strict";
import test from "node:test";
import { createNameResolver } from "../src/adapters/lark-im/name-resolver.mjs";

const opts = { retries: 0, retryDelayMs: 0 };
const APP = "cli_synthetic_paper_clock";
const CHAT = "oc_synthetic_fold_table";

test("application probe forces a new request without changing normal cache or budget policy", () => {
  let calls = 0;
  const events = [];
  const resolver = createNameResolver({ now: () => 0, onLookup: (event) => events.push(event), run(_args, options) {
    assert.equal(options.retryBudgetMs, 5000);
    assert.equal(options.retries, 0);
    calls += 1;
    return { data: { app: { app_name: calls === 1 ? "Paper Clock" : "Renamed Clock" } } };
  } });
  assert.equal(resolver.resolveApplicationNames([APP], opts).get(APP), "Paper Clock");
  assert.equal(resolver.resolveApplicationNames([APP], opts).get(APP), "Paper Clock");
  assert.equal(calls, 1);
  assert.equal(resolver.resolveApplicationNames([APP], { ...opts, forceRefresh: true }).get(APP), "Renamed Clock");
  assert.equal(calls, 2);
  assert.deepEqual(events.map(({ kind, status, cached }) => [kind, status, cached]), [
    ["application", "resolved", false], ["application", "resolved", true], ["application", "resolved", false],
  ]);
});

test("failed forced application refresh is unknown and remains retryable after a positive cache hit", () => {
  let calls = 0;
  const events = [];
  const failure = new Error("synthetic denied");
  const resolver = createNameResolver({ now: () => 0, onLookup: (event) => events.push(event), run() {
    calls += 1;
    if (calls === 2) throw failure;
    return { app: { app_name: calls === 1 ? "Before" : "After" } };
  } });
  resolver.resolveApplicationNames([APP], opts);
  assert.equal(resolver.resolveApplicationNames([APP], { ...opts, forceRefresh: true }).size, 0);
  assert.equal(events.at(-1).error, failure);
  assert.equal(events.at(-1).status, "failed");
  assert.equal(resolver.resolveApplicationNames([APP], opts).get(APP), "After");
  assert.equal(calls, 3);
  assert.ok(events.every((event) => !Object.hasOwn(event, "cleared")));
});

test("application diagnostics distinguish localized success, missing name and request failure once per identity", () => {
  const events = [];
  const resolver = createNameResolver({ onLookup: (event) => events.push(event), run(args) {
    if (args[2].endsWith("cli_synthetic_empty")) return { app: {} };
    if (args[2].endsWith("cli_synthetic_fail")) throw new Error("synthetic failed request");
    return { app: { i18n: [{ i18n_key: "zh_cn", name: "Fold Counter" }] } };
  } });
  const names = resolver.resolveApplicationNames([APP, APP, "cli_synthetic_empty", "cli_synthetic_fail", "not_an_app"], opts);
  assert.deepEqual([...names], [[APP, "Fold Counter"]]);
  assert.deepEqual(events.map((event) => event.status), ["resolved", "missing_name", "failed"]);
  assert.deepEqual(events.map((event) => event.app_id), [APP, "cli_synthetic_empty", "cli_synthetic_fail"]);
});

test("bot fallback diagnostics preserve direct matching, unique inference, ambiguity and failures", () => {
  const events = [];
  let mode = "direct";
  const resolver = createNameResolver({ onLookup: (event) => events.push(event), run(_args, options) {
    assert.equal(options.retryBudgetMs, 5000);
    if (mode === "fail") throw new Error("synthetic bot failure");
    return { items: mode === "direct" ? [{ app_id: APP, bot_name: "Direct Clock" }]
      : mode === "unique" ? [{ bot_name: "Unique Clock" }]
      : mode === "ambiguous" ? [{ bot_name: "Clock A" }, { bot_name: "Clock B" }] : [] };
  } });
  const lookup = () => resolver.resolveChatBotAppFallbackNames(new Map([[CHAT, new Set([APP])]]), new Map(), opts);
  assert.deepEqual(lookup().get(`${CHAT}:${APP}`), { name: "Direct Clock", source: "chat_bot_app_id", confidence: "high" });
  mode = "unique";
  assert.equal(lookup().get(`${CHAT}:${APP}`).source, "chat_bot_unique");
  mode = "ambiguous";
  assert.equal(lookup().size, 0);
  assert.equal(events.at(-1).pending_app_ids, 1);
  assert.equal(events.at(-1).bot_candidates, 2);
  mode = "empty";
  assert.equal(lookup().size, 0);
  mode = "fail";
  assert.equal(lookup().size, 0);
  assert.deepEqual(events.map((event) => [event.kind, event.status]), [
    ["chat_bots", "resolved"], ["chat_bots", "resolved"], ["chat_bots", "ambiguous"],
    ["chat_bots", "unresolved"], ["chat_bots", "failed"],
  ]);
  assert.equal(resolver.resolveChatBotAppFallbackNames(new Map([[CHAT, new Set([APP])]]), new Map([[APP, "Official"]]), opts).size, 0);
  assert.equal(events.length, 5);
});

test("an optional diagnostic observer cannot turn a valid lookup into a name failure", () => {
  const resolver = createNameResolver({ onLookup() { throw new Error("synthetic observer failure"); }, run(args) {
    return args[0] === "api" ? { app: { app_name: "Paper Clock" } } : { items: [{ app_id: APP, bot_name: "Paper Bot" }] };
  } });
  assert.equal(resolver.resolveApplicationNames([APP], opts).get(APP), "Paper Clock");
  assert.equal(resolver.resolveChatBotAppFallbackNames(new Map([[CHAT, new Set([APP])]]), new Map(), opts).get(`${CHAT}:${APP}`).name, "Paper Bot");
});
