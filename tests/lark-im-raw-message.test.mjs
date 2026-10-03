import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { normalizeApiMessage, renderApiMessageContent } from "../src/adapters/lark-im/raw-message.mjs";
import { recordFromMessage } from "../src/adapters/lark-im/message-record.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

function nativeMessage(type = "text", payload = { text: "Synthetic native text" }, overrides = {}) {
  return {
    message_id: "om_synthetic_root", msg_type: type,
    create_time: "1800000000000", update_time: "1800000001000",
    updated: false, deleted: false,
    sender: { id: "ou_synthetic_sender", id_type: "open_id", sender_type: "user", tenant_key: "synthetic_tenant" },
    chat_id: "oc_synthetic_chat", root_id: "om_synthetic_thread_root",
    parent_id: "om_synthetic_parent", thread_id: "omt_synthetic_thread",
    body: { content: JSON.stringify(payload), future_body_field: { retained: true } },
    mentions: [], unknown_future_field: { nested: ["preserve", 42, null] },
    ...overrides,
  };
}

function record(message) {
  return recordFromMessage(message, "synthetic.scope", "received");
}

test("native normalization preserves every raw field and source version without mutating input", () => {
  const original = nativeMessage();
  const snapshot = JSON.stringify(original);
  const normalized = normalizeApiMessage(original);
  assert.equal(normalized.content, "Synthetic native text");
  assert.equal(normalized.source_api, "im.v1.messages");
  assert.deepEqual(normalized.raw_api, original);
  for (const key of Object.keys(original)) assert.deepEqual(normalized[key], original[key], key);
  assert.equal(JSON.stringify(original), snapshot);
  normalized.sender.id = "ou_mutated_projection";
  normalized.body.future_body_field.retained = false;
  assert.equal(JSON.stringify(original), snapshot);
  assert.equal(normalized.raw_api.sender.id, "ou_synthetic_sender");
  assert.equal(normalized.raw_api.body.future_body_field.retained, true);
});

test("native records hash original raw evidence and keep root, parent, render metadata and millisecond version", () => {
  const original = nativeMessage();
  const snapshot = JSON.stringify(original);
  const normalized = normalizeApiMessage(original);
  const stored = record(normalized);
  const canonical = JSON.parse(stored.canonical_json);
  assert.equal(stored.raw_json, snapshot);
  assert.equal(stored.content_hash, hash(snapshot));
  assert.equal(stored.external_version, "1800000001000", "updated=false must not discard update_time");
  assert.equal(canonical.source_api, "im.v1.messages");
  assert.deepEqual(canonical.content_rendering, { version: 1, status: "rendered", reason: null });
  assert.equal(canonical.root_id, original.root_id);
  assert.equal(canonical.parent_id, original.parent_id);
  assert.equal(canonical.thread_id, original.thread_id);
  assert.equal(stored.actor_id, original.sender.id);
  normalized.content = "A changed derived projection";
  normalized.content_rendering.version = 2;
  assert.equal(record(normalized).content_hash, stored.content_hash);
  assert.equal(record(normalized).raw_json, snapshot);
});

test("legacy CLI raw serialization and hash semantics are unchanged", () => {
  const legacy = { message_id: "om_legacy", create_time: "1800000000000", msg_type: "text", content: "Legacy text" };
  const stored = record(legacy);
  assert.equal(stored.body, "Legacy text");
  assert.equal(stored.raw_json, JSON.stringify(legacy));
  assert.equal(stored.content_hash, hash(stored.raw_json));
  assert.equal(Object.hasOwn(JSON.parse(stored.canonical_json), "source_api"), false);
});

test("text resolves only exact in-message mention keys and retains empty and literal text", () => {
  const item = nativeMessage("text", { text: "Hello @_user_1 @_user_10 {name}" }, {
    mentions: [{ key: "@_user_1", id: { open_id: "ou_synthetic_mention" }, name: "Synthetic Mention" }],
  });
  assert.equal(normalizeApiMessage(item).content, "Hello @Synthetic Mention @_user_10 {name}");
  assert.equal(normalizeApiMessage(nativeMessage("text", { text: "" })).content, "");
  assert.deepEqual(normalizeApiMessage(item).raw_api.mentions, item.mentions);
});

