import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-enrich-records-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sqliteExec(dbPath, sql, label) {
  const result = spawnSync("sqlite3", [dbPath], {
    input: `.timeout 5000\n${sql}`,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr.trim()}`);
}

function sqliteJson(dbPath, sql, label) {
  const result = spawnSync("sqlite3", ["-json", dbPath], {
    input: `.timeout 5000\n${sql}`,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr.trim()}`);
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

function quoteSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function installFakeLarkCli(dir) {
  const path = join(dir, "fake-lark-cli.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(" ") === "contact +get-user --as user --format json") {
  process.stdout.write(JSON.stringify({ open_id: "ou_shape_self", name: "Shape Self" }));
  process.exit(0);
}
process.stderr.write("unexpected lark-cli call: " + args.join(" "));
process.exit(1);
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function installSchema(dbPath) {
  sqliteExec(
    dbPath,
    `CREATE TABLE sync_scopes (
       id TEXT PRIMARY KEY,
       source_id TEXT NOT NULL,
       config_json TEXT NOT NULL
     );
     CREATE TABLE records (
       id INTEGER PRIMARY KEY,
       source_id TEXT NOT NULL,
       first_seen_scope_id TEXT NOT NULL,
       external_id TEXT NOT NULL,
       actor_id TEXT,
       container_id TEXT,
       body TEXT NOT NULL,
       canonical_json TEXT NOT NULL,
       raw_json TEXT NOT NULL,
       record_type TEXT NOT NULL,
       occurred_at_ms INTEGER NOT NULL,
       updated_at TEXT
     );`,
    "install schema",
  );
}

function insertScope(dbPath, id, config) {
  sqliteExec(
    dbPath,
    `INSERT INTO sync_scopes (id, source_id, config_json)
     VALUES (${quoteSql(id)}, 'lark.im', ${quoteSql(JSON.stringify(config))});`,
    `insert ${id}`,
  );
}

function insertRecord(dbPath, overrides = {}) {
  const canonical = {
    message_id: "om_shape_sent_001",
    msg_type: "text",
    sender_id: "ou_shape_self",
    sender_name: "Shape Self",
    sender_type: "user",
    chat_id: "oc_shape_group",
    chat_type: "group",
    chat_name: null,
    ...overrides.canonical,
  };
  const raw = overrides.raw || {};
  sqliteExec(
    dbPath,
    `INSERT INTO records (
       source_id,
       first_seen_scope_id,
       external_id,
       actor_id,
       container_id,
       body,
       canonical_json,
       raw_json,
       record_type,
       occurred_at_ms,
       updated_at
     )
     VALUES (
       'lark.im',
       ${quoteSql(overrides.first_seen_scope_id || "lark.im.sent_by_me")},
       ${quoteSql(overrides.external_id || canonical.message_id)},
       ${quoteSql(canonical.sender_id)},
       ${quoteSql(canonical.chat_id)},
       ${quoteSql(overrides.body || "shape body")},
       ${quoteSql(JSON.stringify(canonical))},
       ${quoteSql(JSON.stringify(raw))},
       'lark.im.message',
       ${Number(overrides.occurred_at_ms || 1800000000000)},
       '2027-01-15T08:00:00.000Z'
     );`,
    `insert ${overrides.external_id || canonical.message_id}`,
  );
}

test("lark-im-enrich-records fills sent group chat names from known local chat metadata", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "shape.sqlite");
  const fakeLarkCli = installFakeLarkCli(dir);
  installSchema(dbPath);
  insertScope(dbPath, "lark.im.sent_by_me", {});
  insertScope(dbPath, "lark.im.received.chat.shape", {
    chat_id: "oc_shape_group",
    chat_type: "group",
    chat_name: "Shape Hiring Group",
  });
  insertRecord(dbPath, {
    external_id: "om_shape_sent_missing_chat",
    canonical: { message_id: "om_shape_sent_missing_chat", chat_name: null },
  });
  insertRecord(dbPath, {
    external_id: "om_shape_received_known_chat",
    first_seen_scope_id: "lark.im.received.chat.shape",
    canonical: {
      message_id: "om_shape_received_known_chat",
      chat_name: "Shape Hiring Group",
    },
    occurred_at_ms: 1800000060000,
  });

  const result = spawnSync(
    process.execPath,
    ["scripts/lark-im-enrich-records.mjs", "--db", dbPath, "--limit", "10"],
    {
      cwd: process.cwd(),
      env: { ...process.env, LARK_CLI: fakeLarkCli },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.updated, 1);

  const rows = sqliteJson(
    dbPath,
    `SELECT json_extract(canonical_json, '$.chat_name') AS chat_name
     FROM records
     WHERE external_id = 'om_shape_sent_missing_chat';`,
    "read enriched sent record",
  );
  assert.deepEqual(rows, [{ chat_name: "Shape Hiring Group" }]);
});
