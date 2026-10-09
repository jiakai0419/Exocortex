import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLarkImAdapter } from "../src/adapters/lark-im/adapter.mjs";
import { recordFromMessage } from "../src/adapters/lark-im/message-record.mjs";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";
import { createSyncRunner } from "../src/adapters/lark-im/sync-runner.mjs";
import { readRemoteAccountBinding } from "../src/diagnostics/remote-account-binding.mjs";
import {
  ensureInitialized, quoteSql, readScope, reserveInitialLarkAccount,
  sqliteExec, sqliteQuery, upsertRecordsSql,
} from "../dist/storage/sqlite/ingestion-store.js";

// Entirely invented identities, messages and responses. The real adapter and
// sync runner use injected transport and an isolated, disposable SQLite file.
const START = Date.parse("2026-02-11T08:00:00.000Z");
const CHAT = "oc_synthetic_lantern_archive";
const SCOPE = "lark.im.received.chat.synthetic_lantern_archive";
const ACTOR = "ou_synthetic_lantern_archivist";
const PROFILE = { open_id: "ou_synthetic_lantern_owner", name: "Lantern Owner" };
const NAME = "Lantern Archivist";
const OPTIONS = {
  startMs: START, endMs: START + 60_000, endExplicit: true, stableHorizonSeconds: 30,
  pageSize: 50, maxPages: 2, chatPageSize: 100, chatTypes: "group",
  lockTtlSeconds: 600, retries: 0, retryDelayMs: 0,
};

function native(id, offset, overrides = {}) {
  return {
    message_id: `om_synthetic_lantern_${id}`, chat_id: CHAT, msg_type: "text",
    create_time: String(START + offset), update_time: String(START + offset + 1),
    sender: { id: ACTOR, id_type: "open_id", sender_type: "user" },
    body: { content: JSON.stringify({ text: `Invented lantern entry ${id}.` }) },
    ...overrides,
  };
}
const page = (items) => ({ ok: true, data: { items, has_more: false } });
const contact = () => ({ ok: true, data: { users: [{ open_id: ACTOR, name: NAME }] } });
const isContact = (args) => args[0] === "contact" && args[1] === "+search-user";
const isMember = (args) => args[0] === "im" && args[1] === "chat.members" && args[2] === "get";
const makeRunner = (run) => createSyncRunner(createLarkImAdapter({ run }));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "exocortex-lantern-detail-name-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, "invented.sqlite");
  ensureInitialized(db);
  const accountKey = createHash("sha256").update(`lark.im\0${PROFILE.open_id}`).digest("hex");
  reserveInitialLarkAccount(db, accountKey, new Date().toISOString());
  sqliteExec(db, `UPDATE sources SET config_json=json_set(config_json,
    '$.initial_sync_start_ms',${START}) WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(
      ${quoteSql(SCOPE)},'lark.im','invented lantern archive',
      ${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: "group" }))});`);
  const root = native("bundle", 20_000, { msg_type: "merge_forward", body: { content: "Invented lantern bundle." } });
  const child = native("enclosed", -1000, { upper_message_id: root.message_id });
  const history = native("history", 5000);
  return { db, root, child, history, detailPath: `/open-apis/im/v1/messages/${root.message_id}` };
}

const read = (f, id = f.root.message_id) => sqliteQuery(f.db,
  `SELECT * FROM records WHERE external_id=${quoteSql(id)};`)[0];
const sync = (f, runner) => runner.syncReceivedScope(f.db, OPTIONS, readScope(f.db, SCOPE), PROFILE);

function expectedDetail(f) {
  return recordFromMessage(normalizeApiMessage(f.root, { mergeItems: [f.root, f.child] }),
    SCOPE, "received", {}, { chat_id: CHAT, chat_type: "group" });
}

function assertCompletedSource(f, result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  const row = read(f);
  const expected = expectedDetail(f);
  for (const key of ["raw_json", "content_hash", "external_version", "body", "actor_id", "container_id"]) {
    assert.equal(row[key], expected[key], key);
  }
  assert.match(row.body, /Invented lantern entry enclosed/);
  assert.equal(sqliteQuery(f.db, "SELECT COUNT(*) AS count FROM lark_im_detail_tasks WHERE status='pending';")[0].count, 0);
  assert.equal(sqliteQuery(f.db, "SELECT COUNT(*) AS count FROM sync_locks;")[0].count, 0);
  return JSON.parse(row.canonical_json);
}

function queueWithContactHistory(f) {
  const calls = [];
  const runner = makeRunner((args) => {
    calls.push(args);
    if (isContact(args)) return contact();
    assert.deepEqual(args.slice(0, 2), ["api", "GET"]);
    if (args[2] === "/open-apis/im/v1/messages") return page([f.history, f.root]);
    assert.equal(args[2], f.detailPath);
    throw new Error("lark-cli failed: kind=restricted_mode; invented detail unavailable");
  });
  const result = sync(f, runner);
  assert.equal(result.ok, false);
  assert.equal(result.incomplete, true);
  assert.equal(read(f), undefined);
  const old = read(f, f.history.message_id);
  const canonical = JSON.parse(old.canonical_json);
  assert.equal(canonical.sender_name, NAME);
  assert.equal(canonical.sender_name_source, "contact");
  assert.equal(canonical.sender_name_confidence, "high");
  assert.equal(readRemoteAccountBinding({ db: f.db, selfOpenId: PROFILE.open_id }).state, "verified");
  assert.equal(calls.filter(isContact).length, 1);
  sqliteExec(f.db, "UPDATE lark_im_detail_tasks SET retry_at='2000-01-01T00:00:00.000Z';");
  return old;
}

