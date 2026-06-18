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
