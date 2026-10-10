// @ts-check

import {
  buildPeopleContext,
  fetchChatDiscoveryPage,
  fetchChatMessageList,
  fetchSentMessageList,
  fetchMessageDetails,
  isBotUserOutOfChatError,
  isRestrictedModeError,
} from "./adapter.mjs";
import { isExhaustedLarkTransportFailure } from "./transport.mjs";
import { bindCurrentSenderNames, reuseKnownSenderNames } from "./name-history.mjs";
import {
  acquireLock,
  confirmInitialLarkAccountSql,
  createRun,
  failRun,
  commitLarkListRun,
  readLarkListProgress,
  readPendingLarkDetails,
  finishLarkDetailRun,
  isMaintenanceLocked,
  quoteSql,
  readScope,
  releaseLock,
  runFenceGuardSql as storeRunFenceGuardSql,
  sqlJson,
  sqliteExec,
  sqliteQuery,
} from "../../../dist/storage/sqlite/ingestion-store.js";
import {
  CHAT_DISCOVERY_SCOPE_ID,
  CHAT_HOT_DISCOVERY_SCOPE_ID,
  CHAT_RECONCILE_SCOPE_ID,
  SENT_SCOPE_ID,
  SOURCE_ID,
  chatScopeId,
  cursorAfter,
  fetchMessageWindowWithBisection,
  hash,
  localIsoFromMs,
  messageWindow,
  prepareRecords,
  recordFromMessage,
  senderId,
  shortHash,
} from "./core.mjs";

/**
 * @typedef {"cursor" | "hot" | "reconcile"} DiscoveryMode
 * @typedef {"all" | "hot" | "catchup"} ReceivedMode
 *
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} SyncOptions
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} pageSize
 * @property {number} maxPages
 * @property {number} chatPageSize
 * @property {number} maxChatPages
 * @property {number} discoveryPagesPerRun
 * @property {number} receivedScopesPerRun
 * @property {DiscoveryMode} discoveryMode
 * @property {number} reconcileIntervalHours
 * @property {ReceivedMode} receivedMode
 * @property {string} chatTypes
 * @property {number} stableHorizonSeconds
 * @property {boolean} endExplicit
 * @property {number} lockTtlSeconds
 * @property {number} retries
 * @property {number} retryDelayMs
 * @property {number=} detailLimit
 * @property {string=} detailScope
 * @property {number=} detailBudgetMs
 * @property {number=} detailMaxPages
 * @property {number=} detailMaxItems
 *
 * @typedef {JsonObject & {
 *   id: string,
 *   source_id: string,
 *   enabled?: number,
 *   source_enabled?: number,
 *   config?: JsonObject,
 *   cursor?: JsonObject | null,
 *   cursor_json?: string | null,
 *   cursor_updated_at?: string | null
 * }} ScopeRow
 *
 * @typedef {{open_id: string, name: string}} SelfProfile
 *
 * @typedef {JsonObject & {
 *   ok?: boolean,
 *   scope_id?: string,
 *   run_id?: number | null,
 *   skipped?: boolean,
 *   reason?: string
 * }} RunResult
 *
 * @typedef {object} DiscoveryResult
 * @property {string} snapshot_id
 * @property {string} snapshot_started_at
 * @property {JsonObject[]} chats
 * @property {number} pages
 * @property {number} pages_scanned_total
 * @property {boolean} has_more
 * @property {string} page_token
 * @property {boolean=} hot
 *
 * @typedef {typeof defaultDeps} SyncRunnerDeps
 *
 * @typedef {object} SyncRunner
 * @property {(dbPath: string, mode?: ReceivedMode) => ScopeRow[]} listReceivedScopes
 * @property {(dbPath: string, scopeId: string, opts: SyncOptions, worker: (scope: ScopeRow, runId: number) => RunResult) => RunResult} syncScope
 * @property {(dbPath: string, opts: SyncOptions, selfProfile: SelfProfile) => RunResult} syncSent
 * @property {(messages: JsonObject[], scopeId: string, cursor: JsonObject | null | undefined, startMs: number, endMs: number, selfOpenId: string, peopleContext: JsonObject, scopeConfig: JsonObject) => JsonObject[]} prepareChatWindowRecords
 * @property {(scope: ScopeRow, opts: SyncOptions) => DiscoveryResult} discoverChatPages
 * @property {(opts: SyncOptions) => DiscoveryResult} discoverHotChatPages
 * @property {(scope: ScopeRow, opts: SyncOptions) => boolean} shouldSkipCompletedDiscovery
 * @property {(scope: ScopeRow, opts: SyncOptions) => boolean} shouldSkipReconcile
 * @property {(dbPath: string, opts: SyncOptions) => RunResult} syncDiscovery
 * @property {(dbPath: string, scope: ScopeRow, runId: number, error: unknown, reason: string) => void} succeedUnsupportedRun
 * @property {(dbPath: string, opts: SyncOptions, scope: ScopeRow, selfProfile: SelfProfile) => RunResult} syncReceivedScope
 * @property {(dbPath: string, opts: SyncOptions, selfProfile: SelfProfile) => RunResult[]} syncReceived
 * @property {(dbPath: string, opts: SyncOptions, selfProfile: SelfProfile) => RunResult[]} retryDetails
 */

const defaultDeps = {
  acquireLock,
  buildPeopleContext,
  reuseKnownSenderNames,
  createRun,
  failRun,
  commitLarkListRun,
  readLarkListProgress,
  readPendingLarkDetails,
  finishLarkDetailRun,
  fetchChatDiscoveryPage,
  fetchChatMessageList,
  fetchSentMessageList,
  fetchMessageDetails,
  isMaintenanceLocked,
  isBotUserOutOfChatError,
  isRestrictedModeError,
  makeSnapshotId: (prefix = "snapshot") => `${prefix}_${Date.now()}_${shortHash(`${process.pid}:${Math.random()}`)}`,
  nowIso: () => new Date().toISOString(),
  nowMs: () => performance.now(),
  quoteSql,
  readScope,
  releaseLock,
  runFenceGuardSql: storeRunFenceGuardSql,
  sqlJson,
  sqliteExec,
  sqliteQuery,
};

