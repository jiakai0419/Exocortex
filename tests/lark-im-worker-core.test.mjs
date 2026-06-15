import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCycleStepSpecs,
  compactSummary,
  runCycleWithRunner,
  summarizeWorkerEvents,
} from "../src/runtime/worker/lark-im-worker-core.mjs";
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
    ...overrides,
  };
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

test("worker cycle runs sent, hot lane, then catch-up lane in a stable order", () => {
  const specs = buildCycleStepSpecs(opts());

  assert.deepEqual(specs.map((spec) => spec.name), [
    "sent",
    "discover-hot",
    "received-hot",
    "discover-catchup",
    "discover-reconcile",
    "received-catchup",
  ]);

  const hotDiscover = specs.find((spec) => spec.name === "discover-hot");
  assert.equal(argValue(hotDiscover.args, "--scope"), "discover");
  assert.equal(argValue(hotDiscover.args, "--discovery-mode"), "hot");
  assert.equal(argValue(hotDiscover.args, "--discovery-pages-per-run"), "5");
  assert.equal(argValue(hotDiscover.args, "--max-chat-pages"), "300");

  const hotReceived = specs.find((spec) => spec.name === "received-hot");
  assert.equal(argValue(hotReceived.args, "--scope"), "received");
  assert.equal(argValue(hotReceived.args, "--received-mode"), "hot");
  assert.equal(argValue(hotReceived.args, "--received-scopes-per-run"), "20");

  const catchupDiscover = specs.find((spec) => spec.name === "discover-catchup");
  assert.equal(argValue(catchupDiscover.args, "--discovery-mode"), "cursor");
  assert.equal(argValue(catchupDiscover.args, "--discovery-pages-per-run"), "1");
  assert.equal(argValue(catchupDiscover.args, "--max-chat-pages"), "300");

  const reconcileDiscover = specs.find((spec) => spec.name === "discover-reconcile");
  assert.equal(argValue(reconcileDiscover.args, "--discovery-mode"), "reconcile");
  assert.equal(argValue(reconcileDiscover.args, "--discovery-pages-per-run"), "1");
  assert.equal(argValue(reconcileDiscover.args, "--max-chat-pages"), "300");
  assert.equal(argValue(reconcileDiscover.args, "--reconcile-interval-hours"), "24");

  const catchupReceived = specs.find((spec) => spec.name === "received-catchup");
  assert.equal(argValue(catchupReceived.args, "--received-mode"), "catchup");
  assert.equal(argValue(catchupReceived.args, "--received-scopes-per-run"), "50");
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
  assert.equal(logs[6].steps[2].name, "received-hot");
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

test("summarizeWorkerEvents reports heartbeat and in-progress cycles", () => {
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
  assert.equal(summary.in_progress, true);
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
