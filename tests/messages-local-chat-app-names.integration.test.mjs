import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureInitialized, quoteSql, sqliteExec } from "../dist/storage/sqlite/ingestion-store.js";
import { liveProbeContext } from "../src/diagnostics/live-probe-cache.mjs";

// Fresh fictional records: no screenshots, production rows or redacted originals.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const START = Date.UTC(2057, 2, 19, 10);
const TENANT = "synthetic-tenant-lantern";
const CHAT = "oc_synthetic_lantern_room";
const APP = "cli_synthetic_lantern_app";
const NAME = "Synthetic Lantern Courier";
const SOURCE = { kind: "user_screenshot", recorded_at: "2057-03-19T11:00:00.000Z", evidence_refs: ["synthetic-lantern-proof-1"] };
const hash = (value) => createHash("sha256").update(value).digest("hex");

function record(key, { chat = CHAT, app = APP, tenant = TENANT, name = null, clear = false, card = false } = {}) {
  const native = { message_id: `om_synthetic_lantern_${key}`, chat_id: chat,
    msg_type: card ? "interactive" : "text", create_time: String(START),
    sender: { id: app, id_type: "app_id", sender_type: "app", tenant_key: tenant },
    body: { content: JSON.stringify(card ? { elements: [{ tag: "markdown", elements: [
      { tag: "plain_text", content: "Invented audience " }, { tag: "at_all" },
      { tag: "plain_text", content: ": the paper lighthouse opens at noon." },
    ] }] } : { text: `Fictional lantern message ${key}.` }) } };
  const raw = { ...native, raw_api: structuredClone(native), content: "SYNTHETIC_OLD_PROJECTION" };
  const canonical = { sender_id: app, sender_id_type: "app_id", sender_type: "app", sender_name: name,
    ...(clear ? { sender_name_state: "cleared" } : {}), chat_id: chat, tenant_key: tenant,
    chat_type: "group", chat_name: "Synthetic Lantern Room", msg_type: native.msg_type,
    content: "SYNTHETIC_OLD_PROJECTION" };
  return { key, chat, app, tenant, raw, canonical, body: `Stored synthetic body ${key}.` };
}

function insert(fixture, entries, offset = 0) {
  sqliteExec(fixture.dbPath, entries.map((entry, index) => {
    const scope = `synthetic.scope.${entry.key}`;
    const stamp = START + (offset + index) * 1000;
    return `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(
      ${quoteSql(scope)},'lark.im',${quoteSql(`Synthetic local name test ${entry.key}`)},${quoteSql(JSON.stringify({ chat_id: entry.chat, tenant_key: entry.tenant, chat_type: "group" }))});
      INSERT INTO records(source_id,first_seen_scope_id,external_id,external_version,record_type,
        occurred_at,occurred_at_ms,actor_id,container_id,direction,body,content_hash,canonical_json,raw_json)
      VALUES('lark.im',${quoteSql(scope)},${quoteSql(entry.raw.message_id)},'synthetic-version-1','lark.im.message',
        ${quoteSql(new Date(stamp).toISOString())},${stamp},${quoteSql(entry.app)},${quoteSql(entry.chat)},'received',
        ${quoteSql(entry.body)},${quoteSql(hash(entry.body))},${quoteSql(JSON.stringify(entry.canonical))},${quoteSql(JSON.stringify(entry.raw))});`;
  }).join("\n"));
}

