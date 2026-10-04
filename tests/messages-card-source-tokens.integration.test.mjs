import assert from "node:assert/strict";
import test from "node:test";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";
import { createLegacyCardFixture, snapshot, messages, assertOriginalContract }
  from "./helpers/card-projection-fixture.mjs";
import { createRun, readScope, succeedRecordRun } from "../dist/storage/sqlite/ingestion-store.js";

// Freshly invented records represent persisted legacy projections.
const START = Date.parse("2025-12-31T01:02:00Z");
const SCOPE = "lark.im.received.chat.synthetic_card_source_tokens";
const { row, database } = createLegacyCardFixture({ start: START, scope: SCOPE,
  chatId: "oc_synthetic_card_source_tokens", tempPrefix: "exocortex-card-source-tokens-" });


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
