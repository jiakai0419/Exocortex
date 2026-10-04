import assert from "node:assert/strict";
import test from "node:test";

import { plain } from "../dist/terminal/index.js";
import {
  evaluateWaitOkState,
  formatLogLine,
  isReadyHealth,
  parseArgs,
  parsePositiveInt,
  plistXml,
  runLarkImServiceCli,
  runServiceCommand,
} from "../scripts/lark-im-service.mjs";

function memoryWriter() {
  let text = "";
  return {
    stream: {
      write(chunk) {
        text += String(chunk);
      },
    },
    text: () => text,
  };
}

function spawnResult(overrides = {}) {
  return {
    status: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

function fakeServiceDeps(overrides = {}) {
  const calls = [];
  const stdout = memoryWriter();
  const state = {
    plistExists: true,
    launchdLoaded: false,
    run: null,
    ...overrides,
  };
  const deps = {
    cwd: "/project",
    homedir: () => "/home/tester",
    uid: () => 501,
    execPath: "/usr/local/bin/node",
    nodePath: "/usr/local/bin/node",
    workerPath: "/project/scripts/lark-im-worker.mjs",
    stdout: stdout.stream,
    resolvePath: (...parts) => parts.join("/"),
    existsSync: (path) => {
      calls.push(["exists", path]);
      return state.plistExists;
    },
    mkdirSync: (path, options) => calls.push(["mkdir", path, options]),
    writeFileSync: (path, data) => calls.push(["write", path, data]),
    rmSync: (path) => calls.push(["rm", path]),
    run: (cmd, args, options = {}) => {
      calls.push(["run", cmd, args, options]);
      if (state.run) return state.run(cmd, args, options, calls, state);
      if (cmd === "which") return spawnResult({ stdout: "/usr/local/bin/lark-cli\n" });
      if (cmd === "launchctl" && args[0] === "print") {
        return state.launchdLoaded ? spawnResult({ stdout: "state = running\n" }) : spawnResult({ status: 113, stderr: 'Could not find service "com.exocortex.lark-im-worker" in domain for user gui: 501' });
      }
      return spawnResult();
    },
    ...overrides.deps,
  };
  return { calls, deps, stdout, state };
}

test("lark im service parseArgs keeps stable defaults for status", () => {
  const opts = parseArgs(["status"]);

  assert.equal(opts.command, "status");
  assert.equal(opts.intervalSeconds, 60);
  assert.equal(opts.hotReceivedScopesPerCycle, 20);
  assert.equal(opts.receivedScopesPerCycle, 50);
  assert.equal(opts.hotDiscoveryPagesPerCycle, 5);
  assert.equal(opts.discoveryPagesPerCycle, 1);
  assert.equal(opts.maxChatPages, 300);
  assert.equal(opts.reconcileIntervalHours, 24);
  assert.equal(opts.chatTypes, "group,p2p");
  assert.equal(opts.logDir, "logs/lark-im");
  assert.equal(opts.lines, 20);
  assert.equal(opts.timeoutSeconds, 180);
  assert.equal(opts.pollSeconds, 5);
  assert.equal(opts.stepTimeoutSeconds, 600);
  assert.equal(opts.logMaxBytes, 10 * 1024 * 1024);
  assert.equal(opts.logKeepFiles, 5);
  assert.equal(opts.retentionEveryCycles, 1440);
});

test("lark im service parseArgs accepts worker tuning options", () => {
  const opts = parseArgs([
    "install",
    "--interval-seconds",
    "15",
    "--hot-received-scopes-per-cycle",
    "7",
    "--received-scopes-per-cycle",
    "11",
    "--hot-discovery-pages-per-cycle",
    "3",
    "--discovery-pages-per-cycle",
    "2",
    "--max-chat-pages",
    "99",
    "--reconcile-interval-hours",
    "6",
    "--chat-types",
    "group",
    "--log-dir",
    "/tmp/exocortex-logs",
    "--lines",
    "9",
    "--timeout-seconds",
    "30",
    "--poll-seconds",
    "2",
  ]);

  assert.equal(opts.command, "install");
  assert.equal(opts.intervalSeconds, 15);
  assert.equal(opts.hotReceivedScopesPerCycle, 7);
  assert.equal(opts.receivedScopesPerCycle, 11);
  assert.equal(opts.hotDiscoveryPagesPerCycle, 3);
  assert.equal(opts.discoveryPagesPerCycle, 2);
  assert.equal(opts.maxChatPages, 99);
  assert.equal(opts.reconcileIntervalHours, 6);
  assert.equal(opts.chatTypes, "group");
  assert.equal(opts.logDir, "/tmp/exocortex-logs");
  assert.equal(opts.lines, 9);
  assert.equal(opts.timeoutSeconds, 30);
  assert.equal(opts.pollSeconds, 2);
});

test("lark im service parseArgs rejects unsafe option shapes", () => {
  assert.throws(() => parsePositiveInt("0", "interval-seconds"), /interval-seconds must be positive/);
  assert.throws(() => parseArgs(["status", "--interval-seconds"]), /--interval-seconds requires a value/);
  assert.throws(() => parseArgs(["status", "--unknown", "1"]), /Unknown option: --unknown/);
});

test("plistXml renders LaunchAgent worker arguments without shelling out when lark-cli is provided", () => {
  const mkdirCalls = [];
  const opts = parseArgs([
    "install",
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
    "ignored-by-test",
  ]);
  const xml = plistXml(opts, {
    cwd: "/project",
    logDir: "/project/logs/lark-im",
    nodePath: "/usr/local/bin/node",
    workerPath: "/project/scripts/lark-im-worker.mjs",
    larkCli: "/usr/local/bin/lark-cli",
    mkdirSync: (path, options) => mkdirCalls.push([path, options]),
    run: () => {
      throw new Error("should not run which lark-cli");
    },
  });

  assert.deepEqual(mkdirCalls, [["/project/logs/lark-im", { recursive: true }]]);
  assert.match(xml, /<string>com\.exocortex\.lark-im-worker<\/string>/);
  assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/project<\/string>/);
  assert.match(xml, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(xml, /<string>\/project\/scripts\/lark-im-worker\.mjs<\/string>/);
  assert.match(xml, /<string>--interval-seconds<\/string>\s*<string>15<\/string>/);
  assert.match(xml, /<string>--received-scopes-per-cycle<\/string>\s*<string>11<\/string>/);
  assert.match(xml, /<string>--hot-received-scopes-per-cycle<\/string>\s*<string>7<\/string>/);
  assert.match(xml, /<string>--discovery-pages-per-cycle<\/string>\s*<string>2<\/string>/);
  assert.match(xml, /<string>--hot-discovery-pages-per-cycle<\/string>\s*<string>3<\/string>/);
  assert.match(xml, /<string>--max-chat-pages<\/string>\s*<string>99<\/string>/);
  assert.match(xml, /<string>--reconcile-interval-hours<\/string>\s*<string>6<\/string>/);
  assert.match(xml, /<string>--chat-types<\/string>\s*<string>group<\/string>/);
  assert.match(xml, /<key>LARK_CLI<\/key>\s*<string>\/usr\/local\/bin\/lark-cli<\/string>/);
  assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/dev\/null<\/string>/);
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/project\/logs\/lark-im\/launchd\.err\.log<\/string>/);
  assert.match(xml, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
});

test("plistXml falls back to the default lark-cli path when which returns empty", () => {
  const calls = [];
  const xml = plistXml(parseArgs(["install"]), {
    cwd: "/project",
    logDir: "/project/logs/lark-im",
    nodePath: "/usr/local/bin/node",
    workerPath: "/project/scripts/lark-im-worker.mjs",
    mkdirSync: () => {},
    run: (cmd, args, options) => {
      calls.push([cmd, args, options]);
      return { status: 1, stdout: "", stderr: "", signal: null, pid: 1, output: [] };
    },
  });

  assert.deepEqual(calls, [["which", ["lark-cli"], { allowFailure: true }]]);
  assert.match(xml, /<key>LARK_CLI<\/key>\s*<string>\/opt\/homebrew\/bin\/lark-cli<\/string>/);
});

test("plistXml escapes untrusted paths and values", () => {
  const xml = plistXml(parseArgs(["install", "--chat-types", "group&p2p"]), {
    cwd: "/project/<unsafe>",
    logDir: "/logs/a&b",
    nodePath: "/bin/node",
    workerPath: "/worker\"quoted.mjs",
    larkCli: "/bin/lark'cli",
    mkdirSync: () => {},
  });
  assert.match(xml, /\/project\/&lt;unsafe&gt;/);
  assert.match(xml, /\/logs\/a&amp;b/);
  assert.match(xml, /worker&quot;quoted\.mjs/);
  assert.match(xml, /group&amp;p2p/);
  assert.match(xml, /lark&apos;cli/);
});

test("service status returns semantic unhealthy exit code", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const exitCode = runLarkImServiceCli(["status"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    renderServiceStatusText: () => "STOPPED / PROBLEM\n",
    buildServiceStatusReport: () => ({
      overview: { service: { status: "stopped" }, health: { status: "problem" } },
    }),
  });
  assert.equal(exitCode, 2);
  assert.equal(stderr.text(), "");
});

