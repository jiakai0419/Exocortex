import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSyncRunner } from "../src/adapters/lark-im/sync-runner.mjs";
import { executeLarkImSync, parseArgs } from "../src/cli/lark-im-sync-command.mjs";
import {
  ensureInitialized,
  ensureSourceInitialSyncStart,
  quoteSql,
  readScope,
  sqlJson,
  sqliteExec,
  sqliteQuery,
} from "../dist/storage/sqlite/ingestion-store.js";

const SOURCE = "lark.im";
const DAY_ONE = Date.parse("2026-06-18T00:00:00Z");
const DAY_TWO = Date.parse("2026-06-19T00:00:00Z");
const STORE_URL = new URL("../dist/storage/sqlite/ingestion-store.js", import.meta.url).href;

function tempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-baseline-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "synthetic.sqlite");
  ensureInitialized(dbPath);
  return dbPath;
}

function sourceConfig(dbPath) {
  const rows = sqliteQuery(dbPath, "SELECT config_json FROM sources WHERE id = 'lark.im';", "read synthetic source");
  return JSON.parse(rows[0].config_json);
}

function setSourceConfig(dbPath, config) {
  sqliteExec(dbPath, `UPDATE sources SET config_json = ${sqlJson(config)} WHERE id = 'lark.im';`, "set synthetic source config");
}

test("source baseline is persisted once and preserves unrelated source config across initialization", (t) => {
  const dbPath = tempDb(t);
  setSourceConfig(dbPath, { preserve: { mode: "synthetic" } });

  assert.equal(ensureSourceInitialSyncStart(dbPath, SOURCE, DAY_ONE), DAY_ONE);
  ensureInitialized(dbPath);
  assert.equal(ensureSourceInitialSyncStart(dbPath, SOURCE, DAY_TWO), DAY_ONE);
  assert.equal(ensureSourceInitialSyncStart(dbPath, SOURCE, DAY_ONE, { explicit: true }), DAY_ONE);
  assert.deepEqual(sourceConfig(dbPath), {
    preserve: { mode: "synthetic" },
    initial_sync_start_ms: DAY_ONE,
  });

  assert.throws(() => ensureSourceInitialSyncStart(dbPath, SOURCE, DAY_TWO, { explicit: true }));
  assert.equal(sourceConfig(dbPath).initial_sync_start_ms, DAY_ONE);
});

test("legacy records, runs, and cursors each require explicit baseline adoption", async (t) => {
  const fixtures = {
    record: `INSERT INTO records (source_id, first_seen_scope_id, external_id, record_type, raw_json)
             VALUES ('lark.im', 'lark.im.sent_by_me', 'synthetic:legacy', 'test.message', '{}');`,
    run: `INSERT INTO sync_runs (source_id, scope_id, status)
          VALUES ('lark.im', 'lark.im.sent_by_me', 'failed');`,
    cursor: `UPDATE sync_scopes SET cursor_json = '{"created_at_ms":${DAY_TWO},"message_id":""}'
             WHERE id = 'lark.im.sent_by_me';`,
  };
  for (const [name, sql] of Object.entries(fixtures)) {
    await t.test(name, (t) => {
      const dbPath = tempDb(t);
      sqliteExec(dbPath, sql, `seed synthetic legacy ${name}`);
      const snapshot = () => Object.fromEntries(["records", "sync_runs", "sync_scopes"].map((table) => [
        table, sqliteQuery(dbPath, `SELECT * FROM ${table} ORDER BY id;`, `snapshot synthetic ${table}`),
      ]));
      const before = snapshot();

      assert.throws(() => ensureSourceInitialSyncStart(dbPath, SOURCE, DAY_ONE));
      assert.deepEqual(sourceConfig(dbPath), {});
      assert.equal(ensureSourceInitialSyncStart(dbPath, SOURCE, DAY_ONE, { explicit: true }), DAY_ONE);
      assert.deepEqual(snapshot(), before);
    });
  }
});

