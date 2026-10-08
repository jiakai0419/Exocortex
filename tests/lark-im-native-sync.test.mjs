import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLarkImAdapter } from "../src/adapters/lark-im/adapter.mjs";
import { createSyncRunner } from "../src/adapters/lark-im/sync-runner.mjs";
import { ensureInitialized, quoteSql, readLarkListProgress, readScope, sqliteExec, sqliteQuery } from "../dist/storage/sqlite/ingestion-store.js";

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
  sqliteExec(dbPath, `UPDATE sources SET config_json=json_set(config_json,'$.initial_sync_start_ms',${START}) WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(
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
  assert.equal(initial.ok, true, JSON.stringify(initial));
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

function syntheticDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "exocortex-incomplete-sync-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "synthetic.sqlite");
  ensureInitialized(dbPath);
  sqliteExec(dbPath, `UPDATE sources SET config_json=json_set(config_json,'$.initial_sync_start_ms',${START}) WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(
    ${quoteSql(SCOPE)},'lark.im','synthetic incomplete details',${quoteSql(JSON.stringify({ chat_id: "oc_fixture", chat_type: "group" }))});`);
  return dbPath;
}

const context = () => ({ self: PROFILE, contacts: new Map(), chat_members: new Map(),
  apps: new Map(), app_fallbacks: new Map() });
const rawMerge = (index, ms) => ({ ...raw(index, ms), msg_type: "merge_forward",
  body: { content: "synthetic merged root" } });
const nativePage = (items, has_more = false, page_token = "") => ({ ok: true,
  data: { items, has_more, page_token } });

for (const direction of ["received", "sent"]) {
  test(`${direction} detail denial preserves a successful list stage and failed detail attempt for retry`, (t) => {
    const dbPath = syntheticDatabase(t);
    const scopeId = direction === "sent" ? "lark.im.sent_by_me" : SCOPE;
    const root = rawMerge(40, START + 30_000);
    const ordinary = [raw(41, START + 1_000), raw(42, START + 45_000)];
    let denied = true;
    const paths = [];
    const adapter = createLarkImAdapter({ run(args) {
      const path = args[2];
      paths.push(path);
      const params = JSON.parse(args[args.indexOf("--params") + 1]);
      if (path.endsWith("/search")) {
        const items = params.page_token ? [ordinary[1]] : [ordinary[0], root];
        return nativePage(items.map((item) => ({ meta_data: { message_id: item.message_id } })),
          !params.page_token, params.page_token ? "" : "next");
      }
      if (path.endsWith("/mget")) {
        return nativePage(params.message_ids.map((id) => [root, ...ordinary].find((item) => item.message_id === id)));
      }
      if (path === "/open-apis/im/v1/messages") {
        return params.page_token ? nativePage([ordinary[1]]) : nativePage([ordinary[0], root], true, "next");
      }
      assert.equal(path, `/open-apis/im/v1/messages/${root.message_id}`);
      if (denied) throw new Error("lark-cli failed: kind=bot_user_out_of_chat; synthetic-private-detail");
      return nativePage([root, raw(43, START - 60_000)]);
    } });
    const runner = createSyncRunner({ ...adapter, buildPeopleContext: context });
    const sync = () => direction === "sent" ? runner.syncSent(dbPath, opts(START + 60_000), PROFILE)
      : runner.syncReceivedScope(dbPath, opts(START + 60_000), readScope(dbPath, scopeId), PROFILE);
    const before = sqliteQuery(dbPath, `SELECT cursor_json,cursor_updated_at,last_success_run_id FROM sync_scopes WHERE id=${quoteSql(scopeId)};`)[0];
    const failed = sync();
    assert.equal(failed.ok, false);
    assert.equal(failed.incomplete, true, JSON.stringify(failed));
    assert.equal(failed.inserted, 2);
    assert.doesNotMatch(failed.error, /synthetic-private|om_fixture|oc_fixture/);
    const after = sqliteQuery(dbPath, `SELECT cursor_json,cursor_updated_at,last_success_run_id FROM sync_scopes WHERE id=${quoteSql(scopeId)};`)[0];
    assert.deepEqual(after, before);
    assert.equal(readScope(dbPath, scopeId).enabled, 1);
    assert.deepEqual(sqliteQuery(dbPath, "SELECT external_id FROM records ORDER BY external_id;").map((row) => row.external_id),
      ordinary.map((item) => item.message_id));
    const run = sqliteQuery(dbPath, "SELECT status,cursor_after_json,metadata_json FROM sync_runs;")[0];
    assert.equal(run.status, "succeeded");
    const metadata = JSON.parse(run.metadata_json);
    assert.equal(metadata.window_complete, false);
    assert.equal(metadata.pages, 2);
    assert.equal(metadata.pending_detail_count, 1);
    assert.equal(metadata.list_complete, true);
    assert.equal(metadata.details_complete, false);
    assert.equal(readLarkListProgress(dbPath, readScope(dbPath, scopeId)).cursor.created_at_ms, START + 60_000);
    const missing = sqliteQuery(dbPath, `SELECT status,last_error_message FROM lark_im_detail_tasks WHERE scope_id=${quoteSql(scopeId)};`)[0];
    assert.equal(missing.status, "pending");
    assert.match(missing.last_error_message, /bot_user_out_of_chat/);
    assert.doesNotMatch(missing.last_error_message, /synthetic-private|om_fixture|oc_fixture/);
    assert.equal(metadata.window_start, undefined, "incomplete list stages must not emit full coverage-window keys");
    assert.doesNotMatch(run.metadata_json, /synthetic-private|om_fixture/);
    assert.equal(sqliteQuery(dbPath, "SELECT COUNT(*) AS n FROM sync_locks;")[0].n, 0);

    sqliteExec(dbPath, `UPDATE lark_im_detail_tasks SET retry_at='2000-01-01T00:00:00.000Z';`);
    const repeated = sync();
    assert.equal(repeated.ok, false);
    assert.equal(repeated.duplicate, 0, "completed list coverage does not rewind to denied roots");
    denied = false;
    sqliteExec(dbPath, `UPDATE lark_im_detail_tasks SET retry_at='2000-01-01T00:00:00.000Z';`);
    const recovered = runner.retryDetails(dbPath, opts(START + 60_000), PROFILE)[0];
    assert.equal(recovered.ok, true);
    assert.equal(recovered.inserted, 1);
    assert.equal(recovered.duplicate, 0);
    assert.equal(readScope(dbPath, scopeId).cursor.created_at_ms, START + 60_000);
    assert.deepEqual(sqliteQuery(dbPath, "SELECT status FROM sync_runs ORDER BY id;").map((row) => row.status),
      ["succeeded", "failed", "succeeded", "failed", "succeeded"]);
    assert.equal(sqliteQuery(dbPath, "SELECT COUNT(*) AS n FROM records;")[0].n, 3);
    assert.match(sqliteQuery(dbPath, `SELECT body FROM records WHERE external_id=${quoteSql(root.message_id)};`)[0].body, /synthetic 43/);
    assert.equal(paths.filter((path) => path.endsWith(root.message_id)).length, 3);
  });
}

test("a previously expanded boundary root survives denied edited details while newer ordinary messages persist", (t) => {
  const dbPath = syntheticDatabase(t);
  const root = rawMerge(50, START + 60_000);
  let denied = false;
  const adapter = createLarkImAdapter({ run(args) {
    if (args[2] === "/open-apis/im/v1/messages") return nativePage(denied
      ? [{ ...root, update_time: String(START + 120_000) }, raw(51, START + 90_000)] : [root]);
    if (denied) throw new Error("lark-cli failed: kind=restricted_mode");
    return nativePage([root, raw(52, START)]);
  } });
  const runner = createSyncRunner({ ...adapter, buildPeopleContext: context });
  assert.equal(runner.syncReceivedScope(dbPath, opts(START + 60_000), readScope(dbPath, SCOPE), PROFILE).ok, true);
  const saved = sqliteQuery(dbPath, `SELECT raw_json,canonical_json,body,updated_at FROM records WHERE external_id=${quoteSql(root.message_id)};`)[0];
  const before = sqliteQuery(dbPath, `SELECT cursor_json,cursor_updated_at,last_success_run_id FROM sync_scopes WHERE id=${quoteSql(SCOPE)};`)[0];
  denied = true;
  const failed = runner.syncReceivedScope(dbPath, opts(START + 120_000), readScope(dbPath, SCOPE), PROFILE);
  assert.equal(failed.ok, false);
  assert.equal(failed.inserted, 1);
  assert.deepEqual(sqliteQuery(dbPath, `SELECT raw_json,canonical_json,body,updated_at FROM records WHERE external_id=${quoteSql(root.message_id)};`)[0], saved);
  assert.deepEqual(sqliteQuery(dbPath, `SELECT cursor_json,cursor_updated_at,last_success_run_id FROM sync_scopes WHERE id=${quoteSql(SCOPE)};`)[0], before);
  assert.equal(readLarkListProgress(dbPath, readScope(dbPath, SCOPE)).cursor.created_at_ms, START + 120_000);
  assert.equal(readScope(dbPath, SCOPE).enabled, 1);
});

test("an unchanged completed boundary root reuses its receipt without reopening detail debt", (t) => {
  const dbPath = syntheticDatabase(t);
  const root = rawMerge(55, START + 60_000);
  let replay = false;
  let detailCalls = 0;
  const adapter = createLarkImAdapter({ run(args) {
    if (args[2] === "/open-apis/im/v1/messages") return nativePage(replay ? [root, raw(56, START + 90_000)] : [root]);
    detailCalls += 1;
    if (replay) throw new Error("lark-cli failed: kind=restricted_mode");
    return nativePage([root, raw(57, START)]);
  } });
  const runner = createSyncRunner({ ...adapter, buildPeopleContext: context });
  assert.equal(runner.syncReceivedScope(dbPath, opts(START + 60_000), readScope(dbPath, SCOPE), PROFILE).ok, true);
  const saved = sqliteQuery(dbPath, `SELECT raw_json,body FROM records WHERE external_id=${quoteSql(root.message_id)};`)[0];
  replay = true;
  const result = runner.syncReceivedScope(dbPath, opts(START + 120_000), readScope(dbPath, SCOPE), PROFILE);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.inserted, 1);
  assert.equal(detailCalls, 1, "unchanged source fingerprint has durable completed detail evidence");
  assert.deepEqual(sqliteQuery(dbPath, `SELECT raw_json,body FROM records WHERE external_id=${quoteSql(root.message_id)};`)[0], saved);
  assert.equal(readScope(dbPath, SCOPE).cursor.created_at_ms, START + 120_000);
  assert.equal(sqliteQuery(dbPath, "SELECT COUNT(*) AS n FROM lark_im_detail_tasks WHERE status='pending';")[0].n, 0);
});

test("native window deadline retries a complete minute prefix and next run resumes without losing boundary messages", (t) => {
  const dbPath = syntheticDatabase(t);
  let now = 0;
  const windowStarts = [];
  const windowEnds = [];
  let failLarge = true;
  const adapter = createLarkImAdapter({ clock: () => now, run(args) {
    const params = JSON.parse(args[args.indexOf("--params") + 1]);
    const start = Number(params.start_time) * 1000;
    const end = Number(params.end_time) * 1000;
    windowStarts.push(start);
    windowEnds.push(end);
    if (failLarge && end - start > 60_000) {
      now += 180_000;
      throw new Error("lark-cli failed: kind=network_timeout retry_exhausted=1");
    }
    return nativePage([raw(60, START), raw(61, START + 60_000), raw(62, START + 120_000)]);
  } });
  const runner = createSyncRunner({ ...adapter, buildPeopleContext: context });
  const target = START + 33 * 86_400_000;
  const first = runner.syncReceivedScope(dbPath, opts(target), readScope(dbPath, SCOPE), PROFILE);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.inserted, 2);
  assert.deepEqual(windowEnds, [target, START + 60_000]);
  assert.equal(readScope(dbPath, SCOPE).cursor.created_at_ms, START + 60_000);
  failLarge = false;
  const next = runner.syncReceivedScope(dbPath, opts(target), readScope(dbPath, SCOPE), PROFILE);
  assert.equal(next.ok, true);
  assert.equal(next.inserted, 1);
  assert.equal(next.duplicate, 1, "the minute boundary is deliberately reread");
  assert.equal(windowStarts.at(-1), START + 60_000);
  assert.equal(sqliteQuery(dbPath, "SELECT COUNT(*) AS n FROM records;")[0].n, 3);
});

test("native one-minute budget saturation leaves cursor and records unchanged", (t) => {
  const dbPath = syntheticDatabase(t);
  let now = 0;
  let calls = 0;
  const adapter = createLarkImAdapter({ clock: () => now, run() {
    calls += 1;
    now += 180_000;
    throw new Error("lark-cli failed: kind=network_timeout retry_exhausted=1");
  } });
  const runner = createSyncRunner({ ...adapter, buildPeopleContext: context });
  const result = runner.syncReceivedScope(dbPath, opts(START + 33 * 86_400_000), readScope(dbPath, SCOPE), PROFILE);
  assert.equal(result.ok, false);
  assert.match(result.error, /shared time budget/);
  assert.equal(calls, 2);
  assert.equal(readScope(dbPath, SCOPE).cursor, null);
  assert.equal(readScope(dbPath, SCOPE).enabled, 1);
  assert.equal(sqliteQuery(dbPath, "SELECT COUNT(*) AS n FROM records;")[0].n, 0);
  assert.equal(sqliteQuery(dbPath, "SELECT status FROM sync_runs;")[0].status, "failed");
});

test("a later list failure commits neither ordinary records, missing-root tasks nor cursor", (t) => {
  const dbPath = syntheticDatabase(t);
  const root = rawMerge(70, START);
  const adapter = createLarkImAdapter({ run(args) {
    if (args[2] !== "/open-apis/im/v1/messages") throw new Error("kind=restricted_mode");
    const params = JSON.parse(args[args.indexOf("--params") + 1]);
    if (params.page_token) throw new Error("lark-cli failed: kind=network_error retry_exhausted=1");
    return nativePage([root, raw(71, START)], true, "next");
  } });
  const runner = createSyncRunner({ ...adapter, buildPeopleContext: context });
  const result = runner.syncReceivedScope(dbPath, opts(START + 60_000), readScope(dbPath, SCOPE), PROFILE);
  assert.equal(result.ok, false);
  assert.equal(result.incomplete, undefined, "ordinary records are safe to commit only after list pagination completes");
  assert.equal(readScope(dbPath, SCOPE).enabled, 1);
  assert.equal(readScope(dbPath, SCOPE).cursor, null);
  assert.equal(sqliteQuery(dbPath, "SELECT COUNT(*) AS n FROM records;")[0].n, 0);
  assert.equal(sqliteQuery(dbPath, "SELECT COUNT(*) AS n FROM lark_im_detail_tasks;")[0].n, 0);
  assert.equal(readLarkListProgress(dbPath, readScope(dbPath, SCOPE)), null);
  assert.equal(sqliteQuery(dbPath, "SELECT status FROM sync_runs;")[0].status, "failed");
});