test("service install writes plist and bootstraps LaunchAgent through injected deps", () => {
  const { calls, deps, stdout } = fakeServiceDeps();

  runServiceCommand(parseArgs(["install", "--log-dir", "logs/test", "--interval-seconds", "15"]), deps);

  assert.match(stdout.text(), /installed com\.exocortex\.lark-im-worker/);
  assert.deepEqual(
    calls.filter((call) => call[0] === "mkdir").map((call) => call.slice(1)),
    [
      ["/home/tester/Library/LaunchAgents", { recursive: true }],
      ["/project/logs/test", { recursive: true }],
    ],
  );
  const write = calls.find((call) => call[0] === "write");
  assert.equal(write[1], "/home/tester/Library/LaunchAgents/com.exocortex.lark-im-worker.plist");
  assert.match(write[2], /<string>--interval-seconds<\/string>\s*<string>15<\/string>/);
  assert.deepEqual(
    calls.filter((call) => call[0] === "run").map((call) => call.slice(1, 4)),
    [
      ["which", ["lark-cli"], { allowFailure: true }],
      ["launchctl", ["bootout", "gui/501/com.exocortex.lark-im-worker"], { allowFailure: true }],
      [
        "launchctl",
        ["bootout", "gui/501", "/home/tester/Library/LaunchAgents/com.exocortex.lark-im-worker.plist"],
        { allowFailure: true },
      ],
      [
        "launchctl",
        ["bootstrap", "gui/501", "/home/tester/Library/LaunchAgents/com.exocortex.lark-im-worker.plist"],
        {},
      ],
      ["launchctl", ["kickstart", "-k", "gui/501/com.exocortex.lark-im-worker"], {}],
    ],
  );
});

