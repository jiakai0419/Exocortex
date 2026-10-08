import assert from "node:assert/strict";
import test from "node:test";
import { WORKER_DEFAULTS, parseWorkerProgramArguments } from "../src/runtime/worker/options.mjs";
import { install, start, stop, restart, uninstall, probeService, readInstalledServiceConfig, servicePlist, plistXml, LABEL } from "../src/runtime/service/launchd.mjs";
import { runServiceCommand } from "../src/cli/service-command.mjs";

import { fixture } from "./helpers/service-fixture.mjs";
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const lifecycleCalls = (f) => f.state.calls.filter((call) => call[0] === "launchctl" && call[1] !== "print");

test("service configuration includes database and all shared/adaptive options without finite lifetime flags", () => {
  const f = fixture();
  const config = { ...f.config, intervalSeconds: 20, receivedScopesPerCycle: 17, hotReceivedScopesPerCycle: 9,
    discoveryPagesPerCycle: 2, hotDiscoveryPagesPerCycle: 3, maxChatPages: 33, reconcileIntervalHours: 7,
    chatTypes: "group", stepTimeoutSeconds: 50, logMaxBytes: 2048, logKeepFiles: 3, retentionEveryCycles: 8,
    adaptiveFair: true, adaptiveFairMin: 4, adaptiveFairMax: 19, adaptiveTargetCycleSeconds: 35 };
  const plist = servicePlist({ ...config, once: true, maxCycles: 1 }, f.deps);
  assert.deepEqual(parseWorkerProgramArguments(plist.ProgramArguments.slice(2), { root: f.deps.root, cwd: "/synthetic/elsewhere" }), config);
  assert.equal(plist.ProgramArguments[1], "/synthetic/install/src/runtime/worker/main.mjs");
  assert.equal(plist.ProgramArguments.includes("--once"), false);
  assert.equal(plist.ProgramArguments.includes("--max-cycles"), false);
  assert.equal(plist.WorkingDirectory, f.deps.root);
  assert.equal(plist.Umask, 63);
  assert.equal(plist.RunAtLoad, true);
  assert.equal(plist.StandardOutPath, "/dev/null");
  assert.equal(plist.StandardErrorPath, "/synthetic/install/logs/lark-im/launchd.err.log");
});
test("plist serialization escapes XML and has no directory/process effects", () => {
  const f = fixture();
  const xml = plistXml({ ...f.config, chatTypes: 'a&b<>"' }, { ...f.deps, larkCli: "/synthetic/lark'cli" });
  assert.match(xml, /a&amp;b&lt;&gt;&quot;/);
  assert.match(xml, /lark&apos;cli/);
  assert.deepEqual(f.state.calls, []);
  assert.throws(() => plistXml({ ...f.config, db: "relative.sqlite" }, f.deps), /absolute root, database and log/);
});
for (const installed of [true, false]) {
  test(`install only writes configuration while absent, previous file=${installed}`, () => {
    const f = fixture({ installed, alter: { KeepAlive: false } });
    const result = install(f.config, f.deps);
    assert.equal(result.status, "installed");
    assert.equal(f.state.loaded, false);
    assert.deepEqual(lifecycleCalls(f), []);
    assert.match(f.state.files.get(f.path), /<plist/);
    assert.equal(f.state.modes.get(f.path), 0o600);
    assert.deepEqual(f.state.calls.filter((call) => call[0] === "launchctl"), [
      ["launchctl", "print", "gui/701/com.exocortex.lark-im-worker"],
      ["launchctl", "print", "gui/701/com.exocortex.lark-im-worker"],
    ]);
    assert.deepEqual(f.state.calls.filter((call) => call[0] === "plutil" && call[1] === "-lint"), [
      ["plutil", "-lint", `/synthetic/home/Library/LaunchAgents/com.exocortex.lark-im-worker.plist.tmp-${process.pid}`],
    ]);
    assert.equal(f.state.calls.some((call) => call[0] === "mkdir" && call[1] === f.config.logDir), false);
  });
}
for (const running of [true, false]) {
  test(`loaded install is a no-op only for identical configuration; running=${running}`, () => {
    const same = fixture({ loaded: true, running });
    assert.equal(install(same.config, same.deps).status, "unchanged");
    assert.deepEqual(lifecycleCalls(same), []);
    assert.equal(same.state.calls.some((call) => ["write", "rename", "chmod", "mkdir"].includes(call[0])), false);
    const changed = fixture({ loaded: true, running, alter: { KeepAlive: false } });
    assert.throws(() => install(changed.config, changed.deps), /stop it before installing/);
    assert.equal(changed.state.files.get(changed.path), "SYNTHETIC_OLD_PLIST");
    assert.deepEqual(lifecycleCalls(changed), []);
  });
}
test("install refuses a concurrently loaded worker before publishing staged configuration", () => {
  let prints = 0;
  const f = fixture({ installed: false, fail: (cmd, args, options, state) => {
    if (args[0] === "print" && ++prints === 2) state.loaded = true;
  } });
  assert.throws(() => install(f.config, f.deps), /became loaded/);
  assert.equal(f.state.files.has(f.path), false);
  assert.equal(f.state.files.size, 0);
  assert.deepEqual(lifecycleCalls(f), []);
});
test("start is ensure-running and never forces a new instance", () => {
  const running = fixture({ loaded: true, running: true });
  assert.equal(start(running.deps).status, "already_running");
  assert.deepEqual(lifecycleCalls(running), []);
  assert.equal(running.state.calls.length, 1);
  for (const loaded of [true, false]) {
    const f = fixture({ loaded });
    assert.equal(start(f.deps).status, "start_requested");
    assert.equal(f.state.running, true);
    assert.equal(lifecycleCalls(f).some((call) => call.includes("-k")), false);
    assert.deepEqual(lifecycleCalls(f), loaded
      ? [["launchctl", "kickstart", "gui/701/com.exocortex.lark-im-worker"]]
      : [["launchctl", "bootstrap", "gui/701", "/synthetic/home/Library/LaunchAgents/com.exocortex.lark-im-worker.plist"],
        ["launchctl", "kickstart", "gui/701/com.exocortex.lark-im-worker"]]);
  }
});
test("restart stops the old job and explicitly starts a new instance", () => {
  const f = fixture({ loaded: true, running: true });
  assert.equal(restart(f.deps).status, "restart_requested");
  assert.deepEqual(lifecycleCalls(f), [
    ["launchctl", "bootout", "gui/701/com.exocortex.lark-im-worker"],
    ["launchctl", "bootout", "gui/701", "/synthetic/home/Library/LaunchAgents/com.exocortex.lark-im-worker.plist"],
    ["launchctl", "bootstrap", "gui/701", "/synthetic/home/Library/LaunchAgents/com.exocortex.lark-im-worker.plist"],
    ["launchctl", "kickstart", "gui/701/com.exocortex.lark-im-worker"],
  ]);
  assert.notEqual(f.state.pid, 7011);
});
for (const action of [stop, uninstall]) {
  test(`${action.name} only reports completion after verified absence`, () => {
    const f = fixture({ loaded: true });
    assert.equal(action(f.deps).ok, true);
    assert.equal(f.state.loaded, false);
    assert.equal(f.state.files.has(f.path), action === stop);
    assert.deepEqual(lifecycleCalls(f), [
      ["launchctl", "bootout", "gui/701/com.exocortex.lark-im-worker"],
      ["launchctl", "bootout", "gui/701", "/synthetic/home/Library/LaunchAgents/com.exocortex.lark-im-worker.plist"],
    ]);
  });
}
for (const failure of [
  { status: 1, stderr: "PRIVATE_SERVICE_SENTINEL" },
  { status: 113, stderr: "Could not find domain for user gui: 701" },
  { status: 1, stderr: `Could not find service "${LABEL}" in domain for user gui: 701` },
  { status: 113, stderr: "" },
  { status: null, error: new Error("PRIVATE_SERVICE_SENTINEL") },
  { status: null, signal: "SIGTERM" },
]) {
  for (const action of [start, stop, restart, uninstall, (deps) => install(fixture().config, deps)]) {
    test(`inspection ${JSON.stringify(failure)} blocks ${action.name || "install"} without mutation`, () => {
      const f = fixture({ fail: (cmd, args) => args[0] === "print" ? failure : null });
      assert.throws(() => action(f.deps), (error) => {
        assert.match(error.message, /cannot inspect/);
        assert.doesNotMatch(error.message, /PRIVATE_SERVICE_SENTINEL/);
        return true;
      });
      assert.deepEqual(f.state.calls.map((call) => call[0]), ["launchctl"]);
      assert.equal(f.state.files.get(f.path), "SYNTHETIC_OLD_PLIST");
    });
  }
}
for (const action of [stop, uninstall]) {
  for (const final of ["loaded", "unknown"]) {
    test(`${action.name} does not remove files or succeed after final ${final}`, () => {
      let prints = 0;
      const f = fixture({ loaded: true, fail: (cmd, args) => {
        if (args[0] === "bootout") return { status: 5, stderr: "PRIVATE_SERVICE_SENTINEL" };
        if (args[0] === "print" && ++prints > 1 && final === "unknown") return { status: 1, stderr: "PRIVATE_SERVICE_SENTINEL" };
      } });
      assert.throws(() => action(f.deps), /cannot inspect|remains loaded/);
      assert.equal(f.state.files.get(f.path), "SYNTHETIC_OLD_PLIST");
    });
  }
}
for (const race of ["absent", "loaded", "running", "unknown"]) {
  test(`start bootstrap failure handles concurrent state ${race} without forced restart`, () => {
    const f = fixture({ fail: (cmd, args, options, state) => {
      if (args[0] === "bootstrap") { state.failed = true; state.loaded = ["loaded", "running"].includes(race); state.running = race === "running"; state.pid = state.running ? 7002 : null; return { status: 5 }; }
      if (args[0] === "print" && state.failed && race === "unknown") return { status: 1 };
    } });
    if (["loaded", "running"].includes(race)) assert.equal(start(f.deps).ok, true);
    else assert.throws(() => start(f.deps), /bootstrap failed|cannot inspect/);
    assert.equal(lifecycleCalls(f).some((call) => call.includes("-k")), false);
    if (race === "running") assert.equal(lifecycleCalls(f).some((call) => call[1] === "kickstart"), false);
  });
}
for (const race of [false, true]) {
  test(`start kickstart failure is accepted only after independently observed running=${race}`, () => {
    const f = fixture({ loaded: true, fail: (cmd, args, options, state) => {
      if (args[0] === "kickstart") { state.running = race; state.pid = race ? 7003 : null; return { status: 5, stderr: "PRIVATE_SERVICE_SENTINEL" }; }
    } });
    if (race) assert.equal(start(f.deps).ok, true);
    else assert.throws(() => start(f.deps), /kickstart failed/);
  });
}
test("installed configuration is read-only and malformed/finite-worker configurations are unknown", () => {
  const f = fixture();
  const result = readInstalledServiceConfig(f.deps);
  assert.equal(result.status, "installed");
  assert.deepEqual(result.config, f.config);
  assert.equal(f.state.calls.some((call) => ["write", "chmod", "mkdir", "rename"].includes(call[0])), false);
  const corrupt = fixture({ alter: { ProgramArguments: ["/synthetic/node", "/synthetic/worker", "--once"] } });
  assert.equal(readInstalledServiceConfig(corrupt.deps).status, "unknown");
  assert.equal(readInstalledServiceConfig(fixture({ installed: false }).deps).status, "missing");
});
test("probe reports running only with launchd state and a valid process identity", () => {
  assert.equal(probeService(fixture({ loaded: true, running: true }).deps).status, "running");
  const f = fixture({ loaded: true, fail: (cmd, args) => args[0] === "print" ? ok("state = running\npid = invalid") : null });
  assert.equal(probeService(f.deps).status, "loaded");
});
test("service adapter emits one safe result and delegates no status/check action", async () => {
  let output = "";
  const f = fixture({ loaded: true, running: true });
  assert.equal(await runServiceCommand({ action: "start", format: "json" }, { root: f.deps.root, stdout: { write: (value) => { output += value; } }, serviceDeps: f.deps }), 0);
  assert.deepEqual(JSON.parse(output), { ok: true, action: "start", status: "already_running" });
  assert.doesNotMatch(output, /synthetic|7011/);
  await assert.rejects(() => runServiceCommand({ action: "status" }, { serviceDeps: f.deps }), /unknown service action/);
});
for (const selection of ["provided", "environment", "PATH", "unavailable"]) {
  test(`install preserves lark-cli selection via ${selection} without remote calls`, () => {
    const f = fixture({ installed: false });
    const expected = selection === "provided" ? "/synthetic/bin/lark-cli" : selection === "environment" ? "/synthetic/env/lark-cli" : "/synthetic/path/lark-cli";
    if (selection !== "provided") delete f.deps.larkCli;
    f.deps.env = { PATH: "/synthetic/path:/synthetic/bin", ...(selection === "environment" ? { LARK_CLI: expected } : {}) };
    if (selection !== "unavailable") f.state.executables.add(expected);
    if (selection === "unavailable") {
      f.state.executables.delete("/synthetic/bin/lark-cli");
      assert.throws(() => install(f.config, f.deps), /lark-cli is unavailable/);
      assert.equal(f.state.files.size, 0);
      assert.deepEqual(f.state.calls.map((call) => call[0]), ["launchctl"]);
      return;
    }
    assert.equal(install(f.config, f.deps).status, "installed");
    assert.ok(f.state.files.get(f.path).includes(`<key>LARK_CLI</key><string>${expected}</string>`));
    assert.deepEqual(f.state.calls.filter((call) => call[0] === "which" || call[0] === expected), []);
    assert.deepEqual(lifecycleCalls(f), []);
  });
}
test("registry install paths persist defaults relative to root and explicit paths relative to cwd", async () => {
  const { runCli } = await import("../bin/exocortex.mjs");
  for (const explicit of [false, true]) {
    const f = fixture({ installed: false });
    let output = "";
    const code = await runCli(["service", "install", "--format", "json", ...(explicit ? ["--db", "custom.sqlite", "--log-dir", "custom-logs"] : [])], {
      root: "/synthetic/install", cwd: "/synthetic/caller", env: {}, serviceDeps: f.deps,
      stdout: { write: (value) => { output += value; } }, stderr: { write: (value) => { output += value; } },
    });
    assert.equal(code, 0, output);
    assert.equal(JSON.parse(output).status, "installed");
    const xml = f.state.files.get(f.path);
    assert.ok(xml.includes(`<string>${explicit ? "/synthetic/caller/custom.sqlite" : "/synthetic/install/data/exocortex.sqlite"}</string>`));
    assert.ok(xml.includes(`<string>${explicit ? "/synthetic/caller/custom-logs" : "/synthetic/install/logs/lark-im"}</string>`));
  }
});
test("registry rejects finite lifetime flags and tuning outside install before lifecycle calls", async () => {
  const { runCli } = await import("../bin/exocortex.mjs");
  for (const action of ["install", "start", "stop", "restart", "uninstall"]) {
    const cases = [["--once"], ["--max-cycles", "1"], ...(action === "install" ? [] : [["--db", "ignored.sqlite"], ["--interval-seconds", "30"]])];
    for (const flags of cases) {
      const f = fixture();
      let output = "";
      const code = await runCli(["service", action, "--format", "json", ...flags], { serviceDeps: f.deps,
        stdout: { write: (value) => { output += value; } }, stderr: { write: (value) => { output += value; } } });
      assert.equal(code, 1, `${action} ${flags}`);
      assert.equal(JSON.parse(output).error.code, "invalid_arguments");
      assert.deepEqual(f.state.calls, []);
    }
  }
});
test("registry preserves actionable install conflict and validates adaptive relations before effects", async () => {
  const { runCli } = await import("../bin/exocortex.mjs");
  const f = fixture({ loaded: true, alter: { KeepAlive: false } });
  let output = "";
  const io = { root: "/synthetic/install", serviceDeps: f.deps, stdout: { write: (value) => { output += value; } } };
  assert.equal(await runCli(["service", "install", "--format", "json"], io), 1);
  assert.match(JSON.parse(output).error.message, /stop it before installing/);
  f.state.calls.length = 0; output = "";
  assert.equal(await runCli(["service", "install", "--adaptive-fair-min", "90", "--adaptive-fair-max", "10", "--format", "json"], io), 1);
  assert.equal(JSON.parse(output).error.code, "invalid_arguments");
  assert.deepEqual(f.state.calls, []);
});