function retryWithoutRemoteNames(f) {
  const calls = [];
  // A fresh adapter also removes the previous resolver's in-memory cache.
  const runner = makeRunner((args) => {
    calls.push(args);
    if (isContact(args) || isMember(args)) {
      throw new Error("lark-cli failed: kind=permission_denied; invented name unavailable");
    }
    assert.deepEqual(args.slice(0, 3), ["api", "GET", f.detailPath], "detail retry cannot fetch another message list");
    return page([f.root, f.child]);
  });
  const [result] = runner.retryDetails(f.db, OPTIONS, PROFILE);
  assert.equal(calls.filter(isContact).length, 1);
  assert.equal(calls.filter(isMember).length, 1);
  assert.equal(calls.filter((args) => args[0] === "api").length, 1);
  return result;
}

test("merge-forward detail completion resolves its sender through the real contact resolver", (t) => {
  const f = fixture(t);
  const calls = [];
  const runner = makeRunner((args, options) => {
    calls.push(args);
    if (isContact(args)) {
      assert.equal(args[args.indexOf("--user-ids") + 1], ACTOR);
      assert.equal(options.retries, 0);
      assert.ok(options.retryBudgetMs > 0 && options.retryBudgetMs <= 5000);
      return contact();
    }
    assert.deepEqual(args.slice(0, 2), ["api", "GET"]);
    if (args[2] === "/open-apis/im/v1/messages") return page([f.root]);
    assert.equal(args[2], f.detailPath);
    return page([f.root, f.child]);
  });
  const canonical = assertCompletedSource(f, sync(f, runner));
  assert.equal(canonical.sender_name, NAME);
  assert.equal(canonical.sender_name_source, "contact");
  assert.equal(canonical.sender_name_confidence, "high");
  assert.equal(calls.filter(isContact).length, 1);
  assert.equal(calls.length, 3, "only list, detail and the target contact are requested");
});

test("standalone detail retry reuses verified contact history after name APIs fail and a resolver restart", (t) => {
  const f = fixture(t);
  const historyBefore = queueWithContactHistory(f);
  const canonical = assertCompletedSource(f, retryWithoutRemoteNames(f));
  assert.equal(canonical.sender_name, NAME);
  assert.equal(canonical.sender_name_source, "local_history");
  assert.equal(canonical.sender_name_confidence, "high");
  assert.equal(canonical.sender_name_authority_source, "contact");
  assert.deepEqual(read(f, f.history.message_id), historyBefore, "the authoritative history is never rewritten");
});

for (const state of ["known", "cleared"]) {
  test(`detail history fallback preserves an existing ${state} sender projection`, (t) => {
    const f = fixture(t);
    const historyBefore = queueWithContactHistory(f);
    const record = expectedDetail(f);
    const canonical = {
      ...JSON.parse(record.canonical_json),
      sender_name: state === "known" ? "Existing Lantern Keeper" : null,
      sender_name_source: "message_sender", sender_name_confidence: "high",
      ...(state === "cleared" ? { sender_name_state: "cleared" } : {}),
    };
    sqliteExec(f.db, upsertRecordsSql([{ ...record, canonical_json: JSON.stringify(canonical) }]));
    const after = assertCompletedSource(f, retryWithoutRemoteNames(f));
    for (const key of ["sender_name", "sender_name_source", "sender_name_confidence", "sender_name_state"]) {
      assert.equal(after[key], canonical[key], key);
    }
    assert.equal(after.sender_name_authority_source, undefined, "unused history provenance must not leak into the retained projection");
    assert.deepEqual(read(f, f.history.message_id), historyBefore);
  });
}

for (const mode of ['exact', 'guessed', 'id_echo']) {
  test(`detail application fallback accepts only exact named evidence: ${mode}`, (t) => {
    const f = fixture(t);
    const app = 'cli_synthetic_lantern_cart';
    f.root.sender = { id: app, id_type: 'app_id', sender_type: 'app' };
    const runner = makeRunner((args) => {
      if (args[2] === '/open-apis/im/v1/messages') return page([f.root]);
      if (args[2] === f.detailPath) return page([f.root, f.child]);
      if (args[0] === 'api') throw new Error('synthetic application permission denied');
      assert.deepEqual(args.slice(0, 3), ['im', 'chat.members', 'bots']);
      return { items: [{ ...(mode === 'guessed' ? {} : { app_id: app }), bot_name: mode === 'id_echo' ? app : 'Lantern Cart' }] };
    });
    const value = assertCompletedSource(f, sync(f, runner));
    assert.equal(value.sender_name, mode === 'exact' ? 'Lantern Cart' : null);
    assert.equal(value.sender_name_source, mode === 'exact' ? 'chat_bot_app_id' : null);
  });
}
