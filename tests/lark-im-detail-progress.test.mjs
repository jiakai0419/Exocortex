import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLarkImAdapter } from "../src/adapters/lark-im/adapter.mjs";
import { createSyncRunner } from "../src/adapters/lark-im/sync-runner.mjs";
import { runLarkImSyncCli } from "./helpers/sync-command.mjs";
import {
  ensureInitialized,
  quoteSql,
  readLarkListProgress,
  readScope,
  sqliteExec,
  sqliteQuery,
} from "../dist/storage/sqlite/ingestion-store.js";

// All IDs, message bodies and source times in this file are invented fixtures.
const START = Date.parse("2026-04-02T03:00:00Z");
const MINUTE = 60_000;
const CHAT = "oc_synthetic_detail_progress";
const RECEIVED_SCOPE = "lark.im.received.chat.synthetic_detail_progress";
const SENT_SCOPE = "lark.im.sent_by_me";
const PROFILE = { open_id: "ou_synthetic_detail_self", name: "Synthetic Self" };

function options(endMs, overrides = {}) {
  return {
    startMs: START, endMs, endExplicit: true, stableHorizonSeconds: 30,
    stableHorizonMs: 30_000, pageSize: 50, maxPages: 1, chatPageSize: 100,
    maxChatPages: 100, discoveryPagesPerRun: 1, receivedScopesPerRun: 0,
    discoveryMode: "cursor", reconcileIntervalHours: 24, receivedMode: "all",
    chatTypes: "group", lockTtlSeconds: 600, retries: 0, retryDelayMs: 0,
    ...overrides,
  };
}

function raw(id, createdAt, overrides = {}) {
  return {
    message_id: `om_synthetic_detail_${id}`, chat_id: CHAT, msg_type: "text",
    create_time: String(createdAt), update_time: String(createdAt + 1),
    sender: { id: PROFILE.open_id, id_type: "open_id", sender_type: "user" },
    body: { content: JSON.stringify({ text: `invented detail fixture ${id}` }) },
    ...overrides,
  };
}

function merged(id, createdAt, overrides = {}) {
  return raw(id, createdAt, { msg_type: "merge_forward", body: { content: "synthetic merge root" }, ...overrides });
}

