import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectQualityReport, hasQualityIssues } from "../src/diagnostics/lark-im-quality-report.mjs";
import {
  acquireLock,
  createRun,
  ensureInitialized,
  failRun,
  readScope,
  releaseLock,
  sqliteExec,
  succeedMessageRun,
} from "../dist/storage/sqlite/ingestion-store.js";
import { cursorAfter, recordFromMessage } from "../src/adapters/lark-im/core.mjs";

function tempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-quality-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "exocortex.sqlite");
  ensureInitialized(dbPath);
  return dbPath;
}

function larkMessage(id, occurredAtMs, overrides = {}) {
  return {
    message_id: id,
    create_time: String(Math.floor(occurredAtMs / 1000)),
    msg_type: "text",
    sender: {
      id: "ou_named_sender",
      id_type: "open_id",
      sender_type: "user",
      name: "Named Sender",
    },
    chat_id: "oc_synthetic_chat",
    chat_type: "group",
    chat_name: "Synthetic Chat",
    content: "hello",
    ...overrides,
  };
}

function createLockedRun(dbPath, scope) {
  assert.equal(acquireLock(dbPath, scope.id, 60), true);
  const lockedScope = readScope(dbPath, scope.id);
  return {
    scope: lockedScope,
    runId: createRun(dbPath, lockedScope, { runner: "tests/lark-im-quality.test.mjs" }),
  };
}

function missingAppRecord(scopeId, id, occurredAtMs, appId, chatId) {
  return recordFromMessage(
    larkMessage(id, occurredAtMs, {
      sender: {
        id: appId,
        id_type: "app_id",
        sender_type: "app",
      },
      chat_id: chatId,
      msg_type: "interactive",
      content: "[Card]",
    }),
    scopeId,
    "received",
  );
}

function storeRecords(dbPath, scope, records, cursorMs) {
  const lockedRun = createLockedRun(dbPath, scope);
  try {
    succeedMessageRun(
      dbPath,
      lockedRun.scope,
      lockedRun.runId,
      records,
      records.length,
      cursorAfter(cursorMs),
      { test: true },
    );
  } finally {
    releaseLock(dbPath, scope.id);
  }
}

function markUnresolved(dbPath, externalId) {
  const quotedId = `'${String(externalId).replaceAll("'", "''")}'`;
  sqliteExec(
    dbPath,
    `UPDATE records
     SET canonical_json = json_set(
       canonical_json,
       '$.sender_name_resolution_status', 'unresolved_app_sender',
       '$.sender_name_resolution_reason', 'no_safe_fallback'
     )
     WHERE external_id = ${quotedId};`,
    "mark unresolved app sender",
  );
}

