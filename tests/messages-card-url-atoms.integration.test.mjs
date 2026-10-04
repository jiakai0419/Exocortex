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
const START = Date.parse("2026-01-01T02:03:00Z");
const SCOPE = "lark.im.received.chat.synthetic_card_url_atoms";
const ACTOR = "ou_synthetic_card_sender";

function row(name, payload, overrides = {}) {
  const raw = {
    message_id: `om_synthetic_card_${name}`, msg_type: "interactive",
    chat_id: "oc_synthetic_card_url_atoms", create_time: String(START),
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
  const directory = mkdtempSync(join(tmpdir(), "exocortex-card-url-atoms-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "invented.sqlite");
  const networkMarker = join(directory, "unexpected-network-cli");
  const noNetworkCli = join(directory, "reject-network-cli");
  writeFileSync(noNetworkCli, "#!/bin/sh\nprintf called > \"$SYNTHETIC_NETWORK_MARKER\"\nexit 97\n", { mode: 0o700 });
  ensureInitialized(dbPath);
  sqliteExec(dbPath, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(
    ${quoteSql(SCOPE)},'lark.im','synthetic card reader',${quoteSql(JSON.stringify({ chat_id: "oc_synthetic_card_url_atoms", chat_type: "group" }))});
    ${rows.map((entry, index) => `INSERT INTO records(source_id,first_seen_scope_id,external_id,external_version,record_type,
      occurred_at,occurred_at_ms,actor_id,container_id,direction,body,content_hash,canonical_json,raw_json)
      VALUES('lark.im',${quoteSql(SCOPE)},${quoteSql(entry.raw.message_id || `om_synthetic_card_${entry.name}`)},'1','lark.im.message',
        ${quoteSql(new Date(START + index * 1000).toISOString())},${START + index * 1000},${quoteSql(ACTOR)},'oc_synthetic_card_url_atoms',
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
    });
    assert.deepEqual(normalized.raw_api, original.raw);
  }
  verify(json, text);
  assert.deepEqual(snapshot(fixture), before, "card reading must preserve database bytes, schema, rows and permissions");
}


const CASES = [
  {
    name: "ipv6_then_markdown",
    input: "Before https://[::1]/a?token=SYNTHETIC_QUERY [open](https://example.invalid/public) After",
    visible: ["Before", "https://[::1]/a", "open", "https://example.invalid/public", "After"],
    forbidden: /SYNTHETIC_QUERY|token=/,
  },
  {
    name: "query_bracket_then_markdown",
    input: "Before https://example.invalid/a?token=A[SYNTHETIC_QUERY [open](https://example.invalid/public) After",
    visible: ["Before", "https://example.invalid/a", "open", "https://example.invalid/public", "After"],
    forbidden: /SYNTHETIC_QUERY|token=/,
  },
  {
    name: "markdown_inside_url_query",
    input: "Prefix https://example.invalid/a?token=A[inner](https://hidden.invalid/SYNTHETIC_INNER_PATH?x=SYNTHETIC_QUERY)#SYNTHETIC_FRAGMENT [open](https://example.invalid/public) Suffix",
    visible: ["Prefix", "https://example.invalid/a", "open", "https://example.invalid/public", "Suffix"],
    forbidden: /SYNTHETIC_INNER_PATH|SYNTHETIC_QUERY|SYNTHETIC_FRAGMENT|hidden\.invalid|\binner\b|token=/,
  },
  {
    name: "multiple_links_and_lines",
    input: "Start https://example.invalid/one?token=SYNTHETIC_ONE Middle [two](https://example.invalid/two?token=SYNTHETIC_TWO)\nThird https://[2001:db8::2]/three?token=SYNTHETIC_THREE End",
    visible: ["Start", "https://example.invalid/one", "Middle", "two", "https://example.invalid/two", "Third", "https://[2001:db8::2]/three", "End"],
    forbidden: /SYNTHETIC_ONE|SYNTHETIC_TWO|SYNTHETIC_THREE|token=/,
    multiline: true,
  },
  {
    name: "url_inside_markdown_label",
    input: "Before [label https://[::1]/label?token=SYNTHETIC_LABEL](https://example.invalid/destination?token=SYNTHETIC_DESTINATION) After",
    visible: ["Before", "label", "After"],
    forbidden: /SYNTHETIC_LABEL|SYNTHETIC_DESTINATION|token=/,
    mayBePartial: true,
  },
  {
    name: "nested_and_escaped_markdown",
    input: "Before [outer [inner](https://example.invalid/inner?token=SYNTHETIC_INNER)](https://example.invalid/outer?token=SYNTHETIC_OUTER) Middle [escaped](https://example.invalid/path\\(part\\)?token=SYNTHETIC_ESCAPED) After",
    visible: ["Before", "outer", "inner", "Middle", "escaped", "After"],
    forbidden: /SYNTHETIC_INNER|SYNTHETIC_OUTER|SYNTHETIC_ESCAPED|token=/,
    mayBePartial: true,
  },
];

for (const scenario of CASES) {
  test(`URL atoms: ${scenario.name} keeps surrounding text and cannot expose query fragments`, (t) => {
    const original = row(scenario.name, { elements: [{ tag: "div", text: { tag: "lark_md", content: scenario.input } }] });
    verifyReadOnlyProjection(t, [original], (json, text) => {
      const projection = json[0].display.card;
      assert.ok((scenario.mayBePartial ? ["rendered", "partial"] : ["rendered"]).includes(projection.status), projection.status);
      assert.doesNotMatch(projection.text, scenario.forbidden);
      assert.doesNotMatch(text, scenario.forbidden);
      for (const visible of scenario.visible) {
        assert.ok(projection.text.includes(visible), `${scenario.name}: projection lost ${visible}`);
        assert.ok(text.includes(visible), `${scenario.name}: CLI lost ${visible}`);
      }
      assert.doesNotMatch(text, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
      assert.equal(JSON.parse(json[0].raw.body.content).elements[0].text.content, scenario.input);
      if (scenario.multiline) {
        assert.ok(projection.text.includes("\n"));
        assert.ok(text.slice(text.indexOf("Middle"), text.indexOf("Third")).includes("\n"));
      }
    });
  });
}