function database(t) {
  const directory = mkdtempSync(join(tmpdir(), "exocortex-detail-progress-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "invented.sqlite");
  ensureInitialized(dbPath);
  sqliteExec(dbPath, `UPDATE sources SET config_json=json_set(config_json,
    '$.initial_sync_start_ms',${START}) WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(
    ${quoteSql(RECEIVED_SCOPE)},'lark.im','invented detail progress',
    ${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: "group" }))});`);
  return dbPath;
}

const page = (items, has_more = false, page_token = "") => ({ ok: true, data: { items, has_more, page_token } });
const context = () => ({ self: PROFILE, contacts: new Map(), chat_members: new Map(),
  apps: new Map(), app_fallbacks: new Map() });
const scopeId = (direction) => direction === "sent" ? SENT_SCOPE : RECEIVED_SCOPE;
const tasks = (dbPath, id) => sqliteQuery(dbPath,
  `SELECT * FROM lark_im_detail_tasks WHERE scope_id=${quoteSql(id)} ORDER BY message_id;`);
const storedIds = (dbPath) => sqliteQuery(dbPath, "SELECT external_id FROM records ORDER BY external_id;")
  .map((record) => record.external_id);
const sync = (runner, dbPath, opts, direction) => direction === "sent"
  ? runner.syncSent(dbPath, opts, PROFILE)
  : runner.syncReceivedScope(dbPath, opts, readScope(dbPath, RECEIVED_SCOPE), PROFILE);

function makeRunner(run, overrides = {}) {
  return createSyncRunner({ ...createLarkImAdapter({ run, clock: overrides.clock || (() => 0) }),
    buildPeopleContext: context, nowMs: overrides.clock || (() => 0), ...overrides });
}

function listBounds(args) {
  const params = JSON.parse(args[args.indexOf("--params") + 1]);
  if (args[2].endsWith("/search")) {
    const body = JSON.parse(args[args.indexOf("--data") + 1]);
    return { params, start: Date.parse(body.filter.time_range.start_time), end: Date.parse(body.filter.time_range.end_time) };
  }
  return { params, start: Number(params.start_time) * 1000, end: Number(params.end_time) * 1000 };
}

function detailsCli(dbPath, runner, extraArgs = []) {
  let stdout = "";
  let stderr = "";
  const exitCode = runLarkImSyncCli(["--db", dbPath, "--scope", "details",
    "--start", new Date(START).toISOString(), "--end", new Date(START + 8 * MINUTE).toISOString(), ...extraArgs], {
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
    deps: { syncRunner: runner, getSelfProfile: () => PROFILE,
      resetTransportStats: () => {}, getTransportStats: () => ({ calls: 0 }) },
  });
  assert.equal(stderr, "");
  return { exitCode, summary: JSON.parse(stdout) };
}

for (const direction of ["received", "sent"]) {
  test(`${direction}: denied first root cannot starve later bounded prefixes; fresh runners and detail-only repair close full coverage`, (t) => {
    const dbPath = database(t);
    const id = scopeId(direction);
    const root = merged("first_root", START + 30_000);
    const ordinary = [1, 3, 5, 7].map((minute) => raw(`ordinary_${minute}`, START + minute * MINUTE));
    const all = [root, ...ordinary];
    const target = START + 8 * MINUTE;
    const lists = [];
    let detailCalls = 0;
    const deniedTransport = (args) => {
      const path = args[2];
      if (path.endsWith("/mget")) {
        const params = JSON.parse(args[args.indexOf("--params") + 1]);
        return page(params.message_ids.map((messageId) => all.find((message) => message.message_id === messageId)));
      }
      if (path === "/open-apis/im/v1/messages" || path.endsWith("/search")) {
        const { start, end } = listBounds(args);
        lists.push({ start, end });
        const items = all.filter((message) => Number(message.create_time) >= start && Number(message.create_time) <= end);
        return page(path.endsWith("/search") ? items.map((message) => ({ meta_data: { message_id: message.message_id } })) : items,
          end - start > 2 * MINUTE, end - start > 2 * MINUTE ? "synthetic-more" : "");
      }
      assert.equal(path, `/open-apis/im/v1/messages/${root.message_id}`);
      detailCalls += 1;
      throw new Error("lark-cli failed: kind=bot_user_out_of_chat; invented private diagnostic");
    };

    const before = readScope(dbPath, id).cursor;
    const frontiers = [];
    for (let cycle = 0; cycle < 8; cycle += 1) {
      // Recreate both adapter and runner: progress cannot depend on in-memory roots.
      const runner = makeRunner(deniedTransport);
      const result = sync(runner, dbPath, options(target), direction);
      const progress = readLarkListProgress(dbPath, readScope(dbPath, id));
      assert.ok(progress, JSON.stringify(result));
      frontiers.push(progress.cursor.created_at_ms);
      assert.ok(frontiers.at(-1) > (frontiers.at(-2) ?? START), "each completed prefix advances list coverage");
      assert.deepEqual(readScope(dbPath, id).cursor, before, "pending detail must not claim full coverage");
      assert.equal(readScope(dbPath, id).enabled, 1);
      assert.equal(tasks(dbPath, id).filter((task) => task.status === "pending").length, 1);
      if (progress.cursor.created_at_ms === target) break;
    }
    assert.ok(frontiers.length >= 3, "fixture must exercise repeated window shrinking and resume cycles");
    assert.equal(frontiers.at(-1), target);
    assert.ok(lists.some(({ start, end }) => end - start > 2 * MINUTE), "fixture exercised oversized list attempts");
    assert.deepEqual(storedIds(dbPath), ordinary.map((message) => message.message_id).sort());
    assert.ok(detailCalls >= 1);
    const pending = tasks(dbPath, id)[0];
    assert.equal(pending.message_id, root.message_id);
    assert.ok(pending.attempt_count >= 1);
    assert.deepEqual(JSON.parse(pending.raw_root_json), root);
    assert.doesNotMatch(pending.last_error_message, /invented private diagnostic|om_synthetic|oc_synthetic/);
    for (const run of sqliteQuery(dbPath,
      `SELECT status,metadata_json FROM sync_runs WHERE scope_id=${quoteSql(id)};`)) {
      const metadata = JSON.parse(run.metadata_json);
      assert.equal(run.status, metadata.lark_progress.phase === "list" ? "succeeded" : "failed");
      assert.equal(metadata.lark_progress.outcome, metadata.lark_progress.phase === "list" ? "awaiting_details" : "attempt_failed");
      assert.equal(metadata.list_complete, true);
      assert.equal(metadata.window_complete, false);
      assert.equal(metadata.details_complete, false);
      assert.equal(metadata.window_start, undefined, "partial content must not emit full coverage intervals");
      assert.equal(metadata.window_end, undefined);
    }

    // A standalone retry after a simulated restart does not fetch any list. A
    // newer authoritative root must resolve an older queued source snapshot.
    sqliteExec(dbPath, `UPDATE lark_im_detail_tasks SET retry_at='2000-01-01T00:00:00.000Z' WHERE scope_id=${quoteSql(id)};`);
    const refreshed = { ...root, update_time: String(START + 9 * MINUTE), body: { content: "synthetic edited merge root" } };
    const child = raw("recovered_child", START - MINUTE);
    let retryCalls = 0;
    const freshRunner = makeRunner((args) => {
      assert.equal(args[2], `/open-apis/im/v1/messages/${root.message_id}`, "--scope details must never re-fetch message lists");
      retryCalls += 1;
      return page([refreshed, child]);
    });
    const recovered = detailsCli(dbPath, freshRunner);
    assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.summary));
    assert.equal(retryCalls, 1);
    assert.equal(readScope(dbPath, id).cursor.created_at_ms, target);
    assert.equal(tasks(dbPath, id).filter((task) => task.status === "pending").length, 0);
    assert.deepEqual(storedIds(dbPath), [...ordinary, root].map((message) => message.message_id).sort());
    const record = sqliteQuery(dbPath,
      `SELECT external_version,raw_json,body FROM records WHERE external_id=${quoteSql(root.message_id)};`)[0];
    assert.equal(record.external_version, refreshed.update_time);
    assert.match(record.body, /invented detail fixture recovered_child/);
    assert.equal(JSON.parse(record.raw_json).update_time, refreshed.update_time);
    const closed = sqliteQuery(dbPath, `SELECT metadata_json FROM sync_runs
      WHERE id=(SELECT last_success_run_id FROM sync_scopes WHERE id=${quoteSql(id)});`)[0];
    const coverage = JSON.parse(closed.metadata_json);
    assert.equal(coverage.window_complete, true);
    assert.equal(coverage.window_start_ms, START);
    assert.equal(coverage.window_end_ms, target);
    assert.equal(sqliteQuery(dbPath, "SELECT COUNT(*) AS n FROM sync_locks;")[0].n, 0);
  });
}

