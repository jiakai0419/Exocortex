// @ts-check
import { resolve } from "node:path";
import { CliExecutionError } from "../../cli/context.mjs";
import { getSelfProfile } from "./adapter.mjs";
import { createSyncRunner } from "./sync-runner.mjs";
import { localIsoFromMs, parseLarkTimeMs, SOURCE_ID } from "./core.mjs";
import { SYNC_DEFAULTS } from "./sync-options.mjs";
import { ensureInitialized, ensureSourceInitialSyncStart, validateInitialSyncStartMs } from "../../../dist/storage/sqlite/ingestion-store.js";
import { captureRemoteAccountBinding, readRemoteAccountBinding, recordSuccessfulSyncBinding } from "../../diagnostics/remote-account-binding.mjs";

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
 * @property {ReturnType<typeof import("../../diagnostics/lark-im-activity-evidence.mjs").createActivityWriter>=} activity
 * @property {(dbPath: string) => void=} ensureInitialized
 * @property {(dbPath: string, sourceId: string, candidateStartMs: number, options?: {explicit?: boolean, endMs?: number}) => number=} ensureSourceInitialSyncStart
 * @property {(opts: SyncOptions) => SelfProfile=} getSelfProfile
 * @property {Partial<Pick<import("./sync-runner.mjs").SyncRunner, "syncSent" | "syncDiscovery" | "syncReceived" | "retryDetails">>=} syncRunner
 * @property {Partial<import("./sync-runner.mjs").SyncRunnerDeps>=} syncRunnerDeps
 * @property {(dbPath: string) => string=} resolvePath
 * @property {() => JsonObject=} getTransportStats
 * @property {() => void=} resetTransportStats
 * @property {typeof import("../../runtime/lark-api-lease.mjs").tryAcquireLarkApiLease=} tryAcquireLarkApiLease
 * @property {typeof captureRemoteAccountBinding=} captureRemoteAccountBinding
 * @property {typeof readRemoteAccountBinding=} readRemoteAccountBinding
 * @property {typeof recordSuccessfulSyncBinding=} recordSuccessfulSyncBinding
 *
 * @typedef {object} CliIo
 * @property {{write: (text: string) => unknown}=} stdout
 * @property {{write: (text: string) => unknown}=} stderr
 * @property {LarkImSyncCommandDeps=} deps
 */

function parseTimeMs(value, name) {
  const parsed = parseLarkTimeMs(value);
  if (!Number.isFinite(parsed)) throw new CliExecutionError(`${name} is not a valid time`);
  return parsed;
}

function defaultStartIso(now) {
  return localIsoFromMs(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime());
}

/** @param {string} value */
function parseInitialStartMs(value) {
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) throw new CliExecutionError("--start must be an ISO timestamp with an explicit timezone (Z or +/-HH:mm)");
  const [, local, fraction = "", zone, sign, hour = "0", minute = "0"] = match;
  if (Number(hour) > 23 || Number(minute) > 59) throw new CliExecutionError("--start has an invalid timezone offset");
  let parsed;
  try { parsed = validateInitialSyncStartMs(Date.parse(value)); }
  catch { throw new CliExecutionError("--start is outside the supported millisecond range"); }
  const offset = zone === "Z" ? 0 : (sign === "-" ? -1 : 1) * (Number(hour) * 60 + Number(minute)) * 60_000;
  if (new Date(parsed + offset).toISOString() !== `${local}.${fraction.padEnd(3, "0")}Z`) {
    throw new CliExecutionError("--start is not a valid calendar timestamp");
  }
  return parsed;
}

/** Resolve dynamic defaults once, then validate the domain's persisted window contract.
 * @param {Record<string, any>} options
 * @param {{now?:()=>number,provided?:Set<string>}} [context]
 * @returns {SyncOptions}
 */
