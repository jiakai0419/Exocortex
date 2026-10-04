import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ensureInitialized, readScope, createRun, succeedRecordRun, sqliteQuery, sqliteExec, upsertRecordsSql }
  from "../dist/storage/sqlite/ingestion-store.js";
import { recordFromMessage } from "../src/adapters/lark-im/message-record.mjs";
import { createNameResolver } from "../src/adapters/lark-im/name-resolver.mjs";

// New synthetic identities and content, composed without captured source data.
const EPOCH = Date.UTC(2044, 3, 5, 6, 7, 8);
const scopeId = "lark.im.sent_by_me";
const person = "ou_fixture_clock_builder";
const partner = "ou_fixture_clock_reader";
const room = "oc_fixture_clock_studio";
function message(overrides = {}) {
  return { message_id: "om_fixture_clock_draft", create_time: String(EPOCH), update_time: String(EPOCH + 500),
    sender: { id: person, sender_type: "user" }, chat_id: room, chat_type: "p2p",
    chat_partner: { open_id: partner }, content: { text: "Arrange nine wooden clock hands." }, ...overrides };
}
function candidate(context = {}, source = message()) {
  return recordFromMessage(source, scopeId, "sent", context);
}
function knownContext() {
  return { contacts: new Map([[person, "Clock Builder"], [partner, "Clock Reader"]]) };
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-name-projection-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "synthetic.sqlite");
  ensureInitialized(db);
  return db;
}
function write(db, record) {
  const scope = readScope(db, scopeId);
  const runId = createRun(db, scope, { fixture: true });
  return succeedRecordRun(db, scope, runId, [record], 1,
    { kind: "test.cursor/v1", occurred_at_ms: EPOCH }, {});
}
function stored(db) { return sqliteQuery(db, "SELECT * FROM records;", "read synthetic record")[0]; }
function project(record, fields) {
  return { ...record, canonical_json: JSON.stringify({ ...JSON.parse(record.canonical_json), ...fields }) };
}

test("lookup success then permission failure preserves names and provenance at identical raw/hash/version with updated=0", (t) => {
  const db = fixture(t);
  let denied = false;
  let now = 0;
  let failures = 0;
  const resolver = createNameResolver({ now: () => now, run: () => {
    if (denied) { failures += 1; throw new Error("synthetic permission denied"); }
    return { users: [{ open_id: person, name: "Clock Builder" }, { open_id: partner, name: "Clock Reader" }] };
  } });
  const first = candidate(resolver.buildPeopleContext([message()], {}, null));
  assert.deepEqual(write(db, first), { inserted: 1, updated: 0, duplicate: 0 });
  const before = stored(db);
  denied = true;
  now += 6 * 60 * 1000;
  const second = candidate(resolver.buildPeopleContext([message()], {}, null));
  assert.ok(failures > 0);
  for (const key of ["raw_json", "content_hash", "external_version", "body"]) assert.equal(second[key], first[key]);
  assert.equal(JSON.parse(second.canonical_json).sender_name, null);
  assert.deepEqual(write(db, second), { inserted: 0, updated: 0, duplicate: 1 });
  assert.deepEqual(stored(db), before);
});

test("same-version lookup improvement and rename update once without changing source facts", (t) => {
  const db = fixture(t);
  const raw = candidate();
  write(db, raw);
  const enriched = candidate(knownContext());
  assert.deepEqual(write(db, enriched), { inserted: 0, updated: 1, duplicate: 0 });
  assert.deepEqual(write(db, enriched), { inserted: 0, updated: 0, duplicate: 1 });
  const renamed = candidate({ contacts: new Map([[person, "Clock Designer"], [partner, "Clock Reader"]]) });
  assert.equal(write(db, renamed).updated, 1);
  const row = stored(db);
  for (const field of ["raw_json", "content_hash", "external_version", "body"]) assert.equal(row[field], raw[field]);
  assert.equal(JSON.parse(row.canonical_json).sender_name, "Clock Designer");
});

test("authoritative clear survives later unknown lookup but later resolved name can replace it", (t) => {
  const db = fixture(t);
  write(db, candidate(knownContext()));
  const clear = candidate({ contacts: new Map([[person, { state: "cleared", source: "synthetic_authority" }],
    [partner, { state: "cleared", source: "synthetic_authority" }]]) });
  assert.equal(JSON.parse(clear.canonical_json).sender_name_state, "cleared");
  assert.equal(JSON.parse(clear.canonical_json).chat_partner.name_state, "cleared");
  assert.equal(write(db, clear).updated, 1);
  const before = stored(db);
  assert.deepEqual(write(db, candidate()), { inserted: 0, updated: 0, duplicate: 1 });
  assert.deepEqual(stored(db), before);
  assert.equal(write(db, candidate(knownContext())).updated, 1);
  const canonical = JSON.parse(stored(db).canonical_json);
  assert.equal(canonical.sender_name, "Clock Builder");
  assert.equal(canonical.sender_name_state, undefined);
  assert.equal(canonical.chat_partner.name_state, undefined);
});

