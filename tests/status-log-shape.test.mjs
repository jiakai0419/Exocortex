import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { runCli } from "../bin/exocortex.mjs";
import { runStatusCommand } from "../src/cli/status-command.mjs";
import { formatLogLine } from "../src/terminal/status-log-view.mjs";
import { statusWidth } from "../src/terminal/status-layout.mjs";
import { plain } from "../dist/terminal/index.js";

// Entirely invented reports and log files. The CLI reads only these temporary
// logs; its service/config/database collectors are replaced at their boundary.
const NOW = Date.parse("2037-04-05T12:00:00Z");
const AT = "2037-04-05T11:59:00Z";
const cycle = { type: "lark_im_worker_cycle", at: AT, cycle: 9, ok: true };
const step = { type: "lark_im_worker_step", started_at: AT, finished_at: AT, cycle: 9,
  name: "received-fair", ok: false, exit_code: 2, stderr: "invented failure" };
const malformed = [null, false, 17, "invented JSON string", [], [cycle], {},
  ...[undefined, null, 0, 1, "false", [], {}].flatMap((ok) => [{ ...cycle, ok }, { ...step, ok }]),
  { ...cycle, at: {} }, { ...cycle, cycle: "9" }, { ...cycle, cycle: -1 },
  { ...step, stderr: 7 }, { ...step, stderr: {} }, { ...step, name: {} },
  { ...step, exit_code: {} }, { ...step, finished_at: {} }, { ...step, summary: [] },
  { ...step, summary: { sent: true } }, { ...step, summary: { received: [] } },
  { ...step, summary: { sent: { records: {} } } },
  { ...step, summary: { discovery: { skipped: "false" } } },
  { ...step, summary: { discovery: { has_more: [] } } },
  { ...step, summary: { discovery: { mode: {} } } }];

test("private-log scalars and malformed event fields retain the original line without inventing results", () => {
  for (const value of malformed) {
    const line = JSON.stringify(value);
    assert.equal(formatLogLine(line), line);
  }
  for (const line of ["invented plain stderr", "{incomplete", ""]) assert.equal(formatLogLine(line), line);
});

test("valid cycle and step logs retain their established compact summaries", () => {
  assert.equal(plain(formatLogLine(JSON.stringify(cycle))), `${AT} cycle=9 OK`);
  assert.equal(plain(formatLogLine(JSON.stringify({ ...cycle, ok: false }))), `${AT} cycle=9 FAILED`);
  const summary = { sent: { run_id: 12, records: 4, inserted: 3 },
    discovery: { run_id: 13, mode: "catchup", pages: 2, discovered_in_run: 6, has_more: true },
    received: { scopes: 2, records: 5, inserted: 4, failed: 1 } };
  assert.equal(plain(formatLogLine(JSON.stringify({ ...step, summary }))),
    `${AT} cycle=9 received-fair FAILED exit=2 run=12 records=4 inserted=3 run=13 mode=catchup pages=2 discovered=6 has_more=true scopes=2 records=5 inserted=4 failed=1 stderr=invented failure`);
  const skipped = { ...step, ok: true, exit_code: 0, stderr: "", summary: {
    sent: null, discovery: { skipped: true, reason: "interval", mode: "reconcile", has_more: false }, received: null } };
  assert.equal(plain(formatLogLine(JSON.stringify(skipped))), `${AT} cycle=9 received-fair OK SKIPPED interval mode=reconcile has_more=false`);
  skipped.summary.discovery = { skipped: true, reason: "interval", mode: "reconcile", has_more: null,
    run_id: null, pages: {}, discovered_in_run: [] };
  assert.equal(plain(formatLogLine(JSON.stringify(skipped))), `${AT} cycle=9 received-fair OK SKIPPED interval mode=reconcile has_more=null`);
  assert.equal(plain(formatLogLine(JSON.stringify({ ...step, summary: null, exit_code: undefined }))),
    `${AT} cycle=9 received-fair FAILED exit=undefined stderr=invented failure`);
});

function report() {
  return { probe: { status: "absent", loaded: false, pid: null },
    overview: { health: { status: "problem", reason: "service_stopped" },
      activity: { state: "stopped", phase: "stopped", source: "none", evidence: "no_current_process_observed", reason: "no_current_sync_observed" },
      freshness: { status: "unknown", reason: "no_cached_probe" },
      leases: { evidence: "available", total: 0, occupied_count: 0, abnormal_count: 0, reasons: [] } },
    sync: { status: { health: "ok", records: { total: 3, by_direction: [{ direction: "received", count: 3 }] },
      scopes: { total: 1, enabled: 1, received_enabled: 1, received_without_cursor: 0, message_enabled: 1, message_without_success: 0, received_unsupported: 0, unsupported_reasons: [] },
      discovery: { complete: true }, reconcile: { complete: true }, hot_discovery: { ran: false },
      details: { evidence: "available", pending_count: 0, due_count: 0, scopes_pending: 0 },
      list_progress: { evidence: "available", scopes: 1, invalid_cursor_scopes: 0 }, runs: { by_status: { succeeded: 1 } }, locks: [] } },
    worker: { log: { events: [], exists: false }, summary: {} },
    failure_runs: { evidence: "available", failed_runs: 0, by_kind: [], window_ms: 86400000 } };
}

