// @ts-check
/** @typedef {Record<string, any>} JsonObject */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { quoteSql, sqlJson } from "../../dist/storage/sqlite/ingestion-store.js";
import { readOnlySqliteJson as sqliteJson } from "../storage/sqlite/readonly-query.mjs";
import { commitEnrichmentUpdates, publicEnrichmentError } from "./enrichment-commit.mjs";
import { fetchChatMetadata } from "../adapters/lark-im/adapter.mjs";

/** @returns {JsonObject[]} */
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

/** @param {JsonObject} opts @param {JsonObject} [deps] */
function enrichScopes(opts, deps = {}) {
  const dbPath = resolve(opts.db);
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  const scopes = loadScopes(dbPath, opts.limit);
  let failed = 0;
  const updates = [];
  for (const scope of scopes) {
    if (!scope.config.chat_id) continue;
    try {
      const { chat_name: chatName } = (deps.fetchChatMetadata || fetchChatMetadata)(scope.config.chat_id);
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

  deps.assertReady?.();
  // A newer discovery/reconcile snapshot must survive the remote lookup.
  const { updated, skippedConflicts } = commitEnrichmentUpdates(dbPath, updates, {
    dryRun: opts.dryRun, reason: "lark-im-enrich-scopes", label: "update scopes",
  });
  return {
    ok: true,
    dry_run: opts.dryRun,
    scanned: scopes.length,
    planned: updates.length,
    updated,
    skipped_conflicts: skippedConflicts,
    failed,
  };
}

export { enrichScopes };
