import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createRun, ensureInitialized, quoteSql, readScope, sqliteExec, sqliteQuery, succeedRecordRun }
  from "../dist/storage/sqlite/ingestion-store.js";
import { cursorAfter } from "../src/adapters/lark-im/core.mjs";
import { recordFromMessage } from "../src/adapters/lark-im/message-record.mjs";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";
import { enrichRow, loadMessages } from "../src/diagnostics/messages-report.mjs";

// Entirely invented cards, identities, timestamps, names and URLs. No captured
// messages, redacted production records, contact lookups or remote API calls.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTANT = Date.UTC(2043, 3, 19, 7, 26, 0);
const SCOPE = "lark.im.sent_by_me";
const plain = (content) => ({ tag: "plain_text", content });
const inlineText = (content) => ({ type: "text", property: { content } });
const at = (userID) => ({ type: "at", property: { userID } });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const ACTION_LABELS = ["Synthetic allow control", "Synthetic decline control"];

function controls() {
  return { tag: "action", actions: [
    { tag: "button", text: plain(ACTION_LABELS[0]), value: { operation: "SYNTHETIC_ALLOW_PAYLOAD", retained: [1, 4] } },
    { tag: "button", text: plain(ACTION_LABELS[1]), callback: { payload: "SYNTHETIC_DECLINE_PAYLOAD" } },
  ] };
}

function source(name, card, attachment, mentions = []) {
  return {
    message_id: `om_invented_attachment_${name}`, msg_type: "interactive",
    chat_id: "oc_invented_attachment_workshop", create_time: String(INSTANT), update_time: String(INSTANT + 817),
    sender: { id: "ou_invented_attachment_author", id_type: "open_id", sender_type: "user", name: "Invented Author" },
    mentions,
    body: { content: JSON.stringify({ json_card: JSON.stringify(card), json_attachment: attachment }) },
    uninterpreted_evidence: { fictional: true, preserve: ["outer", 9] },
  };
}

function readableSource(name, attachmentForm) {
  const card = {
    header: { title: plain("Invented kite registry") },
    body: { elements: [
      { type: "markdown", property: { elements: [
        inlineText("Recipient: "), at("native_ref_cedar"), { type: "br" },
        inlineText("Reviewer: "), at("internal_invented_lime"), { tag: "br" },
        inlineText("Label: "), inlineText("value stays inline"), { type: "br" },
        { type: "link", property: { text: "Synthetic reference", url: { url:
          "https://invented:SYNTHETIC_URL_PASSWORD@example.invalid/reference?token=SYNTHETIC_URL_QUERY#SYNTHETIC_URL_FRAGMENT" } } },
      ] } },
      { tag: "div", text: plain("Separate paragraph one") },
      { tag: "div", text: plain("Separate paragraph two") },
      { tag: "div", fields: [{ text: plain("Field A: amber") }, { text: plain("Field B: teal") }] },
      controls(),
      { tag: "button", text: plain("Synthetic navigation"), url: "https://example.invalid/manual?token=SYNTHETIC_NAV_TOKEN" },
      { tag: "note", elements: [plain("Semantic note survives the controls.")] },
    ] },
  };
  const attachment = { at_users: {
    // Dictionary/mention order deliberately differ. Attachment content is not
    // allowed to replace an exact native mention's name.
    native_ref_lime: { content: "UNTRUSTED_ATTACHMENT_LIME_NAME", mention_key: "@_user_3", user_id: "internal_invented_lime" },
    native_ref_cedar: { content: "UNTRUSTED_ATTACHMENT_CEDAR_NAME", mention_key: "@_user_8", user_id: "internal_invented_cedar" },
  }, future_attachment_field: { preserve: "SYNTHETIC_ATTACHMENT_EVIDENCE" } };
  const mentions = [
    { key: "@_user_8", name: "Invented Cedar", id: "ou_invented_cedar", id_type: "open_id" },
    { key: "@_user_3", name: "Invented Lime", id: "ou_invented_lime", id_type: "open_id" },
  ];
  return source(name, card, attachmentForm === "string" ? JSON.stringify(attachment) : attachment, mentions);
}

