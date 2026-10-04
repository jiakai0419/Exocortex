import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureInitialized, quoteSql, sqliteExec } from "../../dist/storage/sqlite/ingestion-store.js";

// Mechanical test infrastructure only. Scenarios, payloads, clocks and expected
// projections remain in each suite; every seeded row is freshly authored.
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ACTOR = "ou_synthetic_card_sender";

function createLegacyCardFixture({ start: START, scope: SCOPE, chatId, tempPrefix }) {
  function row(name, payload, overrides = {}) {
    const raw = {
      message_id: `om_synthetic_card_${name}`, msg_type: "interactive",
      chat_id: chatId, create_time: String(START),
      sender: { id: ACTOR, id_type: "open_id", sender_type: "user", name: "Synthetic Sender" },
      body: { content: typeof payload === "string" ? payload : JSON.stringify(payload) },
      content: "LEGACY_DERIVED_CONTENT",
      content_rendering: { version: 1, status: "structured_fallback", reason: "unsupported_message_content" },
    };
    const canonical = { msg_type: "interactive", chat_type: "group", chat_name: "Synthetic Cards",
      sender_type: "user", sender_id: ACTOR, sender_name: "Synthetic Sender",
      content: "LEGACY_DERIVED_CONTENT", content_rendering: { version: 1, status: "structured_fallback" } };
    return { name, body: `OLD_STORED_BODY_${name}`, raw, canonical, ...overrides };
  }

  function database(t, rows) {
    const directory = mkdtempSync(join(tmpdir(), tempPrefix));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const dbPath = join(directory, "invented.sqlite");
    const networkMarker = join(directory, "unexpected-network-cli");
    const noNetworkCli = join(directory, "reject-network-cli");
    writeFileSync(noNetworkCli, "#!/bin/sh\nprintf called > \"$SYNTHETIC_NETWORK_MARKER\"\nexit 97\n", { mode: 0o700 });
    ensureInitialized(dbPath);
    sqliteExec(dbPath, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(
      ${quoteSql(SCOPE)},'lark.im','synthetic card reader',${quoteSql(JSON.stringify({ chat_id: chatId, chat_type: "group" }))});
      ${rows.map((entry, index) => `INSERT INTO records(source_id,first_seen_scope_id,external_id,external_version,record_type,
        occurred_at,occurred_at_ms,actor_id,container_id,direction,body,content_hash,canonical_json,raw_json)
        VALUES('lark.im',${quoteSql(SCOPE)},${quoteSql(entry.raw.message_id || `om_synthetic_card_${entry.name}`)},'1','lark.im.message',
          ${quoteSql(new Date(START + index * 1000).toISOString())},${START + index * 1000},${quoteSql(ACTOR)},${quoteSql(chatId)},
          'received',${quoteSql(entry.body)},${quoteSql(hash(entry.body))},${quoteSql(JSON.stringify(entry.canonical))},${quoteSql(JSON.stringify(entry.raw))});`).join("\n")}`);
    const journal = spawnSync("sqlite3", [dbPath, "PRAGMA journal_mode=DELETE;"], { encoding: "utf8" });
    assert.equal(journal.status, 0, journal.stderr);
    assert.equal(journal.stdout.trim(), "delete");
    return { directory, dbPath, noNetworkCli, networkMarker, rows };
  }
  return { row, database };
}

function sqlRead(dbPath, sql, json = false) {
  const result = spawnSync("sqlite3", ["-readonly", ...(json ? ["-json"] : []), dbPath, sql], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function snapshot(fixture) {
  const { directory, dbPath } = fixture;
  return {
    fileHash: hash(readFileSync(dbPath)),
    mode: statSync(dbPath).mode & 0o777,
    modifiedMs: statSync(dbPath).mtimeMs,
    schema: sqlRead(dbPath, ".schema"),
    allBusinessRows: hash(sqlRead(dbPath, ".dump")),
    records: sqlRead(dbPath, "SELECT * FROM records ORDER BY id;", true),
    files: readdirSync(directory).sort(),
  };
}

function messages(fixture, format, extraArgs = []) {
  const env = { ...process.env, NO_COLOR: "1", LARK_CLI: fixture.noNetworkCli,
    SYNTHETIC_NETWORK_MARKER: fixture.networkMarker };
  delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath,
    [join(ROOT, "scripts/messages.mjs"), "--db", fixture.dbPath, "--format", format, "--limit", "30", ...extraArgs], {
      cwd: ROOT, encoding: "utf8", maxBuffer: 5 * 1024 * 1024, timeout: 10_000,
      env,
    });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(existsSync(fixture.networkMarker), false, "display must not invoke Lark or look up names");
  return format === "json" ? JSON.parse(result.stdout) : result.stdout;
}

function assertOriginalContract(displayed, original) {
  assert.equal(displayed.body, original.body);
  assert.equal(displayed.raw_json, JSON.stringify(original.raw));
  assert.equal(displayed.canonical_json, JSON.stringify(original.canonical));
  assert.deepEqual(displayed.raw, original.raw);
  assert.deepEqual(displayed.canonical, original.canonical);
  assert.equal(displayed.display.body, original.body);
}

export { createLegacyCardFixture, snapshot, messages, assertOriginalContract };
