import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLarkImAdapter } from "../src/adapters/lark-im/adapter.mjs";
import { createSyncRunner } from "../src/adapters/lark-im/sync-runner.mjs";
import { ensureInitialized, quoteSql, readScope, sqliteExec, sqliteQuery } from "../dist/storage/sqlite/ingestion-store.js";

const START = Date.parse("2026-10-01T00:00:00+08:00");
const SCOPE = "lark.im.received.chat.native_fixture";
const PROFILE = { open_id: "ou_fixture_self", name: "Fixture" };
const opts = (endMs) => ({ startMs: START, endMs, endExplicit: true, stableHorizonSeconds: 30,
  pageSize: 50, maxPages: 5, chatPageSize: 100, chatTypes: "group", lockTtlSeconds: 600,
  retries: 0, retryDelayMs: 0 });

function raw(index, createMs) {
  return { message_id: `om_fixture_${index}`, chat_id: "oc_fixture", msg_type: "text",
    create_time: String(createMs), update_time: String(createMs + 1),
    sender: { id: index === 3 ? PROFILE.open_id : "ou_fixture_other", id_type: "open_id", sender_type: "user" },
    body: { content: JSON.stringify({ text: `synthetic ${index}` }) }, thread_id: "omt_fixture",
    ...(index > 0 ? { root_id: "om_fixture_0", parent_id: "om_fixture_0" } : {}) };
}

test("native root and replies commit atomically; later page failure retains cursor, records and releases lock", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "exocortex-native-sync-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "synthetic.sqlite");
  ensureInitialized(dbPath);
  sqliteExec(dbPath, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(
    ${quoteSql(SCOPE)},'lark.im','native synthetic fixture',${quoteSql(JSON.stringify({ chat_id: "oc_fixture", chat_type: "group" }))});`);
  let failSecondPage = false;
  let calls = 0;
  const originals = Array.from({ length: 9 }, (_, index) => raw(index, index === 8 ? START + 60_000 : START + index * 1000));
  const adapter = createLarkImAdapter({ run(args) {
    calls += 1;
    assert.deepEqual(args.slice(0, 3), ["api", "GET", "/open-apis/im/v1/messages"]);
    const params = JSON.parse(args[args.indexOf("--params") + 1]);
    assert.equal(params.only_thread_root_messages, false);
    if (!failSecondPage) return { ok: true, data: { items: [raw(-1, START - 1), ...originals,
      raw(99, START + 60_001)], has_more: false } };
    if (!params.page_token) return { ok: true, data: { items: [raw(10, START + 70_000)], has_more: true, page_token: "next" } };
    return { ok: false, error: { code: 999, message: "synthetic private payload" } };
  } });
  const runner = createSyncRunner({ ...adapter, buildPeopleContext: () => ({ self: PROFILE,
    contacts: new Map(), chat_members: new Map(), apps: new Map(), app_fallbacks: new Map() }) });
  const initial = runner.syncReceivedScope(dbPath, opts(START + 60_000), readScope(dbPath, SCOPE), PROFILE);
  assert.equal(initial.ok, true);
  assert.equal(initial.records, 9);
  const stored = sqliteQuery(dbPath, "SELECT external_id,external_version,direction,raw_json,canonical_json,body FROM records ORDER BY external_id;");
  assert.equal(stored.length, 9);
  assert.equal(stored.filter((row) => row.direction === "sent").length, 1);
  assert.equal(stored.filter((row) => row.direction === "received").length, 8);
  assert.deepEqual(stored.map((row) => JSON.parse(row.raw_json)), originals);
  assert.equal(stored[1].external_version, originals[1].update_time);
  assert.equal(JSON.parse(stored[1].canonical_json).parent_id, "om_fixture_0");
  assert.equal(stored[1].body, "synthetic 1");
  const cursor = readScope(dbPath, SCOPE).cursor;
  assert.equal(cursor.created_at_ms, START + 60_000);

  failSecondPage = true;
  const failed = runner.syncReceivedScope(dbPath, opts(START + 120_000), readScope(dbPath, SCOPE), PROFILE);
  assert.equal(failed.ok, false);
  assert.doesNotMatch(failed.error, /private payload/);
  assert.deepEqual(readScope(dbPath, SCOPE).cursor, cursor);
  assert.equal(sqliteQuery(dbPath, "SELECT COUNT(*) AS n FROM records;")[0].n, 9);
  assert.equal(sqliteQuery(dbPath, "SELECT COUNT(*) AS n FROM sync_locks;")[0].n, 0);
  assert.deepEqual(sqliteQuery(dbPath, "SELECT status FROM sync_runs ORDER BY id;").map((row) => row.status), ["succeeded", "failed"]);
  assert.equal(calls, 3);
});