function logDirectory(t, lines, filename) {
  const directory = mkdtempSync(join(tmpdir(), "invented-status-log-shape-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, filename);
  writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  return { directory, file };
}

async function invoke(directory, columns, flags) {
  let output = "", error = "";
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }), { columns, isTTY: false });
  const stderr = new Writable({ write(chunk, _encoding, done) { error += chunk; done(); } });
  const code = await runCli(["status", "--db", join(directory, "invented-unopened.sqlite"), "--log-dir", directory, ...flags], {
    stdout, stderr, now: () => NOW,
    loadCommand: async (group) => {
      assert.equal(group, "status");
      return { runStatusCommand: (options, context) => runStatusCommand(options, context, {
        readInstalledServiceConfig: () => ({ status: "missing" }), buildServiceStatusReport: () => report(),
      }) };
    },
  });
  assert.equal(code, 0, error);
  assert.equal(error, "");
  return output;
}

for (const filename of ["worker.jsonl", "launchd.err.log"]) for (const columns of [80, 40]) {
  test(`real status CLI retains the whole ${columns}-column screen with malformed ${filename}`, async (t) => {
    const lines = ["null", JSON.stringify({ ...step, stderr: 7 }), JSON.stringify({ ...cycle, ok: "false" }),
      "invented raw stderr", "{incomplete", JSON.stringify(cycle), JSON.stringify(step)];
    const { directory, file } = logDirectory(t, lines, filename);
    const before = readFileSync(file), mode = statSync(file).mode;
    const ordinary = await invoke(directory, columns, []);
    const output = await invoke(directory, columns, ["--logs"]);
    assert.equal(output.slice(0, output.indexOf("\nPRIVATE LOGS\n")), ordinary.trimEnd() + "\n");
    assert.match(output, /Exocortex status[\s\S]*Messages & progress[\s\S]*PRIVATE LOGS/);
    assert.match(output, /\nnull\n/);
    assert.match(output, /invented raw stderr/);
    const privateText = output.slice(output.indexOf("\nPRIVATE LOGS\n"));
    assert.ok(privateText.replace(/\s/g, "").includes(JSON.stringify({ ...step, stderr: 7 }).replace(/\s/g, "")));
    assert.ok(privateText.replace(/\s/g, "").includes(JSON.stringify({ ...cycle, ok: "false" })));
    assert.match(privateText.replace(/\s+/g, " "), /cycle=9 OK/);
    assert.match(privateText.replace(/\s+/g, " "), /received-fair FAILED exit=2/);
    for (const line of output.split("\n")) assert.ok(statusWidth(line) <= columns, line);
    const json = JSON.parse(await invoke(directory, columns, ["--logs", "--format", "json"]));
    assert.equal(json.privacy, "private");
    assert.deepEqual(json.logs.find((log) => log.name === filename).lines, lines);
    const ordinaryJson = JSON.parse(await invoke(directory, columns, ["--format", "json"]));
    const { logs, privacy, ...publicFields } = json;
    assert.deepEqual({ ...publicFields, privacy: "public-safe" }, ordinaryJson);
    assert.deepEqual(readFileSync(file), before);
    assert.equal(statSync(file).mode, mode);
  });
}

test("real status CLI sanitizes private controls in raw fallback and valid summaries while JSON retains source lines", async (t) => {
  const controls = "invented-visible\u001b[2J\u202e\u001b]52;c;INVENTED_CLIPBOARD\u0007 tail";
  const lines = [controls, JSON.stringify({ ...step, stderr: controls })];
  const { directory } = logDirectory(t, lines, "launchd.err.log");
  const output = await invoke(directory, 40, ["--logs"]);
  assert.match(output, /PRIVATE LOGS/);
  assert.doesNotMatch(output, /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]|INVENTED_CLIPBOARD/);
  assert.equal((output.match(/invented-visible/g) || []).length, 2);
  const json = JSON.parse(await invoke(directory, 40, ["--logs", "--format", "json"]));
  assert.deepEqual(json.logs[1].lines, lines);
});
