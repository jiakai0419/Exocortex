#!/usr/bin/env node

// @ts-check

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildPeopleContext,
  fetchChatDiscoveryPage,
  fetchChatMessages,
  fetchSentMessages,
  getSelfProfile,
  isRestrictedModeError,
} from "../src/adapters/lark-im/adapter.mjs";
import {
  acquireLock,
  createRun,
  ensureInitialized,
  failRun,
  quoteSql,
  readScope,
  releaseLock,
  sqlJson,
  sqliteExec,
  sqliteQuery,
  succeedMessageRun,
} from "../src/storage/sqlite/ingestion-store.mjs";
import {
  CHAT_DISCOVERY_SCOPE_ID,
  CHAT_HOT_DISCOVERY_SCOPE_ID,
  CHAT_RECONCILE_SCOPE_ID,
  SENT_SCOPE_ID,
  SOURCE_ID,
  bodyFromMessage,
  chatScopeId,
  compareRecordToCursor,
  cursorAfter,
  hash,
  localDay,
  localIsoFromMs,
  localOffset,
  messageWindow,
  parseLarkTimeMs,
  prepareRecords,
  recordFromMessage,
  shortHash,
  stableMessageEndMs,
} from "./lib/lark-im-core.mjs";

const DEFAULT_DB = "data/exocortex.sqlite";
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 40;
const DEFAULT_CHAT_PAGE_SIZE = 100;
const DEFAULT_MAX_CHAT_PAGES = 100;
const DEFAULT_CHAT_TYPES = "group,p2p";
const DEFAULT_STABLE_HORIZON_SECONDS = 30;
const DEFAULT_RETRIES = 4;
const DEFAULT_RETRY_DELAY_MS = 2000;

/**
 * @typedef {"all" | "sent" | "discover" | "received"} SyncScopeOption
 * @typedef {"cursor" | "hot" | "reconcile"} DiscoveryMode
 * @typedef {"all" | "hot" | "catchup"} ReceivedMode
 *
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} SyncOptions
 * @property {string} db
 * @property {SyncScopeOption} scope
 * @property {string} start
 * @property {string} end
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
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} stableHorizonMs
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
 */