test("independent detail retry continues to a healthy root after another root remains denied", (t) => {
  const dbPath = database(t);
  const blockedRoot = merged("a_blocked", START + 10_000);
  const healthyRoot = merged("b_healthy", START + 20_000);
  const ordinary = raw("fairness_ordinary", START + 7 * MINUTE);
  const child = raw("fairness_child", START - MINUTE);
  const target = START + 8 * MINUTE;
  const initial = makeRunner((args) => {
    if (args[2] === "/open-apis/im/v1/messages") return page([blockedRoot, healthyRoot, ordinary]);
    assert.ok([blockedRoot, healthyRoot].some(root => args[2] === `/open-apis/im/v1/messages/${root.message_id}`));
    throw new Error("lark-cli failed: kind=restricted_mode");
  });
  sync(initial, dbPath, options(target), "received");
  assert.equal(tasks(dbPath, RECEIVED_SCOPE).filter((task) => task.status === "pending").length, 2);
  sqliteExec(dbPath, `UPDATE lark_im_detail_tasks SET retry_at='2000-01-01T00:00:00.000Z';`);
  const requested = [];
  const restarted = makeRunner((args) => {
    requested.push(args[2]);
    if (args[2] === `/open-apis/im/v1/messages/${blockedRoot.message_id}`) {
      throw new Error("lark-cli failed: kind=restricted_mode");
    }
    assert.equal(args[2], `/open-apis/im/v1/messages/${healthyRoot.message_id}`);
    return page([healthyRoot, child]);
  });
  const retried = detailsCli(dbPath, restarted, ["--detail-limit", "2", "--detail-scope", RECEIVED_SCOPE]);
  assert.equal(retried.exitCode, 2, "remaining detail debt must remain visible in the CLI status");
  assert.deepEqual(requested, [blockedRoot, healthyRoot].map((root) => `/open-apis/im/v1/messages/${root.message_id}`));
  const after = tasks(dbPath, RECEIVED_SCOPE);
  assert.deepEqual(after.map((task) => [task.message_id, task.status]),
    [[blockedRoot.message_id, "pending"], [healthyRoot.message_id, "complete"]]);
  assert.deepEqual(storedIds(dbPath), [healthyRoot.message_id, ordinary.message_id].sort());
  assert.equal(readLarkListProgress(dbPath, readScope(dbPath, RECEIVED_SCOPE)).cursor.created_at_ms, target);
  assert.equal(readScope(dbPath, RECEIVED_SCOPE).cursor, null);
});

