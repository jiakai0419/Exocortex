import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseArgs,
  runCycle,
  runStep,
  runWorker,
  writeLog,
} from "../src/runtime/worker/worker.mjs";

function spawnResult(overrides = {}) {
  return {
    status: 0,
    stdout: "",
    stderr: "",
    signal: null,
    pid: 1,
    output: [],
    ...overrides,
  };
}

test("lark im worker parseArgs keeps stable defaults", () => {
  const opts = parseArgs([]);

  assert.equal(opts.db, "data/exocortex.sqlite");
  assert.equal(opts.intervalSeconds, 60);
  assert.equal(opts.receivedScopesPerCycle, 50);
  assert.equal(opts.hotReceivedScopesPerCycle, 20);
  assert.equal(opts.discoveryPagesPerCycle, 1);
  assert.equal(opts.hotDiscoveryPagesPerCycle, 5);
  assert.equal(opts.maxChatPages, 300);
  assert.equal(opts.reconcileIntervalHours, 24);
  assert.equal(opts.chatTypes, "group,p2p");
  assert.equal(opts.logDir, "logs/lark-im");
  assert.equal(opts.stepTimeoutSeconds, 600);
  assert.equal(opts.logMaxBytes, 10 * 1024 * 1024);
  assert.equal(opts.logKeepFiles, 5);
  assert.equal(opts.retentionEveryCycles, 1440);
  assert.equal(opts.maxCycles, null);
  assert.equal(opts.adaptiveFair, false);
  assert.equal(opts.adaptiveFairMin, 10);
  assert.equal(opts.adaptiveFairMax, 50);
  assert.equal(opts.adaptiveTargetCycleSeconds, 90);
});

test("worker adaptive fair is explicit and rejects inconsistent bounds or interval budget", () => {
  const options = parseArgs(["--adaptive-fair", "--received-scopes-per-cycle", "25", "--adaptive-fair-min", "10",
    "--adaptive-fair-max", "50", "--adaptive-target-cycle-seconds", "90", "--interval-seconds", "30"]);
  assert.equal(options.adaptiveFair, true);
  assert.equal(options.receivedScopesPerCycle, 25);
  assert.equal(options.adaptiveFairMin, 10);
  assert.equal(options.adaptiveFairMax, 50);
  assert.equal(options.adaptiveTargetCycleSeconds, 90);
  assert.throws(() => parseArgs(["--adaptive-fair-min", "51"]), /min must not exceed/);
  assert.throws(() => parseArgs(["--adaptive-fair", "--received-scopes-per-cycle", "5"]), /within adaptive fair bounds/);
  assert.throws(() => parseArgs(["--adaptive-fair", "--interval-seconds", "90"]), /must exceed interval/);
});

test("lark im worker parseArgs accepts once and worker tuning options", () => {
  const opts = parseArgs([
    "--once",
    "--db",
    "custom.sqlite",
    "--interval-seconds",
    "15",
    "--received-scopes-per-cycle",
    "11",
    "--hot-received-scopes-per-cycle",
    "7",
    "--discovery-pages-per-cycle",
    "2",
    "--hot-discovery-pages-per-cycle",
    "3",
    "--max-chat-pages",
    "99",
    "--reconcile-interval-hours",
    "6",
    "--chat-types",
    "group",
    "--log-dir",
    "/tmp/exocortex-worker",
    "--max-cycles",
    "4",
  ]);

  assert.equal(opts.db, "custom.sqlite");
  assert.equal(opts.intervalSeconds, 15);
  assert.equal(opts.receivedScopesPerCycle, 11);
  assert.equal(opts.hotReceivedScopesPerCycle, 7);
  assert.equal(opts.discoveryPagesPerCycle, 2);
  assert.equal(opts.hotDiscoveryPagesPerCycle, 3);
  assert.equal(opts.maxChatPages, 99);
  assert.equal(opts.reconcileIntervalHours, 6);
  assert.equal(opts.chatTypes, "group");
  assert.equal(opts.logDir, "/tmp/exocortex-worker");
  assert.equal(opts.maxCycles, 4);
});

test("lark im worker parseArgs rejects unsafe option shapes", () => {
  assert.throws(() => parseArgs(["--max-cycles", "0"]), /max-cycles must be a positive/);
  assert.throws(() => parseArgs(["--interval-seconds"]), /--interval-seconds requires a value/);
  assert.throws(() => parseArgs(["--unknown", "1"]), /Unknown option or unexpected command argument/);
  assert.throws(() => parseArgs(["--SYNTHETIC_PRIVATE_WORKER_TOKEN"]), (error) => {
    assert.equal(error.message, "Unknown option or unexpected command argument");
    assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE/);
    return true;
  });
});

