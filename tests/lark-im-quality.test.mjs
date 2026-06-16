import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { plain } from "../dist/terminal/index.js";
import { collect, parseArgs, render } from "../scripts/lark-im-quality.mjs";
import {
  createRun,
  ensureInitialized,
  readScope,
  sqliteExec,
  succeedMessageRun,
} from "../dist/storage/sqlite/ingestion-store.js";
import { cursorAfter, recordFromMessage } from "../scripts/lark-im-sync.mjs";

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
  const runId = createRun(dbPath, scope, { runner: "tests/lark-im-quality.test.mjs" });
  succeedMessageRun(dbPath, scope, runId, records, records.length, cursorAfter(base + 2000), { test: true });
  sqliteExec(
    dbPath,
    `INSERT INTO sync_scopes (id, source_id, name, description, enabled, config_json)
     VALUES (
       'lark.im.received.chat.synthetic',
       'lark.im',
       'received.chat.synthetic',
       'Synthetic received chat scope.',
       1,
       '{"hot_seen_at":"2026-06-13T00:00:00.000Z","unsupported_reason":"restricted_mode"}'
     );`,
    "insert synthetic received scope",
  );

  const report = collect(dbPath);

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
  assert.equal(report.scopes.hot_seen_scopes, 1);
  assert.equal(report.scopes.unsupported_scopes, 1);
  assert.match(plain(render(report)), /Lark IM data quality NEEDS ATTENTION/);
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
  const runId = createRun(dbPath, scope, { runner: "tests/lark-im-quality.test.mjs" });
  succeedMessageRun(dbPath, scope, runId, records, records.length, cursorAfter(base + 1000), { test: true });
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

  const report = collect(dbPath);

  assert.equal(report.quality.missing_sender_name, 2);
  assert.equal(report.quality.missing_user_sender_name, 0);
  assert.equal(report.quality.missing_app_sender_name, 1);
  assert.equal(report.quality.unresolved_app_sender_name, 1);
  assert.equal(report.quality.missing_system_sender_name, 1);
  assert.equal(report.quality.actionable_missing_sender_name, 0);
  assert.match(plain(render(report)), /Lark IM data quality OK/);
});

test("lark im quality argument parsing keeps json output explicit", () => {
  assert.deepEqual(parseArgs(["--db", "custom.sqlite", "--format", "json"]), {
    db: "custom.sqlite",
    format: "json",
  });
  assert.throws(() => parseArgs(["--format", "xml"]), /--format must be text or json/);
});
