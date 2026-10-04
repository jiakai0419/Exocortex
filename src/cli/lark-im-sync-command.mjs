// @ts-check

import { ACTIVITY_GRACE_MS, createActivityWriter } from "../diagnostics/lark-im-activity-evidence.mjs";
import { writeLog } from "./lark-im-worker-command.mjs";

import { resolve } from "node:path";
import { getSelfProfile } from "../adapters/lark-im/adapter.mjs";
import { getTransportStats, resetTransportStats } from "../adapters/lark-im/transport.mjs";
import {
  createSyncRunner,
} from "../adapters/lark-im/sync-runner.mjs";
import {
  localIsoFromMs,
  parseLarkTimeMs,
  SOURCE_ID,
} from "../adapters/lark-im/core.mjs";
import {
  ensureInitialized,
  ensureSourceInitialSyncStart,
  validateInitialSyncStartMs,
} from "../../dist/storage/sqlite/ingestion-store.js";

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
 * @typedef {"all" | "sent" | "discover" | "received" | "details"} SyncScopeOption
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
 * @property {boolean} startExplicit
 * @property {number} lockTtlSeconds
 * @property {number} retries
 * @property {number} retryDelayMs
 * @property {number} detailLimit
 * @property {string=} detailScope
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} stableHorizonMs
 * @property {boolean=} help
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
 * @typedef {object} LarkImSyncCommandDeps
 * @property {ReturnType<typeof createActivityWriter>=} activity
 * @property {(dbPath: string) => void=} ensureInitialized
 * @property {(dbPath: string, sourceId: string, candidateStartMs: number, options?: {explicit?: boolean, endMs?: number}) => number=} ensureSourceInitialSyncStart
 * @property {(opts: SyncOptions) => SelfProfile=} getSelfProfile
 * @property {any=} syncRunner
 * @property {Partial<Record<string, any>>=} syncRunnerDeps
 * @property {(dbPath: string) => string=} resolvePath
 * @property {() => JsonObject=} getTransportStats
 * @property {() => void=} resetTransportStats
 *
 * @typedef {object} CliIo
 * @property {{write: (text: string) => unknown}=} stdout
 * @property {{write: (text: string) => unknown}=} stderr
 * @property {LarkImSyncCommandDeps=} deps
 */

