import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bodyFromMessage,
  compareRecordToCursor,
  createRun,
  cursorAfter,
  ensureInitialized,
  failRun,
  messageWindow,
  parseArgs,
  parseLarkTimeMs,
  prepareRecords,
  readScope,
  recordFromMessage,
  shouldSkipCompletedDiscovery,
  shouldSkipReconcile,
  sqliteQuery,
  succeedMessageRun,
} from "../scripts/lark-im-sync.mjs";

function message(id, occurredAtMs, overrides = {}) {
  return {
    message_id: id,
    create_time: String(Math.floor(occurredAtMs / 1000)),
    msg_type: "text",
    sender: {
      id: overrides.senderId || "ou_sender",
      id_type: "open_id",
      sender_type: "user",
      name: overrides.senderName || "Sender",
    },
    chat_id: overrides.chatId || "oc_chat",
    chat_type: overrides.chatType || "group",
    chat_name: overrides.chatName || "Group",
    content: overrides.content || "hello",
    ...overrides,
  };
}

function tempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "exocortex.sqlite");
  ensureInitialized(dbPath);
  return dbPath;
}

test("parseLarkTimeMs accepts seconds, milliseconds, and ISO strings", () => {
  assert.equal(parseLarkTimeMs("1700000000"), 1700000000000);
  assert.equal(parseLarkTimeMs("1700000000000"), 1700000000000);
  assert.equal(parseLarkTimeMs("2026-06-13T10:00:00.000Z"), Date.parse("2026-06-13T10:00:00.000Z"));
});

test("prepareRecords includes the initial start boundary and filters after an existing cursor", () => {
  const base = 1700000000000;

  const initial = prepareRecords(
    [message("om_at_start", base)],
    "lark.im.sent_by_me",
    "sent",
    null,
    base,
    base,
  );
  assert.deepEqual(initial.map((record) => record.external_id), ["om_at_start"]);

  const records = prepareRecords(
    [
      message("om_old", base - 1000),
      message("om_same_a", base),
      message("om_same_c", base),
      message("om_new", base + 1000),
      message("om_future", base + 2000),
    ],
    "lark.im.sent_by_me",
    "sent",
    { created_at_ms: base, message_id: "om_same_a" },
    base - 10_000,
    base + 1000,
  );

  assert.deepEqual(records.map((record) => record.external_id), ["om_same_c", "om_new"]);
  assert.equal(compareRecordToCursor(records[0], { created_at_ms: base, message_id: "om_same_a" }, base), 1);
});

test("deleted invalid rich text content is rendered as an explicit deleted marker", () => {
  assert.equal(
    bodyFromMessage({ deleted: true, content: "[Invalid rich text JSON]" }),
    "[已撤回/已删除：飞书未返回原始富文本内容]",
  );
});

test("messageWindow uses a stable horizon for implicit now, but honors explicit --end", () => {
  const implicit = parseArgs([
    "--start",
    "2026-06-13T00:00:00Z",
    "--end",
    "2026-06-13T00:10:00Z",
    "--stable-horizon-seconds",
    "30",
  ]);
  assert.equal(implicit.endExplicit, true);
  assert.equal(messageWindow({ cursor: null }, implicit).endMs, Date.parse("2026-06-13T00:10:00Z"));

  const opts = {
    startMs: 1000,
    endMs: 100000,
    stableHorizonMs: 30000,
    stableHorizonSeconds: 30,
    endExplicit: false,
  };
  assert.deepEqual(messageWindow({ cursor: null }, opts), { startMs: 1000, endMs: 70000 });
  assert.deepEqual(messageWindow({ cursor: { created_at_ms: 90000 } }, opts), { startMs: 90000, endMs: 90000 });
});

