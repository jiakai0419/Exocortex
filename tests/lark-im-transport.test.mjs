import assert from "node:assert/strict";
import test from "node:test";

import {
  createLarkCliRunner,
  isTransientLarkFailure,
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
  assert.equal(isTransientLarkFailure("permission denied"), false);
});
