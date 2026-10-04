// Configuration shared by foreground workers and persistent service workers.
// Process lifetime and database selection belong to their individual entrypoints.
const defaults = {
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
};
export const WORKER_DEFAULTS = Object.freeze(defaults);
// This explicit list is also the service persistence boundary. Do not serialize
// arbitrary option object keys: --once, --max-cycles and diagnostic --db are not
// configuration for a long-running LaunchAgent.
const integerOptions = [
    ["--interval-seconds", "intervalSeconds"],
    ["--received-scopes-per-cycle", "receivedScopesPerCycle"],
    ["--hot-received-scopes-per-cycle", "hotReceivedScopesPerCycle"],
    ["--discovery-pages-per-cycle", "discoveryPagesPerCycle"],
    ["--hot-discovery-pages-per-cycle", "hotDiscoveryPagesPerCycle"],
    ["--max-chat-pages", "maxChatPages"],
    ["--reconcile-interval-hours", "reconcileIntervalHours"],
    ["--step-timeout-seconds", "stepTimeoutSeconds"],
    ["--log-max-bytes", "logMaxBytes"],
    ["--log-keep-files", "logKeepFiles"],
    ["--retention-every-cycles", "retentionEveryCycles"],
    ["--adaptive-fair-min", "adaptiveFairMin"],
    ["--adaptive-fair-max", "adaptiveFairMax"],
    ["--adaptive-target-cycle-seconds", "adaptiveTargetCycleSeconds"],
];
const stringOptions = [["--chat-types", "chatTypes"], ["--log-dir", "logDir"]];
export function parsePositiveInt(value, name) {
    const text = String(value);
    if (!/^[1-9]\d*$/.test(text))
        throw new Error(`${name} must be positive integer`);
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed))
        throw new Error(`${name} must be a safe positive integer`);
    return parsed;
}
/** Return the consumed argument count, or zero when the entrypoint owns it. */
export function applyWorkerOption(opts, arg, value) {
    if (arg === "--adaptive-fair") {
        opts.adaptiveFair = true;
        return 1;
    }
    const integer = integerOptions.find(([flag]) => flag === arg);
    const text = stringOptions.find(([flag]) => flag === arg);
    if (!integer && !text)
        return 0;
    if (!value || value.startsWith("--"))
        throw new Error(`${arg} requires a value`);
    if (integer)
        opts[integer[1]] = parsePositiveInt(value, arg.slice(2));
    else if (text)
        opts[text[1]] = value;
    return 2;
}
export function validateWorkerOptions(opts) {
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
export function workerProgramArguments(opts) {
    validateWorkerOptions(opts);
    return [
        ...integerOptions.flatMap(([flag, key]) => [flag, String(opts[key])]),
        ...stringOptions.flatMap(([flag, key]) => [flag, opts[key]]),
        ...(opts.adaptiveFair ? ["--adaptive-fair"] : []),
    ];
}