function assertReadableProjection(card) {
  assert.equal(card.version, 3);
  assert.equal(card.status, "rendered");
  assert.equal(card.reason, null);
  assert.equal(card.omitted_actions, 2);
  assert.match(card.text, /Recipient: @Invented Cedar\nReviewer: @Invented Lime\nLabel: value stays inline\nSynthetic reference/);
  assert.match(card.text, /Separate paragraph one\nSeparate paragraph two\nField A: amber\nField B: teal/);
  assert.match(card.text, /https:\/\/example\.invalid\/reference/);
  assert.match(card.text, /Synthetic navigation.*https:\/\/example\.invalid\/manual/);
  assert.match(card.text, /Semantic note survives the controls\./);
  assert.doesNotMatch(card.text, /UNTRUSTED_ATTACHMENT|SYNTHETIC_URL_|SYNTHETIC_NAV_TOKEN|token=|native_ref_|internal_invented_|@未知用户|部分内容未展开/);
  for (const label of ACTION_LABELS) assert.equal(card.text.includes(label), false);
  assert.doesNotMatch(card.text, /SYNTHETIC_ALLOW_PAYLOAD|SYNTHETIC_DECLINE_PAYLOAD/);
}

function legacyRecord(native, wrapRawApi = false) {
  const raw = wrapRawApi ? { raw_api: native, body: { content: "DERIVED_BODY_MUST_NOT_BE_PARSED" } } : native;
  return {
    source_id: "lark.im", first_seen_scope_id: SCOPE, external_id: native.message_id,
    external_version: String(native.update_time), record_type: "lark.im.message",
    occurred_at: new Date(INSTANT).toISOString(), occurred_at_ms: INSTANT,
    actor_id: native.sender.id, container_id: native.chat_id, direction: "sent", title: null,
    body: `LEGACY_STORED_BODY_${native.message_id}`,
    content_hash: sha256(JSON.stringify(raw)), raw_json: JSON.stringify(raw),
    canonical_json: JSON.stringify({ msg_type: "interactive", sender_id: native.sender.id,
      sender_name: "Stored invented author", sender_type: "user", chat_type: "group", chat_name: "Invented workshop",
      content: "LEGACY_CANONICAL_CONTENT", content_rendering: { version: 2, status: "partial", reason: "unresolved_card_mention" } }),
  };
}

