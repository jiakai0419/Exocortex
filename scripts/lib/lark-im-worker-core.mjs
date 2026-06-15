// @ts-check

/**
 * @typedef {object} WorkerCycleOptions
 * @property {string} db
 * @property {number} hotDiscoveryPagesPerCycle
 * @property {number} hotReceivedScopesPerCycle
 * @property {number} discoveryPagesPerCycle
 * @property {number} receivedScopesPerCycle
 * @property {number} maxChatPages
 * @property {number} reconcileIntervalHours
 *
 * @typedef {object} WorkerStepSpec
 * @property {string} name
 * @property {string[]} args
 *
 * @typedef {object} RunSummary
 * @property {number | null=} run_id
 * @property {boolean=} ok
 * @property {number=} scanned
 * @property {number=} records
 * @property {number=} inserted
 * @property {number=} updated
 * @property {number=} duplicate
 * @property {string=} scope_id
 * @property {string=} mode
 * @property {number=} pages
 * @property {number=} discovered_in_run
 * @property {boolean=} has_more
 * @property {string=} snapshot_id
 * @property {boolean=} skipped
 * @property {string=} reason
 *
 * @typedef {object} SyncSummary
 * @property {boolean=} ok
 * @property {Record<string, any>=} window
 * @property {RunSummary | null=} sent
 * @property {RunSummary | null=} discovery
 * @property {RunSummary[]=} received
 *
 * @typedef {object} ReceivedTotals
 * @property {number} scopes
 * @property {number} scanned
 * @property {number} records
 * @property {number} inserted
 * @property {number} updated
 * @property {number} duplicate
 *
 * @typedef {object} WorkerEvent
 * @property {string=} type
 * @property {number=} cycle
 * @property {string=} name
 * @property {boolean=} ok
 * @property {string=} at
 * @property {string=} started_at
 * @property {string=} finished_at
 * @property {RunSummary | null=} summary
 * @property {WorkerEvent[]=} steps
 * @property {number=} exit_code
 * @property {string=} stderr
 *
 * @typedef {object} WorkerCyclePayload
 * @property {"lark_im_worker_cycle"} type
 * @property {number} cycle
 * @property {boolean} ok
 * @property {string} at
 * @property {WorkerEvent[]} steps
 *
 * @typedef {(name: string, args: string[]) => WorkerEvent} WorkerStepRunner
 * @typedef {(opts: WorkerCycleOptions, payload: WorkerEvent | WorkerCyclePayload) => void} WorkerLogWriter
 */

/** @param {WorkerCycleOptions} opts */
function buildCycleStepSpecs(opts) {
  return [
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
      ],
    },
    {
      name: "received-catchup",
      args: [
        "--db",
        opts.db,
        "--scope",
        "received",
        "--received-mode",
        "catchup",
        "--received-scopes-per-run",
        String(opts.receivedScopesPerCycle),
      ],
    },
  ];
}

/** @param {RunSummary | null | undefined} run */
function compactRun(run) {
  if (!run) return null;
  return {
    run_id: run.run_id,
    ok: run.ok,
    scanned: run.scanned,
    records: run.records,
    inserted: run.inserted,
    updated: run.updated,
    duplicate: run.duplicate,
  };
}

/** @param {SyncSummary | null | undefined} summary */
function compactSummary(summary) {
  if (!summary) return null;

  const received = Array.isArray(summary.received) ? summary.received : [];
  const receivedFailures = received.filter((run) => !run.ok);
  /** @type {ReceivedTotals} */
  const initialReceivedTotals = { scopes: 0, scanned: 0, records: 0, inserted: 0, updated: 0, duplicate: 0 };
  const receivedTotals = received.reduce(
    (totals, run) => ({
      scopes: totals.scopes + 1,
      scanned: totals.scanned + (run.scanned || 0),
      records: totals.records + (run.records || 0),
      inserted: totals.inserted + (run.inserted || 0),
      updated: totals.updated + (run.updated || 0),
      duplicate: totals.duplicate + (run.duplicate || 0),
    }),
    initialReceivedTotals,
  );

  return {
    ok: summary.ok,
    window: summary.window,
    sent: compactRun(summary.sent),
    discovery: summary.discovery
      ? Object.fromEntries(
          Object.entries({
            run_id: summary.discovery.run_id,
            ok: summary.discovery.ok,
            mode: summary.discovery.mode,
            pages: summary.discovery.pages,
            discovered_in_run: summary.discovery.discovered_in_run,
            has_more: summary.discovery.has_more,
            snapshot_id: summary.discovery.snapshot_id,
            skipped: summary.discovery.skipped,
            reason: summary.discovery.reason,
          }).filter(([, value]) => value !== undefined),
        )
      : null,
    received:
      received.length > 0
        ? {
            ok: receivedFailures.length === 0,
            ...receivedTotals,
            failed: receivedFailures.length,
            failed_scope_ids: receivedFailures.slice(0, 5).map((run) => run.scope_id),
          }
        : null,
  };
}

