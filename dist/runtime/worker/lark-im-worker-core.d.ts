type JsonObject = Record<string, any>;
type WorkerCycleOptions = {
    db: string;
    hotDiscoveryPagesPerCycle: number;
    hotReceivedScopesPerCycle: number;
    discoveryPagesPerCycle: number;
    receivedScopesPerCycle: number;
    maxChatPages: number;
    reconcileIntervalHours: number;
    retentionEveryCycles?: number;
    chatTypes?: string;
    logDir?: string;
};
type WorkerStepSpec = {
    name: string;
    args: string[];
    command?: "sync" | "maintenance";
};
type RunSummary = {
    run_id?: number | null;
    ok?: boolean;
    scanned?: number;
    records?: number;
    inserted?: number;
    updated?: number;
    duplicate?: number;
    scope_id?: string;
    mode?: string;
    pages?: number;
    discovered_in_run?: number;
    has_more?: boolean;
    snapshot_id?: string;
    skipped?: boolean;
    reason?: string;
    [key: string]: unknown;
};
type SyncSummary = {
    ok?: boolean;
    window?: JsonObject;
    sent?: RunSummary | null;
    discovery?: RunSummary | null;
    received?: RunSummary[];
    transport?: JsonObject;
    partial?: boolean;
    incomplete?: boolean;
    details?: RunSummary[];
};
type AdaptiveFairOptions = {
    receivedScopesPerCycle: number;
    adaptiveFairMin?: number;
    adaptiveFairMax?: number;
    adaptiveTargetCycleSeconds?: number;
    intervalSeconds?: number;
    stepTimeoutSeconds?: number;
};
type AdaptiveFairState = {
    batch: number;
    healthyCycles: number;
};
type AdaptiveCycleObservation = {
    ok: boolean;
    durationMs: number;
    steps?: WorkerEvent[];
};
declare function compactTransportCooldowns(input: unknown): Record<string, number>;
declare function mergeTransportCooldowns(previous: unknown, incoming: unknown, nowMs?: number): {
    [k: string]: number;
};
declare function compactTransportStats(input: unknown): JsonObject | null;
declare function createAdaptiveFairState(opts: AdaptiveFairOptions): AdaptiveFairState;
declare function adaptiveFairDecision(state: AdaptiveFairState, observation: AdaptiveCycleObservation, opts: AdaptiveFairOptions): {
    state: {
        batch: number;
        healthyCycles: number;
    };
    decision: {
        effective_batch: number;
        next_batch: number;
        reason: string;
        healthy_cycles: number;
        durations: {
            work_ms: number;
            interval_ms: number;
            target_cycle_ms: number;
            fair_ms: number | null;
            other_ms: number;
            fair_budget_ms: number;
            per_scope_ms: number | null;
        };
        observed_fair_scopes: number;
        pressure: {
            rate_limits: number;
            timeouts: number;
            exhausted: number;
            failed_steps: number;
        };
    };
};
type WorkerEvent = {
    type?: string;
    cycle?: number;
    name?: string;
    ok?: boolean;
    at?: string;
    started_at?: string;
    finished_at?: string;
    summary?: JsonObject | null;
    steps?: WorkerEvent[];
    exit_code?: number;
    stderr?: string;
    [key: string]: unknown;
};
type WorkerCyclePayload = {
    type: "lark_im_worker_cycle";
    cycle: number;
    ok: boolean;
    at: string;
    step_count: number;
    failed_steps: string[];
};
type WorkerStepRunner = (name: string, args: string[], command?: "sync" | "maintenance") => WorkerEvent;
type WorkerLogWriter = (opts: WorkerCycleOptions, payload: WorkerEvent | WorkerCyclePayload) => void;
declare function buildCycleStepSpecs(opts: WorkerCycleOptions, cycle?: number): WorkerStepSpec[];
declare function compactRun(run: RunSummary | null | undefined): {
    run_id: number | null | undefined;
    ok: boolean | undefined;
    scanned: number | undefined;
    records: number | undefined;
    inserted: number | undefined;
    updated: number | undefined;
    duplicate: number | undefined;
} | null;
declare function compactSummary(summary: SyncSummary | null | undefined): {
    window: JsonObject | undefined;
    sent: {
        run_id: number | null | undefined;
        ok: boolean | undefined;
        scanned: number | undefined;
        records: number | undefined;
        inserted: number | undefined;
        updated: number | undefined;
        duplicate: number | undefined;
    } | null;
    discovery: {
        [k: string]: string | number | boolean | null | undefined;
    } | null;
    received: {
        failed: number;
        failed_scope_ids: (string | undefined)[];
        pending_details?: number | undefined;
        incomplete?: boolean | undefined;
        skipped?: number | undefined;
        scopes: number;
        scanned: number;
        records: number;
        inserted: number;
        updated: number;
        duplicate: number;
        ok: boolean;
    } | null;
    transport?: JsonObject | null | undefined;
    details?: ({
        run_id: number | null | undefined;
        ok: boolean | undefined;
        scanned: number | undefined;
        records: number | undefined;
        inserted: number | undefined;
        updated: number | undefined;
        duplicate: number | undefined;
    } | null)[] | undefined;
    incomplete?: boolean | undefined;
    partial?: boolean | undefined;
    ok: boolean | undefined;
} | null;
declare function cyclePayload(cycle: number, steps: WorkerEvent[], now?: () => string): WorkerCyclePayload;
declare function runCycleWithRunner(opts: WorkerCycleOptions, cycle: number, runStep: WorkerStepRunner, writeLog: WorkerLogWriter, now?: () => string, onComplete?: (steps: WorkerEvent[], payload: WorkerCyclePayload) => void): boolean;
declare function summarizeWorkerEvents(events: unknown[], nowMs?: number): {
    has_events: boolean;
    last_event_type: string | null;
    last_event_at: string | null;
    last_event_age_ms: number | null;
    last_cycle: {
        cycle: number | undefined;
        ok: boolean;
        at: string | null;
        age_ms: number | null;
    } | null;
    last_step: {
        cycle: number | undefined;
        name: string | undefined;
        ok: boolean;
        at: string | null;
        age_ms: number | null;
    } | null;
    in_progress: boolean;
    unfinished_cycle: boolean;
    last_failure: {
        type: string | undefined;
        cycle: number | undefined;
        name: string;
        at: string | null;
        age_ms: number | null;
    } | null;
};
export { adaptiveFairDecision, buildCycleStepSpecs, compactRun, compactSummary, compactTransportCooldowns, compactTransportStats, createAdaptiveFairState, mergeTransportCooldowns, cyclePayload, runCycleWithRunner, summarizeWorkerEvents, };