function usage() {
  return `Usage: node scripts/lark-im-sync.mjs [options]

Options:
  --db <path>                 SQLite database path. Default: ${DEFAULT_DB}
  --scope <scope>             all | sent | discover | received | details. Default: all
  --start <iso>               Confirm the persistent start for scopes without cursors; requires an ISO timezone.
                              On a new source, default: today 00:00 local time. Later conflicting values fail.
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
  --detail-limit <n>         Due detail roots per details-only run, max 20. Default: 5
  --detail-scope <id>        Restrict details-only retries to one stored scope.
  --help                      Show this help.
`;
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parsePositiveInt(value, name) {
  const text = String(value);
  const parsed = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parseNonNegativeInt(value, name) {
  const text = String(value);
  const parsed = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(parsed)) {
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

function defaultStartIso(now) {
  return localIsoFromMs(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime());
}

/** @param {string} value */
function parseInitialStartMs(value) {
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) throw new Error("--start must be an ISO timestamp with an explicit timezone (Z or +/-HH:mm)");
  const [, local, fraction = "", zone, sign, hour = "0", minute = "0"] = match;
  if (Number(hour) > 23 || Number(minute) > 59) throw new Error("--start has an invalid timezone offset");
  const parsed = validateInitialSyncStartMs(Date.parse(value));
  const offset = zone === "Z" ? 0 : (sign === "-" ? -1 : 1) * (Number(hour) * 60 + Number(minute)) * 60_000;
  if (new Date(parsed + offset).toISOString() !== `${local}.${fraction.padEnd(3, "0")}Z`) {
    throw new Error("--start is not a valid calendar timestamp");
  }
  return parsed;
}

/** @returns {SyncOptions} */
function defaultOptions() {
  const now = new Date();
  return {
    db: DEFAULT_DB,
    scope: "all",
    start: defaultStartIso(now),
    end: localIsoFromMs(now.getTime()),
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
    startExplicit: false,
    lockTtlSeconds: 600,
    retries: DEFAULT_RETRIES,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
    detailLimit: 5,
    startMs: 0,
    endMs: 0,
    stableHorizonMs: DEFAULT_STABLE_HORIZON_SECONDS * 1000,
  };
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = defaultOptions();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { ...opts, help: true };
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--scope") opts.scope = /** @type {SyncScopeOption} */ (next);
    else if (arg === "--start") {
      opts.start = next;
      opts.startExplicit = true;
    }
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
    else if (arg === "--detail-limit") opts.detailLimit = Math.min(20, parsePositiveInt(next, "detail-limit"));
    else if (arg === "--detail-scope") opts.detailScope = next;
    else if (arg === "--retries") opts.retries = parsePositiveInt(next, "retries");
    else if (arg === "--retry-delay-ms")
      opts.retryDelayMs = parsePositiveInt(next, "retry-delay-ms");
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }

  if (!["all", "sent", "discover", "received", "details"].includes(opts.scope)) {
    throw new Error("--scope must be one of: all, sent, discover, received, details");
  }
  if (!["cursor", "hot", "reconcile"].includes(opts.discoveryMode)) {
    throw new Error("--discovery-mode must be cursor, hot, or reconcile");
  }
  if (!["all", "hot", "catchup"].includes(opts.receivedMode)) {
    throw new Error("--received-mode must be all, hot, or catchup");
  }
  opts.startMs = parseInitialStartMs(opts.start);
  opts.endMs = parseTimeMs(opts.end, "end");
  opts.stableHorizonMs = opts.stableHorizonSeconds * 1000;
  if (opts.startExplicit && opts.endMs < opts.startMs) throw new Error("--end must be after --start");
  return opts;
}

/**
 * @param {SyncOptions} opts
 * @param {LarkImSyncCommandDeps} [deps]
 */
function executeLarkImSync(opts, deps = {}) {
  const dbPath = (deps.resolvePath || resolve)(opts.db);
  const initialize = deps.ensureInitialized || ensureInitialized;
  const loadSelfProfile = deps.getSelfProfile || getSelfProfile;
  const runner = deps.syncRunner || createSyncRunner(deps.syncRunnerDeps || {});
  initialize(dbPath);
  const baseline = (deps.ensureSourceInitialSyncStart || ensureSourceInitialSyncStart)(
    dbPath, SOURCE_ID, opts.startMs, { explicit: opts.startExplicit, endMs: opts.endMs },
  );
  opts = { ...opts, startMs: baseline, start: new Date(baseline).toISOString() };
  if (opts.endMs < baseline) throw new Error("--end must be after the persisted initial sync baseline");

  const needsSelfProfile = opts.scope === "all" || opts.scope === "sent" || opts.scope === "received" || opts.scope === "details";
  const selfProfile = /** @type {SelfProfile | null} */ (needsSelfProfile ? loadSelfProfile(opts) : null);
  if (needsSelfProfile && !selfProfile?.open_id) {
    throw new Error("could not resolve current Lark user open_id");
  }
  const requiredSelfProfile = needsSelfProfile ? /** @type {SelfProfile} */ (selfProfile) : null;

  /** @type {JsonObject & {sent: RunResult | null, discovery: RunResult | null, received: RunResult[]}} */
  const summary = {
    ok: true,
    db_path: dbPath,
    initial_sync_start_ms: baseline,
    initial_sync_start: new Date(baseline).toISOString(),
    window: {
      start: localIsoFromMs(opts.startMs),
      end: localIsoFromMs(opts.endMs),
    },
    sent: null,
    discovery: null,
    received: [],
  };

  if (opts.scope === "all" || opts.scope === "sent") {
    deps.activity?.update("sync", { step: "sent", durationMs: 5000 });
    summary.sent = runner.syncSent(dbPath, opts, requiredSelfProfile);
  }
  if (opts.scope === "all" || opts.scope === "discover") {
    deps.activity?.update("sync", { step: "discover", durationMs: 5000 });
    summary.discovery = runner.syncDiscovery(dbPath, opts);
  }
  if (opts.scope === "all" || opts.scope === "received") {
    deps.activity?.update("sync", { step: "received", durationMs: 5000 });
    summary.received = runner.syncReceived(dbPath, opts, requiredSelfProfile);
  }

  if (opts.scope === "details") {
    deps.activity?.update("sync", { step: "details", durationMs: 5000 });
    summary.details = runner.retryDetails(dbPath, opts, requiredSelfProfile);
  }

  const failures = [
    summary.sent,
    summary.discovery,
    ...summary.received,
    ...(summary.details || []),
  ].filter((item) => item && item.ok === false);
  if (failures.length > 0) {
    summary.ok = false;
    summary.failures = failures.length;
  }

  return summary;
}

/**
 * @param {string[]} argv
 * @param {CliIo} [io]
 */
function runLarkImSyncCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const readTransport = io.deps?.getTransportStats || getTransportStats;
  (io.deps?.resetTransportStats || resetTransportStats)();
  /** @type {ReturnType<typeof createActivityWriter> | undefined} */
  let activity;
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      stdout.write(usage());
      return 0;
    }
    const parent = process.env.EXOCORTEX_ACTIVITY_PARENT || "";
    const timeout = Number(process.env.EXOCORTEX_ACTIVITY_STEP_TIMEOUT_MS);
    const durationMs = parent && Number.isSafeInteger(timeout) && timeout > 0 ? timeout + ACTIVITY_GRACE_MS : 5000;
    activity = io.deps?.activity || (!io.deps ? createActivityWriter({ db: opts.db, role: "sync", parentInstance: parent,
      emit: (event) => writeLog({ logDir: process.env.EXOCORTEX_ACTIVITY_LOG_DIR || "logs/lark-im" }, event, { stdout: { write() {} } }),
    }) : undefined);
    activity?.update("sync", { step: opts.scope, durationMs });
    const summary = executeLarkImSync(opts, { ...io.deps, activity });
    summary.transport = readTransport();
    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${message}\n`);
    const transport = readTransport();
    if (transport.calls > 0) {
      stderr.write(`${JSON.stringify({ type: "lark_transport_summary", transport })}\n`);
    }
    return 1;
  } finally { activity?.update("stopped"); }
}

export {
  executeLarkImSync,
  parseArgs,
  runLarkImSyncCli,
  usage,
};
