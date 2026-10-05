import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveProbeContext } from "../src/diagnostics/live-probe-cache.mjs";
import { enrichRow } from "../src/diagnostics/messages-report.mjs";
import { readLocalChatAppNames, applyLocalChatAppNames } from "../src/diagnostics/local-chat-app-names.mjs";

// All identities, provenance references, clocks and prose were invented here.
const TENANT = "synthetic-tenant-orbit";
const CHAT = "oc_synthetic_maple_room";
const APP = "cli_synthetic_paper_owl";
const NAME = "Synthetic Paper Owl";
const SOURCE = { kind: "user_screenshot", recorded_at: "2053-08-04T09:10:11.000Z", evidence_refs: ["synthetic-evidence-owl-a"] };
const DISPLAY_SOURCE = { kind: "local_chat_app_name", source_kind: SOURCE.kind,
  recorded_at: SOURCE.recorded_at, evidence_refs: SOURCE.evidence_refs };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "exocortex-synthetic-chat-app-unit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "synthetic.sqlite");
  const configPath = `${dbPath}.chat-app-names.json`;
  writeFileSync(dbPath, "synthetic binding only; these unit tests never query SQLite");
  const entry = { tenant_key: TENANT, chat_id: CHAT, app_id: APP, name: NAME, source: structuredClone(SOURCE) };
  const config = { kind: "lark_im_chat_app_names/v1", context: {
    database_key: liveProbeContext(dbPath).database_key, source_id: "lark.im",
  }, entries: [entry] };
  const save = (value = config) => writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 });
  return { directory, dbPath, configPath, entry, config, save };
}

function message({ raw = {}, canonical = {}, scope = {}, row = {} } = {}) {
  return enrichRow({ id: 1, direction: "received", record_type: "lark.im.message",
    occurred_at: "2053-08-04T09:00:00.000Z", occurred_at_ms: Date.parse("2053-08-04T09:00:00.000Z"),
    actor_id: APP, container_id: CHAT, external_id: "om_synthetic_paper_announcement", body: "Invented workshop announcement.",
    raw_json: JSON.stringify({ chat_id: CHAT, msg_type: "text", sender: {
      id: APP, id_type: "app_id", sender_type: "app", tenant_key: TENANT,
    }, body: { content: JSON.stringify({ text: "Invented workshop announcement." }) }, ...raw }),
    canonical_json: JSON.stringify({ sender_id: APP, sender_id_type: "app_id", sender_type: "app",
      sender_name: null, chat_id: CHAT, tenant_key: TENANT, msg_type: "text", ...canonical }),
    scope_config_json: JSON.stringify({ chat_id: CHAT, tenant_key: TENANT, chat_type: "group", ...scope }), ...row });
}

function safeError(fn, fixture, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    for (const secret of [fixture.directory, NAME, TENANT, CHAT, APP, SOURCE.evidence_refs[0]]) {
      assert.equal(String(error.message).includes(secret), false, "error text must not disclose local mapping content or path");
    }
    return true;
  });
}

test("absent sidecar preserves the exact message array and creates no config", (t) => {
  const f = fixture(t);
  const rows = [message()];
  const before = readFileSync(f.dbPath);
  assert.equal(readLocalChatAppNames(f.dbPath), null);
  assert.equal(applyLocalChatAppNames(rows, null), rows);
  assert.deepEqual(readFileSync(f.dbPath), before);
  assert.throws(() => statSync(f.configPath), { code: "ENOENT" });
});

test("exact typed app identity overlays only sender and explicit local provenance", (t) => {
  const f = fixture(t); f.save();
  const original = message();
  const before = structuredClone(original);
  const configBefore = readFileSync(f.configPath);
  const result = applyLocalChatAppNames([original], readLocalChatAppNames(f.dbPath));
  assert.deepEqual(result, [{ ...before, display: { ...before.display, sender: `应用：${NAME}`, sender_name_source: DISPLAY_SOURCE } }]);
  assert.deepEqual(original, before, "display overlay must not mutate a caller's message");
  assert.deepEqual(readFileSync(f.configPath), configBefore);
  assert.equal(statSync(f.configPath).mode & 0o777, 0o600);
});

