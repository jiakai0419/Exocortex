import assert from "node:assert/strict";
import test from "node:test";

import { plain } from "../dist/terminal/index.js";
import {
  executeMaintenanceCheck,
  parseArgs,
  renderMaintenanceText,
  runMaintenanceCheckCli,
} from "../src/cli/maintenance-check-command.mjs";

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

function fakeClock() {
  let now = Date.parse("2027-01-15T08:00:00.000Z");
  return () => {
    now += 100;
    return now;
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

function fakeRun(overrides = {}) {
  const calls = [];
  const failures = overrides.failures || new Map();
  const dirty = overrides.dirty || false;
  return {
    calls,
    run: (cmd, args) => {
      calls.push([cmd, args]);
      const command = [cmd, ...args].join(" ");
      if (failures.has(command)) return failures.get(command);
      if (cmd === "git") return spawnResult({ stdout: dirty ? " M src/shape.mjs\n" : "" });
      if (cmd === "npm") return spawnResult({ stdout: `${command} ok\n` });
      return spawnResult({ stdout: `${command} ok\n` });
    },
  };
}

test("maintenance check parseArgs keeps default validation flow explicit", () => {
  const opts = parseArgs([]);

  assert.equal(opts.live, false);
  assert.equal(opts.restart, true);
  assert.equal(opts.localChecks, true);
  assert.equal(opts.timeoutSeconds, 180);
  assert.equal(opts.pollSeconds, 5);
  assert.equal(opts.format, "text");
  assert.equal(parseArgs(["--help"]).help, true);
  assert.deepEqual(parseArgs(["--live", "--no-restart", "--skip-local-checks", "--timeout-seconds", "9", "--poll-seconds", "2", "--format", "json"]), {
    live: true,
    restart: false,
    localChecks: false,
    timeoutSeconds: 9,
    pollSeconds: 2,
    format: "json",
  });
  assert.throws(() => parseArgs(["--timeout-seconds", "0"]), /timeout-seconds must be positive/);
  assert.throws(() => parseArgs(["--format", "yaml"]), /--format must be text or json/);
});

test("maintenance check runs local checks, service restart, wait-ok, doctor, live, and status", () => {
  const fake = fakeRun();
  const report = executeMaintenanceCheck(parseArgs(["--live", "--timeout-seconds", "12", "--poll-seconds", "3"]), {
    run: fake.run,
    nowMs: fakeClock(),
    execPath: "/usr/local/bin/node",
  });

  assert.equal(report.ok, true);
  assert.equal(report.git.clean, true);
  assert.deepEqual(fake.calls, [
    ["git", ["status", "--short"]],
    ["npm", ["run", "check"]],
    ["npm", ["run", "build:check"]],
    ["npm", ["run", "typecheck"]],
    ["npm", ["test"]],
    ["/usr/local/bin/node", ["scripts/lark-im-service.mjs", "restart"]],
    [
      "/usr/local/bin/node",
      ["scripts/lark-im-service.mjs", "wait-ok", "--timeout-seconds", "12", "--poll-seconds", "3"],
    ],
    ["/usr/local/bin/node", ["scripts/doctor.mjs"]],
    ["/usr/local/bin/node", ["scripts/doctor.mjs", "--live"]],
    ["/usr/local/bin/node", ["scripts/lark-im-service.mjs", "status"]],
  ]);
  assert.match(plain(renderMaintenanceText(report)), /Exocortex maintenance check OK/);
});

test("maintenance check marks dirty git as warning without failing", () => {
  const fake = fakeRun({ dirty: true });
  const report = executeMaintenanceCheck(parseArgs(["--skip-local-checks", "--no-restart"]), {
    run: fake.run,
    nowMs: fakeClock(),
    execPath: "/usr/local/bin/node",
  });

  assert.equal(report.ok, true);
  assert.equal(report.git.clean, false);
  assert.equal(report.git.changed_files, 1);
  assert.equal(report.steps[0].status, "warning");
  assert.equal(report.steps.find((step) => step.name === "doctor").status, "ok");
});

test("maintenance check stops later required steps after a local check failure", () => {
  const fake = fakeRun({
    failures: new Map([
      ["npm run check", spawnResult({ status: 1, stderr: "redacted syntax failure" })],
    ]),
  });
  const report = executeMaintenanceCheck(parseArgs(["--live"]), {
    run: fake.run,
    nowMs: fakeClock(),
    execPath: "/usr/local/bin/node",
  });

  assert.equal(report.ok, false);
  assert.equal(report.status, "failed");
  assert.equal(report.steps.find((step) => step.name === "syntax check").status, "failed");
  assert.equal(report.steps.find((step) => step.name === "service restart").status, "skipped");
  assert.equal(report.steps.find((step) => step.name === "doctor live").status, "skipped");
  assert.match(plain(renderMaintenanceText(report)), /redacted syntax failure/);
});

test("maintenance check CLI renders text, json, help, and dependency errors", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const fake = fakeRun();
  const exitText = runMaintenanceCheckCli(["--skip-local-checks", "--no-restart"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    deps: {
      run: fake.run,
      nowMs: fakeClock(),
      execPath: "/usr/local/bin/node",
    },
  });

  assert.equal(exitText, 0);
  assert.equal(stderr.text(), "");
  assert.match(plain(stdout.text()), /Exocortex maintenance check OK/);

  const jsonOut = memoryWriter();
  const exitJson = runMaintenanceCheckCli(["--skip-local-checks", "--no-restart", "--format", "json"], {
    stdout: jsonOut.stream,
    deps: {
      run: fakeRun().run,
      nowMs: fakeClock(),
      execPath: "/usr/local/bin/node",
    },
  });
  assert.equal(exitJson, 0);
  assert.equal(JSON.parse(jsonOut.text()).status, "ok");

  const helpOut = memoryWriter();
  assert.equal(runMaintenanceCheckCli(["--help"], { stdout: helpOut.stream }), 0);
  assert.match(helpOut.text(), /Usage: node scripts\/maintenance-check\.mjs/);

  const err = memoryWriter();
  assert.equal(runMaintenanceCheckCli(["--timeout-seconds", "nope"], { stderr: err.stream }), 1);
  assert.match(plain(err.text()), /timeout-seconds must be positive/);
});
