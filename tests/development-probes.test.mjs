import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createProbeRunner, probeVersion, PROBE_MAX_BUFFER_BYTES, PROBE_TIMEOUT_MS, validateProbeWindow } from "../src/development/probe-support.mjs";
import { nativeCursorCommand } from "../src/development/cursor-native.mjs";

const PRIVATE = "INVENTED_PRIVATE_SENTINEL_2048";
const START = "2048-06-07T08:00:00Z";
const END = "2048-06-07T09:00:00Z";
const root = resolve(import.meta.dirname, "..");

function fixture(t, failing = false, { at, chats = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-research-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "home"));
  const cli = join(dir, "fake-lark.mjs"); const log = join(dir, "calls.jsonl");
  writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (${failing}) { process.stderr.write("permission denied ${PRIVATE}"); process.exit(1); }
if (args[0] === "--version") { process.stdout.write("lark-cli 7.8.9\\n"); process.exit(0); }
let result = { note: "${PRIVATE}" };
if (args[1] === "+get-user") result = { open_id: "ou_synthetic_native_self" };
if (args[1] === "+chat-list") result = { chats: ${JSON.stringify(chats ? [{ chat_id: "oc_invented_probe_room" }] : [])} };
if (args[2] === "/open-apis/im/v1/messages/search") result = { code: 0, data: { items: [
  { meta_data: { message_id: "om_synthetic_a" } }, { meta_data: { message_id: "om_synthetic_b" } }
] } };
if (args[2] === "/open-apis/im/v1/messages/mget") result = { code: 0, data: { items: [
  { message_id: "om_synthetic_b", create_time: ${JSON.stringify(String(at ?? 2475130200000))}, body: { content: "${PRIVATE}" } },
  { message_id: "om_synthetic_a", create_time: ${JSON.stringify(String(at ?? 2475129900000))}, body: { content: "${PRIVATE}" } }
] } };
if (args[2] === "/open-apis/im/v1/messages" || args[1] === "+chat-messages-list") result = { data: { items: [
  { message_id: "om_invented_chat", create_time: ${JSON.stringify(String(at ?? 2475129900000))}, sender: { id: "ou_invented_other" } }
] } };
if (args[1] === "+messages-search") result = { messages: ${JSON.stringify(at === undefined ? [] : [{ message_id: "om_invented_sent", create_time: String(at) }])} };
process.stdout.write(JSON.stringify(result));
`);
  chmodSync(cli, 0o700);
  const run = (tool, args = []) => spawnSync(process.execPath, [join(root, "tools/probes", tool), ...args], {
    cwd: dir, encoding: "utf8", timeout: 20_000,
    env: { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"), HOME: join(dir, "home"),
      XDG_CONFIG_HOME: join(dir, "home"), XDG_CACHE_HOME: join(dir, "home"), XDG_DATA_HOME: join(dir, "home"),
      TMPDIR: dir, TZ: "UTC", LANG: "C", LARK_CLI: cli },
  });
  return { dir, log, run, calls: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [] };
}

test("metadata never invokes any event command or live sample and writes no report by default", (t) => {
  const f = fixture(t); const result = f.run("capabilities.mjs");
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.mode, "metadata"); assert.equal(summary.api_version, "7.8.9");
  assert.equal(summary.report_written, false);
  assert(f.calls().every((args) => args[0] !== "event"));
  assert(f.calls().every((args) => !args[1]?.startsWith("+") || args.includes("--dry-run")));
  assert.deepEqual(readdirSync(f.dir).sort(), ["calls.jsonl", "fake-lark.mjs", "home"]);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${PRIVATE}|ou_synthetic|${f.dir}`));
});

test("sample requires an explicit bounded window before any command executes", (t) => {
  for (const args of [["--mode", "sample"], ["--mode", "sample", "--start", START, "--end", "2048-06-09T09:00:00Z"],
    ["--mode", "sample", "--start", START, "--end", END, "--page-size", "999"],
    ["--mode", "metadata", "--event-timeout", "1s"]]) {
    const f = fixture(t); const result = f.run("capabilities.mjs", args);
    assert.equal(result.status, 1); assert.deepEqual(f.calls(), []);
  }
});

