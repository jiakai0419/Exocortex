import { WORKER_DEFAULTS } from "./options.mjs";
const TRANSPORT_COUNTERS = [
    "calls", "attempts", "retries", "rate_limits", "timeouts", "wait_ms",
    "max_retry_after_ms", "cooldown_until_ms", "exhausted",
    "retry_after_unknown",
];
// Operation names must describe API classes, never chat/user identifiers.
const TRANSPORT_OPERATIONS = new Set([
    "message_history_bundle", "message_search_bundle", "chat_discovery_bundle",
    "self_profile", "contact_search", "chat_members", "chat_bots", "application_info", "other",
]);
const REQUIRED_CYCLE_STEPS = [
    "sent", "discover-hot", "received-hot", "discover-catchup", "discover-reconcile", "received-fair",
];
function stepHealthy(step) {
    return step.ok === true && step.summary?.received?.ok !== false &&
        step.summary?.sent?.ok !== false && step.summary?.discovery?.ok !== false;
}
/** Optional maintenance has its own outcome. Its business debt cannot stand in
 * for evidence that a forward step failed. Without receipts, keep the caller's
 * conservative legacy cycle result. */
function cycleHealthyWithoutHistory(steps, fallback) {
    return steps === undefined ? fallback : REQUIRED_CYCLE_STEPS.every(name => steps.some(step => step.name === name && stepHealthy(step))) &&
        steps.every(step => step.name === "history" || stepHealthy(step));
}
/** Version the added history slice so old six-step receipts are still readable. */
function expectedCycleSteps(event) {
    if (event.cycle_policy !== undefined && event.cycle_policy !== "bounded_history/v1")
        return null;
    const base = event.cycle_policy === "bounded_history/v1" ? [...REQUIRED_CYCLE_STEPS, "history"] : REQUIRED_CYCLE_STEPS;
    if (event.step_count === base.length)
        return base;
    if (event.step_count === base.length + 1)
        return [...base, "retention"];
    return null;
}
function finiteNonNegative(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : 0;
}
function hasTransportObservation(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return false;
    const stats = input;
    return ["calls", "attempts", "rate_limits", "timeouts", "exhausted"].every((field) => typeof stats[field] === "number" && Number.isFinite(stats[field]) &&
        stats[field] >= 0 && stats[field] <= Number.MAX_SAFE_INTEGER);
}
function compactTransportCooldowns(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return {};
    return Object.fromEntries(Object.entries(input).filter(([operation, value]) => TRANSPORT_OPERATIONS.has(operation) && typeof value === "number" &&
        Number.isSafeInteger(value) && value >= 0));
}
function mergeTransportCooldowns(previous, incoming, nowMs = Date.now()) {
    const result = compactTransportCooldowns(previous);
    for (const [operation, untilMs] of Object.entries(compactTransportCooldowns(incoming))) {
        result[operation] = Math.max(result[operation] || 0, untilMs);
    }
    return Object.fromEntries(Object.entries(result).filter(([, untilMs]) => untilMs > nowMs));
}
function compactTransportStats(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return null;
    const stats = input;
    const result = Object.fromEntries(TRANSPORT_COUNTERS.filter((field) => typeof stats[field] === "number" && Number.isFinite(stats[field]) &&
        stats[field] >= 0 && stats[field] <= Number.MAX_SAFE_INTEGER)
        .map((field) => [field, stats[field]]));
    result.cooldowns_by_operation = compactTransportCooldowns(stats.cooldowns_by_operation);
    if (stats.by_operation && typeof stats.by_operation === "object" && !Array.isArray(stats.by_operation)) {
        result.by_operation = Object.fromEntries(Object.entries(stats.by_operation)
            .filter(([operation, values]) => TRANSPORT_OPERATIONS.has(operation) && values && typeof values === "object" && !Array.isArray(values))
            .map(([operation, values]) => [operation, Object.fromEntries(TRANSPORT_COUNTERS.filter((field) => typeof values[field] === "number" &&
                Number.isFinite(values[field]) && values[field] >= 0 &&
                values[field] <= Number.MAX_SAFE_INTEGER)
                .map((field) => [field, values[field]]))]));
    }
    return result;
}
function createAdaptiveFairState(opts) {
    const min = opts.adaptiveFairMin ?? WORKER_DEFAULTS.adaptiveFairMin;
    const max = opts.adaptiveFairMax ?? WORKER_DEFAULTS.adaptiveFairMax;
    return { batch: Math.max(min, Math.min(max, opts.receivedScopesPerCycle)), healthyCycles: 0 };
}
function adaptiveFairDecision(state, observation, opts) {
    const min = opts.adaptiveFairMin ?? WORKER_DEFAULTS.adaptiveFairMin;
    const max = opts.adaptiveFairMax ?? WORKER_DEFAULTS.adaptiveFairMax;
    const steps = observation.steps || [];
    const complete = REQUIRED_CYCLE_STEPS.every((name) => steps.some((step) => step.name === name && step.ok === true && hasTransportObservation(step.summary?.transport)));
    const fair = steps.find((step) => step.name === "received-fair");
    const startMs = Date.parse(String(fair?.started_at || ""));
    const finishMs = Date.parse(String(fair?.finished_at || ""));
    const fairMs = Number.isFinite(startMs) && Number.isFinite(finishMs) && finishMs > startMs
        ? finishMs - startMs : null;
    const scopes = Math.max(0, finiteNonNegative(fair?.summary?.received?.scopes) -
        finiteNonNegative(fair?.summary?.received?.skipped));
    const cycleMs = finiteNonNegative(observation.durationMs);
    const intervalMs = (opts.intervalSeconds ?? WORKER_DEFAULTS.intervalSeconds) * 1000;
    const targetMs = (opts.adaptiveTargetCycleSeconds ?? WORKER_DEFAULTS.adaptiveTargetCycleSeconds) * 1000;
    const historyMs = Math.min(cycleMs, steps.filter(step => step.name === "history").reduce((total, step) => {
        const start = Date.parse(String(step.started_at || "")), end = Date.parse(String(step.finished_at || ""));
        return total + (Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0);
    }, 0));
    // The fair batch models forward work. A bounded optional history slice is
    // measured separately, not charged as a throughput regression of that batch.
    const forwardMs = Math.max(0, cycleMs - historyMs);
    const otherMs = fairMs === null ? forwardMs : Math.max(0, forwardMs - fairMs);
    const fairBudgetMs = Math.max(0, Math.min(targetMs - intervalMs - otherMs, (opts.stepTimeoutSeconds ?? WORKER_DEFAULTS.stepTimeoutSeconds) * 1000 * 0.8));
    const perScopeMs = fairMs !== null && scopes > 0 ? fairMs / scopes : null;
    const budgetBatch = perScopeMs === null ? null : Math.max(min, Math.min(max, Math.floor(fairBudgetMs / perScopeMs)));
    const pressure = { rate_limits: 0, timeouts: 0, exhausted: 0, failed_steps: 0 };
    for (const step of steps) {
        const transport = compactTransportStats(step.summary?.transport);
        for (const field of ["rate_limits", "timeouts", "exhausted"]) {
            const operationTotal = Object.values(transport?.by_operation || {})
                .reduce((total, values) => total + finiteNonNegative(values[field]), 0);
            // The aggregate normally includes each operation. Do not double count,
            // but retain pressure when only operation counters were available.
            pressure[field] += Math.max(transport?.[field] || 0, operationTotal);
        }
        if (step.name === "history" && ["rate_limited", "rate_cooldown"].includes(step.summary?.request_budget?.stop_reason)
            && !Math.max(transport?.rate_limits || 0, Object.values(transport?.by_operation || {}).reduce((total, values) => total + finiteNonNegative(values.rate_limits), 0))) {
            // Maintenance has a smaller public budget receipt than sync. A real
            // shared rate stop is still pressure, even without transport counters.
            pressure.rate_limits += 1;
        }
        if (step.name !== "history" && !stepHealthy(step)) {
            pressure.failed_steps += 1;
        }
    }
    let next = state.batch;
    let healthyCycles = 0;
    let reason = "insufficient_observation";
    if ((!steps.length && !observation.ok) || pressure.failed_steps > 0 || pressure.rate_limits > 0 || pressure.timeouts > 0 || pressure.exhausted > 0) {
        next = Math.max(min, Math.floor(state.batch / 2));
        reason = "transport_or_step_pressure";
    }
    else if (complete && fair?.ok === true && fair?.summary?.received?.ok === true && perScopeMs !== null) {
        // A partial queue overweights fixed costs per scope. It cannot establish
        // the cost of a full batch; resizing it also cannot reduce its actual work.
        if (scopes < state.batch) {
            reason = "partial_batch";
        }
        else if (budgetBatch !== null && budgetBatch < state.batch) {
            next = budgetBatch;
            reason = "cycle_budget";
        }
        else {
            healthyCycles = state.healthyCycles + 1;
            if (healthyCycles >= 2) {
                next = Math.min(max, state.batch + 5, budgetBatch ?? state.batch);
                reason = next > state.batch ? "healthy_additive_increase" : "at_budget_or_max";
                healthyCycles = 0;
            }
            else {
                reason = "await_second_healthy_cycle";
            }
        }
    }
    return {
        state: { batch: next, healthyCycles },
        decision: {
            effective_batch: state.batch,
            next_batch: next,
            reason,
            healthy_cycles: healthyCycles,
            durations: { work_ms: cycleMs, ...(historyMs > 0 ? { history_ms: historyMs, forward_work_ms: forwardMs } : {}),
                interval_ms: intervalMs, target_cycle_ms: targetMs, fair_ms: fairMs, other_ms: otherMs, fair_budget_ms: fairBudgetMs, per_scope_ms: perScopeMs },
            observed_fair_scopes: scopes,
            pressure,
        },
    };
}
function buildCycleStepSpecs(opts, cycle = 1) {
    const chatTypes = opts.chatTypes || WORKER_DEFAULTS.chatTypes;
    const steps = [
        {
            name: "sent",
            args: ["--db", opts.db, "--scope", "sent"],
        },
        {
            name: "discover-hot",
            args: [
                "--db",
                opts.db,
                "--scope",
                "discover",
                "--discovery-mode",
                "hot",
                "--discovery-pages-per-run",
                String(opts.hotDiscoveryPagesPerCycle),
                "--max-chat-pages",
                String(opts.maxChatPages),
                "--chat-types",
                chatTypes,
            ],
        },
        {
            name: "received-hot",
            args: [
                "--db",
                opts.db,
                "--scope",
                "received",
                "--received-mode",
                "hot",
                "--received-scopes-per-run",
                String(opts.hotReceivedScopesPerCycle),
            ],
        },
        {
            name: "discover-catchup",
            args: [
                "--db",
                opts.db,
                "--scope",
                "discover",
                "--discovery-mode",
                "cursor",
                "--discovery-pages-per-run",
                String(opts.discoveryPagesPerCycle),
                "--max-chat-pages",
                String(opts.maxChatPages),
                "--chat-types",
                chatTypes,
            ],
        },
        {
            name: "discover-reconcile",
            args: [
                "--db",
                opts.db,
                "--scope",
                "discover",
                "--discovery-mode",
                "reconcile",
                "--discovery-pages-per-run",
                String(opts.discoveryPagesPerCycle),
                "--max-chat-pages",
                String(opts.maxChatPages),
                "--reconcile-interval-hours",
                String(opts.reconcileIntervalHours),
                "--chat-types",
                chatTypes,
            ],
        },
        {
            name: "received-fair",
            args: [
                "--db",
                opts.db,
                "--scope",
                "received",
                "--received-mode",
                "all",
                "--received-scopes-per-run",
                String(opts.receivedScopesPerCycle),
            ],
        },
    ];
    steps.push({ name: "history", command: "maintenance",
        args: ["history", "--db", opts.db, "--max-cli-attempts", "4", "--max-seconds", "30", "--format", "json"] });
    const retentionEveryCycles = Number(opts.retentionEveryCycles || WORKER_DEFAULTS.retentionEveryCycles);
    if (retentionEveryCycles > 0 && cycle % retentionEveryCycles === 0) {
        steps.push({
            name: "retention",
            command: "maintenance",
            args: ["prune-runs", "--db", opts.db, "--apply", "--format", "json"],
        });
    }
    return steps;
}
function compactRun(run) {
    if (!run)
        return null;
    return {
        run_id: run.run_id,
        ok: run.ok,
        scanned: run.scanned,
        records: run.records,
        inserted: run.inserted,
        updated: run.updated,
        duplicate: run.duplicate,
        ...Object.fromEntries(["list_complete", "details_complete", "incomplete", "pending_details", "detail_attempts", "conflicts"]
            .filter((key) => run[key] !== undefined).map((key) => [key, run[key]])),
    };
}
function compactSummary(summary) {
    if (!summary)
        return null;
    const received = Array.isArray(summary.received) ? summary.received : [];
    const receivedFailures = received.filter((run) => run.ok === false || (!run.ok && !run.skipped));
    const receivedSkipped = received.filter((run) => run.skipped === true).length;
    const initialReceivedTotals = { scopes: 0, scanned: 0, records: 0, inserted: 0, updated: 0, duplicate: 0 };
    const receivedTotals = received.reduce((totals, run) => ({
        scopes: totals.scopes + 1,
        scanned: totals.scanned + (run.scanned || 0),
        records: totals.records + (run.records || 0),
        inserted: totals.inserted + (run.inserted || 0),
        updated: totals.updated + (run.updated || 0),
        duplicate: totals.duplicate + (run.duplicate || 0),
    }), initialReceivedTotals);
    return {
        ok: summary.ok,
        ...(summary.partial ? { partial: true } : {}),
        ...(summary.incomplete ? { incomplete: true } : {}),
        ...(summary.details ? { details: summary.details.map(compactRun) } : {}),
        ...(summary.transport ? { transport: compactTransportStats(summary.transport) } : {}),
        window: summary.window,
        sent: compactRun(summary.sent),
        discovery: summary.discovery
            ? Object.fromEntries(Object.entries({
                run_id: summary.discovery.run_id,
                ok: summary.discovery.ok,
                mode: summary.discovery.mode,
                pages: summary.discovery.pages,
                discovered_in_run: summary.discovery.discovered_in_run,
                has_more: summary.discovery.has_more,
                snapshot_id: summary.discovery.snapshot_id,
                skipped: summary.discovery.skipped,
                reason: summary.discovery.reason,
            }).filter(([, value]) => value !== undefined))
            : null,
        received: received.length > 0
            ? {
                ok: receivedFailures.length === 0,
                ...receivedTotals,
                ...(received.some(run => Number(run.conflicts) > 0) ? { conflicts: received.reduce((sum, run) => sum + finiteNonNegative(run.conflicts), 0) } : {}),
                ...(receivedSkipped > 0 ? { skipped: receivedSkipped } : {}),
                ...(received.some((run) => run.pending_details !== undefined) ? {
                    pending_details: received.reduce((sum, run) => sum + finiteNonNegative(run.pending_details), 0),
                    incomplete: received.some((run) => run.incomplete === true),
                } : {}),
                failed: receivedFailures.length,
                failed_scope_ids: receivedFailures.slice(0, 5).map((run) => run.scope_id),
            }
            : null,
    };
}
const HISTORY_OUTCOMES = new Set(["no_eligible_known_record", "processed", "pending_observation",
    "incomplete", "size_limit", "identity", "ambiguous", "missing", "fetch_unavailable"]);
