import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  DEFAULT_LARK_RETRY_BUDGET_MS, MAX_LARK_RETRIES, TRANSPORT_OPERATIONS,
  classifyLarkFailure, createLarkCliRunner, createTransportState, getTransportStats,
  resetTransportStats, isTransientLarkFailure, isExhaustedLarkTransportFailure, retryDelayForAttempt, parseJson,
  redactCommand, transportOperation,
} from "../src/adapters/lark-im/transport.mjs";

const EPOCH = 1_800_000_000_000;
const HISTORY = ["im", "+chat-messages-list", "--chat-id", "oc_private"];
const SEARCH = ["im", "+messages-search", "--sender", "ou_private"];
const CONTACT = ["contact", "+search-user", "--user-ids", "ou_private"];
const ok = (stdout = '{"ok":true}') => ({ status: 0, signal: null, output: [], pid: 1, stdout, stderr: "" });
const fail = (body, extras = {}) => ({ ...ok(""), status: 1, stderr: typeof body === "string" ? body : JSON.stringify(body), ...extras });
const rate = (seconds, extras = {}) => fail({
  error: { type: "api", code: 99991400, subtype: "rate_limit", message: "private remote payload", ...extras },
  ...(seconds === undefined ? {} : { response: { headers: { "X-Ogw-Ratelimit-Reset": seconds } } }),
});

function harness(results, { initial = EPOCH, state = createTransportState(), ...deps } = {}) {
  let now = initial;
  const calls = [];
  const sleeps = [];
  const run = createLarkCliRunner({
    bin: "fake-lark-cli", state, clock: () => now,
    sleep(ms) { sleeps.push(ms); now += ms; },
    spawn(cmd, args, options) {
      calls.push({ cmd, args, options, at: now });
      const result = results[Math.min(calls.length - 1, results.length - 1)];
      return typeof result === "function" ? result({ advance: (ms) => { now += ms; }, options }) : result;
    },
    ...deps,
  });
  return { run, state, calls, sleeps, stats: () => getTransportStats(state, now), now: () => now,
    advance(ms) { now += ms; } };
}

function throwsSafe(fn, expected) {
  assert.throws(fn, (error) => {
    assert.match(error.message, expected);
    assert.doesNotMatch(error.message, /private|secret|Bearer|\/home\/|ou_|oc_|pt_/);
    return true;
  });
}

test("JSON parsing never quotes malformed response content", () => {
  assert.deepEqual(parseJson('{"ok":true}'), { ok: true });
  assert.equal(parseJson(""), null);
  throwsSafe(() => parseJson("private Bearer token"), /non-JSON output$/);
});

test("operation-specific subprocess buffers may tighten but never increase the shared limit", () => {
  for (const [maxBufferBytes, expected] of [
    [undefined, 50 * 1024 * 1024], [20 * 1024 * 1024, 20 * 1024 * 1024],
    [100 * 1024 * 1024, 50 * 1024 * 1024], [0, 50 * 1024 * 1024],
    [NaN, 50 * 1024 * 1024], [1.5, 50 * 1024 * 1024],
  ]) {
    const h = harness([ok()]);
    h.run(CONTACT, { maxBufferBytes });
    assert.equal(h.calls[0].options.maxBuffer, expected);
    assert.equal(h.calls[0].options.timeout, 120000);
  }
});

test("legacy display helper hides every repeated sensitive flag", () => {
  assert.equal(redactCommand(["im", "--id", "secret1", "--id", "secret2"], ["--id"]),
    "lark-cli im --id <redacted> --id <redacted>");
});