test("service start kickstarts when LaunchAgent is already loaded", () => {
  const { calls, deps, stdout } = fakeServiceDeps({ launchdLoaded: true });

  runServiceCommand(parseArgs(["start"]), deps);

  assert.equal(stdout.text(), "start requested com.exocortex.lark-im-worker\n");
  assert.deepEqual(
    calls.filter((call) => call[0] === "run").map((call) => call.slice(1, 4)),
    [
      ["launchctl", ["print", "gui/501/com.exocortex.lark-im-worker"], { allowFailure: true }],
      ["launchctl", ["kickstart", "-k", "gui/501/com.exocortex.lark-im-worker"], {}],
    ],
  );
});

test("service start bootstraps when LaunchAgent is installed but not loaded", () => {
  const { calls, deps, stdout } = fakeServiceDeps({ launchdLoaded: false });

  runServiceCommand(parseArgs(["start"]), deps);

  assert.equal(stdout.text(), "start requested com.exocortex.lark-im-worker\n");
  assert.deepEqual(
    calls.filter((call) => call[0] === "run").map((call) => call.slice(1, 4)),
    [
      ["launchctl", ["print", "gui/501/com.exocortex.lark-im-worker"], { allowFailure: true }],
      [
        "launchctl",
        ["bootstrap", "gui/501", "/home/tester/Library/LaunchAgents/com.exocortex.lark-im-worker.plist"],
        { allowFailure: true },
      ],
      ["launchctl", ["kickstart", "-k", "gui/501/com.exocortex.lark-im-worker"], {}],
    ],
  );
});

