import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSyncRunner } from "../src/adapters/lark-im/sync-runner.mjs";
import { PaginationLimitError } from "../dist/core/sync.js";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";
import {
  acquireLock,
  commitLarkListRun,
  createRun,
  ensureInitialized,
  ensureSourceInitialSyncStart,
  quoteSql,
  readScope,
  releaseLock,
  sqliteExec,
  sqliteQuery,
} from "../dist/storage/sqlite/ingestion-store.js";

const BASE_MS = Date.parse("2026-06-18T08:00:00.000Z");

function message(id, occurredAtMs, overrides = {}) {
  return {
    message_id: id,
    create_time: String(Math.floor(occurredAtMs / 1000)),
    msg_type: "text",
    sender: {
      id: overrides.senderId || "ou_self",
      id_type: "open_id",
      sender_type: "user",
      name: overrides.senderName || "Me",
    },
    chat_id: overrides.chatId || "oc_chat",
    chat_type: overrides.chatType || "group",
    chat_name: overrides.chatName || "Group",
    content: overrides.content || "hello",
    ...overrides,
  };
}

function syncOptions(overrides = {}) {
  return {
    startMs: BASE_MS,
    endMs: BASE_MS + 60_000,
    pageSize: 50,
    maxPages: 1,
    chatPageSize: 100,
    maxChatPages: 100,
    discoveryPagesPerRun: 1,
    receivedScopesPerRun: 0,
    discoveryMode: "cursor",
    reconcileIntervalHours: 24,
    receivedMode: "all",
    chatTypes: "group,p2p",
    stableHorizonSeconds: 30,
    stableHorizonMs: 30_000,
    endExplicit: true,
    lockTtlSeconds: 600,
    retries: 0,
    retryDelayMs: 0,
    ...overrides,
  };
}

function peopleContext(selfProfile) {
  return {
    self: selfProfile,
    contacts: new Map(),
    chat_members: new Map(),
    apps: new Map(),
    app_fallbacks: new Map(),
  };
}

function createTestRunner(deps) {
  return createSyncRunner({
    isMaintenanceLocked: () => false,
    readLarkListProgress: () => null,
    ...deps,
  });
}

test("createSyncRunner lets sent sync run against injected adapter and store deps", () => {
  const calls = [];
  const selfProfile = { open_id: "ou_self", name: "Me" };
  const sentScope = {
    id: "lark.im.sent_by_me",
    source_id: "lark.im",
    enabled: 1,
    config: {},
    cursor: null,
  };
  let written = null;
  const runner = createTestRunner({
    readScope: (_dbPath, scopeId) => ({ ...sentScope, id: scopeId }),
    acquireLock: (_dbPath, scopeId) => {
      calls.push(["lock", scopeId]);
      return true;
    },
    createRun: (_dbPath, scope) => {
      calls.push(["run", scope.id]);
      return 42;
    },
    releaseLock: (_dbPath, scopeId) => calls.push(["release", scopeId]),
    failRun: () => calls.push(["fail"]),
    fetchSentMessageList: (selfOpenId, startMs, endMs) => {
      calls.push(["fetch-sent", selfOpenId, startMs, endMs]);
      return { messages: [message("om_sent", BASE_MS, { content: "sent body" })], detailRoots: [], pages: 1 };
    },
    buildPeopleContext: (_messages, _opts, profile) => peopleContext(profile),
    commitLarkListRun: (_dbPath, scope, runId, records, _detailRoots, scanned, cursor, metadata) => {
      written = { scope, runId, records, scanned, cursor, metadata };
      return { inserted: records.length, updated: 0, duplicate: 0, pending_details: 0 };
    },
  });

  const result = runner.syncSent("fake.sqlite", syncOptions(), selfProfile);

  assert.deepEqual(result, {
    scope_id: "lark.im.sent_by_me",
    run_id: 42,
    ok: true,
    scanned: 1,
    records: 1,
    inserted: 1,
    updated: 0,
    duplicate: 0,
    list_complete: true,
    details_complete: true,
    pending_details: 0,
  });
  assert.equal(written.runId, 42);
  assert.deepEqual(written.records.map((record) => [record.external_id, record.direction, record.body]), [
    ["om_sent", "sent", "sent body"],
  ]);
  assert.equal(written.metadata.adapter, "lark.im.sent_by_me");
  assert.equal(written.cursor.source_time_precision, "minute");
  assert.deepEqual(calls.map((call) => call[0]), ["lock", "run", "fetch-sent", "release"]);
});

