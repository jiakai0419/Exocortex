import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { createCommandContext } from "../src/cli/context.mjs";
import { parseInvocation } from "../src/cli/registry.mjs";
import { createCheckPlan } from "../src/diagnostics/check-plan.mjs";
import { renderStatusText } from "../src/terminal/status-view.mjs";
import { plain } from "../dist/terminal/index.js";
import { STATUS_SCREEN_NOW, statusScreenFixture } from "./helpers/status-screen-fixture.mjs";

// Paths are invented and never opened: acceptance stops at argument/plan validation.
const root = resolve(process.env.TMPDIR || "/tmp", "invented-status-guidance");
const db = resolve(root, "private-db", "records.sqlite");
const logDir = resolve(root, "private-logs");
const stream = Object.assign(new Writable({ write(_chunk, _encoding, done) { done(); } }), { isTTY: false });
const screen = plain(renderStatusText(statusScreenFixture("healthy", { detail: true }), { columns: 96, stream }))
  .replace(/\s+/g, " ").trim();

function parseSuggestion(argv) {
  const context = createCommandContext({ root, cwd: root, now: () => STATUS_SCREEN_NOW });
  const parsed = parseInvocation(argv, { context });
  const plan = parsed.route === "check" ? createCheckPlan(parsed.options, { ...context, provided: parsed.provided }) : null;
  return { ...parsed, plan };
}

function args(command) {
  assert.match(command, /^npm run exo -- /);
  return command.replace(/^npm run exo -- /, "").replace(/ \(private\)$/, "").split(" ");
}

test("rendered local suggestions accept their documented database and mode-specific log target", () => {
  assert.match(screen, /Command targets Keep the same --db\. Keep --log-dir only for status, check --wait or check --live --write-live-cache\./);
  assert.doesNotMatch(screen, /All suggestions require the same --db and --log-dir/);
  const commands = /Inspect further (.*?) Remote check/.exec(screen)?.[1].split(" · ");
  assert.ok(commands?.length, "the rendered status screen must contain local command suggestions");
  assert.equal(commands.length, 4);
  for (const command of commands) {
    const argv = args(command);
    const useLogs = argv[0] === "status";
    const parsed = parseSuggestion([...argv, "--db", db, ...(useLogs ? ["--log-dir", logDir] : [])]);
    assert.equal(parsed.options.db, db);
    assert.equal(parsed.provided.has("--log-dir"), useLogs);
    if (useLogs) assert.equal(parsed.options.logDir, logDir);
    else {
      assert.equal(parsed.route, "check");
      assert.equal(parsed.plan.live, false);
      assert.equal(parsed.plan.wait, false);
      assert.equal(parsed.plan.writeLiveCache, false);
    }
  }
  assert.ok(!screen.includes(db) && !screen.includes(logDir), "public suggestions never print private paths");
});

test("rendered live suggestion remains read-only unless the user selects the documented cache option", () => {
  const command = /Remote check (npm run exo -- check --live) takes a new sample; add (--write-live-cache) to update the status cache\./.exec(screen);
  assert.ok(command, "the rendered live suggestion must keep cache writing opt-in");
  const argv = args(command[1]);
  const live = parseSuggestion([...argv, "--db", db]);
  assert.equal(live.options.db, db);
  assert.equal(live.plan.live, true);
  assert.equal(live.plan.wait, false);
  assert.equal(live.plan.writeLiveCache, false);
  assert.equal(live.provided.has("--log-dir"), false);

  const cache = parseSuggestion([...argv, command[2], "--db", db, "--log-dir", logDir]);
  assert.equal(cache.options.db, db);
  assert.equal(cache.plan.logDir, logDir);
  assert.equal(cache.plan.live, true);
  assert.equal(cache.plan.wait, false);
  assert.equal(cache.plan.writeLiveCache, true);
});

for (const mode of [[], ["--live"]]) {
  test(`check ${mode.join(" ")} still rejects the original blanket log-target instruction`, () => {
    assert.throws(() => parseSuggestion(["check", ...mode, "--db", db, "--log-dir", logDir]), {
      name: "CliUsageError", message: "--log-dir requires --wait or --write-live-cache",
    });
  });
}

test("check --wait accepts the same log target without adding live requests or cache writes", () => {
  const waited = parseSuggestion(["check", "--wait", "--db", db, "--log-dir", logDir]);
  assert.equal(waited.options.db, db);
  assert.equal(waited.plan.logDir, logDir);
  assert.equal(waited.plan.wait, true);
  assert.equal(waited.plan.live, false);
  assert.equal(waited.plan.writeLiveCache, false);
});