const noMatchCases = [
  ["different native app", { raw: { sender: { id: "cli_synthetic_other", id_type: "app_id", sender_type: "app", tenant_key: TENANT } } }],
  ["different native chat", { raw: { chat_id: "oc_synthetic_other" } }],
  ["different native tenant", { raw: { sender: { id: APP, id_type: "app_id", sender_type: "app", tenant_key: "synthetic-other-tenant" } } }],
  ["missing native tenant", { raw: { sender: { id: APP, id_type: "app_id", sender_type: "app" } } }],
  ["missing native chat", { raw: { chat_id: null } }],
  ["prefix without namespace", { raw: { sender: { id: APP, sender_type: "app", tenant_key: TENANT } } }],
  ["app spelling in user namespace", { raw: { sender: { id: APP, id_type: "open_id", sender_type: "app", tenant_key: TENANT } } }],
  ["conflicting app aliases", { raw: { sender: { id: APP, id_type: "app_id", app_id: "cli_synthetic_other", tenant_key: TENANT } } }],
  ["conflicting declared sender type", { raw: { sender: { id: APP, id_type: "app_id", sender_type: "user", tenant_key: TENANT } } }],
  ["row actor mismatch", { row: { actor_id: "cli_synthetic_other" } }],
  ["row chat mismatch", { row: { container_id: "oc_synthetic_other" } }],
  ["canonical app mismatch", { canonical: { sender_id: "cli_synthetic_other" } }],
  ["canonical namespace mismatch", { canonical: { sender_id_type: "open_id" } }],
  ["canonical sender type mismatch", { canonical: { sender_type: "user" } }],
  ["canonical chat mismatch", { canonical: { chat_id: "oc_synthetic_other" } }],
  ["canonical tenant mismatch", { canonical: { tenant_key: "synthetic-other-tenant" } }],
  ["scope chat mismatch", { scope: { chat_id: "oc_synthetic_other" } }],
  ["scope tenant mismatch", { scope: { tenant_key: "synthetic-other-tenant" } }],
  ["known canonical name", { canonical: { sender_name: "Synthetic Authoritative Owl" } }],
  ["known source name", { raw: { sender: { id: APP, id_type: "app_id", tenant_key: TENANT, name: "Synthetic Native Owl" } } }],
  ["known source display name", { raw: { sender: { id: APP, id_type: "app_id", tenant_key: TENANT, display_name: "Synthetic Native Owl" } } }],
  ["authoritative canonical clear", { canonical: { sender_name_state: "cleared" } }],
  ["authoritative raw clear", { raw: { sender_name_state: "cleared" } }],
  ["authoritative source name clear", { raw: { sender: { id: APP, id_type: "app_id", tenant_key: TENANT, name_state: "cleared" } } }],
  ["non-message record", { row: { record_type: "invented.other" } }],
  ["conflicting source", { row: { source_id: "invented.other" } }],
];
for (const [name, overrides] of noMatchCases) {
  test(`local name does not apply with ${name}`, (t) => {
    const f = fixture(t); f.save();
    const original = message(overrides);
    const before = structuredClone(original);
    const [actual] = applyLocalChatAppNames([original], readLocalChatAppNames(f.dbPath));
    assert.equal(actual, original, "unmatched rows retain their object and JSON contract");
    assert.deepEqual(actual, before);
  });
}

test("typed app namespace works without guessing a cli_ prefix and unknown ID echoes may be filled", (t) => {
  const f = fixture(t);
  const app = "invented-application-without-prefix";
  f.entry.app_id = app; f.save();
  const original = message({ row: { actor_id: app }, canonical: { sender_id: app, sender_name: app },
    raw: { sender: { sender_id: { app_id: app }, tenant_key: TENANT } } });
  const [actual] = applyLocalChatAppNames([original], readLocalChatAppNames(f.dbPath));
  assert.equal(actual.display.sender, `应用：${NAME}`);
  assert.deepEqual(actual.canonical, original.canonical);
});