test("syncSent checkpoints one complete prefix after bisecting an oversized window", () => {
  const scope = {
    id: "lark.im.sent_by_me",
    source_id: "lark.im",
    enabled: 1,
    config: {},
    cursor: { created_at_ms: BASE_MS, message_id: "" },
  };
  const fetchEnds = [];
  let checkpoint = null;
  const runner = createTestRunner({
    readScope: () => scope,
    acquireLock: () => true,
    createRun: () => 43,
    releaseLock: () => {},
    failRun: () => {},
    fetchSentMessageList: (_selfId, startMs, endMs) => {
      assert.equal(startMs, BASE_MS);
      fetchEnds.push(endMs);
      if (endMs - startMs > 2 * 60_000) {
        throw new PaginationLimitError("page budget exhausted", 1);
      }
      return { messages: [message("om_prefix", endMs)], detailRoots: [], pages: 1 };
    },
    buildPeopleContext: (_messages, _opts, profile) => peopleContext(profile),
    commitLarkListRun: (_dbPath, _scope, _runId, _records, _detailRoots, _scanned, cursor, metadata) => {
      checkpoint = { cursor, metadata };
      return { inserted: 1, updated: 0, duplicate: 0, pending_details: 0 };
    },
  });

  const result = runner.syncSent(
    "fake.sqlite",
    syncOptions({ endMs: BASE_MS + 8 * 60_000 }),
    { open_id: "ou_self", name: "Me" },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(fetchEnds, [BASE_MS + 8 * 60_000, BASE_MS + 4 * 60_000, BASE_MS + 2 * 60_000]);
  assert.equal(checkpoint.cursor.created_at_ms, BASE_MS + 2 * 60_000);
  assert.equal(checkpoint.metadata.list_window_bisections, 2);
  assert.equal(Date.parse(checkpoint.metadata.list_window_end), BASE_MS + 2 * 60_000);
});

test("createSyncRunner classifies unsupported received scopes through injected deps", () => {
  const calls = [];
  const scope = {
    id: "lark.im.received.chat.test",
    source_id: "lark.im",
    enabled: 1,
    config: { chat_id: "oc_test", chat_type: "group", chat_name: "Test Group" },
    cursor: null,
  };
  let unsupportedSql = "";
  const runner = createTestRunner({
    readScope: () => scope,
    acquireLock: () => true,
    createRun: () => 77,
    releaseLock: (_dbPath, scopeId) => calls.push(["release", scopeId]),
    failRun: () => calls.push(["fail"]),
    fetchChatMessageList: () => {
      throw new Error("restricted private body oc_secret");
    },
    isRestrictedModeError: () => true,
    isBotUserOutOfChatError: () => false,
    sqliteExec: (_dbPath, sql) => {
      unsupportedSql = sql;
    },
  });

  const result = runner.syncReceivedScope(
    "fake.sqlite",
    syncOptions(),
    scope,
    { open_id: "ou_self", name: "Me" },
  );

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "restricted_mode");
  assert.match(unsupportedSql, /restricted_mode/);
  assert.match(unsupportedSql, /__lark_run_fence_guard/);
  assert.match(unsupportedSql, /r\.status = 'running'/);
  assert.doesNotMatch(unsupportedSql, /private body|oc_secret/);
  assert.deepEqual(calls, [["release", "lark.im.received.chat.test"]]);
});

test("createSyncRunner injects discovery fetcher, clock, and snapshot ids", () => {
  const runner = createTestRunner({
    nowIso: () => "2026-06-18T08:00:00.000Z",
    makeSnapshotId: (prefix) => `${prefix}_fixed`,
    fetchChatDiscoveryPage: (_opts, pageToken) => {
      assert.equal(pageToken, "");
      return {
        chats: [
          { chat_id: "oc_alpha", chat_type: "group", chat_name: "Alpha" },
          { chat_id: "oc_alpha", chat_type: "group", chat_name: "Alpha duplicate" },
          { chat_id: "oc_beta", chat_type: "p2p", chat_name: "Beta" },
        ],
        has_more: false,
        page_token: "",
      };
    },
  });

  const result = runner.discoverHotChatPages(syncOptions({ discoveryMode: "hot" }));

  assert.equal(result.snapshot_id, "hot_fixed");
  assert.equal(result.snapshot_started_at, "2026-06-18T08:00:00.000Z");
  assert.equal(result.pages, 1);
  assert.deepEqual(
    result.chats.map((chat) => [chat.chat_id, chat.hot_rank, chat.hot_seen_at]),
    [
      ["oc_alpha", 0, "2026-06-18T08:00:00.000Z"],
      ["oc_beta", 2, "2026-06-18T08:00:00.000Z"],
    ],
  );
});

