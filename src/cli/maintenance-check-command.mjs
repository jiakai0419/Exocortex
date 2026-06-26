// @ts-check

import { spawnSync } from "node:child_process";
import {
  block,
  compact,
  kv,
  renderError,
  section,
  statusBadge,
  subtitle,
  table,
  title,
} from "../../dist/terminal/index.js";

const DEFAULT_TIMEOUT_SECONDS = 180;
const DEFAULT_POLL_SECONDS = 5;

/**
 * @typedef {"text" | "json"} MaintenanceFormat
 * @typedef {"ok" | "failed" | "skipped" | "warning"} StepStatus
 *
 * @typedef {object} MaintenanceOptions
 * @property {boolean} live
 * @property {boolean} restart
 * @property {boolean} localChecks
 * @property {number} timeoutSeconds
 * @property {number} pollSeconds
 * @property {MaintenanceFormat} format
 * @property {boolean=} help
 *
 * @typedef {object} SpawnResult
 * @property {number | null} status
 * @property {string} stdout
 * @property {string} stderr
 *
 * @typedef {object} MaintenanceStep
 * @property {string} name
 * @property {string} command
 * @property {StepStatus} status
 * @property {boolean} required
 * @property {number} duration_ms
 * @property {string=} reason
 * @property {string=} stdout_tail
 * @property {string=} stderr_tail
 * @property {Record<string, any>=} details
 *
 * @typedef {object} MaintenanceReport
 * @property {boolean} ok
 * @property {string} status
 * @property {string} checked_at
 * @property {number} duration_ms
 * @property {object} options
 * @property {{clean: boolean, changed_files: number, status: StepStatus}} git
 * @property {MaintenanceStep[]} steps
 *
 * @typedef {object} MaintenanceDeps
 * @property {(cmd: string, args: string[]) => SpawnResult=} run
 * @property {() => number=} nowMs
 * @property {string=} execPath
 *
 * @typedef {object} CliIo
 * @property {{write: (text: string) => unknown}=} stdout
 * @property {{write: (text: string) => unknown}=} stderr
 * @property {MaintenanceDeps=} deps
 */

function usage() {
  return `Usage: node scripts/maintenance-check.mjs [options]

Runs the release/maintenance validation flow:
  git status -> local checks -> service restart -> wait-ok -> doctor -> status

Options:
  --live                  Also run doctor --live. Requires lark-cli auth/keychain access.
  --no-restart            Do not restart the LaunchAgent service.
  --skip-local-checks     Skip npm checks. Useful only when checks already passed in this shell.
  --timeout-seconds <n>   Timeout passed to service wait-ok. Default: ${DEFAULT_TIMEOUT_SECONDS}
  --poll-seconds <n>      Poll interval passed to service wait-ok. Default: ${DEFAULT_POLL_SECONDS}
  --format <fmt>          text | json. Default: text
  --help                  Show this help.
`;
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {MaintenanceOptions} */
  const opts = {
    live: false,
    restart: true,
    localChecks: true,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    pollSeconds: DEFAULT_POLL_SECONDS,
    format: "text",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { ...opts, help: true };
    if (arg === "--live") {
      opts.live = true;
      continue;
    }
    if (arg === "--no-restart") {
      opts.restart = false;
      continue;
    }
    if (arg === "--skip-local-checks") {
      opts.localChecks = false;
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--timeout-seconds") opts.timeoutSeconds = parsePositiveInt(next, "timeout-seconds");
    else if (arg === "--poll-seconds") opts.pollSeconds = parsePositiveInt(next, "poll-seconds");
    else if (arg === "--format") opts.format = /** @type {MaintenanceFormat} */ (next);
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }

  if (!["text", "json"].includes(opts.format)) throw new Error("--format must be text or json");
  return opts;
}

/**
 * @param {string} value
 * @param {number} limit
 */
function tailText(value, limit = 2000) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= limit) return text;
  return text.slice(text.length - limit);
}

/**
 * @param {string[]} lines
 */