test("runStep invokes lark-im-sync with node and compacts JSON summaries", () => {
  const calls = [];
  const times = [
    new Date("2026-06-20T00:00:00.000Z"),
    new Date("2026-06-20T00:00:01.000Z"),
  ];
  const step = runStep("sent", ["--scope", "sent", "--db", "custom.sqlite"], {
    execPath: "/usr/local/bin/node",
    now: () => times.shift() || new Date("2026-06-20T00:00:02.000Z"),
    spawnSync: (cmd, args, options) => {
      calls.push([cmd, args, options]);
      return spawnResult({
        stdout: JSON.stringify({
          ok: true,
          window: { start: "2026-06-20T00:00:00.000Z", end: "2026-06-20T00:01:00.000Z" },
          sent: {
            run_id: 12,
            ok: true,
            scanned: 3,
            records: 2,
            inserted: 1,
            updated: 1,
            duplicate: 0,
            large_payload: Array(10).fill("ignored"),
          },
        }),
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/local/bin/node");
  assert.match(calls[0][1][0], /\/bin\/exocortex\.mjs$/);
  assert.deepEqual(calls[0][1].slice(1), ["sync", "--scope", "sent", "--db", "custom.sqlite"]);
  assert.deepEqual(calls[0][2], {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    timeout: 600_000,
    killSignal: "SIGKILL",
  });
  assert.equal(step.name, "sent");
  assert.equal(step.ok, true);
  assert.equal(step.exit_code, 0);
  assert.equal(step.started_at, "2026-06-20T00:00:00.000Z");
  assert.equal(step.finished_at, "2026-06-20T00:00:01.000Z");
  assert.deepEqual(step.summary, {
    ok: true,
    window: { start: "2026-06-20T00:00:00.000Z", end: "2026-06-20T00:01:00.000Z" },
    sent: {
      run_id: 12,
      ok: true,
      scanned: 3,
      records: 2,
      inserted: 1,
      updated: 1,
      duplicate: 0,
    },
    discovery: null,
    received: null,
  });
});

test("runStep preserves failures and malformed stdout as null summary", () => {
  const step = runStep("received-hot", ["--scope", "received"], {
    now: () => new Date("2026-06-20T00:00:00.000Z"),
    spawnSync: () =>
      spawnResult({
        status: 2,
        stdout: "not-json",
        stderr: `${"x".repeat(4100)}tail`,
      }),
  });

  assert.equal(step.ok, false);
  assert.equal(step.exit_code, 2);
  assert.equal(step.summary, null);
  assert.equal(step.stderr.length, 4000);
});

test("runStep collects safe transport stats from failed-child stderr and preserves the parent environment", () => {
  let childEnv;
  const step = runStep("sent", [], {
    nowMs: () => 1_000,
    cooldownsByOperation: { contact_search: 4_000, message_history_bundle: 500, "secret-id": 5_000 },
    spawnSync: (_cmd, _args, options) => {
      childEnv = options.env;
      return spawnResult({ status: 1, stderr: `${JSON.stringify({ type: "lark_transport_summary",
        transport: { calls: 1, exhausted: 1, rate_limits: 2, private_id: "do-not-log", cooldowns_by_operation: { contact_search: 8_000 } } })}\n` });
    },
  });
  assert.equal(step.ok, false);
  assert.equal(step.summary.transport.exhausted, 1);
  assert.equal(step.summary.transport.rate_limits, 2);
  assert.equal(step.stderr, "");
  assert.doesNotMatch(JSON.stringify(step), /private_id|do-not-log/);
  assert.deepEqual(JSON.parse(childEnv.EXOCORTEX_LARK_COOLDOWNS_JSON), { contact_search: 4_000 });
  const { EXOCORTEX_LARK_COOLDOWNS_JSON: _override, ...inherited } = childEnv;
  const { EXOCORTEX_LARK_COOLDOWNS_JSON: _original, ...expected } = process.env;
  assert.deepEqual(inherited, expected);
});

test("runCycle forwards cooldowns to later children without a global wait or mutating other options", () => {
  const envs = [];
  const cooldowns = {};
  const steps = [];
  const ok = runCycle({ ...parseArgs(["--once"]), logDir: "" }, 1, {
    nowMs: () => 1_000,
    cooldownsByOperation: cooldowns,
    writeLog: { stdout: { write() {} } },
    onComplete: (observed) => steps.push(...observed),
    runStep: { spawnSync: (_cmd, _args, options) => {
      envs.push(JSON.parse(options.env.EXOCORTEX_LARK_COOLDOWNS_JSON));
      return spawnResult({ stdout: JSON.stringify({ ok: true, transport: {
        calls: 1, cooldowns_by_operation: envs.length === 1 ? { contact_search: 8_000 } : {},
      } }) });
    } },
  });
  assert.equal(ok, true);
  assert.equal(envs.length, 6);
  assert.deepEqual(envs[0], {});
  for (const env of envs.slice(1)) assert.deepEqual(env, { contact_search: 8_000 });
  assert.deepEqual(cooldowns, { contact_search: 8_000 });
  assert.equal(steps.length, 6);
});

test("runCycle defers only the high-level steps whose own operation deadline is still active", () => {
  const cases = [
    ["message_search_bundle", ["sent"]],
    ["message_history_bundle", ["received-hot", "received-fair"]],
    ["chat_discovery_bundle", ["discover-hot", "discover-catchup", "discover-reconcile"]],
    ["contact_search", []],
    ["chat_members", []],
    ["chat_bots", []],
    ["application_info", []],
  ];
  for (const [operation, expectedDeferred] of cases) {
    const observed = [];
    let spawned = 0;
    const ok = runCycle({ ...parseArgs(["--once"]), logDir: "" }, 1, {
      nowMs: () => 1_000,
      cooldownsByOperation: { [operation]: 8_000 },
      writeLog: { stdout: { write() {} } },
      onComplete: (steps) => observed.push(...steps),
      runStep: { spawnSync: () => { spawned += 1; return spawnResult({ stdout: '{"ok":true}' }); } },
    });
    const deferred = observed.filter((step) => step.summary?.deferred);
    assert.deepEqual(deferred.map((step) => step.name), expectedDeferred, operation);
    assert.equal(spawned, 6 - expectedDeferred.length);
    assert.equal(ok, expectedDeferred.length === 0);
    for (const step of deferred) {
      assert.equal(step.ok, false);
      assert.deepEqual(step.summary.deferred, { reason: "operation_cooldown", operation, retry_at_ms: 8_000 });
      assert.equal(step.summary.transport.cooldowns_by_operation[operation], 8_000);
    }
  }
});

test("expired high-level cooldowns resume normally and error events defer later matching steps", () => {
  let spawned = 0;
  const steps = [];
  const cooldowns = { message_history_bundle: 500 };
  const ok = runCycle({ ...parseArgs(["--once"]), logDir: "" }, 1, {
    nowMs: () => 1_000, cooldownsByOperation: cooldowns,
    writeLog: { stdout: { write() {} } },
    onComplete: (observed) => steps.push(...observed),
    runStep: { spawnSync: (_cmd, args) => {
      spawned += 1;
      if (args.includes("hot") && args.includes("received")) return spawnResult({ status: 1,
        stderr: JSON.stringify({ type: "lark_transport_summary", transport: { exhausted: 1, cooldowns_by_operation: { message_history_bundle: 8_000 } } }) });
      return spawnResult({ stdout: '{"ok":true}' });
    } },
  });
  assert.equal(ok, false);
  assert.equal(spawned, 5);
  assert.equal(steps[2].summary.transport.exhausted, 1);
  assert.equal(steps.at(-1).summary.deferred.operation, "message_history_bundle");
  assert.deepEqual(cooldowns, { message_history_bundle: 8_000 });
});

test("runStep fails closed on exit-zero malformed or unhealthy summaries", () => {
  const malformed = runStep("sent", [], {
    now: () => new Date("2026-06-20T00:00:00.000Z"),
    spawnSync: () => spawnResult({ status: 0, stdout: "not-json" }),
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.exit_code, 0);
  assert.match(malformed.stderr, /invalid or empty JSON/);

  const unhealthy = runStep("sent", [], {
    now: () => new Date("2026-06-20T00:00:00.000Z"),
    spawnSync: () => spawnResult({ status: 0, stdout: JSON.stringify({ ok: false }) }),
  });
  assert.equal(unhealthy.ok, false);
  assert.deepEqual(unhealthy.summary, {
    ok: false,
    window: undefined,
    sent: null,
    discovery: null,
    received: null,
  });
  assert.match(unhealthy.stderr, /unhealthy summary/);
});

test("writeLog writes JSONL to stdout and worker log file when logDir is set", () => {
  let stdout = "";
  const mkdirCalls = [];
  const appendCalls = [];

  writeLog(
    { logDir: "logs/test" },
    { type: "lark_im_worker_cycle", cycle: 1, ok: true },
    {
      stdout: { write: (chunk) => { stdout += chunk; } },
      mkdirSync: (path, options) => mkdirCalls.push([path, options]),
      appendFileSync: (path, data, options) => appendCalls.push([path, data, options]),
      resolvePath: (...parts) => parts.join("/"),
    },
  );

  assert.equal(stdout, "{\"type\":\"lark_im_worker_cycle\",\"cycle\":1,\"ok\":true}\n");
  assert.deepEqual(mkdirCalls, [["logs/test", { recursive: true, mode: 0o700 }]]);
  assert.deepEqual(appendCalls, [["logs/test/worker.jsonl", stdout, { encoding: "utf8", mode: 0o600 }]]);
});

test("writeLog can emit stdout without a file log", () => {
  let stdout = "";
  writeLog(
    {},
    { type: "event" },
    {
      stdout: { write: (chunk) => { stdout += chunk; } },
      mkdirSync: () => {
        throw new Error("should not create log dir");
      },
      appendFileSync: () => {
        throw new Error("should not append log file");
      },
    },
  );

  assert.equal(stdout, "{\"type\":\"event\"}\n");
});

test("writeLog rotates private worker logs at the configured size", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-worker-log-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const opts = { logDir: dir, logMaxBytes: 80, logKeepFiles: 2 };
  const deps = { stdout: { write() {} } };
  writeLog(opts, { type: "event", payload: "first".repeat(20) }, deps);
  writeLog(opts, { type: "event", payload: "second".repeat(20) }, deps);

  const current = join(dir, "worker.jsonl");
  assert.equal(existsSync(`${current}.1`), true);
  assert.match(readFileSync(current, "utf8"), /second/);
  assert.match(readFileSync(`${current}.1`, "utf8"), /first/);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(current).mode & 0o777, 0o600);
});

test("runWorker honors maxCycles and sleeps only between cycles", () => {
  const calls = [];
  runWorker(
    {
      ...parseArgs(["--max-cycles", "3", "--interval-seconds", "9"]),
      logDir: "",
    },
    {
      runCycle: (_opts, cycle) => {
        calls.push(["cycle", cycle]);
        return true;
      },
      sleepSeconds: (seconds) => calls.push(["sleep", seconds]),
    },
  );

  assert.deepEqual(calls, [
    ["cycle", 1],
    ["sleep", 9],
    ["cycle", 2],
    ["sleep", 9],
    ["cycle", 3],
  ]);
  assert.equal(runWorker(parseArgs(["--once"]), { runCycle: () => false }), false);
});

test("runWorker applies adaptive batches and preserves independent cooldown state across cycles", () => {
  const options = parseArgs(["--adaptive-fair", "--received-scopes-per-cycle", "25", "--interval-seconds", "30", "--max-cycles", "4"]);
  const batches = [];
  const schedulers = [];
  const sleeps = [];
  const cooldowns = [];
  let ms = 0;
  const ok = runWorker(options, {
    nowMs: () => ms,
    writeScheduler: (_opts, event) => schedulers.push(event),
    sleepSeconds: (seconds) => { sleeps.push(seconds); ms += seconds * 1_000; },
    runCycle: (cycleOpts, cycle, deps) => {
      batches.push(cycleOpts.receivedScopesPerCycle);
      cooldowns.push(deps.cooldownsByOperation);
      if (cycle === 1) deps.cooldownsByOperation.contact_search = 999_000;
      else assert.equal(deps.cooldownsByOperation.contact_search, 999_000);
      const steps = ["sent", "discover-hot", "received-hot", "discover-catchup", "discover-reconcile", "received-fair"]
        .map((name) => ({ name, ok: true, summary: { transport: { calls: 0, attempts: 0, rate_limits: 0, timeouts: 0, exhausted: 0 } } }));
      Object.assign(steps.at(-1), { started_at: new Date(ms).toISOString(), finished_at: new Date(ms + 10_000).toISOString(),
        summary: { received: { ok: true, scopes: cycleOpts.receivedScopesPerCycle }, transport: {
          calls: 1, attempts: 1, timeouts: 0, exhausted: 0, rate_limits: cycle === 3 ? 1 : 0,
        } } });
      ms += 20_000;
      deps.onComplete(steps, { ok: true });
      return true;
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(batches, [25, 25, 30, 15]);
  assert.deepEqual(schedulers.map((event) => event.next_batch), [25, 30, 15, 15]);
  assert.deepEqual(sleeps, [30, 30, 30]);
  assert.equal(cooldowns.every((map) => map === cooldowns[0]), true);
  assert.equal(options.receivedScopesPerCycle, 25);
  assert.equal(schedulers.every((event) => event.type === "lark_im_worker_scheduler"), true);
  assert.doesNotMatch(JSON.stringify(schedulers), /scope_id|chat_id|user_id|stderr/);
});

test("retired worker bridge is absent from the candidate", () => {
  assert.equal(existsSync(new URL("../scripts/lark-im-worker.mjs", import.meta.url)), false);
});

test("internal worker direct CLI help and argument errors keep exit codes stable", () => {
  const help = spawnSync(process.execPath, ["src/runtime/worker/main.mjs", "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node src\/runtime\/worker\/main\.mjs/);
  assert.equal(help.stderr, "");

  const error = spawnSync(process.execPath, ["src/runtime/worker/main.mjs", "--unknown", "1"], {
    encoding: "utf8",
  });
  assert.equal(error.status, 1);
  assert.match(error.stderr, /Unknown option or unexpected command argument/);
});