test("syncSent failure fails the run, releases the lock, and does not checkpoint", () => {
  const calls = [];
  const scope = {
    id: "lark.im.sent_by_me",
    source_id: "lark.im",
    enabled: 1,
    config: {},
    cursor: null,
  };
  let failed = null;
  let checkpointed = false;
  const runner = createTestRunner({
    readScope: () => scope,
    acquireLock: () => {
      calls.push("lock");
      return true;
    },
    createRun: () => {
      calls.push("run");
      return 501;
    },
    fetchSentMessageList: () => {
      calls.push("fetch");
      throw new Error("temporary lark failure");
    },
    failRun: (_dbPath, failedScope, runId, error) => {
      calls.push("fail");
      failed = { scope: failedScope, runId, message: error.message };
    },
    releaseLock: (_dbPath, scopeId) => calls.push(`release:${scopeId}`),
    commitLarkListRun: () => {
      checkpointed = true;
      return { inserted: 0, updated: 0, duplicate: 0, pending_details: 0 };
    },
  });

  const result = runner.syncSent("fake.sqlite", syncOptions(), { open_id: "ou_self", name: "Me" });

  assert.equal(result.ok, false);
  assert.equal(result.run_id, 501);
  assert.equal(result.scope_id, "lark.im.sent_by_me");
  assert.match(result.error, /temporary lark failure/);
  assert.deepEqual(failed, {
    scope,
    runId: 501,
    message: "temporary lark failure",
  });
  assert.equal(checkpointed, false);
  assert.deepEqual(calls, ["lock", "run", "fetch", "fail", "release:lark.im.sent_by_me"]);
});

test("syncScope re-reads the cursor after locking before it creates or runs work", () => {
  const scopes = [
    {
      id: "lark.im.sent_by_me",
      source_id: "lark.im",
      enabled: 1,
      config: {},
      cursor: null,
    },
    {
      id: "lark.im.sent_by_me",
      source_id: "lark.im",
      enabled: 1,
      config: {},
      cursor: { created_at_ms: BASE_MS + 60_000, message_id: "" },
    },
  ];
  const fetchCalls = [];
  let createdFrom = null;
  const runner = createTestRunner({
    readScope: () => scopes.shift() || scopes.at(-1),
    acquireLock: () => true,
    createRun: (_dbPath, scope) => {
      createdFrom = scope;
      return 502;
    },
    releaseLock: () => {},
    failRun: () => {},
    fetchSentMessageList: (_selfId, startMs, endMs) => {
      fetchCalls.push([startMs, endMs]);
      return { messages: [message("om_new", BASE_MS + 2 * 60_000)], detailRoots: [], pages: 1 };
    },
    buildPeopleContext: (_messages, _opts, profile) => peopleContext(profile),
    commitLarkListRun: () => ({ inserted: 1, updated: 0, duplicate: 0, pending_details: 0 }),
  });

  const result = runner.syncSent(
    "fake.sqlite",
    syncOptions({ endMs: BASE_MS + 3 * 60_000 }),
    { open_id: "ou_self", name: "Me" },
  );

  assert.equal(result.ok, true);
  assert.equal(createdFrom.cursor.created_at_ms, BASE_MS + 60_000);
  assert.deepEqual(fetchCalls, [[BASE_MS + 60_000, BASE_MS + 3 * 60_000]]);
});

test("syncScope releases the lock when createRun throws", () => {
  const calls = [];
  const scope = { id: "lark.im.sent_by_me", source_id: "lark.im", enabled: 1, config: {}, cursor: null };
  const runner = createTestRunner({
    readScope: () => scope,
    acquireLock: () => true,
    createRun: () => {
      calls.push("create");
      throw new Error("create failed");
    },
    releaseLock: () => calls.push("release"),
  });

  assert.throws(
    () => runner.syncSent("fake.sqlite", syncOptions(), { open_id: "ou_self", name: "Me" }),
    /create failed/,
  );
  assert.deepEqual(calls, ["create", "release"]);
});

test("syncScope releases after failRun errors and preserves both failure details", () => {
  const calls = [];
  const scope = { id: "lark.im.sent_by_me", source_id: "lark.im", enabled: 1, config: {}, cursor: null };
  const runner = createTestRunner({
    readScope: () => scope,
    acquireLock: () => true,
    createRun: () => 503,
    fetchSentMessageList: () => {
      throw new Error("fetch failed");
    },
    failRun: () => {
      calls.push("fail");
      throw new Error("fail persistence failed");
    },
    releaseLock: () => calls.push("release"),
  });

  const result = runner.syncSent("fake.sqlite", syncOptions(), { open_id: "ou_self", name: "Me" });
  assert.equal(result.ok, false);
  assert.match(result.error, /fetch failed.*fail persistence failed/);
  assert.equal(result.fail_run_error, "fail persistence failed");
  assert.deepEqual(calls, ["fail", "release"]);
});

test("release failure after a successful commit is reported without failing the committed run", () => {
  let failCalls = 0;
  const scope = { id: "lark.im.sent_by_me", source_id: "lark.im", enabled: 1, config: {}, cursor: null };
  const runner = createTestRunner({
    readScope: () => scope,
    acquireLock: () => true,
    createRun: () => 504,
    fetchSentMessageList: () => ({ messages: [], detailRoots: [], pages: 1 }),
    buildPeopleContext: (_messages, _opts, profile) => peopleContext(profile),
    commitLarkListRun: () => ({ inserted: 0, updated: 0, duplicate: 0, pending_details: 0 }),
    failRun: () => {
      failCalls += 1;
    },
    releaseLock: () => {
      throw new Error("release failed");
    },
  });

  const result = runner.syncSent("fake.sqlite", syncOptions(), { open_id: "ou_self", name: "Me" });
  assert.equal(result.ok, false);
  assert.equal(result.run_id, 504);
  assert.match(result.error, /lock release failed.*release failed/);
  assert.equal(result.lock_release_error, "release failed");
  assert.equal(failCalls, 0);
});

