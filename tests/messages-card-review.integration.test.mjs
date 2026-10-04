import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ensureInitialized, quoteSql, sqliteExec } from "../dist/storage/sqlite/ingestion-store.js";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";

// Freshly invented source records represent old persisted projections. No sync,
// native normalization, contact lookup or production data seeds these fixtures.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const START = Date.parse("2026-01-02T03:04:00Z");
const SCOPE = "lark.im.received.chat.synthetic_card_review";
const ACTOR = "ou_synthetic_card_sender";

function row(name, payload, overrides = {}) {
  const raw = {
    message_id: `om_synthetic_card_${name}`, msg_type: "interactive",
    chat_id: "oc_synthetic_card_review", create_time: String(START),
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
  const directory = mkdtempSync(join(tmpdir(), "exocortex-card-review-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "invented.sqlite");
  const networkMarker = join(directory, "unexpected-network-cli");
  const noNetworkCli = join(directory, "reject-network-cli");
  writeFileSync(noNetworkCli, "#!/bin/sh\nprintf called > \"$SYNTHETIC_NETWORK_MARKER\"\nexit 97\n", { mode: 0o700 });
  ensureInitialized(dbPath);
  sqliteExec(dbPath, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(
    ${quoteSql(SCOPE)},'lark.im','synthetic card reader',${quoteSql(JSON.stringify({ chat_id: "oc_synthetic_card_review", chat_type: "group" }))});
    ${rows.map((entry, index) => `INSERT INTO records(source_id,first_seen_scope_id,external_id,external_version,record_type,
      occurred_at,occurred_at_ms,actor_id,container_id,direction,body,content_hash,canonical_json,raw_json)
      VALUES('lark.im',${quoteSql(SCOPE)},${quoteSql(entry.raw.message_id || `om_synthetic_card_${entry.name}`)},'1','lark.im.message',
        ${quoteSql(new Date(START + index * 1000).toISOString())},${START + index * 1000},${quoteSql(ACTOR)},'oc_synthetic_card_review',
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


function verifyReadOnlyProjection(t, originals, verify) {
  const fixture = database(t, originals);
  const before = snapshot(fixture);
  const json = messages(fixture, "json");
  const text = messages(fixture, "text");
  for (const original of originals) {
    const displayed = json.find((record) => record.external_id === original.raw.message_id);
    assertOriginalContract(displayed, original);
    const normalized = normalizeApiMessage(original.raw);
    assert.equal(normalized.content, displayed.display.card.text);
    assert.deepEqual(normalized.content_rendering, {
      status: displayed.display.card.status, reason: displayed.display.card.reason, version: 3,
      ...(displayed.display.card.omitted_actions ? { omitted_actions: displayed.display.card.omitted_actions } : {}),
    });
    assert.deepEqual(normalized.raw_api, original.raw);
  }
  verify(json, text);
  assert.deepEqual(snapshot(fixture), before, "card reading must preserve database bytes, schema, rows and permissions");
}

const plain = (content) => ({ tag: "plain_text", content });
const button = (content, rest = {}) => ({ tag: "button", text: plain(content), ...rest });

test("ordinary and property card headers retain visible subtitles", (t) => {
  const originals = [
    row("header_standard", { header: { title: plain("Synthetic direct title"), subtitle: plain("Synthetic direct subtitle") },
      elements: [{ tag: "div", text: plain("Synthetic direct body") }] }),
    row("header_property", { header: { property: {
      title: { property: { content: "Synthetic property title" } },
      subtitle: { property: { content: "Synthetic property subtitle" } },
    } }, body: { elements: [{ tag: "div", property: { text: plain("Synthetic property body") } }] } }),
  ];
  verifyReadOnlyProjection(t, originals, (json, text) => {
    for (const displayed of json) assert.equal(displayed.display.card.status, "rendered");
    for (const visible of ["Synthetic direct title", "Synthetic direct subtitle", "Synthetic direct body",
      "Synthetic property title", "Synthetic property subtitle", "Synthetic property body"]) assert.ok(text.includes(visible), visible);
  });
});

test("ordinary div.extra and native div.property.extra buttons are projected as visible blocks", (t) => {
  const originals = [
    row("extra_standard", { elements: [{ tag: "div", text: plain("Synthetic direct main text"),
      extra: button("Synthetic direct extra button", { url: "https://example.invalid/direct-extra" }) }] }),
    row("extra_property", { body: { elements: [{ tag: "div", property: {
      text: plain("Synthetic property main text"),
      extra: { type: "button", property: { text: plain("Synthetic property extra button"), url: "https://example.invalid/property-extra" } },
    } }] } }),
  ];
  verifyReadOnlyProjection(t, originals, (json, text) => {
    for (const displayed of json) assert.equal(displayed.display.card.status, "rendered");
    for (const visible of ["Synthetic direct main text", "Synthetic direct extra button", "/direct-extra",
      "Synthetic property main text", "Synthetic property extra button", "/property-extra"]) assert.ok(text.includes(visible), visible);
  });
});

test("multi_url button destinations retain platform meaning and omit credentials, query and fragment", (t) => {
  const multi = Object.fromEntries([["url", "default"], ["pc_url", "desktop"], ["ios_url", "ios"], ["android_url", "android"]]
    .map(([key, path]) => [key, `https://synthetic_user:SYNTHETIC_PASSWORD@example.invalid/${path}?token=SYNTHETIC_TOKEN#SYNTHETIC_FRAGMENT`]));
  const inert = { callback: { url: "https://example.invalid/NEVER_RENDER_CALLBACK" },
    value: { private_action_data: "NEVER_RENDER_VALUE" } };
  const originals = [row("multi_standard", { elements: [button("Synthetic platform button", { multi_url: multi, ...inert })] }),
    row("multi_property", { body: { elements: [{ type: "button", property: {
      text: plain("Synthetic property platform button"), multi_url: multi, ...inert,
    } }] } })];
  verifyReadOnlyProjection(t, originals, (json, text) => {
    for (const displayed of json) {
      assert.equal(displayed.display.card.status, "rendered");
      for (const path of ["default", "desktop", "ios", "android"]) {
        assert.ok(displayed.display.card.text.includes(`https://example.invalid/${path}`), path);
      }
      assert.match(displayed.display.card.text, /PC|pc|桌面|电脑/);
      assert.match(displayed.display.card.text, /iOS|ios/);
      assert.match(displayed.display.card.text, /Android|android|安卓/);
    }
    assert.doesNotMatch(text, /SYNTHETIC_PASSWORD|SYNTHETIC_TOKEN|SYNTHETIC_FRAGMENT|synthetic_user|NEVER_RENDER_CALLBACK|NEVER_RENDER_VALUE/);
    assert.ok(JSON.stringify(json).includes("SYNTHETIC_PASSWORD"), "raw evidence remains complete in JSON");
    assert.ok(JSON.stringify(json).includes("NEVER_RENDER_VALUE"));
  });
});

test("unsupported subtitle, extra and multi_url shapes cannot silently claim a complete card", (t) => {
  const originals = [
    row("unsupported_subtitle", { header: { title: plain("Visible unsupported subtitle title"),
      subtitle: { tag: "synthetic_future_text", private_value: "NEVER_RENDER_SUBTITLE_RAW" } }, elements: [] }),
    row("unsupported_extra", { elements: [{ tag: "div", text: plain("Visible unsupported extra body"),
      extra: { tag: "synthetic_future_widget", private_value: "NEVER_RENDER_EXTRA_RAW" } }] }),
    row("unsupported_multi", { elements: [button("Visible unsupported platform button", {
      multi_url: { synthetic_console_url: "https://example.invalid/NEVER_RENDER_UNSUPPORTED_PLATFORM" },
    })] }),
    row("invalid_multi_value", { elements: [button("Visible malformed platform button", { multi_url: { pc_url: { hidden: "NEVER_RENDER_OBJECT_URL" } } })] }),
  ];
  verifyReadOnlyProjection(t, originals, (json, text) => {
    for (const displayed of json) {
      assert.equal(displayed.display.card.status, displayed.display.card.omitted_actions ? "structured_fallback" : "partial", displayed.external_id);
      assert.equal(displayed.display.card.reason, "unsupported_card_structure");
      assert.match(displayed.display.card.text, /卡片.*未展开/);
    }
    for (const visible of ["Visible unsupported subtitle title", "Visible unsupported extra body"]) assert.ok(text.includes(visible));
    assert.doesNotMatch(text, /Visible unsupported platform button|Visible malformed platform button/);
    assert.doesNotMatch(text, /NEVER_RENDER_|synthetic_future_|synthetic_console_url|"hidden"/);
  });
});

for (const [name, url, safeOrigin] of [
  ["bracket_query", "https://example.invalid/a?token=A]SYNTHETIC_SECRET", "https://example.invalid/a"],
  ["ipv6_bracket_query", "https://[2001:db8::1]/a?token=A]SYNTHETIC_SECRET#TAIL", "https://[2001:db8::1]/a"],
]) {
  test(`bare ${name} links cannot leak a query suffix after a closing bracket`, (t) => {
    const original = row(name, { elements: [{ tag: "div", text: { tag: "lark_md", content: `Synthetic link ${url}\nSynthetic next line` } }] });
    verifyReadOnlyProjection(t, [original], (json, text) => {
      const rendered = json[0].display.card;
      assert.equal(rendered.status, "rendered", "valid IPv6 and bracket-bearing query URLs remain supported");
      assert.ok(rendered.text.includes(safeOrigin));
      assert.doesNotMatch(rendered.text, /SYNTHETIC_SECRET|TAIL|token=A/);
      assert.doesNotMatch(text, /SYNTHETIC_SECRET|TAIL|token=A/);
      assert.match(text, /Synthetic next line/);
      assert.ok(json[0].raw.body.content.includes("SYNTHETIC_SECRET"));
    });
  });
}