function fixture(t, entries) {
  const directory = mkdtempSync(join(tmpdir(), "exocortex-synthetic-local-chat-app-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "synthetic.sqlite");
  const configPath = `${dbPath}.chat-app-names.json`;
  const networkMarker = join(directory, "unexpected-network-call");
  const networkTrap = join(directory, "reject-network-cli");
  writeFileSync(networkTrap, '#!/bin/sh\nprintf called > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
  ensureInitialized(dbPath);
  const result = { directory, dbPath, configPath, networkMarker, networkTrap };
  insert(result, entries);
  const journal = spawnSync("sqlite3", [dbPath, "PRAGMA journal_mode=DELETE;"], { encoding: "utf8" });
  assert.equal(journal.status, 0, journal.stderr);
  assert.equal(journal.stdout.trim(), "delete");
  return result;
}

function saveConfig(fixture, name = NAME) {
  writeFileSync(fixture.configPath, JSON.stringify({ kind: "lark_im_chat_app_names/v1",
    context: { database_key: liveProbeContext(fixture.dbPath).database_key, source_id: "lark.im" },
    entries: [{ tenant_key: TENANT, chat_id: CHAT, app_id: APP, name, source: SOURCE }],
  }), { mode: 0o600 });
}

function query(dbPath, sql) {
  const result = spawnSync("sqlite3", ["-readonly", "-json", dbPath, sql], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function snapshot(f) {
  return { bytes: hash(readFileSync(f.dbPath)), schema: query(f.dbPath, "SELECT * FROM sqlite_schema ORDER BY name;"),
    rows: query(f.dbPath, "SELECT * FROM records ORDER BY id;"), allTables: query(f.dbPath, ".dump"),
    files: readdirSync(f.directory).sort(), dbMode: statSync(f.dbPath).mode & 0o777, dbMtime: statSync(f.dbPath).mtimeMs,
    config: existsSync(f.configPath) ? readFileSync(f.configPath, "utf8") : null,
    configMode: existsSync(f.configPath) ? statSync(f.configPath).mode & 0o777 : null,
    configMtime: existsSync(f.configPath) ? statSync(f.configPath).mtimeMs : null };
}

function cli(f, format = "json", dbPath = f.dbPath) {
  const env = { ...process.env, NO_COLOR: "1", LARK_CLI: f.networkTrap, SYNTHETIC_NETWORK_MARKER: f.networkMarker };
  delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath, [join(ROOT, "bin/exocortex.mjs"), "messages", "--db", dbPath,
    "--format", format, "--limit", "50"], { cwd: ROOT, encoding: "utf8", env, timeout: 10_000 });
  assert.equal(existsSync(f.networkMarker), false, "local display must not perform an identity API lookup");
  return result;
}

function messages(f, format = "json") {
  const result = cli(f, format);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  return format === "json" ? JSON.parse(result.stdout) : result.stdout;
}

test("CLI overlays one exact chat/app/tenant on a historical at_all card, preserving all other JSON and database bytes", (t) => {
  const rows = [record("exact", { card: true }), record("other_chat", { chat: "oc_synthetic_pond_room" }),
    record("other_app", { app: "cli_synthetic_pond_app" }), record("other_tenant", { tenant: "synthetic-tenant-pond" }),
    record("known", { name: "Synthetic Native Courier" }), record("cleared", { clear: true })];
  const f = fixture(t, rows);
  const absentBefore = snapshot(f);
  const baseline = messages(f);
  assert.deepEqual(snapshot(f), absentBefore, "missing config must not be created or cause database writes");
  saveConfig(f);
  const before = snapshot(f);
  const actual = messages(f);
  const expected = baseline.map((entry) => entry.external_id === rows[0].raw.message_id ? {
    ...entry, display: { ...entry.display, sender: `应用：${NAME}`, sender_name_source: {
      kind: "local_chat_app_name", source_kind: "user_screenshot", recorded_at: SOURCE.recorded_at, evidence_refs: SOURCE.evidence_refs,
    } },
  } : entry);
  assert.deepEqual(actual, expected, "only exact match display.sender and explicit display provenance may differ");
  const exact = actual.find((entry) => entry.external_id === rows[0].raw.message_id);
  assert.equal(exact.display.card.text, "Invented audience @所有人: the paper lighthouse opens at noon.");
  assert.equal(exact.display.card.status, "rendered");
  assert.deepEqual(exact.raw, rows[0].raw);
  assert.deepEqual(exact.canonical, rows[0].canonical);
  assert.equal(exact.body, rows[0].body);
  const human = messages(f, "text");
  assert.match(human, /发送人\s+应用：Synthetic Lantern Courier/);
  assert.match(human, /Invented audience @所有人: the paper lighthouse opens at noon\./);
  assert.doesNotMatch(human, /user_screenshot|local_chat_app_name|synthetic-lantern-proof|2057-03-19T11:00/,
    "provenance is machine readable and must not add human display lines");
  assert.deepEqual(messages(f), actual, "text reading cannot mutate subsequent JSON");
  assert.deepEqual(snapshot(f), before, "DB bytes/schema/all rows/raw/hash/version/config and directory contents remain unchanged");
});

test("CLI config edits and removal are effective immediately and the same scope covers future synthetic messages", (t) => {
  const f = fixture(t, [record("existing")]);
  const baseline = messages(f);
  saveConfig(f);
  const firstBefore = snapshot(f);
  assert.equal(messages(f)[0].display.sender, `应用：${NAME}`);
  assert.deepEqual(snapshot(f), firstBefore);
  saveConfig(f, "Synthetic Revised Courier");
  const editedBefore = snapshot(f);
  assert.equal(messages(f)[0].display.sender, "应用：Synthetic Revised Courier");
  assert.deepEqual(snapshot(f), editedBefore);
  insert(f, [record("future", { card: true })], 10);
  const futureBefore = snapshot(f);
  const future = messages(f);
  assert.equal(future.length, 2);
  assert.ok(future.every((entry) => entry.display.sender === "应用：Synthetic Revised Courier"));
  assert.deepEqual(snapshot(f), futureBefore, "reading newly inserted synthetic rows must remain read only");
  unlinkSync(f.configPath);
  const revokedBefore = snapshot(f);
  const revoked = messages(f);
  assert.deepEqual(revoked.find((entry) => entry.external_id === baseline[0].external_id), baseline[0]);
  assert.ok(revoked.every((entry) => !Object.hasOwn(entry.display, "sender_name_source")));
  assert.deepEqual(snapshot(f), revokedBefore);
});

test("CLI rejects old mapping after database copy/replacement with the safe JSON error contract and no writes", (t) => {
  const f = fixture(t, [record("binding")]); saveConfig(f);
  const copy = join(f.directory, "synthetic-copy.sqlite"); copyFileSync(f.dbPath, copy);
  copyFileSync(f.configPath, `${copy}.chat-app-names.json`);
  for (const replace of [false, true]) {
    if (replace) renameSync(copy, f.dbPath);
    const before = snapshot(f);
    const result = cli(f, "json", replace ? f.dbPath : copy);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const error = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(error).sort(), ["error", "ok", "schema_version"]);
    assert.equal(error.schema_version, 1);
    assert.equal(error.ok, false);
    assert.equal(error.error.code, "execution_failed");
    for (const privateValue of [f.directory, NAME, APP, CHAT, TENANT, SOURCE.evidence_refs[0]]) {
      assert.equal(result.stdout.includes(privateValue), false, "errors must not expose mapping contents or local paths");
    }
    assert.deepEqual(snapshot(f), before);
  }
});