test("syncSent skips locked scopes before creating a run or calling the adapter", () => {
  const calls = [];
  const runner = createTestRunner({
    readScope: () => ({
      id: "lark.im.sent_by_me",
      source_id: "lark.im",
      enabled: 1,
      config: {},
      cursor: null,
    }),
    acquireLock: () => {
      calls.push("lock");
      return false;
    },
    createRun: () => calls.push("run"),
    fetchSentMessageList: () => calls.push("fetch"),
    failRun: () => calls.push("fail"),
    releaseLock: () => calls.push("release"),
  });

  const result = runner.syncSent("fake.sqlite", syncOptions(), { open_id: "ou_self", name: "Me" });

  assert.deepEqual(result, {
    scope_id: "lark.im.sent_by_me",
    skipped: true,
    reason: "scope_locked",
  });
  assert.deepEqual(calls, ["lock"]);
});

test("syncSent skips maintenance lock without creating a failed run", () => {
  const calls = [];
  const runner = createTestRunner({
    readScope: () => ({
      id: "lark.im.sent_by_me",
      source_id: "lark.im",
      enabled: 1,
      config: {},
      cursor: null,
    }),
    isMaintenanceLocked: () => {
      calls.push("maintenance");
      return true;
    },
    acquireLock: () => calls.push("lock"),
    createRun: () => calls.push("run"),
    fetchSentMessageList: () => calls.push("fetch"),
    failRun: () => calls.push("fail"),
    releaseLock: () => calls.push("release"),
  });

  const result = runner.syncSent("fake.sqlite", syncOptions(), { open_id: "ou_self", name: "Me" });

  assert.deepEqual(result, {
    scope_id: "lark.im.sent_by_me",
    skipped: true,
    reason: "maintenance_lock",
  });
  assert.deepEqual(calls, ["maintenance"]);
});

test("syncSent reports maintenance lock when acquireLock is blocked by a race", () => {
  const calls = [];
  const runner = createTestRunner({
    readScope: () => ({
      id: "lark.im.sent_by_me",
      source_id: "lark.im",
      enabled: 1,
      config: {},
      cursor: null,
    }),
    isMaintenanceLocked: () => {
      calls.push("maintenance");
      return calls.length > 1;
    },
    acquireLock: () => {
      calls.push("lock");
      return false;
    },
    createRun: () => calls.push("run"),
    fetchSentMessageList: () => calls.push("fetch"),
    failRun: () => calls.push("fail"),
    releaseLock: () => calls.push("release"),
  });

  const result = runner.syncSent("fake.sqlite", syncOptions(), { open_id: "ou_self", name: "Me" });

  assert.deepEqual(result, {
    scope_id: "lark.im.sent_by_me",
    skipped: true,
    reason: "maintenance_lock",
  });
  assert.deepEqual(calls, ["maintenance", "lock", "maintenance"]);
});

test("syncSent skips disabled scopes before locking or calling the adapter", () => {
  const calls = [];
  const runner = createTestRunner({
    readScope: () => ({
      id: "lark.im.sent_by_me",
      source_id: "lark.im",
      enabled: 0,
      config: {},
      cursor: null,
    }),
    acquireLock: () => calls.push("lock"),
    createRun: () => calls.push("run"),
    fetchSentMessageList: () => calls.push("fetch"),
    failRun: () => calls.push("fail"),
    releaseLock: () => calls.push("release"),
  });

  const result = runner.syncSent("fake.sqlite", syncOptions(), { open_id: "ou_self", name: "Me" });

  assert.deepEqual(result, {
    scope_id: "lark.im.sent_by_me",
    skipped: true,
    reason: "scope_disabled",
  });
  assert.deepEqual(calls, []);
});

test("completed discovery skip is fenced by the running run and current lock", () => {
  const scope = {
    id: "lark.im.unmuted_chat_discovery",
    source_id: "lark.im",
    enabled: 1,
    config: {},
    cursor: {
      kind: "chat_discovery_cursor/v1",
      snapshot_id: "snapshot_complete",
      has_more: false,
    },
  };
  let sql = "";
  const runner = createTestRunner({
    readScope: () => scope,
    acquireLock: () => true,
    createRun: () => 600,
    nowIso: () => "2026-06-18T08:00:00.000Z",
    releaseLock: () => {},
    failRun: () => {},
    sqliteExec: (_dbPath, value) => {
      sql = value;
    },
  });

  const result = runner.syncDiscovery("fake.sqlite", syncOptions());
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.match(sql, /BEGIN;[\s\S]*__lark_run_fence_guard/);
  assert.match(sql, /r\.status = 'running'/);
  assert.match(sql, /JOIN sync_locks/);
  assert.match(sql, /julianday\(l\.locked_at\) IS NOT NULL/);
  assert.match(sql, /l\.locked_at > '2026-06-18T07:40:00.000Z'/);
  assert.match(sql, /EXISTS \(SELECT 1 FROM __lark_run_fence_guard\)/);
  assert.match(sql, /COMMIT;/);
});

