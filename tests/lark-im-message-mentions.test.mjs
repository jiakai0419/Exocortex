import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as store from "../dist/storage/sqlite/ingestion-store.js";
import { normalizeApiMessage, renderApiMessageContent } from "../src/adapters/lark-im/raw-message.mjs";
import { recordFromMessage } from "../src/adapters/lark-im/message-record.mjs";
import { loadMessages } from "../src/diagnostics/messages-report.mjs";

// Every message, identity, URL and database below is invented from scratch.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const START = 1900000000000;
const KEY = "@_user_1";
const amber = { key: KEY, id: { open_id: "ou_synthetic_amber" }, name: "Synthetic Amber" };
const birch = { key: KEY, id: { open_id: "ou_synthetic_birch" }, name: "Synthetic Birch" };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const orders = (rows) => [rows, [...rows].reverse()];

function native(type, payload, mentions = []) {
  return { message_id: "om_synthetic_mentions", msg_type: type, chat_id: "oc_synthetic_mentions",
    create_time: String(START), update_time: String(START + 100),
    sender: { id: "ou_synthetic_author", id_type: "open_id", sender_type: "user", name: "Synthetic Author" },
    mentions, body: { content: JSON.stringify(payload) } };
}

function projected(type, mentions, text = `Owner: ${KEY}`) {
  return renderApiMessageContent(native(type, type === "text" ? { text }
    : { content: [[{ tag: "text", text }]] }, mentions));
}

function post(elements, mentions = [], title = "") {
  return renderApiMessageContent(native("post", { title, content: [elements] }, mentions));
}

function unresolved(rendered, text) {
  if (text !== undefined) assert.equal(rendered.text, text);
  assert.equal(rendered.status, "partial");
  assert.equal(rendered.reason, "unresolved_message_mention");
  assert.equal(rendered.version, 1);
}

for (const type of ["text", "post"]) {
  test(`${type}: duplicate keys cannot choose identities or names by array order`, () => {
    for (const rows of [
      [amber, birch],
      [amber, { ...birch, name: amber.name }],
      [amber, { ...amber, name: "Synthetic Different Name" }],
      [amber, { key: KEY, id: { user_id: "ou_synthetic_amber" }, name: amber.name }],
      [amber, { key: KEY, id: { union_id: "on_synthetic_disjoint" }, name: amber.name }],
      [amber, { ...amber, open_id: birch.id.open_id }],
    ]) for (const mentions of orders(rows)) unresolved(projected(type, mentions), `Owner: ${KEY}`);
  });

  test(`${type}: duplicate missing names and malformed identity evidence remain unknown`, () => {
    for (const row of [
      { ...amber, name: "" }, { ...amber, name: "  " }, { ...amber, name: null },
      { ...birch, name: "" }, { key: KEY, name: "" },
      { ...amber, id: { open_id: { invalid: true } } },
      { ...amber, id: "ou_synthetic_amber", id_type: "invented_namespace" },
    ]) for (const mentions of orders([amber, row])) unresolved(projected(type, mentions), `Owner: ${KEY}`);
  });

  test(`${type}: unique, repeated, key-only and compatible additional aliases still resolve`, () => {
    for (const rows of [
      [amber], [amber, structuredClone(amber)],
      [{ key: KEY, name: amber.name }],
      [{ key: KEY, name: amber.name }, { key: KEY, name: amber.name }],
      [amber, { ...amber, id: { ...amber.id, user_id: "synthetic_user_amber" } }],
      [amber, { ...amber, key: "@_user_2", id: { ...amber.id, union_id: "synthetic_union_amber" } },
        { ...amber, id: { union_id: "synthetic_union_amber" } }],
    ]) for (const mentions of orders(rows)) {
      assert.deepEqual(projected(type, mentions), {
        text: `Owner: @${amber.name}`, status: "rendered", reason: null, version: 1,
      });
    }
  });

  test(`${type}: complete tokens use only message keys and replacements are terminal literals`, () => {
    unresolved(projected(type, [{ id: { open_id: KEY }, name: "Synthetic Wrong Namespace" }]), `Owner: ${KEY}`);
    unresolved(projected(type, [{ id: KEY, name: "Synthetic Literal ID" }]), `Owner: ${KEY}`);
    unresolved(projected(type, [amber], `${KEY} @_user_10 @_user_1_suffix`),
      `@${amber.name} @_user_10 @_user_1_suffix`);
    const rendered = projected(type, [{ ...amber, name: "Synthetic @_user_2 Amber" },
      { key: "@_user_2", name: "Synthetic Birch" }]);
    assert.equal(rendered.text, "Owner: @Synthetic @_user_2 Amber");
    assert.equal(rendered.status, "rendered");
    assert.equal(projected(type, [], "ordinary {text}").status, "rendered");
    assert.equal(projected(type, [], "").text, "");
  });

  test(`${type}: identity aliases added by later evidence cannot become display names`, () => {
    const name = "synthetic_alias_echo";
    const rows = [{ ...amber, name }, { ...amber, key: "@_user_2", name,
      id: { ...amber.id, user_id: name } }];
    for (const mentions of orders(rows)) unresolved(projected(type, mentions), `Owner: ${KEY}`);
    const compatible = [{ ...amber, key: "@_user_2", id: { ...amber.id, user_id: name } }, amber];
    assert.equal(projected(type, compatible).text, `Owner: @${amber.name}`);
  });
}

