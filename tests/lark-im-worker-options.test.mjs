import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs as parseWorker, runCycle, runStep } from "../scripts/lark-im-worker.mjs";
import { parseArgs as parseService, plistXml } from "../scripts/lark-im-service.mjs";

const numericOptions = [
  "interval-seconds", "received-scopes-per-cycle", "hot-received-scopes-per-cycle",
  "discovery-pages-per-cycle", "hot-discovery-pages-per-cycle", "max-chat-pages",
  "reconcile-interval-hours", "step-timeout-seconds", "log-max-bytes", "log-keep-files",
  "retention-every-cycles", "adaptive-fair-min", "adaptive-fair-max", "adaptive-target-cycle-seconds",
];
const sharedKeys = [
  "intervalSeconds", "receivedScopesPerCycle", "hotReceivedScopesPerCycle", "discoveryPagesPerCycle",
  "hotDiscoveryPagesPerCycle", "maxChatPages", "reconcileIntervalHours", "chatTypes", "logDir",
  "stepTimeoutSeconds", "logMaxBytes", "logKeepFiles", "retentionEveryCycles", "adaptiveFair",
  "adaptiveFairMin", "adaptiveFairMax", "adaptiveTargetCycleSeconds",
];
function shared(options) {
  return Object.fromEntries(sharedKeys.map((key) => [key, options[key]]));
}
function plistArguments(options) {
  const xml = plistXml(options, {
    cwd: "/synthetic-project", logDir: options.logDir, nodePath: "/synthetic-bin/node",
    workerPath: "/synthetic-project/scripts/lark-im-worker.mjs", larkCli: "/synthetic-bin/lark-cli",
    mkdirSync() {},
  });
  const array = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1];
  return [...array.matchAll(/<string>(.*?)<\/string>/g)].map((match) => match[1]
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'").replaceAll("&amp;", "&")).slice(2);
}

test("worker and service share all persistent defaults and independent option objects", () => {
  assert.deepEqual(shared(parseService(["install"])), shared(parseWorker([])));
  const first = parseWorker([]);
  first.adaptiveFairMin = 99;
  assert.equal(parseWorker([]).adaptiveFairMin, 10);
});

test("service persists adaptive settings through actual plist to worker argument round trip", () => {
  const options = parseService(["install", "--adaptive-fair", "--adaptive-fair-min", "7",
    "--adaptive-fair-max", "41", "--adaptive-target-cycle-seconds", "130",
    "--received-scopes-per-cycle", "23", "--interval-seconds", "37",
    "--log-dir", "synthetic&logs", "--chat-types", "group,p2p"]);
  const args = plistArguments(options);
  const worker = parseWorker(args);
  assert.deepEqual(shared(worker), shared(options));
  assert.equal(worker.maxCycles, null);
  assert.ok(args.includes("--adaptive-fair"));
  assert.ok(!args.includes("--once") && !args.includes("--max-cycles") && !args.includes("--db"));
});

test("inactive adaptive settings remain configurable and persist without enabling adaptation", () => {
  const options = parseService(["install", "--adaptive-fair-min", "2", "--adaptive-fair-max", "9",
    "--adaptive-target-cycle-seconds", "1"]);
  const args = plistArguments(options);
  assert.equal(parseWorker(args).adaptiveFair, false);
  assert.ok(!args.includes("--adaptive-fair"));
  assert.deepEqual(shared(parseWorker(args)), shared(options));
});

for (const flag of numericOptions) {
  test(`worker and service apply identical strict positive integer validation: ${flag}`, () => {
    for (const invalid of ["0", "-1", "1.5", "01", " 1", "1e2", "9007199254740992", "NaN", "Infinity"]) {
      const args = [`--${flag}`, invalid];
      let workerError;
      assert.throws(() => parseWorker(args), (error) => { workerError = error.message; return true; });
      assert.throws(() => parseService(["install", ...args]), (error) => error.message === workerError);
    }
    assert.throws(() => parseWorker([`--${flag}`]), /requires a value/);
    assert.throws(() => parseService(["install", `--${flag}`]), /requires a value/);
  });
}

