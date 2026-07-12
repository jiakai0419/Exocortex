import assert from "node:assert/strict";
import test from "node:test";

import { plain } from "../dist/terminal/index.js";
import {
  parseArgs,
  runDoctorCli,
} from "../src/cli/doctor-command.mjs";
import {
  buildReport,
  runJson,
} from "../src/diagnostics/doctor-report.mjs";
import { renderDoctorText } from "../src/terminal/doctor-view.mjs";

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

function statusFixture(overrides = {}) {
  return {
    health: "ok",
    health_detail: "all known enabled scopes have cursors",
    records: {
      total: 3,
      latest_ms: Date.parse("2026-06-20T00:00:00.000Z"),
      by_direction: [
        { direction: "received", count: 2 },
        { direction: "sent", count: 1 },
      ],
    },
    hot_discovery: {
      ran: true,
      cursor_updated_at: "2026-06-20T00:01:00.000Z",
    },
    reconcile: {
      complete: true,
      cursor: { pages_scanned: 7 },
    },
    scopes: {
      received_enabled: 2,
      received_without_cursor: 0,
    },
    ...overrides,
  };
}

function qualityFixture(overrides = {}) {
  return {
    status: "ok",
    quality: {
      actionable_missing_sender_name: 0,
      missing_sender_name: 0,
      missing_chat_name: 0,
      invalid_rendered_body: 0,
    },
    ...overrides,
  };
}

function fakeRunJson(calls, responses = {}) {
  return (args, okStatuses = new Set([0])) => {
    calls.push({ args, okStatuses: [...okStatuses].sort() });
    const command = args[0];
    if (command === "scripts/sync-status.mjs") return responses.status || statusFixture();
    if (command === "scripts/lark-im-quality.mjs") return responses.quality || qualityFixture();
    if (command === "scripts/lark-im-lag-check.mjs") {
      return responses.live || { status: "healthy", ok: true, missing_count: 0, lag_ms: 1000 };
    }
    throw new Error(`unexpected command: ${command}`);
  };
}

