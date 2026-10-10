import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runCli } from "../bin/exocortex.mjs";
import { createCommandContext } from "../src/cli/context.mjs";
import { COMMANDS, parseInvocation, parseRouteOptions } from "../src/cli/registry.mjs";

function writer() {
  let value = "";
  return { write(chunk) { value += chunk; }, value: () => value };
}

function invocationContext(extra = {}) {
  return createCommandContext({ root: "/synthetic/install", cwd: "/synthetic/caller", now: () => 1234567890, ...extra });
}

test("all eighteen routes dispatch once with shared context and no command aliases", async () => {
  const calls = [];
  const stdout = writer();
  const loadCommand = async (group) => ({ [`run${group[0].toUpperCase()}${group.slice(1)}Command`]: async (options, context) => {
    calls.push({ group, options, context }); return 0;
  } });
  for (const command of COMMANDS) {
    const extra = command.id === "maintenance.enrich" ? ["--target", "records"]
      : command.id === "maintenance.history" ? ["--db", "synthetic.sqlite"]
      : command.id === "maintenance.preview" ? ["--db", "synthetic.sqlite", "--plan", "synthetic-plan.json", "--progress-dir", "synthetic-progress"]
      : command.id === "maintenance.replay" ? ["--db", "synthetic.sqlite", "--scope-id", "synthetic.scope", "--start", "2040-01-01T00:00:00Z", "--end", "2040-01-02T00:00:00Z"] : [];
    assert.equal(await runCli([...command.path, ...extra], invocationContext({ stdout, loadCommand })), 0);
    const call = calls.at(-1);
    assert.equal(call.context.route, command.id);
    assert.equal(call.context.startedAtMs, 1234567890);
    assert.equal(call.options.action, command.path[1]);
    if (call.options.db) assert.match(call.options.db, /^\/synthetic\/(install|caller)\//);
  }
  assert.equal(calls.length, 18);
  assert.equal(stdout.value(), "");
});

test("root, group and leaf help never loads command implementations", async () => {
  let loads = 0;
  const loadCommand = async () => { loads += 1; throw new Error("must not load"); };
  for (const argv of [["--help"], ["--help", "--all", "--format", "json"], ["service", "--help"],
    ["maintenance", "replay", "--help"], ["messages", "--help"]]) {
    const output = writer();
    assert.equal(await runCli(argv, { stdout: output, loadCommand }), 0);
    assert.ok(output.value());
  }
  assert.equal(loads, 0);
});

test("help works in a code-only fixture without dist, database, Python or external commands", (t) => {
  const root = mkdtempSync(join(tmpdir(), "synthetic-cli-help-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["bin/exocortex.mjs", "src/cli/registry.mjs", "src/cli/context.mjs", "src/cli/parse-options.mjs",
    "src/runtime/worker/options.mjs", "src/adapters/lark-im/sync-options.mjs", "src/terminal/text-layout.mjs"]) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(path, destination);
  }
  const alias = join(root, "synthetic-entrypoint.mjs");
  symlinkSync(join(root, "bin/exocortex.mjs"), alias);
  for (const entrypoint of [join(root, "bin/exocortex.mjs"), alias]) {
    const result = spawnSync(process.execPath, [entrypoint, "--help", "--all", "--format", "json"], {
      cwd: root, env: { PATH: "/synthetic/no-programs", HOME: root }, encoding: "utf8", timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const catalog = JSON.parse(result.stdout);
    assert.equal(catalog.groups.length, 6);
    assert.equal(catalog.commands.length, 18);
    assert.doesNotMatch(result.stdout, /\u001b|PRIVATE_|sqlite3.*failed/);
    const text = spawnSync(process.execPath, [entrypoint, "check", "--help"], {
      cwd: root, env: { PATH: "/synthetic/no-programs", HOME: root }, encoding: "utf8", timeout: 30000,
    });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Usage: node bin\/exocortex\.mjs check/);
    assert.match(text.stdout, /--write-live-cache/);
    assert.ok(text.stdout.split("\n").every((line) => line.length <= 80));
  }
});

test("default targets use installation root and explicit relative targets use invocation cwd", () => {
  const context = invocationContext();
  for (const route of ["messages", "status", "check", "sync", "service.install", "maintenance.backup"]) {
    assert.equal(parseRouteOptions(route, [], { context }).options.db, "/synthetic/install/data/exocortex.sqlite");
    assert.equal(parseRouteOptions(route, ["--db", "other.sqlite"], { context }).options.db, "/synthetic/caller/other.sqlite");
  }
  const replay = parseInvocation(["maintenance", "replay", "--db", "other.sqlite", "--scope-id", "synthetic.a", "--scope-id", "synthetic.b", "--start", "2040-01-01T00:00:00Z", "--end", "2040-01-02T00:00:00Z"], { context });
  assert.deepEqual(replay.options.scopeIds, ["synthetic.a", "synthetic.b"]);
  assert.ok(replay.provided.has("--db"));
  assert.equal(replay.options.db, "/synthetic/caller/other.sqlite");
});

test("unsupported routes and effects fail before any handler is loaded", async () => {
  let loads = 0;
  for (const argv of [
    ["help"], ["doctor"], ["diagnose"], ["probe"], ["worker"], ["sync", "worker"],
    ["status", "--live"], ["status", "--apply"], ["check", "--restart"], ["check", "--all"],
    ["service", "install", "--once"], ["service", "start", "--db", "synthetic.sqlite"],
    ["maintenance", "enrich"], ["maintenance", "enrich", "--target", "all"],
    ["maintenance", "replay", "--scope-id", "synthetic.a", "--start", "2040-01-01T00:00:00Z", "--end", "2040-01-02T00:00:00Z"],
    ["maintenance", "compact", "--dry-run"], ["--apply"],
    ["maintenance", "compact", "--db", "-h", "--apply"],
    ["maintenance", "compact", "--db", "-h", "--apply", "--all"],
    ["service.start"], ["maintenance.compact", "--apply"],
    ["maintenance", "compact", "--db", "", "--apply"],
  ]) {
    const stderr = writer();
    const stdout = writer();
    assert.equal(await runCli(argv, { stderr, stdout, loadCommand: async () => { loads += 1; return {}; } }), 1, JSON.stringify(argv));
    assert.equal(stdout.value(), "");
    assert.match(stderr.value(), /^Error: /);
  }
  assert.equal(loads, 0);
});

test("shared parser preserves strict integers and explicit repeated-scope semantics", () => {
  for (const value of ["0", "01", "-1", "1.5", "Infinity", "9007199254740993"]) {
    assert.throws(() => parseRouteOptions("messages", ["--limit", value]));
  }
  assert.throws(() => parseRouteOptions("messages", ["--limit", "1", "--limit", "2"]), /only once/);
  assert.throws(() => parseRouteOptions("messages", ["--limit"]), /requires a value/);
  assert.equal(parseRouteOptions("sync", ["--received-scopes-per-run", "0"]).options.receivedScopesPerRun, 0);
  assert.equal(parseRouteOptions("messages", ["--db", "./-h"], { context: invocationContext() }).options.db, "/synthetic/caller/-h");
  assert.equal(parseRouteOptions("messages", ["--search", ""]).options.search, "");
});

test("CLI preserves a handler's nonzero result even when its JSON says healthy", async () => {
  const stdout = writer();
  const status = await runCli(["check", "--format", "json"], { stdout, loadCommand: async () => ({ runCheckCommand(_options, context) {
    context.stdout.write('{"ok":true}\n'); return 1;
  } }) });
  assert.equal(status, 1);
  assert.deepEqual(JSON.parse(stdout.value()), { ok: true });
});

test("public exception output never reproduces arbitrary remote stderr or argument content", async () => {
  const stdout = writer();
  const stderr = writer();
  const code = await runCli(["check", "--format", "json"], { stdout, stderr, loadCommand: async () => {
    throw new Error("SYNTHETIC_PRIVATE_REMOTE Bearer invented /synthetic/private");
  } });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout.value()).error.code, "execution_failed");
  assert.equal(stderr.value(), "");
  assert.doesNotMatch(stdout.value(), /PRIVATE_REMOTE|Bearer|synthetic\/private/);
  const bad = writer();
  assert.equal(await runCli(["status", "--SYNTHETIC_PRIVATE_ARGUMENT=opaque"], { stderr: bad }), 1);
  assert.doesNotMatch(bad.value(), /PRIVATE_ARGUMENT|opaque/);
  const lowerCase = writer();
  assert.equal(await runCli(["status", "--private-synthetic-contact", "--format", "json"], { stdout: lowerCase }), 1);
  assert.doesNotMatch(lowerCase.value(), /private-synthetic-contact/);
});

test("the public entrypoint has no lifecycle or database implementation embedded", () => {
  const source = readFileSync("bin/exocortex.mjs", "utf8");
  assert.doesNotMatch(source, /spawnSync|launchctl|sqlite3|CREATE TABLE|UPDATE records/);
  assert.match(source, /await import\(`/);
});
