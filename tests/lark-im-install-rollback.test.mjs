import assert from "node:assert/strict";
import test from "node:test";
import { install, start, uninstall } from "../src/runtime/service/launchd.mjs";
import { fixture } from "./helpers/service-fixture.mjs";

for (const installed of [false, true]) {
  for (const failure of ["mkdirSync", "writeFileSync", "chmodSync", "lint", "renameSync"]) {
    test(`install staging ${failure} failure preserves previous file=${installed} and never starts`, () => {
      const f = fixture({ installed, alter: { KeepAlive: false } });
      if (failure === "lint") {
        const run = f.deps.run;
        f.deps.run = (cmd, args, options) => args[0] === "-lint" ? { status: 1, stderr: "PRIVATE_STAGE_SENTINEL" } : run(cmd, args, options);
      } else f.deps[failure] = () => { throw new Error("PRIVATE_STAGE_SENTINEL"); };
      assert.throws(() => install(f.config, f.deps), (error) => {
        assert.match(error.message, /configuration write failed|plutil -lint failed/);
        assert.doesNotMatch(error.message, /PRIVATE_STAGE_SENTINEL/);
        return true;
      });
      assert.equal(f.state.files.has(f.path), installed);
      if (installed) assert.equal(f.state.files.get(f.path), "SYNTHETIC_OLD_PLIST");
      assert.equal(f.state.files.size, installed ? 1 : 0);
      assert.equal(f.state.loaded, false);
      assert.equal(f.state.calls.some((call) => call[0] === "launchctl" && call[1] !== "print"), false);
    });
  }
}
for (const installed of [false, true]) {
  test(`install publication failure restores previous bytes/mode or missing file=${!installed}`, () => {
    const f = fixture({ installed, alter: { KeepAlive: false } });
    const chmod = f.deps.chmodSync;
    f.deps.chmodSync = (path, mode) => { if (path === f.path) throw new Error("PRIVATE_PUBLISH_SENTINEL"); chmod(path, mode); };
    assert.throws(() => install(f.config, f.deps), /configuration write failed/);
    assert.equal(f.state.files.has(f.path), installed);
    if (installed) {
      assert.equal(f.state.files.get(f.path), "SYNTHETIC_OLD_PLIST");
      assert.equal(f.state.modes.get(f.path), 0o640);
    }
    assert.equal(f.state.loaded, false);
    assert.equal(f.state.calls.some((call) => call[0] === "launchctl" && call[1] !== "print"), false);
  });
}
for (const failure of ["writeFileSync", "renameSync", "rmSync"]) {
  test(`install reports incomplete file rollback for ${failure} without service actions`, () => {
    const f = fixture({ installed: failure !== "rmSync", alter: { KeepAlive: false } });
    const chmod = f.deps.chmodSync;
    let failedPublication = false;
    f.deps.chmodSync = (path, mode) => {
      if (path === f.path) { failedPublication = true; throw new Error("PRIVATE_PUBLISH_SENTINEL"); }
      chmod(path, mode);
    };
    const original = f.deps[failure];
    f.deps[failure] = (...args) => {
      if (failedPublication && (failure !== "rmSync" || args[0] === f.path)) throw new Error("PRIVATE_ROLLBACK_SENTINEL");
      return original(...args);
    };
    assert.throws(() => install(f.config, f.deps), (error) => {
      assert.match(error.message, /rollback incomplete/);
      assert.doesNotMatch(error.message, /PRIVATE_(PUBLISH|ROLLBACK)_SENTINEL/);
      return true;
    });
    assert.equal(f.state.loaded, false);
    assert.equal(f.state.calls.some((call) => call[0] === "launchctl" && call[1] !== "print"), false);
  });
}
test("staging cleanup cannot hide primary/rollback failures", () => {
  const f = fixture({ installed: false });
  f.deps.chmodSync = (path) => { if (path === f.path) throw new Error("PRIVATE_PUBLISH_SENTINEL"); };
  f.deps.rmSync = () => { throw new Error("PRIVATE_CLEANUP_SENTINEL"); };
  assert.throws(() => install(f.config, f.deps), (error) => {
    assert.match(error.message, /configuration write failed/);
    assert.match(error.message, /rollback incomplete/);
    assert.match(error.message, /staging cleanup failed/);
    assert.doesNotMatch(error.message, /PRIVATE_/);
    return true;
  });
});
test("loaded service with missing or malformed old configuration remains untouched", () => {
  for (const installed of [false, true]) {
    const f = fixture({ installed, loaded: true, alter: { ProgramArguments: [] } });
    assert.throws(() => install(f.config, f.deps), /different or unknown configuration; stop/);
    assert.equal(f.state.loaded, true);
    assert.equal(f.state.files.has(f.path), installed);
    assert.equal(f.state.calls.some((call) => call[0] === "launchctl" && call[1] !== "print"), false);
  }
});
test("absent service permits explicit replacement of a malformed plist with recoverable old bytes", () => {
  const f = fixture({ alter: { ProgramArguments: [] } });
  assert.equal(install(f.config, f.deps).status, "installed");
  assert.match(f.state.files.get(f.path), /<plist/);
  assert.equal(f.state.loaded, false);
});
test("unreadable old configuration prevents write without leaking private paths", () => {
  const f = fixture();
  f.deps.readFileSync = () => { throw new Error("PRIVATE_READ_SENTINEL"); };
  assert.throws(() => install(f.config, f.deps), /cannot read previous service configuration for rollback/);
  assert.equal(f.state.files.get(f.path), "SYNTHETIC_OLD_PLIST");
  assert.equal(f.state.calls.some((call) => ["mkdir", "chmod", "write", "rename"].includes(call[0])), false);
});
test("unknown final pre-publication inspection prevents replacement", () => {
  let inspections = 0;
  const f = fixture({ installed: false, fail: (cmd, args) => args[0] === "print" && ++inspections > 1 ? { status: 1 } : null });
  assert.throws(() => install(f.config, f.deps), /cannot inspect/);
  assert.equal(f.state.files.size, 0);
});
test("start and uninstall filesystem failures stay public-safe", () => {
  const starting = fixture();
  starting.deps.mkdirSync = () => { throw new Error("PRIVATE_FILESYSTEM_SENTINEL"); };
  assert.throws(() => start(starting.deps), /cannot prepare service log directory/);
  const removing = fixture();
  removing.deps.rmSync = () => { throw new Error("PRIVATE_FILESYSTEM_SENTINEL"); };
  assert.throws(() => uninstall(removing.deps), /cannot remove service configuration/);
});