test("doctor command renders help without touching dependencies", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const exitCode = runDoctorCli(["--help"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    deps: {
      runJson: () => {
        throw new Error("should not run");
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.text(), /Usage: node scripts\/doctor\.mjs/);
  assert.equal(stderr.text(), "");
});

test("doctor subprocesses use absolute project scripts, process executable, and a hard timeout", () => {
  const calls = [];
  const report = runJson(
    ["scripts/sync-status.mjs", "--format", "json"],
    new Set([0]),
    {
      execPath: "/runtime/node",
      projectRoot: "/project/root",
      timeoutMs: 1234,
      spawnSync: (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return { status: 0, stdout: '{"health":"ok"}', stderr: "" };
      },
    },
  );

  assert.equal(report.health, "ok");
  assert.equal(calls[0].cmd, "/runtime/node");
  assert.deepEqual(calls[0].args, ["/project/root/scripts/sync-status.mjs", "--format", "json"]);
  assert.equal(calls[0].options.cwd, "/project/root");
  assert.equal(calls[0].options.timeout, 1234);
  assert.equal(calls[0].options.killSignal, "SIGKILL");

  const unavailable = runJson(["scripts/sync-status.mjs"], new Set([0]), {
    spawnSync: () => ({
      status: null,
      stdout: undefined,
      stderr: undefined,
      error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    }),
  });
  assert.equal(unavailable.status, "command_failed");
  assert.equal(unavailable.reason, "dependency_unavailable");
});

test("doctor command emits fresh local report as json", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const calls = [];
  const cacheWrites = [];
  const exitCode = runDoctorCli(["--db", "custom.sqlite", "--format", "json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    deps: {
      resolvePath: (dbPath) => `/abs/${dbPath}`,
      now: () => new Date("2026-06-20T00:00:00.000Z"),
      runJson: fakeRunJson(calls),
      writeLiveProbeCache: (path, report) => {
        cacheWrites.push({ path, report });
        return null;
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.text(), "");
  const report = JSON.parse(stdout.text());
  assert.equal(report.ok, true);
  assert.equal(report.overall, "fresh");
  assert.equal(report.checked_at, "2026-06-20T00:00:00.000Z");
  assert.equal(report.db_path, undefined);
  assert.equal(stdout.text().includes("/abs/custom.sqlite"), false);
  assert.equal(report.live, null);
  assert.deepEqual(calls.map((call) => call.args[0]), [
    "scripts/sync-status.mjs",
    "scripts/lark-im-quality.mjs",
  ]);
  assert.deepEqual(cacheWrites, []);
});

test("doctor command runs live probe with tolerated delayed exit status", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const calls = [];
  const cacheWrites = [];
  const exitCode = runDoctorCli(
    [
      "--live",
      "--hot-chats",
      "2",
      "--messages-per-chat",
      "4",
      "--format",
      "json",
    ],
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      deps: {
        resolvePath: (dbPath) => `/abs/${dbPath}`,
        now: () => new Date("2026-06-20T00:00:00.000Z"),
        runJson: fakeRunJson(calls, {
          live: { status: "healthy", ok: true, missing_count: 0, lag_ms: 1000 },
        }),
        liveProbeCachePath: "logs/test/live-probe.json",
        writeLiveProbeCache: (path, report) => {
          cacheWrites.push({ path, report });
          return { status: report.live.status };
        },
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr.text(), "");
  const report = JSON.parse(stdout.text());
  assert.equal(report.live.status, "healthy");
  const liveCall = calls.find((call) => call.args[0] === "scripts/lark-im-lag-check.mjs");
  assert.deepEqual(liveCall.okStatuses, [0, 2]);
  assert.deepEqual(liveCall.args.slice(0, 8), [
    "scripts/lark-im-lag-check.mjs",
    "--db",
    "/abs/data/exocortex.sqlite",
    "--hot-chats",
    "2",
    "--messages-per-chat",
    "4",
    "--format",
  ]);
  assert.equal(cacheWrites.length, 1);
  assert.equal(cacheWrites[0].path, "logs/test/live-probe.json");
  assert.equal(cacheWrites[0].report.live.status, "healthy");
});

test("doctor command normalizes live keychain failures without failing local health", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const calls = [];
  const cacheWrites = [];
  const exitCode = runDoctorCli(["--live", "--format", "json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    deps: {
      resolvePath: (dbPath) => `/abs/${dbPath}`,
      now: () => new Date("2026-06-20T00:00:00.000Z"),
      runJson: fakeRunJson(calls, {
        live: {
          status: "command_failed",
          stderr: "keychain Get failed: keychain not initialized",
        },
      }),
      writeLiveProbeCache: (path, report) => {
        cacheWrites.push({ path, report });
        return { status: report.live.status };
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.text(), "");
  const report = JSON.parse(stdout.text());
  assert.equal(report.overall, "fresh");
  assert.equal(report.live.status, "unavailable");
  assert.equal(report.live.reason, "keychain_unavailable");
  assert.deepEqual(report.findings, ["live lag probe unavailable in this shell"]);
  assert.equal(cacheWrites.length, 1);
  assert.equal(cacheWrites[0].report.live.status, "unavailable");
});

test("doctor command returns exit code 2 when report needs attention", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const exitCode = runDoctorCli(["--format", "json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    deps: {
      now: () => new Date("2026-06-20T00:00:00.000Z"),
      runJson: fakeRunJson([], {
        quality: qualityFixture({
          quality: {
            actionable_missing_sender_name: 1,
            missing_sender_name: 1,
            missing_chat_name: 0,
            invalid_rendered_body: 0,
          },
        }),
      }),
    },
  });

  assert.equal(exitCode, 2);
  assert.equal(stderr.text(), "");
  const report = JSON.parse(stdout.text());
  assert.equal(report.ok, false);
  assert.equal(report.overall, "needs_attention");
  assert.deepEqual(report.findings, ["some senders still lack display names"]);
});

test("doctor command returns exit code 1 on dependency errors", () => {
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const exitCode = runDoctorCli(["--format", "json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    deps: {
      runJson: () => {
        throw new Error("status unavailable");
      },
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.text(), "");
  assert.match(plain(stderr.text()), /doctor check failed/);
});

test("doctor json applies a public-safe projection to nested diagnostics", () => {
  const privateSentinel = "PRIVATE_DOCTOR_SENTINEL";
  const privateId = `oc_${"x".repeat(80)}`;
  const stdout = memoryWriter();
  const exitCode = runDoctorCli(["--live", "--format", "json"], {
    stdout: stdout.stream,
    deps: {
      resolvePath: (dbPath) => `/private/users/example/${dbPath}`,
      now: () => new Date("2026-06-20T00:00:00.000Z"),
      runJson: fakeRunJson([], {
        status: statusFixture({
          db_path: "/private/users/example/exocortex.sqlite",
          locks: [{ scope_id: privateId, locked_by: privateSentinel }],
          runs: { by_status: {}, recent: [{ scope_id: privateId, error_message: privateSentinel }] },
        }),
        quality: qualityFixture({
          latest_records: [{ body: privateSentinel, chat_name: privateSentinel }],
          recent_failures: [{ scope_id: privateId, error_message: privateSentinel }],
        }),
        live: {
          ...statusFixture(),
          ok: true,
          status: "healthy",
          checked_at: "2026-06-20T00:00:00.000Z",
          window: { start: "2026-06-20T00:00:00.000Z", end: "2026-06-20T00:05:00.000Z" },
          probe: { hot_chats_requested: 1, hot_chats_found: 1, remote_messages_checked: 1 },
          latest_remote: { message_id: privateId, chat_name: privateSentinel, body: privateSentinel },
          missing: [],
          unsupported_chats: [],
          probe_errors: [],
        },
      }),
    },
  });

  assert.equal(exitCode, 0);
  assert.doesNotMatch(stdout.text(), new RegExp(privateSentinel));
  assert.doesNotMatch(stdout.text(), new RegExp(privateId));
  assert.doesNotMatch(stdout.text(), /\/private\/users\/example/);
});

test("renderDoctorText includes summary, live, and findings", () => {
  const report = buildReport(
    { db: "db.sqlite", live: true, hotChats: 1, messagesPerChat: 1, format: "text" },
    {
      resolvePath: (dbPath) => `/abs/${dbPath}`,
      now: () => new Date("2026-06-20T00:00:00.000Z"),
      runJson: fakeRunJson([], {
        live: { status: "delayed", ok: false, missing_count: 1, lag_ms: 42000 },
      }),
    },
  );
  const output = plain(renderDoctorText(report));

  assert.equal(report.overall, "delayed");
  assert.match(output, /Exocortex doctor/);
  assert.match(output, /Records\s+3 total, 1 sent, 2 received/);
  assert.match(output, /Live/);
  assert.match(output, /Missing\s+1/);
  assert.match(output, /remote hot messages are not fully present locally yet/);
});

test("parseArgs validates live options and format", () => {
  assert.deepEqual(parseArgs(["--live", "--hot-chats", "2", "--messages-per-chat", "4"]), {
    db: "data/exocortex.sqlite",
    live: true,
    hotChats: 2,
    messagesPerChat: 4,
    format: "text",
  });
  assert.throws(() => parseArgs(["--hot-chats", "0"]), /hot-chats must be a positive integer/);
  assert.throws(() => parseArgs(["--hot-chats", "20junk"]), /positive integer/);
  assert.throws(() => parseArgs(["--messages-per-chat", "4.9"]), /positive integer/);
  assert.throws(() => parseArgs(["--format", "yaml"]), /--format must be text or json/);
  assert.throws(() => parseArgs(["--db"]), /--db requires a value/);
});
