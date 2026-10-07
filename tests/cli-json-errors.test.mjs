import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../bin/exocortex.mjs";
import { CliExecutionError } from "../src/cli/context.mjs";
import { ReplayInputError } from "../src/maintenance/replay.mjs";
import { runStep } from "../src/runtime/worker/worker.mjs";

const NOW = Date.parse("2030-01-02T12:00:00Z");
const START = "2030-01-01T00:00:00Z";
const END = "2030-01-02T00:00:00Z";
const PRIVATE = "SYNTHETIC_PRIVATE_FAILURE /invented/private-path?token=INVENTED_TOKEN";
const replay = ["maintenance", "replay", "--db", "synthetic.sqlite", "--scope-id", "synthetic.scope"];
const noEffect = () => assert.fail("invalid arguments must fail before any local or remote effect");

async function invoke(argv, overrides = {}) {
  let stdout = "", stderr = "";
  const code = await runCli(argv, {
    root: "/synthetic-install", cwd: "/synthetic-caller", now: () => NOW, env: {},
    stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
    deps: { resetTransportStats() {}, getTransportStats: () => ({ calls: 0 }),
      tryAcquireLarkApiLease: noEffect, ensureInitialized: noEffect,
      executeLarkImReplay: noEffect, enrichRecords: noEffect, enrichScopes: noEffect },
    ...overrides,
  });
  return { code, stdout, stderr };
}

function errorReport(result, code) {
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report).sort(), ["error", "ok", "schema_version"]);
  assert.equal(report.schema_version, 1);
  assert.equal(report.ok, false);
  assert.equal(report.error.code, code);
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_PRIVATE|private-path|INVENTED_TOKEN/);
  return report;
}

for (const argv of [
  ["sync", "--page-size", "0"],
  ["sync", "--format", "text"],
  ["sync", "--start", "not-a-timestamp"],
  ["sync", "--start", "2030-02-30T00:00:00Z"],
  ["sync", "--start", START, "--end", "not-a-timestamp"],
  ["sync", "--start", END, "--end", START],
  ["sync", "--start", "not-a-timestamp", "--format", "json"],
  [...replay, "--end", END, "--format", "json"],
  [...replay, "--start", "not-a-timestamp", "--end", END, "--format", "json"],
  [...replay, "--start", END, "--end", START, "--format", "json"],
  [...replay, "--scope-id", "synthetic.scope", "--start", START, "--end", END, "--format", "json"],
  ["maintenance", "enrich", "--target", "scopes", "--probe-apps", "--format", "json"],
]) {
  test(`JSON primitive and semantic argument errors: ${argv.join(" ")}`, async () => {
    const result = await invoke(argv);
    errorReport(result, "invalid_arguments");
    assert.equal(result.stderr, "");
  });
}

test("default sync module failures use safe JSON; known reasons survive explicit JSON errors", async () => {
  const result = await invoke(["sync"], { loadCommand: async () => { throw new Error(PRIVATE); } });
  assert.equal(errorReport(result, "execution_failed").error.message,
    "Unable to complete command; check its required dependencies and local evidence.");
  assert.equal(result.stderr, "");
  for (const reason of ["read_timeout", PRIVATE]) {
    const known = await invoke(["messages", "--format", "json"], {
      loadCommand: async () => { throw new CliExecutionError("Safe local failure", reason); },
    });
    assert.deepEqual(errorReport(known, "execution_failed").error, {
      code: "execution_failed", message: "Safe local failure", ...(reason === "read_timeout" ? { reason } : {}),
    });
    assert.equal(known.stderr, "");
  }
});

test("sync execution failures keep transport diagnostics on stderr without leaking dependency text", async () => {
  const transport = { calls: 2, retries: 1 };
  const result = await invoke(["sync", "--start", START], { deps: {
    resetTransportStats() {}, getTransportStats: () => transport,
    ensureInitialized() { throw new Error(PRIVATE); },
  } });
  assert.equal(errorReport(result, "execution_failed").error.message, "sync failed");
  assert.deepEqual(JSON.parse(result.stderr), { type: "lark_transport_summary", transport });
});

test("sync busy lease remains execution failure and never reaches the database", async () => {
  let released = 0;
  const result = await invoke(["sync", "--start", START], { deps: {
    resetTransportStats() {}, getTransportStats: () => ({ calls: 0 }), ensureInitialized: noEffect,
    tryAcquireLarkApiLease: () => ({ state: "busy", release() { released++; } }),
  } });
  assert.equal(errorReport(result, "execution_failed").error.message, "sync skipped: Lark API is busy");
  assert.equal(result.stderr, ""); assert.equal(released, 1);
});

for (const state of ["busy", "unavailable"]) {
  test(`replay ${state} lease is an execution failure with no replay work`, async () => {
    let released = 0;
    const result = await invoke([...replay, "--start", START, "--end", END, "--format", "json"], { deps: {
      tryAcquireLarkApiLease: () => ({ state, release() { released++; } }),
      executeLarkImReplay: noEffect,
    } });
    const expected = state === "busy" ? "replay skipped: Lark API is busy" : "replay skipped: Lark API lease unavailable";
    assert.equal(errorReport(result, "execution_failed").error.message, expected);
    assert.equal(result.stderr, ""); assert.equal(released, 1);
  });
}

