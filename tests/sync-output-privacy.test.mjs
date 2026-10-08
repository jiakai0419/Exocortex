import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../bin/exocortex.mjs";
import { commandCatalog, renderHelp } from "../src/cli/registry.mjs";
import { syncScope } from "../src/adapters/lark-im/sync-runner.mjs";
import { chatScopeId } from "../src/adapters/lark-im/core.mjs";

const db = "/synthetic/INVENTED_PERSON/private.sqlite";
const privateError = "INVENTED_PRIVATE_FAILURE /synthetic/private/path?token=INVENTED_TOKEN";
const now = () => Date.parse("2034-01-01T12:00:00Z");
const scope = { id: chatScopeId("oc_invented_chat"), source_id: "lark.im", enabled: 1, source_enabled: 1 };

async function invoke(mode) {
  let stdout = ""; let stderr = "";
  const deps = {
    ensureInitialized() {}, ensureSourceInitialSyncStart: (_db, _source, start) => start,
    captureRemoteAccountBinding: () => ({ database_key: "invented-binding", empty: true, binding_absent: true }),
    readRemoteAccountBinding: () => ({ state: "unverified", reason: "account_database_unbound", database_key: "invented-binding" }),
    reserveSyncAccountBinding() {}, recordSuccessfulSyncBinding() {},
    getSelfProfile: () => ({ open_id: "ou_invented_self", name: "Invented Self" }),
    resetTransportStats() {}, getTransportStats: () => ({ calls: 0 }),
    syncRunner: { syncReceived: (_db, options) => {
      if (mode === "outer-failure") throw new Error(privateError);
      return [syncScope(db, scope.id, options, () => {
        if (mode === "scope-failure") throw new Error(privateError);
        return { ok: true, inserted: 0, updated: 0, duplicate: 0 };
      }, { readScope: () => scope, isMaintenanceLocked: () => false, acquireLock: () => true,
        createRun: () => 1, failRun: () => true, releaseLock() {} })];
    } },
  };
  const code = await runCli(["sync", "--scope", "received", "--db", db], {
    root: "/synthetic/install", cwd: "/synthetic/cwd", now, env: {}, deps,
    stdout: { write(text) { stdout += text; } }, stderr: { write(text) { stderr += text; } },
  });
  return { code, stdout, stderr, report: JSON.parse(stdout) };
}

test("sync discovery classifies its retained summary as private in text and machine help", () => {
  const route = commandCatalog().commands.find(({ id }) => id === "sync");
  assert.equal(route.privacy, "private");
  assert.deepEqual(route.effects, ["remote-read", "database-write", "activity-write"]);
  assert.match(renderHelp({ route: "sync", all: true }), /output: private/);
  const machine = JSON.parse(renderHelp({ route: "sync", all: true, options: { format: "json" } }));
  assert.equal(machine.commands[0].privacy, "private");
  for (const id of ["check", "status"]) {
    assert.equal(commandCatalog().commands.find(route => route.id === id).privacy, "public-safe");
  }
});

test("private sync classification preserves success and scope-failure JSON without weakening outer error redaction", async () => {
  const success = await invoke("success");
  assert.equal(success.code, 0);
  assert.equal(success.report.db_path, db);
  assert.equal(success.report.received[0].ok, true);
  assert.equal(success.stderr, "");
  assert.ok(!success.stdout.includes("oc_invented_chat"));

  const failure = await invoke("scope-failure");
  assert.equal(failure.code, 1);
  assert.equal(failure.report.db_path, db);
  assert.equal(failure.report.received[0].error, privateError);
  assert.equal(failure.stderr, "");

  const outer = await invoke("outer-failure");
  assert.equal(outer.code, 1);
  assert.equal(outer.report.error.code, "execution_failed");
  assert.ok(!outer.stdout.includes(privateError));
  assert.ok(!outer.stdout.includes(db));
  assert.equal(outer.stderr, "");
});
