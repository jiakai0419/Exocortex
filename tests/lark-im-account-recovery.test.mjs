import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../bin/exocortex.mjs";
import { createSyncRunner } from "../src/adapters/lark-im/sync-runner.mjs";
import { chatScopeId } from "../src/adapters/lark-im/core.mjs";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";
import { readRemoteAccountBinding, reserveSyncAccountBinding } from "../src/diagnostics/remote-account-binding.mjs";
import { ensureInitialized, ensureSourceInitialSyncStart, quoteSql, sqliteExec, sqliteQuery } from "../dist/storage/sqlite/ingestion-store.js";

// Every account, timestamp, message and database is invented. All remote
// adapter entries are injected; an unexpected entry fails even if caught by CLI.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const START = Date.parse("2026-01-01T00:00:00Z");
const END = START + 4 * 60_000;
const A = { open_id: "ou_synthetic_recovery_a", name: "Invented A" };
const B = { open_id: "ou_synthetic_recovery_b", name: "Invented B" };
const CHAT = "oc_synthetic_recovery_shared";
const SCOPE = chatScopeId(CHAT);
const SENT = "lark.im.sent_by_me";
const DATES = ["--start", new Date(START).toISOString(), "--end", new Date(END).toISOString()];

function raw(id, sender = B.open_id, extra = {}) {
  return { message_id: id, chat_id: CHAT, msg_type: "text",
    create_time: String(START + 60_000), update_time: String(START + 60_000),
    sender: { id: sender, id_type: "open_id", sender_type: "user" },
    body: { content: JSON.stringify({ text: `Invented recovery message ${id}` }) }, ...extra };
}
const message = (id, sender) => normalizeApiMessage(raw(id, sender));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-account-recovery-"));
  const f = { dir, db: join(dir, "synthetic.sqlite"), profile: A, calls: [], unexpected: [],
    sent: null, sentError: null, roots: [], received: null, chats: null, detailError: null, replay: null };
  f.sidecar = `${f.db}.remote-account-binding.json`;
  const unexpected = name => { f.unexpected.push(name); assert.fail(`unexpected remote adapter path: ${name}`); };
  const window = (items, start, end) => items.filter(item => Number(item.create_time) >= start && Number(item.create_time) <= end);
  f.adapter = {
    fetchSentMessageList: (_self, start, end) => {
      if (f.sent === null && !f.sentError) return unexpected("fetchSentMessageList");
      f.calls.push("sent");
      if (f.sentError) throw f.sentError;
      return { messages: window(f.sent, start, end), detailRoots: window(f.roots, start, end), pages: 1 };
    },
    fetchChatMessageList: (chat, start, end) => {
      if (f.received === null) return unexpected("fetchChatMessageList");
      assert.equal(chat, CHAT); f.calls.push("received");
      return { messages: window(f.received, start, end), detailRoots: [], pages: 1 };
    },
    fetchChatDiscoveryPage: () => {
      if (f.chats === null) return unexpected("fetchChatDiscoveryPage");
      f.calls.push("discovery"); return { chats: f.chats, has_more: false, page_token: "" };
    },
    fetchMessageDetails: () => {
      if (!f.detailError) return unexpected("fetchMessageDetails");
      f.calls.push("detail"); throw f.detailError;
    },
    buildPeopleContext: () => ({ self: f.profile }),
  };
  f.deps = {
    tryAcquireLarkApiLease: () => ({ state: "acquired", release() {} }),
    getSelfProfile: () => f.profile,
    syncRunnerDeps: f.adapter,
    fetchChatMessages: (chat, start, end) => {
      if (f.replay === null) return unexpected("fetchChatMessages");
      assert.equal(chat, CHAT); assert.equal(start, START); assert.equal(end, END);
      f.calls.push("replay"); return { messages: f.replay, pages: 1 };
    },
  };
  t.after(() => {
    try { assert.deepEqual(f.unexpected, []); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  return f;
}

async function cli(f, argv, extra = {}) {
  let stdout = "", stderr = "";
  const code = await runCli(argv, { root: ROOT, cwd: f.dir, env: {},
    stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
    deps: { ...f.deps, ...extra } });
  return { code, stdout, stderr, summary: stdout ? JSON.parse(stdout) : null };
}
const sync = (f, scope, extra) => cli(f, ["sync", "--db", f.db, "--scope", scope, ...DATES], extra);
const replay = f => cli(f, ["maintenance", "replay", "--db", f.db, "--scope-id", SCOPE, ...DATES, "--apply"]);
const rows = (f, table) => sqliteQuery(f.db, `SELECT * FROM ${table} ORDER BY rowid;`);
const initial = f => JSON.parse(rows(f, "sources").find(row => row.id === "lark.im").config_json).initial_account_binding;
const binding = (f, profile = A) => readRemoteAccountBinding({ db: f.db, selfOpenId: profile.open_id });
function snapshot(f) {
  return { tables: Object.fromEntries(["sources", "sync_scopes", "sync_runs", "records", "sync_locks",
    "maintenance_locks", "lark_im_list_progress", "lark_im_detail_tasks", "bounded_replay_runs"].map(table => [table, rows(f, table)])),
    sidecar: existsSync(f.sidecar) ? readFileSync(f.sidecar, "utf8") : null };
}
function assertConfirmed(f) {
  const value = initial(f);
  assert.equal(value.kind, "lark_im_initial_account/v1");
  assert.match(value.confirmed_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(binding(f).state, "verified");
  assert.equal(binding(f, B).state, "conflict");
}
function assertPending(f) {
  assert.equal(initial(f).confirmed_at, null);
  assert.equal(binding(f).state, "unverified");
  assert.equal(binding(f).reason, "account_database_pending");
  assert.equal(binding(f).evidence, null);
  assert.equal(binding(f, B).state, "conflict");
  assert.equal(existsSync(f.sidecar), false);
}
async function assertOtherAccountRejected(f) {
  const before = snapshot(f), calls = [...f.calls]; f.profile = B;
  const result = await sync(f, "sent");
  assert.equal(result.code, 1); assert.equal(result.stderr, "");
  assert.equal(result.summary.schema_version, 1); assert.equal(result.summary.ok, false);
  assert.equal(result.summary.error.code, "execution_failed"); assert.match(result.summary.error.message, /account conflicts/);
  assert.deepEqual(snapshot(f), before); assert.deepEqual(f.calls, calls); f.profile = A;
}
function enableDiscovery(f) {
  f.chats = [{ chat_id: CHAT, chat_type: "group", name: "Invented shared recovery chat" }];
}

test("an unavailable initial snapshot cannot create an unbound first run", async t => {
  const f = fixture(t); f.sent = [];
  const result = await sync(f, "sent", { captureRemoteAccountBinding: () => null });
  assert.equal(result.code, 1); assert.deepEqual(f.calls, []);
  assert.equal(rows(f, "sync_runs").length, 0); assert.equal(initial(f), undefined);
  assert.equal((await sync(f, "sent")).code, 0); assertConfirmed(f);
  await assertOtherAccountRejected(f);
});

test("replacing a legacy database during profile resolution cannot bypass fresh-source reservation", async t => {
  const f = fixture(t); ensureInitialized(f.db); enableDiscovery(f);
  sqliteExec(f.db, `INSERT INTO records(source_id,first_seen_scope_id,external_id,record_type,direction,actor_id,raw_json)
    VALUES('lark.im',${quoteSql(SENT)},'om_synthetic_legacy_replace','lark.im.message','received','ou_synthetic_legacy_peer','{}');`);
  const fresh = join(f.dir, "replacement.sqlite"); ensureInitialized(fresh);
  const result = await sync(f, "discover", { getSelfProfile: () => {
    renameSync(fresh, f.db); return A;
  } });
  assert.equal(result.code, 1); assert.deepEqual(f.calls, []);
  assert.equal(rows(f, "sync_runs").length, 0); assert.equal(initial(f), undefined);
  assert.equal(JSON.parse(rows(f, "sources").find(row => row.id === "lark.im").config_json).initial_sync_start_ms, undefined);
  assert.equal((await sync(f, "discover")).code, 0); assertConfirmed(f);
  await assertOtherAccountRejected(f);
});

test("clock rollback during discovery cannot leave permanently invalid confirmation evidence", async t => {
  const f = fixture(t); enableDiscovery(f);
  const earlier = new Date(Date.now() - 60_000).toISOString();
  const result = await sync(f, "discover", { syncRunnerDeps: { ...f.adapter, nowIso: () => earlier } });
  assert.equal(result.code, 0); assertConfirmed(f);
  const evidence = initial(f);
  assert.ok(Date.parse(evidence.confirmed_at) >= Date.parse(evidence.reserved_at));
  assert.equal((await sync(f, "discover")).code, 0); assertConfirmed(f);
  await assertOtherAccountRejected(f);
});

test("a first partially successful all command retains account ownership and resumes for the same account", async t => {
  const f = fixture(t); enableDiscovery(f);
  f.sentError = new Error("invented sent list failure");
  f.received = [message("om_synthetic_partial_received")];
  const first = await sync(f, "all");
  assert.equal(first.code, 2); assert.equal(first.summary.partial, true);
  assert.equal(first.summary.sent.ok, false); assert.equal(first.summary.discovery.ok, true);
  assert.equal(rows(f, "records").length, 1); assertConfirmed(f);
  await assertOtherAccountRejected(f);
  f.sentError = null; f.sent = [];
  assert.equal((await sync(f, "sent")).code, 0); assertConfirmed(f);
});

test("an interruption after the actual list commit retains verified ownership without a sidecar", async t => {
  const f = fixture(t); f.sent = [];
  const runner = createSyncRunner(f.adapter);
  const interrupted = await sync(f, "sent", { syncRunner: { syncSent: (...args) => {
    assert.equal(runner.syncSent(...args).ok, true);
    throw new Error("invented interruption after the committed list and before publication");
  } } });
  assert.equal(interrupted.code, 1); assert.equal(existsSync(f.sidecar), false);
  assert.equal(rows(f, "sync_runs")[0].status, "succeeded"); assertConfirmed(f);
  await assertOtherAccountRejected(f);
  assert.equal((await sync(f, "sent")).code, 0); assertConfirmed(f);
});

test("sidecar publication failure cannot discard a confirmed discovery account", async t => {
  const f = fixture(t); enableDiscovery(f); let publications = 0;
  const result = await sync(f, "discover", { recordSuccessfulSyncBinding: () => { publications++; return false; } });
  assert.equal(result.code, 0); assert.equal(publications, 1);
  assert.equal(existsSync(f.sidecar), false); assert.equal(rows(f, "records").length, 0); assertConfirmed(f);
  await assertOtherAccountRejected(f);
  f.sent = []; assert.equal((await sync(f, "sent")).code, 0);
});

test("an interruption immediately after reservation remains unverified and permits only the original account to resume", async t => {
  const f = fixture(t);
  const result = await sync(f, "sent", { reserveSyncAccountBinding: options => {
    assert.equal(reserveSyncAccountBinding(options), true);
    throw new Error("invented interruption before any runner starts");
  } });
  assert.equal(result.code, 1); assert.deepEqual(f.calls, []);
  assert.equal(rows(f, "sync_runs").length, 0); assertPending(f);
  await assertOtherAccountRejected(f);
  f.sent = []; assert.equal((await sync(f, "sent")).code, 0); assertConfirmed(f);
});

test("a committed list confirms ownership while unavailable merge details retain durable debt", async t => {
  const f = fixture(t); f.sent = [];
  f.roots = [raw("om_synthetic_debt_root", A.open_id, { msg_type: "merge_forward", body: { content: "{}" } })];
  f.detailError = new Error("invented unavailable details");
  const result = await sync(f, "sent", { recordSuccessfulSyncBinding: () => false });
  assert.equal(result.code, 2); assert.equal(result.summary.sent.list_complete, true);
  assert.equal(result.summary.sent.details_complete, false); assert.equal(result.summary.sent.pending_details, 1);
  assert.equal(rows(f, "records").length, 0); assert.equal(rows(f, "lark_im_list_progress").length, 1);
  assert.equal(rows(f, "lark_im_detail_tasks")[0].status, "pending");
  assert.equal(rows(f, "sync_scopes").find(row => row.id === SENT).cursor_json, null);
  assert.equal(existsSync(f.sidecar), false); assertConfirmed(f);
  await assertOtherAccountRejected(f);
});

test("a failure late in the list transaction rolls back confirmation with records and list progress", async t => {
  const f = fixture(t); ensureInitialized(f.db);
  sqliteExec(f.db, `CREATE TRIGGER synthetic_reject_completion BEFORE UPDATE OF status ON sync_runs
    WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT, 'invented late transaction failure'); END;`);
  f.sent = [message("om_synthetic_rolled_back", A.open_id)];
  const result = await sync(f, "sent");
  assert.equal(result.code, 1); assert.equal(result.summary.sent.ok, false);
  assert.match(result.summary.sent.error, /invented late transaction failure/);
  assert.equal(rows(f, "records").length, 0); assert.equal(rows(f, "lark_im_list_progress").length, 0);
  assert.equal(rows(f, "sync_runs")[0].status, "failed"); assertPending(f);
  sqliteExec(f.db, "DROP TRIGGER synthetic_reject_completion;");
  assert.equal((await sync(f, "sent")).code, 0); assertConfirmed(f);
});

test("pure failed and skipped first attempts never confirm their reservation", async t => {
  for (const kind of ["failed", "skipped"]) {
    await t.test(kind, async t => {
      const f = fixture(t);
      if (kind === "failed") f.sentError = new Error("invented list failure before any commit");
      else {
        ensureInitialized(f.db);
        sqliteExec(f.db, `UPDATE sync_scopes SET enabled=0 WHERE id=${quoteSql(SENT)};`);
      }
      const result = await sync(f, "sent");
      assert.equal(result.code, kind === "failed" ? 1 : 0);
      if (kind === "skipped") { assert.equal(result.summary.sent.skipped, true); assert.deepEqual(f.calls, []); }
      assertPending(f); assert.equal(rows(f, "records").length, 0);
    });
  }
});

test("public replay rejects a conflicting discovery-only account before fetch or audit, while same-account and legacy replay work", async t => {
  const f = fixture(t); enableDiscovery(f);
  assert.equal((await sync(f, "discover")).code, 0);
  assert.equal(rows(f, "records").length, 0); assertConfirmed(f);
  const before = snapshot(f), calls = [...f.calls]; f.profile = B;
  f.replay = [message("om_synthetic_replay_peer")];
  const denied = await replay(f);
  assert.equal(denied.code, 1); assert.equal(denied.stdout, ""); assert.match(denied.stderr, /account conflicts/);
  assert.deepEqual(snapshot(f), before); assert.deepEqual(f.calls, calls);
  f.profile = A;
  const accepted = await replay(f);
  assert.equal(accepted.code, 0); assert.equal(accepted.summary.scopes[0].inserted, 1);
  assert.equal(rows(f, "records")[0].direction, "received"); assertConfirmed(f);
  f.sent = []; assert.equal((await sync(f, "sent")).code, 0);

  const legacy = fixture(t); ensureInitialized(legacy.db);
  ensureSourceInitialSyncStart(legacy.db, "lark.im", START, { explicit: true });
  sqliteExec(legacy.db, `INSERT INTO sync_scopes(id,source_id,name,config_json)
    VALUES(${quoteSql(SCOPE)},'lark.im','Invented legacy scope',${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: "group" }))});
    INSERT INTO records(source_id,first_seen_scope_id,external_id,record_type,direction,actor_id,raw_json)
    VALUES('lark.im',${quoteSql(SCOPE)},'om_synthetic_legacy_history','lark.im.message','received','ou_synthetic_legacy_peer','{}');`);
  legacy.replay = [message("om_synthetic_legacy_repair")];
  const repaired = await replay(legacy);
  assert.equal(repaired.code, 0); assert.equal(repaired.summary.scopes[0].inserted, 1);
  legacy.sent = []; assert.equal((await sync(legacy, "sent")).code, 0);
  assert.equal(initial(legacy), undefined); assert.equal(existsSync(legacy.sidecar), false);
  assert.equal(binding(legacy).reason, "account_database_unbound");
});

for (const invalid of ["corrupt_sidecar", "wrong_database", "future_sidecar", "corrupt_embedded"]) {
  test(`public replay rejects ${invalid} evidence without fetching or changing business state`, async t => {
    const f = fixture(t); enableDiscovery(f);
    assert.equal((await sync(f, "discover")).code, 0);
    if (invalid === "corrupt_embedded") {
      sqliteExec(f.db, "UPDATE sources SET config_json=json_set(config_json, '$.initial_account_binding', json('null')) WHERE id='lark.im';");
    } else if (invalid === "corrupt_sidecar") writeFileSync(f.sidecar, "invented invalid JSON");
    else {
      const sidecar = JSON.parse(readFileSync(f.sidecar, "utf8"));
      if (invalid === "wrong_database") sidecar.database_key = "0".repeat(64);
      else sidecar.bound_at = new Date(Date.now() + 86_400_000).toISOString();
      writeFileSync(f.sidecar, JSON.stringify(sidecar));
    }
    const before = snapshot(f), calls = [...f.calls];
    const result = await replay(f);
    assert.equal(result.code, 1); assert.equal(result.stdout, "");
    assert.match(result.stderr, /binding cannot be verified/);
    assert.deepEqual(snapshot(f), before); assert.deepEqual(f.calls, calls);
  });
}
