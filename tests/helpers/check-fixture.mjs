import { createCommandContext } from "../../src/cli/context.mjs";
export const at = Date.parse("2030-01-02T12:00:00Z");
export const sync = (overrides = {}) => ({ health: "ok", scopes: {}, records: {}, runs: {}, locks: [], details: { evidence: "available", pending_count: 0 }, list_progress: { evidence: "available", invalid_cursor_scopes: 0 }, ...overrides });
export const quality = (overrides = {}) => ({ quality: { actionable_missing_sender_name: 0, missing_chat_name: 0, invalid_rendered_body: 0, ...overrides } });
export const live = (overrides = {}) => ({ ok: true, status: "healthy", missing_count: 0, window: { start: "2030-01-02T00:00:00Z", end: "2030-01-02T12:00:00Z" }, probe: { remote_messages_checked: 3, probe_errors: 0 }, ...overrides });
export const options = (overrides = {}) => ({ db: "/tmp/invented.sqlite", logDir: "/tmp/invented-logs", backupDir: "/tmp/invented-backups", format: "json", ...overrides });
export function fixture(overrides = {}) {
  let output = "";
  const context = createCommandContext({ root: "/tmp/invented-root", cwd: "/tmp/invented-cwd", now: () => at, stdout: { write: (value) => { output += value; } }, ...overrides });
  const calls = [];
  const deps = { checkDependencies: () => ({ sqlite: true, python: true, live: true, wait: true }),
    readDatabaseEvidence: () => { calls.push("database"); return { ok: true, quick_check: "ok" }; },
    buildStatus: () => { calls.push("sync"); return sync(); },
    collectQualityReport: () => { calls.push("quality"); return quality(); },
    collectLagReport: () => { calls.push("live"); return live(); },
    inspectCoverage: () => { calls.push("coverage"); return { ok: true, evidence: { coverage: { initial_baseline_complete: true } } }; },
    verifyBackupEvidence: () => { calls.push("backup"); return { ok: true, ownership: "matched", manifest: { ok: true, status: "verified" }, backup_check: { ok: true, quick_check: "ok" } }; },
    liveProbeContext: () => ({ database_key: "a".repeat(64) }),
    writeLiveProbeCache: () => { calls.push("cache"); },
  };
  return { context, calls, deps, output: () => output };
}
export function waitEvidence(startedAt, overrides = {}) {
  return { report: { sync: { status: sync() } }, service: { status: "running", target_match: "matched" },
    workerSummary: { last_cycle: { ok: true, complete: true, started_at: new Date(startedAt).toISOString(), at: new Date(startedAt + 100).toISOString() }, unfinished_cycle: false, in_progress: false }, ...overrides };
}