for (const direction of ["received", "sent"]) {
  test(`${direction}: automatic batches keep up with two healthy roots per listing across restarts`, t => {
    const dbPath = database(t), all = [];
    let detailCalls = 0;
    for (let cycle = 0; cycle < 6; cycle++) {
      all.push(...[0, 1].map(i => merged(`healthy_batch_${cycle}_${i}`, START + (cycle * 2 + i) * MINUTE + 1000)));
      const runner = makeRunner(args => {
        if (args[2].endsWith("/mget")) {
          const ids = JSON.parse(args[args.indexOf("--params") + 1]).message_ids;
          return page(ids.map(id => all.find(root => root.message_id === id)));
        }
        if (args[2] === "/open-apis/im/v1/messages" || args[2].endsWith("/search")) {
          const { start, end } = listBounds(args);
          const roots = all.filter(root => Number(root.create_time) >= start && Number(root.create_time) <= end);
          return page(args[2].endsWith("/search") ? roots.map(root => ({ meta_data: { message_id: root.message_id } })) : roots);
        }
        const root = all.find(root => args[2] === `/open-apis/im/v1/messages/${root.message_id}`);
        assert.ok(root); detailCalls++;
        return page([root, raw(`${root.message_id}_child`, START - MINUTE, { upper_message_id: root.message_id })]);
      });
      const target = START + (cycle + 1) * 2 * MINUTE;
      const result = sync(runner, dbPath, options(target), direction);
      assert.equal(result.ok, true); assert.equal(result.pending_details, 0);
      assert.equal(result.detail_retry.detail_attempts, 2);
      assert.equal(readScope(dbPath, scopeId(direction)).cursor.created_at_ms, target);
    }
    assert.equal(detailCalls, 12); assert.equal(storedIds(dbPath).length, 12);
  });
}

test("automatic detail batches cap attempts at five and finish the remainder on the next listing", t => {
  const dbPath = database(t), roots = Array.from({ length: 7 }, (_, i) => merged(`cap_${i}`, START + i * 1000));
  let detailCalls = 0;
  const runner = makeRunner(args => {
    if (args[2] === "/open-apis/im/v1/messages") return page(roots);
    const root = roots.find(root => args[2] === `/open-apis/im/v1/messages/${root.message_id}`);
    assert.ok(root); detailCalls++;
    return page([root, raw(`${root.message_id}_child`, START - MINUTE, { upper_message_id: root.message_id })]);
  });
  const first = sync(runner, dbPath, options(START + MINUTE), "received");
  assert.equal(first.detail_retry.detail_attempts, 5); assert.equal(detailCalls, 5); assert.equal(first.pending_details, 2);
  assert.equal(readScope(dbPath, RECEIVED_SCOPE).cursor, null);
  const second = sync(runner, dbPath, options(START + 2 * MINUTE), "received");
  assert.equal(second.detail_retry.detail_attempts, 2); assert.equal(detailCalls, 7); assert.equal(second.pending_details, 0);
  assert.equal(readScope(dbPath, RECEIVED_SCOPE).cursor.created_at_ms, START + 2 * MINUTE);
});