test("lark im quality report flags missing names, chat names, and invalid bodies", (t) => {
  const dbPath = tempDb(t);
  const scope = readScope(dbPath, "lark.im.sent_by_me");
  const base = 1700000000000;
  const records = [
    recordFromMessage(
      larkMessage("om_missing_user", base, {
        sender: {
          id: "ou_missing_user",
          id_type: "open_id",
          sender_type: "user",
        },
        chat_name: "",
        content: "[Invalid rich text JSON]",
      }),
      scope.id,
      "received",
      {},
      { chat_id: "oc_synthetic_chat", chat_type: "group", chat_name: "" },
    ),
    recordFromMessage(
      larkMessage("om_missing_app", base + 1000, {
        sender: {
          id: "cli_missing_app",
          id_type: "app_id",
          sender_type: "app",
        },
        msg_type: "interactive",
        content: "[Card]",
      }),
      scope.id,
      "received",
    ),
    recordFromMessage(
      larkMessage("om_deleted_invalid", base + 2000, {
        deleted: true,
        content: "[Invalid rich text JSON]",
      }),
      scope.id,
      "received",
    ),
  ];
  const lockedRun = createLockedRun(dbPath, scope);
  succeedMessageRun(dbPath, lockedRun.scope, lockedRun.runId, records, records.length, cursorAfter(base + 2000), { test: true });
  releaseLock(dbPath, scope.id);
  sqliteExec(
    dbPath,
    `INSERT INTO sync_scopes (id, source_id, name, description, enabled, config_json)
     VALUES
     (
       'lark.im.received.chat.synthetic',
       'lark.im',
       'received.chat.synthetic',
       'Synthetic received chat scope.',
       1,
       '{"hot_seen_at":"2026-06-13T00:00:00.000Z","unsupported_reason":"restricted_mode"}'
     ),
     (
       'lark.im.received.chat.out_of_chat',
       'lark.im',
       'received.chat.out_of_chat',
       'Synthetic out-of-chat received scope.',
       0,
       '{"hot_seen_at":"2026-06-13T00:01:00.000Z","unsupported_reason":"bot_user_out_of_chat","lark_cli_error_code":230002,"lark_cli_error_message":"Bot/User can NOT be out of the chat."}'
     );`,
    "insert synthetic received scope",
  );

  const report = collectQualityReport(dbPath);

  assert.deepEqual(report.messages, {
    total: 3,
    sent: 0,
    received: 3,
    latest_at: new Date(base + 2000).toISOString(),
  });
  assert.equal(report.quality.missing_sender_name, 2);
  assert.equal(report.quality.missing_user_sender_name, 1);
  assert.equal(report.quality.missing_app_sender_name, 1);
  assert.equal(report.quality.unresolved_app_sender_name, 0);
  assert.equal(report.quality.missing_system_sender_name, 0);
  assert.equal(report.quality.actionable_missing_sender_name, 2);
  assert.equal(report.quality.app_sender_records, 1);
  assert.equal(report.quality.missing_chat_name, 1);
  assert.equal(report.quality.invalid_rendered_body, 1);
  assert.equal(report.quality.deleted_or_recalled_body, 1);
  assert.equal(report.scopes.enabled_received_scopes, 1);
  assert.equal(report.scopes.hot_seen_scopes, 2);
  assert.equal(report.scopes.unsupported_scopes, 2);
  assert.deepEqual(report.unsupported_reasons, [
    {
      reason: "bot_user_out_of_chat",
      error_code: 230002,
      count: 1,
    },
    { reason: "restricted_mode", error_code: null, count: 1 },
  ]);
  assert.equal(hasQualityIssues(report), true);
});

test("lark im quality treats senderless system and known unresolved app senders as advisory", (t) => {
  const dbPath = tempDb(t);
  const scope = readScope(dbPath, "lark.im.sent_by_me");
  const base = 1700000000000;
  const records = [
    recordFromMessage(
      larkMessage("om_system_senderless", base, {
        msg_type: "system",
        sender: {},
        content: "system event",
      }),
      scope.id,
      "received",
    ),
    recordFromMessage(
      larkMessage("om_unresolved_app", base + 1000, {
        sender: {
          id: "cli_unresolved_app",
          id_type: "app_id",
          sender_type: "app",
        },
        msg_type: "interactive",
        content: "[Card]",
      }),
      scope.id,
      "received",
    ),
  ];
  const lockedRun = createLockedRun(dbPath, scope);
  succeedMessageRun(dbPath, lockedRun.scope, lockedRun.runId, records, records.length, cursorAfter(base + 1000), { test: true });
  releaseLock(dbPath, scope.id);
  sqliteExec(
    dbPath,
    `UPDATE records
     SET canonical_json = json_set(
       canonical_json,
       '$.sender_name_resolution_status', 'unresolved_app_sender',
       '$.sender_name_resolution_reason', 'no_safe_fallback'
     )
     WHERE external_id = 'om_unresolved_app';`,
    "mark unresolved app sender",
  );

  const report = collectQualityReport(dbPath);

  assert.equal(report.quality.missing_sender_name, 2);
  assert.equal(report.quality.missing_user_sender_name, 0);
  assert.equal(report.quality.missing_app_sender_name, 1);
  assert.equal(report.quality.unresolved_app_sender_name, 1);
  assert.equal(report.quality.missing_system_sender_name, 1);
  assert.equal(report.quality.actionable_missing_sender_name, 0);
  assert.equal(hasQualityIssues(report), false);
});

