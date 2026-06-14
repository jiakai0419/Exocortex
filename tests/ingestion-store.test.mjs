import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireLock,
  createRun,
  ensureInitialized,
  readScope,
  recoverStaleSyncState,
  releaseLock,
  sqliteExec,
  sqliteQuery,
  succeedRecordRun,
} from "../scripts/lib/ingestion-store.mjs";

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