function sqlRead(db, sql) {
  const result = spawnSync("sqlite3", ["-readonly", db, sql], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function database(t, records = []) {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-card-attachment-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "invented.sqlite");
  const networkMarker = join(dir, "unexpected-network-invocation");
  const noNetworkCli = join(dir, "reject-network-cli");
  writeFileSync(noNetworkCli, "#!/bin/sh\nprintf called > \"$SYNTHETIC_NETWORK_MARKER\"\nexit 97\n", { mode: 0o700 });
  ensureInitialized(db);
  for (const record of records) {
    const columns = Object.keys(record);
    sqliteExec(db, `INSERT INTO records(${columns.join(",")}) VALUES(${columns.map((key) =>
      record[key] === null ? "NULL" : typeof record[key] === "number" ? String(record[key]) : quoteSql(record[key])).join(",")});`);
  }
  const journal = spawnSync("sqlite3", [db, "PRAGMA journal_mode=DELETE;"], { encoding: "utf8" });
  assert.equal(journal.status, 0, journal.stderr);
  assert.equal(journal.stdout.trim(), "delete");
  return { dir, db, networkMarker, noNetworkCli };
}

function snapshot({ dir, db }) {
  return { bytes: sha256(readFileSync(db)), mode: statSync(db).mode & 0o777, modified: statSync(db).mtimeMs,
    schema: sqlRead(db, ".schema"), allRows: sha256(sqlRead(db, ".dump")), files: readdirSync(dir).sort() };
}

function messages(fixture, format) {
  const env = { ...process.env, NO_COLOR: "1", LARK_CLI: fixture.noNetworkCli, SYNTHETIC_NETWORK_MARKER: fixture.networkMarker };
  delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath, [join(ROOT, "scripts/messages.mjs"), "--db", fixture.db, "--format", format], {
    cwd: ROOT, encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024, env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(existsSync(fixture.networkMarker), false, "card reading must not invoke the remote CLI");
  return format === "json" ? JSON.parse(result.stdout) : result.stdout;
}

function assertUnchangedDisplay(displayed, record) {
  for (const key of ["body", "raw_json", "canonical_json"]) assert.equal(displayed[key], record[key], key);
  assert.deepEqual(displayed.raw, JSON.parse(record.raw_json));
  assert.deepEqual(displayed.canonical, JSON.parse(record.canonical_json));
  assert.equal(displayed.display.body, record.body);
}

for (const attachmentForm of ["object", "string"]) {
  test(`native ${attachmentForm} attachments normalize without changing source evidence, hash or version`, () => {
    const native = readableSource(`native_${attachmentForm}`, attachmentForm);
    const original = JSON.stringify(native);
    const normalized = normalizeApiMessage(native);
    const record = recordFromMessage(normalized, SCOPE, "sent");
    const displayed = enrichRow(record);
    assertReadableProjection(displayed.display.card);
    assert.equal(normalized.content, displayed.display.card.text);
    const { text: _text, ...rendering } = displayed.display.card;
    assert.deepEqual(normalized.content_rendering, rendering);
    assert.deepEqual(normalized.raw_api, native);
    assert.equal(record.raw_json, original);
    assert.equal(record.content_hash, sha256(original));
    assert.equal(record.external_version, native.update_time);
    assert.equal(JSON.stringify(native), original);
    assertUnchangedDisplay(displayed, record);
    const rawCard = JSON.parse(JSON.parse(record.raw_json).body.content);
    assert.deepEqual(JSON.parse(rawCard.json_card).body.elements[4], controls(), "folding controls cannot discard source actions");
  });
}

test("old attachment cards use the shared projection while JSON and every stored byte remain unchanged", (t) => {
  const records = [legacyRecord(readableSource("old_object", "object")),
    legacyRecord(readableSource("old_string", "string"), true)];
  const fixture = database(t, records);
  const before = snapshot(fixture);
  const loaded = loadMessages(fixture.db, { db: fixture.db, direction: "all", limit: 30, search: "" });
  const json = messages(fixture, "json");
  const text = messages(fixture, "text");
  for (const record of records) {
    for (const displayed of [enrichRow(record), loaded.find((row) => row.external_id === record.external_id),
      json.find((row) => row.external_id === record.external_id)]) {
      assertUnchangedDisplay(displayed, record);
      assertReadableProjection(displayed.display.card);
      const native = displayed.raw.raw_api ?? displayed.raw;
      const card = JSON.parse(JSON.parse(native.body.content).json_card);
      assert.deepEqual(card.body.elements[4], controls());
      assert.equal(displayed.canonical.content_rendering.version, 2, "reading does not rewrite historical rendering metadata");
    }
  }
  assert.match(text, /Recipient: @Invented Cedar\n\s+Reviewer: @Invented Lime\n\s+Label: value stays inline/);
  assert.match(text, /Semantic note survives the controls\./);
  assert.doesNotMatch(text, /LEGACY_STORED_BODY|DERIVED_BODY_MUST_NOT_BE_PARSED|SYNTHETIC_ALLOW_PAYLOAD|SYNTHETIC_DECLINE_PAYLOAD/);
  for (const label of ACTION_LABELS) assert.equal(text.includes(label), false);
  assert.deepEqual(snapshot(fixture), before);
});

test("attachment-only names, prefix keys and conflicting identities remain unknown without duplicate prose markers", (t) => {
  const card = (id) => ({ elements: [{ tag: "div", text: { type: "markdown", property: {
    elements: [inlineText("Assigned: "), at(id)],
  } } }, controls()] });
  const cases = [
    source("unmatched", card("native_ref_missing"), { at_users: { native_ref_missing: {
      content: "DO_NOT_GUESS_ATTACHMENT_NAME", mention_key: "@_user_80", user_id: "internal_missing" } } },
    [{ key: "@_user_8", name: "DO_NOT_GUESS_PREFIX_NAME", id: "ou_invented_prefix", id_type: "open_id" }]),
    ...[false, true].map((sameName) => source(`collision_${sameName}`, card("internal_shared"), { at_users: {
      ref_one: { mention_key: "@_user_2", user_id: "internal_shared", content: "DO_NOT_GUESS_FIRST" },
      ref_two: { mention_key: "@_user_5", user_id: "internal_shared", content: "DO_NOT_GUESS_SECOND" },
    } }, [
      { key: "@_user_2", name: "DO_NOT_GUESS_COLLISION_NAME", id: "ou_invented_identity_one", id_type: "open_id" },
      { key: "@_user_5", name: sameName ? "DO_NOT_GUESS_COLLISION_NAME" : "DO_NOT_GUESS_OTHER_NAME", id: "ou_invented_identity_two", id_type: "open_id" },
    ])),
  ];
  const records = cases.map((native) => legacyRecord(native));
  const fixture = database(t, records);
  const before = snapshot(fixture);
  const json = messages(fixture, "json");
  for (const record of records) {
    const displayed = json.find((row) => row.external_id === record.external_id);
    assertUnchangedDisplay(displayed, record);
    const projected = displayed.display.card;
    assert.equal(projected.version, 3);
    assert.equal(projected.status, "partial");
    assert.equal(projected.reason, "unresolved_card_mention");
    assert.equal(projected.omitted_actions, 2);
    assert.equal(projected.text, "Assigned: @未知用户");
    assert.doesNotMatch(projected.text, /DO_NOT_GUESS|卡片部分|未展开/);
    assert.equal(normalizeApiMessage(cases.find((native) => native.message_id === record.external_id)).content, projected.text);
  }
  assert.deepEqual(snapshot(fixture), before);
});

test("unknown body widgets and a declared missing body stay visibly incomplete beside controls or unresolved mentions", (t) => {
  const cases = [
    source("unknown_body", { header: { title: plain("Known invented heading") }, elements: [
      { tag: "div", text: plain("Known invented paragraph") }, at("missing_invented_person"),
      { tag: "invented_unhandled_chart", text: "DO_NOT_DUMP_UNKNOWN_BODY" }, controls(),
    ] }, {}, []),
    source("missing_body", { header: { title: plain("Known missing-body heading") },
      body: { unrecognized_elements: [{ text: "DO_NOT_DUMP_MISSING_BODY" }] } }, {}, []),
  ];
  const records = cases.map((native) => legacyRecord(native));
  const fixture = database(t, records);
  const before = snapshot(fixture);
  const json = messages(fixture, "json");
  for (const record of records) {
    const displayed = json.find((row) => row.external_id === record.external_id);
    assertUnchangedDisplay(displayed, record);
    assert.equal(displayed.display.card.status, "partial");
    assert.equal(displayed.display.card.reason, "unsupported_card_structure");
    assert.match(displayed.display.card.text, /部分内容未展开/);
    assert.doesNotMatch(displayed.display.card.text, /DO_NOT_DUMP|invented_unhandled_chart/);
  }
  assert.deepEqual(snapshot(fixture), before);
});

test("pure callback cards have a neutral folded display and their complete actions remain available in JSON", (t) => {
  const onlyControls = source("only_controls", { elements: [controls()] }, {}, []);
  const prose = source("ordinary_prose", { elements: [{ tag: "div", text: plain("同意/拒绝是本条合成正文中的普通词语。") }, controls()] }, {}, []);
  const records = [legacyRecord(onlyControls), legacyRecord(prose)];
  const fixture = database(t, records);
  const before = snapshot(fixture);
  const json = messages(fixture, "json");
  const folded = json.find((row) => row.external_id === onlyControls.message_id);
  assert.equal(folded.display.card.text, "[卡片仅含交互操作，文本视图已收起]");
  assert.equal(folded.display.card.status, "rendered");
  assert.equal(folded.display.card.reason, null);
  assert.equal(folded.display.card.omitted_actions, 2);
  assert.doesNotMatch(folded.display.card.text, /已同意|已拒绝|待处理|待审批/);
  assert.deepEqual(JSON.parse(JSON.parse(folded.raw.body.content).json_card).elements, [controls()]);
  assert.match(json.find((row) => row.external_id === prose.message_id).display.card.text, /同意\/拒绝是本条合成正文中的普通词语。/);
  for (const record of records) assertUnchangedDisplay(json.find((row) => row.external_id === record.external_id), record);
  assert.deepEqual(snapshot(fixture), before);
});

test("same-source-version attachment projection improves once without changing source hash, raw bytes or version", (t) => {
  const fixture = database(t);
  const native = readableSource("same_version", "string");
  const normalized = normalizeApiMessage(native);
  const current = recordFromMessage(normalized, SCOPE, "sent");
  const old = recordFromMessage({ ...normalized, content: "OLD_SYNTHETIC_ATTACHMENT_PROJECTION",
    content_rendering: { version: 2, status: "partial", reason: "unresolved_card_mention" } }, SCOPE, "sent");
  const write = (record) => {
    const scope = readScope(fixture.db, SCOPE);
    const runId = createRun(fixture.db, scope, { runner: "synthetic attachment projection" });
    return succeedRecordRun(fixture.db, scope, runId, [record], 1, cursorAfter(INSTANT + 60_000), {});
  };
  assert.deepEqual(write(old), { inserted: 1, updated: 0, duplicate: 0 });
  assert.deepEqual(write(current), { inserted: 0, updated: 1, duplicate: 0 });
  assert.deepEqual(write(current), { inserted: 0, updated: 0, duplicate: 1 });
  const stored = sqliteQuery(fixture.db, "SELECT * FROM records;", "read synthetic attachment record")[0];
  assert.equal(stored.raw_json, JSON.stringify(native));
  assert.equal(stored.content_hash, old.content_hash);
  assert.equal(stored.external_version, old.external_version);
  assert.equal(stored.body, normalized.content);
  assert.equal(JSON.parse(stored.canonical_json).content_rendering.version, 3);
  assertReadableProjection(enrichRow(stored).display.card);
});