test("raw_api is identity authority while inconsistent wrapper evidence prevents overlay", (t) => {
  const f = fixture(t); f.save();
  const native = { chat_id: CHAT, sender: { id: APP, id_type: "app_id", tenant_key: TENANT } };
  const valid = message({ raw: { raw_api: native } });
  assert.equal(applyLocalChatAppNames([valid], readLocalChatAppNames(f.dbPath))[0].display.sender, `应用：${NAME}`);
  const invalid = message({ raw: { raw_api: { ...native, sender: { ...native.sender, id_type: "open_id" } } } });
  assert.equal(applyLocalChatAppNames([invalid], readLocalChatAppNames(f.dbPath))[0], invalid);
  const wrapperMismatch = message({ raw: { raw_api: native, chat_id: "oc_synthetic_other" } });
  assert.equal(applyLocalChatAppNames([wrapperMismatch], readLocalChatAppNames(f.dbPath))[0], wrapperMismatch);
});

for (const [label, outer] of [
  ["scalar sender_id", { sender_id: "cli_synthetic_other" }],
  ["nested app_id", { sender_id: { app_id: "cli_synthetic_other" } }],
  ["open_id", { open_id: "ou_synthetic_other" }],
  ["user_id", { user_id: "synthetic-other-user" }],
  ["union_id", { sender_id: { union_id: "on_synthetic_other" } }],
  ["same spelling in person namespace", { open_id: APP }],
]) {
  test(`raw_api cannot grant mapping across outer ${label} conflict`, (t) => {
    const f = fixture(t); f.save();
    const native = { chat_id: CHAT, sender: { id: APP, id_type: "app_id", tenant_key: TENANT } };
    const original = message({ raw: { raw_api: native, sender: outer } });
    assert.equal(applyLocalChatAppNames([original], readLocalChatAppNames(f.dbPath))[0], original);
  });
}

for (const rawApi of [null, [], "synthetic-invalid-native", 42]) {
  test(`present invalid raw_api (${JSON.stringify(rawApi)}) cannot fall back to wrapper identity`, (t) => {
    const f = fixture(t); f.save();
    const original = message({ raw: { raw_api: rawApi } });
    assert.equal(applyLocalChatAppNames([original], readLocalChatAppNames(f.dbPath))[0], original);
  });
}

test("raw_api names and explicit clears remain authoritative when projections are unknown", (t) => {
  const f = fixture(t); f.save();
  for (const extra of [{ name: "Synthetic Native Authority" }, { display_name: "Synthetic Native Authority" }, { name_state: "cleared" }]) {
    const original = message({ raw: { raw_api: { chat_id: CHAT,
      sender: { id: APP, id_type: "app_id", tenant_key: TENANT, ...extra } } } });
    assert.equal(applyLocalChatAppNames([original], readLocalChatAppNames(f.dbPath))[0], original);
  }
});

test("an empty configured entry list preserves unmatched JSON exactly", (t) => {
  const f = fixture(t); f.config.entries = []; f.save();
  const original = message();
  assert.equal(applyLocalChatAppNames([original], readLocalChatAppNames(f.dbPath))[0], original);
});

test("missing native identity is never reconstructed from a canonical app ID", (t) => {
  const f = fixture(t); f.save();
  const original = message({ raw: { raw_api: { chat_id: CHAT, sender: { tenant_key: TENANT } } } });
  assert.equal(applyLocalChatAppNames([original], readLocalChatAppNames(f.dbPath))[0], original);
});

