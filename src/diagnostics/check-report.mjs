import { runManualRemoteSample } from "../runtime/worker/remote-sample-scheduler.mjs";
// @ts-check
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readDatabaseEvidence, verifyBackupEvidence } from "../storage/sqlite/maintenance.mjs";
import { buildStatus, sanitizeStatusReportForPublicOutput } from "./sync-status-report.mjs";
import { collectQualityReport, hasQualityIssues, sanitizeQualityReportForPublicOutput } from "./lark-im-quality-report.mjs";
import { runReadOnlyRemoteSample } from "./remote-sample.mjs";
import { publicRemoteReport } from "./remote-sample-cache.mjs";
import { collectStatusEvidence } from "./status-report.mjs";
import { createCheckPlan } from "./check-plan.mjs";
import { evaluateWaitState, isLocalReady } from "./service-wait-state.mjs";
import { inspectCoverage } from "./coverage-bridge.mjs";
import { publicCommandFailureReason } from "./public-safe.mjs";
/** @typedef {Record<string, any>} JsonObject */

/** @param {string} command @param {JsonObject} env */
function executableAvailable(command, env) {
  const paths = isAbsolute(command) || command.includes("/") ? [command] : String(env.PATH || "").split(delimiter).map((dir) => resolve(dir, command));
  return paths.some((path) => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
}
/** Dependency planning is read-only and never invokes remote tools. @param {JsonObject} plan @param {JsonObject} context */
function checkDependencies(plan, context) {
  return { sqlite: executableAvailable("sqlite3", context.env), python: !plan.through && !plan.live || executableAvailable("python3", context.env),
    live: !plan.live || executableAvailable(context.env.LARK_CLI || "lark-cli", context.env),
    wait: !plan.wait || executableAvailable("launchctl", context.env) };
}
/** @param {unknown} value */
const count = (value) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
/** @param {JsonObject} value */
function publicDatabase(value) {
  return { ok: value.ok === true, quick_check: value.quick_check === "ok" ? "ok" : "failed", foreign_key_issues: count(value.foreign_key_issues),
    missing_tables: (value.missing_tables || []).filter((/** @type {string} */ name) => ["sources", "sync_scopes", "records", "sync_runs", "sync_locks", "maintenance_locks"].includes(name)),
    counts: Object.fromEntries(["sources", "sync_scopes", "records", "sync_runs", "sync_locks", "maintenance_locks"].map((key) => [key, count(value.counts?.[key])])),
    size_bytes: count(value.size_bytes), page_size: count(value.page_size), page_count: count(value.page_count), freelist_count: count(value.freelist_count), reclaimable_bytes: count(value.reclaimable_bytes) };
}
/** @param {JsonObject} value */
function publicBackup(value) {
  return { ok: value.ok === true, ownership: ["matched", "mismatch", "unknown"].includes(value.ownership) ? value.ownership : "unknown",
    database: value.backup_check ? publicDatabase(value.backup_check) : null,
    manifest: { status: ["verified", "mismatch", "invalid", "missing"].includes(value.manifest?.status) ? value.manifest.status : "unknown",
      ok: value.manifest?.ok === true, checks: Object.fromEntries(["kind", "source", "backup_file", "sha256", "size", "counts"].map((key) => [key, value.manifest?.checks?.[key] === true])) } };
}
/** @param {JsonObject} live */
function liveReady(live) {
  if (Object.hasOwn(live, "guardian_diagnostic") || Object.hasOwn(live, "collector_diagnostic")) return false;
  if (!publicRemoteReport(live).ok) return false;
  const start = Date.parse(String(live.window?.start || ""));
  const end = Date.parse(String(live.window?.end || ""));
  return live.ok === true && live.status === "healthy" && Number.isSafeInteger(live.probe?.remote_messages_checked) && live.probe.remote_messages_checked > 0 &&
    live.missing_count === 0 && live.probe.probe_errors === 0 && Number.isFinite(start) && Number.isFinite(end) && start < end;
}
/** Preserve failure presence before public projection rejects unsafe fields.
 * @param {JsonObject} report @param {JsonObject} result */
function withRemoteDiagnostics(report, result) {
  for (const key of ["guardian_diagnostic", "collector_diagnostic"]) {
    if (Object.hasOwn(result, key)) report = { ...report, [key]: result[key] };
  }
  return report;
}
/** @param {JsonObject} plan @param {JsonObject} context @param {JsonObject} deps */
async function waitForCycle(plan, context, deps) {
  const deadline = context.now() + plan.timeoutSeconds * 1000;
  let state = null;
  do {
    const evidence = await (deps.collectStatusEvidence || collectStatusEvidence)(plan, context, deps.statusDeps);
    if (!evidence.report.sync.status) throw new Error("wait_evidence_unavailable");
    if (evidence.service.status === "unknown") throw new Error("wait_service_inspection_failed");
    state = evaluateWaitState(plan.calledAt, evidence.report.sync.status, evidence.workerSummary, evidence.service);
    if (state.ready) return { ok: true, ...state };
    if (evidence.service.status !== "running") return { ok: false, ...state };
    const remaining = deadline - context.now();
    if (remaining <= 0) break;
    await (deps.sleep || sleep)(Math.min(remaining, plan.pollSeconds * 1000, 60000));
  } while (context.now() <= deadline);
  return { ok: false, ...state, reason: "wait_timeout" };
}

/** One evidence plan. Every result owns an observation time; no cross-system
 * atomic snapshot is implied. @param {JsonObject} options @param {JsonObject} context @param {JsonObject} [deps] */
async function collectCheckReport(options, context, deps = {}) {
  const plan = createCheckPlan(options, context);
  const dependencies = await (deps.checkDependencies || checkDependencies)(plan, context);
  /** @type {JsonObject} */
  const checks = Object.fromEntries(["database", "sync", "quality", "coverage", "backup", "live", "wait"].map((key) => [key, { status: "not_requested" }]));
  /** @type {JsonObject[]} */
  const issues = [];
  const observed = () => new Date(context.now()).toISOString();
  const unavailable = (/** @type {string} */ key, /** @type {string} */ code) => {
    checks[key] = { status: "unavailable", observed_at: observed() }; issues.push({ code, check: key });
  };
  const collect = async (/** @type {string} */ key, /** @type {() => any} */ action, /** @type {(value: any) => boolean} */ passed, /** @type {(value: any) => any} */ project = (value) => value) => {
    try {
      const result = await action();
      const ok = passed(result);
      checks[key] = { status: ok ? "passed" : "incomplete", observed_at: observed(), evidence: project(result) };
      if (!ok) issues.push({ code: `${key}_incomplete`, check: key });
      return result;
    } catch (error) { unavailable(key, `${key}_${publicCommandFailureReason(error instanceof Error ? error.message : error)}`); return null; }
  };
  if (plan.wait) {
    if (!dependencies.sqlite || !dependencies.wait) unavailable("wait", "wait_dependency_unavailable");
    else await collect("wait", () => waitForCycle(plan, context, deps), (value) => value.ok === true);
  }
  let finalSync = null;
  let finalQuality = null;
  if (!dependencies.sqlite) for (const key of ["database", "sync", "quality"]) unavailable(key, `${key}_dependency_unavailable`);
  else {
    await collect("database", () => (deps.readDatabaseEvidence || readDatabaseEvidence)(plan.db), (value) => value.ok === true, publicDatabase);
    finalSync = await collect("sync", () => (deps.buildStatus || buildStatus)(plan.db), isLocalReady, sanitizeStatusReportForPublicOutput);
    finalQuality = await collect("quality", () => (deps.collectQualityReport || collectQualityReport)(plan.db), (value) => !hasQualityIssues(value), sanitizeQualityReportForPublicOutput);
  }
  if (plan.wait && checks.wait.status === "passed" && (!isLocalReady(finalSync) || !finalQuality || hasQualityIssues(finalQuality))) {
    checks.wait = { status: "incomplete", observed_at: observed(), evidence: { ok: false, reason: "final_local_not_ready" } };
    issues.push({ code: "wait_final_local_not_ready", check: "wait" });
  }
  if (plan.through) {
    if (!dependencies.sqlite || !dependencies.python) unavailable("coverage", "coverage_dependency_unavailable");
    else await collect("coverage", () => (deps.inspectCoverage || inspectCoverage)(plan, context), (value) => value.ok === true, (value) => value.evidence);
  }
  if (plan.backup || plan.latestBackup) {
    if (!dependencies.sqlite) unavailable("backup", "backup_dependency_unavailable");
    else await collect("backup", () => (deps.verifyBackupEvidence || verifyBackupEvidence)({ db: plan.db, backupDir: plan.backupDir, backup: plan.backup, latest: plan.latestBackup }, { now: () => new Date(context.now()), cwd: context.cwd }), (value) => value.ok === true, publicBackup);
  }
  let live = null;
  let remoteResult = /** @type {any} */ (null);
  let manualAttempt = /** @type {any} */ (null);
  if (plan.live) {
    const waitFailed = plan.wait && checks.wait.status !== "passed";
    const failedDependency = !dependencies.live || !dependencies.sqlite || (plan.through || plan.live) && !dependencies.python || plan.wait && !dependencies.wait;
    const localReadFailed = ["database", "sync", "quality"].some((key) => checks[key].status === "unavailable");
    if (waitFailed || failedDependency || localReadFailed) {
      checks.live = { status: "skipped", observed_at: observed(), reason: waitFailed ? "wait_not_passed" : "dependency_or_local_read_failed" };
      issues.push({ code: !dependencies.live ? "live_dependency_unavailable" : "live_skipped", check: "live" });
    } else {
      live = await collect("live", () => {
        if (plan.writeLiveCache) {
          manualAttempt = (deps.runManualRemoteSample || runManualRemoteSample)({ db: plan.db, logDir: plan.logDir }, {
            nowMs: context.now, collectorOptions: { startMs: plan.startMs, endMs: plan.endMs, hotChats: plan.hotChats, messagesPerChat: plan.messagesPerChat },
          });
          const report = manualAttempt.report || { schema_version: 3, ok: false, status: manualAttempt.outcome === "failed" ? "unavailable" : "inconclusive",
            reason: manualAttempt.reason, checked_at: observed(), window: { start: plan.start, end: plan.end }, probe: {}, findings: {}, binding: { state: "unverified" },
          };
          return withRemoteDiagnostics(report, manualAttempt);
        }
        remoteResult = (deps.collectRemoteSample || runReadOnlyRemoteSample)(plan.db, { ...plan, env: context.env }, { now: context.now });
        return withRemoteDiagnostics(remoteResult.report, remoteResult);
      }, liveReady, publicRemoteReport);
    }
  }
  if (remoteResult?.outcome === "failed" || manualAttempt?.outcome === "failed" || live &&
      (Object.hasOwn(live, "guardian_diagnostic") || Object.hasOwn(live, "collector_diagnostic"))) checks.live.status = "unavailable";
  const cache = { status: plan.writeLiveCache ? manualAttempt?.cacheWritten ? "written" : "skipped" : "not_requested" };
  const hardFailure = Object.values(checks).some((item) => ["failed", "unavailable"].includes(item.status)) || plan.live && !dependencies.live;
  const ok = !hardFailure && Object.values(checks).every((item) => ["passed", "not_requested"].includes(item.status));
  return { schema_version: 1, privacy: plan.unsafeDetails ? "private" : "public-safe", ok, started_at: new Date(plan.calledAt).toISOString(), observed_at: observed(), checks, cache, issues,
    exit_code: hardFailure ? 1 : ok ? 0 : 2 };
}
export { collectCheckReport, checkDependencies, executableAvailable, liveReady, publicDatabase, publicBackup, waitForCycle };
