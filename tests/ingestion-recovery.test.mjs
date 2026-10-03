import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireMaintenanceLock,
  createRun,
  ensureInitialized,
  quoteSql,
  readScope,
  recoverStaleSyncState,
  releaseMaintenanceLock,
  sqliteExec,
  sqliteQuery,
  succeedRecordRun,
} from "../dist/storage/sqlite/ingestion-store.js";

const NO_RECOVERY = { recovered_locks: 0, cancelled_runs: 0, active_expired_locks: 0 };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "exocortex-recovery-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "synthetic.sqlite");
  ensureInitialized(dbPath);
  const now = new Date();
  return { directory, dbPath, now, nowMs: now.getTime() };
}

function installScope(dbPath, scopeId, sourceId = "recovery.test") {
  sqliteExec(dbPath, `
    INSERT OR IGNORE INTO sources (id, kind, display_name)
    VALUES (${quoteSql(sourceId)}, 'test', 'Synthetic recovery source');
    INSERT INTO sync_scopes (id, source_id, name, config_json)
    VALUES (${quoteSql(scopeId)}, ${quoteSql(sourceId)}, ${quoteSql(scopeId)}, '{}');
  `, "install synthetic recovery scope");
  return readScope(dbPath, scopeId);
}

function installLock(dbPath, scopeId, owner, lockedAtMs, expiresAtMs) {
  const lockedAt = new Date(lockedAtMs).toISOString();
  const expiresAt = new Date(expiresAtMs).toISOString();
  sqliteExec(dbPath, `
    INSERT OR REPLACE INTO sync_locks (scope_id, locked_by, locked_at, expires_at)
    VALUES (${[scopeId, owner, lockedAt, expiresAt].map(quoteSql).join(", ")});
  `, "install synthetic recovery lock");
  return { lockedAt, expiresAt };
}

function installRun(dbPath, scope, owner, lockedAt, options = {}) {
  const metadata = options.unfenced ? {} : { __run_fence: { owner, locked_at: lockedAt } };
  return sqliteQuery(dbPath, `
    INSERT INTO sync_runs (source_id, scope_id, status, started_at, metadata_json)
    VALUES (${quoteSql(options.sourceId || scope.source_id)}, ${quoteSql(scope.id)},
      ${quoteSql(options.status || "running")}, ${quoteSql(options.startedAt || lockedAt)},
      ${quoteSql(JSON.stringify(metadata))}) RETURNING id;
  `, "install synthetic recovery run")[0].id;
}

function runState(dbPath, id) {
  return sqliteQuery(dbPath,
    `SELECT status, error_type FROM sync_runs WHERE id = ${id};`, "read synthetic recovery run")[0];
}

function locks(dbPath) {
  return sqliteQuery(dbPath,
    "SELECT scope_id, locked_by, locked_at, expires_at FROM sync_locks ORDER BY scope_id;",
    "read synthetic recovery locks");
}

for (const replaceOwner of [true, false]) {
  test(`recovery ignores a ${replaceOwner ? "new owner" : "same owner new lease"} installed after observation`, (t) => {
    const { dbPath, now, nowMs } = fixture(t);
    const scope = installScope(dbPath, "replacement.scope");
    const oldOwner = "synthetic:old-owner";
    const newOwner = replaceOwner ? "synthetic:new-owner" : oldOwner;
    const oldLock = installLock(dbPath, scope.id, oldOwner, nowMs - 1_200_000, nowMs - 600_000);
    const oldRun = installRun(dbPath, scope, oldOwner, oldLock.lockedAt);
    let newRun;
    let currentLock;

    const result = recoverStaleSyncState(dbPath, {
      now,
      ownerState(owner) {
        assert.equal(owner, oldOwner);
        currentLock = installLock(dbPath, scope.id, newOwner, nowMs, nowMs + 600_000);
        newRun = createRun(dbPath, readScope(dbPath, scope.id), {}, newOwner);
        return "dead";
      },
    });

    assert.deepEqual(result, NO_RECOVERY);
    assert.deepEqual(runState(dbPath, oldRun), { status: "running", error_type: null });
    assert.deepEqual(runState(dbPath, newRun), { status: "running", error_type: null });
    assert.deepEqual(locks(dbPath), [{ scope_id: scope.id, locked_by: newOwner,
      locked_at: currentLock.lockedAt, expires_at: currentLock.expiresAt }]);
    const cursor = { created_at_ms: nowMs - 30_000 };
    assert.deepEqual(succeedRecordRun(dbPath, readScope(dbPath, scope.id), newRun, [], 0, cursor, {}),
      { inserted: 0, updated: 0, duplicate: 0 });
    assert.deepEqual(readScope(dbPath, scope.id).cursor, cursor, "new owner's fenced commit must remain usable");
  });
}