test("service stop bootouts both targets and verifies unloaded state", () => {
  let inspections = 0;
  const { calls, deps, stdout } = fakeServiceDeps({ run: (cmd, args) => {
    if (args[0] === "print") return inspections++ === 0 ? spawnResult({ stdout: "state = running\n" }) : spawnResult({ status: 113, stderr: 'Could not find service "com.exocortex.lark-im-worker" in domain for user gui: 501' });
    return spawnResult();
  } });

  runServiceCommand(parseArgs(["stop"]), deps);

  assert.equal(stdout.text(), "stopped com.exocortex.lark-im-worker\n");
  assert.deepEqual(
    calls.filter((call) => call[0] === "run").map((call) => call.slice(1, 4)),
    [
      ["launchctl", ["print", "gui/501/com.exocortex.lark-im-worker"], { allowFailure: true }],
      ["launchctl", ["bootout", "gui/501/com.exocortex.lark-im-worker"], { allowFailure: true }],
      [
        "launchctl",
        ["bootout", "gui/501", "/home/tester/Library/LaunchAgents/com.exocortex.lark-im-worker.plist"],
        { allowFailure: true },
      ],
      ["launchctl", ["print", "gui/501/com.exocortex.lark-im-worker"], { allowFailure: true }],
    ],
  );
});

test("service stop reports launchctl details when service remains loaded", () => {
  const { deps } = fakeServiceDeps({
    launchdLoaded: true,
    run: (cmd, args) => {
      if (cmd === "launchctl" && args[0] === "bootout") {
        return spawnResult({ status: 1, stderr: `failed ${args[1]}` });
      }
      if (cmd === "launchctl" && args[0] === "print") return spawnResult({ stdout: "state = running\n" });
      return spawnResult();
    },
  });

  assert.throws(
    () => runServiceCommand(parseArgs(["stop"]), deps),
    /failed to stop com\.exocortex\.lark-im-worker: failed gui\/501\/com\.exocortex\.lark-im-worker; failed gui\/501/,
  );
});

test("service uninstall stops and removes the plist when it exists", () => {
  const { calls, deps, stdout } = fakeServiceDeps({ launchdLoaded: false, plistExists: true });

  runServiceCommand(parseArgs(["uninstall"]), deps);

  assert.match(stdout.text(), /stopped com\.exocortex\.lark-im-worker/);
  assert.match(stdout.text(), /removed \/home\/tester\/Library\/LaunchAgents\/com\.exocortex\.lark-im-worker\.plist/);
  assert.deepEqual(calls.filter((call) => call[0] === "rm").map((call) => call[1]), [
    "/home/tester/Library/LaunchAgents/com.exocortex.lark-im-worker.plist",
  ]);
});

test("service restart stops then starts through the same stable wrapper", () => {
  const { calls, deps, stdout } = fakeServiceDeps({
    plistExists: true,
    run: (cmd, args) => {
      if (cmd === "launchctl" && args[0] === "print") {
        return spawnResult({ status: 113, stderr: 'Could not find service "com.exocortex.lark-im-worker" in domain for user gui: 501' });
      }
      return spawnResult();
    },
  });

  runServiceCommand(parseArgs(["restart"]), deps);

  assert.equal(stdout.text(), "stopped com.exocortex.lark-im-worker\nstart requested com.exocortex.lark-im-worker\n");
  assert.deepEqual(
    calls.filter((call) => call[0] === "run").map((call) => call.slice(1, 3)),
    [
      ["launchctl", ["print", "gui/501/com.exocortex.lark-im-worker"]],
      ["launchctl", ["print", "gui/501/com.exocortex.lark-im-worker"]],
      ["launchctl", ["bootstrap", "gui/501", "/home/tester/Library/LaunchAgents/com.exocortex.lark-im-worker.plist"]],
      ["launchctl", ["kickstart", "-k", "gui/501/com.exocortex.lark-im-worker"]],
    ],
  );
});

