// @ts-check

import { readOnlySqliteJson } from "../storage/sqlite/readonly-query.mjs";
import { summarizeHealth } from "./sync-status-core.mjs";
import { summarizeLockEvidence } from "./lark-im-lock-evidence.mjs";

import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  fstatSync,
} from "node:fs";
import { resolve } from "node:path";
import { summarizeWorkerEvents } from "../../dist/runtime/worker/lark-im-worker-core.js";
import { activityDatabaseKey, inspectActivityProcesses, latestActivityEvents, evaluateActivityEvent, validateActivityEventShape, compareActivityProcessStarts, collectWorkerParentIdentities } from "./lark-im-activity-evidence.mjs";
import { classifyLarkFailure } from "../adapters/lark-im/transport.mjs";
import { readLiveProbeCache, liveProbeContext, DEFAULT_LIVE_PROBE_TTL_MS } from "./live-probe-cache.mjs";
import { buildStatus } from "./sync-status-report.mjs";
import { probeService, parseLaunchdState, classifyLaunchdPrint } from "../runtime/service/launchd.mjs";

const DEFAULT_FRESHNESS_MAX_AGE_MS = DEFAULT_LIVE_PROBE_TTL_MS;
const DEFAULT_STABILITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WORKER_LOG_TAIL_BYTES = 8 * 1024 * 1024;
const DEFAULT_WORKER_LOG_MAX_EVENTS = 20000;
const DEFAULT_DB = "data/exocortex.sqlite";

/**
 * @typedef {Record<string, any>} JsonObject
 * @typedef {import("node:child_process").SpawnSyncReturns<string>} SpawnResult
 *
 * @typedef {object} WorkerLogTail
 * @property {string} path
 * @property {boolean} exists
 * @property {JsonObject[]} events
 * @property {boolean=} truncated
 * @property {boolean=} activity_integrity
 *
 * @typedef {object} ServiceStatusOptions
 * @property {string} label
 * @property {string} target
 * @property {string} logDir
 * @property {string=} db
 *
 * @typedef {object} ServiceStatusReportDeps
 * @property {(cmd: string, args: string[], options?: {allowFailure?: boolean}) => SpawnResult=} runCommand
 * @property {(logDir: string) => WorkerLogTail=} readRecentWorkerEvents
 * @property {(events: unknown[], nowMs?: number) => JsonObject=} summarizeWorkerEvents
 * @property {(path: string) => JsonObject | null=} readLiveProbeCache
 * @property {(path: string) => JsonObject | null=} liveProbeContext
 * @property {(dbPath: string, sql: string, label: string) => JsonObject[]=} sqliteJson
 * @property {typeof inspectActivityProcesses=} inspectActivityProcesses
 * @property {(dbPath: string) => JsonObject=} buildStatus
 * @property {JsonObject=} serviceDeps
 * @property {number=} nowMs
 * @property {() => number=} clock
 * @property {number=} freshnessMaxAgeMs
 * @property {number=} stabilityWindowMs
 *
 * @typedef {"running" | "stopped" | "unknown"} ServiceRuntimeStatus
 * @typedef {"ok" | "catching_up" | "problem"} ServiceHealthStatus
 * @typedef {"idle" | "syncing" | "unknown"} ServiceActivityStatus
 * @typedef {"sampled" | "unknown" | "behind"} ServiceFreshnessStatus
 *
 * @typedef {object} ServiceOverview
 * @property {ReturnType<typeof summarizeLockEvidence>} leases
 * @property {{status: ServiceRuntimeStatus, detail: string}} service
 * @property {{status: ServiceHealthStatus, detail: string}} health
 * @property {{status: ServiceActivityStatus, state: string, detail: string}} activity
 * @property {{status: ServiceFreshnessStatus, detail: string}} freshness
 */

/**
 * @param {string} dbPath
 * @param {string} sql
 * @param {string} label
 * @returns {JsonObject[]}
 */
