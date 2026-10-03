#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  acquireMaintenanceLock,
  releaseMaintenanceLock,
} from "../dist/storage/sqlite/ingestion-store.js";

const DEFAULT_DB = "data/exocortex.sqlite";

function usage() {
  return `Usage: node scripts/lark-im-enrich-scopes.mjs [options]

Options:
  --db <path>       SQLite database path. Default: ${DEFAULT_DB}
  --limit <n>       Max scopes to enrich. Default: 50
  --dry-run         Report proposed changes without writing or acquiring locks.
  --help            Show this help.
`;
}

function parseArgs(argv) {
  const opts = { db: DEFAULT_DB, limit: 50, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
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
  const text = String(value);
  const parsed = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(parsed)) throw new Error(`${name} must be positive integer`);
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
  const result = spawnSync("sqlite3", ["-readonly", "-json", dbPath], {
    input: `.bail on\n.timeout 5000\nPRAGMA query_only = ON;\n${sql}`,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`${label} failed: ${String(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`);
  }
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

function sqliteExec(dbPath, sql, label) {
  const result = spawnSync("sqlite3", ["-json", dbPath], {
    input: `.bail on\n.timeout 5000\nPRAGMA foreign_keys = ON;\n${sql}`,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`${label} failed: ${String(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`);
  }
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

function runLark(args) {
  const result = spawnSync(process.env.LARK_CLI || "lark-cli", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `lark-cli exit ${result.status}`);
  return JSON.parse(result.stdout);
}

function acquireWriteMaintenanceLock(dbPath, reason) {
  const owner = `pid:${process.pid}:lark-im-enrich-scopes:${randomUUID()}`;
  // All remote work precedes this short local-commit lease.
  const result = acquireMaintenanceLock(dbPath, { owner, ttlSeconds: 60, reason });
  if (result.acquired) return owner;
  if (result.reason === "sync_locks_active") {
    throw new Error(`maintenance lock unavailable: ${result.active_sync_locks || 0} active sync lock(s); retry shortly`);
  }
  throw new Error(`maintenance lock unavailable: held by ${result.lock_owner || "another maintenance command"}`);
}

function loadScopes(dbPath, limit) {
  return sqliteJson(
    dbPath,
    `SELECT DISTINCT s.id, s.source_id, s.config_json, s.updated_at
     FROM sync_scopes s
     JOIN records r ON r.first_seen_scope_id = s.id
     WHERE s.id LIKE 'lark.im.received.chat.%'
       AND s.source_id = 'lark.im'
       AND COALESCE(json_extract(s.config_json, '$.chat_name'), '') = ''
     ORDER BY s.updated_at DESC
     LIMIT ${Number(limit)};`,
    "load scopes",
  ).map((row) => ({ ...row, config: JSON.parse(row.config_json || "{}") }));
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
  let failed = 0;
  const updates = [];
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
      updates.push(`UPDATE sync_scopes
        SET config_json = ${sqlJson(nextConfig)},
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ${quoteSql(scope.id)}
          AND source_id IS ${quoteSql(scope.source_id)}
          AND config_json IS ${quoteSql(scope.config_json)}
          AND updated_at IS ${quoteSql(scope.updated_at)};
        INSERT INTO __enrichment_effects (updated) VALUES (changes());`);
    } catch {
      failed += 1;
    }
  }

  let updated = 0;
  let skippedConflicts = 0;
  if (updates.length > 0 && !opts.dryRun) {
    const lockOwner = acquireWriteMaintenanceLock(dbPath, "lark-im-enrich-scopes");
    try {
      // A newer discovery/reconcile snapshot must survive the remote lookup.
      // Recheck the lease under the same write transaction as the CAS updates.
      const effects = sqliteExec(dbPath, `
        BEGIN IMMEDIATE;
        CREATE TEMP TABLE __enrichment_fence (allowed INTEGER NOT NULL CHECK (allowed = 1));
        INSERT INTO __enrichment_fence (allowed)
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM maintenance_locks
          WHERE name = 'global'
            AND owner = ${quoteSql(lockOwner)}
            AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ) AND NOT EXISTS (SELECT 1 FROM sync_locks) THEN 1 ELSE 0 END;
        CREATE TEMP TABLE __enrichment_effects (updated INTEGER NOT NULL);
        ${updates.join("\n")}
        SELECT COALESCE(SUM(updated), 0) AS updated FROM __enrichment_effects;
        COMMIT;
      `, "update scopes");
      updated = Number(effects[0]?.updated || 0);
      skippedConflicts = updates.length - updated;
    } finally {
      releaseMaintenanceLock(dbPath, lockOwner);
    }
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    dry_run: opts.dryRun,
    scanned: scopes.length,
    planned: updates.length,
    updated,
    skipped_conflicts: skippedConflicts,
    failed,
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
