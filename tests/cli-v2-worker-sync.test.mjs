import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandContext } from "../src/cli/context.mjs";
import { parseRouteOptions } from "../src/cli/registry.mjs";
import { runSyncCommand } from "../src/cli/sync-command.mjs";
import { normalizeSyncOptions } from "../src/adapters/lark-im/sync-command.mjs";
import { main, parseArgs, runCycle, runStep } from "../src/runtime/worker/worker.mjs";
import { WORKER_DEFAULTS, WORKER_OPTION_SPECS, workerProgramArguments,
  parseWorkerProgramArguments } from "../src/runtime/worker/options.mjs";

const instant = Date.parse("2028-04-12T08:00:00Z");
const context = () => createCommandContext({ root: "/synthetic-install", cwd: "/synthetic-invocation", now: () => instant, env: {} });

function sync(argv, results, ctx = context()) {
  let stdout = ""; let stderr = "";
  const parsed = parseRouteOptions("sync", argv, { context: ctx });
  const code = runSyncCommand(parsed.options, { ...ctx, provided: parsed.provided,
    stdout: { write: (text) => { stdout += text; } }, stderr: { write: (text) => { stderr += text; } },
    deps: { ensureInitialized() {}, ensureSourceInitialSyncStart: (_db, _source, value) => value,
      resetTransportStats() {}, getTransportStats: () => ({ calls: 0 }),
      getSelfProfile: () => ({ open_id: "synthetic-user", name: "Synthetic User" }),
      syncRunner: { syncSent: () => results.sent, syncDiscovery: () => results.discovery,
        syncReceived: () => results.received || [], retryDetails: () => results.details || [] } } });
  return { code, stdout, stderr, summary: stdout ? JSON.parse(stdout) : null };
}

test("sync partial commits and retryable detail debt use exit 2 while complete failures use 1", () => {
  const partial = sync(["--scope", "sent"], { sent: { ok: false, list_complete: true,
    incomplete: true, pending_details: 1, inserted: 3, updated: 0, duplicate: 0 } });
  assert.equal(partial.code, 2);
  assert.equal(partial.summary.partial, true);
  assert.equal(partial.summary.sent.inserted, 3);
  assert.equal(partial.summary.sent.pending_details, 1);
  assert.equal(partial.stderr, "");
  const mixed = sync([], { sent: { ok: false }, discovery: { ok: true }, received: [] });
  assert.equal(mixed.code, 2);
  assert.equal(mixed.summary.incomplete, false);
  assert.equal(sync(["--scope", "sent"], { sent: { ok: false } }).code, 1);
  assert.equal(sync(["--scope", "sent"], { sent: { ok: true } }).code, 0);
  const deferred = sync(["--scope", "details"], { details: [{ ok: false, incomplete: true,
    reason: "details_pending", pending_details: 2, detail_attempts: 0 }] });
  assert.equal(deferred.code, 2);
  assert.equal(deferred.summary.details[0].pending_details, 2);
});

test("worker preserves partial committed counts and debt without reporting a healthy step", () => {
  const result = sync(["--scope", "sent"], { sent: { ok: false, list_complete: true,
    incomplete: true, pending_details: 2, inserted: 3, updated: 1, duplicate: 0 } });
  const step = runStep("sent", [], { nowMs: () => instant,
    spawnSync: () => ({ status: result.code, stdout: result.stdout, stderr: result.stderr }) });
  assert.equal(step.ok, false);
  assert.equal(step.partial, true);
  assert.equal(step.exit_code, 2);
  assert.equal(step.summary.partial, true);
  assert.equal(step.summary.sent.inserted, 3);
  assert.equal(step.summary.sent.pending_details, 2);
  assert.equal(step.summary.sent.list_complete, true);
  const debt = sync(["--scope", "received"], { received: [{ ok: false, incomplete: true, pending_details: 3, inserted: 4 }] });
  const received = runStep("received-fair", [], { spawnSync: () => ({ status: 2, stdout: debt.stdout, stderr: "" }) });
  assert.equal(received.summary.received.pending_details, 3);
  assert.equal(received.summary.received.inserted, 4);
  assert.equal(received.summary.received.failed, 1);
});

test("sync captures its dynamic time once and registry resolves default versus explicit paths", () => {
  let clocks = 0;
  const ctx = context();
  const parsed = parseRouteOptions("sync", [], { context: ctx });
  const opts = normalizeSyncOptions(parsed.options, { provided: parsed.provided, now: () => { clocks++; return instant; } });
  assert.equal(clocks, 1);
  assert.equal(opts.endMs, instant);
  assert.equal(opts.db, "/synthetic-install/data/exocortex.sqlite");
  const explicit = parseRouteOptions("sync", ["--db", "explicit.sqlite"], { context: ctx });
  assert.equal(explicit.options.db, "/synthetic-invocation/explicit.sqlite");
  const observed = sync(["--scope", "sent"], { sent: { ok: true } }, { ...ctx, now: () => instant + 60_000 });
  assert.equal(Date.parse(observed.summary.window.end), instant, "window default uses the invocation clock captured before dispatch");
});

test("internal worker uses root defaults while its registered bridge retains cwd defaults", () => {
  function observe(argv, extra = {}) {
    let observed;
    assert.equal(main(argv, { root: "/synthetic-install", cwd: "/synthetic-invocation",
      runWorker: (opts) => { observed = opts; return true; }, ...extra }), 0);
    return observed;
  }
  const current = observe(["--once"]);
  assert.equal(current.db, "/synthetic-install/data/exocortex.sqlite");
  assert.equal(current.logDir, "/synthetic-install/logs/lark-im");
  const explicit = observe(["--db", "explicit.sqlite", "--log-dir", "explicit-logs", "--once"]);
  assert.equal(explicit.db, "/synthetic-invocation/explicit.sqlite");
  assert.equal(explicit.logDir, "/synthetic-invocation/explicit-logs");
  const bridge = observe(["--once"], { legacyPaths: true });
  assert.equal(bridge.db, "/synthetic-invocation/data/exocortex.sqlite");
  assert.equal(bridge.logDir, "/synthetic-invocation/logs/lark-im");
});

