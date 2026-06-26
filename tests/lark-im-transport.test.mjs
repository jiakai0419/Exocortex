import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyLarkFailure,
  createLarkCliRunner,
  isTransientLarkFailure,
  retryDelayForAttempt,
  parseJson,
  redactCommand,
} from "../src/adapters/lark-im/transport.mjs";

test("parseJson returns objects, null for empty output, and rejects malformed JSON", () => {
  assert.deepEqual(parseJson('{"ok":true}'), { ok: true });
  assert.equal(parseJson(""), null);
  assert.throws(() => parseJson("not json"), /non-JSON output/);
});

test("redactCommand hides sensitive flag values", () => {
  assert.equal(
    redactCommand(["im", "+chat-messages-list", "--chat-id", "oc_secret", "--page-token", "pt_secret"], [
      "--chat-id",
      "--page-token",
    ]),
    "lark-cli im +chat-messages-list --chat-id <redacted> --page-token <redacted>",
  );
});

test("createLarkCliRunner retries transient failures and parses the successful response", () => {
  const calls = [];
  const sleeps = [];
  const run = createLarkCliRunner({
    bin: "fake-lark-cli",
    sleep(ms) {
      sleeps.push(ms);
    },
    spawn(cmd, args, options) {
      calls.push({ cmd, args, options });
      if (calls.length === 1) {
        return {
          status: 1,
          signal: null,
          output: [],
          pid: 1,
          stdout: "",
          stderr: JSON.stringify({
            error: { type: "api", code: 2200, message: "Internal Error" },
          }),
        };
      }
      return {
        status: 0,
        signal: null,
        output: [],
        pid: 2,
        stdout: '{"ok":true,"data":{"items":[1]}}',
        stderr: "",
      };
    },
  });

  const result = run(["im", "+chat-list", "--format", "json"], { retries: 1, retryDelayMs: 7 });

  assert.deepEqual(result, { ok: true, data: { items: [1] } });
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [7]);
  assert.equal(calls[0].cmd, "fake-lark-cli");
  assert.equal(calls[0].options.encoding, "utf8");
});

test("createLarkCliRunner retries Lark rate limits with deterministic backoff", () => {
  const calls = [];
  const sleeps = [];
  const run = createLarkCliRunner({
    sleep(ms) {
      sleeps.push(ms);
    },
    spawn(cmd, args) {
      calls.push({ cmd, args });
      if (calls.length <= 2) {
        return {
          status: 1,
          signal: null,
          output: [],
          pid: calls.length,
          stdout: "",
          stderr: JSON.stringify({
            ok: false,
            error: { type: "api", code: 9499, message: "too many request" },
          }),
        };
      }
      return {
        status: 0,
        signal: null,
        output: [],
        pid: 3,
        stdout: '{"ok":true,"data":{"items":[]}}',
        stderr: "",
      };
    },
  });

  const result = run(["im", "+messages-search", "--sender", "ou_secret", "--format", "json"], {
    retries: 2,
    retryDelayMs: 5,
    redactedFlags: ["--sender"],
  });

  assert.deepEqual(result, { ok: true, data: { items: [] } });
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [5, 10]);
});

test("createLarkCliRunner preserves a redacted error after retry budget is exhausted", () => {
  const sleeps = [];
  const run = createLarkCliRunner({
    sleep(ms) {
      sleeps.push(ms);
    },
    spawn() {
      return {
        status: 1,
        signal: null,
        output: [],
        pid: 1,
        stdout: "",
        stderr: JSON.stringify({
          ok: false,
          error: { type: "api", code: 9499, message: "too many request" },
        }),
      };
    },
  });

  assert.throws(
    () => run(["im", "+messages-search", "--sender", "ou_secret"], {
      retries: 2,
      retryDelayMs: 3,
      redactedFlags: ["--sender"],
    }),
    /lark-cli im \+messages-search --sender <redacted> failed: .*too many request/s,
  );
  assert.deepEqual(sleeps, [3, 6]);
});

test("createLarkCliRunner does not retry non-transient failures and redacts the error command", () => {
  const run = createLarkCliRunner({
    spawn() {
      return {
        status: 1,
        signal: null,
        output: [],
        pid: 1,
        stdout: "",
        stderr: "permission denied",
      };
    },
  });

  assert.throws(
    () => run(["contact", "+search-user", "--user-ids", "ou_secret"], { retries: 3, redactedFlags: ["--user-ids"] }),
    /lark-cli contact \+search-user --user-ids <redacted> failed: permission denied/,
  );
});

test("isTransientLarkFailure classifies known transient Lark failures", () => {
  assert.equal(isTransientLarkFailure("TLS handshake timeout"), true);
  assert.equal(isTransientLarkFailure(JSON.stringify({ error: { type: "network", subtype: "timeout" } })), true);
  assert.equal(isTransientLarkFailure(JSON.stringify({ error: { type: "api", code: 9499, message: "too many request" } })), true);
  assert.equal(isTransientLarkFailure("permission denied"), false);
});

test("classifyLarkFailure exposes public-safe failure kinds", () => {
  assert.deepEqual(classifyLarkFailure("TLS handshake timeout"), {
    kind: "network_timeout",
    transient: true,
    code: null,
    message: "network timeout",
  });
  assert.deepEqual(
    classifyLarkFailure(
      'lark-cli im +messages-search --sender <redacted> failed: {"error":{"type":"api","code":9499,"message":"too many request"}}',
    ),
    {
      kind: "rate_limited",
      transient: true,
      code: 9499,
      message: "too many request",
    },
  );
  assert.deepEqual(classifyLarkFailure(JSON.stringify({ error: { type: "api", code: 2200, message: "scope fail" } })), {
    kind: "unknown",
    transient: false,
    code: 2200,
    message: "scope fail",
  });
});

test("retryDelayForAttempt applies capped exponential backoff", () => {
  assert.equal(retryDelayForAttempt(0, 2000), 2000);
  assert.equal(retryDelayForAttempt(1, 2000), 4000);
  assert.equal(retryDelayForAttempt(4, 2000), 30000);
});