test("post: original title, text and link-label slots resolve once; generated names and href stay literal", () => {
  const mentions = [{ ...amber, name: "Synthetic @_user_2 Amber" }, { key: "@_user_2", name: "Synthetic Birch" }];
  const href = "https://example.invalid/@_user_2?q=@_user_9";
  const rendered = post([
    { tag: "at", user_id: amber.id.open_id }, { tag: "text", text: ` / ${KEY}` },
    { tag: "a", text: ` link ${KEY}`, href }, { tag: "a", href },
    { tag: "at", user_id: "synthetic_explicit", user_name: "Explicit @_user_2" },
  ], mentions, `Title ${KEY}`);
  assert.deepEqual(rendered, { text: "Title @Synthetic @_user_2 Amber\n"
    + "@Synthetic @_user_2 Amber / @Synthetic @_user_2 Amber link @Synthetic @_user_2 Amber"
    + ` (${href})${href}@Explicit @_user_2`, status: "rendered", reason: null, version: 1 });
  assert.equal(post([{ tag: "a", href }]).status, "rendered", "literal target tokens are not unresolved mentions");
  assert.equal(post([{ tag: "a", text: KEY, href }]).reason, "unresolved_message_mention");
  unresolved(post([{ tag: "text", text: "@_us" }, { tag: "text", text: "er_1" },
    { tag: "text", text: " @_user_9" }], [amber]), "@_user_1 @_user_9");
  assert.equal(post([{ tag: "text", text: "@_us" }, { tag: "text", text: "er_1" }], [amber]).status,
    "rendered", "joining original slots must not manufacture a mention token");
  assert.equal(post([{ tag: "at", user_id: "synthetic_explicit", user_name: "Synthetic Explicit", text: "@_user_99" }]).status,
    "rendered", "unused source slots must not manufacture unresolved mentions");
});

test("a long conflicting alias chain stays partial without recursive stack growth", () => {
  const mentions = Array.from({ length: 20_000 }, (_, index) => ({
    key: `@_user_${index}`, id: { open_id: `synthetic_chain_${index}`, user_id: "synthetic_shared_alias" },
    name: "Synthetic Same Name",
  }));
  unresolved(projected("text", mentions, "Owner: @_user_0"), "Owner: @_user_0");
});