test("lark im quality inherits unresolved app verdict within the same app and chat pair", (t) => {
  const dbPath = tempDb(t);
  const scope = readScope(dbPath, "lark.im.sent_by_me");
  const base = 1700000000000;
  const records = [
    missingAppRecord(scope.id, "om_pair_known", base, "cli_pair_app", "oc_pair_chat"),
    missingAppRecord(scope.id, "om_pair_new", base + 1000, "cli_pair_app", "oc_pair_chat"),
  ];
  storeRecords(dbPath, scope, records, base + 1000);
  markUnresolved(dbPath, "om_pair_known");

  const report = collectQualityReport(dbPath);

  assert.equal(report.quality.missing_app_sender_name, 2);
  assert.equal(report.quality.unresolved_app_sender_name, 2);
  assert.equal(report.quality.missing_non_actionable_sender_name, 2);
  assert.equal(report.quality.actionable_missing_sender_name, 0);
  assert.equal(hasQualityIssues(report), false);
});

test("lark im quality does not inherit unresolved app verdict across chats", (t) => {
  const dbPath = tempDb(t);
  const scope = readScope(dbPath, "lark.im.sent_by_me");
  const base = 1700000000000;
  const records = [
    missingAppRecord(scope.id, "om_chat_known", base, "cli_shared_app", "oc_known_chat"),
    missingAppRecord(scope.id, "om_chat_new", base + 1000, "cli_shared_app", "oc_other_chat"),
  ];
  storeRecords(dbPath, scope, records, base + 1000);
  markUnresolved(dbPath, "om_chat_known");

  const report = collectQualityReport(dbPath);

  assert.equal(report.quality.missing_app_sender_name, 2);
  assert.equal(report.quality.unresolved_app_sender_name, 1);
  assert.equal(report.quality.missing_non_actionable_sender_name, 1);
  assert.equal(report.quality.actionable_missing_sender_name, 1);
  assert.equal(hasQualityIssues(report), true);
});

test("lark im quality does not inherit unresolved app verdict across apps", (t) => {
  const dbPath = tempDb(t);
  const scope = readScope(dbPath, "lark.im.sent_by_me");
  const base = 1700000000000;
  const records = [
    missingAppRecord(scope.id, "om_app_known", base, "cli_known_app", "oc_shared_chat"),
    missingAppRecord(scope.id, "om_app_new", base + 1000, "cli_other_app", "oc_shared_chat"),
  ];
  storeRecords(dbPath, scope, records, base + 1000);
  markUnresolved(dbPath, "om_app_known");

  const report = collectQualityReport(dbPath);

  assert.equal(report.quality.missing_app_sender_name, 2);
  assert.equal(report.quality.unresolved_app_sender_name, 1);
  assert.equal(report.quality.missing_non_actionable_sender_name, 1);
  assert.equal(report.quality.actionable_missing_sender_name, 1);
  assert.equal(hasQualityIssues(report), true);
});

test("lark im quality classifies historical Lark rate limits", (t) => {
  const dbPath = tempDb(t);
  const scope = readScope(dbPath, "lark.im.sent_by_me");
  const lockedRun = createLockedRun(dbPath, scope);
  failRun(
    dbPath,
    lockedRun.scope,
    lockedRun.runId,
    new Error(
      'lark-cli im +messages-search --sender GENERATED_PRIVATE_QUALITY_SENDER failed: {"ok":false,"error":{"type":"api","code":9499,"message":"too many request"}}',
    ),
  );
  releaseLock(dbPath, scope.id);

  const report = collectQualityReport(dbPath);
  const output = JSON.stringify(report);

  assert.deepEqual(report.recent_failures[0], {
    failure_kind: "rate_limited",
    transient: true,
    error_code: 9499,
  });
  assert.doesNotMatch(output, /GENERATED_PRIVATE_QUALITY_SENDER|too many request|messages-search/);
});