test("completed full discovery is skipped without disabling hot discovery", () => {
  const completedScope = {
    cursor: {
      kind: "chat_discovery_cursor/v1",
      has_more: false,
    },
  };
  const activeScope = {
    cursor: {
      kind: "chat_discovery_cursor/v1",
      has_more: true,
    },
  };

  assert.equal(shouldSkipCompletedDiscovery(completedScope, { discoveryMode: "cursor" }), true);
  assert.equal(shouldSkipCompletedDiscovery(completedScope, { discoveryMode: "hot" }), false);
  assert.equal(shouldSkipCompletedDiscovery(activeScope, { discoveryMode: "cursor" }), false);
  assert.equal(shouldSkipCompletedDiscovery({ cursor: null }, { discoveryMode: "cursor" }), false);
});

test("reconcile discovery skips only when a completed snapshot is still fresh", () => {
  const opts = {
    discoveryMode: "reconcile",
    endMs: Date.parse("2026-06-14T00:00:00.000Z"),
    reconcileIntervalHours: 24,
  };
  const freshCompleted = {
    cursor: {
      kind: "chat_discovery_cursor/v1",
      has_more: false,
      completed_at: "2026-06-13T12:00:00.000Z",
    },
  };
  const staleCompleted = {
    cursor: {
      kind: "chat_discovery_cursor/v1",
      has_more: false,
      completed_at: "2026-06-12T00:00:00.000Z",
    },
  };
  const unfinished = {
    cursor: {
      kind: "chat_discovery_cursor/v1",
      has_more: true,
      completed_at: "2026-06-13T12:00:00.000Z",
    },
  };

  assert.equal(shouldSkipReconcile(freshCompleted, opts), true);
  assert.equal(shouldSkipReconcile(staleCompleted, opts), false);
  assert.equal(shouldSkipReconcile(unfinished, opts), false);
  assert.equal(shouldSkipReconcile({ cursor: null }, opts), false);
  assert.equal(shouldSkipReconcile(freshCompleted, { ...opts, discoveryMode: "cursor" }), false);
});

test("successful message runs atomically write records, run state, and cursor", (t) => {
  const dbPath = tempDb(t);
  const scope = readScope(dbPath, "lark.im.sent_by_me");
  const runId = createRun(dbPath, scope);
  const record = recordFromMessage(
    message("om_db", 1700000000000, { content: "stored once" }),
    scope.id,
    "sent",
  );
  const cursor = cursorAfter(record.occurred_at_ms);

  const effects = succeedMessageRun(dbPath, scope, runId, [record], 1, cursor, { test: true });

  assert.deepEqual(effects, { inserted: 1, updated: 0, duplicate: 0 });
  assert.equal(sqliteQuery(dbPath, "SELECT COUNT(*) AS count FROM records;", "count records")[0].count, 1);
  assert.equal(sqliteQuery(dbPath, "SELECT status FROM sync_runs WHERE id = 1;", "read run")[0].status, "succeeded");

  const updatedScope = readScope(dbPath, "lark.im.sent_by_me");
  assert.equal(updatedScope.cursor.created_at_ms, record.occurred_at_ms);

  const secondRunId = createRun(dbPath, updatedScope);
  const duplicateEffects = succeedMessageRun(dbPath, updatedScope, secondRunId, [record], 1, cursor, {
    test: true,
  });
  assert.deepEqual(duplicateEffects, { inserted: 0, updated: 0, duplicate: 1 });
  assert.equal(sqliteQuery(dbPath, "SELECT COUNT(*) AS count FROM records;", "count records")[0].count, 1);
});

test("failed runs do not advance the scope cursor", (t) => {
  const dbPath = tempDb(t);
  const scope = readScope(dbPath, "lark.im.sent_by_me");
  const runId = createRun(dbPath, scope);

  failRun(dbPath, scope, runId, new Error("network timeout"));

  const updatedScope = readScope(dbPath, "lark.im.sent_by_me");
  assert.equal(updatedScope.cursor, null);
  const row = sqliteQuery(
    dbPath,
    "SELECT status, error_type, error_message FROM sync_runs WHERE id = 1;",
    "read failed run",
  )[0];
  assert.equal(row.status, "failed");
  assert.equal(row.error_type, "Error");
  assert.match(row.error_message, /network timeout/);
});