test("unknown chat and partner names are retained only for matching identities", (t) => {
  const db = fixture(t);
  write(db, project(candidate(knownContext()), { chat_name: "Clock Studio" }));
  assert.equal(write(db, candidate()).updated, 0);
  const changed = candidate({}, message({ update_time: String(EPOCH + 1000),
    sender: { id: "ou_fixture_other_builder", sender_type: "user" },
    chat_id: "oc_fixture_clock_gallery", chat_partner: { open_id: "ou_fixture_other_reader" } }));
  assert.equal(write(db, changed).updated, 1);
  const row = stored(db);
  const canonical = JSON.parse(row.canonical_json);
  assert.equal(canonical.sender_name, null);
  assert.equal(canonical.chat_name, null);
  assert.equal(canonical.chat_partner.name, null);
  assert.equal(row.raw_json, changed.raw_json);
});

test("canonical identities inconsistent with record columns never inherit names", (t) => {
  const db = fixture(t);
  write(db, project(candidate(knownContext()), { chat_name: "Clock Studio" }));
  const mismatched = project(candidate(), { sender_id: "ou_fixture_unmatched", chat_id: "oc_fixture_unmatched" });
  assert.equal(write(db, mismatched).updated, 1);
  const canonical = JSON.parse(stored(db).canonical_json);
  assert.equal(canonical.sender_name, null);
  assert.equal(canonical.chat_name, null);
  assert.equal(canonical.chat_partner.name, null);
});

test("older source versions cannot improve projection or clear current names", (t) => {
  const db = fixture(t);
  write(db, candidate(knownContext()));
  const before = stored(db);
  const older = candidate({ contacts: new Map([[person, { state: "cleared" }]]) },
    message({ update_time: String(EPOCH + 100) }));
  assert.deepEqual(write(db, older), { inserted: 0, updated: 0, duplicate: 1 });
  assert.deepEqual(stored(db), before);
});

test("plain record upsert uses the same Lark name merge while other record types keep replacement semantics", (t) => {
  const db = fixture(t);
  write(db, candidate(knownContext()));
  const before = stored(db);
  sqliteExec(db, upsertRecordsSql([candidate()]), "unknown name upsert");
  assert.deepEqual(stored(db), before);
  const differentType = { ...candidate(), record_type: "synthetic.other" };
  sqliteExec(db, upsertRecordsSql([differentType]), "other type upsert");
  assert.equal(JSON.parse(stored(db).canonical_json).sender_name, null);
});

test("matching actor in a different container cannot inherit a scoped sender name", (t) => {
  const db = fixture(t);
  write(db, candidate({ chat_members: new Map([[`${room}:${person}`, "Studio Timekeeper"]]) }));
  const changed = candidate({}, message({ chat_id: "oc_fixture_clock_annex" }));
  assert.equal(write(db, changed).updated, 1);
  assert.equal(JSON.parse(stored(db).canonical_json).sender_name, null);
});

// Run blocking SQLite work outside this test process: node:test timers cannot
// interrupt spawnSync. The real deadline kills this owned process group only,
// including any synthetic SQLite descendant that is still blocked.
function runBoundedChild(source, directory, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: directory, detached: true,
      env: { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
        HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory,
        XDG_DATA_HOME: directory, TMPDIR: directory, TZ: "UTC", LANG: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") reject(error); }
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
  });
}

