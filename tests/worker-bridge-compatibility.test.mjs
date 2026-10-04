import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { main, parseArgs } from "../src/runtime/worker/worker.mjs";
import { WORKER_OPTION_SPECS, parseWorkerProgramArguments } from "../src/runtime/worker/options.mjs";
import { parseRouteOptions } from "../src/cli/registry.mjs";

const pairs = {
  db: ["first.sqlite", "last.sqlite"], logDir: ["first-logs", "last-logs"],
  chatTypes: ["group", "p2p"], adaptiveFairMin: ["5", "8"],
  adaptiveFairMax: ["80", "90"], adaptiveTargetCycleSeconds: ["120", "180"],
};

for (const spec of WORKER_OPTION_SPECS) {
  test(`registered worker bridge retains last-value semantics for ${spec.flag}`, () => {
    const values = pairs[spec.key] || ["2", "3"];
    const argv = spec.type === "boolean" ? [spec.flag, spec.flag] : [spec.flag, values[0], spec.flag, values[1]];
    const expected = spec.type === "boolean" ? true : spec.type === "integer" ? Number(values[1]) : values[1];
    assert.equal(parseArgs(argv, { legacy: true })[spec.key], expected);
    assert.throws(() => parseArgs(argv), /only once/);
    assert.throws(() => parseWorkerProgramArguments(argv), /only once/);
    assert.throws(() => parseRouteOptions("service.install", argv), /only once/);
  });
}

test("only the legacy bridge opts into repeated paths and lifetime flags", () => {
  let calls = 0;
  const argv = ["--db", "first.sqlite", "--db", "last.sqlite", "--log-dir", "old", "--log-dir", "last",
    "--max-cycles", "2", "--once", "--max-cycles", "3"];
  const context = { legacyPaths: true, root: "/synthetic/install", cwd: "/synthetic/caller", runWorker(opts) {
    calls++;
    assert.equal(opts.db, "/synthetic/caller/last.sqlite");
    assert.equal(opts.logDir, "/synthetic/caller/last");
    assert.equal(opts.maxCycles, 3);
    return true;
  } };
  assert.equal(main(argv, context), 0);
  assert.equal(calls, 1);
  assert.throws(() => main(argv, { ...context, legacyPaths: false }), /only once/);
  assert.equal(calls, 1);
  assert.equal(parseArgs(["--max-cycles", "2", "--max-cycles", "3", "--once", "--once"], { legacy: true }).maxCycles, 1);
});

test("legacy repetition never hides an invalid value or unknown option", () => {
  assert.throws(() => parseArgs(["--interval-seconds", "bad", "--interval-seconds", "3"], { legacy: true }), /positive integer/);
  assert.throws(() => parseArgs(["--db", "", "--db", "valid.sqlite"], { legacy: true }), /non-empty path/);
  assert.throws(() => parseArgs(["--private-synthetic-unknown"], { legacy: true }), /Unknown option/);
});

test("the executable bridge accepts repeated valid options while help stays effect-free", () => {
  const result = spawnSync(process.execPath, ["scripts/lark-im-worker.mjs", "--db", "first.sqlite", "--db", "last.sqlite", "--once", "--once", "--help"], {
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Usage: node scripts\/lark-im-worker.mjs/);
});