test("sample is explicit, never consumes events, and detailed reports are opt-in private files", (t) => {
  const f = fixture(t); const output = join(f.dir, "private/report.json");
  const result = f.run("capabilities.mjs", ["--mode", "sample", "--start", START, "--end", END, "--output", output]);
  assert.equal(result.status, 0, result.stderr);
  assert(f.calls().some((args) => args[1] === "+messages-search" && !args.includes("--dry-run")));
  assert(f.calls().every((args) => args[0] !== "event"));
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.match(readFileSync(output, "utf8"), new RegExp(PRIVATE));
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${PRIVATE}|ou_synthetic|${f.dir}`));
});

test("only events mode starts exactly two event sessions, each with count and duration bounds", (t) => {
  const f = fixture(t); const result = f.run("capabilities.mjs", ["--mode", "events", "--event-timeout", "2s"]);
  assert.equal(result.status, 0, result.stderr);
  const sessions = f.calls().filter((args) => args[0] === "event" && args[1] === "consume");
  assert.equal(sessions.length, 2);
  for (const args of sessions) {
    assert.equal(args[args.indexOf("--max-events") + 1], "1");
    assert.equal(args[args.indexOf("--timeout") + 1], "2s");
  }
  assert(f.calls().every((args) => !args[1]?.startsWith("+") || args.includes("--dry-run")));
});

test("probe transport makes exactly one bounded attempt and retains failure evidence only in detail", () => {
  let calls = 0;
  const run = createProbeRunner({ spawn: (_bin, _args, settings) => {
    calls += 1; assert.ok(settings.timeout > 0 && settings.timeout <= PROBE_TIMEOUT_MS); assert.equal(settings.maxBuffer, PROBE_MAX_BUFFER_BYTES);
    assert.equal(settings.killSignal, "SIGKILL");
    return { status: 1, signal: null, stdout: "", stderr: `network timeout ${PRIVATE}` };
  } });
  const result = run("invented", ["api", "GET", "/invented", "--params", PRIVATE], { redactedFlags: ["--params"] });
  assert.equal(calls, 1); assert.equal(result.ok, false);
  assert.match(result.stderr, new RegExp(PRIVATE)); assert.doesNotMatch(result.command, new RegExp(PRIVATE));
});

test("default failure output excludes raw stderr, private paths and command parameters", (t) => {
  const f = fixture(t, true); const result = f.run("capabilities.mjs");
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).failed, f.calls().length);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${PRIVATE}|${f.dir}|permission denied`));
  assert.equal(new Set(f.calls().map(JSON.stringify)).size, f.calls().length, "no automatic retries");
});

test("native cursor is the default and preserves both native response orders without message bodies", (t) => {
  const f = fixture(t); const output = join(f.dir, "cursor.json");
  const result = f.run("cursors.mjs", ["--start", START, "--end", END, "--output", output]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout); const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(summary.api_family, "native"); assert.equal(summary.api_version, "im/v1"); assert.equal(summary.cli_version, "7.8.9");
  assert(f.calls().some((args) => args[0] === "api" && args[2] === "/open-apis/im/v1/messages/search"));
  assert(f.calls().every((args) => !["+messages-search", "+chat-messages-list"].includes(args[1])));
  const search = report.native_observations.find((record) => record.id === "sent_search_page_1");
  const detail = report.native_observations.find((record) => record.id === "sent_search_page_1_mget");
  assert.deepEqual(search.items.map((row) => row.message_id_hash), detail.items.map((row) => row.message_id_hash).reverse());
  assert.doesNotMatch(readFileSync(output, "utf8"), new RegExp(PRIVATE));
  assert.doesNotMatch(result.stdout + result.stderr, /om_synthetic|ou_synthetic|cursor.json/);
});

test("cursor convenience calls occur only with explicit selection; absent output creates no report", (t) => {
  const f = fixture(t); const result = f.run("cursors.mjs", ["--api", "convenience", "--start", START, "--end", END]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).api_family, "convenience");
  assert(f.calls().some((args) => args[1] === "+messages-search")); assert(f.calls().every((args) => args[0] !== "api"));
  assert.deepEqual(readdirSync(f.dir).sort(), ["calls.jsonl", "fake-lark.mjs", "home"]);
});