test("automatic details share one 30-second budget and preserve unattempted work", t => {
  const dbPath = database(t), roots = Array.from({ length: 5 }, (_, i) => merged(`deadline_${i}`, START + i * 1000));
  let clock = 0;
  const budgets = [];
  const runner = makeRunner((args, request) => {
    if (args[2] === "/open-apis/im/v1/messages") return page(roots);
    const root = roots.find(root => args[2] === `/open-apis/im/v1/messages/${root.message_id}`);
    assert.ok(root); budgets.push(request.retryBudgetMs);
    const elapsed = Math.min(11_000, request.timeoutMs); clock += elapsed;
    if (elapsed < 11_000) throw new Error("lark-cli failed: kind=network_timeout retry_exhausted=1");
    return page([root, raw(`${root.message_id}_child`, START - MINUTE, { upper_message_id: root.message_id })]);
  }, { clock: () => clock });
  const result = sync(runner, dbPath, options(START + MINUTE), "received");
  assert.deepEqual(budgets, [30_000, 19_000, 8_000]); assert.equal(clock, 30_000);
  assert.equal(result.detail_retry.detail_attempts, 3); assert.equal(result.pending_details, 3);
  const after = tasks(dbPath, RECEIVED_SCOPE);
  assert.deepEqual(after.map(task => [task.status, task.attempt_count]),
    [["complete", 1], ["complete", 1], ["pending", 1], ["pending", 0], ["pending", 0]]);
  assert.equal(readLarkListProgress(dbPath, readScope(dbPath, RECEIVED_SCOPE)).cursor.created_at_ms, START + MINUTE);
  assert.equal(readScope(dbPath, RECEIVED_SCOPE).cursor, null);
});

test("automatic detail batches finish healthy siblings and retain a denied root's backoff", t => {
  const dbPath = database(t), roots = [0, 1, 2].map(i => merged(`sibling_${i}`, START + i * 1000));
  let detailCalls = 0;
  const runner = makeRunner(args => {
    if (args[2] === "/open-apis/im/v1/messages") return page(roots);
    const root = roots.find(root => args[2] === `/open-apis/im/v1/messages/${root.message_id}`);
    assert.ok(root); detailCalls++;
    if (root === roots[0]) throw new Error("lark-cli failed: kind=permission_denied");
    return page([root, raw(`${root.message_id}_child`, START - MINUTE, { upper_message_id: root.message_id })]);
  });
  const first = sync(runner, dbPath, options(START + MINUTE), "received");
  assert.equal(first.detail_retry.detail_attempts, 3); assert.equal(first.pending_details, 1);
  assert.deepEqual(storedIds(dbPath), roots.slice(1).map(root => root.message_id));
  const receipt = tasks(dbPath, RECEIVED_SCOPE)[0];
  const second = sync(runner, dbPath, options(START + 2 * MINUTE), "received");
  assert.equal(detailCalls, 3); assert.equal(second.pending_details, 1);
  assert.equal(second.detail_retry.reason, "details_not_due");
  assert.deepEqual(tasks(dbPath, RECEIVED_SCOPE)[0], receipt);
});