function normalizeSyncOptions(options, context = {}) {
  const now = new Date((context.now || Date.now)());
  const provided = context.provided || new Set();
  const opts = /** @type {SyncOptions} */ ({ ...SYNC_DEFAULTS, ...options,
    start: options.start ?? defaultStartIso(now), end: options.end ?? localIsoFromMs(now.getTime()),
    startExplicit: provided.has("--start"), endExplicit: provided.has("--end"),
  });
  opts.pageSize = Math.min(50, opts.pageSize);
  opts.chatPageSize = Math.min(100, opts.chatPageSize);
  opts.detailLimit = Math.min(20, opts.detailLimit);
  opts.startMs = parseInitialStartMs(opts.start);
  opts.endMs = parseTimeMs(opts.end, "end");
  opts.stableHorizonMs = opts.stableHorizonSeconds * 1000;
  if (opts.startExplicit && opts.endMs < opts.startMs) throw new CliExecutionError("--end must be after --start");
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
  // Injected runners may implement just the requested scope, as before.
  const runner = /** @type {import("./sync-runner.mjs").SyncRunner} */ (deps.syncRunner || createSyncRunner(deps.syncRunnerDeps || {}));
  initialize(dbPath);
  const bindingBefore = (deps.captureRemoteAccountBinding || captureRemoteAccountBinding)({ db: dbPath, emptyOnly: true, includeSidecar: true });
  const resolveBaseline = () => (deps.ensureSourceInitialSyncStart || ensureSourceInitialSyncStart)(
    dbPath, SOURCE_ID, opts.startMs, { explicit: opts.startExplicit, endMs: opts.endMs },
  );
  // A proven fresh source may retain collection intent across authentication
  // failure and midnight. Existing or uncertain account evidence cannot.
  let baseline = bindingBefore?.empty === true && bindingBefore.binding_absent === true ? resolveBaseline() : null;

  // Discovery can create and disable scopes, so it needs the same account
  // boundary as message and detail writes.
  const selfProfile = loadSelfProfile(opts);
  if (!selfProfile?.open_id) throw new CliExecutionError("could not resolve current Lark user open_id");
  const binding = (deps.readRemoteAccountBinding || readRemoteAccountBinding)({ db: dbPath, selfOpenId: selfProfile.open_id });
  if (binding.state === "conflict") {
    throw new CliExecutionError("sync account conflicts with this database; use the matching account or a separate database");
  }
  if (binding.state !== "verified" && !(binding.state === "unverified" && binding.reason === "account_database_unbound")) {
    throw new CliExecutionError("sync account binding cannot be verified; inspect the existing database binding before retrying");
  }
  baseline ??= resolveBaseline();
  opts = { ...opts, startMs: baseline, start: new Date(baseline).toISOString() };
  if (opts.endMs < baseline) throw new CliExecutionError("--end must be after the persisted initial sync baseline");

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
    summary.sent = runner.syncSent(dbPath, opts, selfProfile);
  }
  if (opts.scope === "all" || opts.scope === "discover") {
    deps.activity?.update("sync", { step: "discover", durationMs: 5000 });
    summary.discovery = runner.syncDiscovery(dbPath, opts);
  }
  if (opts.scope === "all" || opts.scope === "received") {
    deps.activity?.update("sync", { step: "received", durationMs: 5000 });
    summary.received = runner.syncReceived(dbPath, opts, selfProfile);
  }

  if (opts.scope === "details") {
    deps.activity?.update("sync", { step: "details", durationMs: 5000 });
    summary.details = runner.retryDetails(dbPath, opts, selfProfile);
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
    const runs = [summary.sent, summary.discovery, ...summary.received, ...(summary.details || [])].filter(Boolean);
    summary.incomplete = runs.some((run) => run.incomplete === true || Number(run.pending_details || 0) > 0);
    summary.partial = summary.incomplete || runs.some((run) => run.ok === true || run.list_complete === true);
  }

  (deps.recordSuccessfulSyncBinding || recordSuccessfulSyncBinding)({
    db: dbPath, selfOpenId: selfProfile.open_id, before: bindingBefore,
    successful: summary.ok === true && [summary.sent, summary.discovery, ...summary.received, ...(summary.details || [])]
      .some((run) => run?.ok === true && run.skipped !== true),
  });
  return summary;
}

export { normalizeSyncOptions, executeLarkImSync };