test("formatLogLine renders worker cycle and step summaries", () => {
  const cycle = plain(
    formatLogLine(
      JSON.stringify({
        type: "lark_im_worker_cycle",
        at: "2026-06-20T00:00:00.000Z",
        cycle: 7,
        ok: true,
      }),
    ),
  );

  assert.match(cycle, /2026-06-20T00:00:00\.000Z cycle=7 OK/);

  const step = plain(
    formatLogLine(
      JSON.stringify({
        type: "lark_im_worker_step",
        finished_at: "2026-06-20T00:01:00.000Z",
        cycle: 8,
        name: "received-catchup",
        ok: false,
        exit_code: 2,
        summary: {
          received: { scopes: 3, records: 5, inserted: 4, failed: 1 },
        },
        stderr: "example failure",
      }),
    ),
  );

  assert.match(step, /received-catchup FAILED exit=2/);
  assert.match(step, /scopes=3 records=5 inserted=4 failed=1/);
  assert.match(step, /stderr=example failure/);
  assert.equal(formatLogLine("not-json"), "not-json");
});

test("evaluateWaitOkState requires a new successful cycle and ready sync health", () => {
  const startedAt = Date.parse("2026-06-20T00:00:00.000Z");
  const ready = evaluateWaitOkState(
    startedAt,
    { health: "ok_with_history" },
    {
      last_cycle: { cycle: 3, ok: true, at: "2026-06-20T00:00:01.000Z" },
      in_progress: false,
    },
  );

  assert.equal(ready.ready, true);
  assert.equal(ready.newOkCycle, true);
  assert.equal(ready.healthReady, true);
  assert.match(ready.reason, /cycle=3/);

  const stale = evaluateWaitOkState(
    startedAt,
    { health: "ok" },
    {
      last_cycle: { cycle: 2, ok: true, at: "2026-06-19T23:59:59.000Z" },
      in_progress: false,
    },
  );
  assert.equal(stale.ready, false);
  assert.match(stale.reason, /cycle_new=false/);

  const busy = evaluateWaitOkState(
    startedAt,
    { health: "fresh" },
    {
      last_cycle: { cycle: 4, ok: true, at: "2026-06-20T00:00:02.000Z" },
      in_progress: true,
    },
  );
  assert.equal(busy.ready, false);
  assert.match(busy.reason, /in_progress=true/);

  const unavailable = evaluateWaitOkState(startedAt, null, { last_cycle: null, in_progress: false });
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.healthReady, false);
  assert.match(unavailable.reason, /health=unavailable/);
});

test("isReadyHealth keeps wait-ok accepted health states explicit", () => {
  assert.equal(isReadyHealth("fresh"), true);
  assert.equal(isReadyHealth("ok"), true);
  assert.equal(isReadyHealth("ok_with_history"), true);
  assert.equal(isReadyHealth("catching_up"), false);
  assert.equal(isReadyHealth("needs_attention"), false);
});

test("service status passes an explicit database and install rejects ignored DB flags", () => {
  assert.throws(() => parseArgs(["install", "--db", "custom.sqlite"]), /only for status and wait-ok/);
  let seen;
  runServiceCommand(parseArgs(["status", "--db", "/synthetic/custom.sqlite"]), {
    stdout: memoryWriter().stream,
    uid: () => 501,
    buildServiceStatusReport: (opts) => { seen = opts; return {}; },
    renderServiceStatusText: () => "",
  });
  assert.equal(seen.db, "/synthetic/custom.sqlite");
});