test("cursor rejects unbounded and invalid arguments before touching the CLI", (t) => {
  for (const args of [[], ["--start", START, "--end", END, "--chat-limit", "6"],
    ["--start", START, "--end", END, "--api", PRIVATE]]) {
    const f = fixture(t); const result = f.run("cursors.mjs", args);
    assert.equal(result.status, 1); assert.deepEqual(f.calls(), []); assert.doesNotMatch(result.stderr, new RegExp(PRIVATE));
  }
});

test("version summaries accept only a numeric version, never arbitrary CLI text", () => {
  assert.equal(probeVersion({ stdout: "lark-cli 1.2.3" }), "1.2.3");
  for (const stdout of [PRIVATE, `1.2.3-${PRIVATE}`, `1.2.3 ${PRIVATE}`]) assert.equal(probeVersion({ stdout }), "unknown");
});

test("malformed JSON is a failed observation with private detail rather than an empty success", () => {
  const run = createProbeRunner({ spawn: () => ({ status: 0, signal: null, stdout: PRIVATE, stderr: "" }) });
  const record = run("invented", ["schema", "invented"]);
  assert.equal(record.ok, false); assert.equal(record.json_parse_failed, true);
  assert.equal(record.stdout_excerpt, PRIVATE);
});

test("explicit native API failure stays a failure even when the CLI process exits zero", () => {
  const json = { code: 210508, msg: `permission denied ${PRIVATE}` };
  const run = createProbeRunner({ spawn: () => ({ status: 0, signal: null, stdout: JSON.stringify(json), stderr: "" }) });
  const record = run("invented", ["api", "GET", "/invented"]);
  assert.equal(record.ok, false); assert.equal(record.exit_code, 0); assert.deepEqual(record.json, json);
  assert.equal(record.failure_kind, "permission_denied");
});

