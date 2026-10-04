import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureInitialized, readScope, createRun, succeedRecordRun, sqliteQuery }
  from "../dist/storage/sqlite/ingestion-store.js";
import { normalizeApiMessage, renderApiMessageContent } from "../src/adapters/lark-im/raw-message.mjs";
import { renderCardContent } from "../src/adapters/lark-im/card-content.mjs";
import { recordFromMessage } from "../src/adapters/lark-im/message-record.mjs";
import { enrichRow } from "../src/diagnostics/messages-report.mjs";

// Composed from schema field names alone; no captured or transformed messages.
const instant = Date.UTC(2047, 7, 13, 9, 12, 0);
function native() {
  const card = {
    header: { title: { tag: "plain_text", content: "Paper observatory" } },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: "Fold the violet roof." } },
      { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "Read plan" },
        url: "https://example.invalid/paper-plan?access=synthetic-only" }] },
    ],
  };
  return { message_id: "om_fixture_paper_plan", msg_type: "interactive",
    create_time: String(instant), update_time: String(instant + 300),
    sender: { id: "ou_fixture_paper_author", sender_type: "user" },
    chat_id: "oc_fixture_paper_workshop", mentions: [],
    body: { content: JSON.stringify({ json_card: JSON.stringify(card) }) },
    future_evidence: { preserved: ["uninterpreted", 7] } };
}
function record(item) { return recordFromMessage(item, "lark.im.sent_by_me", "sent"); }

test("native cards and old-record views share projection without changing raw evidence or source hash", () => {
  const item = native();
  const before = JSON.stringify(item);
  const normalized = normalizeApiMessage(item);
  const rendered = renderCardContent(item.body.content, item.mentions);
  assert.deepEqual(renderApiMessageContent(item), rendered);
  assert.equal(normalized.content, rendered.text);
  assert.equal(normalized.content_rendering.version, 3);
  const stored = record(normalized);
  assert.equal(stored.raw_json, before);
  assert.equal(stored.content_hash, createHash("sha256").update(before).digest("hex"));
  assert.equal(stored.external_version, item.update_time);
  assert.deepEqual(enrichRow(stored).display.card, rendered);
  assert.equal(JSON.stringify(item), before);
  assert.equal(JSON.parse(stored.raw_json).body.content, item.body.content);
  assert.match(stored.body, /Paper observatory/);
  assert.match(stored.body, /Read plan/);
  assert.doesNotMatch(stored.body, /synthetic-only/);
});

test("same-version native card projection can improve once while preserving facts and names", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-card-record-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "synthetic.sqlite");
  ensureInitialized(db);
  const item = native();
  const legacy = normalizeApiMessage(item);
  legacy.content = `[消息未完整渲染，以下为原始内容]\n${item.body.content}`;
  legacy.content_rendering = { status: "structured_fallback", reason: "unsupported_message_content", version: 1 };
  const first = record(legacy);
  first.canonical_json = JSON.stringify({ ...JSON.parse(first.canonical_json), sender_name: "Paper author",
    sender_name_source: "synthetic_direct", sender_name_confidence: "high" });
  const write = (candidate) => {
    const scope = readScope(db, "lark.im.sent_by_me");
    const run = createRun(db, scope, { fixture: true });
    return succeedRecordRun(db, scope, run, [candidate], 1,
      { kind: "test.cursor/v1", occurred_at_ms: instant }, {});
  };
  assert.equal(write(first).inserted, 1);
  const improved = record(normalizeApiMessage(item));
  assert.deepEqual(write(improved), { inserted: 0, updated: 1, duplicate: 0 });
  assert.deepEqual(write(improved), { inserted: 0, updated: 0, duplicate: 1 });
  const stored = sqliteQuery(db, "SELECT * FROM records;", "read synthetic card record")[0];
  for (const key of ["raw_json", "content_hash", "external_version"]) assert.equal(stored[key], first[key]);
  assert.equal(stored.body, improved.body);
  assert.equal(JSON.parse(stored.canonical_json).sender_name, "Paper author");
  assert.equal(JSON.parse(stored.canonical_json).content_rendering.version, 3);
});

test("read-only card projection never substitutes canonical or fallback text for missing raw evidence", () => {
  const stored = record(normalizeApiMessage(native()));
  const missing = { ...stored, body: "DO_NOT_PARSE_STORED_FALLBACK",
    raw_json: "{}", canonical_json: JSON.stringify({ msg_type: "interactive", content: { header: {
      title: { tag: "plain_text", content: "DO_NOT_PARSE_DERIVED_CANONICAL" } } } }) };
  const enriched = enrichRow(missing);
  assert.equal(enriched.display.body, missing.body);
  assert.equal(enriched.display.card.status, "structured_fallback");
  assert.doesNotMatch(enriched.display.card.text, /DO_NOT_PARSE/);
  assert.deepEqual(enrichRow({ ...missing, raw_json: JSON.stringify({ raw_api: native() }) }).display.card,
    renderCardContent(native().body.content));
});
