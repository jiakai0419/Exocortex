import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifySyncRunFailure } from "../src/diagnostics/sync-run-failure.mjs";
import { collectQualityReport } from "../src/diagnostics/lark-im-quality-report.mjs";
import { buildServiceStatusReport } from "../src/diagnostics/lark-im-service-report.mjs";
import { publicStatusReport } from "../src/diagnostics/status-report.mjs";
import { renderStatusText } from "../src/terminal/status-view.mjs";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";
import { recordFromMessage } from "../src/adapters/lark-im/message-record.mjs";
import { cursorAfter } from "../src/adapters/lark-im/core.mjs";
import { commitLarkListRun, createRun, ensureInitialized, ensureSourceInitialSyncStart,
  finishLarkDetailRun, readPendingLarkDetails, readScope, sqliteQuery } from "../dist/storage/sqlite/ingestion-store.js";

test("only the exact stored detail error type creates a historical detail category", () => {
  assert.deepEqual(classifySyncRunFailure({ error_type: "LarkDetailIncomplete", error_message: "PRIVATE_SYNTHETIC" }),
    { kind: "detail_incomplete", transient: false, code: null });
  for (const error_type of [undefined, null, "Error", "LarkDetailIncompleteExtra", " LarkDetailIncomplete", "larkdetailincomplete"]) {
    assert.equal(classifySyncRunFailure({ error_type,
      error_message: "List coverage saved; merge-forward details remain pending" }).kind, "unknown");
    assert.equal(classifySyncRunFailure({ error_type, error_message: "lark-cli failed: kind=rate_limited code=9499" }).kind,
      "rate_limited", "other error types retain existing transport classification");
    assert.equal(classifySyncRunFailure({ error_type, error_message: "LarkDetailIncomplete PRIVATE_SYNTHETIC" }).kind,
      "unknown", "type-looking prose cannot supply a structured type");
  }
});