test("syncDiscovery fails and avoids checkpointing on unsafe pagination", () => {
  const calls = [];
  const scope = {
    id: "lark.im.unmuted_chat_discovery",
    source_id: "lark.im",
    enabled: 1,
    config: {},
    cursor: null,
  };
  let failed = null;
  const runner = createTestRunner({
    readScope: () => scope,
    acquireLock: () => {
      calls.push("lock");
      return true;
    },
    createRun: () => {
      calls.push("run");
      return 601;
    },
    fetchChatDiscoveryPage: () => {
      calls.push("fetch-discovery");
      return {
        chats: [{ chat_id: "oc_unsafe", chat_type: "group", chat_name: "Unsafe" }],
        has_more: true,
        page_token: "",
      };
    },
    failRun: (_dbPath, failedScope, runId, error) => {
      calls.push("fail");
      failed = { scope: failedScope, runId, message: error.message };
    },
    releaseLock: (_dbPath, scopeId) => calls.push(`release:${scopeId}`),
    sqliteExec: () => calls.push("checkpoint"),
  });

  const result = runner.syncDiscovery("fake.sqlite", syncOptions());

  assert.equal(result.ok, false);
  assert.equal(result.run_id, 601);
  assert.match(result.error, /has_more without page_token/);
  assert.deepEqual(failed, {
    scope,
    runId: 601,
    message: "chat-list returned has_more without page_token",
  });
  assert.deepEqual(calls, [
    "lock",
    "run",
    "fetch-discovery",
    "fail",
    "release:lark.im.unmuted_chat_discovery",
  ]);
});

test("syncReceived honors receivedScopesPerRun batch limits", () => {
  const chatIds = [];
  const scopeRows = [
    {
      id: "lark.im.received.chat.a",
      source_id: "lark.im",
      enabled: 1,
      config_json: JSON.stringify({ chat_id: "oc_a", chat_type: "group", chat_name: "A" }),
      cursor_json: null,
    },
    {
      id: "lark.im.received.chat.b",
      source_id: "lark.im",
      enabled: 1,
      config_json: JSON.stringify({ chat_id: "oc_b", chat_type: "group", chat_name: "B" }),
      cursor_json: null,
    },
    {
      id: "lark.im.received.chat.c",
      source_id: "lark.im",
      enabled: 1,
      config_json: JSON.stringify({ chat_id: "oc_c", chat_type: "group", chat_name: "C" }),
      cursor_json: null,
    },
  ];
  const scopes = new Map(
    scopeRows.map((row) => [
      row.id,
      {
        id: row.id,
        source_id: row.source_id,
        enabled: row.enabled,
        config: JSON.parse(row.config_json),
        cursor: null,
      },
    ]),
  );
  const runner = createTestRunner({
    sqliteQuery: () => scopeRows,
    quoteSql: (value) => `'${String(value)}'`,
    readScope: (_dbPath, scopeId) => scopes.get(scopeId),
    acquireLock: () => true,
    createRun: (_dbPath, scope) => Number(scope.id.at(-1).charCodeAt(0)),
    releaseLock: () => {},
    failRun: () => {},
    fetchChatMessageList: (chatId) => {
      chatIds.push(chatId);
      return {
        messages: [
          message(`om_${chatId}`, BASE_MS, {
            chatId,
            senderId: "ou_other",
            senderName: "Other",
            content: `from ${chatId}`,
          }),
        ],
        detailRoots: [],
        pages: 1,
      };
    },
    buildPeopleContext: (_messages, _opts, selfProfile) => peopleContext(selfProfile),
    commitLarkListRun: (_dbPath, _scope, _runId, records) => ({
      inserted: records.length,
      updated: 0,
      duplicate: 0,
      pending_details: 0,
    }),
  });

  const results = runner.syncReceived(
    "fake.sqlite",
    syncOptions({ receivedScopesPerRun: 2 }),
    { open_id: "ou_self", name: "Me" },
  );

  assert.deepEqual(chatIds, ["oc_a", "oc_b"]);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((result) => result.ok), [true, true]);
  assert.deepEqual(results.map((result) => result.records), [1, 1]);
});