test("native message endpoints retain worker operation buckets and inherited cooldowns", () => {
  const list = ["api", "GET", "/open-apis/im/v1/messages", "--params", '{"container_id":"oc_private"}'];
  const search = ["api", "POST", "/open-apis/im/v1/messages/search", "--data", '{"from_ids":["ou_private"]}'];
  const mget = ["api", "GET", "/open-apis/im/v1/messages/mget", "--params", '{"message_ids":["om_private"]}'];
  const detail = ["api", "GET", "/open-apis/im/v1/messages/om_private"];
  assert.equal(transportOperation(list), "message_history_bundle");
  assert.equal(transportOperation(detail), "message_history_bundle");
  assert.equal(transportOperation(search), "message_search_bundle");
  assert.equal(transportOperation(mget), "message_search_bundle");
  const state = createTransportState(JSON.stringify({ message_search_bundle: EPOCH + 2000 }), EPOCH);
  const h = harness([ok(), ok(), ok()], { state });
  h.run(list);
  h.run(mget);
  h.run(search);
  assert.deepEqual(h.sleeps, [2000]);
  assert.equal(h.stats().by_operation.message_history_bundle.calls, 1);
  assert.equal(h.stats().by_operation.message_search_bundle.calls, 2);
  assert.equal(redactCommand(mget, ["--params"]), "lark-cli api GET /open-apis/im/v1/messages/mget --params <redacted>");
});

test("official rate-limit code, subtype and HTTP 429 are recognized without treating general 400 as throttling", () => {
  const inputs = [
    { error: { code: 99991400 } }, { code: "99991400" },
    { error: { subtype: "rate_limit" } },
    { error: { http_status: 429 } }, { response: { status: 429 } },
    { error: { status_code: "429" } }, { error: { http_status: 400, code: 99991400 } },
    { error: { type: "api", code: 9499, message: "too many request" } },
  ];
  for (const input of inputs) {
    const result = classifyLarkFailure(JSON.stringify(input));
    assert.equal(result.kind, "rate_limited", JSON.stringify(input));
    assert.equal(result.transient, true);
  }
  assert.equal(classifyLarkFailure("HTTP/1.1 429 Too Many Requests").kind, "rate_limited");
  assert.equal(classifyLarkFailure("HTTP 400 Bad Request").transient, false);
  assert.equal(classifyLarkFailure('{"error":{"http_status":400,"code":230001}}').kind, "unknown");
  assert.equal(classifyLarkFailure('{"error":{"code":null}}').code, null);
  assert.equal(classifyLarkFailure('{"error":{"code":""}}').code, null);
  assert.equal(classifyLarkFailure('{"error":{"subtype":"rate_limit"}}').code, null);
});

test("reset seconds survive supported structured headers and detail envelopes", () => {
  const locations = [
    { headers: { "x-ogw-ratelimit-reset": "2.5" } },
    { response: { headers: { "X-OGW-RATELIMIT-RESET": ["2.5"] } } },
    { error: { code: 99991400, detail: { headers: { "x-ogw-ratelimit-reset": 2.5 } } } },
    { error: { code: 99991400, detail: "x-ogw-ratelimit-reset: 2.5" } },
    { error: { code: 99991400, detail: '{"headers":{"x-ogw-ratelimit-reset":"2.5"}}' } },
  ];
  for (const envelope of locations) {
    assert.equal(classifyLarkFailure(JSON.stringify({ code: 99991400, ...envelope })).retry_after_ms, 2500);
  }
  assert.equal(classifyLarkFailure("HTTP 429\nx-ogw-ratelimit-reset: 60").retry_after_ms, 60000);
  assert.equal(classifyLarkFailure('prefix warning\n{"error":{"code":99991400},"headers":{"x-ogw-ratelimit-reset":"3"}}\n').retry_after_ms, 3000);
});

test("invalid reset values are unknown; huge valid durations are never shortened", () => {
  for (const value of [null, "", "NaN", "Infinity", -1, "-1", "1e3", "30seconds", "9".repeat(200)]) {
    assert.equal(classifyLarkFailure(JSON.stringify({ code: 99991400, headers: { "x-ogw-ratelimit-reset": value } })).retry_after_ms, null);
    if (typeof value === "string") {
      assert.equal(classifyLarkFailure(JSON.stringify({ code: 99991400, detail: `x-ogw-ratelimit-reset: ${value}` })).retry_after_ms, null);
    }
  }
  assert.equal(classifyLarkFailure('{"code":99991400,"headers":{"x-ogw-ratelimit-reset":"9999999999999999999999"}}').retry_after_ms, Number.MAX_SAFE_INTEGER);
});