test("another source's history does not prevent initial Lark baseline seeding", (t) => {
  const dbPath = tempDb(t);
  sqliteExec(dbPath, `
    INSERT INTO sources (id, kind, display_name) VALUES ('synthetic.other', 'test', 'Other');
    INSERT INTO sync_scopes (id, source_id, name, cursor_json)
      VALUES ('synthetic.other.scope', 'synthetic.other', 'other', '{}');
    INSERT INTO sync_runs (source_id, scope_id, status)
      VALUES ('synthetic.other', 'synthetic.other.scope', 'failed');
    INSERT INTO records (source_id, first_seen_scope_id, external_id, record_type, raw_json)
      VALUES ('synthetic.other', 'synthetic.other.scope', 'other:1', 'test.message', '{}');
  `, "seed unrelated synthetic history");
  assert.equal(ensureSourceInitialSyncStart(dbPath, SOURCE, DAY_ONE), DAY_ONE);
});

test("invalid baseline candidates are rejected without persisting a value", (t) => {
  const dbPath = tempDb(t);
  for (const candidate of [null, String(DAY_ONE), NaN, Infinity, -1, 0, 1781740800, DAY_ONE + 0.5, 253_402_300_800_000, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => ensureSourceInitialSyncStart(dbPath, SOURCE, candidate, { explicit: true }));
    assert.deepEqual(sourceConfig(dbPath), {});
  }
});

test("malformed persisted baseline data is rejected rather than silently reseeded", (t) => {
  const dbPath = tempDb(t);
  const invalidConfigs = [
    [], null, "object required",
    ...[null, String(DAY_ONE), DAY_ONE + 0.5, 1781740800, 253_402_300_800_000]
      .map((value) => ({ initial_sync_start_ms: value })),
  ];
  for (const config of invalidConfigs) {
    setSourceConfig(dbPath, config);
    assert.throws(() => ensureSourceInitialSyncStart(dbPath, SOURCE, DAY_ONE, { explicit: true }));
    assert.deepEqual(sourceConfig(dbPath), config);
  }
});

test("baseline end validation does not seed an unusable window and uses an existing baseline", (t) => {
  const dbPath = tempDb(t);
  assert.throws(() => ensureSourceInitialSyncStart(dbPath, SOURCE, DAY_TWO, { endMs: DAY_ONE }));
  assert.deepEqual(sourceConfig(dbPath), {});
  assert.equal(ensureSourceInitialSyncStart(dbPath, SOURCE, DAY_ONE, { endMs: DAY_ONE }), DAY_ONE);
  assert.equal(ensureSourceInitialSyncStart(dbPath, SOURCE, DAY_TWO, { endMs: DAY_ONE + 60_000 }), DAY_ONE);
  assert.throws(() => ensureSourceInitialSyncStart(dbPath, SOURCE, DAY_TWO, { endMs: DAY_ONE - 1 }));
  assert.equal(sourceConfig(dbPath).initial_sync_start_ms, DAY_ONE);
});

test("an implicit start with an older explicit end resolves the saved baseline before validation", (t) => {
  const savedDb = tempDb(t);
  const freshDb = tempDb(t);
  ensureSourceInitialSyncStart(savedDb, SOURCE, DAY_ONE);
  const calls = [];
  const deps = {
    getSelfProfile: () => { throw new Error("discovery must not resolve the real account"); },
    syncRunner: { syncDiscovery: () => { calls.push("discovery"); return { ok: true }; } },
  };
  const options = (dbPath) => ({
    ...parseArgs(["--db", dbPath, "--scope", "discover", "--end", "2026-06-18T01:00:00Z"]),
    start: new Date(DAY_TWO).toISOString(),
    startMs: DAY_TWO,
  });

  const result = executeLarkImSync(options(savedDb), deps);
  assert.equal(result.ok, true);
  assert.equal(result.initial_sync_start_ms, DAY_ONE);
  assert.throws(() => executeLarkImSync(options(freshDb), deps));
  assert.deepEqual(sourceConfig(freshDb), {});
  assert.deepEqual(calls, ["discovery"]);
});

test("equivalent explicit timezones preserve millisecond baseline precision in storage and CLI output", (t) => {
  const dbPath = tempDb(t);
  const preciseMs = DAY_ONE + 123;
  const deps = {
    getSelfProfile: () => { throw new Error("discovery must not resolve the real account"); },
    syncRunner: { syncDiscovery: () => ({ ok: true }) },
  };
  for (const start of ["2026-06-18T08:00:00.123+08:00", "2026-06-18T00:00:00.123Z"]) {
    const result = executeLarkImSync(parseArgs([
      "--db", dbPath, "--scope", "discover", "--start", start, "--end", "2026-06-18T01:00:00Z",
    ]), deps);
    assert.equal(result.initial_sync_start_ms, preciseMs);
    assert.equal(result.initial_sync_start, "2026-06-18T00:00:00.123Z");
    assert.equal(sourceConfig(dbPath).initial_sync_start_ms, preciseMs);
  }
});