test("syncReceived stops after exhausted transient transport failures and keeps committed progress", async (t) => {
  const cases = ["rate_limited", "network_timeout", "network_error", "service_unavailable"].map((kind) => ({
    errorMessage: `lark-cli failed: kind=${kind} operation=message_history_bundle`,
    shouldStop: true,
  }));
  cases.push(...[
    "lark-cli failed: kind=unknown operation=message_history_bundle",
    "validation noted kind=rate_limited",
    "lark-cli failed: kind=rate_limited-other operation=message_history_bundle",
  ].map((errorMessage) => ({ errorMessage, shouldStop: false })));
  for (const { errorMessage, shouldStop } of cases) {
    await t.test(errorMessage, () => {
      const rows = ["a", "b", "c"].map((name) => ({
        id: `lark.im.received.chat.${name}`,
        source_id: "lark.im",
        enabled: 1,
        config_json: JSON.stringify({ chat_id: `oc_${name}`, discovery_rank: name.charCodeAt(0) }),
        cursor_json: null,
      }));
      const scopes = new Map(rows.map((row) => [row.id, {
        ...row,
        config: JSON.parse(row.config_json),
        cursor: null,
      }]));
      const untouchedBefore = structuredClone(scopes.get(rows[2].id));
      const calls = [];
      const runner = createTestRunner({
        sqliteQuery: () => rows,
        readScope: (_dbPath, scopeId) => scopes.get(scopeId),
        acquireLock: (_dbPath, scopeId) => {
          calls.push(["lock", scopeId]);
          return true;
        },
        createRun: (_dbPath, scope) => {
          calls.push(["run", scope.id]);
          return scope.id.at(-1).charCodeAt(0);
        },
        fetchChatMessageList: (chatId) => {
          calls.push(["fetch", chatId]);
          if (chatId === "oc_b") throw new Error(errorMessage);
          return { messages: [], detailRoots: [], pages: 1 };
        },
        buildPeopleContext: (_messages, _opts, profile) => peopleContext(profile),
        commitLarkListRun: (_dbPath, scope, _runId, _records, _detailRoots, _scanned, cursor) => {
          calls.push(["checkpoint", scope.id]);
          scopes.get(scope.id).cursor = cursor;
          return { inserted: 0, updated: 0, duplicate: 0, pending_details: 0 };
        },
        failRun: (_dbPath, scope, _runId, error) => {
          assert.equal(error.message, errorMessage);
          calls.push(["fail", scope.id]);
        },
        releaseLock: (_dbPath, scopeId) => calls.push(["release", scopeId]),
        sqliteExec: () => assert.fail("received failure must not disable or rewrite a scope"),
      });

      const results = runner.syncReceived(
        "fake.sqlite",
        syncOptions({ receivedScopesPerRun: 3 }),
        { open_id: "ou_self", name: "Me" },
      );

      assert.deepEqual(results.map((result) => result.ok), shouldStop ? [true, false] : [true, false, true]);
      assert.equal(results[1].error, errorMessage);
      assert.equal(scopes.get(rows[0].id).cursor.created_at_ms, BASE_MS + 60_000);
      assert.equal(scopes.get(rows[1].id).cursor, null);
      assert.equal(scopes.get(rows[1].id).enabled, 1);
      const expectedCalls = [
        ["lock", rows[0].id], ["run", rows[0].id], ["fetch", "oc_a"],
        ["checkpoint", rows[0].id], ["release", rows[0].id],
        ["lock", rows[1].id], ["run", rows[1].id], ["fetch", "oc_b"],
        ["fail", rows[1].id], ["release", rows[1].id],
      ];
      if (shouldStop) {
        assert.deepEqual(scopes.get(rows[2].id), untouchedBefore);
      } else {
        expectedCalls.push(
          ["lock", rows[2].id], ["run", rows[2].id], ["fetch", "oc_c"],
          ["checkpoint", rows[2].id], ["release", rows[2].id],
        );
      }
      assert.deepEqual(calls, expectedCalls);
    });
  }
});

test("catchup mode becomes a fair steady lane after initial cursors exist", () => {
  const rows = Array.from({ length: 21 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return {
      id: `lark.im.received.chat.${number}`,
      source_id: "lark.im",
      enabled: 1,
      config_json: JSON.stringify({ chat_id: `oc_${number}`, hot_rank: index }),
      cursor_json: JSON.stringify({ created_at_ms: BASE_MS }),
      cursor_updated_at: "2026-06-18T08:00:00.000Z",
    };
  }).reverse();
  let querySql = "";
  const runner = createTestRunner({
    sqliteQuery: (_dbPath, sql) => {
      querySql = sql;
      return rows;
    },
  });

  const first = runner.listReceivedScopes("fake.sqlite", "catchup").slice(0, 20);
  for (const selected of first) {
    rows.find((row) => row.id === selected.id).cursor_updated_at = "2026-06-18T08:01:00.000Z";
  }
  const second = runner.listReceivedScopes("fake.sqlite", "catchup").slice(0, 20);

  assert.equal(first.some((scope) => scope.id.endsWith(".21")), false);
  assert.equal(second[0].id, "lark.im.received.chat.21");
  assert.doesNotMatch(querySql, /AND cursor_json IS NULL/);
  assert.match(querySql, /cursor_updated_at/);
});