test("existing permanent and transient classifications remain public-safe", () => {
  const cases = [
    ["TLS handshake timeout", "network_timeout", true],
    ['{"error":{"type":"network","subtype":"timeout","message":"private"}}', "network_timeout", true],
    ['{"error":{"type":"api","code":1663,"message":"Internal Error private"}}', "internal_error", true],
    ["request failed: EAI_AGAIN", "network_error", true],
    ["HTTP 503 Service Unavailable", "service_unavailable", true],
    ["Restricted Mode: copying is disabled", "restricted_mode", false],
    ['{"error":{"code":230002,"message":"private"}}', "bot_user_out_of_chat", false],
    ['{"error":{"code":2200,"message":"private permission denied"}}', "permission_denied", false],
    ['{"error":{"code":2200,"message":"private ambiguous failure"}}', "unknown", false],
  ];
  for (const [input, kind, transient] of cases) {
    const result = classifyLarkFailure(input);
    assert.equal(result.kind, kind);
    assert.equal(isTransientLarkFailure(input), transient);
    assert.doesNotMatch(result.message, /private/);
  }
  const result = classifyLarkFailure("lark-cli failed: kind=rate_limited code=99991400 retry_after_ms=5000 operation=contact_search");
  assert.equal(result.retry_after_ms, 5000);
  assert.equal(result.code, 99991400);
});

test("shared permission evidence preserves enrichment counts without exposing remote text", () => {
  const inputs = [
    '{"error":{"type":"api","code":210508,"message":"SYNTHETIC_PRIVATE_REMOTE"}}',
    "lark-cli failed: kind=unknown code=210508 operation=application_info",
    ...["insufficient permission", "permission denied", "permission level", "no permission", "unauthorized"]
      .map((reason) => `${reason}: SYNTHETIC_PRIVATE_REMOTE /invented/private-fixture`),
  ];
  for (const input of inputs) {
    const failure = classifyLarkFailure(input);
    assert.equal(failure.kind, "permission_denied");
    assert.equal(failure.transient, false);
    assert.equal(failure.message, "permission denied");
    const h = harness([fail(input)]);
    throwsSafe(() => h.run(CONTACT, { retries: 3 }), /kind=permission_denied/);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.sleeps, []);
  }
  // Known transport outages keep their request retry meaning even when the
  // remote explanation also mentions permission; prose is only a fallback.
  assert.equal(classifyLarkFailure('{"error":{"type":"api","code":2200,"message":"Internal Error: permission denied"}}').kind, "internal_error");
  assert.equal(classifyLarkFailure("HTTP 503 temporary permission level issue").kind, "service_unavailable");
});

test("non-rate transient retries preserve exponential backoff and successful telemetry", () => {
  const h = harness([fail({ error: { type: "api", code: 2200, message: "Internal Error" } }), ok()]);
  assert.deepEqual(h.run(HISTORY, { retries: 1, retryDelayMs: 7 }), { ok: true });
  assert.deepEqual(h.sleeps, [7]);
  assert.equal(h.calls[0].cmd, "fake-lark-cli");
  assert.equal(h.calls[0].options.encoding, "utf8");
  assert.equal(h.stats().calls, 1);
  assert.equal(h.stats().attempts, 2);
  assert.equal(h.stats().retries, 1);
  assert.equal(h.stats().rate_limits, 0);
  assert.equal(h.stats().wait_ms, 7);
});