function sqliteJson(dbPath, sql, label) {
  return readOnlySqliteJson(dbPath, sql, label);
}


/**
 * @param {string} path
 * @param {number} [maxBytes]
 */
function readFileTail(path, maxBytes = 512 * 1024) {
  return readFileTailEvidence(path, maxBytes).text;
}

/** Read one opened file even if its path is rotated during the read.
 * @param {string} path @param {number} maxBytes */
function readFileTailEvidence(path, maxBytes) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const start = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    return { text: start > 0 ? newline < 0 ? "" : text.slice(newline + 1) : text,
      truncated: start > 0 || bytesRead < length };
  } finally {
    closeSync(fd);
  }
}

/**
 * Only current worker.jsonl is read; rotated files are not history evidence.
 * @param {string} logDir
 * @param {{maxBytes?: number, maxEvents?: number}} [limits]
 * @returns {WorkerLogTail}
 */
function readRecentWorkerEvents(logDir, limits = {}) {
  const path = resolve(logDir, "worker.jsonl");
  if (!existsSync(path)) return { path, exists: false, events: [], truncated: false };
  const maxBytes = limits.maxBytes ?? DEFAULT_WORKER_LOG_TAIL_BYTES;
  const maxEvents = limits.maxEvents ?? DEFAULT_WORKER_LOG_MAX_EVENTS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxEvents) || maxEvents < 1) {
    throw new Error("worker log read limits must be positive integers");
  }
  const tail = readFileTailEvidence(path, maxBytes);
  const allLines = tail.text.trim().split("\n").filter(Boolean);
  const lines = allLines.slice(-maxEvents);
  /** @type {JsonObject[]} */
  const events = [];
  let activityIntegrity = tail.text.endsWith("\n");
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || Array.isArray(event)) { activityIntegrity = false; continue; }
      if (!["lark_im_worker_cycle", "lark_im_worker_step", "lark_im_worker_scheduler", "lark_im_worker_activity"].includes(event.type)) activityIntegrity = false;
      if (event.type === "lark_im_worker_activity" && !validateActivityEventShape(event)) activityIntegrity = false;
      events.push(event);
    } catch {
      // Never fall back to an older phase after a damaged or partial event.
      activityIntegrity = false;
    }
  }
  return { path, exists: true, events, truncated: tail.truncated || allLines.length > maxEvents, activity_integrity: activityIntegrity };
}

/**
 * @param {JsonObject | null | undefined} event
 * @returns {number | null}
 */
