import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  DEFAULT_HARD_LEASE_SECONDS,
  acquireLock,
  acquireMaintenanceLock,
  createRun,
  ensureInitialized,
  failRun,
  isMaintenanceLocked,
  ownerPid,
  ownerStartedAtMs,
  defaultOwnerState,
  readScope,
  recoverStaleSyncState,
  releaseLock,
  releaseMaintenanceLock,
  secureDatabasePaths,
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

function succeedWithExplicitLock(dbPath, scopeId, records, cursor, metadata = { test: true }) {
  assert.equal(acquireLock(dbPath, scopeId, 60), true);
  try {
    const scope = readScope(dbPath, scopeId);
    const runId = createRun(dbPath, scope, { runner: "tests/ingestion-store.test.mjs" });
    const effects = succeedRecordRun(dbPath, scope, runId, records, records.length, cursor, metadata);
    return { effects, runId };
  } finally {
    releaseLock(dbPath, scopeId);
  }
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

test("createRun may use an implicit lock but cannot borrow a lock held by another owner", (t) => {
  const dbPath = tempDb(t);
  const scope = readScope(dbPath, "lark.im.sent_by_me");
  const owner = "worker:explicit-owner";

  assert.equal(acquireLock(dbPath, scope.id, 60, owner), true);
  assert.throws(
    () => createRun(dbPath, scope),
    /scope changed or current scope lock is not held/,
  );

  const runId = createRun(dbPath, scope, { test: true }, owner);
  assert.equal(failRun(dbPath, scope, runId, new Error("expected explicit-owner failure")), true);
  releaseLock(dbPath, scope.id, owner);
  assert.equal(
    sqliteQuery(dbPath, `SELECT status FROM sync_runs WHERE id = ${runId};`, "read explicit-owner run")[0].status,
    "failed",
  );
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
  const runId = createRun(dbPath, scope, undefined, "pid:111111");

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
  const runId = createRun(dbPath, scope, undefined, "pid:222222");
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
  releaseLock(dbPath, scope.id);
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

test("owner PID parsing accepts fenced owner suffixes and rejects malformed owners", () => {
  assert.equal(ownerPid("pid:123"), 123);
  assert.equal(ownerPid("pid:456:started:1700000000000"), 456);
  assert.equal(ownerPid("pid:789:sqlite-maintenance"), 789);
  assert.equal(ownerPid("worker:pid:123"), null);
  assert.equal(ownerPid("pid:0"), null);
  assert.equal(ownerPid("pid:not-a-number"), null);
  assert.equal(ownerStartedAtMs("pid:456:started:1700000000000"), 1_700_000_000_000);
  assert.equal(ownerStartedAtMs("pid:456:started:synthetic"), null);
  assert.equal(ownerStartedAtMs("pid:456"), null);

  const currentStartedAt = Math.floor(Date.now() - process.uptime() * 1000);
  assert.equal(defaultOwnerState(`pid:${process.pid}:started:${currentStartedAt}`), "alive");
  assert.equal(defaultOwnerState(`pid:${process.pid}:started:${currentStartedAt - 60_000}`), "dead");
});

test("scope locks cap requested TTLs and recover at the hard lease ceiling even for live owners", (t) => {
  const dbPath = tempDb(t);
  const scope = readScope(dbPath, "lark.im.sent_by_me");
  const owner = `pid:${process.pid}:started:synthetic`;

  assert.equal(acquireLock(dbPath, scope.id, DEFAULT_HARD_LEASE_SECONDS * 10, owner), true);
  let lock = sqliteQuery(
    dbPath,
    `SELECT locked_at, expires_at FROM sync_locks WHERE scope_id = '${scope.id}';`,
    "read bounded lease",
  )[0];
  assert.ok(Date.parse(lock.expires_at) - Date.parse(lock.locked_at) <= DEFAULT_HARD_LEASE_SECONDS * 1000);

  const runId = createRun(dbPath, scope, undefined, owner);
  sqliteExec(
    dbPath,
    `UPDATE sync_locks
     SET locked_at = '2026-06-13T00:00:00.000Z',
         expires_at = '2026-06-13T00:10:00.000Z'
     WHERE scope_id = '${scope.id}';
     UPDATE sync_runs
     SET metadata_json = json_set(metadata_json, '$.__run_fence.locked_at', '2026-06-13T00:00:00.000Z')
     WHERE id = ${runId};`,
    "age lock past hard ceiling",
  );
  assert.throws(
    () =>
      succeedRecordRun(
        dbPath,
        scope,
        runId,
        [],
        0,
        { kind: "test.cursor/v1", created_at_ms: 1 },
        { test: true },
      ),
    /stale, cancelled, mismatched, or unfenced/,
  );
  const recovery = recoverStaleSyncState(dbPath, {
    now: new Date("2026-06-13T02:00:00.000Z"),
    ownerState: () => "alive",
    hardLeaseSeconds: 3600,
  });

  assert.deepEqual(recovery, {
    recovered_locks: 1,
    cancelled_runs: 1,
    active_expired_locks: 0,
  });
  lock = sqliteQuery(dbPath, "SELECT * FROM sync_locks;", "read recovered lease")[0];
  assert.equal(lock, undefined);
  assert.equal(
    sqliteQuery(dbPath, `SELECT status FROM sync_runs WHERE id = ${runId};`, "read hard-ceiling run")[0].status,
    "cancelled",
  );
});

test("cancelled, completed, mismatched, and lock-lost runs cannot mutate records or regress cursors", (t) => {
  const dbPath = tempDb(t);
  const scope = installTestScope(dbPath);
  const cursor100 = { kind: "test.cursor/v1", occurred_at_ms: 100 };
  const cursor200 = { kind: "test.cursor/v1", occurred_at_ms: 200 };

  assert.equal(acquireLock(dbPath, scope.id, 60), true);
  const cancelledRunId = createRun(dbPath, scope);
  sqliteExec(
    dbPath,
    `UPDATE sync_runs SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP WHERE id = ${cancelledRunId};`,
    "cancel old run",
  );
  releaseLock(dbPath, scope.id);

  const freshWrite = succeedWithExplicitLock(
    dbPath,
    scope.id,
    [record({ external_version: "200", body: "new body", content_hash: "hash:200" })],
    cursor200,
  );
  assert.deepEqual(freshWrite.effects, { inserted: 1, updated: 0, duplicate: 0 });

  assert.throws(
    () =>
      succeedRecordRun(
        dbPath,
        scope,
        cancelledRunId,
        [record({ external_version: "100", body: "old body", content_hash: "hash:100" })],
        1,
        cursor100,
        { test: true },
      ),
    /stale, cancelled, mismatched, or unfenced/,
  );

  assert.equal(acquireLock(dbPath, scope.id, 60), true);
  const currentScope = readScope(dbPath, scope.id);
  const completedRunId = createRun(dbPath, currentScope);
  const completedEffects = succeedRecordRun(
    dbPath,
    currentScope,
    completedRunId,
    [record({ external_version: "200", body: "new body", content_hash: "hash:200" })],
    1,
    cursor200,
    { test: true },
  );
  assert.deepEqual(completedEffects, { inserted: 0, updated: 0, duplicate: 1 });
  assert.equal(failRun(dbPath, currentScope, completedRunId, new Error("late failure")), false);
  releaseLock(dbPath, scope.id);

  const finalScope = readScope(dbPath, scope.id);
  const finalRecord = sqliteQuery(
    dbPath,
    "SELECT external_version, body, content_hash FROM records WHERE external_id = 'external:1';",
    "read fenced record",
  )[0];
  const runs = sqliteQuery(
    dbPath,
    `SELECT id, status FROM sync_runs WHERE id IN (${cancelledRunId}, ${completedRunId}) ORDER BY id;`,
    "read fenced runs",
  );
  assert.deepEqual(finalScope.cursor, cursor200);
  assert.deepEqual(finalRecord, { external_version: "200", body: "new body", content_hash: "hash:200" });
  assert.deepEqual(runs, [
    { id: cancelledRunId, status: "cancelled" },
    { id: completedRunId, status: "succeeded" },
  ]);

  assert.equal(acquireLock(dbPath, scope.id, 60), true);
  const lostLockScope = readScope(dbPath, scope.id);
  const lostLockRunId = createRun(dbPath, lostLockScope);
  releaseLock(dbPath, scope.id);
  assert.throws(
    () => succeedRecordRun(dbPath, lostLockScope, lostLockRunId, [], 0, cursor100, { test: true }),
    /unfenced run/,
  );
  assert.equal(
    sqliteQuery(dbPath, `SELECT status FROM sync_runs WHERE id = ${lostLockRunId};`, "read lock-lost run")[0].status,
    "running",
  );
});

test("record-run cursors reject rollback, nulling, and invalid timestamps", (t) => {
  const dbPath = tempDb(t);
  const scope = installTestScope(dbPath);
  const cursor200 = { kind: "test.cursor/v1", created_at_ms: 200, message_id: "" };
  const cursor100 = { kind: "test.cursor/v1", created_at_ms: 100, message_id: "" };
  succeedWithExplicitLock(dbPath, scope.id, [], cursor200);

  for (const rejectedCursor of [cursor100, null]) {
    assert.equal(acquireLock(dbPath, scope.id, 60), true);
    const currentScope = readScope(dbPath, scope.id);
    const runId = createRun(dbPath, currentScope);
    assert.throws(
      () =>
        succeedRecordRun(
          dbPath,
          currentScope,
          runId,
          [record({ external_id: `rejected:${String(rejectedCursor)}`, content_hash: "rejected" })],
          1,
          rejectedCursor,
          { test: true },
        ),
      /stale, cancelled, mismatched, or unfenced/,
    );
    assert.equal(failRun(dbPath, currentScope, runId, new Error("rejected cursor")), true);
    releaseLock(dbPath, scope.id);
  }

  assert.equal(acquireLock(dbPath, scope.id, 60), true);
  const currentScope = readScope(dbPath, scope.id);
  const invalidRunId = createRun(dbPath, currentScope);
  assert.throws(
    () =>
      succeedRecordRun(
        dbPath,
        currentScope,
        invalidRunId,
        [],
        0,
        { kind: "test.cursor/v1", created_at_ms: "not-a-number" },
        { test: true },
      ),
    /created_at_ms must be a finite number/,
  );
  assert.equal(failRun(dbPath, currentScope, invalidRunId, new Error("invalid cursor")), true);
  releaseLock(dbPath, scope.id);

  assert.deepEqual(readScope(dbPath, scope.id).cursor, cursor200);
  assert.equal(
    sqliteQuery(dbPath, "SELECT COUNT(*) AS count FROM records WHERE external_id LIKE 'rejected:%';", "count rejected writes")[0]
      .count,
    0,
  );

  sqliteExec(
    dbPath,
    `UPDATE sync_scopes
     SET cursor_json = '{"kind":"test.cursor/v1","created_at_ms":"broken"}'
     WHERE id = '${scope.id}';`,
    "install invalid stored cursor",
  );
  const invalidScope = readScope(dbPath, scope.id);
  assert.equal(acquireLock(dbPath, scope.id, 60), true);
  assert.throws(() => createRun(dbPath, invalidScope), /scope cursor\.created_at_ms must be a finite number/);
  releaseLock(dbPath, scope.id);
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

test("record versions are normalized and never regress to older or null payloads", (t) => {
  const dbPath = tempDb(t);
  const scope = installTestScope(dbPath);
  const cursor = { kind: "test.cursor/v1", occurred_at_ms: record().occurred_at_ms };

  const first = succeedWithExplicitLock(
    dbPath,
    scope.id,
    [
      record({ external_version: "100", body: "old in batch", content_hash: "hash:100" }),
      record({ external_version: "000200", body: "newest", content_hash: "hash:200" }),
    ],
    cursor,
  );
  assert.deepEqual(first.effects, { inserted: 1, updated: 0, duplicate: 0 });

  const older = succeedWithExplicitLock(
    dbPath,
    scope.id,
    [record({ external_version: "150", body: "stale", content_hash: "hash:150" })],
    cursor,
  );
  const unknown = succeedWithExplicitLock(
    dbPath,
    scope.id,
    [record({ external_version: null, body: "unknown stale", content_hash: "hash:null" })],
    cursor,
  );
  assert.deepEqual(older.effects, { inserted: 0, updated: 0, duplicate: 1 });
  assert.deepEqual(unknown.effects, { inserted: 0, updated: 0, duplicate: 1 });

  let stored = sqliteQuery(
    dbPath,
    "SELECT external_version, body, content_hash FROM records WHERE external_id = 'external:1';",
    "read monotonic record",
  )[0];
  assert.deepEqual(stored, { external_version: "200", body: "newest", content_hash: "hash:200" });

  const newer = succeedWithExplicitLock(
    dbPath,
    scope.id,
    [record({ external_version: "201", body: "newer", content_hash: "hash:201" })],
    cursor,
  );
  assert.deepEqual(newer.effects, { inserted: 0, updated: 1, duplicate: 0 });

  const enriched = record({
    external_version: "201",
    body: "newer",
    content_hash: "hash:201",
    canonical_json: JSON.stringify({ normalized: true, enriched: true }),
  });
  const enrichedWrite = succeedWithExplicitLock(dbPath, scope.id, [enriched], cursor);
  const exactDuplicate = succeedWithExplicitLock(dbPath, scope.id, [enriched], cursor);
  assert.deepEqual(enrichedWrite.effects, { inserted: 0, updated: 1, duplicate: 0 });
  assert.deepEqual(exactDuplicate.effects, { inserted: 0, updated: 0, duplicate: 1 });

  stored = sqliteQuery(
    dbPath,
    "SELECT external_version, body, content_hash, canonical_json FROM records WHERE external_id = 'external:1';",
    "read enriched monotonic record",
  )[0];
  assert.equal(stored.external_version, "201");
  assert.equal(stored.body, "newer");
  assert.equal(JSON.parse(stored.canonical_json).enriched, true);
});

test("a null version may initialize or update an unversioned record but cannot replace a known version", (t) => {
  const dbPath = tempDb(t);
  const scope = installTestScope(dbPath);
  const cursor = { kind: "test.cursor/v1", occurred_at_ms: record().occurred_at_ms };

  assert.deepEqual(
    succeedWithExplicitLock(
      dbPath,
      scope.id,
      [record({ external_version: null, body: "unversioned", content_hash: "hash:null:1" })],
      cursor,
    ).effects,
    { inserted: 1, updated: 0, duplicate: 0 },
  );
  assert.deepEqual(
    succeedWithExplicitLock(
      dbPath,
      scope.id,
      [record({ external_version: null, body: "unversioned refresh", content_hash: "hash:null:2" })],
      cursor,
    ).effects,
    { inserted: 0, updated: 1, duplicate: 0 },
  );
  assert.deepEqual(
    succeedWithExplicitLock(
      dbPath,
      scope.id,
      [record({ external_version: "1", body: "known", content_hash: "hash:known" })],
      cursor,
    ).effects,
    { inserted: 0, updated: 1, duplicate: 0 },
  );
  assert.deepEqual(
    succeedWithExplicitLock(
      dbPath,
      scope.id,
      [record({ external_version: null, body: "must not win", content_hash: "hash:null:3" })],
      cursor,
    ).effects,
    { inserted: 0, updated: 0, duplicate: 1 },
  );
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

test("store SQLite sessions bail on the first SQL error", (t) => {
  const dbPath = tempDb(t);

  assert.throws(
    () =>
      sqliteExec(
        dbPath,
        `CREATE TABLE bail_before (id INTEGER);
         THIS IS NOT SQL;
         CREATE TABLE bail_after (id INTEGER);`,
        "synthetic bail check",
      ),
    /synthetic bail check failed/,
  );
  const tables = sqliteQuery(
    dbPath,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'bail_%' ORDER BY name;",
    "read bail tables",
  );
  assert.deepEqual(tables, [{ name: "bail_before" }]);
});

test("database directories and SQLite sidecar files are forced private", (t) => {
  const dir = tempDir(t);
  chmodSync(dir, 0o755);
  const dbPath = join(dir, "private.sqlite");
  ensureInitialized(dbPath);

  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);

  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${suffix}`;
    writeFileSync(sidecar, "synthetic sidecar", { mode: 0o644 });
    chmodSync(sidecar, 0o644);
  }
  secureDatabasePaths(dbPath);
  assert.equal(statSync(`${dbPath}-wal`).mode & 0o777, 0o600);
  assert.equal(statSync(`${dbPath}-shm`).mode & 0o777, 0o600);
});

test("ensureInitialized resolves its initializer independently of the caller cwd", (t) => {
  const dir = tempDir(t);
  const storeUrl = pathToFileURL(resolve("dist/storage/sqlite/ingestion-store.js")).href;
  const code = `
    import { ensureInitialized, sqliteQuery } from ${JSON.stringify(storeUrl)};
    ensureInitialized('nested/from-other-cwd.sqlite');
    const rows = sqliteQuery('nested/from-other-cwd.sqlite', 'SELECT COUNT(*) AS count FROM schema_migrations;', 'read migrations');
    process.stdout.write(JSON.stringify(rows[0]));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
    cwd: dir,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).count >= 6, true);
  assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "nested", "from-other-cwd.sqlite")).mode & 0o777, 0o600);
});

test("missing sqlite3 errors name the missing executable instead of dereferencing stderr", (t) => {
  const dir = tempDir(t);
  const storeUrl = pathToFileURL(resolve("dist/storage/sqlite/ingestion-store.js")).href;
  const code = `
    import { sqliteQuery } from ${JSON.stringify(storeUrl)};
    try {
      sqliteQuery('missing.sqlite', 'SELECT 1;', 'missing sqlite smoke');
    } catch (error) {
      process.stderr.write(String(error.message));
      process.exit(7);
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
    cwd: dir,
    env: { ...process.env, PATH: "" },
    encoding: "utf8",
  });

  assert.equal(result.status, 7);
  assert.match(result.stderr, /sqlite3 executable not found \(ENOENT\)/);
  assert.doesNotMatch(result.stderr, /Cannot read properties/);
});