test("transport exhaustion shares transient classification without trusting task-local or malformed descriptors", () => {
  for (const code of [2200, 1663]) {
    const h = harness([fail({ error: { type: "api", code, message: "Internal Error invented private payload" } })]);
    assert.throws(() => h.run(HISTORY, { retries: 1, retryDelayMs: 7 }), (error) => {
      assert.equal(classifyLarkFailure(error).kind, "internal_error");
      assert.equal(isExhaustedLarkTransportFailure(error), true);
      assert.match(error.message, new RegExp(`code=${code}\\b`));
      assert.doesNotMatch(error.message, /invented|private/);
      return true;
    });
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.sleeps, [7]);
  }
  for (const text of [
    "validation noted kind=rate_limited", "message-details unavailable: kind=internal_error",
    "lark-cli failed: kind=rate_limited-other", "lark-cli failed: kind=internal_error_extra",
    "lark-cli failed: kind=invalid-kind operation=other; additionally kind=internal_error",
    "lark-cli failed: kind=permission_denied", "lark-cli failed: kind=unknown code=2200",
  ]) assert.equal(isExhaustedLarkTransportFailure(text), false, text);
  for (const [descriptor, kind] of [
    ["kind=permission_denied", "permission_denied"],
    ["kind=unknown code=231203", "restricted_mode"],
    ["kind=unknown code=230002", "bot_user_out_of_chat"],
    ["kind=unknown code: 231203", "restricted_mode"],
    ["kind=unknown code: 230002", "bot_user_out_of_chat"],
  ]) {
    assert.equal(classifyLarkFailure(descriptor).kind, kind);
    assert.equal(classifyLarkFailure(descriptor).transient, false);
  }
});

test("recovered rate limits retain numeric aggregate and operation telemetry after success", () => {
  const h = harness([rate("2"), rate("3"), ok()]);
  assert.deepEqual(h.run(HISTORY, { retries: 2, retryDelayMs: 1 }), { ok: true });
  assert.deepEqual(h.sleeps, [2000, 3000]);
  assert.deepEqual(h.stats().by_operation.message_history_bundle, {
    calls: 1, attempts: 3, retries: 2, rate_limits: 2, timeouts: 0, wait_ms: 5000,
    max_retry_after_ms: 3000, cooldown_until_ms: 0, exhausted: 0, retry_after_unknown: 0,
  });
  assert.deepEqual(h.stats().cooldowns_by_operation, {});
  assert.doesNotMatch(JSON.stringify(h.stats()), /private|ou_|oc_|headers|payload/);
});

test("missing headers use conservative fallback independent of caller retryDelayMs", () => {
  const h = harness([rate(), rate(), ok()]);
  h.run(SEARCH, { retries: 2, retryDelayMs: 0 });
  assert.deepEqual(h.sleeps, [30000, 60000]);
  assert.equal(h.stats().retry_after_unknown, 2);
  assert.equal(h.stats().max_retry_after_ms, 0);
  assert.equal(h.stats().wait_ms, 90000);
});

test("a reset beyond budget causes no shortened sleep or second request and retains cooldown", () => {
  const h = harness([rate("181"), ok()]);
  throwsSafe(() => h.run(HISTORY, { retries: 10 }), /retry_after_ms=181000.*retry_exhausted=1/);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.sleeps, []);
  assert.equal(h.stats().cooldowns_by_operation.message_history_bundle, EPOCH + 181000);
  assert.equal(h.stats().exhausted, 1);
  // Exactly consuming the budget leaves no time for an attempt, also fail closed.
  const exact = harness([rate("180")]);
  assert.throws(() => exact.run(HISTORY, { retries: 1 }), /retry_exhausted=1/);
  assert.equal(exact.calls.length, 1);
  assert.deepEqual(exact.sleeps, []);
});

test("long valid reset remains enforceable across later calls and counter resets", () => {
  const h = harness([rate("9999999999999999999999")]);
  assert.throws(() => h.run(CONTACT, { retries: 1 }), /retry_exhausted=1/);
  resetTransportStats(h.state);
  const stats = h.stats();
  assert.equal(stats.calls, 0);
  assert.equal(stats.cooldowns_by_operation.contact_search, Number.MAX_SAFE_INTEGER);
  throwsSafe(() => h.run(CONTACT), /retry_after_source=shared.*retry_exhausted=1/);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.sleeps, []);
});