test("post renders locale, paragraphs, links, mentions and content_v2 without API lookups", () => {
  const item = nativeMessage("post", { zh_cn: { title: "Synthetic title", content: [
    [{ tag: "text", text: "Hello " }, { tag: "at", user_id: "ou_synthetic_mention" }],
    [{ tag: "a", text: "Synthetic link", href: "https://example.invalid/path" }],
  ] } }, { mentions: [{ id: { open_id: "ou_synthetic_mention" }, name: "Synthetic Mention" }] });
  assert.equal(normalizeApiMessage(item).content,
    "Synthetic title\nHello @Synthetic Mention\nSynthetic link (https://example.invalid/path)");
  const v2 = nativeMessage("post", { content_v2: [[{ tag: "md", text: "Preferred v2" }]],
    content: [[{ tag: "text", text: "Old branch" }]] });
  assert.equal(normalizeApiMessage(v2).content, "Preferred v2");
  const oldFallback = nativeMessage("post", { content_v2: [], content: [[{ tag: "text", text: "Old branch" }]] });
  assert.equal(normalizeApiMessage(oldFallback).content, "Old branch");
});

test("unsupported post elements preserve the entire original structure with a partial-render marker", () => {
  const item = nativeMessage("post", { title: "Synthetic mixed post", content: [[
    { tag: "text", text: "Readable part" },
    { tag: "img", image_key: "img_synthetic", unknown_media_field: { keep: true } },
    { tag: "future_element", secret_structure: ["synthetic full structure"] },
  ]] });
  const rendered = renderApiMessageContent(item);
  assert.equal(rendered.status, "partial");
  assert.match(rendered.text, /Readable part/);
  assert.match(rendered.text, /未完整渲染/);
  assert.equal(rendered.text.endsWith(item.body.content), true);
  assert.deepEqual(JSON.parse(record(normalizeApiMessage(item)).raw_json), item);
});

test("cards, unknown types and malformed content have complete declared structural fallbacks", () => {
  for (const type of ["interactive", "future_type", "image"]) {
    const item = nativeMessage(type, { title: "Synthetic title", elements: [{ future: [1, 2, { all_fields: true }] }] });
    const normalized = normalizeApiMessage(item);
    assert.equal(normalized.content_rendering.status, "structured_fallback");
    assert.match(normalized.content, /未完整渲染/);
    assert.equal(normalized.content.endsWith(item.body.content), true);
    assert.deepEqual(normalized.raw_api, item);
  }
  const malformed = nativeMessage("text", {}, { body: { content: '{"text": "unfinished' } });
  assert.equal(normalizeApiMessage(malformed).content.endsWith(malformed.body.content), true);
  const missing = nativeMessage("text", {}, { body: {} });
  assert.equal(normalizeApiMessage(missing).content.endsWith(JSON.stringify(missing)), true);
});

test("system uses source parameters once, preserves placeholders in raw facts and never invents identity", () => {
  const item = nativeMessage("system", { template: "{name} clipped a topic to top.",
    from_user: [], to_chatters: [], divider_text: {} },
  { sender: { id: "", id_type: "", sender_type: "", tenant_key: "" } });
  const normalized = normalizeApiMessage(item);
  const stored = record(normalized);
  assert.equal(normalized.content, item.body.content);
  assert.equal(stored.body, "未知操作者置顶了一个话题");
  assert.equal(normalized.content_rendering.status, "partial");
  assert.equal(stored.actor_id, null);
  assert.equal(JSON.parse(stored.canonical_json).sender_name, null);
  assert.equal(stored.raw_json, JSON.stringify(item));
  const named = nativeMessage("system", { template: "{name} clipped a topic to top.", name: "Synthetic {literal}" },
    { sender: item.sender });
  assert.equal(record(normalizeApiMessage(named)).body, "Synthetic {literal} clipped a topic to top.");
  assert.equal(record(normalizeApiMessage(named)).actor_id, null);
});

test("a system structural fallback is not reinterpreted as a template", () => {
  const item = nativeMessage("system", { unknown_structure: "Literal {name}" });
  const normalized = normalizeApiMessage(item);
  assert.equal(record(normalized).body, normalized.content);
  assert.equal(record(normalized).body.endsWith(item.body.content), true);
});

test("deleted messages preserve deletion state and unavailable original structure", () => {
  const item = nativeMessage("post", {}, { deleted: true, body: { content: "" } });
  const stored = record(normalizeApiMessage(item));
  assert.equal(JSON.parse(stored.canonical_json).deleted, true);
  assert.equal(JSON.parse(stored.raw_json).body.content, "");
  assert.match(stored.body, /未完整渲染/);
});

