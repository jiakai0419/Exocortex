import assert from "node:assert/strict";
import test from "node:test";

import {
  executeLarkImSync,
  parseArgs,
  runLarkImSyncCli,
} from "./helpers/sync-command.mjs";

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

test("sync CLI preserves recovered transport pressure in its successful JSON", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  let resets = 0;
  const transport = { calls: 2, attempts: 3, retries: 1, rate_limits: 1, timeouts: 0, exhausted: 0,
    cooldowns_by_operation: {}, by_operation: { contact_search: { rate_limits: 1 } } };
  const exitCode = runLarkImSyncCli(["--scope", "discover"], {
    stdout: stdout.stream, stderr: stderr.stream,
    deps: {
      resetTransportStats: () => { resets++; }, getTransportStats: () => transport,
      ensureInitialized: () => {}, ensureSourceInitialSyncStart: (_db, _source, ms) => ms,
      syncRunner: { syncDiscovery: () => ({ ok: true }) },
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(resets, 1);
  assert.deepEqual(JSON.parse(stdout.text()).transport, transport);
  assert.equal(stderr.text(), "");
});

test("sync CLI emits aggregate transport pressure when profile loading fails", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const transport = { calls: 1, attempts: 2, retries: 1, rate_limits: 2, exhausted: 1,
    cooldowns_by_operation: { self_profile: 1900000000000 } };
  const exitCode = runLarkImSyncCli(["--scope", "received"], {
    stdout: stdout.stream, stderr: stderr.stream,
    deps: {
      resetTransportStats: () => {}, getTransportStats: () => transport,
      ensureInitialized: () => {}, ensureSourceInitialSyncStart: (_db, _source, ms) => ms,
      getSelfProfile: () => { throw new Error("kind=rate_limited code=99991400"); },
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(stdout.text(), "");
  const lines = stderr.text().trim().split("\n");
  assert.match(lines[0], /kind=rate_limited/);
  assert.deepEqual(JSON.parse(lines[1]), { type: "lark_transport_summary", transport });
});

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
      ensureSourceInitialSyncStart: () => {
        throw new Error("should not read or write the baseline");
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.text(), /Usage: node bin\/exocortex\.mjs sync/);
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
        ensureSourceInitialSyncStart: (dbPath, sourceId, startMs, options) => {
          calls.push(["baseline", dbPath, sourceId, startMs, options.explicit]);
          return startMs;
        },
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
    ["baseline", "/abs/custom.sqlite", "lark.im", Date.parse("2026-06-18T08:00:00Z"), true],
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
      ensureSourceInitialSyncStart: (_dbPath, _sourceId, startMs) => startMs,
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
  assert.equal(opts.startExplicit, true);
  assert.equal(opts.endExplicit, true);
  assert.equal(opts.receivedScopesPerRun, 2);
  assert.equal(opts.startMs, Date.parse("2026-06-18T08:00:00Z"));
  assert.equal(opts.endMs, Date.parse("2026-06-18T08:10:00Z"));
});

test("lark im sync command distinguishes a default start from an explicit baseline", () => {
  const opts = parseArgs([]);
  assert.equal(opts.startExplicit, false);
  assert.equal(opts.endExplicit, false);
  assert.equal(Number.isSafeInteger(opts.startMs), true);
});

test("explicit start accepts a complete ISO timestamp with a timezone", () => {
  for (const value of ["2026-06-18T08:00:00Z", "2026-06-18T08:00:00.123+08:00"]) {
    const opts = parseArgs(["--start", value, "--end", "2026-06-19T00:00:00Z"]);
    assert.equal(opts.startExplicit, true);
    assert.equal(opts.startMs, Date.parse(value));
  }
  assert.equal(
    parseArgs(["--start", "2026-06-18T08:00:00.123+08:00"]).startMs,
    parseArgs(["--start", "2026-06-18T00:00:00.123Z"]).startMs,
  );
});

test("explicit start rejects ambiguous or normalized timestamps", () => {
  for (const value of [
    "2026-06-18",
    "2026-06-18T08:00:00",
    "1781769600",
    "1781769600000",
    "2026-02-30T08:00:00Z",
    "2026-06-18T24:00:00Z",
  ]) {
    assert.throws(() => parseArgs(["--start", value]), undefined, value);
  }
});

test("lark im sync command resolves the persisted baseline before profiles and every runner", () => {
  const baselineMs = Date.parse("2026-06-18T00:00:00Z");
  const candidateMs = Date.parse("2026-06-19T00:00:00Z");
  const opts = {
    ...parseArgs(["--start", "2026-06-19T00:00:00Z", "--end", "2026-06-19T01:00:00Z"]),
    startExplicit: false,
  };
  const calls = [];
  const checkBaseline = (name, effectiveOpts) => {
    assert.equal(effectiveOpts.startMs, baselineMs);
    assert.equal(Date.parse(effectiveOpts.start), baselineMs);
    assert.equal(effectiveOpts.endMs, Date.parse("2026-06-19T01:00:00Z"));
    assert.equal(effectiveOpts.endExplicit, true);
    calls.push(name);
  };
  const summary = executeLarkImSync(opts, {
    resolvePath: () => "/fake/baseline.sqlite",
    ensureInitialized: () => calls.push("init"),
    ensureSourceInitialSyncStart: (dbPath, sourceId, startMs, options) => {
      assert.equal(dbPath, "/fake/baseline.sqlite");
      assert.equal(sourceId, "lark.im");
      assert.equal(startMs, candidateMs);
      assert.equal(options.explicit, false);
      assert.equal(options.endMs, opts.endMs);
      calls.push("baseline");
      return baselineMs;
    },
    getSelfProfile: (effectiveOpts) => {
      checkBaseline("self", effectiveOpts);
      return { open_id: "ou_synthetic", name: "Synthetic" };
    },
    syncRunner: {
      syncSent: (_dbPath, effectiveOpts) => {
        checkBaseline("sent", effectiveOpts);
        return { ok: true };
      },
      syncDiscovery: (_dbPath, effectiveOpts) => {
        checkBaseline("discovery", effectiveOpts);
        return { ok: true };
      },
      syncReceived: (_dbPath, effectiveOpts) => {
        checkBaseline("received", effectiveOpts);
        return [];
      },
    },
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.initial_sync_start_ms, baselineMs);
  assert.equal(summary.initial_sync_start, new Date(baselineMs).toISOString());
  assert.equal(Date.parse(summary.window.start), baselineMs);
  assert.deepEqual(calls, ["init", "baseline", "self", "sent", "discovery", "received"]);
});

test("lark im sync command fails closed before fetching a profile or running a scope", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const calls = [];
  const exitCode = runLarkImSyncCli(["--scope", "sent"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    deps: {
      resolvePath: () => "/fake/legacy.sqlite",
      ensureInitialized: () => calls.push("init"),
      ensureSourceInitialSyncStart: () => {
        calls.push("baseline");
        throw new Error("legacy database requires an explicit initial baseline");
      },
      getSelfProfile: () => {
        calls.push("self");
        throw new Error("must not read the real account");
      },
      syncRunner: {
        syncSent: () => calls.push("sent"),
      },
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.text(), "");
  assert.equal(stderr.text(), "sync failed\n");
  assert.deepEqual(calls, ["init", "baseline"]);
});

test("discovery-only commands persist the source baseline without fetching a profile", () => {
  const calls = [];
  const opts = parseArgs(["--scope", "discover"]);
  const summary = executeLarkImSync(opts, {
    resolvePath: () => "/fake/discovery.sqlite",
    ensureInitialized: () => calls.push("init"),
    ensureSourceInitialSyncStart: (_dbPath, sourceId, candidateMs, options) => {
      assert.equal(sourceId, "lark.im");
      assert.equal(options.explicit, false);
      calls.push("baseline");
      return candidateMs;
    },
    getSelfProfile: () => {
      throw new Error("discovery does not need a profile");
    },
    syncRunner: {
      syncDiscovery: () => {
        calls.push("discover");
        return { ok: true };
      },
    },
  });

  assert.equal(summary.ok, true);
  assert.deepEqual(calls, ["init", "baseline", "discover"]);
});

test("details-only CLI has a capped positive batch limit and never dispatches list scopes", () => {
  assert.equal(parseArgs(["--scope", "details"]).detailLimit, 5);
  assert.equal(parseArgs(["--scope", "details", "--detail-limit", "200"]).detailLimit, 20);
  assert.throws(() => parseArgs(["--scope", "details", "--detail-limit", "0"]), /positive integer/);
  const opts = parseArgs(["--scope", "details", "--detail-limit", "2", "--detail-scope", "invented-scope"]);
  const called = [];
  const summary = executeLarkImSync(opts, {
    resolvePath: (value) => value,
    ensureInitialized: () => {},
    ensureSourceInitialSyncStart: (_db, _source, value) => value,
    getSelfProfile: () => ({ open_id: "invented-self", name: "Invented Self" }),
    syncRunner: {
      retryDetails: (_db, receivedOptions) => {
        called.push([receivedOptions.detailLimit, receivedOptions.detailScope]);
        return [{ ok: false, reason: "details_pending", pending_details: 1, detail_attempts: 0 }];
      },
    },
  });
  assert.deepEqual(called, [[2, "invented-scope"]]);
  assert.equal(summary.ok, false, "no due attempt must not claim unresolved debt is complete");
  assert.equal(summary.sent, null);
  assert.equal(summary.discovery, null);
  assert.deepEqual(summary.received, []);
});