const invalidConfigs = [
  ["wrong schema version", (f) => { f.config.kind = "lark_im_chat_app_names/v9"; }],
  ["wrong source", (f) => { f.config.context.source_id = "invented.other"; }],
  ["duplicate exact tuple", (f) => { f.config.entries.push(structuredClone(f.entry)); }],
  ["blank name", (f) => { f.entry.name = ""; }],
  ["whitespace name", (f) => { f.entry.name = "   "; }],
  ["padded name", (f) => { f.entry.name = ` ${NAME}`; }],
  ["app ID as name", (f) => { f.entry.name = APP; }],
  ["chat ID as name", (f) => { f.entry.name = CHAT; }],
  ["tenant ID as name", (f) => { f.entry.name = TENANT; }],
  ["terminal escape in name", (f) => { f.entry.name = "Synthetic\u001b[31mOwl"; }],
  ["bidi format in name", (f) => { f.entry.name = "Synthetic\u202eOwl"; }],
  ["line separator in name", (f) => { f.entry.name = "Synthetic\u2028Owl"; }],
  ["overlong name", (f) => { f.entry.name = "x".repeat(129); }],
  ["unrecognized provenance", (f) => { f.entry.source.kind = "guessed_from_app_id"; }],
  ["missing provenance", (f) => { delete f.entry.source; }],
  ["missing evidence references", (f) => { f.entry.source.evidence_refs = []; }],
  ["noncanonical timestamp", (f) => { f.entry.source.recorded_at = "2053-08-04"; }],
  ["too many entries", (f) => { f.config.entries = Array.from({ length: 101 }, (_, i) => ({ ...f.entry, chat_id: `oc_synthetic_${i}` })); }],
  ["unexpected global mapping key", (f) => { f.config.global = true; }],
  ["overlong app identity", (f) => { f.entry.app_id = "a".repeat(129); }],
  ["overlong evidence reference", (f) => { f.entry.source.evidence_refs = ["e".repeat(257)]; }],
  ["too many evidence references", (f) => { f.entry.source.evidence_refs = Array.from({ length: 9 }, (_, i) => `synthetic-evidence-${i}`); }],
];
for (const [name, mutate] of invalidConfigs) {
  test(`invalid local mapping fails safely: ${name}`, (t) => {
    const f = fixture(t); mutate(f); f.save();
    const before = readFileSync(f.configPath);
    safeError(() => readLocalChatAppNames(f.dbPath), f, "local_chat_app_names_invalid");
    assert.deepEqual(readFileSync(f.configPath), before);
  });
}

test("malformed JSON and excessive file size are rejected without including content", (t) => {
  const f = fixture(t);
  writeFileSync(f.configPath, `{\"${NAME}\":`, { mode: 0o600 });
  safeError(() => readLocalChatAppNames(f.dbPath), f, "local_chat_app_names_invalid");
  writeFileSync(f.configPath, " ".repeat(65537));
  assert.throws(() => readLocalChatAppNames(f.dbPath), (error) => {
    assert.match(error.code, /^local_chat_app_names_(invalid|unsafe_file)$/);
    assert.equal(error.message.includes(f.directory), false);
    return true;
  });
});

test("invalid UTF-8 is rejected before it can become a replacement-character name", (t) => {
  const f = fixture(t);
  const valid = Buffer.from(JSON.stringify(f.config));
  const position = valid.indexOf(Buffer.from(NAME));
  valid[position] = 0xff;
  writeFileSync(f.configPath, valid, { mode: 0o600 });
  safeError(() => readLocalChatAppNames(f.dbPath), f, "local_chat_app_names_invalid");
  assert.deepEqual(readFileSync(f.configPath), valid);
});

test("a directory masquerading as sidecar is rejected without recursive reads or repair", (t) => {
  const f = fixture(t); mkdirSync(f.configPath, { mode: 0o700 });
  safeError(() => readLocalChatAppNames(f.dbPath), f, "local_chat_app_names_unsafe_file");
  assert.equal(statSync(f.configPath).isDirectory(), true);
});

