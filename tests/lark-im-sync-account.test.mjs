import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../bin/exocortex.mjs";
import { createSyncRunner } from "../src/adapters/lark-im/sync-runner.mjs";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";
import { captureRemoteAccountBinding, readRemoteAccountBinding, recordSuccessfulSyncBinding } from "../src/diagnostics/remote-account-binding.mjs";
import { ensureInitialized, ensureSourceInitialSyncStart, sqliteExec, sqliteQuery } from "../dist/storage/sqlite/ingestion-store.js";

// Invented accounts, messages and database state; no real CLI/API or lease call.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const START = Date.parse("2026-01-01T00:00:00Z");
const A = { open_id: "ou_synthetic_account_a", name: "Invented A" };
const B = { open_id: "ou_synthetic_account_b", name: "Invented B" };
const message = (id, sender, minute = 1) => normalizeApiMessage({
  message_id: id, chat_id: "oc_synthetic_account_a", msg_type: "text",
  create_time: String(START + minute * 60_000), update_time: String(START + minute * 60_000),
  sender: { id: sender, id_type: "open_id", sender_type: "user" },
  body: { content: JSON.stringify({ text: "Invented account boundary message" }) },
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-sync-account-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = { dir, db: join(dir, "synthetic.sqlite"), profile: A, profileError: false,
    profileCalls: 0, apiCalls: 0, sent: [], received: [],
    chats: [{ chat_id: "oc_synthetic_account_a", chat_type: "group", name: "Invented chat" }] };
  f.sidecar = `${f.db}.remote-account-binding.json`;
  f.runner = createSyncRunner({
    fetchSentMessageList: (_self, start, end) => { f.apiCalls++; return {
      messages: f.sent.filter(m => Number(m.create_time) >= start && Number(m.create_time) <= end), detailRoots: [], pages: 1 }; },
    fetchChatMessageList: (_chat, start, end) => { f.apiCalls++; return {
      messages: f.received.filter(m => Number(m.create_time) >= start && Number(m.create_time) <= end), detailRoots: [], pages: 1 }; },
    fetchChatDiscoveryPage: () => { f.apiCalls++; return { chats: f.chats, has_more: false, page_token: "" }; },
    fetchMessageDetails: () => assert.fail("this fixture has no detail debt"),
    buildPeopleContext: () => ({ self: f.profile }),
  });
  return f;
}
async function invoke(f, scope, extra = {}, minute = 4) {
  let stdout = "", stderr = "";
  const code = await runCli(["sync", "--db", f.db, "--scope", scope,
    "--start", new Date(START).toISOString(), "--end", new Date(START + minute * 60_000).toISOString(),
    "--discovery-mode", "reconcile", "--reconcile-interval-hours", "1"], {
    root: ROOT, cwd: f.dir, env: {}, stdout: { write: x => { stdout += x; } }, stderr: { write: x => { stderr += x; } },
    deps: { tryAcquireLarkApiLease: () => ({ state: "acquired", release() {} }),
      getSelfProfile: () => { f.profileCalls++; if (f.profileError) throw new Error("invented profile unavailable"); return f.profile; },
      syncRunner: f.runner, resetTransportStats() {}, getTransportStats: () => ({ calls: 0 }), ...extra },
  });
  return { code, stdout, stderr, summary: stdout ? JSON.parse(stdout) : null };
}
function snapshot(f) {
  const tables = ["sources", "sync_scopes", "sync_runs", "records", "sync_locks", "lark_im_list_progress", "lark_im_detail_tasks"];
  return { tables: Object.fromEntries(tables.map(table => [table, sqliteQuery(f.db, `SELECT * FROM ${table} ORDER BY rowid;`)])),
    sidecar: existsSync(f.sidecar) ? readFileSync(f.sidecar, "utf8") : null };
}

for (const scope of ["sent", "received", "details", "discover", "all"]) {
  test(`bound account switch rejects ${scope} before baseline, API or business writes`, async t => {
    const f = fixture(t); f.sent = [message("om_synthetic_account_a", A.open_id)];
    assert.equal((await invoke(f, "all", {}, 2)).code, 0);
    assert.equal(readRemoteAccountBinding({ db: f.db, selfOpenId: A.open_id }).evidence, "initialized_empty_database");
    f.profile = B;
    assert.equal(readRemoteAccountBinding({ db: f.db, selfOpenId: B.open_id }).state, "conflict");
    f.sent = [message("om_synthetic_b_early", B.open_id), message("om_synthetic_b_late", B.open_id, 3)];
    f.chats = [{ chat_id: "oc_synthetic_account_b", chat_type: "group", name: "Invented other chat" }];
    const before = snapshot(f), calls = f.apiCalls, profiles = f.profileCalls;
    let baselineCalls = 0;
    const result = await invoke(f, scope, { ensureSourceInitialSyncStart: (...args) => {
      baselineCalls++; return ensureSourceInitialSyncStart(...args);
    } });
    assert.equal(result.code, 1); assert.equal(result.stderr, "");
    assert.equal(result.summary.error.code, "execution_failed"); assert.match(result.summary.error.message, /account conflicts/);
    assert.equal(baselineCalls, 0); assert.equal(f.profileCalls, profiles + 1); assert.equal(f.apiCalls, calls);
    assert.deepEqual(snapshot(f), before);
  });
}

test("first successful discovery binds an empty source, and same-account multi-sender work remains valid", async t => {
  const f = fixture(t);
  assert.equal((await invoke(f, "discover")).code, 0);
  assert.equal(readRemoteAccountBinding({ db: f.db, selfOpenId: A.open_id }).evidence, "initialized_empty_database");
  const binding = readFileSync(f.sidecar, "utf8");
  f.received = [message("om_synthetic_received_b", B.open_id), message("om_synthetic_received_c", "ou_synthetic_account_c")];
  assert.equal((await invoke(f, "received")).code, 0);
  assert.equal(sqliteQuery(f.db, "SELECT COUNT(*) AS n FROM records WHERE direction='received';")[0].n, 2);
  assert.equal(readRemoteAccountBinding({ db: f.db, selfOpenId: A.open_id }).state, "verified");
  assert.equal(readFileSync(f.sidecar, "utf8"), binding);
});

for (const result of [{ ok: false }, { ok: true, skipped: true }, { skipped: true }]) {
  test(`first discovery does not bind after ${JSON.stringify(result)}`, async t => {
    const f = fixture(t);
    await invoke(f, "discover", { syncRunner: { syncDiscovery: () => result } });
    assert.equal(existsSync(f.sidecar), false);
  });
}

test("unbound received-only legacy data can sync without automatic rebinding", async t => {
  const f = fixture(t); ensureInitialized(f.db);
  sqliteExec(f.db, `INSERT INTO records(source_id,first_seen_scope_id,external_id,record_type,direction,actor_id,raw_json)
    VALUES('lark.im','lark.im.sent_by_me','om_synthetic_legacy','lark.im.message','received','ou_synthetic_legacy_sender','{}');`);
  assert.equal(readRemoteAccountBinding({ db: f.db, selfOpenId: A.open_id }).state, "unverified");
  assert.equal((await invoke(f, "all")).code, 0);
  assert.equal(existsSync(f.sidecar), false);
  assert.equal(readRemoteAccountBinding({ db: f.db, selfOpenId: A.open_id }).state, "unverified");
});

for (const mutation of ["corrupt", "wrong_database"]) {
  test(`${mutation} binding is not treated as a never-bound database`, async t => {
    const f = fixture(t); assert.equal((await invoke(f, "discover")).code, 0);
    const value = JSON.parse(readFileSync(f.sidecar, "utf8")); value.database_key = "0".repeat(64);
    writeFileSync(f.sidecar, mutation === "corrupt" ? "not JSON" : JSON.stringify(value));
    const before = snapshot(f), calls = f.apiCalls;
    const result = await invoke(f, "discover", { ensureSourceInitialSyncStart: () => assert.fail("binding failure must precede baseline mutation") });
    assert.equal(result.code, 1); assert.equal(result.stderr, "");
    assert.equal(result.summary.error.code, "execution_failed"); assert.match(result.summary.error.message, /binding cannot be verified/);
    assert.deepEqual(snapshot(f), before); assert.equal(f.apiCalls, calls);
  });
}

test("first profile failure preserves only a fresh source's intended baseline, including discovery", async t => {
  const f = fixture(t); ensureInitialized(f.db); const before = snapshot(f); f.profileError = true;
  assert.equal((await invoke(f, "discover")).code, 1);
  const after = snapshot(f), source = before.tables.sources.find(row => row.id === "lark.im");
  source.config_json = JSON.stringify({ initial_sync_start_ms: START });
  const updatedAt = after.tables.sources.find(row => row.id === "lark.im").updated_at;
  assert.ok(Date.parse(updatedAt) >= Date.parse(source.updated_at)); source.updated_at = updatedAt;
  assert.deepEqual(after, before); assert.equal(f.apiCalls, 0);
});

test("an empty but already bound source rejects another account before baseline changes", async t => {
  const f = fixture(t); ensureInitialized(f.db);
  assert.equal(recordSuccessfulSyncBinding({ db: f.db, selfOpenId: A.open_id,
    before: captureRemoteAccountBinding({ db: f.db }), successful: true }), true);
  const before = snapshot(f); f.profile = B;
  const result = await invoke(f, "discover", { ensureSourceInitialSyncStart: () => assert.fail("present binding must precede baseline") });
  assert.equal(result.code, 1); assert.equal(result.stderr, "");
  assert.equal(result.summary.error.code, "execution_failed"); assert.match(result.summary.error.message, /account conflicts/);
  assert.deepEqual(snapshot(f), before); assert.equal(f.apiCalls, 0);
});

for (const kind of ["corrupt_binding", "legacy_history", "unavailable_evidence"]) {
  test(`profile failure cannot seed a baseline with ${kind}`, async t => {
    const f = fixture(t); ensureInitialized(f.db);
    if (kind === "corrupt_binding") writeFileSync(f.sidecar, "not JSON");
    if (kind === "legacy_history") sqliteExec(f.db, `INSERT INTO records(source_id,first_seen_scope_id,external_id,record_type,direction,actor_id,raw_json)
      VALUES('lark.im','lark.im.sent_by_me','om_synthetic_old','lark.im.message','received','ou_synthetic_other','{}');`);
    const before = snapshot(f); f.profileError = true; let baselineCalls = 0;
    const result = await invoke(f, "discover", {
      ...(kind === "unavailable_evidence" ? { captureRemoteAccountBinding: () => null } : {}),
      ensureSourceInitialSyncStart: (...args) => { baselineCalls++; return ensureSourceInitialSyncStart(...args); },
    });
    assert.equal(result.code, 1); assert.equal(f.profileCalls, 1); assert.equal(baselineCalls, 0);
    assert.deepEqual(snapshot(f), before); assert.equal(f.apiCalls, 0);
  });
}

test("legacy sent-self evidence permits its account and rejects a different account", async t => {
  const f = fixture(t); ensureInitialized(f.db);
  sqliteExec(f.db, `INSERT INTO records(source_id,first_seen_scope_id,external_id,record_type,direction,actor_id,raw_json)
    VALUES('lark.im','lark.im.sent_by_me','om_synthetic_legacy_sent','lark.im.message','sent','${A.open_id}','{}');`);
  assert.equal((await invoke(f, "sent")).code, 0); assert.equal(existsSync(f.sidecar), false);
  const before = snapshot(f); f.profile = B;
  assert.equal((await invoke(f, "discover")).code, 1); assert.deepEqual(snapshot(f), before);
});
