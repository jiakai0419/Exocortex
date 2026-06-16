import assert from "node:assert/strict";
import test from "node:test";

import {
  actionableMissingSenderNames,
  buildFindings,
  isKeychainUnavailable,
  normalizeLiveResult,
  overallStatus,
} from "../src/diagnostics/doctor-core.mjs";
import { overallStatus as shimOverallStatus } from "../scripts/lib/doctor-core.mjs";

function localState(overrides = {}) {
  return {
    status: { health: "ok" },
    quality: { quality: {} },
    live: null,
    ...overrides,
  };
}

test("keychain failures are classified as live unavailable, not sync failure", () => {
  const live = normalizeLiveResult({
    ok: false,
    status: "command_failed",
    exit_status: 1,
    stderr:
      "Error FAILED\nMessage  keychain Get failed: keychain not initialized\nHint The keychain master key may have been cleaned up.",
  });

  assert.equal(isKeychainUnavailable(live.stderr), true);
  assert.equal(live.status, "unavailable");
  assert.equal(live.reason, "keychain_unavailable");
  assert.match(live.hint, /background service can still be healthy/);
  assert.equal(overallStatus(localState({ live })), "fresh");
  assert.equal(shimOverallStatus(localState({ live })), "fresh");
  assert.deepEqual(buildFindings(localState({ live })), ["live lag probe unavailable in this shell"]);
});

test("live unavailable preserves local syncing and catching_up states", () => {
  const live = normalizeLiveResult({
    status: "command_failed",
    stderr: "keychain Get failed: keychain not initialized",
  });

  assert.equal(
    overallStatus(localState({ status: { health: "syncing" }, live })),
    "syncing",
  );
  assert.equal(
    overallStatus(localState({ status: { health: "catching_up" }, live })),
    "catching_up",
  );
});

test("real live failures still need attention and delayed live status stays delayed", () => {
  assert.equal(
    overallStatus(localState({ live: { status: "command_failed", stderr: "syntax error" } })),
    "needs_attention",
  );
  assert.equal(
    overallStatus(localState({ live: { status: "needs_attention" } })),
    "needs_attention",
  );
  assert.equal(
    overallStatus(localState({ live: { status: "delayed" } })),
    "delayed",
  );
});

test("doctor ignores non-actionable sender gaps but flags actionable sender gaps", () => {
  const advisoryOnly = localState({
    quality: {
      quality: {
        missing_sender_name: 33,
        actionable_missing_sender_name: 0,
        missing_user_sender_name: 0,
        missing_app_sender_name: 1,
        unresolved_app_sender_name: 1,
        missing_system_sender_name: 32,
      },
    },
  });

  assert.equal(actionableMissingSenderNames(advisoryOnly), 0);
  assert.equal(overallStatus(advisoryOnly), "fresh");
  assert.deepEqual(buildFindings(advisoryOnly), []);

  const actionable = localState({
    quality: {
      quality: {
        missing_sender_name: 1,
        actionable_missing_sender_name: 1,
        missing_user_sender_name: 1,
      },
    },
  });

  assert.equal(actionableMissingSenderNames(actionable), 1);
  assert.equal(overallStatus(actionable), "needs_attention");
  assert.deepEqual(buildFindings(actionable), ["some senders still lack display names"]);
});