test("the owner gate rejects another UID without chmod or chown", (t) => {
  const f = fixture(t); f.save();
  const actualUid = process.getuid();
  const actualOwner = statSync(f.configPath).uid;
  const mocked = t.mock.method(process, "getuid", () => actualUid + 1);
  try { safeError(() => readLocalChatAppNames(f.dbPath), f, "local_chat_app_names_unsafe_file"); }
  finally { mocked.mock.restore(); }
  assert.equal(statSync(f.configPath).uid, actualOwner);
  assert.equal(statSync(f.configPath).mode & 0o777, 0o600);
});

for (const mode of [0o644, 0o660, 0o400, 0o000]) {
  test(`sidecar permissions ${mode.toString(8)} are rejected and never repaired`, (t) => {
    const f = fixture(t); f.save(); chmodSync(f.configPath, mode);
    safeError(() => readLocalChatAppNames(f.dbPath), f, "local_chat_app_names_unsafe_file");
    assert.equal(statSync(f.configPath).mode & 0o777, mode);
  });
}

for (const kind of ["symbolic", "hard"]) {
  test(`${kind} linked sidecar is rejected without changing the link or its target`, (t) => {
    const f = fixture(t); f.save();
    const target = join(f.directory, "synthetic-config-target.json"); renameSync(f.configPath, target);
    (kind === "symbolic" ? symlinkSync : linkSync)(target, f.configPath);
    const before = readFileSync(target);
    safeError(() => readLocalChatAppNames(f.dbPath), f, "local_chat_app_names_unsafe_file");
    assert.deepEqual(readFileSync(target), before);
  });
}

test("database path and inode binding rejects a copy or replacement even with identical bytes", (t) => {
  const f = fixture(t); f.save();
  const copy = join(f.directory, "synthetic-copy.sqlite"); copyFileSync(f.dbPath, copy);
  copyFileSync(f.configPath, `${copy}.chat-app-names.json`); chmodSync(`${copy}.chat-app-names.json`, 0o600);
  safeError(() => readLocalChatAppNames(copy), f, "local_chat_app_names_database_mismatch");
  const state = readLocalChatAppNames(f.dbPath);
  renameSync(copy, f.dbPath);
  safeError(() => applyLocalChatAppNames([message()], state), f, "local_chat_app_names_database_mismatch");
  safeError(() => readLocalChatAppNames(f.dbPath), f, "local_chat_app_names_database_mismatch");
});

test("wrong database key is rejected rather than silently applying a global app alias", (t) => {
  const f = fixture(t); f.config.context.database_key = "a".repeat(64); f.save();
  safeError(() => readLocalChatAppNames(f.dbPath), f, "local_chat_app_names_database_mismatch");
});

test("a database symlink resolves to the canonical file and swapping its target invalidates the loaded mapping", (t) => {
  const f = fixture(t); f.save();
  const alias = join(f.directory, "synthetic-alias.sqlite"); symlinkSync(f.dbPath, alias);
  const state = readLocalChatAppNames(alias);
  assert.equal(applyLocalChatAppNames([message()], state)[0].display.sender, `应用：${NAME}`);
  const other = join(f.directory, "synthetic-other.sqlite"); copyFileSync(f.dbPath, other);
  unlinkSync(alias); symlinkSync(other, alias);
  safeError(() => applyLocalChatAppNames([message()], state), f, "local_chat_app_names_database_mismatch");
});

test("config edits and deletion take effect next read; changes during a query fail closed", (t) => {
  const f = fixture(t); f.save();
  const prior = readLocalChatAppNames(f.dbPath);
  f.entry.name = "Synthetic Updated Owl"; f.save();
  safeError(() => applyLocalChatAppNames([message()], prior), f, "local_chat_app_names_changed");
  assert.equal(applyLocalChatAppNames([message()], readLocalChatAppNames(f.dbPath))[0].display.sender, "应用：Synthetic Updated Owl");
  const current = readLocalChatAppNames(f.dbPath); unlinkSync(f.configPath);
  safeError(() => applyLocalChatAppNames([message()], current), f, "local_chat_app_names_changed");
  assert.equal(readLocalChatAppNames(f.dbPath), null);
});