const REQUEST_STOP_REASONS = new Set(["cli_budget", "time_budget", "clock_unavailable", "sync_busy", "lease_unavailable",
    "rate_cooldown", "rate_limited", "shared_cooldown_unavailable"]);
/** Strict public projection: never copy record IDs, raw/error payloads, arbitrary
 * reasons or unknown nested fields into the worker's history receipt. */
function compactHistorySummary(summary) {
    if (!summary || typeof summary !== "object" || Array.isArray(summary))
        return null;
    const budget = summary.request_budget;
    const result = { ok: summary.ok === true };
    if (summary.profile === "known_record_history/v1")
        result.profile = summary.profile;
    if (HISTORY_OUTCOMES.has(summary.outcome || ""))
        result.outcome = summary.outcome;
    if (summary.cursor_policy === "unchanged")
        result.cursor_policy = "unchanged";
    if (summary.coverage === "known_rows_only")
        result.coverage = "known_rows_only";
    const error = summary.error;
    if (summary.schema_version === 1 && error && ["invalid_arguments", "execution_failed"].includes(error.code))
        result.reason = error.code;
    for (const field of ["inserted", "updated", "duplicate", "conflicts"]) {
        if (typeof summary[field] === "number" && Number.isSafeInteger(summary[field]) && Number(summary[field]) >= 0)
            result[field] = summary[field];
    }
    if (budget && typeof budget === "object" && !Array.isArray(budget)) {
        result.request_budget = Object.fromEntries(["max_cli_attempts", "cli_attempts", "max_seconds", "min_interval_ms", "elapsed_ms"]
            .filter(field => typeof budget[field] === "number" && Number.isSafeInteger(budget[field]) && budget[field] >= 0)
            .map(field => [field, budget[field]]));
        if (budget.stop_reason === null || REQUEST_STOP_REASONS.has(budget.stop_reason))
            result.request_budget.stop_reason = budget.stop_reason;
    }
    return result;
}
function cyclePayload(cycle, steps, now = () => new Date().toISOString()) {
    return {
        type: "lark_im_worker_cycle",
        cycle,
        ok: steps.length > 0 && steps.every((step) => step.ok === true),
        at: now(),
        step_count: steps.length,
        ...(steps.some(step => step.name === "history") ? { cycle_policy: "bounded_history/v1" } : {}),
        failed_steps: steps.filter((step) => step.ok !== true).map((step) => step.name || "unknown"),
    };
}
function runCycleWithRunner(opts, cycle, runStep, writeLog, now = () => new Date().toISOString(), onComplete) {
    const steps = [];
    for (const spec of buildCycleStepSpecs(opts, cycle)) {
        const step = runStep(spec.name, spec.args, spec.command || "sync");
        steps.push(step);
        writeLog(opts, { ...step, type: "lark_im_worker_step", cycle, step_index: steps.length - 1 });
    }
    const payload = cyclePayload(cycle, steps, now);
    writeLog(opts, payload);
    onComplete?.(steps, payload);
    return payload.ok;
}
function eventTimeMs(event) {
    const value = event?.at || event?.finished_at || event?.started_at || "";
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function eventTimeIso(event) {
    const ms = eventTimeMs(event);
    return ms === null ? null : new Date(ms).toISOString();
}
function latestEvent(events, predicate = () => true) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
        if (predicate(events[i]))
            return events[i];
    }
    return null;
}
function summarizeWorkerEvents(events, nowMs = Date.now()) {
    const normalized = (events || []).filter((event) => event && typeof event === "object");
    const lastEvent = latestEvent(normalized, (event) => Boolean(event.type));
    const lastCycle = latestEvent(normalized, (event) => event.type === "lark_im_worker_cycle");
    const lastStep = latestEvent(normalized, (event) => event.type === "lark_im_worker_step");
    const lastFailure = latestEvent(normalized, (event) => event.ok === false);
    const lastEventMs = eventTimeMs(lastEvent);
    const lastCycleMs = eventTimeMs(lastCycle);
    const lastStepMs = eventTimeMs(lastStep);
    const lastFailureMs = eventTimeMs(lastFailure);
    // Cycle counters restart with the worker. Append order, not the largest
    // cycle number, determines whether its latest step still lacks a completion.
    const stepAfterCycle = Boolean(lastStep && (!lastCycle || normalized.lastIndexOf(lastStep) > normalized.lastIndexOf(lastCycle)));
    return {
        has_events: normalized.length > 0,
        last_event_type: lastEvent?.type || null,
        last_event_at: eventTimeIso(lastEvent),
        last_event_age_ms: lastEventMs === null ? null : Math.max(0, nowMs - lastEventMs),
        last_cycle: lastCycle
            ? {
                cycle: lastCycle.cycle,
                ok: lastCycle.ok === true,
                at: eventTimeIso(lastCycle),
                age_ms: lastCycleMs === null ? null : Math.max(0, nowMs - lastCycleMs),
            }
            : null,
        last_step: lastStep
            ? {
                cycle: lastStep.cycle,
                name: lastStep.name,
                ok: lastStep.ok === true,
                at: eventTimeIso(lastStep),
                age_ms: lastStepMs === null ? null : Math.max(0, nowMs - lastStepMs),
            }
            : null,
        // These events are written after each step has finished. Even a recent
        // unfinished cycle cannot prove another step is running. Live activity is
        // established separately by a current database lease in the service report.
        in_progress: false,
        unfinished_cycle: stepAfterCycle,
        last_failure: lastFailure
            ? {
                type: lastFailure.type,
                cycle: lastFailure.cycle,
                name: lastFailure.name || "cycle",
                at: eventTimeIso(lastFailure),
                age_ms: lastFailureMs === null ? null : Math.max(0, nowMs - lastFailureMs),
            }
            : null,
    };
}
export { REQUIRED_CYCLE_STEPS, expectedCycleSteps, adaptiveFairDecision, buildCycleStepSpecs, compactRun, compactSummary, compactHistorySummary, compactTransportCooldowns, compactTransportStats, createAdaptiveFairState, mergeTransportCooldowns, cyclePayload, cycleHealthyWithoutHistory, runCycleWithRunner, summarizeWorkerEvents, };