test("operation cooldown survives swallowed error and another runner, without blocking other operations", () => {
  const state = createTransportState();
  const first = harness([rate(20)], { state });
  assert.throws(() => first.run(CONTACT), /rate_limited/);
  const next = harness([ok()], { state });
  next.run(HISTORY);
  assert.deepEqual(next.sleeps, []);
  next.run(CONTACT);
  assert.deepEqual(next.sleeps, [20000]);
  assert.equal(next.calls[0].at, EPOCH);
  assert.equal(next.calls[1].at, EPOCH + 20000);
  assert.equal(next.stats().calls, 3);
  assert.equal(next.stats().rate_limits, 1);
});

test("consecutive fallback cooldown escalates even when best-effort caller catches errors", () => {
  const h = harness([rate()]);
  assert.throws(() => h.run(CONTACT), /retry_after_source=fallback/);
  resetTransportStats(h.state);
  assert.throws(() => h.run(CONTACT), /retry_after_source=fallback/);
  assert.deepEqual(h.sleeps, [30000]);
  assert.equal(h.stats().cooldowns_by_operation.contact_search, EPOCH + 90000);
});

test("attempt execution and sleep share one total budget and remaining time bounds spawn timeout", () => {
  const h = harness([
    ({ advance }) => { advance(50); return rate(0.025); },
    ({ advance, options }) => { assert.equal(options.timeout, 25); advance(25); return fail("ETIMEDOUT"); },
  ]);
  throwsSafe(() => h.run(HISTORY, { retries: 10, retryBudgetMs: 100, timeoutMs: 90 }), /retry_exhausted=1/);
  assert.deepEqual(h.sleeps, [25]);
  assert.deepEqual(h.calls.map((call) => call.options.timeout), [90, 25]);
  assert.equal(h.stats().timeouts, 1);
  assert.equal(h.stats().attempts, 2);
});

test("default total budget is 180 seconds and cannot be evaded by repeated transient calls", () => {
  const h = harness([({ advance, options }) => { advance(options.timeout); return fail("ETIMEDOUT"); }]);
  assert.throws(() => h.run(HISTORY, { retries: 10, retryDelayMs: 0 }), /retry_exhausted=1/);
  assert.deepEqual(h.calls.map((call) => call.options.timeout), [120000, 60000]);
  assert.equal(h.now() - EPOCH, DEFAULT_LARK_RETRY_BUDGET_MS);
});

test("retry count has a finite hard cap even with a zero reset header", () => {
  const h = harness([rate(0)]);
  assert.throws(() => h.run(HISTORY, { retries: Number.MAX_SAFE_INTEGER }), /retry_exhausted=1/);
  assert.equal(h.calls.length, MAX_LARK_RETRIES + 1);
  assert.equal(h.stats().retries, MAX_LARK_RETRIES);
  assert.deepEqual(h.sleeps, []);
});

test("invalid retry configuration falls back to bounded defaults", () => {
  for (const retries of [NaN, Infinity, -1]) {
    const h = harness([rate()]);
    assert.throws(() => h.run(HISTORY, { retries, retryBudgetMs: NaN, timeoutMs: -1 }), /retry_exhausted/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].options.timeout, 120000);
  }
});

test("permission failures never retry or leak args, stderr, stdout, or executable path", () => {
  const h = harness([fail("private permission denied", { stdout: "private output" })], { bin: "/home/private/bin" });
  throwsSafe(() => h.run([...CONTACT, "--token", "Bearer secret", "--params", '{"private":1}'], { retries: 10 }), /kind=permission_denied operation=contact_search/);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.sleeps, []);
  assert.equal(h.stats().exhausted, 0);
});

test("spawn timeout and missing executable errors stay safe", () => {
  const timeout = harness([fail("private body", {
    status: null, signal: "SIGKILL", error: Object.assign(new Error("private"), { code: "ETIMEDOUT" }),
  })], { timeoutMs: 321 });
  throwsSafe(() => timeout.run(HISTORY), /kind=network_timeout timeout_ms=321/);
  assert.equal(timeout.calls[0].options.killSignal, "SIGKILL");
  assert.equal(timeout.stats().timeouts, 1);
  const missing = harness([fail("", { stdout: undefined, stderr: undefined, status: null,
    error: Object.assign(new Error("/home/private/bin"), { code: "ENOENT" }) })]);
  throwsSafe(() => missing.run(HISTORY), /kind=command_unavailable spawn_code=ENOENT/);
});

