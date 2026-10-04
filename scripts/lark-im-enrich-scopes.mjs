#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { quoteSql, sqlJson } from "../dist/storage/sqlite/ingestion-store.js";
import { readOnlySqliteJson as sqliteJson } from "../src/storage/sqlite/readonly-query.mjs";
import { commitEnrichmentUpdates, publicEnrichmentError } from "./lib/lark-im-enrichment.mjs";
import { fetchChatMetadata } from "../src/adapters/lark-im/adapter.mjs";

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

function main(opts) {
  const dbPath = resolve(opts.db);
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  const scopes = loadScopes(dbPath, opts.limit);
  let failed = 0;
  const updates = [];
  for (const scope of scopes) {
    if (!scope.config.chat_id) continue;
    try {
      const { chat_name: chatName } = fetchChatMetadata(scope.config.chat_id);
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

  // A newer discovery/reconcile snapshot must survive the remote lookup.
  const { updated, skippedConflicts } = commitEnrichmentUpdates(dbPath, updates, {
    dryRun: opts.dryRun, reason: "lark-im-enrich-scopes", label: "update scopes",
  });
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
  const opts = parseArgs(process.argv.slice(2));
  try {
    main(opts);
  } catch (error) {
    throw publicEnrichmentError(error, "scope enrichment failed");
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
