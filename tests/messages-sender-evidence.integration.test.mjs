import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ensureInitialized, quoteSql, sqliteExec } from "../dist/storage/sqlite/ingestion-store.js";
import { recordFromMessage } from "../src/adapters/lark-im/message-record.mjs";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";

// Fresh invented inputs only. Every CLI read uses a newly initialized SQLite
// database and traps both the remote CLI and direct Node network connections.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const START = Date.UTC(2059, 4, 23, 11, 17);
const SCOPE = "lark.im.sent_by_me";
const ACTOR = "ou_synthetic_sender_cedar";
const ALIAS = "synthetic_sender_cedar_alias";
const OTHER = "ou_synthetic_sender_amber";
const APP = "cli_synthetic_sender_lantern";
const unknown = `${ACTOR.slice(0, 8)}...`;
const hash = (value) => createHash("sha256").update(value).digest("hex");

function record(key, sender, { canonical = {}, omit = [], actor, wrap = false, msgType = "text" } = {}) {
  const source = { message_id: `om_synthetic_sender_${key}`, create_time: String(START),
    update_time: String(START + 17), chat_id: "oc_synthetic_sender_workshop", chat_type: "group",
    msg_type: msgType, content: { text: `SYNTHETIC_BODY_${key}` }, sender };
  const result = recordFromMessage(source, SCOPE, "received");
  const projected = { ...JSON.parse(result.canonical_json), ...canonical };
  for (const field of omit) delete projected[field];
  result.canonical_json = JSON.stringify(projected);
  if (actor !== undefined) result.actor_id = actor;
  if (wrap) {
    // The native sender, not a derived wrapper's different identity/name, is
    // authoritative. Existing raw_api compatibility must survive the guard.
    result.raw_json = JSON.stringify({ raw_api: source,
      sender: { id: OTHER, id_type: "open_id", name: "WRAPPER_NAME_MUST_NOT_SUPPLY" } });
    result.content_hash = hash(result.raw_json);
  }
  return result;
}

