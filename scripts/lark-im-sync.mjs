#!/usr/bin/env node

// @ts-check

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getSelfProfile } from "../src/adapters/lark-im/adapter.mjs";
import {
  createRun,
  ensureInitialized,
  failRun,
  readScope,
  sqliteExec,
  sqliteQuery,
  succeedMessageRun,
} from "../dist/storage/sqlite/ingestion-store.js";
import {
  createSyncRunner,
  prepareChatWindowRecords,
  shouldSkipCompletedDiscovery,
  shouldSkipReconcile,
  succeedUnsupportedRun,
  syncDiscovery,
  syncReceived,
  syncSent,
} from "../src/adapters/lark-im/sync-runner.mjs";
import {
  bodyFromMessage,
  compareRecordToCursor,
  cursorAfter,
  localDay,
  localIsoFromMs,
  localOffset,
  messageWindow,
  parseLarkTimeMs,
  prepareRecords,
  recordFromMessage,
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
const syncRunner = createSyncRunner();

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
    summary.sent = syncRunner.syncSent(dbPath, opts, /** @type {SelfProfile} */ (requiredSelfProfile));
  }
  if (opts.scope === "all" || opts.scope === "discover") {
    summary.discovery = syncRunner.syncDiscovery(dbPath, opts);
  }
  if (opts.scope === "all" || opts.scope === "received") {
    summary.received = syncRunner.syncReceived(dbPath, opts, /** @type {SelfProfile} */ (requiredSelfProfile));
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
  createSyncRunner,
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
  succeedUnsupportedRun,
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