test("start and install propagate kickstart failures without claiming success", () => {
  for (const command of ["start", "install"]) {
    for (const loaded of [true, false]) {
      const { deps, stdout } = fakeServiceDeps({ run: (cmd, args) => {
        if (args[0] === "print") return loaded ? spawnResult() : spawnResult({ status: 113, stderr: 'Could not find service "com.exocortex.lark-im-worker" in domain for user gui: 501' });
        if (args[0] === "kickstart") return spawnResult({ status: 5, stderr: "synthetic kickstart denied" });
        return spawnResult();
      } });
      assert.throws(() => runServiceCommand(parseArgs([command]), deps), /launchctl failed: synthetic kickstart denied/);
      assert.equal(stdout.text(), "");
    }
  }
});

test("start surfaces bootstrap errors but tolerates a concurrently loaded service", () => {
  for (const concurrentlyLoaded of [false, true]) {
    let prints = 0;
    const { calls, deps, stdout } = fakeServiceDeps({ run: (cmd, args) => {
      if (args[0] === "print") return prints++ > 0 && concurrentlyLoaded ? spawnResult() : spawnResult({ status: 113, stderr: 'Could not find service "com.exocortex.lark-im-worker" in domain for user gui: 501' });
      if (args[0] === "bootstrap") return spawnResult({ status: 5, stderr: "synthetic bootstrap failure" });
      return spawnResult();
    } });
    if (concurrentlyLoaded) {
      runServiceCommand(parseArgs(["start"]), deps);
      assert.match(stdout.text(), /^start requested /);
    } else {
      assert.throws(() => runServiceCommand(parseArgs(["start"]), deps), /synthetic bootstrap failure/);
      assert.equal(stdout.text(), "");
      assert.equal(calls.some((call) => call[0] === "run" && call[2][0] === "kickstart"), false);
    }
  }
});

test("inspection failures abort start, stop and uninstall without success or plist removal", () => {
  const failures = [
    { status: 1, stderr: "Operation not permitted" },
    { status: 113, stderr: "Could not find domain for user gui: 501" },
    { status: 1, stderr: 'Could not find service "com.exocortex.lark-im-worker" in domain for user gui: 501' },
    { status: 113, stderr: "" },
    { status: null, error: new Error("synthetic spawn failure") },
    { status: null, signal: "SIGTERM" },
  ];
  for (const command of ["start", "stop", "uninstall"]) {
    for (const failure of failures) {
      const { calls, deps, stdout } = fakeServiceDeps({ run: (cmd, args) => args[0] === "print" ? spawnResult(failure) : spawnResult() });
      assert.throws(() => runServiceCommand(parseArgs([command]), deps), /cannot inspect .*launchctl print failed/);
      assert.equal(stdout.text(), "");
      assert.equal(calls.some((call) => call[0] === "rm"), false);
      assert.deepEqual(calls.filter((call) => call[0] === "run").map((call) => call[2][0]), ["print"]);
    }
  }
});

test("stop and uninstall cannot claim success when final inspection fails", () => {
  for (const command of ["stop", "uninstall"]) {
    let prints = 0;
    const { calls, deps, stdout } = fakeServiceDeps({ run: (cmd, args) => {
      if (args[0] === "print") return prints++ === 0 ? spawnResult() : spawnResult({ status: 1, stderr: "synthetic inspection failure" });
      return spawnResult();
    } });
    assert.throws(() => runServiceCommand(parseArgs([command]), deps), /cannot inspect/);
    assert.equal(stdout.text(), "");
    assert.equal(calls.some((call) => call[0] === "rm"), false);
    assert.equal(calls.filter((call) => call[0] === "run" && call[2][0] === "bootout").length, 2);
  }
});

test("wait-ok does not accept a completed cycle followed by unfinished history", () => {
  const summary = {
    last_cycle: { cycle: 1, ok: true, at: "2026-06-20T00:00:01.000Z" },
    in_progress: false,
    unfinished_cycle: true,
  };
  const evaluation = evaluateWaitOkState(Date.parse("2026-06-20T00:00:00.000Z"), { health: "ok" }, summary);
  assert.equal(evaluation.ready, false);
  assert.match(evaluation.reason, /unfinished_cycle=true/);
});
