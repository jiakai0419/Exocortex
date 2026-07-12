import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseArgs,
  parsePositiveInt,
  runStep,
  runWorker,
  writeLog,
} from "../scripts/lark-im-worker.mjs";

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
  assert.throws(() => parsePositiveInt("0", "max-cycles"), /max-cycles must be positive/);
  assert.throws(() => parseArgs(["--interval-seconds"]), /--interval-seconds requires a value/);
  assert.throws(() => parseArgs(["--unknown", "1"]), /Unknown option: --unknown/);
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
  assert.match(calls[0][1][0], /\/scripts\/lark-im-sync\.mjs$/);
  assert.deepEqual(calls[0][1].slice(1), ["--scope", "sent", "--db", "custom.sqlite"]);
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

test("lark im worker direct CLI help and argument errors keep exit codes stable", () => {
  const help = spawnSync(process.execPath, ["scripts/lark-im-worker.mjs", "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node scripts\/lark-im-worker\.mjs/);
  assert.equal(help.stderr, "");

  const error = spawnSync(process.execPath, ["scripts/lark-im-worker.mjs", "--unknown", "1"], {
    encoding: "utf8",
  });
  assert.equal(error.status, 1);
  assert.match(error.stderr, /Unknown option: --unknown/);
});
