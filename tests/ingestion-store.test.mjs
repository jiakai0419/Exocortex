import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireLock,
  acquireMaintenanceLock,
  createRun,
  ensureInitialized,
  failRun,
  isMaintenanceLocked,
  readScope,
  recoverStaleSyncState,
  releaseLock,
  releaseMaintenanceLock,
  sqliteExec,
  sqliteQuery,
  succeedRecordRun,
} from "../dist/storage/sqlite/ingestion-store.js";
import * as ingestionStoreShim from "../scripts/lib/ingestion-store.mjs";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-store-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempDb(t) {
  const dbPath = join(tempDir(t), "exocortex.sqlite");
  ensureInitialized(dbPath);
  return dbPath;
}

test("ingestion store shim re-exports the src implementation", () => {
  assert.equal(ingestionStoreShim.ensureInitialized, ensureInitialized);
  assert.equal(ingestionStoreShim.succeedRecordRun, succeedRecordRun);
});

function installTestScope(dbPath) {
  sqliteExec(
    dbPath,
    `
INSERT INTO sources (id, kind, display_name)
VALUES ('test.source', 'test', 'Test Source');
INSERT INTO sync_scopes (id, source_id, name, description, config_json)
VALUES ('test.scope', 'test.source', 'test.scope', 'Test scope', '{}');
`,
    "install test scope",
  );
  return readScope(dbPath, "test.scope");
}

function record(overrides = {}) {
  return {
    source_id: "test.source",
    first_seen_scope_id: "test.scope",
    external_id: "external:1",
    external_version: "v1",
    record_type: "test.record",
    occurred_at: "2026-06-13T00:00:00.000Z",
    occurred_at_ms: Date.parse("2026-06-13T00:00:00.000Z"),
    actor_id: "actor:1",
    container_id: "container:1",
    direction: null,
    title: "Test record",
    body: "stored body",
    content_hash: "hash:1",
    canonical_json: JSON.stringify({ normalized: true }),
    raw_json: JSON.stringify({ external_id: "external:1" }),
    ...overrides,
  };
}

test("readScope parses config and cursor JSON into stable objects", (t) => {
  const dbPath = tempDb(t);
  const scope = readScope(dbPath, "lark.im.sent_by_me");
  const cursor = { kind: "test.cursor/v1", created_at_ms: 1700000000000 };
  sqliteExec(
    dbPath,
    `UPDATE sync_scopes
     SET config_json = '{"adapter":"synthetic"}',
         cursor_json = '${JSON.stringify(cursor)}'
     WHERE id = '${scope.id}';`,
    "seed scope config and cursor",
  );

  const updated = readScope(dbPath, "lark.im.sent_by_me");

  assert.equal(updated.id, "lark.im.sent_by_me");
  assert.deepEqual(updated.config, { adapter: "synthetic" });
  assert.deepEqual(updated.cursor, cursor);
});

test("scope locks reject competing owners and release only by owner", (t) => {
  const dbPath = tempDb(t);
  const scopeId = "lark.im.sent_by_me";

  assert.equal(acquireLock(dbPath, scopeId, 60, "worker:a"), true);
  assert.equal(acquireLock(dbPath, scopeId, 60, "worker:b"), false);

  releaseLock(dbPath, scopeId, "worker:b");
  assert.equal(acquireLock(dbPath, scopeId, 60, "worker:b"), false);

  releaseLock(dbPath, scopeId, "worker:a");
  assert.equal(acquireLock(dbPath, scopeId, 60, "worker:b"), true);

  releaseLock(dbPath, scopeId, "worker:b");
  const rows = sqliteQuery(dbPath, "SELECT COUNT(*) AS count FROM sync_locks;", "count locks");
  assert.equal(rows[0].count, 0);
});