for (const [action, dependency] of [["init", "initializeDatabase"], ["backup", "executeSqliteMaintenance"],
  ["compact", "executeSqliteMaintenance"], ["prune-runs", "executeSqliteMaintenance"],
  ["repair", "executeSyncRepair"], ["enrich", "executeEnrichment"], ["replay", "executeLarkImReplay"]]) {
  test(`maintenance ${action} execution exception is safe JSON`, async () => {
    const argv = action === "replay" ? [...replay, "--start", START, "--end", END]
      : ["maintenance", action, ...(action === "enrich" ? ["--target", "records"] : [])];
    const result = await invoke([...argv, "--format", "json"], {
      deps: { [dependency]() { throw new Error(PRIVATE); } },
    });
    errorReport(result, "execution_failed"); assert.equal(result.stderr, "");
  });
}

test("replay state validation after argument parsing is an execution failure", async () => {
  const result = await invoke([...replay, "--start", START, "--end", END, "--format", "json"], {
    deps: { executeLarkImReplay() { throw new ReplayInputError("replay source is missing or disabled"); } },
  });
  assert.equal(errorReport(result, "execution_failed").error.message, "replay source is missing or disabled");
  assert.equal(result.stderr, "");
});

test("maintenance text errors retain their stderr channel and message", async () => {
  const validation = await invoke([...replay, "--start", "not-a-timestamp", "--end", END]);
  assert.equal(validation.code, 1); assert.equal(validation.stdout, "");
  assert.equal(validation.stderr, "--start requires an ISO timestamp with an explicit timezone\n");
  const execution = await invoke(["maintenance", "compact"], {
    deps: { executeSqliteMaintenance() { throw new Error(PRIVATE); } },
  });
  assert.equal(execution.code, 1); assert.equal(execution.stdout, "");
  assert.equal(execution.stderr, "SQLite maintenance failed\n");
});

test("sync success retains its summary and maintenance retains nonzero business reports", async () => {
  const sent = { ok: true, inserted: 3, updated: 1, pending_details: 0 };
  const result = await invoke(["sync", "--scope", "sent", "--start", START, "--end", END], { deps: {
    resetTransportStats() {}, getTransportStats: () => ({ calls: 0 }), ensureInitialized() {},
    captureRemoteAccountBinding: () => ({ empty: true, binding_absent: true }),
    readRemoteAccountBinding: () => ({ state: "unverified", reason: "account_database_unbound" }),
    reserveSyncAccountBinding: () => false,
    recordSuccessfulSyncBinding() {}, ensureSourceInitialSyncStart: (_db, _source, start) => start,
    getSelfProfile: () => ({ open_id: "ou_synthetic", name: "Invented User" }),
    syncRunner: { syncSent: () => sent },
  } });
  assert.equal(result.code, 0); assert.equal(result.stderr, "");
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true); assert.deepEqual(summary.sent, sent);
  assert.deepEqual(summary.received, []); assert.equal(summary.discovery, null);
  assert.equal(summary.initial_sync_start_ms, Date.parse(START));
  assert.equal(Date.parse(summary.window.end), Date.parse(END));
  assert.equal(summary.error, undefined); assert.equal(summary.schema_version, undefined);
  for (const [report, expected] of [[{ ok: true, dry_run: true }, 0],
    [{ ok: false, partial: true, skipped_conflicts: 1 }, 2], [{ ok: false, status: "failed" }, 1]]) {
    const maintenance = await invoke(["maintenance", "compact", "--format", "json"], {
      deps: { executeSqliteMaintenance: () => report },
    });
    assert.equal(maintenance.code, expected); assert.equal(maintenance.stderr, "");
    assert.deepEqual(JSON.parse(maintenance.stdout), report);
  }
});

test("worker logs retain safe CLI JSON errors and transport diagnostics", async () => {
  const transport = { calls: 2, retries: 1 };
  const results = [
    await invoke(["sync", "--start", "not-a-timestamp"]),
    await invoke(["sync", "--start", START], { deps: { resetTransportStats() {}, getTransportStats: () => transport,
      ensureInitialized() { throw new Error(PRIVATE); } } }),
    await invoke(["maintenance", "compact", "--format", "json"], {
      deps: { executeSqliteMaintenance() { throw new Error(PRIVATE); } },
    }),
  ];
  for (const result of results) {
    const step = runStep("sent", [], { nowMs: () => NOW,
      spawnSync: () => ({ status: result.code, stdout: result.stdout, stderr: result.stderr }) });
    assert.equal(step.ok, false);
    assert.equal(step.exit_code, 1);
    assert.equal(step.stderr, JSON.parse(result.stdout).error.message);
    assert.doesNotMatch(JSON.stringify(step), /SYNTHETIC_PRIVATE|private-path|INVENTED_TOKEN/);
    if (result.stderr) assert.equal(step.summary.transport.retries, 1);
  }
});

test("worker only reads recognized error envelopes and preserves process failure precedence", () => {
  const envelope = { schema_version: 1, ok: false, error: { code: "execution_failed", message: "Safe CLI error" } };
  const step = (report, child = {}) => runStep("sent", [], { nowMs: () => NOW,
    spawnSync: () => ({ status: 1, stdout: JSON.stringify(report), stderr: "", ...child }) });
  for (const report of [{ ...envelope, schema_version: 99 }, { ...envelope, ok: true },
    { ...envelope, error: { code: "unknown", message: "Ignored error" } },
    { ...envelope, error: { code: "execution_failed", message: { nested: "Ignored" } } }]) assert.equal(step(report).stderr, "");
  assert.equal(step(envelope, { stderr: "Existing failure reason" }).stderr, "Existing failure reason");
  assert.equal(step(envelope, { signal: "SIGKILL" }).stderr, "worker step terminated with a process error or signal");
  assert.equal(step(envelope, { status: 0 }).stderr, "worker step reported an unhealthy summary");
});
