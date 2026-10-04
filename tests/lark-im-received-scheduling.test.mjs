import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSyncRunner } from "../src/adapters/lark-im/sync-runner.mjs";
import { ensureInitialized, quoteSql, sqliteExec, sqliteQuery } from "../dist/storage/sqlite/ingestion-store.js";

const NOW = Date.parse("2026-06-18T08:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

function row(n, cursor = true, extra = {}) {
  return {
    id: `lark.im.received.chat.${String(n).padStart(3, "0")}`,
    source_id: "lark.im", enabled: 1,
    config_json: JSON.stringify({ chat_id: `oc_fixture_${n}`, hot_rank: n, discovery_rank: n, hot_seen_at: iso(NOW) }),
    cursor_json: cursor ? JSON.stringify({ created_at_ms: NOW - 600_000, message_id: "" }) : null,
    cursor_updated_at: cursor ? iso(NOW - 600_000) : null,
    created_at: iso(NOW - 600_000), ...extra,
  };
}

test("persisted attempts rotate all 20 hot scopes across four batches and restart, including failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-hot-rotation-"));
  const db = join(dir, "fixture.sqlite");
  try {
    ensureInitialized(db);
    const rows = Array.from({ length: 23 }, (_, n) => row(n));
    // Rank 20+ is outside the bounded activity pool, even though recently discovered.
    sqliteExec(db, rows.map((r) => `INSERT INTO sync_scopes
      (id, source_id, name, config_json, cursor_json, cursor_updated_at, created_at)
      VALUES (${quoteSql(r.id)}, 'lark.im', ${quoteSql(r.id)}, ${quoteSql(r.config_json)},
      ${quoteSql(r.cursor_json)}, ${quoteSql(r.cursor_updated_at)}, ${quoteSql(r.created_at)});`).join("\n"), "seed scheduler fixture");
    const selected = [];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const now = NOW + cycle * 90_000;
      // A new runner simulates restart: no process-local round-robin state exists.
      const runner = createSyncRunner({ nowIso: () => iso(now) });
      const batch = runner.listReceivedScopes(db, "hot").slice(0, 5);
      assert.equal(batch.length, 5);
      selected.push(...batch.map((s) => s.id));
      sqliteExec(db, batch.map((s, i) => `INSERT INTO sync_runs
        (source_id, scope_id, status, started_at, finished_at)
        VALUES ('lark.im', ${quoteSql(s.id)}, ${quoteSql(i === 0 ? "failed" : "succeeded")},
        ${quoteSql(iso(now))}, ${quoteSql(iso(now + 1000))});`).join("\n"), "record synthetic attempts");
    }
    assert.equal(new Set(selected).size, 20);
    assert.deepEqual(new Set(selected), new Set(rows.slice(0, 20).map((s) => s.id)));
    const cursorTimes = sqliteQuery(db, "SELECT DISTINCT cursor_updated_at FROM sync_scopes WHERE id LIKE 'lark.im.received.chat.%'", "unchanged cursors");
    assert.deepEqual(cursorTimes, [{ cursor_updated_at: iso(NOW - 600_000) }]);
    assert.deepEqual(createSyncRunner({ nowIso: () => iso(NOW + 601_000) }).listReceivedScopes(db, "hot"), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fair lane reserves initialized work under continual discovery and rotates failed new work", () => {
  const rows = Array.from({ length: 5 }, (_, n) => row(n));
  rows.push(...Array.from({ length: 10 }, (_, n) => row(n + 20, false)));
  let now = NOW;
  const runner = createSyncRunner({ nowIso: () => iso(now), sqliteQuery: () => rows });
  const visited = new Set();
  for (let cycle = 0; cycle < 3; cycle += 1) {
    rows.push(...Array.from({ length: 10 }, (_, n) => row(100 + cycle * 10 + n, false, { created_at: iso(now) })));
    const batch = runner.listReceivedScopes("fixture", "catchup").slice(0, 4);
    assert.equal(batch.filter((s) => s.cursor !== null).length, 2);
    for (const scope of batch) {
      const source = rows.find((r) => r.id === scope.id);
      source.last_attempt_at = iso(now);
      if (scope.cursor) visited.add(scope.id);
      // Pending scopes remain pending, simulating a failed API attempt.
    }
    now += 90_000;
  }
  assert.equal(visited.size, 5);
  const onlyPending = rows.filter((r) => !r.cursor_json);
  const retry = onlyPending.find((r) => r.last_attempt_at);
  retry.last_attempt_at = iso(NOW - 60_000);
  for (const r of onlyPending) if (r !== retry) r.created_at = iso(now);
  const pendingRunner = createSyncRunner({ nowIso: () => iso(now), sqliteQuery: () => onlyPending });
  assert.equal(pendingRunner.listReceivedScopes("fixture", "catchup")[0].id, retry.id);
});

