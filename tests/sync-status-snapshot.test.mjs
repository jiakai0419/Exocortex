import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { createLarkImAdapter } from "../src/adapters/lark-im/adapter.mjs";
import { createSyncRunner } from "../src/adapters/lark-im/sync-runner.mjs";
import { evaluateWaitState } from "../src/diagnostics/service-wait-state.mjs";
import { buildServiceOverview } from "../src/diagnostics/lark-im-service-report.mjs";
import { buildStatus } from "../src/diagnostics/sync-status-report.mjs";
import { readOnlySqliteJson } from "../src/storage/sqlite/readonly-query.mjs";
import { ensureInitialized, readScope, sqliteExec, sqliteQuery } from "../dist/storage/sqlite/ingestion-store.js";

// Entirely invented records. Writers below use the real sync adapter and store;
// no returned report rows, transactions or pending counts are mocked.
const START = Date.parse("2026-03-04T05:00:00.000Z");
const MINUTE = 60_000;
const SCOPE = "lark.im.sent_by_me";
const PROFILE = { open_id: "ou_synthetic_snapshot_self", name: "Synthetic Snapshot" };
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const context = () => ({ self: PROFILE, contacts: new Map(), chat_members: new Map(),
  apps: new Map(), app_fallbacks: new Map() });
const page = (items) => ({ ok: true, data: { items, has_more: false, page_token: "" } });

function raw(name, milliseconds, merge = false) {
  return {
    message_id: `om_synthetic_snapshot_${name}`, chat_id: "oc_synthetic_snapshot",
    msg_type: merge ? "merge_forward" : "text", create_time: String(milliseconds), update_time: String(milliseconds + 1),
    sender: { id: PROFILE.open_id, id_type: "open_id", sender_type: "user" },
    body: { content: merge ? "invented pending merge" : JSON.stringify({ text: `invented snapshot ${name}` }) },
  };
}

function options(endMs) {
  return { startMs: START, endMs, endExplicit: true, stableHorizonSeconds: 30,
    pageSize: 50, maxPages: 40, chatPageSize: 100, chatTypes: "group", lockTtlSeconds: 600,
    retries: 0, retryDelayMs: 0 };
}

function syncSent(dbPath, messages, endMs) {
  const adapter = createLarkImAdapter({ run(args) {
    const path = args[2];
    const params = JSON.parse(args[args.indexOf("--params") + 1]);
    if (path.endsWith("/search")) return page(messages.map((message) => ({ meta_data: { message_id: message.message_id } })));
    if (path.endsWith("/mget")) return page(params.message_ids.map((id) => messages.find((message) => message.message_id === id)));
    throw new Error("lark-cli failed: kind=permission_denied");
  } });
  return createSyncRunner({ ...adapter, buildPeopleContext: context }).syncSent(dbPath, options(endMs), PROFILE);
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "exocortex-status-snapshot-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "invented.sqlite");
  ensureInitialized(dbPath);
  sqliteExec(dbPath, `PRAGMA journal_mode=WAL;
    UPDATE sources SET config_json=json_set(config_json,'$.initial_sync_start_ms',${START}) WHERE id='lark.im';
    UPDATE sync_scopes SET cursor_json='{"has_more":false}' WHERE id='lark.im.unmuted_chat_discovery';`);
  assert.equal(sqliteQuery(dbPath, "PRAGMA journal_mode;")[0].journal_mode, "wal");
  const initial = syncSent(dbPath, [raw("before", START + MINUTE)], START + MINUTE);
  assert.equal(initial.ok, true, JSON.stringify(initial));
  const before = buildStatus(dbPath);
  assert.equal(before.health, "ok");
  assert.equal(before.details.pending_count, 0);
  assert.equal(before.records.total, 1);
  assert.equal(before.list_progress.oldest_cursor_ms, START + MINUTE);
  return { directory, dbPath, before };
}

const laterMessages = () => [raw("denied_root", START + 90_000, true), raw("after", START + 2 * MINUTE)];