test("a denied edited boundary root preserves its prior expansion while ordinary records advance, then repair updates it", (t) => {
  const dbPath = database(t);
  const root = merged("edited_boundary", START + MINUTE);
  const oldChild = raw("old_expansion", START - MINUTE);
  const ordinary = raw("after_edited_boundary", START + 7 * MINUTE);
  const target = START + 8 * MINUTE;
  const initial = makeRunner((args) => args[2] === "/open-apis/im/v1/messages"
    ? page([root]) : page([root, oldChild]));
  const first = sync(initial, dbPath, options(START + MINUTE), "received");
  assert.equal(first.ok, true, JSON.stringify(first));
  const recordSql = `SELECT external_version,raw_json,canonical_json,body FROM records
    WHERE external_id=${quoteSql(root.message_id)};`;
  const before = sqliteQuery(dbPath, recordSql)[0];
  const fullBefore = readScope(dbPath, RECEIVED_SCOPE).cursor;
  assert.equal(fullBefore.created_at_ms, START + MINUTE);
  const edited = { ...root, update_time: String(START + 2 * MINUTE), body: { content: "synthetic edited boundary" } };
  const denied = makeRunner((args) => {
    if (args[2] === "/open-apis/im/v1/messages") return page([edited, ordinary]);
    throw new Error("lark-cli failed: kind=permission_denied");
  });
  sync(denied, dbPath, options(target), "received");
  assert.deepEqual(sqliteQuery(dbPath, recordSql)[0], before, "failed detail must not replace an existing full expansion");
  assert.deepEqual(readScope(dbPath, RECEIVED_SCOPE).cursor, fullBefore);
  assert.equal(readLarkListProgress(dbPath, readScope(dbPath, RECEIVED_SCOPE)).cursor.created_at_ms, target);
  assert.deepEqual(storedIds(dbPath), [root.message_id, ordinary.message_id].sort());
  assert.equal(tasks(dbPath, RECEIVED_SCOPE)[0].status, "pending");
  sqliteExec(dbPath, `UPDATE lark_im_detail_tasks SET retry_at='2000-01-01T00:00:00.000Z';`);
  const latest = { ...edited, update_time: String(START + 9 * MINUTE) };
  const repaired = detailsCli(dbPath, makeRunner((args) => {
    assert.equal(args[2], `/open-apis/im/v1/messages/${root.message_id}`);
    return page([latest, raw("new_expansion", START - MINUTE)]);
  }));
  assert.equal(repaired.exitCode, 0, JSON.stringify(repaired.summary));
  const after = sqliteQuery(dbPath, recordSql)[0];
  assert.equal(after.external_version, latest.update_time);
  assert.match(after.body, /invented detail fixture new_expansion/);
  assert.doesNotMatch(after.body, /invented detail fixture old_expansion/);
  assert.equal(readScope(dbPath, RECEIVED_SCOPE).cursor.created_at_ms, target);
  assert.equal(tasks(dbPath, RECEIVED_SCOPE)[0].status, "complete");
});

for (const direction of ["received", "sent"]) {
  test(`${direction}: failed later list page writes neither ordinary records, detail tasks nor list coverage`, (t) => {
    const dbPath = database(t);
    const id = scopeId(direction);
    const root = merged("atomic_root", START + 10_000);
    const ordinary = raw("atomic_ordinary", START + 20_000);
    let detailCalls = 0;
    let listCalls = 0;
    const runner = makeRunner((args) => {
      const path = args[2];
      const params = JSON.parse(args[args.indexOf("--params") + 1]);
      if (path.endsWith("/mget")) return page([root, ordinary]);
      if (path === "/open-apis/im/v1/messages" || path.endsWith("/search")) {
        listCalls += 1;
        if (params.page_token) return { ok: false, error: { code: 999, message: "invented bad page" } };
        return page(path.endsWith("/search")
          ? [root, ordinary].map((message) => ({ meta_data: { message_id: message.message_id } }))
          : [root, ordinary], true, "synthetic-next");
      }
      detailCalls += 1;
      return page([root]);
    });
    const before = readScope(dbPath, id).cursor;
    const result = sync(runner, dbPath, options(START + MINUTE, { maxPages: 3 }), direction);
    assert.equal(result.ok, false);
    assert.equal(listCalls, 2);
    assert.equal(detailCalls, 0, "uncommitted root snapshots must never start detail work");
    assert.deepEqual(storedIds(dbPath), []);
    assert.deepEqual(tasks(dbPath, id), []);
    assert.equal(readLarkListProgress(dbPath, readScope(dbPath, id)), null);
    assert.deepEqual(readScope(dbPath, id).cursor, before);
    assert.equal(readScope(dbPath, id).enabled, 1);
    assert.equal(sqliteQuery(dbPath, "SELECT COUNT(*) AS n FROM sync_locks;")[0].n, 0);
  });
}

