import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { renderSystemContent } from "../src/adapters/lark-im/system-content.mjs";
import { bodyFromMessage, recordFromMessage } from "../src/adapters/lark-im/message-record.mjs";
import { prepareRecords } from "../src/adapters/lark-im/core.mjs";

// Constructed here from the parameter protocol; no captured message or account
// data is an input. Labels describe an imaginary instrument panel, not people.
const LAB_TIME = 2_000_000_000_000;
const LAB_SCOPE = "synthetic.parameter_lab";
const missing = (key) => `[未知参数：${key}]`;

function labEvent({ sequence = 0, content = {}, sender, type = "system" } = {}) {
  const event = {};
  event.message_id = `om_parameter_lab_${sequence}`;
  event.msg_type = type;
  event.create_time = String(LAB_TIME + sequence);
  event.update_time = String(LAB_TIME + 500 + sequence);
  event.sender = sender ?? { id: "", id_type: "", sender_type: "" };
  event.chat_id = "oc_parameter_lab_room";
  event.thread_id = "omt_parameter_lab_series";
  event.content = content;
  return event;
}

function labRecord(event, context = {}) {
  return recordFromMessage(event, LAB_SCOPE, "received", context);
}

test("generic absent parameters stay explicit for text, objects, and JSON input", () => {
  const template = "Panel {label} reports {phase}.";
  const expected = `Panel ${missing("label")} reports ${missing("phase")}.`;
  const object = { template };
  for (const content of [template, object, JSON.stringify(object)]) {
    assert.equal(renderSystemContent(content), expected);
    assert.equal(bodyFromMessage(labEvent({ content })), expected);
  }
  assert.equal(renderSystemContent(`  ${template}\n`), `  ${expected}\n`);
});

test("supplied display strings substitute once without creating sender identity", () => {
  for (const label of ["Copper dial", "Violet gauge", "Dial $& {unexpanded}"]) {
    const content = Object.freeze({ template: "Reading for {label}: {label}", label });
    const record = labRecord(labEvent({ content }));
    const canonical = JSON.parse(record.canonical_json);
    assert.equal(record.body, `Reading for ${label}: ${label}`);
    assert.equal(record.actor_id, null);
    assert.equal(canonical.sender_id, "");
    assert.equal(canonical.sender_name, null);
    assert.equal(canonical.sender_type, null);
    assert.deepEqual(canonical.content, content);
  }
});

test("missing, structured, and inherited generic parameters cannot supply display names", () => {
  const template = "Station [{label}]";
  for (const label of [undefined, null, "", " \t", 27, false, ["Dial"], { text: "Dial" }]) {
    assert.equal(renderSystemContent({ template, label }), `Station [${missing("label")}]`);
  }
  const inherited = Object.assign(Object.create({ label: "Prototype dial" }), { template });
  assert.equal(renderSystemContent(inherited), `Station [${missing("label")}]`);
  assert.equal(renderSystemContent(Object.create({ template, label: "Prototype dial" })), null);
});

test("the supported array and divider fields render only their own valid string values", () => {
  const template = "Route {from_user} => {to_chatters}{divider_text}; {state}";
  const content = {
    template,
    from_user: ["Dial A", "Dial B"],
    to_chatters: ["Gauge C"],
    divider_text: { text: " / lab" },
  };
  assert.equal(renderSystemContent(content), `Route Dial A, Dial B => Gauge C / lab; ${missing("state")}`);
  const rejected = {
    template: "{from_user}|{to_chatters}|{divider_text}",
    from_user: [],
    to_chatters: ["Gauge C", { name: "Not display text" }],
    divider_text: Object.create({ text: "Inherited divider" }),
  };
  assert.equal(renderSystemContent(rejected), ["from_user", "to_chatters", "divider_text"].map(missing).join("|"));
});

test("unsupported envelopes return no invented rendering and existing body text survives", () => {
  for (const input of [undefined, null, 31, [], {}, { label: "No template" }, { template: false }]) {
    assert.equal(renderSystemContent(input), null);
  }
  assert.equal(renderSystemContent("Lab envelope remains literal."), "Lab envelope remains literal.");
  const content = { text: "Independent body fallback" };
  assert.equal(bodyFromMessage(labEvent({ content })), content.text);
  const deletedEvent = labEvent({ content: "[Invalid instrument envelope JSON]" });
  deletedEvent.deleted = true;
  assert.equal(bodyFromMessage(deletedEvent), "[已撤回/已删除：飞书未返回原始富文本内容]");
});

test("ordinary message types preserve placeholder text and serialized parameter objects", () => {
  const template = "Literal circuit {circuit}";
  const encoded = JSON.stringify({ template, circuit: "Delta" });
  for (const type of ["text", "post", "interactive"]) {
    for (const content of [template, encoded]) {
      assert.equal(bodyFromMessage(labEvent({ type, content })), content);
    }
  }
  assert.equal(bodyFromMessage({ message_type: "system", content: template }), `Literal circuit ${missing("circuit")}`);
});