test("merge-forward without details honestly declares that its content was not expanded", () => {
  const item = nativeMessage("merge_forward", { create_message_ids: ["om_child"] });
  const normalized = normalizeApiMessage(item);
  assert.match(normalized.content, /未展开转发合并内容/);
  assert.equal(normalized.content.endsWith(item.body.content), true);
  assert.equal(normalized.content_rendering.reason, "merge_forward_not_expanded");
  assert.equal(record(normalized).raw_json, JSON.stringify(item));
});

test("merge-forward expansion retains eight children as raw evidence and renders each exactly once", () => {
  const parent = nativeMessage("merge_forward", { create_message_ids: ["om_first_child"] });
  const children = Array.from({ length: 8 }, (_, index) => nativeMessage(
    index < 3 ? "post" : "text",
    index < 3 ? { content: [[{ tag: "text", text: `Synthetic child ${index}` }]] } : { text: `Synthetic child ${index}` },
    { message_id: `om_synthetic_child_${index}`, upper_message_id: index === 0 ? parent.message_id : `om_synthetic_child_${index - 1}` },
  ));
  const details = [parent, ...children];
  const before = JSON.stringify(details);
  const normalized = normalizeApiMessage(parent, { mergeItems: details });
  for (let index = 0; index < 8; index++) assert.equal(normalized.content.split(`Synthetic child ${index}`).length - 1, 1);
  assert.match(normalized.content, /列出 8 条/);
  assert.equal(normalized.content_rendering.status, "rendered");
  const stored = record(normalized);
  const raw = JSON.parse(stored.raw_json);
  assert.deepEqual(raw.raw_api_expansions.merge_forward, { source_api: "im.v1.messages.get", items: details });
  for (const key of Object.keys(parent)) assert.deepEqual(raw[key], parent[key], key);
  assert.equal(stored.content_hash, hash(stored.raw_json));
  assert.equal(JSON.stringify(details), before);
  details[1].body.content = '{"text":"external mutation"}';
  assert.equal(JSON.stringify(normalized.raw_api_expansions.merge_forward.items), before);
});

test("merge-forward flattening cannot loop or discard unknown descendants", () => {
  const parent = nativeMessage("merge_forward", { create_message_ids: ["om_child_a"] });
  const childA = nativeMessage("text", { text: "Cyclic child A" }, { message_id: "om_child_a", upper_message_id: "om_child_b" });
  const childB = nativeMessage("interactive", { nested_card: { preserved: true } }, { message_id: "om_child_b", upper_message_id: "om_child_a" });
  const nested = nativeMessage("merge_forward", { create_message_ids: ["om_unfetched"] }, { message_id: "om_nested" });
  const normalized = normalizeApiMessage(parent, { mergeItems: [parent, childA, childB, nested] });
  assert.equal(normalized.content_rendering.status, "partial");
  assert.match(normalized.content, /列出 3 条/);
  assert.match(normalized.content, /Cyclic child A/);
  assert.equal(normalized.content.includes(childB.body.content), true);
  assert.equal(normalized.content.includes(nested.body.content), true);
  assert.match(normalized.content, /未展开转发合并内容/);
});

test("merge detail source conflicts and duplicate identities fail instead of mixing versions", () => {
  const parent = nativeMessage("merge_forward", { create_message_ids: ["om_child"] });
  const child = nativeMessage("text", { text: "Synthetic child" }, { message_id: "om_child" });
  for (const changed of [
    { ...parent, update_time: "1800000002000" },
    { ...parent, body: { content: '{"different":"source"}' } },
  ]) assert.throws(() => normalizeApiMessage(parent, { mergeItems: [changed, child] }), /source changed/);
  assert.throws(() => normalizeApiMessage(parent, { mergeItems: [parent, child, child] }), /duplicate/);
  assert.throws(() => normalizeApiMessage(parent, { mergeItems: [{ msg_type: "text" }] }), /detail item/);
});

test("single-message normalization keeps all native thread reply identities without flattening or filtering", () => {
  const items = Array.from({ length: 9 }, (_, index) => nativeMessage("text", { text: `Native thread item ${index}` }, {
    message_id: `om_thread_item_${index}`, parent_id: index ? "om_thread_item_0" : "",
    root_id: "om_thread_item_0", create_time: String(1800000000000 + index),
  }));
  const messages = items.map((item) => normalizeApiMessage(item));
  assert.equal(messages.length, 9);
  assert.equal(new Set(messages.map((item) => item.message_id)).size, 9);
  for (const [index, message] of messages.entries()) {
    const stored = record(message);
    assert.equal(stored.external_id, items[index].message_id);
    assert.equal(stored.raw_json, JSON.stringify(items[index]));
  }
});