function changedFileCount(lines) {
  return lines.filter((line) => line.trim()).length;
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {MaintenanceDeps} deps
 * @returns {SpawnResult}
 */
function runProgram(cmd, args, deps = {}) {
  const run = deps.run || ((program, programArgs) => {
    const result = spawnSync(program, programArgs, {
      encoding: "utf8",
      maxBuffer: 80 * 1024 * 1024,
    });
    return {
      status: result.status,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
    };
  });
  return run(cmd, args);
}

/**
 * @param {string} name
 * @param {string} command
 * @param {boolean} required
 * @param {string} reason
 * @returns {MaintenanceStep}
 */
function skippedStep(name, command, required, reason) {
  return { name, command, status: "skipped", required, duration_ms: 0, reason };
}

/**
 * @param {string} name
 * @param {string} command
 * @param {string} cmd
 * @param {string[]} args
 * @param {boolean} required
 * @param {MaintenanceDeps} deps
 * @returns {MaintenanceStep}
 */
function runStep(name, command, cmd, args, required, deps = {}) {
  const nowMs = deps.nowMs || Date.now;
  const started = nowMs();
  const result = runProgram(cmd, args, deps);
  const status = result.status === 0 ? "ok" : "failed";
  return {
    name,
    command,
    status,
    required,
    duration_ms: Math.max(0, nowMs() - started),
    stdout_tail: tailText(result.stdout),
    stderr_tail: tailText(result.stderr),
  };
}

/** @param {string} value */
function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Keep only public-safe fields. Do not include db_path, message samples, ids,
 * raw stdout/stderr, people, chats, links, or local filesystem paths.
 *
 * @param {Record<string, any>} report
 * @param {number | null} commandExitStatus
 */
function doctorLiveDetails(report, commandExitStatus) {
  const live = report.live && typeof report.live === "object" ? report.live : {};
  return {
    overall: report.overall || null,
    live_status: live.status || null,
    live_reason: live.reason || null,
    live_missing_count: live.missing_count ?? null,
    live_lag_ms: live.lag_ms ?? null,
    live_exit_status: live.exit_status ?? live._command_status ?? null,
    command_exit_status: commandExitStatus,
    findings: Array.isArray(report.findings) ? report.findings : [],
  };
}

/**
 * @param {string} name
 * @param {string} command
 * @param {string} cmd
 * @param {string[]} args
 * @param {MaintenanceDeps} deps
 * @returns {MaintenanceStep}
 */
function runDoctorLiveStep(name, command, cmd, args, deps = {}) {
  const nowMs = deps.nowMs || Date.now;
  const started = nowMs();
  const result = runProgram(cmd, args, deps);
  /** @type {StepStatus} */
  const status = result.status === 0 ? "ok" : "failed";
  const parsed = parseJsonObject(result.stdout.trim());
  /** @type {MaintenanceStep} */
  const step = {
    name,
    command,
    status,
    required: true,
    duration_ms: Math.max(0, nowMs() - started),
    stdout_tail: parsed ? "" : tailText(result.stdout),
    stderr_tail: tailText(result.stderr),
  };
  if (parsed) step.details = doctorLiveDetails(parsed, result.status);
  return step;
}

/**
 * @param {MaintenanceOptions} opts
 * @param {MaintenanceDeps} [deps]
 * @returns {MaintenanceReport}
 */
function executeMaintenanceCheck(opts, deps = {}) {
  const nowMs = deps.nowMs || Date.now;
  const started = nowMs();
  const execPath = deps.execPath || process.execPath;
  /** @type {MaintenanceStep[]} */
  const steps = [];

  const gitStep = runStep("git status", "git status --short", "git", ["status", "--short"], false, deps);
  const gitLines = gitStep.stdout_tail ? gitStep.stdout_tail.split("\n") : [];
  const changed = changedFileCount(gitLines);
  if (gitStep.status === "ok" && changed > 0) {
    gitStep.status = "warning";
    gitStep.reason = `${changed} changed file${changed === 1 ? "" : "s"}`;
  }
  steps.push(gitStep);

  let stopped = false;
  const runRequired = (name, command, cmd, args) => {
    if (stopped) {
      steps.push(skippedStep(name, command, true, "previous required step failed"));
      return;
    }
    const step = runStep(name, command, cmd, args, true, deps);
    steps.push(step);
    if (step.status === "failed") stopped = true;
  };
  const maybeSkip = (name, command, reason) => {
    steps.push(skippedStep(name, command, true, reason));
  };

  if (opts.localChecks) {
    runRequired("syntax check", "npm run check", "npm", ["run", "check"]);
    runRequired("generated files", "npm run build:check", "npm", ["run", "build:check"]);
    runRequired("type check", "npm run typecheck", "npm", ["run", "typecheck"]);
    runRequired("tests", "npm test", "npm", ["test"]);
  } else {
    maybeSkip("syntax check", "npm run check", "--skip-local-checks");
    maybeSkip("generated files", "npm run build:check", "--skip-local-checks");
    maybeSkip("type check", "npm run typecheck", "--skip-local-checks");
    maybeSkip("tests", "npm test", "--skip-local-checks");
  }

  if (opts.restart) {
    runRequired("service restart", "node scripts/lark-im-service.mjs restart", execPath, [
      "scripts/lark-im-service.mjs",
      "restart",
    ]);
    runRequired(
      "service wait-ok",
      `node scripts/lark-im-service.mjs wait-ok --timeout-seconds ${opts.timeoutSeconds} --poll-seconds ${opts.pollSeconds}`,
      execPath,
      [
        "scripts/lark-im-service.mjs",
        "wait-ok",
        "--timeout-seconds",
        String(opts.timeoutSeconds),
        "--poll-seconds",
        String(opts.pollSeconds),
      ],
    );
  } else {
    maybeSkip("service restart", "node scripts/lark-im-service.mjs restart", "--no-restart");
    maybeSkip("service wait-ok", "node scripts/lark-im-service.mjs wait-ok", "--no-restart");
  }

  runRequired("doctor", "node scripts/doctor.mjs", execPath, ["scripts/doctor.mjs"]);
  if (opts.live) {
    if (stopped) {
      steps.push(skippedStep("doctor live", "node scripts/doctor.mjs --live --format json", true, "previous required step failed"));
    } else {
      const step = runDoctorLiveStep(
        "doctor live",
        "node scripts/doctor.mjs --live --format json",
        execPath,
        ["scripts/doctor.mjs", "--live", "--format", "json"],
        deps,
      );
      steps.push(step);
      if (step.status === "failed") stopped = true;
    }
  } else {
    steps.push(skippedStep("doctor live", "node scripts/doctor.mjs --live --format json", true, "--live not requested"));
  }
  const diagnosticFailure = steps.some(
    (step) => ["doctor", "doctor live"].includes(step.name) && step.status === "failed",
  );
  if (stopped && !diagnosticFailure) {
    steps.push(skippedStep("service status", "node scripts/lark-im-service.mjs status", true, "previous required step failed"));
  } else {
    const step = runStep("service status", "node scripts/lark-im-service.mjs status", execPath, [
      "scripts/lark-im-service.mjs",
      "status",
    ], true, deps);
    steps.push(step);
    if (step.status === "failed") stopped = true;
  }

  const failedRequired = steps.some((step) => step.required && step.status === "failed");
  return {
    ok: !failedRequired,
    status: failedRequired ? "failed" : "ok",
    checked_at: new Date(nowMs()).toISOString(),
    duration_ms: Math.max(0, nowMs() - started),
    options: {
      live: opts.live,
      restart: opts.restart,
      local_checks: opts.localChecks,
      timeout_seconds: opts.timeoutSeconds,
      poll_seconds: opts.pollSeconds,
    },
    git: {
      clean: changed === 0 && gitStep.status === "ok",
      changed_files: changed,
      status: gitStep.status,
    },
    steps,
  };
}

/** @param {number} ms */
function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${Math.round(ms / 1000)}s`;
}

/** @param {Record<string, any> | null | undefined} details */
function renderStepDetails(details) {
  if (!details || typeof details !== "object") return "";
  const fields = [
    ["overall", details.overall],
    ["live_status", details.live_status],
    ["live_reason", details.live_reason],
    ["missing", details.live_missing_count],
    ["lag_ms", details.live_lag_ms],
    ["live_exit", details.live_exit_status],
    ["command_exit", details.command_exit_status],
  ]
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`);
  if (Array.isArray(details.findings) && details.findings.length > 0) {
    fields.push(`findings=${details.findings.join("; ")}`);
  }
  return fields.join(", ");
}

