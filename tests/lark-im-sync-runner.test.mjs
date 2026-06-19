import assert from "node:assert/strict";
import test from "node:test";

import { createSyncRunner } from "../src/adapters/lark-im/sync-runner.mjs";

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
  const runner = createSyncRunner({
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
    fetchSentMessages: (selfOpenId, startMs, endMs) => {
      calls.push(["fetch-sent", selfOpenId, startMs, endMs]);
      return { messages: [message("om_sent", BASE_MS, { content: "sent body" })], pages: 1 };
    },
    buildPeopleContext: (_messages, _opts, profile) => peopleContext(profile),
    succeedMessageRun: (_dbPath, scope, runId, records, scanned, cursor, metadata) => {
      written = { scope, runId, records, scanned, cursor, metadata };
      return { inserted: records.length, updated: 0, duplicate: 0 };
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
  });
  assert.equal(written.runId, 42);
  assert.deepEqual(written.records.map((record) => [record.external_id, record.direction, record.body]), [
    ["om_sent", "sent", "sent body"],
  ]);
  assert.equal(written.metadata.adapter, "lark.im.sent_by_me");
  assert.equal(written.cursor.source_time_precision, "minute");
  assert.deepEqual(calls.map((call) => call[0]), ["lock", "run", "fetch-sent", "release"]);
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
  const runner = createSyncRunner({
    readScope: () => scope,
    acquireLock: () => true,
    createRun: () => 77,
    releaseLock: (_dbPath, scopeId) => calls.push(["release", scopeId]),
    failRun: () => calls.push(["fail"]),
    fetchChatMessages: () => {
      throw new Error("restricted");
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
  assert.deepEqual(calls, [["release", "lark.im.received.chat.test"]]);
});

test("createSyncRunner injects discovery fetcher, clock, and snapshot ids", () => {
  const runner = createSyncRunner({
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
  const runner = createSyncRunner({
    readScope: () => scope,
    acquireLock: () => {
      calls.push("lock");
      return true;
    },
    createRun: () => {
      calls.push("run");
      return 501;
    },
    fetchSentMessages: () => {
      calls.push("fetch");
      throw new Error("temporary lark failure");
    },
    failRun: (_dbPath, failedScope, runId, error) => {
      calls.push("fail");
      failed = { scope: failedScope, runId, message: error.message };
    },
    releaseLock: (_dbPath, scopeId) => calls.push(`release:${scopeId}`),
    succeedMessageRun: () => {
      checkpointed = true;
      return { inserted: 0, updated: 0, duplicate: 0 };
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

test("syncSent skips locked scopes before creating a run or calling the adapter", () => {
  const calls = [];
  const runner = createSyncRunner({
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
    fetchSentMessages: () => calls.push("fetch"),
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

test("syncSent skips disabled scopes before locking or calling the adapter", () => {
  const calls = [];
  const runner = createSyncRunner({
    readScope: () => ({
      id: "lark.im.sent_by_me",
      source_id: "lark.im",
      enabled: 0,
      config: {},
      cursor: null,
    }),
    acquireLock: () => calls.push("lock"),
    createRun: () => calls.push("run"),
    fetchSentMessages: () => calls.push("fetch"),
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
  const runner = createSyncRunner({
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
  const runner = createSyncRunner({
    sqliteQuery: () => scopeRows,
    quoteSql: (value) => `'${String(value)}'`,
    readScope: (_dbPath, scopeId) => scopes.get(scopeId),
    acquireLock: () => true,
    createRun: (_dbPath, scope) => Number(scope.id.at(-1).charCodeAt(0)),
    releaseLock: () => {},
    failRun: () => {},
    fetchChatMessages: (chatId) => {
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
        pages: 1,
      };
    },
    buildPeopleContext: (_messages, _opts, selfProfile) => peopleContext(selfProfile),
    succeedMessageRun: (_dbPath, _scope, _runId, records) => ({
      inserted: records.length,
      updated: 0,
      duplicate: 0,
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