for (const args of [
  ["--adaptive-fair-min", "51"],
  ["--adaptive-fair", "--received-scopes-per-cycle", "5"],
  ["--adaptive-fair", "--received-scopes-per-cycle", "51"],
  ["--adaptive-fair", "--interval-seconds", "90"],
]) {
  test(`both entries reject the same inconsistent adaptive configuration: ${args.join(" ")}`, () => {
    let expected;
    assert.throws(() => parseWorker(args), (error) => { expected = error.message; return true; });
    assert.throws(() => parseService(["install", ...args]), (error) => error.message === expected);
  });
}

test("once and max-cycles remain foreground-only and never enter persistent arguments", () => {
  for (const command of ["install", "start", "stop", "status", "wait-ok"]) {
    for (const args of [["--once"], ["--max-cycles", "2"]]) {
      assert.throws(() => parseService([command, ...args]), /foreground worker only/);
    }
  }
  assert.equal(parseWorker(["--once"]).maxCycles, 1);
  assert.equal(parseWorker(["--max-cycles", "2"]).maxCycles, 2);
  const args = plistArguments({ ...parseService(["install"]), maxCycles: 2, once: true });
  assert.equal(parseWorker(args).maxCycles, null);
});

test("an injected worker clock also timestamps child step and cycle evidence", () => {
  const fixedMs = Date.parse("2026-06-15T12:00:00Z");
  const step = runStep("sent", [], { nowMs: () => fixedMs,
    spawnSync: () => ({ status: 0, stdout: '{"ok":true}', stderr: "" }) });
  assert.equal(step.started_at, "2026-06-15T12:00:00.000Z");
  assert.equal(step.finished_at, step.started_at);
  let observed;
  runCycle({ ...parseWorker(["--once"]), logDir: "" }, 1, {
    nowMs: () => fixedMs, writeLog: { stdout: { write() {} } },
    runStep: { spawnSync: () => ({ status: 0, stdout: '{"ok":true}', stderr: "" }) },
    onComplete: (steps, payload) => { observed = { steps, payload }; },
  });
  assert.equal(observed.payload.at, step.started_at);
  for (const child of observed.steps) assert.equal(child.started_at, step.started_at);
});


test("every persistent tuning value survives service plist serialization", () => {
  const args = ["--interval-seconds", "11", "--received-scopes-per-cycle", "33",
    "--hot-received-scopes-per-cycle", "7", "--discovery-pages-per-cycle", "2",
    "--hot-discovery-pages-per-cycle", "6", "--max-chat-pages", "9",
    "--reconcile-interval-hours", "8", "--step-timeout-seconds", "100",
    "--log-max-bytes", "4096", "--log-keep-files", "2", "--retention-every-cycles", "13",
    "--adaptive-fair-min", "5", "--adaptive-fair-max", "49", "--adaptive-target-cycle-seconds", "77",
    "--adaptive-fair", "--chat-types", "group", "--log-dir", "synthetic-tuning-logs"];
  const service = parseService(["install", ...args]);
  assert.deepEqual(shared(service), shared(parseWorker(args)));
  assert.deepEqual(shared(parseWorker(plistArguments(service))), shared(parseWorker(args)));
});

test("worker timestamps use the process clock when no clock is injected", (t) => {
  const fixedMs = Date.parse("2026-06-15T13:00:00Z");
  t.mock.method(Date, "now", () => fixedMs);
  const step = runStep("sent", [], {
    spawnSync: () => ({ status: 0, stdout: '{"ok":true}', stderr: "" }),
  });
  assert.equal(step.started_at, "2026-06-15T13:00:00.000Z");
  assert.equal(step.finished_at, step.started_at);
});