test("seeding refuses disabled sources and active maintenance or source sync locks", async (t) => {
  const fixtures = {
    disabled: "UPDATE sources SET enabled = 0 WHERE id = 'lark.im';",
    maintenance: `INSERT INTO maintenance_locks (name, owner, acquired_at, expires_at, reason)
                  VALUES ('global', 'synthetic:maintenance', '2026-06-18T00:00:00Z', '9999-12-31T23:59:59Z', 'synthetic test');`,
    sync: `INSERT INTO sync_locks (scope_id, locked_by, locked_at, expires_at)
           VALUES ('lark.im.sent_by_me', 'synthetic:sync', '2026-06-18T00:00:00Z', '9999-12-31T23:59:59Z');`,
  };
  for (const [name, sql] of Object.entries(fixtures)) {
    await t.test(name, (t) => {
      const dbPath = tempDb(t);
      sqliteExec(dbPath, sql, `seed synthetic ${name} block`);
      assert.throws(() => ensureSourceInitialSyncStart(dbPath, SOURCE, DAY_ONE, { explicit: true }));
      assert.deepEqual(sourceConfig(dbPath), {});
      setSourceConfig(dbPath, { initial_sync_start_ms: DAY_ONE });
      assert.equal(ensureSourceInitialSyncStart(dbPath, SOURCE, DAY_TWO), DAY_ONE);
    });
  }
});

async function concurrentSeeds(t, dbPath, candidates, explicit) {
  // IPC starts the calls only after every contender has imported the store.
  // Each child invokes the store only on the supplied synthetic database.
  const script = `
    import { ensureSourceInitialSyncStart } from ${JSON.stringify(STORE_URL)};
    process.once('message', () => {
      try {
        const value = ensureSourceInitialSyncStart(process.argv[1], 'lark.im', Number(process.argv[2]), { explicit: process.argv[3] === 'true' });
        process.stdout.write(JSON.stringify({ ok: true, value }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
      }
      process.disconnect();
    });
    process.send('ready');
  `;
  const contenders = candidates.map((candidate) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, dbPath, String(candidate), String(explicit)], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const ready = new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`contender exited before ready: ${stderr}`)));
    });
    const done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) return reject(new Error(`contender failed (${code}): ${stderr}`));
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      });
    });
    return { child, ready, done };
  });
  await Promise.all(contenders.map(({ ready }) => ready));
  for (const { child } of contenders) child.send("start");
  return Promise.all(contenders.map(({ done }) => done));
}

test("simultaneous implicit baseline seeders all observe the same committed winner", { timeout: 20_000 }, async (t) => {
  const dbPath = tempDb(t);
  const candidates = [DAY_ONE, DAY_TWO, DAY_TWO + 86_400_000, DAY_TWO + 2 * 86_400_000];
  const results = await concurrentSeeds(t, dbPath, candidates, false);
  const stored = sourceConfig(dbPath).initial_sync_start_ms;
  assert.equal(candidates.includes(stored), true);
  assert.deepEqual(results, candidates.map(() => ({ ok: true, value: stored })));
});