test("persistent worker arguments contain db plus exactly 13 common and 4 adaptive fields", () => {
  assert.equal(WORKER_OPTION_SPECS.length, 18);
  const config = { ...WORKER_DEFAULTS, db: "/synthetic/data.sqlite", logDir: "/synthetic/logs", adaptiveFair: true };
  const args = workerProgramArguments({ ...config, maxCycles: 2, once: true });
  assert.deepEqual(parseWorkerProgramArguments(args), config);
  assert.ok(!args.includes("--once") && !args.includes("--max-cycles"));
  assert.throws(() => parseWorkerProgramArguments(["--once"]), /foreground worker only/);
  assert.throws(() => parseWorkerProgramArguments(["--max-cycles", "2"]), /foreground worker only/);
  assert.equal(parseWorkerProgramArguments([]).db, "data/exocortex.sqlite", "read-only argv decoding must not assume dist is the install root");
});

test("worker routes all child steps through bin with retained timeout and JSON retention protocol", () => {
  const calls = [];
  assert.equal(runCycle({ ...parseArgs(["--once", "--retention-every-cycles", "1"]), logDir: "" }, 1, {
    nowMs: () => instant, writeLog: { stdout: { write() {} } },
    runStep: { spawnSync: (_cmd, args, opts) => { calls.push({ args, opts }); return { status: 0, stdout: '{"ok":true}', stderr: "" }; } },
  }), true);
  assert.equal(calls.length, 7);
  for (const call of calls) {
    assert.match(call.args[0], /\/bin\/exocortex\.mjs$/);
    assert.equal(call.opts.timeout, 600_000);
    assert.equal(call.opts.killSignal, "SIGKILL");
  }
  assert.ok(calls.slice(0, 6).every((call) => call.args[1] === "sync"));
  assert.deepEqual(calls[6].args.slice(1), ["maintenance", "prune-runs", "--db", "data/exocortex.sqlite", "--apply", "--format", "json"]);
});

test("actual child timeout and signal termination never become successful worker steps", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-invented-worker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const waiting = join(dir, "waiting.mjs");
  const cancelled = join(dir, "cancelled.mjs");
  writeFileSync(waiting, 'setTimeout(() => {}, 10000);\n');
  writeFileSync(cancelled, 'process.kill(process.pid, "SIGTERM");\n');
  for (const [scriptPath, timeoutSeconds] of [[waiting, 0.05], [cancelled, 5]]) {
    const result = runStep("synthetic-termination", [], { scriptPath, timeoutSeconds, nowMs: () => instant });
    assert.equal(result.ok, false);
    assert.equal(result.summary, null);
    assert.equal(result.exit_code, undefined);
    assert.match(result.stderr, /timed|ETIMEDOUT|terminated/);
  }
});

for (const abnormal of [
  { error: new Error("synthetic spawn failure") },
  { signal: "SIGTERM" },
  { signal: "SIGKILL", error: new Error("synthetic buffer failure") },
]) {
  test(`process error or signal defeats healthy child JSON and a complete cycle: ${abnormal.signal || "error"}`, () => {
    const child = { status: 0, stdout: '{"ok":true,"sent":{"ok":true,"inserted":1}}', stderr: "", ...abnormal };
    const step = runStep("sent", [], { nowMs: () => instant, spawnSync: () => child });
    assert.equal(step.ok, false);
    assert.ok(step.stderr.length > 0);
    let cycle;
    assert.equal(runCycle({ ...parseArgs(["--once"]), logDir: "" }, 1, {
      nowMs: () => instant, runStep: { spawnSync: () => child },
      writeLog: { stdout: { write: (line) => { const event = JSON.parse(line); if (event.type === "lark_im_worker_cycle") cycle = event; } } },
    }), false);
    assert.equal(cycle.ok, false);
    assert.equal(cycle.failed_steps.length, 6);
  });
}

for (const stage of ["initialize", "baseline", "profile", "sync"]) {
  test(`public sync failure hides arbitrary dependency text from ${stage}`, () => {
    let stdout = ""; let stderr = "";
    const privateText = "SYNTHETIC_PRIVATE_SYNC_FAILURE /invented/private-path?token=INVENTED_TOKEN";
    const fail = () => { throw new Error(privateText); };
    const ctx = context();
    const parsed = parseRouteOptions("sync", ["--scope", "sent"], { context: ctx });
    const deps = { ensureInitialized() {}, ensureSourceInitialSyncStart: (_db, _source, value) => value,
      getSelfProfile: () => ({ open_id: "ou_invented_profile", name: "Invented Profile" }),
      syncRunner: { syncSent: () => ({ ok: true }) }, resetTransportStats() {}, getTransportStats: () => ({ calls: 0 }) };
    if (stage === "initialize") deps.ensureInitialized = fail;
    else if (stage === "baseline") deps.ensureSourceInitialSyncStart = fail;
    else if (stage === "profile") deps.getSelfProfile = fail;
    else deps.syncRunner.syncSent = fail;
    const code = runSyncCommand(parsed.options, { ...ctx, provided: parsed.provided, deps,
      stdout: { write: (text) => { stdout += text; } }, stderr: { write: (text) => { stderr += text; } } });
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.doesNotMatch(stderr, /SYNTHETIC_PRIVATE|private-path|INVENTED_TOKEN/);
    assert.equal(stderr, "sync failed\n");
  });
}
