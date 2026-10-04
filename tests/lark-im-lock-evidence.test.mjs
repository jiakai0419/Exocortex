import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_HARD_LEASE_SECONDS } from "../dist/storage/sqlite/ingestion-store.js";
import { summarizeLockEvidence } from "../src/diagnostics/lark-im-lock-evidence.mjs";

// Invented clock and lease rows; no operational records or captured identities.
const NOW = Date.UTC(2045, 6, 8, 9, 10, 11);
const iso = (value) => new Date(value).toISOString();
const lease = (start = NOW - 1000, end = NOW + 1000, extra = {}) => ({
  locked_at: iso(start), expires_at: iso(end), ...extra,
});

test("a normal lease is occupancy evidence without claiming process liveness", () => {
  const report = summarizeLockEvidence([lease()], NOW);
  assert.deepEqual(report, { evidence: "available", observed_at: iso(NOW), total: 1,
    occupied_count: 1, abnormal_count: 0, reasons: [] });
  assert.equal("owner_alive" in report, false);
  assert.equal("process_running" in report, false);
});

test("an empty observation is different from unavailable evidence or an invalid observation clock", () => {
  assert.deepEqual(summarizeLockEvidence([], NOW), { evidence: "available", observed_at: iso(NOW), total: 0,
    occupied_count: 0, abnormal_count: 0, reasons: [] });
  for (const locks of [undefined, null, {}, "invented invalid input"]) {
    assert.deepEqual(summarizeLockEvidence(locks, NOW), { evidence: "unavailable", observed_at: iso(NOW), total: null,
      occupied_count: null, abnormal_count: null, reasons: [] });
  }
  for (const clock of [NaN, Infinity, -Infinity, 9e15]) {
    assert.deepEqual(summarizeLockEvidence([lease()], clock), { evidence: "unavailable", observed_at: null,
      total: null, occupied_count: null, abnormal_count: null, reasons: [] });
  }
});

test("normal occupancy includes its start and excludes expiry and the hard lease boundary", () => {
  assert.equal(summarizeLockEvidence([lease(NOW, NOW + 1000)], NOW).occupied_count, 1);
  assert.equal(summarizeLockEvidence([lease(NOW - 1000, NOW)], NOW - 1).occupied_count, 1);
  assert.deepEqual(summarizeLockEvidence([lease(NOW - 1000, NOW)], NOW).reasons,
    [{ reason: "expired", count: 1 }]);
  const start = NOW - DEFAULT_HARD_LEASE_SECONDS * 1000;
  const row = lease(start, NOW + 86_400_000);
  assert.equal(summarizeLockEvidence([row], NOW - 1).occupied_count, 1);
  assert.deepEqual(summarizeLockEvidence([row], NOW).reasons,
    [{ reason: "hard_limit_exceeded", count: 1 }]);
});

test("each stale or malformed lease contributes one fixed reason, never its raw data", () => {
  const privateText = "synthetic-private-holder-and-path";
  const rows = [lease(), lease(NOW + 1, NOW + 1000), lease(NOW - 1000, NOW),
    lease(NOW - 2 * DEFAULT_HARD_LEASE_SECONDS * 1000, NOW + 1000),
    lease(NOW, NOW), lease(NOW + 10, NOW + 5),
    { locked_at: privateText, expires_at: iso(NOW + 1000) },
    { locked_at: iso(NOW - 1000), expires_at: null }, null,
    lease(NOW - 1000, NOW + 1000, { locked_by: privateText, scope_id: privateText, owner_alive: false })];
  const report = summarizeLockEvidence(rows, NOW);
  assert.equal(report.total, rows.length);
  assert.equal(report.occupied_count, 2, "untrusted owner-liveness fields are not evidence");
  assert.equal(report.abnormal_count, 8);
  assert.deepEqual(report.reasons, [
    { reason: "invalid_timestamp", count: 3 }, { reason: "invalid_interval", count: 2 },
    { reason: "expired", count: 1 }, { reason: "future_start", count: 1 },
    { reason: "hard_limit_exceeded", count: 1 },
  ]);
  assert.equal(report.reasons.reduce((sum, item) => sum + item.count, 0), report.abnormal_count);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(privateText));
});

test("the same snapshot can expire at a later observation without mutating its evidence", () => {
  const rows = [lease(NOW - 1000, NOW + 10)];
  const before = structuredClone(rows);
  assert.equal(summarizeLockEvidence(rows, NOW).occupied_count, 1);
  assert.deepEqual(summarizeLockEvidence(rows, NOW + 10).reasons, [{ reason: "expired", count: 1 }]);
  assert.deepEqual(rows, before);
});