test("maintenance lock coordinates with scope locks", (t) => {
  const dbPath = tempDb(t);
  const scopeId = "lark.im.sent_by_me";

  const maintenance = acquireMaintenanceLock(dbPath, {
    owner: "maintenance:a",
    now: new Date("2099-06-13T00:00:00.000Z"),
    ttlSeconds: 600,
    reason: "test maintenance",
  });
  assert.deepEqual(maintenance, { acquired: true });
  assert.equal(isMaintenanceLocked(dbPath, new Date("2099-06-13T00:01:00.000Z")), true);
  assert.equal(acquireLock(dbPath, scopeId, 60, "worker:a"), false);

  releaseMaintenanceLock(dbPath, "maintenance:a");
  assert.equal(isMaintenanceLocked(dbPath, new Date("2099-06-13T00:01:00.000Z")), false);
  assert.equal(acquireLock(dbPath, scopeId, 60, "worker:a"), true);

  const blocked = acquireMaintenanceLock(dbPath, {
    owner: "maintenance:b",
    now: new Date("2099-06-13T00:02:00.000Z"),
    ttlSeconds: 600,
    reason: "test maintenance",
  });
  assert.equal(blocked.acquired, false);
  assert.equal(blocked.reason, "sync_locks_active");
  assert.equal(blocked.active_sync_locks, 1);

  releaseLock(dbPath, scopeId, "worker:a");
  assert.deepEqual(
    acquireMaintenanceLock(dbPath, {
      owner: "maintenance:b",
      now: new Date("2099-06-13T00:03:00.000Z"),
      ttlSeconds: 600,
      reason: "test maintenance",
    }),
    { acquired: true },
  );
  releaseMaintenanceLock(dbPath, "maintenance:b");
});

test("expired maintenance locks are recoverable", (t) => {
  const dbPath = tempDb(t);

  assert.deepEqual(
    acquireMaintenanceLock(dbPath, {
      owner: "maintenance:expired",
      now: new Date("2026-06-13T00:00:00.000Z"),
      ttlSeconds: 60,
      reason: "expired maintenance",
    }),
    { acquired: true },
  );

  assert.deepEqual(
    acquireMaintenanceLock(dbPath, {
      owner: "maintenance:new",
      now: new Date("2026-06-13T00:02:00.000Z"),
      ttlSeconds: 60,
      reason: "new maintenance",
    }),
    { acquired: true },
  );
  const rows = sqliteQuery(dbPath, "SELECT owner FROM maintenance_locks;", "read maintenance lock");
  assert.deepEqual(rows, [{ owner: "maintenance:new" }]);
});

test("stale lock recovery cancels runs owned by dead workers", (t) => {
  const dbPath = tempDb(t);
  const scope = readScope(dbPath, "lark.im.sent_by_me");

  assert.equal(acquireLock(dbPath, scope.id, 600, "pid:111111"), true);
  const runId = createRun(dbPath, scope);

  const recovery = recoverStaleSyncState(dbPath, {
    now: new Date("2026-06-13T00:00:00.000Z"),
    ownerState: () => "dead",
  });

  assert.deepEqual(recovery, {
    recovered_locks: 1,
    cancelled_runs: 1,
    active_expired_locks: 0,
  });
  assert.equal(sqliteQuery(dbPath, "SELECT COUNT(*) AS count FROM sync_locks;", "count locks")[0].count, 0);
  const run = sqliteQuery(
    dbPath,
    `SELECT status, error_type FROM sync_runs WHERE id = ${Number(runId)};`,
    "read recovered run",
  )[0];
  assert.deepEqual(run, { status: "cancelled", error_type: "StaleLock" });
});

test("stale lock recovery keeps expired locks when the owner is still alive", (t) => {
  const dbPath = tempDb(t);
  const scope = readScope(dbPath, "lark.im.sent_by_me");

  assert.equal(acquireLock(dbPath, scope.id, 600, "pid:222222"), true);
  const runId = createRun(dbPath, scope);
  sqliteExec(
    dbPath,
    `UPDATE sync_locks SET expires_at = '2026-06-12T00:00:00.000Z' WHERE scope_id = '${scope.id}';`,
    "expire test lock",
  );

  const recovery = recoverStaleSyncState(dbPath, {
    now: new Date("2026-06-13T00:00:00.000Z"),
    ownerState: () => "alive",
  });

  assert.deepEqual(recovery, {
    recovered_locks: 0,
    cancelled_runs: 0,
    active_expired_locks: 1,
  });
  assert.equal(sqliteQuery(dbPath, "SELECT COUNT(*) AS count FROM sync_locks;", "count locks")[0].count, 1);
  const run = sqliteQuery(
    dbPath,
    `SELECT status FROM sync_runs WHERE id = ${Number(runId)};`,
    "read active run",
  )[0];
  assert.deepEqual(run, { status: "running" });
});