function childDirectory(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-name-child-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const storeModule = new URL("../dist/storage/sqlite/ingestion-store.js", import.meta.url).href;
const recordModule = new URL("../src/adapters/lark-im/message-record.mjs", import.meta.url).href;

test("a hundred synthetic names survive an exact unknown replay under an outer process deadline", async (t) => {
  const dir = childDirectory(t);
  const source = `
    import assert from "node:assert/strict";
    import { ensureInitialized, readScope, createRun, succeedRecordRun, sqliteQuery }
      from ${JSON.stringify(storeModule)};
    import { recordFromMessage } from ${JSON.stringify(recordModule)};
    const db = ${JSON.stringify(join(dir, "synthetic.sqlite"))};
    const scopeId = ${JSON.stringify(scopeId)};
    const epoch = ${EPOCH};
    ensureInitialized(db);
    const messages = Array.from({ length: 100 }, (_, index) => ({
      message_id: 'om_fixture_bounded_batch_' + index, create_time: String(epoch), update_time: String(epoch + 100),
      sender: { id: 'ou_fixture_bounded_maker', sender_type: 'user' }, chat_id: 'oc_fixture_bounded_studio',
      content: { text: 'Synthetic dial position ' + index },
    }));
    const known = { contacts: new Map([['ou_fixture_bounded_maker', 'Bounded Dial Maker']]) };
    function writeBatch(context) {
      const scope = readScope(db, scopeId);
      const runId = createRun(db, scope, { synthetic_batch: true });
      const records = messages.map((item) => recordFromMessage(item, scopeId, 'sent', context));
      return succeedRecordRun(db, scope, runId, records, records.length,
        { kind: 'test.cursor/v1', occurred_at_ms: epoch }, {});
    }
    assert.deepEqual(writeBatch(known), { inserted: 100, updated: 0, duplicate: 0 });
    const before = sqliteQuery(db, 'SELECT canonical_json, updated_at FROM records ORDER BY id;', 'before');
    assert.deepEqual(writeBatch({}), { inserted: 0, updated: 0, duplicate: 100 });
    assert.deepEqual(sqliteQuery(db, 'SELECT canonical_json, updated_at FROM records ORDER BY id;', 'after'), before);
    process.stdout.write('batch-complete');
  `;
  const result = await runBoundedChild(source, dir, 30_000);
  assert.equal(result.timedOut, false, result.stderr);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "batch-complete");
});

test("outer deadline terminates a synthetic child blocked inside spawnSync", async (t) => {
  const result = await runBoundedChild(`
    import { spawnSync } from 'node:child_process';
    process.stdout.write('entered-spawnSync\\n');
    spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)'],
      { stdio: 'ignore' });
    process.stdout.write('unexpected-return');
  `, childDirectory(t), 1_000);
  assert.match(result.stdout, /entered-spawnSync/);
  assert.equal(result.stdout.includes('unexpected-return'), false);
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.equal(result.signal, "SIGKILL");
});

for (const state of ["cleared", "known"]) {
  test(`cached scope chat name cannot replace a ${state} projection at identical raw/hash/version`, (t) => {
    const db = fixture(t);
    const initial = project(candidate(knownContext()), {
      chat_name: state === "known" ? "Current Clock Studio" : null,
      ...(state === "cleared" ? { chat_name_state: "cleared" } : {}),
      chat_name_source: "synthetic_authority",
    });
    write(db, initial);
    const before = stored(db);
    const incoming = recordFromMessage(message(), scopeId, "sent", {},
      { chat_id: room, chat_name: "Historical Clock Studio" });
    assert.equal(JSON.parse(incoming.canonical_json).chat_name_source, "scope_config");
    for (const field of ["raw_json", "content_hash", "external_version", "body"]) assert.equal(incoming[field], initial[field]);
    assert.deepEqual(write(db, incoming), { inserted: 0, updated: 0, duplicate: 1 });
    assert.deepEqual(stored(db), before);
  });
}

test("cached chat name fills unknown once and a fresh same-version message name can replace clear", (t) => {
  const db = fixture(t);
  const initial = candidate();
  write(db, initial);
  const cached = recordFromMessage(message(), scopeId, "sent", {}, { chat_name: "Cached Clock Studio" });
  assert.deepEqual(write(db, cached), { inserted: 0, updated: 1, duplicate: 0 });
  assert.deepEqual(write(db, cached), { inserted: 0, updated: 0, duplicate: 1 });
  for (const field of ["raw_json", "content_hash", "external_version", "body"]) assert.equal(stored(db)[field], initial[field]);
  write(db, project(initial, { chat_name: null, chat_name_state: "cleared", chat_name_source: "synthetic_authority" }));
  const fresh = candidate({}, message({ chat_name: "Fresh Clock Studio" }));
  assert.equal(fresh.external_version, initial.external_version);
  assert.deepEqual(write(db, fresh), { inserted: 0, updated: 1, duplicate: 0 });
  assert.deepEqual(write(db, fresh), { inserted: 0, updated: 0, duplicate: 1 });
  const canonical = JSON.parse(stored(db).canonical_json);
  assert.equal(canonical.chat_name, "Fresh Clock Studio");
  assert.equal(canonical.chat_name_source, "message");
  assert.equal(canonical.chat_name_state, undefined);
});