function commitLater(dbPath) {
  const result = syncSent(dbPath, laterMessages(), START + 3 * MINUTE);
  assert.equal(result.list_complete, true, JSON.stringify(result));
  assert.equal(result.pending_details, 1);
  assert.equal(result.ok, false);
  return result;
}

function assertOldSnapshot(report, before) {
  assert.equal(report.details.pending_count, 0);
  assert.equal(report.list_progress.oldest_cursor_ms, START + MINUTE,
    "pending=0 cannot be combined with the newer incomplete list frontier");
  assert.equal(report.records.total, 1);
  assert.equal(report.records.by_direction[0].count, 1,
    "record total and directional counts must belong to the same snapshot");
  assert.deepEqual(report.runs.by_status, before.runs.by_status);
  assert.deepEqual(report.runs.recent, before.runs.recent);
  assert.equal(report.health, "ok");
}

function assertCommittedDebtIsVisible(dbPath) {
  assert.equal(readScope(dbPath, SCOPE).cursor.created_at_ms, START + MINUTE,
    "the concurrent writer advanced list coverage, never full content");
  const after = buildStatus(dbPath);
  assert.equal(after.details.evidence, "available");
  assert.equal(after.details.pending_count, 1);
  assert.equal(after.list_progress.oldest_cursor_ms, START + 3 * MINUTE);
  assert.equal(after.records.total, 2);
  assert.equal(after.runs.by_status.failed, 1);
  assert.equal(after.health, "catching_up");
  const nowMs = Date.now();
  const workerSummary = { last_cycle: { cycle: 2, at: new Date(nowMs).toISOString(), started_at: new Date(nowMs - 1).toISOString(), complete: true, ok: true },
    in_progress: false, unfinished_cycle: false };
  const overview = buildServiceOverview({ launchd: { loaded: true, state: "running", pid: 4321 },
    syncStatus: after, workerSummary, nowMs });
  assert.equal(overview.health.status, "catching_up");
  const waiting = evaluateWaitState(nowMs - 1, after, workerSummary, { status: "running", target_match: "matched" });
  assert.equal(waiting.newOkCycle, true, "fixture must independently satisfy the successful-cycle requirement");
  assert.equal(waiting.healthReady, false);
  assert.equal(waiting.ready, false);
  return after;
}

test("a denied-root commit after pending totals cannot mix old debt with new lists, records or health", (t) => {
  const { dbPath, before } = fixture(t);
  let writes = 0;
  const report = buildStatus(dbPath, { sqliteJson(path, sql, label) {
    const rows = readOnlySqliteJson(path, sql, label);
    // This is the exact old race boundary. A batched report reads every section
    // together, so the same hook fires only after the complete old snapshot.
    if (!writes && /pending_count/.test(sql)) {
      writes += 1;
      commitLater(path);
    }
    return rows;
  } });
  assert.equal(writes, 1, "the real writer must run at the intended read boundary");
  assertCommittedDebtIsVisible(dbPath);
  assertOldSnapshot(report, before);
});

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function writeConcurrentWriter(directory) {
  const script = join(directory, "synthetic-writer.mjs");
  const witness = join(directory, "writer-completed.json");
  const imports = {
    adapter: pathToFileURL(join(ROOT, "src/adapters/lark-im/adapter.mjs")).href,
    runner: pathToFileURL(join(ROOT, "src/adapters/lark-im/sync-runner.mjs")).href,
  };
  writeFileSync(script, `import { writeFileSync } from "node:fs";
import { createLarkImAdapter } from ${JSON.stringify(imports.adapter)};
import { createSyncRunner } from ${JSON.stringify(imports.runner)};
const profile = ${JSON.stringify(PROFILE)};
const messages = ${JSON.stringify(laterMessages())};
const page = items => ({ok:true,data:{items,has_more:false,page_token:""}});
const adapter = createLarkImAdapter({run(args) {
  const params = JSON.parse(args[args.indexOf("--params")+1]);
  if (args[2].endsWith("/search")) return page(messages.map(message=>({meta_data:{message_id:message.message_id}})));
  if (args[2].endsWith("/mget")) return page(params.message_ids.map(id=>messages.find(message=>message.message_id===id)));
  throw new Error("lark-cli failed: kind=permission_denied");
}});
const runner = createSyncRunner({...adapter,buildPeopleContext:()=>({self:profile,contacts:new Map(),chat_members:new Map(),apps:new Map(),app_fallbacks:new Map()})});
const result = runner.syncSent(process.argv[2], ${JSON.stringify(options(START + 3 * MINUTE))}, profile);
if (!result.list_complete || result.pending_details !== 1) throw new Error("synthetic concurrent commit failed");
writeFileSync(process.argv[3], JSON.stringify({committed:true,pending:result.pending_details}));
`, { encoding: "utf8", mode: 0o600 });
  return { script, witness };
}