test("repeated valid evidence and tokens stay usable with a bounded subprocess; bindings never cross messages", () => {
  // A generous whole-process deadline catches multiplicative evidence scans,
  // without asserting a machine-specific microbenchmark or exposing helpers.
  const script = `
    import assert from "node:assert/strict";
    import { renderApiMessageContent } from ${JSON.stringify(new URL("../src/adapters/lark-im/raw-message.mjs", import.meta.url).href)};
    const count = 60_000;
    const key = "@_user_1";
    const text = Array(count).fill(key).join(" ");
    const expected = Array(count).fill("@Synthetic Repeated").join(" ");
    const mentions = Array.from({ length: count }, () => ({ key,
      id: { open_id: "ou_synthetic_repeated" }, name: "Synthetic Repeated" }));
    for (const msg_type of ["text", "post"]) {
      const payload = msg_type === "text" ? { text } : { content: [[{ tag: "text", text }]] };
      const result = renderApiMessageContent({ msg_type, mentions, body: { content: JSON.stringify(payload) } });
      assert.equal(result.text, expected);
      assert.equal(result.status, "rendered");
      assert.equal(result.reason, null);
    }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: ROOT, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
  for (const mentions of orders([amber, birch])) {
    assert.equal(projected("text", [amber]).text, `Owner: @${amber.name}`);
    unresolved(projected("text", mentions), `Owner: ${KEY}`);
    unresolved(projected("text", []), `Owner: ${KEY}`);
  }
});

test("post: explicit names cannot erase confirmed conflicts, while standalone source names remain readable", () => {
  for (const mentions of orders([amber, birch])) {
    unresolved(post([{ tag: "at", user_id: KEY, user_name: "Synthetic Override" }], mentions), KEY);
  }
  for (const mentions of orders([amber, { ...amber, name: "Synthetic Other Name" }])) {
    unresolved(post([{ tag: "at", user_id: amber.id.open_id, user_name: "Synthetic Override" }], mentions),
      `@${amber.id.open_id}`);
  }
  assert.equal(post([{ tag: "at", user_id: "synthetic_explicit", user_name: "Synthetic Standalone" }]).text,
    "@Synthetic Standalone");
  unresolved(post([{ tag: "at", user_id: "synthetic_explicit", user_name: "synthetic_explicit" }]),
    "@synthetic_explicit");
  const alias = "synthetic_user_alias";
  assert.equal(post([{ tag: "at", user_id: amber.id.open_id, user_name: alias }],
    [{ ...amber, id: { ...amber.id, user_id: alias } }]).text, `@${amber.name}`,
  "an echoed explicit label may fall back to an independently known name");
  unresolved(post([{ tag: "at", user_id: "synthetic_unknown" }]), "@synthetic_unknown");
  unresolved(post([{ tag: "at" }]), "@未知用户");
});

test("post: explicitly bridged native aliases resolve once per confirmed identity root", () => {
  const id = "synthetic_bridged_actor";
  const name = "Synthetic Bridged Name";
  for (const rows of [
    [{ key: KEY, id, open_id: id, name }],
    [{ id: { open_id: id, user_id: id }, name }],
    [{ id, id_type: "open_id", user_id: id, name }],
    [{ id, union_id: "synthetic_explicit_bridge", name },
      { id: { open_id: id, union_id: "synthetic_explicit_bridge" }, name }],
  ]) for (const mentions of orders(rows)) {
    assert.deepEqual(post([{ tag: "at", user_id: id }], mentions),
      { text: `@${name}`, status: "rendered", reason: null, version: 1 });
    assert.equal(post([{ tag: "at", user_id: id, id_type: "open_id" }], mentions).text, `@${name}`);
  }
  const keyedBridge = [{ key: KEY, id: { open_id: KEY }, name }];
  assert.equal(post([{ tag: "at", user_id: KEY }], keyedBridge).text, `@${name}`);
  assert.equal(projected("text", keyedBridge).text, `Owner: @${name}`);
  for (const mentions of [[{ id, open_id: id }], [{ id: { open_id: id, user_id: id } }]]) {
    assert.deepEqual(post([{ tag: "at", user_id: id, user_name: name }], mentions),
      { text: `@${name}`, status: "rendered", reason: null, version: 1 });
    unresolved(post([{ tag: "at", user_id: id }], mentions), `@${id}`);
  }
});

test("post: root deduplication retains independent identities and negative key evidence", () => {
  const id = "synthetic_distinct_actor";
  const name = "Synthetic Shared Spelling";
  for (const rows of [
    [{ id, name }, { id: { open_id: id }, name }],
    [{ id: { open_id: id }, name }, { id: { user_id: id }, name }],
    [{ id }, { id: { open_id: id } }],
    [{ id, open_id: id, name }, { id: { open_id: id }, name: "Synthetic Conflicting Name" }],
    [{ id, open_id: id, name }, { id, open_id: "synthetic_other_actor", name }],
    [{ key: KEY, id: { open_id: KEY }, name }, { key: KEY, id: { open_id: KEY }, name: "" }],
    [{ key: KEY, id: { open_id: KEY }, name }, { key: KEY, id: { user_id: "synthetic_disjoint" }, name }],
    [{ key: KEY, id: { open_id: KEY }, name }, { key: KEY, id: { open_id: [] }, name }],
    [{ key: KEY, id: { open_id: KEY }, name: "" }],
  ]) for (const mentions of orders(rows)) {
    const reference = mentions.some((entry) => entry.key === KEY) ? KEY : id;
    for (const user_name of [undefined, "Synthetic Explicit Override"]) {
      unresolved(post([{ tag: "at", user_id: reference, user_name }], mentions),
        reference.startsWith("@") ? reference : `@${reference}`);
    }
  }
});

test("post: native aliases keep independent namespaces separate, with no prefix-based inference", () => {
  const literal = "ou_synthetic_same_bytes";
  const mentions = [
    { id: { open_id: literal }, name: "Synthetic Open" },
    { id: { user_id: literal }, name: "Synthetic User" },
  ];
  for (const rows of orders(mentions)) {
    unresolved(post([{ tag: "at", user_id: literal }], rows), `@${literal}`);
    unresolved(post([{ tag: "at", user_id: literal, user_name: "Synthetic Override" }], rows), `@${literal}`);
    for (const [id_type, name] of [["open_id", "Synthetic Open"], ["user_id", "Synthetic User"]]) {
      const rendered = post([{ tag: "at", user_id: literal, id_type }], rows);
      assert.equal(rendered.text, `@${name}`);
      assert.equal(rendered.status, "rendered");
    }
  }
  unresolved(post([{ tag: "at", user_id: KEY, id_type: "open_id" }], [amber]), KEY);
  assert.equal(post([{ tag: "at", user_id: literal }], [{ id: literal, name: "Synthetic Legacy" }]).text,
    "@Synthetic Legacy");
  assert.equal(post([{ tag: "at", user_id: KEY }], [{ key: KEY, name: "Synthetic Key Only" }]).text,
    "@Synthetic Key Only");
});

test("post: all-users, ordinary formatting and structural-diagnostic precedence remain compatible", () => {
  assert.deepEqual(post([{ tag: "at", user_id: "all" }, { tag: "text", text: " / " },
    { tag: "at", user_id: "@_all" }, { tag: "md", text: " markdown" },
    { tag: "emotion", emoji_type: "SMILE" }, { tag: "hr" }, { tag: "code_block", text: "literal" }]),
  { text: "@所有人 / @所有人 markdown:SMILE:\n---\n\nliteral\n", status: "rendered", reason: null, version: 1 });
  const raw = native("post", { content: [[{ tag: "text", text: KEY }, { tag: "image", image_key: "img_synthetic" }]] });
  const rendered = renderApiMessageContent(raw);
  assert.equal(rendered.status, "partial");
  assert.equal(rendered.reason, "unsupported_post_element");
  assert.ok(rendered.text.startsWith(`${KEY}\n`));
  assert.ok(rendered.text.endsWith(raw.body.content));
});

test("new projections reach SQLite and messages JSON/text; reads preserve raw, hash, version and historical body", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "exocortex-synthetic-mentions-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, "synthetic.sqlite");
  const marker = join(directory, "unexpected-network");
  const cli = join(directory, "reject-network-cli");
  writeFileSync(cli, '#!/bin/sh\nprintf called > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
  store.ensureInitialized(db);
  const payloads = [
    native("text", { text: `Owner: ${KEY}` }, [amber, birch]),
    native("post", { title: "Synthetic literal test", content: [[{ tag: "at", user_id: amber.id.open_id },
      { tag: "a", text: ` Link ${KEY}`, href: "https://example.invalid/@_user_2" }]] },
    [{ ...amber, name: "Synthetic @_user_2 Amber" }, { key: "@_user_2", name: "Synthetic Birch" }]),
    native("post", { content: [[{ tag: "text", text: KEY }]] }, [amber, birch]),
    native("post", { content: [[{ tag: "at", user_id: "synthetic_stored_bridge" }]] },
      [{ key: KEY, id: "synthetic_stored_bridge", open_id: "synthetic_stored_bridge", name: "Synthetic Stored Bridge" }]),
  ].map((value, index) => ({ ...value, message_id: `om_synthetic_mentions_${index}`, create_time: String(START + index) }));
  const before = JSON.stringify(payloads);
  const rows = payloads.map((value) => recordFromMessage(normalizeApiMessage(value), "lark.im.sent_by_me", "sent"));
  assert.equal(rows[3].body, "@Synthetic Stored Bridge");
  assert.equal(JSON.parse(rows[3].canonical_json).content_rendering.status, "rendered");
  rows[2].body = "HISTORICAL_STORED_POST_BODY";
  const historical = JSON.parse(rows[2].canonical_json);
  historical.content_rendering = { version: 1, status: "rendered", reason: null };
  rows[2].canonical_json = JSON.stringify(historical);
  const scope = store.readScope(db, "lark.im.sent_by_me");
  const run = store.createRun(db, scope);
  store.succeedRecordRun(db, scope, run, rows, rows.length, { synthetic: "cursor" }, {});
  const state = () => JSON.stringify({ rows: store.sqliteQuery(db, "SELECT * FROM records ORDER BY id"),
    scopes: store.sqliteQuery(db, "SELECT * FROM sync_scopes ORDER BY id") });
  const snapshot = state();
  const loaded = loadMessages(db, { db, direction: "all", limit: 10, search: "" });
  const env = { ...process.env, NO_COLOR: "1", LARK_CLI: cli, SYNTHETIC_NETWORK_MARKER: marker };
  delete env.FORCE_COLOR;
  function messages(format, extra = []) {
    const output = spawnSync(process.execPath, [join(ROOT, "bin/exocortex.mjs"), "messages", "--db", db,
      "--format", format, "--limit", "10", ...extra], { cwd: ROOT, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stderr, "");
    return format === "json" ? JSON.parse(output.stdout) : output.stdout;
  }
  const json = messages("json");
  for (const displayed of [loaded, json]) for (const row of rows) {
    const value = displayed.find((item) => item.external_id === row.external_id);
    assert.equal(value.display.body, row.body);
    assert.equal(value.raw_json, row.raw_json);
    assert.equal(value.canonical_json, row.canonical_json);
    assert.equal(row.content_hash, hash(row.raw_json));
    assert.equal(value.raw.update_time, JSON.parse(row.raw_json).update_time);
  }
  for (const saved of store.sqliteQuery(db, "SELECT external_id, external_version, content_hash FROM records")) {
    const row = rows.find((value) => value.external_id === saved.external_id);
    assert.equal(saved.external_version, row.external_version);
    assert.equal(saved.content_hash, row.content_hash);
  }
  assert.equal(loaded.find((value) => value.external_id === rows[0].external_id).canonical.content_rendering.reason,
    "unresolved_message_mention");
  const text = messages("text");
  assert.match(text, /Owner: @_user_1/);
  assert.match(text, /@Synthetic @_user_2 Amber/);
  assert.match(text, /https:\/\/example.invalid\/@_user_2/);
  assert.match(text, /HISTORICAL_STORED_POST_BODY/);
  assert.equal(messages("json", ["--search", "HISTORICAL_STORED_POST_BODY"]).length, 1);
  assert.equal(state(), snapshot, "reads do not write back projections or alter the cursor");
  assert.equal(JSON.stringify(payloads), before);
  assert.equal(existsSync(marker), false);
});
