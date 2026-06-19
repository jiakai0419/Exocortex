import assert from "node:assert/strict";
import test from "node:test";

import {
  parseArgs,
  runLarkImSyncCli,
} from "../src/cli/lark-im-sync-command.mjs";

function memoryWriter() {
  let text = "";
  return {
    stream: {
      write(chunk) {
        text += String(chunk);
      },
    },
    text: () => text,
  };
}

test("lark im sync command renders help without touching dependencies", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const exitCode = runLarkImSyncCli(["--help"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    deps: {
      ensureInitialized: () => {
        throw new Error("should not initialize");
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.text(), /Usage: node scripts\/lark-im-sync\.mjs/);
  assert.equal(stderr.text(), "");
});

test("lark im sync command executes sent scope through injected deps", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const calls = [];
  const exitCode = runLarkImSyncCli(
    [
      "--db",
      "custom.sqlite",
      "--scope",
      "sent",
      "--start",
      "2026-06-18T08:00:00Z",
      "--end",
      "2026-06-18T08:10:00Z",
    ],
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      deps: {
        resolvePath: (dbPath) => `/abs/${dbPath}`,
        ensureInitialized: (dbPath) => calls.push(["init", dbPath]),
        getSelfProfile: () => {
          calls.push(["self"]);
          return { open_id: "ou_self", name: "Me" };
        },
        syncRunner: {
          syncSent: (dbPath, opts, selfProfile) => {
            calls.push(["sent", dbPath, opts.scope, selfProfile.open_id]);
            return { ok: true, scanned: 1, records: 1, inserted: 1, updated: 0, duplicate: 0 };
          },
          syncDiscovery: () => {
            throw new Error("should not run discovery");
          },
          syncReceived: () => {
            throw new Error("should not run received");
          },
        },
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr.text(), "");
  const summary = JSON.parse(stdout.text());
  assert.equal(summary.ok, true);
  assert.equal(summary.db_path, "/abs/custom.sqlite");
  assert.deepEqual(summary.sent, { ok: true, scanned: 1, records: 1, inserted: 1, updated: 0, duplicate: 0 });
  assert.equal(summary.discovery, null);
  assert.deepEqual(summary.received, []);
  assert.deepEqual(calls, [
    ["init", "/abs/custom.sqlite"],
    ["self"],
    ["sent", "/abs/custom.sqlite", "sent", "ou_self"],
  ]);
});

test("lark im sync command returns nonzero and stderr on dependency errors", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const exitCode = runLarkImSyncCli(["--scope", "sent"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    deps: {
      ensureInitialized: () => {},
      getSelfProfile: () => ({ open_id: "", name: "" }),
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /could not resolve current Lark user open_id/);
});

test("lark im sync command parseArgs keeps explicit end stable", () => {
  const opts = parseArgs([
    "--scope",
    "received",
    "--start",
    "2026-06-18T08:00:00Z",
    "--end",
    "2026-06-18T08:10:00Z",
    "--received-scopes-per-run",
    "2",
  ]);

  assert.equal(opts.scope, "received");
  assert.equal(opts.endExplicit, true);
  assert.equal(opts.receivedScopesPerRun, 2);
  assert.equal(opts.startMs, Date.parse("2026-06-18T08:00:00Z"));
  assert.equal(opts.endMs, Date.parse("2026-06-18T08:10:00Z"));
});