/**
 * @param {Partial<SyncRunnerDeps>} [deps]
 * @returns {SyncRunnerDeps}
 */
function resolveDeps(deps = {}) {
  return { ...defaultDeps, ...deps };
}

// The discovery rank is an activity hint, not a timestamp of a message.
const HOT_POOL_SIZE = 20;
const HOT_SNAPSHOT_TTL_MS = 10 * 60_000;
const RECENT_SUCCESS_SKIP_MS = 60_000;

/** @param {ScopeRow} scope @param {string} key */
function numericScopeRank(scope, key) {
  const raw = scope.config?.[key];
  const value = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** Persisted attempts rotate failed/killed work too. Creation time keeps a
 * continuous stream of new scopes from always jumping ahead of a retry.
 * @param {ScopeRow} scope */
function scopeAttemptTime(scope) {
  for (const value of [scope.last_attempt_at, scope.cursor_updated_at, scope.created_at]) {
    const time = Date.parse(String(value || ""));
    if (Number.isFinite(time)) return time;
  }
  return 0;
}

/** @param {ScopeRow} left @param {ScopeRow} right @param {ReceivedMode} mode */
function compareReceivedScopes(left, right, mode) {
  const attempted = scopeAttemptTime(left) - scopeAttemptTime(right);
  if (attempted !== 0) return attempted;
  const rank = numericScopeRank(left, mode === "hot" ? "hot_rank" : "discovery_rank") -
    numericScopeRank(right, mode === "hot" ? "hot_rank" : "discovery_rank");
  if (rank !== 0) return rank;
  return left.id.localeCompare(right.id);
}

/**
 * Fair traffic reserves alternating places for initialized and new scopes.
 * When either lane is empty, the other borrows every remaining place.
 * @param {ScopeRow[]} scopes
 */
function interleaveReceivedScopes(scopes) {
  const initialized = scopes.filter((scope) => scope.cursor !== null && scope.cursor !== undefined);
  const pending = scopes.filter((scope) => scope.cursor === null || scope.cursor === undefined);
  const result = [];
  for (let i = 0; i < Math.max(initialized.length, pending.length); i += 1) {
    if (i < initialized.length) result.push(initialized[i]);
    if (i < pending.length) result.push(pending[i]);
  }
  return result;
}

/**
 * @param {string} dbPath
 * @param {ReceivedMode} [mode]
 * @param {SyncRunnerDeps} [deps]
 * @returns {ScopeRow[]}
 */
function listReceivedScopes(dbPath, mode = "all", deps = defaultDeps) {
  const nowMs = Date.parse(deps.nowIso());
  if (!Number.isFinite(nowMs)) throw new Error("invalid received scheduling time");
  const cutoff = new Date(nowMs - HOT_SNAPSHOT_TTL_MS).toISOString();
  const modeWhere = mode === "hot" ? `
       AND julianday(json_extract(s.config_json, '$.hot_seen_at')) >= julianday(${deps.quoteSql(cutoff)})
       AND julianday(json_extract(s.config_json, '$.hot_seen_at')) <= julianday(${deps.quoteSql(new Date(nowMs).toISOString())})
       AND json_extract(s.config_json, '$.hot_rank') >= 0
       AND json_extract(s.config_json, '$.hot_rank') < ${HOT_POOL_SIZE}` : "";
  const rankKey = mode === "hot" ? "hot_rank" : "discovery_rank";
  const rows = deps.sqliteQuery(
    dbPath,
    `SELECT s.id, s.source_id, s.name, s.enabled, s.config_json, s.cursor_json,
       s.cursor_updated_at, s.created_at,
       (SELECT MAX(r.started_at) FROM sync_runs r WHERE r.scope_id = s.id) AS last_attempt_at
     FROM sync_scopes s
     JOIN sources src ON src.id = s.source_id AND src.enabled = 1
     WHERE s.source_id = ${deps.quoteSql(SOURCE_ID)}
       AND s.id LIKE 'lark.im.received.chat.%'
       AND s.enabled = 1
       ${modeWhere}
     ORDER BY COALESCE(last_attempt_at, s.cursor_updated_at, s.created_at),
       CAST(COALESCE(json_extract(s.config_json, '$.${rankKey}'), 999999999) AS INTEGER), s.id;`,
    "list received scopes",
  );
  const scopes = rows.map((row) => {
    const scope = /** @type {ScopeRow} */ (row);
    return {
      ...scope,
      config: scope.config_json ? JSON.parse(scope.config_json) : {},
      cursor: scope.cursor_json ? JSON.parse(scope.cursor_json) : null,
    };
  }).sort((left, right) => compareReceivedScopes(left, right, mode));
  if (mode !== "hot") return interleaveReceivedScopes(scopes);
  // Repeat the eligibility guard for injected stores and malformed rank values.
  return scopes.filter((scope) => {
    const seen = Date.parse(String(scope.config.hot_seen_at || ""));
    const rank = numericScopeRank(scope, "hot_rank");
    const successfulAt = Date.parse(String(scope.cursor_updated_at || ""));
    const boundary = Number(scope.cursor?.created_at_ms);
    const recentlyCaughtUp = successfulAt > nowMs - RECENT_SUCCESS_SKIP_MS &&
      successfulAt <= nowMs && Number.isFinite(boundary) && boundary >= nowMs - 2 * RECENT_SUCCESS_SKIP_MS;
    return Number.isFinite(seen) && seen <= nowMs && seen >= nowMs - HOT_SNAPSHOT_TTL_MS &&
      Number.isInteger(rank) && rank >= 0 && rank < HOT_POOL_SIZE && !recentlyCaughtUp;
  });
}

/**
 * @param {string} dbPath
 * @param {string} scopeId
 * @param {SyncOptions} opts
 * @param {(scope: ScopeRow, runId: number) => RunResult} worker
 * @param {SyncRunnerDeps} [deps]
 * @returns {RunResult}
 */
function syncScope(dbPath, scopeId, opts, worker, deps = defaultDeps) {
  const initialScope = /** @type {ScopeRow} */ (deps.readScope(dbPath, scopeId));
  if (!initialScope.enabled) return { scope_id: scopeId, skipped: true, reason: "scope_disabled" };
  if (initialScope.source_enabled === 0) return { scope_id: scopeId, skipped: true, reason: "source_disabled" };
  if (deps.isMaintenanceLocked(dbPath)) {
    return { scope_id: scopeId, skipped: true, reason: "maintenance_lock" };
  }
  if (!deps.acquireLock(dbPath, scopeId, opts.lockTtlSeconds)) {
    const reason = deps.isMaintenanceLocked(dbPath) ? "maintenance_lock" : "scope_locked";
    return { scope_id: scopeId, skipped: true, reason };
  }

  /** @type {RunResult | null} */
  let outcome = null;
  /** @type {Error | null} */
  let infrastructureError = null;
  /** @type {Error | null} */
  let releaseError = null;
  try {
    // Another contender may have advanced or disabled the scope while this
    // process waited for the lock. Only the post-lock snapshot is authoritative.
    const scope = /** @type {ScopeRow} */ (deps.readScope(dbPath, scopeId));
    if (!scope.enabled) {
      outcome = { scope_id: scopeId, skipped: true, reason: "scope_disabled" };
    } else if (scope.source_enabled === 0) {
      outcome = { scope_id: scopeId, skipped: true, reason: "source_disabled" };
    } else {
      const runId = deps.createRun(dbPath, scope);
      try {
        const result = worker(scope, runId);
        outcome = { scope_id: scopeId, run_id: runId, ...result };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        let failError = null;
        try {
          const failed = deps.failRun(dbPath, scope, runId, err);
          if (failed === false) failError = new Error("run failure update was rejected by the active run fence");
        } catch (failure) {
          failError = failure instanceof Error ? failure : new Error(String(failure));
        }
        outcome = {
          scope_id: scopeId,
          run_id: runId,
          ok: false,
          error: failError ? `${err.message}; additionally failed to persist run failure: ${failError.message}` : err.message,
          ...(failError ? { fail_run_error: failError.message } : {}),
        };
      }
    }
  } catch (error) {
    infrastructureError = error instanceof Error ? error : new Error(String(error));
  } finally {
    try {
      deps.releaseLock(dbPath, scopeId);
    } catch (error) {
      releaseError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (infrastructureError) {
    if (releaseError) {
      throw new AggregateError(
        [infrastructureError, releaseError],
        `${infrastructureError.message}; additionally failed to release scope lock: ${releaseError.message}`,
      );
    }
    throw infrastructureError;
  }
  if (releaseError) {
    const message = `scope lock release failed after run completion: ${releaseError.message}`;
    return {
      ...(outcome || { scope_id: scopeId }),
      ok: false,
      error: outcome?.error ? `${outcome.error}; ${message}` : message,
      lock_release_error: releaseError.message,
    };
  }
  return outcome || { scope_id: scopeId, ok: false, error: "scope sync produced no result" };
}

/**
 * Every non-record success path must use the same run/lock/cursor fence as the
 * ingestion store. The assertion row deliberately violates a CHECK constraint
 * when the fence is absent so `.bail on` rolls the whole transaction back
 * before scope discovery/disable mutations can commit.
 *
 * @param {ScopeRow} scope
 * @param {number} runId
 * @param {string} finishedAtIso
 * @param {SyncRunnerDeps} deps
 */
function runFenceGuardSql(scope, runId, finishedAtIso, deps) {
  return deps.runFenceGuardSql(scope, runId, finishedAtIso, {
    guardTable: "__lark_run_fence_guard", assert: true,
  });
}

/** Retry one scope's durable debt without any list fetch or list-cursor rewind.
 * The list transaction has already committed before this separate run starts.
 * @param {string} dbPath @param {SyncOptions} opts @param {ScopeRow} scope
 * @param {SelfProfile} selfProfile @param {SyncRunnerDeps} deps
 * @param {number} [limit] @param {number} [deadline]
 * @returns {RunResult}
 */
function retryScopeDetails(dbPath, opts, scope, selfProfile, deps, limit = 5,
  deadline = deps.nowMs() + Math.min(30_000, opts.detailBudgetMs ?? 30_000)) {
  if (deps.nowMs() >= deadline) return { ok: false, skipped: true, reason: "detail_budget_exhausted", detail_attempts: 0 };
  const due = deps.readPendingLarkDetails(dbPath, scope, { limit, now: deps.nowIso() });
  if (!due.length) return { ok: false, skipped: true, reason: "details_not_due", detail_attempts: 0 };
  return syncScope(dbPath, scope.id, opts, (lockedScope, runId) => {
    const tasks = deps.readPendingLarkDetails(dbPath, lockedScope, { limit, now: deps.nowIso() });
    const outcomes = [];
    for (const task of tasks) {
      const remaining = Math.floor(deadline - deps.nowMs());
      if (remaining <= 0) break;
      try {
        const message = deps.fetchMessageDetails(task.raw_root, {
          retries: opts.retries, retryDelayMs: opts.retryDelayMs,
          detailBudgetMs: Math.min(30_000, remaining),
          detailMaxPages: opts.detailMaxPages, detailMaxItems: opts.detailMaxItems,
        });
        const direction = senderId(message) === selfProfile.open_id ? "sent" : "received";
        const nameBudgetMs = Math.max(0, Math.min(5000, Math.floor(deadline - deps.nowMs())));
        const context = nameBudgetMs > 0 ? deps.buildPeopleContext([message], {
          retries: opts.retries, retryDelayMs: opts.retryDelayMs,
          nameLookupDeadlineMs: Date.now() + nameBudgetMs,
        }, selfProfile, lockedScope.config || {}) : { self: selfProfile };
        // A completed detail must not introduce a guessed application identity.
        if ('app_fallbacks' in context) context.app_fallbacks = new Map(
          [...context.app_fallbacks].filter(([, value]) => value.source === 'chat_bot_app_id' && value.confidence === 'high'));
        const record = recordFromMessage(message, lockedScope.id, direction, context, lockedScope.config || {});
        outcomes.push({ message_id: task.message_id, fingerprint: task.fingerprint, record });
      } catch (error) {
        const reason = error && typeof error === "object" && "detailReason" in error
          ? String(error.detailReason) : "invalid_or_unavailable_details";
        const safeReason = /^[a-z_]{1,80}$/.test(reason) ? reason : "invalid_or_unavailable_details";
        const failure = new Error(`message detail retry failed: kind=${safeReason}`);
        failure.name = "MessageDetailError";
        outcomes.push({ message_id: task.message_id, fingerprint: task.fingerprint, error: failure });
      }
    }
    if (!outcomes.length) throw new Error("detail retry budget exhausted before a task could be attempted");
    const complete = outcomes.filter((outcome) => outcome.record);
    const reused = deps.reuseKnownSenderNames(dbPath,
      bindCurrentSenderNames(complete.map((outcome) => /** @type {import('./message-record.mjs').LocalRecord} */ (outcome.record)), selfProfile), selfProfile,
      Math.max(0, Math.floor(deadline - deps.nowMs())));
    for (let index = 0; index < complete.length; index += 1) complete[index].record = reused[index];
    const effects = deps.finishLarkDetailRun(dbPath, lockedScope, runId, outcomes, {
      adapter: "lark.im.details", detail_attempts: outcomes.length,
    });
    return { ok: effects.pending_details === 0, details_complete: effects.pending_details === 0,
      incomplete: effects.pending_details > 0, detail_attempts: outcomes.length,
      ...(effects.pending_details > 0 ? { error: "message details remain pending and retryable" } : {}),
      records: outcomes.filter((outcome) => "record" in outcome).length, ...effects };
  }, deps);
}

/** List coverage and complete content have separate durable checkpoints.
 * A detail failure can never enter the list-window bisection path.
 * @param {string} dbPath @param {SyncOptions} opts @param {string} scopeId
 * @param {SelfProfile} selfProfile @param {"sent" | "received"} direction
 * @param {SyncRunnerDeps} deps @returns {RunResult}
 */
function syncListedScope(dbPath, opts, scopeId, selfProfile, direction, deps) {
  const listed = syncScope(dbPath, scopeId, opts, (scope, runId) => {
    const progress = deps.readLarkListProgress(dbPath, scope);
    const listScope = { ...scope, cursor: progress?.cursor ?? scope.cursor };
    const { startMs, endMs: targetEndMs } = messageWindow(listScope, opts);
    let fetched;
    try {
      if (direction === "received" && !scope.config?.chat_id) throw new Error("received scope is missing chat identity");
      fetched = fetchMessageWindowWithBisection((start, end) => direction === "sent"
        ? deps.fetchSentMessageList(selfProfile.open_id, start, end, opts)
        : deps.fetchChatMessageList(scope.config?.chat_id, start, end, opts), startMs, targetEndMs);
    } catch (error) {
      const unsupported = direction === "received"
        ? deps.isRestrictedModeError(error) ? "restricted_mode"
          : deps.isBotUserOutOfChatError(error) ? "bot_user_out_of_chat" : null
        : null;
      if (unsupported) {
        succeedUnsupportedRun(dbPath, scope, runId, error, unsupported, deps);
        return { ok: true, skipped: true, reason: unsupported, scanned: 0, records: 0,
          inserted: 0, updated: 0, duplicate: 0 };
      }
      throw error;
    }
    const endMs = Number(fetched.window_end_ms);
    const context = deps.buildPeopleContext(fetched.messages, opts, selfProfile, scope.config || {});
    const prepared = direction === "sent"
      ? prepareRecords(fetched.messages, scope.id, "sent", listScope.cursor, opts.startMs, endMs,
        null, context, scope.config || {})
      : prepareChatWindowRecords(fetched.messages, scope.id, listScope.cursor, opts.startMs, endMs,
        selfProfile.open_id, context, scope.config || {});
    const records = deps.reuseKnownSenderNames(dbPath, bindCurrentSenderNames(prepared, selfProfile), selfProfile);
    const roots = fetched.detailRoots || [];
    const scanned = fetched.messages.length + roots.length;
    const effects = deps.commitLarkListRun(dbPath, scope, runId, records, roots, scanned, cursorAfter(endMs), {
      adapter: direction === "sent" ? "lark.im.sent_by_me" : "lark.im.received_per_chat",
      pages: fetched.pages, initial_sync_start_ms: opts.startMs,
      list_window_start_ms: startMs, list_window_end_ms: endMs,
      list_window_start: localIsoFromMs(startMs), list_window_end: localIsoFromMs(endMs),
      list_window_bisections: fetched.window_bisections,
      requested_window_end: localIsoFromMs(opts.endMs), bounded_window_target: localIsoFromMs(targetEndMs),
      stable_horizon_seconds: opts.endExplicit ? 0 : opts.stableHorizonSeconds,
      fetched_count: scanned, stored_candidate_count: records.length,
    });
    const pending = Number(effects.pending_details || 0);
    return { ok: pending === 0, list_complete: true, details_complete: pending === 0,
      ...(pending > 0 ? { incomplete: true, error: "list saved; message details remain pending and retryable" } : {}),
      scanned, records: records.length, ...effects };
  }, deps);
  if (!listed.list_complete || !listed.pending_details) return listed;
  // Up to five due roots share the existing 30-second automatic retry budget.
  // Failures retain backoff; explicit details-only work has its own batch limit.
  const retry = retryScopeDetails(dbPath, opts, deps.readScope(dbPath, scopeId), selfProfile, deps);
  const pending = retry.pending_details ?? listed.pending_details;
  return { ...listed, ok: pending === 0, details_complete: pending === 0, incomplete: pending > 0,
    error: pending > 0 ? "list saved; message details remain pending and retryable" : undefined,
    pending_details: pending, detail_retry: retry,
    inserted: Number(listed.inserted || 0) + Number(retry.inserted || 0),
    updated: Number(listed.updated || 0) + Number(retry.updated || 0),
    duplicate: Number(listed.duplicate || 0) + Number(retry.duplicate || 0),
    ...(Number(listed.conflicts || 0) + Number(retry.conflicts || 0) > 0
      ? { conflicts: Number(listed.conflicts || 0) + Number(retry.conflicts || 0) } : {}),
    records: Number(listed.records || 0) + Number(retry.records || 0) };
}

/** @param {string} dbPath @param {SyncOptions} opts @param {SelfProfile} selfProfile
 * @param {SyncRunnerDeps} [deps] @returns {RunResult} */
function syncSent(dbPath, opts, selfProfile, deps = defaultDeps) {
  return syncListedScope(dbPath, opts, SENT_SCOPE_ID, selfProfile, "sent", deps);
}

/** Explicit bounded entry point; honors durable retry_at rather than bypassing backoff.
 * @param {string} dbPath @param {SyncOptions} opts @param {SelfProfile} selfProfile
 * @param {SyncRunnerDeps} [deps] @returns {RunResult[]} */
function retryDetails(dbPath, opts, selfProfile, deps = defaultDeps) {
  const limit = Math.min(20, opts.detailLimit ?? 5);
  const now = deps.nowIso();
  const scanLimit = Math.max(limit * 3, limit + 20);
  const scopeFilter = opts.detailScope ? `AND s.id = ${deps.quoteSql(opts.detailScope)}` : "";
  const scopes = deps.sqliteQuery(dbPath, `SELECT s.id, MIN(d.retry_at) AS due_at
    FROM sync_scopes s JOIN sources src ON src.id=s.source_id AND src.enabled=1
      JOIN lark_im_detail_tasks d ON d.scope_id=s.id
    WHERE s.source_id='lark.im' AND s.enabled=1 AND d.status='pending'
      AND d.retry_at <= ${deps.quoteSql(now)} ${scopeFilter}
    GROUP BY s.id ORDER BY due_at, s.id LIMIT ${scanLimit};`, "list due detail scopes");
  const deadline = deps.nowMs() + Math.min(30_000, opts.detailBudgetMs ?? 30_000);
  const results = [];
  let remaining = limit;
  for (const row of scopes) {
    if (remaining <= 0 || deps.nowMs() >= deadline) break;
    const result = retryScopeDetails(dbPath, opts, deps.readScope(dbPath, row.id), selfProfile, deps, remaining, deadline);
    results.push(result);
    remaining -= Number(result.detail_attempts || 0);
    if (result.skipped && result.reason === "maintenance_lock") break;
  }
  const outstanding = deps.sqliteQuery(dbPath, `SELECT COUNT(*) AS count
    FROM sync_scopes s JOIN sources src ON src.id=s.source_id AND src.enabled=1
      JOIN lark_im_detail_tasks d ON d.scope_id=s.id
    WHERE s.source_id='lark.im' AND s.enabled=1 AND d.status='pending' ${scopeFilter};`, "count remaining detail debt")[0];
  if (Number(outstanding?.count || 0) > 0) {
    results.push({ ok: false, incomplete: true, reason: "details_pending",
      pending_details: Number(outstanding.count), detail_attempts: 0 });
  }
  return results;
}

/**
 * @param {JsonObject[]} messages
 * @param {string} scopeId
 * @param {JsonObject | null | undefined} cursor
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} selfOpenId
 * @param {JsonObject} peopleContext
 * @param {JsonObject} scopeConfig
 */
function prepareChatWindowRecords(
  messages,
  scopeId,
  cursor,
  startMs,
  endMs,
  selfOpenId,
  peopleContext,
  scopeConfig,
) {
  const selfHash = hash(selfOpenId);
  // Direction is a record projection; raw payload, canonical names and hash
  // are independent of it. Normalize each message only once before classifying.
  const records = prepareRecords(messages, scopeId, "received", cursor, startMs, endMs,
    null, /** @type {any} */ (peopleContext), scopeConfig);
  for (const record of records) {
    if (hash(record.actor_id || "") === selfHash) record.direction = "sent";
  }
  // Preserve the old received-then-sent tie order: same-version duplicate
  // writes select the last candidate, even if a source repeats an identity.
  return records.sort((a, b) => a.occurred_at_ms - b.occurred_at_ms || a.external_id.localeCompare(b.external_id)
    || Number(a.direction === "sent") - Number(b.direction === "sent"));
}

/** @param {unknown} value @param {string} label */
function assertValidDiscoveryPage(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const page = /** @type {JsonObject} */ (value);
  if (!Array.isArray(page.chats)) throw new Error(`${label} is missing a chats array`);
  if (typeof page.has_more !== "boolean") throw new Error(`${label} is missing a boolean has_more`);
  if (typeof page.page_token !== "string") throw new Error(`${label} has a non-string page_token`);
  page.chats.forEach((chat, index) => {
    if (!chat || typeof chat !== "object" || Array.isArray(chat)) {
      throw new Error(`${label} chat at index ${index} must be an object`);
    }
    if (typeof chat.chat_id !== "string" || !chat.chat_id.trim()) {
      throw new Error(`${label} chat at index ${index} is missing a valid chat_id`);
    }
  });
  return page;
}

/**
 * @param {ScopeRow} scope
 * @param {SyncOptions} opts
 * @param {SyncRunnerDeps} [deps]
 * @returns {DiscoveryResult}
 */
function discoverChatPages(scope, opts, deps = defaultDeps) {
  /** @type {JsonObject[]} */
  const chats = [];
  const seen = new Set();
  const cursor = scope.cursor || {};
  const activeCursor =
    cursor.kind === "chat_discovery_cursor/v1" && cursor.has_more === true;
  const snapshotId = activeCursor
    ? String(cursor.snapshot_id)
    : deps.makeSnapshotId("snapshot");
  const snapshotStartedAt = activeCursor ? String(cursor.snapshot_started_at) : deps.nowIso();
  let pageToken = activeCursor ? String(cursor.page_token || "") : "";
  let hasMore = false;
  let processedPages = 0;
  const previousPages = activeCursor ? Number(scope.cursor?.pages_scanned || 0) : 0;
  for (let pageIndex = 0; pageIndex < opts.discoveryPagesPerRun; pageIndex += 1) {
    const page = assertValidDiscoveryPage(
      deps.fetchChatDiscoveryPage(opts, pageToken),
      `chat discovery page ${processedPages + 1}`,
    );
    processedPages += 1;
    const rankBase = (previousPages + processedPages - 1) * opts.chatPageSize;
    for (const [chatIndex, chat] of page.chats.entries()) {
      if (seen.has(chat.chat_id)) continue;
      seen.add(chat.chat_id);
      chats.push({ ...chat, discovery_rank: rankBase + chatIndex });
    }
    hasMore = page.has_more;
    pageToken = page.page_token;
    if (hasMore && !pageToken) throw new Error("chat-list returned has_more without page_token");
    if (!hasMore) break;
  }
  const pagesScannedTotal = previousPages + processedPages;
  if (hasMore && pagesScannedTotal >= opts.maxChatPages) {
    throw new Error(`chat discovery still has more data after ${opts.maxChatPages} pages`);
  }
  return {
    snapshot_id: snapshotId,
    snapshot_started_at: snapshotStartedAt,
    chats,
    pages: processedPages,
    pages_scanned_total: pagesScannedTotal,
    has_more: hasMore,
    page_token: hasMore ? pageToken : "",
  };
}

/**
 * @param {SyncOptions} opts
 * @param {SyncRunnerDeps} [deps]
 * @returns {DiscoveryResult}
 */
function discoverHotChatPages(opts, deps = defaultDeps) {
  /** @type {JsonObject[]} */
  const chats = [];
  const seen = new Set();
  let pageToken = "";
  let hasMore = false;
  let processedPages = 0;
  const hotSeenAt = deps.nowIso();
  for (let pageIndex = 0; pageIndex < opts.discoveryPagesPerRun; pageIndex += 1) {
    const page = assertValidDiscoveryPage(
      deps.fetchChatDiscoveryPage(opts, pageToken),
      `hot chat discovery page ${processedPages + 1}`,
    );
    processedPages += 1;
    const rankBase = pageIndex * opts.chatPageSize;
    for (const [chatIndex, chat] of page.chats.entries()) {
      if (seen.has(chat.chat_id)) continue;
      seen.add(chat.chat_id);
      chats.push({ ...chat, hot_rank: rankBase + chatIndex, hot_seen_at: hotSeenAt });
    }
    hasMore = page.has_more;
    pageToken = page.page_token;
    if (hasMore && !pageToken) throw new Error("chat-list returned has_more without page_token");
    if (!hasMore) break;
  }
  return {
    snapshot_id: deps.makeSnapshotId("hot"),
    snapshot_started_at: hotSeenAt,
    chats,
    pages: processedPages,
    pages_scanned_total: processedPages,
    has_more: hasMore,
    page_token: "",
    hot: true,
  };
}

/**
 * @param {ScopeRow} scope
 * @param {SyncOptions} opts
 */
function shouldSkipCompletedDiscovery(scope, opts) {
  return (
    opts.discoveryMode === "cursor" &&
    scope.cursor?.kind === "chat_discovery_cursor/v1" &&
    scope.cursor?.has_more === false
  );
}

/**
 * @param {ScopeRow} scope
 * @param {SyncOptions} opts
 */
function shouldSkipReconcile(scope, opts) {
  if (opts.discoveryMode !== "reconcile") return false;
  if (scope.cursor?.kind === "chat_discovery_cursor/v1" && scope.cursor?.has_more === true) {
    return false;
  }
  if (!scope.cursor) return false;
  const lastCompletedMs = Date.parse(
    scope.cursor.completed_at || scope.cursor.updated_at || scope.cursor.snapshot_started_at || "",
  );
  if (!Number.isFinite(lastCompletedMs)) return false;
  const dueBeforeMs = opts.endMs - opts.reconcileIntervalHours * 60 * 60 * 1000;
  return lastCompletedMs > dueBeforeMs;
}

/**
 * @param {string} dbPath
 * @param {SyncOptions} opts
 * @param {SyncRunnerDeps} [deps]
 * @returns {RunResult}
 */
function syncDiscovery(dbPath, opts, deps = defaultDeps) {
  const scopeId =
    opts.discoveryMode === "hot"
      ? CHAT_HOT_DISCOVERY_SCOPE_ID
      : opts.discoveryMode === "reconcile"
        ? CHAT_RECONCILE_SCOPE_ID
        : CHAT_DISCOVERY_SCOPE_ID;
  const currentScope = /** @type {ScopeRow} */ (deps.readScope(dbPath, scopeId));
  if (shouldSkipReconcile(currentScope, opts)) {
    const cursor = currentScope.cursor || {};
    return {
      run_id: null,
      scope_id: scopeId,
      ok: true,
      mode: opts.discoveryMode,
      discovered_in_run: 0,
      pages: 0,
      has_more: false,
      snapshot_id: cursor.snapshot_id,
      skipped: true,
      reason: "not_due",
    };
  }
  return syncScope(dbPath, scopeId, opts, (scope, runId) => {
    if (shouldSkipCompletedDiscovery(scope, opts)) {
      const now = deps.nowIso();
      const cursor = scope.cursor || {};
      deps.sqliteExec(
        dbPath,
        `
BEGIN;
${runFenceGuardSql(scope, runId, now, deps)}
UPDATE sync_runs
SET status = 'succeeded',
    cursor_after_json = ${deps.sqlJson(cursor)},
    finished_at = ${deps.quoteSql(now)},
    scanned_count = 0,
    inserted_count = 0,
    updated_count = 0,
    duplicate_count = 0,
    metadata_json = ${deps.sqlJson({
      adapter: "lark.im.unmuted_chat_discovery",
      discovery_mode: opts.discoveryMode,
      pages: 0,
      discovered_in_run: 0,
      snapshot_id: cursor.snapshot_id,
      has_more: false,
      skipped_reason: "already_complete",
    })}
WHERE id = ${Number(runId)}
  AND EXISTS (SELECT 1 FROM __lark_run_fence_guard);
COMMIT;
`,
        `skip completed discovery run ${runId}`,
      );
      return {
        ok: true,
        mode: opts.discoveryMode,
        discovered_in_run: 0,
        pages: 0,
        has_more: false,
        snapshot_id: cursor.snapshot_id,
        skipped: true,
      };
    }
    const discovered = opts.discoveryMode === "hot" ? discoverHotChatPages(opts, deps) : discoverChatPages(scope, opts, deps);
    const now = deps.nowIso();
    const fullSnapshotField =
      opts.discoveryMode === "reconcile" ? "last_reconcile_snapshot_id" : "last_discovered_snapshot_id";
    const fullAdapter =
      opts.discoveryMode === "reconcile" ? "lark.im.unmuted_chat_reconcile" : "lark.im.unmuted_chat_discovery";
    const upserts = discovered.chats
      .map((chat) => {
        const id = chatScopeId(chat.chat_id);
        const config = discovered.hot
          ? {
              chat_id: chat.chat_id,
              chat_type: chat.chat_type,
              chat_name: chat.chat_name,
              hot_rank: chat.hot_rank,
              hot_seen_at: chat.hot_seen_at,
              last_hot_snapshot_id: discovered.snapshot_id,
            }
          : {
              chat_id: chat.chat_id,
              chat_type: chat.chat_type,
              chat_name: chat.chat_name,
              discovery_rank: chat.discovery_rank,
              [fullSnapshotField]: discovered.snapshot_id,
            };
        return `
INSERT INTO sync_scopes (id, source_id, name, description, enabled, config_json, updated_at)
VALUES (
  ${deps.quoteSql(id)},
  ${deps.quoteSql(SOURCE_ID)},
  ${deps.quoteSql(`received.chat.${shortHash(chat.chat_id)}`)},
  'Messages received in one non-muted Lark chat.',
  1,
  ${deps.sqlJson(config)},
  ${deps.quoteSql(now)}
)
ON CONFLICT(id) DO UPDATE SET
  enabled = CASE
    WHEN json_extract(sync_scopes.config_json, '$.unsupported_reason') IS NOT NULL THEN sync_scopes.enabled
    ELSE 1
  END,
  config_json = json_patch(sync_scopes.config_json, excluded.config_json),
  updated_at = excluded.updated_at;
`;
      })
      .join("\n");
    const disableSql =
      !discovered.hot && !discovered.has_more
        ? `
UPDATE sync_scopes
SET enabled = 0,
    updated_at = ${deps.quoteSql(now)}
WHERE source_id = ${deps.quoteSql(SOURCE_ID)}
  AND id LIKE 'lark.im.received.chat.%'
  AND COALESCE(json_extract(config_json, '$.${fullSnapshotField}'), '') <> ${deps.quoteSql(
    discovered.snapshot_id,
  )};
`
        : "";
    const clearStaleHotSql = discovered.hot
      ? `
UPDATE sync_scopes
SET config_json = json_remove(
      config_json,
      '$.hot_rank',
      '$.hot_seen_at',
      '$.last_hot_snapshot_id'
    ),
    updated_at = ${deps.quoteSql(now)}
WHERE source_id = ${deps.quoteSql(SOURCE_ID)}
  AND id LIKE 'lark.im.received.chat.%'
  AND json_extract(config_json, '$.hot_seen_at') IS NOT NULL
  AND COALESCE(json_extract(config_json, '$.last_hot_snapshot_id'), '') <> ${deps.quoteSql(
    discovered.snapshot_id,
  )};
`
      : "";
    const cursor = discovered.hot
      ? scope.cursor || null
      : discovered.has_more
      ? {
          kind: "chat_discovery_cursor/v1",
          snapshot_id: discovered.snapshot_id,
          snapshot_started_at: discovered.snapshot_started_at,
          page_token: discovered.page_token,
          pages_scanned: discovered.pages_scanned_total,
          has_more: true,
          updated_at: now,
        }
      : {
          kind: "chat_discovery_cursor/v1",
          snapshot_id: discovered.snapshot_id,
          snapshot_started_at: discovered.snapshot_started_at,
          completed_at: now,
          pages_scanned: discovered.pages_scanned_total,
          has_more: false,
        };
    deps.sqliteExec(
      dbPath,
      `
BEGIN;
${runFenceGuardSql(scope, runId, now, deps)}
${confirmInitialLarkAccountSql(now)}
${upserts}
${clearStaleHotSql}
${disableSql}
UPDATE sync_runs
SET status = 'succeeded',
    cursor_after_json = ${deps.sqlJson(cursor)},
    finished_at = ${deps.quoteSql(now)},
    scanned_count = ${Number(discovered.chats.length)},
    inserted_count = 0,
    updated_count = 0,
    duplicate_count = 0,
      metadata_json = ${deps.sqlJson({
      adapter: discovered.hot ? "lark.im.hot_chat_discovery" : fullAdapter,
      discovery_mode: opts.discoveryMode,
      pages: discovered.pages,
      pages_scanned_total: discovered.pages_scanned_total,
      chat_types: opts.chatTypes,
      discovered_in_run: discovered.chats.length,
      snapshot_id: discovered.snapshot_id,
      has_more: discovered.has_more,
    })}
WHERE id = ${Number(runId)}
  AND EXISTS (SELECT 1 FROM __lark_run_fence_guard);
UPDATE sync_scopes
SET cursor_json = ${deps.sqlJson(cursor)},
    cursor_updated_at = ${deps.quoteSql(now)},
    last_success_run_id = ${Number(runId)},
    updated_at = ${deps.quoteSql(now)}
WHERE id = ${deps.quoteSql(scope.id)}
  AND EXISTS (SELECT 1 FROM __lark_run_fence_guard);
COMMIT;
`,
      `succeed discovery run ${runId}`,
    );
    return {
      ok: true,
      mode: opts.discoveryMode,
      discovered_in_run: discovered.chats.length,
      pages: discovered.pages,
      has_more: discovered.has_more,
      snapshot_id: discovered.snapshot_id,
    };
  }, deps);
}

/**
 * @param {string} dbPath
 * @param {ScopeRow} scope
 * @param {number} runId
 * @param {unknown} error
 * @param {string} reason
 * @param {SyncRunnerDeps} [deps]
 */
function succeedUnsupportedRun(dbPath, scope, runId, error, reason, deps = defaultDeps) {
  const now = deps.nowIso();
  const config = {
    unsupported_reason: reason,
    unsupported_at: now,
    unsupported_error: `${reason} (remote details redacted)`,
    ...(reason === "bot_user_out_of_chat"
      ? {
          lark_cli_error_code: 230002,
          lark_cli_error_message: "Bot/User can NOT be out of the chat.",
        }
      : {}),
  };
  deps.sqliteExec(
    dbPath,
    `
BEGIN;
${runFenceGuardSql(scope, runId, now, deps)}
UPDATE sync_runs
SET status = 'succeeded',
    finished_at = ${deps.quoteSql(now)},
    scanned_count = 0,
    inserted_count = 0,
    updated_count = 0,
    duplicate_count = 0,
    metadata_json = ${deps.sqlJson({
      adapter: "lark.im.received_per_chat",
      skipped: true,
      skip_reason: reason,
    })}
WHERE id = ${Number(runId)}
  AND EXISTS (SELECT 1 FROM __lark_run_fence_guard);
UPDATE sync_scopes
SET enabled = 0,
    config_json = json_patch(config_json, ${deps.sqlJson(config)}),
    last_success_run_id = ${Number(runId)},
    updated_at = ${deps.quoteSql(now)}
WHERE id = ${deps.quoteSql(scope.id)}
  AND EXISTS (SELECT 1 FROM __lark_run_fence_guard);
COMMIT;
`,
    `succeed unsupported run ${runId}`,
  );
}

/**
 * @param {string} dbPath
 * @param {SyncOptions} opts
 * @param {ScopeRow} scope
 * @param {SelfProfile} selfProfile
 * @param {SyncRunnerDeps} [deps]
 * @returns {RunResult}
 */
function syncReceivedScope(dbPath, opts, scope, selfProfile, deps = defaultDeps) {
  return syncListedScope(dbPath, opts, scope.id, selfProfile, "received", deps);
}

/**
 * @param {string} dbPath
 * @param {SyncOptions} opts
 * @param {SelfProfile} selfProfile
 * @param {SyncRunnerDeps} [deps]
 * @returns {RunResult[]}
 */
function syncReceived(dbPath, opts, selfProfile, deps = defaultDeps) {
  const allScopes = listReceivedScopes(dbPath, opts.receivedMode, deps);
  const limit = opts.receivedScopesPerRun > 0 ? opts.receivedScopesPerRun : allScopes.length;
  // Refill a locked place from the same lane, preserving the split in actual
  // started work. Each lane has a finite inspection budget; unused places may
  // be borrowed after its candidates are exhausted or unavailable.
  const queues = opts.receivedMode === "hot" ? [allScopes] : [
    allScopes.filter((scope) => scope.cursor !== null && scope.cursor !== undefined),
    allScopes.filter((scope) => scope.cursor === null || scope.cursor === undefined),
  ];
  const indices = queues.map(() => 0);
  const laneAttempts = queues.map(() => 0);
  // Persisted attempts choose the first/spare place even for batches of one.
  // Keep this tie preference for the whole batch so locked places refill from
  // their own lane before unused capacity is borrowed.
  const firstLane = queues.length === 2 && queues[0].length && queues[1].length &&
    scopeAttemptTime(queues[1][0]) < scopeAttemptTime(queues[0][0]) ? 1 : 0;
  const scanLimit = Math.max(limit * 3, limit + 20);
  /** @type {RunResult[]} */
  const results = [];
  let attempted = 0;
  while (attempted < limit) {
    const available = queues.map((_, lane) => lane).filter((lane) =>
      indices[lane] < queues[lane].length && indices[lane] < scanLimit);
    if (!available.length) break;
    const lane = available.sort((a, b) => laneAttempts[a] - laneAttempts[b] ||
      (firstLane === 0 ? a - b : b - a))[0];
    const scope = queues[lane][indices[lane]++];
    const result = syncReceivedScope(dbPath, opts, scope, selfProfile, deps);
    results.push(result);
    if (!result.skipped || result.run_id !== undefined && result.run_id !== null) {
      attempted += 1;
      laneAttempts[lane] += 1;
    }
    if (result.skipped && result.reason === "maintenance_lock") break;
    // Transport retries are exhausted; leave the remaining scopes for a later run.
    if (
      result.ok === false &&
      typeof result.error === "string" &&
      isExhaustedLarkTransportFailure(result.error)
    ) break;
  }
  return results;
}

/**
 * Create a sync runner bound to a concrete adapter/store dependency set.
 *
 * Production uses the default Lark CLI and SQLite dependencies. Tests can pass
 * fake dependencies to exercise runner behavior without touching Lark or disk.
 *
 * @param {Partial<SyncRunnerDeps>} [deps]
 * @returns {SyncRunner}
 */
function createSyncRunner(deps = {}) {
  const resolvedDeps = resolveDeps(deps);
  return {
    listReceivedScopes: (dbPath, mode = "all") => listReceivedScopes(dbPath, mode, resolvedDeps),
    syncScope: (dbPath, scopeId, opts, worker) => syncScope(dbPath, scopeId, opts, worker, resolvedDeps),
    syncSent: (dbPath, opts, selfProfile) => syncSent(dbPath, opts, selfProfile, resolvedDeps),
    prepareChatWindowRecords,
    discoverChatPages: (scope, opts) => discoverChatPages(scope, opts, resolvedDeps),
    discoverHotChatPages: (opts) => discoverHotChatPages(opts, resolvedDeps),
    shouldSkipCompletedDiscovery,
    shouldSkipReconcile,
    syncDiscovery: (dbPath, opts) => syncDiscovery(dbPath, opts, resolvedDeps),
    succeedUnsupportedRun: (dbPath, scope, runId, error, reason) =>
      succeedUnsupportedRun(dbPath, scope, runId, error, reason, resolvedDeps),
    syncReceivedScope: (dbPath, opts, scope, selfProfile) =>
      syncReceivedScope(dbPath, opts, scope, selfProfile, resolvedDeps),
    syncReceived: (dbPath, opts, selfProfile) => syncReceived(dbPath, opts, selfProfile, resolvedDeps),
    retryDetails: (dbPath, opts, selfProfile) => retryDetails(dbPath, opts, selfProfile, resolvedDeps),
  };
}

export {
  compareReceivedScopes,
  interleaveReceivedScopes,
  createSyncRunner,
  discoverChatPages,
  discoverHotChatPages,
  listReceivedScopes,
  prepareChatWindowRecords,
  shouldSkipCompletedDiscovery,
  shouldSkipReconcile,
  succeedUnsupportedRun,
  syncDiscovery,
  syncReceived,
  syncReceivedScope,
  syncScope,
  syncSent,
  retryDetails,
};