test("a throwing spawn or malformed success response cannot expose secrets", () => {
  const h = harness([], { spawn() { throw new Error("private Bearer secret /home/private/bin"); } });
  throwsSafe(() => h.run(HISTORY), /kind=spawn_error operation=message_history_bundle/);
  const malformed = harness([ok("private Bearer secret")]);
  throwsSafe(() => malformed.run(HISTORY), /non-JSON output$/);
});

test("CLI errors on stdout are classified, and malformed reset values use fallback", () => {
  const h = harness([fail("", { stdout: JSON.stringify({ error: { subtype: "rate_limit", code: null }, headers: { "x-ogw-ratelimit-reset": "NaN" } }) }), ok()]);
  h.run(HISTORY, { retries: 1 });
  assert.deepEqual(h.sleeps, [30000]);
  assert.equal(h.stats().retry_after_unknown, 1);
});

test("inherited cooldown input accepts only fixed operation keys and future safe integer timestamps", () => {
  const state = createTransportState(JSON.stringify({
    contact_search: EPOCH + 60000, message_history_bundle: EPOCH - 1,
    chat_members: "1800000060000", chat_bots: 1.5, application_info: null,
    other: Number.MAX_SAFE_INTEGER + 1, private_id: EPOCH + 100000,
  }), EPOCH);
  assert.deepEqual(getTransportStats(state, EPOCH).cooldowns_by_operation, { contact_search: EPOCH + 60000 });
  const h = harness([ok()], { state });
  h.run(HISTORY);
  assert.deepEqual(h.sleeps, []);
  throwsSafe(() => h.run(CONTACT, { retryBudgetMs: 1000 }), /retry_after_source=shared.*retry_exhausted/);
  assert.equal(h.calls.length, 1);
  for (const invalid of ["not JSON private", "[]", "null", '"secret"', " ".repeat(16385)]) {
    assert.deepEqual(getTransportStats(createTransportState(invalid, EPOCH), EPOCH).cooldowns_by_operation, {});
  }
  assert.deepEqual(getTransportStats(state, EPOCH + 60000).cooldowns_by_operation, {});
});

test("fresh module reads EXOCORTEX_LARK_COOLDOWNS_JSON without executing the CLI", () => {
  const until = Date.now() + 3600000;
  const moduleUrl = new URL("../src/adapters/lark-im/transport.mjs", import.meta.url).href;
  const script = `import {getTransportStats} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(getTransportStats()));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, EXOCORTEX_LARK_COOLDOWNS_JSON: JSON.stringify({ contact_search: until, secret: until }) },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout).cooldowns_by_operation, { contact_search: until });
});

test("operation identity and telemetry never contain dynamic arguments", () => {
  const cases = [
    [HISTORY, "message_history_bundle"], [SEARCH, "message_search_bundle"],
    [["im", "+chat-list"], "chat_discovery_bundle"], [["contact", "+get-user"], "self_profile"],
    [CONTACT, "contact_search"], [["im", "chat.members", "get"], "chat_members"],
    [["im", "chat.members", "bots"], "chat_bots"],
    [["api", "GET", "/open-apis/application/v6/applications/cli_private"], "application_info"],
    [["private", "token"], "other"],
  ];
  assert.equal(cases.length, TRANSPORT_OPERATIONS.length);
  for (const [args, expected] of cases) assert.equal(transportOperation(args), expected);
  const h = harness([ok()]);
  h.run(["private", "secret"]);
  const snapshot = h.stats();
  snapshot.by_operation.other.calls = 999;
  assert.equal(h.stats().calls, 1, "caller cannot mutate live counters via a snapshot");
  assert.doesNotMatch(JSON.stringify(h.stats()), /private|secret/);
});

test("ordinary transient backoff remains capped", () => {
  assert.equal(retryDelayForAttempt(0, 2000), 2000);
  assert.equal(retryDelayForAttempt(1, 2000), 4000);
  assert.equal(retryDelayForAttempt(4, 2000), 30000);
});