function usage() {
  return `Usage: node scripts/lark-im-sync.mjs [options]

Options:
  --db <path>                 SQLite database path. Default: ${DEFAULT_DB}
  --scope <scope>             all | sent | discover | received. Default: all
  --start <iso>               Initial sync start when a scope has no cursor. Default: today 00:00 local time.
  --end <iso>                 Upper bound for this run. Default: now.
  --page-size <n>             Message page size, max 50. Default: ${DEFAULT_PAGE_SIZE}
  --max-pages <n>             Max message pages per scope. Default: ${DEFAULT_MAX_PAGES}
  --chat-page-size <n>        Chat discovery page size, max 100. Default: ${DEFAULT_CHAT_PAGE_SIZE}
  --max-chat-pages <n>        Max chat discovery pages. Default: ${DEFAULT_MAX_CHAT_PAGES}
  --discovery-pages-per-run <n>
                              Chat discovery pages processed per run. Default: 1
  --received-scopes-per-run <n>
                              Received chat scopes processed per run. 0 means all. Default: 0
  --discovery-mode <mode>     cursor | hot | reconcile. Default: cursor
                              reconcile runs an independent periodic full discovery refresh.
  --reconcile-interval-hours <n>
                              Minimum hours between completed reconcile snapshots. Default: 24
  --received-mode <mode>      all | hot | catchup. Default: all
  --chat-types <types>        Chat types for discovery. Default: ${DEFAULT_CHAT_TYPES}
  --stable-horizon-seconds <n>
                              Do not advance message cursors into the freshest N seconds unless --end is explicit.
                              Default: ${DEFAULT_STABLE_HORIZON_SECONDS}
  --lock-ttl-seconds <n>      Scope lock TTL. Default: 600
  --retries <n>               Retries for transient lark-cli failures. Default: ${DEFAULT_RETRIES}
  --retry-delay-ms <n>        Delay between transient retries. Default: ${DEFAULT_RETRY_DELAY_MS}
  --help                      Show this help.
`;
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parseNonNegativeInt(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parseTimeMs(value, name) {
  const parsed = parseLarkTimeMs(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} is not a valid time: ${value}`);
  return parsed;
}

function defaultStartIso() {
  const now = new Date();
  return `${localDay(now)}T00:00:00${localOffset(now)}`;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {SyncOptions} */
  const opts = {
    db: DEFAULT_DB,
    scope: "all",
    start: defaultStartIso(),
    end: localIsoFromMs(Date.now()),
    pageSize: DEFAULT_PAGE_SIZE,
    maxPages: DEFAULT_MAX_PAGES,
    chatPageSize: DEFAULT_CHAT_PAGE_SIZE,
    maxChatPages: DEFAULT_MAX_CHAT_PAGES,
    discoveryPagesPerRun: 1,
    receivedScopesPerRun: 0,
    discoveryMode: "cursor",
    reconcileIntervalHours: 24,
    receivedMode: "all",
    chatTypes: DEFAULT_CHAT_TYPES,
    stableHorizonSeconds: DEFAULT_STABLE_HORIZON_SECONDS,
    endExplicit: false,
    lockTtlSeconds: 600,
    retries: DEFAULT_RETRIES,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
    startMs: 0,
    endMs: 0,
    stableHorizonMs: DEFAULT_STABLE_HORIZON_SECONDS * 1000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--scope") opts.scope = /** @type {SyncScopeOption} */ (next);
    else if (arg === "--start") opts.start = next;
    else if (arg === "--end") {
      opts.end = next;
      opts.endExplicit = true;
    }
    else if (arg === "--page-size") opts.pageSize = Math.min(50, parsePositiveInt(next, "page-size"));
    else if (arg === "--max-pages") opts.maxPages = parsePositiveInt(next, "max-pages");
    else if (arg === "--chat-page-size")
      opts.chatPageSize = Math.min(100, parsePositiveInt(next, "chat-page-size"));
    else if (arg === "--max-chat-pages") opts.maxChatPages = parsePositiveInt(next, "max-chat-pages");
    else if (arg === "--discovery-pages-per-run")
      opts.discoveryPagesPerRun = parsePositiveInt(next, "discovery-pages-per-run");
    else if (arg === "--received-scopes-per-run")
      opts.receivedScopesPerRun = parseNonNegativeInt(next, "received-scopes-per-run");
    else if (arg === "--discovery-mode") opts.discoveryMode = /** @type {DiscoveryMode} */ (next);
    else if (arg === "--reconcile-interval-hours")
      opts.reconcileIntervalHours = parsePositiveInt(next, "reconcile-interval-hours");
    else if (arg === "--received-mode") opts.receivedMode = /** @type {ReceivedMode} */ (next);
    else if (arg === "--chat-types") opts.chatTypes = next;
    else if (arg === "--stable-horizon-seconds")
      opts.stableHorizonSeconds = parseNonNegativeInt(next, "stable-horizon-seconds");
    else if (arg === "--lock-ttl-seconds")
      opts.lockTtlSeconds = parsePositiveInt(next, "lock-ttl-seconds");
    else if (arg === "--retries") opts.retries = parsePositiveInt(next, "retries");
    else if (arg === "--retry-delay-ms")
      opts.retryDelayMs = parsePositiveInt(next, "retry-delay-ms");
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }

  if (!["all", "sent", "discover", "received"].includes(opts.scope)) {
    throw new Error("--scope must be one of: all, sent, discover, received");
  }
  if (!["cursor", "hot", "reconcile"].includes(opts.discoveryMode)) {
    throw new Error("--discovery-mode must be cursor, hot, or reconcile");
  }
  if (!["all", "hot", "catchup"].includes(opts.receivedMode)) {
    throw new Error("--received-mode must be all, hot, or catchup");
  }
  opts.startMs = parseTimeMs(opts.start, "start");
  opts.endMs = parseTimeMs(opts.end, "end");
  opts.stableHorizonMs = opts.stableHorizonSeconds * 1000;
  if (opts.endMs < opts.startMs) throw new Error("--end must be after --start");
  return opts;
}

/**
 * @param {string} dbPath
 * @param {ReceivedMode} [mode]
 * @returns {ScopeRow[]}
 */
function listReceivedScopes(dbPath, mode = "all") {
  const modeWhere =
    mode === "hot"
      ? "AND json_extract(config_json, '$.hot_seen_at') IS NOT NULL"
      : mode === "catchup"
        ? "AND cursor_json IS NULL"
        : "";
  const orderBy =
    mode === "hot"
      ? `
     ORDER BY
       CAST(COALESCE(json_extract(config_json, '$.hot_rank'), 999999999) AS INTEGER),
       cursor_updated_at,
       id;`
      : mode === "catchup"
        ? `
     ORDER BY
       CAST(COALESCE(json_extract(config_json, '$.discovery_rank'), 999999999) AS INTEGER),
       id;`
        : `
     ORDER BY
       cursor_updated_at IS NOT NULL,
       CAST(COALESCE(json_extract(config_json, '$.discovery_rank'), 999999999) AS INTEGER),
       cursor_updated_at,
       id;`;
  const rows = sqliteQuery(
    dbPath,
    `SELECT id, source_id, name, enabled, config_json, cursor_json
     FROM sync_scopes
     WHERE source_id = ${quoteSql(SOURCE_ID)}
       AND id LIKE 'lark.im.received.chat.%'
       AND enabled = 1
       ${modeWhere}
     ${orderBy}`,
    "list received scopes",
  );
  return rows.map((row) => ({
    ...row,
    config: row.config_json ? JSON.parse(row.config_json) : {},
    cursor: row.cursor_json ? JSON.parse(row.cursor_json) : null,
  }));
}

/**
 * @param {string} dbPath
 * @param {string} scopeId
 * @param {SyncOptions} opts
 * @param {(scope: ScopeRow, runId: number) => RunResult} worker
 * @returns {RunResult}
 */
function syncScope(dbPath, scopeId, opts, worker) {
  const scope = /** @type {ScopeRow} */ (readScope(dbPath, scopeId));
  if (!scope.enabled) return { scope_id: scopeId, skipped: true, reason: "scope_disabled" };
  if (!acquireLock(dbPath, scopeId, opts.lockTtlSeconds)) {
    return { scope_id: scopeId, skipped: true, reason: "scope_locked" };
  }
  const runId = createRun(dbPath, scope);
  try {
    const result = worker(scope, runId);
    releaseLock(dbPath, scopeId);
    return { scope_id: scopeId, run_id: runId, ...result };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    failRun(dbPath, scope, runId, err);
    releaseLock(dbPath, scopeId);
    return { scope_id: scopeId, run_id: runId, ok: false, error: err.message };
  }
}

/**
 * @param {string} dbPath
 * @param {SyncOptions} opts
 * @param {SelfProfile} selfProfile
 * @returns {RunResult}
 */
function syncSent(dbPath, opts, selfProfile) {
  return syncScope(dbPath, SENT_SCOPE_ID, opts, (scope, runId) => {
    const { startMs, endMs } = messageWindow(scope, opts);
    const fetched = fetchSentMessages(selfProfile.open_id, startMs, endMs, opts);
    const peopleContext = buildPeopleContext(fetched.messages, opts, selfProfile, scope.config);
    const records = prepareRecords(
      fetched.messages,
      scope.id,
      "sent",
      scope.cursor,
      opts.startMs,
      endMs,
      null,
      /** @type {any} */ (peopleContext),
      scope.config,
    );
    const cursor = cursorAfter(endMs);
    const effects = succeedMessageRun(dbPath, scope, runId, records, fetched.messages.length, cursor, {
      adapter: "lark.im.sent_by_me",
      pages: fetched.pages,
      window_start: localIsoFromMs(startMs),
      window_end: localIsoFromMs(endMs),
      requested_window_end: localIsoFromMs(opts.endMs),
      stable_horizon_seconds: opts.endExplicit ? 0 : opts.stableHorizonSeconds,
      fetched_count: fetched.messages.length,
      stored_candidate_count: records.length,
    });
    return { ok: true, scanned: fetched.messages.length, records: records.length, ...effects };
  });
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

/**
 * @param {ScopeRow} scope
 * @param {SyncOptions} opts
 * @returns {DiscoveryResult}
 */
function discoverChatPages(scope, opts) {
  /** @type {JsonObject[]} */
  const chats = [];
  const seen = new Set();
  const cursor = scope.cursor || {};
  const activeCursor =
    cursor.kind === "chat_discovery_cursor/v1" && cursor.has_more === true;
  const snapshotId = activeCursor
    ? String(cursor.snapshot_id)
    : `snapshot_${Date.now()}_${shortHash(`${process.pid}:${Math.random()}`)}`;
  const snapshotStartedAt = activeCursor ? String(cursor.snapshot_started_at) : new Date().toISOString();
  let pageToken = activeCursor ? String(cursor.page_token || "") : "";
  let hasMore = false;
  let processedPages = 0;
  const previousPages = activeCursor ? Number(scope.cursor?.pages_scanned || 0) : 0;
  for (let pageIndex = 0; pageIndex < opts.discoveryPagesPerRun; pageIndex += 1) {
    const page = fetchChatDiscoveryPage(opts, pageToken);
    processedPages += 1;
    const rankBase = (previousPages + processedPages - 1) * opts.chatPageSize;
    for (const [chatIndex, chat] of page.chats.entries()) {
      if (!chat?.chat_id || seen.has(chat.chat_id)) continue;
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
 * @returns {DiscoveryResult}
 */
function discoverHotChatPages(opts) {
  /** @type {JsonObject[]} */
  const chats = [];
  const seen = new Set();
  let pageToken = "";
  let hasMore = false;
  let processedPages = 0;
  const hotSeenAt = new Date().toISOString();
  for (let pageIndex = 0; pageIndex < opts.discoveryPagesPerRun; pageIndex += 1) {
    const page = fetchChatDiscoveryPage(opts, pageToken);
    processedPages += 1;
    const rankBase = pageIndex * opts.chatPageSize;
    for (const [chatIndex, chat] of page.chats.entries()) {
      if (!chat?.chat_id || seen.has(chat.chat_id)) continue;
      seen.add(chat.chat_id);
      chats.push({ ...chat, hot_rank: rankBase + chatIndex, hot_seen_at: hotSeenAt });
    }
    hasMore = page.has_more;
    pageToken = page.page_token;
    if (hasMore && !pageToken) throw new Error("chat-list returned has_more without page_token");
    if (!hasMore) break;
  }
  return {
    snapshot_id: `hot_${Date.now()}_${shortHash(`${process.pid}:${Math.random()}`)}`,
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
 * @returns {RunResult}
 */
function syncDiscovery(dbPath, opts) {
  const scopeId =
    opts.discoveryMode === "hot"
      ? CHAT_HOT_DISCOVERY_SCOPE_ID
      : opts.discoveryMode === "reconcile"
        ? CHAT_RECONCILE_SCOPE_ID
        : CHAT_DISCOVERY_SCOPE_ID;
  const currentScope = /** @type {ScopeRow} */ (readScope(dbPath, scopeId));
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
      const now = new Date().toISOString();
      const cursor = scope.cursor || {};
      sqliteExec(
        dbPath,
        `
UPDATE sync_runs
SET status = 'succeeded',
    cursor_after_json = ${sqlJson(cursor)},
    finished_at = ${quoteSql(now)},
    scanned_count = 0,
    inserted_count = 0,
    updated_count = 0,
    duplicate_count = 0,
    metadata_json = ${sqlJson({
      adapter: "lark.im.unmuted_chat_discovery",
      discovery_mode: opts.discoveryMode,
      pages: 0,
      discovered_in_run: 0,
      snapshot_id: cursor.snapshot_id,
      has_more: false,
      skipped_reason: "already_complete",
    })}
WHERE id = ${Number(runId)};
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
    const discovered = opts.discoveryMode === "hot" ? discoverHotChatPages(opts) : discoverChatPages(scope, opts);
    const now = new Date().toISOString();
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
  ${quoteSql(id)},
  ${quoteSql(SOURCE_ID)},
  ${quoteSql(`received.chat.${shortHash(chat.chat_id)}`)},
  'Messages received in one non-muted Lark chat.',
  1,
  ${sqlJson(config)},
  ${quoteSql(now)}
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
    updated_at = ${quoteSql(now)}
WHERE source_id = ${quoteSql(SOURCE_ID)}
  AND id LIKE 'lark.im.received.chat.%'
  AND COALESCE(json_extract(config_json, '$.${fullSnapshotField}'), '') <> ${quoteSql(
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
    sqliteExec(
      dbPath,
      `
BEGIN;
${upserts}
${disableSql}
UPDATE sync_runs
SET status = 'succeeded',
    cursor_after_json = ${sqlJson(cursor)},
    finished_at = ${quoteSql(now)},
    scanned_count = ${Number(discovered.chats.length)},
    inserted_count = 0,
    updated_count = 0,
    duplicate_count = 0,
      metadata_json = ${sqlJson({
      adapter: discovered.hot ? "lark.im.hot_chat_discovery" : fullAdapter,
      discovery_mode: opts.discoveryMode,
      pages: discovered.pages,
      pages_scanned_total: discovered.pages_scanned_total,
      chat_types: opts.chatTypes,
      discovered_in_run: discovered.chats.length,
      snapshot_id: discovered.snapshot_id,
      has_more: discovered.has_more,
    })}
WHERE id = ${Number(runId)};
UPDATE sync_scopes
SET cursor_json = ${sqlJson(cursor)},
    cursor_updated_at = ${quoteSql(now)},
    last_success_run_id = ${Number(runId)},
    updated_at = ${quoteSql(now)}
WHERE id = ${quoteSql(scope.id)};
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
  });
}

/**
 * @param {string} dbPath
 * @param {ScopeRow} scope
 * @param {number} runId
 * @param {unknown} error
 * @param {string} reason
 */
function succeedUnsupportedRun(dbPath, scope, runId, error, reason) {
  const now = new Date().toISOString();
  const config = {
    unsupported_reason: reason,
    unsupported_at: now,
    unsupported_error: String(error instanceof Error ? error.message : error).slice(0, 1000),
  };
  sqliteExec(
    dbPath,
    `
BEGIN;
UPDATE sync_runs
SET status = 'succeeded',
    finished_at = ${quoteSql(now)},
    scanned_count = 0,
    inserted_count = 0,
    updated_count = 0,
    duplicate_count = 0,
    metadata_json = ${sqlJson({
      adapter: "lark.im.received_per_chat",
      skipped: true,
      skip_reason: reason,
    })}
WHERE id = ${Number(runId)};
UPDATE sync_scopes
SET enabled = 0,
    config_json = json_patch(config_json, ${sqlJson(config)}),
    last_success_run_id = ${Number(runId)},
    updated_at = ${quoteSql(now)}
WHERE id = ${quoteSql(scope.id)};
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
 * @returns {RunResult}
 */
function syncReceivedScope(dbPath, opts, scope, selfProfile) {
  return syncScope(dbPath, scope.id, opts, (lockedScope, runId) => {
    const chatIdValue = lockedScope.config?.chat_id;
    if (!chatIdValue) throw new Error(`received scope missing config.chat_id: ${lockedScope.id}`);
    const { startMs, endMs } = messageWindow(lockedScope, opts);
    let fetched;
    try {
      fetched = fetchChatMessages(chatIdValue, startMs, endMs, opts);
    } catch (error) {
      if (isRestrictedModeError(error)) {
        succeedUnsupportedRun(dbPath, lockedScope, runId, error, "restricted_mode");
        return { ok: true, skipped: true, reason: "restricted_mode", scanned: 0, records: 0, inserted: 0, updated: 0, duplicate: 0 };
      }
      throw error;
    }
    const scopeConfig = lockedScope.config || {};
    const peopleContext = buildPeopleContext(fetched.messages, opts, selfProfile, scopeConfig);
    const records = prepareChatWindowRecords(
      fetched.messages,
      lockedScope.id,
      lockedScope.cursor,
      opts.startMs,
      endMs,
      selfProfile.open_id,
      /** @type {any} */ (peopleContext),
      scopeConfig,
    );
    const cursor = cursorAfter(endMs);
    const effects = succeedMessageRun(dbPath, lockedScope, runId, records, fetched.messages.length, cursor, {
      adapter: "lark.im.received_per_chat",
      pages: fetched.pages,
      window_start: localIsoFromMs(startMs),
      window_end: localIsoFromMs(endMs),
      requested_window_end: localIsoFromMs(opts.endMs),
      stable_horizon_seconds: opts.endExplicit ? 0 : opts.stableHorizonSeconds,
      fetched_count: fetched.messages.length,
      stored_candidate_count: records.length,
      chat_scope_id: lockedScope.id,
    });
    return { ok: true, scanned: fetched.messages.length, records: records.length, ...effects };
  });
}

/**
 * @param {string} dbPath
 * @param {SyncOptions} opts
 * @param {SelfProfile} selfProfile
 * @returns {RunResult[]}
 */
function syncReceived(dbPath, opts, selfProfile) {
  const allScopes = listReceivedScopes(dbPath, opts.receivedMode);
  const scopes =
    opts.receivedScopesPerRun > 0 ? allScopes.slice(0, opts.receivedScopesPerRun) : allScopes;
  return scopes.map((scope) => syncReceivedScope(dbPath, opts, scope, selfProfile));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = resolve(opts.db);
  ensureInitialized(dbPath);

  const needsSelfProfile = opts.scope === "all" || opts.scope === "sent" || opts.scope === "received";
  const selfProfile = /** @type {SelfProfile | null} */ (needsSelfProfile ? getSelfProfile(opts) : null);
  if (needsSelfProfile && !selfProfile?.open_id) {
    throw new Error("could not resolve current Lark user open_id");
  }
  /** @type {SelfProfile | null} */
  const requiredSelfProfile = needsSelfProfile ? selfProfile : null;

  /** @type {JsonObject & {sent: RunResult | null, discovery: RunResult | null, received: RunResult[]}} */
  const summary = {
    ok: true,
    db_path: dbPath,
    window: {
      start: localIsoFromMs(opts.startMs),
      end: localIsoFromMs(opts.endMs),
    },
    sent: null,
    discovery: null,
    received: [],
  };

  if (opts.scope === "all" || opts.scope === "sent") {
    summary.sent = syncSent(dbPath, opts, /** @type {SelfProfile} */ (requiredSelfProfile));
  }
  if (opts.scope === "all" || opts.scope === "discover") {
    summary.discovery = syncDiscovery(dbPath, opts);
  }
  if (opts.scope === "all" || opts.scope === "received") {
    summary.received = syncReceived(dbPath, opts, /** @type {SelfProfile} */ (requiredSelfProfile));
  }

  const failures = [
    summary.sent,
    summary.discovery,
    ...summary.received,
  ].filter((item) => item && item.ok === false);
  if (failures.length > 0) {
    summary.ok = false;
    summary.failures = failures.length;
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.ok) process.exit(1);
}

export {
  bodyFromMessage,
  compareRecordToCursor,
  createRun,
  cursorAfter,
  ensureInitialized,
  failRun,
  messageWindow,
  parseArgs,
  parseLarkTimeMs,
  prepareChatWindowRecords,
  prepareRecords,
  readScope,
  recordFromMessage,
  shouldSkipCompletedDiscovery,
  shouldSkipReconcile,
  sqliteExec,
  sqliteQuery,
  stableMessageEndMs,
  succeedMessageRun,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
