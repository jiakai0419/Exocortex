import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { larkSenderNamespaceSql, mergeLarkNameProjectionSql } from "../dist/storage/sqlite/lark-name-projection.js";

// Only newly invented JSON and SQLite :memory: state. Identity byte equality
// does not establish an ID namespace, including for these synthetic ou_ IDs.
const ACTOR = "ou_synthetic_namespace_maker";
const OTHER = "ou_synthetic_namespace_reader";
const CHAT = "oc_synthetic_namespace_studio";
const KNOWN = "Synthetic Namespace Maker";

function quoted(value) {
  return value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
}
function json(value) { return quoted(typeof value === "string" ? value : JSON.stringify(value)); }
function query(statement) {
  const result = spawnSync("/usr/bin/sqlite3", ["-init", "/dev/null", ":memory:", "-json"], {
    input: `.bail on\n${statement}`, encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function canonical(type, name = null, actor = ACTOR) {
  return { sender_id: actor, ...(type === undefined ? {} : { sender_id_type: type }),
    sender_name: name, chat_id: CHAT, content: { text: "Synthetic namespace evidence." } };
}
function raw(type, actor = ACTOR) {
  return { sender: { id: actor, ...(type === undefined ? {} : { id_type: type }) }, chat_id: CHAT };
}
function namespace(canonicalValue, rawValue, actor = ACTOR, allowLegacy = true) {
  return query(`SELECT ${larkSenderNamespaceSql(json(canonicalValue), json(rawValue), quoted(actor), allowLegacy)} AS namespace;`)[0].namespace;
}
function merge(old, next, oldRaw, nextRaw, actor = ACTOR) {
  return query(`SELECT ${mergeLarkNameProjectionSql(json(old), json(next), quoted(actor), quoted(actor),
    quoted(CHAT), quoted(CHAT), json(oldRaw), json(nextRaw))} AS canonical_json;`)[0].canonical_json;
}
function assertNotInherited(oldType, nextType, oldRaw, nextRaw, actor = ACTOR) {
  const old = { ...canonical(oldType, KNOWN, actor), sender_name_source: "contact", sender_name_confidence: "high" };
  const next = canonical(nextType, null, actor);
  const result = JSON.parse(merge(old, next, oldRaw, nextRaw, actor));
  assert.equal(result.sender_name, null);
  assert.equal(Object.hasOwn(result, "sender_name_source"), false);
  assert.equal(Object.hasOwn(result, "sender_name_confidence"), false);
  assert.deepEqual(result, next);
}

for (const previous of ["open_id", "user_id", "app_id"]) {
  for (const incoming of ["open_id", "user_id", "app_id"]) {
    if (previous === incoming) continue;
    test(`identical actor bytes cannot inherit ${previous} names into ${incoming}`, () => {
      assert.equal(namespace(canonical(previous), raw(previous)), `typed:${previous}`);
      assert.equal(namespace(canonical(incoming), raw(incoming)), `typed:${incoming}`);
      assertNotInherited(previous, incoming, raw(previous), raw(incoming));
    });
  }
}

for (const type of ["open_id", "user_id", "app_id"]) {
  test(`matching explicit ${type} evidence retains a known name after an unknown lookup`, () => {
    const old = canonical(type, KNOWN);
    const result = JSON.parse(merge(old, canonical(type), raw(type), raw(type)));
    assert.deepEqual(result, old);
  });
}

test("raw user_id evidence overrides an absent canonical type and cannot inherit into open_id despite an ou_ actor", () => {
  assert.equal(namespace(canonical(undefined), raw("user_id")), "typed:user_id");
  assertNotInherited(undefined, "open_id", raw("user_id"), raw("open_id"));
});

test("completely untyped historical ou_ identity retains compatibility inheritance but grants no lookup authority", () => {
  const old = canonical(undefined, KNOWN);
  assert.equal(namespace(old, raw(undefined)), "typed:open_id");
  assert.equal(namespace(old, raw(undefined), ACTOR, false), null);
  const result = JSON.parse(merge(old, canonical("open_id"), raw(undefined), raw("open_id")));
  assert.equal(result.sender_name, KNOWN);
  assert.equal(result.sender_id_type, "open_id");
});

for (const [label, canonicalType, rawValue] of [
  ["canonical open_id and raw user_id", "open_id", raw("user_id")],
  ["canonical user_id and raw open_id", "user_id", raw("open_id")],
  ["direct typed value mismatches actor", undefined, { sender: { open_id: OTHER } }],
  ["raw id mismatches actor", "open_id", raw("open_id", OTHER)],
  ["same-namespace direct and nested fields disagree", "open_id",
    { sender: { id: ACTOR, id_type: "open_id", open_id: ACTOR, sender_id: { open_id: OTHER } } }],
  ["declared open_id and same-namespace direct field disagree", "open_id",
    { sender: { id: ACTOR, id_type: "open_id", open_id: OTHER } }],
  ["undeclared multiple namespaces match identical bytes", undefined,
    { sender: { id: ACTOR, open_id: ACTOR, user_id: ACTOR } }],
  ["non-selected user_id namespace contains contradictory fields", "open_id",
    { sender: { id: ACTOR, id_type: "open_id", user_id: "synthetic-local-user-a",
      sender_id: { user_id: "synthetic-local-user-b" } } }],
]) {
  test(`${label} blocks inheritance in either direction`, () => {
    assert.equal(namespace(canonical(canonicalType), rawValue), null);
    assertNotInherited(canonicalType, "open_id", rawValue, raw("open_id"));
    assertNotInherited("open_id", canonicalType, raw("open_id"), rawValue);
  });
}

for (const malformed of [{ declared: "open_id" }, 17]) {
  const label = typeof malformed;
  test(`a ${label} canonical sender type is invalid instead of a matching namespace`, () => {
    assert.equal(namespace(canonical(malformed), raw("open_id")), null);
    assertNotInherited(malformed, "open_id", raw("open_id"), raw("open_id"));
    assertNotInherited("open_id", malformed, raw("open_id"), raw("open_id"));
  });
  test(`a ${label} raw sender type is invalid instead of a matching namespace`, () => {
    assert.equal(namespace(canonical(undefined), raw(malformed)), null);
    assertNotInherited(undefined, "open_id", raw(malformed), raw("open_id"));
    assertNotInherited("open_id", undefined, raw("open_id"), raw(malformed));
  });
}

test("two wholly untyped opaque identities preserve compatibility only within the legacy namespace", () => {
  const opaque = "synthetic-opaque-identity";
  const old = canonical(undefined, KNOWN, opaque);
  assert.equal(namespace(old, raw(undefined, opaque), opaque), "legacy:opaque");
  assert.equal(namespace(old, raw(undefined, opaque), opaque, false), null);
  assert.deepEqual(JSON.parse(merge(old, canonical(undefined, null, opaque), raw(undefined, opaque), raw(undefined, opaque), opaque)), old);
});

test("an explicit unknown namespace remains isolated from legacy opaque and recognized open_id", () => {
  const opaque = "synthetic-opaque-identity";
  assertNotInherited(undefined, "unknown", raw(undefined, opaque), raw("unknown", opaque), opaque);
  assertNotInherited("unknown", undefined, raw("unknown", opaque), raw(undefined, opaque), opaque);
  assertNotInherited("unknown", "open_id", raw("unknown"), raw("open_id"));
  assertNotInherited("open_id", "unknown", raw("open_id"), raw("unknown"));
});

test("a raw_api wrapper uses its authoritative inner typed source instead of outer projection fields", () => {
  const wrapped = { sender: { id: ACTOR, id_type: "user_id" }, raw_api: raw("open_id") };
  assert.equal(namespace(canonical("open_id"), wrapped), "typed:open_id");
  const old = canonical("open_id", KNOWN);
  assert.deepEqual(JSON.parse(merge(old, canonical("open_id"), wrapped, raw("open_id"))), old);
  assertNotInherited(undefined, "open_id", { raw_api: raw("user_id") }, raw("open_id"));
});

test("contradictory same-namespace fields inside a raw_api wrapper cannot inherit a name", () => {
  const wrapped = { raw_api: { sender: { id: ACTOR, id_type: "open_id", sender_id: { open_id: OTHER } } } };
  assert.equal(namespace(canonical("open_id"), wrapped), null);
  assertNotInherited("open_id", "open_id", wrapped, raw("open_id"));
  assertNotInherited("open_id", "open_id", raw("open_id"), wrapped);
});

test("valid direct and nested typed source fields establish a namespace without relying on the actor prefix", () => {
  const actor = "synthetic_opaque_open_identity";
  for (const sender of [{ open_id: actor }, { sender_id: { open_id: actor } }]) {
    assert.equal(namespace(canonical(undefined, null, actor), { sender }, actor, false), "typed:open_id");
  }
});

test("distinct namespaces may each carry one different ID without invalidating explicit open_id evidence", () => {
  const source = { sender: { id: ACTOR, id_type: "open_id", open_id: ACTOR,
    user_id: "synthetic-local-user", sender_id: { union_id: "synthetic-union-user" } } };
  assert.equal(namespace(canonical("open_id"), source), "typed:open_id");
  const old = canonical("open_id", KNOWN);
  assert.deepEqual(JSON.parse(merge(old, canonical("open_id"), source, raw("open_id"))), old);
});

test("unknown replay preserves absent provenance properties and returns the original canonical bytes", () => {
  const old = canonical("open_id", KNOWN);
  const original = `${JSON.stringify(old, null, 2)}\n`;
  const next = { ...canonical("open_id"), sender_name_source: "unknown", sender_name_confidence: "low",
    sender_name_resolution_status: "synthetic-unresolved", sender_name_resolution_reason: "synthetic-failure" };
  const result = merge(original, next, raw("open_id"), raw("open_id"));
  assert.equal(result, original);
});

test("name projection SQL accepts fresh completion while the caller retains source version and facts", () => {
  // This exercises the name projection expression, not the store's separate
  // source-version admission policy covered by lark-name-projection.test.mjs.
  const old = canonical("open_id");
  const incoming = { ...old, sender_name: KNOWN, sender_name_source: "contact", sender_name_confidence: "high" };
  const rawJson = JSON.stringify(raw("open_id"));
  const expression = mergeLarkNameProjectionSql("r.canonical_json", json(incoming), "r.actor_id", "r.actor_id",
    "r.container_id", "r.container_id", "r.raw_json", "r.raw_json");
  const [row] = query(`
    CREATE TABLE r (canonical_json TEXT, raw_json TEXT, actor_id TEXT, container_id TEXT,
      external_version TEXT, content_hash TEXT, body TEXT);
    INSERT INTO r VALUES (${json(old)}, ${quoted(rawJson)}, ${quoted(ACTOR)}, ${quoted(CHAT)},
      '20470101000117', 'synthetic-fixed-source-hash', 'Synthetic source body');
    UPDATE r SET canonical_json = ${expression};
    SELECT * FROM r;`);
  assert.deepEqual(JSON.parse(row.canonical_json), incoming);
  assert.equal(row.raw_json, rawJson);
  assert.equal(row.external_version, "20470101000117");
  assert.equal(row.content_hash, "synthetic-fixed-source-hash");
  assert.equal(row.body, "Synthetic source body");
});