test("one real SQLite WAL read transaction stays coherent while an independent sync writer commits", (t) => {
  const { directory, dbPath, before } = fixture(t);
  const { script, witness } = writeConcurrentWriter(directory);
  let snapshots = 0;
  const report = buildStatus(dbPath, { sqliteJson(path, sql, label) {
    if (!/pending_count/.test(sql)) return readOnlySqliteJson(path, sql, label);
    snapshots += 1;
    return readOnlySqliteJson(path, sql, label, { spawnSync(command, args, opts) {
      // Establish a real read snapshot, then synchronously wait for a separate
      // process to commit through real syncSent while that snapshot stays open.
      const establishSnapshotAndWrite = `BEGIN;\n.output /dev/null\nSELECT COUNT(*) FROM lark_im_detail_tasks;\n.output stdout\n.shell ${[process.execPath, script, path, witness].map(shellQuote).join(" ")}\n`;
      assert.match(opts.input, /BEGIN;\n/);
      return spawnSync(command, args, { ...opts, input: opts.input.replace("BEGIN;\n", establishSnapshotAndWrite) });
    } });
  } });
  assert.equal(snapshots, 1);
  assert.deepEqual(JSON.parse(readFileSync(witness, "utf8")), { committed: true, pending: 1 });
  assertCommittedDebtIsVisible(dbPath);
  assertOldSnapshot(report, before);
});

test("schema migration during status preflight cannot silently hide newly available detail debt", (t) => {
  const { dbPath } = fixture(t);
  commitLater(dbPath);
  const rootRow = sqliteQuery(dbPath, "SELECT * FROM lark_im_detail_tasks;")[0];
  sqliteExec(dbPath, `ALTER TABLE lark_im_detail_tasks RENAME TO synthetic_saved_detail_tasks;
    ALTER TABLE lark_im_list_progress RENAME TO synthetic_saved_list_progress;
    DELETE FROM schema_migrations WHERE version='009';`);
  let migrated = false;
  assert.throws(() => buildStatus(dbPath, { sqliteJson(path, sql, label) {
    const rows = readOnlySqliteJson(path, sql, label);
    if (!migrated && /sqlite_schema/.test(sql)) {
      migrated = true;
      // Re-publish the complete schema and existing synthetic debt after the
      // legacy-schema preflight, before the report acquires its final snapshot.
      sqliteExec(path, `ALTER TABLE synthetic_saved_detail_tasks RENAME TO lark_im_detail_tasks;
        ALTER TABLE synthetic_saved_list_progress RENAME TO lark_im_list_progress;
        INSERT INTO schema_migrations(version,name,applied_at) VALUES('009','synthetic migration',strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
    }
    return rows;
  } }), /schema|snapshot|changed|migration/i);
  assert.equal(migrated, true);
  assert.equal(sqliteQuery(dbPath, "SELECT * FROM lark_im_detail_tasks;")[0].message_id, rootRow.message_id);
  assertCommittedDebtIsVisible(dbPath);
});
