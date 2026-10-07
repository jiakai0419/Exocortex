import { createCommandContext } from "../../src/cli/context.mjs";
export const at = Date.parse("2030-01-02T12:00:00Z");
export const sync = (overrides = {}) => ({ health: "ok", scopes: {}, records: {}, runs: {}, locks: [], details: { evidence: "available", pending_count: 0 }, list_progress: { evidence: "available", invalid_cursor_scopes: 0 }, ...overrides });
export const quality = (overrides = {}) => ({ quality: { actionable_missing_sender_name: 0, missing_chat_name: 0, invalid_rendered_body: 0, ...overrides } });
export const live = (overrides = {}) => ({ schema_version: 3, ok: true, status: "healthy", reason: null,
  checked_at: new Date(at).toISOString(), scope: "discovered_chats_rotating", missing_count: 0,
  window: { start: "2030-01-02T00:00:00Z", end: "2030-01-02T11:50:00Z" },
  binding: { state: "verified", evidence: "single_sent_actor", tenant_verified: false },
  probe: { mode: "bounded_native_pages", comparison: "identity_version_static_body", hot_chats_requested: 1,
    hot_chats_found: 1, messages_per_chat: 20, remote_messages_checked: 3, unsupported_chats: 0, probe_errors: 0,
    eligible_chats: 1, hot_chats: 1, fair_chats: 0, chats_checked: 1, pages: 1, truncated_chats: 0, api_calls: 3 },
  findings: { present: 3, missing: 0, pending_sync: 0, suspected_missing: 0, confirmed_missing: 0,
    stale_version: 0, content_mismatch: 0, identity_conflict: 0, local_newer: 0, content_equal: 3,
    content_unverified: 0, unresolved_prior: 0, expired_observations: 0, observation_overflow: 0 }, ...overrides });
export const liveResult = (report = live(), overrides = {}) => ({ outcome: "ok", report, ...overrides });
export const options = (overrides = {}) => ({ db: "/tmp/invented.sqlite", logDir: "/tmp/invented-logs", backupDir: "/tmp/invented-backups", format: "json", ...overrides });
export function fixture(overrides = {}) {
  let output = "";
  const context = createCommandContext({ root: "/tmp/invented-root", cwd: "/tmp/invented-cwd", now: () => at, stdout: { write: (value) => { output += value; } }, ...overrides });
  const calls = [];
  const deps = { checkDependencies: () => ({ sqlite: true, python: true, live: true, wait: true }),
    readDatabaseEvidence: () => { calls.push("database"); return { ok: true, quick_check: "ok" }; },
    buildStatus: () => { calls.push("sync"); return sync(); },
    collectQualityReport: () => { calls.push("quality"); return quality(); },
    collectRemoteSample: () => { calls.push("live"); return liveResult(); },
    runManualRemoteSample: () => { calls.push("live-cache"); return liveResult(live(), { cacheWritten: true }); },
    inspectCoverage: () => { calls.push("coverage"); return { ok: true, evidence: { coverage: { initial_baseline_complete: true } } }; },
    verifyBackupEvidence: () => { calls.push("backup"); return { ok: true, ownership: "matched", manifest: { ok: true, status: "verified" }, backup_check: { ok: true, quick_check: "ok" } }; },
  };
  return { context, calls, deps, output: () => output };
}
export function waitEvidence(startedAt, overrides = {}) {
  return { report: { sync: { status: sync() } }, service: { status: "running", target_match: "matched" },
    workerSummary: { last_cycle: { ok: true, complete: true, started_at: new Date(startedAt).toISOString(), at: new Date(startedAt + 100).toISOString() }, unfinished_cycle: false, in_progress: false }, ...overrides };
}
