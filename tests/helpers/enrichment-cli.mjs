// Run the real CLI against fictional fixtures while keeping its real cross-process
// API lease and cooldown implementation in a test-owned directory.
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { runCli } from "../../bin/exocortex.mjs";
import { readSharedLarkCooldown, tryAcquireLarkApiLease, writeSharedLarkCooldown } from "../../src/runtime/lark-api-lease.mjs";

const [fixtureRoot, ...args] = process.argv.slice(2);
assert.ok(fixtureRoot, "the enrichment harness requires its synthetic fixture directory");
const inside = (root, path) => {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith("../") && !isAbsolute(child);
};
const root = resolve(fixtureRoot);
assert.equal(args[0], "maintenance");
assert.ok(["enrich", "replay"].includes(args[1]), "only fixture-owned enrichment or replay is supported");
const db = args[args.indexOf("--db") + 1];
assert.ok(args.includes("--db") && inside(root, resolve(db)), "the database must belong to this fixture");
if (existsSync(db)) assert.ok(inside(realpathSync(root), realpathSync(db)), "the database must not resolve outside its fixture");
const cli = process.env.LARK_CLI;
// One pre-existing missing-database test uses this inert executable; the command
// must reject the missing database before attempting it.
assert.ok(cli === "/usr/bin/false" || cli && inside(realpathSync(root), realpathSync(cli)),
  "the CLI must be the fixture's fake executable");
const directory = join(root, "api-state");
// Elide only the explicit inter-request pause. Real process and filesystem time
// still consumes the same monotonic deadline used by the session and lease.
let virtualElapsed = 0;
const monotonicClock = () => performance.now() + virtualElapsed;
const requestSessionDeps = {
  monotonicClock,
  sleep: ms => { virtualElapsed += ms; },
  tryAcquireLease: options => tryAcquireLarkApiLease(options, { directory, monotonicClock }),
  readSharedCooldown: options => readSharedLarkCooldown(options, { directory }),
  writeSharedCooldown: options => writeSharedLarkCooldown(options, { directory }),
};
process.exitCode = await runCli(args, { deps: { requestSessionDeps } });