function fixture(t, rows) {
  const directory = mkdtempSync(join(tmpdir(), "exocortex-synthetic-sender-reading-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, "synthetic.sqlite");
  const marker = join(directory, "unexpected-network");
  const networkCli = join(directory, "reject-network-cli");
  const networkGuard = join(directory, "reject-network.mjs");
  writeFileSync(networkCli, '#!/bin/sh\nprintf called > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
  writeFileSync(networkGuard, `import { writeFileSync } from "node:fs";
import { Socket } from "node:net";
const reject = () => { writeFileSync(process.env.SYNTHETIC_NETWORK_MARKER, "called"); throw new Error("unexpected synthetic network access"); };
globalThis.fetch = reject;
Socket.prototype.connect = reject;
`);
  ensureInitialized(db);
  for (const row of rows) {
    const columns = Object.keys(row);
    sqliteExec(db, `INSERT INTO records(${columns.join(",")}) VALUES(${columns.map((column) =>
      row[column] === null ? "NULL" : typeof row[column] === "number" ? String(row[column]) : quoteSql(row[column])).join(",")});`);
  }
  const journal = spawnSync("sqlite3", [db, "PRAGMA journal_mode=DELETE;"], { encoding: "utf8" });
  assert.equal(journal.status, 0, journal.stderr);
  assert.equal(journal.stdout.trim(), "delete");
  return { directory, db, marker, networkCli, networkGuard };
}

function snapshot(f) {
  const dump = spawnSync("sqlite3", ["-readonly", f.db, ".dump"], { encoding: "utf8" });
  assert.equal(dump.status, 0, dump.stderr);
  return { bytes: hash(readFileSync(f.db)), dump: dump.stdout, files: readdirSync(f.directory).sort(),
    mode: statSync(f.db).mode & 0o777, modified: statSync(f.db).mtimeMs };
}

function messages(f, format) {
  const env = { ...process.env, NO_COLOR: "1", LARK_CLI: f.networkCli, SYNTHETIC_NETWORK_MARKER: f.marker };
  delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath, ["--import", f.networkGuard, join(ROOT, "bin/exocortex.mjs"),
    "messages", "--db", f.db, "--format", format, "--limit", "100"], {
    cwd: ROOT, encoding: "utf8", env, timeout: 10_000, maxBuffer: 5 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.equal(existsSync(f.marker), false, "reading must not invoke Lark, fetch or a network socket");
  return format === "json" ? JSON.parse(result.stdout) : result.stdout;
}

function verify(t, cases) {
  const rows = cases.map(({ row }) => row);
  const f = fixture(t, rows);
  const before = snapshot(f);
  const json = messages(f, "json");
  const text = messages(f, "text");
  assert.equal(json.length, cases.length);
  for (const { row, expected } of cases) {
    const actual = json.find((entry) => entry.external_id === row.external_id);
    assert.ok(actual, row.external_id);
    assert.equal(actual.display.sender, expected, row.external_id);
    for (const key of ["actor_id", "body", "raw_json", "canonical_json"]) assert.equal(actual[key], row[key], key);
    assert.deepEqual(actual.raw, JSON.parse(row.raw_json));
    assert.deepEqual(actual.canonical, JSON.parse(row.canonical_json));
    assert.equal(actual.display.body, row.body);
    const block = text.split("\n\n").find((part) => part.includes(row.body));
    assert.ok(block, row.external_id);
    assert.equal(block.match(/发送人\s+([^\n]+)/)?.[1], expected, row.external_id);
  }
  assert.deepEqual(messages(f, "json"), json, "text reading cannot affect subsequent JSON");
  assert.deepEqual(snapshot(f), before, "reading preserves bytes, all tables, schema, hash/version, times and directory contents");
}

test("real messages CLI does not revive source names rejected for sender conflicts", (t) => {
  const conflict = { id: ACTOR, id_type: "open_id", open_id: OTHER, name: "REJECTED_CONFLICT_NAME" };
  const native = { message_id: "om_synthetic_sender_canonical_conflict", create_time: String(START),
    update_time: String(START + 17), chat_id: "oc_synthetic_sender_workshop", msg_type: "text",
    sender: conflict, body: { content: JSON.stringify({ text: "SYNTHETIC_BODY_canonical_conflict" }) } };
  const original = recordFromMessage(normalizeApiMessage(native), SCOPE, "received");
  assert.equal(JSON.parse(original.canonical_json).sender_id_type, "conflicting");
  assert.equal(JSON.parse(original.canonical_json).sender_name, null);
  assert.equal(original.raw_json, JSON.stringify(native));
  assert.equal(original.content_hash, hash(JSON.stringify(native)));
  verify(t, [
    { row: original, expected: unknown },
    { row: record("raw_conflict_legacy", conflict, { omit: ["sender_id_type"] }), expected: unknown },
    { row: record("canonical_conflict_only", { id: ACTOR, id_type: "open_id", name: "REJECTED_MARKED_NAME" },
      { canonical: { sender_id_type: "conflicting", sender_name: null } }), expected: unknown },
    { row: record("malformed_source", { id: ACTOR, id_type: "open_id", user_id: [], name: "REJECTED_MALFORMED_NAME" },
      { omit: ["sender_id_type"] }), expected: unknown },
  ]);
});

test("raw fallback requires agreement with stored actors and explicit namespaces", (t) => {
  const sender = { id: ACTOR, id_type: "open_id", name: "UNMATCHED_SOURCE_NAME" };
  verify(t, [
    { row: record("source_actor_disagrees", { ...sender, id: OTHER },
      { actor: ACTOR, canonical: { sender_id: ACTOR, sender_name: null } }), expected: unknown },
    { row: record("row_actor_disagrees", sender,
      { actor: OTHER, canonical: { sender_name: null } }), expected: unknown },
    { row: record("namespace_disagrees", sender,
      { canonical: { sender_id_type: "user_id", sender_name: null } }), expected: unknown },
    { row: record("malformed_namespace", sender,
      { canonical: { sender_id_type: ["open_id"], sender_name: null } }), expected: unknown },
    { row: record("idless_cannot_name_actor", { name: "UNMATCHED_IDLESS_NAME" },
      { actor: ACTOR, canonical: { sender_id: ACTOR, sender_name: null } }), expected: unknown },
  ]);
});

test("clear and every source alias echo remain unknown while a valid display_name can supply the name", (t) => {
  const sender = { id: ACTOR, id_type: "open_id", sender_id: { user_id: ALIAS } };
  verify(t, [
    { row: record("cleared", { ...sender, name: "OLD_CLEARED_NAME" },
      { canonical: { sender_name: null, sender_name_state: "cleared" } }), expected: unknown },
    { row: record("stale_name_with_clear", { ...sender, name: "OLD_CLEARED_NAME" },
      { canonical: { sender_name: "STALE_CANONICAL_NAME", sender_name_state: "cleared" } }), expected: unknown },
    { row: record("source_alias_echo", { ...sender, name: ALIAS }), expected: unknown },
    { row: record("canonical_alias_echo", sender, { canonical: { sender_name: ALIAS } }), expected: unknown },
    { row: record("canonical_actor_echo", sender, { canonical: { sender_name: ACTOR } }), expected: unknown },
    { row: record("display_name_after_echo", { ...sender, name: ALIAS, display_name: "Invented Cedar Display" },
      { canonical: { sender_name: null } }), expected: "Invented Cedar Display" },
    { row: record("echo_can_fall_back", { ...sender, name: "Invented Cedar Source" },
      { canonical: { sender_name: ALIAS } }), expected: "Invented Cedar Source" },
  ]);
});

test("trusted legacy, typed nested and wrapped sender names remain readable", (t) => {
  verify(t, [
    { row: record("legacy_untyped", { id: ACTOR, name: "Invented Legacy Sender" },
      { omit: ["sender_name", "sender_id_type"] }), expected: "Invented Legacy Sender" },
    { row: record("legacy_typed", { open_id: ACTOR, name: "Invented Typed Sender" },
      { omit: ["sender_name", "sender_id_type", "sender_id"] }), expected: "Invented Typed Sender" },
    { row: record("nested", { sender_id: { open_id: ACTOR, user_id: ALIAS }, display_name: "Invented Nested Sender" },
      { canonical: { sender_name: null } }), expected: "Invented Nested Sender" },
    { row: record("wrapped", { id: ACTOR, id_type: "open_id", name: "Invented Native Sender" },
      { canonical: { sender_name: null }, wrap: true }), expected: "Invented Native Sender" },
    { row: record("idless", { name: "Invented IDless Sender" },
      { omit: ["sender_name", "sender_id_type"] }), expected: "Invented IDless Sender" },
    { row: record("canonical_first", { id: ACTOR, id_type: "open_id", name: "Lesser Source Name" },
      { canonical: { sender_name: "Invented Known Sender" } }), expected: "Invented Known Sender" },
    { row: record("canonical_without_raw_name", { id: ACTOR, id_type: "open_id" },
      { canonical: { sender_name: "Invented Enriched Sender" } }), expected: "Invented Enriched Sender" },
  ]);
});

test("unknown sender IDs, applications and senderless systems keep their daily labels", (t) => {
  verify(t, [
    { row: record("unknown_person", { id: ACTOR, id_type: "open_id" }), expected: unknown },
    { row: record("no_sender", {}), expected: "unknown" },
    { row: record("system", {}, { msgType: "system" }), expected: "系统" },
    { row: record("known_app", { id: APP, id_type: "app_id", sender_type: "app", name: "Invented Lantern App" },
      { canonical: { sender_name: null } }), expected: "应用：Invented Lantern App" },
    { row: record("legacy_app", { id: APP, sender_type: "app", name: "Invented Legacy App" },
      { omit: ["sender_name", "sender_id_type"] }), expected: "应用：Invented Legacy App" },
    { row: record("unknown_app", { id: APP, id_type: "app_id", sender_type: "app" }), expected: `应用：${APP.slice(0, 8)}...` },
  ]);
});
