import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createRun, ensureInitialized, quoteSql, readScope, sqliteExec, succeedRecordRun } from "../dist/storage/sqlite/ingestion-store.js";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";

// Freshly invented source records represent old persisted projections. No sync,
// native normalization, contact lookup or production data seeds these fixtures.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const START = Date.parse("2025-12-31T01:02:00Z");
const SCOPE = "lark.im.received.chat.synthetic_card_source_tokens";
const ACTOR = "ou_synthetic_card_sender";

function row(name, payload, overrides = {}) {
  const raw = {
    message_id: `om_synthetic_card_${name}`, msg_type: "interactive",
    chat_id: "oc_synthetic_card_source_tokens", create_time: String(START),
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

function database(t, rows) {
  const directory = mkdtempSync(join(tmpdir(), "exocortex-card-source-tokens-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "invented.sqlite");
  const networkMarker = join(directory, "unexpected-network-cli");
  const noNetworkCli = join(directory, "reject-network-cli");
  writeFileSync(noNetworkCli, "#!/bin/sh\nprintf called > \"$SYNTHETIC_NETWORK_MARKER\"\nexit 97\n", { mode: 0o700 });
  ensureInitialized(dbPath);
  sqliteExec(dbPath, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(
    ${quoteSql(SCOPE)},'lark.im','synthetic card reader',${quoteSql(JSON.stringify({ chat_id: "oc_synthetic_card_source_tokens", chat_type: "group" }))});
    ${rows.map((entry, index) => `INSERT INTO records(source_id,first_seen_scope_id,external_id,external_version,record_type,
      occurred_at,occurred_at_ms,actor_id,container_id,direction,body,content_hash,canonical_json,raw_json)
      VALUES('lark.im',${quoteSql(SCOPE)},${quoteSql(entry.raw.message_id || `om_synthetic_card_${entry.name}`)},'1','lark.im.message',
        ${quoteSql(new Date(START + index * 1000).toISOString())},${START + index * 1000},${quoteSql(ACTOR)},'oc_synthetic_card_source_tokens',
        'received',${quoteSql(entry.body)},${quoteSql(hash(entry.body))},${quoteSql(JSON.stringify(entry.canonical))},${quoteSql(JSON.stringify(entry.raw))});`).join("\n")}`);
  const journal = spawnSync("sqlite3", [dbPath, "PRAGMA journal_mode=DELETE;"], { encoding: "utf8" });
  assert.equal(journal.status, 0, journal.stderr);
  assert.equal(journal.stdout.trim(), "delete");
  return { directory, dbPath, noNetworkCli, networkMarker, rows };
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


import { recordFromMessage } from "../src/adapters/lark-im/message-record.mjs";
import { cursorAfter } from "../src/adapters/lark-im/core.mjs";

const URL_WITH_SOURCE_KEY = "https://example.invalid/public?token=@_user_1]SYNTHETIC_QUERY_TAIL";
const MENTION = { key: "@_user_1", id: { open_id: "ou_synthetic_source_token_person" }, name: "Synthetic Person" };

function sourceMessage(name, text) {
  const original = row(name, { elements: [{ tag: "div", text: { tag: "lark_md", content: text } }] });
  original.raw.mentions = [structuredClone(MENTION)];
  return original;
}

function storeNormalized(t, original) {
  const fixture = database(t, []);
  const normalized = normalizeApiMessage(original.raw);
  const scope = readScope(fixture.dbPath, SCOPE);
  const record = recordFromMessage(normalized, SCOPE, "received", {}, scope.config);
  const runId = createRun(fixture.dbPath, scope, { runner: "synthetic source-token integration" });
  const effects = succeedRecordRun(fixture.dbPath, scope, runId, [record], 1, cursorAfter(START + 60_000),
    { fixture: "synthetic source tokens" });
  assert.deepEqual(effects, { inserted: 1, updated: 0, duplicate: 0 });
  assert.equal(record.raw_json, JSON.stringify(original.raw));
  assert.deepEqual(normalized.raw_api, original.raw);
  return { fixture, normalized, record };
}

function assertSafeProjection(text, linkForm) {
  assert.doesNotMatch(text, /SYNTHETIC_QUERY_TAIL|token=|@_user_1/);
  assert.match(text, /https:\/\/example\.invalid\/public/);
  assert.match(text, /Before @Synthetic Person/);
  assert.match(text, /After @Synthetic Person/);
  assert.equal((text.match(/Synthetic Person/g) || []).length, 2,
    "the same key outside a URL resolves twice; the URL's source key is never expanded into a third visible name");
  if (linkForm === "markdown") assert.match(text, /open/);
}

for (const storageRoute of ["legacy", "normalize_record_store"]) {
  for (const linkForm of ["bare", "markdown"]) {
    test(`source URL tokens survive mention resolution through ${storageRoute} / ${linkForm}`, (t) => {
      const link = linkForm === "markdown" ? `[open](${URL_WITH_SOURCE_KEY})` : URL_WITH_SOURCE_KEY;
      const input = `Before @_user_1 ${link} After @_user_1`;
      const original = sourceMessage(`${storageRoute}_${linkForm}`, input);
      const nativeBefore = JSON.stringify(original.raw);
      const persisted = storageRoute === "legacy" ? { fixture: database(t, [original]),
        normalized: normalizeApiMessage(original.raw), record: null } : storeNormalized(t, original);
      const { fixture, normalized, record } = persisted;
      const before = snapshot(fixture);
      const [json] = messages(fixture, "json");
      const text = messages(fixture, "text");
      assert.equal(JSON.stringify(original.raw), nativeBefore);
      assert.deepEqual(json.raw, original.raw);
      assert.equal(json.raw_json, nativeBefore);
      assert.equal(JSON.parse(json.raw.body.content).elements[0].text.content, input);
      assert.deepEqual(json.raw.mentions, [MENTION]);
      assert.equal(json.display.card.version, 3);
      assert.equal(json.display.card.status, "rendered");
      assert.equal(json.display.card.text, normalized.content);
      if (storageRoute === "legacy") {
        assertOriginalContract(json, original);
      } else {
        assert.equal(json.body, record.body);
        assert.equal(json.display.body, record.body);
        assert.equal(json.canonical_json, record.canonical_json);
        assert.deepEqual(json.canonical, JSON.parse(record.canonical_json));
        assert.equal(json.body, normalized.content);
        assertSafeProjection(json.body, linkForm);
      }
      assertSafeProjection(normalized.content, linkForm);
      assertSafeProjection(json.display.card.text, linkForm);
      for (const visible of ["Before @Synthetic Person", "After @Synthetic Person", "https://example.invalid/public"]) assert.ok(text.includes(visible));
      assert.doesNotMatch(text, /SYNTHETIC_QUERY_TAIL|token=|@_user_1/);
      assert.deepEqual(snapshot(fixture), before, "messages reads never mutate stored records, source evidence or database bytes");
    });
  }
}
