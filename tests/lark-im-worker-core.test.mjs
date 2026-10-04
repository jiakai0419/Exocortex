import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptiveFairDecision,
  buildCycleStepSpecs,
  compactSummary,
  compactTransportStats,
  createAdaptiveFairState,
  mergeTransportCooldowns,
  runCycleWithRunner,
  summarizeWorkerEvents,
} from "../dist/runtime/worker/lark-im-worker-core.js";
import { summarizeWorkerEvents as shimSummarizeWorkerEvents } from "../scripts/lib/lark-im-worker-core.mjs";

function opts(overrides = {}) {
  return {
    db: "data/test.sqlite",
    hotDiscoveryPagesPerCycle: 5,
    hotReceivedScopesPerCycle: 20,
    discoveryPagesPerCycle: 1,
    receivedScopesPerCycle: 50,
    maxChatPages: 300,
    reconcileIntervalHours: 24,
    chatTypes: "group,p2p",
    ...overrides,
  };
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function adaptiveOpts(overrides = {}) {
  return opts({ receivedScopesPerCycle: 25, adaptiveFairMin: 10, adaptiveFairMax: 50,
    adaptiveTargetCycleSeconds: 90, intervalSeconds: 30, stepTimeoutSeconds: 600, ...overrides });
}

function observation({ scopes = 25, fairMs = 20_000, otherMs = 10_000, transport, ok = true } = {}) {
  const emptyStats = { calls: 0, attempts: 0, rate_limits: 0, timeouts: 0, exhausted: 0 };
  const steps = buildCycleStepSpecs(opts()).map(({ name }) => ({ name, ok: true, summary: { transport: { ...emptyStats } } }));
  Object.assign(steps.at(-1), {
    ok,
    started_at: new Date(0).toISOString(),
    finished_at: new Date(fairMs).toISOString(),
    summary: { received: { ok, scopes }, transport: { ...emptyStats, ...transport } },
  });
  return { ok, durationMs: fairMs + otherMs, steps };
}

test("adaptive fair requires two complete healthy batches before additive growth", () => {
  const options = adaptiveOpts();
  let state = createAdaptiveFairState(options);
  const first = adaptiveFairDecision(state, observation(), options);
  assert.deepEqual(first.state, { batch: 25, healthyCycles: 1 });
  assert.equal(first.decision.reason, "await_second_healthy_cycle");
  const second = adaptiveFairDecision(first.state, observation(), options);
  assert.deepEqual(second.state, { batch: 30, healthyCycles: 0 });
  assert.equal(second.decision.reason, "healthy_additive_increase");

  const incomplete = observation();
  incomplete.steps.shift();
  assert.equal(adaptiveFairDecision(first.state, incomplete, options).decision.reason, "insufficient_observation");
  assert.equal(adaptiveFairDecision(first.state, observation({ scopes: 3 }), options).decision.reason, "partial_batch");
  assert.deepEqual(adaptiveFairDecision(first.state, observation({ scopes: 3, fairMs: 120_000 }), options).state,
    { batch: 25, healthyCycles: 0 });
  assert.equal(adaptiveFairDecision(first.state, observation({ fairMs: 0 }), options).state.healthyCycles, 0);
  const missingStats = observation();
  delete missingStats.steps[0].summary.transport;
  assert.deepEqual(adaptiveFairDecision(first.state, missingStats, options).state, { batch: 25, healthyCycles: 0 });
  const missingSlowStats = observation({ fairMs: 120_000 });
  delete missingSlowStats.steps[0].summary.transport;
  assert.deepEqual(adaptiveFairDecision(first.state, missingSlowStats, options).state, { batch: 25, healthyCycles: 0 });
  const incompleteStats = observation();
  incompleteStats.steps[0].summary.transport = compactTransportStats({ calls: 1 });
  assert.equal(adaptiveFairDecision(first.state, incompleteStats, options).decision.reason, "insufficient_observation");
  assert.equal(adaptiveFairDecision({ batch: 50, healthyCycles: 1 }, observation({ scopes: 50 }), options).state.batch, 50);
});

test("adaptive fair includes interval and non-fair time in its measured cycle budget", () => {
  const options = adaptiveOpts();
  const state = createAdaptiveFairState(options);
  const slow = adaptiveFairDecision(state, observation({ fairMs: 50_000, otherMs: 20_000 }), options);
  assert.equal(slow.decision.reason, "cycle_budget");
  assert.equal(slow.state.batch, 20);
  assert.deepEqual(slow.decision.durations, { work_ms: 70_000, interval_ms: 30_000, target_cycle_ms: 90_000,
    fair_ms: 50_000, other_ms: 20_000, fair_budget_ms: 40_000, per_scope_ms: 2_000 });
  const timeoutBudget = adaptiveFairDecision(state, observation({ fairMs: 25_000, otherMs: 1_000 }), adaptiveOpts({ stepTimeoutSeconds: 20 }));
  assert.equal(timeoutBudget.state.batch, 16);
});

test("adaptive fair never treats locked or skipped scopes as successful throughput", () => {
  const options = adaptiveOpts();
  for (const skippedCount of [1, 25]) {
    const skipped = observation();
    const runs = Array.from({ length: 25 }, (_, index) => index < skippedCount
      ? { skipped: true, reason: "scope_locked" } : { ok: true });
    skipped.steps.at(-1).summary.received = compactSummary({ ok: true, received: runs }).received;
    const result = adaptiveFairDecision({ batch: 25, healthyCycles: 1 }, skipped, options);
    assert.deepEqual(result.state, { batch: 25, healthyCycles: 0 });
    assert.equal(result.decision.pressure.failed_steps, 0);
    assert.equal(result.decision.observed_fair_scopes, 25 - skippedCount);
  }
  const permittedSkip = observation();
  permittedSkip.steps.at(-1).summary.received = compactSummary({ ok: true,
    received: Array.from({ length: 25 }, () => ({ ok: true, skipped: true, reason: "restricted_mode" })),
  }).received;
  assert.deepEqual(adaptiveFairDecision({ batch: 25, healthyCycles: 1 }, permittedSkip, options).state,
    { batch: 25, healthyCycles: 0 });
});

test("adaptive fair halves after recovered rate limits, timeout, exhaustion, or step failure and resets recovery", () => {
  const options = adaptiveOpts();
  for (const field of ["rate_limits", "timeouts", "exhausted"]) {
    const result = adaptiveFairDecision({ batch: 25, healthyCycles: 1 }, observation({ transport: { [field]: 1 } }), options);
    assert.deepEqual(result.state, { batch: 12, healthyCycles: 0 });
    assert.equal(result.decision.reason, "transport_or_step_pressure");
    assert.equal(result.decision.pressure[field], 1);
  }
  const failed = adaptiveFairDecision({ batch: 12, healthyCycles: 1 }, observation({ ok: false }), options);
  assert.deepEqual(failed.state, { batch: 10, healthyCycles: 0 });
  const hotPressure = observation();
  hotPressure.steps[2].summary.transport = { by_operation: { contact_search: { rate_limits: 1 } } };
  assert.equal(adaptiveFairDecision({ batch: 30, healthyCycles: 1 }, hotPressure, options).state.batch, 15);
});

test("transport projection exposes only bounded numeric counters and fixed operation names", () => {
  const transport = compactTransportStats({ calls: 3, rate_limits: 1, timeouts: "1", wait_ms: Infinity,
    token: "do-not-log", cooldowns_by_operation: { contact_search: 5_000, "secret-chat": 6_000, other: -1 },
    by_operation: { contact_search: { calls: 2, retries: 1, request: "do-not-log" }, "secret-chat": { calls: 1 } } });
  assert.equal(transport.calls, 3);
  assert.equal(transport.timeouts, undefined);
  assert.equal(transport.wait_ms, undefined);
  assert.deepEqual(transport.cooldowns_by_operation, { contact_search: 5_000 });
  assert.deepEqual(Object.keys(transport.by_operation), ["contact_search"]);
  assert.equal(transport.by_operation.contact_search.retries, 1);
  assert.doesNotMatch(JSON.stringify(transport), /secret-chat|token|request|do-not-log/);
  assert.equal(compactTransportStats([]), null);
  assert.equal(compactSummary({ ok: true, transport: { calls: 2, user_id: "secret" } }).transport.calls, 2);
});

test("operation cooldown merge keeps independent longest deadlines and removes expired or invalid entries", () => {
  assert.deepEqual(mergeTransportCooldowns(
    { contact_search: 4_000, message_history_bundle: 900, chat_members: 5_000 },
    { contact_search: 3_000, message_search_bundle: 2_000, chat_bots: Infinity, other: Number.MAX_SAFE_INTEGER, "secret-chat": 8_000 },
    1_000,
  ), { contact_search: 4_000, chat_members: 5_000, message_search_bundle: 2_000, other: Number.MAX_SAFE_INTEGER });
});

test("worker cycle runs sent, hot lane, then fair steady-state lane in a stable order", () => {
  const specs = buildCycleStepSpecs(opts());

  assert.deepEqual(specs.map((spec) => spec.name), [
    "sent",
    "discover-hot",
    "received-hot",
    "discover-catchup",
    "discover-reconcile",
    "received-fair",
  ]);

  const hotDiscover = specs.find((spec) => spec.name === "discover-hot");
  assert.equal(argValue(hotDiscover.args, "--scope"), "discover");
  assert.equal(argValue(hotDiscover.args, "--discovery-mode"), "hot");
  assert.equal(argValue(hotDiscover.args, "--discovery-pages-per-run"), "5");
  assert.equal(argValue(hotDiscover.args, "--max-chat-pages"), "300");
  assert.equal(argValue(hotDiscover.args, "--chat-types"), "group,p2p");

  const hotReceived = specs.find((spec) => spec.name === "received-hot");
  assert.equal(argValue(hotReceived.args, "--scope"), "received");
  assert.equal(argValue(hotReceived.args, "--received-mode"), "hot");
  assert.equal(argValue(hotReceived.args, "--received-scopes-per-run"), "20");

  const catchupDiscover = specs.find((spec) => spec.name === "discover-catchup");
  assert.equal(argValue(catchupDiscover.args, "--discovery-mode"), "cursor");
  assert.equal(argValue(catchupDiscover.args, "--discovery-pages-per-run"), "1");
  assert.equal(argValue(catchupDiscover.args, "--max-chat-pages"), "300");
  assert.equal(argValue(catchupDiscover.args, "--chat-types"), "group,p2p");

  const reconcileDiscover = specs.find((spec) => spec.name === "discover-reconcile");
  assert.equal(argValue(reconcileDiscover.args, "--discovery-mode"), "reconcile");
  assert.equal(argValue(reconcileDiscover.args, "--discovery-pages-per-run"), "1");
  assert.equal(argValue(reconcileDiscover.args, "--max-chat-pages"), "300");
  assert.equal(argValue(reconcileDiscover.args, "--reconcile-interval-hours"), "24");
  assert.equal(argValue(reconcileDiscover.args, "--chat-types"), "group,p2p");

  const fairReceived = specs.find((spec) => spec.name === "received-fair");
  assert.equal(argValue(fairReceived.args, "--received-mode"), "all");
  assert.equal(argValue(fairReceived.args, "--received-scopes-per-run"), "50");

  const retention = buildCycleStepSpecs(opts({ retentionEveryCycles: 10 }), 10).at(-1);
  assert.equal(retention.name, "retention");
  assert.equal(retention.command, "maintenance");
  assert.deepEqual(retention.args.slice(0, 2), ["prune-runs", "--db"]);
});

test("worker cycle logs every step plus one cycle event and reports failure", () => {
  const logs = [];
  const calls = [];
  const ok = runCycleWithRunner(
    opts({ db: "custom.sqlite", hotReceivedScopesPerCycle: 7 }),
    42,
    (name, args) => {
      calls.push({ name, args });
      return {
        name,
        ok: name !== "received-hot",
        exit_code: name === "received-hot" ? 1 : 0,
        started_at: `start:${name}`,
        finished_at: `finish:${name}`,
        summary: null,
        stderr: name === "received-hot" ? "temporary failure" : "",
      };
    },
    (_opts, payload) => logs.push(payload),
    () => "2026-06-14T00:00:00.000Z",
  );

  assert.equal(ok, false);
  assert.equal(calls.length, 6);
  assert.equal(logs.length, 7);
  assert.deepEqual(logs.slice(0, 6).map((log) => log.type), Array(6).fill("lark_im_worker_step"));
  assert.equal(logs[6].type, "lark_im_worker_cycle");
  assert.equal(logs[6].cycle, 42);
  assert.equal(logs[6].ok, false);
  assert.equal(logs[6].step_count, 6);
  assert.deepEqual(logs[6].failed_steps, ["received-hot"]);
  assert.equal("steps" in logs[6], false);
  assert.equal(argValue(calls[2].args, "--received-scopes-per-run"), "7");
});

test("compactSummary keeps worker logs small while preserving run confidence signals", () => {
  const summary = compactSummary({
    ok: false,
    window: { start: "s", end: "e" },
    sent: {
      run_id: 1,
      ok: true,
      scanned: 3,
      records: 2,
      inserted: 1,
      updated: 0,
      duplicate: 1,
      ignored: "large field",
    },
    discovery: {
      run_id: 2,
      ok: true,
      mode: "hot",
      pages: 5,
      discovered_in_run: 24,
      has_more: true,
      snapshot_id: "hot_1",
      chats: Array(100).fill({ chat_id: "oc" }),
    },
    received: [
      { scope_id: "scope:1", ok: true, scanned: 2, records: 2, inserted: 2, updated: 0, duplicate: 0 },
      { scope_id: "scope:2", ok: false, scanned: 1, records: 0, inserted: 0, updated: 0, duplicate: 0 },
    ],
  });

  assert.deepEqual(summary, {
    ok: false,
    window: { start: "s", end: "e" },
    sent: {
      run_id: 1,
      ok: true,
      scanned: 3,
      records: 2,
      inserted: 1,
      updated: 0,
      duplicate: 1,
    },
    discovery: {
      run_id: 2,
      ok: true,
      mode: "hot",
      pages: 5,
      discovered_in_run: 24,
      has_more: true,
      snapshot_id: "hot_1",
    },
    received: {
      ok: false,
      scopes: 2,
      scanned: 3,
      records: 2,
      inserted: 2,
      updated: 0,
      duplicate: 0,
      failed: 1,
      failed_scope_ids: ["scope:2"],
    },
  });
});

test("summarizeWorkerEvents retains unfinished history without claiming an active step", () => {
  const events = [
    {
      type: "lark_im_worker_step",
      cycle: 1,
      name: "sent",
      ok: true,
      finished_at: "2026-06-14T00:00:01.000Z",
    },
    {
      type: "lark_im_worker_cycle",
      cycle: 1,
      ok: true,
      at: "2026-06-14T00:00:02.000Z",
    },
    {
      type: "lark_im_worker_step",
      cycle: 2,
      name: "sent",
      ok: true,
      finished_at: "2026-06-14T00:01:01.000Z",
    },
  ];

  const summary = summarizeWorkerEvents(events, Date.parse("2026-06-14T00:01:31.000Z"));

  assert.equal(summary.has_events, true);
  assert.equal(summary.last_cycle.cycle, 1);
  assert.equal(summary.last_cycle.ok, true);
  assert.equal(summary.last_step.cycle, 2);
  assert.equal(summary.last_step.name, "sent");
  assert.equal(summary.in_progress, false);
  assert.equal(summary.unfinished_cycle, true);
  assert.equal(summary.last_event_age_ms, 30_000);
});

test("summarizeWorkerEvents keeps the latest failure visible", () => {
  const summary = summarizeWorkerEvents(
    [
      {
        type: "lark_im_worker_step",
        cycle: 1,
        name: "received-hot",
        ok: false,
        finished_at: "2026-06-14T00:00:05.000Z",
      },
      {
        type: "lark_im_worker_cycle",
        cycle: 2,
        ok: true,
        at: "2026-06-14T00:02:00.000Z",
      },
    ],
    Date.parse("2026-06-14T00:03:00.000Z"),
  );

  assert.equal(summary.in_progress, false);
  assert.equal(summary.last_failure.name, "received-hot");
  assert.equal(summary.last_failure.cycle, 1);
  assert.equal(summary.last_failure.age_ms, 175_000);
  assert.equal(shimSummarizeWorkerEvents([], Date.parse("2026-06-14T00:03:00.000Z")).has_events, false);
});

test("old, recent, future and malformed unfinished step history never proves active work", () => {
  const now = Date.parse("2026-06-20T00:00:00.000Z");
  for (const at of ["2026-05-18T00:00:00.000Z", "2026-06-19T23:59:59.000Z", "2026-06-20T00:00:01.000Z", "invalid", undefined]) {
    const summary = summarizeWorkerEvents([{ type: "lark_im_worker_step", cycle: 91, name: "sent", ok: true, finished_at: at }], now);
    assert.equal(summary.in_progress, false);
    assert.equal(summary.unfinished_cycle, true);
    assert.equal(summary.last_step.cycle, 91);
  }
});

test("worker restart cycle numbers do not override later completion order", () => {
  const events = [
    { type: "lark_im_worker_step", cycle: 91, name: "sent", ok: true, finished_at: "2026-05-18T00:00:00.000Z" },
    { type: "lark_im_worker_cycle", cycle: 1, ok: true, at: "2026-06-20T00:00:00.000Z" },
  ];
  const summary = summarizeWorkerEvents(events, Date.parse("2026-06-20T00:00:01.000Z"));
  assert.equal(summary.in_progress, false);
  assert.equal(summary.unfinished_cycle, false);
  assert.equal(summary.last_step.cycle, 91);
  assert.equal(summary.last_cycle.cycle, 1);
});