test("rendering leaves constructed source facts, raw bytes, hash, and version intact", () => {
  const content = { template: "Meter {label} / {phase}", label: "Amber meter" };
  const event = labEvent({ sequence: 7, content });
  const original = JSON.stringify(event);
  const record = labRecord(event, {
    self: { open_id: "ou_lab_unrelated_self", name: "Unrelated self label" },
    contacts: new Map([["ou_lab_unrelated_contact", "Unrelated contact label"]]),
    chat_members: new Map([["oc_parameter_lab_room:ou_lab_unrelated_member", "Unrelated member label"]]),
  });
  const canonical = JSON.parse(record.canonical_json);
  assert.equal(record.body, `Meter Amber meter / ${missing("phase")}`);
  assert.equal(record.raw_json, original);
  assert.equal(JSON.stringify(event), original);
  assert.equal(record.content_hash, createHash("sha256").update(original).digest("hex"));
  assert.equal(record.external_version, String(LAB_TIME + 507));
  assert.equal(record.actor_id, null);
  assert.deepEqual(canonical.content, content);
  assert.equal(canonical.thread_id, event.thread_id);
  assert.equal(canonical.sender_id, "");
  assert.equal(canonical.sender_name, null);
  assert.equal(canonical.sender_type, null);
  assert.equal(canonical.sender_name_source, null);
});

test("constructed events sharing a thread never borrow another event's label as an actor", () => {
  const events = [
    labEvent({ sequence: 0, content: { template: "Marker {label}", label: "North dial" } }),
    labEvent({ sequence: 1, content: { template: "Marker {label}", label: "South dial" } }),
    labEvent({ sequence: 2, content: { template: "Marker {label}" } }),
  ];
  const records = prepareRecords(events, LAB_SCOPE, "received", null, LAB_TIME - 1, LAB_TIME + 3);
  assert.deepEqual(records.map((record) => record.body), ["Marker North dial", "Marker South dial", `Marker ${missing("label")}`]);
  assert.equal(records.every((record) => record.actor_id === null), true);
  assert.equal(records.every((record) => JSON.parse(record.canonical_json).sender_name === null), true);
});

test("an explicit source sender cannot fill an absent template parameter", () => {
  const sender = { id: "ou_parameter_lab_operator", sender_type: "user", name: "Lab source operator" };
  const event = labEvent({ sender, content: { template: "Calibration by {operator}" } });
  const record = labRecord(event);
  assert.equal(record.body, `Calibration by ${missing("operator")}`);
  assert.equal(record.actor_id, sender.id);
  assert.equal(JSON.parse(record.canonical_json).sender_name, sender.name);
  assert.deepEqual(JSON.parse(record.raw_json).sender, sender);
});

test("the existing source constant retains its dedicated missing-name branch contract", () => {
  // This tests an existing source constant's behavior. It neither establishes
  // the template's external origin nor reuses a captured event or old fixture.
  const source = readFileSync(new URL("../src/adapters/lark-im/system-content.mjs", import.meta.url), "utf8");
  const declarations = [...source.matchAll(/^const PIN_TOPIC_TEMPLATE = ("(?:[^"\\\r\n]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*");$/gm)];
  assert.equal(declarations.length, 1, "require one exact JSON-string constant declaration");
  const template = JSON.parse(declarations[0][1]);
  assert.equal(typeof template, "string");
  assert.ok(template.includes("{name}"));

  const absent = {};
  absent.template = template;
  const supplied = {};
  supplied.template = template;
  supplied.name = "Fictional brass label";
  const cases = [
    { content: template, expected: "未知操作者置顶了一个话题" },
    { content: ` \t${template}\n`, expected: "未知操作者置顶了一个话题" },
    { content: absent, expected: "未知操作者置顶了一个话题" },
    { content: JSON.stringify(absent), expected: "未知操作者置顶了一个话题" },
    { content: supplied, expected: template.replace(/\{name\}/g, () => supplied.name) },
    { content: JSON.stringify(supplied), expected: template.replace(/\{name\}/g, () => supplied.name) },
  ];
  for (const name of [undefined, null, "", " \t", 47, false, ["Brass label"], { text: "Brass label" }]) {
    const invalid = {};
    invalid.template = template;
    invalid.name = name;
    cases.push({ content: invalid, expected: "未知操作者置顶了一个话题" });
  }
  const inherited = Object.create({ name: "Prototype brass label" });
  inherited.template = template;
  cases.push({ content: inherited, expected: "未知操作者置顶了一个话题" });
  for (const [index, { content, expected }] of cases.entries()) {
    const event = labEvent({ sequence: 11 + index, content });
    const original = JSON.stringify(event);
    const record = labRecord(event);
    const canonical = JSON.parse(record.canonical_json);
    assert.equal(renderSystemContent(content), expected);
    assert.equal(record.body, expected);
    assert.equal(record.raw_json, original);
    assert.equal(JSON.stringify(event), original);
    assert.equal(record.content_hash, createHash("sha256").update(original).digest("hex"));
    assert.equal(record.external_version, event.update_time);
    assert.equal(record.actor_id, null);
    assert.equal(canonical.sender_id, "");
    assert.equal(canonical.sender_name, null);
    assert.deepEqual(canonical.content, JSON.parse(JSON.stringify(content)));
  }
});