/** @param {MaintenanceReport} report */
function renderMaintenanceText(report) {
  const failed = report.steps.filter((step) => step.status === "failed");
  const lines = [
    `${title("Exocortex maintenance check")} ${statusBadge(report.status)}`,
    subtitle(`Checked at ${new Date(report.checked_at).toLocaleString()}`),
    "",
    section("Summary"),
    kv([
      ["Git", report.git.clean ? "clean" : `${report.git.changed_files} changed file(s)`],
      ["Local checks", report.options.local_checks ? "yes" : "skipped"],
      ["Service restart", report.options.restart ? "yes" : "skipped"],
      ["Live probe", report.options.live ? "yes" : "skipped"],
      ["Duration", formatDuration(report.duration_ms)],
    ]),
    "",
    section("Steps"),
    table(report.steps, [
      { header: "Status", key: "status", render: (step) => statusBadge(step.status) },
      { header: "Step", key: "name" },
      { header: "Duration", key: "duration_ms", render: (step) => formatDuration(step.duration_ms) },
      { header: "Command", key: "command" },
    ]),
  ];

  const skipped = report.steps.filter((step) => step.status === "skipped");
  if (skipped.length > 0) {
    lines.push("");
    lines.push(section("Skipped"));
    lines.push(
      skipped
        .map((step) => `  - ${step.name}: ${step.reason || "skipped"}`)
        .join("\n"),
    );
  }

  if (failed.length > 0) {
    lines.push("");
    lines.push(section("Failed output"));
    for (const step of failed) {
      const details = renderStepDetails(step.details);
      const output = compact(step.stderr_tail || step.stdout_tail || "", 500);
      if (details) lines.push(`  - ${step.name} details: ${details}`);
      if (output) lines.push(`  - ${step.name}: ${output}`);
      if (!details && !output) lines.push(`  - ${step.name}: (no output)`);
    }
  }

  return `${block(lines)}\n`;
}

/**
 * @param {string[]} argv
 * @param {CliIo} [io]
 */
function runMaintenanceCheckCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      stdout.write(usage());
      return 0;
    }
    const report = executeMaintenanceCheck(opts, io.deps || {});
    if (opts.format === "json") stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else stdout.write(renderMaintenanceText(report));
    return report.ok ? 0 : 2;
  } catch (error) {
    stderr.write(renderError(error));
    return 1;
  }
}

/** @param {string[]} [argv] */
function main(argv = process.argv.slice(2)) {
  return runMaintenanceCheckCli(argv);
}

export {
  DEFAULT_POLL_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  executeMaintenanceCheck,
  parseArgs,
  parsePositiveInt,
  renderMaintenanceText,
  runMaintenanceCheckCli,
  runStep,
  tailText,
  usage,
  main,
};