test("successful hot discovery atomically removes stale hot snapshot metadata", () => {
  const scope = {
    id: "lark.im.unmuted_chat_hot",
    source_id: "lark.im",
    enabled: 1,
    config: {},
    cursor: null,
  };
  let transactionSql = "";
  const runner = createTestRunner({
    readScope: () => scope,
    acquireLock: () => true,
    createRun: () => 701,
    releaseLock: () => {},
    failRun: () => {},
    makeSnapshotId: () => "hot_latest",
    nowIso: () => "2026-06-18T08:00:00.000Z",
    fetchChatDiscoveryPage: () => ({
      chats: [{ chat_id: "oc_current", chat_type: "group", chat_name: "Current" }],
      has_more: false,
      page_token: "",
    }),
    sqliteExec: (_dbPath, sql) => {
      transactionSql = sql;
    },
  });

  const result = runner.syncDiscovery("fake.sqlite", syncOptions({ discoveryMode: "hot" }));

  assert.equal(result.ok, true);
  assert.match(transactionSql, /__lark_run_fence_guard/);
  assert.match(transactionSql, /r\.status = 'running'/);
  assert.match(transactionSql, /last_hot_snapshot_id/);
  assert.match(transactionSql, /json_remove\([\s\S]*\$\.hot_rank[\s\S]*\$\.hot_seen_at/);
  assert.match(transactionSql, /COALESCE\(json_extract\(config_json, '\$\.last_hot_snapshot_id'\), ''\) <> 'hot_latest'/);
});

test("malformed discovery items fail the run without checkpointing or disabling scopes", () => {
  const calls = [];
  const scope = {
    id: "lark.im.unmuted_chat_discovery",
    source_id: "lark.im",
    enabled: 1,
    config: {},
    cursor: null,
  };
  const runner = createTestRunner({
    readScope: () => scope,
    acquireLock: () => true,
    createRun: () => 702,
    releaseLock: () => calls.push("release"),
    failRun: () => calls.push("fail"),
    fetchChatDiscoveryPage: () => ({
      chats: [{ chat_name: "missing id" }],
      has_more: false,
      page_token: "",
    }),
    sqliteExec: () => calls.push("checkpoint"),
  });

  const result = runner.syncDiscovery("fake.sqlite", syncOptions());
  assert.equal(result.ok, false);
  assert.match(result.error, /missing a valid chat_id/);
  assert.deepEqual(calls, ["fail", "release"]);
});

test("stale success fencing rolls back unsupported scope mutations", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-runner-fence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "exocortex.sqlite");
  ensureInitialized(dbPath);

  const scopeId = "lark.im.sent_by_me";
  assert.equal(acquireLock(dbPath, scopeId, 60), true);
  const scope = readScope(dbPath, scopeId);
  const runId = createRun(dbPath, scope, { test: "stale-success-fence" });
  releaseLock(dbPath, scopeId);

  const runner = createSyncRunner();
  assert.throws(
    () => runner.succeedUnsupportedRun(
      dbPath,
      scope,
      runId,
      new Error("private remote body oc_secret"),
      "restricted_mode",
    ),
    /CHECK constraint failed|succeed unsupported run/,
  );

  assert.deepEqual(
    sqliteQuery(dbPath, `SELECT status FROM sync_runs WHERE id = ${runId};`, "read stale run"),
    [{ status: "running" }],
  );
  assert.deepEqual(
    sqliteQuery(
      dbPath,
      `SELECT enabled, json_extract(config_json, '$.unsupported_reason') AS reason
       FROM sync_scopes WHERE id = '${scopeId}';`,
      "read stale scope",
    ),
    [{ enabled: 1, reason: null }],
  );
});

test("hard-expired lock fencing rolls back unsupported scope mutations", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-runner-expired-fence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "exocortex.sqlite");
  ensureInitialized(dbPath);

  const scopeId = "lark.im.sent_by_me";
  assert.equal(acquireLock(dbPath, scopeId, 60), true);
  const scope = readScope(dbPath, scopeId);
  const runId = createRun(dbPath, scope, { test: "expired-success-fence" });
  const expiredLockedAt = new Date(Date.now() - 1_201_000).toISOString();
  sqliteExec(
    dbPath,
    `BEGIN;
     UPDATE sync_locks
     SET locked_at = '${expiredLockedAt}'
     WHERE scope_id = '${scopeId}';
     UPDATE sync_runs
     SET metadata_json = json_set(
       metadata_json,
       '$.__run_fence.locked_at',
       '${expiredLockedAt}'
     )
     WHERE id = ${runId};
     COMMIT;`,
    "expire success fence lock",
  );

  const runner = createSyncRunner();
  assert.throws(
    () => runner.succeedUnsupportedRun(
      dbPath,
      scope,
      runId,
      new Error("private remote body oc_secret"),
      "restricted_mode",
    ),
    /CHECK constraint failed|succeed unsupported run/,
  );

  assert.deepEqual(
    sqliteQuery(dbPath, `SELECT status FROM sync_runs WHERE id = ${runId};`, "read expired run"),
    [{ status: "running" }],
  );
  assert.deepEqual(
    sqliteQuery(
      dbPath,
      `SELECT enabled, json_extract(config_json, '$.unsupported_reason') AS reason
       FROM sync_scopes WHERE id = '${scopeId}';`,
      "read expired scope",
    ),
    [{ enabled: 1, reason: null }],
  );
});