for (const budget of ["time", "page", "item"]) {
  test(`detail ${budget} budget cannot bisect or roll back an otherwise complete list window`, (t) => {
    const dbPath = database(t);
    const root = merged(`budget_${budget}`, START + 30_000);
    const ordinary = raw(`budget_ordinary_${budget}`, START + 7 * MINUTE);
    const child = raw(`budget_child_${budget}`, START - MINUTE);
    const target = START + 8 * MINUTE;
    let now = 0;
    let listCalls = 0;
    let detailCalls = 0;
    const runner = makeRunner((args) => {
      if (args[2] === "/open-apis/im/v1/messages") {
        listCalls += 1;
        return page([root, ordinary]);
      }
      assert.equal(args[2], `/open-apis/im/v1/messages/${root.message_id}`);
      detailCalls += 1;
      if (budget === "time") now += 30_001;
      return page([root, child], budget === "page", budget === "page" ? "synthetic-next-detail" : "");
    }, { clock: () => now });
    const before = readScope(dbPath, RECEIVED_SCOPE).cursor;
    const result = sync(runner, dbPath, options(target, {
      detailBudgetMs: budget === "time" ? 1 : 30_000,
      detailMaxPages: budget === "page" ? 1 : 50,
      detailMaxItems: budget === "item" ? 1 : 1000,
    }), "received");
    assert.equal(listCalls, 1, JSON.stringify(result));
    assert.equal(detailCalls, 1);
    assert.deepEqual(storedIds(dbPath), [ordinary.message_id]);
    assert.equal(readLarkListProgress(dbPath, readScope(dbPath, RECEIVED_SCOPE)).cursor.created_at_ms, target);
    assert.deepEqual(readScope(dbPath, RECEIVED_SCOPE).cursor, before);
    const pending = tasks(dbPath, RECEIVED_SCOPE);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, "pending");
    assert.equal(pending[0].attempt_count, 1);
    assert.match(pending[0].last_error_message, new RegExp({
      time: "detail_budget_exhausted", page: "detail_page_limit", item: "detail_item_limit",
    }[budget]));
  });
}

for (const direction of ["received", "sent"]) {
  for (const exhausted of [true, false]) {
    test(`${direction}: ${exhausted ? "shared 180s list deadline advances three minute prefixes" : "unexhausted list control ingests later ordinary messages"} despite a denied T0 root`, (t) => {
      const dbPath = database(t);
      const id = scopeId(direction);
      const root = merged("deadline_t0", START);
      const ordinary = [1, 2].map((minute) => raw(`deadline_t${minute}`, START + minute * MINUTE));
      const messages = [root, ...ordinary];
      const target = START + 33 * 86_400_000;
      const windows = [];
      let now = 0;
      const transport = (args) => {
        const path = args[2];
        const params = JSON.parse(args[args.indexOf("--params") + 1]);
        if (path.endsWith("/mget")) {
          return page(params.message_ids.map((messageId) => messages.find((message) => message.message_id === messageId)));
        }
        if (path === "/open-apis/im/v1/messages" || path.endsWith("/search")) {
          const { start, end } = listBounds(args);
          windows.push({ start, end });
          if (exhausted && end - start > MINUTE) {
            now += 180_000;
            throw new Error("lark-cli failed: kind=network_timeout retry_exhausted=1");
          }
          const selected = messages.filter((message) => Number(message.create_time) >= start && Number(message.create_time) <= end);
          return page(path.endsWith("/search")
            ? selected.map((message) => ({ meta_data: { message_id: message.message_id } })) : selected);
        }
        assert.equal(path, `/open-apis/im/v1/messages/${root.message_id}`);
        throw new Error("lark-cli failed: kind=bot_user_out_of_chat");
      };
      const cycles = exhausted ? 3 : 1;
      for (let cycle = 1; cycle <= cycles; cycle += 1) {
        const runner = makeRunner(transport, { clock: () => now });
        const result = sync(runner, dbPath, options(target, { maxPages: 40 }), direction);
        assert.equal(result.list_complete, true, JSON.stringify(result));
        assert.equal(readLarkListProgress(dbPath, readScope(dbPath, id)).cursor.created_at_ms,
          exhausted ? START + cycle * MINUTE : target);
        assert.equal(readScope(dbPath, id).cursor, null);
        assert.equal(readScope(dbPath, id).enabled, 1);
      }
      assert.deepEqual(storedIds(dbPath), ordinary.map((message) => message.message_id).sort());
      assert.equal(tasks(dbPath, id).filter((task) => task.status === "pending").length, 1);
      assert.equal(windows.length, exhausted ? 6 : 1);
      if (exhausted) {
        assert.deepEqual(windows.filter((_window, index) => index % 2 === 1), [1, 2, 3].map((minute) => ({
          start: START + (minute - 1) * MINUTE, end: START + minute * MINUTE,
        })));
      }
    });
  }
}

