import assert from "node:assert/strict";
import test from "node:test";
import { executeDoctor } from "../src/cli/doctor-command.mjs";
import { buildReport, runJson } from "../src/diagnostics/doctor-report.mjs";

const status = { health: "ok", details: { pending_count: 0 } };
const quality = { status: "ok", quality: {} };
const live = { status: "healthy", ok: true, missing_count: 0, probe: { remote_messages_checked: 1 }, window: { start: "2028-01-01T00:00:00Z", end: "2028-01-02T00:00:00Z" } };
for (const failing of ["sync-status", "lark-im-quality", "lark-im-lag-check"]) {
  for (const failure of [{ status: 1 }, { status: 2 }, { status: null, signal: "SIGKILL" }, { status: 0, error: new Error("SYNTHETIC_PRIVATE_FAILURE") }]) {
    test(`doctor rejects ${failing} successful-looking JSON after ${JSON.stringify(failure)}`, () => {
      const report = buildReport({ db: "synthetic.sqlite", live: true, hotChats: 1, messagesPerChat: 1 }, {
        runJson: (args, accepted) => runJson(args, accepted, { spawnSync: () => ({
          status: 0, stderr: "SYNTHETIC_PRIVATE_FAILURE", stdout: JSON.stringify(args[0].includes("sync-status") ? status : args[0].includes("quality") ? quality : live),
          ...(args[0].includes(failing) ? failure : {}),
        }) }),
      });
      assert.equal(report.ok, false);
      assert.equal(report.overall, "needs_attention");
      assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_PRIVATE_FAILURE/);
      const failed = failing === "sync-status" ? report.status : failing === "lark-im-quality" ? report.quality : report.live;
      if (failure.status !== 2 || failing !== "lark-im-quality") assert.equal(failed.status, "command_failed");
      assert.equal(failed.exit_status, failure.status || 1);
    });
  }
}
test("doctor retains accepted exit 2 diagnostic JSON and normal live keychain unavailable semantics", () => {
  assert.equal(runJson(["synthetic.mjs"], new Set([0, 2]), { spawnSync: () => ({ status: 2, stdout: '{"status":"delayed"}' }) }).status, "delayed");
});

test("doctor cannot cache exit 2 healthy live JSON as a successful sample", () => {
  const cached = [];
  const report = executeDoctor({ db: "synthetic.sqlite", live: true, writeLiveCache: true, hotChats: 1, messagesPerChat: 1, format: "json" }, {
    runJson: (args, accepted) => runJson(args, accepted, { spawnSync: () => ({
      status: args[0].includes("lag-check") ? 2 : 0,
      stdout: JSON.stringify(args[0].includes("sync-status") ? status : args[0].includes("quality") ? quality : live),
    }) }),
    liveProbeContext: () => ({ database_key: "synthetic_database_key" }),
    writeLiveProbeCache: (path, value) => { cached.push(value); return value; },
  });
  assert.equal(report.ok, false);
  assert.equal(cached.length, 1);
  assert.equal(cached[0].live.status, "command_failed");
  assert.equal(cached[0].live.ok, false);
  assert.equal(cached[0].live.exit_status, 2);
});
for (const [stderr, reason, expectedStatus] of [
  ["keychain not initialized", "keychain_unavailable", "unavailable"],
  ["database not found", "database_not_found", "command_failed"],
  ["spawn ENOENT", "dependency_unavailable", "command_failed"],
]) {
  test(`doctor preserves classified failure ${reason} through child JSON projection`, () => {
    const report = buildReport({ db: "synthetic.sqlite", live: true, hotChats: 1, messagesPerChat: 1 }, {
      runJson: (args, accepted) => runJson(args, accepted, { spawnSync: () => args[0].includes("lag-check")
        ? { status: 1, stdout: "", stderr }
        : { status: 0, stdout: JSON.stringify(args[0].includes("sync-status") ? status : quality) },
      }),
    });
    assert.equal(report.ok, false);
    assert.equal(report.live.status, expectedStatus);
    assert.equal(report.live.reason, reason);
    assert.equal(report.live.exit_status, 1);
  });
}
test("doctor classified multi-line failures never expose arbitrary child content", () => {
  const report = buildReport({ db: "synthetic.sqlite", live: true, hotChats: 1, messagesPerChat: 1 }, {
    runJson: (args, accepted) => runJson(args, accepted, { spawnSync: () => args[0].includes("lag-check")
      ? { status: 1, stdout: JSON.stringify(live), stderr: "keychain not initialized\nPRIVATE_MULTILINE_SENTINEL\n" }
      : { status: 0, stdout: JSON.stringify(args[0].includes("sync-status") ? status : quality) },
    }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.live.status, "unavailable");
  assert.equal(report.live.reason, "keychain_unavailable");
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_MULTILINE_SENTINEL/);
});
