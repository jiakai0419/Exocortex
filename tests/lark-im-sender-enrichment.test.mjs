import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// Entirely invented fixtures, built from an empty SQLite database. No captured,
// transformed, anonymized, or production messages, identities, or API responses.
const TARGET = "ou_synthetic_sender_ceramic";
const OTHER = "ou_synthetic_sender_paper";
const PERSON = "Synthetic Ceramic Reader";
const CHAT = "oc_synthetic_sender_workshop";
const EPOCH = Date.UTC(2047, 2, 19, 8, 9, 10);
const SAFE_PATH = [...new Set([dirname(process.execPath), "/usr/bin", "/bin"])].join(":");
const SENDER_FIELDS = new Set(["sender_id_type", "sender_name", "sender_name_source", "sender_name_confidence"]);

function sqlString(value) {
  return value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
}

function sql(db, statement, readonly = false) {
  const result = spawnSync("/usr/bin/sqlite3", [...(readonly ? ["-readonly"] : []), "-json", db], {
    input: `.bail on\n.timeout 5000\n${readonly ? "PRAGMA query_only=ON;\n" : ""}${statement}`,
    encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : [];
}

function readRows(fixture) {
  return sql(fixture.db, "SELECT * FROM records ORDER BY id;", true);
}

function callLog(fixture) {
  return existsSync(fixture.calls) ? readFileSync(fixture.calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
}

function setRemote(fixture, config) {
  writeFileSync(fixture.remote, JSON.stringify(config));
}

function fixture(t, remote = { contact: "success" }) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-sender-only-test-"));
  for (const part of ["home", "config", "cache", "data", "api-state", "tmp"]) mkdirSync(join(dir, part), { mode: 0o700 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const value = { dir, db: join(dir, "synthetic.sqlite"), calls: join(dir, "calls.jsonl"),
    remote: join(dir, "remote.json"), cli: join(dir, "fake-lark-cli.mjs"),
    audit: join(dir, "spawn-audit.jsonl"), preload: join(dir, "audit-spawn.cjs") };
  sql(value.db, `
    CREATE TABLE sync_scopes (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, config_json TEXT NOT NULL);
    CREATE TABLE sync_locks (scope_id TEXT PRIMARY KEY);
    CREATE TABLE maintenance_locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL,
      acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '');
    CREATE TABLE records (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, first_seen_scope_id TEXT NOT NULL,
      external_id TEXT NOT NULL, external_version TEXT, content_hash TEXT, actor_id TEXT,
      container_id TEXT, body TEXT NOT NULL, canonical_json TEXT NOT NULL, raw_json TEXT NOT NULL,
      record_type TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL, updated_at TEXT);
    INSERT INTO sync_scopes VALUES ('lark.im.sent_by_me', 'lark.im', '{}');
  `);
  setRemote(value, remote);
  writeFileSync(value.cli, `#!/usr/bin/env node
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const cfg = JSON.parse(readFileSync(${JSON.stringify(value.remote)}, 'utf8'));
const args = process.argv.slice(2);
const at = flag => args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined;
const params = at('--params') ? JSON.parse(at('--params')) : {};
const previous = existsSync(${JSON.stringify(value.calls)})
  ? readFileSync(${JSON.stringify(value.calls)}, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];
const kind = args[0] === 'contact' && args[1] === '+search-user' ? 'contact'
  : args[0] === 'im' && args[1] === 'chat.members' && args[2] === 'get' ? 'members' : 'unexpected';
appendFileSync(${JSON.stringify(value.calls)}, JSON.stringify({kind, args, params, userIds:at('--user-ids') || null}) + '\\n');
const locks = spawnSync('/usr/bin/sqlite3', ['-readonly', ${JSON.stringify(value.db)}, 'SELECT count(*) FROM maintenance_locks;'], {encoding:'utf8'});
if (locks.status !== 0 || locks.stdout.trim() !== '0') {
  process.stderr.write('synthetic assertion: remote lookup held a maintenance lock'); process.exit(9);
}
if (cfg.mutateSql && previous.length === 0) {
  const changed = spawnSync('/usr/bin/sqlite3', [${JSON.stringify(value.db)}], {input:'.bail on\\n' + cfg.mutateSql, encoding:'utf8'});
  if (changed.status !== 0) { process.stderr.write(changed.stderr); process.exit(9); }
}
const deny = () => { process.stderr.write('synthetic permission denied PRIVATE_REMOTE_DIAGNOSTIC'); process.exit(1); };
if (kind === 'contact') {
  if (cfg.contact === 'deny') deny();
  const name = cfg.contact === 'echo' ? ${JSON.stringify(TARGET)} : ${JSON.stringify(PERSON)};
  const users = cfg.contact === 'empty' ? [] : cfg.contactUsers || [{open_id:${JSON.stringify(TARGET)}, name}];
  process.stdout.write(JSON.stringify({users}));
} else if (kind === 'members') {
  if (cfg.members === 'deny' || !cfg.members) deny();
  const seen = previous.filter(call => call.kind === 'members' && call.params.chat_id === params.chat_id).length;
  const mode = cfg.membersByChat?.[params.chat_id] || cfg.members;
  const match = mode === 'success' || (mode === 'late-success' && seen === 4);
  const items = match ? [{member_id:cfg.memberId || ${JSON.stringify(TARGET)}, name:cfg.memberName || ${JSON.stringify(PERSON)}}]
    : Array.from({length:100}, (_, index) => ({member_id:'ou_synthetic_unrelated_' + seen + '_' + index, name:'Unrelated Synthetic Member'}));
  const has_more = mode === 'forever' || (mode === 'late-success' && !match);
  process.stdout.write(JSON.stringify({items, has_more, page_token:has_more ? 'synthetic_page_' + (seen + 1) : ''}));
} else {
  process.stderr.write('synthetic assertion: unrelated remote command'); process.exit(9);
}
`);
  chmodSync(value.cli, 0o755);
  // Observe the real subprocess timeout passed by the command without changing
  // its source, transport, clock, return values, or execution duration.
  writeFileSync(value.preload, `
const cp = require('node:child_process');
const fs = require('node:fs');
const original = cp.spawnSync;
cp.spawnSync = function(command, args, options) {
  if (command === ${JSON.stringify(value.cli)}) fs.appendFileSync(${JSON.stringify(value.audit)}, JSON.stringify({timeout:options?.timeout}) + '\\n');
  return original.apply(this, arguments);
};
require('node:module').syncBuiltinESMExports();
`);
  return value;
}

function insertRow(fixture, { id = 1, ordinal = id, actor = TARGET, chat = CHAT,
  name = null, canonical = {}, rawSender = {}, raw = {}, row = {} } = {}) {
  const when = EPOCH + ordinal * 1000;
  const message = { message_id: `om_synthetic_sender_${id}`, chat_id: chat,
    msg_type: "text", create_time: String(when), update_time: String(when + 117),
    sender: { id: actor, id_type: "open_id", sender_type: "user", ...rawSender },
    body: { content: JSON.stringify({ text: `Synthetic ${id} folds three blue triangles.` }) },
    ...raw };
  const canonicalValue = { message_id: message.message_id, msg_type: message.msg_type,
    sender_id: actor, sender_type: "user", sender_id_type: "open_id", sender_name: name,
    chat_id: chat, chat_type: "group", chat_name: null,
    chat_partner: { open_id: OTHER, name: null },
    content: { text: "Synthetic canonical material remains exact." },
    retained: { labels: ["cyan", 3], explanation: "No sender lookup may rewrite this object." },
    ...canonical };
  const rawJson = JSON.stringify(message);
  const values = { id, source_id: "lark.im", first_seen_scope_id: "lark.im.sent_by_me",
    external_id: message.message_id, external_version: message.update_time,
    content_hash: createHash("sha256").update(rawJson).digest("hex"), actor_id: actor,
    container_id: chat, body: `Synthetic stored body ${id}.`, canonical_json: JSON.stringify(canonicalValue),
    raw_json: rawJson, record_type: "lark.im.message", occurred_at_ms: when,
    updated_at: new Date(when + 321).toISOString(), ...row };
  sql(fixture.db, `INSERT INTO records (${Object.keys(values).join(",")}) VALUES (${Object.values(values).map(sqlString).join(",")});`);
  return values;
}

function run(fixture, args = [], { exactArgs = false, audit = false } = {}) {
  const result = spawnSync(process.execPath, ["tests/helpers/enrichment-cli.mjs", fixture.dir, "maintenance", "enrich", "--target", "records", "--format", "json", "--db", fixture.db,
    ...(exactArgs ? [] : ["--sender-only", "--sender-id", TARGET]),
    ...(args.includes("--dry-run") ? [] : ["--apply"]), ...args.filter((arg) => arg !== "--dry-run")], {
    cwd: process.cwd(), encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 40_000,
    env: { PATH: SAFE_PATH, HOME: join(fixture.dir, "home"), XDG_CONFIG_HOME: join(fixture.dir, "config"),
      XDG_CACHE_HOME: join(fixture.dir, "cache"), XDG_DATA_HOME: join(fixture.dir, "data"),
      TMPDIR: join(fixture.dir, "tmp"), LANG: "C", TZ: "UTC", LARK_CLI: fixture.cli,
      ...(audit ? { NODE_OPTIONS: `--require=${fixture.preload}` } : {}) },
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function summary(result, status = 0) {
  assert.equal(result.status, status, `${result.stderr}\n${result.stdout}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, "sender-only");
  for (const field of ["scanned", "planned", "updated", "skipped_conflicts", "resolved", "unresolved"])
    assert.ok(Number.isSafeInteger(output[field]) && output[field] >= 0, `${field}: ${result.stdout}`);
  assert.equal(typeof output.has_more_candidates, "boolean");
  assert.doesNotMatch(result.stdout + result.stderr, /ou_synthetic_|oc_synthetic_|om_synthetic_|Synthetic Ceramic Reader|PRIVATE_REMOTE_DIAGNOSTIC/);
  return output;
}

function assertSenderWrite(before, after, expectedSource = null) {
  for (const field of Object.keys(before)) {
    if (!["canonical_json", "updated_at"].includes(field)) assert.equal(after[field], before[field], field);
  }
  const old = JSON.parse(before.canonical_json);
  const next = JSON.parse(after.canonical_json);
  const strip = value => Object.fromEntries(Object.entries(value).filter(([key]) => !SENDER_FIELDS.has(key)));
  assert.deepEqual(strip(next), strip(old), "non-sender canonical fields must remain unchanged");
  assert.equal(next.sender_id_type, "open_id");
  assert.equal(next.sender_name, PERSON);
  if (expectedSource) assert.equal(next.sender_name_source, expectedSource);
  else assert.ok(["contact", "chat_member"].includes(next.sender_name_source));
  assert.equal(next.sender_name_confidence, "high");
  assert.notEqual(after.updated_at, before.updated_at);
}

function assertTargetCalls(fixture) {
  const calls = callLog(fixture);
  const targetChats = new Set(readRows(fixture).filter(row => row.actor_id === TARGET).map(row => row.container_id));
  for (const call of calls) {
    assert.ok(["contact", "members"].includes(call.kind), JSON.stringify(call));
    if (call.kind === "contact") assert.equal(call.userIds, TARGET);
    if (call.kind === "members") {
      assert.equal(call.params.member_id_type, "open_id");
      assert.ok(call.params.page_size > 0 && call.params.page_size <= 100);
      assert.ok(targetChats.has(call.params.chat_id), "member lookup must belong to the selected sender's local chat");
    }
  }
  return calls;
}

test("sender filtering precedes limit and reaches an old target without touching newer named or unrelated records", (t) => {
  const f = fixture(t);
  insertRow(f, { id: 1, ordinal: 1, canonical: { sender_id_type: undefined } });
  insertRow(f, { id: 2, ordinal: 100, name: "Known Synthetic Sender" });
  insertRow(f, { id: 3, ordinal: 200, actor: OTHER });
  const before = readRows(f);
  const output = summary(run(f, ["--limit", "1"]));
  assert.equal(existsSync(join(f.dir, "api-state", "api.lock")), true, "real API lease belongs to the synthetic fixture");
  assert.equal(output.scanned, 1);
  assert.equal(output.planned, 1);
  assert.equal(output.updated, 1);
  assert.equal(output.resolved, 1);
  assert.equal(output.unresolved, 0);
  assert.equal(output.skipped_conflicts, 0);
  assert.equal(output.has_more_candidates, false);
  const after = readRows(f);
  assertSenderWrite(before[0], after[0]);
  assert.deepEqual(after.slice(1), before.slice(1));
  const calls = assertTargetCalls(f);
  assert.deepEqual(calls.map(call => call.kind), ["contact"]);
});

test("oldest-first limited batches expose remaining candidates and reach the next record on rerun", (t) => {
  const f = fixture(t);
  insertRow(f, { id: 1, ordinal: 100 });
  insertRow(f, { id: 2, ordinal: 1 });
  const before = readRows(f);
  const first = summary(run(f, ["--limit", "1"]), 2);
  assert.equal(first.scanned, 1);
  assert.equal(first.updated, 1);
  assert.equal(first.has_more_candidates, true);
  let after = readRows(f);
  assert.deepEqual(after[0], before[0]);
  assertSenderWrite(before[1], after[1]);
  const second = summary(run(f, ["--limit", "1"]));
  assert.equal(second.updated, 1);
  assert.equal(second.has_more_candidates, false);
  after = readRows(f);
  assertSenderWrite(before[0], after[0]);
});

for (const [label, canonical] of [
  ["missing", { sender_name: undefined }], ["null", { sender_name: null }],
  ["empty", { sender_name: "" }], ["blank", { sender_name: "   " }],
  ["an ID placeholder", { sender_name: TARGET }],
]) {
  test(`a canonical sender name that is ${label} is eligible`, (t) => {
    const f = fixture(t);
    insertRow(f, { canonical });
    const before = readRows(f)[0];
    assert.equal(summary(run(f)).updated, 1);
    assertSenderWrite(before, readRows(f)[0]);
  });
}

test("type evidence, sender identity and missing-state gates exclude non-target rows before any remote work", (t) => {
  const f = fixture(t);
  const excluded = [
    { name: "Known Synthetic Name" },
    { canonical: { sender_name_state: "cleared" } },
    { rawSender: { id_type: "user_id" } },
    { rawSender: { id_type: undefined } },
    { rawSender: { id: OTHER } },
    { canonical: { sender_id: OTHER } },
    { actor: OTHER },
    { canonical: { sender_id_type: "user_id" } },
    { rawSender: { sender_type: "app" } },
    { canonical: { sender_type: "app" } },
    { raw: { msg_type: "system" }, canonical: { msg_type: "system" } },
    { raw: { msg_type: "system" }, canonical: { msg_type: "text" } },
    { canonical: { msg_type: "system" } },
    { row: { source_id: "synthetic.other" } },
    { row: { record_type: "synthetic.other" } },
  ];
  excluded.forEach((row, index) => insertRow(f, { id: index + 1, ...row }));
  const before = readFileSync(f.db);
  const output = summary(run(f));
  assert.equal(output.scanned, 0);
  assert.equal(output.updated, 0);
  assert.equal(output.has_more_candidates, false);
  assert.deepEqual(callLog(f), []);
  assert.deepEqual(readFileSync(f.db), before);
});

test("a contact ID echo falls back to this sender's chat membership and never becomes its name", (t) => {
  const f = fixture(t, { contact: "echo", members: "success" });
  insertRow(f);
  const before = readRows(f)[0];
  assert.equal(summary(run(f)).updated, 1);
  const after = readRows(f)[0];
  assertSenderWrite(before, after);
  assert.equal(JSON.parse(after.canonical_json).sender_name_source, "chat_member");
  const calls = assertTargetCalls(f);
  assert.deepEqual(calls.map(call => call.kind), ["contact", "members"]);
  assert.equal(calls[1].params.chat_id, CHAT);
});

test("failed name lookups leave the exact record unchanged, then recover at the same source version and become idempotent", (t) => {
  const f = fixture(t, { contact: "deny", members: "deny" });
  insertRow(f);
  const before = readRows(f);
  const failed = summary(run(f), 2);
  assert.equal(failed.unresolved, 1);
  assert.equal(failed.resolved, 0);
  assert.equal(failed.planned, 0);
  assert.equal(failed.updated, 0);
  assert.deepEqual(readRows(f), before);
  setRemote(f, { contact: "success" });
  const recovered = summary(run(f));
  assert.equal(recovered.updated, 1);
  const after = readRows(f);
  assertSenderWrite(before[0], after[0]);
  const callsBefore = callLog(f).length;
  const again = summary(run(f));
  assert.equal(again.scanned, 0);
  assert.equal(again.updated, 0);
  assert.equal(callLog(f).length, callsBefore);
  assert.deepEqual(readRows(f), after);
});

test("lookup responses for unrelated identities cannot supply the selected sender name", (t) => {
  const f = fixture(t, { contact: "success", contactUsers: [{ open_id: OTHER, name: PERSON }], members: "deny" });
  insertRow(f);
  const before = readRows(f);
  const output = summary(run(f), 2);
  assert.equal(output.unresolved, 1);
  assert.equal(output.updated, 0);
  assert.deepEqual(readRows(f), before);
  assertTargetCalls(f);
});

for (const [label, response] of [
  ["an unrelated member", { memberId: OTHER }],
  ["a member name that only echoes its ID", { memberName: TARGET }],
]) {
  test(`${label} cannot resolve the selected sender`, (t) => {
    const f = fixture(t, { contact: "empty", members: "success", ...response });
    insertRow(f);
    const before = readRows(f);
    const output = summary(run(f), 2);
    assert.equal(output.unresolved, 1);
    assert.equal(output.resolved, 0);
    assert.equal(output.updated, 0);
    assert.deepEqual(readRows(f), before);
    assertTargetCalls(f);
  });
}

test("sender-only success changes neither unrelated canonical fields nor any source/body/chat/partner columns", (t) => {
  const f = fixture(t);
  insertRow(f, { raw: { deleted: true }, canonical: { deleted: undefined },
    row: { body: "[Invalid post JSON]" } });
  const before = readRows(f)[0];
  assert.equal(summary(run(f)).updated, 1);
  assertSenderWrite(before, readRows(f)[0]);
  assert.deepEqual(assertTargetCalls(f).map(call => call.kind), ["contact"]);
});

test("a member list still continuing after five pages stays unresolved without unbounded traversal", (t) => {
  const f = fixture(t, { contact: "empty", members: "forever" });
  insertRow(f);
  const before = readRows(f);
  const output = summary(run(f, [], { audit: true }), 2);
  assert.equal(output.unresolved, 1);
  assert.equal(output.updated, 0);
  assert.deepEqual(readRows(f), before);
  const calls = assertTargetCalls(f);
  assert.equal(calls.filter(call => call.kind === "members").length, 5);
  const tokens = calls.filter(call => call.kind === "members").map(call => call.params.page_token || "");
  assert.equal(new Set(tokens).size, 5);
  const audit = readFileSync(f.audit, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(audit.length, calls.length);
  for (const attempt of audit) assert.ok(attempt.timeout > 0 && attempt.timeout <= 5000, JSON.stringify(attempt));
});

test("a target found on the fifth allowed member page resolves without fetching a sixth", (t) => {
  const f = fixture(t, { contact: "empty", members: "late-success" });
  insertRow(f);
  assert.equal(summary(run(f)).updated, 1);
  assert.equal(assertTargetCalls(f).filter(call => call.kind === "members").length, 5);
});

test("the five-page member budget is shared across all chats in a round", (t) => {
  const firstChat = "oc_synthetic_budget_first";
  const secondChat = "oc_synthetic_budget_second";
  const f = fixture(t, { contact: "empty", members: "forever" });
  insertRow(f, { id: 1, chat: firstChat });
  insertRow(f, { id: 2, chat: secondChat });
  const output = summary(run(f), 2);
  assert.equal(output.updated, 0);
  const members = assertTargetCalls(f).filter(call => call.kind === "members");
  assert.equal(members.length, 5);
  assert.ok(members.every(call => [firstChat, secondChat].includes(call.params.chat_id)));
});

test("at most three distinct chats are queried for one sender in a round", (t) => {
  const f = fixture(t, { contact: "empty", members: "empty" });
  for (let id = 1; id <= 5; id += 1) insertRow(f, { id, chat: `oc_synthetic_budget_chat_${id}` });
  const output = summary(run(f), 2);
  assert.equal(output.updated, 0);
  const members = assertTargetCalls(f).filter(call => call.kind === "members");
  assert.equal(members.length, 3);
  assert.equal(new Set(members.map(call => call.params.chat_id)).size, 3);
});

test("dry-run resolves the exact target but writes no database bytes or maintenance locks", (t) => {
  const f = fixture(t);
  insertRow(f);
  const before = readFileSync(f.db);
  const output = summary(run(f, ["--dry-run"]));
  assert.equal(output.scanned, 1);
  assert.equal(output.planned, 1);
  assert.equal(output.updated, 0);
  assert.deepEqual(readFileSync(f.db), before);
  assert.deepEqual(sql(f.db, "SELECT * FROM maintenance_locks;", true), []);
  assert.deepEqual(assertTargetCalls(f).map(call => call.kind), ["contact"]);
});

for (const [label, mutation, field, expected] of [
  ["source version", "external_version = '9876543210123'", "external_version", "9876543210123"],
  ["body", "body = 'Synthetic concurrently edited body.'", "body", "Synthetic concurrently edited body."],
  ["sender identity", `actor_id = ${sqlString(OTHER)}`, "actor_id", OTHER],
]) {
  test(`CAS skips a record whose ${label} changed during remote lookup`, (t) => {
    const f = fixture(t, { contact: "success", mutateSql: `UPDATE records SET ${mutation} WHERE id=1;` });
    insertRow(f);
    const before = readRows(f)[0];
    const output = summary(run(f), 2);
    assert.equal(output.skipped_conflicts, 1, JSON.stringify(output));
    assert.equal(output.updated, 0);
    assert.deepEqual(readRows(f)[0], { ...before, [field]: expected });
    assert.deepEqual(sql(f.db, "SELECT * FROM maintenance_locks;", true), []);
  });
}

test("an active sync lock blocks sender writes without deleting or bypassing that lock", (t) => {
  const f = fixture(t, { contact: "success", mutateSql: "INSERT INTO sync_locks VALUES ('synthetic-active-scope');" });
  insertRow(f);
  const before = readRows(f);
  const result = run(f);
  assert.equal(result.status, 1);
  assert.deepEqual(readRows(f), before);
  assert.equal(sql(f.db, "SELECT count(*) AS n FROM sync_locks;", true)[0].n, 1);
  assert.deepEqual(sql(f.db, "SELECT * FROM maintenance_locks;", true), []);
});

test("sender-only defaults to fifty eligible rows and honestly reports more candidates", (t) => {
  const f = fixture(t);
  for (let id = 1; id <= 51; id += 1) insertRow(f, { id });
  const output = summary(run(f), 2);
  assert.equal(output.scanned, 50);
  assert.equal(output.updated, 50);
  assert.equal(output.has_more_candidates, true);
  assert.equal(JSON.parse(readRows(f)[50].canonical_json).sender_name, null);
});

for (const args of [
  ["--sender-only"], ["--sender-id", TARGET], ["--sender-only", "--sender-id", "user_synthetic_other"],
  ["--sender-only", "--sender-id", "ou_"], ["--sender-only", "--sender-id", TARGET, "--limit", "0"],
  ["--sender-only", "--sender-id", TARGET, "--limit", "101"],
  ["--sender-only", "--sender-id", TARGET, "--limit", "1.5"],
]) {
  test(`invalid sender-only arguments fail before network or writes: ${args.join(" ")}`, (t) => {
    const f = fixture(t);
    insertRow(f);
    const before = readFileSync(f.db);
    const result = run(f, args, { exactArgs: true });
    assert.equal(result.status, 1);
    assert.deepEqual(callLog(f), []);
    assert.deepEqual(readFileSync(f.db), before);
  });
}

const SOURCE_ALIASES = Object.freeze({
  open_id: TARGET, user_id: "synthetic_ceramic_user_alias", union_id: "synthetic_ceramic_union_alias",
});

for (const aliasType of ["user_id", "union_id"]) {
  test(`sender alias ${aliasType} already in canonical sender_name is selected and corrected`, (t) => {
    const f = fixture(t);
    insertRow(f, { name: SOURCE_ALIASES[aliasType], rawSender: { ...SOURCE_ALIASES },
      canonical: { sender_name_source: "contact", sender_name_confidence: "high" } });
    const before = readRows(f)[0];
    const output = summary(run(f));
    assert.equal(output.scanned, 1);
    assert.equal(output.updated, 1);
    assertSenderWrite(before, readRows(f)[0], "contact");
    assert.deepEqual(assertTargetCalls(f).map(call => call.kind), ["contact"]);
  });
}

test("sender alias already in canonical sender_name is corrected using only nested typed identities", (t) => {
  const f = fixture(t);
  insertRow(f, { name: SOURCE_ALIASES.user_id,
    rawSender: { id: undefined, id_type: undefined, sender_id: { ...SOURCE_ALIASES } } });
  const before = readRows(f)[0];
  const output = summary(run(f));
  assert.equal(output.scanned, 1);
  assert.equal(output.updated, 1);
  assertSenderWrite(before, readRows(f)[0], "contact");
  assert.deepEqual(assertTargetCalls(f).map(call => call.kind), ["contact"]);
});

test("sender alias evidence does not select an existing genuine canonical sender_name", (t) => {
  const f = fixture(t);
  insertRow(f, { name: PERSON, rawSender: { ...SOURCE_ALIASES } });
  const before = readRows(f);
  assert.equal(summary(run(f)).scanned, 0);
  assert.deepEqual(readRows(f), before);
  assert.deepEqual(callLog(f), []);
});

for (const [aliasType, alias] of Object.entries(SOURCE_ALIASES)) {
  for (const field of ["name", "display_name"]) {
    test(`sender alias ${aliasType} echoed in raw ${field} stays unknown until the reliable open-ID lookup resolves it`, (t) => {
      const f = fixture(t);
      insertRow(f, { rawSender: { ...SOURCE_ALIASES, [field]: alias } });
      const before = readRows(f)[0];
      const output = summary(run(f));
      assert.equal(output.updated, 1);
      assertSenderWrite(before, readRows(f)[0], "contact");
      assert.deepEqual(assertTargetCalls(f).map(call => call.kind), ["contact"]);
    });
  }
  test(`sender alias ${aliasType} in raw name cannot hide a genuine display_name`, (t) => {
    const f = fixture(t);
    insertRow(f, { rawSender: { ...SOURCE_ALIASES, name: alias, display_name: PERSON } });
    const before = readRows(f)[0];
    assert.equal(summary(run(f)).updated, 1);
    assertSenderWrite(before, readRows(f)[0], "message_sender");
    assert.deepEqual(callLog(f), []);
  });
}

test("sender alias remains unknown after denied lookup and recovers later without changing any source facts", (t) => {
  const f = fixture(t, { contact: "deny", members: "deny" });
  insertRow(f, { rawSender: { ...SOURCE_ALIASES, name: SOURCE_ALIASES.user_id, display_name: SOURCE_ALIASES.union_id } });
  const before = readRows(f)[0];
  const denied = summary(run(f), 2);
  assert.equal(denied.unresolved, 1);
  assert.equal(denied.updated, 0);
  assert.deepEqual(readRows(f)[0], before);
  setRemote(f, { contact: "success" });
  assert.equal(summary(run(f)).updated, 1);
  assertSenderWrite(before, readRows(f)[0], "contact");
});

test("sender alias correction obeys CAS if source version changes during the reliable lookup", (t) => {
  const changedVersion = "9876543210456";
  const f = fixture(t, { contact: "success", mutateSql: `UPDATE records SET external_version='${changedVersion}' WHERE id=1;` });
  insertRow(f, { rawSender: { ...SOURCE_ALIASES, name: SOURCE_ALIASES.user_id } });
  const before = readRows(f)[0];
  const output = summary(run(f), 2);
  assert.equal(output.skipped_conflicts, 1);
  assert.equal(output.updated, 0);
  assert.deepEqual(readRows(f)[0], { ...before, external_version: changedVersion });
  assert.deepEqual(assertTargetCalls(f).map(call => call.kind), ["contact"]);
});

test("sender alias in a nested typed sender_id uses its explicit open_id for correction", (t) => {
  const f = fixture(t);
  insertRow(f, { rawSender: { id: undefined, id_type: undefined,
    sender_id: { ...SOURCE_ALIASES }, name: SOURCE_ALIASES.user_id } });
  const before = readRows(f)[0];
  assert.equal(summary(run(f)).updated, 1);
  assertSenderWrite(before, readRows(f)[0], "contact");
  assert.deepEqual(assertTargetCalls(f).map(call => call.kind), ["contact"]);
});

for (const type of ["user_id", "union_id"]) {
  for (const nested of [false, true]) {
    test(`sender alias with only ${nested ? "nested " : ""}${type} evidence never authorizes open-ID lookup`, (t) => {
      const f = fixture(t);
      const evidence = { [type]: TARGET };
      insertRow(f, { rawSender: { id: undefined, id_type: undefined,
        ...(nested ? { sender_id: evidence } : evidence) }, canonical: { sender_id_type: type } });
      const before = readRows(f);
      const output = summary(run(f));
      assert.equal(output.scanned, 0);
      assert.equal(output.updated, 0);
      assert.deepEqual(callLog(f), []);
      assert.deepEqual(readRows(f), before);
    });
  }
}

// Added after the original 9b8e750 RED capture: remote responses may omit the
// alternate-ID fields, but the original message still proves these are aliases.
test("sender remote alias contact echo without alias fields falls back to a genuine member name", (t) => {
  const f = fixture(t, { contactUsers: [{ open_id: TARGET, name: SOURCE_ALIASES.user_id }], members: "success" });
  insertRow(f, { rawSender: { ...SOURCE_ALIASES } });
  const before = readRows(f)[0];
  assert.equal(summary(run(f)).updated, 1);
  assertSenderWrite(before, readRows(f)[0], "chat_member");
  assert.deepEqual(assertTargetCalls(f).map(call => call.kind), ["contact", "members"]);
});

test("sender remote alias echoes from contact and member remain unwritten and can recover next run", (t) => {
  const f = fixture(t, { contactUsers: [{ open_id: TARGET, name: SOURCE_ALIASES.user_id }],
    members: "success", memberName: SOURCE_ALIASES.union_id });
  insertRow(f, { rawSender: { ...SOURCE_ALIASES } });
  const before = readRows(f)[0];
  const unresolved = summary(run(f), 2);
  assert.equal(unresolved.unresolved, 1);
  assert.equal(unresolved.updated, 0);
  assert.deepEqual(readRows(f)[0], before);
  assert.deepEqual(assertTargetCalls(f).map(call => call.kind), ["contact", "members"]);
  setRemote(f, { contact: "success" });
  assert.equal(summary(run(f)).updated, 1);
  assertSenderWrite(before, readRows(f)[0], "contact");
});

test("sender remote alias member echo is unknown even when contact returns no person", (t) => {
  const f = fixture(t, { contact: "empty", members: "success", memberName: SOURCE_ALIASES.user_id });
  insertRow(f, { rawSender: { ...SOURCE_ALIASES } });
  const before = readRows(f)[0];
  const output = summary(run(f), 2);
  assert.equal(output.unresolved, 1);
  assert.equal(output.updated, 0);
  assert.deepEqual(readRows(f)[0], before);
  assert.deepEqual(assertTargetCalls(f).map(call => call.kind), ["contact", "members"]);
});
