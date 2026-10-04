import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { install, parseArgs } from "../src/cli/lark-im-service-command.mjs";

function fixture(t, { loaded = true, oldFile = true, failure = "kickstart", rollbackFailure = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-install-contract-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "Library/LaunchAgents/com.exocortex.lark-im-worker.plist");
  mkdirSync(join(dir, "Library/LaunchAgents"), { recursive: true });
  if (oldFile) writeFileSync(path, "SYNTHETIC_OLD_PLIST", { mode: 0o600 });
  const state = { loaded, loadedXml: loaded ? "SYNTHETIC_OLD_PLIST" : null, failed: false, calls: [], output: "" };
  const deps = {
    homedir: () => dir, uid: () => 701, cwd: dir, logDir: join(dir, "logs"), larkCli: "/synthetic/lark-cli",
    stdout: { write: (text) => { state.output += text; } },
    run: (cmd, args) => {
      const op = args[0]; state.calls.push([cmd, ...args]);
      if (cmd === "plutil") return { status: failure === "lint" ? 1 : 0, stdout: "", stderr: "synthetic lint failure" };
      const shouldFail = !state.failed && op === failure || state.failed && op === rollbackFailure;
      if (shouldFail) { state.failed = true; return { status: 5, stdout: "", stderr: `synthetic ${op} failure` }; }
      if (op === "print") return state.loaded ? { status: 0, stdout: "state = running", stderr: "" } : { status: 113, stdout: "", stderr: 'Could not find service "com.exocortex.lark-im-worker" in domain for user gui: 701' };
      if (op === "bootout") { state.loaded = false; state.loadedXml = null; }
      if (op === "bootstrap") {
        if (state.loaded) return { status: 5, stdout: "", stderr: "already loaded" };
        state.loaded = true; state.loadedXml = readFileSync(path, "utf8");
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return { state, deps, path, opts: parseArgs(["install", "--log-dir", join(dir, "logs")]) };
}
for (const loaded of [true, false]) {
  for (const oldFile of [true, false]) {
    if (loaded && !oldFile) continue;
    test(`install kickstart rollback restores old file=${oldFile} and loaded=${loaded}`, (t) => {
      const f = fixture(t, { loaded, oldFile });
      assert.throws(() => install(f.opts, f.deps), /synthetic kickstart failure/);
      assert.equal(existsSync(f.path), oldFile);
      if (oldFile) assert.equal(readFileSync(f.path, "utf8"), "SYNTHETIC_OLD_PLIST");
      assert.equal(f.state.loaded, loaded);
      assert.equal(f.state.loadedXml, loaded ? "SYNTHETIC_OLD_PLIST" : null);
      assert.equal(f.state.output, "");
      const firstBootstrap = f.state.calls.findIndex((call) => call[1] === "bootstrap");
      const kickstart = f.state.calls.findIndex((call) => call[1] === "kickstart");
      assert.ok(firstBootstrap < kickstart);
      assert.ok(f.state.calls.slice(kickstart + 1).some((call) => call[1] === "bootout"));
    });
  }
}
test("install unknown initial state does not mutate existing plist or launchd", (t) => {
  const f = fixture(t, { failure: "print" });
  assert.throws(() => install(f.opts, f.deps), /cannot inspect/);
  assert.equal(readFileSync(f.path, "utf8"), "SYNTHETIC_OLD_PLIST");
  assert.deepEqual(f.state.calls.map((call) => call[1]), ["print"]);
});
test("install cannot replace an un-restorable loaded service without its plist", (t) => {
  const f = fixture(t, { oldFile: false });
  assert.throws(() => install(f.opts, f.deps), /loaded service.*plist/);
  assert.equal(existsSync(f.path), false);
  assert.equal(f.state.loaded, true);
});
for (const rollbackFailure of ["print", "bootout", "bootstrap", "kickstart"]) {
  test(`install reports incomplete rollback when restoring ${rollbackFailure} fails`, (t) => {
    const f = fixture(t, { rollbackFailure });
    assert.throws(() => install(f.opts, f.deps), /rollback incomplete/);
    assert.equal(readFileSync(f.path, "utf8"), "SYNTHETIC_OLD_PLIST");
    assert.equal(f.state.output, "");
    if (rollbackFailure === "print" || rollbackFailure === "bootout") {
      assert.equal(f.state.calls.filter((call) => call[1] === "bootstrap").length, 1);
    }
  });
}

test("install validates staging before unloading and preserves previous file permissions on rollback", (t) => {
  const lint = fixture(t, { failure: "lint" });
  assert.throws(() => install(lint.opts, lint.deps), /synthetic lint failure/);
  assert.equal(lint.state.loadedXml, "SYNTHETIC_OLD_PLIST");
  assert.equal(lint.state.calls.some((call) => call[1] === "bootout"), false);
  assert.deepEqual(readdirSync(join(lint.path, "..")), ["com.exocortex.lark-im-worker.plist"]);
  const kickstart = fixture(t);
  chmodSync(kickstart.path, 0o640);
  assert.throws(() => install(kickstart.opts, kickstart.deps), /synthetic kickstart failure/);
  assert.equal(statSync(kickstart.path).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(join(kickstart.path, "..")), ["com.exocortex.lark-im-worker.plist"]);
});
test("install final rollback inspection must confirm loaded state", (t) => {
  const f = fixture(t);
  const run = f.deps.run;
  let bootstraps = 0;
  f.deps.run = (cmd, args) => {
    if (args[0] === "bootstrap") bootstraps += 1;
    if (args[0] === "print" && bootstraps === 2) return { status: 5, stdout: "", stderr: "synthetic final inspection denied" };
    return run(cmd, args);
  };
  assert.throws(() => install(f.opts, f.deps), /rollback incomplete: could not restore previous loaded service/);
  assert.equal(readFileSync(f.path, "utf8"), "SYNTHETIC_OLD_PLIST");
  assert.equal(f.state.output, "");
});
for (const failure of ["lint", "kickstart"]) {
  test(`install ${failure} failure retains primary and rollback errors if staging cleanup fails`, (t) => {
    const f = fixture(t, { failure, rollbackFailure: "print" });
    f.deps.rmSync = () => { throw new Error("synthetic cleanup failure"); };
    assert.throws(() => install(f.opts, f.deps), (error) => {
      assert.match(error.message, new RegExp(`synthetic ${failure} failure`));
      if (failure === "kickstart") assert.match(error.message, /rollback incomplete/);
      assert.match(error.message, /staging cleanup failed/);
      return true;
    });
    assert.equal(f.state.output, "");
  });
}