test("stale run recovery cancels old running runs without locks", (t) => {
  const dbPath = tempDb(t);
  const scope = readScope(dbPath, "lark.im.sent_by_me");
  const runId = createRun(dbPath, scope);
  sqliteExec(
    dbPath,
    `UPDATE sync_runs SET started_at = '2026-06-13T00:00:00.000Z' WHERE id = ${Number(runId)};`,
    "age running run",
  );

  const recovery = recoverStaleSyncState(dbPath, {
    now: new Date("2026-06-13T00:20:00.000Z"),
    ownerState: () => "unknown",
    orphanRunSeconds: 600,
  });

  assert.deepEqual(recovery, {
    recovered_locks: 0,
    cancelled_runs: 1,
    active_expired_locks: 0,
  });
  const run = sqliteQuery(
    dbPath,
    `SELECT status, error_type FROM sync_runs WHERE id = ${Number(runId)};`,
    "read orphan run",
  )[0];
  assert.deepEqual(run, { status: "cancelled", error_type: "StaleRun" });
});

test("scope lock acquisition surfaces structural database errors", (t) => {
  const dbPath = join(tempDir(t), "empty.sqlite");

  assert.throws(
    () => acquireLock(dbPath, "lark.im.sent_by_me", 60, "worker:a"),
    /no such table: sync_locks/,
  );
});

test("record runs are source-agnostic and count insert, update, duplicate effects", (t) => {
  const dbPath = tempDb(t);
  const scope = installTestScope(dbPath);

  const firstRunId = createRun(dbPath, scope, { runner: "tests/ingestion-store.test.mjs" });
  const cursor = { kind: "test.cursor/v1", occurred_at_ms: record().occurred_at_ms };
  const firstEffects = succeedRecordRun(dbPath, scope, firstRunId, [record()], 1, cursor, { test: true });
  assert.deepEqual(firstEffects, { inserted: 1, updated: 0, duplicate: 0 });

  const secondRunId = createRun(dbPath, readScope(dbPath, scope.id), {
    runner: "tests/ingestion-store.test.mjs",
  });
  const duplicateEffects = succeedRecordRun(dbPath, scope, secondRunId, [record()], 1, cursor, { test: true });
  assert.deepEqual(duplicateEffects, { inserted: 0, updated: 0, duplicate: 1 });

  const thirdRunId = createRun(dbPath, readScope(dbPath, scope.id), {
    runner: "tests/ingestion-store.test.mjs",
  });
  const updated = record({ content_hash: "hash:2", body: "updated body" });
  const updateEffects = succeedRecordRun(dbPath, scope, thirdRunId, [updated], 1, cursor, { test: true });
  assert.deepEqual(updateEffects, { inserted: 0, updated: 1, duplicate: 0 });

  const rows = sqliteQuery(
    dbPath,
    "SELECT source_id, first_seen_scope_id, body, content_hash FROM records WHERE external_id = 'external:1';",
    "read test record",
  );
  assert.deepEqual(rows, [
    {
      source_id: "test.source",
      first_seen_scope_id: "test.scope",
      body: "updated body",
      content_hash: "hash:2",
    },
  ]);
});

test("failed record runs preserve the previous successful cursor", (t) => {
  const dbPath = tempDb(t);
  const scope = installTestScope(dbPath);
  const successfulCursor = { kind: "test.cursor/v1", occurred_at_ms: record().occurred_at_ms };
  const successfulRunId = createRun(dbPath, scope, { runner: "tests/ingestion-store.test.mjs" });
  succeedRecordRun(dbPath, scope, successfulRunId, [record()], 1, successfulCursor, { test: true });

  const updatedScope = readScope(dbPath, scope.id);
  const failedRunId = createRun(dbPath, updatedScope, { runner: "tests/ingestion-store.test.mjs" });
  failRun(dbPath, updatedScope, failedRunId, new Error("synthetic failure"));

  const finalScope = readScope(dbPath, scope.id);
  assert.deepEqual(finalScope.cursor, successfulCursor);
  assert.equal(
    sqliteQuery(dbPath, `SELECT last_error_run_id FROM sync_scopes WHERE id = '${scope.id}';`, "read last error")[0]
      .last_error_run_id,
    failedRunId,
  );
  assert.deepEqual(
    sqliteQuery(
      dbPath,
      `SELECT status, cursor_after_json, error_type, error_message FROM sync_runs WHERE id = ${Number(failedRunId)};`,
      "read failed run",
    )[0],
    {
      status: "failed",
      cursor_after_json: null,
      error_type: "Error",
      error_message: "synthetic failure",
    },
  );
});