function eventTimeMs(event) {
  const parsed = Date.parse(String(event?.at || event?.finished_at || event?.started_at || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {unknown[]} events
 * @param {number} [nowMs]
 * @param {number} [windowMs]
 * @param {{truncated?: boolean}} [logEvidence]
 */
function summarizeWorkerStability(events, nowMs = Date.now(), windowMs = DEFAULT_STABILITY_WINDOW_MS, logEvidence = {}) {
  const windowStartMs = nowMs - windowMs;
  const retained = (events || [])
    .filter((event) => event && typeof event === "object")
    .map((event) => /** @type {JsonObject} */ (event))
    .filter((event) => ["lark_im_worker_cycle", "lark_im_worker_step", "lark_im_worker_scheduler"].includes(event.type))
    .map((event) => ({ event, at_ms: eventTimeMs(event) }))
    .filter((item) => item.at_ms !== null && item.at_ms <= nowMs)
    .sort((a, b) => Number(a.at_ms) - Number(b.at_ms));
  const normalized = retained.filter((item) => Number(item.at_ms) >= windowStartMs);
  const cycles = normalized.filter((item) => item.event.type === "lark_im_worker_cycle");
  const successCycles = cycles.filter((item) => item.event.ok === true);
  const failedCycles = cycles.filter((item) => item.event.ok === false);
  const failedSteps = normalized.filter(
    (item) => item.event.type === "lark_im_worker_step" && item.event.ok === false,
  );
  /** @type {Record<string, number>} */
  const failuresByStep = {};
  for (const item of failedSteps) {
    const name = String(item.event.name || "unknown");
    failuresByStep[name] = (failuresByStep[name] || 0) + 1;
  }
  const successTimes = successCycles.map((item) => Number(item.at_ms));
  const lastSuccess = successCycles.at(-1);
  /** @type {number | null} */
  let longestBetweenSuccessesMs = null;
  for (let i = 1; i < successTimes.length; i += 1) {
    longestBetweenSuccessesMs = Math.max(longestBetweenSuccessesMs ?? 0, successTimes[i] - successTimes[i - 1]);
  }
  const firstRetained = retained[0];
  const lastRetained = retained.at(-1);
  const firstMs = firstRetained ? Number(firstRetained.at_ms) : null;

  return {
    window_ms: windowMs,
    window_started_at: new Date(windowStartMs).toISOString(),
    observation: {
      first_event_at: firstMs === null ? null : new Date(firstMs).toISOString(),
      last_event_at: lastRetained ? new Date(Number(lastRetained.at_ms)).toISOString() : null,
      range_started_at: firstMs === null ? null : new Date(Math.max(windowStartMs, firstMs)).toISOString(),
      range_ended_at: firstMs === null ? null : new Date(nowMs).toISOString(),
      window_start_reached: firstMs !== null && firstMs <= windowStartMs,
      tail_truncated: typeof logEvidence.truncated === "boolean" ? logEvidence.truncated : null,
    },
    observed_events: normalized.length,
    cycles: {
      total: cycles.length,
      ok: successCycles.length,
      failed: failedCycles.length,
    },
    last_success: lastSuccess
      ? {
          cycle: lastSuccess.event.cycle ?? null,
          at: new Date(Number(lastSuccess.at_ms)).toISOString(),
          age_ms: Math.max(0, nowMs - Number(lastSuccess.at_ms)),
        }
      : null,
    longest_between_successes_ms: longestBetweenSuccessesMs,
    failures: {
      failed_cycles: failedCycles.length,
      failed_steps: failedSteps.length,
      by_step: Object.entries(failuresByStep)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    },
  };
}

/** @param {unknown} value */
function quoteSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * @param {string} dbPath
 * @param {number} nowMs
 * @param {number} windowMs
 * @param {ServiceStatusReportDeps} [deps]
 */
function collectRecentFailureKinds(dbPath, nowMs, windowMs, deps = {}) {
  const query = deps.sqliteJson || sqliteJson;
  const windowStart = new Date(nowMs - windowMs).toISOString();
  const rows = query(
    dbPath,
    `SELECT error_message
     FROM sync_runs
     WHERE status = 'failed'
       AND started_at >= ${quoteSql(windowStart)}
     ORDER BY id DESC;`,
    "read recent failed run kinds",
  );
  /** @type {Record<string, number>} */
  const byKind = {};
  for (const row of rows) {
    const kind = classifyLarkFailure(row.error_message || "").kind;
    byKind[kind] = (byKind[kind] || 0) + 1;
  }
  return {
    failed_runs: rows.length,
    by_kind: Object.entries(byKind)
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
  };
}

/**
 * @param {{loaded?: boolean | null, state?: unknown, pid?: unknown}} launchd
 * @returns {{status: ServiceRuntimeStatus, detail: string}}
 */
function summarizeServiceRuntime(launchd) {
  if (launchd.loaded === null || launchd.loaded === undefined) return { status: "unknown", detail: "LaunchAgent state unavailable: launchctl print failed" };
  if (!launchd.loaded) return { status: "stopped", detail: "LaunchAgent not loaded" };
  const state = String(launchd.state || "").toLowerCase();
  const hasWorkerProcess = Boolean(launchd.pid);
  if (hasWorkerProcess || state === "running" || state === "active") {
    return { status: "running", detail: "LaunchAgent loaded, worker process active" };
  }
  return { status: "stopped", detail: "LaunchAgent loaded, worker process not running" };
}

/**
 * @param {JsonObject | null} syncStatus
 */
function isCatchingUp(syncStatus) {
  if (!syncStatus) return false;
  return (
    String(syncStatus.health || "").toLowerCase() === "catching_up" ||
    Number(syncStatus.details?.pending_count || 0) > 0 ||
    Number(syncStatus.scopes?.received_without_cursor || 0) > 0 ||
    syncStatus.discovery?.cursor?.has_more === true
  );
}

/**
 * @param {{service: {status: ServiceRuntimeStatus}, syncStatus: JsonObject | null, syncErrorText?: string, workerSummary: JsonObject, activity?: {status: ServiceActivityStatus}}} input
 * @returns {{status: ServiceHealthStatus, detail: string}}
 */
function summarizeServiceHealth({ service, syncStatus, syncErrorText = "", workerSummary, activity }) {
  if (service.status === "unknown") return { status: "problem", detail: "background service state is unavailable" };
  if (service.status !== "running") return { status: "problem", detail: "background service is stopped" };
  if (!syncStatus) return { status: "problem", detail: syncErrorText || "sync status unavailable" };
  const rawHealth = String(syncStatus.health || "").toLowerCase();
  const databasePhaseUnknown = rawHealth === "unknown" && syncStatus.current_activity?.evidence === "database_only"
    && syncStatus.current_activity?.reason === "unverified_sync_history";
  const historicalHealth = databasePhaseUnknown ? summarizeHealth({
    discoveryCursor: syncStatus.discovery?.cursor, scopeCounts: syncStatus.scopes || {}, locks: [],
    runCounts: Object.entries(syncStatus.runs?.by_status || {}).filter(([status]) => status !== "running")
      .map(([status, count]) => ({ status, count })), details: syncStatus.details,
  }) : null;
  if (databasePhaseUnknown && activity?.status === "syncing" && ["needs_attention", "not_ready"].includes(String(historicalHealth))) {
    return { status: "problem", detail: historicalHealth === "not_ready"
      ? "initial discovery or successful message-scope evidence is missing"
      : "sync history contains failures but no successful run" };
  }
  if (["failed", "needs_attention", "problem", "command_failed", "not_ready", "unknown"].includes(rawHealth)
    && !(databasePhaseUnknown && activity?.status === "syncing")) {
    return { status: "problem", detail: syncStatus.health_detail || rawHealth };
  }
  if (workerSummary.last_cycle?.ok === false && activity?.status !== "syncing") {
    return { status: "problem", detail: "last worker cycle failed" };
  }
  if (isCatchingUp(syncStatus) || historicalHealth === "catching_up") {
    if (Number(syncStatus.details?.pending_count || 0) > 0) {
      return { status: "catching_up", detail: `${Number(syncStatus.details.pending_count)} message details await retry` };
    }
    return { status: "catching_up", detail: rawHealth === "catching_up" ? syncStatus.health_detail || "sync is still catching up" : "known scopes still need catch-up" };
  }
  if (rawHealth === "syncing" || databasePhaseUnknown) {
    if (activity?.status !== "syncing") return { status: "problem", detail: "unfinished sync history has no current activity evidence" };
    return { status: "ok", detail: "sync activity observed; this does not verify remote freshness" };
  }
  if (!["ok", "ok_with_history"].includes(rawHealth)) return { status: "problem", detail: "sync health is unknown" };
  return { status: "ok", detail: syncStatus.health_detail || "all known enabled scopes have cursors" };
}

/**
 * Current phases and OS identity establish activity; leases only diagnose
 * unidentified possible work. Historical completed events never establish it.
 * @param {{service: {status: ServiceRuntimeStatus}, syncStatus: JsonObject | null, workerSummary: JsonObject, nowMs?: number, activityEvidence?: JsonObject, launchd?: JsonObject}} input
 */
function summarizeServiceActivity({ service, syncStatus, nowMs = Date.now(), activityEvidence, launchd = {} }) {
  /** @param {string} state @param {string} detail @param {JsonObject} [fields] */
  const result = (state, detail, fields = {}) => ({
    status: /** @type {ServiceActivityStatus} */ (state === "waiting" || state === "stopped" ? "idle" : state), state, detail, ...fields,
  });
  if (!syncStatus || syncStatus.status === "command_failed" || !syncStatus.health) {
    return result("unknown", "sync status unavailable; current activity cannot be determined");
  }
  if (activityEvidence?.database_identity_stable === false) return result("unknown", "database file identity changed or is unavailable");
  if (activityEvidence?.integrity === false || activityEvidence?.truncated) {
    return result("unknown", "current phase evidence is incomplete");
  }
  const events = activityEvidence?.events || [];
  if (!events.every(validateActivityEventShape)) return result("unknown", "current phase evidence is incomplete");
  const processes = activityEvidence?.processes || new Map();
  const evaluated = events.map((event) => ({ event,
    value: evaluateActivityEvent(event, processes.get(event.pid), activityEvidence?.database_key || "", nowMs),
  })).filter((item) => item.value.state !== "other_database" && item.value.state !== "dead");
  // Unknown liveness/start evidence is not proof that a historical worker
  // association disappeared. Only two known, different starts exclude it.
  // A dead parent still named by a live child's PPID is a non-atomic conflict,
  // not evidence that the child has become an independent invocation.
  const parentIdentities = activityEvidence?.parent_identities || collectWorkerParentIdentities(events,
    events.filter((event) => event.role === "sync").map((event) => processes.get(event.pid)?.ppid));
  const workerPids = new Set([...parentIdentities].filter(([pid, expectedStarts]) =>
    [...expectedStarts].some((expectedStart) => compareActivityProcessStarts(expectedStart, processes.get(pid)?.started_at_ms) !== "different")).map(([pid]) => pid));
  if (service.status === "running" && launchd.pid) workerPids.add(Number(launchd.pid));
  const worker = evaluated.find((item) => item.event.role === "worker"
    && (service.status !== "running" || item.event.pid === Number(launchd.pid)));
  const children = evaluated.filter((item) => item.event.role === "sync" && item.value.state !== "stopped");
  const independent = [];
  let childEvidenceIssue = null;
  for (const child of children) {
    const ppid = processes.get(child.event.pid)?.ppid;
    const parent = child.event.parent_instance;
    if (parent || workerPids.has(ppid)) {
      if (!worker || parent !== worker.event.instance_id || ppid !== worker.event.pid
        || worker.value.state !== "syncing") {
        const belongsToCurrentWorker = worker && (parent === worker.event.instance_id || ppid === worker.event.pid);
        childEvidenceIssue = belongsToCurrentWorker ? "worker and child phase evidence disagree"
          : childEvidenceIssue || "a worker child has no verified current parent phase";
      }
    } else if (!Number.isSafeInteger(ppid) || ppid < 1) {
      childEvidenceIssue ||= "foreground process parent is unavailable";
    } else independent.push(child);
  }
  // Verified independent work proves activity for this database even if a
  // different worker/child remains unexplained. Never promote that child.
  const foreground = independent.find((item) => item.value.state === "syncing");
  if (foreground) return result("syncing", "foreground sync observed", {
    phase: "sync", updated_at: foreground.value.updated_at, valid_until: foreground.value.valid_until,
    evidence: "recent_foreground_phase", observed_at: activityEvidence?.observed_at || null,
  });
  if (childEvidenceIssue) return result("unknown", childEvidenceIssue);
  if (worker?.value.state === "syncing" && service.status !== "unknown") {
    const value = worker.value;
    return result("syncing", `cycle #${value.cycle || "?"}${value.step ? ` · ${value.step}` : " · between steps"}`, {
      phase: value.phase, cycle: value.cycle, updated_at: value.updated_at, valid_until: value.valid_until,
      evidence: "verified_worker_phase", observed_at: activityEvidence?.observed_at || null,
    });
  }
  const uncertainEvent = evaluated.some((item) => item.value.state === "unknown" || item.value.state === "syncing");
  // Expiry ends the reservation, not the owner's process. Both live and
  // uninspectable owners prevent an unsupported overall WAITING/STOPPED claim.
  const uncertainOwner = !Array.isArray(syncStatus.locks) || syncStatus.locks.some((lock) => {
    const at = Date.parse(String(lock.owner_observed_at || ""));
    return lock.owner_state !== "dead" || !Number.isFinite(at) || at > nowMs || nowMs - at > 5000;
  });
  if (uncertainEvent || uncertainOwner) return result("unknown", "current phase or owner evidence is unavailable");
  if (worker?.value.state === "waiting" && service.status !== "unknown") {
    return result("waiting", `between cycles · last cycle #${worker.value.cycle || "?"}`, {
      phase: "waiting", cycle: worker.value.cycle, updated_at: worker.value.updated_at, valid_until: worker.value.valid_until,
      evidence: "verified_worker_phase", observed_at: activityEvidence?.observed_at || null,
    });
  }
  if (service.status === "stopped") return result("stopped", "no current local sync process observed");
  return result("unknown", "current worker phase is unavailable");
}

/**
 * @param {number} ms
 * @returns {string}
 */
function durationText(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Cached evidence is local-file/source bound and deliberately says nothing
 * about the identity of the currently authenticated remote principal.
 * @param {JsonObject | null | undefined} liveProbe
 * @param {number} [nowMs]
 * @param {number} [maxAgeMs]
 * @param {JsonObject | null} [expectedContext]
 * @returns {{status: ServiceFreshnessStatus, detail: string, [key: string]: any}}
 */
function summarizeServiceFreshness(liveProbe, nowMs = Date.now(), maxAgeMs = DEFAULT_FRESHNESS_MAX_AGE_MS, expectedContext = null) {
  const unknown = (/** @type {string} */ reason, /** @type {string} */ detail) => ({
    status: /** @type {ServiceFreshnessStatus} */ ("unknown"), reason, detail, auth_identity: "unknown",
  });
  if (!liveProbe) return unknown("no_cached_probe", "no cached live probe");
  if (liveProbe.kind !== "lark_im_live_probe_cache/v2") return unknown("legacy_evidence", "legacy live probe lacks bound sample evidence");
  if (!expectedContext || !liveProbe.context || liveProbe.context.database_key !== expectedContext.database_key || liveProbe.context.source_id !== expectedContext.source_id) {
    return unknown("context_mismatch", "live probe does not match the current database/source");
  }
  const checkedAtMs = Date.parse(String(liveProbe.checked_at || ""));
  const expiresAtMs = Date.parse(String(liveProbe.expires_at || ""));
  if (!Number.isFinite(checkedAtMs) || !Number.isFinite(expiresAtMs) || checkedAtMs > nowMs || expiresAtMs <= checkedAtMs) {
    return unknown("invalid_timestamp", "cached live probe has invalid timestamps");
  }
  const deadlineMs = Math.min(expiresAtMs, checkedAtMs + Math.min(DEFAULT_FRESHNESS_MAX_AGE_MS, maxAgeMs));
  const ageText = `${durationText(nowMs - checkedAtMs)} ago`;
  if (nowMs >= deadlineMs) return unknown("expired", `last live probe stale, checked ${ageText}`);
  const windowStartMs = Date.parse(String(liveProbe.window?.start || ""));
  const windowEndMs = Date.parse(String(liveProbe.window?.end || ""));
  const sampleCount = liveProbe.sample?.remote_messages_checked;
  if (liveProbe.scope !== "recent_hot_messages" || !Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowStartMs >= windowEndMs || !Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
    return unknown("no_usable_sample", "live probe lacks a usable message sample and bounded window");
  }
  const evidence = {
    scope: "recent_hot_messages", sample_count: sampleCount,
    window: { start: new Date(windowStartMs).toISOString(), end: new Date(windowEndMs).toISOString() },
    checked_at: new Date(checkedAtMs).toISOString(), expires_at: new Date(deadlineMs).toISOString(),
    auth_identity: "unknown",
  };
  if (liveProbe.status === "healthy" && liveProbe.ok === true && liveProbe.missing_count === 0 && liveProbe.sample?.probe_errors === 0) {
    return { ...evidence, status: "sampled", detail: `${sampleCount} recent hot messages sampled ${ageText}; auth identity unknown` };
  }
  if (liveProbe.status === "delayed" && Number(liveProbe.missing_count) > 0) {
    return { ...evidence, status: "behind", detail: `sample checked ${ageText}, missing ${liveProbe.missing_count}; auth identity unknown` };
  }
  return unknown("inconclusive", "last live probe did not establish sample freshness");
}

/**
 * @param {{launchd: JsonObject, syncStatus: JsonObject | null, syncErrorText?: string, workerSummary: JsonObject, liveProbe?: JsonObject | null, expectedContext?: JsonObject | null, nowMs?: number, freshnessMaxAgeMs?: number, activityEvidence?: JsonObject}} input
 * @returns {ServiceOverview}
 */
function buildServiceOverview({
  launchd,
  syncStatus,
  syncErrorText = "",
  workerSummary,
  liveProbe = null,
  expectedContext = null,
  nowMs = Date.now(),
  freshnessMaxAgeMs = DEFAULT_FRESHNESS_MAX_AGE_MS,
  activityEvidence,
}) {
  const service = summarizeServiceRuntime(launchd);
  const activity = summarizeServiceActivity({ service, syncStatus, workerSummary, nowMs, activityEvidence, launchd });
  return {
    service,
    leases: summarizeLockEvidence(syncStatus?.locks, nowMs),
    health: summarizeServiceHealth({ service, syncStatus, syncErrorText, workerSummary, activity }),
    activity,
    freshness: summarizeServiceFreshness(liveProbe, nowMs, freshnessMaxAgeMs, expectedContext),
  };
}

/**
 * @param {ServiceStatusOptions} opts
 * @param {ServiceStatusReportDeps} [deps]
 */
function buildServiceStatusReport(opts, deps = {}) {
  const readWorkerLog = deps.readRecentWorkerEvents || readRecentWorkerEvents;
  const summarize = deps.summarizeWorkerEvents || summarizeWorkerEvents;
  const readFreshnessCache = deps.readLiveProbeCache || readLiveProbeCache;
  const now = () => deps.nowMs ?? (deps.clock || Date.now)();
  const initialDatabaseKey = activityDatabaseKey(opts.db || DEFAULT_DB);
  const probe = probeService({ ...deps.serviceDeps, target: opts.target, ...(deps.runCommand ? { run: deps.runCommand } : {}) });
  const inspection = probe.loaded === null ? "unknown" : probe.loaded ? "loaded" : "absent";
  const loaded = probe.loaded;
  const launchdState = { state: probe.state, pid: probe.pid, "last exit code": probe.last_exit_code };
  let syncStatus = null;
  try { syncStatus = (deps.buildStatus || buildStatus)(opts.db || DEFAULT_DB); } catch { /* unavailable, never raw errors */ }
  const workerLog = readWorkerLog(opts.logDir);
  const liveProbeCachePath = resolve(opts.logDir, "live-probe.json");
  const liveProbe = readFreshnessCache(liveProbeCachePath);
  const expectedContext = (deps.liveProbeContext || liveProbeContext)(opts.db || DEFAULT_DB);
  let failureKinds = [];
  try {
    failureKinds = collectRecentFailureKinds(
      opts.db || DEFAULT_DB,
      now(),
      deps.stabilityWindowMs || DEFAULT_STABILITY_WINDOW_MS,
      deps,
    ).by_kind;
  } catch {
    // Failure aggregation is optional; unavailable evidence stays empty.
  }
  // Synchronous diagnostic reads can outlast a lease or observe one acquired
  // after collection began. Evaluate all temporal evidence after those reads.
  const candidates = latestActivityEvents(workerLog.events, initialDatabaseKey, now());
  const processes = (deps.inspectActivityProcesses || inspectActivityProcesses)(candidates.events.map((event) => Number(event.pid)));
  const parentIdentities = collectWorkerParentIdentities(workerLog.events, candidates.events
    .filter((event) => event.role === "sync").map((event) => processes.get(Number(event.pid))?.ppid));
  const finalDatabaseKey = activityDatabaseKey(opts.db || DEFAULT_DB);
  const nowMs = now();
  const activityEvidence = { ...candidates, processes, parent_identities: parentIdentities, database_key: finalDatabaseKey,
    database_identity_stable: initialDatabaseKey !== null && initialDatabaseKey === finalDatabaseKey,
    integrity: workerLog.activity_integrity !== false && candidates.integrity !== false, observed_at: new Date(nowMs).toISOString() };
  const workerSummary = summarize(workerLog.events.filter((event) => event.type !== "lark_im_worker_activity"), nowMs);
  const workerStability = summarizeWorkerStability(
    workerLog.events,
    nowMs,
    deps.stabilityWindowMs || DEFAULT_STABILITY_WINDOW_MS,
    workerLog,
  );
  workerStability.failures.by_kind = failureKinds;
  const serviceState = loaded === null ? "unknown" : loaded ? launchdState.state || "loaded" : "not loaded";
  const launchdReport = {
    loaded,
    inspection,
    state: launchdState.state || null,
    pid: launchdState.pid || null,
    last_exit_code: launchdState["last exit code"] || null,
    command_status: probe.command_status,
  };
  const syncErrorText = syncStatus ? "" : "sync status unavailable";

  return {
    label: opts.label,
    probe,
    activity_evidence: activityEvidence,
    service_state: serviceState,
    overview: buildServiceOverview({
      launchd: launchdReport,
      syncStatus,
      syncErrorText,
      workerSummary,
      activityEvidence,
      liveProbe,
      expectedContext,
      nowMs,
      freshnessMaxAgeMs: deps.freshnessMaxAgeMs,
    }),
    launchd: launchdReport,
    sync: {
      status: syncStatus,
      command_status: syncStatus ? 0 : 1,
      error_text: syncErrorText,
    },
    worker: {
      log: { ...workerLog, events: workerLog.events.filter((event) => event.type !== "lark_im_worker_activity") },
      summary: workerSummary,
    },
    stability: workerStability,
    freshness: {
      cache_path: liveProbeCachePath,
      cache: liveProbe,
    },
  };
}

export {
  buildServiceOverview,
  buildServiceStatusReport,
  classifyLaunchdPrint,
  collectRecentFailureKinds,
  durationText,
  DEFAULT_DB,
  DEFAULT_FRESHNESS_MAX_AGE_MS,
  DEFAULT_STABILITY_WINDOW_MS,
  DEFAULT_WORKER_LOG_MAX_EVENTS,
  DEFAULT_WORKER_LOG_TAIL_BYTES,
  isCatchingUp,
  eventTimeMs,
  parseLaunchdState,
  readFileTail,
  readRecentWorkerEvents,
  sqliteJson,
  summarizeServiceActivity,
  summarizeServiceFreshness,
  summarizeServiceHealth,
  summarizeServiceRuntime,
  summarizeWorkerStability,
};
