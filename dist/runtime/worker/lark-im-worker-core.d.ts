type JsonObject = Record<string, any>;
type WorkerCycleOptions = {
    db: string;
    hotDiscoveryPagesPerCycle: number;
    hotReceivedScopesPerCycle: number;
    discoveryPagesPerCycle: number;
    receivedScopesPerCycle: number;
    maxChatPages: number;
    reconcileIntervalHours: number;
    chatTypes?: string;
    logDir?: string;
};
type WorkerStepSpec = {
    name: string;
    args: string[];
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
};
type WorkerEvent = {
    type?: string;
    cycle?: number;
    name?: string;
    ok?: boolean;
    at?: string;
    started_at?: string;
    finished_at?: string;
    summary?: RunSummary | null;
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
    steps: WorkerEvent[];
};
type WorkerStepRunner = (name: string, args: string[]) => WorkerEvent;
type WorkerLogWriter = (opts: WorkerCycleOptions, payload: WorkerEvent | WorkerCyclePayload) => void;
declare function buildCycleStepSpecs(opts: WorkerCycleOptions): WorkerStepSpec[];
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
    ok: boolean | undefined;
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
        scopes: number;
        scanned: number;
        records: number;
        inserted: number;
        updated: number;
        duplicate: number;
        ok: boolean;
    } | null;
} | null;
declare function cyclePayload(cycle: number, steps: WorkerEvent[], now?: () => string): WorkerCyclePayload;
declare function runCycleWithRunner(opts: WorkerCycleOptions, cycle: number, runStep: WorkerStepRunner, writeLog: WorkerLogWriter, now?: () => string): boolean;
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
    last_failure: {
        type: string | undefined;
        cycle: number | undefined;
        name: string;
        at: string | null;
        age_ms: number | null;
    } | null;
};
export { buildCycleStepSpecs, compactRun, compactSummary, cyclePayload, runCycleWithRunner, summarizeWorkerEvents, };