test("recovery ignores a renewed expiry even when owner and acquired time did not change", (t) => {
  const { dbPath, now, nowMs } = fixture(t);
  const scope = installScope(dbPath, "renewed.scope");
  const owner = "synthetic:unknown-owner";
  const lock = installLock(dbPath, scope.id, owner, nowMs - 1_200_000, nowMs - 600_000);
  const runId = installRun(dbPath, scope, owner, lock.lockedAt);
  const newExpiry = new Date(nowMs + 600_000).toISOString();
  const result = recoverStaleSyncState(dbPath, {
    now,
    ownerState() {
      sqliteExec(dbPath, `UPDATE sync_locks SET expires_at = ${quoteSql(newExpiry)}
        WHERE scope_id = ${quoteSql(scope.id)};`, "renew synthetic lease after observation");
      return "unknown";
    },
  });
  assert.deepEqual(result, NO_RECOVERY);
  assert.equal(locks(dbPath)[0].expires_at, newExpiry);
  assert.equal(runState(dbPath, runId).status, "running");
});

test("recovery cancellation matches source, scope, owner and acquired time, and reports actual run counts", (t) => {
  const { dbPath, now, nowMs } = fixture(t);
  const scope = installScope(dbPath, "fenced.scope");
  installScope(dbPath, "foreign.scope", "foreign.source");
  const owner = "synthetic:dead-owner";
  const lock = installLock(dbPath, scope.id, owner, nowMs - 1_200_000, nowMs - 600_000);
  const matching = [installRun(dbPath, scope, owner, lock.lockedAt), installRun(dbPath, scope, owner, lock.lockedAt)];
  const otherOwner = installRun(dbPath, scope, "synthetic:other-owner", lock.lockedAt);
  const otherLease = installRun(dbPath, scope, owner, new Date(nowMs - 1_800_000).toISOString());
  const otherSource = installRun(dbPath, scope, owner, lock.lockedAt, { sourceId: "foreign.source" });
  const completed = installRun(dbPath, scope, owner, lock.lockedAt, { status: "succeeded" });

  assert.deepEqual(recoverStaleSyncState(dbPath, { now, ownerState: () => "dead" }),
    { recovered_locks: 1, cancelled_runs: 2, active_expired_locks: 0 });
  for (const id of matching) assert.deepEqual(runState(dbPath, id), { status: "cancelled", error_type: "StaleLock" });
  for (const id of [otherOwner, otherLease, otherSource]) assert.equal(runState(dbPath, id).status, "running");
  assert.equal(runState(dbPath, completed).status, "succeeded");
  assert.deepEqual(locks(dbPath), []);
});

test("recovery counts empty stale locks separately and is idempotent", (t) => {
  const { dbPath, now, nowMs } = fixture(t);
  const scope = installScope(dbPath, "empty.scope");
  installLock(dbPath, scope.id, "synthetic:dead-owner", nowMs - 1_200_000, nowMs - 600_000);
  assert.deepEqual(recoverStaleSyncState(dbPath, { now, ownerState: () => "dead" }),
    { recovered_locks: 1, cancelled_runs: 0, active_expired_locks: 0 });
  assert.deepEqual(recoverStaleSyncState(dbPath, { now }), NO_RECOVERY);
});

test("recovery rolls back run cancellation when lock deletion cannot commit", (t) => {
  const { dbPath, now, nowMs } = fixture(t);
  const scope = installScope(dbPath, "rollback.scope");
  const lock = installLock(dbPath, scope.id, "synthetic:dead", nowMs - 1_200_000, nowMs - 600_000);
  const runId = installRun(dbPath, scope, "synthetic:dead", lock.lockedAt);
  const before = locks(dbPath);
  sqliteExec(dbPath, `CREATE TRIGGER synthetic_recovery_abort BEFORE DELETE ON sync_locks
    BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END;`, "install synthetic abort trigger");

  assert.throws(() => recoverStaleSyncState(dbPath, { now, ownerState: () => "dead" }),
    /synthetic delete failure/);
  assert.deepEqual(runState(dbPath, runId), { status: "running", error_type: null });
  assert.deepEqual(locks(dbPath), before);
});

test("recovery applies its scope filter to both stale locks and orphan runs", (t) => {
  const { dbPath, now, nowMs } = fixture(t);
  const chosen = installScope(dbPath, "chosen.scope", "chosen.source");
  const other = installScope(dbPath, "other.scope", "other.source");
  const orphan = installScope(dbPath, "other.orphan", "other.source");
  const chosenLock = installLock(dbPath, chosen.id, "synthetic:chosen", nowMs - 1_200_000, nowMs - 600_000);
  const otherLock = installLock(dbPath, other.id, "synthetic:other", nowMs - 1_200_000, nowMs - 600_000);
  const chosenRun = installRun(dbPath, chosen, "synthetic:chosen", chosenLock.lockedAt);
  const otherRun = installRun(dbPath, other, "synthetic:other", otherLock.lockedAt);
  const orphanRun = installRun(dbPath, orphan, "synthetic:orphan", chosenLock.lockedAt);
  const observedOwners = [];

  assert.deepEqual(recoverStaleSyncState(dbPath, { now, scopeId: chosen.id,
    ownerState(owner) { observedOwners.push(owner); return "dead"; } }),
  { recovered_locks: 1, cancelled_runs: 1, active_expired_locks: 0 });
  assert.deepEqual(observedOwners, ["synthetic:chosen"]);
  assert.equal(runState(dbPath, chosenRun).status, "cancelled");
  for (const id of [otherRun, orphanRun]) assert.equal(runState(dbPath, id).status, "running");
  assert.deepEqual(locks(dbPath).map((lock) => lock.scope_id), [other.id]);
});

