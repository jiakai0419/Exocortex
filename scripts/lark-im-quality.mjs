#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { block, compact, kv, list, renderError, section, statusBadge, table, title } from "./lib/terminal.mjs";

const DEFAULT_DB = "data/exocortex.sqlite";

function usage() {
  return `Usage: node scripts/lark-im-quality.mjs [options]

Options:
  --db <path>       SQLite database path. Default: ${DEFAULT_DB}
  --format <fmt>    text | json. Default: text
  --help            Show this help.
`;
}

function parseArgs(argv) {
  const opts = { db: DEFAULT_DB, format: "text" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--format") opts.format = next;
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  if (!["text", "json"].includes(opts.format)) throw new Error("--format must be text or json");
  return opts;
}

function sqliteJson(dbPath, sql, label) {
  const result = spawnSync("sqlite3", ["-json", dbPath], {
    input: `.timeout 5000\n${sql}`,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr.trim()}`);
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

function one(rows, key, fallback = 0) {
  return rows[0]?.[key] ?? fallback;
}

function collect(dbPath) {
  const counts = sqliteJson(
    dbPath,
    `SELECT
       COUNT(*) AS total,
       SUM(direction = 'sent') AS sent,
       SUM(direction = 'received') AS received,
       MAX(occurred_at_ms) AS latest_ms
     FROM records
     WHERE source_id = 'lark.im'
       AND record_type = 'lark.im.message';`,
    "message counts",
  );
  const byType = sqliteJson(
    dbPath,
    `SELECT json_extract(canonical_json, '$.msg_type') AS msg_type, COUNT(*) AS count
     FROM records
     WHERE source_id = 'lark.im'
       AND record_type = 'lark.im.message'
     GROUP BY msg_type
     ORDER BY count DESC, msg_type;`,
    "message types",
  );
  const quality = sqliteJson(
    dbPath,
    `SELECT
       SUM(COALESCE(json_extract(canonical_json, '$.sender_name'), '') = '') AS missing_sender_name,
       SUM(
         COALESCE(json_extract(canonical_json, '$.sender_name'), '') = ''
         AND COALESCE(json_extract(canonical_json, '$.sender_id'), '') LIKE 'ou_%'
       ) AS missing_user_sender_name,
       SUM(
         COALESCE(json_extract(canonical_json, '$.sender_name'), '') = ''
         AND COALESCE(json_extract(canonical_json, '$.sender_id'), '') LIKE 'cli_%'
       ) AS missing_app_sender_name,
       SUM(COALESCE(json_extract(canonical_json, '$.sender_id'), '') LIKE 'cli_%') AS app_sender_records,
       SUM(
         json_extract(canonical_json, '$.chat_type') IN ('group', 'topic')
         AND COALESCE(json_extract(canonical_json, '$.chat_name'), '') = ''
       ) AS missing_chat_name,
       SUM(body LIKE '[Invalid%JSON]') AS invalid_rendered_body,
       SUM(body LIKE '[已撤回/已删除%') AS deleted_or_recalled_body
     FROM records
     WHERE source_id = 'lark.im'
       AND record_type = 'lark.im.message';`,
    "quality counts",
  );
  const scopes = sqliteJson(
    dbPath,
    `SELECT
       COUNT(*) AS total_received_scopes,
       SUM(enabled = 1) AS enabled_received_scopes,
       SUM(enabled = 1 AND cursor_json IS NULL) AS enabled_without_cursor,
       SUM(json_extract(config_json, '$.unsupported_reason') IS NOT NULL) AS unsupported_scopes,
       SUM(json_extract(config_json, '$.hot_seen_at') IS NOT NULL) AS hot_seen_scopes
     FROM sync_scopes
     WHERE source_id = 'lark.im'
       AND id LIKE 'lark.im.received.chat.%';`,
    "scope counts",
  );
  const recentFailures = sqliteJson(
    dbPath,
    `SELECT id, scope_id, error_type, substr(error_message, 1, 240) AS error_message
     FROM sync_runs
     WHERE status = 'failed'
     ORDER BY id DESC
     LIMIT 5;`,
    "recent failures",
  );
  const latest = sqliteJson(
    dbPath,
    `SELECT direction, occurred_at, json_extract(canonical_json, '$.chat_name') AS chat_name, body
     FROM records
     WHERE source_id = 'lark.im'
       AND record_type = 'lark.im.message'
     ORDER BY occurred_at_ms DESC, external_id DESC
     LIMIT 5;`,
    "latest records",
  );

  const countRow = counts[0] || {};
  return {
    messages: {
      total: countRow.total || 0,
      sent: countRow.sent || 0,
      received: countRow.received || 0,
      latest_at: countRow.latest_ms ? new Date(countRow.latest_ms).toISOString() : null,
    },
    message_types: byType,
    quality: quality[0] || {},
    scopes: scopes[0] || {},
    recent_failures: recentFailures,
    latest_records: latest,
  };
}

function render(report) {
  const hasIssues =
    Number(report.quality.missing_user_sender_name || 0) > 0 ||
    Number(report.quality.missing_app_sender_name || 0) > 0 ||
    Number(report.quality.missing_chat_name || 0) > 0 ||
    Number(report.quality.invalid_rendered_body || 0) > 0;
  const lines = [
    `${title("Lark IM data quality")} ${statusBadge(hasIssues ? "needs_attention" : "ok")}`,
    "",
    section("Summary"),
    kv([
      ["Messages", `${report.messages.total} total, ${report.messages.sent} sent, ${report.messages.received} received`],
      ["Latest", report.messages.latest_at || "none"],
      ["Missing sender names", report.quality.missing_sender_name || 0],
      ["Missing user sender names", report.quality.missing_user_sender_name || 0],
      ["Missing app sender names", report.quality.missing_app_sender_name || 0],
      ["Missing chat names", report.quality.missing_chat_name || 0],
      ["Invalid bodies", report.quality.invalid_rendered_body || 0],
      ["Deleted/recalled bodies", report.quality.deleted_or_recalled_body || 0],
      ["App sender records", report.quality.app_sender_records || 0],
    ]),
    "",
    section("Scopes"),
    kv([
      [
        "Received scopes",
        `${report.scopes.enabled_received_scopes || 0} enabled / ${report.scopes.total_received_scopes || 0} total`,
      ],
      ["Without cursor", report.scopes.enabled_without_cursor || 0],
      ["Hot-seen", report.scopes.hot_seen_scopes || 0],
      ["Unsupported", report.scopes.unsupported_scopes || 0],
    ]),
  ];
  if (report.message_types.length > 0) {
    lines.push("");
    lines.push(section("Message types"));
    lines.push(
      table(report.message_types, [
        { header: "Type", render: (row) => row.msg_type || "unknown" },
        { header: "Count", render: (row) => row.count },
      ]),
    );
  }
  if (report.recent_failures.length > 0) {
    lines.push("");
    lines.push(section("Historical failed runs"));
    lines.push(
      list(
        report.recent_failures.map(
          (row) => `#${row.id} ${row.scope_id}: ${row.error_type || "Error"} ${compact(row.error_message, 140)}`,
        ),
      ),
    );
  }
  return `${block(lines)}\n`;
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const dbPath = resolve(opts.db);
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  const report = collect(dbPath);
  if (opts.format === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(render(report));
}

export { collect, main, one, parseArgs, render, sqliteJson };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(renderError(error));
    process.exit(1);
  }
}
