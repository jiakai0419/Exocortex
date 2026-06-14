import assert from "node:assert/strict";
import test from "node:test";

import {
  countBy,
  healthDetail,
  summarizeHealth,
} from "../scripts/lib/sync-status-core.mjs";

function state(overrides = {}) {
  return {
    discoveryCursor: { has_more: false },
    scopeCounts: { received_without_cursor: 0 },
    locks: [],
    runCounts: [],
    ...overrides,
  };
}

test("countBy normalizes grouped sqlite rows", () => {
  assert.deepEqual(
    countBy(
      [
        { status: "succeeded", count: "2" },
        { status: "failed", count: 1 },
        { status: "", count: 3 },
      ],
      "status",
      "count",
    ),
    { succeeded: 2, failed: 1, unknown: 3 },
  );
});

test("health is syncing when a lock exists or a run is still running", () => {
  assert.equal(summarizeHealth(state({ locks: [{ scope_id: "scope" }] })), "syncing");
  assert.equal(
    summarizeHealth(state({ runCounts: [{ status: "running", count: 1 }] })),
    "syncing",
  );
  assert.equal(healthDetail(state({ locks: [{ scope_id: "scope" }] })), "worker is currently syncing");
});

test("health is catching_up while discovery or received cursors are incomplete", () => {
  assert.equal(
    summarizeHealth(state({ discoveryCursor: { has_more: true } })),
    "catching_up",
  );
  assert.equal(
    summarizeHealth(state({ scopeCounts: { received_without_cursor: 12 } })),
    "catching_up",
  );
  assert.equal(
    healthDetail(
      state({
        discoveryCursor: { has_more: true },
        scopeCounts: { received_without_cursor: 12 },
      }),
    ),
    "initial catch-up: discovery still has more pages, 12 chat scopes need cursors",
  );
});

test("health separates historical failures from current attention needs", () => {
  assert.equal(
    summarizeHealth(state({ runCounts: [{ status: "failed", count: 2 }] })),
    "ok_with_history",
  );
  assert.equal(summarizeHealth(state()), "ok");
  assert.equal(healthDetail(state()), "all known enabled scopes have cursors");
});