/**
 * @param {number} cycle
 * @param {WorkerEvent[]} steps
 * @param {() => string} [now]
 * @returns {WorkerCyclePayload}
 */
function cyclePayload(cycle, steps, now = () => new Date().toISOString()) {
  return {
    type: "lark_im_worker_cycle",
    cycle,
    ok: steps.every((step) => step.ok),
    at: now(),
    steps,
  };
}

/**
 * @param {WorkerCycleOptions} opts
 * @param {number} cycle
 * @param {WorkerStepRunner} runStep
 * @param {WorkerLogWriter} writeLog
 * @param {() => string} [now]
 */
function runCycleWithRunner(opts, cycle, runStep, writeLog, now = () => new Date().toISOString()) {
  const steps = [];
  for (const spec of buildCycleStepSpecs(opts)) {
    const step = runStep(spec.name, spec.args);
    steps.push(step);
    writeLog(opts, { type: "lark_im_worker_step", cycle, ...step });
  }
  const payload = cyclePayload(cycle, steps, now);
  writeLog(opts, payload);
  return payload.ok;
}

/** @param {WorkerEvent | null | undefined} event */
function eventTimeMs(event) {
  const value = event?.at || event?.finished_at || event?.started_at || "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** @param {WorkerEvent | null | undefined} event */
function eventTimeIso(event) {
  const ms = eventTimeMs(event);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * @param {WorkerEvent[]} events
 * @param {(event: WorkerEvent) => boolean} [predicate]
 */
function latestEvent(events, predicate = () => true) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (predicate(events[i])) return events[i];
  }
  return null;
}

/**
 * @param {unknown[]} events
 * @param {number} [nowMs]
 */
function summarizeWorkerEvents(events, nowMs = Date.now()) {
  const normalized = /** @type {WorkerEvent[]} */ (
    (events || []).filter((event) => event && typeof event === "object")
  );
  const lastEvent = latestEvent(normalized, (event) => Boolean(event.type));
  const lastCycle = latestEvent(normalized, (event) => event.type === "lark_im_worker_cycle");
  const lastStep = latestEvent(normalized, (event) => event.type === "lark_im_worker_step");
  const lastFailure = latestEvent(normalized, (event) => event.ok === false);
  const lastEventMs = eventTimeMs(lastEvent);
  const lastCycleMs = eventTimeMs(lastCycle);
  const lastStepMs = eventTimeMs(lastStep);
  const lastFailureMs = eventTimeMs(lastFailure);
  const stepAfterCycle =
    lastStep &&
    (!lastCycle ||
      Number(lastStep.cycle) > Number(lastCycle.cycle) ||
      (lastStepMs !== null && lastCycleMs !== null && lastStepMs > lastCycleMs));

  return {
    has_events: normalized.length > 0,
    last_event_type: lastEvent?.type || null,
    last_event_at: eventTimeIso(lastEvent),
    last_event_age_ms: lastEventMs === null ? null : Math.max(0, nowMs - lastEventMs),
    last_cycle: lastCycle
      ? {
          cycle: lastCycle.cycle,
          ok: Boolean(lastCycle.ok),
          at: eventTimeIso(lastCycle),
          age_ms: lastCycleMs === null ? null : Math.max(0, nowMs - lastCycleMs),
        }
      : null,
    last_step: lastStep
      ? {
          cycle: lastStep.cycle,
          name: lastStep.name,
          ok: Boolean(lastStep.ok),
          at: eventTimeIso(lastStep),
          age_ms: lastStepMs === null ? null : Math.max(0, nowMs - lastStepMs),
        }
      : null,
    in_progress: Boolean(stepAfterCycle),
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

export {
  buildCycleStepSpecs,
  compactRun,
  compactSummary,
  cyclePayload,
  runCycleWithRunner,
  summarizeWorkerEvents,
};