test("orphan decisions see locks introduced after observation and require age at the transaction", (t) => {
  const { dbPath, now, nowMs } = fixture(t);
  const trigger = installScope(dbPath, "trigger.scope");
  const guarded = installScope(dbPath, "guarded.scope");
  const oldOrphan = installScope(dbPath, "old.orphan");
  const youngOrphan = installScope(dbPath, "young.orphan");
  const lock = installLock(dbPath, trigger.id, "synthetic:alive", nowMs - 1_000, nowMs + 600_000);
  const guardedRun = installRun(dbPath, guarded, "synthetic:guarded", new Date(nowMs - 1_200_000).toISOString());
  const oldRun = installRun(dbPath, oldOrphan, "synthetic:orphan", new Date(nowMs - 1_200_000).toISOString());
  const youngRun = installRun(dbPath, youngOrphan, "synthetic:orphan", lock.lockedAt);
  assert.deepEqual(recoverStaleSyncState(dbPath, { now, ownerState() {
    installLock(dbPath, guarded.id, "synthetic:guarded", nowMs - 1_200_000, nowMs + 600_000);
    return "alive";
  } }), { recovered_locks: 0, cancelled_runs: 1, active_expired_locks: 0 });
  assert.equal(runState(dbPath, guardedRun).status, "running");
  assert.deepEqual(runState(dbPath, oldRun), { status: "cancelled", error_type: "StaleRun" });
  assert.equal(runState(dbPath, youngRun).status, "running");
});

test("legacy unfenced runs are recovered only after becoming old lock-free orphans", (t) => {
  const { dbPath, now, nowMs } = fixture(t);
  const scope = installScope(dbPath, "legacy.scope");
  const lock = installLock(dbPath, scope.id, "synthetic:dead", nowMs - 1_200_000, nowMs - 600_000);
  const runId = installRun(dbPath, scope, "synthetic:dead", lock.lockedAt, { unfenced: true });
  assert.deepEqual(recoverStaleSyncState(dbPath, { now, ownerState: () => "dead" }),
    { recovered_locks: 1, cancelled_runs: 0, active_expired_locks: 0 });
  assert.equal(runState(dbPath, runId).status, "running");
  assert.deepEqual(recoverStaleSyncState(dbPath, { now }),
    { recovered_locks: 0, cancelled_runs: 1, active_expired_locks: 0 });
  assert.deepEqual(runState(dbPath, runId), { status: "cancelled", error_type: "StaleRun" });
  assert.deepEqual(recoverStaleSyncState(dbPath, { now }), NO_RECOVERY);
});

test("invalid recovery bounds and empty scope IDs fail before changing synthetic data", (t) => {
  const { dbPath, now, nowMs } = fixture(t);
  const scope = installScope(dbPath, "invalid.scope");
  installLock(dbPath, scope.id, "synthetic:dead", nowMs - 1_200_000, nowMs - 600_000);
  const before = locks(dbPath);
  for (const options of [
    { scopeId: "" }, { scopeId: " " }, { orphanRunSeconds: -1 }, { orphanRunSeconds: 0 },
    { orphanRunSeconds: NaN }, { hardLeaseSeconds: Infinity }, { now: new Date(NaN) },
  ]) {
    assert.throws(() => recoverStaleSyncState(dbPath, { now, ...options }));
    assert.deepEqual(locks(dbPath), before);
  }
});

test("ordinary store writes preserve shared parent and unrelated file modes", (t) => {
  const { directory, dbPath } = fixture(t);
  const unrelated = join(directory, "unrelated.sqlite");
  writeFileSync(unrelated, "unrelated synthetic file");
  chmodSync(directory, 0o755);
  chmodSync(unrelated, 0o644);
  chmodSync(dbPath, 0o644);
  sqliteExec(dbPath, "CREATE TABLE synthetic_mode_check (id INTEGER);", "synthetic mode check");
  sqliteQuery(dbPath, "INSERT INTO synthetic_mode_check VALUES (1) RETURNING id;", "synthetic query write");
  assert.deepEqual(acquireMaintenanceLock(dbPath, { owner: "synthetic:maintenance", reason: "test" }), { acquired: true });
  releaseMaintenanceLock(dbPath, "synthetic:maintenance");
  assert.equal(statSync(directory).mode & 0o777, 0o755);
  assert.equal(statSync(unrelated).mode & 0o777, 0o644);
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);
});