test("native chat probe matches the production endpoint bounds and keeps duplicate source observations", () => {
  const calls = []; const observations = [];
  const rows = [{ message_id: "om_invented_duplicate", create_time: "2475129600001" },
    { message_id: "om_invented_duplicate", create_time: "2475129600001" }];
  const run = (id, args) => {
    calls.push(args); return { id, ok: true, json: { code: 0, data: { items: rows, has_more: true, page_token: "opaque_invented" } } };
  };
  const result = nativeCursorCommand(run, observations, "chat", ["im", "+chat-messages-list",
    "--chat-id", "oc_invented", "--start", "2048-06-07T08:00:00.001Z", "--end", "2048-06-07T08:01:00.001Z",
    "--page-size", "50", "--page-token", "opaque_invented"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ["api", "GET", "/open-apis/im/v1/messages"]);
  const params = JSON.parse(calls[0][calls[0].indexOf("--params") + 1]);
  assert.deepEqual(params, { container_id_type: "chat", container_id: "oc_invented", only_thread_root_messages: false,
    sort_type: "ByCreateTimeAsc", page_size: 50, card_msg_content_type: "raw_card_content",
    start_time: String(Math.floor(Date.parse("2048-06-07T08:00:00.001Z") / 1000)),
    end_time: String(Math.ceil(Date.parse("2048-06-07T08:01:00.001Z") / 1000)), page_token: "opaque_invented" });
  assert.equal(result.json.data.items, rows, "no normalization or deduplication");
  assert.equal(observations[0].items.length, 2);
  assert.deepEqual(observations[0].request_time_range, { start_time: params.start_time, end_time: params.end_time });
});

test("oversized native search response remains observable without an unbounded detail request", () => {
  const observations = []; let calls = 0;
  const rows = Array.from({ length: 31 }, (_, index) => ({ meta_data: { message_id: `om_invented_${index}` } }));
  const result = nativeCursorCommand((id) => { calls += 1; return { id, ok: true, json: { code: 0, data: { items: rows } } }; }, observations,
    "sent", ["im", "+messages-search", "--sender", "ou_invented", "--start", START, "--end", END, "--page-size", "50"]);
  assert.equal(calls, 1); assert.equal(observations[0].request_page_size, 30);
  assert.equal(observations[0].items.length, 31); assert.equal(result.json.data.items, rows);
});

test("invalid calendar dates are rejected by both tools before the first CLI call", (t) => {
  for (const tool of ["capabilities.mjs", "cursors.mjs"]) {
    for (const [start, end] of [["2030-02-30T08:00:00Z", "2030-03-02T09:00:00Z"],
      ["2030-02-28T23:00:00Z", "2030-02-29T00:00:00Z"],
      ["2048-06-07T24:00:00Z", "2048-06-08T01:00:00Z"]]) {
      const f = fixture(t);
      const result = f.run(tool, [...(tool === "capabilities.mjs" ? ["--mode", "sample"] : []), "--start", start, "--end", end]);
      assert.equal(result.status, 1, `${tool}: ${start} -> ${end}`); assert.deepEqual(f.calls(), []);
    }
  }
});

test("strict probe calendars retain valid leap days, precision, offsets and the exact 24-hour limit", () => {
  for (const [start, end] of [["2048-02-29T08:00:00Z", "2048-03-01T08:00:00Z"],
    ["2000-02-29T08:00:00.01+05:30", "2000-02-29T08:00:00.011+05:30"],
    ["2030-06-07T08:00-03:30", "2030-06-07T09:00-03:30"]]) assert.doesNotThrow(() => validateProbeWindow(start, end));
  for (const [start, end] of [["2100-02-29T08:00:00Z", "2100-03-01T09:00:00Z"],
    ["2048-02-29T08:00:00Z", "2048-03-01T08:00:00.001Z"],
    ["2030-06-07T08:00:00+05:60", "2030-06-07T09:00:00+05:60"], [START, START]]) assert.throws(() => validateProbeWindow(start, end));
});

test("native and convenience cursor boundaries cannot expand, invert or empty the requested window", (t) => {
  for (const api of ["native", "convenience"]) {
    for (const at of [Date.parse("2000-01-01T00:00:00Z"), Date.parse("2050-01-01T00:00:00Z"), Date.parse(END), "invalid-invented-time"]) {
      const f = fixture(t, false, { at, chats: true }); const output = join(f.dir, "bounded.json");
      const result = f.run("cursors.mjs", ["--api", api, "--start", START, "--end", END, "--output", output]);
      assert.equal(result.status, 2, `${api}: ${at}`);
      const summary = JSON.parse(result.stdout); const report = JSON.parse(readFileSync(output, "utf8"));
      assert.equal(summary.incomplete, true); assert.equal(summary.ok, false);
      for (const page of [report.probes.sent_by_me, ...report.probes.received_from_unmuted_chats.chats]) {
        assert.equal(page.start_boundary_probe.skipped, true); assert.equal(page.start_boundary_probe.incomplete, true);
        assert.equal(page.first_page.messages.at(-1).create_time_raw, String(at), "retain original anomalous observation");
      }
      const calls = f.calls().filter((args) => ["+messages-search", "+chat-messages-list"].includes(args[1]) ||
        ["/open-apis/im/v1/messages", "/open-apis/im/v1/messages/search"].includes(args[2]));
      assert.equal(calls.length, 2, "only original sent/chat windows, no invalid boundary request");
    }
  }
});

test("valid returned boundaries keep both probes inside the explicit window including an exact-start boundary", (t) => {
  const windows = [[START, END, Date.parse(START)], [START, END, Date.parse(START) + 30 * 60_000],
    ["1969-12-31T23:30:00Z", "1970-01-01T00:30:00Z", 0]];
  for (const api of ["native", "convenience"]) for (const [start, end, at] of windows) {
    const f = fixture(t, false, { at, chats: true }); const output = join(f.dir, "valid-boundary.json");
    const result = f.run("cursors.mjs", ["--api", api, "--start", start, "--end", end, "--output", output]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(output, "utf8"));
    for (const page of [report.probes.sent_by_me, ...report.probes.received_from_unmuted_chats.chats]) {
      assert.equal(Date.parse(page.start_boundary_probe.start), at); assert.equal(page.start_boundary_probe.boundary_returned, true);
    }
  }
});