function detailSchedulingFixture(t, count) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-detail-scheduling-synthetic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "synthetic.sqlite");
  ensureInitialized(dbPath);
  ensureSourceInitialSyncStart(dbPath, "lark.im", BASE_MS, { explicit: true });
  const candidates = Array.from({ length: count }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    const id = `lark.im.received.chat.generated_detail_schedule_${suffix}`;
    const root = { message_id: `om_generated_detail_schedule_${suffix}`, msg_type: "merge_forward",
      chat_id: `oc_generated_detail_schedule_${suffix}`, create_time: String(BASE_MS + 1_000),
      update_time: String(BASE_MS + 1_000), sender: { id: "ou_generated_detail_schedule", sender_type: "user" },
      body: { content: "{}" } };
    sqliteExec(dbPath, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(
      ${quoteSql(id)},'lark.im',${quoteSql(`generated detail scheduling ${suffix}`)},${quoteSql(JSON.stringify({ chat_id: root.chat_id }))});`);
    const scope = readScope(dbPath, id);
    const runId = createRun(dbPath, scope);
    commitLarkListRun(dbPath, scope, runId, [], [root], 1,
      { kind: "time_message_cursor/v1", created_at_ms: BASE_MS + 60_000, message_id: "" },
      { initial_sync_start_ms: BASE_MS, list_window_start_ms: BASE_MS, list_window_end_ms: BASE_MS + 60_000 });
    return { id, root };
  });
  sqliteExec(dbPath, "UPDATE lark_im_detail_tasks SET retry_at='2000-01-01T00:00:00.000Z';");
  return { dbPath, candidates };
}

test("details limit one refills an oldest locked scope with a healthy due scope", (t) => {
  const { dbPath, candidates: [locked, healthy] } = detailSchedulingFixture(t, 2);
  assert.equal(acquireLock(dbPath, locked.id, 60), true);
  const lockBefore = sqliteQuery(dbPath, "SELECT * FROM sync_locks;");
  const requests = [];
  const runner = createSyncRunner({
    fetchMessageDetails: (root) => {
      requests.push(root.message_id);
      assert.equal(root.message_id, healthy.root.message_id);
      const child = { ...root, message_id: "om_generated_detail_schedule_child", msg_type: "text",
        upper_message_id: root.message_id, body: { content: '{"text":"Invented scheduling child"}' } };
      return normalizeApiMessage(root, { mergeItems: [root, child] });
    },
  });
  const results = runner.retryDetails(dbPath, syncOptions({ detailLimit: 1 }),
    { open_id: "ou_generated_detail_schedule_self", name: "Generated Self" });
  assert.deepEqual(requests, [healthy.root.message_id]);
  assert.equal(results.find((item) => item.scope_id === locked.id).reason, "scope_locked");
  assert.equal(results.find((item) => item.scope_id === healthy.id).detail_attempts, 1);
  assert.equal(results.find((item) => item.scope_id === healthy.id).ok, true);
  assert.equal(results.at(-1).pending_details, 1, "locked debt remains explicit");
  assert.deepEqual(sqliteQuery(dbPath, "SELECT * FROM sync_locks;"), lockBefore);
  assert.equal(readScope(dbPath, locked.id).cursor, null);
  assert.equal(readScope(dbPath, healthy.id).cursor.created_at_ms, BASE_MS + 60_000);
  assert.deepEqual(sqliteQuery(dbPath, "SELECT status FROM lark_im_detail_tasks ORDER BY scope_id;")
    .map((row) => row.status), ["pending", "complete"]);
});

test("details limit one inspects at most twenty-one locked scope candidates", (t) => {
  const { dbPath } = detailSchedulingFixture(t, 22);
  const inspected = [];
  const runner = createSyncRunner({
    acquireLock: (_path, id) => { inspected.push(id); return false; },
    fetchMessageDetails: () => { throw new Error("locked candidates must not fetch details"); },
  });
  const results = runner.retryDetails(dbPath, syncOptions({ detailLimit: 1 }),
    { open_id: "ou_generated_detail_schedule_self", name: "Generated Self" });
  assert.equal(inspected.length, 21);
  assert.equal(new Set(inspected).size, 21);
  assert.equal(results.filter((item) => item.reason === "scope_locked").length, 21);
  assert.equal(results.at(-1).pending_details, 22);
  assert.equal(sqliteQuery(dbPath, "SELECT COUNT(*) AS n FROM records;")[0].n, 0);
});