test("hot eligibility expires stale/future hints and skips only a recent caught-up success", () => {
  const rows = [row(0), row(1), row(2), row(3), row(4)];
  rows[0].config_json = JSON.stringify({ hot_rank: 0, hot_seen_at: iso(NOW - 601_000) });
  rows[1].config_json = JSON.stringify({ hot_rank: 1, hot_seen_at: iso(NOW + 1) });
  rows[2].config_json = JSON.stringify({ hot_rank: null, hot_seen_at: iso(NOW) });
  rows[3].cursor_updated_at = iso(NOW - 10_000);
  rows[3].cursor_json = JSON.stringify({ created_at_ms: NOW - 30_000 });
  // A recently committed prefix is still eligible if its remote window is old.
  rows[4].cursor_updated_at = iso(NOW - 10_000);
  const runner = createSyncRunner({ nowIso: () => iso(NOW), sqliteQuery: () => rows });
  assert.deepEqual(runner.listReceivedScopes("fixture", "hot").map((s) => s.id), [rows[4].id]);
});

test("locked scopes are refilled within a finite scan while actual API attempts keep their budget", () => {
  const rows = Array.from({ length: 100 }, (_, n) => row(n));
  const scopes = new Map(rows.map((r) => [r.id, { ...r, config: JSON.parse(r.config_json), cursor: JSON.parse(r.cursor_json) }]));
  let locks = 0;
  let fetched = 0;
  let blockAll = false;
  let maintenance = false;
  const runner = createSyncRunner({
    nowIso: () => iso(NOW), sqliteQuery: () => rows,
    readScope: (_db, id) => scopes.get(id),
    isMaintenanceLocked: () => maintenance,
    acquireLock: () => { locks += 1; return !blockAll && locks > 2; },
    readLarkListProgress: () => null,
    createRun: () => locks, releaseLock: () => {}, failRun: () => {},
    fetchChatMessageList: () => { fetched += 1; return { messages: [], detailRoots: [], pages: 1 }; },
    buildPeopleContext: () => ({}),
    commitLarkListRun: () => ({ inserted: 0, updated: 0, duplicate: 0, pending_details: 0 }),
  });
  const opts = { startMs: NOW - 600_000, endMs: NOW, receivedMode: "catchup", receivedScopesPerRun: 2,
    endExplicit: true, stableHorizonSeconds: 30, lockTtlSeconds: 600, maxPages: 10, pageSize: 50 };
  const results = runner.syncReceived("fixture", opts, { open_id: "ou_self", name: "Fixture" });
  assert.equal(fetched, 2);
  assert.equal(locks, 4);
  assert.equal(results.filter((r) => r.skipped).length, 2);
  blockAll = true; locks = 0;
  runner.syncReceived("fixture", opts, { open_id: "ou_self", name: "Fixture" });
  assert.equal(locks, 22);
  maintenance = true; locks = 0;
  assert.equal(runner.syncReceived("fixture", opts, { open_id: "ou_self", name: "Fixture" }).length, 1);
  assert.equal(locks, 0);
});

test("locked initialized candidates refill their own lane without crowding out the fair quota", () => {
  const rows = [...Array.from({ length: 6 }, (_, n) => row(n)),
    ...Array.from({ length: 6 }, (_, n) => row(n + 20, false))];
  const scopes = new Map(rows.map((r) => [r.id, { ...r, config: JSON.parse(r.config_json), cursor: JSON.parse(r.cursor_json) }]));
  const started = [];
  const runner = createSyncRunner({
    nowIso: () => iso(NOW), sqliteQuery: () => rows,
    readScope: (_db, id) => scopes.get(id), isMaintenanceLocked: () => false,
    acquireLock: (_db, id) => id !== rows[0].id && id !== rows[1].id,
    readLarkListProgress: () => null,
    createRun: (_db, scope) => { started.push(scope); return started.length; },
    releaseLock: () => {}, failRun: () => {},
    fetchChatMessageList: () => ({ messages: [], detailRoots: [], pages: 1 }), buildPeopleContext: () => ({}),
    commitLarkListRun: () => ({ inserted: 0, updated: 0, duplicate: 0, pending_details: 0 }),
  });
  runner.syncReceived("fixture", { startMs: NOW - 600_000, endMs: NOW, receivedMode: "catchup",
    receivedScopesPerRun: 4, endExplicit: true, stableHorizonSeconds: 30, lockTtlSeconds: 600,
    maxPages: 10, pageSize: 50 }, { open_id: "ou_self", name: "Fixture" });
  assert.equal(started.length, 4);
  assert.equal(started.filter((s) => s.cursor !== null).length, 2);
  assert.equal(started.filter((s) => s.cursor === null).length, 2);
});
