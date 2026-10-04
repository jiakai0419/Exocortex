import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const PRIVATE = "INVENTED_PRIVATE_PROBE_OUTCOME_2052";
const SELF = "ou_invented_outcome_self";
const root = resolve(import.meta.dirname, "..");

// Each child gets an in-memory spawn replacement before importing transport.
// No real account command can execute, including error/signal exit-zero cases.
function probe(t, api, scenario = {}, output = true) {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-probe-outcome-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, "preload.mjs"); const callsPath = join(dir, "calls.jsonl");
  writeFileSync(preload, `import child from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const scenario = ${JSON.stringify(scenario)};
child.spawnSync = (bin, args, options) => {
  if (bin !== "invented-lark-cli" || options.timeout > 10000 || options.maxBuffer !== 20 * 1024 * 1024) throw new Error("Unexpected executor configuration");
  appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
  const result = { status: 0, signal: null, stdout: "", stderr: "" };
  if (args[0] === "--version") {
    result.stdout = scenario.versionText ?? "lark-cli 4.5.6";
    if (scenario.versionMode === "nonzero") { result.status = 7; result.stderr = ${JSON.stringify(PRIVATE)}; }
    if (scenario.versionMode === "error") { result.stdout = '{"ok":true}'; result.error = new Error(${JSON.stringify(PRIVATE)}); }
    if (scenario.versionMode === "signal") { result.stdout = '{"ok":true}'; result.signal = "SIGTERM"; result.stderr = ${JSON.stringify(PRIVATE)}; }
    return result;
  }
  if (args[1] === "+get-user") { result.stdout = JSON.stringify(Object.hasOwn(scenario,"self") ? scenario.self : { open_id: ${JSON.stringify(SELF)} }); return result; }
  if (args[1] === "+chat-list") { result.stdout = '{"chats":[]}'; return result; }
  if (args[1] === "+messages-search" || args[2] === "/open-apis/im/v1/messages/search") {
    if (scenario.pageFailure) { result.status = 1; result.stderr = ${JSON.stringify(PRIVATE)}; }
    else result.stdout = args[0] === "api" ? '{"code":0,"data":{"items":[]}}' : '{"messages":[]}';
    return result;
  }
  throw new Error("Unrequested CLI scope");
};
syncBuiltinESMExports();
`);
  const reportPath = join(dir, "report.json");
  const result = spawnSync(process.execPath, ["--import", preload, join(root, "tools/probes/cursors.mjs"),
    "--api", api, "--start", "2052-06-01T08:00:00Z", "--end", "2052-06-01T09:00:00Z", ...(output ? ["--output", reportPath] : [])], {
    cwd: dir, encoding: "utf8", timeout: 10000,
    env: { PATH: "/invented/no-commands", HOME: dir, TMPDIR: dir, TZ: "UTC", LARK_CLI: "invented-lark-cli" },
  });
  assert.ifError(result.error);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, new RegExp(`${PRIVATE}|${SELF}|${dir}`));
  const calls = readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((args) => args[0] === "--version").length, 1);
  assert.equal(calls.filter((args) => args[1] === "+get-user").length, 1);
  if (!output) assert.deepEqual(readdirSync(dir).sort(), ["calls.jsonl", "preload.mjs"]);
  return { result, summary: JSON.parse(result.stdout), calls, report: output ? JSON.parse(readFileSync(reportPath, "utf8")) : null };
}

for (const api of ["native", "convenience"]) {
  for (const versionMode of ["nonzero", "error", "signal"]) {
    test(`${api}: version ${versionMode} cannot be masked by healthy cursor pages`, (t) => {
      const { result, summary, report, calls } = probe(t, api, { versionMode });
      assert.equal(result.status, 1); assert.equal(summary.ok, false); assert.equal(summary.failed, 1);
      assert.equal(report.commands.version.ok, false);
      if (versionMode === "error") assert.equal(report.commands.version.execution_error, true);
      if (versionMode === "signal") assert.equal(report.commands.version.signal, "SIGTERM");
      if (versionMode === "nonzero") assert.equal(report.commands.version.stderr, PRIVATE);
      assert.equal(calls.length, 4, "scope and attempts remain unchanged");
    });
  }
  for (const versionText of ["", PRIVATE, `4.5.6-${PRIVATE}`]) {
    test(`${api}: an unrecognized successful version is incomplete`, (t) => {
      const { result, summary, report } = probe(t, api, { versionText });
      assert.equal(result.status, 2); assert.equal(summary.ok, false); assert.equal(summary.incomplete, true);
      assert.equal(summary.cli_version, "unknown"); assert.equal(report.commands.version.stdout, versionText);
    });
  }
  for (const self of [{}, null, [], { open_id: "" }, { open_id: "  " }, { open_id: 7 }, { open_id: true },
    { open_id: { invented: PRIVATE } }, { open_id: [SELF] }, { data: { user: { open_id: "\u0000invented" } } }]) {
    test(`${api}: identity ${JSON.stringify(self)} cannot produce complete success`, (t) => {
      const { result, summary, report, calls } = probe(t, api, { self });
      assert.equal(result.status, 2); assert.equal(summary.ok, false); assert.equal(summary.incomplete, true);
      assert.equal(report.commands.self.open_id_present, false);
      assert.deepEqual(report.probes.sent_by_me, { skipped: true, incomplete: true, reason: "self_open_id_unavailable" });
      assert.equal(calls.length, 3, "missing identity must not expand to a sent query");
      assert.equal(report.probes.received_from_unmuted_chats.chat_list.ok, true);
    });
  }
  for (const self of [{ open_id: SELF }, { user: { open_id: SELF } }, { data: { open_id: SELF } },
    { data: { user: { open_id: SELF } } }, { data: { user_id: { open_id: SELF } } }]) {
    test(`${api}: valid identity envelope remains a healthy positive`, (t) => {
      const { result, summary, report, calls } = probe(t, api, { self });
      assert.equal(result.status, 0); assert.equal(summary.ok, true); assert.equal(summary.incomplete, false);
      assert.equal(summary.failed, 0); assert.equal(summary.cli_version, "4.5.6"); assert.equal(calls.length, 4);
      assert.equal(report.commands.version.ok, true); assert.equal(report.commands.self.open_id_present, true);
    });
  }
  test(`${api}: page failures still count alongside a failed version`, (t) => {
    const { result, summary } = probe(t, api, { versionMode: "nonzero", pageFailure: true });
    assert.equal(result.status, 1); assert.equal(summary.failed, 2); assert.equal(summary.ok, false);
  });
  test(`${api}: a page failure alone retains valid-probe exit two`, (t) => {
    const { result, summary } = probe(t, api, { pageFailure: true });
    assert.equal(result.status, 2); assert.equal(summary.failed, 1); assert.equal(summary.ok, false);
  });
  test(`${api}: failed metadata never writes private detail without output`, (t) => {
    const { result, summary } = probe(t, api, { versionMode: "nonzero", self: {} }, false);
    assert.equal(result.status, 1); assert.equal(summary.failed, 1); assert.equal(summary.incomplete, true);
    assert.equal(summary.report_written, false);
  });
}
