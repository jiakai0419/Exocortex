import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { plain } from "../dist/terminal/index.js";
import {
  parseArgs,
  runQualityCli,
} from "../src/cli/lark-im-quality-command.mjs";
import { collectQualityReport } from "../src/diagnostics/lark-im-quality-report.mjs";
import { renderQualityText } from "../src/terminal/lark-im-quality-view.mjs";
import {
  createRun,
  ensureInitialized,
  failRun,
  readScope,
  sqliteExec,
  succeedMessageRun,
} from "../dist/storage/sqlite/ingestion-store.js";
import { cursorAfter, recordFromMessage } from "../scripts/lark-im-sync.mjs";

function memoryWriter() {
  let text = "";
  return {
    stream: {
      write(chunk) {
        text += String(chunk);
      },
    },
    text: () => text,
  };
}

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
      lark_cli_error_code: 230002,
      lark_cli_error_message: "Bot/User can NOT be out of the chat.",
      count: 1,
    },
    { reason: "restricted_mode", lark_cli_error_code: "", lark_cli_error_message: "", count: 1 },
  ]);
  assert.match(plain(renderQualityText(report)), /Lark IM data quality NEEDS ATTENTION/);
  assert.match(plain(renderQualityText(report)), /Unsupported reasons/);
  assert.match(plain(renderQualityText(report)), /230002: Bot\/User can NOT be out of the chat\./);
  assert.match(plain(renderQualityText(report)), /restricted_mode/);
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

  const report = collectQualityReport(dbPath);

  assert.equal(report.quality.missing_sender_name, 2);
  assert.equal(report.quality.missing_user_sender_name, 0);
  assert.equal(report.quality.missing_app_sender_name, 1);
  assert.equal(report.quality.unresolved_app_sender_name, 1);
  assert.equal(report.quality.missing_system_sender_name, 1);
  assert.equal(report.quality.actionable_missing_sender_name, 0);
  assert.match(plain(renderQualityText(report)), /Lark IM data quality OK/);
});

test("lark im quality classifies historical Lark rate limits", (t) => {
  const dbPath = tempDb(t);
  const scope = readScope(dbPath, "lark.im.sent_by_me");
  const runId = createRun(dbPath, scope, { runner: "tests/lark-im-quality.test.mjs" });
  failRun(
    dbPath,
    scope,
    runId,
    new Error(
      'lark-cli im +messages-search --sender <redacted> failed: {"ok":false,"error":{"type":"api","code":9499,"message":"too many request"}}',
    ),
  );

  const report = collectQualityReport(dbPath);
  const output = plain(renderQualityText(report));

  assert.equal(report.recent_failures[0].failure_kind, "rate_limited");
  assert.equal(report.recent_failures[0].transient, true);
  assert.equal(report.recent_failures[0].error_code, 9499);
  assert.match(output, /\[rate_limited\]/);
  assert.doesNotMatch(output, /ou_secret/);
});

test("lark im quality argument parsing keeps json output explicit", () => {
  assert.deepEqual(parseArgs(["--db", "custom.sqlite", "--format", "json"]), {
    db: "custom.sqlite",
    format: "json",
  });
  assert.throws(() => parseArgs(["--format", "xml"]), /--format must be text or json/);
});

test("lark im quality command renders text, json, help, and dependency errors", () => {
  const report = {
    messages: { total: 3, sent: 1, received: 2, latest_at: "2026-06-20T00:00:00.000Z" },
    message_types: [{ msg_type: "text", count: 3 }],
    quality: {
      actionable_missing_sender_name: 0,
      missing_sender_name: 1,
      missing_user_sender_name: 0,
      missing_app_sender_name: 1,
      unresolved_app_sender_name: 1,
      missing_system_sender_name: 0,
      missing_chat_name: 0,
      invalid_rendered_body: 0,
      deleted_or_recalled_body: 0,
      app_sender_records: 1,
    },
    scopes: {
      enabled_received_scopes: 2,
      total_received_scopes: 2,
      enabled_without_cursor: 0,
      hot_seen_scopes: 1,
      unsupported_scopes: 0,
    },
    unsupported_reasons: [],
    recent_failures: [],
    latest_records: [],
  };
  const stdout = memoryWriter();
  const stderr = memoryWriter();
  const exitText = runQualityCli([], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    deps: {
      resolvePath: (dbPath) => `/abs/${dbPath}`,
      existsSync: () => true,
      collect: () => report,
    },
  });

  assert.equal(exitText, 0);
  assert.equal(stderr.text(), "");
  assert.match(plain(stdout.text()), /Lark IM data quality OK/);

  const jsonOut = memoryWriter();
  const exitJson = runQualityCli(["--format", "json"], {
    stdout: jsonOut.stream,
    deps: {
      resolvePath: (dbPath) => `/abs/${dbPath}`,
      existsSync: () => true,
      collect: () => report,
    },
  });
  assert.equal(exitJson, 0);
  assert.equal(JSON.parse(jsonOut.text()).messages.total, 3);

  const helpOut = memoryWriter();
  assert.equal(runQualityCli(["--help"], { stdout: helpOut.stream }), 0);
  assert.match(helpOut.text(), /Usage: node scripts\/lark-im-quality\.mjs/);

  const errorOut = memoryWriter();
  const exitError = runQualityCli(["--db", "missing.sqlite"], {
    stderr: errorOut.stream,
    deps: {
      resolvePath: (dbPath) => `/abs/${dbPath}`,
      existsSync: () => false,
    },
  });
  assert.equal(exitError, 1);
  assert.match(plain(errorOut.text()), /database not found/);
});
