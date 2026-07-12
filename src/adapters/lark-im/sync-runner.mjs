// @ts-check

import {
  buildPeopleContext,
  fetchChatDiscoveryPage,
  fetchChatMessages,
  fetchSentMessages,
  isBotUserOutOfChatError,
  isRestrictedModeError,
} from "./adapter.mjs";
import {
  acquireLock,
  createRun,
  failRun,
  isMaintenanceLocked,
  quoteSql,
  readScope,
  releaseLock,
  sqlJson,
  sqliteExec,
  sqliteQuery,
  succeedMessageRun,
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
  shortHash,
} from "./core.mjs";

const RUN_FENCE_HARD_LEASE_SECONDS = 20 * 60;

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
 *
 * @typedef {JsonObject & {
 *   id: string,
 *   source_id: string,
 *   enabled?: number,
 *   config?: JsonObject,
 *   cursor?: JsonObject | null,
 *   cursor_json?: string | null
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
 * @typedef {Record<string, any>} SyncRunnerDeps
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
 */

/** @type {SyncRunnerDeps} */
const defaultDeps = {
  acquireLock,
  buildPeopleContext,
  createRun,
  failRun,
  fetchChatDiscoveryPage,
  fetchChatMessages,
  fetchSentMessages,
  isMaintenanceLocked,
  isBotUserOutOfChatError,
  isRestrictedModeError,
  makeSnapshotId: (prefix = "snapshot") => `${prefix}_${Date.now()}_${shortHash(`${process.pid}:${Math.random()}`)}`,
  nowIso: () => new Date().toISOString(),
  quoteSql,
  readScope,
  releaseLock,
  sqlJson,
  sqliteExec,
  sqliteQuery,
  succeedMessageRun,
};

/**
 * @param {Partial<SyncRunnerDeps>} [deps]
 * @returns {SyncRunnerDeps}
 */
function resolveDeps(deps = {}) {
  return { ...defaultDeps, ...deps };
}

/** @param {ScopeRow} scope @param {string} key */
function numericScopeRank(scope, key) {
  const value = Number(scope.config?.[key]);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** @param {ScopeRow} left @param {ScopeRow} right @param {ReceivedMode} mode */
function compareReceivedScopes(left, right, mode) {
  if (mode === "hot") {
    const rank = numericScopeRank(left, "hot_rank") - numericScopeRank(right, "hot_rank");
    if (rank !== 0) return rank;
  } else {
    const leftHasCursor = left.cursor !== null && left.cursor !== undefined;
    const rightHasCursor = right.cursor !== null && right.cursor !== undefined;
    if (leftHasCursor !== rightHasCursor) return leftHasCursor ? 1 : -1;
    if (!leftHasCursor) {
      const rank = numericScopeRank(left, "discovery_rank") - numericScopeRank(right, "discovery_rank");
      if (rank !== 0) return rank;
    }
  }
  const updated = String(left.cursor_updated_at || "").localeCompare(String(right.cursor_updated_at || ""));
  if (updated !== 0) return updated;
  return left.id.localeCompare(right.id);
}

/**
 * @param {string} dbPath
 * @param {ReceivedMode} [mode]
 * @param {SyncRunnerDeps} [deps]
 * @returns {ScopeRow[]}
 */
function listReceivedScopes(dbPath, mode = "all", deps = defaultDeps) {
  const modeWhere =
    mode === "hot"
      ? "AND json_extract(config_json, '$.hot_seen_at') IS NOT NULL"
      : "";
  const orderBy =
    mode === "hot"
      ? `
     ORDER BY
       CAST(COALESCE(json_extract(config_json, '$.hot_rank'), 999999999) AS INTEGER),
       cursor_updated_at,
       id;`
      : `
     ORDER BY
       cursor_json IS NOT NULL,
       CASE WHEN cursor_json IS NULL
         THEN CAST(COALESCE(json_extract(config_json, '$.discovery_rank'), 999999999) AS INTEGER)
         ELSE NULL
       END,
       cursor_updated_at,
       id;`;
  const rows = deps.sqliteQuery(
    dbPath,
    `SELECT id, source_id, name, enabled, config_json, cursor_json, cursor_updated_at
     FROM sync_scopes
     WHERE source_id = ${deps.quoteSql(SOURCE_ID)}
       AND id LIKE 'lark.im.received.chat.%'
       AND enabled = 1
       ${modeWhere}
     ${orderBy}`,
    "list received scopes",
  );
  return rows.map((row) => {
    const scope = /** @type {ScopeRow} */ (row);
    return {
      ...scope,
      config: scope.config_json ? JSON.parse(scope.config_json) : {},
      cursor: scope.cursor_json ? JSON.parse(scope.cursor_json) : null,
    };
  }).sort((left, right) => compareReceivedScopes(left, right, mode));
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
  const id = Number(runId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`invalid run id: ${String(runId)}`);
  const finishedAtMs = Date.parse(finishedAtIso);
  if (!Number.isFinite(finishedAtMs)) throw new Error(`invalid run finish time: ${finishedAtIso}`);
  const hardLeaseCutoff = new Date(
    finishedAtMs - RUN_FENCE_HARD_LEASE_SECONDS * 1000,
  ).toISOString();
  return `
CREATE TEMP TABLE __lark_run_fence_guard (allowed INTEGER PRIMARY KEY);
INSERT INTO __lark_run_fence_guard (allowed)
SELECT 1
FROM sync_runs r
JOIN sync_scopes s ON s.id = r.scope_id AND s.source_id = r.source_id
JOIN sync_locks l ON l.scope_id = r.scope_id
WHERE r.id = ${id}
  AND r.status = 'running'
  AND r.scope_id = ${deps.quoteSql(scope.id)}
  AND r.source_id = ${deps.quoteSql(scope.source_id)}
  AND l.locked_by = json_extract(r.metadata_json, '$.__run_fence.owner')
  AND l.locked_at = json_extract(r.metadata_json, '$.__run_fence.locked_at')
  AND julianday(l.locked_at) IS NOT NULL
  AND l.locked_at > ${deps.quoteSql(hardLeaseCutoff)}
  AND s.cursor_json IS r.cursor_before_json;
CREATE TEMP TABLE __lark_run_fence_assert (
  allowed INTEGER NOT NULL CHECK (allowed = 1)
);
INSERT INTO __lark_run_fence_assert (allowed)
VALUES (CASE WHEN EXISTS (SELECT 1 FROM __lark_run_fence_guard) THEN 1 ELSE 0 END);
`;
}

/**
 * @param {string} dbPath
 * @param {SyncOptions} opts
 * @param {SelfProfile} selfProfile
 * @param {SyncRunnerDeps} [deps]
 * @returns {RunResult}
 */
function syncSent(dbPath, opts, selfProfile, deps = defaultDeps) {
  return syncScope(dbPath, SENT_SCOPE_ID, opts, (scope, runId) => {
    const { startMs, endMs: targetEndMs } = messageWindow(scope, opts);
    const fetched = fetchMessageWindowWithBisection(
      (windowStartMs, windowEndMs) =>
        deps.fetchSentMessages(selfProfile.open_id, windowStartMs, windowEndMs, opts),
      startMs,
      targetEndMs,
    );
    const completedEndMs = Number(fetched.window_end_ms);
    const peopleContext = deps.buildPeopleContext(fetched.messages, opts, selfProfile, scope.config);
    const records = prepareRecords(
      fetched.messages,
      scope.id,
      "sent",
      scope.cursor,
      opts.startMs,
      completedEndMs,
      null,
      /** @type {any} */ (peopleContext),
      scope.config,
    );
    const cursor = cursorAfter(completedEndMs);
    const effects = deps.succeedMessageRun(dbPath, scope, runId, records, fetched.messages.length, cursor, {
      adapter: "lark.im.sent_by_me",
      pages: fetched.pages,
      window_start: localIsoFromMs(startMs),
      window_end: localIsoFromMs(completedEndMs),
      requested_window_end: localIsoFromMs(opts.endMs),
      bounded_window_target: localIsoFromMs(targetEndMs),
      window_bisections: fetched.window_bisections,
      stable_horizon_seconds: opts.endExplicit ? 0 : opts.stableHorizonSeconds,
      fetched_count: fetched.messages.length,
      stored_candidate_count: records.length,
    });
    return { ok: true, scanned: fetched.messages.length, records: records.length, ...effects };
  }, deps);
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
  const isSelfRecord = (record) => hash(record.actor_id || "") === selfHash;
  return [
    ...prepareRecords(
      messages,
      scopeId,
      "received",
      cursor,
      startMs,
      endMs,
      (record) => !isSelfRecord(record),
      /** @type {any} */ (peopleContext),
      scopeConfig,
    ),
    ...prepareRecords(
      messages,
      scopeId,
      "sent",
      cursor,
      startMs,
      endMs,
      isSelfRecord,
      /** @type {any} */ (peopleContext),
      scopeConfig,
    ),
  ].sort((a, b) => a.occurred_at_ms - b.occurred_at_ms || a.external_id.localeCompare(b.external_id));
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
  return syncScope(dbPath, scope.id, opts, (lockedScope, runId) => {
    const chatIdValue = lockedScope.config?.chat_id;
    if (!chatIdValue) throw new Error(`received scope missing config.chat_id: ${lockedScope.id}`);
    const { startMs, endMs: targetEndMs } = messageWindow(lockedScope, opts);
    let fetched;
    try {
      fetched = fetchMessageWindowWithBisection(
        (windowStartMs, windowEndMs) =>
          deps.fetchChatMessages(chatIdValue, windowStartMs, windowEndMs, opts),
        startMs,
        targetEndMs,
      );
    } catch (error) {
      if (deps.isRestrictedModeError(error)) {
        succeedUnsupportedRun(dbPath, lockedScope, runId, error, "restricted_mode", deps);
        return { ok: true, skipped: true, reason: "restricted_mode", scanned: 0, records: 0, inserted: 0, updated: 0, duplicate: 0 };
      }
      if (deps.isBotUserOutOfChatError(error)) {
        succeedUnsupportedRun(dbPath, lockedScope, runId, error, "bot_user_out_of_chat", deps);
        return { ok: true, skipped: true, reason: "bot_user_out_of_chat", scanned: 0, records: 0, inserted: 0, updated: 0, duplicate: 0 };
      }
      throw error;
    }
    const completedEndMs = Number(fetched.window_end_ms);
    const scopeConfig = lockedScope.config || {};
    const peopleContext = deps.buildPeopleContext(fetched.messages, opts, selfProfile, scopeConfig);
    const records = prepareChatWindowRecords(
      fetched.messages,
      lockedScope.id,
      lockedScope.cursor,
      opts.startMs,
      completedEndMs,
      selfProfile.open_id,
      /** @type {any} */ (peopleContext),
      scopeConfig,
    );
    const cursor = cursorAfter(completedEndMs);
    const effects = deps.succeedMessageRun(dbPath, lockedScope, runId, records, fetched.messages.length, cursor, {
      adapter: "lark.im.received_per_chat",
      pages: fetched.pages,
      window_start: localIsoFromMs(startMs),
      window_end: localIsoFromMs(completedEndMs),
      requested_window_end: localIsoFromMs(opts.endMs),
      bounded_window_target: localIsoFromMs(targetEndMs),
      window_bisections: fetched.window_bisections,
      stable_horizon_seconds: opts.endExplicit ? 0 : opts.stableHorizonSeconds,
      fetched_count: fetched.messages.length,
      stored_candidate_count: records.length,
      chat_scope_id: lockedScope.id,
    });
    return { ok: true, scanned: fetched.messages.length, records: records.length, ...effects };
  }, deps);
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
  const scopes =
    opts.receivedScopesPerRun > 0 ? allScopes.slice(0, opts.receivedScopesPerRun) : allScopes;
  return scopes.map((scope) => syncReceivedScope(dbPath, opts, scope, selfProfile, deps));
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
  };
}

export {
  compareReceivedScopes,
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
};
