#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  buildFindings,
  normalizeLiveResult,
  overallStatus,
} from "./lib/doctor-core.mjs";
import { block, hint, kv, list, renderError, section, statusBadge, subtitle, title } from "./lib/terminal.mjs";

const DEFAULT_DB = "data/exocortex.sqlite";

function usage() {
  return `Usage: node scripts/doctor.mjs [options]

Options:
  --db <path>                SQLite database path. Default: ${DEFAULT_DB}
  --live                     Also probe recent remote Lark messages. Requires lark-cli auth/keychain access.
  --hot-chats <n>            Hot chats for --live. Default: 5
  --messages-per-chat <n>    Recent messages per hot chat for --live. Default: 3
  --format <fmt>             text | json. Default: text
  --help                     Show this help.
`;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function parseArgs(argv) {
  const opts = {
    db: DEFAULT_DB,
    live: false,
    hotChats: 5,
    messagesPerChat: 3,
    format: "text",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--live") {
      opts.live = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--hot-chats") opts.hotChats = parsePositiveInt(next, "hot-chats");
    else if (arg === "--messages-per-chat")
      opts.messagesPerChat = parsePositiveInt(next, "messages-per-chat");
    else if (arg === "--format") opts.format = next;
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }

  if (!["text", "json"].includes(opts.format)) throw new Error("--format must be text or json");
  return opts;
}

function runJson(args, okStatuses = new Set([0])) {
  const result = spawnSync("node", args, {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  const stdout = result.stdout.trim();
  if (stdout) {
    try {
      const json = JSON.parse(stdout);
      if (!okStatuses.has(result.status)) json._command_status = result.status;
      return json;
    } catch (error) {
      if (okStatuses.has(result.status)) {
        throw new Error(`${args.join(" ")} returned non-JSON output: ${error.message}`);
      }
    }
  }
  if (!okStatuses.has(result.status)) {
    return {
      ok: false,
      status: "command_failed",
      command: ["node", ...args].join(" "),
      exit_status: result.status,
      stderr: result.stderr.trim(),
      stdout,
    };
  }
  return {};
}

function buildReport(opts) {
  const dbPath = resolve(opts.db);
  const status = runJson(["scripts/sync-status.mjs", "--db", dbPath, "--format", "json"]);
  const quality = runJson(["scripts/lark-im-quality.mjs", "--db", dbPath, "--format", "json"]);
  const live = opts.live
    ? normalizeLiveResult(runJson(
        [
          "scripts/lark-im-lag-check.mjs",
          "--db",
          dbPath,
          "--hot-chats",
          String(opts.hotChats),
          "--messages-per-chat",
          String(opts.messagesPerChat),
          "--format",
          "json",
        ],
        new Set([0, 2]),
      ))
    : null;

  const findings = buildFindings({ status, quality, live });
  const overall = overallStatus({ status, quality, live });

  return {
    ok: ["fresh", "syncing", "catching_up"].includes(overall),
    overall,
    checked_at: new Date().toISOString(),
    db_path: dbPath,
    status,
    quality,
    live,
    findings,
  };
}

function localLatest(status) {
  const ms = status.records?.latest_ms;
  return ms ? new Date(Number(ms)).toLocaleString() : "none";
}

function reconcileText(status) {
  const state = status.reconcile?.complete
    ? "complete"
    : status.reconcile?.cursor?.has_more
      ? "in progress"
      : "not started";
  return `${state}, ${status.reconcile?.cursor?.pages_scanned || 0} pages`;
}

function hotDiscoveryText(status) {
  if (!status.hot_discovery?.ran) return "not started";
  const time = status.hot_discovery.cursor_updated_at
    ? new Date(status.hot_discovery.cursor_updated_at).toLocaleString()
    : "unknown time";
  return `last run ${time}`;
}

function render(report) {
  const byDirection = Object.fromEntries(
    (report.status.records?.by_direction || []).map((row) => [row.direction, row]),
  );
  const lines = [
    `${title("Exocortex doctor")} ${statusBadge(report.overall)}`,
    subtitle(`Checked at ${new Date(report.checked_at).toLocaleString()}`),
    "",
    section("Summary"),
    kv([
      ["Latest record", localLatest(report.status)],
      [
        "Records",
        `${report.status.records?.total || 0} total, ${byDirection.sent?.count || 0} sent, ${
          byDirection.received?.count || 0
        } received`,
      ],
      ["Sync", `${statusBadge(report.status.health || "unknown")} ${report.status.health_detail || ""}`],
      ["Hot discovery", hotDiscoveryText(report.status)],
      ["Reconcile", reconcileText(report.status)],
      [
        "Scopes",
        `${report.status.scopes?.received_enabled || 0} received enabled, ${
          report.status.scopes?.received_without_cursor || 0
        } without cursor`,
      ],
      [
        "Quality",
        `${report.quality.quality?.missing_sender_name || 0} missing sender names, ` +
          `${report.quality.quality?.missing_chat_name || 0} missing chat names, ` +
          `${report.quality.quality?.invalid_rendered_body || 0} invalid bodies`,
      ],
    ]),
  ];

  lines.push("");
  if (report.live) {
    lines.push(section("Live"));
    const liveRows = [
      ["Status", statusBadge(report.live.status || "unknown")],
      ["Missing", report.live.missing_count ?? "?"],
      [
        "Lag",
        report.live.lag_ms === null || report.live.lag_ms === undefined
          ? "unknown"
          : `${Math.round(report.live.lag_ms / 1000)}s`,
      ],
    ];
    if (report.live.reason) liveRows.push(["Reason", report.live.reason]);
    if (report.live.hint) liveRows.push(["Hint", report.live.hint]);
    lines.push(kv(liveRows));
  } else {
    lines.push(hint("Live", "skipped. Run node scripts/doctor.mjs --live to compare recent remote hot messages."));
  }

  if (report.findings.length > 0) {
    lines.push("");
    lines.push(section("Findings"));
    lines.push(list(report.findings));
  }

  return `${block(lines)}\n`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = buildReport(opts);
  if (opts.format === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(render(report));
  if (!report.ok) process.exit(2);
}

try {
  main();
} catch (error) {
  process.stderr.write(renderError(error));
  process.exit(1);
}