test("real detail ingestion keeps classified failed history after the current debt is resolved", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-status-run-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, "synthetic.sqlite");
  const start = Date.parse("2020-02-03T00:00:00Z");
  const scopeId = "lark.im.sent_by_me";
  const privateMarker = "PRIVATE_SYNTHETIC_DETAIL";
  const root = { message_id: `${privateMarker}_root`, chat_id: `${privateMarker}_chat`, msg_type: "merge_forward",
    create_time: String(start + 1000), update_time: String(start + 1000),
    sender: { id: `${privateMarker}_sender`, sender_type: "user" }, body: { content: "{}" } };
  ensureInitialized(db);
  ensureSourceInitialSyncStart(db, "lark.im", start, { explicit: true });
  let scope = readScope(db, scopeId);
  const incompleteRun = createRun(db, scope);
  commitLarkListRun(db, scope, incompleteRun, [], [root], 1,
    cursorAfter(start + 2000),
    { adapter: "lark.im.sent_by_me", initial_sync_start_ms: start, list_window_start_ms: start, list_window_end_ms: start + 2000 });
  // A from-zero compatibility fixture: reproduce only the former list-row contract.
  // New writes correctly record succeeded/awaiting_details; no production history is imported.
  assert.equal(sqliteQuery(db, `SELECT status FROM sync_runs WHERE id=${incompleteRun};`)[0].status, "succeeded");
  sqliteQuery(db, `UPDATE sync_runs SET status='failed', error_type='LarkDetailIncomplete',
    metadata_json=json_remove(metadata_json,'$.lark_progress') WHERE id=${incompleteRun};`);
  const stored = () => sqliteQuery(db, `SELECT status, error_type FROM sync_runs WHERE id=${incompleteRun};`, "synthetic failed run")[0];
  assert.deepEqual(stored(), { status: "failed", error_type: "LarkDetailIncomplete" });

  const report = () => {
    const now = Date.now();
    const raw = buildServiceStatusReport({ db, logDir: directory, label: "synthetic", target: "synthetic" }, {
      nowMs: now, runCommand: () => ({ status: 0, stdout: "state = running\npid = 7701\n", stderr: "" }),
      readRecentWorkerEvents: () => ({ path: "synthetic", exists: true, events: [], activity_integrity: true }),
      readLiveProbeCache: () => null, liveProbeContext: () => null, inspectActivityProcesses: () => new Map(),
    });
    return publicStatusReport({ observedAt: now, service: { status: "running", target_match: "matched" },
      installed: { status: "installed" }, report: raw }, { detail: true });
  };
  const assertHistory = (value, resolved = false) => {
    assert.equal(value.failure_runs.evidence, "available");
    assert.equal(value.failure_runs.failed_runs, 1);
    assert.deepEqual(value.failure_runs.by_kind, [{ kind: "detail_incomplete", count: 1 }]);
    assert.deepEqual(value.stability.failures.by_kind, value.failure_runs.by_kind);
    const failed = value.detail.runs.recent.find((row) => row.status === "failed");
    assert.equal(failed.failure_kind, "detail_incomplete");
    assert.equal(failed.transient, false);
    assert.equal(failed.error_code, null);
    const quality = collectQualityReport(db);
    assert.deepEqual(quality.recent_failures, [{ failure_kind: "detail_incomplete", transient: false, error_code: null,
      phase: "list", outcome: "awaiting_details", resolution: resolved ? "resolved" : "unresolved" }]);
    assert.equal(value.failure_runs.actionable_failed_runs, resolved ? 0 : 1);
    assert.equal(value.failure_runs.transitions.resolved, resolved ? 1 : 0);
    for (const detail of [false, true]) {
      const text = renderStatusText({ ...value, detail: detail ? value.detail : undefined }, { columns: 120, detail }).replace(/\s+/g, " ");
      if (detail || !resolved) {
        assert.match(text, /1 retained failed runs/);
        assert.match(text, /Merge-forward details pending at run end · 1/);
      } else assert.doesNotMatch(text, /retained failed runs|Failure category|Database failures/);
      if (detail && resolved) assert.match(text, /1 legacy list runs have later detail closure evidence/);
      assert.doesNotMatch(text, /Unclassified failure/);
      assert.doesNotMatch(text + JSON.stringify(value) + JSON.stringify(quality),
        /PRIVATE_SYNTHETIC_DETAIL|LarkDetailIncomplete|List coverage saved/);
    }
  };
  const before = report();
  assert.equal(before.sync.details.pending_count, 1);
  assert.equal(before.sync.list_progress.invalid_cursor_scopes, 0);
  assertHistory(before);

  scope = readScope(db, scopeId);
  const task = readPendingLarkDetails(db, scope, { now: "2099-01-01T00:00:00Z" })[0];
  const child = { ...root, message_id: `${privateMarker}_child`, upper_message_id: root.message_id,
    msg_type: "text", body: { content: JSON.stringify({ text: privateMarker }) } };
  const record = recordFromMessage(normalizeApiMessage(root, { mergeItems: [root, child] }), scopeId, "sent");
  const completedRun = createRun(db, scope);
  const effects = finishLarkDetailRun(db, scope, completedRun,
    [{ message_id: root.message_id, fingerprint: task.fingerprint, record }]);
  assert.equal(effects.pending_details, 0);
  assert.equal(effects.full_cursor_promoted, true);
  const after = report();
  assert.equal(after.sync.details.pending_count, 0);
  assert.equal(after.sync.details.due_count, 0);
  assert.equal(after.sync.list_progress.invalid_cursor_scopes, 0);
  assert.equal(after.detail.runs.recent[0].status, "succeeded");
  assert.equal(after.detail.runs.recent[0].failure_kind, "");
  assert.deepEqual(stored(), { status: "failed", error_type: "LarkDetailIncomplete" });
  assertHistory(after, true);
});
