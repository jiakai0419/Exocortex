#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_DB = "data/exocortex.sqlite";

function usage() {
  return `Usage: node scripts/lark-im-enrich-scopes.mjs [options]

Options:
  --db <path>       SQLite database path. Default: ${DEFAULT_DB}
  --limit <n>       Max scopes to enrich. Default: 50
  --help            Show this help.
`;
}

function parseArgs(argv) {
  const opts = { db: DEFAULT_DB, limit: 50 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--limit") opts.limit = parsePositiveInt(next, "limit");
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  return opts;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function quoteSql(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  return quoteSql(JSON.stringify(value));
}

function sqliteJson(dbPath, sql, label) {
  const result = spawnSync("sqlite3", ["-json", dbPath], {
    input: `.timeout 5000\n${sql}`,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

function sqliteExec(dbPath, sql, label) {
  const result = spawnSync("sqlite3", [dbPath], {
    input: `.timeout 5000\n${sql}`,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
}

function runLark(args) {
  const result = spawnSync(process.env.LARK_CLI || "lark-cli", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `lark-cli exit ${result.status}`);
  return JSON.parse(result.stdout);
}

function loadScopes(dbPath, limit) {
  return sqliteJson(
    dbPath,
    `SELECT DISTINCT s.id, s.config_json
     FROM sync_scopes s
     JOIN records r ON r.first_seen_scope_id = s.id
     WHERE s.id LIKE 'lark.im.received.chat.%'
       AND COALESCE(json_extract(s.config_json, '$.chat_name'), '') = ''
     ORDER BY s.updated_at DESC
     LIMIT ${Number(limit)};`,
    "load scopes",
  ).map((row) => ({ id: row.id, config: JSON.parse(row.config_json || "{}") }));
}

function chatNameFromResponse(json) {
  const data = json?.data || json;
  return data?.name || data?.i18n_names?.zh_cn || data?.i18n_names?.en_us || null;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = resolve(opts.db);
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  const scopes = loadScopes(dbPath, opts.limit);
  let updated = 0;
  let failed = 0;
  for (const scope of scopes) {
    if (!scope.config.chat_id) continue;
    try {
      const json = runLark([
        "im",
        "chats",
        "get",
        "--as",
        "user",
        "--params",
        JSON.stringify({ chat_id: scope.config.chat_id }),
        "--format",
        "json",
      ]);
      const chatName = chatNameFromResponse(json);
      if (!chatName) continue;
      const nextConfig = { ...scope.config, chat_name: chatName };
      sqliteExec(
        dbPath,
        `UPDATE sync_scopes
         SET config_json = ${sqlJson(nextConfig)},
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ${quoteSql(scope.id)};`,
        `update ${scope.id}`,
      );
      updated += 1;
    } catch {
      failed += 1;
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, scanned: scopes.length, updated, failed }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