test("simultaneous conflicting explicit baseline seeders admit exactly one winner", { timeout: 20_000 }, async (t) => {
  const dbPath = tempDb(t);
  const results = await concurrentSeeds(t, dbPath, [DAY_ONE, DAY_TWO], true);
  const succeeded = results.filter((result) => result.ok);
  const rejected = results.filter((result) => !result.ok);
  assert.equal(succeeded.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(succeeded[0].value, sourceConfig(dbPath).initial_sync_start_ms);
  assert.equal(typeof rejected[0].error, "string");
});

function optionsForDay(dbPath, dayStartMs, scope, endMs) {
  return {
    ...parseArgs(["--db", dbPath, "--scope", scope, "--start", new Date(dayStartMs).toISOString(), "--end", new Date(endMs).toISOString()]),
    // Simulate the next process's locally computed day start, without changing
    // the test host's wall clock or timezone.
    startExplicit: false,
  };
}

function installChat(dbPath, name, cursor = null) {
  const scopeId = `lark.im.received.chat.${name}`;
  sqliteExec(dbPath, `INSERT INTO sync_scopes (id, source_id, name, config_json, cursor_json)
    VALUES (${quoteSql(scopeId)}, 'lark.im', ${quoteSql(name)}, ${sqlJson({ chat_id: name })}, ${cursor ? sqlJson(cursor) : "NULL"});`, "install synthetic chat");
  return scopeId;
}

function fakeRunner(fetchChatMessageList) {
  return createSyncRunner({
    fetchChatMessageList,
    fetchSentMessageList: () => { throw new Error("unexpected synthetic sent fetch"); },
    fetchChatDiscoveryPage: () => { throw new Error("unexpected synthetic discovery fetch"); },
    buildPeopleContext: (_messages, _opts, self) => ({
      self, contacts: new Map(), chat_members: new Map(), apps: new Map(), app_fallbacks: new Map(),
    }),
  });
}

test("a failed first launch keeps its baseline across midnight, a restart, and newly discovered scopes", (t) => {
  const dbPath = tempDb(t);
  const pendingScope = installChat(dbPath, "pending");
  const forbiddenFetch = () => { throw new Error("remote fetch must not run before profile resolution"); };
  assert.throws(() => executeLarkImSync(optionsForDay(dbPath, DAY_ONE, "sent", DAY_ONE + 23 * 3_600_000), {
    getSelfProfile: () => { throw new Error("synthetic first-launch profile failure"); },
    syncRunner: fakeRunner(forbiddenFetch),
  }), /synthetic first-launch profile failure/);
  assert.equal(sourceConfig(dbPath).initial_sync_start_ms, DAY_ONE);
  assert.equal(readScope(dbPath, pendingScope).cursor, null);

  const newScope = installChat(dbPath, "new_after_midnight");
  const existingCursorMs = DAY_ONE + 22 * 3_600_000;
  const existingScope = installChat(dbPath, "already_scanned", {
    kind: "time_message_cursor/v1", created_at_ms: existingCursorMs, message_id: "",
  });
  const fetched = [];
  const endMs = DAY_TWO + 3_600_000;
  const profile = { open_id: "ou_synthetic_self", name: "Synthetic" };
  const summary = executeLarkImSync(optionsForDay(dbPath, DAY_TWO, "received", endMs), {
    getSelfProfile: () => profile,
    syncRunner: fakeRunner((chatId, startMs, windowEndMs) => {
      fetched.push([chatId, startMs, windowEndMs]);
      return { messages: [{
        message_id: `synthetic:${chatId}`,
        create_time: String((startMs + 60_000) / 1000),
        msg_type: "text",
        sender: { id: "ou_synthetic_other", id_type: "open_id", sender_type: "user" },
        chat_id: chatId, chat_type: "group", content: "synthetic previous-day message",
      }], detailRoots: [], pages: 1 };
    }),
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.received.length, 3);
  assert.deepEqual(fetched.sort(), [
    ["already_scanned", existingCursorMs, endMs],
    ["new_after_midnight", DAY_ONE, endMs],
    ["pending", DAY_ONE, endMs],
  ]);
  assert.equal(sqliteQuery(dbPath, "SELECT COUNT(*) AS count FROM records WHERE occurred_at_ms < " + DAY_TWO + ";", "count synthetic prior-day messages")[0].count, 3);
  for (const scopeId of [pendingScope, newScope, existingScope]) {
    assert.equal(readScope(dbPath, scopeId).cursor.created_at_ms, endMs);
  }

  // A fresh runner models a later worker subprocess: each persisted cursor now
  // wins over both the original baseline and the new day's default start.
  const resumedStarts = [];
  const dayThree = DAY_TWO + 86_400_000;
  const resumed = executeLarkImSync(optionsForDay(dbPath, dayThree, "received", dayThree + 3_600_000), {
    getSelfProfile: () => profile,
    syncRunner: fakeRunner((_chatId, startMs) => {
      resumedStarts.push(startMs);
      return { messages: [], detailRoots: [], pages: 1 };
    }),
  });
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumedStarts, [endMs, endMs, endMs]);
  assert.equal(sourceConfig(dbPath).initial_sync_start_ms, DAY_ONE);
});
