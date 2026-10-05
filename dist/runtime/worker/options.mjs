// @ts-check
// One source of defaults, validation and persistence for internal workers and services.
import { resolve } from "node:path";
import { parseOptions } from "../../cli/parse-options.mjs";
const defaults = {
    db: "data/exocortex.sqlite",
    intervalSeconds: 60,
    receivedScopesPerCycle: 50,
    hotReceivedScopesPerCycle: 20,
    discoveryPagesPerCycle: 1,
    hotDiscoveryPagesPerCycle: 5,
    maxChatPages: 300,
    reconcileIntervalHours: 24,
    chatTypes: "group,p2p",
    logDir: "logs/lark-im",
    stepTimeoutSeconds: 600,
    logMaxBytes: 10 * 1024 * 1024,
    logKeepFiles: 5,
    retentionEveryCycles: 1440,
    adaptiveFair: false,
    adaptiveFairMin: 10,
    adaptiveFairMax: 50,
    adaptiveTargetCycleSeconds: 90,
    remoteSampleIntervalSeconds: 900,
};
/** @typedef {typeof defaults} WorkerSettings */
export const WORKER_DEFAULTS = Object.freeze(defaults);
/**
 * @typedef {{flag:string,key:string,type:"path"|"string"|"boolean"|"integer"|"enum",default?:any,choices?:string[],min?:number,max?:number,repeat?:boolean,required?:boolean,description:string}} OptionSpec
 */
/** @type {ReadonlyArray<OptionSpec>} */
export const WORKER_OPTION_SPECS = Object.freeze([
    { flag: "--db", key: "db", type: "path", default: defaults.db, description: "SQLite database path." },
    { flag: "--interval-seconds", key: "intervalSeconds", type: "integer", default: defaults.intervalSeconds, description: "Sleep between cycles." },
    { flag: "--received-scopes-per-cycle", key: "receivedScopesPerCycle", type: "integer", default: defaults.receivedScopesPerCycle, description: "Catch-up received scopes per cycle." },
    { flag: "--hot-received-scopes-per-cycle", key: "hotReceivedScopesPerCycle", type: "integer", default: defaults.hotReceivedScopesPerCycle, description: "Recently active received scopes per cycle." },
    { flag: "--discovery-pages-per-cycle", key: "discoveryPagesPerCycle", type: "integer", default: defaults.discoveryPagesPerCycle, description: "Full discovery pages per cycle." },
    { flag: "--hot-discovery-pages-per-cycle", key: "hotDiscoveryPagesPerCycle", type: "integer", default: defaults.hotDiscoveryPagesPerCycle, description: "Recently active discovery pages per cycle." },
    { flag: "--max-chat-pages", key: "maxChatPages", type: "integer", default: defaults.maxChatPages, description: "Maximum full-discovery pages per snapshot." },
    { flag: "--reconcile-interval-hours", key: "reconcileIntervalHours", type: "integer", default: defaults.reconcileIntervalHours, description: "Minimum hours between full reconcile snapshots." },
    { flag: "--chat-types", key: "chatTypes", type: "string", default: defaults.chatTypes, description: "Chat types for discovery." },
    { flag: "--log-dir", key: "logDir", type: "path", default: defaults.logDir, description: "Worker JSONL log directory." },
    { flag: "--step-timeout-seconds", key: "stepTimeoutSeconds", type: "integer", default: defaults.stepTimeoutSeconds, description: "Hard timeout for each child step." },
    { flag: "--log-max-bytes", key: "logMaxBytes", type: "integer", default: defaults.logMaxBytes, description: "Rotate worker.jsonl at this size." },
    { flag: "--log-keep-files", key: "logKeepFiles", type: "integer", default: defaults.logKeepFiles, description: "Rotated worker logs to keep." },
    { flag: "--retention-every-cycles", key: "retentionEveryCycles", type: "integer", default: defaults.retentionEveryCycles, description: "Apply run retention every N cycles." },
    { flag: "--adaptive-fair", key: "adaptiveFair", type: "boolean", default: defaults.adaptiveFair, description: "Adapt the fair scope batch; not an HTTP rate limiter." },
    { flag: "--adaptive-fair-min", key: "adaptiveFairMin", type: "integer", default: defaults.adaptiveFairMin, description: "Minimum adaptive fair batch." },
    { flag: "--adaptive-fair-max", key: "adaptiveFairMax", type: "integer", default: defaults.adaptiveFairMax, description: "Maximum adaptive fair batch." },
    { flag: "--adaptive-target-cycle-seconds", key: "adaptiveTargetCycleSeconds", type: "integer", default: defaults.adaptiveTargetCycleSeconds, description: "Target work plus interval duration." },
    { flag: "--remote-sample-interval-seconds", key: "remoteSampleIntervalSeconds", type: "integer", min: 0, max: 1800, default: defaults.remoteSampleIntervalSeconds, description: "Bounded remote sample interval (900–1800 seconds; 0 disables)." },
]);
export function validateWorkerOptions(opts) {
    if (opts.remoteSampleIntervalSeconds !== undefined && opts.remoteSampleIntervalSeconds !== 0 &&
        (!Number.isSafeInteger(opts.remoteSampleIntervalSeconds) || opts.remoteSampleIntervalSeconds < 900 || opts.remoteSampleIntervalSeconds > 1800)) {
        throw new Error("remote-sample-interval-seconds must be 0 or between 900 and 1800");
    }
    if (opts.adaptiveFairMin > opts.adaptiveFairMax) {
        throw new Error("adaptive-fair-min must not exceed adaptive-fair-max");
    }
    if (opts.adaptiveFair && (opts.receivedScopesPerCycle < opts.adaptiveFairMin ||
        opts.receivedScopesPerCycle > opts.adaptiveFairMax)) {
        throw new Error("received-scopes-per-cycle must be within adaptive fair bounds");
    }
    if (opts.adaptiveFair && opts.adaptiveTargetCycleSeconds <= opts.intervalSeconds) {
        throw new Error("adaptive-target-cycle-seconds must exceed interval-seconds");
    }
}
/** @param {WorkerSettings} opts */
export function workerProgramArguments(opts) {
    validateWorkerOptions(opts);
    return WORKER_OPTION_SPECS.flatMap((spec) => spec.type === "boolean"
        ? (opts[spec.key] ? [spec.flag] : []) : [spec.flag, String(opts[spec.key])]);
}
/** Defaults are root-relative; explicit paths are cwd-relative. */
export function resolveWorkerPaths(opts, { root = process.cwd(), cwd = process.cwd(), provided = new Set() } = {}) {
    return { ...opts, db: resolve(provided.has("--db") ? cwd : root, opts.db),
        logDir: resolve(provided.has("--log-dir") ? cwd : root, opts.logDir) };
}
/** Parse only persistent arguments; process lifetime flags never enter a service plist.
 * @param {string[]} argv
 * @param {{root?:string,cwd?:string,resolvePaths?:boolean}} [context]
 */
export function parseWorkerProgramArguments(argv, context = {}) {
    for (const arg of argv) {
        if (arg === "--once" || arg === "--max-cycles")
            throw new Error(`${arg} is foreground worker only`);
    }
    const { options, provided, help } = parseOptions(argv, WORKER_OPTION_SPECS, { resolvePaths: false });
    if (help)
        throw new Error("--help is not a persistent worker argument");
    const opts = /** @type {WorkerSettings} */ (options);
    validateWorkerOptions(opts);
    return context.resolvePaths === true ? resolveWorkerPaths(opts, { ...context, provided }) : opts;
}