for (const direction of ["received", "sent"]) {
  test(`${direction}: default page size 50 and 40-page limit eventually ingest all 2100 ordinary messages past the denied root`, (t) => {
    const dbPath = database(t);
    const id = scopeId(direction);
    const root = merged("dense_t0", START);
    const ordinary = Array.from({ length: 2100 }, (_value, index) =>
      raw(`dense_${String(index + 1).padStart(4, "0")}`, START + (index + 1) * 1000));
    const messages = [root, ...ordinary];
    const byId = new Map(messages.map((message) => [message.message_id, message]));
    const target = START + 60 * MINUTE;
    const initialWindows = [];
    const transport = (args) => {
      const path = args[2];
      const params = JSON.parse(args[args.indexOf("--params") + 1]);
      if (path.endsWith("/mget")) return page(params.message_ids.map((messageId) => byId.get(messageId)));
      if (path === "/open-apis/im/v1/messages" || path.endsWith("/search")) {
        const { start, end } = listBounds(args);
        if (!params.page_token) initialWindows.push({ start, end });
        const selected = messages.filter((message) => Number(message.create_time) >= start && Number(message.create_time) <= end);
        const offset = Number(params.page_token || 0);
        const nextOffset = offset + params.page_size;
        const selectedPage = selected.slice(offset, nextOffset);
        const more = nextOffset < selected.length;
        return page(path.endsWith("/search")
          ? selectedPage.map((message) => ({ meta_data: { message_id: message.message_id } })) : selectedPage,
        more, more ? String(nextOffset) : "");
      }
      assert.equal(path, `/open-apis/im/v1/messages/${root.message_id}`);
      throw new Error("lark-cli failed: kind=restricted_mode");
    };
    const frontiers = [];
    for (let cycle = 0; cycle < 6; cycle += 1) {
      const result = sync(makeRunner(transport), dbPath, options(target, { pageSize: 50, maxPages: 40 }), direction);
      assert.equal(result.list_complete, true, JSON.stringify(result));
      const frontier = readLarkListProgress(dbPath, readScope(dbPath, id)).cursor.created_at_ms;
      assert.ok(frontier > (frontiers.at(-1) ?? START));
      frontiers.push(frontier);
      assert.equal(readScope(dbPath, id).cursor, null);
      if (frontier === target) break;
    }
    assert.ok(frontiers.length >= 2, "default page budgets must force more than one committed prefix");
    assert.ok(initialWindows.length > frontiers.length, "at least one list fetch must actually hit the page cap");
    assert.equal(frontiers.at(-1), target);
    assert.deepEqual(storedIds(dbPath), ordinary.map((message) => message.message_id).sort());
    assert.equal(tasks(dbPath, id).filter((task) => task.status === "pending").length, 1);
    assert.equal(readScope(dbPath, id).enabled, 1);
  });
}

test("details-only invocation with deferred debt reports incomplete without any remote request", (t) => {
  const dbPath = database(t);
  const root = merged("deferred_root", START + 30_000);
  const initial = makeRunner((args) => {
    if (args[2] === "/open-apis/im/v1/messages") return page([root]);
    throw new Error("lark-cli failed: kind=restricted_mode");
  });
  sync(initial, dbPath, options(START + MINUTE), "received");
  sqliteExec(dbPath, "UPDATE lark_im_detail_tasks SET retry_at='2999-01-01T00:00:00.000Z';");
  const prior = tasks(dbPath, RECEIVED_SCOPE)[0];
  const deferred = detailsCli(dbPath, makeRunner(() => assert.fail("deferred detail made a remote request")));
  assert.equal(deferred.exitCode, 2);
  assert.ok(deferred.summary.details.some((result) => result.pending_details === 1 && result.detail_attempts === 0));
  assert.equal(tasks(dbPath, RECEIVED_SCOPE)[0].attempt_count, prior.attempt_count);
  assert.equal(readScope(dbPath, RECEIVED_SCOPE).cursor, null);
});
